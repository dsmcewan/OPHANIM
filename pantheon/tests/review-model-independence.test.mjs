// MODEL-level review independence (pantheon.cycle/v3; owner direction 2026-11-17): the panel is three distinct labs,
// and what is excluded is the MODELS that contributed, not every model of their labs. Tested on the REAL configured
// model inventory (role/seating.mjs, config/models.json, config/lanes.json). Reviewer turns are scripted.
// Not active by default: a cycle opens under v3 only when asked; v1 and v2 cycles keep the lab rule.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPantheonLedger} from '../src/ledger/system.mjs';
import {reviewCycle, reviewSeats, reviewSeatsByModel} from '../src/ledger/review-cycle.mjs';
import {CYCLE_CONTRACT, CYCLE_CONTRACT_V3} from '../src/ledger/cycle-kinds.mjs';
import {modelIdentity, contributorKeys, currentPolicy} from '../src/review/identity.mjs';
import {cycleReviewers} from '../src/board/operate.mjs';

const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
let n = 0;
const approve = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `mi_${vendor}_${++n}`, served_model: model});
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-model-indep-'));
  try { const sys = openPantheonLedger({root: path.join(dir, 'ledger')}); return await fn(sys, sys.recorder()); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const contrib = (purpose, vendor, model, extra = {}) => ({purpose, vendor, model, ...extra});
const PLAN = contrib('plan', 'anthropic', 'claude-fable-5-2'), WORK = contrib('work', 'openai', 'gpt-6-astra');
const labs = seats => seats.map(s => s.lab);
const ids = seats => seats.map(s => s.identity);

test('identity: effort levels, lane names, dated snapshots and routes are the same model; an unknown name is not assumed to be a different one', () => {
  const id = (v, m) => modelIdentity(v, m).id;
  assert.equal(id('agy_google', 'claude-opus-4-6-thinking'), id('anthropic', 'claude-opus-4-6'), 'a thinking (effort) variant through another route');
  assert.equal(id('agy_google', 'gemini-3.8-flash-high'), id('google', 'gemini-3.8-flash'), 'an effort variant under a lane name');
  assert.equal(id('anthropic', 'claude-haiku-4-5-20251001'), id('anthropic', 'claude-haiku-4-5'), 'a dated snapshot');
  assert.equal(id('anthropic', 'Claude-Fable-5-2'), id('anthropic', 'claude-fable-5-2'));
  assert.notEqual(id('anthropic', 'claude-fable-5-2'), id('anthropic', 'claude-opus-5-5'), 'two models of one lab are two models');
  // A model this configuration does not declare is UNRESOLVED: not another model, and not a model of its route's lab.
  assert.equal(modelIdentity('openai', 'gpt-6-astra-turbo-preview').known, false);
  const k = contributorKeys([PLAN, contrib('work', 'openai', 'gpt-6-astra-turbo-preview'), {purpose: 'critique', lab: 'xai'}]);
  assert.deepEqual(k.unresolved.map(u => u.model), ['gpt-6-astra-turbo-preview']);
  assert.deepEqual(k.labs, ['xai'], 'a contribution that names only its lab excludes that lab');
  assert.deepEqual(k.contributing_labs, ['anthropic', 'xai']);
  assert.throws(() => reviewSeatsByModel({n: 3, contributions: [PLAN, contrib('work', 'openai', 'gpt-6-astra-turbo-preview')]}), /a contributor's identity is unresolved/);
  // The requested and the served model of one turn are both contributors.
  assert.deepEqual(contributorKeys([contrib('work', 'openai', 'gpt-6-sol', {requested_model: 'gpt-6-astra'})]).models, ['openai/gpt-6-astra', 'openai/gpt-6-sol']);
});

test('the real inventory: a plan and an implementation from two labs leave a three-lab panel; non-contributing labs come first and a shared lab is recorded', () => {
  // The lab rule (v1, v2), for contrast: two contributing labs leave two labs.
  assert.throws(() => reviewSeats({n: 3, avoidLabs: ['anthropic', 'openai']}), e => e.code === 'NO_SEATS');
  const seats = reviewSeatsByModel({n: 3, contributions: [PLAN, WORK]});
  assert.equal(new Set(labs(seats)).size, 3, 'three distinct labs');
  assert.deepEqual(labs(seats).slice(0, 2).sort(), ['google', 'xai'], 'the labs that did not contribute are seated first');
  const third = seats[2];
  assert.ok(['anthropic', 'openai'].includes(third.lab));
  assert.equal(third.shared_lab, true);
  assert.deepEqual(third.shared_with, [third.lab === 'anthropic' ? 'anthropic/claude-fable-5-2' : 'openai/gpt-6-astra'], 'which contributor it shares a lab with');
  assert.ok(seats.slice(0, 2).every(s => s.shared_lab === false));
  for (const s of seats) assert.ok(!['anthropic/claude-fable-5-2', 'openai/gpt-6-astra'].includes(s.identity), 'no contributing model reviews');
  // A contributor is excluded through every name it has: contributing claude-opus-4-6 excludes the thinking lane.
  const viaAlias = reviewSeatsByModel({n: 4, contributions: [contrib('plan', 'anthropic', 'claude-opus-4-6')]});
  assert.ok(!viaAlias.some(s => s.model === 'claude-opus-4-6-thinking'));
  const effort = reviewSeatsByModel({n: 4, contributions: [contrib('critique', 'google', 'gemini-3.8-flash')]});
  assert.ok(!effort.some(s => s.model === 'gemini-3.8-flash-high'), 'another effort level of a contributor is not a new reviewer');
  // cycleReviewers, as the board and the lifecycle call it.
  const scope = {kind: 'change', contributions: [{...PLAN, lab: 'anthropic'}, {...WORK, lab: 'openai'}], author_labs: ['anthropic', 'openai']};
  assert.equal(cycleReviewers({scope}).pending.code, 'REVIEW_CAPACITY_PENDING', 'the default is still the lab rule');
  const by = cycleReviewers({scope, independence: 'model'});
  assert.equal(by.seats.length, 3);
  assert.deepEqual(by.shared_labs, [third.lab]);
  assert.deepEqual(by.author_models, ['anthropic/claude-fable-5-2', 'openai/gpt-6-astra']);
});

test('repeated revisions: contributions come to span all four labs and a three-lab panel still forms; when fewer than three labs have a model left, the review is pending', () => {
  // Each revision's panel is chosen from the real inventory, and one of its reviewers' findings reaches the next revision.
  const history = [PLAN, WORK];
  const rounds = [];
  for (let r = 0; r < 12; r++) {
    let seats;
    try { seats = reviewSeatsByModel({n: 3, contributions: history}); } catch (e) { assert.equal(e.code, 'NO_SEATS'); rounds.push({pending: e.eligible_labs}); break; }
    assert.equal(new Set(labs(seats)).size, 3);
    const keys = contributorKeys(history);
    for (const s of seats) assert.ok(!keys.models.includes(s.identity), `${s.identity} contributed earlier and reviews revision ${r + 1}`);
    rounds.push({labs: labs(seats), shared: seats.filter(s => s.shared_lab).length, contributing: keys.contributing_labs.length});
    // The finding of the first reviewer from a lab not yet contributing (else the first reviewer) reaches the next revision.
    const finder = seats.find(s => !keys.contributing_labs.includes(s.lab)) ?? seats[0];
    history.push(contrib('critique', finder.vendor, finder.model));
  }
  const spanning = rounds.filter(x => x.labs && x.contributing === 4);
  assert.ok(spanning.length >= 1, `a panel formed after contributions spanned all four labs: ${JSON.stringify(rounds)}`);
  assert.ok(spanning.every(x => x.shared === 3), 'every seat of such a panel shares a lab with a contributor, and says so');
  // The full contribution history is preserved: nothing that contributed in an early revision returns later.
  assert.equal(new Set(contributorKeys(history).models).size, history.length, 'each contribution is a distinct model');
  // It ends pending, not on a smaller panel: fewer than three labs have a model that did not contribute.
  const last = rounds.at(-1);
  assert.ok(last.pending && last.pending.length < 3, JSON.stringify(rounds));
  const scope = {kind: 'change', contributions: history.map(c => ({...c, lab: modelIdentity(c.vendor, c.model).lab})), author_labs: []};
  const cap = cycleReviewers({scope, independence: 'model'});
  assert.equal(cap.seats, null);
  assert.equal(cap.pending.code, 'REVIEW_CAPACITY_PENDING');
  assert.match(cap.pending.why, /fewer than 3 labs have a model that did not contribute/);
  // A lab with an unidentifiable contributor is out entirely, which can also leave fewer than three.
  assert.throws(() => reviewSeatsByModel({n: 3, contributions: [PLAN, {purpose: 'critique', lab: 'xai'}, {purpose: 'critique', lab: 'google'}]}), e => e.code === 'NO_SEATS');
});

test('the ledger enforces v3: a contributing model is refused under any of its names, a sibling model is accepted and recorded as sharing a lab, and three distinct labs are still required', () => withLedger(async (sys, rec) => {
  const change = (scope, extra = {}) => ({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x'], independence: 'model', contributions: [PLAN, WORK], ...extra});
  const r = await reviewCycle({ledger: rec, change: change('v3'), turn: approve});
  const c = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle));
  assert.equal(c.contract, CYCLE_CONTRACT_V3);
  assert.deepEqual(c.author_models, ['anthropic/claude-fable-5-2', 'openai/gpt-6-astra']);
  assert.deepEqual(c.author_labs, ['anthropic', 'openai']);
  assert.equal(c.required_reviewers, 3);
  assess(rec, r.cycle);
  const close = rec.closeCycle(r.cycle);
  assert.equal(close.outcome, 'verified');
  assert.equal(new Set(close.labs).size, 3);
  assert.equal(close.shared_labs.length, 1, 'the close names the reviewer lab that also contributed');
  assert.ok(['anthropic', 'openai'].includes(close.shared_labs[0]));
  assert.equal(sys.ledger.verify().ok, true);

  // A contributor may not review: named directly, by an effort lane of it, or as the model that served another request.
  const three = extra => [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'agy_google', model: 'gemini-3.6-flash'}, extra];
  await assert.rejects(reviewCycle({ledger: rec, change: change('direct'), turn: approve, seats: three({vendor: 'anthropic', model: 'claude-fable-5-2'})}), e => e.code === 'CONTRIBUTOR');
  await assert.rejects(reviewCycle({ledger: rec, change: change('alias', {contributions: [contrib('plan', 'anthropic', 'claude-opus-4-6'), WORK]}), turn: approve,
    seats: three({vendor: 'agy_google', model: 'claude-opus-4-6-thinking'})}), e => e.code === 'CONTRIBUTOR');
  // Served as a contributor although asked for a sibling: the ledger refuses the review itself, and the cycle stays open.
  const served = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `sv_${++n}`, served_model: vendor === 'anthropic' ? 'claude-fable-5-2' : model});
  const s = await reviewCycle({ledger: rec, change: change('served'), turn: served, seats: three({vendor: 'anthropic', model: 'claude-sonnet-5'})});
  assert.equal(s.failed.length, 1);
  assert.match(s.failed[0].why, /anthropic\/claude-fable-5-2 contributed to the change under review/);
  assert.throws(() => rec.closeCycle(s.cycle), /2 of 3 reviews are recorded/);
  // Three distinct labs, still: two seats of one lab are refused, and a panel of two cannot be asked for.
  await assert.rejects(reviewCycle({ledger: rec, change: change('samelab'), turn: approve,
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}, {vendor: 'anthropic', model: 'claude-opus-5-5'}]}), e => e.code === 'SAME_LAB');
  await assert.rejects(reviewCycle({ledger: rec, change: change('two'), turn: approve, n: 2}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED' || e.code === 'NO_SEATS');
  assert.throws(() => rec.openCycle({scope: 'low', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], prompt: 'p', contract: CYCLE_CONTRACT_V3, reviewers: 2, required_reviewers: 2,
    author_models: [], excluded_labs: [], contributors: [], identity_policy: currentPolicy()}), /at least 3; a caller cannot lower it/);
}));

