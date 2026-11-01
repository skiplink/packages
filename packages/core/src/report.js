// Output formats. Three audiences: a person reading a terminal, a machine
// reading stdout, and GitHub reading workflow commands.

const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// Colour only when stdout is a TTY and NO_COLOR is unset. CI logs full of
// escape codes are worse than no colour at all.
function makeStyle(stream) {
  const on = stream.isTTY && !process.env.NO_COLOR;
  const wrap = (code) => (s) => (on ? `[${code}m${s}[0m` : s);
  return {
    bold: wrap(1),
    dim: wrap(2),
    red: wrap(31),
    green: wrap(32),
    yellow: wrap(33),
    blue: wrap(34),
    grey: wrap(90),
  };
}

const byImpact = (a, b) =>
  (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) ||
  a.rule.localeCompare(b.rule);

function impactTag(style, impact) {
  const label = (impact || 'unknown').toUpperCase().padEnd(8);
  if (impact === 'critical' || impact === 'serious') return style.red(label);
  if (impact === 'moderate') return style.yellow(label);
  return style.grey(label);
}

/** Human-readable terminal report. */
export function human(diffResult, verdict, { scans, style = makeStyle(process.stdout) } = {}) {
  const lines = [];
  const failed = scans.filter((s) => s.status === 'failed');
  // A page that answered 4xx or 5xx was still scanned — a styled 404 is a real page —
  // but the findings describe an error page, not the page anybody meant to test. Said
  // first and loudly, because otherwise a moved staging URL produces a plausible report
  // for the wrong document and `--update-baseline` writes it down as the truth.
  const errored = scans.filter((s) => typeof s.http_status === 'number' && s.http_status >= 400);

  lines.push('');
  for (const s of errored) {
    lines.push(
      style.yellow(`  ! ${s.url} answered HTTP ${s.http_status}`),
      style.dim('    It was scanned anyway, but these findings describe an error page.'),
      style.dim('    Check the URL before trusting this result or recording a baseline.'),
      '',
    );
  }
  for (const v of diffResult.isNew.slice().sort(byImpact)) {
    lines.push(`  ${impactTag(style, v.impact)} ${style.bold(v.rule)}  ${style.grey(v.path)}`);
    lines.push(`           ${v.selector}`);
    lines.push(`           ${style.dim(v.message || '')}`);
    if (v.help_url) lines.push(`           ${style.blue(v.help_url)}`);
    lines.push('');
  }

  if (diffResult.drifted.length > 0) {
    lines.push(
      style.yellow(`  ${diffResult.drifted.length} accepted violation(s) moved to a new selector.`),
    );
    lines.push(
      style.dim('  Matched on content instead. Run --update-baseline to refresh the fingerprints.'),
    );
    lines.push('');
  }

  if (diffResult.fixed.length > 0) {
    lines.push(style.green(`  ${diffResult.fixed.length} baseline violation(s) no longer present.`));
    lines.push(
      style.dim('  Fixed, or on a page this run did not scan. Run --update-baseline to prune them.'),
    );
    lines.push('');
  }

  for (const s of failed) {
    lines.push(`  ${style.red('SCAN FAILED')} ${s.url}`);
    lines.push(`           ${style.dim(`${s.error_code}: ${s.error_message || ''}`)}`);
    lines.push('');
  }

  const summary = [
    `${diffResult.total} violation(s)`,
    `${diffResult.isNew.length} new`,
    `${diffResult.accepted.length + diffResult.drifted.length} accepted`,
  ].join(' · ');

  lines.push(style.dim('  ' + '─'.repeat(64)));
  lines.push(
    verdict.fail
      ? `  ${style.red(style.bold('FAILED'))}  ${verdict.reason}`
      : `  ${style.green(style.bold('PASSED'))}  ${summary}`,
  );
  if (!verdict.fail) lines.push(style.dim(`  ${summary}`));
  lines.push('');

  // Never let a passing scan imply legal compliance. Same disclaimer the API
  // ships in every response body, for the same reason.
  lines.push(
    style.dim(
      '  Automated testing covers a subset of WCAG. A pass means no automatically\n' +
        '  detectable violations were found, not that the page conforms to WCAG or\n' +
        '  complies with any law. Manual review is required for a conformance claim.',
    ),
  );
  lines.push('');

  return lines.join('\n');
}

