#!/usr/bin/env node
// skiplink — accessibility gate for CI.
//
//   npx @skiplink/cli scan https://staging.example.com --baseline .skiplink/baseline.json
//
// Exit codes are the contract with CI, so they are narrow and stable:
//   0  gate passed
//   1  gate failed (new violations, or violations at/above --fail-on)
//   2  usage error — bad flag, unreadable baseline
//   3  could not complete — API unreachable, auth rejected, scan failed
//
// 1 is distinguished from 3 deliberately. "The site has a new violation" and
// "we could not find out" are different facts, and a pipeline should be able to
// treat them differently.

import { appendFile } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, ApiError } from './api.js';

// The hosted scanner only reaches public pages. Scanning localhost or a preview
// server inside CI is the most common first mistake, so say what to use instead.
const UNREACHABLE = new Set(['blocked_url', 'private_address', 'internal_hostname', 'port_not_allowed', 'credentials_in_url', 'dns_failed']);
const REACH_HINT =
  'The hosted scanner can only reach public pages on ports 80 and 443. For localhost,\n' +
  'a CI preview server or pages behind a login, run the same checks inside your tests\n' +
  'with @skiplink/playwright: https://www.npmjs.com/package/@skiplink/playwright\n';
import {
  loadBaseline,
  saveBaseline,
  baselineFrom,
  diff,
  shouldFail,
} from '@skiplink/core/baseline';
import { human, json, githubAnnotations, markdown } from '@skiplink/core/report';
import { STANDARDS } from '@skiplink/core/axe';

// Read once from the package's own manifest, so `--version` and the User-Agent can
// never disagree with what npm installed.
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const FAIL_ON = ['new', 'critical', 'serious', 'moderate', 'minor', 'never'];

const EXIT_OK = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_ERROR = 3;

const USAGE = `
skiplink — accessibility gate for CI

USAGE
  skiplink scan <url...> [options]

OPTIONS
  --baseline <path>      Baseline file. Violations in it do not fail the build.
  --update-baseline      Rewrite the baseline from this run and exit 0.
  --fail-on <level>      new (default) | critical | serious | moderate | minor | never
  --standard <name>      wcag22aa (default) | wcag21aa | wcag2aa | wcag2a | section508 | all
  --format <name>        human (default) | json | github
  --comment-file <path>  Write a markdown report for a PR comment.
  --token <key>          API key. Defaults to $SKIPLINK_TOKEN.
  --api <url>            API base URL. Defaults to $SKIPLINK_API or the hosted API.
  --wait-for <selector>  Wait for this selector before scanning.
  --timeout <seconds>    Give up waiting for scans. Default 600.
  --quiet                Suppress progress output.
  -v, --version          Print the version.
  -h, --help             Show this.

EXIT CODES
  0 passed · 1 gate failed · 2 usage error · 3 could not complete

EXAMPLES
  skiplink scan https://staging.example.com
  skiplink scan https://staging.example.com --baseline .skiplink/baseline.json
  skiplink scan https://staging.example.com --update-baseline
  skiplink scan $(cat urls.txt) --fail-on serious --format github

Docs: https://skiplink.dev/docs/#cli
`;

