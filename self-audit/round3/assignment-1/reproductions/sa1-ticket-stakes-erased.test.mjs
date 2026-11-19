// SELF-AUDIT repro (assignment 1, Q4). PASSING = DEFECT PRESENT.
// The planner is seated from the ticket's declared difficulty AND stakes. But a plan that revises the ticket
// rewrites tickets/<item>.json from ticketOf(), which carries `difficulty` (the planner's own choice) and drops
// `stakes`, `ambiguity` and `depth`. The next plan of the same item is then seated without the declared stakes:
// a critical item drops from the hard planner to the easy one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {readTicket} from '../pantheon/src/board/operate.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, TICKET, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

test('DEFECT: a revised ticket loses its declared stakes, and the next planner is seated below them', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'crit'}], {tickets: ['crit']});
    fs.writeFileSync(path.join(repo, 'tickets', 'crit.json'), JSON.stringify({...TICKET('crit'), difficulty: 'easy', stakes: 'critical'}, null, 2) + '\n');
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, /Mode: revalidate/.test(prompt)
      ? {ticket_assessment: {still_valid: false, reasons: ['the acceptance command needs a parse check as well']},
        acceptance: [{id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd: 'node verify.mjs'}}, {id: 'a2', criterion: 'alpha.mjs parses', test: {cmd: 'node --check alpha.mjs'}}]}
      : {}))});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const first = w.stages('crit')[0];
    assert.equal(first.status, 'passed');
    assert.equal(first.team.find(t => t.role === 'planner').model, 'claude-fable-5-2', 'the first planner honours stakes: critical');
    const t = readTicket({repo, item: 'crit'});
    assert.equal(t.spec.stakes, undefined, 'DEFECT: the rewritten ticket no longer declares stakes');
    // The owner restates the requirement (new inputs, so a new plan is dispatched).
    f.S.set({item: 'crit', title: 'Alpha for crit', basis: 'restated: alpha.mjs exports ok = true and parses', state: 'Ready', checked: '2026-11-19'});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const second = openWorkLedger({root: f.workRoot}).stages('crit').filter(s => s.stage === 'plan')[1];
    assert.ok(second, 'a second plan was made');
    const seat = second.team.find(t => t.role === 'planner');
    assert.notEqual(seat.model, 'claude-fable-5-2', 'DEFECT: the critical item is no longer planned by the hard planner');
    assert.deepEqual(second.outputs.planner.selection.tier.declared, {difficulty: 'easy'});
  });
});
