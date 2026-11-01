// The WCAG reference data, checked against axe-core.
//
// data/wcag.json is hand-authored, so the failure mode is a criterion that axe
// reports and the reference does not document. That would silently drop rules from
// the published coverage table — and the coverage table is the one page whose whole
// value is being accurate about what automation does and does not catch. Getting it
// wrong there is worse than not publishing it.
//
// This test lives in the MCP package because that is where axe-core's rule metadata
// already is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { allRules, criteriaFor } from '../src/rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wcag = JSON.parse(readFileSync(path.resolve(here, '../../data/wcag.json'), 'utf8'));
const byId = new Map(wcag.criteria.map((c) => [c.id, c]));

test('the data is internally consistent', () => {
  assert.equal(wcag.version, '2.2');
  assert.ok(wcag.criteria.length > 50);

  const seen = new Set();
  for (const c of wcag.criteria) {
    assert.match(c.id, /^\d+\.\d+\.\d+$/, `bad criterion id ${c.id}`);
    assert.ok(!seen.has(c.id), `duplicate criterion ${c.id}`);
    seen.add(c.id);

    assert.ok(c.name, `${c.id} has no name`);
    assert.ok(['A', 'AA', 'AAA'].includes(c.level), `${c.id} has level ${c.level}`);
    assert.ok(['2.0', '2.1', '2.2'].includes(c.added), `${c.id} was added in ${c.added}`);
    assert.ok(c.requires && c.requires.length > 30, `${c.id} needs a real summary`);
  }
});

test('WCAG 2.2 Level A and AA are complete', () => {
  // 31 A and 24 AA, counting 4.1.1 out because it was removed in 2.2. If either
  // number moves, either the data gained a mistake or a criterion was missed — both
  // worth stopping for, because the page states these totals.
  const current = wcag.criteria.filter((c) => !c.removed);
  const a = current.filter((c) => c.level === 'A');
  const aa = current.filter((c) => c.level === 'AA');

  assert.equal(a.length, 31, 'expected 31 Level A criteria in WCAG 2.2');
  assert.equal(aa.length, 24, 'expected 24 Level AA criteria in WCAG 2.2');
});

test('every criterion axe-core references is documented', () => {
  // The check this file exists for. axe tags rules with criteria; if it names one the
  // reference does not carry, the join drops those rules and the coverage table
  // understates what the scanner detects.
  const referenced = new Set();
  for (const rule of allRules()) {
    for (const criterion of rule.wcag) referenced.add(criterion);
  }

  const missing = [...referenced].filter((id) => !byId.has(id)).sort();
  assert.deepEqual(
    missing,
    [],
    `axe-core references criteria that data/wcag.json does not document: ${missing.join(', ')}`,
  );
});

test('4.1.1 is marked as removed rather than quietly dropped', () => {
  // axe still reports rules against Parsing, which WCAG 2.2 removed. Deleting it from
  // the data would make those rules vanish from the table; presenting it as current
  // would imply a 2.2 requirement that no longer exists. It is documented as removed.
  const parsing = byId.get('4.1.1');
  assert.ok(parsing, '4.1.1 should be present');
  assert.equal(parsing.removed, '2.2');
  assert.ok(parsing.note && /removed in WCAG 2\.2/i.test(parsing.note));

  const rulesForParsing = allRules().filter((r) => r.wcag.includes('4.1.1'));
  assert.ok(
    rulesForParsing.length > 0,
    'if axe stopped reporting 4.1.1, the note explaining why it is here should be revisited',
  );
});

test('AAA criteria are present only because axe references them', () => {
  // The reference is scoped to A and AA. A AAA entry that no rule maps to is data
  // nobody asked for, and it would appear in the coverage table as a row with
  // nothing in it.
  const referenced = new Set(allRules().flatMap((r) => r.wcag));
  for (const c of wcag.criteria.filter((c) => c.level === 'AAA')) {
    assert.ok(
      referenced.has(c.id),
      `${c.id} is AAA and no axe rule references it, so it does not belong in the data`,
    );
  }
});

test('criteriaFor agrees with the documented ids', () => {
  // Guards the tag parser against a criterion like 1.4.11, where the naive split
  // gives 1.4.1 and 1.
  assert.deepEqual(criteriaFor(['wcag1411']), ['1.4.11']);
  assert.ok(byId.has('1.4.11'), '1.4.11 should be documented');
  assert.deepEqual(criteriaFor(['wcag143']), ['1.4.3']);
});

test('rules map to criteria at a plausible rate', () => {
  // A sanity check on the join rather than an exact figure: if this collapses to
  // almost nothing, the tag format has changed under us and the coverage table would
  // silently claim automation detects nothing.
  const withCriteria = allRules().filter((r) => r.wcag.length > 0);
  assert.ok(
    withCriteria.length > 40,
    `only ${withCriteria.length} rules mapped to a WCAG criterion — the join looks broken`,
  );

  const covered = new Set(withCriteria.flatMap((r) => r.wcag));
  assert.ok(covered.size >= 25, `only ${covered.size} criteria covered — the join looks broken`);
});
