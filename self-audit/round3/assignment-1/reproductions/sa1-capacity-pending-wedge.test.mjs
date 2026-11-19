// SELF-AUDIT repro (assignment 1, Q1/Q7). PASSING = DEFECT PRESENT.
// A plan that is pending on review CAPACITY (a structural, non-transient blocker whose resume_when is "a reviewer lab
// outside the contributors becomes available") is never dispatched again once capacity exists: gates.mjs routes a
// pending/blocked last plan on the same requirement to `blocked` unless it is transient-and-due or EVIDENCE_INSUFFICIENT
// with changed evidence. Nothing the gate reads can express "capacity came back", and re-recording the item Ready with
// the same title and basis gives the same requirement digest, so even the owner's natural "resume" does nothing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {SEATING} from '../pantheon/src/role/seating.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: a capacity-pending plan is never retried after capacity returns, nor after the owner re-records it Ready', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn();
    // A short reviewer pool: only xai remains outside the planner's lab.
    const short = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'lab',
      seating: Object.fromEntries(Object.entries(SEATING).map(([k, v]) => [k, Array.isArray(v) ? v.filter(r => r.vendor === 'xai') : v]))});
    const r1 = await tick({repo, ...f, executors: {plan: short.plan}, limits: LIMITS});
    assert.deepEqual(r1.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:pending']);
    const p = openWorkLedger({root: f.workRoot}).stages('target')[0];
    assert.match(p.blocker.what, /REVIEW_CAPACITY_PENDING/);
    assert.ok(!p.blocker.transient, 'a structural blocker');
    // Capacity returns (the configured pool).
    const full = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'lab'});
    const r2 = await tick({repo, ...f, executors: {plan: full.plan}, limits: LIMITS});
    assert.deepEqual(r2.dispatched, [], 'DEFECT: capacity is back, nothing is dispatched');
    assert.equal(r2.blocked.find(b => b.item === 'target')?.gate, 'blocked');
    // The owner re-records the item Ready (same title and basis): still blocked.
    const latest = f.S.board().items.find(i => i.item === 'target');
    f.S.set({item: 'target', title: latest.title, basis: latest.basis, state: 'Ready', checked: '2026-11-19'});
    const r3 = await tick({repo, ...f, executors: {plan: full.plan}, limits: LIMITS});
    assert.deepEqual(r3.dispatched, [], 'DEFECT: re-recording Ready does not resume it either');
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 0, 'nothing was ever planned');
  });
});
