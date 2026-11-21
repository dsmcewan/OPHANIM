#!/usr/bin/env node
// The verification summary a workflow run writes to $GITHUB_STEP_SUMMARY (docs/public-record.md):
// per suite, the node:test counts read from the run's own logs, and the status ledger's verification.
//
//   node ophanim/public/ci-summary.mjs LABEL=LOG [LABEL=LOG ...]
//
// A log holding several npm scripts (`npm test` runs three packages) is split at each `> name@version
// script` header, so every suite is counted on its own. A log that is missing is reported, not skipped.
// `cancelled` is its own column, in bold when non-zero: node:test counts a timed-out test, or a file cut off before
// its tests finished, as cancelled and NOT as fail, so `fail 0` alone does not mean the suite ran (L-503). The
// pass/fail judgement is scripts/test-gates/check.mjs; this table only shows the counts.
//
// Inputs:  LABEL=LOG arguments; the status ledger, verified by running packages/ledger/status.mjs verify.
// Outputs: Markdown on stdout; exit code 1 if the status ledger does not verify.
// Must never: invent a count it did not read, or hide a missing log or a failed ledger verification.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const COUNT = /^(?:ℹ|#) (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/;
const HEADER = /^> (\S+)@\S+ (\S+)/;

/** The suites in one log: [{suite, tests, pass, fail, skipped, todo, cancelled}]. */
export function suiteCounts(text, label) {
  const out = [];
  let name = label, cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = HEADER.exec(line);
    if (h) { name = `${label}: ${h[1]} ${h[2]}`; cur = null; continue; }
    const m = COUNT.exec(line.trim());
    if (!m) continue;
    if (!cur || m[1] === 'tests' && 'tests' in cur) { cur = {suite: name}; out.push(cur); }
    cur[m[1]] = Number(m[2]);
  }
  return out;
}

export function summary(logs, {statusVerify = null} = {}) {
  const rows = [];
  for (const {label, file} of logs) {
    if (!fs.existsSync(file)) { rows.push({suite: label, missing: true}); continue; }
    const found = suiteCounts(fs.readFileSync(file, 'utf8'), label);
    rows.push(...(found.length ? found : [{suite: label, missing: true}]));
  }
  const n = v => v ?? 0;
  return [
    '## Verification summary',
    '',
    '| Suite | Tests | Pass | Fail | Skipped | Todo | Cancelled |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => (r.missing ? `| ${r.suite} | no result (the step did not run or did not finish) | | | | | |`
      : `| ${r.suite} | ${n(r.tests)} | ${n(r.pass)} | ${n(r.fail)} | ${n(r.skipped)} | ${n(r.todo)} | ${n(r.cancelled) ? `**${r.cancelled}**` : 0} |`)),
    '',
    ...(statusVerify
      ? ['### Status ledger', '', '`node packages/ledger/status.mjs verify`', '', '```', statusVerify.trim(), '```', '']
      : []),
  ].join('\n');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Each argument is `label=file`, split at the first '='.
  const logs = process.argv.slice(2).map(a => {
    const i = a.indexOf('='); return {label: a.slice(0, i), file: a.slice(i + 1)};
  });
  let statusVerify;
  try {
    statusVerify = execFileSync(process.execPath, [path.resolve(HERE, '../../packages/ledger/status.mjs'), 'verify'],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  }
  catch (err) { statusVerify = `FAILED: ${(err.stderr || err.stdout || err.message).trim()}`; process.exitCode = 1; }
  console.log(summary(logs, {statusVerify}));
}
