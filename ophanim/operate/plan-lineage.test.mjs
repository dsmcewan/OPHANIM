// The PLAN's contribution lineage across resume and revision, and the input-model marker on the planner's turn
// (stages.mjs plan()). Seats are scripted; nothing here is a live model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {contributorKeys, candidateRefusal} from '../../pantheon/src/review/identity.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, APPROVE, ACCEPT, json, planFor, scriptedTurn, LIMITS, FIVE, SIX, stagesOf} from './test-fixtures.mjs';

// Independent review, assignment 1 (Google, 09d490f), question 3: plan v1 drew a finding from an xAI plan reviewer and
// was revised; one reviewer of v2 failed transiently, so the stage was pending with v2's cycle open. The retry resumed
// that cycle but re-initialised the contributions with the planner alone: the xAI finder, whose finding the approved
// v2 answers, was no longer a contributor of the plan or of anything downstream.
test('resuming an open plan-review cycle keeps the earlier plan-review finders in the plan\'s contributions', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_v, m) => m);
    const f = fixture(repo, [{item: 'plan-lineage'}]);
    let failOnceOnV2 = true;
    const turn = scriptedTurn({
      'plan-review': ({vendor, prompt}) => {
        const isV2 = /\+\s*"n":\s*2\b/.test(prompt);
        if (!isV2 && vendor === 'xai') return json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'add explicit rollback note', reproduction: null}]});
        if (isV2 && vendor === 'openai' && failOnceOnV2) { failOnceOnV2 = false; throw new Error('503 transient failure on v2 plan review'); }
        return APPROVE;
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    assert.deepEqual(stagesOf(r1), ['plan:pending']);
    const pending = openWorkLedger({root: f.workRoot}).stages('plan-lineage')[0];
    const finder = pending.contributions.find(c => c.purpose === 'plan-review' && c.lab === 'xai');
    assert.ok(finder, 'attempt 1 records the xai finder as a contributor');

    now += 20 * 60_000;
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    // The resumed plan passes and the work goes on through a change review and validation: the panels below exist.
    assert.deepEqual(stagesOf(r2), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const passed = w.stages('plan-lineage').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.equal(passed.outputs.plan.answers.length, 1, 'the approved v2 answers the xai finding');
    assert.ok(passed.contributions.some(c => c.purpose === 'plan-review' && c.vendor === finder.vendor && c.model === finder.model),
      'the xai finder is still a contributor of the plan after the resume');
    // So it is excluded from every later panel and from validating.
    const keys = contributorKeys(passed.contributions);
    assert.ok(candidateRefusal({vendor: finder.vendor, model: finder.model}, keys), `${finder.model} is eligible downstream after the resume`);
    const rev = w.stages('plan-lineage').find(s => s.stage === 'review' && s.status === 'passed');
    assert.ok(rev, 'a change review passed: its panel is the later panel checked here');
    assert.ok(rev.outputs.author_models.includes(`xai/${finder.model}`), 'the review cycle excludes the plan-review finder');
  });
});

// Independent review, assignment 2 (OpenAI gpt-6-astra, 09d490f), question 6: a revised plan inherited the previous
// plan's contributions EXCEPT every `purpose: 'plan'` row, although the revision consumes that plan. When the planner
// seat changed between versions, the previous planner was no longer a contributor and could review the revision.
test('a revised plan keeps the previous planner as a contributor, also when the planner seat changed', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_v, m) => m);
    const f = fixture(repo, [{item: 'plan-defect'}]);
    let judged = 0;
    // The first plan declares itself hard, so the ticket it derives seats the revision's planner from that difficulty
    // (an item without a ticket plans at medium): a different planner seat writes the revision.
    const turn = scriptedTurn({
      planner: ({prompt}) => json(planFor(prompt, /Mode: revise/.test(prompt) ? {} : {difficulty: 'hard'})),
      validator: () => (++judged > 1 ? ACCEPT
        : json({verdict: 'plan_defect', reasons: ['criterion a1 does not test that alpha.mjs keeps its other exports'], criteria: [{id: 'a1', met: true, why: 'passes, but is inadequate'}]})),
    });
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, ...SIX});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const stages = openWorkLedger({root: f.workRoot}).stages('plan-defect');
    const plans = stages.filter(s => s.stage === 'plan' && s.status === 'passed');
    assert.ok(plans.length >= 2, JSON.stringify(stages.map(s => `${s.stage}:${s.status}`)));
    const [first, revised] = plans;
    assert.equal(revised.outputs.plan.mode, 'revise');
    const was = first.outputs.planner, now = revised.outputs.planner;
    assert.notDeepEqual([was.vendor, was.model], [now.vendor, now.model], 'the fixture must change the planner seat between versions');
    for (const p of [was, now]) {
      assert.ok(revised.contributions.some(c => c.purpose === 'plan' && c.vendor === p.vendor && c.model === p.model), `${p.model} is not a contributor of the revised plan`);
    }
  });
});

// Independent review, assignment 2 (OpenAI gpt-6-astra, 09d490f), question 9: an Antigravity answer carries
// `served_model_source: "input"` (the pinned model was recorded as the served one; no provider said so). The planner's
// ledger turn dropped the marker, so the recorded served name read as the provider's statement.
test('the planner\'s ledger turn keeps the input-model marker of its answer', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, serve}) => {
    serve((_v, m) => m);
    const f = fixture(repo, [{item: 'marked'}]);
    const turn = scriptedTurn({planner: ({prompt, model}) => ({text: json(planFor(prompt)), served_model: model, served_model_source: 'input'})});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, ...FIVE});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const plan = openWorkLedger({root: f.workRoot}).stages('marked').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.ok(plan, 'the plan passed');
    const sys = openPantheonLedger({root: plan.outputs.plan_ledger});
    const turns = sys.ledger.read().filter(e => e.kind === 'turn').map(e => sys.ledger.payloadOf(e)).filter(p => p.purpose === 'plan');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].served_model, plan.outputs.planner.model);
    assert.equal(turns[0].served_model_source, 'input', 'the substituted served name is marked as the input, not a provider\'s statement');
  });
});
