// Skiplink for Playwright.
//
// Runs axe-core in the page your test already has open, and fails the test only
// on violations that are not in your baseline.
//
//   import { expectNoNewViolations } from '@skiplink/playwright';
//
//   test('checkout is accessible', async ({ page }) => {
//     await page.goto('/checkout');
//     await page.getByLabel('Card number').fill('4242424242424242');
//     await expectNoNewViolations(page);
//   });
//
// Why this exists alongside the hosted API, rather than as a thin client for it:
// the hosted scanner fetches a URL from our infrastructure, so it can only ever
// see pages that are on the public internet and reachable without signing in.
// That excludes most of what actually breaks. A checkout form behind a login, a
// dashboard in a review app, anything on localhost in CI — our own SSRF guard
// refuses those by design, and correctly.
//
// A test suite is already past all of that. The browser is open, the user is
// signed in, the form is filled. Running the same engine there and computing the
// same fingerprints means one baseline file covers both paths: public pages
// scanned by the hosted API, private ones by the tests.
//
// The engine is axe-core, unmodified, resolved from your own node_modules — the
// same rules and version as everything else we run.

import {
  fingerprint,
  fingerprintLoose,
  diff,
  loadBaseline,
  saveBaseline,
  baselineFrom,
  shouldFail,
} from '@skiplink/core';

import { runAxe, axeVersion } from './axe.js';

export { runAxe, axeVersion };

const DEFAULT_BASELINE = '.skiplink/baseline.json';

/**
 * Run the accessibility checks against the current state of `page`.
 *
 * Returns the same result shape the hosted API returns, so anything that reads a
 * scan result — reporters, the baseline file, your own assertions — does not care
 * which path produced it.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {string} [options.standard] wcag22aa by default, as everywhere else.
 * @param {string|string[]} [options.include] Restrict to a selector or selectors.
 * @param {string|string[]} [options.exclude] Skip a selector or selectors.
 * @param {string[]} [options.disableRules] Rule ids to skip entirely.
 */
export async function scan(page, options = {}) {
  const raw = await runAxe(page, options);

  const violations = raw.violations.map((v) => ({
    ...v,
    fingerprint: fingerprint(v.rule, v.selector),
    fingerprint_loose: fingerprintLoose(v.rule, v.html),
  }));

  const summary = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    if (v.impact in summary) summary[v.impact] += 1;
  }

  return {
    // page.url() rather than a configured base: the baseline keys on path, and
    // the path that matters is the one actually under test after any redirect.
    url: page.url(),
    standard: options.standard || 'wcag22aa',
    status: 'done',
    engine: { axe_core: raw.axeVersion, chromium: raw.browserVersion },
    score: score(summary, raw.passes),
    summary,
    violations,
    passes: raw.passes,
  };
}

/**
 * Fail the test if the page has accessibility violations that are not already in
 * the baseline.
 *
 * Throws a plain Error with the violations formatted the same way the CLI prints
 * them, so a failing test reads like a failing gate. Playwright shows the message
 * in the report without any custom matcher.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options] Everything scan() takes, plus:
 * @param {string|false} [options.baseline] Baseline path, or false for none.
 * @param {'new'|'any'|'critical'|'serious'} [options.failOn] Defaults to 'new'.
 * @param {boolean} [options.updateBaseline] Record the current state and pass.
 */
export async function expectNoNewViolations(page, options = {}) {
  const {
    baseline: baselinePath = process.env.SKIPLINK_BASELINE ?? DEFAULT_BASELINE,
    failOn = 'new',
    // Deliberately an environment variable and not only an option: updating a
    // baseline is something you do once from a terminal, and threading a flag
    // through a test runner to reach this call is worse than
    // SKIPLINK_UPDATE_BASELINE=1 npx playwright test.
    updateBaseline = process.env.SKIPLINK_UPDATE_BASELINE === '1',
    ...scanOptions
  } = options;

  const result = await scan(page, scanOptions);

  if (updateBaseline) {
    if (!baselinePath) {
      throw new Error(
        'Cannot update a baseline when baseline is false. Give a path, or drop the update.',
      );
    }
    // Merge rather than replace: a test run visits some of the pages, not all of
    // them, and rewriting the file from one run would silently discard the
    // entries for every page this particular test did not open.
    const existing = await loadBaseline(baselinePath);
    const merged = mergeBaselines(existing, baselineFrom([result]));
    await saveBaseline(baselinePath, merged);
    return result;
  }

  const base = baselinePath ? await loadBaseline(baselinePath) : null;
  const outcome = diff([result], base);

  // shouldFail returns a verdict object, not a boolean — an object is always
  // truthy, so treating it as one makes every check fail.
  const verdict = shouldFail(outcome, failOn);
  if (verdict.fail) {
    throw new Error(formatFailure(outcome, verdict, failOn, baselinePath));
  }
  return result;
}

/**
 * Merge a run's entries into an existing baseline, keyed the same way the diff
 * keys them so a re-record of one page cannot disturb another.
 */
function mergeBaselines(existing, fresh) {
  if (!existing) return fresh;

  const freshPaths = new Set(fresh.entries.map((e) => e.path));
  const kept = existing.entries.filter((e) => !freshPaths.has(e.path));

  return {
    ...existing,
    entries: [...kept, ...fresh.entries],
  };
}

function formatFailure(outcome, verdict, failOn, baselinePath) {
  // Formatted here rather than through the CLI's reporter: that one writes ANSI
  // colour for a terminal and takes the whole run's scan list, neither of which
  // belongs in a test runner's failure message.
  // verdict.blocking, not outcome.isNew: with failOn set to an impact threshold
  // those are different sets, and listing violations that did not cause the
  // failure sends someone looking for the wrong thing.
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
      `  ${outcome.drifted.length} accepted violation(s) moved to a new selector; ` +
        'they were matched on element text instead.',
      '',
    );
  }

  if (failOn === 'new' && baselinePath) {
    lines.push(
      `These are new since ${baselinePath}. If they are acceptable, record them with:`,
      '  SKIPLINK_UPDATE_BASELINE=1 npx playwright test',
    );
  } else if (failOn === 'new') {
    lines.push(
      'No baseline is configured, so every violation counts as new. Point at one with',
      "  expectNoNewViolations(page, { baseline: '.skiplink/baseline.json' })",
    );
  }

  // The same disclaimer the API attaches to every result. A test that passes is
  // not a conformance claim, and the place a developer is most likely to draw
  // that conclusion is a green suite.
  lines.push(
    '',
    'Automated testing detects a subset of WCAG success criteria. A passing check does not',
    'mean the page conforms to WCAG or complies with the ADA, Section 508, or the European',
    'Accessibility Act.',
  );

  return lines.join('\n');
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const byImpact = (a, b) =>
  (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9) || a.rule.localeCompare(b.rule);

// Same formula as the server: the share of passed checks, weighted by impact.
// Duplicated here rather than shared because it is four lines and lives in the
// Go response type; the fingerprints are what must not drift, and those are
// shared.
function score(summary, passes) {
  const weighted =
    summary.critical * 10 + summary.serious * 5 + summary.moderate * 2 + summary.minor;
  const total = passes + weighted;
  if (total === 0) return 100;
  return Math.round((100 * passes) / total);
}
