// SELF-AUDIT repro (assignment 1, Q5). PASSING = DEFECT PRESENT.
// Only the PLAN's cited evidence is bound by digest and re-checked on reuse (gates.mjs planValidity). The validator
// (and the change reviewers) also judge from evidence they retrieve -- consumers of the changed files, earlier
// findings -- but the validate record keeps its cited `sources` as {ref, delivered, complete} with no version, and
// nothing re-checks them: when a file the validator relied on changes, the validation is reused and the item goes on
// to its outcome.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, json, ACCEPT, LIMITS, SIX, stagesOf} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: a file the validator retrieved and relied on changes; the validation is still reused', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    fs.writeFileSync(path.join(repo, 'consumer-contract.md'), 'Importers of alpha.mjs require ok to be a boolean.\n');
    const f = fixture(repo, [{item: 'val-ev'}]);
    const turn = scriptedTurn({validator: ({k}) => (k === 1
      ? json({requests: [{op: 'file', path: 'consumer-contract.md'}]})
      : json({...JSON.parse(/```json\n([\s\S]*)\n```/.exec(ACCEPT)[1]), sources: ['consumer-contract.md']}))});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r = await tick({repo, ...f, executors: {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate}, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed'], JSON.stringify(r.dispatched));
    const w = openWorkLedger({root: f.workRoot});
    const val = w.stages('val-ev').find(s => s.stage === 'validate');
    const src = val.outputs.sources.find(s => s.ref === 'file:consumer-contract.md');
    assert.ok(src && src.delivered, 'the validator cited a delivered file');
    assert.equal(src.version, undefined, 'DEFECT: the cited source carries no version');
    // The contract the validator relied on changes.
    fs.writeFileSync(path.join(repo, 'consumer-contract.md'), 'Importers of alpha.mjs now require ok to be the string "yes".\n');
    const g = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'val-ev').gate;
    assert.equal(g.gate, 'outcome', 'DEFECT: the validation is reused on changed evidence');
    assert.equal(g.reuse.validate, val.hash);
    assert.deepEqual(g.stale, []);
  });
});
