// SELF-AUDIT (coordinating lab, Anthropic; not independent), assignment 2 at af0dc30. Scratch reproductions at the
// ledger/identity layer. Each test PASSES when the defect it names is PRESENT. No provider call.
//   node --test .review-tests/a2-ledger.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPantheonLedger} from '../pantheon/src/ledger/system.mjs';
import {reviewCycle} from '../pantheon/src/ledger/review-cycle.mjs';
import {cycleRecorder} from '../pantheon/src/ledger/cycle-kinds.mjs';
import {resolveModel} from '../pantheon/src/review/identity.mjs';
import {labOf} from '../pantheon/src/config/models.mjs';

const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-self-'));
  try { const sys = openPantheonLedger({root: path.join(dir, 'ledger')}); return await fn(sys, sys.recorder()); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// L-1 (Q2, lab rule = every non-fit profile and pantheon-board runs). Under v1/v2 a review's lab is
// labOf(vendor, served ?? model) (cycle-kinds.mjs:113, lineage-kinds.mjs:130, review-cycle.mjs:120): an undeclared
// name takes its VENDOR's lab, and anything answered on the agy_google route counts as Google (models.mjs:59-63).
// The b9fa745 "lab taken from the route" defect was fixed for v3 only. A new default-contract (v2) cycle of an
// ANTHROPIC-authored change closes `verified` with an answer served by claude-opus-5-5 on the agy route, counted as google,
// and one served by an undeclared name on xai, counted as xai.
test('L-1 (Q2): under the lab rule an Anthropic model answering on the agy route counts as Google, and an undeclared name takes its vendor\'s lab', () => withLedger(async (sys, rec) => {
  assert.equal(resolveModel('agy_google', 'claude-opus-5-5').known, true);
  assert.equal(resolveModel('agy_google', 'claude-opus-5-5').lab, 'anthropic');
  assert.equal(labOf('agy_google', 'claude-opus-5-5'), 'google');
  assert.equal(labOf('xai', 'grok-9-undeclared'), 'xai');
  const served = {'agy_google': 'claude-opus-5-5', xai: 'grok-9-undeclared', openai: 'gpt-6-sol'};
  let k = 0;
  const turn = async ({vendor}) => ({text: APPROVE, response_id: `r_${vendor}_${++k}`, served_model: served[vendor]});
  const r = await reviewCycle({ledger: rec, turn, change: {scope: 's', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], author_labs: ['anthropic']},
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'openai', model: 'gpt-6-sol'}, {vendor: 'agy_google', model: 'gemini-4-carbon-high'}]});
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assess(rec, r.cycle);
  const closed = rec.closeCycle(r.cycle);
  assert.equal(closed.outcome, 'verified');
  assert.deepEqual(closed.labs, ['google', 'openai', 'xai']);
  assert.equal(sys.ledger.verify().ok, true);
}));

// L-2 (Q5, layer). The three-lab floor of a NEW v2 cycle is enforced by the recorder (cycle-kinds.mjs:443-450), not by
// the kind: requirementRefusal returns null when required_reviewers is absent (cycle-kinds.mjs:122). Any writer with the
// controller key (the exported `historical: true` recorder here) opens a fresh one-reviewer v2 cycle that closes verified.
test('L-2 (Q5): the ledger kind accepts a freshly written one-reviewer v2 cycle that closes verified on one lab', () => withLedger(async (sys, rec) => {
  const opener = cycleRecorder({ledger: sys.ledger, controller: sys.controller, order: sys.controller, historical: true});
  const prompt = 'review';
  const cycle = opener.openCycle({scope: 'one', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], prompt, reviewers: 1, author_labs: ['anthropic']});
  const seat = {seat_id: 'xai-cycle-review@grok-4.7', vendor: 'xai', mode: 'cycle-review', occupancy_gen: 1};
  const t = rec.recordTurn({seat, requested_model: 'grok-4.7', served_model: 'grok-4.7', response_id: 'one_1', reply: APPROVE, purpose: 'cycle-review', prompt, cites: [cycle]});
  rec.recordReview({seat, model: 'grok-4.7', served_model: 'grok-4.7', response_id: 'one_1', verdict: 'approve', targets: [cycle], turn: t});
  assess(rec, cycle);
  const closed = rec.closeCycle(cycle);
  assert.deepEqual([closed.outcome, closed.labs], ['verified', ['xai']]);
  assert.equal(sys.ledger.verify().ok, true);
}));

// L-3 (Q9). The ledger turn kind does not check served_model_source (lineage-kinds.mjs:186 records any string;
// the turn validate at :88-89 ignores it), and admission never reads it (identity.mjs:159-171). A turn marked "input" whose
// served_model differs from requested_model (incoherent: "input" means the served name IS the input) is accepted.
test('L-3 (Q9): an incoherent served_model_source is accepted by the ledger', () => withLedger(async (sys, rec) => {
  const seat = {seat_id: 'agy_google-x@gemini-4-carbon-high', vendor: 'agy_google', mode: 'x', occupancy_gen: 1};
  rec.recordTurn({seat, requested_model: 'gemini-4-carbon-high', served_model: 'gemini-4-argon-high', served_model_source: 'input', response_id: null, reply: 'x', purpose: 'x'});
  rec.recordTurn({seat: {...seat, seat_id: 'y'}, requested_model: 'gemini-4-carbon-high', served_model: 'gemini-4-carbon-high', served_model_source: 'made-up', response_id: null, reply: 'y', purpose: 'x'});
  assert.equal(sys.ledger.verify().ok, true);
}));
