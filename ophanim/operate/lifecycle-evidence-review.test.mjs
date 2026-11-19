// Regression tests for the defects independent review, assignment 1 "Lifecycle and evidence" (Google
// gemini-4-carbon, at 09d490f) found. Each ports the reviewer's reproduction (docs/reviews/2026-11-18-independent-review/
// findings-1-google-09d490f/reproductions) and asserts the CORRECT behaviour; each fails on the code the review ran at.
// Scripted seats only: no network, no live model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openStatusLedger, applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick, verifyHandoff} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors} from './stages.mjs';
import {reassessItem} from './reassess.mjs';
import {buildDossier, makeRetriever} from './context.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {currentPolicy, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, fixture, APPROVE, ACCEPT, json, planFor, scriptedTurn, LIMITS, FIVE, stagesOf} from './test-fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'review-a1-fix-'));
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
const REF = 'independent review, assignment 1 (Google gemini-4-carbon, 09d490f)';

// A scripted lifecycle for gate routing: plan passes (writing a ticket), implement passes once, validate returns the
// work to implement, and the revision then ends as `second` says.
function routing(repo, second) {
  let implCalls = 0;
  const ok = (stage, next) => ({status: 'passed', outputs: {[stage]: 1}, team: [{role: stage}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: next, why: 'ok'}});
  return {
    plan: async ctx => {
      fs.writeFileSync(path.join(repo, 'tickets', `${ctx.item}.json`), JSON.stringify({schema: 'ophanim.ticket/v1', item: ctx.item, slice: 's', proposes: {state: 'Resolved', basis: 'b'},
        title: 't', goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: 'a.mjs', copy: [], acceptance_cmd: 'true'}));
      const rt = readTicket({repo, item: ctx.item});
      return {...ok('plan', 'implement'), identity: {ticket: {path: rt.path, digest: rt.digest}}, outputs: {v: implCalls, ticket: {path: rt.path, digest: rt.digest}, deps: {}, evidence: []}};
    },
    implement: async () => (++implCalls === 1 ? ok('implement', 'review') : second()),
    review: async () => ok('review', 'validate'),
    validate: async () => ({status: 'returned', outputs: {verdict: 'implementation_defect'}, team: [{role: 'validate'}], contributions: [],
      findings: [{id: 'v1', severity: 'block', text: 'bug'}], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'fix bug'}}),
    outcome: async () => ok('outcome', null),
  };
}
const routingRepo = item => {
  const repo = tmp();
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  openStatusLedger({root: statusRoot}).set({item, title: 'Ret', state: 'Ready', basis: 'req', checked: '2026-11-18'});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot};
};

test(`${REF}, question 1: after validate returns to implement, the revision that returns to plan is routed to plan; one that pends structurally blocks; a superseded passed implement is never resurrected`, async () => {
  {
    const {repo, statusRoot, workRoot} = routingRepo('ret-item');
    try {
      const ex = routing(repo, async () => ({status: 'returned', outputs: {outside: ['other.mjs']}, team: [{role: 'implement'}], contributions: [],
        findings: [{id: 'i-ret', severity: 'block', text: 'plan scope missing other.mjs'}], usage: {provider_calls: 1}, next: {stage: 'plan', why: 'writes outside planned scope'}}));
      await tick({repo, statusRoot, workRoot, executors: ex, limits: {...LIMITS, iterations: 6}});
      const w = openWorkLedger({root: workRoot});
      assert.deepEqual(seq(w, 'ret-item'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'implement:returned', 'plan:passed'],
        'the implement revision returned the work to plan, and plan ran next (not implement again)');
      const [, , , , ret, replan] = w.stages('ret-item');
      assert.equal(replan.inputs.returned_by, ret.hash, 'the plan revision answers the implement record that returned the work');
    } finally { fs.rmSync(repo, {recursive: true, force: true}); }
  }
  {
    const {repo, statusRoot, workRoot} = routingRepo('pend-item');
    try {
      const ex = routing(repo, async () => ({status: 'pending', outputs: {stage: 'before-work'}, team: [], contributions: [], findings: [], usage: {provider_calls: 0},
        blocker: {what: 'REVIEW_CAPACITY_PENDING: short pool', role: 'check@review', resume_when: 'a reviewer becomes available'}, next: {stage: 'implement', why: 'capacity'}}));
      const r = await tick({repo, statusRoot, workRoot, executors: ex, limits: LIMITS});
      const w = openWorkLedger({root: workRoot});
      assert.deepEqual(seq(w, 'pend-item'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'implement:pending'], 'a structural pending is not re-dispatched');
      const gate = reconcile({repo, statusRoot, workLedger: w}).items[0].gate;
      assert.equal(gate.gate, 'blocked');
      assert.equal(gate.stage, 'implement');
      assert.equal(gate.reuse.implement, undefined, 'the superseded passed implement is not reused');
      assert.ok(r.blocked.some(b => b.item === 'pend-item' && /REVIEW_CAPACITY_PENDING/.test(b.blocker.what)));
    } finally { fs.rmSync(repo, {recursive: true, force: true}); }
  }
});

