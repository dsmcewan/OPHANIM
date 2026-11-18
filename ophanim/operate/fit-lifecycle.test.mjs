// THE LIFECYCLE UNDER ITS DEFAULT ROUTING PROFILE, `fit` (owner direction 2026-11-17; the matrix is
// pantheon/src/route/fit-matrix.mjs). Complete lifecycle runs: the scheduler, the stage executors, Pantheon's run and
// the ledgers, end to end, with NO profile named. Seats are scripted (the API providers) or the fixture's fake agy CLI
// (the Antigravity lanes): these show routing, escalation and recording, not model judgment and not a live quota.
//
// What the current lifecycle exercises of the matrix: the planner, the implementer (an Antigravity lane) and the
// in-run reviewer (the dispatcher's model for the unit's difficulty). It seats no dispatcher or subagent yet.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors, REVIEW_INDEPENDENCE} from './stages.mjs';
import {statelessHooks, FINDING} from './test-restart-child.mjs';
import {resolveModel, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {fitMatrix, IMPLEMENTER_LADDERS, pinnedReviewer, selectionPolicy} from '../../pantheon/src/route/frontier.mjs';
import {verifyEscalation} from '../../pantheon/src/route/protocol.mjs';
import {withDispatch, WORK} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, LIMITS} from './test-fixtures.mjs';

const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
const idOf = t => resolveModel(t.vendor, t.model).id;
const runJson = rec => JSON.parse(fs.readFileSync(path.join(rec.outputs.run?.board ?? rec.outputs.board, 'run.json'), 'utf8'));
const named = t => `${t.vendor}/${t.model}`;
const DONE = ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'];

test('LIFECYCLE, default routing (fit): an item without a ticket and one with a ticket go plan -> outcome; the planner, the Antigravity implementer and the in-run reviewer follow the matrix', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    assert.equal(REVIEW_INDEPENDENCE, 'lab', 'the model rule is asked for here; it is not the default');
    ctx.serve((_vendor, model) => model);   // the scripted providers report the model they served
    const f = fixture(repo, [{item: 'fresh'}, {item: 'ticketed'}], {tickets: ['ticketed']});
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model'});   // no profile: the default
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), DONE, JSON.stringify(r.dispatched.map(d => [d.item, d.stage, d.status])));
      const [plan, impl, rev, val, out] = w.stages(item);
      assert.equal(plan.outputs.plan.mode, item === 'ticketed' ? 'revalidate' : 'author');
      // PLANNER: the matrix's planner. The lifecycle seats it before the item has a difficulty, so at the default (medium).
      assert.equal(named(plan.outputs.planner), named(fitMatrix('planner', 'medium')));
      assert.equal(plan.outputs.planner.model, 'claude-opus-5-5');
      const run = runJson(impl);
      const difficulty = run.turns.find(t => t.purpose === 'work').selection.matrix.difficulty;
      assert.equal(difficulty, 'easy', 'the plan (and the ticket) call this item easy');
      for (const t of run.turns) {
        assert.equal(t.selection.profile, 'fit', `${t.purpose}: the run ran under fit without being told to`);
        assert.equal(t.selection.policy_hash, selectionPolicy('fit').hash);
      }
      // IMPLEMENTER: the matrix's Antigravity lane, through the agy CLI. The metered Gemini API wrote nothing.
      const work = run.turns.filter(t => t.purpose === 'work');
      assert.deepEqual(work.map(t => [named(t), t.transport, t.selection.eligibility, t.selection.rank]), [['agy_google/gemini-4-hydrogen-medium', 'agy-cli', 'fit-matrix', 0]]);
      assert.equal(named(work[0]), named(fitMatrix('implementer', difficulty)));
      assert.deepEqual(work[0].selection.matrix.ladder, IMPLEMENTER_LADDERS[difficulty].map(s => s.model));
      assert.deepEqual([work[0].served_model, work[0].served_model_source], ['gemini-4-hydrogen-medium', 'input']);
      assert.equal(work[0].quota_failover, undefined);
      // IN-RUN REVIEWER: the dispatcher's exact model for this difficulty, pinned.
      const critics = run.turns.filter(t => t.purpose === 'critique');
      assert.deepEqual(critics.map(named), ['openai/gpt-6-luna']);
      assert.equal(named(critics[0]), named(pinnedReviewer(fitMatrix('dispatcher', difficulty))));
      assert.equal(critics[0].selection.matrix.pinned_to, 'dispatcher');
      assert.equal(critics[0].served_model, critics[0].model);
      // Independence is intact: the contributors are the Anthropic planner and the Google worker, by model; no
      // contributing model is on the change panel or validates, and the panel is three distinct labs.
      const keys = contributorKeys(impl.contributions);
      assert.deepEqual(keys.contributing_labs, ['anthropic', 'google']);
      assert.ok(keys.models.includes('google/gemini-4-hydrogen') && keys.models.includes(idOf(plan.outputs.planner)));
      const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
      assert.equal(new Set(panel.map(t => t.lab)).size, 3);
      for (const t of panel) assert.ok(!keys.models.includes(idOf(t)), `${idOf(t)} contributed and reviewed`);
      assert.ok(!keys.models.includes(idOf(val.outputs.validator)));
      // The owner can apply the outcome (three labs, checked structurally).
      assert.equal(applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'))}).checked.checked, 'structural');
    }
    assert.deepEqual(ctx.agy(), Array(2).fill({agent: 'pantheon-implementer', model: 'gemini-4-hydrogen-medium'}), 'one lane turn per item: the work');
    assert.ok(!calls.some(c => c.vendor === 'agy_google'), 'the metered Gemini API was never called');
    assert.equal(calls.filter(c => WORK.test(c.prompt)).length, 0);
    assert.ok(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.every(i => i.gate.gate === 'complete'));
  });
});

