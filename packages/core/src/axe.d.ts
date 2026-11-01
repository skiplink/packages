import type { Standard, Violation } from './types.js';

/** axe-core tags ("wcag143") to success criteria ("1.4.3"). */
export function wcagFromTags(tags?: string[]): string[];
/** axe-core violations to one entry per offending node, without fingerprints. */
export function flatten(violations: unknown[]): Array<Omit<Violation, 'fingerprint' | 'fingerprint_loose'>>;
/** Standard name to axe-core tags. `null` means every rule axe-core ships. */
export const STANDARDS: Readonly<Record<Standard, string[] | null>>;
/** Tags for a standard, or `undefined` if the name is not one we accept. */
export function tagsForStandard(name: string): string[] | null | undefined;
