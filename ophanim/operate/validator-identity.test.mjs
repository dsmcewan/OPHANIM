// The validator is checked by the model that ANSWERED, and the in-run code review's findings count as contributions
// (corrections after the review of b9fa745). Model-level independence (`independence: 'model'`), the four real labs
// and their real model inventory; seats are scripted. The policy stays off by default.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {tickWithPrimary as tick} from './test-fixtures.mjs';   // every tick declares primary Gemini execution: the fit implementer is an SDK session
import {makeExecutors} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, APPROVE, json, ACCEPT, scriptedTurn, unitApprove, unitReject, LIMITS} from './test-fixtures.mjs';

const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
// One plan-review finding from the xai seat, so that xai's grok-4.7 is a contributor to everything that follows.
const xaiFinds = () => { let asked = 0; return ({vendor}) => (vendor === 'xai' && ++asked === 1
  ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'the plan names no regression check', reproduction: null}]}) : APPROVE); };

test('4. a validator answer served by a contributor, or by an unresolved model, is not accepted: it is kept on the record and the item does not reach an outcome', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_vendor, model) => model);   // the scripted providers report the model they served
    const f = fixture(repo, [{item: 'val'}]);
    // Whatever seat is asked: an OpenAI seat answers as gpt-6-luna (the easy unit's dispatcher, a Decision 6 arbiter), any
    // other as a model nobody declares. (Owner decision L-002 (2026-11-19): the change reviewers -- grok-4.6 among them --
    // are not asked at all, and a lab off the review panel, OpenAI here, is asked first.)
    const turn = scriptedTurn({'plan-review': xaiFinds(),
      validator: ({vendor}) => ({text: ACCEPT, served_model: vendor === 'openai' ? 'gpt-6-luna' : 'unreleased-model-x'})});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, stage_attempts: 1}});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'val'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:failed'], 'an ACCEPT from an ineligible model is not a validation');
    const val = w.stages('val').at(-1);
    assert.equal(val.outputs.cause, 'validation-defect');
    const rej = val.outputs.rejected_answers;
    assert.ok(rej.length >= 2);
    // The unresolved answers: requested and served names kept, with the reason and the reply's digest.
    const lost = rej.find(x => x.served_model === 'unreleased-model-x');
    assert.match(lost.why, /the model that answered is unresolved/);
    assert.equal(lost.verdict, 'accept');
    assert.match(lost.reply_sha, /^sha256:/);
    // The first seat: gpt-6-sol was asked (a lab outside the panel), gpt-6-luna (an arbiter of the change) answered.
    const sib = rej.find(x => x.vendor === 'openai');
    assert.deepEqual([sib.model, sib.served_model], ['gpt-6-sol', 'gpt-6-luna']);
    assert.match(sib.why, /openai\/gpt-6-luna contributed to the change under review/);
    // No seat that reviewed the passing change review was asked (owner decision L-002, 2026-11-19).
    const reviewed = w.stages('val').find(s => s.stage === 'review').team.map(t => `${t.vendor}/${t.model}`);
    assert.equal(reviewed.length, 3);
    assert.deepEqual(rej.filter(x => reviewed.includes(`${x.vendor}/${x.model}`)), []);
    assert.ok(!w.stages('val').some(s => s.stage === 'outcome'));
    assert.equal(new Set(rej.map(x => `${x.vendor}/${x.model}`)).size, rej.length, 'a seat whose answer was rejected is not asked again');
  });
});

test('4. after a rejected answer the next eligible seat is asked; the accepted record names the model asked for and the model that answered', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_vendor, model) => model);   // the scripted providers report the model they served
    const f = fixture(repo, [{item: 'val2'}]);
    let n = 0;
    const turn = scriptedTurn({'plan-review': xaiFinds(),
      // The first validator turn is served by the implementer's model; later turns answer as the model asked for (a dated snapshot of it).
      validator: ({model}) => ({text: ACCEPT, served_model: ++n === 1 ? 'gpt-6-astra' : `${model}-20261101`})});
    // profile 'argo', named since 2026-11-17 (the lifecycle default is now `fit`): the scenario names argo's implementer
    // model (gpt-6-astra) as the one that wrongly serves the first validator turn.
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'val2'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    const val = w.stages('val2').find(s => s.stage === 'validate');
    assert.equal(val.outputs.rejected_answers.length, 1);
    assert.equal(val.outputs.rejected_answers[0].served_model, 'gpt-6-astra');
    const v = val.outputs.validator;
    assert.equal(v.served_model, `${v.model}-20261101`);
    assert.equal(v.identity, v.served_identity, 'a snapshot of the model asked for is that model');
    assert.notEqual(`${val.outputs.rejected_answers[0].vendor}/${val.outputs.rejected_answers[0].model}`, `${v.vendor}/${v.model}`);
    assert.equal(v.independent, true);
    assert.equal(val.usage.provider_calls, 2, 'both answers were paid for and counted');
  });
});

