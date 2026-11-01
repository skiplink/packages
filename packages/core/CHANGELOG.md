# Changelog

All notable changes to `@skiplink/core`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## 1.0.0 — 2026-11-01

First public release.

- Violation identity: `fingerprint` (rule + normalised selector) and `fingerprintLoose` (rule + element text). Both are frozen — committed baselines depend on them, and the Go API computes the same values.
- Baselines keyed on URL path, not hostname, so preview deployments keep matching. File format version 1.
- `diff` and `shouldFail`: exact match first, loose match second, each loose match consumed once per baseline entry.
- Reporters for the terminal, JSON, GitHub annotations and the pull-request comment.
- Type declarations for every entry point.
