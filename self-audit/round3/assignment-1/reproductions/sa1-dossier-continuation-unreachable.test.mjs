// SELF-AUDIT repro (assignment 1, Q6). PASSING = DEFECT PRESENT.
// A cut DERIVED dossier view (relations, consumers, guess, runs, index) names its continuation as
// {"op":"dossier","source":...,"offset":N}. The derived bytes are attached to the dossier (d.views), but the retriever
// the stages give their seats (stages.mjs evidenceFor -> makeRetriever without dossierViews) cannot serve that op:
// every seat's continuation of a cut derived view fails NOT_FOUND, so the gap can never be resolved. The existing test
// (lifecycle-evidence-review.test.mjs "a cut dossier view carries its continuation") builds its own retriever with
// dossierViews: d.views, which no stage does.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: the planner cannot continue a cut relations view; its continuation fails NOT_FOUND', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'target'}]);
    for (let i = 0; i < 60; i++) f.S.set({item: `dep-${i}`, title: `Dep ${i}`, state: 'Ready', basis: 'b'.repeat(100), depends_on: ['target'], checked: '2026-11-18'});
    let next = null;
    const turn = scriptedTurn({planner: ({prompt, item, k}) => {
      if (item !== 'target') return json(planFor(prompt));
      const line = prompt.split('\n').find(l => l.includes('source: status:target#relations') && l.includes('PARTIAL'));
      const m = line ? /\| next: (\{.*\})$/.exec(line) : null;
      if (k === 1 || (m && !next)) { next = JSON.parse(m[1]); return json({requests: [next]}); }
      return json(planFor(prompt));
    }});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS, only: 'target'});
    assert.ok(next, 'the relations view was cut and named its continuation');
    assert.equal(next.op, 'dossier');
    const p = openWorkLedger({root: f.workRoot}).stages('target')[0];
    const reqs = p.outputs.context.investigations.filter(x => x.role === 'planner').flatMap(x => x.requests);
    const asked = reqs.find(r => r.request?.op === 'dossier');
    assert.ok(asked, 'the planner asked for the continuation');
    assert.equal(asked.ok, false, 'DEFECT: the continuation is not served');
    assert.equal(asked.error, 'NOT_FOUND');
    const gap = p.outputs.context.unresolved.find(u => u.source === 'status:target#relations');
    assert.ok(gap, 'the gap stays unresolved, pointing at a request no seat can run');
  });
});
