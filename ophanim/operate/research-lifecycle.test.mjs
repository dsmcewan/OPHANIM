// RESEARCH THROUGH THE SCHEDULER (owner direction 2026-11-20: the Carbon 4 research and exploration team). The real
// reconciliation, gates, scheduler, plan stage, dossier and work ledger; scripted seats, and a scripted research session
// in place of the SDK transport (operate/research.test.mjs and pantheon's suites cover the session and the team).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {makeExecutors} from './stages.mjs';
import {tick as plainTick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {requestResearch, researchOf} from './research.mjs';
import {resolveModel} from '../../pantheon/src/review/identity.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS, FIVE, tickWithPrimary as tick} from './test-fixtures.mjs';

const VERSION = 'sha256:' + ''.padStart(64, '1');
const FINDING = 'RESEARCH-FINDING: alpha.mjs exports ok and nothing in the repository reads it yet.';
const part = (question, text = FINDING) => ({question, sources: [{ref: 'alpha.mjs'}], observations: [{id: 'o1', text, sources: ['alpha.mjs']}], hypotheses: [], dependencies: [], unresolved: [], next: []});
const lead = (over = {}) => ({question: 'root', sources: [], observations: [], hypotheses: [], dependencies: [], unresolved: [{id: 'u1', question: 'where is the ok export read?', why: 'needs a look'}], next: [],
  delegations: [], satisfied: false, material: false, summary: 'not yet', ...over});
const DELEGATE = {addresses: 'u1', question: 'Find every reader of the ok export in this repository.', specialty: 'source-inventory', scope: ['.'], expected_evidence: 'paths and lines', why: 'the plan needs it'};
/** A scripted research session: one billed request, then a coordinator that delegates once and concludes, or a specialist's report. */
function scriptedResearch({material = true} = {}) {
  const calls = [];
  const sdk = async ({seat, prompt, admit, control_dir, worktree, research = null}) => {
    const specialist = /^ROLE: research specialist/.test(prompt), round = Number(/ROUND (\d+) of/.exec(prompt)?.[1] ?? 0);
    calls.push({model: seat.model, specialist, round, prompt, control_dir, worktree, control_existed: fs.existsSync(control_dir), hide: research?.hide ?? null});
    admit({class: 'root', model: seat.model});
    const report = specialist ? part('Find every reader of the ok export in this repository.') : round === 1 ? lead({delegations: [DELEGATE]}) : lead({satisfied: true, material, unresolved: [], summary: 'ok is exported and unread'});
    return {text: JSON.stringify(report), examined: specialist ? [{tool: 'view_file', path: 'alpha.mjs', kind: 'file', sha256: VERSION, bytes: 3}] : [], served_model: seat.model, served_model_source: 'provider', usage: {total_token_count: 5}};
  };
  return {sdk, calls};
}
function lifecycle(ctx, {planner = ({prompt}) => json(planFor(prompt)), research = scriptedResearch(), items = ['alpha'], seating = FIVE.seating, exec = r => ({enabled: true, sdk: r.sdk}), antigravity = {}} = {}) {
  const repo = ctx.dir, f = fixture(repo, items.map(item => ({item}))), seen = [];
  const turn = scriptedTurn({planner: a => { seen.push(a.prompt); return planner(a, seen.length); }});
  const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'model', seating, facts: FIVE.facts, research: exec(research), antigravity});
  const at = {repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS};
  const w = () => openWorkLedger({root: f.workRoot});
  const gate = item => reconcile({repo, statusRoot: f.statusRoot, workLedger: w(), issues: null}).items.find(i => i.item === item).gate;
  return {repo, f, at, w, gate, seen, research, plans: item => w().stages(item).filter(s => s.stage === 'plan')};
}
const QUESTION = 'What reads the ok export, and what would changing it touch?';
const googleReviewer = rec => rec.team.find(r => r.role === 'plan-reviewer' && r.lab === 'google');

