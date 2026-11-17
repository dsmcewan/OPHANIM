// Model-level review independence in the lifecycle (stages.mjs `independence: 'model'`, pantheon.cycle/v3), on the
// REAL four configured labs and their real model inventory: no synthetic lab. Seats are scripted; nothing here is a
// live model. The policy is implemented and tested, and NOT active: the default stays the lab rule.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openStatusLedger, applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors, REVIEW_INDEPENDENCE, workContributions} from './stages.mjs';
import {reviewSeatsByModel} from '../../pantheon/src/ledger/review-cycle.mjs';
import {readServiceConfig, SERVICE_CONFIG_SCHEMA} from './service.mjs';
import {modelIdentity, contributorKeys, currentPolicy, policyDigest, reassess} from '../../pantheon/src/review/identity.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, fixture, APPROVE, json, planFor, ACCEPT, scriptedTurn, LIMITS, stagesOf} from './test-fixtures.mjs';

const REAL_LABS = ['anthropic', 'google', 'openai', 'xai'];
const idOf = t => modelIdentity(t.vendor, t.model).id;
const reviewers = rec => rec.team.filter(t => /reviewer$/.test(t.role));
const commit = (repo, files, msg) => { for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), c); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };

test('the policy is not active: the lab rule is the default, and neither the service config nor an unknown value can switch it', () => {
  assert.equal(REVIEW_INDEPENDENCE, 'lab');
  assert.throws(() => makeExecutors({repo: '/x', makeClientFor: () => {}, turn: async () => {}, independence: 'effort'}), /independence is "lab" or "model"/);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'indep-'));
  try {
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, interval_s: 60, limits: {total_provider_calls: 1}, review_independence: 'model'}));
    assert.throws(() => readServiceConfig(path.join(dir, 'c.json')), /unknown service config key/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('four real labs: an item without a ticket and one with an existing ticket complete the lifecycle; the panel is three distinct labs, no contributing model reviews, and the shared lab is recorded', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'fresh'}, {item: 'ticketed'}], {tickets: ['ticketed']});
    const turn = scriptedTurn();
    // The lab rule, for contrast, on the same items: implementation waits on review capacity.
    const lab = await tick({repo, statusRoot: f.statusRoot, workRoot: path.join(repo, 'status', 'work-lab'), limits: LIMITS,
      executors: makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: path.join(repo, 'status', 'operate-lab')})});
    assert.deepEqual(stagesOf(lab), ['plan:passed', 'implement:pending', 'plan:passed', 'implement:pending']);
    git(repo, 'checkout', '-q', '--', '.'); fs.rmSync(path.join(repo, 'tickets', 'fresh.json'), {force: true});

    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r), Array(2).fill(['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']).flat(), JSON.stringify(r.dispatched.map(d => [d.item, d.stage, d.status])));
    const w = openWorkLedger({root: f.workRoot});
    for (const item of ['fresh', 'ticketed']) {
      const [plan, impl, rev, val, out] = w.stages(item);
      assert.equal(plan.outputs.plan.mode, item === 'ticketed' ? 'revalidate' : 'author');
      // Plan review: three distinct real labs; the planner's own model is not among them.
      const pr = reviewers(plan);
      assert.equal(new Set(pr.map(t => t.lab)).size, 3);
      assert.ok(pr.every(t => REAL_LABS.includes(t.lab)), 'only configured labs');
      assert.ok(!pr.map(idOf).includes(idOf(plan.outputs.planner)));
      // Change review: contributors are an Anthropic planner and an OpenAI implementer; the panel is still three labs.
      const keys = contributorKeys(impl.contributions);
      assert.deepEqual(keys.contributing_labs, ['anthropic', 'openai']);
      const cr = reviewers(rev);
      assert.equal(new Set(cr.map(t => t.lab)).size, 3);
      for (const t of cr) assert.ok(!keys.models.includes(idOf(t)), `${idOf(t)} contributed and reviewed`);
      assert.deepEqual(rev.outputs.author_models, keys.models);
      assert.equal(rev.outputs.shared_labs.length, 1, 'one seat shares a lab with a contributor, and the record says which');
      assert.ok(['anthropic', 'openai'].includes(rev.outputs.shared_labs[0]));
      // The cycle on the run ledger is v3 and its close names the shared lab.
      const sys = openPantheonLedger({root: impl.outputs.run.ledger, anchor: impl.outputs.run.ledger_anchor, board: openBoard(impl.outputs.run.board)});
      const payload = h => sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === h));
      assert.equal(payload(rev.outputs.cycle).contract, 'pantheon.cycle/v3');
      assert.deepEqual(payload(rev.outputs.close).shared_labs, rev.outputs.shared_labs);
      assert.equal(sys.recorder().verify().ok, true);
      // The validator is not a contributor either; the owner can apply the outcome (three labs, checked structurally).
      assert.ok(!keys.models.includes(idOf(val.outputs.validator)));
      const applied = applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'))});
      assert.equal(applied.checked.checked, 'structural');
    }
    assert.ok(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.every(i => i.gate.gate === 'complete'));
    // A LATER alias correction: the shared-lab reviewer's model is declared to be the same model as a contributor.
    // That is new evidence about the closed cycle, recorded as such; the cycle's ledger and the item's status are unchanged.
    const [, impl, rev] = w.stages('fresh');
    const sys = openPantheonLedger({root: impl.outputs.run.ledger, anchor: impl.outputs.run.ledger_anchor, board: openBoard(impl.outputs.run.board)});
    const state = sys.recorder().cycleState(rev.outputs.cycle);
    const shared = reviewers(rev).find(t => rev.outputs.shared_labs.includes(t.lab));
    const sibling = contributorKeys(impl.contributions).models.find(m => m.startsWith(`${shared.lab}/`)).split('/')[1];
    const corrected = {...currentPolicy(), same_model: {...currentPolicy().same_model, [shared.model]: sibling}};
    const again = reassess({cycle: state.cycle, reviews: state.reviews, policy: corrected});
    assert.equal(again.changed, true);
    assert.equal(again.findings.length, 1);
    assert.match(again.findings[0].why, new RegExp(`${shared.lab}/${sibling} contributed`));
    w.recordReassessment({item: 'fresh', cycle: rev.outputs.cycle, recorded_policy: again.recorded, policy: again.policy, findings: again.findings});
    assert.equal(openWorkLedger({root: f.workRoot}).reassessments('fresh').length, 1);
    assert.equal(sys.recorder().verify().ok, true, 'the recorded cycle still verifies under the policy it recorded');
    assert.equal(again.recorded, policyDigest(state.cycle.identity_policy.rules));
    assert.throws(() => w.recordReassessment({item: 'fresh', cycle: rev.outputs.cycle, recorded_policy: again.recorded, policy: again.recorded, findings: []}), /another one/);
    assert.equal(openStatusLedger({root: f.statusRoot, create: false}).board().items.filter(i => i.state === 'Resolved').length, 2);
  });
});

