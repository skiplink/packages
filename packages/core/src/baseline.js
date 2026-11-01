// The baseline: the difference between a checker and a gate.
//
// A baseline is a committed list of violations a team has already seen and
// decided not to block on. The gate then fails on what is new, so turning it on
// for an existing site does not paint every build red — which is the failure
// mode that gets accessibility checks deleted from pipelines in the first week.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BASELINE_VERSION = 1;

/**
 * Violations are keyed by PATH, not by full URL.
 *
 * Preview deployments get a fresh hostname on every pull request
 * (pr-482.preview.example.com), and CI scans the preview, not production. A
 * baseline keyed on the full URL would therefore match nothing on the very runs
 * it exists to serve, and every build would report every violation as new — the
 * exact failure the baseline is meant to prevent.
 *
 * The trade is that two hosts serving genuinely different content at the same
 * path share baseline entries. That is rare, and the alternative is a feature
 * that silently does not work on the platform most of its users deploy to.
 */
export function pathKeyFor(url) {
  try {
    const u = new URL(url);
    // Trailing slashes are not a meaningful difference between two scans.
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return path + u.search;
  } catch {
    return url;
  }
}

const exactKey = (url, v) => `${pathKeyFor(url)}|${v.fingerprint}`;

// The rule is in the loose key as well as inside the hash. Belt and braces: the
// loose fingerprint is deliberately fuzzy, and it must never be able to match
// across two different rules just because two elements share their text.
const looseKey = (url, v) => `${pathKeyFor(url)}|~${v.rule}|${v.fingerprint_loose}`;
const looseKeyForEntry = (e) => `${e.path}|~${e.rule}|${e.fingerprint_loose}`;

export function emptyBaseline() {
  return { version: BASELINE_VERSION, generated_at: null, engine: null, entries: [] };
}

