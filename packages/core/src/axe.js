// Turning axe-core's output into our violation shape.
//
// This is shared rather than copied because fingerprints are computed from what
// it produces. The exact fingerprint hashes the selector this file builds; the
// loose one hashes the html it picks. Two implementations of this would drift and
// take the fingerprints with them, so the hosted worker and the test-framework
// adapters both call these functions.

/**
 * axe-core tags to WCAG success criteria numbers.
 *
 * axe tags look like "wcag143" (1.4.3) or "wcag1411" (1.4.11): the first two
 * digits are principle and guideline, whatever follows is the criterion.
 */
export function wcagFromTags(tags = []) {
  const out = [];
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out;
}

/**
 * Flatten axe violations to one entry per offending node.
 *
 * One violation per element, not per rule: a rule that fails on nine elements is
 * nine things to fix, nine baseline entries, and nine independently resolvable
 * findings.
 */
export function flatten(violations) {
  const out = [];
  for (const v of violations) {
    const wcag = wcagFromTags(v.tags);
    for (const node of v.nodes) {
      out.push({
        rule: v.id,
        impact: node.impact || v.impact || '',
        wcag,
        // node.target is an array; nested arrays address elements inside frames.
        selector: node.target.flat(Infinity).join(' >>> '),
        html: node.html,
        // failureSummary is multi-line and prefixed; the first check message is
        // the specific, quotable one ("Contrast ratio 3.1:1, needs 4.5:1").
        message:
          node.any?.[0]?.message ||
          node.all?.[0]?.message ||
          node.none?.[0]?.message ||
          v.help,
        help: v.help,
        help_url: v.helpUrl,
      });
    }
  }
  return out;
}

/**
 * Standard names to axe-core tag sets.
 *
 * Mirrors schema.Standards in Go, and test/standards.test.js checks the two
 * against a file Go generates — a standard that means different rules depending
 * on which path ran the scan would be a quiet and very confusing bug.
 *
 * null means every rule axe-core ships, including best-practice rules that are
 * not WCAG success criteria.
 */
export const STANDARDS = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21a: ['wcag2a', 'wcag21a'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  section508: ['section508'],
  all: null,
};

/** Tags for a standard name, or undefined if the name is not one we accept. */
export function tagsForStandard(name) {
  return Object.prototype.hasOwnProperty.call(STANDARDS, name) ? STANDARDS[name] : undefined;
}
