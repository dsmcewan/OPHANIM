// Independent review, assignment 3, commit 09d490feae4df80effa081d08a02ea240f3dc854.
// Original fixtures. Scripted providers and local processes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStatusLedger } from '../packages/ledger/status.mjs';
import { openWorkLedger } from '../ophanim/operate/work-ledger.mjs';
import { tick, spent } from '../ophanim/operate/scheduler.mjs';
import { reconcile } from '../ophanim/operate/reconcile.mjs';
import { makeExecutors } from '../ophanim/operate/stages.mjs';
import { runConfirmed, statusLedgerState, verifyInChild } from '../ophanim/operate/live-run.mjs';
import { fixture as gitFixture, scriptedTurn, FIVE } from '../ophanim/operate/test-fixtures.mjs';
import { withDispatch } from '../pantheon/tests/fixtures/dispatch.mjs';
import { runPipeline } from '../pantheon/src/pipeline/index.mjs';
import { checkpointRefusal, readCheckpoint, unitKey, writeCheckpoint } from '../pantheon/src/pipeline/checkpoint.mjs';
import { waves, lockConflicts } from '../pantheon/src/pipeline/dispatch.mjs';
import { pathsOverlap } from '../pantheon/src/pipeline/paths.mjs';
import { runVerify } from '../pantheon/src/pipeline/review.mjs';
import { pipelineTurns } from '../pantheon/src/pipeline/turns.mjs';
import { workerArgv } from '../pantheon/src/board/agy-cli.mjs';
import { spawnPromise } from '../pantheon/src/board/spawn.mjs';
import { routeSeats } from '../pantheon/src/route/quota-failover.mjs';
import { git } from '../pantheon/src/pipeline/git.mjs';
import { sha256 } from '../pantheon/src/pipeline/util.mjs';
import { tempRepo, seats, unit, scripted, PLANNER, sh } from '../pantheon/tests/fixtures/pipeline-stages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-17T00:00:00Z');

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-exec-'));
  const statusRoot = path.join(repo, 'status', 'ledger');
  const workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({ root: statusRoot });
  for (const i of items) S.set({ checked: '2026-11-17', basis: `the requirement of ${i.item}`, state: 'Ready', title: i.title ?? i.item, ...i });
  return { repo, statusRoot, workRoot, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
const passed = (calls = 0, extra = {}) => ({
  status: 'passed', outputs: { ok: true, ...extra }, team: [], contributions: [], findings: [],
  usage: { provider_calls: calls }, next: { stage: 'implement', why: 'ok' },
});
const quotaError = () => Object.assign(new Error('RESOURCE_EXHAUSTED'), { code: 'quota_exhausted', status: 429, quota: { explicit: true, matched: '429' } });
const laneError = kind => Object.assign(new Error(`lane ${kind}`), { code: 'lane_failure', kind });
const waitFor = async (file, ms = 8000) => {
  const t = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${file}`);
    await new Promise(r => setTimeout(r, 20));
  }
};
const untilExit = (child, ms = 5000) => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit within ${ms} ms`)), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
});

test('Q1: each admitted turn is one charge, a resumed unit is not charged, and the cap is not passed', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const plan = [unit('a'), unit('b', { owned_paths: ['src/b/**'] })];
  const seen = [];
  const s = scripted({ plan });
  const capped = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: plan }, seats: seats(), turns: s.turns,
    dir: path.join(env.root, 'cap'), planner: PLANNER, limits: { max_provider_calls: 3, max_concurrent_units: 2 },
    onCharge: ({ role }) => { seen.push(role); },
  });
  assert.ok(capped.provider_calls.total <= 3, `total ${capped.provider_calls.total} passed max_provider_calls 3`);
  assert.equal(capped.provider_calls.total, seen.length, 'onCharge once per admitted call');
  assert.ok(capped.provider_calls.refused_at_limit >= 1);
  assert.equal(s.calls.length, seen.length, 'a refused admit does not call the provider');

  const full = scripted({ plan: [unit('a')] });
  const one = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, seats: seats(), turns: full.turns,
    dir: path.join(env.root, 'full'), planner: PLANNER, checkpoints: { dir: path.join(env.root, 'ck') }, run_id: 'one',
  });
  assert.equal(one.units.a.status, 'approved');
  const roles = {};
  for (const c of full.calls) roles[c.role] = (roles[c.role] ?? 0) + 1;
  assert.equal(one.provider_calls.total, full.calls.length);
  assert.deepEqual(roles, { dispatcher: 1, implementer: 1, reviewer: 1 });
  const again = scripted({ plan: [unit('a')] });
  const two = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, seats: seats(), turns: again.turns,
    dir: path.join(env.root, 'resume'), planner: PLANNER, checkpoints: { dir: path.join(env.root, 'ck') }, run_id: 'two',
  });
  assert.equal(two.units.a.resumed, true);
  assert.equal(two.provider_calls.total, 0, 'a resumed unit makes no provider call');
  assert.equal(again.calls.length, 0);
});