test('RESEARCH ACTIVATES BEFORE A PLAN EXISTS, WITH NO TEAM ASSEMBLED BY HAND: a request on a new item is run by the plan stage before the planner is asked; the planner is shown the findings; every request is billed through the policy on the work ledger and counted in the stage\'s calls', {timeout: 300_000}, async () => {
  await withDispatch(async ctx => {
    const L = lifecycle(ctx);
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    assert.deepEqual([L.gate('alpha').gate, L.plans('alpha').length], ['plan', 0], 'no plan exists yet');
    const t = await tick(L.at);
    const [plan] = L.plans('alpha');
    assert.deepEqual(t.dispatched.map(d => [d.item, d.stage, d.status]), [['alpha', 'plan', 'passed']]);
    // THE TEAM: a scout on Carbon (the trigger's role), one Hydrogen specialist one level down, then the conclusion.
    assert.deepEqual(L.research.calls.map(c => [c.model, c.specialist, c.round]), [['gemini-4-carbon', false, 1], ['gemini-4-hydrogen', true, 0], ['gemini-4-carbon', false, 2]]);
    const r = researchOf(L.w(), 'alpha');
    assert.deepEqual([r.teams.map(x => [x.role, x.trigger, x.request, x.coordinator.model]), r.open, r.conclusions.map(c => [c.request, c.satisfied, c.telemetry.depth_reached])], [[['scout', 'intake', request, 'gemini-4-carbon']], [], [[request, true, 2]]]);
    assert.match(L.research.calls[0].prompt, /WHAT IS ALREADY KNOWN \(the controller's initial view\):[\s\S]*Original requirement/, 'the coordinator starts from the dossier, not from nothing');
    // WHAT THE CONTROLLER KEEPS INSIDE THE REPOSITORY IS HIDDEN FROM EVERY SESSION (independent review, lifecycle finding 1):
    // the work ledger with its private key, the item's state, and the owner's status keys.
    for (const c of L.research.calls) assert.deepEqual([L.f.workRoot, L.f.stateDir, path.join(L.f.statusRoot, 'keys')].map(p => c.hide.includes(p)), [true, true, true], `${c.model} round ${c.round}`);
    // BEFORE THE PLANNER: the one planner prompt already holds the findings, as a dossier view with its version.
    assert.equal(L.seen.length, 1);
    assert.ok(L.seen[0].includes(FINDING) && L.seen[0].includes('alpha.mjs@sha256:111111111111'), 'the planner was shown the finding with its source and version');
    const view = plan.outputs.context.dossier.entries.find(e => e.source === 'research:alpha');
    assert.deepEqual([view.kind, typeof view.version, plan.outputs.context.research, plan.outputs.context.research_ran.map(x => [x.trigger, x.status, x.concluded])], ['derived', 'string', [r.conclusions[0].hash], [['intake', 'satisfied', true]]]);
    // SPEND: three sessions, three billed requests, each on the work ledger under the plan stage's claim, and in the stage's count.
    assert.deepEqual(L.w().billings().map(b => [b.kind, b.model, b.purpose, b.role, b.transport, b.stage]), [['primary', 'gemini-4-carbon', 'research', 'scout', 'sdk', 'plan'], ['primary', 'gemini-4-hydrogen', 'research', 'scout', 'sdk', 'plan'],
      ['primary', 'gemini-4-carbon', 'research', 'scout', 'sdk', 'plan']]);
    assert.equal(plan.usage.gemini.billed.gemini_api_primary, 3);
    assert.ok(plan.usage.provider_calls >= 3 + 1 + 3, `the research requests are provider calls of the stage (${plan.usage.provider_calls}: 3 research, the planner, the plan reviewers)`);
    const evidenceDir = path.join(L.f.stateDir, 'alpha', 'research', r.teams[0].team);
    assert.ok(fs.existsSync(path.join(evidenceDir, 'findings.json')), 'the full record is in the item\'s state');
    // THE ITEM'S STATE IS INSIDE THE REPOSITORY HERE, AND THE SESSIONS READ THE REPOSITORY: each session's own directory
    // (its runtime state, written by the session) is outside it, existed for the session, and is gone after it.
    const inRepo = p => !path.relative(fs.realpathSync(L.repo), p).startsWith('..');
    assert.ok(inRepo(fs.realpathSync(evidenceDir)), 'the fixture keeps the item\'s state in the repository');
    assert.deepEqual(L.research.calls.map(c => [c.worktree === fs.realpathSync(L.repo) || c.worktree === L.repo, inRepo(c.control_dir), c.control_existed, fs.existsSync(c.control_dir)]), [[true, false, true, false], [true, false, true, false], [true, false, true, false]]);
  });
});

test('INDEPENDENT REVIEW ELIGIBILITY FOLLOWS THE RESEARCH: its members are contributors to the plan, with the model asked and the model that answered; the plan\'s panel is seated outside those models and says which lab it shares; without research the panel is as it was', {timeout: 300_000}, async () => {
  await withDispatch(async ctx => {
    // A pool whose first Google reviewer is a Carbon seat: the model the research coordinator runs on.
    const at = FIVE.seating.reviewer.findIndex(r => r.vendor === 'agy_google');
    const seating = {...FIVE.seating, reviewer: [...FIVE.seating.reviewer.slice(0, at), {vendor: 'agy_google', model: 'gemini-4-carbon-high', band: 'easy', basis: 'ISOLATION', why: 'test: a Carbon reviewer ahead of the pool\'s own Google seat'},
      ...FIVE.seating.reviewer.slice(at)]};
    const L = lifecycle(ctx, {items: ['alpha', 'beta'], seating});
    requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    await tick(L.at);
    const [researched] = L.plans('alpha'), [plain] = L.plans('beta');
    assert.deepEqual(researched.contributions.filter(c => c.purpose === 'research').map(c => [c.vendor, c.model, c.lab, c.served_model_source]), [['agy_google', 'gemini-4-carbon', 'google', 'provider'], ['agy_google', 'gemini-4-hydrogen', 'google', 'provider']],
      'one row per model that answered: several Hydrogen members would still be one row');
    assert.deepEqual(plain.contributions.filter(c => c.purpose === 'research'), []);
    // The control: with no research the Google seat of the plan's panel is a seat the research would have contributed on.
    const before = googleReviewer(plain), after = googleReviewer(researched);
    const baseOf = model => resolveModel('agy_google', model).base;
    assert.equal(baseOf(before.model), 'gemini-4-carbon', `the unresearched plan's Google reviewer is ${before.model}`);
    assert.ok(!['gemini-4-carbon', 'gemini-4-hydrogen'].includes(baseOf(after.model)), `the researched plan's Google reviewer (${after.model}) is not a model that researched it`);
    assert.deepEqual([after.shared_lab, [...after.shared_with].sort()], [true, ['google/gemini-4-carbon', 'google/gemini-4-hydrogen']], 'and the shared lab is on the record');
    assert.deepEqual([researched.outputs.plan_review.outcome, [...researched.outputs.plan_review.labs].sort()], ['verified', ['google', 'openai', 'xai']], 'three labs still review it');
  });
});

test('A REQUEST DURING THE LIFECYCLE PUTS THE APPROVED PLAN IN QUESTION: the plan is stale while the request is open, the plan stage runs the research and plans again on its findings; and a conclusion that changes what a plan should rest on makes stale any plan that was not given it', {timeout: 300_000}, async () => {
  await withDispatch(async ctx => {
    const L = lifecycle(ctx);
    await tick(L.at);
    assert.deepEqual([L.plans('alpha').map(p => p.status), L.gate('alpha').gate, L.research.calls.length], [['passed'], 'implement', 0], 'planned with no research: none was asked for');
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'review-finding', question: 'Does anything outside alpha.mjs depend on the value of ok?', by: 'check@review'});
    const g = L.gate('alpha');
    assert.deepEqual([g.gate, g.stale.map(s => s.why.join('; '))], ['plan', ['research was requested and is not answered yet (review-finding)']]);
    await tick(L.at);
    const plans = L.plans('alpha'), r = researchOf(L.w(), 'alpha');
    assert.deepEqual([plans.map(p => p.status), r.open, r.teams.map(x => [x.role, x.trigger]), plans[1].outputs.context.research], [['passed', 'passed'], [], [['researcher', 'review-finding']], [r.conclusions[0].hash]]);
    assert.ok(L.seen[1].includes(FINDING), 'the second plan was written with the findings');
    assert.equal(L.gate('alpha').gate, 'implement', 'the plan that was given the research stands');
    assert.equal(request, r.conclusions[0].request);
    // A MATERIAL CONCLUSION THE PLAN WAS NOT GIVEN (recorded here as a team run elsewhere would record it).
    const w = L.w(), team = {item: 'alpha', team: 'rt-00000000000000aa'}, seat = {vendor: 'agy_google', model: 'gemini-4-carbon', effort: 'high'};
    w.recordResearch({phase: 'team', ...team, request: null, trigger: 'contradiction', role: 'explorer', coordinator: seat, subordinate: {...seat, model: 'gemini-4-hydrogen'}, selection: null, limits: {max_depth: 10}, root: 'rn-0000000000000000'});
    const conclusion = phase => ({phase: 'conclusion', request: null, status: 'satisfied', stop_reason: 'SATISFIED', satisfied: true, summary: 'ok is read by a consumer', findings_text: '- ok is read by beta.mjs [beta.mjs@sha256:2222]', findings: null,
      telemetry: {depth_reached: 1}, contributors: [], ...phase});
    // A team has at least one member on the ledger before it concludes (the ledger refuses a conclusion of none).
    const member = t => { for (const state of ['admitted', 'finished']) w.recordResearch({phase: 'node', ...t, node: 'rn-0000000000000000', kind: 'coordinator', parent: null, depth: 1, round: 1, state, seat, question: 'what reads ok?'}); };
    member(team);
    w.recordResearch({...conclusion({material: false}), ...team});
    assert.equal(L.gate('alpha').gate, 'implement', 'a conclusion that changes nothing a plan rests on leaves the plan standing');
    const other = {item: 'alpha', team: 'rt-00000000000000bb'};
    w.recordResearch({phase: 'team', ...other, request: null, trigger: 'contradiction', role: 'explorer', coordinator: seat, subordinate: {...seat, model: 'gemini-4-hydrogen'}, selection: null, limits: {max_depth: 10}, root: 'rn-0000000000000001'});
    member(other);
    w.recordResearch({...conclusion({material: true}), ...other});
    const stale = L.gate('alpha');
    // (stale[0] is the newest plan: it was given the lifecycle's own research, and not this one.)
    assert.deepEqual([stale.gate, stale.stale[0].why], ['plan', ['research concluded that what it found changes what a plan should rest on, and this plan was not given it (rt-00000000000000bb)']]);
  });
});