test('LIFECYCLE, default routing (fit): an in-run rejection raises the implementer\'s thinking level first; the revision is made on the higher lane of the same model, and the item completes', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    const f = fixture(repo, [{item: 'fresh'}, {item: 'ticketed'}], {tickets: ['ticketed']});
    // The in-run checker rejects bytes not marked frozen; the worker (the fake agy CLI) revises when given the findings.
    const h = statelessHooks();
    ctx.implement(h.implement); ctx.review(h.review); ctx.serve(h.serve);
    ctx.agyMode('frozen');
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model'});
    const go = () => tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    await go();
    let w = openWorkLedger({root: f.workRoot});
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:failed']);
      const stopped = w.stages(item)[1];
      // The decision: the thinking level, before any other rung. Under argo this same rejection was a same-seat revise.
      assert.deepEqual(stopped.outputs.escalations, [{protocol: 'pantheon.escalation/v2', action: 'raise_thinking', steps: 0}]);
      assert.equal(stopped.outputs.pending_revision, true);
      assert.deepEqual(stopped.findings.map(x => [x.cause, x.vendor, x.model, x.text.split('\n')[0]]), [['in-run-review', 'openai', 'gpt-6-luna', FINDING]]);
    }
    await go();
    w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:failed', ...DONE.slice(1)]);
      const [, stopped, impl, rev] = w.stages(item);
      assert.equal(impl.outputs.resumed_from, stopped.hash, 'resumed, not restarted');
      const run = runJson(impl);
      // hydrogen-medium -> hydrogen-high: the same base model, one thinking level up. Not the ladder's next rung.
      const work = run.turns.filter(t => t.purpose === 'work');
      assert.deepEqual(work.map(t => [named(t), t.transport]), [['agy_google/gemini-4-hydrogen-medium', 'agy-cli'], ['agy_google/gemini-4-hydrogen-high', 'agy-cli']]);
      assert.equal(idOf(work[0]), idOf(work[1]), 'one model identity: a thinking level is not another model');
      assert.equal(work[1].selection.source, 'escalation');
      assert.match(work[1].selection.reason, /raise_thinking to gemini-4-hydrogen-high/);
      const esc = run.escalations.filter(e => e.outcome.kind === 'critique');
      assert.deepEqual(esc.map(e => [e.decision.action, e.decision.from.model, e.decision.to.model]), [['raise_thinking', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high']]);
      assert.deepEqual(esc[0].seat.lane_ladder, IMPLEMENTER_LADDERS.easy.map(s => s.model), 'the record carries the ladder it was decided on');
      assert.equal(verifyEscalation(esc.map(({slot, rev: _r, purpose, tier, ...rec}) => rec)).ok, true, 'and re-derives from it');
      // The reviewer whose finding reached the revision did not review the revised bytes; the next one is not that model.
      const critics = run.turns.filter(t => t.purpose === 'critique');
      assert.equal(critics.length, 2);
      assert.equal(named(critics[0]), 'openai/gpt-6-luna');
      assert.notEqual(idOf(critics[1]), idOf(critics[0]));
      const keys = contributorKeys(impl.contributions);
      assert.ok(keys.models.includes('openai/gpt-6-luna') && keys.models.includes('google/gemini-4-hydrogen'));
      for (const t of rev.team.filter(t => t.role === 'cycle-reviewer')) assert.ok(!keys.models.includes(idOf(t)), `${idOf(t)} contributed and reviewed`);
    }
    const built = ctx.agy().filter(a => a.agent === 'pantheon-implementer').map(a => a.model);
    assert.deepEqual(built, ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-high']);
    assert.deepEqual(ctx.agyRevisions().filter(a => a.agent === 'pantheon-implementer').map(a => a.model), ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-high'], 'the finding reached the worker on the raised lane');
    assert.ok(!calls.some(c => c.vendor === 'agy_google' && WORK.test(c.prompt)), 'the metered Gemini API wrote nothing');
  });
});