/** Machine-readable. The shape other tools should depend on. */
export function json(diffResult, verdict, { scans }) {
  return JSON.stringify(
    {
      passed: !verdict.fail,
      reason: verdict.reason,
      summary: {
        total: diffResult.total,
        new: diffResult.isNew.length,
        accepted: diffResult.accepted.length,
        drifted: diffResult.drifted.length,
        fixed: diffResult.fixed.length,
        scans_failed: scans.filter((s) => s.status === 'failed').length,
      },
      new_violations: diffResult.isNew,
      drifted_violations: diffResult.drifted,
      fixed_violations: diffResult.fixed,
      scans: scans.map((s) => ({
        id: s.id,
        url: s.url,
        status: s.status,
        score: s.score,
        error_code: s.error_code,
        engine: s.engine,
      })),
    },
    null,
    2,
  );
}

/**
 * GitHub workflow commands: inline annotations on the run.
 *
 * Annotations without a file/line land on the run summary rather than the diff,
 * which is correct here — a violation belongs to a rendered page, not to a line
 * of source, and guessing at a source location would put the marker on the
 * wrong line more often than not.
 */
export function githubAnnotations(diffResult) {
  const out = [];
  for (const v of diffResult.isNew.slice().sort(byImpact)) {
    const level = v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning';
    const title = `${v.rule} (${v.impact}) on ${v.path}`;
    const message = [v.message, v.selector, v.help_url].filter(Boolean).join(' — ');
    out.push(`::${level} title=${escapeProp(title)}::${escapeData(message)}`);
  }
  return out.join('\n');
}

/** Markdown for the pull request comment and the job summary. */
export function markdown(diffResult, verdict, { scans, runUrl } = {}) {
  const md = [];
  const icon = verdict.fail ? '🔴' : '🟢';
  const state = verdict.fail ? 'Build failed' : 'Build passed';

  md.push(`### ${icon} Skiplink — ${state}`);
  md.push('');

  // Before the numbers, not after. A reviewer skims the top of a PR comment, and a
  // report for a 404 is worse than no report — it looks authoritative.
  const errored = scans.filter((s) => typeof s.http_status === 'number' && s.http_status >= 400);
  for (const s of errored) {
    md.push(
      `> **⚠️ \`${s.url}\` answered HTTP ${s.http_status}.** It was scanned anyway, but these ` +
        'findings describe an error page rather than the page you meant to test. Check the URL.',
      '',
    );
  }
  md.push(
    `**${diffResult.total}** violation(s) across ${scans.length} page(s): ` +
      `**${diffResult.isNew.length} new**, ` +
      `${diffResult.accepted.length + diffResult.drifted.length} accepted by the baseline.`,
  );
  md.push('');

  if (diffResult.isNew.length > 0) {
    md.push('#### New violations');
    md.push('');
    md.push('| Impact | Rule | Page | Selector |');
    md.push('|---|---|---|---|');
    for (const v of diffResult.isNew.slice().sort(byImpact).slice(0, 30)) {
      const rule = v.help_url ? `[${v.rule}](${v.help_url})` : v.rule;
      md.push(`| ${v.impact} | ${rule} | \`${v.path}\` | \`${truncate(v.selector, 60)}\` |`);
    }
    if (diffResult.isNew.length > 30) {
      // Say what was cut. A truncated table that does not admit it reads as a
      // complete one.
      md.push('');
      md.push(`_${diffResult.isNew.length - 30} further new violations not shown._`);
    }
    md.push('');
    md.push(
      '<details><summary>Accept these deliberately</summary>\n\n' +
        'Run `npx @skiplink/cli scan <urls> --update-baseline` and commit the change. ' +
        'The diff shows exactly what is being accepted, so it can be reviewed like any other change.\n\n</details>',
    );
    md.push('');
  }

  if (diffResult.drifted.length > 0) {
    md.push(
      `> ${diffResult.drifted.length} accepted violation(s) matched on content rather than selector — ` +
        'a restyle probably moved them. `--update-baseline` refreshes the fingerprints.',
    );
    md.push('');
  }

  if (diffResult.fixed.length > 0) {
    md.push(
      `> ${diffResult.fixed.length} baseline violation(s) were not seen this run. ` +
        'Fixed, or on a page this run did not scan.',
    );
    md.push('');
  }

  const failedScans = scans.filter((s) => s.status === 'failed');
  if (failedScans.length > 0) {
    md.push('#### Pages that could not be scanned');
    md.push('');
    for (const s of failedScans) md.push(`- \`${s.url}\` — ${s.error_code}: ${s.error_message || ''}`);
    md.push('');
  }

  md.push('---');
  md.push(
    '<sub>Automated testing covers a subset of WCAG. A pass means no automatically detectable ' +
      'violations were found — not that the page conforms to WCAG, nor that it complies with the ADA, ' +
      'Section 508, or the European Accessibility Act. Manual review by a qualified reviewer is ' +
      'required for a conformance claim.' +
      (runUrl ? ` · [Full run](${runUrl})` : '') +
      '</sub>',
  );

  return md.join('\n');
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
