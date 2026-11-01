// The rule catalogue, read from axe-core's own metadata.
//
// These tests deliberately assert relationships rather than exact numbers. "105 rules"
// would be true today and wrong at the next axe-core release, and a test that has to be
// updated on every dependency bump gets updated without being read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allRules,
  findRule,
  rulesForStandard,
  searchRules,
  standardsSummary,
  criteriaFor,
  levelFor,
  wcagVersionFor,
  AXE_VERSION,
} from '../src/rules.js';

test('the catalogue comes from axe-core and is not empty', () => {
  const rules = allRules();
  assert.ok(rules.length > 50, `only ${rules.length} rules — that does not look like axe-core`);
  assert.match(AXE_VERSION, /^\d+\.\d+\.\d+/);
});

test('every rule has the fields an answer needs', () => {
  for (const r of allRules()) {
    assert.ok(r.rule, 'missing id');
    assert.ok(r.help, `${r.rule} has no help text`);
    assert.ok(r.description, `${r.rule} has no description`);
    assert.ok(Array.isArray(r.wcag), `${r.rule} has no criteria array`);
    assert.equal(typeof r.best_practice, 'boolean');
  }
});

test('a WCAG rule has criteria and a level; a best-practice rule has neither', () => {
  const contrast = findRule('color-contrast');
  assert.deepEqual(contrast.wcag, ['1.4.3']);
  assert.equal(contrast.level, 'AA');
  assert.equal(contrast.best_practice, false);

  const region = findRule('region');
  assert.equal(region.best_practice, true);
  assert.equal(region.level, null);
  assert.deepEqual(region.wcag, []);
});

test('the telemetry parameter is stripped from documentation links', () => {
  // axe appends ?application=axeAPI, and handing that to a reader is passing on a
  // tracking parameter we had no reason to keep.
  for (const r of allRules()) {
    if (r.help_url) assert.ok(!r.help_url.includes('application=axeAPI'), r.rule);
  }
});

test('findRule is forgiving about whitespace and strict about everything else', () => {
  assert.equal(findRule('  color-contrast  ').rule, 'color-contrast');
  assert.equal(findRule('Color-Contrast'), null, 'rule ids are lowercase and matching is exact');
  assert.equal(findRule(''), null);
  assert.equal(findRule(null), null);
  assert.equal(findRule(undefined), null);
});

test('criteria are parsed including two-digit criterion numbers', () => {
  assert.deepEqual(criteriaFor(['wcag143']), ['1.4.3']);
  assert.deepEqual(criteriaFor(['wcag1411']), ['1.4.11']);
  assert.deepEqual(criteriaFor(['cat.color', 'wcag2aa']), [], 'only criterion tags count');
  assert.deepEqual(criteriaFor(), []);
});

test('level reports the strictest level a rule belongs to', () => {
  // A rule tagged at more than one level applies from the strictest one, and that is
  // what determines when it starts to matter to a given project.
  assert.equal(levelFor(['wcag2a']), 'A');
  assert.equal(levelFor(['wcag2a', 'wcag2aa']), 'AA');
  assert.equal(levelFor(['wcag2aaa']), 'AAA');
  assert.equal(levelFor(['best-practice']), null);
  assert.equal(levelFor([]), null);
});

test('wcag version is the newest one a rule appears in', () => {
  assert.equal(wcagVersionFor(['wcag2aa']), '2.0');
  assert.equal(wcagVersionFor(['wcag2aa', 'wcag21aa']), '2.1');
  assert.equal(wcagVersionFor(['wcag2aa', 'wcag21aa', 'wcag22aa']), '2.2');
  assert.equal(wcagVersionFor(['best-practice']), null);
});

test('standards nest the way WCAG does', () => {
  const a20 = rulesForStandard('wcag2a').map((r) => r.rule);
  const aa22 = rulesForStandard('wcag22aa').map((r) => r.rule);

  assert.ok(aa22.length > a20.length);
  for (const rule of a20) {
    assert.ok(aa22.includes(rule), `${rule} is in 2.0 A but not in 2.2 AA`);
  }
});

test('all means the whole catalogue, not an empty result', () => {
  // axe expresses "every rule" as an absent tag filter, which is easy to turn into an
  // empty list by accident.
  assert.equal(rulesForStandard('all').length, allRules().length);
});

test('an unknown standard is undefined, so callers can tell it apart from "none"', () => {
  assert.equal(rulesForStandard('wcag99zz'), undefined);
  assert.notEqual(rulesForStandard('section508'), undefined);
});

test('no WCAG standard includes best-practice rules', () => {
  for (const name of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']) {
    const bp = rulesForStandard(name).filter((r) => r.best_practice);
    assert.equal(bp.length, 0, `${name} included best-practice rules: ${bp.map((r) => r.rule)}`);
  }
});

test('search finds a rule by name, by help text and by criterion', () => {
  assert.ok(searchRules('contrast').some((r) => r.rule === 'color-contrast'));
  assert.ok(searchRules('alt').some((r) => r.rule === 'image-alt'));
  assert.ok(searchRules('1.4.3').some((r) => r.wcag.includes('1.4.3')));
  assert.deepEqual(searchRules(''), [], 'an empty query matches nothing rather than everything');
  assert.deepEqual(searchRules(null), []);
});

test('every standard in the summary resolves to rules', () => {
  for (const s of standardsSummary()) {
    assert.ok(s.rules > 0, `${s.standard} resolved to no rules`);
    if (s.standard !== 'all' && s.standard !== 'section508') {
      assert.ok(s.wcag_criteria > 0, `${s.standard} has no criteria`);
    }
  }
});
