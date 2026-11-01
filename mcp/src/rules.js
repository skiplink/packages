// The rule catalogue, read from axe-core's own metadata.
//
// Nothing here is our own list of rules, and that is deliberate. axe-core ships
// `getRules()`, which works in plain Node with no browser, and returns every rule
// with its description, help text, documentation URL, tag set and ACT rule ids. A
// hand-maintained copy would go stale the first time axe-core released, and would
// disagree with what an actual scan reports — which is a worse failure than being
// out of date, because it looks like the scanner is wrong.
//
// This is also the part of the MCP server that needs no API key and no network. An
// agent can ask what `aria-required-children` means, which criteria `wcag22aa`
// covers, or which rules are best-practice rather than WCAG, before anyone has
// signed up for anything.

import axe from 'axe-core';
import { tagsForStandard, STANDARDS } from '@skiplink/core/axe';

/** axe-core's version, reported so an answer can be pinned to it. */
export const AXE_VERSION = axe.version;

/**
 * WCAG success criteria numbers from an axe tag set.
 *
 * Not @skiplink/core's wcagFromTags: that one exists to put criteria on a
 * violation and only reads `wcagNNN` tags. Here the level matters too — telling
 * someone a rule maps to 1.4.3 without saying it is a AA criterion leaves out the
 * thing they need in order to decide whether to care.
 */
export function criteriaFor(tags = []) {
  const out = [];
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out;
}

/** The WCAG level a rule belongs to, from its tags, or null for best-practice rules. */
export function levelFor(tags = []) {
  // Order matters: a rule tagged both wcag2a and wcag21aa is reported at the
  // stricter level it was added at, which is what determines when it starts to
  // apply to you.
  if (tags.includes('wcag2aaa') || tags.includes('wcag21aaa')) return 'AAA';
  if (tags.includes('wcag2aa') || tags.includes('wcag21aa') || tags.includes('wcag22aa')) {
    return 'AA';
  }
  if (tags.includes('wcag2a') || tags.includes('wcag21a') || tags.includes('wcag22a')) return 'A';
  return null;
}

/**
 * Which WCAG version first defined a rule's criteria, so "we target 2.1" is
 * answerable without cross-referencing the specification.
 */
export function wcagVersionFor(tags = []) {
  if (tags.some((t) => t.startsWith('wcag22'))) return '2.2';
  if (tags.some((t) => t.startsWith('wcag21'))) return '2.1';
  if (tags.some((t) => /^wcag2a{1,3}$/.test(t))) return '2.0';
  return null;
}

/** Strip axe's telemetry parameter from a documentation link. */
function cleanURL(url) {
  return typeof url === 'string' ? url.replace(/[?&]application=axeAPI/, '') : url;
}

/** Category tags (`cat.color`) reworded as something readable. */
function categoryFor(tags = []) {
  const cat = tags.find((t) => t.startsWith('cat.'));
  return cat ? cat.slice(4).replace(/-/g, ' ') : null;
}

let catalogue = null;

/** Every rule axe-core ships, normalised. Built once. */
export function allRules() {
  if (catalogue) return catalogue;

  catalogue = axe.getRules().map((r) => {
    const tags = r.tags || [];
    return {
      rule: r.ruleId,
      description: r.description,
      help: r.help,
      help_url: cleanURL(r.helpUrl),
      category: categoryFor(tags),
      wcag: criteriaFor(tags),
      level: levelFor(tags),
      wcag_version: wcagVersionFor(tags),
      // A rule with no WCAG tag is a best-practice check. Failing a build on those
      // is a legitimate choice but it is not a compliance requirement, and
      // conflating the two is how a scanner ends up overstating what it found.
      best_practice: tags.includes('best-practice') || criteriaFor(tags).length === 0,
      // ACT rules are the W3C's own published test procedures. Their presence means
      // a rule's behaviour is externally specified rather than one vendor's opinion.
      act_ids: r.actIds || [],
      tags,
    };
  });
  return catalogue;
}

/** One rule by id, or null. */
export function findRule(id) {
  if (typeof id !== 'string' || !id) return null;
  return allRules().find((r) => r.rule === id.trim()) || null;
}

/**
 * Rules that would run for a standard.
 *
 * `all` means every rule, which is how axe expresses an absent tag filter, so it
 * is the whole catalogue rather than an empty result.
 */
export function rulesForStandard(standard) {
  const tags = tagsForStandard(standard);
  if (tags === undefined) return undefined;
  if (tags === null) return allRules();
  return allRules().filter((r) => r.tags.some((t) => tags.includes(t)));
}

/**
 * Rules whose id or text mentions a term.
 *
 * Substring matching on purpose. Someone asking about "contrast" should find
 * `color-contrast` and `color-contrast-enhanced`, and an agent guessing at a rule
 * name should be told which real rules are close rather than getting nothing.
 */
export function searchRules(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return allRules().filter(
    (r) =>
      r.rule.includes(q) ||
      r.help.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.wcag.some((c) => c.startsWith(q)),
  );
}

/** The accepted standard names, with what each one covers. */
export function standardsSummary() {
  return Object.keys(STANDARDS).map((name) => {
    const rules = rulesForStandard(name);
    const criteria = new Set(rules.flatMap((r) => r.wcag));
    return {
      standard: name,
      rules: rules.length,
      wcag_criteria: criteria.size,
      includes_best_practice: rules.some((r) => r.best_practice),
    };
  });
}