test('history is verified under the rule it was recorded under: a v2 cycle on the same ledger still refuses the contributing lab, and v2 stays the default', () => withLedger(async (sys, rec) => {
  const v2 = {scope: 'old', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], author_labs: ['anthropic', 'openai']};
  // Under v2 a sibling model of a contributing lab may not review, exactly as before.
  await assert.rejects(reviewCycle({ledger: rec, change: v2, turn: approve,
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'agy_google', model: 'gemini-3.6-flash'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}]}), e => e.code === 'SAME_LAB');
  const one = {...v2, author_labs: ['openai']};
  const r = await reviewCycle({ledger: rec, change: one, turn: approve, required_reviewers: 3});
  const c = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle));
  assert.equal(c.contract, CYCLE_CONTRACT, 'a cycle opens under v2 unless model independence is asked for');
  assert.equal(c.author_models, undefined);
  assess(rec, r.cycle);
  const close = rec.closeCycle(r.cycle);
  assert.equal(close.shared_labs, undefined, 'a v2 close is the claim it always was');
  // A v3 cycle follows on the same ledger; both verify, each under its own rule.
  const next = await reviewCycle({ledger: rec, change: {scope: 'new', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], independence: 'model', contributions: [PLAN, WORK]}, turn: approve});
  assess(rec, next.cycle);
  rec.closeCycle(next.cycle);
  assert.equal(sys.ledger.verify().ok, true);
  // A v2 payload cannot carry v3's fields, so the lab rule cannot be dropped inside a v2 cycle.
  const mixed = rec.openCycle({scope: 'mixed', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], prompt: 'p', author_labs: ['anthropic'], author_models: ['x/y']});
  const m = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === mixed));
  assert.equal(m.contract, CYCLE_CONTRACT);
  assert.equal(m.author_models, undefined, 'v3 fields passed to a v2 cycle are not recorded: its rule stays the lab rule');
}));

