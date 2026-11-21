#!/usr/bin/env node
// MUTATION RUNNER for the stop on a provider refusing the account (register KG-39: ophanim/operate/account-refusal.mjs,
// the stage meter of ophanim/operate/stages.mjs, ophanim/operate/scheduler.mjs). Modelled on ophanim/graph/deps.mutate.mjs.
// Every mutation re-introduces a plausible regression of what the change states: a kind of refusal of the account no
// longer recognized (no credit, exhausted quota, a key the provider does not accept), a rate limit read as one, the
// refused provider asked again in the stage, the refusal not reported to the scheduler, the tick not stopped, the
// refusal counted as an attempt, the stage recorded as it reported instead of pending on the refusal, a blocker that
// is not retried or not the owner's, the stage's own result not kept, an executor's thrown refusal not read -- on a
// DISPOSABLE COPY of this tree (never the tree itself; recorded review findings, `findings-*`, are not copied). Only the
// tests that decide it run there (`tests`: each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node ophanim/operate/account-refusal.mutate.mjs [--only A1,A7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Every provider error in the tests is synthetic; nothing reaches a provider. This
// file is read as text by ophanim/graph/extract/verification.mjs and is never imported by anything (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST = 'ophanim/operate/account-refusal.test.mjs';
const SUITES = [TEST];
const CLASSIFY = 'ophanim/operate/account-refusal.mjs', STAGES = 'ophanim/operate/stages.mjs', SCHED = 'ophanim/operate/scheduler.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});
const T_CLASSIFIED = [TEST, '^ACCOUNT REFUSAL, classified'];
const T_PLANNER = [TEST, '^ACCOUNT REFUSAL, the planner'];
const T_REVIEWER = [TEST, '^ACCOUNT REFUSAL, a reviewer'];
const T_ATTEMPTS = [TEST, '^ACCOUNT REFUSAL uses no attempt'];
const T_THROWN = [TEST, '^ACCOUNT REFUSAL, thrown by an executor'];

export const MUTATIONS = [
  // ---- account-refusal.mjs: what a refusal of the account is, and what it is not ------------------------------------------
  {id: 'A1', what: 'no credit is no longer a refusal of the account (Anthropic\'s 400 "credit balance is too low" reads as a failed answer again)', tests: [T_CLASSIFIED, T_PLANNER],
    edits: [one(CLASSIFY, "  const kind = CREDIT_TEXT.test(text) ? 'credit'", "  const kind = false ? 'credit'")]},
  {id: 'A2', what: 'an exhausted quota or a spend cap is no longer a refusal of the account', tests: [T_CLASSIFIED],
    edits: [one(CLASSIFY, "    : codes.some(c => QUOTA_CODES.includes(c)) ? 'quota'", "    : false ? 'quota'")]},
  {id: 'A3', what: 'a key the provider does not accept is one only on a 401: xAI\'s and Google\'s 400 for an unknown key are missed', tests: [T_CLASSIFIED, T_REVIEWER],
    edits: [one(CLASSIFY, "    : status === 401 || codes.includes('authentication_error') || codes.includes('invalid_api_key') || KEY_TEXT.test(text) ? 'key'", "    : status === 401 ? 'key'")]},
  {id: 'A4', what: 'a rate limit (a 429 that is neither a quota nor a spend cap) is read as a refusal of the account', tests: [T_CLASSIFIED],
    edits: [one(CLASSIFY, '  if (!kind) return null;', '  if (!kind && status !== 429) return null;')]},
  // ---- stages.mjs: the meter sends the refused provider nothing more, and reports the refusal ---------------------------
  {id: 'A5', what: 'the meter asks a provider that refused the account again in the same stage (the planner asked three times)', tests: [T_PLANNER],
    edits: [one(STAGES, '    if (before) {\n      return Promise.reject(', '    if (false) {\n      return Promise.reject(')]},
  {id: 'A6', what: 'the meter does not report the refusal to the scheduler: the stage is recorded as it reported', tests: [T_PLANNER, T_REVIEWER, T_ATTEMPTS],
    edits: [one(STAGES, '{ refusedAccounts.set(who.vendor, a); ctx.accountRefused?.(a); }', '{ refusedAccounts.set(who.vendor, a); }')]},
  // ---- scheduler.mjs: the stop, the pending record, the attempt bound ------------------------------------------------------
  {id: 'A7', what: 'the tick does not stop: the next item is dispatched into the same refusal', tests: [T_PLANNER],
    edits: [one(SCHED, '      if (log.stop?.code === STOP_CODES.ACCOUNT) return;\n', '')]},
  {id: 'A8', what: 'a refusal of the account counts against the stage\'s attempt bound again', tests: [T_ATTEMPTS],
    edits: [one(SCHED, " && s.blocker?.code !== ACCOUNT_REFUSED).length;", ').length;')]},
  {id: 'A9', what: 'a stage that did not pass under a refusal is recorded as it reported (failed, or REVIEW_PENDING), not pending on the refusal', tests: [T_PLANNER, T_REVIEWER, T_ATTEMPTS, T_THROWN],
    edits: [one(SCHED, "      if (!stopped && refusals.length && result.status !== 'passed') {", '      if (false) {')]},
  {id: 'A10', what: 'the refusal\'s blocker is not transient: the item is never retried once the account is restored', tests: [T_PLANNER, T_ATTEMPTS],
    edits: [one(SCHED, '          blocker: {code: ACCOUNT_REFUSED, transient: true,', '          blocker: {code: ACCOUNT_REFUSED, transient: false,')]},
  {id: 'A11', what: 'the refusal is routed to the lead instead of the owner, who alone can restore the account', tests: [T_PLANNER],
    edits: [one(SCHED, "what: why.slice(0, 600), role: 'decision-authority',", "what: why.slice(0, 600), role: 'lead@orch',")]},
  {id: 'A12', what: 'the result the stage reported is not kept beside the refusal', tests: [T_PLANNER, T_REVIEWER, T_THROWN],
    edits: [one(SCHED, 'account_refused: {refusals, status_reported: result.status, ', 'account_refused: {refusals, ')]},
  {id: 'A13', what: 'a refusal of the account in the error an executor threw is not read', tests: [T_THROWN],
    edits: [one(SCHED, '        accountRefused(accountRefusal(e));\n', '')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  // As graph-b.mutate.mjs: a local clone at HEAD (the history kept) whose sparse checkout never writes a withheld path
  // (recorded review findings), with this working tree committed on top.
  const g = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, encoding: 'utf8'});
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', ROOT, dest], {stdio: 'ignore'});
  g(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  g(dest, ['checkout', '-q', g(ROOT, ['rev-parse', 'HEAD']).trim()]);
  const files = g(ROOT, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD.test(f)) continue;                                   // recorded review findings are not read, so not copied
    const from = path.join(ROOT, f), to = path.join(dest, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(to), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.rmSync(to, {force: true}); fs.symlinkSync(fs.readlinkSync(from), to); continue; }
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  g(dest, ['add', '-A']);
  g(dest, ['commit', '-q', '--allow-empty', '-m', 'the working tree under mutation']);
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `account-refusal-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'account-refusal-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
