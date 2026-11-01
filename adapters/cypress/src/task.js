// The Node half of the Cypress adapter.
//
// Cypress splits a run across two processes: spec code executes in the browser,
// and only `setupNodeEvents` runs in Node. That split decides the whole design
// here, because the two things this adapter must do — hash a violation and read a
// baseline file — are both impossible in a browser. `node:crypto` is not there and
// neither is the filesystem.
//
// So the browser does exactly one thing: run axe-core and post the raw results
// over. Fingerprinting, baseline loading, diffing and the verdict all happen here,
// in the same process, using the same @skiplink/core functions the CLI and the
// Playwright adapter use. That is not a workaround; it is why a baseline recorded
// through Cypress matches one recorded through the hosted API.
//
// Register it in cypress.config.js:
//
//   import { defineConfig } from 'cypress';
//   import { registerSkiplinkTasks } from '@skiplink/cypress/task';
//
//   export default defineConfig({
//     e2e: {
//       setupNodeEvents(on, config) {
//         registerSkiplinkTasks(on, config);
//         return config;
//       },
//     },
//   });

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  fingerprint,
  fingerprintLoose,
  flatten,
  tagsForStandard,
} from '@skiplink/core';
import {
  loadBaseline,
  saveBaseline,
  baselineFrom,
  diff,
  shouldFail,
} from '@skiplink/core/baseline';

const require = createRequire(import.meta.url);

const DEFAULT_BASELINE = '.skiplink/baseline.json';

let axeCache = null;

/**
 * The axe-core source, read once, to be evaluated in the browser.
 *
 * Resolved here rather than in the spec because module resolution from a browser
 * bundle is a different and much worse problem, and because reading it in Node
 * means the version reported in results is unambiguously the one in the caller's
 * lockfile.
 */
function axeSource() {
  if (axeCache) return axeCache;
  try {
    const source = readFileSync(require.resolve('axe-core'), 'utf8');
    const { version } = require('axe-core/package.json');
    axeCache = { source, version };
    return axeCache;
  } catch (err) {
    throw new Error(
      '@skiplink/cypress needs axe-core, which is a peer dependency so that the version in ' +
        'your results is the version in your lockfile.\n\n  npm install --save-dev axe-core\n\n' +
        `(${err.message})`,
    );
  }
}

/**
 * Turn raw axe output into a Skiplink result, identical in shape to what the
 * hosted API returns.
 */
export function resultFrom({ url, violations, passes, standard, axeVersion, browser }) {
  const flat = flatten(violations).map((v) => ({
    ...v,
    fingerprint: fingerprint(v.rule, v.selector),
    fingerprint_loose: fingerprintLoose(v.rule, v.html),
  }));

  const summary = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of flat) {
    if (v.impact in summary) summary[v.impact] += 1;
  }

  return {
    url,
    standard,
    status: 'done',
    engine: { axe_core: axeVersion, chromium: browser || '' },
    score: score(summary, passes),
    summary,
    violations: flat,
    passes,
  };
}

// The server's formula: the share of passed checks, weighted by impact.
function score(summary, passes) {
  const weighted =
    summary.critical * 10 + summary.serious * 5 + summary.moderate * 2 + summary.minor;
  const total = passes + weighted;
  if (total === 0) return 100;
  return Math.round((100 * passes) / total);
}

/**
 * Merge one run's entries into an existing baseline.
 *
 * Replaces only the paths this run actually visited. A spec file opens some pages,
 * not all of them, and rewriting the whole file from one run would silently discard
 * every entry for every page it did not touch — which would look like the baseline
 * working right up until the build that needed it.
 */
export function mergeBaselines(existing, fresh) {
  if (!existing) return fresh;
  const freshPaths = new Set(fresh.entries.map((e) => e.path));
  return {
    ...existing,
    entries: [...existing.entries.filter((e) => !freshPaths.has(e.path)), ...fresh.entries],
  };
}

/**
 * Decide whether a result passes, against the baseline on disk.
 *
 * Returns a plain object rather than throwing, because this runs in Node and the
 * assertion has to fail in the browser process where the test is.
 */
