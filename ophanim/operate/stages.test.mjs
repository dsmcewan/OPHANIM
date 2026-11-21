// The real stage executors (stages.mjs) through the real scheduler (`tick`), over Pantheon's scripted providers:
// withDispatch's makeClientFor for the work seats (runOpenItem), and a scripted single-turn `turn` for the planner,
// the plan and change reviewers and the validator. No network and no live model: every result here is synthetic.
// These tests pin the LAB rule: they assert its capacity behaviour (fit defaults to the model rule, owner 2026-11-18).
const LAB = 'lab';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openStatusLedger, applyProposal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tickWithPrimary as tick} from './test-fixtures.mjs';   // every tick declares primary Gemini execution: the fit implementer is an SDK session
import {reconcile} from './reconcile.mjs';
import {makeExecutors, planRefusal} from './stages.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {SEATING} from '../../pantheon/src/role/seating.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, TICKET, fixture, APPROVE, json, planFor, ACCEPT, scriptedTurn, LIMITS, SYNTH, FIVE, SIX, stagesOf} from './test-fixtures.mjs';


test('the four configured labs: a Ready item with no ticket gets a reviewed plan and its ticket, then the change review is a recorded capacity pending, nothing narrowed', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, calls}) => {
    const f = fixture(repo, [{item: 'four-labs'}]);
    const turn = scriptedTurn();
    const executors = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'implement:pending'], JSON.stringify(r.dispatched));
    const [plan, impl] = openWorkLedger({root: f.workRoot}).stages('four-labs');
    const plannerLab = plan.outputs.planner.lab;
    assert.equal(plan.outputs.plan_review.labs.length, 3);
    assert.ok(!plan.outputs.plan_review.labs.includes(plannerLab));
    assert.ok(readTicket({repo, item: 'four-labs'}).digest, 'the reviewed plan\'s ticket is written and kept');
    // The planner is chosen on its own merits, not moved into the implementer's lab to free a reviewer lab.
    assert.match(impl.blocker.what, /^REVIEW_CAPACITY_PENDING/);
    assert.equal(impl.blocker.role, 'check@review');
    assert.ok(impl.blocker.resume_when, 'the pending names its resume condition');
    assert.equal(impl.usage.provider_calls, 0, 'no work is launched that its review could not judge');
    assert.equal(calls.length, 0);
    assert.ok(r.blocked.some(b => b.item === 'four-labs'));
  });
});

