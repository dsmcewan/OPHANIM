// L-121 (self-audit round 3, assignment 3 (sealed bb1287a), the follow-up of L-305): `cli.mjs tick`, `watch` and `serve`
// did not pass `interrupt` to the scheduler. A SIGTERM killed `tick` outright and only stopped the LOOP of `watch` and
// `serve` between ticks: the stage in flight ran on, and a killed process left its claim held for the whole lease.
// They now stop the stage in flight cooperatively and release its claim `interrupted` (as live-run does since 72303b2);
// a stage that does not stop is released by the launcher's hard stop after its grace. The lease fence is unchanged.
//
// REAL OS PROCESSES receiving REAL signals, at the production entry (cli.mjs main: the verbs' own handlers), with the
// real scheduler, work ledger and stage executors (serve: ophanim/operate/stages.mjs, its planner seat a module that
// waits for the stage's signal; tick/watch: a stages module whose plan executor does). Nothing calls a provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {SERVICE_CONFIG_SCHEMA} from './service.mjs';

const HERE = import.meta.dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); } };

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-stop-'));
  const S = openStatusLedger({root: path.join(repo, 'status', 'ledger')});
  S.set({checked: '2026-11-19', basis: 'the requirement of alpha', item: 'alpha', title: 'alpha', state: 'Ready'});
  fs.mkdirSync(path.join(repo, 'tickets'));
  openWorkLedger({root: path.join(repo, 'status', 'work')});   // the controller key, as `--init` makes it
  const entered = path.join(repo, 'entered');
  // A stages module: the plan executor charges one call, says it is in flight, and waits for its signal (cooperative),
  // or ignores it (deaf). Its result after the stop is not a handoff either way.
  fs.writeFileSync(path.join(repo, 'stages.mjs'), `import fs from 'node:fs';
export const makeExecutors = () => ({plan: async ctx => {
  ctx.charge(1);
  fs.writeFileSync(${JSON.stringify(entered)}, ctx.claim);
  if (process.env.STOP_MODE === 'deaf') await new Promise(() => {});
  if (process.env.STOP_MODE === 'quick') return {status: 'blocked', outputs: {}, blocker: {code: 'FIXTURE_HELD', what: 'FIXTURE_HELD: the fixture holds the item', role: 'lead@orch', resume_when: 'never'}, next: {stage: 'plan', why: 'held'}};
  await new Promise(r => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', r, {once: true}); });
  return {status: 'returned', outputs: {stopped: ctx.signal.reason?.code ?? null}, next: {stage: 'plan', why: 'stopped'}};
}});
`);
  // The service's seats: a planner that waits for the stage's signal (what a live adapter does with an in-flight request).
  fs.writeFileSync(path.join(repo, 'turn.mjs'), `import fs from 'node:fs';
export default async args => {
  fs.writeFileSync(${JSON.stringify(entered)}, 'turn');
  if (process.env.STOP_MODE === 'deaf') await new Promise(() => {});
  await new Promise((_, reject) => { const s = args.signal; if (s.aborted) reject(s.reason); s.addEventListener('abort', () => reject(s.reason), {once: true}); });
};
`);
  fs.writeFileSync(path.join(repo, 'clients.mjs'), 'export default () => { throw new Error("no client in this fixture"); };\n');
  fs.writeFileSync(path.join(repo, 'operate.json'), JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', issues: {source: 'none'}, interval_s: 3600,
    seats: {turn: 'turn.mjs', clients: 'clients.mjs'}, limits: {total_provider_calls: 100, stage_provider_calls: 5, lease_ms: 3_600_000}}));
  // The child: cli.mjs main, in its own process, with the process's own signal handling.
  fs.writeFileSync(path.join(repo, 'child.mjs'), `import {main} from ${JSON.stringify(pathToFileURL(path.join(HERE, 'cli.mjs')).href)};
const inflight = setInterval(() => {}, 1000);
try {
  process.exitCode = await main(process.argv.slice(2), {log: s => process.stdout.write(s + '\\n'), err: s => process.stderr.write(s + '\\n'),
    ...(process.env.STAGES ? {stagesFile: process.env.STAGES} : {}), graceMs: Number(process.env.GRACE_MS ?? 10000)});
} finally { clearInterval(inflight); }
`);
  // The stage executors read the checkout as a git repository.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'status/\nentered\n');
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']]) execFileSync('git', ['-C', repo, ...a]);
  return {repo, entered, workRoot: path.join(repo, 'status', 'work'), done: () => fs.rmSync(repo, {recursive: true, force: true})};
}

