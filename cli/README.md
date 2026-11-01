# @skiplink/cli

Accessibility gate for CI. Runs axe-core against your URLs and fails the build
only on violations you have not already accepted.

```bash
npx @skiplink/cli scan https://staging.example.com
```

Works in any CI system that can run Node 20. For GitHub Actions there is
[`skiplink/action`](https://github.com/skiplink/action), which wraps this and adds
inline annotations and a self-updating pull-request comment.

## Why a baseline

Point any scanner at a site that already exists and you get a wall of red. The
average home page has [56 detectable violations](https://webaim.org/projects/million/).
Nobody fixes 56 issues to unblock a deploy — they delete the CI step, and the
check is gone by Friday.

A baseline is a committed file listing the violations you have seen and decided
not to block on. The gate then fails on what is *new*:

```bash
# Once: accept what is already there.
npx @skiplink/cli scan https://staging.example.com --baseline .skiplink/baseline.json --update-baseline
git add .skiplink/baseline.json

# Every build after that.
npx @skiplink/cli scan https://staging.example.com --baseline .skiplink/baseline.json
```

Turning the gate on costs you nothing on day one, and the next regression fails
the build. Accepting a violation later is an `--update-baseline` commit someone
reviews, like any other change.

## Usage

```
skiplink scan <url...> [options]

  --baseline <path>      Baseline file. Violations in it do not fail the build.
  --update-baseline      Rewrite the baseline from this run and exit 0.
  --fail-on <level>      new (default) | critical | serious | moderate | minor | never
  --standard <name>      wcag22aa (default) | wcag21aa | wcag2aa | wcag2a | section508 | all
  --format <name>        human (default) | json | github
  --comment-file <path>  Write a markdown report for a PR comment.
  --token <key>          API key. Defaults to $SKIPLINK_TOKEN.
  --api <url>            API base URL. Defaults to $SKIPLINK_API or the hosted API.
  --wait-for <selector>  Wait for this selector before scanning.
  --timeout <seconds>    Give up waiting for scans. Default 600.
  --quiet                Suppress progress output.
  -v, --version          Print the version.
  -h, --help             Show this.
```

An API key comes from your dashboard at [skiplink.dev](https://skiplink.dev/signup/);
the free tier is 500 scans a month and needs no card. In CI, keep it in a secret and
expose it as `SKIPLINK_TOKEN`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Gate passed |
| 1 | Gate failed — new violations, or violations at/above `--fail-on` |
| 2 | Usage error — bad flag, unreadable baseline |
| 3 | Could not complete — API unreachable, key rejected, no page could be scanned |

`1` and `3` are deliberately different. "This page has a new violation" and "we
could not find out" are different facts, and a pipeline should be free to treat
them differently — retry on 3, block on 1.

## How matching works

Every violation carries two fingerprints from the API:

- **exact** — the rule plus the normalised CSS selector.
- **loose** — the rule plus the element's text content.

The exact fingerprint does not try to guess which parts of a selector are build
output. An earlier version did, and the heuristic also matched ordinary BEM element
names, so `.hero__title` and `.hero__subtitle` shared a fingerprint — meaning a
baseline entry for one silently absorbed a new violation on the other. Surviving
class churn is the loose fingerprint's job, and the fallback below is how it gets
done.

Matching tries exact first and falls back to loose, which means **a restyle that
only renames classes does not reopen accepted violations**. Drifted matches are
reported separately so you can refresh the baseline deliberately rather than
watch it rot. A loose match is consumed once per baseline entry, so one accepted
violation cannot absorb ten new ones that happen to share its text.

Entries are keyed by URL **path**, not by full URL. Preview deployments get a
fresh hostname on every pull request, and a baseline keyed on the whole URL would
match nothing on exactly the runs it exists to serve.

## Pages this cannot reach

The API fetches URLs from our infrastructure, so it only sees pages that are on the
public internet and readable without signing in. A checkout form behind a login, a
dashboard in a review app, anything on `localhost` — the scanner refuses those, and
should.

If you have a Playwright suite, [`@skiplink/playwright`](https://www.npmjs.com/package/@skiplink/playwright)
runs the same engine in the page your test already has open, signed in and filled
out. It writes to the same baseline file: violation identity is computed by shared
code, so a violation accepted in one place stays accepted in the other.

## What this does not tell you

Automated testing detects a subset of WCAG success criteria — published estimates
range from roughly 13% to 57% depending on how you count. A passing run means no
automatically detectable violations were found. It does not mean the page
conforms to WCAG, nor that it complies with the ADA, Section 508, or the European
Accessibility Act. Manual testing by a qualified reviewer, including testing with
assistive technology, is required for a conformance claim.

## Licence

MIT. Uses the open-source [axe-core](https://github.com/dequelabs/axe-core)
engine, distributed by Deque Systems, Inc. under MPL-2.0. AXE and AXE-CORE are
trademarks of Deque Systems, Inc. Use of axe-core does not imply endorsement by
or affiliation with Deque Systems, Inc.