test('with a SYNTHETIC fifth reviewer lab, a Ready item with no ticket goes through reviewed planning, ticket creation, implementation, review, validation and an unsigned outcome', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'alpha-item'}]);
    const validatorPrompts = [];
    const turn = scriptedTurn({validator: ({prompt}) => { validatorPrompts.push(prompt); return ACCEPT; }});
    const executors = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'], JSON.stringify(r.dispatched));
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    const [plan, impl, rev, val, out] = w.stages('alpha-item');
    // A substantive plan, approved by three labs that did not write it.
    const doc = plan.outputs.plan;
    assert.equal(doc.schema, 'ophanim.plan/v1');
    assert.equal(doc.mode, 'author');
    assert.deepEqual(doc.requirement.item, 'alpha-item');
    for (const k of ['problem', 'scope', 'exclusions', 'capabilities', 'acceptance', 'slices', 'limits', 'stopping', 'recovery', 'rollback']) assert.ok(doc[k], `plan names ${k}`);
    assert.deepEqual(planRefusal(doc, {shown: ['alpha.mjs', 'verify.mjs']}), []);
    assert.match(plan.outputs.plan_digest, /^sha256:/);
    assert.ok(plan.outputs.evidence.every(e => /^sha256:[0-9a-f]{64}$/.test(e.sha256)), 'the evidence is bound to bytes');
    const plannerLab = plan.outputs.planner.lab;
    assert.equal(plan.outputs.plan_review.labs.length, 3);
    assert.ok(!plan.outputs.plan_review.labs.includes(plannerLab), 'no plan reviewer is the planner\'s lab');
    assert.equal(turn.log.filter(l => l.kind === 'plan-review').length, 3);
    // The ticket the plan derived, written and valid, identified on every later stage.
    const t = readTicket({repo, item: 'alpha-item'});
    assert.equal(t.why, undefined);
    assert.equal(t.digest, plan.outputs.ticket.digest);
    assert.equal(t.ticket.acceptance_cmd, 'node verify.mjs');
    for (const s of [impl, rev, val, out]) assert.equal(s.identity.ticket.digest, t.digest);
    // The implementation, committed on its branch; the review: three labs outside every contributor (the planner's too).
    assert.equal(git(repo, 'rev-parse', 'refs/heads/pantheon/alpha-item').trim(), impl.outputs.commit);
    assert.ok(impl.contributions.some(c => c.purpose === 'plan' && c.lab === plannerLab), 'the planner is a recorded contribution');
    assert.equal(rev.outputs.outcome, 'verified');
    assert.equal(new Set(rev.outputs.labs).size, 3);
    for (const lab of rev.outputs.labs) assert.ok(!rev.outputs.author_labs.includes(lab), `${lab} contributed and may not review`);
    assert.ok(rev.outputs.author_labs.includes(plannerLab));
    // Validation in a clean checkout, judged by a validator from a lab that did not contribute. Under the LAB rule the
    // validator's lab is necessarily one of the panel's, and here the seat is one of the approving change reviewers: the
    // record says so, `independent` is no longer the constant true, and the validator was told it reviewed the change
    // (owner decision L-002 (2026-11-19): under the lab rule only the record and the prompt are corrected).
    assert.equal(val.outputs.verdict, 'accept');
    assert.deepEqual(val.outputs.tests.filter(x => x.kind === 'acceptance').map(x => [x.cmd, x.exit]), [['node verify.mjs', 0]]);
    const ind = val.outputs.validator.independence;
    assert.deepEqual([ind.rule, ind.also_change_reviewer, ind.contributor, ind.fourth_lab, val.outputs.validator.independent], ['lab', true, false, false, false]);
    assert.ok(rev.team.some(t => t.vendor === val.outputs.validator.vendor && t.model === val.outputs.validator.model));
    assert.equal(validatorPrompts.length, 1);
    assert.match(validatorPrompts[0], /^You are the validator of one implemented change[^\n]*You were one of the reviewers whose review of it passed/);
    assert.doesNotMatch(validatorPrompts[0], /You did not plan, write or review it/);
    assert.ok(!rev.outputs.author_labs.includes(val.outputs.validator.lab));
    // The outcome: an unsigned proposal bound to the item, the ticket and the reviewed, validated commit.
    const p = JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'));
    assert.equal(p.item, 'alpha-item');
    assert.equal(p.to.state, 'Resolved');
    assert.equal(p.evidence.ticket.digest, t.digest);
    assert.equal(p.evidence.commit, impl.outputs.commit);
    assert.equal(p.evidence.review.close_entry, rev.outputs.close);
    assert.equal(p.signature, undefined, 'never signed');
    assert.equal(out.outputs.signed, false);
    assert.equal(openStatusLedger({root: f.statusRoot, create: false}).board().items[0].state, 'Ready', 'the status ledger is the owner\'s to change');
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'awaiting-owner');
    // The owner can apply it: everything it cites re-checks structurally, bound to this item's board scope and commit.
    const applied = applyProposal({root: f.statusRoot, proposal: p});
    assert.equal(applied.state, 'Resolved');
    assert.equal(applied.checked.checked, 'structural');
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'complete');
    for (const s of [plan, impl, rev, val]) assert.ok(s.usage.provider_calls <= 40, `${s.stage} stayed within its budget`);
  });
});

