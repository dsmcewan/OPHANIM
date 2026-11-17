// Corrections after the review of 10cbd52 (reproduction appendix), at the Pantheon boundary. Scripted answers only:
// these are identity, admission and protocol tests, not an evaluation of any model.
//   1. An ANSWER is admitted on the identity of the model that answered. A missing, blank or unresolved serving model
//      does not qualify, and the model asked for is never taken as evidence of which model answered. Selecting a
//      candidate before a call is a separate question. Cycles recorded under the earlier admission rule verify as before.
//   3. A checker's rejection when the worker is at the top of its dial: under protocol v2 the same seat revises;
//      v1 records re-derive as v1. The in-run review under the model rule, on the run ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPantheonLedger} from '../src/ledger/system.mjs';
import {reviewCycle, reviewSeatsByModel} from '../src/ledger/review-cycle.mjs';
import {reviewerIdentity, reviewerRefusal, candidateIdentity, candidateRefusal, currentPolicy, policyDigest, RESOLVER} from '../src/review/identity.mjs';
import {nextStep, escalationRecord, verifyEscalation, documentedEfforts, PROTOCOL, PROTOCOL_V2, MAX_STEPS} from '../src/route/protocol.mjs';

const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
let n = 0;
const turnWith = served => async ({vendor, model}) => ({text: APPROVE, response_id: `ad_${vendor}_${++n}`, served_model: served(vendor, model)});
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-admission-'));
const PLAN = {purpose: 'plan', vendor: 'anthropic', model: 'claude-fable-5-2'};
const SEATS = [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'openai', model: 'gpt-6-sol'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}];
const change = (scope, extra = {}) => ({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x'], independence: 'model', contributions: [PLAN], ...extra});

test('1. selection and admission are separate: a seat may be asked on the model asked for; an answer counts only on the model that answered', () => {
  assert.equal(RESOLVER, 2);
  // Before a call: the model asked for is all there is.
  assert.deepEqual(candidateIdentity({vendor: 'xai', model: 'grok-4.7'}), {lab: 'xai', id: 'xai/grok-4.7'});
  assert.equal(candidateRefusal({vendor: 'xai', model: 'grok-4.7'}, {models: [], labs: []}), null);
  assert.match(candidateRefusal({vendor: 'anthropic', model: 'claude-fable-5-2'}, {models: ['anthropic/claude-fable-5-2'], labs: []}), /contributed/);
  // After a call: no serving model, no admission. The asked-for model is not substituted.
  for (const served of [null, undefined, '', '   ']) {
    const who = reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: served});
    assert.equal(who.code, 'NO_SERVED_IDENTITY', JSON.stringify(served));
    assert.equal(who.lab, undefined);
    assert.match(reviewerRefusal({vendor: 'xai', model: 'grok-4.7', served_model: served}, {models: [], labs: []}), /names no serving model.*not evidence of which model answered/);
  }
  assert.equal(reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: 'grok-unknown'}).code, 'UNRESOLVED');
  assert.deepEqual(reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.7'}), {lab: 'xai', ids: ['xai/grok-4.7']});
  // The earlier admission rule, kept only for cycles recorded under it.
  assert.deepEqual(reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: null}, {...currentPolicy(), resolver: 1}), {lab: 'xai', ids: ['xai/grok-4.7']});
  assert.equal(reviewSeatsByModel({n: 3, contributions: [PLAN]}).length, 3, 'candidates need no serving model to be asked');
});