test('Q1: a metered failover is its own charge, a probe is not, and an aborted or refused charge does not call the API', async t => {
  const env = await tempRepo({ 'README.md': 'base\n' });
  t.after(env.cleanup);
  let api = 0, probes = 0;
  const turns = pipelineTurns({
    turn: async () => ({ text: 'unused', served_model: 'x' }),
    agy: {
      meteredFailover: true,
      run: async () => { throw quotaError(); },
      probe: async () => { probes++; return { state: 'exhausted', buckets: [], raw_digest: null, exit_code: 0 }; },
      api: async () => { api++; return { text: JSON.stringify({ files: [{ path: 'README.md', content: 'next\n' }] }), served_model: 'gemini-4-hydrogen' }; },
    },
  });
  let charges = 0;
  const ok = await turns.implementer({
    vendor: 'agy_google', model: 'gemini-4-hydrogen-medium', prompt: 'write', cwd: env.repo,
    owned_paths: ['README.md'], unit_id: 'a', charge: () => { charges++; },
  });
  assert.equal(api, 1);
  assert.equal(charges, 1, 'the API call is charged once, separate from the lane');
  assert.equal(probes, 1);
  assert.equal(ok.quota_failover.used, true);

  let api2 = 0;
  const refused = pipelineTurns({
    turn: async () => ({ text: 'unused', served_model: 'x' }),
    agy: {
      meteredFailover: true,
      run: async () => { throw quotaError(); },
      probe: async () => ({ state: 'exhausted', buckets: [] }),
      api: async () => { api2++; return { text: '{}' }; },
    },
  });
  await assert.rejects(() => refused.implementer({
    vendor: 'agy_google', model: 'gemini-4-hydrogen-medium', prompt: 'write', cwd: env.repo,
    owned_paths: ['README.md'], unit_id: 'a', charge: () => { throw Object.assign(new Error('stage budget spent'), { code: 'PROVIDER_CALL_LIMIT' }); },
  }), e => e.code === 'PROVIDER_LIMIT' || e.cause?.code === 'PROVIDER_CALL_LIMIT' || /not charged|stage budget/.test(e.message));
  assert.equal(api2, 0, 'a refused charge does not call the API');

  const ac = new AbortController();
  let api3 = 0, failoverAdmits = 0;
  const aborted = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, seats: seats(), dir: path.join(env.root, 'abort'),
    planner: PLANNER, signal: ac.signal, limits: { max_revisions: 0 },
    onCharge: ({ role }) => { if (role === 'metered_failover') failoverAdmits++; },
    turns: pipelineTurns({
      turn: async () => ({ text: '{}', served_model: 'gpt-6-luna' }),
      agy: {
        meteredFailover: true,
        run: async () => { ac.abort(); throw quotaError(); },
        probe: async () => ({ state: 'exhausted', buckets: [] }),
        api: async () => { api3++; return { text: '{}' }; },
      },
    }),
  });
  assert.equal(api3, 0, 'admit() sees the aborted signal before the API call');
  assert.equal(failoverAdmits, 0);
  assert.notEqual(aborted.units.a.status, 'approved');
});

