# Changelog

All notable changes to `@skiplink/cli`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## 1.0.0 — 2026-11-01

First public release.

- `skiplink scan <url...>` against the hosted API, with `--baseline`, `--update-baseline`, `--fail-on`, `--standard`, `--format human|json|github` and `--comment-file`.
- Exit codes: 0 passed, 1 gate failed, 2 usage error, 3 could not complete.
- `--wait-for` for pages that render late, `--timeout` to cap how long the run waits for results, `--quiet` for CI logs, `--token`/`SKIPLINK_TOKEN` and `--api`/`SKIPLINK_API`.
- `--version`; unknown `--standard` and `--fail-on` values are refused before any network call.
- Unreachable-API errors name the cause and point at the status page.
- A URL the hosted scanner cannot reach (localhost, private addresses, other ports) says so and points to `@skiplink/playwright`, which runs the same checks inside your tests.

0.1.0 was an early build published before `@skiplink/core` existed. It has been removed from npm; 1.0.0 is the first release.
