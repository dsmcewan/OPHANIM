// Self-audit round 3, assignment 2 (sealed 449ca42): the LEDGER enforces what the identity rules claim.
//   L-1/L-204  a lab-rule cycle that pins its lab identity resolves every lab under it (never from a route or a vendor),
//              and records the three-lab floor; the kind refuses such a cycle without it, and a scope never drops either.
//   L-3/L-204  a turn's served-model marker is one of the vocabulary's and consistent with the names.
//   D-C/L-201  a reviewer's retrieval rounds are turns on the cycle, each admitted by the review's own rule.
//   M9/L-205   a v3 cycle records every requested and served name of a contribution (contributorRows), through reviewCycle.
// Recorded history (cycles without the new fields) verifies exactly as before. Temporary ledgers; no provider is called.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPantheonLedger, CONTROLLER} from '../src/ledger/system.mjs';
import {reviewCycle} from '../src/ledger/review-cycle.mjs';
import {reviewPrompt, cycleRecorder, deriveCycle, ledgerView, CYCLE} from '../src/ledger/cycle-kinds.mjs';
import * as identity from '../src/review/identity.mjs';

const {currentPolicy, policyDigest, resolveModel} = identity;

const SA = 'self-audit round 3, assignment 2 (sealed 449ca42)';
const C = n => String(n).repeat(40).slice(0, 40);
const BASE = C('a'), HEAD = C('b');
const DIFF = 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n';
const change = (over = {}) => ({scope: 'ophanim', base: BASE, head: HEAD, diff: DIFF, files: ['src/x.mjs'], author_labs: ['anthropic'], ...over});
const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
const ROUND = '```json\n{"requests": [{"op": "file", "path": "src/x.mjs"}]}\n```';
const ctl = sys => ({author: {key_id: CONTROLLER}, signer: sys.controller, order: sys.controller});
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-wave2-identity-'));
  try { const sys = openPantheonLedger({root: path.join(dir, 'ledger')}); return await fn(sys, sys.recorder()); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
/** Each vendor answers as scripted: a reply or {text, served_model, served_model_source?, rounds?}. */
const scripted = (replies = {}) => {
  let n = 0;
  return async ({vendor, model}) => {
    const r = replies[vendor] ?? APPROVE;
    const o = typeof r === 'string' ? {text: r} : r;
    return {text: o.text, response_id: `resp_${vendor}_${++n}`, served_model: 'served_model' in o ? o.served_model : model,
      ...(o.served_model_source ? {served_model_source: o.served_model_source} : {}), ...(o.rounds ? {rounds: o.rounds.map((x, i) => ({prompt: `round ${i + 1}`, text: ROUND, response_id: `resp_${vendor}_r${++n}`, ...x}))} : {})};
  };
};
const L1 = {agy_google: {text: APPROVE, served_model: 'claude-opus-5-5'}, xai: {text: APPROVE, served_model: 'grok-9-undeclared'}};

test(`${SA}, L-1/L-204: a lab-rule cycle that pins its lab identity refuses a Claude answer on the Google route and an undeclared model; one that does not (history) still closes as recorded`, () => withLedger(async (sys, rec) => {
  // Pinned: the identity a lab is resolved under is on the cycle.
  const pinned = await reviewCycle({ledger: rec, change: change({lab_identity: currentPolicy()}), turn: scripted(L1)});
  const c = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === pinned.cycle));
  assert.deepEqual([c.lab_identity.digest, c.required_reviewers], [policyDigest(currentPolicy()), 3]);
  assert.equal(pinned.reviews.length, 1);
  assert.deepEqual(pinned.failed.map(x => x.lab).sort(), ['google', 'xai']);
  assert.match(pinned.failed.find(x => x.lab === 'google').why, /google\/gemini-3\.8-flash was asked and anthropic\/claude-opus-5-5 answered/);
  assert.match(pinned.failed.find(x => x.lab === 'xai').why, /"grok-9-undeclared" is not a model this identity policy declares/);
  assess(rec, pinned.cycle);
  assert.throws(() => rec.closeCycle(pinned.cycle), /1 of 3 reviews are recorded/);
  assert.equal(sys.ledger.verify().ok, true);
  // History: the same answers on a cycle without the field (the shape every lab-rule cycle was recorded in) are judged
  // by labOf, as recorded, and still verify and close.
  const legacy = await reviewCycle({ledger: rec, change: change({scope: 'legacy'}), turn: scripted(L1)});
  assert.equal(legacy.reviews.length, 3);
  assess(rec, legacy.cycle);
  assert.equal(rec.closeCycle(legacy.cycle).outcome, 'verified');
  assert.equal(sys.ledger.verify().ok, true);
}));

