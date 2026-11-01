/// <reference types="cypress" />
import type { FailOn, ScanResult, Standard } from '@skiplink/core';

export interface SkiplinkScanOptions {
  /** Default `wcag22aa`. */
  standard?: Standard;
  include?: string | string[];
  exclude?: string | string[];
  disableRules?: string[];
}

export interface SkiplinkCheckOptions extends SkiplinkScanOptions {
  /** Default `.skiplink/baseline.json`. `false` fails on any violation. */
  baseline?: string | false;
  /** Default `'new'`. */
  failOn?: FailOn;
  /** Record the current state and pass. Also `SKIPLINK_UPDATE_BASELINE=1`. */
  updateBaseline?: boolean;
}

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      /** Fail the test on violations that are not in the baseline. */
      checkA11y(options?: SkiplinkCheckOptions): Chainable<ScanResult>;
      /** The same scan without the assertion. */
      skiplinkScan(options?: SkiplinkScanOptions): Chainable<ScanResult>;
    }
  }
}

export {};
