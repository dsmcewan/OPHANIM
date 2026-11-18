// THE LIFECYCLE UNDER ITS DEFAULT ROUTING PROFILE, `fit` (owner direction 2026-11-17; the matrix is
// pantheon/src/route/fit-matrix.mjs). Complete lifecycle runs with NO profile named: the scheduler, the stage
// executors, Pantheon's FIVE-STAGE SPECIALIST PIPELINE (pantheon/src/pipeline) and the ledgers, end to end.
//
//   Stage 1  the plan stage's planner writes `work_units` with the plan (three labs review them with it)
//   Stage 2  an OpenAI dispatcher per unit, by the unit's difficulty          (scripted single-turn seat)
//   Stage 3  an Antigravity lane per unit, in the unit's own worktree         (the fixture's fake agy CLI: a real
//                                                                               child process that writes files)
//   Stage 4  a Grok subagent over the unit's A2A shim                          (scripted single-turn seat)
//   Stage 5  the dispatcher's exact model, pinned                              (scripted single-turn seat)
//   then     the coordinated three-lab change review, the validator and the outcome, unchanged.
//
// Every provider is scripted or the fake CLI: these show routing, scheduling, escalation and recording, not model
// judgment and not a live quota.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors, implementerPath, REVIEW_INDEPENDENCE} from './stages.mjs';
import {resolveModel, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {fitMatrix, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION, pinnedReviewer} from '../../pantheon/src/route/frontier.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, git, UNIT, unitApprove, unitReject, LIMITS} from './test-fixtures.mjs';

const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
const idOf = t => resolveModel(t.vendor, t.model).id;
const named = t => `${t.vendor}/${t.model}`;
const recordOf = rec => JSON.parse(fs.readFileSync(rec.outputs.run.record, 'utf8'));
const DONE = ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'];
const ITEMS = ['fresh', 'ticketed'];
// Stage 1's tier per item: the fixture ticket declares difficulty `easy`; an item without a ticket declares none.
const PLAN_TIER = {fresh: 'medium', ticketed: 'easy'};
const PLANNER = {fresh: 'claude-opus-5-5', ticketed: 'claude-sonnet-5'};
const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const branches = (repo, pattern) => git(repo, 'branch', '--list', pattern).split('\n').map(l => l.replace(/^[* ]+/, '').trim()).filter(Boolean);

// THREE WORK UNITS: `a` (easy) and `c` (hard) are disjoint and share a wave; `b` (medium) builds on `a`.
//   a  alpha.mjs exports ok = true                               verified by the fixture's verify.mjs
//   b  beta.mjs imports alpha.mjs: passes only on top of `a`     a multi-unit dependency
//   c  gamma/**: a module AND its test, one owner; it may consult one subagent
const UNITS = [
  UNIT('a'),
  UNIT('b', {depends_on: ['a'], owned_paths: ['beta.mjs'], difficulty: 'medium', verify_cmd: 'node -e "import(\'./beta.mjs\').then(m => process.exit(m.both === true ? 0 : 1))"', invariants: ['beta.mjs exports both === true, computed from alpha.mjs']}),
  UNIT('c', {owned_paths: ['gamma/**'], difficulty: 'hard', allowed_subagents: ['api-designer'], verify_cmd: 'node gamma/gamma.test.mjs', invariants: ['gamma/gamma.mjs exports g === 3 and its test proves it']}),
];
const THREE = {work_units: UNITS, slices: [{id: 's1', title: 'alpha.mjs exports ok = true', slot: 'alpha', path: 'alpha.mjs'}, {id: 's2', title: 'beta.mjs', slot: 'beta', path: 'beta.mjs'}, {id: 's3', title: 'gamma.mjs', slot: 'gamma', path: 'gamma/gamma.mjs'}]};
// The fake agy CLI's worker for those units (sourced with $dir = the unit's worktree, $unit, $model, $prompt): it
// writes the unit's files, logs when it started and ended, and unit c asks its subagent one question over A2A.
const SPAN = 'printf \'%s %s %s %s\\n\' "$dir" "$unit" "$1" "$(date +%s%N)" >> "$FAKE_AGY_LOG.spans"';
// Unit c asks its subagent one question through the stdio MCP server over the unit's Unix socket (the fake CLI's agy_ask).
const WORKER = `span() { ${SPAN}; }
span start
case "$unit" in
  a) sleep 0.3; printf 'export const ok = true;\\n' > "$dir/alpha.mjs" ;;
  b) printf 'import {ok} from "./alpha.mjs";\\nexport const both = ok === true;\\n' > "$dir/beta.mjs" ;;
  c) sleep 0.3; agy_ask api-designer "what should g be?" >/dev/null || exit 1; mkdir -p "$dir/gamma"; printf 'export const g = 3;\\n' > "$dir/gamma/gamma.mjs"; printf 'import {g} from "./gamma.mjs"; if (g !== 3) process.exit(1);\\n' > "$dir/gamma/gamma.test.mjs" ;;
esac
span end
`;

test('LIFECYCLE, default routing (fit): an item without a ticket and one with a ticket go plan -> dispatcher -> implementer in per-unit worktrees -> pinned reviewer -> integration -> three-lab review -> validation -> an outcome the owner applies', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    assert.equal(REVIEW_INDEPENDENCE, 'lab', 'the model rule is asked for here; it is not the default');
    const f = fixture(repo, ITEMS.map(item => ({item})), {tickets: ['ticketed']});
    ctx.agyWorker(WORKER);
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, THREE))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});   // no profile: the default
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    const spans = lines(path.join(repo, 'agy.log.spans')).map(l => { const [dir, unit, edge, at] = l.split(' '); return {dir, unit, edge, at: BigInt(at)}; });
    for (const item of ITEMS) {
      assert.deepEqual(seq(w, item), DONE, JSON.stringify(r.dispatched.map(d => [d.item, d.stage, d.status, d.next?.why])));
      const [plan, impl, rev, val, out] = w.stages(item);
      assert.equal(plan.outputs.plan.mode, item === 'ticketed' ? 'revalidate' : 'author');
      // STAGE 1. The planner is seated from the item's own declared difficulty (owner direction 2026-11-18): the fixture
      // ticket declares `easy`, so the ticketed item plans on the easy planner; the item without a ticket plans at medium.
      assert.equal(named(plan.outputs.planner), named(fitMatrix('planner', PLAN_TIER[item])));
      assert.equal(plan.outputs.planner.model, PLANNER[item]);
      assert.deepEqual(plan.outputs.plan.work_units.map(u => [u.unit_id, u.difficulty, u.depends_on]), [['a', 'easy', []], ['b', 'medium', ['a']], ['c', 'hard', []]]);
      // The three plan reviewers were shown the work units with the plan.
      assert.match(git(repo, 'show', `${plan.outputs.plan_commit}:plans/${item}.json`), /"work_units"/);

      // THE RUN: the pipeline, not the per-file board run.
      assert.equal(impl.outputs.run.kind, 'pipeline');
      const rec = recordOf(impl);
      assert.equal(rec.status, 'completed');
      // The controller's waves: a and c together (disjoint, no order between them), b after a.
      assert.deepEqual(rec.waves, [['a', 'c'], ['b']]);
      const at = (unit, edge) => spans.find(s => s.dir.includes(`/${item}/`) && s.unit === unit && s.edge === edge);
      assert.ok(at('a', 'start').at < at('c', 'end').at && at('c', 'start').at < at('a', 'end').at, 'a and c did not overlap in time');
      assert.ok(at('b', 'start').at >= at('a', 'end').at, 'b started before a ended');
      const dirs = ['a', 'b', 'c'].map(u => at(u, 'start').dir);
      assert.equal(new Set(dirs).size, 3, 'each unit worked in its own worktree');
      for (const [i, u] of ['a', 'b', 'c'].entries()) {
        assert.equal(dirs[i], rec.units[u].worktree);
        assert.ok(!dirs[i].startsWith(repo + path.sep) || dirs[i].startsWith(f.stateDir + path.sep), 'never the checkout');
        assert.equal(fs.existsSync(dirs[i]), false, 'the worktree is removed when the unit ends');
      }
      // SEATS FOLLOW THE MATRIX, per unit difficulty.
      for (const u of UNITS) {
        const x = rec.units[u.unit_id], d = u.difficulty;
        assert.equal(named(x.dispatch), named(fitMatrix('dispatcher', d)), `${u.unit_id}: dispatcher`);
        assert.equal(x.dispatch.served_model, x.dispatch.model);
        assert.deepEqual(x.attempts.map(a => [named(a), a.status, a.served_model, a.served_model_source]), [[named(fitMatrix('implementer', d)), 'written', IMPLEMENTER_LADDERS[d][0].model, 'input']], `${u.unit_id}: implementer`);
        assert.deepEqual(x.implementer_ladder.map(s => s.model), implementerPath(d).map(s => s.model));
        // STAGE 5: the dispatcher's exact model, pinned; its ladder never leaves OpenAI.
        assert.deepEqual(x.reviews.map(v => [named(v), v.pinned_to_dispatcher, v.status, v.verify.exit_code]), [[named(pinnedReviewer(fitMatrix('dispatcher', d))), true, 'approved', 0]], `${u.unit_id}: reviewer`);
        assert.deepEqual(x.reviewer_ladder.map(named), REVIEWER_ESCALATION.slice(REVIEWER_ESCALATION.findIndex(s => s.model === x.dispatch.model)).map(named));
        assert.ok(x.reviewer_ladder.every(s => s.vendor === 'openai'));
        assert.equal(x.merged, true);
      }
      assert.deepEqual([rec.units.b.dispatch.model, rec.units.b.reviews[0].model], ['gpt-6.1-sol', 'gpt-6.1-sol'], 'the medium dispatcher and its pinned reviewer');
      assert.deepEqual(rec.units.c.a2a.calls.map(c => [c.role, c.status, named(c)]), [['api-designer', 'answered', named(fitMatrix('subagent', 'hard'))]]);
      assert.deepEqual([rec.units.a.a2a.calls.length, rec.units.b.a2a.calls.length], [0, 0]);

      // ARBITERS vs CONTRIBUTIONS (owner governance decision 2026-11-17, flagged for independent review): the
      // dispatcher is recorded as a non-authoring arbiter, and is NOT a contribution.
      assert.deepEqual(impl.outputs.arbiters.map(a => [a.unit_id, a.role, a.standing, a.authored, named(a)]),
        [['a', 'dispatcher', 'arbiter', false, 'openai/gpt-6-luna'], ['b', 'dispatcher', 'arbiter', false, 'openai/gpt-6.1-sol'], ['c', 'dispatcher', 'arbiter', false, 'openai/gpt-6-astra']]);
      assert.deepEqual(impl.contributions.map(c => [c.purpose, named(c)]).sort(), [['plan', `anthropic/${PLANNER[item]}`], ['subtask', 'xai/grok-4.7'],
        ['work', 'agy_google/gemini-4-carbon-high'], ['work', 'agy_google/gemini-4-hydrogen-high'], ['work', 'agy_google/gemini-4-hydrogen-medium']].sort());
      assert.ok(!impl.contributions.some(c => c.vendor === 'openai'), 'no OpenAI model contributed: the dispatchers arbitrated and the pinned reviewers only approved');
      assert.deepEqual(impl.contributions, impl.outputs.contributions);
      const dispatchers = impl.team.filter(x => x.role === 'dispatcher');
      assert.equal(dispatchers.length, 3);
      for (const d of dispatchers) assert.deepEqual([d.standing, d.authored], ['arbiter', false]);
      const keys = contributorKeys(impl.contributions);
      assert.deepEqual(keys.contributing_labs, ['anthropic', 'google', 'xai']);
      assert.deepEqual(keys.models, [`anthropic/${PLANNER[item]}`, 'google/gemini-4-carbon', 'google/gemini-4-hydrogen', 'xai/grok-4.7']);

      // INTEGRATION reaches the review as one commit on pantheon/<item>, parent = the base the run started from.
      assert.equal(git(repo, 'rev-parse', `${impl.outputs.commit}^`).trim(), impl.outputs.base);
      assert.equal(git(repo, 'rev-parse', `pantheon/${item}`).trim(), impl.outputs.commit);
      assert.equal(git(repo, 'rev-parse', `${impl.outputs.commit}^{tree}`).trim(), impl.outputs.integration.tree);
      assert.deepEqual(impl.outputs.files, ['alpha.mjs', 'beta.mjs', 'gamma/gamma.mjs', 'gamma/gamma.test.mjs']);
      assert.deepEqual([rev.outputs.base, rev.outputs.commit, val.outputs.commit], [impl.outputs.base, impl.outputs.commit, impl.outputs.commit]);

      // THE COORDINATED THREE-LAB REVIEW AND THE VALIDATOR REMAIN, after the pipeline: three distinct labs, no
      // contributing model. OpenAI did not contribute, so an OpenAI model is on the panel.
      const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
      assert.equal(panel.length, 3);
      assert.equal(new Set(panel.map(t => t.lab)).size, 3);
      for (const t of panel) assert.ok(!keys.models.includes(idOf(t)), `${idOf(t)} contributed and reviewed`);
      assert.ok(panel.some(t => t.lab === 'openai'), `an OpenAI model is still eligible for the panel: ${panel.map(named).join(', ')}`);
      assert.deepEqual(rev.outputs.author_models, keys.models);
      assert.ok(!keys.models.includes(idOf(val.outputs.validator)));
      assert.equal(val.outputs.verdict, 'accept');
      // The owner can apply the outcome (three labs, checked structurally: run ledger, cycle, run.json, ticket).
      assert.equal(applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'))}).checked.checked, 'structural');
    }
    // The integration branches are gone; the checkout was never written to.
    assert.deepEqual(branches(repo, 'pantheon/pipeline/*'), []);
    assert.deepEqual(branches(repo, 'pantheon/*').filter(b => !b.includes('/pipeline/')).sort(), ['pantheon/fresh', 'pantheon/ticketed']);
    assert.equal(fs.readFileSync(path.join(repo, 'alpha.mjs'), 'utf8'), 'export const ok = false;\n');
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1);
    // Every implementer turn was the fake agy CLI on its lane, with the worktree and the A2A endpoint; no metered API.
    const launched = ctx.agyContext();
    assert.deepEqual(launched.map(a => a.model).sort(), ITEMS.flatMap(() => ['gemini-4-carbon-high', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium']).sort());
    for (const a of launched) assert.deepEqual([a.agent, a.a2a_socket, a.a2a_token, a.google_key], ['pantheon-unit-worker', true, true, false]);
    assert.equal(calls.length, 0, 'no SDK client was used: the metered Gemini API was never called');
    // The single-turn seats: one dispatcher and one pinned review per unit, one subagent answer per item.
    const kinds = k => turn.log.filter(l => l.kind === k);
    assert.deepEqual([kinds('dispatcher').length, kinds('unit-review').length, kinds('subagent').length], [6, 6, 2]);
    for (const l of kinds('unit-review')) assert.deepEqual(l.extra, {reasoning: {context: 'all_turns'}});
    assert.ok(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.every(i => i.gate.gate === 'complete'));
  });
});

