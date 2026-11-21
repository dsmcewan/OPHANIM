// Stage 1 is seated from the item's own declared difficulty and stakes (owner direction 2026-11-18), and the
// model-level review rule is the default under `fit`. The plan stage only; every seat is scripted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors, independenceFor, REVIEW_INDEPENDENCE} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, TICKET, LIMITS} from './test-fixtures.mjs';

test('the model-level rule is the default under fit; other profiles keep the configured rule', () => {
  assert.equal(REVIEW_INDEPENDENCE, 'lab', 'the configured rule outside fit is unchanged');
  assert.equal(independenceFor('fit'), 'model');
  assert.equal(independenceFor('argo'), 'lab');
  assert.equal(independenceFor('legacy'), 'lab');
});

test("the planner is seated from the ticket's difficulty and stakes: easy, medium, hard, and a critical easy ticket; an item without a ticket plans at medium", async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const want = {fresh: 'claude-opus-5-5', easy: 'claude-sonnet-5', medium: 'claude-opus-5-5', hard: 'claude-fable-5-2', critical: 'claude-fable-5-2'};
    const f = fixture(repo, Object.keys(want).map(item => ({item})), {tickets: ['easy', 'medium', 'hard', 'critical']});
    const declare = (item, extra) => fs.writeFileSync(path.join(repo, 'tickets', `${item}.json`), JSON.stringify({...TICKET(item), ...extra}, null, 2) + '\n');
    declare('easy', {difficulty: 'easy'}); declare('medium', {difficulty: 'medium'}); declare('hard', {difficulty: 'hard'});
    declare('critical', {difficulty: 'easy', stakes: 'critical'});
    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});   // profile and independence: the defaults
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    for (const [item, model] of Object.entries(want)) {
      const plan = w.stages(item).find(s => s.stage === 'plan');
      assert.ok(plan, `${item} was planned`);
      const seat = plan.team.find(t => t.role === 'planner');
      assert.equal(`${seat.vendor}/${seat.model}`, `anthropic/${model}`, item);
      // The tier is ON the record, always (independent review, assignment 1, Google gemini-4-carbon, 09d490f, question 4:
      // this assertion used to sit behind `if (tier)`, and `tier` was never recorded, so it never ran).
      const tier = plan.outputs.planner?.selection?.tier;
      assert.ok(tier, `${item}: the planner's tier is recorded`);
      assert.equal(tier.source, item === 'fresh' ? 'no ticket: medium' : 'ticket', item);
      assert.deepEqual(seat.tier, tier, `${item}: the team row names the same tier`);
      if (item === 'fresh') assert.deepEqual(tier.declared, {}, 'an item without a ticket declares nothing');
    }
    // The planner turns were made by those models.
    const planners = turn.log.filter(l => l.kind === 'planner').map(l => l.model);
    for (const m of new Set(Object.values(want))) assert.ok(planners.includes(m), m);
  });
});