test(`${REF}, question 1: a requirement changed while a plan cycle is open is planned afresh, never finished on the old requirement's plan`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'req-swap', basis: 'OLD REQUIREMENT: alpha.mjs exports ok = true'}]);
    let failXai = true;
    const turn = scriptedTurn({'plan-review': ({vendor}) => { if (vendor === 'xai' && failXai) throw new Error('503 transient failure'); return APPROVE; }});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS})), ['plan:pending']);
    f.S.set({item: 'req-swap', title: 'Completely Different Title', state: 'Ready', basis: 'NEW REQUIREMENT: alpha.mjs exports ok = 42', checked: '2026-11-18'});
    failXai = false;
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(r2), ['plan:passed']);
    const passed = openWorkLedger({root: f.workRoot}).stages('req-swap').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 2, 'the new requirement was planned by the planner');
    assert.match(passed.outputs.plan.requirement.basis, /NEW REQUIREMENT/);
    assert.equal(passed.outputs.plan.requirement.title, 'Completely Different Title');
  });
});

test(`${REF}, question 2: a non-plan stage cannot start from nothing or skip a stage; verifyHandoff checks the chain and the requirement; an executor refuses another item's record`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'item-a'}, {item: 'item-b'}]);
    const w = openWorkLedger({root: f.workRoot});
    const budget = {provider_calls: 5, iterations: 1, elapsed_ms: 1000, retries: 1};
    const reqA = 'sha256:' + 'a'.repeat(64);
    const rec = (stage, attempt, from, extra = {}) => {
      const inputs = {upstream: from ? 'sha256:' + createHash('sha256').update('x').digest('hex') : null, requirement: reqA};
      const claim = w.claim({item: 'item-a', stage, attempt, inputs, holder: 'c', budget});
      try {
        return w.recordStage({claim, from, stage, attempt, status: 'passed', identity: {item: 'item-a', requirement: reqA}, inputs, outputs: {stage}, team: [{role: stage}],
          contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: null, why: 'ok'}, ...extra});
      } finally { if (!w.released(claim)) w.release({claim, item: 'item-a', stage, outcome: 'failed', why: 'test'}); }
    };
    assert.throws(() => rec('implement', 1, null), /only a plan starts without one/);
    const plan = rec('plan', 1, null);
    const planRec = w.stages('item-a').find(s => s.hash === plan);
    // Skipping implement and review: an outcome handed off from the plan is refused.
    const outcomeInputs = {upstream: (await import('./work-ledger.mjs')).outputsDigest(planRec.outputs), requirement: reqA};
    const oc = w.claim({item: 'item-a', stage: 'outcome', attempt: 1, inputs: outcomeInputs, holder: 'c', budget});
    assert.throws(() => w.recordStage({claim: oc, from: plan, stage: 'outcome', attempt: 1, status: 'passed', identity: {item: 'item-a', requirement: reqA}, inputs: outcomeInputs,
      outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: null, why: 'ok'}}), /no stage is skipped/);
    assert.equal(w.verify().ok, true);
    // verifyHandoff checks the requirement the gate asks for, before anything is spent.
    assert.throws(() => verifyHandoff(w, {item: 'item-a', gate: 'implement', from: plan, requirement: {item: 'item-a', title: 'Other', basis: 'other'}}), e => e.code === 'HANDOFF');

    // An executor given another item's record refuses it (it would review item-b's commit as item-a's).
    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan, implement: ex.implement}, limits: LIMITS, only: 'item-b'});
    const implB = openWorkLedger({root: f.workRoot}).stages('item-b').find(s => s.stage === 'implement');
    const reviewsBefore = turn.log.filter(l => l.kind === 'review').length;
    await assert.rejects(ex.review({item: 'item-a', upstream: implB, work: openWorkLedger({root: f.workRoot}), attempt: 1, budget: {provider_calls: 10}}), e => e.code === 'HANDOFF');
    assert.equal(turn.log.filter(l => l.kind === 'review').length, reviewsBefore, 'no provider call was made');
  });
});