test('an existing ticket enters at planning (revalidate): still valid, it is kept byte-identical; no longer valid, it is revised with the reasons', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'keep-item'}, {item: 'stale-item'}], {tickets: ['keep-item', 'stale-item']});
    const before = Object.fromEntries(['keep-item', 'stale-item'].map(i => [i, fs.readFileSync(path.join(repo, 'tickets', `${i}.json`))]));
    const turn = scriptedTurn({planner: ({prompt, item}) => json(item === 'stale-item'
      ? planFor(prompt, {ticket_assessment: {still_valid: false, reasons: ['the acceptance command does not check that alpha.mjs parses on its own']},
        acceptance: [{id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd: 'node verify.mjs'}}, {id: 'a2', criterion: 'alpha.mjs parses', test: {cmd: 'node --check alpha.mjs'}}]})
      : planFor(prompt))});
    const ex = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'plan:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const keep = w.stages('keep-item')[0], stale = w.stages('stale-item')[0];
    assert.equal(keep.outputs.plan.mode, 'revalidate');
    assert.ok(fs.readFileSync(path.join(repo, 'tickets', 'keep-item.json')).equals(before['keep-item']), 'a still-valid ticket is kept byte-identical');
    assert.equal(keep.outputs.ticket_kept, true);
    assert.equal(keep.outputs.ticket.digest, readTicket({repo, item: 'keep-item'}).digest);
    assert.ok(!fs.readFileSync(path.join(repo, 'tickets', 'stale-item.json')).equals(before['stale-item']), 'an invalid ticket is revised');
    assert.equal(readTicket({repo, item: 'stale-item'}).ticket.acceptance_cmd, 'node verify.mjs && node --check alpha.mjs');
    assert.match(stale.outputs.ticket_revision.reasons[0], /does not check/);
    assert.equal(stale.outputs.ticket_kept, false);
    // Both re-validated plans were independently reviewed before the ticket decision.
    for (const s of [keep, stale]) assert.equal(s.outputs.plan_review.labs.length, 3);
  });
});

test('plan review findings cause a revision and a re-review of the new version; a malformed plan is refused; the finder then counts as a contributor', async () => {
  await withDispatch(async ({dir: repo, makeClientFor, calls}) => {
    const f = fixture(repo, [{item: 'rev-item'}]);
    let cycles = 0;
    const turn = scriptedTurn({
      planner: ({prompt, k}) => (k === 1 ? 'Here is my plan: do it carefully.' : json(planFor(prompt))),
      'plan-review': ({vendor}) => {
        if (vendor === 'xai') cycles++;
        return vendor === 'xai' && cycles === 1
          ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'the plan has no regression check for importers of alpha.mjs', reproduction: null}]})
          : APPROVE;
      },
    });
    // A SYNTHETIC fifth lab: the revision answers xai's finding, so xai may not review it, and four labs leave too few.
    const ex = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir, ...FIVE});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan, implement: ex.implement}, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'implement:pending']);
    const [plan, impl] = openWorkLedger({root: f.workRoot}).stages('rev-item');
    assert.equal(plan.outputs.refused.length, 1, 'the malformed answer was refused');
    assert.match(plan.outputs.refused[0].why.join(), /not one JSON plan object/);
    assert.equal(plan.outputs.versions.length, 2, 'the revised version was re-reviewed');
    const [v1, v2] = plan.outputs.versions;
    assert.notEqual(v1.digest, v2.digest);
    assert.notEqual(v1.cycle, v2.cycle, 'the revision has its own review cycle');
    assert.equal(plan.outputs.plan.version.previous, v1.digest);
    assert.equal(plan.outputs.plan_digest, v2.digest, 'only the exact re-reviewed version is approved');
    assert.ok(plan.outputs.plan.answers.length >= 1, 'the revision answers the finding');
    assert.ok(v1.reviews.some(x => x.verdict === 'request_changes'));
    assert.ok(v2.reviews.every(x => x.verdict === 'approve'));
    assert.ok(!v2.reviews.some(x => x.lab === 'xai'), 'the lab whose finding the revision answers does not review the revision');
    assert.equal(new Set(v2.reviews.map(x => x.lab)).size, 3);
    assert.equal(turn.log.filter(l => l.kind === 'plan-review').length, 6);
    assert.ok(plan.contributions.some(c => c.purpose === 'plan-review' && c.lab === 'xai'), 'the finder\'s critique reached the plan');
    // That critique makes xai a contributor: with the planner's lab, the configured pool is short of three
    // independent labs for the change, so implementation is not launched (pending, never fewer labs).
    assert.equal(impl.blocker.role, 'check@review');
    assert.match(impl.blocker.what, /^REVIEW_CAPACITY_PENDING/);
    assert.equal(impl.usage.provider_calls, 0);
    assert.equal(calls.length, 0, 'no work seat was called');
    assert.ok(readTicket({repo, item: 'rev-item'}).digest, 'the approved plan\'s ticket is kept');

    // The four configured labs: the revision would need three labs outside the planner's and the finder's. It is not
    // paid for; the reviewed version and its findings are kept and the plan waits on review capacity.
    const g = path.join(repo, 'four');
    fs.mkdirSync(g);
    const fg = fixture(g, [{item: 'rev-four'}]);
    const t4 = scriptedTurn({'plan-review': ({vendor}) => (vendor === 'xai'
      ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: 'no regression check', reproduction: null}]}) : APPROVE)});
    const r4 = await tick({repo: g, statusRoot: fg.statusRoot, workRoot: fg.workRoot, executors: {plan: makeExecutors({independence: LAB, repo: g, makeClientFor, turn: t4, stateDir: fg.stateDir}).plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(r4), ['plan:pending']);
    const p4 = openWorkLedger({root: fg.workRoot}).stages('rev-four')[0];
    assert.match(p4.blocker.what, /^REVIEW_CAPACITY_PENDING: the revised plan would answer findings from xai/);
    assert.equal(t4.log.filter(l => l.kind === 'planner').length, 1, 'the revision was not paid for');
    assert.equal(p4.findings.length, 1, 'the findings are kept');
  });
});

