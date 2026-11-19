// SELF-AUDIT repro (assignment 1, Q1/Q5). PASSING = DEFECT PRESENT.
// (a) A plan that cites a dossier-derived view (the consumers view) is stale the moment it passes, because the plan
//     stage's OWN consequence -- tickets/<item>.json written into the working tree -- changes the rebuilt dossier
//     (reconcile.mjs dossierViews rebuilds against the current tickets/ dir; only the work ledger is cut back to
//     "before the plan").
// (b) The stale plan is then never re-planned: the new plan claim has the same inputs {upstream: null, requirement}
//     as the passed one, so the work ledger refuses it as "already completed for these exact inputs". The item is
//     wedged at gate `plan`, skipped on every tick, and never reaches implement.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: a plan citing the consumers view is stale right after it passes, and the item is then wedged', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    // A natural citation: operational_position rests on the dossier's consumers view.
    const turn = scriptedTurn({planner: ({prompt}) => {
      const p = planFor(prompt);
      p.investigation.operational_position.sources = ['verify.mjs', 'consumers:target'];
      return json(p);
    }});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    const r1 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(r1.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const p = w.stages('target')[0];
    assert.ok(p.outputs.evidence.some(e => e.source === 'consumers:target'), 'the plan binds the consumers view');
    // Nothing outside the lifecycle changed. The approved plan should be reused (gate implement).
    const g = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'target').gate;
    assert.equal(g.gate, 'plan', 'DEFECT (a): the just-approved plan is already stale');
    assert.match(JSON.stringify(g.stale), /consumers:target changed/);
    // (b) Three more ticks: nothing is dispatched, the plan claim is refused every time.
    for (let i = 0; i < 3; i++) {
      const r = await tick({repo, ...f, executors: {plan: ex.plan, implement: ex.implement}, limits: LIMITS});
      assert.deepEqual(r.dispatched, [], 'DEFECT (b): nothing runs');
      assert.match(JSON.stringify(r.skipped), /already completed for these exact inputs/, 'DEFECT (b): the re-plan is refused by the idempotency key');
    }
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
  });
});
