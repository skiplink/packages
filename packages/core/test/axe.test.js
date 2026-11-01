import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STANDARDS, tagsForStandard, wcagFromTags, flatten } from '../src/axe.js';
import { fingerprint } from '../src/fingerprint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const standardsPath = path.resolve(here, '../../../internal/scan/schema/testdata/standards.json');

test('the standard-to-tag map matches the Go one exactly', () => {
  const fromGo = JSON.parse(readFileSync(standardsPath, 'utf8'));

  assert.deepEqual(
    Object.keys(STANDARDS).sort(),
    Object.keys(fromGo).sort(),
    'the set of accepted standard names differs between Go and JavaScript',
  );

  for (const [name, tags] of Object.entries(fromGo)) {
    assert.deepEqual(
      STANDARDS[name],
      tags,
      `standard ${name} resolves to different axe-core tags in JavaScript than in Go`,
    );
  }
});

test('an unknown standard is undefined rather than silently empty', () => {
  // Returning [] would mean "no tags", which axe-core reads as "every rule" —
  // the opposite of refusing a typo.
  assert.equal(tagsForStandard('wcag99zz'), undefined);
  assert.equal(tagsForStandard('__proto__'), undefined, 'prototype keys are not standards');
  assert.deepEqual(tagsForStandard('wcag22aa'), ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
});

test('all means every rule, expressed as null rather than an empty list', () => {
  assert.equal(STANDARDS.all, null);
});

test('wcag tags become success criteria, including two-digit criteria', () => {
  assert.deepEqual(wcagFromTags(['wcag143']), ['1.4.3']);
  assert.deepEqual(wcagFromTags(['wcag1411']), ['1.4.11']);
  assert.deepEqual(wcagFromTags(['cat.color', 'wcag2aa', 'wcag143']), ['1.4.3'], 'non-criteria tags are dropped');
  assert.deepEqual(wcagFromTags(), []);
});

test('one violation per element, not per rule', () => {
  const out = flatten([
    {
      id: 'color-contrast',
      impact: 'serious',
      tags: ['wcag2aa', 'wcag143'],
      help: 'Elements must have sufficient colour contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/color-contrast',
      nodes: [
        { target: ['.a'], html: '<p class="a">One</p>', any: [{ message: 'Contrast 3.03:1' }] },
        { target: ['.b'], html: '<p class="b">Two</p>', any: [{ message: 'Contrast 2.10:1' }] },
      ],
    },
  ]);

  assert.equal(out.length, 2, 'a rule failing on two elements is two findings');
  assert.equal(out[0].rule, 'color-contrast');
  assert.deepEqual(out[0].wcag, ['1.4.3']);
  assert.equal(out[0].message, 'Contrast 3.03:1', 'the specific check message, not the generic help');
  assert.equal(out[0].help_url, 'https://dequeuniversity.com/rules/axe/4.12/color-contrast');

  // And they must be distinguishable, or a baseline entry for one would absorb
  // the other.
  assert.notEqual(
    fingerprint(out[0].rule, out[0].selector),
    fingerprint(out[1].rule, out[1].selector),
  );
});

test('a target inside a frame becomes a single selector string', () => {
  const out = flatten([
    {
      id: 'image-alt',
      impact: 'critical',
      tags: ['wcag2a', 'wcag111'],
      help: 'Images must have alternate text',
      nodes: [{ target: [['#checkout-frame', 'img.logo']], html: '<img class="logo">' }],
    },
  ]);
  assert.equal(out[0].selector, '#checkout-frame >>> img.logo');
});

test('node impact wins over rule impact', () => {
  // axe reports impact per node for rules whose severity depends on the element.
  const out = flatten([
    {
      id: 'color-contrast',
      impact: 'serious',
      tags: [],
      help: 'h',
      nodes: [{ target: ['.x'], html: '<p></p>', impact: 'critical' }],
    },
  ]);
  assert.equal(out[0].impact, 'critical');
});

test('a node with no check message falls back to the rule help', () => {
  const out = flatten([
    { id: 'r', impact: 'minor', tags: [], help: 'Do the thing', nodes: [{ target: ['.x'], html: '<p></p>' }] },
  ]);
  assert.equal(out[0].message, 'Do the thing');
});
