// The flags are a contract: they appear in documentation, in the GitHub Action
// and in people's CI configuration, and a silent misparse there is worse than a
// crash because the build keeps passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../src/index.js';

test('defaults', () => {
  const o = parseArgs(['https://example.com']);
  assert.deepEqual(o.urls, ['https://example.com']);
  assert.equal(o.standard, 'wcag22aa');
  assert.equal(o.failOn, 'new');
  assert.equal(o.format, 'human');
  assert.equal(o.baseline, null);
  assert.equal(o.updateBaseline, false);
});

test('several urls', () => {
  const o = parseArgs(['https://a.example', 'https://b.example', '--fail-on', 'critical']);
  assert.deepEqual(o.urls, ['https://a.example', 'https://b.example']);
  assert.equal(o.failOn, 'critical');
});

test('a flag that needs a value and does not get one is a usage error', () => {
  // Not a silent undefined: --baseline with nothing after it usually means a
  // shell variable that did not expand, and quietly running with no baseline
  // would fail the build on everything.
  assert.throws(() => parseArgs(['https://x.example', '--baseline']), UsageError);
});

test('an unknown option is refused rather than treated as a url', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['https://x.example', '--verbose']), /Unknown option/);
});

test('a bad format is refused', () => {
  assert.throws(() => parseArgs(['https://x.example', '--format', 'xml']), /Unknown --format/);
  for (const f of ['human', 'json', 'github']) {
    assert.equal(parseArgs(['https://x.example', '--format', f]).format, f);
  }
});

test('--update-baseline without a path to write to is refused', () => {
  assert.throws(() => parseArgs(['https://x.example', '--update-baseline']), /needs --baseline/);
  const o = parseArgs(['https://x.example', '--update-baseline', '--baseline', 'b.json']);
  assert.equal(o.updateBaseline, true);
  assert.equal(o.baseline, 'b.json');
});

test('--timeout must be a positive number', () => {
  // parseInt("abc") is NaN and would otherwise flow into the poll loop.
  assert.throws(() => parseArgs(['https://x.example', '--timeout', 'abc']), /positive number/);
  assert.throws(() => parseArgs(['https://x.example', '--timeout', '0']), /positive number/);
  assert.throws(() => parseArgs(['https://x.example', '--timeout', '-5']), /positive number/);
  assert.equal(parseArgs(['https://x.example', '--timeout', '30']).timeout, 30);
});

test('a url that looks like a flag value is not swallowed', () => {
  const o = parseArgs(['--baseline', 'b.json', 'https://x.example']);
  assert.equal(o.baseline, 'b.json');
  assert.deepEqual(o.urls, ['https://x.example']);
});

test('--help short-circuits without needing a url', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('an unknown standard is a usage error before any network call', () => {
  assert.throws(() => parseArgs(['https://x.example', '--standard', 'wcag3']), /Unknown --standard/);
  for (const s of ['wcag22aa', 'wcag21aa', 'wcag2aa', 'wcag2a', 'section508', 'all']) {
    assert.equal(parseArgs(['https://x.example', '--standard', s]).standard, s);
  }
});

test('an unknown --fail-on is a usage error, not a silent pass', () => {
  assert.throws(() => parseArgs(['https://x.example', '--fail-on', 'severe']), /Unknown --fail-on/);
});

test('the version comes from package.json', async () => {
  const { VERSION } = await import('../src/index.js');
  const { createRequire } = await import('node:module');
  const pkg = createRequire(import.meta.url)('../package.json');
  assert.equal(VERSION, pkg.version);
});