test(`${SA}, L-2/L-204: the three-lab floor of a pinned lab-rule cycle is the kind's, not only the recorder's; a scope never returns to an unfloored or unpinned cycle`, () => withLedger(async (sys, rec) => {
  const policy = currentPolicy();
  const prompt = reviewPrompt({base: BASE, head: HEAD, files: ['src/x.mjs'], diff: DIFF});
  // Written past the recorder (a controller-key holder appending directly): pinned and unfloored is refused by the kind.
  const hist = cycleRecorder({ledger: sys.ledger, controller: sys.controller, order: sys.controller, historical: true});
  const h = hist.openCycle({scope: 'raw', base: BASE, head: HEAD, diff: DIFF, files: ['src/x.mjs'], prompt, reviewers: 1, author_labs: ['anthropic']});
  const p = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === h));
  assert.equal(p.required_reviewers, undefined, 'the historical shape is still writable and verifies');
  assert.throws(() => sys.ledger.append({kind: CYCLE, payload: {...p, scope: 'raw-pinned', lab_identity: {digest: policyDigest(policy), rules: policy}}, derivedFrom: [], ...ctl(sys)}),
    /a cycle that pins its lab identity records required_reviewers/);
  assert.throws(() => sys.ledger.append({kind: CYCLE, payload: {...p, scope: 'raw-forged', reviewers: 3, required_reviewers: 3, lab_identity: {digest: 'sha256:' + '0'.repeat(64), rules: policy}}, derivedFrom: [], ...ctl(sys)}),
    /lab_identity is \{digest, rules\}/);
  // A pinned, floored cycle, closed; the next cycle of that scope may drop neither.
  const first = await reviewCycle({ledger: rec, change: change({scope: 'mono', lab_identity: policy}), turn: scripted()});
  assess(rec, first.cycle);
  const close = rec.closeCycle(first.cycle).hash;
  const next = {scope: 'mono', base: HEAD, head: C('c'), diff: DIFF, files: ['src/x.mjs'], prompt, reviewers: 3, author_labs: ['anthropic']};
  assert.throws(() => hist.openCycle(next), /a later one may not drop the three-lab floor/);
  assert.throws(() => rec.openCycle(next), /pins its lab identity: a later lab-rule cycle may not drop it/);
  const ok = rec.openCycle({...next, lab_identity: policy});
  assert.ok(sys.ledger.read().find(e => sys.ledger.hashOf(e) === ok).derived_from.includes(close));
  assert.equal(sys.ledger.verify().ok, true);
}));

test(`${SA}, L-3/L-204: the served-model marker is one of the vocabulary's, and "input" names the requested model itself`, () => withLedger(async (sys, rec) => {
  const seat = {seat_id: 'agy_google-cycle-review@gemini-4-carbon-high', vendor: 'agy_google', mode: 'cycle-review', occupancy_gen: 1};
  const base = {seat, requested_model: 'gemini-4-carbon-high', reply: 'x'};
  for (const [over, why] of [[{served_model: 'claude-opus-5-5', served_model_source: 'input'}, /a turn marked "input" records the required input model as served/],
    [{served_model: 'gemini-4-carbon-high', served_model_source: 'trust-me'}, /served_model_source "trust-me" is not one of provider, input, unnamed, unknown/],
    [{served_model: 'gemini-4-carbon-high', served_model_source: 'unnamed'}, /a turn marked "unnamed" names no serving model/],
    [{served_model: null, served_model_source: 'provider'}, /a turn marked "provider" names its serving model/]]) {
    assert.throws(() => rec.recordTurn({...base, ...over, response_id: `r_${Math.random()}`}), why);
  }
  // Every marker any producer writes still records.
  for (const over of [{served_model: 'gemini-4-carbon-high', served_model_source: 'input'}, {served_model: null, served_model_source: 'unnamed'},
    {served_model: 'gemini-4-carbon', served_model_source: 'provider'}, {served_model: 'gemini-4-carbon', served_model_source: 'unknown'}, {served_model: 'gemini-4-carbon'}]) {
    rec.recordTurn({...base, ...over, response_id: `r_${Math.random()}`});
  }
  assert.equal(sys.ledger.verify().ok, true);
}));