test(`${REF}, question 4: an item without a ticket is recorded as planning at medium`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'unticketed'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    const plan = openWorkLedger({root: f.workRoot}).stages('unticketed')[0];
    assert.equal(plan.outputs.planner.model, 'claude-opus-5-5', 'seated on the medium planner');
    assert.equal(plan.outputs.planner.selection.tier.source, 'no ticket: medium');
    assert.deepEqual(plan.outputs.planner.selection.tier.declared, {});
    assert.equal(plan.team.find(t => t.role === 'planner').tier.source, 'no ticket: medium');
  });
});

test(`${REF}, questions 1 and 5: citations are bound to the bytes the planner was shown; files cited in investigation sources or copy, and non-file views, make the plan stale when they change`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    // (Planned in id order: hist-ev and inv-ev before race-ev, whose planner changes alpha.mjs during its turn.)
    const f = fixture(repo, [{item: 'race-ev'}, {item: 'inv-ev'}, {item: 'hist-ev'}]);
    const shown = sha(fs.readFileSync(path.join(repo, 'alpha.mjs')));
    const turn = scriptedTurn({
      planner: ({prompt, item}) => {
        if (item === 'race-ev') {
          fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = "mutated-mid-turn";\n');
          return json(planFor(prompt));
        }
        // inv-ev cites only the requirement (S1) as evidence; its files are in investigation sources and copy.
        // hist-ev also cites the item's status history (S2), a non-file view.
        return json(planFor(prompt, {evidence: [{ref: 'S1', why: 'the authoritative requirement'}, ...(item === 'hist-ev' ? [{ref: 'S2', why: 'the item\'s history'}] : [])]}));
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const [race, again] = w.stages('race-ev');
    assert.equal(race.outputs.plan.evidence.find(e => e.path === 'alpha.mjs').sha256, shown, 'bound to the bytes shown, not the disk after the turn');
    assert.equal(race.outputs.evidence.find(e => e.path === 'alpha.mjs').sha256, shown);
    // The bytes on disk are not the bytes the planner saw: the plan is stale, and it is PLANNED AGAIN on the present
    // bytes in the same tick -- not refused as "already completed" and skipped for good (self-audit round 3,
    // assignment 1 (sealed 323361a), question 1; this test asserted the stale gate only, and the wedge hid behind it).
    assert.equal(again?.stage, 'plan');
    assert.equal(again.status, 'passed');
    assert.equal(again.outputs.evidence.find(e => e.path === 'alpha.mjs').sha256, sha(fs.readFileSync(path.join(repo, 'alpha.mjs'))), 'the re-plan rests on the present bytes');
    assert.notEqual(again.inputs.route, race.inputs.route, 'a re-plan on changed evidence is a new attempt identity');
    const gates = () => Object.fromEntries(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.map(i => [i.item, i.gate]));
    assert.equal(gates()['race-ev'].gate, 'implement', 'the re-plan is valid on the present bytes');
    fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');   // back to the bytes shown: the first plan is valid again
    assert.deepEqual(Object.values(gates()).map(g => g.gate), ['implement', 'implement', 'implement']);
    fs.writeFileSync(path.join(repo, 'verify.mjs'), 'throw new Error("completely changed acceptance check");\n');
    const g = gates();
    assert.equal(g['inv-ev'].gate, 'plan', 'a changed investigation source / copy file makes the plan stale');
    assert.ok(g['inv-ev'].stale[0].why.includes('evidence verify.mjs changed'));
    fs.writeFileSync(path.join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
    assert.equal(gates()['hist-ev'].gate, 'implement');
    // A new status entry of the item (same requirement: title and basis unchanged) changes the cited history view.
    f.S.set({item: 'hist-ev', title: 'Alpha for hist-ev', state: 'Ready', basis: 'the requirement of hist-ev: alpha.mjs exports ok = true', checked: '2026-11-19'});
    const v = gates()['hist-ev'];
    assert.equal(v.gate, 'plan');
    assert.ok(v.stale[0].why.some(x => /^evidence status:hist-ev#history changed/.test(x)), JSON.stringify(v.stale));
  });
});

test(`${REF}, question 5: derived dossier views (relations, consumers, guesses, runs, index) are versioned by the digest of their bytes`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'resume-rv'}]);
    const d = buildDossier({repo, statusRoot: f.statusRoot, item: 'resume-rv'});
    for (const e of d.entries.filter(x => /^(consumers|guess|runs|index):|#relations$/.test(x.source))) assert.equal(e.version, sha(e.text), `${e.source} is bound to its bytes`);
  });
});

