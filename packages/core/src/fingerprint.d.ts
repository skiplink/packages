export function truncateBytes(s: string, limit?: number): string;
export function lowerASCII(s: string): string;
export function normaliseSelector(selector: string): string;
export function normaliseText(html: string): string;
export function normaliseMarkupShape(html: string): string;
/** Exact identity: rule plus normalised selector. Frozen contract. */
export function fingerprint(rule: string, selector: string): string;
/** Loose identity: rule plus element text. Frozen contract. */
export function fingerprintLoose(rule: string, html: string): string;
