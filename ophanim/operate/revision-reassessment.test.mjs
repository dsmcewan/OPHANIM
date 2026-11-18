// Corrections after the review of 10cbd52 (reproduction appendix), through the lifecycle. `argo` routing, named
// explicitly since 2026-11-17 (the lifecycle's default profile is now `fit`; fit-lifecycle.test.mjs covers it);
// model-level independence asked for explicitly (it is NOT active by default); the four real labs and the
// real model inventory; no synthetic lab. Seats are scripted: these show enforcement, routing and persistence, not
// model judgment.
//
// COMPLETE LIFECYCLE tests run the scheduler, the stage executors, Pantheon's run and the ledgers end to end.
// BOUNDARY tests inject prior stage records to reach a state a complete lifecycle was not shown to reach; each says so.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStatusLedger, applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors, REVIEW_INDEPENDENCE} from './stages.mjs';
import {reassessItem} from './reassess.mjs';
import {statelessHooks, FINDING} from './test-restart-child.mjs';
import {currentPolicy, resolveModel, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {reviewSeatsByModel} from '../../pantheon/src/ledger/review-cycle.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {withDispatch, WORK} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, fixture, ACCEPT, planFor, scriptedTurn, LIMITS} from './test-fixtures.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-restart-child.mjs');
const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
const idOf = t => resolveModel(t.vendor, t.model).id;
const runJson = rec => JSON.parse(fs.readFileSync(path.join(rec.outputs.run?.board ?? rec.outputs.board, 'run.json'), 'utf8'));
const hook = (ctx, h) => { ctx.implement(h.implement); ctx.review(h.review); ctx.serve(h.serve); };

test('LIFECYCLE, argo routing: an in-run finding is followed by a revision by the same worker model, across a process restart, for an item without a ticket and one with a ticket', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    assert.equal(REVIEW_INDEPENDENCE, 'lab', 'the model rule is asked for here; it is not the default');
    const f = fixture(repo, [{item: 'fresh'}, {item: 'ticketed'}], {tickets: ['ticketed']});
    hook(ctx, statelessHooks());
    // argo's second in-run reviewer is its Google seat, which goes through its Antigravity lane first (owner direction
    // 2026-11-17): the fake CLI is given the same stateless behaviour as the scripted API hooks.
    ctx.agyMode('frozen');
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    let w = openWorkLedger({root: f.workRoot});
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:failed']);
      const stopped = w.stages(item)[1];
      // The worker is on the top model at its top effort: under protocol v1 this rejection was a terminal stop.
      assert.deepEqual(stopped.outputs.escalations, [{protocol: 'pantheon.escalation/v2', action: 'revise', steps: 0}]);
      assert.equal(stopped.outputs.pending_revision, true);
      // The rejected work and the finding are on the record, with the reviewer that made it.
      assert.deepEqual(stopped.findings.map(x => [x.cause, x.vendor, x.model, x.text.split('\n')[0]]), [['in-run-review', 'xai', 'grok-4.7', FINDING]]);
      assert.ok(fs.existsSync(path.join(stopped.outputs.board, 'run.json')));
    }
    const parentCalls = calls.length;
    // PROCESS RESTART: the next tick runs in a new process, with everything rebuilt from disk.
    const child = JSON.parse(execFileSync(process.execPath, [CHILD, repo, f.statusRoot, f.workRoot, f.stateDir, 'argo'], {encoding: 'utf8', env: process.env}).trim().split('\n').at(-1));
    assert.notEqual(child.pid, process.pid);
    w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:failed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'], JSON.stringify(child.dispatched));
      const [plan, stopped, impl, rev, val] = w.stages(item);
      assert.equal(plan.outputs.plan.mode, item === 'ticketed' ? 'revalidate' : 'author');
      // Resumed, not restarted: the same board, and the revision was made by the SAME model with the finding in its prompt.
      assert.equal(impl.outputs.resumed_from, stopped.hash);
      assert.equal(impl.outputs.run.board, stopped.outputs.board);
      const run = runJson(impl);
      const work = run.turns.filter(t => t.purpose === 'work');
      assert.deepEqual(work.map(t => `${t.vendor}/${t.model}`), ['openai/gpt-6-astra', 'openai/gpt-6-astra'], 'one first build and one revision, by the same model: not a new identity');
      // The reviewer whose finding reached the revision did not review the revised work.
      const critics = run.turns.filter(t => t.purpose === 'critique');
      assert.equal(critics.length, 2);
      assert.equal(`${critics[0].vendor}/${critics[0].model}`, 'xai/grok-4.7');
      assert.notEqual(idOf(critics[1]), idOf(critics[0]));
      assert.equal(critics[1].served_model, critics[1].model, 'the in-run answer names the model that served it');
      // Contributor lineage: the plan, the work and the in-run critic, by model; the change review excludes all of them.
      const keys = contributorKeys(impl.contributions);
      assert.ok(keys.models.includes('xai/grok-4.7') && keys.models.includes('openai/gpt-6-astra') && keys.models.includes(idOf(plan.outputs.planner)));
      const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
      assert.equal(new Set(panel.map(t => t.lab)).size, 3);
      for (const t of panel) assert.ok(!keys.models.includes(idOf(t)));
      assert.ok(!keys.models.includes(idOf(val.outputs.validator)));
      assert.equal(val.outputs.validator.served_model, val.outputs.validator.model);
      // Cumulative accounting: each implement attempt is charged its own calls, once.
      assert.equal(stopped.usage.provider_calls + impl.usage.provider_calls, run.turns.length);
    }
    assert.deepEqual(child.work_prompts, [{model: 'gpt-6-astra', told: true}, {model: 'gpt-6-astra', told: true}], 'in the new process the worker was given the finding');
    // A lane turn is a provider call too: the second in-run review of each item went through the Antigravity lane (the
    // fake CLI's log), and is charged like the API calls.
    assert.deepEqual(ctx.agy(), [{agent: 'pantheon-reviewer', model: 'gemini-4-carbon-high'}, {agent: 'pantheon-reviewer', model: 'gemini-4-carbon-high'}]);
    assert.equal(parentCalls + child.work_calls + ctx.agy().length, w.stages().filter(s => s.stage === 'implement').reduce((n, s) => n + s.usage.provider_calls, 0), 'no call is charged twice or dropped across the restart');
  });
});