test('validation returns an implementation defect to implement and an inadequate criterion to plan', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'impl-defect'}, {item: 'plan-defect'}]);
    const judged = {};
    const turn = scriptedTurn({validator: ({item}) => {
      judged[item] = (judged[item] ?? 0) + 1;
      if (judged[item] > 1) return ACCEPT;
      return item === 'impl-defect'
        ? json({verdict: 'implementation_defect', reasons: ['alpha.mjs also drops a trailing newline the requirement keeps'], criteria: [{id: 'a1', met: false, why: 'see reasons'}]})
        : json({verdict: 'plan_defect', reasons: ['criterion a1 does not test that alpha.mjs keeps its other exports'], criteria: [{id: 'a1', met: true, why: 'passes, but is inadequate'}]});
    }});
    const ex = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir, ...SIX});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const seq = item => w.stages(item).map(s => `${s.stage}:${s.status}`);
    const a = w.stages('impl-defect');
    const va = a.find(s => s.stage === 'validate');
    assert.equal(va.next.stage, 'implement');
    assert.equal(va.outputs.verdict, 'implementation_defect');
    assert.deepEqual(seq('impl-defect'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'implement:pending']);
    // The returned implement received the validator's findings; the validator's critique now counts as a contribution,
    // so the next three-lab review is short of independent labs and the revision waits rather than lowering the bar.
    assert.ok(a[4].contributions.some(c => c.purpose === 'critique' && c.lab === va.outputs.validator.lab));
    const b = w.stages('plan-defect');
    const vb = b.find(s => s.stage === 'validate');
    assert.equal(vb.next.stage, 'plan');
    assert.equal(vb.outputs.verdict, 'plan_defect');
    assert.deepEqual(seq('plan-defect'), ['plan:passed', 'implement:passed', 'review:passed', 'validate:returned', 'plan:passed', 'implement:pending']);
    const revised = b[4];
    assert.equal(revised.outputs.plan.mode, 'revise');
    assert.deepEqual(revised.outputs.plan.answers.map(x => x.finding), ['validate-1'], 'the revised plan answers the validator\'s finding');
    assert.equal(revised.outputs.plan_review.labs.length, 3, 'and is re-reviewed');
    // A green test alone never passes: both items' first validation ran green and was still returned.
    assert.ok([va, vb].every(v => v.outputs.green === true && v.status === 'returned'));
  });
});