function launch(f, argv, env = {}) {
  const c = spawn(process.execPath, [path.join(f.repo, 'child.mjs'), ...argv], {cwd: f.repo, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  const closed = new Promise(r => c.on('close', (code, signal) => r({code, signal, out, err})));
  return {c, closed};
}
const at = f => ['--repo', f.repo, '--status-ledger', path.join(f.repo, 'status', 'ledger'), '--work-ledger', f.workRoot];
/** The process's exit within `ms`, or {timedOut: true} (and it is killed). */
const exitWithin = async (run, ms) => { const r = await Promise.race([run.closed, sleep(ms).then(() => null)]); if (r) return r; run.c.kill('SIGKILL'); return {timedOut: true, ...(await run.closed)}; };

/** SIGTERM the verb's process while its plan stage is in flight; report how it ended and what the work ledger holds. */
async function stopInFlight(f, argv, env = {}, {wait = 8000} = {}) {
  const run = launch(f, argv, env);
  try { await until(() => fs.existsSync(f.entered) || run.c.exitCode !== null, 30_000, 'the stage in flight'); }
  catch (e) { run.c.kill('SIGKILL'); const r = await run.closed; throw new Error(`${e.message}: ${r.out.slice(-800)} ${r.err.slice(-1500)}`); }
  if (!fs.existsSync(f.entered)) { const r = await run.closed; throw new Error(`the process ended before its stage was in flight (${r.code}): ${r.out.slice(-800)} ${r.err.slice(-1500)}`); }
  run.c.kill('SIGTERM');
  const ended = await exitWithin(run, wait);
  const w = openWorkLedger({root: f.workRoot, create: false});
  const claims = w.claims('alpha');
  return {ended, claims, released: claims.map(c => w.released(c.hash)?.outcome ?? null), stages: w.stages('alpha'), w};
}

test('L-121 (self-audit round 3, assignment 3 (sealed bb1287a)): `cli.mjs tick` on SIGTERM stops the stage in flight, releases its claim `interrupted` with no stage record, and the next start dispatches at once', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    const r = await stopInFlight(f, ['tick', '--total-provider-calls', '100', '--stage-provider-calls', '5', '--lease-ms', '3600000', ...at(f)], {STAGES: path.join(f.repo, 'stages.mjs')});
    assert.equal(r.ended.timedOut, undefined, `the process did not exit: ${r.ended.err}`);
    assert.deepEqual([r.ended.code, r.ended.signal], [0, null], `it returned normally, not killed by the signal: ${r.ended.err.slice(-600)}`);
    assert.deepEqual(r.released, ['interrupted'], 'the claim is released as interrupted, not held for its hour-long lease');
    assert.deepEqual(r.stages, [], 'no stage record: the stopped result is not a handoff');
    assert.match(r.w.released(r.claims[0].hash).why, /^INTERRUPTED: SIGTERM received/);
    assert.equal(JSON.parse(r.ended.out).spent.charged, 1, 'the call charged before the stop stays counted');
    // The next start dispatches the plan at once (its lease had an hour left).
    fs.rmSync(f.entered);
    const again = await stopInFlight(f, ['tick', '--total-provider-calls', '100', '--stage-provider-calls', '5', '--lease-ms', '3600000', ...at(f)], {STAGES: path.join(f.repo, 'stages.mjs')});
    assert.equal(again.claims.length, 2, 'a second claim was taken at once');
  } finally { f.done(); }
});

test('L-121: `cli.mjs watch` on SIGTERM stops the stage in flight (not only the loop) and releases its claim', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    const r = await stopInFlight(f, ['watch', '--interval', '3600', '--total-provider-calls', '100', '--stage-provider-calls', '5', '--lease-ms', '3600000', ...at(f)], {STAGES: path.join(f.repo, 'stages.mjs')});
    assert.equal(r.ended.timedOut, undefined, 'the watch did not exit: the stage in flight ran on after SIGTERM');
    assert.deepEqual([r.ended.code, r.ended.signal], [0, null], r.ended.err.slice(-600));
    assert.deepEqual(r.released, ['interrupted']);
    assert.deepEqual(r.stages, []);
    assert.equal(JSON.parse(r.ended.out).ticks.length, 1);
  } finally { f.done(); }
});

