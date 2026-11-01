import type { Baseline, DiffResult, FailOn, ScanResult, Verdict } from './types.js';

export const BASELINE_VERSION: number;
/** Baselines key on URL path (plus query), never hostname. Frozen contract. */
export function pathKeyFor(url: string): string;
export function emptyBaseline(): Baseline;
/** `null` when the file does not exist; throws on a file it cannot read. */
export function loadBaseline(path: string): Promise<Baseline | null>;
export function saveBaseline(path: string, baseline: Baseline): Promise<void>;
export function baselineFrom(
  results: Array<Pick<ScanResult, 'url' | 'violations'>>,
  opts?: { engine?: Baseline['engine']; now?: string },
): Baseline;
export function diff(results: Array<Pick<ScanResult, 'url' | 'violations'>>, baseline: Baseline | null): DiffResult;
export function shouldFail(diffResult: DiffResult, failOn: FailOn): Verdict;
