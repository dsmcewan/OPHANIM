// EXECUTION RELIABILITY of the controller: leases, budgets across restarts and concurrency, the cooperative stop, the
// fresh-process verification. Each test is a regression for a defect found by the independent review, assignment 3
// (xAI grok-4.7, commit 7997657); each asserts the CORRECT behaviour and failed on the code the review read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger, outputsDigest} from './work-ledger.mjs';
import {tick, spent} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors} from './stages.mjs';
import {verifyInChild, statusLedgerState} from './live-run.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture as gitFixture, scriptedTurn, unitApprove, unitReject, LIMITS as FIT_LIMITS} from './test-fixtures.mjs';

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rel-'));
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i.item}`, ...i});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
const passed = (calls, extra = {}) => ({status: 'passed', outputs: {ok: true, ...extra}, team: [], contributions: [], findings: [], usage: {provider_calls: calls}, next: {stage: 'implement', why: 'ok'}});
const passPlan = f => async ctx => {
  const ticket = {schema: 'ophanim.ticket/v1', item: ctx.item, slice: 'all', proposes: {state: 'Resolved', basis: 'done'}, title: ctx.gate.requirement.title, goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: 'a.mjs', copy: [], acceptance_cmd: 'true'};
  fs.writeFileSync(path.join(f.repo, 'tickets', `${ctx.item}.json`), JSON.stringify(ticket));
  const {readTicket} = await import('../../pantheon/src/board/operate.mjs');
  const t = readTicket({repo: f.repo, item: ctx.item});
  return {status: 'passed', identity: {ticket: {path: t.path, digest: t.digest}}, outputs: {plan_version: 1, ticket: {path: t.path, digest: t.digest}, deps: {}, evidence: []}, team: [{role: 'planner'}],
    contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'approved'}};
};
const T0 = Date.parse('2026-11-17T00:00:00Z');
const BUDGET = {provider_calls: 10, iterations: 1, elapsed_ms: 1000, retries: 1};

// Question 4: a holder whose claim was released as `expired` appended a `passed` stage under it, and the next tick
// treated that late record as the handoff (implement never re-ran, the gate moved to review). The lease fence refuses
// it: recordStage throws LEASE_FENCED, the ledger's re-derivation refuses the same, and the next tick resumes implement.
test('the lease fence: a stage recorded under a released or expired claim is refused, and the stage resumes', async () => {
  const f = fixture([{item: 'eps', title: 'Eps', state: 'Ready'}]);
  try {
    const limits = {total_provider_calls: 100, stage_provider_calls: 10, iterations: 1};
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: passPlan(f)}, limits, clock: () => T0 - 60_000});
    const w = openWorkLedger({root: f.workRoot});
    const plan = w.stages('eps').find(s => s.stage === 'plan' && s.status === 'passed');
    const inputs = {upstream: outputsDigest(plan.outputs), requirement: plan.identity.requirement};
    const claim = w.claim({item: 'eps', stage: 'implement', attempt: 1, inputs, holder: 'stale', budget: BUDGET, lease_ms: 1000, at: new Date(T0).toISOString()});
    const rec = at => ({claim, from: plan.hash, stage: 'implement', attempt: 1, status: 'passed', identity: plan.identity, inputs, outputs: {forged: true}, team: [], contributions: [],
      findings: [{id: 'f1', severity: 'block', text: 'arrived after the lease'}], usage: {provider_calls: 9}, next: {stage: 'review', why: 'stale holder says shipped'}, at});
    // Past the lease, still unreleased: refused (the lease time is part of the fence).
    assert.throws(() => w.recordStage(rec(new Date(T0 + 2000).toISOString())), e => e.code === 'LEASE_FENCED' && /expired/.test(e.message));
    const released = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits, clock: () => T0 + 5000});
    assert.deepEqual(released.released_expired.map(x => x.stage), ['implement']);
    // Released: refused, whatever time it claims.
    assert.throws(() => w.recordStage(rec(new Date(T0 + 10).toISOString())), e => e.code === 'LEASE_FENCED' && /already released/.test(e.message));
    let implementRuns = 0;
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits, clock: () => T0 + 6000,
      executors: {implement: async () => { implementRuns++; return {...passed(1, {real: true}), next: {stage: 'review', why: 'ok'}}; }}});
    assert.equal(implementRuns, 1, 'the interrupted implement stage was resumed');
    const after = openWorkLedger({root: f.workRoot});
    assert.equal(after.verify().ok, true);
    const impl = after.stages('eps').filter(s => s.stage === 'implement');
    assert.deepEqual(impl.map(s => s.outputs.real ?? s.outputs.forged), [true], 'only the live holder\'s result is on the ledger');
    assert.equal(reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: after, now: T0 + 6000}).items[0].gate.from, impl[0].hash);
  } finally { f.done(); }
});

// Question 3/4: after the lease time an unreleased claim did not block a new one, so a second process could claim
// the same item and stage and both could record. A new claim now first releases the expired one as `expired`, and the
// old holder can then record nothing: no two claims lead to recorded stages.
test('a second claim over an unreleased expired claim releases it first; the old holder cannot record', () => {
  const f = fixture([]);
  try {
    const w = openWorkLedger({root: f.workRoot});
    const id = {item: 'one', requirement: 'sha256:' + 'a'.repeat(64)};
    const old = w.claim({item: 'one', stage: 'plan', attempt: 1, inputs: {n: 1}, holder: 'a', budget: BUDGET, lease_ms: 1000, at: new Date(T0).toISOString()});
    const now = new Date(T0 + 5000).toISOString();
    const fresh = w.claim({item: 'one', stage: 'plan', attempt: 1, inputs: {n: 1}, holder: 'b', budget: BUDGET, lease_ms: 60_000, at: now});
    assert.equal(w.released(old).outcome, 'expired');
    const rec = claim => ({claim, stage: 'plan', attempt: 1, status: 'passed', identity: id, inputs: {n: 1}, outputs: {by: claim === old ? 'a' : 'b'}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null, at: now});
    assert.throws(() => w.recordStage(rec(old)), e => e.code === 'LEASE_FENCED');
    w.recordStage(rec(fresh));
    assert.throws(() => w.recordStage(rec(fresh)), /already has a stage record/);
    assert.deepEqual(w.stages('one').map(s => s.outputs.by), ['b']);
    assert.equal(w.verify().ok, true);
  } finally { f.done(); }
});

// Question 8: a stage killed after its provider calls and before recordStage was invisible to spent(); after the
// lease the resume spent a full budget again (external calls 8, spent 4) and total_provider_calls did not bound calls
// across the restart. Calls are now CHARGED on the ledger before they are made (work.spend), and spent() counts the
// charges of a claim with no stage record.
test('a restart: calls charged before a kill stay counted, and the total bounds calls across the restart', async () => {
  const f = fixture([{item: 'k', title: 'K', state: 'Ready'}]);
  try {
    const external = {calls: 0};
    let n = 0;
    const plan = async ctx => {
      n++;
      ctx.charge(4); external.calls += 4;
      if (n === 1) await new Promise(() => {});   // killed after the calls, before the stage record
      return {...passed(4), findings: [{id: 'kept', text: 'the second run'}]};
    };
    const limits = {total_provider_calls: 20, stage_provider_calls: 10, lease_ms: 1000, iterations: 5};
    tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits, clock: () => T0});
    await new Promise(r => setTimeout(r, 50));
    const mid = openWorkLedger({root: f.workRoot});
    assert.deepEqual([mid.claims('k').length, mid.stages('k').length], [1, 0]);
    assert.deepEqual(spent(mid, {now: T0}), {calls: 4, unknown_counted_at_budget: 0, reserved: 6, charged: 4}, 'the killed calls are counted, the rest of the stage budget reserved');
    assert.deepEqual(spent(mid, {now: T0 + 5000}), {calls: 4, unknown_counted_at_budget: 0, reserved: 0, charged: 4}, 'past the lease: no reservation, the charges stay');
    const resumed = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits, clock: () => T0 + 5000});
    assert.equal(resumed.released_expired.length, 1);
    assert.equal(resumed.dispatched[0].status, 'passed');
    assert.equal(spent(openWorkLedger({root: f.workRoot}), {now: T0 + 5000}).calls, external.calls, 'the ledger counts every call that was made');
    // With a total of 12, the 4 charged before the kill leave 8: less than a stage's 10, so the resume is refused.
    const g = fixture([{item: 'k', title: 'K', state: 'Ready'}]);
    try {
      n = 0;
      tick({repo: g.repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: {plan}, limits: {...limits, total_provider_calls: 12}, clock: () => T0});
      await new Promise(r => setTimeout(r, 50));
      const r = await tick({repo: g.repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: {plan}, limits: {...limits, total_provider_calls: 12}, clock: () => T0 + 5000});
      assert.deepEqual(r.dispatched, []);
      assert.match(r.stopped, /provider-call budget: 8 left of 12/);
    } finally { g.done(); }
  } finally { f.done(); }
});

// Questions 1-3: with concurrency 2, two stages both passed the budget check (spent counted recorded stages only),
// both ran and both were recorded passed: 10 calls against a total of 5. A live claim now RESERVES its stage budget,
// so the second item is not dispatched.
test('concurrency: a dispatched stage reserves its budget; two stages cannot both start on the same remainder', async () => {
  const f = fixture([{item: 'a', title: 'A', state: 'Ready'}, {item: 'b', title: 'B', state: 'Ready'}]);
  try {
    const limits = {total_provider_calls: 5, stage_provider_calls: 5, concurrency: 2, iterations: 10};
    let running = 0, peak = 0;
    const plan = async ctx => { running++; peak = Math.max(peak, running); ctx.charge(5); await new Promise(r => setTimeout(r, 40)); running--; return passed(5); };
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits});
    assert.equal(peak, 1);
    assert.deepEqual(r.dispatched.map(d => d.status), ['passed']);
    assert.ok(spent(openWorkLedger({root: f.workRoot})).calls <= limits.total_provider_calls);
    assert.match(r.stopped ?? '', /provider-call budget/);
  } finally { f.done(); }
});

// Question 2: the scheduler recorded whatever usage a result reported, even above the stage budget, as `passed`.
// A result reporting more calls than its stage budget is now recorded failed with a named reason; and a charge over
// the stage budget is refused before the call.
test('a result reporting more calls than its stage budget is recorded failed (STAGE_BUDGET_EXCEEDED); an over-budget charge is refused', async () => {
  const f = fixture([{item: 'a', title: 'A', state: 'Ready'}, {item: 'b', title: 'B', state: 'Ready'}]);
  try {
    let refused = null;
    const plan = async ctx => {
      if (ctx.item === 'b') { try { ctx.charge(6); } catch (e) { refused = e.code; } return passed(0); }
      return passed(9);
    };
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits: {total_provider_calls: 100, stage_provider_calls: 5, iterations: 2}});
    const a = openWorkLedger({root: f.workRoot}).stages('a')[0];
    assert.equal(a.status, 'failed');
    assert.match(a.next.why, /^STAGE_BUDGET_EXCEEDED: .* 9 provider call\(s\), over its stage budget of 5/);
    assert.equal(refused, 'PROVIDER_CALL_LIMIT');
    assert.deepEqual(r.dispatched.map(d => `${d.item}:${d.status}`), ['a:failed', 'b:passed']);
  } finally { f.done(); }
});

// Question 9 (not a blocker alone): elapsed_ms was checked only between stages; a running stage kept making calls.
// The stage now gets ctx.signal, aborted at its elapsed budget; ctx.charge refuses calls after it; the stop is recorded.
test('the cooperative stop: past the stage\'s elapsed budget no call is admitted, and the stop is on the stage record', async () => {
  const f = fixture([{item: 'slow', title: 'Slow', state: 'Ready'}]);
  try {
    let made = 0, stoppedBy = null;
    const plan = async ctx => {
      for (;;) {
        try { ctx.charge(1); made++; } catch (e) { stoppedBy = e.code; break; }
        await new Promise(r => setTimeout(r, 15));
      }
      assert.equal(ctx.signal.aborted, true);
      return {...passed(made), status: 'failed', next: {stage: 'plan', why: 'stopped at the deadline'}};
    };
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits: {total_provider_calls: 1000, stage_provider_calls: 1000, elapsed_ms: 80, iterations: 5}});
    assert.equal(stoppedBy, 'STAGE_ELAPSED');
    assert.ok(made >= 1 && made < 20, `${made} call(s) admitted in 80 ms`);
    const s = openWorkLedger({root: f.workRoot}).stages('slow')[0];
    assert.deepEqual([s.outputs.stopped.code, s.outputs.stopped.charged], ['STAGE_ELAPSED', made]);
    assert.match(r.stopped, /elapsed/);
  } finally { f.done(); }
});

// Question 10: the run record's "fresh verification" re-opened the ledgers in the SAME process. The recorded verdict
// is now a child process's, which re-reads the item's stage records from the ledger itself.
test('verifyInChild: a separate node process verifies the work and status ledgers and reports a tampered chain', async () => {
  const f = fixture([{item: 'v', title: 'V', state: 'Ready'}]);
  try {
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: passPlan(f)}, limits: {total_provider_calls: 10, stage_provider_calls: 5, iterations: 1}});
    const before = statusLedgerState(f.statusRoot);
    const ok = await verifyInChild({workRoot: f.workRoot, item: 'v', statusRoot: f.statusRoot, statusBefore: before});
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.notEqual(ok.process.pid, process.pid);
    assert.deepEqual([ok.process.exit_code, ok.stages, ok.status.unchanged], [0, 1, true]);
    const chain = path.join(f.workRoot, 'chain.jsonl');
    fs.writeFileSync(chain, fs.readFileSync(chain, 'utf8').replace(/"seq":2,/, '"seq":7,'));
    const bad = await verifyInChild({workRoot: f.workRoot, item: 'v', statusRoot: f.statusRoot, statusBefore: before});
    assert.equal(bad.ok, false);
    assert.equal(bad.work.ok, false);
  } finally { f.done(); }
});

// Question 8, the fit implement stage: each attempt used a NEW pipeline directory and passed no checkpoints, so a kill
// after units were approved paid for every unit again, and the in-run findings that lived only in the killed run's
// pipeline.json were lost. Approved units now persist in one checkpoint directory per item (re-verified on resume),
// and the findings of an interrupted attempt on the same plan are carried into the next attempt's record.
test('LIFECYCLE (fit): an implement stage killed after its units were approved resumes them from checkpoints and keeps the killed run\'s findings', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = gitFixture(repo, [{item: 'ticketed'}], {tickets: ['ticketed']});
    ctx.agyWorker('printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n');
    const FINDING = 'the first attempt is not good enough';
    const turn = scriptedTurn({'unit-review': ({k, rubric, passed}) => JSON.stringify(k === 1 || !passed ? unitReject(rubric, [FINDING]) : unitApprove(rubric))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    const limits = {...FIT_LIMITS, iterations: 2};   // plan, then implement
    let kills = 1, finished;
    const done = new Promise(r => { finished = r; });
    const implement = async c => { const out = await ex.implement(c); if (kills-- > 0) { finished(out); await new Promise(() => {}); } return out; };
    tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {...ex, implement}, limits});
    const killed = await done;
    assert.equal(killed.status, 'passed', 'the killed attempt had approved and integrated its unit');
    const w = openWorkLedger({root: f.workRoot});
    const claim1 = w.claims('ticketed').find(c => c.stage === 'implement');
    const charged1 = Math.max(...w.spends(claim1.hash).map(s => s.provider_calls));
    assert.ok(charged1 >= 4, `the killed attempt's calls were charged before they were made (${charged1})`);
    const calls1 = turn.log.length;
    // The lease expires; the next tick releases the claim and resumes implement.
    const later = Date.now() + 31 * 60_000;
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...limits, iterations: 1}, clock: () => later});
    assert.deepEqual(r.released_expired.map(x => x.stage), ['implement']);
    const impl = openWorkLedger({root: f.workRoot}).stages('ticketed').find(s => s.stage === 'implement');
    assert.equal(impl.status, 'passed', JSON.stringify([impl.next, impl.outputs.error]));
    const run = JSON.parse(fs.readFileSync(impl.outputs.run.record, 'utf8'));
    assert.deepEqual([run.units.alpha.resumed, run.provider_calls.total], [true, 0], 'the approved unit was resumed, not paid for again');
    assert.equal(run.units.alpha.checkpoint.reverified.exit_code, 0, 'its verify_cmd was re-run on the resumed tree');
    assert.equal(turn.log.length, calls1, 'no provider was asked again');
    assert.deepEqual(impl.findings.filter(x => x.text === FINDING).map(x => [x.cause, x.carried_from?.attempt]), [['in-run-review', 1]]);
    // Every finding of the killed run (the reviewer's finding and its unmet criterion) is carried, marked with its run.
    assert.ok(impl.findings.length >= 2 && impl.findings.every(x => x.carried_from?.record && x.carried_from.attempt === 1), JSON.stringify(impl.findings));
    assert.deepEqual(impl.outputs.carried_runs.map(x => x.findings), [impl.findings.length]);
    assert.ok(spent(openWorkLedger({root: f.workRoot}), {now: later}).calls >= charged1 + 1, 'the killed attempt\'s charges count toward the total');
  });
});