export async function loadBaseline(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null; // absent is a normal first run
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  if (parsed.version !== BASELINE_VERSION) {
    throw new Error(
      `${path} is version ${parsed.version}; this CLI reads version ${BASELINE_VERSION}. ` +
        `Regenerate it with --update-baseline.`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${path} has no entries array.`);
  }
  return parsed;
}

export async function saveBaseline(path, baseline) {
  await mkdir(dirname(path), { recursive: true });
  // Trailing newline and stable key order: this file lives in git, and a diff
  // that churns on formatting makes reviewing an accepted violation harder than
  // it needs to be.
  await writeFile(path, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

/**
 * Build a baseline from scan results.
 * @param {Array<{url: string, violations: Array}>} results
 * @param {{engine?: object, now?: string}} [opts]
 */
export function baselineFrom(results, opts = {}) {
  const entries = [];
  for (const result of results) {
    for (const v of result.violations || []) {
      entries.push({
        path: pathKeyFor(result.url),
        fingerprint: v.fingerprint,
        fingerprint_loose: v.fingerprint_loose,
        rule: v.rule,
        impact: v.impact,
        // Kept for humans reading the diff in a pull request. Not used for
        // matching — the selector already lives inside the fingerprint.
        selector: v.selector,
      });
    }
  }

  // Sorted so regenerating an unchanged baseline produces no git diff.
  entries.sort((a, b) =>
    a.path.localeCompare(b.path) ||
    a.rule.localeCompare(b.rule) ||
    a.fingerprint.localeCompare(b.fingerprint),
  );

  return {
    version: BASELINE_VERSION,
    generated_at: opts.now || new Date().toISOString(),
    engine: opts.engine || null,
    entries,
  };
}

/**
 * Compare scan results against a baseline.
 *
 * @param {Array<{url: string, violations: Array}>} results
 * @param {object|null} baseline
 * @returns {{isNew: Array, accepted: Array, drifted: Array, fixed: Array, total: number}}
 */
export function diff(results, baseline) {
  const entries = baseline?.entries || [];

  // Exact matching is by identity and unlimited: a fingerprint names a specific
  // violation, so seeing it is seeing that violation.
  const exact = new Set(entries.map((e) => `${e.path}|${e.fingerprint}`));

  // Loose matching is CONSUMED, one match per baseline entry.
  //
  // Without the limit, a single accepted entry absorbs every new violation that
  // happens to share its rule and text — ten new broken links on a page with one
  // accepted broken link would all pass as "drift", and the gate would be open
  // while reporting green. The fuzzy fallback exists to survive a class rename,
  // not to raise a ceiling.
  const looseRemaining = new Map();
  const looseEntries = new Map();
  entries.forEach((e, i) => {
    if (!e.fingerprint_loose) return;
    const lk = looseKeyForEntry(e);
    looseRemaining.set(lk, (looseRemaining.get(lk) || 0) + 1);
    if (!looseEntries.has(lk)) looseEntries.set(lk, []);
    looseEntries.get(lk).push(i);
  });

  const seen = new Set();
  const isNew = [];
  const accepted = [];
  const drifted = [];
  let total = 0;

  for (const result of results) {
    for (const v of result.violations || []) {
      total += 1;
      const item = { ...v, url: result.url, path: pathKeyFor(result.url) };
      const ek = exactKey(result.url, v);

      if (exact.has(ek)) {
        accepted.push(item);
        entries.forEach((e, i) => {
          if (`${e.path}|${e.fingerprint}` === ek) seen.add(i);
        });
        continue;
      }

      // Exact miss, loose hit: the same violation on an element whose selector
      // changed — a restyle, a renamed class, a bundler hash. Accepted, but
      // surfaced separately so a team can refresh the baseline deliberately
      // instead of watching it rot.
      const lk = looseKey(result.url, v);
      const remaining = looseRemaining.get(lk) || 0;
      if (remaining > 0) {
        looseRemaining.set(lk, remaining - 1);
        const candidates = looseEntries.get(lk) || [];
        const idx = candidates.find((i) => !seen.has(i));
        if (idx !== undefined) seen.add(idx);
        drifted.push(item);
        continue;
      }

      isNew.push(item);
    }
  }

  const unseen = entries.filter((_, i) => !seen.has(i));

  // Anything left in the baseline was not seen this run: fixed, or on a page
  // this run did not scan. Reported, never failed on — a scan of one URL must
  // not conclude that violations on twelve others were fixed.
  return { isNew, accepted, drifted, fixed: unseen, total };
}

const IMPACT_ORDER = ['minor', 'moderate', 'serious', 'critical'];

/**
 * Decide the exit condition.
 *
 * failOn:
 *   'new'      — fail on any violation not in the baseline (the gate)
 *   'critical' | 'serious' | 'moderate' | 'minor' — fail at or above that
 *                impact, baseline or not (the pre-baseline behaviour)
 *   'never'    — report only
 */
export function shouldFail(diffResult, failOn) {
  if (failOn === 'never') return { fail: false, reason: '', blocking: [] };

  if (failOn === 'new') {
    return {
      fail: diffResult.isNew.length > 0,
      reason: `${diffResult.isNew.length} new violation${diffResult.isNew.length === 1 ? '' : 's'}`,
      blocking: diffResult.isNew,
    };
  }

  const floor = IMPACT_ORDER.indexOf(failOn);
  if (floor === -1) {
    throw new Error(
      `Unknown --fail-on value "${failOn}". Use: new, critical, serious, moderate, minor, never.`,
    );
  }

  // Impact thresholds still respect the baseline — otherwise --fail-on serious
  // on a site with accepted serious violations can never go green, and the
  // baseline may as well not exist.
  const blocking = diffResult.isNew.filter(
    (v) => IMPACT_ORDER.indexOf(v.impact) >= floor,
  );
  return {
    fail: blocking.length > 0,
    reason: `${blocking.length} new ${failOn}-or-above violation${blocking.length === 1 ? '' : 's'}`,
    blocking,
  };
}
