# @skiplink/cypress

Accessibility gate for Cypress. Runs axe-core in the page your test already has
open, and fails the test only on violations you have not already accepted.

```bash
npm install --save-dev @skiplink/cypress axe-core
```

Register the Node side in `cypress.config.js`:

```js
import { defineConfig } from 'cypress';
import { registerSkiplinkTasks } from '@skiplink/cypress/task';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      registerSkiplinkTasks(on, config);
      return config;
    },
  },
});
```

And the commands in `cypress/support/e2e.js`:

```js
import '@skiplink/cypress';
```

Then use it:

```js
it('checkout is accessible', () => {
  cy.visit('/checkout');
  cy.get('[name=card]').type('4242424242424242');
  cy.checkA11y();
});
```

First run, record what is already broken so the gate has something to compare
against:

```bash
SKIPLINK_UPDATE_BASELINE=1 npx cypress run
```

Commit `.skiplink/baseline.json`. From then on the test fails only on violations
that are new.

## Why two registration steps

Cypress splits a run across two processes: your spec code executes in the browser,
and only `setupNodeEvents` runs in Node. The two things this adapter must do —
hash a violation and read a baseline file — are both impossible in a browser.
`node:crypto` is not there and neither is the filesystem.

So the browser does one job: run axe-core and post the raw results over. Identity,
the baseline and the verdict all happen in Node, using the same
[`@skiplink/core`](https://www.npmjs.com/package/@skiplink/core) functions the CLI
and the hosted API use. That is not a workaround for the split; it is the reason a
baseline recorded through Cypress matches one recorded through the API.

## Why not just point the hosted API at the URL

Because it cannot see the pages that break. The hosted scanner fetches a URL from
our infrastructure, so it only reaches pages that are public and readable without
signing in. A checkout form behind a login, a dashboard in a review app, anything
on `localhost` in CI — the SSRF guard refuses all of those, and should.

Your test suite is already past that. One baseline file covers both: public pages
scanned by the API or the GitHub Action, private ones scanned by your tests.

## Commands

### `cy.checkA11y(options?)`

Fails the test if the page has violations that are not in the baseline. The failure
message lists them with rule, selector, the specific failure and a link to Deque's
documentation for that rule.

| Option | Default | |
|---|---|---|
| `baseline` | `.skiplink/baseline.json` | Path, or `false` to fail on any violation. Also `SKIPLINK_BASELINE`. |
| `failOn` | `'new'` | Or an impact floor: `'critical'`, `'serious'`, `'moderate'`, `'minor'`, `'never'`. Impact floors still respect the baseline. |
| `updateBaseline` | `false` | Record the current state and pass. Also `SKIPLINK_UPDATE_BASELINE=1`. |
| `standard` | `'wcag22aa'` | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `section508`, `all`. |
| `include` | — | Selector or selectors to restrict the scan to. |
| `exclude` | — | Selector or selectors to skip. |
| `disableRules` | `[]` | Rule ids to turn off entirely. |

```js
// Only the checkout form, ignoring a third-party widget you cannot change.
cy.checkA11y({ include: '#checkout', exclude: '.vendor-embed' });

// Block on anything serious or worse that is new.
cy.checkA11y({ failOn: 'serious' });
```

### `cy.skiplinkScan(options?)`

The same check without the assertion or the baseline. Yields the result object the
hosted API returns — `score`, `summary`, `violations` with fingerprints, `engine` —
so you can assert on it yourself.

```js
cy.skiplinkScan().then((result) => {
  expect(result.summary.critical).to.equal(0);
});
```

## Notes

**Scanning happens where the test left the page.** No extra navigation, no waiting
for network idle, no retrying. If the page needs settling first, settle it with
Cypress's own commands, which you can see and control.

**axe-core is a peer dependency on purpose.** The version in your results is the
version in your lockfile, reported on every result as `engine.axe_core`. Rule
behaviour changes between axe versions, so a scanner that hides which version it
ran is a scanner whose results you cannot reproduce.

**An unknown `standard` is an error, not a silent full run.** axe-core reads an
empty tag list as "run every rule", so a typo would quietly widen the scan instead
of failing. The standard is resolved in Node before axe runs.

**A passing check is not a conformance claim.** Automated testing detects a subset
of WCAG success criteria; published estimates range from roughly 13% to 57%
depending on how you measure. Keyboard order, focus management, whether alt text is
*accurate*, and whether a custom widget behaves as its role promises all need a
person. That paragraph is in the failure output too, because a green suite is
exactly where someone concludes otherwise.

## Licence

MIT. Uses [axe-core](https://github.com/dequelabs/axe-core), distributed by Deque
Systems under MPL-2.0 and used unmodified. AXE and AXE-CORE are trademarks of Deque
Systems, Inc.
