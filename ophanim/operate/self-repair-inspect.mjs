// THE INSPECTOR: the self-repair lane's recursive loop, as a background process (started by self-repair.mjs inspectIdle).
//
//   node ophanim/operate/self-repair-inspect.mjs --plan <inspection/plan.json>
//
// On a clean checkout of the plan's commit (the line head), beside the foundry's tickets and at a lower CPU priority:
//   1. a WHOLE gate run (scripts/test-gates/check.mjs run --json), recorded as a gate record;
//   2. a stress run of the test files changed since the last inspected commit, recorded as a stress record (skipped on
//      the first inspection, or when no test file changed);
//   3. the pentest (scripts/pentest/run.mjs), its report recorded as a pentest record.
// Each record names the plan's commit and goes into the lane's records directory, so the next round's Detect reads
// it. The checkout is fresh at that commit and checked clean BEFORE anything runs, so the commit a record names is the
// code the run tested by construction; files a test leaves behind are outputs, not changes to that code.
// It runs the outer wheels and edits none of them. What a step produced is recorded as before; whether it is a finished
// report of its kind (reportRefusal) decides only whether the attempt was complete. Nothing is invented. At the end it writes inspection/last.json
// (the attempt: which steps ran, their exits and records, and whether it was COMPLETE by that evidence --
// inspectionCompleteness), copies it to complete.json when it was, and removes inspection/running.json. An incomplete
// attempt is retried by the lane when due; the stress run's comparison base stays the last complete commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkoutAt, spawnRun, writeRecord, writeJsonAtomic, inspectionDirOf, inspectionCompleteness, reportRefusal, INSPECTION_SCHEMA} from './self-repair.mjs';

const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const NICE = ['/usr/bin/nice', '/bin/nice'].find(p => fs.existsSync(p)) ?? null;
const cut = (s, n = 300) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

/** The test files a commit range changed (existing at `commit`, withheld paths never named). */
export function changedTests(dir, since, commit) {
  let out = '';
  try { out = git(dir, ['diff', '--name-only', `${since}..${commit}`]); } catch { return []; }
  return out.split('\n').filter(f => /\.test\.mjs$/.test(f) && !WITHHELD.test(f) && fs.existsSync(path.join(dir, f))).sort();
}
/** A command template with {json}, {rounds} and {files} (one argument per file) filled in. */
export const fill = (tpl, vars) => tpl.flatMap(a => (a === '{files}' ? vars.files ?? [] : [String(a).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))]));

export async function runInspection(plan, {log = s => console.log(s)} = {}) {
  const started_at = new Date().toISOString(), steps = [], insp = plan.inspect;
  const attempt = Number.isInteger(plan.attempt) && plan.attempt > 0 ? plan.attempt : 1;
  const token = typeof plan.token === 'string' ? plan.token : null;
  const dir = inspectionDirOf(plan.state);
  // The second running.json writer: the same attempt token as the lane's, with this process's own pid.
  writeJsonAtomic(path.join(dir, 'running.json'), {schema: INSPECTION_SCHEMA, commit: plan.commit, pid: process.pid, ...(token ? {token} : {}), started_at, since: plan.since, attempt});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-repair-inspect-'));
  let co = null;
  const run = args => { const cmd = NICE && Number.isInteger(insp.nice) ? [NICE, '-n', String(insp.nice), ...args] : args; return spawnRun(cmd[0], cmd.slice(1), {cwd: co.dir, env: process.env, timeout: insp.timeout_ms ?? 90 * 60_000}); };
  const record = (name, kind, body, r) => {
    const file = writeRecord({dir: plan.records, kind, commit: plan.commit, record: body});
    steps.push({name, exit: r.exit, ms: r.ms, killed: r.killed ?? null, record: path.relative(plan.records, file)});
    const bad = reportRefusal(kind, body, r.exit);
    log(`inspect: ${name} exit ${r.exit} -> ${kind} record${bad ? ` (not complete: ${bad})` : ''}`);
  };
  const report = (name, kind, file, r, what) => {
    if (!fs.existsSync(file)) { steps.push({name, exit: r.exit, ms: r.ms, killed: r.killed ?? null, error: `no ${what} record was written: ${cut(r.stderr || r.stdout, 300)}`}); return; }
    let body;
    try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { steps.push({name, exit: r.exit, ms: r.ms, killed: r.killed ?? null, error: `the ${what} record is not JSON: ${cut(e.message, 200)}`}); return; }
    record(name, kind, body, r);
  };
  try {
    co = checkoutAt(plan.repo, plan.commit);
    const dirty = git(co.dir, ['status', '--porcelain']).split('\n').filter(Boolean);
    if (dirty.length) throw new Error(`the checkout of ${plan.commit.slice(0, 12)} is not clean (${dirty.length} path(s)): nothing is recorded`);
    // 1. The whole gate run.
    const gj = path.join(tmp, 'gate.json');
    const g = await run(fill(insp.gates, {json: gj}));
    report('gates', 'gate', gj, g, 'gate');
    // 2. Stress: the test files changed since the last inspected commit.
    const files = plan.since ? changedTests(co.dir, plan.since, plan.commit) : [];
    if (files.length) {
      const sj = path.join(tmp, 'stress.json');
      const s = await run(fill(insp.stress, {files, rounds: insp.rounds ?? 5, json: sj}));
      report('stress', 'stress', sj, s, 'stress');
    } else steps.push({name: 'stress', skipped: plan.since ? `no test file changed since ${plan.since.slice(0, 12)}` : 'the first inspection: no earlier inspected commit to compare with'});
    // 3. The pentest: its report is the record (as `self-repair record --kind pentest` takes it).
    const p = await run(fill(insp.pentest, {}));
    record('pentest', 'pentest', {report: p.stdout}, p);
  } catch (e) {
    steps.push({name: 'inspection', error: cut(e.message, 400)});
    log(`inspect: stopped: ${e.message}`);
  } finally {
    try { co?.done(); } catch {}
    fs.rmSync(tmp, {recursive: true, force: true});
    const body = {schema: INSPECTION_SCHEMA, commit: plan.commit, since: plan.since, attempt, ...(token ? {token} : {}), started_at, finished_at: new Date().toISOString(), steps};
    const c = inspectionCompleteness(body, plan.records);
    body.complete = c.complete; body.incomplete = c.why;
    writeJsonAtomic(path.join(dir, 'last.json'), body);
    if (c.complete) writeJsonAtomic(path.join(dir, 'complete.json'), body);
    log(`inspect: attempt ${attempt} of ${String(plan.commit).slice(0, 12)} ${c.complete ? 'COMPLETE' : `INCOMPLETE (${c.why.join('; ')})`}`);
    fs.rmSync(path.join(dir, 'running.json'), {force: true});
  }
  return steps;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--plan');
  if (i < 0 || !process.argv[i + 1]) { console.error('usage: self-repair-inspect.mjs --plan <plan.json>'); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  if (plan?.schema !== INSPECTION_SCHEMA) { console.error(`not an ${INSPECTION_SCHEMA} plan`); process.exit(2); }
  // The token on the argv is the identity witness the lane reads; it must be the plan's own.
  const t = process.argv.indexOf('--token');
  if (t >= 0 && process.argv[t + 1] !== plan.token) { console.error('the --token does not match the plan\'s attempt token'); process.exit(2); }
  runInspection(plan).then(() => { process.exitCode = 0; }, e => { console.error(`inspect: ${e.message}`); process.exitCode = 1; });
}
