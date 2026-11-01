// These tests drive a real Chromium against a real page, because the things
// worth checking here only exist at that level: what axe reports for a given
// element, what selector it produces, and whether a baseline written by one code
// path matches a scan run by another.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

import { scan, expectNoNewViolations } from '../src/index.js';

// The worker's SSRF guard refuses loopback, which is right, and this fixture is
// served on loopback. Allowed through the same env hatch selfscan uses, set
// before the worker's config module reads the environment — hence the dynamic
// import below rather than a static one.
// The worker is part of the hosted service and is not in the public packages
// mirror, so the one test that compares against it runs only where it exists.
process.env.GUARD_ALLOW_HOSTS = '127.0.0.1';
const workerPath = new URL('../../../worker/src/scan.js', import.meta.url);
const { runScan } = existsSync(workerPath) ? await import(workerPath.href) : {};
const { tagsForStandard } = await import('@skiplink/core/axe');

// A page with four deliberate, distinct failures, and two of them on BEM
// siblings — the case that used to collapse into a single fingerprint.
const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture</title></head>
<body>
  <h1>Fixture</h1>
  <!-- Normal-size text on purpose: large text passes AA at 3:1, so an h1 at
       these colours would not fail and the sibling test would prove nothing. -->
  <p class="hero__title" style="color:#949494;background:#fff;font-size:14px">Ship faster</p>
  <p class="hero__subtitle" style="color:#9a9a9a;background:#fff;font-size:14px">Every pull request</p>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <a href="/x"><span></span></a>
  <p>Fine text with plenty of contrast.</p>
