// A scan of an error page must say so.
//
// The worker always noticed a 4xx or 5xx and wrote it to its own log, which told the
// operator and left the customer with a report that looked exactly like a report for a
// working page. In CI that is the expensive version: a staging URL that has moved returns
// 404, the gate scans the error page, and --update-baseline records those violations as
// the accepted truth. From then on the baseline describes a 404 and the real page is
// unmeasured, with nothing anywhere explaining why.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { human, markdown } from '../src/report.js';

const emptyDiff = { isNew: [], accepted: [], drifted: [], fixed: [], total: 0 };
const passing = { fail: false, reason: '0 new violations', blocking: [] };
// No colour, so assertions match plain text.
const plain = new Proxy({}, { get: () => (s) => s });

function scan(url, httpStatus) {
  return { url, status: 'done', score: 90, http_status: httpStatus };
}

test('the terminal report warns about a 404 before anything else', () => {
  const out = human(emptyDiff, passing, {
    scans: [scan('https://staging.example/moved', 404)],
    style: plain,
  });
  assert.match(out, /answered HTTP 404/);
  assert.match(out, /findings describe an error page/);
  assert.match(out, /before trusting this result or recording a baseline/);
});

test('a 5xx is warned about too, not just a 404', () => {
  const out = human(emptyDiff, passing, { scans: [scan('https://x.example/', 503)], style: plain });
  assert.match(out, /answered HTTP 503/);
});

test('a normal scan produces no warning', () => {
  const out = human(emptyDiff, passing, { scans: [scan('https://x.example/', 200)], style: plain });
  assert.ok(!/answered HTTP/.test(out), 'a 200 must not be flagged');
});

test('an unknown status produces no warning', () => {
  // Scans recorded before the status was captured have no http_status. Absent is not an
  // error, and inventing a warning for old data would train people to ignore it.
  for (const s of [{ url: 'https://x.example/', status: 'done' }, scan('https://x.example/', null)]) {
    const out = human(emptyDiff, passing, { scans: [s], style: plain });
    assert.ok(!/answered HTTP/.test(out), `unexpected warning for ${JSON.stringify(s)}`);
  }
});

test('the pull-request comment leads with the warning', () => {
  const md = markdown(emptyDiff, passing, { scans: [scan('https://staging.example/gone', 404)] });
  const warningAt = md.indexOf('answered HTTP 404');
  const countsAt = md.indexOf('violation(s) across');

  assert.ok(warningAt > -1, 'the comment must mention the status');
  assert.ok(
    warningAt < countsAt,
    'the warning has to come before the numbers — a reviewer skims the top and a report for a 404 looks authoritative',
  );
  assert.match(md, /Check the URL/);
});