test('cold review, by contract: with the author\'s turn cited, v3 refuses the model in the lineage and admits a sibling; v2 still refuses the whole lab', () => withLedger(async (sys, rec) => {
  const plannerTurn = (id, served = 'claude-fable-5-2') => rec.recordTurn({seat: {seat_id: `anthropic-plan-${id}@claude-fable-5-2`, vendor: 'anthropic', mode: 'plan', occupancy_gen: 1},
    requested_model: 'claude-fable-5-2', served_model: served, response_id: `plan_${id}`, reply: `a plan ${id}`, purpose: 'plan', prompt: 'p'});
  const three = extra => [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'agy_google', model: 'gemini-3.6-flash'}, extra];
  const base = scope => ({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x']});
  // v3, a sibling model of the planner's lab reviews work whose lineage holds the planner's turn: accepted.
  const t1 = plannerTurn(1);
  const ok = await reviewCycle({ledger: rec, change: {...base('cold-v3'), author_turns: [t1], independence: 'model', contributions: [PLAN]}, turn: approve, seats: three({vendor: 'anthropic', model: 'claude-sonnet-5'})});
  assert.equal(ok.failed.length, 0);
  // v3, a turn that was SERVED by another model than it asked for: that serving model is in the lineage, and is refused
  // even though the cycle's contribution list (wrongly) omits it.
  const t2 = plannerTurn(2, 'claude-opus-5-5');
  const bad = await reviewCycle({ledger: rec, change: {...base('cold-served'), author_turns: [t2], independence: 'model', contributions: [PLAN]}, turn: approve, seats: three({vendor: 'anthropic', model: 'claude-opus-5-5'})});
  assert.equal(bad.failed.length, 1);
  assert.match(bad.failed[0].why, /anthropic\/claude-opus-5-5 is in the lineage of what it reviews/);
  // v2, the same shape: the sibling's LAB is in the lineage, as it always was.
  const t3 = plannerTurn(3);
  const old = await reviewCycle({ledger: rec, change: {...base('cold-v2'), author_turns: [t3], author_labs: []}, turn: approve, seats: three({vendor: 'anthropic', model: 'claude-sonnet-5'})});
  assert.equal(old.failed.length, 1);
  assert.match(old.failed[0].why, /the anthropic lab is in the lineage of what it reviews/);
  assert.equal(sys.ledger.verify().ok, true);
}));
