// The browser half of the Cypress adapter: two custom commands.
//
// Import once in cypress/support/e2e.js:
//
//   import '@skiplink/cypress';
//
// Then, in a spec:
//
//   it('checkout is accessible', () => {
//     cy.visit('/checkout');
//     cy.get('[name=card]').type('4242424242424242');
//     cy.checkA11y();
//   });
//
// This file runs in the browser, so it does no hashing and touches no files. It
// runs axe-core and hands the raw results to the Node side, which owns violation
// identity and the baseline. See src/task.js for why that split is the point
// rather than a limitation.

const DEFAULTS = { standard: 'wcag22aa' };

/**
 * Inject axe-core into the page under test.
 *
 * The source arrives from Node via a task, because resolving a module from browser
 * code is a much worse problem and because reading it in Node makes the reported
 * version unambiguously the one in the caller's lockfile.
 */
function injectAxe() {
  return cy.task('skiplink:axe', null, { log: false }).then(({ source, version }) =>
    cy.window({ log: false }).then((win) => {
      // Re-injecting on every check would be wasteful; axe is idempotent to load
      // but not free, and a spec may check a dozen pages.
      if (!win.axe) {
        // eslint-disable-next-line no-eval
        win.eval(source);
      }
      return version;
    }),
  );
}

/**
 * Run axe against the page as it currently stands and return a Skiplink result.
 *
 * Deliberately does not wait, retry or settle anything. The test put the page in
 * the state it wants checked; guessing that it needs another wait would be both
 * wrong and unpredictable.
 */
function scanA11y(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  return injectAxe().then((axeVersion) =>
    cy.task('skiplink:tags', opts.standard, { log: false }).then(({ tags }) =>
      cy.window({ log: false }).then((win) =>
        cy.wrap(runAxeIn(win, tags, opts), { log: false, timeout: 60000 }).then((raw) => ({
          ...raw,
          axeVersion,
          url: win.location.href,
        })),
      ),
    ),
  );
}

function runAxeIn(win, tags, opts) {
  const runOptions = { resultTypes: ['violations', 'passes'] };
  if (tags) runOptions.runOnly = { type: 'tag', values: tags };
  if (opts.disableRules?.length) {
    runOptions.rules = Object.fromEntries(opts.disableRules.map((id) => [id, { enabled: false }]));
  }

  const asList = (v) => (Array.isArray(v) ? v : [v]).map((s) => [s]);
  let context;
  if (opts.include) context = { include: asList(opts.include) };
  if (opts.exclude) context = { ...(context || {}), exclude: asList(opts.exclude) };

  return win.axe.run(context || win.document, runOptions).then((results) => ({
    violations: results.violations,
    passes: results.passes.length,
  }));
}

Cypress.Commands.add('skiplinkScan', (options = {}) =>
  scanA11y(options).then((raw) =>
    cy
      .task(
        'skiplink:check',
        { ...raw, ...options, standard: options.standard || DEFAULTS.standard, updateBaseline: false, baseline: false },
        { log: false },
      )
      .then((res) => res.result),
  ),
);

Cypress.Commands.add('checkA11y', (options = {}) => {
  const log = Cypress.log({
    name: 'checkA11y',
    message: options.standard || DEFAULTS.standard,
    autoEnd: false,
  });

  return scanA11y(options)
    .then((raw) =>
      cy.task(
        'skiplink:check',
        { ...raw, ...options, standard: options.standard || DEFAULTS.standard },
        { log: false },
      ),
    )
    .then((verdict) => {
      if (verdict.updated) {
        log.set({ message: `baseline updated (${verdict.baseline})` });
        log.end();
        return verdict.result;
      }

      const { summary } = verdict.result;
      log.set({
        message: verdict.fail
          ? verdict.reason
          : `no new violations (${summary.critical + summary.serious + summary.moderate + summary.minor} accepted)`,
        consoleProps: () => ({
          Result: verdict.result,
          New: verdict.outcome.isNew,
          Accepted: verdict.outcome.accepted,
          Drifted: verdict.outcome.drifted,
        }),
      });
      log.end();

      if (verdict.fail) {
        // A plain assertion failure, not a thrown object: Cypress renders the
        // message in the runner and the terminal, and this is where someone will
        // read the list of violations.
        throw new Error(verdict.message);
      }
      return verdict.result;
    });
});