test(`${REF}, question 5: a resumed review records the dossier its seats were shown (the one bound with its brief), not a rebuilt one`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'resume-rv'}]);
    let failOnce = true;
    const turn = scriptedTurn({review: ({vendor}) => { if (vendor === 'xai' && failOnce) { failOnce = false; throw new Error('503 transient'); } return APPROVE; }});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    assert.deepEqual(stagesOf(r1).slice(0, 3), ['plan:passed', 'implement:passed', 'review:pending']);
    const pending = openWorkLedger({root: f.workRoot}).stages('resume-rv').find(s => s.stage === 'review');
    // HEAD moves on (an unrelated commit): a dossier built now would name another head.
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated\n');
    git(repo, 'add', 'unrelated.txt'); git(repo, 'commit', '-q', '-m', 'unrelated');
    now += 20 * 60_000;
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    const resumed = openWorkLedger({root: f.workRoot}).stages('resume-rv').filter(s => s.stage === 'review')[1];
    assert.ok(resumed, 'the review was resumed');
    assert.equal(resumed.outputs.cycle, pending.outputs.cycle);
    assert.equal(resumed.outputs.context.dossier.digest, pending.outputs.context.dossier.digest, 'the dossier recorded is the one the bound brief was made with');
  });
});

// A plan cycle left open by a transient reviewer failure: the first plan-review seat of `failLab` fails once, the
// stage pends with the cycle open, and the next tick resumes it. `finding` (if given) is what that lab's review adds.
const resumablePlan = ({failLab = 'xai', finding = null, planner} = {}) => {
  let failOnce = true;
  return scriptedTurn({
    ...(planner ? {planner} : {}),
    'plan-review': ({vendor}) => {
      if (vendor !== failLab) return APPROVE;
      if (failOnce) { failOnce = false; throw new Error('503 transient failure'); }
      return finding ? json({verdict: 'approve', findings: [finding]}) : APPROVE;
    },
  });
};
// The planner retrieves notes.md (which is not in the dossier) before it answers.
const retrievingPlanner = ({prompt}) => (/## Retrieved \(round/.test(prompt) ? json(planFor(prompt)) : json({requests: [{op: 'file', path: 'notes.md'}]}));
const NOTES_FINDING = {severity: 'minor', file: null, line: null, claim: 'the plan should mention the release note [source: notes.md]', reproduction: null};

test(`${REF}, question 5: a resumed PLAN review records the dossier its seats were shown (the one bound with its brief), not a rebuilt one`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'resume-plan'}]);
    const turn = resumablePlan();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, clock: () => now})), ['plan:pending']);
    const pending = openWorkLedger({root: f.workRoot}).stages('resume-plan')[0];
    // HEAD moves on (an unrelated commit): a dossier built now would name another head.
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated\n');
    git(repo, 'add', 'unrelated.txt'); git(repo, 'commit', '-q', '-m', 'unrelated');
    now += 20 * 60_000;
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, clock: () => now})), ['plan:passed']);
    const passed = openWorkLedger({root: f.workRoot}).stages('resume-plan').find(s => s.status === 'passed');
    assert.equal(passed.outputs.plan_review.cycle, pending.outputs.cycle, 'the open cycle was resumed');
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1, 'the plan was not re-planned');
    assert.equal(passed.outputs.context.dossier.head, pending.outputs.context.dossier.head, 'the dossier recorded names the head the reviewers were shown');
    assert.equal(passed.outputs.context.dossier.digest, pending.outputs.context.dossier.digest, 'the dossier recorded is the one the bound brief was made with');
  });
});

test(`${REF}, question 6: a resumed plan counts delivery against the accepted planner's own investigation, restored from the attempt that opened the cycle`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a release note, unrelated to any file\n');
    const f = fixture(repo, [{item: 'resume-log'}]);
    const turn = resumablePlan({finding: NOTES_FINDING, planner: retrievingPlanner});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, clock: () => now})), ['plan:pending']);
    const pending = openWorkLedger({root: f.workRoot}).stages('resume-log')[0];
    assert.ok(!pending.outputs.context.dossier.entries.some(e => e.source === 'file:notes.md'), 'notes.md is not in the dossier: only the planner\'s retrieval delivered it');
    assert.ok(pending.outputs.context.investigations.some(x => x.role === 'planner' && x.requests.some(r => r.ok && r.source === 'file:notes.md')), 'the accepted planner retrieved notes.md');
    now += 20 * 60_000;
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, clock: () => now})), ['plan:passed']);
    const passed = openWorkLedger({root: f.workRoot}).stages('resume-log').find(s => s.status === 'passed');
    assert.equal(passed.outputs.plan_review.cycle, pending.outputs.cycle);
    const row = passed.outputs.plan_review.unresolved.find(x => x.file === 'notes.md');
    assert.ok(row, 'the resumed review\'s finding about notes.md is carried');
    assert.equal(row.cause, 'evidence-delivered', `notes.md reached the planner (it retrieved it): ${row.why}`);
    assert.ok(passed.outputs.context.author_log?.requests.some(r => r.ok && r.source === 'file:notes.md'), 'the resumed record carries the accepted planner\'s investigation');
    assert.equal(passed.outputs.context.author_delivery, undefined, 'the delivery is known');
    assert.deepEqual(passed.outputs.context.unresolved, pending.outputs.context.unresolved);
  });
});