export function parseArgs(argv) {
  const opts = {
    urls: [],
    baseline: null,
    updateBaseline: false,
    failOn: 'new',
    standard: 'wcag22aa',
    format: 'human',
    commentFile: null,
    token: process.env.SKIPLINK_TOKEN || '',
    api: process.env.SKIPLINK_API || undefined,
    waitFor: null,
    timeout: 600,
    quiet: false,
    help: false,
  };

  const takesValue = new Set([
    '--baseline', '--fail-on', '--standard', '--format',
    '--comment-file', '--token', '--api', '--wait-for', '--timeout',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (arg === '--update-baseline') { opts.updateBaseline = true; continue; }
    if (arg === '--quiet') { opts.quiet = true; continue; }

    if (takesValue.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value.`);
      switch (arg) {
        case '--baseline': opts.baseline = value; break;
        case '--fail-on': opts.failOn = value; break;
        case '--standard': opts.standard = value; break;
        case '--format': opts.format = value; break;
        case '--comment-file': opts.commentFile = value; break;
        case '--token': opts.token = value; break;
        case '--api': opts.api = value; break;
        case '--wait-for': opts.waitFor = value; break;
        case '--timeout': {
          // parseInt("abc") is NaN, which would flow into a setTimeout and make
          // the poll loop behave in a way nobody could explain from the command
          // they typed.
          const seconds = Number.parseInt(value, 10);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new UsageError(`--timeout needs a positive number of seconds, got "${value}".`);
          }
          opts.timeout = seconds;
          break;
        }
      }
      continue;
    }

    if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}.`);
    opts.urls.push(arg);
  }

  // Checked here rather than left to the API, so a typo is exit 2 before any
  // network call — and so it still says something useful when the API is down.
  if (!Object.prototype.hasOwnProperty.call(STANDARDS, opts.standard)) {
    throw new UsageError(
      `Unknown --standard "${opts.standard}". Use one of: ${Object.keys(STANDARDS).join(', ')}.`,
    );
  }
  if (!FAIL_ON.includes(opts.failOn)) {
    throw new UsageError(`Unknown --fail-on "${opts.failOn}". Use one of: ${FAIL_ON.join(', ')}.`);
  }
  if (!['human', 'json', 'github'].includes(opts.format)) {
    throw new UsageError(`Unknown --format "${opts.format}". Use human, json, or github.`);
  }
  if (opts.updateBaseline && !opts.baseline) {
    throw new UsageError('--update-baseline needs --baseline <path> to write to.');
  }
  return opts;
}

export class UsageError extends Error {}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (command !== 'scan') {
    // The most common mistake by far is leaving out the subcommand.
    const hint = /^https?:\/\//i.test(command)
      ? `Did you mean: skiplink scan ${argv.join(' ')}\n`
      : '';
    process.stderr.write(`Unknown command "${command}".\n${hint}${USAGE}`);
    return EXIT_USAGE;
  }

  let opts;
  try {
    opts = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (opts.urls.length === 0) {
    process.stderr.write(`No URLs given.\n${USAGE}`);
    return EXIT_USAGE;
  }

  // Progress goes to stderr so `--format json` stays pipeable.
  const progress = (msg) => {
    if (!opts.quiet && opts.format !== 'json') process.stderr.write(msg);
  };

  let baseline = null;
  if (opts.baseline && !opts.updateBaseline) {
    try {
      baseline = await loadBaseline(opts.baseline);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_USAGE;
    }
    if (!baseline) {
      progress(
        `No baseline at ${opts.baseline}. Every violation counts as new.\n` +
          `Create one with --update-baseline once you have reviewed them.\n\n`,
      );
    }
  }

  let client;
  try {
    client = new Client({ token: opts.token, baseUrl: opts.api, userAgent: `skiplink-cli/${VERSION}` });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT_ERROR;
  }

  let scans;
  try {
    progress(`Scanning ${opts.urls.length} URL(s)…\n`);
    const batch = await client.scanBatch(opts.urls, {
      standard: opts.standard,
      ...(opts.waitFor ? { wait_for: opts.waitFor } : {}),
    });
    const ids = batch.scans.map((s) => s.id);

    scans = await client.waitForAll(ids, {
      timeoutMs: opts.timeout * 1000,
      onProgress: (done, total) => progress(`\r  ${done}/${total} complete`),
    });
    progress('\n');
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(`\n${err.message}\n`);
      if (UNREACHABLE.has(err.code)) process.stderr.write(`\n${REACH_HINT}`);
      return EXIT_ERROR;
    }
    throw err;
  }

  const completed = scans.filter((s) => s.status === 'done');
  const failed = scans.filter((s) => s.status !== 'done');

  // A scan that could not run is not a pass. Reporting "0 new violations"
  // because the page never loaded would be the single most misleading thing
  // this tool could do.
  if (completed.length === 0) {
    process.stderr.write('No page could be scanned.\n');
    for (const s of failed) {
      process.stderr.write(`  ${s.url} — ${s.error_code}: ${s.error_message || ''}\n`);
    }
    if (failed.some((s) => UNREACHABLE.has(s.error_code))) process.stderr.write(`\n${REACH_HINT}`);
    return EXIT_ERROR;
  }

  if (opts.updateBaseline) {
    const next = baselineFrom(completed, { engine: completed[0]?.engine || null });
    await saveBaseline(opts.baseline, next);
    process.stderr.write(
      `Wrote ${next.entries.length} violation(s) to ${opts.baseline}.\n` +
        `Review the diff before committing — every entry is a violation the gate will now ignore.\n`,
    );
    return EXIT_OK;
  }

  const result = diff(completed, baseline);

  let verdict;
  try {
    verdict = shouldFail(result, opts.failOn);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT_USAGE;
  }

  switch (opts.format) {
    case 'json':
      process.stdout.write(json(result, verdict, { scans }) + '\n');
      break;
    case 'github':
      process.stdout.write(githubAnnotations(result) + '\n');
      await writeStepSummary(markdown(result, verdict, { scans, runUrl: runUrl() }));
      // The CLI writes its own step outputs rather than having the action parse
      // them back out of stdout. One place knows the counts; parsing them out of
      // formatted text would be a second, lossier implementation.
      await writeStepOutputs({
        passed: String(!verdict.fail),
        new_violations: String(result.isNew.length),
        accepted_violations: String(result.accepted.length + result.drifted.length),
        total_violations: String(result.total),
      });
      break;
    default:
      process.stdout.write(human(result, verdict, { scans }));
  }

  if (opts.commentFile) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.commentFile, markdown(result, verdict, { scans, runUrl: runUrl() }), 'utf8');
  }

  // A page that failed to load does not fail the gate, but it must not pass
  // silently either — the exit code says "could not complete", which is true.
  if (verdict.fail) return EXIT_GATE_FAILED;
  if (failed.length > 0) return EXIT_ERROR;
  return EXIT_OK;
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

async function writeStepSummary(md) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  } catch {
    // A missing summary file must never fail the build.
  }
}

async function writeStepOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  try {
    const body = Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    await appendFile(process.env.GITHUB_OUTPUT, body + '\n');
  } catch {
    // Same: reporting is best-effort, the gate's verdict is not.
  }
}

// Only run when invoked as the command, not when imported.
//
// Without this the module cannot be imported at all: main() would start a real
// scan and call process.exit, which is what happened when the argument-parsing
// tests were first written — the test process exited before a single test
// registered, and the runner reported a pass.
if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`skiplink: ${err?.stack || err}\n`);
      process.exit(EXIT_ERROR);
    });
}

function isEntrypoint(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  // Compared as resolved paths so `skiplink`, `./src/index.js` and the npm bin
  // symlink all count as being run directly.
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked);
  } catch {
    return false;
  }
}