test('Q2 and Q9: a stage that returns passed after its elapsed abort is recorded passed, and the next stage still runs', async () => {
  const f = fixture([{ item: 'slow', title: 'Slow' }]);
  try {
    const seen = [];
    const plan = async ctx => {
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 20_000) await new Promise(r => setTimeout(r, 20));
      seen.push(['plan-end', ctx.signal.aborted, Date.now() - start]);
      return passed(0);
    };
    const implement = async ctx => {
      ctx.charge(1);
      seen.push(['implement', ctx.signal.aborted]);
      return { ...passed(1), status: 'failed', next: { stage: 'implement', why: 'stop the loop' } };
    };
    const r = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot,
      executors: { plan, implement },
      limits: { total_provider_calls: 100, stage_provider_calls: 5, iterations: 5, lease_ms: 8000, elapsed_ms: 120_000 },
    });
    assert.deepEqual(seen[0], ['plan-end', true, seen[0][2]]);
    assert.ok(seen[0][2] < 120_000, 'the tick elapsed limit had not been reached');
    assert.deepEqual(r.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed', 'implement:failed']);
    assert.match(r.stopped, /stage elapsed limit/);
    const w = openWorkLedger({ root: f.workRoot });
    const planRec = w.stages('slow').find(s => s.stage === 'plan');
    assert.equal(planRec.status, 'passed');
    assert.equal(planRec.outputs.stopped.code, 'STAGE_ELAPSED');
    const gate = reconcile({ repo: f.repo, statusRoot: f.statusRoot, workLedger: w }).items[0].gate;
    assert.equal(gate.reuse.plan, planRec.hash, 'the stopped plan is a valid handoff');
    assert.equal(seen[1][0], 'implement');
    assert.equal(spent(w).calls, 1, 'the next stage charged a call after the elapsed stop');
  } finally { f.done(); }
});

test('Q3: overlapping owned paths are not one wave, and a second process cannot claim a live item', async () => {
  const a = unit('a', { owned_paths: ['src/shared/**'] });
  const b = unit('b', { owned_paths: ['src/shared/leaf.mjs'] });
  const c = unit('c', { owned_paths: ['other/**'] });
  assert.equal(pathsOverlap('src/shared/**', 'src/shared/leaf.mjs'), true);
  assert.equal(lockConflicts([a, b]).length, 1);
  const split = waves([a, b, c]);
  for (const wave of split) {
    const units = [a, b, c].filter(u => wave.includes(u.unit_id));
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) assert.equal(pathsOverlap(units[i].owned_paths[0], units[j].owned_paths[0]), false, wave.join(','));
  }
  assert.ok(split.length >= 2);

  const f = fixture([{ item: 'a', title: 'A' }, { item: 'b', title: 'B' }]);
  try {
    let running = 0, peak = 0;
    const plan = async ctx => {
      running++; peak = Math.max(peak, running);
      ctx.charge(1);
      await new Promise(r => setTimeout(r, 80));
      running--;
      return passed(1);
    };
    const both = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: { plan },
      limits: { total_provider_calls: 20, stage_provider_calls: 5, concurrency: 2, iterations: 4 },
    });
    assert.equal(peak, 2, 'concurrency above 1 runs two items when their budgets both fit');
    assert.deepEqual(both.dispatched.map(d => d.status).sort(), ['passed', 'passed']);
    assert.ok(spent(openWorkLedger({ root: f.workRoot })).calls <= 20);
  } finally { f.done(); }

  const g = fixture([{ item: 'one', title: 'One' }]);
  const marker = path.join(g.repo, 'held');
  const childLog = path.join(g.repo, 'child.log');
  const childOut = fs.openSync(childLog, 'w');
  const child = spawn(process.execPath, [path.join(HERE, 'stall-stage.mjs'), g.repo, g.statusRoot, g.workRoot, marker], { stdio: ['ignore', childOut, childOut] });
  try {
    await waitFor(marker);
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, `holder exited before the second claim: ${fs.readFileSync(childLog, 'utf8')}`);
    const w = openWorkLedger({ root: g.workRoot });
    assert.equal(w.claims('one').length, 1);
    assert.throws(() => w.claim({
      item: 'one', stage: 'plan', attempt: 1, inputs: { n: 2 }, holder: 'other',
      budget: { provider_calls: 5, iterations: 1, elapsed_ms: 1000, retries: 1 }, lease_ms: 60_000, at: new Date().toISOString(),
    }), /already claimed/);
    const second = await tick({
      repo: g.repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: { plan: async () => passed(1) },
      limits: { total_provider_calls: 100, stage_provider_calls: 5, iterations: 2 },
    });
    assert.deepEqual(second.dispatched, []);
    assert.equal(openWorkLedger({ root: g.workRoot }).claims('one').length, 1);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await untilExit(child);
    g.done();
  }
});