const FINDING = 'export ok as a frozen constant; a comment must say why';
test('LIFECYCLE, default routing (fit): a Stage 5 rejection raises the implementer\'s thinking level first; after repeated rejections the reviewer escalates inside OpenAI only; the reviewer whose finding fed a revision is excluded from the three-lab review, the one that only approved is not', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    const f = fixture(repo, ITEMS.map(item => ({item})), {tickets: ['ticketed']});
    // The worker revises when it is given the finding (and says so); the pinned reviewer (gpt-6-luna) rejects every
    // revision it sees, so after two rejections the reviewer is raised; the next rung approves passing work.
    ctx.agyWorker(`case "$prompt" in *"${FINDING}"*) printf '%s %s\\n' "$dir" "$model" >> "$FAKE_AGY_LOG.told"; printf '// frozen: the importer reads it lazily\\nexport const ok = true;\\n' > "$dir/alpha.mjs" ;; *) printf 'export const ok = true;\\n' > "$dir/alpha.mjs" ;; esac\n`);
    const turn = scriptedTurn({'unit-review': ({model, rubric, passed}) => JSON.stringify(model === 'gpt-6-luna' || !passed ? unitReject(rubric, [FINDING]) : unitApprove(rubric))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    for (const item of ITEMS) {
      // The rejection is answered INSIDE the run (a revision by the same unit owner), not by a failed stage.
      assert.deepEqual(seq(w, item), DONE, JSON.stringify(r.dispatched.map(d => [d.item, d.stage, d.status, d.next?.why])));
      const [, impl, rev, val] = w.stages(item);
      const u = recordOf(impl).units.alpha;
      // hydrogen-medium -> hydrogen-high -> hydrogen-xhigh: the same base model, one thinking level up per rejection.
      assert.deepEqual(u.attempts.map(a => [a.model, a.status, a.findings_in]), [['gemini-4-hydrogen-medium', 'written', 0], ['gemini-4-hydrogen-high', 'written', 2], ['gemini-4-hydrogen-xhigh', 'written', 2]]);
      assert.equal(new Set(u.attempts.map(idOf)).size, 1, 'one model identity: a thinking level is not another model');
      // The reviewer: pinned gpt-6-luna twice, then raised one rung, inside OpenAI.
      assert.deepEqual(u.reviews.map(v => [named(v), v.level, v.pinned_to_dispatcher, v.status, v.fed_revision]),
        [['openai/gpt-6-luna', 0, true, 'request_changes', true], ['openai/gpt-6-luna', 0, true, 'request_changes', true], ['openai/gpt-6.1-sol', 1, false, 'approved', false]]);
      assert.deepEqual(u.escalations.map(e => [e.after_attempt, e.kind, e.from.model, e.to.model]), [[1, 'implementer', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high'],
        [2, 'implementer', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh'], [2, 'reviewer', 'gpt-6-luna', 'gpt-6.1-sol']]);
      assert.ok(u.escalations.filter(e => e.kind === 'reviewer').every(e => e.from.vendor === 'openai' && e.to.vendor === 'openai'));
      assert.equal(u.reviewer_fed_revision, true);
      // The findings are kept on the stage record with the reviewer that made them.
      assert.deepEqual(impl.findings.map(x => [x.cause, x.vendor, x.model, x.unit, x.text]).filter(x => x[4] === FINDING), Array(2).fill(['in-run-review', 'openai', 'gpt-6-luna', 'alpha', FINDING]));
      // CONTRIBUTIONS: gpt-6-luna's finding fed a revision, so it IS a critique contributor; gpt-6.1-sol only approved
      // and is not. The dispatcher (gpt-6-luna as an arbiter) is listed apart.
      assert.deepEqual(impl.contributions.map(c => [c.purpose, named(c)]).sort(), [['critique', 'openai/gpt-6-luna'], ['plan', `anthropic/${PLANNER[item]}`],
        ['work', 'agy_google/gemini-4-hydrogen-high'], ['work', 'agy_google/gemini-4-hydrogen-medium'], ['work', 'agy_google/gemini-4-hydrogen-xhigh']]);
      assert.deepEqual(impl.outputs.arbiters.map(named), ['openai/gpt-6-luna']);
      const keys = contributorKeys(impl.contributions);
      assert.ok(keys.models.includes('openai/gpt-6-luna') && !keys.models.includes('openai/gpt-6.1-sol'));
      // The later three-lab review and the validator exclude the contributing reviewer, by model.
      const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
      assert.equal(new Set(panel.map(t => t.lab)).size, 3);
      for (const t of panel) assert.ok(!keys.models.includes(idOf(t)), `${idOf(t)} contributed and reviewed`);
      assert.ok(rev.outputs.author_models.includes('openai/gpt-6-luna'));
      assert.ok(!panel.some(t => idOf(t) === 'openai/gpt-6-luna') && idOf(val.outputs.validator) !== 'openai/gpt-6-luna');
      assert.match(git(repo, 'show', `${impl.outputs.commit}:alpha.mjs`), /^\/\/ frozen/);
    }
    assert.deepEqual(lines(path.join(repo, 'agy.log.told')).map(l => l.split(' ')[1]), ITEMS.flatMap(() => ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh']), 'the finding reached the worker on each raised lane');
    assert.equal(calls.length, 0, 'the metered Gemini API wrote nothing');
  });
});

test('LIFECYCLE, default routing (fit): a write outside the unit\'s owned paths is refused and discarded, the unit does not integrate, and the stage is blocked with the findings kept', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, ITEMS.map(item => ({item})), {tickets: ['ticketed']});
    // The worker does its unit AND rewrites the acceptance check so that anything passes.
    ctx.agyWorker('printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"; printf \'// nothing to check\\n\' > "$dir/verify.mjs"\n');
    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model', pipelineLimits: {max_revisions: 1}});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    for (const item of ITEMS) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:blocked']);
      const impl = w.stages(item)[1];
      const u = recordOf(impl).units.alpha;
      assert.deepEqual(u.attempts.map(a => [a.status, a.code, a.violations.map(v => [v.path, v.code])]), Array(2).fill(['refused', 'WRITE_JAIL', [['verify.mjs', 'OUTSIDE_OWNED']]]));
      assert.deepEqual([u.status, u.merged, u.reviews.length], ['blocked', false, 0], 'refused before any review; never merged');
      assert.equal(impl.blocker.code, 'PIPELINE_UNITS_UNRESOLVED');
      assert.match(impl.blocker.what, /unit\(s\) alpha \(blocked/);
      assert.deepEqual(impl.findings.map(x => [x.cause, x.code, x.unit]), Array(2).fill(['in-run-controller', 'WRITE_JAIL', 'alpha']));
      assert.match(impl.findings[0].text, /write jail: verify\.mjs \(OUTSIDE_OWNED\)/);
      assert.equal(impl.outputs.shipped, false);
      assert.ok(fs.existsSync(impl.outputs.run.record), 'the run record is kept');
      // Nothing the refused attempts wrote is a contribution; nothing reached a branch of the item.
      assert.deepEqual(impl.contributions.map(c => c.purpose), ['plan']);
      assert.deepEqual(branches(repo, `pantheon/${item}*`), []);
    }
    assert.equal(turn.log.filter(l => l.kind === 'unit-review').length, 0);
    assert.match(fs.readFileSync(path.join(repo, 'verify.mjs'), 'utf8'), /assert\.equal\(ok, true\)/, 'the repository\'s check is untouched');
    assert.equal(git(repo, 'status', '--porcelain', '--', 'alpha.mjs', 'verify.mjs').trim(), '');
  });
});

