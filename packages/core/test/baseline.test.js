import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, baselineFrom, shouldFail, pathKeyFor } from '../src/baseline.js';

// Mirrors how the server computes fingerprints: the exact one is hash(rule +
// selector), the loose one hash(rule + element text). Both therefore vary with
// the rule, and a fixture that holds fingerprint_loose constant across two
// different rules is describing a state the real system cannot produce.
const v = (over = {}) => {
  const merged = {
    rule: 'color-contrast',
    impact: 'serious',
    selector: '.hero__subtitle',
    message: 'Contrast 3.03:1',
    text: 'ship faster',
    ...over,
  };
  return {
    ...merged,
    fingerprint: over.fingerprint ?? `f_${merged.rule}|${merged.selector}`,
    fingerprint_loose: over.fingerprint_loose ?? `f_${merged.rule}|${merged.text}`,
  };
};

const scan = (url, violations) => ({ url, violations, status: 'done' });

// ── The core promise ─────────────────────────────────────────────────────────

test('a violation in the baseline does not fail the build', () => {
  const results = [scan('https://example.com/', [v()])];
  const baseline = baselineFrom(results);
  const d = diff(results, baseline);

  assert.equal(d.isNew.length, 0);
  assert.equal(d.accepted.length, 1);
  assert.equal(shouldFail(d, 'new').fail, false);
});

test('a violation not in the baseline fails the build', () => {
  const baseline = baselineFrom([scan('https://example.com/', [v()])]);
  const d = diff(
    [scan('https://example.com/', [v(), v({ rule: 'image-alt' })])],
    baseline,
  );

  assert.equal(d.isNew.length, 1);
  assert.equal(d.isNew[0].rule, 'image-alt');
  assert.equal(shouldFail(d, 'new').fail, true);
});

test('with no baseline at all, every violation is new', () => {
  const d = diff([scan('https://example.com/', [v(), v({ rule: 'image-alt' })])], null);
  assert.equal(d.isNew.length, 2);
  assert.equal(d.accepted.length, 0);
});

// ── Preview deployments ──────────────────────────────────────────────────────

test('a baseline matches across changing preview hostnames', () => {
  // The scenario this design exists for: CI scans pr-482.preview.example.com
  // today and pr-483.preview.example.com tomorrow. Keying on the full URL would
  // report every violation as new on every pull request.
  const baseline = baselineFrom([scan('https://pr-482.preview.example.com/pricing', [v()])]);
  const d = diff([scan('https://pr-483.preview.example.com/pricing', [v()])], baseline);

  assert.equal(d.isNew.length, 0, 'a new preview host must not invalidate the baseline');
  assert.equal(d.accepted.length, 1);
});

test('the same violation on a different path is new', () => {
  const baseline = baselineFrom([scan('https://example.com/pricing', [v()])]);
  const d = diff([scan('https://example.com/checkout', [v()])], baseline);

  assert.equal(d.isNew.length, 1, 'paths are part of identity — a new page is not pre-accepted');
});

test('trailing slashes are not a difference', () => {
  assert.equal(pathKeyFor('https://example.com/pricing/'), pathKeyFor('https://example.com/pricing'));
  assert.equal(pathKeyFor('https://example.com'), '/');
  assert.equal(pathKeyFor('https://example.com/'), '/');
});

test('query strings are part of identity', () => {
  // ?lang=de can be a genuinely different page.
  assert.notEqual(pathKeyFor('https://example.com/p?lang=de'), pathKeyFor('https://example.com/p'));
});

// ── Selector churn ───────────────────────────────────────────────────────────

test('a restyle that only renames classes does not fail the build', () => {
  const baseline = baselineFrom([scan('https://example.com/', [v()])]);
  // Same element, same text, new bundler-hashed class: exact fingerprint moves,
  // loose one does not.
  const restyled = v({ selector: '.Hero_subtitle__x7f2q' }); // same rule, same text
  const d = diff([scan('https://example.com/', [restyled])], baseline);

  assert.equal(d.isNew.length, 0, 'a class rename must not read as a new violation');
  assert.equal(d.drifted.length, 1, 'but it should be surfaced so the baseline can be refreshed');
  assert.equal(shouldFail(d, 'new').fail, false);
});

