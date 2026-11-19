// SELF-AUDIT repro (assignment 1, Q3). PASSING = DEFECT PRESENT.
// Under `fit` a planner ANSWER without work_units is refused (planRefusal, workUnits 'required'). But a plan version
// whose review cycle is RESUMED is taken from the cycle head and never re-checked: a version opened under another
// profile (no work_units) and finished by a `fit` executor is approved and recorded passed under fit with no units;
// its implement stage then silently takes the per-file runOpenItem path (stages.mjs implement: "a plan record without
// them ... keeps the per-file path").
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS, APPROVE} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: a resumed plan cycle is approved under fit without work_units', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'units'}]);
    let down = true;
    const turn = scriptedTurn({
      planner: ({prompt}) => { const p = planFor(prompt); delete p.work_units; return json(p); },
      'plan-review': ({vendor}) => { if (down && vendor === 'xai') throw new Error('xai unavailable'); return APPROVE; },
    });
    let t = Date.parse('2026-11-19T00:00:00Z');
    const L = {...LIMITS, retry_after_ms: 60_000};
    const argo = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'lab'});
    const r1 = await tick({repo, ...f, executors: {plan: argo.plan}, limits: L, clock: () => t});
    assert.deepEqual(r1.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:pending']);
    // The same open cycle is finished by a `fit` executor.
    down = false; t += 120_000;
    const fit = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'fit', independence: 'lab'});
    const r2 = await tick({repo, ...f, executors: {plan: fit.plan}, limits: L, clock: () => t});
    assert.deepEqual(r2.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed'], JSON.stringify(r2));
    const p = openWorkLedger({root: f.workRoot}).stages('units').at(-1);
    assert.equal(p.status, 'passed');
    assert.equal(p.outputs.plan.work_units, undefined, 'DEFECT: approved under fit with no work_units');
  });
});
