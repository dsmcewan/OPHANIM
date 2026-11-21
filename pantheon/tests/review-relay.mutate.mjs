#!/usr/bin/env node
// MUTATION RUNNER for the test relay of the codex reviewer (pantheon/src/review-runner/relay.mjs, its use in
// subscription.mjs and coverage.mjs, and its record in pr-review.mjs; owner direction 2026-11-21). Modelled on
// pantheon/tests/capability.mutate.mjs. Every mutation re-introduces a plausible regression of what the relay states: a
// request run without the hook's decision, a repeated id, the test budget, the wall clock or the round limit not
// enforced, a jail refusal or a killed test counted as a test run, the reviewer's conclusion not recorded, an unjudged
// test passing the gate, relayed tests not counted, the results sent to a new thread, the exit code not sent back, who
// requested or which runner executed a test not recorded, a conclusion swallowing the lines after it, the relay not
// offered to codex or its launchers not written, the relay record dropped from the action's result -- on a DISPOSABLE
// COPY of this tree (never the tree itself; recorded review findings, `findings-*`, are not copied). Only the tests that
// decide it run there (`tests`: each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node pantheon/tests/review-relay.mutate.mjs [--only T1,T7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its deciding
// tests stay green with it. The codex SDK is scripted; relayed tests run in the real verify jail; nothing reaches a CLI,
// a provider or the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = 'pantheon/tests/';
// Not review-runner-subscription.test.mjs: its grok and agy jails mount an empty /tmp, which hides a copy made under it,
// and one of its tests reads a recorded `findings-runs-*` file, which the copy leaves out (seen at 777d32d: 5 of 82
// failed in the unmutated copy). Every relay rule is decided by the suites below.
const SUITES = [`${T}review-runner-relay.test.mjs`, `${T}review-runner-cli-units.test.mjs`, `${T}review-pr.test.mjs`];
const R = 'pantheon/src/review-runner/', RELAY = `${R}relay.mjs`, COV = `${R}coverage.mjs`, SUB = `${R}subscription.mjs`, PR = `${R}pr-review.mjs`;
const one = (file, from, to) => ({file, from, to});
const t = (file, pattern) => [`${T}${file}.test.mjs`, pattern];

