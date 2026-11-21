import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger, applyProposal} from '../packages/ledger/status.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {tick, verifyHandoff} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {reassessItem} from '../ophanim/operate/reassess.mjs';
import {buildDossier, makeRetriever} from '../ophanim/operate/context.mjs';
import {currentPolicy, contributorKeys} from '../pantheon/src/review/identity.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {git, fixture, APPROVE, ACCEPT, json, planFor, scriptedTurn, LIMITS, FIVE, stagesOf} from '../ophanim/operate/test-fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'review-a1-'));

// ---- Q1: Earliest gate & upstream changes ----

test('Q1A defect: after review/validate returns to implement, a non-passing implement attempt (returned to plan, blocked, or pending) is ignored by earliestGate because chainFrom resurrects the superseded passed implement', async () => {
  const repo = tmp();
  try {
    const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
    const S = openStatusLedger({root: statusRoot});
    S.set({item: 'ret-item', title: 'Ret', state: 'Ready', basis: 'req', checked: '2026-11-18'});
    fs.mkdirSync(path.join(repo, 'tickets'));

    let implCalls = 0, valCalls = 0;
    const ex = {
      plan: async ctx => {
        const tf = path.join(repo, 'tickets', `${ctx.item}.json`);
        const tk = {schema: 'ophanim.ticket/v1', item: ctx.item, slice: 's', proposes: {state: 'Resolved', basis: 'b'},
          title: 't', goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: 'a.mjs', copy: [], acceptance_cmd: 'true'};
        fs.writeFileSync(tf, JSON.stringify(tk));
        const {readTicket} = await import('../pantheon/src/board/operate.mjs');
        const rt = readTicket({repo, item: ctx.item});
        return {status: 'passed', identity: {ticket: {path: rt.path, digest: rt.digest}},
          outputs: {v: implCalls, ticket: {path: rt.path, digest: rt.digest}, deps: {}, evidence: []},
          team: [{role: 'planner'}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'ok'}};
      },
      implement: async () => {
        implCalls++;
        if (implCalls === 1) {
          return {status: 'passed', outputs: {impl: 1}, team: [{role: 'implement'}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'review', why: 'ok'}};
        }
        return {status: 'returned', outputs: {outside: ['other.mjs']}, team: [{role: 'implement'}], contributions: [],
          findings: [{id: 'i-ret', severity: 'block', text: 'plan scope missing other.mjs'}],
          usage: {provider_calls: 1}, next: {stage: 'plan', why: 'writes outside planned scope'}};
      },
      review: async () => ({status: 'passed', outputs: {rev: 1}, team: [{role: 'review'}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'validate', why: 'ok'}}),
      validate: async () => {
        valCalls++;
        return {status: 'returned', outputs: {verdict: 'implementation_defect'}, team: [{role: 'validate'}], contributions: [],
          findings: [{id: 'v1', severity: 'block', text: 'bug'}], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'fix bug'}};
      },
      outcome: async () => ({status: 'passed', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: null, why: 'ok'}}),
    };

    const r = await tick({repo, statusRoot, workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: workRoot});
    const seq = w.stages('ret-item').map(s => `${s.stage}:${s.status}`);
    assert.deepEqual(seq, ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'implement:returned', 'implement:returned', 'implement:returned']);
    assert.equal(valCalls, 1);
    assert.equal(w.stages('ret-item').filter(s => s.stage === 'plan').length, 1, 'never routed back to plan despite implement returning to plan');
    assert.ok(r.blocked.some(b => b.item === 'ret-item' && /3 attempts of implement/.test(b.blocker.what)));
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

