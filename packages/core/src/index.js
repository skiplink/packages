// Everything the CLI and the test-framework adapters share.
//
// Kept in one package rather than copied into each consumer because it holds the
// two things that must not drift: how a violation is identified, and how a
// baseline decides whether a violation is new. A second copy of either would
// eventually disagree, and a gate that disagrees with itself reports green on a
// broken page.
export * from './fingerprint.js';
export * from './axe.js';
export * from './baseline.js';
export * from './report.js';