test('LIFECYCLE, argo routing: repeated in-run findings are revised within bounds; when no eligible in-run reviewer is left the work is blocked with every finding kept, not restarted', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor, calls} = ctx;
    const f = fixture(repo, [{item: 'rounds'}]);
    hook(ctx, statelessHooks({alwaysReject: true}));
    ctx.agyMode('reject');   // the Google reviewer answers through its Antigravity lane (the fake CLI), and rejects too
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    const go = () => tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    for (let i = 0; i < 3; i++) await go();
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'rounds'), ['plan:passed', 'implement:failed', 'implement:failed', 'implement:blocked']);
    const [, a, b, c] = w.stages('rounds');
    // One board throughout: three builds (one first, two revisions), never a fresh start.
    assert.equal(new Set([a, b, c].map(x => x.outputs.board)).size, 1);
    assert.equal(calls.filter(x => WORK.test(x.prompt)).length, 3);
    assert.deepEqual(c.outputs.escalations.map(e => [e.protocol, e.action, e.steps]), [['pantheon.escalation/v2', 'revise', 0], ['pantheon.escalation/v2', 'revise', 1]]);
    // Each revision was reviewed by a model that had not contributed; the two argo reviewer models are then used up.
    // The Google one is named by its Antigravity lane (gemini-4-carbon-high), the same model identity as gemini-4-carbon:
    // its metered API id is only that lane's quota failover and is not a third reviewer.
    const critics = runJson(c).turns.filter(t => t.purpose === 'critique').map(t => `${t.vendor}/${t.model}`);
    assert.deepEqual(critics, ['xai/grok-4.7', 'agy_google/gemini-4-carbon-high']);
    assert.equal(resolveModel('agy_google', 'gemini-4-carbon-high').id, resolveModel('agy_google', 'gemini-4-carbon').id);
    assert.ok(!calls.some(x => x.vendor === 'agy_google'), 'the metered Gemini API was never called');
    // Blocked, explicitly, with both findings and who made them; the rejected work is still there.
    assert.equal(c.blocker.code, 'IN_RUN_REVIEW_UNRESOLVED');
    assert.match(c.blocker.what, /no in-run reviewer is eligible for the revised work.*2 in-run finding\(s\) are unresolved; the run and its work are kept/);
    assert.deepEqual(c.findings.map(x => [x.cause, `${x.vendor}/${x.model}`]), [['in-run-review', 'xai/grok-4.7'], ['in-run-review', 'agy_google/gemini-4-carbon-high']]);
    assert.equal(runJson(c).files[0].rev, 3);
    // It is not dispatched again on the same inputs, and nothing is charged twice.
    assert.deepEqual((await go()).dispatched, []);
    assert.equal(a.usage.provider_calls + b.usage.provider_calls + c.usage.provider_calls, runJson(c).turns.length + (runJson(c).attempts.length - runJson(c).turns.length));
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'blocked');
  });
});