export const MUTATIONS = [
  // ---- the decision, and the limits ---------------------------------------------------------------------------------
  {id: 'T1', what: 'a request runs without the hook\'s decision', tests: [t('review-runner-relay', '^RELAY: each request is decided'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(RELAY, '    if (d.decision !== "auto_approve") { out.push(', '    if (false) { out.push(')]},
  {id: 'T2', what: 'a repeated request id runs again', tests: [t('review-runner-relay', '^RELAY: the limits')],
    edits: [one(RELAY, '    if (budget.used.has(q.id)) { out.push(', '    if (false) { out.push(')]},
  {id: 'T3', what: 'the relayed-test budget is not enforced', tests: [t('review-runner-relay', '^RELAY: the limits')],
    edits: [one(RELAY, '    if (budget.tests <= 0) { out.push(', '    if (false) { out.push(')]},
  {id: 'T4', what: 'the wall clock does not stop a relayed test', tests: [t('review-runner-relay', '^RELAY: the limits')],
    edits: [one(RELAY, '    if (left <= 1000) { out.push(', '    if (false) { out.push(')]},
  {id: 'T5', what: 'one more round than the limit', tests: [t('review-runner-relay', '^RELAY: at most MAX_RELAY_ROUNDS rounds')],
    edits: [one(RELAY, '  for (let round = 1; round <= maxRounds && cur.status === "complete"; round++) {', '  for (let round = 1; round <= maxRounds + 1 && cur.status === "complete"; round++) {')]},
  // ---- what counts as a test run, and the reviewer's judgment ------------------------------------------------------
  {id: 'T6', what: 'the verify jail refusing to start counts as a test run', tests: [t('review-runner-relay', '^RELAY: the results go back verbatim')],
    edits: [one(RELAY, 'r.result.exit_code !== VERIFY_JAIL_REFUSED && !r.result.killed_for', '!r.result.killed_for')]},
  {id: 'T7', what: 'a test killed at the wall clock counts as a test run', tests: [t('review-runner-relay', '^RELAY: the results go back verbatim')],
    edits: [one(RELAY, 'r.result.exit_code !== VERIFY_JAIL_REFUSED && !r.result.killed_for', 'r.result.exit_code !== VERIFY_JAIL_REFUSED')]},
  {id: 'T8', what: 'the reviewer\'s conclusion is not what it wrote', tests: [t('review-runner-relay', '^RELAY: the loop returns results'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(RELAY, '  for (const r of records) if (r.decision === "run") r.reviewer_conclusion = conclusions.get(r.id) ?? null;', '  for (const r of records) if (r.decision === "run") r.reviewer_conclusion = "concluded";')]},
  {id: 'T9', what: 'a relayed test the reviewer did not judge passes the gate', tests: [t('review-runner-relay', '^RELAY: the loop returns results'), t('review-runner-relay', '^RELAY through run-review: a failing relayed test')],
    edits: [one(COV, '  if (cov.relay?.unconcluded?.length) reasons.push(', '  if (false) reasons.push(')]},
  {id: 'T10', what: 'relayed tests are not counted as tests run', tests: [t('review-runner-relay', '^RELAY: the loop returns results'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(COV, '    reads, denied, tests: relayed.length, tests_allowed, tests_refused,', '    reads, denied, tests: 0, tests_allowed, tests_refused,')]},
  {id: 'T11', what: 'a conclusion swallows the unindented lines after it', tests: [t('review-runner-relay', '^RELAY: conclusions are read')],
    edits: [one(RELAY, '    if (cur && l.trim() && /^\\s/.test(l)) out.set(', '    if (cur && l.trim()) out.set(')]},
  // ---- the results, and the record --------------------------------------------------------------------------------
  {id: 'T12', what: 'the results go to a new thread, not the reviewer\'s own', tests: [t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(SUB, 'nextTurn: (msg, { wallS }) => turn(msg, wallS, threadId)', 'nextTurn: (msg, { wallS }) => turn(msg, wallS, null)')]},
  {id: 'T13', what: 'the exit code is not sent back to the reviewer', tests: [t('review-runner-relay', '^RELAY: the results go back verbatim'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(RELAY, '`exit ${x.exit_code} after ${x.duration_ms} ms`', '`ran for ${x.duration_ms} ms`')]},
  {id: 'T14', what: 'who requested a test is not recorded', tests: [t('review-runner-relay', '^RELAY: each request is decided'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(RELAY, 'requested_by: { ...requestedBy, turn }, commit };', 'requested_by: null, commit };')]},
  {id: 'T15', what: 'which runner executed a test is not recorded', tests: [t('review-runner-relay', '^RELAY: each request is decided'), t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(RELAY, '      executed_by: { runner: EXECUTED_BY, launcher:', '      executed_by: { runner: null, launcher:')]},
  // ---- the relay offered to codex, and its record in the action's result --------------------------------------------
  {id: 'T16', what: 'codex is not offered the relay', tests: [t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(SUB, '    if (relayed) cmds.lines = relayLines({ lines: cmds.lines, commit: opts.commit });', '    if (false) cmds.lines = relayLines({ lines: cmds.lines, commit: opts.commit });')]},
  {id: 'T17', what: 'the review\'s launchers are not written for codex', tests: [t('review-runner-relay', '^RELAY through run-review: codex requests a test')],
    edits: [one(SUB, '    if ((transport === "grok-cli" || relayed) && !opts.dryRun) {', '    if (transport === "grok-cli" && !opts.dryRun) {')]},
  {id: 'T18', what: 'the action\'s result drops the relay record', tests: [t('review-pr', '^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '    relayed_tests: t?.test_relay ? relaySummary(t.test_relay) : null,', '    relayed_tests: null,')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const WITHHELD = f => f.split('/').some(s => s.startsWith('findings-'));
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD(f)) continue;
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `review-relay-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'review-relay-mutate-'));
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
