// Self-audit round 3, assignment 3 (sealed bb1287a): execution reliability, the controller side. Register ids L-302 (a
// zero-call exception is charged its actual spend), L-305 (an interrupted live run releases its claim; a killed one is
// named with its expiry), L-307 (run.json is not accepted before the fresh verification) and L-308 (budget stops are
// classified by code).
//
// Production entry points: tick (scheduler.mjs) over the real work ledger, and the live-run launcher (live-run.mjs main)
// run as a REAL CHILD PROCESS that receives a REAL signal (SIGTERM, SIGKILL), with the fixture's fake agy CLI in the
// real bwrap jail and scripted single-turn seats. Every credential is SYNTHETIC.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick, spent, releaseInterrupted, STOP_CODES} from './scheduler.mjs';
import {main, budgetStops, LIVE_RUN_SCHEMA} from './live-run.mjs';
import {sandboxAvailable} from '../../pantheon/src/agy/sandbox.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture as gitFixture, scriptedTurn, git} from './test-fixtures.mjs';

const HERE = import.meta.dirname, ROOT = path.resolve(HERE, '../..');
const box = await sandboxAvailable('bwrap');
const real = {timeout: 300_000};
// An in-process test whose stop never arrives fails within this bound instead of waiting out a stage's hour.
const quick = {timeout: 30_000};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ledgerFixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r3a3-op-'));
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i}`, item: i, title: i, state: 'Ready'});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
const untilAborted = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once: true}); });

test('the bwrap jail is available on this host (the live-run tests run the real boundary, they are never skipped)', () => {
  assert.equal(box.ok, true, `bwrap: ${box.why}`);
});

// ---- L-302 -------------------------------------------------------------------------------------------------------
test('L-302 (self-audit round 3, assignment 3 (sealed bb1287a)): an exception is charged what it spent (0, or 2), not the whole stage budget; unknown only when the executor says so', quick, async () => {
  const f = ledgerFixture(['alpha', 'beta', 'gamma']);
  try {
    const limits = {total_provider_calls: 15, stage_provider_calls: 10, stage_attempts: 3};
    const throwsAfter = n => async ctx => { for (let i = 0; i < n; i++) ctx.charge(1); throw new Error(`a git read failed after ${n} provider call(s)`); };
    const t1 = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: throwsAfter(0)}, limits, only: 'alpha'});
    assert.deepEqual([t1.dispatched.length, t1.dispatched[0].provider_calls, t1.spent.calls, t1.spent.unknown_counted_at_budget], [1, 0, 0, 0], 'nothing was spent, nothing is counted');
    // The retry is dispatched: the total is not consumed by a call that was never made.
    let ran = 0;
    const t2 = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: async ctx => { ran++; return throwsAfter(2)(ctx); }}, limits, only: 'alpha'});
    assert.equal(ran, 1, 'the retry ran');
    assert.equal(t2.stopped, null);
    assert.deepEqual([t2.dispatched[0].provider_calls, t2.spent.calls], [2, 2], 'the 2 charged calls are its usage');
    const rec = openWorkLedger({root: f.workRoot, create: false}).stages('alpha').at(-1);
    assert.equal(rec.usage.basis, 'charged on the work ledger before each call');
    // An executor that made calls outside the charge says so: unknown, counted at the whole budget (conservative).
    const t3 = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: async () => { throw Object.assign(new Error('calls outside the meter'), {provider_calls_unknown: true}); }}, limits, only: 'beta'});
    assert.equal(t3.dispatched[0].provider_calls, null);
    assert.equal(spent(openWorkLedger({root: f.workRoot, create: false})).calls, 12, '2 charged for alpha + the whole budget of 10 for the unknown beta');
  } finally { f.done(); }
});

// ---- L-305: tick, in process -----------------------------------------------------------------------------------------
test('L-305 (self-audit round 3, assignment 3 (sealed bb1287a)): an interrupt stops the stage in flight, releases its claim as interrupted with no stage record, and the next tick dispatches it at once', quick, async () => {
  const f = ledgerFixture(['alpha']);
  try {
    const limits = {total_provider_calls: 100, stage_provider_calls: 10, lease_ms: 3_600_000};
    const ac = new AbortController();
    const seen = [];
    const plan = async ctx => {
      ctx.charge(1);
      setTimeout(() => ac.abort(new Error('SIGTERM received: the launcher was stopped')), 50);
      await untilAborted(ctx.signal);
      seen.push(ctx.signal.reason.code);
      return {status: 'returned', outputs: {kept: true}, next: {stage: 'plan', why: 'stopped'}};
    };
    const t = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits, interrupt: ac.signal, progress: e => seen.push(e.event)});
    assert.deepEqual(seen, ['dispatch', 'INTERRUPTED', 'interrupted']);
    assert.equal(t.stop.code, STOP_CODES.INTERRUPTED);
    assert.deepEqual(t.interrupted.map(x => [x.item, x.stage, x.charged, x.released]), [['alpha', 'plan', 1, true]]);
    assert.deepEqual(t.dispatched, [], 'no stage record');
    const w = openWorkLedger({root: f.workRoot, create: false});
    assert.deepEqual(w.stages('alpha'), []);
    const rel = w.released(t.interrupted[0].claim);
    assert.equal(rel.outcome, 'interrupted');
    assert.match(rel.why, /^INTERRUPTED: SIGTERM received/);
    assert.equal(spent(w).charged, 1, 'the charge made under it stays counted');
    // The lease (an hour) has not passed; the next tick dispatches the plan at once.
    let again = 0;
    const t2 = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: async () => { again++; return {status: 'returned', outputs: {}, next: {stage: 'plan', why: 'fixture'}}; }}, limits: {...limits, stage_attempts: 1}});
    assert.deepEqual([again, t2.dispatched.map(d => d.stage)], [1, ['plan']]);
  } finally { f.done(); }
});

test('L-305: the fence holds after an interrupt release: an executor that ignores the stop can neither charge nor hand on its result', quick, async () => {
  const f = ledgerFixture(['alpha']);
  try {
    const ac = new AbortController();
    let refused = null;
    const plan = async ctx => {
      ac.abort(new Error('SIGTERM received'));
      // The launcher's grace ends and it releases the claim itself (main's hard stop); the executor runs on.
      releaseInterrupted(ctx.work, {claim: ctx.claim, item: ctx.item, stage: 'plan', why: 'released by the launcher on exit'});
      try { ctx.charge(1); } catch (e) { refused = e.code; }
      return {status: 'returned', outputs: {late: true}, next: {stage: 'plan', why: 'late'}};
    };
    const t = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits: {total_provider_calls: 100, stage_provider_calls: 10}, interrupt: ac.signal});
    assert.equal(refused, 'STAGE_ELAPSED', 'the stopped stage admits no charge (its signal is aborted)');
    const w = openWorkLedger({root: f.workRoot, create: false});
    assert.throws(() => w.recordSpend({claim: t.interrupted[0].claim, provider_calls: 1}), e => e.code === 'LEASE_FENCED');
    assert.deepEqual([w.stages('alpha').length, t.interrupted[0].released, w.released(t.interrupted[0].claim).why], [0, false, 'INTERRUPTED: released by the launcher on exit']);
  } finally { f.done(); }
});

// ---- L-308 ----------------------------------------------------------------------------------------------------------
test('L-308 (self-audit round 3, assignment 3 (sealed bb1287a)): budget stops are classified by code: an elapsed stop is not a provider budget stop, a stage charged its whole budget is one whatever its words, and a reason that merely says "budget" is none', quick, async () => {
  const f = ledgerFixture(['alpha', 'beta', 'gamma']);
  try {
    const base = {repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot};
    // alpha: the validator-like stage that ran out of its 3 calls, its reason naming no budget.
    const a = await tick({...base, executors: {plan: async ctx => { for (let i = 0; i < 3; i++) ctx.charge(1); return {status: 'returned', outputs: {cause: 'validation-defect'}, next: {stage: 'plan', why: 'no well-formed validator judgment'}}; }},
      limits: {total_provider_calls: 100, stage_provider_calls: 3, stage_attempts: 1}, only: 'alpha'});
    // beta: stopped at its elapsed budget (its own reason happens to say "provider-call budget").
    const b = await tick({...base, executors: {plan: async ctx => { await untilAborted(ctx.signal); return {status: 'returned', outputs: {}, next: {stage: 'plan', why: 'the plan names a provider-call budget of 5'}}; }},
      limits: {total_provider_calls: 100, stage_provider_calls: 3, stage_attempts: 1, elapsed_ms: 300}, only: 'beta'});
    // gamma: a reason with the word, no stop of any kind.
    const g = await tick({...base, executors: {plan: async ctx => { ctx.charge(1); return {status: 'returned', outputs: {}, next: {stage: 'plan', why: 'the plan exceeds the reviewer budget guidance'}}; }},
      limits: {total_provider_calls: 100, stage_provider_calls: 3, stage_attempts: 1}, only: 'gamma'});
    const w = openWorkLedger({root: f.workRoot, create: false});
    const stops = budgetStops([a, b, g], w.stages(), []);
    const of = item => stops.filter(s => s.source === 'stage' && w.stages(item).some(x => x.hash === s.record)).map(s => [s.kind, s.code]);
    assert.deepEqual(of('alpha'), [['provider_calls', 'STAGE_PROVIDER_CALLS']]);
    assert.deepEqual(of('beta'), [['elapsed', 'STAGE_ELAPSED']]);
    assert.deepEqual(of('gamma'), []);
    assert.deepEqual(stops.filter(s => s.source === 'tick').map(s => [s.tick, s.kind, s.code]), [[1, 'elapsed', 'STAGE_ELAPSED']]);
    assert.deepEqual(w.stages('alpha')[0].usage.budget_exhausted, {code: 'STAGE_PROVIDER_CALLS', charged: 3, budget: 3, refused_charges: 0});
  } finally { f.done(); }
});

// ---- the live-run launcher, as a real child process -------------------------------------------------------------------
const USAGE_REPORT = JSON.stringify({conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, usage: {total_tokens: 0}, command: {name: 'usage', data: {groups: [
  {name: 'Gemini Models', description: 'Models within this group: Gemini 4 Hydrogen, Gemini 4 Carbon, Gemini 3.8 Flash', buckets: [{id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7}]},
  {name: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5', buckets: [{id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1}]}]}}});
const LIMITS = {total_provider_calls: 400, stage_provider_calls: 40, revisions: 2, stage_attempts: 2, elapsed_ms: 600_000,
  pipeline: {max_provider_calls: 40, max_revisions: 2, max_concurrent_units: 2, verify_timeout_ms: 60_000}};
const SYNTHETIC_ENV = {ANTHROPIC_API_KEY: 'sk-ant-SYNTHETIC-r3a3', OPENAI_API_KEY: 'sk-SYNTHETIC-r3a3', XAI_API_KEY: 'xai-SYNTHETIC-r3a3'};
// The child: the launcher's main() with scripted seats; `mode` decides the planner: hang until stopped (cooperative),
// hang and ignore the stop (deaf), or answer (pass). Its exit code is the launcher's (or 128 + signal from the hard stop).
const CHILD = mods => `import {main} from ${JSON.stringify(mods.liveRun)};
import {scriptedTurn} from ${JSON.stringify(mods.fixtures)};
import {scriptedClients, installScriptedGemini} from ${JSON.stringify(mods.dispatch)};
// The Google implementer's provider, scripted in THIS process (the launcher's preflight and its sessions ask it).
installScriptedGemini();
const [manifest, confirm, repo, mode] = process.argv.slice(2);
const base = scriptedTurn();
const turn = async args => {
  if (args.prompt.startsWith('You are the planner') && mode !== 'pass') {
    if (mode === 'cooperative') await new Promise((_, reject) => { const s = args.signal; if (s.aborted) reject(s.reason); s.addEventListener('abort', () => reject(s.reason), {once: true}); });
    else await new Promise(() => {});
  }
  return base(args);
};
// An in-flight provider request holds the event loop open; the scripted seat holds it the same way while it runs.
const inflight = setInterval(() => {}, 1000);
try {
  process.exitCode = await main(['--manifest', manifest, '--confirm-spend', confirm, '--repo', repo],
    {log: s => process.stdout.write(s + '\\n'), err: s => process.stderr.write(s + '\\n'), seats: {turn, makeClientFor: scriptedClients()}, graceMs: 1500});
} finally { clearInterval(inflight); }
`;

async function withLauncher(fn) {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = gitFixture(repo, ['one', 'two'].map(item => ({item})));
    ctx.agyWorker('printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n');
    fs.writeFileSync(path.join(repo, 'quota-report.txt'), USAGE_REPORT);
    fs.writeFileSync(path.join(repo, 'quota-exit'), '0');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3a3-home-')));
    const g = path.join(home, '.gemini'), c = path.join(g, 'antigravity-cli');
    fs.mkdirSync(path.join(c, 'log'), {recursive: true}); fs.mkdirSync(path.join(g, 'config', 'projects'), {recursive: true});
    fs.writeFileSync(path.join(c, 'antigravity-oauth-token'), 'SYNTHETIC-oauth-token'); fs.writeFileSync(path.join(g, 'config', 'projects', 'default-cli-project.json'), '{}');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3a3-out-')));
    const before = process.env.HOME; process.env.HOME = home;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const manifest = {schema: LIVE_RUN_SCHEMA, item: 'two', candidate_commit: head, profile: 'fit', independence: 'model', limits: structuredClone(LIMITS),
      billing: {scope: 'fixture: scripted providers and the fake agy only', gemini_api_implementer: true, metered_gemini_failover: false, note: ''}, ledgers: {status_root: f.statusRoot, work_root: path.join(outside, 'run', 'work')},
      credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'required'}, out_dir: path.join(outside, 'run')};
    const file = path.join(outside, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const childFile = path.join(outside, 'launcher-child.mjs');
    const url = p => pathToFileURL(path.join(ROOT, p)).href;
    fs.writeFileSync(childFile, CHILD({liveRun: url('ophanim/operate/live-run.mjs'), fixtures: url('ophanim/operate/test-fixtures.mjs'), dispatch: url('pantheon/tests/fixtures/dispatch.mjs')}));
    const confirm = `two@${head.slice(0, 7)}`;
    const progressFile = path.join(manifest.out_dir, 'progress.jsonl');
    const launch = mode => {
      const child = spawn(process.execPath, [childFile, file, confirm, repo, mode], {cwd: ROOT, env: {...process.env, ...SYNTHETIC_ENV}, stdio: ['ignore', 'pipe', 'pipe']});
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
      const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({code, signal, out, err})));
      return {child, exited};
    };
    /** The claim of the n-th dispatch the launcher announced (progress.jsonl), once it is there. */
    const dispatched = async (n = 1, ms = 60_000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
        const d = (fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []).filter(e => e.event === 'dispatch');
        if (d.length >= n) return d[n - 1];
      }
      throw new Error('the launcher never dispatched a stage');
    };
    const record = () => JSON.parse(fs.readFileSync(path.join(manifest.out_dir, 'run.json'), 'utf8'));
    const work = () => openWorkLedger({root: manifest.ledgers.work_root, create: false});
    try { await fn({launch, dispatched, record, work, manifest}); }
    finally {
      if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
      fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true});
    }
  });
}

test('L-305: a live run stopped by a real SIGTERM releases its claim as interrupted, records why, and a restart resumes at once (not after its ten-minute lease)', real, async () => {
  await withLauncher(async ({launch, dispatched, record, work}) => {
    const first = launch('cooperative');
    const d = await dispatched(1);
    assert.equal(d.stage, 'plan');
    first.child.kill('SIGTERM');
    const r1 = await first.exited;
    assert.equal(r1.code, 3, r1.err.slice(-2000));
    const rec = record();
    const blocker = rec.blockers.find(b => b.source === 'launcher' && b.code === 'INTERRUPTED');
    assert.match(blocker.why, /^INTERRUPTED: SIGTERM received/);
    assert.deepEqual(blocker.released.map(x => [x.claim, x.stage, x.released]), [[d.claim, 'plan', true]]);
    assert.equal(rec.acceptance.met, false);
    assert.equal(work().released(d.claim).outcome, 'interrupted');
    assert.deepEqual(work().stages('two'), [], 'the stopped stage handed nothing on');
    // The restart: the lease (elapsed_ms + grace) has not passed, and the plan is dispatched again at once.
    const second = launch('pass');
    const r2 = await second.exited;
    const rec2 = record();
    assert.equal(rec2.blockers.some(b => b.code === 'CLAIM_HELD'), false);
    assert.equal(rec2.ticks[0].dispatched[0].stage, 'plan', JSON.stringify(rec2.ticks[0]));
    assert.equal(r2.code, 0, JSON.stringify(rec2.acceptance));
  });
});

test('L-305: a stage that ignores the stop does not keep its claim: after the grace the launcher releases it and exits 143', real, async () => {
  await withLauncher(async ({launch, dispatched, work}) => {
    const run = launch('deaf');
    const d = await dispatched(1);
    run.child.kill('SIGTERM');
    const r = await run.exited;
    assert.equal(r.code, 143, r.err.slice(-2000));
    const rel = work().released(d.claim);
    assert.equal(rel.outcome, 'interrupted');
    assert.match(rel.why, /^INTERRUPTED: SIGTERM received and the run did not stop within 1500 ms/);
  });
});

test('L-305: after a SIGKILL the claim is held; the restart names which claim, by whom and until when, and dispatches nothing', real, async () => {
  await withLauncher(async ({launch, dispatched, work, manifest}) => {
    const run = launch('deaf');
    const d = await dispatched(1);
    run.child.kill('SIGKILL');
    await run.exited;
    const claim = work().claims('two').find(c => c.hash === d.claim);
    assert.equal(work().released(d.claim), null, 'nothing released it');
    const until = new Date(Date.parse(claim.leased_at) + claim.lease_ms).toISOString();
    const again = launch('pass');
    const r = await again.exited;
    const plan = JSON.parse(r.out);
    assert.equal(r.code, 1, 'refused before any dispatch');
    assert.deepEqual(plan.refusals, [`CLAIM_HELD: "two" plan (attempt 1) is claimed by live-run until ${until}: a run stopped without releasing its claim (killed, not interrupted); the item resumes from its last recorded stage once that lease ends, and nothing can be dispatched before`]);
    assert.deepEqual([plan.gate.held.claim, plan.gate.held.stage, plan.gate.held.holder, plan.gate.held.lease_until], [d.claim, 'plan', 'live-run', until]);
    assert.equal(work().claims('two').length, 1, 'no new claim was taken');
    assert.equal(fs.existsSync(path.join(manifest.out_dir, 'run.json')), false, 'no run was recorded');
  });
});

// ---- L-307 ----------------------------------------------------------------------------------------------------------
test('L-307 (self-audit round 3, assignment 3 (sealed bb1287a)): the run.json on disk while the fresh verification runs is NOT accepted; only the verified rewrite is', real, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = gitFixture(repo, ['one', 'two'].map(item => ({item})));
    ctx.agyWorker('printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n');
    fs.writeFileSync(path.join(repo, 'quota-report.txt'), USAGE_REPORT);
    fs.writeFileSync(path.join(repo, 'quota-exit'), '0');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3a3-home-')));
    const g = path.join(home, '.gemini'), c = path.join(g, 'antigravity-cli');
    fs.mkdirSync(path.join(c, 'log'), {recursive: true}); fs.mkdirSync(path.join(g, 'config', 'projects'), {recursive: true});
    fs.writeFileSync(path.join(c, 'antigravity-oauth-token'), 'SYNTHETIC-oauth-token'); fs.writeFileSync(path.join(g, 'config', 'projects', 'default-cli-project.json'), '{}');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3a3-out-')));
    const before = process.env.HOME; process.env.HOME = home;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const manifest = {schema: LIVE_RUN_SCHEMA, item: 'two', candidate_commit: head, profile: 'fit', independence: 'model', limits: structuredClone(LIMITS),
      billing: {scope: 'fixture', gemini_api_implementer: true, metered_gemini_failover: false, note: ''}, ledgers: {status_root: f.statusRoot, work_root: path.join(outside, 'run', 'work')},
      credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'required'}, out_dir: path.join(outside, 'run')};
    const file = path.join(outside, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const runFile = path.join(manifest.out_dir, 'run.json');
    // What is on disk at the moment the verifier child is started (what a kill during verification leaves).
    let atVerify = null;
    const orig = fs.mkdtempSync;
    fs.mkdtempSync = function (prefix, ...rest) { if (String(prefix).includes('ophanim-verdict-')) atVerify = JSON.parse(fs.readFileSync(runFile, 'utf8')); return orig.call(this, prefix, ...rest); };
    try {
      const code = await main(['--manifest', file, '--confirm-spend', `two@${head.slice(0, 7)}`, '--repo', repo],
        {log: () => {}, err: () => {}, env: {...process.env, ...SYNTHETIC_ENV}, seats: {turn: scriptedTurn(), makeClientFor: ctx.makeClientFor}, signals: []});
      assert.equal(atVerify.verification, null);
      assert.equal(atVerify.acceptance.met, false, 'not accepted before the verification');
      assert.equal(atVerify.acceptance.state, 'pending');
      assert.match(atVerify.acceptance.reasons.at(-1), /^VERIFICATION_PENDING: /);
      const final = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      assert.deepEqual([code, final.acceptance, final.verification.ok], [0, {met: true, reasons: []}, true], 'the verified rewrite is accepted');
    } finally {
      fs.mkdtempSync = orig;
      if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
      fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true});
    }
  });
});