test('Q4: an expired claim is released as expired, the next tick resumes the unfinished stage, and the old holder cannot record', async () => {
  const f = fixture([{ item: 'eps', title: 'Eps' }]);
  try {
    const limits = { total_provider_calls: 40, stage_provider_calls: 5, iterations: 3, lease_ms: 1000 };
    await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot,
      executors: { plan: async () => passed(1) }, limits, clock: () => T0,
    });
    const w = openWorkLedger({ root: f.workRoot });
    const plan = w.stages('eps').find(s => s.stage === 'plan');
    const inputs = { upstream: 'sha256:' + 'b'.repeat(64), requirement: plan.identity.requirement };
    const claim = w.claim({
      item: 'eps', stage: 'implement', attempt: 1, inputs, holder: 'stale',
      budget: { provider_calls: 5, iterations: 1, elapsed_ms: 1000, retries: 1 }, lease_ms: 1000, at: new Date(T0).toISOString(),
    });
    w.recordSpend({ claim, provider_calls: 2, at: new Date(T0 + 10).toISOString() });
    const released = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits, clock: () => T0 + 5000,
    });
    assert.deepEqual(released.released_expired.map(x => x.stage), ['implement']);
    const rec = at => ({
      claim, from: plan.hash, stage: 'implement', attempt: 1, status: 'passed', identity: plan.identity, inputs,
      outputs: { forged: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 2 }, next: null, at,
    });
    assert.throws(() => w.recordStage(rec(new Date(T0 + 10).toISOString())), e => e.code === 'LEASE_FENCED');
    assert.throws(() => w.recordSpend({ claim, provider_calls: 3, at: new Date(T0 + 10).toISOString() }), e => e.code === 'LEASE_FENCED');
    let runs = 0;
    const next = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits, clock: () => T0 + 6000,
      executors: { implement: async () => { runs++; return { ...passed(1), next: { stage: 'review', why: 'resumed' } }; } },
    });
    assert.equal(runs, 1);
    assert.equal(next.dispatched[0].stage, 'implement');
    const after = openWorkLedger({ root: f.workRoot });
    assert.equal(after.stages('eps').filter(s => s.stage === 'implement' && s.outputs.forged).length, 0);
    assert.equal(after.stages('eps').some(s => s.stage === 'plan' && s.status === 'passed'), true, 'the passed plan was not repeated');
  } finally { f.done(); }
});

test('Q5: a non-quota lane failure is retried once, a quota refusal steps down immediately, and an exhausted ladder blocks with every failure and no revision', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const ladder = [['gemini-4-carbon-high'], ['gemini-4-hydrogen-xhigh'], ['gemini-4-argon-high']].map(([model]) => ({ vendor: 'agy_google', model }));
  const seatOver = { implementer: () => ({ seat: { ...ladder[0] }, ladder: ladder.map(x => ({ ...x })) }) };
  const writeImpl = async args => { const { write } = await import('../pantheon/tests/fixtures/pipeline-stages.mjs'); await write(args.cwd, `src/${args.unit_id}/impl.mjs`, 'export {};\n'); return 'done'; };

  const retry = scripted({ plan: [unit('a')], implement: async (args, n) => { if (n === 1) throw laneError('timeout'); return writeImpl(args); } });
  const retried = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, dir: path.join(env.root, 'retry'), planner: PLANNER,
    turns: retry.turns, seats: seats(seatOver), limits: { max_revisions: 0 },
  });
  assert.equal(retried.units.a.status, 'approved');
  assert.deepEqual(retry.calls.filter(c => c.role === 'implementer').map(c => c.model), ['gemini-4-carbon-high', 'gemini-4-carbon-high']);
  assert.equal(retried.units.a.attempts[0].lane_failures[0].next, 'same_lane');
  assert.equal(retried.units.a.escalations.length, 0);
  assert.equal(retried.revisions ?? 0, 0);

  const quota = scripted({ plan: [unit('a')], implement: async (args, n) => { if (n === 1) throw quotaError(); return writeImpl(args); } });
  const stepped = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, dir: path.join(env.root, 'quota'), planner: PLANNER,
    turns: quota.turns, seats: seats(seatOver), limits: { max_revisions: 0 },
  });
  assert.deepEqual(stepped.units.a.attempts[0].lane_failures.map(f => [f.cause, f.retry, f.next]), [['quota', false, 'next_rung']]);
  assert.deepEqual(quota.calls.filter(c => c.role === 'implementer').map(c => c.model), ['gemini-4-carbon-high', 'gemini-4-hydrogen-xhigh']);

  const dead = scripted({ plan: [unit('a')], implement: async () => { throw laneError('timeout'); } });
  const blocked = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, dir: path.join(env.root, 'dead'), planner: PLANNER,
    turns: dead.turns, seats: seats(seatOver), limits: { max_revisions: 0 },
  });
  assert.equal(blocked.units.a.status, 'blocked');
  assert.equal(blocked.units.a.code, 'LANE_LADDER_EXHAUSTED');
  assert.equal(blocked.units.a.attempts[0].lane_failures.length, 6, 'two tries on each of three rungs');
  assert.equal(dead.calls.filter(c => c.role === 'reviewer').length, 0);
  assert.equal(blocked.units.a.attempts.length, 1, 'lane failures did not open a review revision');
});

