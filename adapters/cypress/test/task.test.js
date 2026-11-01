// Tests for the Node half of the Cypress adapter, which is where everything that
// can be wrong in an interesting way lives: violation identity, the baseline, and
// the verdict. The browser half runs axe and posts the results over; it has no
// logic to get wrong that these do not cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resultFrom, mergeBaselines, check, registerSkiplinkTasks } from '../src/task.js';
import { fingerprint, fingerprintLoose } from '@skiplink/core/fingerprint';

// Raw axe output for a page with two failing BEM siblings and a missing alt.
function axeViolations() {
  return [
    {
      id: 'color-contrast',
      impact: 'serious',
      tags: ['wcag2aa', 'wcag143'],
      help: 'Elements must have sufficient colour contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/color-contrast',
      nodes: [
        {
          target: ['.hero__title'],
          html: '<p class="hero__title">Ship faster</p>',
          any: [{ message: 'Contrast 3.03:1, needs 4.5:1' }],
        },
        {
          target: ['.hero__subtitle'],
          html: '<p class="hero__subtitle">Every pull request</p>',
          any: [{ message: 'Contrast 2.91:1, needs 4.5:1' }],
        },
      ],
    },
    {
      id: 'image-alt',
      impact: 'critical',
      tags: ['wcag2a', 'wcag111'],
      help: 'Images must have alternate text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/image-alt',
      nodes: [{ target: ['img'], html: '<img src="/hero.png">' }],
    },
  ];
}

function payload(extra = {}) {
  return {
    url: 'https://app.example/checkout',
    violations: axeViolations(),
    passes: 30,
    standard: 'wcag22aa',
    axeVersion: '4.12.1',
    browser: 'Chrome 131',
    ...extra,
  };
}

let tmp;
test('setup', async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skiplink-cypress-'));
});

test('resultFrom produces the same shape the hosted API returns', () => {
  const r = resultFrom(payload());

  assert.equal(r.status, 'done');
  assert.equal(r.url, 'https://app.example/checkout');
  assert.equal(r.standard, 'wcag22aa');
  assert.deepEqual(r.engine, { axe_core: '4.12.1', chromium: 'Chrome 131' });
  assert.deepEqual(r.summary, { critical: 1, serious: 2, moderate: 0, minor: 0 });
  assert.equal(r.violations.length, 3, 'one entry per offending element, not per rule');
  assert.ok(r.score > 0 && r.score < 100);

  const first = r.violations.find((v) => v.selector === '.hero__title');
  assert.deepEqual(first.wcag, ['1.4.3']);
  assert.equal(first.message, 'Contrast 3.03:1, needs 4.5:1');
  assert.ok(first.help_url.includes('dequeuniversity'));
});

test('fingerprints are the shared ones, not a private copy', () => {
  // If this adapter ever computed identity its own way, a baseline written through
  // Cypress would not match one written by the API or the Playwright adapter.
  const r = resultFrom(payload());
  for (const v of r.violations) {
    assert.equal(v.fingerprint, fingerprint(v.rule, v.selector), `exact for ${v.selector}`);
    assert.equal(
      v.fingerprint_loose,
      fingerprintLoose(v.rule, v.html),
      `loose for ${v.selector}`,
    );
  }
});

test('BEM siblings get different fingerprints', () => {
  const r = resultFrom(payload());
  const contrast = r.violations.filter((v) => v.rule === 'color-contrast');
  assert.equal(contrast.length, 2);
  assert.notEqual(
    contrast[0].fingerprint,
    contrast[1].fingerprint,
    '.hero__title and .hero__subtitle must not share a fingerprint',
  );
});

test('score is 100 when nothing failed', () => {
  const r = resultFrom(payload({ violations: [], passes: 40 }));
  assert.equal(r.score, 100);
  assert.deepEqual(r.summary, { critical: 0, serious: 0, moderate: 0, minor: 0 });
});

test('with no baseline, every violation is new and the check fails', async () => {
  const baseline = path.join(tmp, 'absent.json');
  const verdict = await check(payload({ baseline }));

  assert.equal(verdict.fail, true);
  assert.equal(verdict.outcome.isNew.length, 3);
  assert.match(verdict.message, /3 accessibility violations/);
  assert.match(verdict.message, /CRITICAL {2}image-alt/);
  assert.match(verdict.message, /SKIPLINK_UPDATE_BASELINE=1 npx cypress run/);
});

test('the failure message carries the accuracy disclaimer', async () => {
  const verdict = await check(payload({ baseline: false }));
  assert.match(verdict.message, /subset of WCAG success criteria/);
  assert.match(verdict.message, /does not\s+mean the page conforms/);
});

