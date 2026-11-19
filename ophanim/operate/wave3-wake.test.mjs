// Wave 3 (sub-wave 3B-1), register L-106: THE STATUS-ENTRY WAKE, for every stage that can wait on one.
//
// THE CLASS (enumerated from the code, gates.mjs earliestGate and reconcile.mjs):
//   W1 plan       a plan attempt pending or blocked on a STRUCTURAL blocker: wakeOf(lastPlan).
//   W2 implement  W3 review  W4 validate  W5 outcome
//                 the attempt handed off from the last reusable record, pending or blocked on a structural blocker:
//                 wakeOf(latestTry). (A transient pending is retried when due instead, by design, not woken.)
//   W6 any stage  an ATTEMPT_IDENTITY_COLLISION block (reconcile.mjs): the gate routes a stage whose identical attempt
//                 completed; it resumes when the routing basis changes, a new status entry included (attemptInputs).
//   W7 any stage  the scheduler's attempt bound (stage_attempts failed attempts on the same inputs); a new status entry is
//                 a new attempt identity.
// For each: (a) the waiting attempt is NOT re-run while the item's status entry is unchanged, (b) it IS run again once
// the owner records a new entry, once per entry, and (c) a new entry of one item wakes that item only. Through the
// scheduler's `tick` and through the execution service (service.mjs runService: `watch` on the input signature, the
// production trigger), with scripted stage executors (the scheduler's injection point: the property lives in the gate,
// reconcile and the scheduler); and W3 again over the real stage executors. No provider is called.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {readServiceConfig, runService, SERVICE_CONFIG_SCHEMA} from './service.mjs';
import {makeExecutors} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture as gitFixture, scriptedTurn, LIMITS as GIT_LIMITS, SIX, stagesOf} from './test-fixtures.mjs';

const L106 = 'L-106 status-entry wake';
const STAGES = ['plan', 'implement', 'review', 'validate', 'outcome'];
const LIMITS = {total_provider_calls: 1000, stage_provider_calls: 10};
const ITEMS = ['a', 'b'];

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-wake-'));
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const item of ITEMS) S.set({item, title: `Item ${item}`, basis: `the requirement of ${item}`, state: 'Ready', checked: '2026-11-17'});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, S, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
// The owner records a new status entry of the item, title and basis unchanged: its signed resume. 'Ready' again is also a
// new latest Ready entry (which the requirement the attempt identity digests names); 'In progress' is a new entry and
// nothing else, so it isolates the status-entry fields of the identity.
const reEntry = (S, item, state) => { const s = S.board().items.find(i => i.item === item); S.set({item, title: s.title, basis: s.basis, state, checked: '2026-11-19'}); };
const reReady = (S, item) => reEntry(S, item, 'Ready');
const inProgress = (S, item) => reEntry(S, item, 'In progress');
/**
 * Scripted executors: every stage before `stage` hands on; `stage` waits on a structural blocker (`as`: blocked, or a
 * pending that is not transient). Every dispatch is logged with the gate it was given.
 */
function executors(stage, as) {
  const seen = [];
  const make = s => async ctx => {
    seen.push({item: ctx.item, stage: s, wake: ctx.gate.wake ?? null, retry_of: ctx.gate.retry_of ?? null, entry: ctx.gate.entry});
    const base = {team: [{role: s}], contributions: [], findings: [], usage: {provider_calls: 1}};
    if (s !== stage) return {...base, status: 'passed', outputs: {[s]: `${ctx.item}-${seen.length}`, deps: {}, evidence: []}, next: {stage: STAGES[STAGES.indexOf(s) + 1] ?? null, why: 'handed on'}};
    return {...base, status: as, outputs: {waiting: seen.length}, next: {stage: s, why: 'waits on its owner'},
      blocker: {code: 'OWNER_INPUT', what: `${s} waits on input only the owner can give`, role: 'decision-authority', resume_when: 'the owner records a new status entry of the item'}};
  };
  return {ex: Object.fromEntries(STAGES.map(s => [s, make(s)])), seen};
}
const waiting = (f, stage) => Object.fromEntries(reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})}).items
  .map(i => [i.item, `${i.gate.gate}:${i.gate.stage ?? ''}`]));
const at = (t, stage) => t.dispatched.filter(d => d.stage === stage).map(d => d.item);
const last = (f, item, stage) => openWorkLedger({root: f.workRoot}).stages(item).filter(s => s.stage === stage).at(-1);

const ROWS = [...STAGES.map(stage => ({stage, as: 'blocked'})), {stage: 'plan', as: 'pending'}, {stage: 'review', as: 'pending'}];