test('Q6: metered failover off never calls the Gemini API, and the unit is recorded blocked', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  let api = 0, probes = 0;
  const charged = [];
  const out = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, seats: seats(), dir: path.join(env.root, 'off'),
    planner: PLANNER, limits: { max_revisions: 0 },
    onCharge: ({ role }) => charged.push(role),
    turns: pipelineTurns({
      turn: async () => ({ text: JSON.stringify({ unit_id: 'a', cohesive: true, specialist_role: 'node-esm-library-engineer', difficulty: 'medium', rubric: ['the verify command passes', 'only owned paths are changed'], notes: '' }), served_model: 'gpt-6-luna' }),
      agy: {
        meteredFailover: false,
        run: async () => { throw quotaError(); },
        probe: async () => { probes++; return { state: 'exhausted', buckets: [] }; },
        api: async () => { api++; return { text: '{}' }; },
      },
    }),
  });
  assert.equal(api, 0);
  assert.ok(probes >= 1);
  assert.equal(charged.includes('metered_failover'), false, 'a probe and a disabled failover are not charged');
  assert.equal(out.units.a.status, 'blocked');
  assert.equal(out.units.a.code, 'LANE_LADDER_EXHAUSTED');
  assert.equal(out.units.a.attempts.at(-1).quota_failover.disabled, true);
  assert.equal(out.units.a.attempts.at(-1).quota_failover.used, false);
  assert.equal(out.status, 'incomplete');

  const asked = [], skipped = [];
  await routeSeats({
    candidates: [
      { vendor: 'agy_google', model: 'gemini-4-carbon-high', transport: 'agy-cli', pool: 'agy_google' },
      { vendor: 'agy_google', model: 'gemini-4-carbon', transport: 'api', pool: 'agy_google', quota_failover: { base: 'gemini-4-carbon', lanes: ['gemini-4-carbon-high'] } },
      { vendor: 'openai', model: 'gpt-6-astra', transport: 'api', pool: 'openai' },
    ],
    onSkip: s => skipped.push(s.seat.model),
    invoke: async c => { asked.push(c.model); if (c.transport === 'agy-cli') throw Object.assign(new Error('down'), { status: 503, headers: { 'retry-after': '0' } }); return c.model; },
  });
  assert.equal(asked.includes('gemini-4-carbon'), false);
  assert.deepEqual(skipped, ['gemini-4-carbon']);
});

