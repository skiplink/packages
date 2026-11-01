# Contributing

Thanks for taking the time. Skiplink is maintained by one person, so a clear report
goes a long way.

## Reporting a bug

Open an issue with the bug form. The three things that make a report actionable:

1. **What you ran** — the command, or the workflow step, with secrets removed.
2. **What happened** — the output, and the exit code if it was the CLI or the Action.
3. **What you expected** — and, for a scan result you disagree with, the URL (if it is
   public) and the rule id.

A finding you think is wrong is worth reporting even if you are not sure. axe-core does
the detection, so some reports belong upstream with
[Deque](https://github.com/dequelabs/axe-core/issues) — we will say so and help move it
there if that is the case.

## Security issues

Do not open an issue. See [SECURITY.md](SECURITY.md).

## Pull requests

This repository is published from a private source tree, so **pull requests are read
here but applied upstream** rather than merged directly. Your change still lands with
your name on it. Before starting anything larger than a small fix, open an issue to
talk about it — it saves both of us time.

Two things are deliberately hard to change:

- **Violation fingerprints and the baseline file format.** Customers commit baselines
  to their repositories. Changing how identity is computed turns every one of their
  builds red at once, so a change there needs a new field and a migration path, never a
  redefinition.
- **axe-core itself.** It is used unmodified. Custom rules belong in our own files.

## Development

```bash
npm install          # links the packages to each other
npm test --workspaces
```

Node 20 or later. The Playwright adapter's tests need a browser:
`npx playwright install chromium`.

## Code of conduct

Participation is covered by the [code of conduct](CODE_OF_CONDUCT.md).