test('Q1B defect: when the requirement changes while a plan review cycle is open (REVIEW_PENDING), the next plan run resumes the OLD plan document and stamps it with the NEW requirement digest', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'req-swap', basis: 'OLD REQUIREMENT: alpha.mjs exports ok = true'}]);
    let failXai = true;
    const turn = scriptedTurn({
      'plan-review': ({vendor}) => {
        if (vendor === 'xai' && failXai) throw new Error('503 transient failure');
        return APPROVE;
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});

    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:pending']);

    f.S.set({item: 'req-swap', title: 'Completely Different Title', state: 'Ready', basis: 'NEW REQUIREMENT: alpha.mjs exports ok = 42', checked: '2026-11-18'});
    failXai = false;

    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.equal(r2.dispatched[0].stage, 'plan');
    assert.equal(r2.dispatched[0].status, 'passed');

    const w = openWorkLedger({root: f.workRoot});
    const passedPlan = w.stages('req-swap').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
    assert.match(passedPlan.outputs.plan.requirement.basis, /OLD REQUIREMENT/);
    const gateAfter = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate;
    assert.equal(gateAfter.gate, 'awaiting-owner');
  });
});

// ---- Q2: Handoffs ----

test('Q2 defect: work.stage accepts non-plan stages with from: null or skipped stages, verifyHandoff accepts an upstream implement with from: null, and stage executors do not verify ctx.upstream item', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'item-a'}, {item: 'item-b'}]);
    const w = openWorkLedger({root: f.workRoot});
    const budget = {provider_calls: 5, iterations: 1, elapsed_ms: 1000, retries: 1};
    const reqA = 'sha256:' + 'a'.repeat(64);

    const c1 = w.claim({item: 'item-a', stage: 'implement', attempt: 1, inputs: {upstream: null, requirement: reqA}, holder: 'c', budget});
    const implNoFrom = w.recordStage({claim: c1, from: null, stage: 'implement', attempt: 1, status: 'passed',
      identity: {item: 'item-a', requirement: reqA}, inputs: {upstream: null, requirement: reqA},
      outputs: {forged_impl: true}, team: [{role: 'implement'}], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'review', why: 'ok'}});
    w.release({claim: c1, item: 'item-a', stage: 'implement', outcome: 'completed', why: 'ok'});

    assert.equal(w.verify().ok, true);
    const verified = verifyHandoff(w, {item: 'item-a', gate: 'review', from: implNoFrom, requirement: {item: 'item-a', title: 'Other', basis: 'other'}});
    assert.equal(verified.hash, implNoFrom);

    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan, implement: ex.implement}, limits: LIMITS, only: 'item-b'});
    const implB = openWorkLedger({root: f.workRoot}).stages('item-b').find(s => s.stage === 'implement');
    const crossReview = await ex.review({item: 'item-a', upstream: implB, work: openWorkLedger({root: f.workRoot}), attempt: 1, budget: {provider_calls: 10}});
    assert.equal(crossReview.status, 'passed');
    assert.equal(crossReview.outputs.commit, implB.outputs.commit);
    assert.match(crossReview.outputs.scope, /^board\/item-a\//);
  });
});

// ---- Q3: Plan contributor lineage across open cycle resume ----

test('Q3 defect: when plan v1 has findings (revising to v2) and v2 pends transiently in review, resuming v2 drops the v1 plan-review finder from contributions so the finder reviews/validates later stages', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'plan-lineage'}]);
    let failOnceOnV2 = true;
    const turn = scriptedTurn({
      'plan-review': ({vendor, prompt}) => {
        const isV2 = /\+\s*"n":\s*2\b/.test(prompt);
        if (!isV2 && vendor === 'xai') {
          return json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'add explicit rollback note', reproduction: null}]});
        }
        if (isV2 && vendor === 'openai' && failOnceOnV2) {
          failOnceOnV2 = false;
          throw new Error('503 transient failure on v2 plan review');
        }
        return APPROVE;
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');

    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    assert.deepEqual(stagesOf(r1), ['plan:pending']);
    const pendingPlan = openWorkLedger({root: f.workRoot}).stages('plan-lineage')[0];
    const xaiCrit = pendingPlan.contributions.find(c => c.purpose === 'plan-review' && c.lab === 'xai');
    assert.ok(xaiCrit, 'attempt 1 knew xai was a contributor');

    now += 20 * 60_000;
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});
    assert.deepEqual(stagesOf(r2), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);

    const w = openWorkLedger({root: f.workRoot});
    const passedPlan = w.stages('plan-lineage').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.equal(passedPlan.outputs.plan.answers.length, 1, 'the approved plan v2 answered xai\'s finding');
    assert.equal(passedPlan.contributions.some(c => c.lab === 'xai'), false, 'xai finder was dropped from plan.contributions on resume');

    const rev = w.stages('plan-lineage').find(s => s.stage === 'review' && s.status === 'passed');
    assert.equal(rev.outputs.author_models.includes(`xai/${xaiCrit.model}`), false, 'the exact xai finder model was not in author_models');
  });
});