test('Q7: a checkpoint is atomic, and resume rejects a stale base, a bad digest, a different upstream tree, and a verify failure', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const u = unit('a');
  const key = unitKey({ unit: u, base_commit: 'a'.repeat(40), upstream: [] });
  const changed = unitKey({ unit: { ...u, invariants: ['different'] }, base_commit: 'a'.repeat(40), upstream: [] });
  const withRubric = unitKey({ unit: { ...u, rubric: ['not part of the key'] }, base_commit: 'a'.repeat(40), upstream: [] });
  assert.notEqual(key, changed);
  assert.equal(key, withRubric, 'rubric text is outside unit_key, as checkpoint.mjs documents');
  const upKey = unitKey({ unit: u, base_commit: 'a'.repeat(40), upstream: [{ unit_id: 'z', unit_key: 'sha256:' + 'c'.repeat(64) }] });
  assert.notEqual(key, upKey);

  const dir = path.join(env.root, 'checkpoints');
  const record = {
    unit_key: key, unit_id: 'a', rubric_hash: 'sha256:' + 'd'.repeat(64), base_commit: 'a'.repeat(40), unit_base_commit: 'a'.repeat(40),
    upstream: [], commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    reviewer: { vendor: 'openai', model: 'gpt-6-luna', served_model: 'gpt-6-luna' },
    verify: { cmd: u.verify_cmd, exit_code: 0, digest: 'sha256:' + 'e'.repeat(64) },
    review_digest: 'sha256:' + 'f'.repeat(64),
  };
  const written = await writeCheckpoint({ dir, record, patch: 'diff\n' });
  assert.equal(fs.readdirSync(dir).some(n => n.endsWith('.tmp')), false);
  fs.writeFileSync(path.join(dir, 'ignored.tmp'), '{');
  const read = await readCheckpoint({ dir, unit_key: key });
  assert.equal(read.why, undefined);
  assert.equal(checkpointRefusal(read, { unit_key: key, unit_id: 'a', base_commit: 'a'.repeat(40), upstream: [], verify_cmd: u.verify_cmd }), null);
  assert.match(checkpointRefusal({ ...read, patch: 'other' }, { unit_key: key, unit_id: 'a', base_commit: 'a'.repeat(40), upstream: [], verify_cmd: u.verify_cmd }), /hashes to/);
  assert.match(checkpointRefusal(read, { unit_key: key, unit_id: 'a', base_commit: 'b'.repeat(40), upstream: [], verify_cmd: u.verify_cmd }), /base/);
  assert.match(checkpointRefusal(read, { unit_key: key, unit_id: 'a', base_commit: 'a'.repeat(40), upstream: [{ unit_id: 'z', unit_key: upKey, tree: 'd'.repeat(40) }], verify_cmd: u.verify_cmd }), /upstream/);
  fs.writeFileSync(read.record ? path.join(dir, `${key.replace(/^sha256:/, '')}.json`) : written.unit_key, '{');
  const torn = await readCheckpoint({ dir, unit_key: key });
  assert.match(torn.why, /not JSON/);

  const plan = [unit('a', { verify_cmd: 'test -f src/a/impl.mjs && ! grep -q EVIL src/a/impl.mjs' })];
  const ck = { dir: path.join(env.root, 'ck2') };
  const one = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns,
    dir: path.join(env.root, 'run1'), planner: PLANNER, checkpoints: ck, run_id: 'r1',
  });
  assert.equal(one.units.a.status, 'approved');
  const file = one.units.a.checkpoint.file;
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const evil = 'diff --git a/src/a/impl.mjs b/src/a/impl.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/a/impl.mjs\n@@ -0,0 +1 @@\n+export const id = "EVIL";\n';
  const wt = path.join(env.root, 'forge');
  await git(env.repo, ['worktree', 'add', '--detach', wt, one.base.commit]);
  await git(wt, ['apply', '--index', '--whitespace=nowarn', '-'], { input: evil });
  const tree = (await git(wt, ['write-tree'])).trim();
  await git(env.repo, ['worktree', 'remove', '--force', wt]);
  fs.writeFileSync(path.join(ck.dir, rec.patch_path), evil);
  fs.writeFileSync(file, JSON.stringify({ ...rec, tree, patch_digest: sha256(evil), rubric_hash: 'sha256:' + '1'.repeat(64) }, null, 2) + '\n');
  const two = await runPipeline({
    repo: env.repo, base: 'main', plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns,
    dir: path.join(env.root, 'run2'), planner: PLANNER, checkpoints: ck, run_id: 'r2',
  });
  assert.equal(two.units.a.resumed, false);
  assert.match(two.units.a.checkpoint_rejected.why, /verify_cmd fails/);
  assert.ok(two.provider_calls.total > 0);
});