test('NO IMPLICIT AUTHORIZATION THROUGH THE LIFECYCLE: with nothing declared a requested research leaves the plan stage pending on the billing policy\'s refusal, the planner is not asked and nothing is billed; the declared policy wakes it at once and the research runs', {timeout: 300_000}, async () => {
  await withDispatch(async ctx => {
    const L = lifecycle(ctx);
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    const off = await plainTick(L.at);
    const [pending] = L.plans('alpha');
    assert.deepEqual([off.dispatched.map(d => [d.stage, d.status]), pending.blocker.code, pending.blocker.transient, pending.blocker.billing.settings.primary], [[['plan', 'pending']], 'GEMINI_PRIMARY_DISABLED', true, {enabled: false, budget: null}]);
    assert.deepEqual([L.seen.length, L.research.calls.length, L.w().billings().length, researchOf(L.w(), 'alpha').open.map(x => x.hash), pending.usage.gemini.refusals.map(x => [x.code, x.purpose])], [0, 0, 0, [request], [['GEMINI_PRIMARY_DISABLED', 'research']]]);
    assert.deepEqual(pending.outputs.research.map(x => [x.status, x.concluded]), [['refused', false]]);
    const on = await tick(L.at);
    assert.deepEqual([on.dispatched.map(d => [d.stage, d.status]), L.research.calls.length, L.seen.length, researchOf(L.w(), 'alpha').open], [[['plan', 'passed']], 3, 1, []], 'woken by the policy, not by the clock');
  });
});