// ---- Q4: Planner seat recording ----

test('Q4 defect: an item without a ticket plans on the medium planner, but seatOf() strips selection.tier so the stage record never records planning at medium', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'unticketed'}]);
    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    const plan = openWorkLedger({root: f.workRoot}).stages('unticketed')[0];
    assert.equal(plan.outputs.planner.model, 'claude-opus-5-5', 'seated on medium planner');
    assert.deepEqual(Object.keys(plan.outputs.planner).sort(), ['lab', 'model', 'vendor']);
    const teamPlanner = plan.team.find(t => t.role === 'planner');
    assert.deepEqual(Object.keys(teamPlanner).sort(), ['lab', 'model', 'role', 'vendor']);
    assert.equal(JSON.stringify(plan).includes('no ticket: medium'), false);
  });
});

// ---- Q5: Evidence freshness ----

test('Q5A/D defect: file citation sha256 hashes post-turn disk bytes instead of bytes shown, and files cited in investigation.sources / copy without file: in plan.evidence do not invalidate the plan when changed', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'race-ev'}, {item: 'inv-ev'}]);
    const beforeSha = 'sha256:' + (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(repo, 'alpha.mjs'))).digest('hex');

    const turn = scriptedTurn({
      planner: ({prompt, item}) => {
        if (item === 'race-ev') {
          fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = "mutated-mid-turn";\n');
          return json(planFor(prompt));
        }
        return json(planFor(prompt, {
          evidence: [{ref: 'S1', why: 'the authoritative requirement'}],
        }));
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});

    const w = openWorkLedger({root: f.workRoot});
    const racePlan = w.stages('race-ev')[0];
    const citedAlpha = racePlan.outputs.plan.evidence.find(e => e.path === 'alpha.mjs');
    const dossierAlpha = racePlan.outputs.context.dossier.entries.find(e => e.source === 'file:alpha.mjs');
    assert.equal(dossierAlpha.version, beforeSha, 'planner was shown the original bytes');
    assert.notEqual(citedAlpha.sha256, dossierAlpha.version, 'DEFECT: recorded sha256 bound to post-turn mutated disk bytes, not bytes shown!');

    fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
    fs.writeFileSync(path.join(repo, 'verify.mjs'), 'throw new Error("completely changed acceptance check");\n');
    const rec = reconcile({repo, statusRoot: f.statusRoot, workLedger: w});
    const invGate = rec.items.find(i => i.item === 'inv-ev').gate;
    assert.equal(invGate.gate, 'implement', 'stale plan was reused despite cited investigation source verify.mjs changing');
  });
});

test('Q5F defect: evidence recovery sourcesDigest omits locations.ticket and ledger objects/', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'obj-tamper'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, profile: 'argo', ...FIVE});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});

    const w0 = openWorkLedger({root: f.workRoot});
    const out = w0.stages('obj-tamper').find(s => s.stage === 'outcome');
    const prop = JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'));
    const objsDir = path.join(prop.locations.run_ledger, 'objects');
    const objFile = path.join(objsDir, fs.readdirSync(objsDir)[0]);
    const savedObj = fs.readFileSync(objFile);

    fs.writeFileSync(objFile, '{"corrupted":true}');
    f.S.set({item: 'obj-tamper', title: 'Alpha for obj-tamper', state: 'Resolved', basis: 'attested', checked: '2026-11-18'});

    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.equal(r1.recovery[0].outcome, 'not-found');

    fs.writeFileSync(objFile, savedObj);
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r2.recovery, [], 'DEFECT: repaired ledger object was never searched again because sourcesDigest ignores objects/');
  });
});

// ---- Q6: Evidence bounds & partial view recording ----