test('Q8: a kill keeps the charges once, a torn checkpoint is not resumed, an orphan worktree does not block the next run, and a review saved before findings is dropped', async t => {
  const f = fixture([{ item: 'k', title: 'K' }]);
  const marker = path.join(f.repo, 'charged');
  const childLog = path.join(f.repo, 'child.log');
  const childOut = fs.openSync(childLog, 'w');
  const child = spawn(process.execPath, [path.join(HERE, 'stall-stage.mjs'), f.repo, f.statusRoot, f.workRoot, marker], { stdio: ['ignore', childOut, childOut] });
  try {
    await waitFor(marker);
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, `stall child exited before SIGKILL: ${fs.readFileSync(childLog, 'utf8')}`);
    process.kill(child.pid, 'SIGKILL');
    await untilExit(child);
    const mid = openWorkLedger({ root: f.workRoot });
    assert.equal(mid.stages('k').length, 0);
    const claim = mid.claims('k')[0];
    assert.equal(Math.max(...mid.spends(claim.hash).map(s => s.provider_calls)), 2);
    const later = Date.now() + 120_000;
    let runs = 0;
    const resumed = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot,
      executors: { plan: async ctx => { runs++; ctx.charge(1); return passed(1); } },
      limits: { total_provider_calls: 100, stage_provider_calls: 10, iterations: 2, lease_ms: 1000 },
      clock: () => later,
    });
    assert.equal(resumed.released_expired.length, 1);
    assert.equal(runs, 1);
    const after = openWorkLedger({ root: f.workRoot });
    assert.equal(spent(after, { now: later }).calls, 3, 'the killed charges stay, and are not recorded again');
    assert.equal(after.spends(claim.hash).length >= 1, true);
  } finally { f.done(); }

  const env = await tempRepo();
  t.after(env.cleanup);
  const hung = path.join(env.root, 'hung');
  const orphanLog = path.join(env.root, 'orphan.log');
  const orphanOut = fs.openSync(orphanLog, 'w');
  const orphan = spawn(process.execPath, [path.join(HERE, 'orphan-hang.mjs'), env.repo, path.join(env.root, 'run1'), hung], { stdio: ['ignore', orphanOut, orphanOut] });
  try {
    await waitFor(hung, 15000);
    const orphanPath = fs.readFileSync(hung, 'utf8');
    let alive = true;
    try { process.kill(orphan.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, `orphan child exited before SIGKILL: ${fs.readFileSync(orphanLog, 'utf8')}`);
    process.kill(orphan.pid, 'SIGKILL');
    await untilExit(orphan);
    const two = await runPipeline({
      repo: env.repo, base: 'main', plan: { work_units: [unit('a')] }, seats: seats(), turns: scripted({ plan: [unit('a')] }).turns,
      dir: path.join(env.root, 'run2'), planner: PLANNER, run_id: 'after-kill',
    });
    assert.equal(two.status, 'completed', two.reason ?? two.units.a.reason);
    const listed = await sh('git worktree list --porcelain', env.repo);
    assert.match(listed, new RegExp(orphanPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const g = gitFixture(repo, [{ item: 'ticketed' }], { tickets: ['ticketed'] });
    // FIVE is test seating only, so the capacity check does not return before the carry this assertion observes.
    const ex = makeExecutors({ repo, makeClientFor: ctx.makeClientFor, turn: scriptedTurn(), stateDir: g.stateDir, independence: 'model', seating: FIVE.seating, facts: FIVE.facts });
    const planned = await tick({
      repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: { plan: ex.plan },
      limits: { total_provider_calls: 40, stage_provider_calls: 20, iterations: 1 },
    });
    const w = openWorkLedger({ root: g.workRoot });
    const plan = w.stages('ticketed').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.ok(plan, JSON.stringify(planned.dispatched));
    const dead = path.join(g.stateDir, 'ticketed', 'pipeline-dead');
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, 'attempt.json'), JSON.stringify({ item: 'ticketed', attempt: 1, plan_record: plan.hash }) + '\n');
    fs.writeFileSync(path.join(dead, 'pipeline.json'), JSON.stringify({
      run_id: 'dead', status: 'incomplete',
      units: { alpha: {
        unit_id: 'alpha',
        findings: [{ attempt: 1, source: 'reviewer', vendor: 'openai', model: 'gpt-6-luna', code: 'request_changes', findings: ['KEPT_ON_DISK'] }],
        reviews: [{ status: 'request_changes', feedback: ['ONLY_IN_THE_REVIEW_SAVE'], vendor: 'openai', model: 'gpt-6-luna' }],
      } },
    }) + '\n');
    const ac = new AbortController();
    ac.abort();
    const out = await ex.implement({
      item: 'ticketed', gate: { gate: 'implement', mode: 'author', from: plan.hash, requirement: plan.identity },
      upstream: plan, attempt: 2, budget: { provider_calls: 20, iterations: 1, elapsed_ms: 60_000, retries: 1 },
      repo, work: w, signal: ac.signal, claim: null, charge: () => { throw new Error('no call expected'); },
    });
    const texts = (out.findings ?? []).map(f => f.text);
    assert.ok(texts.includes('KEPT_ON_DISK'), JSON.stringify(texts));
    assert.equal(texts.includes('ONLY_IN_THE_REVIEW_SAVE'), false, JSON.stringify(texts));
  });
});