test(`${REF}, question 6: a resumed plan whose opening record lacks the planner's investigation marks the delivery unknown, never complete from the dossier alone`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a release note, unrelated to any file\n');
    const f = fixture(repo, [{item: 'resume-nolog'}]);
    const turn = resumablePlan({finding: NOTES_FINDING, planner: retrievingPlanner});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    // The opening attempt's record as an older executor wrote it: no author log, no planner investigation.
    const older = async c => {
      const r = await ex.plan(c);
      const {author_log: _a, ...context} = r.outputs.context;
      return {...r, outputs: {...r.outputs, context: {...context, investigations: context.investigations.filter(x => x.role !== 'planner')}}};
    };
    let now = Date.parse('2026-11-18T00:00:00Z');
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: older}, limits: LIMITS, clock: () => now})), ['plan:pending']);
    now += 20 * 60_000;
    assert.deepEqual(stagesOf(await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, clock: () => now})), ['plan:passed']);
    const passed = openWorkLedger({root: f.workRoot}).stages('resume-nolog').find(s => s.status === 'passed');
    assert.equal(passed.outputs.context.author_delivery?.known, false, 'what the accepted planner was given is recorded as unknown');
    assert.equal(passed.outputs.context.author_delivery.complete, false);
    const row = passed.outputs.plan_review.unresolved.find(x => x.file === 'notes.md');
    assert.ok(row);
    assert.equal(row.cause, 'undetermined', `the record cannot say notes.md never reached the planner: ${row.why}`);
  });
});

test(`${REF}, question 5: evidence recovery searches again when cited ledger objects are repaired, and re-checks a recovered proposal when its sources change`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'obj-tamper'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, profile: 'argo', ...FIVE});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const out = openWorkLedger({root: f.workRoot}).stages('obj-tamper').find(s => s.stage === 'outcome');
    const prop = JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'));
    const objsDir = path.join(prop.locations.run_ledger, 'objects');
    const objFile = path.join(objsDir, fs.readdirSync(objsDir)[0]);
    const saved = fs.readFileSync(objFile);
    // The reviewer's case: a cited ledger object is damaged when the item is first searched; then it is repaired.
    fs.writeFileSync(objFile, '{"corrupted":true}');
    f.S.set({item: 'obj-tamper', title: 'Alpha for obj-tamper', state: 'Resolved', basis: 'attested', checked: '2026-11-18'});
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.equal(r1.recovery[0].outcome, 'not-found');
    fs.writeFileSync(objFile, saved);
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.equal(r2.recovery.length, 1, 'a repaired ledger object is searched again');
    assert.equal(r2.recovery[0].outcome, 'recovered');
    const gate = () => reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})}).items[0].gate;
    assert.equal(gate().gate, 'awaiting-owner');
    // The cited bytes change after recovery: the recovered proposal no longer stands; it is not left for the owner.
    fs.writeFileSync(objFile, '{"corrupted":true}');
    assert.equal(gate().gate, 'evidence-gap', 'a recovered proposal whose sources changed is not left awaiting the owner');
    // Restored: the search of exactly these sources is not repeated, and its recovered result stands again.
    fs.writeFileSync(objFile, saved);
    const r3 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r3.recovery, []);
    assert.equal(gate().gate, 'awaiting-owner');
  });
});

test(`${REF}, question 5: the dossier (and its stable digest) sees untracked, unignored files the retriever can read`, () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'needs-file', basis: 'gamma.mjs must exist and export ok'}]);
    const before = buildDossier({repo, statusRoot: f.statusRoot, item: 'needs-file'}).stable;
    fs.writeFileSync(path.join(repo, 'gamma.mjs'), 'export const ok = true;\n');   // untracked, not ignored: readable evidence
    const after = buildDossier({repo, statusRoot: f.statusRoot, item: 'needs-file'});
    assert.notEqual(after.stable, before, 'an untracked file that appeared changes the evidence available');
    assert.ok(after.entries.some(e => e.source === 'file:gamma.mjs'), 'and the file the requirement names is shown');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// A repository that is a SUBDIRECTORY of its git checkout, with a parent file and a parent-only commit.