test('Q6 defects: (A) git pathspec :/ escapes subdirectory repo in list/grep; (B) out-of-range start line returns ok:true 0 bytes; (C) cut dossier add() view has next:null; (D) plannerGot/validator sources pool requests across tries/versions', async () => {
  const outer = tmp();
  try {
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
    git(outer, 'add', 'parent-secret.txt', 'subrepo/alpha.mjs');
    git(outer, 'commit', '-q', '-m', 'init');

    const R = makeRetriever({repo: sub, statusRoot});
    const listed = R.run({op: 'list', prefix: ':/'});
    assert.equal(listed.ok, true);
    assert.match(listed.text, /parent-secret\.txt/);
    const grepped = R.run({op: 'grep', pattern: 'OUTER_REPO_SECRET_LINE', path: ':/'});
    assert.equal(grepped.ok, true);
    assert.match(grepped.text, /OUTER_REPO_SECRET_LINE/);

    const emptyLineRange = R.run({op: 'file', path: 'alpha.mjs', start: 500, lines: 10});
    assert.equal(emptyLineRange.ok, true);
    assert.equal(emptyLineRange.bytes, 0);

    for (let i = 0; i < 60; i++) {
      S.set({item: `dep-${i}`, title: `Dep ${i}`, state: 'Ready', basis: 'b'.repeat(100), depends_on: ['sub-item'], checked: '2026-11-18'});
    }
    const d = buildDossier({repo: sub, statusRoot, item: 'sub-item'});
    const rel = d.entries.find(e => e.source === 'status:sub-item#relations');
    assert.equal(rel.coverage.complete, false);
    assert.equal(rel.coverage.next, undefined);
  } finally {
    fs.rmSync(outer, {recursive: true, force: true});
  }

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
          return {text: ACCEPT, served_model: null};
        }
        return {text: json({verdict: 'accept', reasons: ['ok'], criteria: [{id: 'a1', met: true, why: 'ok'}], sources: ['extra.mjs']}), served_model: model};
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const val = openWorkLedger({root: f.workRoot}).stages('val-pool').find(s => s.stage === 'validate');
    assert.equal(val.outputs.rejected_answers.length, 1, 'Seat 1 was rejected');
    assert.deepEqual(val.outputs.sources, [{ref: 'file:extra.mjs', delivered: true, complete: true}],
      'DEFECT 6D: Seat 2 falsely credited with complete delivery of extra.mjs retrieved only by rejected Seat 1');
  });
});

// ---- Q7: Intake recording ----

