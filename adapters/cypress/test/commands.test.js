// Tests for the browser half of the adapter, against a small model of Cypress.
//
// There is a real end-to-end suite in cypress/e2e/ that runs these commands in a
// real browser, and that is the one that proves axe-core actually injects. It needs
// Cypress's Electron shell, which does not start in every environment, so it is not
// part of `npm test`:
//
//     npx cypress run --config-file cypress.config.mjs
//
// These tests cover what is cheap to get wrong and expensive to notice: the task
// names the commands call, the shape of what they send, the default standard, the
// guard against re-injecting axe, and that a failing verdict becomes a thrown error
// rather than a resolved promise nobody checks.
//
// The fake below models Cypress's chaining rather than mimicking its whole API. It
// is honest about being a model: it cannot tell us the commands work in a browser,
// only that they ask for the right things.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── A model of the parts of Cypress these commands use ───────────────────────

/** A chainable that resolves like Cypress's subject chain: .then flattens promises. */
function chain(value) {
  return {
    then(fn) {
      const resolved = Promise.resolve(value).then((v) => fn(v));
      return chain(resolved.then((r) => (r && typeof r.then === 'function' ? r.then((x) => x) : r)));
    },
    // So a test can await the end of a chain.
    unwrap() {
      return Promise.resolve(value);
    },
  };
}

function makeCypress({ axeResults, verdict, win } = {}) {
  const calls = { tasks: [], logs: [] };

  const fakeWindow = win || {
    location: { href: 'https://app.example/checkout' },
    document: { __isDocument: true },
    // A page where axe has not been injected yet.
    axe: undefined,
    eval(source) {
      calls.eval = source;
      // Injecting axe defines window.axe; model that, including the run function.
      fakeWindow.axe = {
        run: (context, options) => {
          calls.axeRun = { context, options };
          // axe returns `passes` as an array of rule results; the command reads
          // its length. Modelling it as a number hid nothing about the code and
          // only broke the model.
          return Promise.resolve(
            axeResults || { violations: [], passes: new Array(12).fill({}) },
          );
        },
      };
    },
  };

  const cy = {
    task(name, arg, opts) {
      calls.tasks.push({ name, arg, opts });
      switch (name) {
        case 'skiplink:axe':
          return chain({ source: '/* axe-core */', version: '4.12.1' });
        case 'skiplink:tags':
          if (arg === 'wcag99zz') throw new Error('Unknown standard');
          return chain({ tags: arg === 'all' ? null : ['wcag2a', 'wcag2aa'] });
        case 'skiplink:check':
          return chain(verdict || { fail: false, result: { summary: {}, violations: [] }, outcome: {} });
        default:
          throw new Error(`unexpected task ${name}`);
      }
    },
    window: () => chain(fakeWindow),
    document: () => chain(fakeWindow.document),
    wrap: (value) => chain(value),
  };

  const commands = {};
  const Cypress = {
    Commands: { add: (name, fn) => (commands[name] = fn) },
    log: (props) => {
      const entry = { ...props };
      calls.logs.push(entry);
      return { set: (p) => Object.assign(entry, p), end: () => (entry.ended = true) };
    },
  };

  return { cy, Cypress, commands, calls, fakeWindow };
}

/** Load the command module fresh against a given fake. */
async function load(fake) {
  globalThis.cy = fake.cy;
  globalThis.Cypress = fake.Cypress;
  // Cache-busted so Cypress.Commands.add runs again against this fake.
  await import(`../src/index.js?t=${Math.random().toString(36).slice(2)}`);
  return fake;
}

beforeEach(() => {
  delete globalThis.cy;
  delete globalThis.Cypress;
});

// ── The tests ────────────────────────────────────────────────────────────────

test('it registers the two commands', async () => {
  const fake = await load(makeCypress());
  assert.deepEqual(Object.keys(fake.commands).sort(), ['checkA11y', 'skiplinkScan']);
});