test('1. the ledger: three answers that name no serving model do not close a cycle; each is kept; a retry that names it is admitted', async () => {
  const dir = tmp();
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    // The appendix's case: every answer has served_model null.
    const r = await reviewCycle({ledger: rec, change: change('missing'), seats: SEATS, turn: turnWith(() => null)});
    assert.equal(r.reviews.length, 0, 'none of them is a review');
    assert.equal(r.failed.length, 3);
    for (const f of r.failed) assert.match(f.why, /names no serving model/);
    assess(rec, r.cycle);
    assert.throws(() => rec.closeCycle(r.cycle), /0 of 3 reviews are recorded/);
    // Preserved, with provenance: the three turns are on the ledger, and three failed attempts say why.
    const turns = sys.ledger.read().filter(e => e.kind === 'turn').map(e => sys.ledger.payloadOf(e));
    assert.equal(turns.filter(t => t.served_model === null && t.reply.includes('approve')).length, 3);
    const state = rec.cycleState(r.cycle);
    assert.equal(state.attempts.filter(a => a.outcome === 'failed' && /names no serving model/.test(a.why)).length, 3);
    // A blank name is the same as none.
    const blank = await reviewCycle({ledger: rec, change: change('blank'), seats: SEATS, turn: turnWith(v => (v === 'xai' ? '  ' : null))});
    assert.equal(blank.reviews.length, 0);
    // Retry, within the cycle's attempt limit: the SAME open cycle, the same seats; answers that name their model count.
    const again = await reviewCycle({ledger: rec, resume: true, change: change('missing'), seats: SEATS, turn: turnWith((_v, m) => m)});
    assert.equal(again.cycle, r.cycle);
    assert.equal(again.reviews.length, 3);
    assert.equal(rec.closeCycle(r.cycle).outcome, 'verified');
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('1. history: a cycle recorded under the earlier admission rule still verifies and closes as it was recorded', async () => {
  const dir = tmp();
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    const earlier = {...currentPolicy(), resolver: 1};
    const r = await reviewCycle({ledger: rec, change: change('recorded-under-1', {identity_policy: earlier}), seats: SEATS, turn: turnWith(() => null)});
    assert.equal(r.failed.length, 0, 'under the rule it records, an unnamed answer was taken as served by the model asked for');
    const c = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle));
    assert.equal(c.identity_policy.rules.resolver, 1);
    assert.equal(c.identity_policy.digest, policyDigest(earlier));
    assess(rec, r.cycle);
    assert.equal(rec.closeCycle(r.cycle).outcome, 'verified');
    // A new cycle on the same ledger is under the current rule; both verify, each under its own.
    const now = await reviewCycle({ledger: rec, change: change('current'), seats: SEATS, turn: turnWith(() => null)});
    assert.equal(now.failed.length, 3);
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('3. the protocol: a rejection at the top of the dial stops under v1 and is a bounded revision by the same seat under v2', () => {
  const model = 'gpt-6-astra', top = documentedEfforts(model).at(-1);
  const input = {role: 'implementer', seat: {vendor: 'openai', model, effort: top}, outcome: {kind: 'critique', verdict: 'request_changes'}, steps: 0};
  // v1, unchanged (the appendix's probe B).
  const v1 = nextStep(input);
  assert.equal(v1.action, 'stop');
  assert.equal(nextStep({...input, protocol: PROTOCOL}).action, 'stop');
  // v2: permission to revise does not depend on a stronger seat existing. The same model, the same effort.
  const v2 = nextStep({...input, protocol: PROTOCOL_V2});
  assert.equal(v2.action, 'revise');
  assert.deepEqual(v2.to, {vendor: 'openai', model, effort: top, output: null}, 'the same seat: not a new identity');
  // Bounded: the escalation budget still ends it, and it is counted as a step.
  assert.equal(nextStep({...input, protocol: PROTOCOL_V2, steps: MAX_STEPS}).action, 'stop');
  // Everything else is v1's decision under v2: headroom still raises effort; a failed acceptance at the top still stops.
  assert.equal(nextStep({...input, protocol: PROTOCOL_V2, seat: {vendor: 'openai', model, effort: 'low'}}).action, 'raise_effort');
  assert.equal(nextStep({...input, protocol: PROTOCOL_V2, outcome: {kind: 'acceptance', exit: 1}}).action, 'stop');
  assert.equal(nextStep({...input, protocol: PROTOCOL_V2, outcome: {kind: 'critique', verdict: 'approve'}}).action, 'hold');
  // Records name their protocol and are re-derived under it: a v1 trail and a v2 trail both verify; a v2 decision
  // relabelled v1 does not.
  const a = escalationRecord(input), b = escalationRecord({...input, protocol: PROTOCOL_V2});
  assert.equal(a.schema, PROTOCOL);
  assert.equal(b.schema, PROTOCOL_V2);
  assert.equal(verifyEscalation([a]).ok, true);
  assert.equal(verifyEscalation([b, escalationRecord({...input, protocol: PROTOCOL_V2, steps: 1})]).ok, true);
  assert.throws(() => verifyEscalation([{...b, schema: PROTOCOL}]), /not intact|does not follow/);
  assert.throws(() => escalationRecord({...input, protocol: 'pantheon.escalation/v9'}), /unknown protocol/);
});

test('3. the run ledger: an in-run review made under the model rule carries its policy; a sibling is admitted, a contributor or an unnamed answer is not; without the policy the lab rule applies', () => {
  const dir = tmp();
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    const seat = (vendor, model, mode) => ({seat_id: `${vendor}-${mode}@${model}`, vendor, mode, occupancy_gen: 1});
    let k = 0;
    const turn = (vendor, model, purpose, served = model, cites = []) => rec.recordTurn({seat: seat(vendor, model, purpose), requested_model: model, served_model: served, response_id: `rl_${++k}`, reply: `${purpose} ${k}`, purpose, prompt: `p${k}`, cites});
    const review = (vendor, model, work, extra = {}) => rec.recordReview({seat: seat(vendor, model, 'critique'), model, served_model: model, response_id: `rv_${++k}`, verdict: 'approve', targets: [work], ...extra});
    const policy = currentPolicy();
    const work = turn('openai', 'gpt-6-astra', 'work');
    // Lab rule (no policy on the review): a sibling of the worker's lab is refused, as always.
    assert.throws(() => review('openai', 'gpt-6-sol', work), /the openai lab is in the lineage of what it reviews/);
    // Model rule: the sibling is admitted; the worker's own model, under any name, is not.
    review('openai', 'gpt-6-sol', work, {identity_policy: policy});
    assert.throws(() => review('openai', 'gpt-6-astra', work, {identity_policy: policy}), /openai\/gpt-6-astra is in the lineage of what it reviews/);
    assert.throws(() => rec.recordReview({seat: seat('xai', 'grok-4.7', 'critique'), model: 'grok-4.7', served_model: null, response_id: `rv_${++k}`, verdict: 'approve', targets: [work], identity_policy: policy}),
      /names no serving model/);
    assert.throws(() => rec.recordReview({seat: seat('xai', 'grok-4.6', 'critique'), model: 'grok-4.6', served_model: 'grok-9-x', response_id: `rv_${++k}`, verdict: 'approve', targets: [work], identity_policy: policy}),
      /the model that answered is unresolved/);
    review('xai', 'grok-4.7', work, {identity_policy: policy});
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
