import type { DiffResult, ScanResult, Verdict } from './types.js';

export function human(diffResult: DiffResult, verdict: Verdict, opts: { scans: ScanResult[]; style?: unknown }): string;
export function json(diffResult: DiffResult, verdict: Verdict, opts: { scans: ScanResult[] }): string;
/** `::error` / `::warning` workflow commands, one per new violation. */
export function githubAnnotations(diffResult: DiffResult): string;
/** The pull-request comment and job summary. */
export function markdown(diffResult: DiffResult, verdict: Verdict, opts: { scans: ScanResult[]; runUrl?: string | null }): string;
