// The validator is checked by the model that ANSWERED, and the in-run code review's findings count as contributions
// (corrections after the review of b9fa745). Model-level independence (`independence: 'model'`), the four real labs
// and their real model inventory; seats are scripted. The policy stays off by default.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {withDispatch, WORK} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, APPROVE, json, ACCEPT, scriptedTurn, LIMITS} from './test-fixtures.mjs';

const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
// One plan-review finding from the xai seat, so that xai's grok-4.7 is a contributor to everything that follows.
const xaiFinds = () => { let asked = 0; return ({vendor}) => (vendor === 'xai' && ++asked === 1
  ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'the plan names no regression check', reproduction: null}]}) : APPROVE); };

test('4. a validator answer served by a contributor, or by an unresolved model, is not accepted: it is kept on the record and the item does not reach an outcome', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_vendor, model) => model);   // the scripted providers report the model they served
    const f = fixture(repo, [{item: 'val'}]);
    // Whatever seat is asked: the Google route answers as a model nobody declares, and xai answers as grok-4.7.
    const turn = scriptedTurn({'plan-review': xaiFinds(),
      validator: ({vendor}) => ({text: ACCEPT, served_model: vendor === 'xai' ? 'grok-4.7' : 'unreleased-model-x'})});
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
    // The fallback seat: grok-4.6 was asked, grok-4.7 (the plan-review finder) answered.
    const sib = rej.find(x => x.vendor === 'xai');
    assert.deepEqual([sib.model, sib.served_model], ['grok-4.6', 'grok-4.7']);
    assert.match(sib.why, /xai\/grok-4\.7 contributed to the change under review/);
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
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
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

test('an in-run code-review finding is followed by a code revision: the stopped run is RESUMED, the finding reaches the worker, and that reviewer model is excluded from the change review', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, review, implement, calls, serve}) => {
    serve((_vendor, model) => model);   // the scripted providers report the model they served
    const f = fixture(repo, [{item: 'inrun'}]);
    // Pantheon's own in-run checker requests changes of the first, passing revision. (`fit` routing: the worker has
    // effort headroom, so the escalation protocol decides a revision. The fixture routes any prompt that mentions a
    // verdict to this hook; the worker's revision prompt quotes the reviewer, so the hook answers that one as the worker.)
    let reviews = 0, builds = 0;
    review(({prompt}) => (WORK.test(prompt) ? (builds++, '// frozen: the importer reads it lazily\nexport const ok = true;\n')
      : /^Attack the artifact/.test(prompt) && ++reviews === 1 ? 'export ok as a frozen constant; a comment must say why\nVERDICT: request_changes' : null));
    implement(() => (builds++, 'export const ok = true;\n'));
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'fit'});
    const go = () => tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    await go();
    const w = () => openWorkLedger({root: f.workRoot});
    // The run stops unshipped with the finding pending (Pantheon ends a run on a rejection of passing work).
    assert.deepEqual(seq(w(), 'inrun'), ['plan:passed', 'implement:failed']);
    assert.equal(w().stages('inrun')[1].outputs.pending_revision, true);
    await go();
    assert.deepEqual(seq(w(), 'inrun'), ['plan:passed', 'implement:failed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    const [, stopped, impl, rev, val] = w().stages('inrun');
    // Resumed, not restarted: the same board, one first build and one revision, each attempt charged its own calls.
    assert.equal(impl.outputs.resumed_from, stopped.hash);
    assert.equal(impl.outputs.run.board, stopped.outputs.board);
    assert.equal(builds, 2, 'the work was not repeated');
    assert.ok(calls.some(c => WORK.test(c.prompt) && /export ok as a frozen constant/.test(c.prompt)), 'the finding reached the worker\'s revision prompt');
    assert.equal(stopped.usage.provider_calls + impl.usage.provider_calls, calls.length, 'no call is charged twice or dropped');
    // The in-run reviewer is now a contributor to the change, by model.
    const critic = impl.contributions.find(c => c.purpose === 'critique');
    assert.ok(critic && critic.model, JSON.stringify(impl.contributions));
    const work = impl.contributions.find(c => c.purpose === 'work');
    // Inside the run the checker still follows the LAB rule: the revised bytes were reviewed by a lab that is neither
    // the worker's nor the critic's.
    const run = JSON.parse(fs.readFileSync(path.join(impl.outputs.run.board, 'run.json'), 'utf8'));
    const second = run.turns.filter(t => t.purpose === 'critique').at(-1);
    assert.ok(![work.lab, critic.lab].includes(second.vendor === 'agy_google' ? 'google' : second.vendor), JSON.stringify(run.turns.map(t => [t.purpose, t.vendor, t.model])));
    // The change review (model rule): three distinct labs, none of the planner's, worker's or critic's models.
    assert.ok(rev.outputs.author_models.includes(`${critic.lab}/${critic.model}`), JSON.stringify(rev.outputs.author_models));
    const panel = rev.team.filter(t => t.role === 'cycle-reviewer');
    assert.equal(new Set(panel.map(t => t.lab)).size, 3);
    for (const t of panel) assert.ok(!rev.outputs.author_models.includes(`${t.lab}/${t.model}`), `${t.lab}/${t.model} contributed`);
    assert.notEqual(`${val.outputs.validator.lab}/${val.outputs.validator.model}`, `${critic.lab}/${critic.model}`);
  });
});
// Default routing (argo) used to stop here with no revision pending. That gap is closed: see revision-reassessment.test.mjs.
