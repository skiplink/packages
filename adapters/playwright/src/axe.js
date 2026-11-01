// Running axe-core inside a page Playwright already controls.
//
// axe-core is injected and called through its public API, unmodified. It is a
// peer dependency resolved from your own node_modules, so the version in your
// results is the version in your lockfile — and you can see it in
// `engine.axe_core` on every result rather than having to trust us about it.

import { createRequire } from 'node:module';
import { flatten, tagsForStandard } from '@skiplink/core/axe';

const require = createRequire(import.meta.url);

let cached = null;

/**
 * The axe-core source and version, resolved from the caller's node_modules.
 *
 * Read from disk rather than imported so the exact same string is injected into
 * every page, and so a missing peer dependency produces an explanation instead of
 * a module-resolution stack trace.
 */
function axeSource() {
  if (cached) return cached;
  try {
    const path = require.resolve('axe-core');
    const { version } = require('axe-core/package.json');
    const { readFileSync } = require('node:fs');
    cached = { source: readFileSync(path, 'utf8'), version };
    return cached;
  } catch (err) {
    throw new Error(
      '@skiplink/playwright needs axe-core, which is a peer dependency so that the version ' +
        'reported in your results is the one in your lockfile.\n\n  npm install --save-dev axe-core\n\n' +
        `(${err.message})`,
    );
  }
}

/** The axe-core version that will be used, for reporting and for pinning. */
export function axeVersion() {
  return axeSource().version;
}

/**
 * Run axe-core against the current state of the page.
 *
 * Deliberately does not navigate, wait for a network idle state, or touch the
 * page in any way beyond injecting the engine. The test put the page in the state
 * it wants tested; guessing that it needs another wait would be both wrong and
 * unpredictable.
 *
 * @param {import('playwright').Page} page
 */
export async function runAxe(page, options = {}) {
  const { source, version } = axeSource();
  const standard = options.standard || 'wcag22aa';
  const tags = tagsForStandard(standard);

  if (tags === undefined) {
    throw new Error(
      `Unknown standard ${JSON.stringify(standard)}. ` +
        'One of: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, section508, all.',
    );
  }

  // Injected into the main frame and every child frame: an iframe is where
  // payment forms and embedded widgets live, and they are exactly the parts
  // people cannot fix but do need to know about.
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(source);
    } catch {
      // A frame that navigated or closed while we were injecting is not an error
      // worth failing a test over; axe will simply not see inside it.
    }
  }

  const raw = await page.evaluate(
    async ({ tags, include, exclude, disableRules }) => {
      const runOptions = { resultTypes: ['violations', 'passes'] };
      if (tags) runOptions.runOnly = { type: 'tag', values: tags };
      if (disableRules?.length) {
        runOptions.rules = Object.fromEntries(disableRules.map((id) => [id, { enabled: false }]));
      }

      let context = undefined;
      if (include) context = { include: asSelectorList(include) };
      if (exclude) context = { ...(context || {}), exclude: asSelectorList(exclude) };

      function asSelectorList(v) {
        return (Array.isArray(v) ? v : [v]).map((s) => [s]);
      }

      // eslint-disable-next-line no-undef
      const results = await window.axe.run(context || document, runOptions);
      return {
        violations: results.violations,
        passes: results.passes.length,
      };
    },
    {
      tags,
      include: options.include ?? null,
      exclude: options.exclude ?? null,
      disableRules: options.disableRules ?? [],
    },
  );

  return {
    violations: flatten(raw.violations),
    passes: raw.passes,
    axeVersion: version,
    browserVersion: page.context().browser()?.version() ?? '',
  };
}