test('Q9: verify_cmd is killed at its timeout, and the worker argv carries the print timeout', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const slow = await runVerify({ worktree: env.repo, verify_cmd: 'sleep 30', timeout_ms: 200, max_output_bytes: 1000 });
  assert.equal(slow.timed_out, true);
  assert.equal(slow.passed, false);
  assert.ok(slow.duration_ms < 5000);
  const argv = workerArgv({ model: 'gemini-4-hydrogen-medium', worktree: env.repo, prompt: 'p', timeoutS: 30 });
  assert.ok(argv.includes('--print-timeout'));
  assert.equal(argv[argv.indexOf('--print-timeout') + 1], '30s');
  const killed = await spawnPromise('sleep', ['30'], { timeout: 200 });
  assert.equal(killed.killedFor, 'timeout');
});

test('Q10: run.json is verified by a different process and lists the budget stop and the blocker', async () => {
  const f = fixture([{ item: 'q10', title: 'Q10' }]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runjson-'));
  try {
    const status = statusLedgerState(f.statusRoot);
    const manifest = {
      item: 'q10', candidate_commit: 'a'.repeat(40),
      limits: {
        total_provider_calls: 20, stage_provider_calls: 5, revisions: 1, stage_attempts: 1, elapsed_ms: 120_000,
        pipeline: { max_provider_calls: 5, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 1000 },
      },
      billing: { metered_gemini_failover: false },
      credentials: { gemini_api_key: 'not-used' },
      ledgers: { status_root: f.statusRoot, work_root: path.join(out, 'work') },
      out_dir: out,
      require_subagent: null,
    };
    const { record, file } = await runConfirmed(
      { manifest, digest: 'sha256:' + 'a'.repeat(64), file: path.join(out, 'manifest.json') },
      { schema: 'review' }, status, { state: 'absent' },
      {
        repo: f.repo,
        seats: { turn: async () => { throw new Error('no live turn'); }, makeClientFor: () => { throw new Error('no live client'); } },
        makeExecutorsImpl: async () => ({
          plan: async () => ({
            status: 'blocked', outputs: { partial: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 1 },
            blocker: { what: 'LANE_LADDER_EXHAUSTED: the ladder is spent', role: 'lead@orch', resume_when: 'the owner reseats the work' },
            next: { stage: 'plan', why: 'PROVIDER_CALL_LIMIT: the stage budget stopped the plan' },
          }),
        }),
      },
    );
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.schema, record.schema);
    assert.notEqual(disk.verification.process.pid, process.pid);
    assert.equal(disk.verification.process.exit_code, 0);
    assert.equal(disk.verification.ok, true);
    assert.ok(disk.budget_stops.some(s => /PROVIDER_CALL_LIMIT/.test(s.why)), JSON.stringify(disk.budget_stops));
    assert.ok(disk.blockers.some(b => /LANE_LADDER_EXHAUSTED/.test(b.blocker?.what ?? '')), JSON.stringify(disk.blockers));
    assert.equal(disk.stages[0].status, 'blocked');
    const child = await verifyInChild({ workRoot: manifest.ledgers.work_root, item: 'q10', statusRoot: f.statusRoot, statusBefore: status });
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.notEqual(child.process.pid, process.pid);
  } finally { f.done(); fs.rmSync(out, { recursive: true, force: true }); }
});
