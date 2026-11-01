// Type declarations for @skiplink/core. Hand-written alongside the JavaScript, which
// stays the source of truth; `npm test` type-checks nothing, so keep these to the
// shapes the code actually returns.

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
export type Standard = 'wcag2a' | 'wcag2aa' | 'wcag21a' | 'wcag21aa' | 'wcag22aa' | 'section508' | 'all';
export type FailOn = 'new' | Impact | 'never';

/** One offending element. A rule that fails on nine elements is nine violations. */
export interface Violation {
  rule: string;
  impact: Impact;
  /** WCAG success criteria, e.g. ["1.4.3"]. Empty for best-practice rules. */
  wcag: string[];
  selector: string;
  html: string;
  message: string;
  help_url?: string;
  /** Rule plus normalised selector. Frozen: committed baselines depend on it. */
  fingerprint: string;
  /** Rule plus element text. Survives a class rename. */
  fingerprint_loose: string;
}

/** The result object, whether it came from the hosted API or a local adapter. */
export interface ScanResult {
  id?: string;
  url: string;
  final_url?: string;
  standard: Standard;
  status: 'queued' | 'running' | 'done' | 'failed';
  engine: { axe_core: string; chromium?: string } | null;
  score?: number;
  summary: Record<Impact, number>;
  violations: Violation[];
  http_status?: number;
  duration_ms?: number;
  error_code?: string;
  error_message?: string;
  disclaimer?: string;
  [key: string]: unknown;
}

export interface BaselineEntry {
  path: string;
  fingerprint: string;
  fingerprint_loose?: string;
  rule: string;
  impact?: Impact;
  selector?: string;
}

export interface Baseline {
  version: number;
  generated_at: string | null;
  engine: { axe_core: string; chromium?: string } | null;
  entries: BaselineEntry[];
}

export type DiffItem = Violation & { url: string; path: string };

export interface DiffResult {
  /** Not in the baseline. What the gate fails on. */
  isNew: DiffItem[];
  /** Matched an entry exactly. */
  accepted: DiffItem[];
  /** Matched only on the loose fingerprint: accepted, but worth refreshing. */
  drifted: DiffItem[];
  /** Baseline entries nothing matched — fixed, or a page this run did not visit. */
  fixed: BaselineEntry[];
  total: number;
}

export interface Verdict {
  fail: boolean;
  reason: string;
  blocking: DiffItem[];
}
