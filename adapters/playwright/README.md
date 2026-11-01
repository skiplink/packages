# @skiplink/playwright

Accessibility gate for Playwright. Runs axe-core in the page your test already has
open, and fails the test only on violations you have not already accepted.

```bash
npm install --save-dev @skiplink/playwright axe-core
```

```js
import { test } from '@playwright/test';
import { expectNoNewViolations } from '@skiplink/playwright';

test('checkout is accessible', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await expectNoNewViolations(page);
});
```

First run, record what is already broken so the gate has something to compare
against:

```bash
SKIPLINK_UPDATE_BASELINE=1 npx playwright test
```

Commit `.skiplink/baseline.json`. From then on the test fails only on violations
that are new.

## Why not just call the hosted API

Because it cannot see the pages that matter. The hosted scanner fetches a URL from
our infrastructure, so it only reaches pages that are public and readable without
signing in. A checkout form behind a login, a dashboard in a review app, anything
on `localhost` in CI — our own SSRF guard refuses all of those, correctly.

Your test suite is already past all of that. The browser is open, the session is
authenticated, the form is filled. This runs the same engine right there.

Both paths compute violation identity the same way, from the same shared code, so
**one baseline file covers both** — public pages scanned by the API or the GitHub
Action, private ones by your tests. There is a test in this repository that scans
one page through both paths and asserts the fingerprints match.

## API

### `expectNoNewViolations(page, options?)`

Throws if the page has violations that are not in the baseline. The error message
lists them with rule, selector, the specific failure and a link to Deque's
documentation.

| Option | Default | |
|---|---|---|
| `baseline` | `.skiplink/baseline.json` | Path, or `false` to fail on any violation. Also `SKIPLINK_BASELINE`. |
| `failOn` | `'new'` | `'new'`, or an impact floor: `'critical'`, `'serious'`, `'moderate'`, `'minor'`, `'never'`. Impact floors still respect the baseline. |
| `updateBaseline` | `false` | Record the current state and pass. Also `SKIPLINK_UPDATE_BASELINE=1`. |
| `standard` | `'wcag22aa'` | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `section508`, `all`. |
| `include` | — | Selector or selectors to restrict the scan to. |
| `exclude` | — | Selector or selectors to skip. |
| `disableRules` | `[]` | Rule ids to turn off entirely. |

### `scan(page, options?)`

The same check without the assertion. Returns the result object the hosted API
returns — `score`, `summary`, `violations` with fingerprints, `engine` — so
anything that reads a scan result does not care which path produced it.

```js
const result = await scan(page, { include: 'main' });
console.log(result.summary); // { critical: 0, serious: 2, moderate: 0, minor: 1 }
```

### `runAxe(page, options?)`

The raw axe-core run that `scan` builds on: `violations` as axe reports them, before
fingerprinting, plus `passes`, `axeVersion` and `browserVersion`. Exposed for tooling
that wants axe's own output; for anything that compares against a baseline, use
`scan`. Takes the same options as `scan`.

### `axeVersion()`

The axe-core version that will be used, resolved from your `node_modules`.

## Notes

**axe-core is a peer dependency on purpose.** The version in your results is the
version in your lockfile, reported on every result as `engine.axe_core`. Rule
behaviour changes between axe versions, so a scanner that hides which version it
ran is a scanner whose results you cannot reproduce.

**Scanning happens where the test left the page.** No extra navigation, no waiting
for network idle, no guessing. If you need the page settled first, settle it with
Playwright's own waits, which you can see and control.

**Frames are included.** The engine is injected into every frame, so an embedded
payment form is checked too — usually the part you cannot fix but do need to know
about.

**A passing check is not a conformance claim.** Automated testing detects a subset
of WCAG success criteria; published estimates range from roughly 13% to 57%
depending on how you measure. Keyboard order, focus management, whether alt text
is *accurate*, and whether a custom widget behaves as its role promises all need a
person. That paragraph is in the failure output too, because a green suite is
exactly where someone concludes otherwise.

## Licence

MIT. Uses [axe-core](https://github.com/dequelabs/axe-core), distributed by Deque
Systems under MPL-2.0 and used unmodified. AXE and AXE-CORE are trademarks of
Deque Systems, Inc.