test('violations are listed worst first', async () => {
  const verdict = await check(payload({ baseline: false }));
  const order = verdict.message
    .split('\n')
    .filter((l) => /^ {2}(CRITICAL|SERIOUS|MODERATE|MINOR)/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(order, ['CRITICAL', 'SERIOUS', 'SERIOUS']);
});

test('recording a baseline makes the same page pass', async () => {
  const baseline = path.join(tmp, 'record.json');

  const recorded = await check(payload({ baseline, updateBaseline: true }));
  assert.equal(recorded.updated, true);
  assert.equal(recorded.fail, false);

  const again = await check(payload({ baseline }));
  assert.equal(again.fail, false, 'the violations we just accepted must not fail');
  assert.equal(again.outcome.accepted, 3);
});

test('a new violation on a sibling element is not absorbed by the baseline', async () => {
  // The fingerprint collision this repository used to have would have let this
  // through: a baseline entry for .hero__title matched anything shaped like
  // .hero__<something>, so the gate went green on a genuinely new failure.
  const baseline = path.join(tmp, 'sibling.json');
  await check(payload({ baseline, updateBaseline: true }));

  const withExtra = axeViolations();
  withExtra[0].nodes.push({
    target: ['.hero__caption'],
    html: '<p class="hero__caption">Added later</p>',
    any: [{ message: 'Contrast 3.10:1, needs 4.5:1' }],
  });

  const verdict = await check(payload({ baseline, violations: withExtra }));
  assert.equal(verdict.fail, true);
  assert.equal(verdict.outcome.isNew.length, 1);
  assert.equal(verdict.outcome.isNew[0].selector, '.hero__caption');
});

test('an impact floor still respects the baseline', async () => {
  const baseline = path.join(tmp, 'floor.json');
  await check(payload({ baseline, updateBaseline: true }));

  // Everything is accepted, so even failOn critical must pass. Otherwise a site
  // with accepted critical violations could never go green and the baseline may as
  // well not exist.
  const accepted = await check(payload({ baseline, failOn: 'critical' }));
  assert.equal(accepted.fail, false);

  // A new serious violation does not trip a critical floor.
  const withSerious = axeViolations();
  withSerious[0].nodes.push({
    target: ['.new-serious'],
    html: '<p class="new-serious">Later</p>',
    any: [{ message: 'Contrast 3.2:1' }],
  });
  const serious = await check(payload({ baseline, violations: withSerious, failOn: 'critical' }));
  assert.equal(serious.fail, false, 'a serious violation must not trip a critical floor');

  const anyNew = await check(payload({ baseline, violations: withSerious, failOn: 'new' }));
  assert.equal(anyNew.fail, true, 'but it is still new');
});

test('a baseline keyed on path matches across changing hostnames', async () => {
  // Preview deployments get a fresh hostname on every pull request.
  const baseline = path.join(tmp, 'hosts.json');
  await check(payload({ baseline, updateBaseline: true }));

  const otherHost = await check(
    payload({ baseline, url: 'https://pr-482.preview.example/checkout' }),
  );
  assert.equal(otherHost.fail, false, 'the same path on another host is the same page');

  const otherPath = await check(payload({ baseline, url: 'https://app.example/basket' }));
  assert.equal(otherPath.fail, true, 'a different path is a different page');
});

test('updating a baseline keeps entries for pages this run did not visit', async () => {
  const baseline = path.join(tmp, 'merge.json');
  await fs.writeFile(
    baseline,
    JSON.stringify({
      version: 1,
      entries: [
        {
          path: '/some/other/page',
          rule: 'image-alt',
          fingerprint: 'f_deadbeef',
          fingerprint_loose: 'f_cafebabe',
          impact: 'critical',
          selector: 'img',
        },
      ],
    }),
  );

  await check(payload({ baseline, updateBaseline: true }));

  const after = JSON.parse(await fs.readFile(baseline, 'utf8'));
  const paths = new Set(after.entries.map((e) => e.path));
  assert.ok(paths.has('/some/other/page'), 'entries for other pages must survive');
  assert.ok(paths.has('/checkout'), 'the visited page should be recorded');
});

test('mergeBaselines with nothing existing returns the fresh one', () => {
  const fresh = { version: 1, entries: [{ path: '/a' }] };
  assert.deepEqual(mergeBaselines(null, fresh), fresh);
});

test('updateBaseline with baseline false is refused rather than silently doing nothing', async () => {
  await assert.rejects(
    () => check(payload({ baseline: false, updateBaseline: true })),
    /Give a path/,
  );
});

// ── Task registration ────────────────────────────────────────────────────────

function fakeOn() {
  const handlers = {};
  const on = (event, map) => {
    assert.equal(event, 'task');
    Object.assign(handlers, map);
  };
  return { on, handlers };
}

test('registerSkiplinkTasks registers the tasks the commands call', () => {
  const { on, handlers } = fakeOn();
  registerSkiplinkTasks(on, {});
  assert.deepEqual(Object.keys(handlers).sort(), [
    'skiplink:axe',
    'skiplink:check',
    'skiplink:tags',
  ]);
});

test('registering with the wrong argument says so instead of failing later', () => {
  // Passing `config` first is the obvious mistake, and without this the failure
  // would surface as an unrelated missing-task error inside a spec.
  assert.throws(() => registerSkiplinkTasks({}, () => {}), TypeError);
  assert.throws(() => registerSkiplinkTasks(), /setupNodeEvents/);
});

test('skiplink:tags resolves a standard and refuses an unknown one', () => {
  const { on, handlers } = fakeOn();
  registerSkiplinkTasks(on, {});

  assert.deepEqual(handlers['skiplink:tags']('wcag22aa'), {
    tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  });
  // null is "every rule axe ships", and it has to survive the JSON round trip to
  // the browser as null rather than becoming an empty list, which axe reads the
  // same way but which would hide a typo.
  assert.deepEqual(handlers['skiplink:tags']('all'), { tags: null });
  assert.throws(() => handlers['skiplink:tags']('wcag99zz'), /Unknown standard/);
});

test('skiplink:axe returns the engine source and its version', () => {
  const { on, handlers } = fakeOn();
  registerSkiplinkTasks(on, {});

  const { source, version } = handlers['skiplink:axe']();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.ok(source.length > 100000, 'that does not look like axe-core');
  assert.ok(source.includes('axe'), 'the source should mention axe');
});

test('teardown', async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