test('Q7 defect: intake ignores tickets and linked issues, and records duplicate candidate refs when issues snapshot repeats a number or work.intake is called twice', async () => {
  const repo = tmp();
  try {
    const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
    const S = openStatusLedger({root: statusRoot});
    S.set({item: 'alpha', title: 'Alpha', state: 'Ready', basis: 'req', checked: '2026-11-18'});
    fs.mkdirSync(path.join(repo, 'tickets'));
    fs.writeFileSync(path.join(repo, 'tickets', 'alpha.json'), '{}');
    fs.writeFileSync(path.join(repo, 'tickets', 'orphan.json'), '{}');

    const issues = [
      {number: 1, title: 'Linked', body: '<!-- ophanim:item=alpha -->', state: 'open'},
      {number: 9, title: 'Dup candidate', body: 'no marker', state: 'open'},
      {number: 9, title: 'Dup candidate', body: 'no marker', state: 'open'},
    ];
    await tick({repo, statusRoot, workRoot, issues, executors: {}, limits: {total_provider_calls: 0}});
    const w = openWorkLedger({root: workRoot});
    const intakes = w.intakes();
    assert.equal(intakes.filter(i => i.source === 'ticket').length, 0);
    assert.equal(intakes.some(i => i.ref === 'issue:1'), false);
    assert.equal(intakes.filter(i => i.ref === 'issue:9').length, 2);
    assert.equal(w.verify().ok, true);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

// ---- Q9: Reassessment ----

test('Q9A/B defects: (A) a transient failure during rereview drops gate.rereview on retry, wedging tick on a completed-claim collision and causing review() to reuse the disqualified cycle; (B) a Resolved item whose plan review was reassessed stays gate=complete', async () => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 're-active'}, {item: 're-plan-done'}]);
    let failRereviewOnce = false;
    const turn = scriptedTurn({
      review: () => {
        if (failRereviewOnce) {
          failRereviewOnce = false;
          throw new Error('503 transient failure during rereview');
        }
        return APPROVE;
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'model'});
    let now = Date.parse('2026-11-18T00:00:00Z');
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now});

    let w = openWorkLedger({root: f.workRoot});
    const doneOut = w.stages('re-plan-done').find(s => s.stage === 'outcome');
    applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(doneOut.outputs.proposal_path, 'utf8'))});

    // (A) Reassess `re-active`'s change review:
    const [, implA, revA] = w.stages('re-active');
    const shared = revA.team.find(t => revA.outputs.shared_labs.includes(t.lab));
    const sibling = contributorKeys(implA.contributions).models.find(m => m.startsWith(`${shared.lab}/`)).split('/')[1];
    const policyA = {...currentPolicy(), same_model: {...currentPolicy().same_model, [shared.model]: sibling}};
    const ra = reassessItem({work: w, item: 're-active', policy: policyA});
    assert.equal(ra.recorded.length, 1);

    // Tick with transient failure on 1 seat of rereview -> review:pending (transient: true)!
    failRereviewOnce = true;
    const t1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now, only: 're-active'});
    assert.deepEqual(stagesOf(t1), ['review:pending']);

    // Next tick when retry is due: earliestGate returns mode='resume' WITHOUT `rereview`!
    now += 20 * 60_000;
    const gateAtRetry = reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot}), now}).items.find(i => i.item === 're-active').gate;
    assert.equal(gateAtRetry.rereview, undefined, 'DEFECT 9A: earliestGate dropped gate.rereview on retry');
    // 1. In tick(), dropping gate.rereview drops inputs.rereview, colliding workKey with revA's completed claim and permanently skipping the item:
    const t2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => now, only: 're-active'});
    assert.deepEqual(t2.dispatched, []);
    assert.match(t2.skipped[0].why, /already completed for these exact inputs/);
    // 2. And ex.review() given that gate opens o.run.ledger and returns `passed` reusing the disqualified cycle with 0 provider calls:
    const resumed = await ex.review({item: 're-active', gate: gateAtRetry, upstream: implA, work: openWorkLedger({root: f.workRoot}), attempt: 2, budget: {provider_calls: 10}});
    assert.equal(resumed.status, 'passed');
    assert.equal(resumed.usage.provider_calls, 0);
    assert.equal(resumed.outputs.cycle, revA.outputs.cycle, 'DEFECT 9A: review() reused the exact disqualified cycle!');

    // (B) Record a reassessment disqualifying `re-plan-done`'s PLAN review cycle:
    const planDone = w.stages('re-plan-done').find(s => s.stage === 'plan');
    const planReviewer = planDone.team.find(t => t.role === 'plan-reviewer');
    w.recordReassessment({
      item: 're-plan-done',
      cycle: planDone.outputs.plan_review.cycle,
      recorded_policy: 'sha256:' + '8'.repeat(64),
      policy: 'sha256:' + '9'.repeat(64),
      findings: [{review: null, why: `plan reviewer ${planReviewer.model} was an alias of the planner`}],
    });
    w = openWorkLedger({root: f.workRoot});
    const doneGate = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 're-plan-done').gate;
    assert.equal(doneGate.gate, 'complete', 'DEFECT 9B: Resolved item ignored disqualified plan review reassessment');
  });
});

// ---- Q10: Outcome structural check against apply ----

test('Q10 defect: outcome produces a passed proposal without running checkEvidenceLedgers, so missing/altered run.json (or missing run_ledger after rereview) passes outcome and fails status.mjs apply', async () => {
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
    assert.deepEqual(stagesOf(r2), ['outcome:passed']);
    const out = openWorkLedger({root: f.workRoot}).stages('bad-outcome').find(s => s.stage === 'outcome');
    const proposal = JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'));

    assert.throws(() => applyProposal({root: f.statusRoot, proposal}), /run\.json is not the one the proposal cites/);
  });
});