test('INSUFFICIENT EVIDENCE ACTIVATES RESEARCH: where primary execution is declared the planner\'s gaps become a recorded request that is run at once, and the findings are what wakes the plan; where it is not declared nothing is requested or run, and the item waits as it did before', {timeout: 300_000}, async () => {
  const insufficient = json({insufficient: {gaps: ['whether anything reads the ok export'], needed: ['a search of the repository for readers of ok']}});
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {planner: ({prompt}, n) => (n === 1 ? insufficient : json(planFor(prompt)))});
    // ONE TICK: the blocked attempt records its research, and the tick, reading the gate again, finds the item's evidence
    // changed and dispatches the plan again.
    const first = await tick(L.at);
    const [blocked] = L.plans('alpha'), r = researchOf(L.w(), 'alpha');
    assert.deepEqual([first.dispatched.map(d => [d.stage, d.status]), blocked.blocker.code], [[['plan', 'blocked'], ['plan', 'passed']], 'EVIDENCE_INSUFFICIENT']);
    assert.deepEqual([r.requests.map(x => [x.trigger, x.by]), r.open, r.teams.map(x => x.role), blocked.outputs.research_on_gaps.ran, blocked.outputs.research_on_gaps.concluded], [[['insufficient-evidence', 'plan stage']], [], ['researcher'], true, true]);
    assert.match(r.requests[0].question, /Gaps: whether anything reads the ok export\. Evidence it says is needed: a search of the repository for readers of ok\./);
    // THE FINDINGS ARE NEW EVIDENCE: the second attempt's planner has them, and the first did not.
    const passed = L.plans('alpha')[1];
    assert.deepEqual([L.seen.length, L.seen[1].includes(FINDING), L.seen[0].includes(FINDING), passed.outputs.context.research], [2, true, false, [r.conclusions[0].hash]]);
    assert.notEqual(passed.outputs.context.dossier.stable, blocked.outputs.context.dossier.stable, 'the evidence the plan waited on is not the evidence it was then given');
  });
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {planner: () => insufficient});
    const t = await plainTick(L.at);
    const [blocked] = L.plans('alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), blocked.blocker.code, blocked.blocker.billing ?? null, L.w().research('alpha'), L.research.calls.length], [[['plan', 'blocked']], 'EVIDENCE_INSUFFICIENT', null, [], 0]);
    assert.deepEqual([blocked.outputs.research_on_gaps.ran, /gemini_api_primary is not declared/.test(blocked.outputs.research_on_gaps.why)], [false, true]);
  });
});