test(`${SA}, D-C/L-201: a reviewer's retrieval rounds are turns of its seat on the cycle, each admitted by the review's rule; a round served by a contributor fails the review on the ledger`, () => withLedger(async (sys, rec) => {
  // v3: the plan author claude-opus-5-5 contributed. The xAI reviewer's first round is served by a dated name of its own
  // model (admitted); the OpenAI reviewer's round is served by gpt-6-astra, a contributor (refused).
  const contributions = [{purpose: 'plan', vendor: 'anthropic', model: 'claude-opus-5-5', lab: 'anthropic'}, {purpose: 'work', vendor: 'openai', model: 'gpt-6-astra', lab: 'openai'}];
  const r = await reviewCycle({ledger: rec, change: change({independence: 'model', contributions, author_labs: ['anthropic', 'openai']}),
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'agy_google', model: 'gemini-3.8-flash-high'}, {vendor: 'openai', model: 'gpt-6-sol'}],
    turn: scripted({xai: {text: APPROVE, rounds: [{served_model: 'grok-4.7-20261101'}]}, openai: {text: APPROVE, rounds: [{served_model: 'gpt-6-astra'}]}})});
  assert.deepEqual(r.reviews.map(x => x.lab).sort(), ['google', 'xai']);
  assert.match(r.failed.find(x => x.lab === 'openai').why, /a retrieval round of this review: openai\/gpt-6-astra contributed to the change under review/);
  const L = sys.ledger, turns = L.read().filter(e => e.kind === 'turn').map(e => ({h: L.hashOf(e), e, p: L.payloadOf(e)}));
  const rounds = turns.filter(t => t.p.purpose === 'cycle-review-round');
  assert.deepEqual(rounds.map(t => [t.p.seat.vendor, t.p.served_model]), [['xai', 'grok-4.7-20261101'], ['openai', 'gpt-6-astra']]);
  assert.ok(rounds.every(t => t.e.derived_from.includes(r.cycle)));
  const st = deriveCycle(ledgerView(L), r.cycle);
  assert.equal(st.reviews.length, 2);
  assert.equal(L.verify().ok, true);
  // Under the lab rule (pinned): a round answered by the authoring lab, or from another lab than the review's, is refused.
  const lab = await reviewCycle({ledger: rec, change: change({scope: 'lab', lab_identity: currentPolicy()}),
    turn: scripted({xai: {text: APPROVE, rounds: [{served_model: 'grok-4.6'}]}, openai: {text: APPROVE, rounds: [{served_model: null}]}})});
  assert.deepEqual(lab.reviews.map(x => x.lab).sort(), ['google', 'xai']);
  assert.match(lab.failed.find(x => x.lab === 'openai').why, /a retrieval round of this review: the answer names no serving model/);
  assert.equal(L.verify().ok, true);
}));

test(`${SA}, M9/L-205: a v3 cycle opened through reviewCycle records the requested AND the served name of a contribution, and refuses an answer served by either`, () => withLedger(async (sys, rec) => {
  // The contribution was asked of gpt-6-astra and served by gpt-6-sol (the fit projection's shape: model = served).
  const contributions = [{purpose: 'plan', vendor: 'anthropic', model: 'claude-opus-5-5', lab: 'anthropic'},
    {purpose: 'subtask', vendor: 'openai', model: 'gpt-6-sol', requested_model: 'gpt-6-astra', lab: 'openai'},
    {purpose: 'critique', vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.6', lab: 'xai'}];
  const r = await reviewCycle({ledger: rec, change: change({independence: 'model', contributions, author_labs: ['anthropic', 'openai', 'xai']}),
    seats: [{vendor: 'agy_google', model: 'gemini-3.8-flash-high'}, {vendor: 'openai', model: 'gpt-6-luna'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}],
    turn: scripted({openai: {text: APPROVE, served_model: 'gpt-6-astra'}})});
  const c = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle));
  assert.deepEqual(c.contributors.map(x => `${x.vendor}/${x.model}`).sort(), ['anthropic/claude-opus-5-5', 'openai/gpt-6-astra', 'openai/gpt-6-sol', 'xai/grok-4.6', 'xai/grok-4.7']);
  assert.deepEqual(c.author_models, ['anthropic/claude-opus-5-5', 'openai/gpt-6-astra', 'openai/gpt-6-sol', 'xai/grok-4.6', 'xai/grok-4.7']);
  assert.match(r.failed.find(x => x.lab === 'openai').why, /openai\/gpt-6-astra contributed to the change under review/);
  assert.equal(sys.ledger.verify().ok, true);
}));

test(`${SA}, L-204: a vendor the caller declares outright with its own seat facts is written into the pinned policy; a known vendor's undeclared model never is`, () => {
  const base = currentPolicy();
  const {withDeclaredVendors} = identity;
  assert.equal(typeof withDeclaredVendors, 'function');
  const p = withDeclaredVendors(base, [{vendor: 'synthlab', model: 'synthetic-reviewer-1'}, {vendor: 'xai', model: 'grok-9-undeclared'}, {vendor: 'agy_google', model: 'claude-opus-5-5'}]);
  assert.equal(resolveModel('synthlab', 'synthetic-reviewer-1', p).lab, 'synthlab');
  assert.equal(resolveModel('xai', 'grok-9-undeclared', p).known, false);
  assert.equal(resolveModel('agy_google', 'claude-opus-5-5', p).lab, 'anthropic');
  assert.equal(withDeclaredVendors(base, [{vendor: 'xai', model: 'grok-4.7'}]), base);
});