test('L-121: `cli.mjs serve` on SIGTERM stops the stage in flight through the real stage executors and the seat\'s signal, releases its claim, and records itself stopped', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    const r = await stopInFlight(f, ['serve', '--config', path.join(f.repo, 'operate.json')]);
    assert.equal(r.ended.timedOut, undefined, 'the service did not exit: the stage in flight ran on after SIGTERM');
    assert.deepEqual([r.ended.code, r.ended.signal], [0, null], r.ended.err.slice(-600));
    assert.deepEqual(r.released, ['interrupted']);
    assert.deepEqual(r.stages, []);
    const status = JSON.parse(fs.readFileSync(path.join(f.repo, 'status', 'operate', 'service', 'service-status.json'), 'utf8'));
    assert.equal(status.state, 'stopped');
    assert.equal(fs.existsSync(path.join(f.workRoot, 'service.lock')), false, 'the single-instance lock is released');
  } finally { f.done(); }
});

test('L-121: a stage that ignores the stop is released by the hard stop after the grace (or a second signal), and the process exits 128 + 15', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    const r = await stopInFlight(f, ['tick', '--total-provider-calls', '100', '--stage-provider-calls', '5', '--lease-ms', '3600000', ...at(f)], {STAGES: path.join(f.repo, 'stages.mjs'), STOP_MODE: 'deaf', GRACE_MS: '1500'});
    assert.equal(r.ended.timedOut, undefined, 'the hard stop did not end the process');
    assert.deepEqual([r.ended.code, r.ended.signal], [143, null], r.ended.err.slice(-600));
    assert.deepEqual(r.released, ['interrupted']);
    assert.match(r.w.released(r.claims[0].hash).why, /did not stop within 1500 ms .*released by the launcher on exit/);
    // The lease fence: the released claim can record and charge nothing.
    assert.throws(() => r.w.recordSpend({claim: r.claims[0].hash, provider_calls: 2}), e => e.code === 'LEASE_FENCED');
  } finally { f.done(); }
});

test('L-121: `cli.mjs watch` stopped while it waits between ticks ends at once; it does not sleep out its interval first', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    // The plan stage returns at once (STOP_MODE quick), so the watch is waiting for its next poll, an hour away.
    const run = launch(f, ['watch', '--interval', '3600', '--total-provider-calls', '100', '--stage-provider-calls', '5', ...at(f)], {STAGES: path.join(f.repo, 'stages.mjs'), STOP_MODE: 'quick'});
    try {
      await until(() => { try { const w = openWorkLedger({root: f.workRoot, create: false}); return w.stages('alpha').length === 1; } catch { return false; } }, 30_000, 'the first tick\'s stage record');
    } catch (e) { run.c.kill('SIGKILL'); throw e; }
    await sleep(500);   // the tick returns and the watch starts its wait
    run.c.kill('SIGTERM');
    const ended = await exitWithin(run, 8000);
    assert.equal(ended.timedOut, undefined, 'the watch slept on after SIGTERM');
    assert.deepEqual([ended.code, ended.signal], [0, null], ended.err.slice(-600));
    assert.equal(JSON.parse(ended.out).ticks.length, 1);
  } finally { f.done(); }
});

test('L-121: `cli.mjs serve` whose stage ignores the stop: the hard stop releases the claim the service took, and exits 128 + 15', {timeout: 90_000}, async () => {
  const f = setup();
  try {
    const r = await stopInFlight(f, ['serve', '--config', path.join(f.repo, 'operate.json')], {STOP_MODE: 'deaf', GRACE_MS: '1500'});
    assert.equal(r.ended.timedOut, undefined, 'the hard stop did not end the service');
    assert.deepEqual([r.ended.code, r.ended.signal], [143, null], r.ended.err.slice(-600));
    assert.deepEqual(r.released, ['interrupted'], 'the claim the service took is released, not held for its lease');
    assert.deepEqual(r.stages, []);
  } finally { f.done(); }
});