test('ACTIVATION IS THE LAUNCHER\'S: executors that were not given research run none: the planner\'s gaps request nothing although primary execution is declared, and an open request stops the plan stage by name before the planner is asked', {timeout: 300_000}, async () => {
  const insufficient = json({insufficient: {gaps: ['whether anything reads the ok export'], needed: ['a search of the repository for readers of ok']}});
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {planner: () => insufficient, exec: () => undefined, antigravity: {apiKey: ''}});
    const t = await tick(L.at);
    const [blocked] = L.plans('alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), blocked.blocker.code, L.w().research('alpha'), L.research.calls.length, L.w().billings().length], [[['plan', 'blocked']], 'EVIDENCE_INSUFFICIENT', [], 0, 0]);
    assert.deepEqual([blocked.outputs.research_on_gaps.ran, /not enabled/.test(blocked.outputs.research_on_gaps.why)], [false, true]);
  });
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {exec: () => undefined, antigravity: {apiKey: ''}});
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    const t = await tick(L.at);
    const [stopped] = L.plans('alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), stopped.blocker.code, L.seen.length, L.research.calls.length, L.w().billings().length, researchOf(L.w(), 'alpha').open.map(x => x.hash)],
      [[['plan', 'blocked']], 'RESEARCH_NOT_ENABLED', 0, 0, 0, [request]], 'the request is neither run nor planned around');
    assert.match(stopped.blocker.what, /research was requested for alpha \(intake\) and these executors run none/);
  });
});

