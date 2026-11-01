// Violation identity, in JavaScript.
//
// This is a deliberate second implementation of internal/scan/schema/schema.go.
// The hosted scanner fingerprints in Go; the test-framework adapters run axe in
// the customer's own browser and fingerprint here. Both write to the same
// baseline file, so the two must agree exactly. If they drift by one character, a
// baseline recorded through one path stops matching through the other, every
// accepted violation reappears as new, and a build fails for reasons nobody can
// see — it would look like our scanner is flaky.
//
// Parity is enforced by test/fingerprint.test.js, which reads the vector file the
// Go implementation generates. Do not change anything here without running it.
//
// Three places where the obvious JavaScript is wrong, all found by writing the
// vectors before writing this code:
//
//  1. Go's \s is [\t\n\f\r ]. JavaScript's \s also matches U+00A0, U+2009,
//     U+3000 and U+FEFF, so the obvious /\s+/g collapses spaces Go leaves alone.
//  2. Go truncates at 120 bytes of UTF-8. JavaScript strings are UTF-16, so
//     slice(0, 120) counts different units entirely for any non-ASCII text.
//  3. Truncation must not split a character. Go backs off to a rune boundary;
//     here that means measuring in bytes and cutting on a code-point boundary.
//  4. toLowerCase() applies Unicode's full special casing and Go's strings.ToLower
//     applies simple per-rune mapping, so they disagree on U+0130 (İ becomes "i"
//     in Go, "i" plus a combining dot in JavaScript) and on Greek final sigma
//     (JavaScript lowercases a trailing Σ to ς, Go always to σ). Both are correct
//     for text and neither can be made to match the other, so both sides fold
//     ASCII only.

import { createHash } from 'node:crypto';

// Go's \s exactly, not JavaScript's.
const WHITESPACE = /[\t\n\f\r ]+/g;
const TAG = /<[^>]*>/g;
const ATTR_VALUE = /=[\t\n\f\r ]*"[^"]*"|=[\t\n\f\r ]*'[^']*'/g;

const TEXT_LIMIT_BYTES = 120;

const encoder = new TextEncoder();

/**
 * Truncate to at most `limit` bytes of UTF-8 without splitting a character.
 *
 * Iterating code points rather than UTF-16 units, so a surrogate pair is one
 * unit here and is either wholly kept or wholly dropped — matching Go, whose
 * range loop walks runes.
 */
export function truncateBytes(s, limit = TEXT_LIMIT_BYTES) {
  // Fast path: ASCII-only strings, which is nearly all of them.
  if (s.length <= limit && !/[^\x00-\x7F]/.test(s)) return s;

  let bytes = 0;
  let out = '';
  for (const char of s) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * Lowercase A-Z and nothing else.
 *
 * Not toLowerCase(): see note 4 at the top. A fingerprint needs the same bytes on
 * both sides far more than it needs Unicode case semantics.
 */
export function lowerASCII(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** Collapse whitespace and unify axe-core's iframe path separator. */
export function normaliseSelector(selector) {
  const collapsed = String(selector ?? '').trim().replace(WHITESPACE, ' ');
  return collapsed.replaceAll(' >>> ', '>>>').trim();
}

/** Visible text of an HTML snippet: tags out, whitespace collapsed, lowercased. */
export function normaliseText(html) {
  const text = String(html ?? '')
    .replace(TAG, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
  return truncateBytes(lowerASCII(text));
}

/** Markup shape with attribute values removed, for elements that have no text. */
export function normaliseMarkupShape(html) {
  const shape = String(html ?? '')
    .replace(ATTR_VALUE, '')
    .replace(WHITESPACE, ' ')
    .trim();
  return truncateBytes(lowerASCII(shape));
}

function hashID(input) {
  return 'f_' + createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
}

/** Exact identity: rule plus normalised selector. */
export function fingerprint(rule, selector) {
  return hashID(`${rule}|${normaliseSelector(selector)}`);
}

/**
 * Churn-resistant identity: rule plus the element's text. Collides across
 * repeated instances of the same component, which is why the baseline matcher
 * only ever uses it as a fallback for the exact fingerprint.
 */
export function fingerprintLoose(rule, html) {
  const text = normaliseText(html) || normaliseMarkupShape(html);
  return hashID(`${rule}|${text}`);
}