test('an unavailable reviewer or a short pool is pending with a blocker and the work kept; an exhausted stage budget stops within bounds', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'flaky-review'}]);
    let down = true;
    const turn = scriptedTurn({review: ({vendor}) => { if (vendor === 'xai' && down) throw Object.assign(new Error('503 service unavailable'), {status: 503}); return APPROVE; }});
    const ex = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir, ...SIX});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:passed', 'implement:passed', 'review:pending']);
    const w = openWorkLedger({root: f.workRoot});
    const impl = w.stages('flaky-review')[1], rev = w.stages('flaky-review')[2];
    assert.equal(rev.blocker.role, 'check@review');
    assert.match(rev.blocker.what, /REVIEW_PENDING: 2 of 3/);
    assert.ok(r.blocked.some(b => b.item === 'flaky-review' && /REVIEW_PENDING/.test(b.blocker.what)));
    assert.equal(git(repo, 'rev-parse', 'refs/heads/pantheon/flaky-review').trim(), impl.outputs.commit, 'the commit is kept');
    // The failure is transient: the pending carries a retry time. Before it is due, the scheduler dispatches nothing.
    assert.equal(rev.blocker.transient, true);
    const due = Date.parse(rev.blocker.retry_at);
    assert.ok(Number.isFinite(due));
    const early = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => due - 1000});
    assert.deepEqual(stagesOf(early), [], 'not before the retry is due');
    assert.ok(early.blocked.some(b => b.item === 'flaky-review'));
    // The reviewer comes back; at the retry time the scheduler re-dispatches review on its own: the SAME open cycle is
    // resumed, only the missing seat is asked, the two reviews kept, and the item goes on to validation and outcome.
    down = false;
    const reviewsAsked = () => turn.log.filter(l => l.kind === 'review').map(l => l.vendor);
    const askedBefore = reviewsAsked();
    const later = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => due + 1000});
    assert.deepEqual(stagesOf(later), ['review:passed', 'validate:passed', 'outcome:passed']);
    const again = openWorkLedger({root: f.workRoot}).stages('flaky-review').find(s => s.stage === 'review' && s.status === 'passed');
    assert.equal(again.attempt, 2);
    assert.equal(again.outputs.cycle, rev.outputs.cycle, 'resumed, not reopened');
    assert.deepEqual(reviewsAsked(), [...askedBefore, 'xai'], 'the resumed cycle asked the missing seat only');
    assert.equal(again.usage.provider_calls, 1);

    // A reviewer that never comes back: the retries are bounded by stage_attempts on the same inputs, then the item is
    // blocked for the orchestration lead with the attempts counted; nothing is reviewed by fewer labs.
    const d = path.join(repo, 'down');
    fs.mkdirSync(d);
    const fd = fixture(d, [{item: 'always-down'}]);
    const deadTurn = scriptedTurn({review: ({vendor}) => { if (vendor === 'xai') throw Object.assign(new Error('503'), {status: 503}); return APPROVE; }});
    const dx = makeExecutors({independence: LAB, repo: d, makeClientFor, turn: deadTurn, stateDir: fd.stateDir, ...SIX});
    let t0 = Date.parse('2026-11-17T00:00:00Z');
    const seen = [];
    for (let i = 0; i < 5; i++, t0 += 60 * 60_000) {
      const ti = await tick({repo: d, statusRoot: fd.statusRoot, workRoot: fd.workRoot, executors: dx, limits: LIMITS, clock: () => t0});
      seen.push(...stagesOf(ti));
      if (i === 4) assert.ok(ti.blocked.some(b => b.item === 'always-down' && /3 attempts of review/.test(b.blocker.what)), JSON.stringify(ti.blocked));
    }
    assert.deepEqual(seen, ['plan:passed', 'implement:passed', 'review:pending', 'review:pending', 'review:pending']);
    // One try of the failed seat per attempt, in the same open cycle: three calls, no more.
    assert.equal(deadTurn.log.filter(l => l.kind === 'review' && l.vendor === 'xai').length, 3);
    const downRevs = openWorkLedger({root: fd.workRoot}).stages('always-down').filter(s => s.stage === 'review');
    assert.equal(new Set(downRevs.map(s => s.outputs.cycle)).size, 1, 'one cycle, resumed, never reopened');

    // A short pool: the configured reviewer seating offers two labs outside the planner's. Nothing is planned and
    // no provider is called; the plan is pending, never reviewed by fewer labs.
    const g = path.join(repo, 'short');
    fs.mkdirSync(g);
    const fg = fixture(g, [{item: 'short-pool'}]);
    const shortTurn = scriptedTurn();
    const short = {reviewer: SEATING.reviewer.filter(c => c.vendor !== 'anthropic')};
    const sx = makeExecutors({independence: LAB, repo: g, makeClientFor, turn: shortTurn, stateDir: fg.stateDir, seating: short});
    // No iteration cap here: a structural pending is recorded once and is not re-dispatched on the same inputs.
    const rs = await tick({repo: g, statusRoot: fg.statusRoot, workRoot: fg.workRoot, executors: sx, limits: LIMITS});
    assert.deepEqual(stagesOf(rs), ['plan:pending']);
    assert.ok(rs.blocked.some(b => b.item === 'short-pool' && /^REVIEW_CAPACITY_PENDING/.test(b.blocker.what)));
    assert.deepEqual(stagesOf(await tick({repo: g, statusRoot: fg.statusRoot, workRoot: fg.workRoot, executors: sx, limits: LIMITS})), [], 'nor on the next tick');
    const ps = openWorkLedger({root: fg.workRoot}).stages('short-pool')[0];
    assert.match(ps.blocker.what, /^REVIEW_CAPACITY_PENDING/);
    assert.equal(ps.usage.provider_calls, 0);
    assert.equal(shortTurn.log.length, 0);

    // An exhausted stage budget: 5 calls cover one plan and its review, not a revision and its re-review.
    const h = path.join(repo, 'budget');
    fs.mkdirSync(h);
    const fh = fixture(h, [{item: 'tight'}]);
    const tight = scriptedTurn({'plan-review': ({vendor}) => (vendor === 'xai'
      ? json({verdict: 'request_changes', findings: [{severity: 'block', file: null, line: null, claim: 'no rollback for importers', reproduction: null}]}) : APPROVE)});
    const hx = makeExecutors({independence: LAB, repo: h, makeClientFor, turn: tight, stateDir: fh.stateDir, ...FIVE});
    const rh = await tick({repo: h, statusRoot: fh.statusRoot, workRoot: fh.workRoot, executors: hx, limits: {total_provider_calls: 100, stage_provider_calls: 5}});
    assert.deepEqual(stagesOf(rh), ['plan:failed']);
    const ph = openWorkLedger({root: fh.workRoot}).stages('tight')[0];
    assert.match(ph.next.why, /stage budget/);
    assert.equal(ph.usage.provider_calls, 4);
    assert.equal(tight.log.length, 4, 'one plan, three reviews: no call past the bound');
    assert.equal(fs.existsSync(path.join(h, 'tickets', 'tight.json')), false, 'no unapproved ticket is written');
  });
});

test('a one-line-title "plan" is refused, never reviewed, and writes no ticket; the review floor cannot be lowered', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'title-only'}]);
    const turn = scriptedTurn({planner: () => 'TITLE: alpha.mjs exports ok = true'});
    const ex = makeExecutors({independence: LAB, repo, makeClientFor, turn, stateDir: f.stateDir});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r), ['plan:failed']);
    const p = openWorkLedger({root: f.workRoot}).stages('title-only')[0];
    assert.equal(p.outputs.refused.length, 3);
    assert.ok(p.outputs.refused.every(x => /not one JSON plan object/.test(x.why.join())));
    assert.equal(turn.log.filter(l => l.kind === 'plan-review').length, 0, 'a refused plan is never put to review');
    assert.equal(p.usage.provider_calls, 3, 'every refused answer is counted');
    assert.equal(fs.existsSync(path.join(repo, 'tickets', 'title-only.json')), false);
    // A thin JSON "plan" is refused as well: a title in a JSON object is still a title.
    assert.ok(planRefusal({title: 'alpha.mjs exports ok = true'}).length > 5);
    assert.throws(() => makeExecutors({independence: LAB, repo, makeClientFor, turn, n: 2}), /needs 3 labs/);
  });
});