test('WHERE THE TRANSPORT CANNOT START A SESSION nothing is simulated: the planner\'s gaps request nothing and the item waits on its evidence as before; a requested research blocks the plan stage on the transport, by name, with nothing prepared, billed or planned', {timeout: 300_000}, async () => {
  const insufficient = json({insufficient: {gaps: ['whether anything reads the ok export'], needed: ['a search of the repository for readers of ok']}});
  // The real transport (no scripted session), with no key: the check the transport itself makes before it prepares anything.
  const real = {exec: () => ({enabled: true}), antigravity: {apiKey: ''}};
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {planner: () => insufficient, ...real});
    const t = await tick(L.at);
    const [blocked] = L.plans('alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), blocked.blocker.code, L.w().research('alpha'), L.w().billings().length], [[['plan', 'blocked']], 'EVIDENCE_INSUFFICIENT', [], 0]);
    assert.deepEqual([blocked.outputs.research_on_gaps.ran, /NO_API_KEY/.test(blocked.outputs.research_on_gaps.why)], [false, true]);
  });
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, real);
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    const t = await tick(L.at);
    const [stopped] = L.plans('alpha'), r = researchOf(L.w(), 'alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), stopped.blocker.code, stopped.outputs.transport_blocker.codes, L.seen.length, L.w().billings().length, r.open.map(x => x.hash), r.teams],
      [[['plan', 'blocked']], 'RESEARCH_TRANSPORT', ['NO_API_KEY'], 0, 0, [request], []]);
    assert.equal(fs.existsSync(path.join(L.f.stateDir, 'alpha', 'research')), false, 'nothing was prepared');
  });
  // A SESSION THAT COULD NOT START (the jail, here, which only starting one can tell): the same named stop, not a failed
  // investigation; the team is on the ledger, without a conclusion, and its request is still open.
  await withDispatch(async ctx => {
    const noJail = async () => { throw Object.assign(new Error('bubblewrap is not usable here'), {code: 'SANDBOX_UNAVAILABLE', transport: 'antigravity-sdk'}); };
    const L = lifecycle(ctx, {exec: () => ({enabled: true, sdk: noJail})});
    const request = requestResearch({work: L.w(), item: 'alpha', trigger: 'intake', question: QUESTION, by: 'owner'});
    const t = await tick(L.at);
    const [stopped] = L.plans('alpha'), r = researchOf(L.w(), 'alpha');
    assert.deepEqual([t.dispatched.map(d => [d.stage, d.status]), stopped.blocker.code, stopped.outputs.transport_blocker.codes, L.seen.length, L.w().billings().length, r.open.map(x => x.hash), r.teams.length, r.conclusions],
      [[['plan', 'blocked']], 'RESEARCH_TRANSPORT', ['SANDBOX_UNAVAILABLE'], 0, 0, [request], 1, []]);
    assert.match(stopped.blocker.what, /bubblewrap is not usable here/);
  });
});

// ---- Finding 3 of the independent review of ea858a6..af23623, the lifecycle side (2026-11-20) --------------------------
test('GAP RESEARCH IS BOUNDED PER ITEM: a planner that words its gaps differently every time gets a bounded number of teams on its say; after that nothing more is requested, and the record says why', {timeout: 300_000}, async () => {
  // "Once per set of gaps" was an exact match of the text: a new wording was a new team, without end (20 teams and 60 billed
  // requests in one tick, in the reviewer's run).
  const {GAP_RESEARCH_MAX} = await import('./stages.mjs');
  await withDispatch(async ctx => {
    const L = lifecycle(ctx, {planner: (_, n) => json({insufficient: {gaps: [`gap number ${n}: whether anything reads the ok export`], needed: [`a search of the repository, attempt ${n}`]}})});
    await tick(L.at); await tick(L.at);
    const r = researchOf(L.w(), 'alpha'), plans = L.plans('alpha');
    assert.deepEqual([r.requests.filter(x => x.trigger === 'insufficient-evidence' && x.by === 'plan stage').length, r.teams.length], [GAP_RESEARCH_MAX, GAP_RESEARCH_MAX]);
    assert.deepEqual([plans.at(-1).status, plans.at(-1).blocker.code, plans.at(-1).outputs.research_on_gaps.ran], ['blocked', 'EVIDENCE_INSUFFICIENT', false]);
    assert.match(plans.at(-1).outputs.research_on_gaps.why, /already asked for research on this item's evidence 3 time\(s\) \(at most 3\): no further team is started on the planner's say/);
    assert.equal(plans.length, GAP_RESEARCH_MAX + 1, 'each team\'s findings woke the plan once; the attempt after the last asked for nothing and the item now waits');
  });
});