test('LIFECYCLE: a validator answer that names no serving model is never a validation; each is kept; the item does not reach an outcome (no ticket, and a ticket)', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'fresh'}, {item: 'ticketed'}], {tickets: ['ticketed']});
    ctx.serve((_v, m) => m);
    const turn = scriptedTurn({validator: ({k}) => ({text: ACCEPT, served_model: [null, '', '   '][(k - 1) % 3]})});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, stage_attempts: 1}});
    const w = openWorkLedger({root: f.workRoot});
    for (const item of ['fresh', 'ticketed']) {
      assert.deepEqual(seq(w, item), ['plan:passed', 'implement:passed', 'review:passed', 'validate:failed']);
      const val = w.stages(item).at(-1);
      assert.equal(val.outputs.validator.independent, true);
      assert.equal(val.outputs.verdict, undefined, 'no judgment was accepted');
      assert.equal(val.outputs.rejected_answers.length, 3);
      for (const r of val.outputs.rejected_answers) {
        assert.ok(r.served_model === null || !r.served_model.trim(), 'missing, empty or blank');
        assert.match(r.why, /names no serving model.*not evidence of which model answered/);
        assert.equal(r.verdict, 'accept');
        assert.match(r.reply_sha, /^sha256:/);
      }
      assert.equal(new Set(val.outputs.rejected_answers.map(r => `${r.vendor}/${r.model}`)).size, 3, 'three different seats were asked');
      assert.equal(val.usage.provider_calls, 3, 'within the stage budget, each call counted');
    }
  });
});

test('BOUNDARY (injected stage records): with every declared model a contributor, validation waits on capacity; it does not fall back to a contributor (no ticket, and a ticket)', async () => {
  // The appendix's direct probe, with its conditions kept: prior plan, implement and review records are INJECTED, and
  // the contributor list is every model the identity policy declares. A complete lifecycle was not shown to reach this
  // (see the lifecycle test below it).
  await withDispatch(async ({dir}) => {
    for (const ticketed of [false, true]) {
      const repo = path.join(dir, ticketed ? 'ticketed' : 'unticketed'); fs.mkdirSync(repo);
      const item = 'probe', f = fixture(repo, [{item}], {tickets: ticketed ? [item] : []});
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = true;\n');
      git(repo, 'add', 'alpha.mjs'); git(repo, 'commit', '-q', '-m', 'fixture implementation');
      const commit = git(repo, 'rev-parse', 'HEAD').trim(), identity = {item};
      const all = Object.entries(currentPolicy().model_lab).map(([model, lab]) => ({purpose: 'critique', vendor: lab, model, lab}));
      const contributions = [{purpose: 'plan', vendor: 'anthropic', model: 'claude-fable-5-2', lab: 'anthropic'}, {purpose: 'work', vendor: 'openai', model: 'gpt-6-astra', lab: 'openai'}, ...all];
      assert.throws(() => reviewSeatsByModel({n: 1, contributions}), e => e.code === 'NO_SEATS');
      const p = {hash: 'sha256:' + '1'.repeat(64), identity, stage: 'plan', status: 'passed', outputs: {plan: {...planFor(''), requirement: {title: 'alpha succeeds', basis: 'alpha.mjs exports ok as true'}}}};
      const i = {hash: 'sha256:' + '2'.repeat(64), identity, stage: 'implement', status: 'passed', handoff: {from: p.hash}, outputs: {base, commit, contributions}};
      const r = {hash: 'sha256:' + '3'.repeat(64), identity, stage: 'review', status: 'passed', handoff: {from: i.hash}, outputs: {commit}, findings: []};
      const asked = [];
      const ex = makeExecutors({repo, stateDir: f.stateDir, independence: 'model', makeClientFor: () => { throw new Error('no live client'); },
        turn: async ({vendor, model}) => { asked.push(`${vendor}/${model}`); return {text: ACCEPT, served_model: model}; }});
      const v = await ex.validate({item, upstream: r, work: {root: f.workRoot, stages: () => [p, i, r]}, attempt: 1, budget: {provider_calls: 4}});
      assert.equal(v.status, 'pending', 'on 10cbd52 this passed with independent: false, validated by contributing grok-4.7');
      assert.match(v.blocker.what, /^REVIEW_CAPACITY_PENDING: no eligible validator/);
      assert.deepEqual(asked, [], 'no contributor was asked');
      assert.equal(v.outputs.validator, undefined);
      assert.ok(v.outputs.commit === commit && v.outputs.tests.length, 'the work and its test results are kept');
    }
  });
});