test('a scan asks for axe, resolves the standard, and posts results to Node', async () => {
  const fake = await load(
    makeCypress({
      axeResults: {
        violations: [
          {
            id: 'image-alt',
            impact: 'critical',
            tags: ['wcag2a', 'wcag111'],
            help: 'Images must have alternate text',
            nodes: [{ target: ['img'], html: '<img>' }],
          },
        ],
        passes: new Array(8).fill({}),
      },
      verdict: { fail: false, result: { ok: true }, outcome: {} },
    }),
  );

  await fake.commands.skiplinkScan({}).unwrap();

  const names = fake.calls.tasks.map((t) => t.name);
  assert.deepEqual(names, ['skiplink:axe', 'skiplink:tags', 'skiplink:check']);

  // The standard defaults to wcag22aa and is resolved in Node, not guessed here.
  assert.equal(fake.calls.tasks[1].arg, 'wcag22aa');

  const sent = fake.calls.tasks[2].arg;
  assert.equal(sent.url, 'https://app.example/checkout', 'the URL comes from the live window');
  assert.equal(sent.axeVersion, '4.12.1');
  assert.equal(sent.passes, 8);
  assert.equal(sent.violations.length, 1, 'raw axe violations are forwarded for Node to fingerprint');

  // A bare scan must not touch the baseline: it is a read, not a gate.
  assert.equal(sent.baseline, false);
  assert.equal(sent.updateBaseline, false);
});

test('axe is injected once, not on every check', async () => {
  const fake = await load(makeCypress());

  await fake.commands.skiplinkScan({}).unwrap();
  assert.ok(fake.calls.eval, 'the engine should be injected on first use');

  fake.calls.eval = null;
  await fake.commands.skiplinkScan({}).unwrap();
  assert.equal(fake.calls.eval, null, 'a page that already has axe must not be re-injected');
});

test('the resolved tag list is handed to axe, and all means every rule', async () => {
  let fake = await load(makeCypress());
  await fake.commands.skiplinkScan({}).unwrap();
  assert.deepEqual(fake.calls.axeRun.options.runOnly, {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa'],
  });

  fake = await load(makeCypress());
  await fake.commands.skiplinkScan({ standard: 'all' }).unwrap();
  assert.equal(
    fake.calls.axeRun.options.runOnly,
    undefined,
    'null tags mean no runOnly filter at all, which is how axe expresses every rule',
  );
});

test('include and exclude become an axe context', async () => {
  const fake = await load(makeCypress());
  await fake.commands
    .skiplinkScan({ include: '#checkout', exclude: ['.vendor', '.ads'] })
    .unwrap();

  assert.deepEqual(fake.calls.axeRun.context, {
    include: [['#checkout']],
    exclude: [['.vendor'], ['.ads']],
  });
});

test('with no include or exclude, axe is given the document', async () => {
  const fake = await load(makeCypress());
  await fake.commands.skiplinkScan({}).unwrap();
  assert.equal(fake.calls.axeRun.context.__isDocument, true);
});

test('disableRules is passed through', async () => {
  const fake = await load(makeCypress());
  await fake.commands.skiplinkScan({ disableRules: ['color-contrast', 'region'] }).unwrap();
  assert.deepEqual(fake.calls.axeRun.options.rules, {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  });
});

test('checkA11y throws the verdict message when the gate fails', async () => {
  const fake = await load(
    makeCypress({
      verdict: {
        fail: true,
        reason: '2 new violations',
        message: 'CRITICAL image-alt\n\nsubset of WCAG success criteria',
        result: { summary: { critical: 1, serious: 1, moderate: 0, minor: 0 } },
        outcome: { isNew: [], accepted: 0, drifted: 0, fixed: 0 },
      },
    }),
  );

  await assert.rejects(
    () => fake.commands.checkA11y({}).unwrap(),
    /CRITICAL image-alt/,
    'a failing gate must fail the test, not resolve quietly',
  );
});

test('checkA11y yields the result when the gate passes', async () => {
  const fake = await load(
    makeCypress({
      verdict: {
        fail: false,
        result: { summary: { critical: 0, serious: 0, moderate: 0, minor: 0 }, score: 100 },
        outcome: { isNew: [], accepted: 3, drifted: 0, fixed: 0 },
      },
    }),
  );

  const result = await fake.commands.checkA11y({}).unwrap();
  assert.equal(result.score, 100);
  assert.ok(fake.calls.logs.length > 0, 'the run should be visible in the Cypress log');
});

test('an update run reports what it wrote and does not fail', async () => {
  const fake = await load(
    makeCypress({
      verdict: { updated: true, fail: false, baseline: '.skiplink/baseline.json', result: { ok: 1 } },
    }),
  );

  const result = await fake.commands.checkA11y({ updateBaseline: true }).unwrap();
  assert.deepEqual(result, { ok: 1 });
  assert.match(fake.calls.logs[0].message, /baseline updated/);
});

test('an unknown standard rejects before axe runs', async () => {
  const fake = await load(makeCypress());
  await assert.rejects(
    () => fake.commands.skiplinkScan({ standard: 'wcag99zz' }).unwrap(),
    /Unknown standard/,
  );
  assert.equal(fake.calls.axeRun, undefined, 'axe must not run with an unresolved standard');
});