function subRepo() {
  const outer = tmp();
  fs.writeFileSync(path.join(outer, 'parent-secret.txt'), 'OUTER_REPO_SECRET_LINE\n');
  const sub = path.join(outer, 'subrepo');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'alpha.mjs'), 'export const ok = false;\n');
  const statusRoot = path.join(sub, 'status', 'ledger');
  const S = openStatusLedger({root: statusRoot});
  S.set({item: 'sub-item', title: 'Sub', state: 'Ready', basis: 'alpha.mjs', checked: '2026-11-18'});
  git(outer, 'init', '-q', '-b', 'main');
  git(outer, 'config', 'user.name', 'Test');
  git(outer, 'config', 'user.email', 'test@example.invalid');
  git(outer, 'add', 'parent-secret.txt');
  git(outer, 'commit', '-q', '-m', 'PARENT_ONLY_COMMIT');
  git(outer, 'add', 'subrepo/alpha.mjs');
  git(outer, 'commit', '-q', '-m', 'sub commit');
  return {outer, sub, statusRoot, S, parentCommit: git(outer, 'rev-parse', 'HEAD~1').trim()};
}

test(`${REF}, question 6: retrieval is contained: no git pathspec magic, and log and show are limited to the repository`, () => {
  const {outer, sub, statusRoot, parentCommit} = subRepo();
  try {
    const R = makeRetriever({repo: sub, statusRoot});
    for (const req of [{op: 'list', prefix: ':/'}, {op: 'grep', pattern: 'OUTER_REPO_SECRET_LINE', path: ':/'}, {op: 'grep', pattern: 'OUTER_REPO_SECRET_LINE', path: ':(top)'},
      {op: 'log', path: ':/'}, {op: 'show', commit: parentCommit, path: '../parent-secret.txt'}, {op: 'file', path: ':/parent-secret.txt'}]) {
      assert.equal(R.run(req).ok, false, `${JSON.stringify(req)} is refused`);
    }
    assert.doesNotMatch(R.run({op: 'show', commit: parentCommit, path: 'parent-secret.txt'}).text ?? '', /OUTER_REPO_SECRET_LINE/, 'a show path is the repository\'s own');
    assert.doesNotMatch(R.run({op: 'log'}).text, /PARENT_ONLY_COMMIT/, 'the log is the repository\'s own');
    assert.match(R.run({op: 'log'}).text, /sub commit/);
    assert.doesNotMatch(R.run({op: 'show', commit: parentCommit}).text ?? '', /parent-secret/, 'a commit stat is limited to the repository');
  } finally { fs.rmSync(outer, {recursive: true, force: true}); }
});

test(`${REF}, question 6: a line window or offset past the end is refused, never an empty success`, () => {
  const {outer, sub, statusRoot} = subRepo();
  try {
    const R = makeRetriever({repo: sub, statusRoot});
    const past = R.run({op: 'file', path: 'alpha.mjs', start: 500, lines: 10});
    assert.equal(past.ok, false);
    assert.equal(past.error, 'OUT_OF_RANGE');
    fs.writeFileSync(path.join(sub, 'big.mjs'), Array.from({length: 400}, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    const beyond = R.run({op: 'file', path: 'big.mjs', start: 1, lines: 5, offset: 5000});
    assert.equal(beyond.ok, false);
    assert.equal(beyond.error, 'OUT_OF_RANGE');
    assert.equal(R.run({op: 'file', path: 'big.mjs', start: 400, lines: 1}).ok, true, 'the last line is still in range');
  } finally { fs.rmSync(outer, {recursive: true, force: true}); }
});

test(`${REF}, question 6: a cut dossier view carries its continuation, which delivers the rest of the same bytes`, () => {
  const {outer, sub, statusRoot, S} = subRepo();
  try {
    for (let i = 0; i < 60; i++) S.set({item: `dep-${i}`, title: `Dep ${i}`, state: 'Ready', basis: 'b'.repeat(100), depends_on: ['sub-item'], checked: '2026-11-18'});
    const d = buildDossier({repo: sub, statusRoot, item: 'sub-item'});
    const rel = d.entries.find(e => e.source === 'status:sub-item#relations');
    assert.equal(rel.coverage.complete, false);
    assert.ok(rel.coverage.next, 'a cut view names the request that continues it');
    const more = makeRetriever({repo: sub, statusRoot, dossierViews: d.views}).run(rel.coverage.next);
    assert.equal(more.ok, true);
    assert.equal(more.coverage.from, rel.coverage.to);
    assert.equal(more.version, rel.version);
  } finally { fs.rmSync(outer, {recursive: true, force: true}); }
});

test(`${REF}, question 6: a validator is credited only with what its own accepted answer was given, never a rejected seat's retrieval`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'val-pool'}]);
    fs.writeFileSync(path.join(repo, 'extra.mjs'), 'export const extra = 1;\n');
    git(repo, 'add', 'extra.mjs');
    git(repo, 'commit', '-q', '-m', 'extra');
    let firstSeatDone = false;
    const turn = scriptedTurn({
      validator: ({prompt, model}) => {
        if (!firstSeatDone) {
          if (!/## Retrieved/.test(prompt)) return json({requests: [{op: 'file', path: 'extra.mjs'}]});
          firstSeatDone = true;
          return {text: ACCEPT, served_model: null};      // rejected: names no serving model
        }
        return {text: json({verdict: 'accept', reasons: ['ok'], criteria: [{id: 'a1', met: true, why: 'ok'}], sources: ['extra.mjs']}), served_model: model};
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const val = openWorkLedger({root: f.workRoot}).stages('val-pool').find(s => s.stage === 'validate');
    assert.equal(val.outputs.rejected_answers.length, 1, 'seat 1 was rejected');
    assert.deepEqual(val.outputs.sources, [{ref: 'file:extra.mjs', delivered: false}], 'the accepted seat never received extra.mjs: a rejected seat\'s retrieval is not its delivery');
  });
});

