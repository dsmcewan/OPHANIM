// SELF-AUDIT repro (assignment 1, Q5/Q7). PASSING = DEFECT PRESENT.
// buildDossier's `stable` digest is meant to leave out the work ledger ("recording an attempt does not itself look like
// new evidence", context.mjs). It drops the `work:` entry, but that entry still spends the dossier's shared
// dossier_bytes budget, so the entries after it are cut or omitted differently once an attempt is recorded. A plan
// that blocked on EVIDENCE_INSUFFICIENT is then "woken" by its own record and paid for again, in the same tick, on
// unchanged evidence. Control: with a short requirement (budget not binding) the plan is made once.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, json, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

const run = async (basis) => {
  let out;
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target', basis}]);
    const turn = scriptedTurn({planner: () => json({insufficient: {gaps: ['the cause is not visible'], needed: ['a trace']}})});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    const r = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const recs = openWorkLedger({root: f.workRoot}).stages('target');
    out = {dispatched: r.dispatched.map(d => `${d.stage}:${d.status}`), planners: turn.log.filter(l => l.kind === 'planner').length,
      stables: recs.map(s => s.outputs.context.dossier.stable), codes: recs.map(s => s.blocker?.code)};
  });
  return out;
};

test('control: a short requirement -- the evidence-blocked plan is made once', async () => {
  const r = await run('the requirement: alpha.mjs exports ok = true');
  assert.deepEqual(r.dispatched, ['plan:blocked']);
  assert.equal(r.planners, 1);
});

test('DEFECT: a long requirement -- the same unchanged evidence is planned twice in one tick', async () => {
  // ~71 KB: the requirement entry is never cut, so the rest of the 80 KB initial view is tight.
  const r = await run('the requirement: alpha.mjs exports ok = true. ' + 'Context paragraph. '.repeat(3747));
  assert.deepEqual(r.codes, ['EVIDENCE_INSUFFICIENT', 'EVIDENCE_INSUFFICIENT']);
  assert.deepEqual(r.dispatched, ['plan:blocked', 'plan:blocked'], 'DEFECT: re-planned on unchanged evidence');
  assert.equal(r.planners, 2, 'DEFECT: a second planner call was paid for');
  assert.notEqual(r.stables[0], r.stables[1], 'the stable digest moved although only the work ledger changed');
});