// (Rewritten 2026-11-18 for the five-stage pipeline, which is what `fit` runs: the in-run reviewer is Stage 5, the
// revision happens inside the same run instead of by resuming a stopped board run, and — OWNER GOVERNANCE DECISION
// 2026-11-17, flagged for independent review — the pinned Stage 5 reviewer STAYS the unit's reviewer after its
// finding fed a revision. What is unchanged, and still asserted: the finding reaches the worker, the work is not
// repeated, every call is charged once, and that reviewer model is a contributor excluded from the three-lab change
// review and from validating. The resumed-run form of this test is kept for `argo` in revision-reassessment.test.mjs.)
test('an in-run code-review finding is followed by a code revision: the finding reaches the worker in the same run, and that reviewer model is excluded from the change review', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, calls, agy, sdk, agyWorker}) => {
    const FINDING = 'export ok as a frozen constant; a comment must say why';
    // Under the fit matrix the worker is an Antigravity SDK session (the fixture's scripted worker, writing in the
    // unit's worktree): it revises when its prompt carries the finding.
    agyWorker(`case "$prompt" in *"${FINDING}"*) : >> "$FAKE_AGY_LOG.told"; printf '// frozen: the importer reads it lazily\\nexport const ok = true;\\n' > "$dir/alpha.mjs" ;; *) printf 'export const ok = true;\\n' > "$dir/alpha.mjs" ;; esac\n`);
    const f = fixture(repo, [{item: 'inrun'}]);
    // The in-run reviewer (Stage 5, pinned to the dispatcher's model) requests changes of the first, passing revision.
    let reviews = 0;
    const turn = scriptedTurn({'unit-review': ({rubric, passed}) => JSON.stringify(++reviews === 1 || !passed ? unitReject(rubric, [FINDING]) : unitApprove(rubric))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model', profile: 'fit'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = () => openWorkLedger({root: f.workRoot});
    // The rejection is answered by a revision inside the run: one implement stage, which ships.
    assert.deepEqual(seq(w(), 'inrun'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    const [, impl, rev, val] = w().stages('inrun');
    const built = sdk().filter(a => a.agent === 'sdk-implementer').length;
    assert.equal(built, 2, 'one first build and one revision: the work was not repeated');
    assert.deepEqual(agy(), [], 'no agy CLI process was launched');
    assert.ok(fs.existsSync(path.join(repo, 'agy.log.told')), 'the finding reached the worker\'s revision prompt');
    const inRun = turn.log.filter(l => ['dispatcher', 'unit-review', 'subagent'].includes(l.kind)).length;
    assert.equal(impl.usage.provider_calls, calls.length + built + inRun, 'no call is charged twice or dropped');
    // The in-run reviewer is now a contributor to the change, by model.
    const critic = impl.contributions.find(c => c.purpose === 'critique');
    assert.ok(critic && critic.model, JSON.stringify(impl.contributions));
    const work = impl.contributions.find(c => c.purpose === 'work');
    assert.notEqual(work.lab, critic.lab);
    // Inside the run the pin holds (the owner's decision): the revised bytes were judged by the same Stage 5 model, and
    // the record says its finding fed the revision.
    const unit = JSON.parse(fs.readFileSync(impl.outputs.run.record, 'utf8')).units.alpha;
    assert.deepEqual(unit.reviews.map(r => [r.model, r.status, r.fed_revision]), [[critic.model, 'request_changes', true], [critic.model, 'approved', false]]);
    assert.equal(unit.reviewer_fed_revision, true);
    // The change review (model rule): three distinct labs, none of the planner's, worker's or critic's models.
    assert.ok(rev.outputs.author_models.includes(`${critic.lab}/${critic.model}`), JSON.stringify(rev.outputs.author_models));
    const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
    assert.equal(new Set(panel.map(t => t.lab)).size, 3);
    for (const t of panel) assert.ok(!rev.outputs.author_models.includes(`${t.lab}/${t.model}`), `${t.lab}/${t.model} contributed`);
    assert.notEqual(`${val.outputs.validator.lab}/${val.outputs.validator.model}`, `${critic.lab}/${critic.model}`);
  });
});
// Default routing (argo) used to stop here with no revision pending. That gap is closed: see revision-reassessment.test.mjs.