test('LIFECYCLE: a recorded reassessment stops the disqualified review, and the validation resting on it, from being reused; the work is re-reviewed; a Resolved item is marked for re-verification and left alone', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'active'}, {item: 'ticketed'}, {item: 'done'}], {tickets: ['ticketed']});
    ctx.serve((_v, m) => m);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model'});
    const upToValidate = {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate};
    const go = executors => tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: LIMITS});
    await go(ex);                                    // all three reach an outcome
    let w = openWorkLedger({root: f.workRoot});
    // `done` is applied by the owner: Resolved, with evidence.
    const out = w.stages('done').find(s => s.stage === 'outcome');
    applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'))});
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'done').gate.gate, 'complete');
    const statusEntries = openStatusLedger({root: f.statusRoot, create: false}).board().entries;
    // A later alias correction (SYNTHETIC test data, not a claim about these models): the shared-lab reviewer's model
    // is declared to be the same model as a contributor of that lab.
    const corrected = item => {
      const [, impl, rev] = w.stages(item);
      const shared = rev.team.find(t => rev.outputs.shared_labs.includes(t.lab));
      const sibling = contributorKeys(impl.contributions).models.find(m => m.startsWith(`${shared.lab}/`)).split('/')[1];
      return {shared, policy: {...currentPolicy(), same_model: {...currentPolicy().same_model, [shared.model]: sibling}}};
    };
    const before = Object.fromEntries(['active', 'ticketed', 'done'].map(i => [i, w.stages(i).length]));
    const fixes = {};
    for (const item of ['active', 'ticketed', 'done']) {
      fixes[item] = corrected(item);
      const r = reassessItem({work: w, item, policy: fixes[item].policy});
      assert.deepEqual(r.recorded.map(x => x.stage), ['review'], JSON.stringify(r.skipped));
      assert.equal(reassessItem({work: openWorkLedger({root: f.workRoot}), item, policy: fixes[item].policy}).recorded.length, 0, 'the same evidence is not recorded twice');
    }
    w = openWorkLedger({root: f.workRoot});
    const gates = Object.fromEntries(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.map(i => [i.item, i.gate]));
    // Active work: the disqualified review is not reused, nor the validation and outcome that rested on it.
    for (const item of ['active', 'ticketed']) {
      assert.equal(gates[item].gate, 'review', 'on 10cbd52 the gate stayed where it was and the review was reused');
      assert.equal(gates[item].mode, 'rereview');
      assert.deepEqual(Object.keys(gates[item].reuse).sort(), ['implement', 'plan'], 'the plan and the implementation stand; the review, validation and outcome do not');
    }
    // A Resolved item: the need is recorded; the owner's signed status is not rewritten and the item is not reopened.
    assert.equal(gates.done.gate, 'reverification-needed');
    assert.equal(gates.done.blocker.role, 'decision-authority');
    await go(ex);
    w = openWorkLedger({root: f.workRoot});
    assert.equal(openStatusLedger({root: f.statusRoot, create: false}).board().entries, statusEntries, 'no status was recorded');
    assert.equal(openStatusLedger({root: f.statusRoot, create: false}).board().items.find(i => i.item === 'done').state, 'Resolved');
    assert.equal(w.stages('done').length, before.done, 'the Resolved item was not dispatched');
    for (const item of ['active', 'ticketed']) {
      // A bounded re-review: one new review, then validation and outcome again on it.
      const added = w.stages(item).slice(before[item]);
      assert.deepEqual(added.map(s => `${s.stage}:${s.status}`), ['review:passed', 'validate:passed', 'outcome:passed']);
      const [, impl, old] = w.stages(item), [rev2, val2, out2] = added;
      assert.equal(rev2.outputs.rereview_of.replaces, old.hash);
      assert.notEqual(rev2.outputs.cycle, old.outputs.cycle);
      // Its panel was chosen under the corrected policy: the model the correction identified is not on it. Three labs, still.
      const panel = rev2.team.filter(t => t.role === 'cycle-reviewer');
      assert.equal(new Set(panel.map(t => t.lab)).size, 3);
      assert.ok(!panel.some(t => t.model === fixes[item].shared.model), `${fixes[item].shared.model} reviewed again`);
      assert.equal(val2.handoff.from, rev2.hash, 'validation rests on the new review');
      // History is intact: the earlier cycle still verifies on the run ledger, under the policy it recorded.
      const sys = openPantheonLedger({root: impl.outputs.run.ledger, anchor: impl.outputs.run.ledger_anchor, board: openBoard(impl.outputs.run.board)});
      assert.equal(sys.recorder().verify().ok, true);
      assert.ok(sys.recorder().cycleState(old.outputs.cycle).close, 'the earlier cycle is still closed, unchanged');
      // The new outcome is one the owner can apply: evidence checked structurally, the re-review on its own ledger.
      const applied = applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(out2.outputs.proposal_path, 'utf8'))});
      assert.equal(applied.checked.checked, 'structural');
    }
    assert.equal(openWorkLedger({root: f.workRoot}).verify().ok, true);
    void upToValidate;
  });
});
