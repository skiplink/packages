import type { Page } from 'playwright';
import type { FailOn, ScanResult, Standard } from '@skiplink/core';

export interface ScanOptions {
  /** Default `wcag22aa`. */
  standard?: Standard;
  /** Restrict the scan to a selector or selectors. */
  include?: string | string[];
  /** Skip a selector or selectors. */
  exclude?: string | string[];
  /** Rule ids to turn off entirely. */
  disableRules?: string[];
}

export interface GateOptions extends ScanOptions {
  /** Default `.skiplink/baseline.json`, or `SKIPLINK_BASELINE`. `false` fails on any violation. */
  baseline?: string | false;
  /** Default `'new'`. Impact floors still respect the baseline. */
  failOn?: FailOn;
  /** Record the current state and pass. Also `SKIPLINK_UPDATE_BASELINE=1`. */
  updateBaseline?: boolean;
}

/** Run axe-core in the page as it stands and return a hosted-API-shaped result. */
export function scan(page: Page, options?: ScanOptions): Promise<ScanResult & { passes: number }>;

/** Throw if the page has violations that are not in the baseline. */
export function expectNoNewViolations(page: Page, options?: GateOptions): Promise<ScanResult>;

/** Raw axe-core run, before fingerprinting. Exposed for tooling; prefer `scan`. */
export function runAxe(page: Page, options?: ScanOptions): Promise<{
  violations: Array<Record<string, unknown>>;
  passes: number;
  axeVersion: string;
  browserVersion: string;
}>;

/** The axe-core version that will be used, resolved from your node_modules. */
export function axeVersion(): string;