test('drift is only forgiven once per baseline entry', () => {
  // Two elements now share the loose fingerprint of a single accepted one.
  // The first is drift; the second is a genuinely new violation and must fail.
  const baseline = baselineFrom([scan('https://example.com/', [v()])]);
  const d = diff(
    [
      scan('https://example.com/', [
        v({ selector: '.a' }),
        v({ selector: '.b' }),
      ]),
    ],
    baseline,
  );

  assert.equal(d.drifted.length, 1);
  assert.equal(d.isNew.length, 1);
  assert.equal(shouldFail(d, 'new').fail, true);
});

// ── Fixed ────────────────────────────────────────────────────────────────────

test('violations that disappear are reported as fixed, not failed', () => {
  const baseline = baselineFrom([
    scan('https://example.com/', [v(), v({ rule: 'image-alt' })]),
  ]);
  const d = diff([scan('https://example.com/', [v()])], baseline);

  assert.equal(d.fixed.length, 1);
  assert.equal(d.fixed[0].rule, 'image-alt');
  assert.equal(shouldFail(d, 'new').fail, false, 'fixing something must never fail a build');
});

test('scanning a subset of pages does not report the others as fixed failures', () => {
  const baseline = baselineFrom([
    scan('https://example.com/a', [v()]),
    scan('https://example.com/b', [v({ selector: '.other' })]),
  ]);
  const d = diff([scan('https://example.com/a', [v()])], baseline);

  assert.equal(d.fixed.length, 1, 'page b is reported as unseen');
  assert.equal(shouldFail(d, 'new').fail, false, 'but it must not fail the build');
});

// ── fail-on ──────────────────────────────────────────────────────────────────

test('--fail-on serious ignores new violations below the threshold', () => {
  const d = diff(
    [scan('https://example.com/', [v({ impact: 'minor' })])],
    null,
  );
  assert.equal(shouldFail(d, 'serious').fail, false);
  assert.equal(shouldFail(d, 'minor').fail, true);
  assert.equal(shouldFail(d, 'new').fail, true);
});

test('--fail-on serious still respects the baseline', () => {
  // Otherwise a site with accepted serious violations can never go green, and
  // the baseline may as well not exist.
  const results = [scan('https://example.com/', [v({ impact: 'critical' })])];
  const baseline = baselineFrom(results);
  const d = diff(results, baseline);

  assert.equal(shouldFail(d, 'critical').fail, false);
});

test('--fail-on never always passes', () => {
  const d = diff([scan('https://example.com/', [v({ impact: 'critical' })])], null);
  assert.equal(shouldFail(d, 'never').fail, false);
});

test('an unknown --fail-on value is an error, not a silent pass', () => {
  const d = diff([scan('https://example.com/', [v()])], null);
  assert.throws(() => shouldFail(d, 'sevre'), /Unknown --fail-on/);
});

// ── Baseline file ────────────────────────────────────────────────────────────

test('regenerating an unchanged baseline produces identical bytes', () => {
  // The file lives in git. Nondeterministic ordering would produce a diff on
  // every run and make an accepted violation impossible to review.
  const results = [
    scan('https://example.com/b', [v({ rule: 'image-alt', fingerprint: 'f_2' }), v({ fingerprint: 'f_1' })]),
    scan('https://example.com/a', [v({ fingerprint: 'f_3' })]),
  ];
  const now = '2026-07-28T00:00:00.000Z';
  const a = JSON.stringify(baselineFrom(results, { now }));
  const b = JSON.stringify(baselineFrom(results.slice().reverse(), { now }));

  assert.equal(a, b, 'entry order must not depend on scan order');
});