test('four real labs, repeated revisions: contributions come to span all four labs and each later panel is still three labs of models that never contributed', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, implement}) => {
    const f = fixture(repo, [{item: 'cyc'}]);
    commit(repo, {'alpha.mjs': 'export const ok = false;\nexport const legacy = 1;\n',
      'consumer.mjs': 'import {ok, mode} from \'./alpha.mjs\';\nif (ok && mode !== \'strict\') process.exit(1);\n',
      'legacy-user.mjs': 'import {legacy} from \'./alpha.mjs\';\nif (legacy !== 1) process.exit(1);\n'}, 'consumers');
    const crit = (...ids) => ids.map(id => ({a1: {id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd: 'node verify.mjs'}},
      a2: {id: 'a2', criterion: 'consumer.mjs runs: mode is strict when ok', test: {cmd: 'node consumer.mjs'}},
      a3: {id: 'a3', criterion: 'legacy-user.mjs still runs', test: {cmd: 'node legacy-user.mjs'}}}[id]));
    let planReviews = 0, validations = 0;
    const turn = scriptedTurn({
      planner: ({prompt}) => {
        const told = /## Findings to answer[^\n]*\n((?:- .*\n?)*)/.exec(prompt)?.[1] ?? '', prev = /## Previous plan\n([\s\S]*?)\n## /.exec(prompt)?.[1] ?? '';
        return json(planFor(prompt, {acceptance: crit('a1', ...(/consumer/.test(told) || /"id": "a2"/.test(prev) ? ['a2'] : []), ...(/legacy-user/.test(told) ? ['a3'] : [])),
          copy: ['alpha.mjs', 'verify.mjs', 'consumer.mjs', 'legacy-user.mjs']}));
      },
      // The first plan review: the xai seat finds the missing consumer criterion (so xai's model becomes a contributor).
      'plan-review': ({vendor, prompt}) => (vendor === 'xai' && ++planReviews === 1 && !/node consumer\.mjs/.test(prompt.split('```diff')[1] ?? '')
        ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: '[source: consumer.mjs] no criterion covers consumer.mjs', reproduction: null}]}) : APPROVE),
      // The first validation returns the plan (so the validator's model becomes a contributor); later ones accept.
      validator: ({prompt}) => { const met = [...new Set(prompt.match(/"id": "a\d"/g))].map(x => ({id: x.slice(7, 9), met: true, why: 'passes'}));
        return ++validations === 1 ? json({verdict: 'plan_defect', reasons: ['legacy-user.mjs reads legacy and no criterion covers it'], criteria: met})
          : json({verdict: 'accept', reasons: ['meets the requirement and every criterion'], criteria: met}); },
    });
    implement(() => 'export const ok = true;\nexport const mode = \'strict\';\nexport const legacy = 1;\n');
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'model'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(w.stages('cyc').map(s => `${s.stage}:${s.status}`),
      ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'], JSON.stringify(r.dispatched.map(d => [d.stage, d.status, d.next])));
    const [plan1, , , val1, plan2, impl2, rev2, val2] = w.stages('cyc');
    // Revision 1 of the plan answers xai's finding: that xai MODEL does not review it, though another xai model may.
    const [v1, v2] = plan1.outputs.versions;
    assert.ok(v1.reviews.some(x => x.verdict === 'request_changes') && v2.reviews.length === 3);
    const finder = plan1.contributions.find(c => c.purpose === 'plan-review');
    assert.equal(finder.lab, 'xai');
    assert.ok(!reviewers(plan1).map(idOf).includes(idOf(finder)), 'the finder\'s model is not on the revision\'s panel');
    // By the second cycle the history holds a planner, a plan-review finder, an implementer and a validator: all four labs.
    const history = contributorKeys(impl2.contributions);
    assert.deepEqual(history.contributing_labs, REAL_LABS, JSON.stringify(impl2.contributions.map(c => [c.purpose, c.lab, c.model])));
    assert.ok(history.models.includes(idOf(val1.outputs.validator)) && history.models.includes(idOf(finder)) && history.models.includes(idOf(plan1.outputs.planner)), 'the full contribution history is kept through the revisions');
    for (const rec of [plan2, rev2]) {
      const panel = reviewers(rec);
      assert.equal(new Set(panel.map(t => t.lab)).size, 3, `${rec.stage}: three distinct labs`);
      assert.ok(panel.every(t => REAL_LABS.includes(t.lab)));
      for (const t of panel) assert.ok(!contributorKeys(rec.stage === 'plan' ? plan2.contributions : impl2.contributions).models.includes(idOf(t)), `${rec.stage}: ${idOf(t)} contributed earlier`);
    }
    assert.equal(rev2.outputs.shared_labs.length, 3, 'with all four labs contributing, every seat shares a lab with a contributor, and each is recorded');
    assert.ok(!history.models.includes(idOf(val2.outputs.validator)));
    assert.notEqual(idOf(val2.outputs.validator), idOf(val1.outputs.validator));
  });
});

test('an implementer turn that asked for one model and was served by another excludes both, in the contributions later stages carry', () => {
  const run = {turns: [{purpose: 'work', vendor: 'openai', model: 'gpt-6-astra', served_model: 'gpt-6-sol', slot: 'alpha'}], files: []};
  const carried = workContributions(run);
  assert.deepEqual(contributorKeys(carried).models, ['openai/gpt-6-astra', 'openai/gpt-6-sol']);
  // With both excluded, the only OpenAI model left in the real inventory is the third one.
  const openai = reviewSeatsByModel({n: 4, contributions: carried}).find(x => x.lab === 'openai');
  assert.equal(openai.identity, 'openai/gpt-6-luna');
});
