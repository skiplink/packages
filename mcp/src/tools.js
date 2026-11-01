// The tools, as plain functions.
//
// Kept separate from the server wiring so they can be tested by calling them, rather
// than through a transport. Each returns the object an MCP tool result is built from:
// `{ text }` for prose, plus `data` where a structured answer is genuinely more useful
// than a paragraph.
//
// Three of the four need no API key and no network. That is a deliberate ordering of
// what this server is for: an agent should be able to ask what a rule means, what a
// standard covers, and what a project has already accepted, before anyone has signed
// up for anything. Only `scan_url` costs a scan.

import path from 'node:path';

import { diff, loadBaseline } from '@skiplink/core/baseline';

import { allRules, findRule, rulesForStandard, searchRules, standardsSummary, AXE_VERSION } from './rules.js';
import { sanitiseViolation, untrustedBlock } from './untrusted.js';

const DISCLAIMER =
  'Automated testing detects a subset of WCAG success criteria — published estimates range ' +
  'from roughly 13% to 57% depending on whether coverage is counted by success criteria or by ' +
  'issue volume. A clean result means no automatically detectable violations were found. It is ' +
  'not a statement that the page conforms to WCAG or complies with the ADA, Section 508 or the ' +
  'European Accessibility Act.';

// ── explain_rule ─────────────────────────────────────────────────────────────

export function explainRule({ rule }) {
  const found = findRule(rule);

  if (!found) {
    // A near miss is far more useful than "not found". An agent guessing
    // `color-contrast-aa` should be told the real name rather than concluding the
    // rule does not exist.
    const near = searchRules(String(rule || '').split(/[-_]/)[0]).slice(0, 8);
    return {
      isError: true,
      text: near.length
        ? `No axe-core rule called ${JSON.stringify(rule)}. Closest matches: ${near
            .map((r) => r.rule)
            .join(', ')}.`
        : `No axe-core rule called ${JSON.stringify(rule)}. Use list_rules to see what exists.`,
    };
  }

  const lines = [
    `${found.rule} — ${found.help}`,
    '',
    found.description,
    '',
    found.best_practice
      ? 'This is a best-practice rule, not a WCAG success criterion. Failing a build on it is a ' +
        'legitimate choice but not a compliance requirement.'
      : `WCAG ${found.wcag_version} level ${found.level}, success criteria ${found.wcag.join(', ')}.`,
  ];

  if (found.category) lines.push(`Category: ${found.category}.`);
  if (found.act_ids.length) {
    lines.push(
      `Externally specified: W3C ACT rules ${found.act_ids.join(', ')}. The test procedure is ` +
        'published, not a vendor opinion.',
    );
  }
  if (found.help_url) lines.push('', found.help_url);
  lines.push('', `axe-core ${AXE_VERSION}.`);

  return { text: lines.join('\n'), data: found };
}

// ── list_rules ───────────────────────────────────────────────────────────────

export function listRules({ standard, impact, search, include_best_practice = true } = {}) {
  let rules;

  if (standard) {
    rules = rulesForStandard(standard);
    if (rules === undefined) {
      return {
        isError: true,
        text:
          `Unknown standard ${JSON.stringify(standard)}. One of: ` +
          standardsSummary().map((s) => s.standard).join(', ') +
          '.',
      };
    }
  } else {
    rules = allRules();
  }

  if (search) rules = rules.filter((r) => searchRules(search).some((s) => s.rule === r.rule));
  if (!include_best_practice) rules = rules.filter((r) => !r.best_practice);

  // axe reports impact per element at scan time, so it is not a property of a rule
  // and cannot be filtered on here. Saying so is better than silently ignoring the
  // argument, which would look like the filter worked and found nothing.
  if (impact) {
    return {
      isError: true,
      text:
        'Impact is decided per element when a page is scanned, not per rule, so rules cannot be ' +
        'filtered by it. Scan a page and filter the violations instead.',
    };
  }

  const summary = rules.map((r) => ({
    rule: r.rule,
    help: r.help,
    wcag: r.wcag,
    level: r.level,
    best_practice: r.best_practice,
  }));

  return {
    text:
      `${summary.length} rule(s)${standard ? ` for ${standard}` : ''} in axe-core ${AXE_VERSION}.\n\n` +
      summary
        .map(
          (r) =>
            `${r.rule}${r.best_practice ? ' [best practice]' : ` [${r.level} ${r.wcag.join(' ')}]`} — ${r.help}`,
        )
        .join('\n'),
    data: { axe_core: AXE_VERSION, standard: standard || 'all', count: summary.length, rules: summary },
  };
}

// ── list_standards ───────────────────────────────────────────────────────────

export function listStandards() {
  const rows = standardsSummary();
  return {
    text: [
      `Standards accepted by Skiplink, resolved against axe-core ${AXE_VERSION}:`,
      '',
      ...rows.map(
        (r) =>
          `${r.standard} — ${r.rules} rules, ${r.wcag_criteria} WCAG success criteria` +
          (r.includes_best_practice ? ', includes best-practice rules that are not WCAG criteria' : ''),
      ),
      '',
      'wcag22aa is the default and the one most regulations point at.',
    ].join('\n'),
    data: { axe_core: AXE_VERSION, standards: rows },
  };
}

// ── read_baseline ────────────────────────────────────────────────────────────

/**
 * Summarise a project's committed baseline.
 *
 * Answers the question someone actually has when they open a repository: what has
 * this project already agreed to live with? Reading the raw JSON is possible but it
 * is a flat list of fingerprints, which tells a reader nothing.
 */