test('LIFECYCLE, default routing (fit): a plan whose units overlap without an order is returned to the planner by the controller; the revised units run to an outcome', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'fresh'}]);
    // Two units own alpha.mjs and neither depends on the other; the revision (which answers the finding) is one unit.
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, /## Findings to answer/.test(prompt) ? {} : {work_units: [UNIT('one'), UNIT('two')]}))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    for (let i = 0; i < 3; i++) await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'fresh'), ['plan:passed', 'implement:returned', ...DONE]);
    const [, back, replan, impl] = w.stages('fresh');
    assert.deepEqual(back.next.stage, 'plan');
    assert.match(back.next.why, /units one and two own overlapping paths \(alpha\.mjs ~ alpha\.mjs\) and neither depends on the other/);
    assert.deepEqual(back.findings.map(x => [x.cause, x.severity]), [['inadequate-plan', 'block']]);
    assert.match(back.findings[0].text, /^\[LOCK_CONFLICT\]/);
    assert.equal(back.usage.provider_calls, 0, 'refused before any turn');
    assert.equal(turn.log.filter(l => l.kind === 'dispatcher').length, 1, 'only the revised plan was dispatched');
    assert.equal(replan.outputs.plan.mode, 'revise');
    assert.deepEqual(replan.outputs.plan.work_units.map(u => u.unit_id), ['alpha']);
    assert.deepEqual(replan.outputs.plan.answers.map(a => a.finding), back.findings.map(x => x.id));
    assert.equal(recordOf(impl).status, 'completed');
  });
});

