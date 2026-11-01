# Security policy

## Reporting a vulnerability

Email **security@skiplink.dev**. Please do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it.
A person reads every report. There is no bug bounty budget; saying so beats implying a reward that is not there.

Research carried out in good faith under this policy is welcome, and we will not
pursue legal action over it. The full policy, including scope and safe harbour, is at
[skiplink.dev/legal/security](https://skiplink.dev/legal/security/). The machine-readable
contact is at [skiplink.dev/.well-known/security.txt](https://skiplink.dev/.well-known/security.txt).

## Supported versions

Only the latest published version of each package, and the latest `v1` tag of the
GitHub Action, receive fixes.

## Scope notes

The hosted scanner fetches URLs that strangers choose. Server-side request forgery
against it — reaching private, loopback or metadata addresses, directly or through
redirects or DNS — is squarely in scope and the kind of report we most want.