export async function readBaseline({ file = '.skiplink/baseline.json' } = {}) {
  const resolved = path.resolve(file);

  let baseline;
  try {
    baseline = await loadBaseline(resolved);
  } catch (err) {
    return { isError: true, text: `Could not read ${file}: ${err.message}` };
  }
  if (!baseline) {
    return {
      text:
        `No baseline at ${file}. That means every violation counts as new, so the first gated ` +
        'build will fail on everything the pages already had. Record one with ' +
        '`npx @skiplink/cli scan <url> --baseline ' + file + ' --update-baseline`.',
      data: { file, exists: false, entries: 0 },
    };
  }

  const byRule = new Map();
  const byPath = new Map();
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };

  for (const e of baseline.entries) {
    byRule.set(e.rule, (byRule.get(e.rule) || 0) + 1);
    byPath.set(e.path, (byPath.get(e.path) || 0) + 1);
    if (e.impact in byImpact) byImpact[e.impact] += 1;
  }

  const topRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]);

  return {
    text: [
      `${baseline.entries.length} accepted violation(s) across ${byPath.size} page(s) in ${file}.`,
      '',
      `By impact: ${Object.entries(byImpact)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ') || 'none recorded'}.`,
      '',
      'Most common rules:',
      ...topRules.slice(0, 10).map(([rule, n]) => `  ${n}× ${rule}`),
      '',
      'These are violations this project has chosen not to block on. They are not fixed, and a ' +
        'build passing does not mean they are gone. Ask explain_rule about any of them.',
    ].join('\n'),
    data: {
      file,
      exists: true,
      entries: baseline.entries.length,
      pages: byPath.size,
      by_impact: byImpact,
      by_rule: Object.fromEntries(topRules),
      paths: [...byPath.keys()].sort(),
    },
  };
}

// ── scan_url ─────────────────────────────────────────────────────────────────

/**
 * Scan a public URL through the hosted API.
 *
 * This server does not fetch the URL itself, and that is the security design rather
 * than an implementation detail. The API applies the SSRF guard, so an agent that has
 * been talked into scanning `http://169.254.169.254/` by something it read on a web
 * page gets a refusal from a service whose job is refusing that, instead of this
 * process making the request.
 */
export async function scanURL(
  { url, standard = 'wcag22aa', wait_for, baseline },
  { token = process.env.SKIPLINK_TOKEN, api = process.env.SKIPLINK_API || 'https://api.skiplink.dev', fetchImpl = fetch } = {},
) {
  if (!url || typeof url !== 'string') {
    return { isError: true, text: 'Give a url to scan.' };
  }
  if (!token) {
    return {
      isError: true,
      text:
        'Scanning needs an API key. Set SKIPLINK_TOKEN in this server\'s environment — the free ' +
        'tier is 500 scans a month and needs no card: https://skiplink.dev/signup/\n\n' +
        'The other tools here (explain_rule, list_rules, list_standards, read_baseline) work ' +
        'without one.',
    };
  }

  let response;
  try {
    response = await fetchImpl(`${api.replace(/\/$/, '')}/v1/scan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url, standard, ...(wait_for ? { wait_for } : {}) }),
    });
  } catch (err) {
    return { isError: true, text: `Could not reach the Skiplink API at ${api}: ${err.message}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { isError: true, text: `The API returned a non-JSON response (HTTP ${response.status}).` };
  }

  if (!response.ok || body.error) {
    const e = body.error || {};
    return {
      isError: true,
      text: `Scan refused (HTTP ${response.status}${e.code ? `, ${e.code}` : ''}): ${e.message || 'unknown error'}`,
    };
  }

  const violations = (body.violations || []).map(sanitiseViolation);
  const summary = body.summary || { critical: 0, serious: 0, moderate: 0, minor: 0 };

  // If a baseline is named, say which findings are new — that is the question worth
  // answering, and it is the difference between a list and a verdict.
  let newness = null;
  if (baseline) {
    const base = await loadBaseline(path.resolve(baseline)).catch(() => null);
    if (base) {
      const outcome = diff([{ url: body.url, violations: body.violations || [] }], base);
      newness = { new: outcome.isNew.length, accepted: outcome.accepted.length, drifted: outcome.drifted.length };
    }
  }

  const header = [
    `${body.url} — score ${body.score}, ${Object.values(summary).reduce((a, b) => a + b, 0)} violation(s)`,
    `critical ${summary.critical}, serious ${summary.serious}, moderate ${summary.moderate}, minor ${summary.minor}`,
    `axe-core ${body.engine?.axe_core || '?'}, standard ${body.standard}`,
  ];
  if (newness) {
    header.push(
      `Against ${baseline}: ${newness.new} new, ${newness.accepted} already accepted, ${newness.drifted} drifted.`,
    );
  }

  const detail = violations.length
    ? violations
        .map(
          (v) =>
            `[${v.impact}] ${v.rule}  ${v.selector}\n  ${v.message}\n  ${v.html}` +
            (v.help_url ? `\n  ${v.help_url}` : ''),
        )
        .join('\n\n')
    : 'No automatically detectable violations found.';

  return {
    text: [header.join('\n'), '', untrustedBlock(body.url, detail), '', DISCLAIMER].join('\n'),
    data: {
      url: body.url,
      final_url: body.final_url,
      standard: body.standard,
      score: body.score,
      summary,
      engine: body.engine,
      violations,
      ...(newness ? { baseline: { file: baseline, ...newness } } : {}),
      disclaimer: DISCLAIMER,
    },
  };
}

export { DISCLAIMER };