test(`${REF}, question 6: a test output the validator was shown only as its tail is recorded as an unresolved gap, with the request that continues it`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'val-tail'}]);
    const long = 'node -e "process.stdout.write(\'y\'.repeat(5000))"';
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {regression: {cmd: long}}))});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const val = openWorkLedger({root: f.workRoot}).stages('val-tail').find(s => s.stage === 'validate');
    assert.equal(val.outputs.tests.find(t => t.kind === 'regression').output.complete, false);
    const gap = val.outputs.context.investigations.at(-1).unresolved.find(u => u.source === 'output:regression-regression.txt');
    assert.ok(gap, 'a test output shown only as its tail is an unresolved gap');
    assert.deepEqual(gap.next, {op: 'output', id: 'regression-regression.txt', offset: 0});
  });
});

test(`${REF}, question 7: intake records every source once -- status items, tickets (an item's and an orphan), linked and candidate issues -- and refuses a duplicate`, async () => {
  const repo = tmp();
  try {
    const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
    openStatusLedger({root: statusRoot}).set({item: 'alpha', title: 'Alpha', state: 'Ready', basis: 'req', checked: '2026-11-18'});
    fs.mkdirSync(path.join(repo, 'tickets'));
    fs.writeFileSync(path.join(repo, 'tickets', 'alpha.json'), '{}');
    fs.writeFileSync(path.join(repo, 'tickets', 'orphan.json'), '{}');
    const issues = [
      {number: 1, title: 'Linked', body: '<!-- ophanim:item=alpha -->', state: 'open'},
      {number: 9, title: 'Dup candidate', body: 'no marker', state: 'open'},
      {number: 9, title: 'Dup candidate', body: 'no marker', state: 'open'},
    ];
    await tick({repo, statusRoot, workRoot, issues, executors: {}, limits: {total_provider_calls: 0}});
    await tick({repo, statusRoot, workRoot, issues, executors: {}, limits: {total_provider_calls: 0}});
    const w = openWorkLedger({root: workRoot});
    const by = Object.fromEntries(w.intakes().map(i => [i.ref, i]));
    assert.equal(w.intakes().length, 5);
    assert.deepEqual(Object.keys(by).sort(), ['issue:1', 'issue:9', 'status:alpha', 'ticket:alpha', 'ticket:orphan']);
    assert.equal(by['ticket:alpha'].source, 'ticket');
    assert.equal(by['ticket:alpha'].item, 'alpha');
    assert.equal(by['ticket:orphan'].item, null);
    assert.equal(by['issue:1'].item, 'alpha');
    assert.equal(by['issue:9'].classification, 'candidate');
    assert.throws(() => w.intake({source: 'issue', ref: 'issue:9', item: null, classification: 'candidate', why: 'again'}), /once per source/);
    assert.equal(w.verify().ok, true);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// The lifecycle of three items to an outcome, under the model rule (argo), for the reassessment and recovery cases.
async function toOutcome(ctx, items, turnOver = {}) {
  const {dir: repo, makeClientFor} = ctx;
  ctx.serve((_v, m) => m);
  const f = fixture(repo, items.map(item => ({item})));
  const turn = scriptedTurn(turnOver);
  const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
  return {repo, f, ex};
}

test(`${REF}, question 9: a transient re-review keeps its reassessment on retry: no claim-key collision, and the disqualified cycle is never reused`, async () => {
  await withDispatch(async ctx => {
    let failRereviewOnce = false;
    const {repo, f, ex} = await toOutcome(ctx, ['re-active'], {review: () => { if (failRereviewOnce) { failRereviewOnce = false; throw new Error('503 transient failure during rereview'); } return APPROVE; }});
    let now = Date.parse('2026-11-18T00:00:00Z');
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    const w = openWorkLedger({root: f.workRoot});
    const [, implA, revA] = w.stages('re-active');
    const shared = revA.team.find(t => revA.outputs.shared_labs.includes(t.lab));
    const sibling = contributorKeys(implA.contributions).models.find(m => m.startsWith(`${shared.lab}/`)).split('/')[1];
    const policyA = {...currentPolicy(), same_model: {...currentPolicy().same_model, [shared.model]: sibling}};
    const ra = reassessItem({work: w, item: 're-active', policy: policyA});
    assert.equal(ra.recorded.length, 1);
    failRereviewOnce = true;
    const t1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now, only: 're-active'});
    assert.deepEqual(stagesOf(t1), ['review:pending']);
    now += 20 * 60_000;
    const gateAtRetry = reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot}), now}).items.find(i => i.item === 're-active').gate;
    assert.equal(gateAtRetry.mode, 'resume');
    assert.equal(gateAtRetry.rereview?.reassessment, ra.recorded[0].reassessment, 'the retry still answers the reassessment');
    assert.equal(gateAtRetry.rereview.replaces, revA.hash);
    const t2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, iterations: 1}, clock: () => now, only: 're-active'});
    assert.deepEqual(stagesOf(t2), ['review:passed'], 'the retry ran (no claim-key collision with the disqualified review)');
    const rev2 = openWorkLedger({root: f.workRoot}).stages('re-active').filter(s => s.stage === 'review').at(-1);
    assert.notEqual(rev2.outputs.cycle, revA.outputs.cycle, 'the disqualified cycle is never reused');
    assert.equal(rev2.outputs.rereview_of.reassessment, ra.recorded[0].reassessment);
  });
});

