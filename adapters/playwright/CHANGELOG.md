# Changelog

All notable changes to `@skiplink/playwright`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## 1.0.0 — 2026-11-01

First public release.

- `expectNoNewViolations(page)` and `scan(page)`: run axe-core in a page your test already has open — behind a login, on localhost, mid-checkout.
- Writes to the same baseline file as the CLI and the GitHub Action.
- `SKIPLINK_UPDATE_BASELINE=1` records the current state; updates merge rather than replace.
- Type declarations.