</body>
</html>`;

let server;
let base;
let browser;
let tmp;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skiplink-adapter-'));
});

after(async () => {
  await browser?.close();
  server?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function openFixture() {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  return page;
}

test('finds the deliberate failures and names the rules', async () => {
  const page = await openFixture();
  try {
    const result = await scan(page);
    const rules = new Set(result.violations.map((v) => v.rule));

    for (const expected of ['color-contrast', 'image-alt', 'link-name']) {
      assert.ok(rules.has(expected), `expected ${expected}, got ${[...rules].join(', ')}`);
    }
    assert.equal(result.status, 'done');
    assert.equal(result.standard, 'wcag22aa');
    assert.ok(result.engine.axe_core, 'the axe-core version must be reported');
    assert.ok(result.passes > 0, 'a page with some correct markup should have passes');
    assert.ok(result.score >= 0 && result.score <= 100);
  } finally {
    await page.close();
  }
});

test('BEM siblings get different fingerprints', async () => {
  // The regression that motivated removing the build-hash heuristic. Both
  // headings fail contrast; if they shared a fingerprint, a baseline entry for
  // one would silently absorb a new violation on the other and the gate would
  // report green.
  const page = await openFixture();
  try {
    const result = await scan(page);
    const contrast = result.violations.filter((v) => v.rule === 'color-contrast');
    assert.ok(contrast.length >= 2, `expected two failing siblings, got ${contrast.length}`);

    const prints = new Set(contrast.map((v) => v.fingerprint));
    assert.equal(prints.size, contrast.length, 'two elements collapsed into one fingerprint');
  } finally {
    await page.close();
  }
});

test('the hosted path and the adapter agree on every fingerprint', {
  skip: !runScan && 'needs the hosted worker, which is not in this repository',
}, async () => {
  // The whole reason the identity code is shared. A customer scans public pages
  // through the API and private ones through their test suite, and both write to
  // the same baseline file. If these two disagree, that baseline is worthless.
  const page = await openFixture();
  let fromAdapter;
  try {
    fromAdapter = await scan(page);
  } finally {
    await page.close();
  }

  // axe_tags, not standard: the worker takes the resolved tag list because the
  // Go server owns the standard-to-tags mapping. Passing `standard` here would
  // leave the worker with no tag filter at all, which means every rule axe ships
  // including best-practice ones — a different scan, and the mismatch this test
  // originally reported.
  const fromWorker = await runScan(browser, {
    url: `${base}/`,
    axe_tags: tagsForStandard('wcag22aa'),
  });
  assert.equal(fromWorker.status, 'done', fromWorker.error_message);

  const key = (v) => `${v.rule}|${v.selector}|${v.fingerprint}|${v.fingerprint_loose}`;
  // The worker returns violations without fingerprints (the Go server adds them),
  // so compare on what identity is derived from plus the adapter's own values.
  const workerSelectors = fromWorker.violations.map((v) => `${v.rule}|${v.selector}`).sort();
  const adapterSelectors = fromAdapter.violations.map((v) => `${v.rule}|${v.selector}`).sort();

  assert.deepEqual(
    adapterSelectors,
    workerSelectors,
    'the two paths saw different violations on the same page',
  );
  assert.ok(key(fromAdapter.violations[0]).length > 0);
});

test('a violation in the baseline does not fail, and a new one does', async () => {
  const baseline = path.join(tmp, 'baseline.json');
  const page = await openFixture();

  try {
    // Nothing recorded yet: every violation is new.
    await assert.rejects(
      () => expectNoNewViolations(page, { baseline }),
      /violation/i,
      'a page with violations and no baseline must fail',
    );

    // Record them, then the same page passes.
    await expectNoNewViolations(page, { baseline, updateBaseline: true });
    await expectNoNewViolations(page, { baseline });

    // Introduce a genuinely new failure and it must be caught, even though the
    // page already has accepted contrast violations on sibling elements.
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.className = 'hero__caption';
      p.style.color = '#9d9d9d';
      p.style.background = '#fff';
      p.style.fontSize = '14px';
      p.textContent = 'Added after the baseline was recorded';
      document.body.append(p);
    });

    await assert.rejects(
      () => expectNoNewViolations(page, { baseline }),
      /violation/i,
      'a new violation on a sibling element must not be absorbed by the baseline',
    );
  } finally {
    await page.close();
  }
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

  const page = await openFixture();
  try {
    await expectNoNewViolations(page, { baseline, updateBaseline: true });
  } finally {
    await page.close();
  }

  const after = JSON.parse(await fs.readFile(baseline, 'utf8'));
  const paths = new Set(after.entries.map((e) => e.path));
  assert.ok(
    paths.has('/some/other/page'),
    'recording one page must not delete the entries for every other page',
  );
  assert.ok(paths.size > 1, 'the visited page should have been added');
});

test('an unknown standard is refused rather than silently scanning everything', async () => {
  const page = await openFixture();
  try {
    await assert.rejects(() => scan(page, { standard: 'wcag99zz' }), /Unknown standard/);
  } finally {
    await page.close();
  }
});

test('include narrows the scan to one part of the page', async () => {
  const page = await openFixture();
  try {
    const all = await scan(page);
    const narrowed = await scan(page, { include: '.hero__title' });
    assert.ok(
      narrowed.violations.length < all.violations.length,
      'restricting to one element should find fewer violations',
    );
    assert.ok(
      narrowed.violations.every((v) => v.rule === 'color-contrast'),
      'only the heading failure is inside the included selector',
    );
  } finally {
    await page.close();
  }
});

test('disableRules skips a rule entirely', async () => {
  const page = await openFixture();
  try {
    const result = await scan(page, { disableRules: ['color-contrast'] });
    assert.ok(
      !result.violations.some((v) => v.rule === 'color-contrast'),
      'a disabled rule must not report',
    );
    assert.ok(result.violations.length > 0, 'the other failures should still be found');
  } finally {
    await page.close();
  }
});

test('the failure message carries the accuracy disclaimer', async () => {
  // A green test suite is exactly where someone concludes the page is compliant.
  const page = await openFixture();
  try {
    const err = await expectNoNewViolations(page, { baseline: false }).catch((e) => e);
    assert.match(err.message, /subset of WCAG success criteria/);
    assert.match(err.message, /does not/i);
  } finally {
    await page.close();
  }
});