test(`${REF}, question 9: a Resolved item whose PLAN review was disqualified by a reassessment needs re-verification`, async () => {
  await withDispatch(async ctx => {
    const {repo, f, ex} = await toOutcome(ctx, ['re-plan-done']);
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    let w = openWorkLedger({root: f.workRoot});
    applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(w.stages('re-plan-done').find(s => s.stage === 'outcome').outputs.proposal_path, 'utf8'))});
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'complete');
    const planDone = w.stages('re-plan-done').find(s => s.stage === 'plan');
    w.recordReassessment({item: 're-plan-done', cycle: planDone.outputs.plan_review.cycle, recorded_policy: 'sha256:' + '8'.repeat(64), policy: 'sha256:' + '9'.repeat(64),
      findings: [{review: null, why: 'a plan reviewer was an alias of the planner'}]});
    w = openWorkLedger({root: f.workRoot});
    const g = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate;
    assert.equal(g.gate, 'reverification-needed');
    assert.equal(g.blocker.role, 'decision-authority');
  });
});

test(`${REF}, question 8: evidence recovery does not propose a retained bundle whose review a reassessment disqualified`, async () => {
  await withDispatch(async ctx => {
    const {repo, f, ex} = await toOutcome(ctx, ['re-recover']);
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const recRev = w.stages('re-recover').find(s => s.stage === 'review');
    w.recordReassessment({item: 're-recover', cycle: recRev.outputs.cycle, recorded_policy: 'sha256:' + '8'.repeat(64), policy: 'sha256:' + '9'.repeat(64),
      findings: [{review: null, why: 'a reviewer was an alias of a contributor'}]});
    f.S.set({item: 're-recover', title: 'Alpha for re-recover', state: 'Resolved', basis: 'attested', checked: '2026-11-18'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.equal(r.recovery.find(x => x.item === 're-recover').outcome, 'not-found');
    const recorded = openWorkLedger({root: f.workRoot}).recoveries('re-recover').at(-1);
    assert.ok(recorded.searched.some(x => x.result === 'disqualified'), JSON.stringify(recorded.searched));
  });
});

test(`${REF}, question 10: an outcome whose proposal would not re-check at apply is not passed`, async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'bad-outcome'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, profile: 'argo', ...FIVE});
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, iterations: 4}});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed']);
    const impl = openWorkLedger({root: f.workRoot}).stages('bad-outcome').find(s => s.stage === 'implement');
    fs.writeFileSync(impl.outputs.run.run_json, '{"tampered": true}\n');
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r2), ['outcome:blocked']);
    const out = openWorkLedger({root: f.workRoot}).stages('bad-outcome').find(s => s.stage === 'outcome');
    assert.equal(out.blocker.code, 'OUTCOME_EVIDENCE_REFUSED');
    assert.match(out.blocker.what, /run\.json is not the one the proposal cites/);
    assert.equal(fs.existsSync(path.join(out.outputs.bundle, 'proposal.json')), false, 'no proposal is left for the owner to apply');
  });
});