// ---- W1-W5 through tick ---------------------------------------------------------------------------------------------
for (const {stage, as} of ROWS) {
  test(`${L106}, ${stage} ${as} on a structural blocker, through tick: not re-run on an unchanged entry, run again once per new entry, and only for that item`, async () => {
    const f = fixture();
    try {
      const {ex, seen} = executors(stage, as);
      const run = () => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
      const t1 = await run();
      assert.deepEqual(at(t1, stage), ITEMS, `both items reach ${stage} and wait`);
      assert.deepEqual(waiting(f, stage), {a: `blocked:${stage}`, b: `blocked:${stage}`});
      // (a) unchanged: nothing is re-run, and each is reported blocked.
      const t2 = await run();
      assert.deepEqual(t2.dispatched, [], 'an unchanged status entry re-runs nothing');
      assert.deepEqual(t2.blocked.map(x => x.item).sort(), ITEMS);
      // (b) a new entry of `a` (In progress: the requirement's Ready entry is unchanged) runs a's waiting stage again, as a
      // status wake of that attempt; (c) b stays waiting.
      const waited = last(f, 'a', stage);
      inProgress(f.S, 'a');
      const t3 = await run();
      assert.deepEqual(t3.dispatched.map(d => `${d.item}:${d.stage}`), [`a:${stage}`], 'only the item whose entry changed, only its waiting stage');
      assert.deepEqual(seen.at(-1), {item: 'a', stage, wake: 'status', retry_of: waited.hash, entry: f.S.board().items.find(i => i.item === 'a').entry});
      assert.notEqual(last(f, 'a', stage).inputs.status_entry, waited.inputs.status_entry, 'the woken attempt names the new entry');
      assert.deepEqual(waiting(f, stage), {a: `blocked:${stage}`, b: `blocked:${stage}`});
      // Once per entry.
      assert.deepEqual((await run()).dispatched, [], 'the same new entry wakes once');
      // And b in its turn, alone (Ready again: a new entry that is also a new Ready entry).
      reReady(f.S, 'b');
      assert.deepEqual((await run()).dispatched.map(d => `${d.item}:${d.stage}`), [`b:${stage}`]);
      assert.equal(seen.filter(s => s.stage === stage).length, 4, 'each item ran the stage twice: its first attempt and one wake');
    } finally { f.done(); }
  });
}

// ---- W1-W5 through the execution service (watch on the input signature) --------------------------------------------------
for (const {stage, as} of ROWS) {
  test(`${L106}, ${stage} ${as} on a structural blocker, through the service: the trigger re-runs nothing until a new entry, then wakes only that item`, async () => {
    const f = fixture();
    try {
      const file = path.join(f.repo, 'operate.json');
      fs.writeFileSync(file, JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', issues: {source: 'none'}, interval_s: 10, limits: LIMITS}));
      const {ex, seen} = executors(stage, as);
      // Between the service's turns: turn 1 runs the items to `stage`; nothing changes before turn 2; `a`'s owner records
      // a new entry before turn 3; nothing before turn 4.
      let turn = 0;
      const sleep = async () => { turn++; if (turn === 2) inProgress(f.S, 'a'); };
      const r = await runService({config: readServiceConfig(file), executors: ex, maxTicks: 4, sleep});
      assert.equal(r.code, 0);
      assert.equal(r.ticks.length, 2, 'the service ticked on its first turn and on the new entry only');
      assert.deepEqual(at(r.ticks[0], stage), ITEMS);
      assert.deepEqual(r.ticks[1].dispatched.map(d => `${d.item}:${d.stage}`), [`a:${stage}`], 'the new entry wakes a, and only a');
      assert.equal(seen.at(-1).wake, 'status');
      const log = fs.readFileSync(path.join(f.repo, 'status', 'operate', 'service', 'service.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      assert.equal(log.filter(e => e.event === 'tick').length, 2);
    } finally { f.done(); }
  });
}

// ---- W6: an attempt identity collision resumes on a new entry -------------------------------------------------------------
test(`${L106}, W6: a stage blocked on an attempt identity collision (validate, resting on a view nothing here re-reads) waits, and is run again once per new entry of its item only`, async () => {
  const f = fixture();
  try {
    const seen = [];
    const pass = s => async ctx => {
      seen.push({item: ctx.item, stage: s});
      const outputs = s === 'validate' ? {verdict: 'accept', sources: [{ref: 'issue:9', delivered: true, source: 'issue:9', version: 'sha256:' + '9'.repeat(64), request: {op: 'issue', number: 9}}]}
        : {[s]: `${ctx.item}-${seen.length}`, deps: {}, evidence: []};
      return {status: 'passed', outputs, team: [{role: s}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: STAGES[STAGES.indexOf(s) + 1] ?? null, why: 'handed on'}};
    };
    const ex = Object.fromEntries(STAGES.map(s => [s, pass(s)]));
    const run = () => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const t1 = await run();
    assert.deepEqual(at(t1, 'validate'), ['a', 'a', 'b', 'b'], 'validated, re-validated once on its stale view, then refused on the same basis');
    const coll = () => Object.fromEntries(reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})}).items.map(i => [i.item, i.gate.blocker?.code ?? i.gate.gate]));
    assert.deepEqual(coll(), {a: 'ATTEMPT_IDENTITY_COLLISION', b: 'ATTEMPT_IDENTITY_COLLISION'});
    assert.deepEqual((await run()).dispatched, [], '(a) unchanged: not re-run');
    inProgress(f.S, 'a');
    assert.deepEqual((await run()).dispatched.map(d => `${d.item}:${d.stage}`), ['a:validate'], '(b, c) the new entry of a: a, once');
    assert.deepEqual(coll(), {a: 'ATTEMPT_IDENTITY_COLLISION', b: 'ATTEMPT_IDENTITY_COLLISION'});
    assert.deepEqual((await run()).dispatched, []);
    reReady(f.S, 'b');
    assert.deepEqual((await run()).dispatched.map(d => `${d.item}:${d.stage}`), ['b:validate'], 'and b on its own new entry');
  } finally { f.done(); }
});