export async function check(payload) {
  const {
    url,
    violations,
    passes,
    standard = 'wcag22aa',
    axeVersion,
    browser,
    baseline: baselinePath = process.env.SKIPLINK_BASELINE ?? DEFAULT_BASELINE,
    failOn = 'new',
    updateBaseline = process.env.SKIPLINK_UPDATE_BASELINE === '1',
  } = payload;

  const result = resultFrom({ url, violations, passes, standard, axeVersion, browser });

  if (updateBaseline) {
    if (!baselinePath) {
      throw new Error('Cannot update a baseline when baseline is false. Give a path.');
    }
    const existing = await loadBaseline(baselinePath);
    await saveBaseline(baselinePath, mergeBaselines(existing, baselineFrom([result])));
    return { fail: false, updated: true, result, baseline: baselinePath };
  }

  const base = baselinePath ? await loadBaseline(baselinePath) : null;
  const outcome = diff([result], base);
  const verdict = shouldFail(outcome, failOn);

  return {
    fail: verdict.fail,
    reason: verdict.reason,
    message: verdict.fail ? formatFailure(verdict, outcome, failOn, baselinePath) : '',
    result,
    outcome: {
      isNew: outcome.isNew,
      accepted: outcome.accepted.length,
      drifted: outcome.drifted.length,
      fixed: outcome.fixed.length,
    },
  };
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const byImpact = (a, b) =>
  (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9) || a.rule.localeCompare(b.rule);

export function formatFailure(verdict, outcome, failOn, baselinePath) {
  // verdict.blocking, not outcome.isNew: with failOn set to an impact floor those
  // are different sets, and listing violations that did not cause the failure
  // sends someone looking for the wrong thing.
  const blocking = verdict.blocking;
  const lines = [
    `${blocking.length} accessibility violation${blocking.length === 1 ? '' : 's'} on this page`,
    '',
  ];

  for (const v of [...blocking].sort(byImpact)) {
    lines.push(`  ${v.impact.toUpperCase()}  ${v.rule}`);
    lines.push(`    ${v.selector}`);
    if (v.message) lines.push(`    ${v.message}`);
    if (v.help_url) lines.push(`    ${v.help_url}`);
    lines.push('');
  }

  if (outcome.drifted.length > 0) {
    lines.push(
      `  ${outcome.drifted.length} accepted violation(s) moved to a new selector; matched on text.`,
      '',
    );
  }

  if (failOn === 'new' && baselinePath) {
    lines.push(
      `These are new since ${baselinePath}. If they are acceptable, record them with:`,
      '  SKIPLINK_UPDATE_BASELINE=1 npx cypress run',
    );
  } else if (failOn === 'new') {
    lines.push('No baseline is configured, so every violation counts as new.');
  }

  // The disclaimer the API attaches to every result. A green suite is exactly
  // where someone concludes the page is compliant.
  lines.push(
    '',
    'Automated testing detects a subset of WCAG success criteria. A passing check does not',
    'mean the page conforms to WCAG or complies with the ADA, Section 508, or the European',
    'Accessibility Act.',
  );

  return lines.join('\n');
}

/** Register the tasks the browser-side commands call. */
export function registerSkiplinkTasks(on, _config = {}) {
  if (typeof on !== 'function') {
    throw new TypeError(
      'registerSkiplinkTasks(on, config) takes the `on` function Cypress passes to setupNodeEvents.',
    );
  }

  on('task', {
    'skiplink:axe': () => axeSource(),
    'skiplink:check': (payload) => check(payload),
    // Resolved in Node so an unknown standard is refused before axe runs with no
    // tag filter at all, which would silently mean "every rule".
    'skiplink:tags': (standard) => {
      const tags = tagsForStandard(standard);
      if (tags === undefined) {
        throw new Error(
          `Unknown standard ${JSON.stringify(standard)}. One of: wcag2a, wcag2aa, ` +
            'wcag21a, wcag21aa, wcag22aa, section508, all.',
        );
      }
      // null means "every rule"; JSON round-trips it, false would not.
      return { tags };
    },
  });

  return on;
}