test('LIFECYCLE: under fit a plan without valid work_units is refused at plan validation like any other malformed plan; under argo the same plan runs the per-file path', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_vendor, model) => model);
    const f = fixture(repo, [{item: 'fresh'}]);
    const without = prompt => { const {work_units: _dropped, ...rest} = planFor(prompt); return rest; };
    // fit: no work_units, then a unit with an unknown key and no verify_cmd, then none again -> no plan, nothing run.
    const turn = scriptedTurn({planner: ({prompt, k}) => json(k === 2 ? {...without(prompt), work_units: [{...UNIT('alpha', {verify_cmd: ''}), extra: true}]} : without(prompt))});
    const fit = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: fit, limits: {...LIMITS, stage_attempts: 1}});
    let w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'fresh'), ['plan:failed']);
    const refused = w.stages('fresh')[0].outputs.refused;
    assert.equal(refused.length, 3);
    assert.match(refused[0].why.join('\n'), /work_units is required/);
    assert.match(refused[1].why.join('\n'), /work_units: unit alpha: unknown key\(s\): extra/);
    assert.match(refused[1].why.join('\n'), /work_units: unit alpha: verify_cmd is a non-empty string/);
    assert.equal(turn.log.filter(l => l.kind === 'plan-review').length, 0, 'a refused plan is never sent to review');
    assert.equal(fs.existsSync(path.join(repo, 'tickets', 'fresh.json')), false);
    // The planner was told the unit rules, and (on the retry) why its answer was refused.
    const prompts = [];
    const probe = scriptedTurn({planner: ({prompt}) => { prompts.push(prompt); return json(without(prompt)); }});
    await makeExecutors({repo, makeClientFor, turn: probe, stateDir: path.join(repo, 'status', 'probe')}).plan({item: 'fresh', gate: {mode: 'author', requirement: {title: 'Alpha for fresh', basis: 'x'}}, budget: {provider_calls: 20}, work: w, attempt: 1}).catch(() => null);
    assert.match(prompts[0], /## Work units \(required/);
    assert.match(prompts[0], /Coupled files belong to ONE unit/);
    assert.match(prompts[1], /Your previous answer was refused[\s\S]*work_units is required/);
  });
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_vendor, model) => model);
    const f = fixture(repo, [{item: 'fresh'}]);
    const turn = scriptedTurn({planner: ({prompt}) => { const {work_units: _dropped, ...rest} = planFor(prompt); return json(rest); }});
    const argo = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: argo, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'fresh').slice(0, 2), ['plan:passed', 'implement:passed']);
    const impl = w.stages('fresh')[1];
    assert.equal(impl.outputs.run.kind, undefined, 'the per-file board run, not the pipeline');
    assert.ok(JSON.parse(fs.readFileSync(impl.outputs.run.run_json, 'utf8')).turns.some(t => t.purpose === 'work'));
    assert.equal(impl.outputs.arbiters, undefined);
    assert.equal(turn.log.filter(l => l.kind === 'dispatcher').length, 0);
  });
});