// ---- W7: the scheduler's attempt bound resumes on a new entry -------------------------------------------------------------
test(`${L106}, W7: a stage that failed its attempt bound on the same inputs waits, and is run again once per new entry of its item only`, async () => {
  const f = fixture();
  try {
    const seen = [];
    const ex = Object.fromEntries(STAGES.map(s => [s, async ctx => {
      seen.push({item: ctx.item, stage: s});
      if (s === 'implement') throw new Error('the implementation tool crashed');
      return {status: 'passed', outputs: {[s]: ctx.item, deps: {}, evidence: []}, team: [{role: s}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'handed on'}};
    }]));
    const run = () => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, stage_attempts: 2}});
    for (let k = 0; k < 2; k++) assert.deepEqual(at(await run(), 'implement'), ITEMS);
    const t = await run();
    assert.deepEqual(t.dispatched, [], '(a) the bound is reached on the same inputs: not re-run');
    assert.deepEqual(t.blocked.filter(b => b.gate === 'implement').map(b => b.item), ITEMS);
    inProgress(f.S, 'a');
    assert.deepEqual((await run()).dispatched.map(d => `${d.item}:${d.stage}`), ['a:implement'], '(b, c) the new entry of a: a, once');
    assert.deepEqual(at(await run(), 'implement'), ['a'], 'the new entry is a new attempt identity: its own bound');
    assert.deepEqual((await run()).dispatched, []);
    reReady(f.S, 'b');
    assert.deepEqual((await run()).dispatched.map(d => `${d.item}:${d.stage}`), ['b:implement'], 'and b on its own new entry');
  } finally { f.done(); }
});

// ---- W3 over the real stage executors -------------------------------------------------------------------------------------
test(`${L106}, W3 over the real executors: a change review pending on capacity is not re-asked on an unchanged pool and entry, and is re-asked once for the item whose owner records a new entry`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = gitFixture(repo, [{item: 'cap-a'}, {item: 'cap-b'}]);
    const turn = scriptedTurn();
    const six = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    // The four configured labs for the review: the planner's and implementers' labs contributed, so no three are left.
    const four = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17'});
    const ex = {plan: six.plan, implement: six.implement, review: four.review};
    const r1 = await tick({repo, ...f, executors: ex, limits: GIT_LIMITS});
    assert.deepEqual(r1.dispatched.filter(d => d.stage === 'review').map(d => `${d.item}:${d.status}`), ['cap-a:pending', 'cap-b:pending']);
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.stages('cap-a').at(-1).blocker.code, 'REVIEW_CAPACITY_PENDING');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: ex, limits: GIT_LIMITS})), [], '(a) the same pool and entry: not re-asked');
    const reviewers = () => turn.log.filter(l => l.kind === 'review').length;
    const before = reviewers();
    reReady(f.S, 'cap-a');
    const r3 = await tick({repo, ...f, executors: ex, limits: GIT_LIMITS});
    assert.deepEqual(r3.dispatched.map(d => `${d.item}:${d.stage}:${d.status}`), ['cap-a:review:pending'], '(b, c) re-asked for cap-a only, still short of labs');
    assert.notEqual(w.stages('cap-a').at(-1).inputs.status_entry, w.stages('cap-b').at(-1).inputs.status_entry);
    assert.equal(reviewers(), before, 'no reviewer is called when the pool is short');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: ex, limits: GIT_LIMITS})), [], 'once per entry');
  });
});
