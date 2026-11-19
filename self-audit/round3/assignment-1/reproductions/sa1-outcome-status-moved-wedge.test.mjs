// SELF-AUDIT repro (assignment 1, Q1/Q10). PASSING = DEFECT PRESENT.
// The outcome's bundle is bound to the status entry the implementation was made against (made_against). If the owner
// records any new status entry of the item in between -- even the same Ready requirement, re-checked on a later date --
// proposeFromBundle refuses ("re-dispatch it") and the outcome is recorded BLOCKED (structural). Its resume_when says
// "the item is re-dispatched against its current status", but nothing re-dispatches it: the gate routes a blocked
// latest attempt to `blocked`, and the requirement digest (item, title, basis) is unchanged. The item never reaches
// an outcome.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, LIMITS, SIX, stagesOf} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: an outcome blocked because the status moved is never re-dispatched', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'moved'}]);
    const turn = scriptedTurn();
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r1 = await tick({repo, ...f, executors: {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed']);
    // The owner re-records the same Ready requirement (a later check date).
    const s = f.S.board().items.find(i => i.item === 'moved');
    f.S.set({item: 'moved', title: s.title, basis: s.basis, state: 'Ready', checked: '2026-11-19'});
    const r2 = await tick({repo, ...f, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r2), ['outcome:blocked']);
    const w = openWorkLedger({root: f.workRoot});
    assert.match(w.stages('moved').at(-1).blocker.what, /status changed since the run started/);
    for (let i = 0; i < 2; i++) {
      const r = await tick({repo, ...f, executors: ex, limits: LIMITS});
      assert.deepEqual(r.dispatched, [], 'DEFECT: never re-dispatched');
    }
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'moved').gate.gate, 'blocked');
  });
});
