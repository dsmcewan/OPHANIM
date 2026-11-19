// A coordinated cycle review requires three independent labs, recorded on the cycle (86ce18a review, defect 2):
// the requirement cannot be lowered by a caller, a cycle that records it cannot name or close on fewer labs, and
// cycles that do not record it (v1, and v2 opened before it existed) re-derive exactly as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openPantheonLedger} from '../src/ledger/system.mjs';
import {reviewCycle} from '../src/ledger/review-cycle.mjs';
import {REQUIRED_REVIEW_LABS, CYCLE_CONTRACT_V1} from '../src/ledger/cycle-kinds.mjs';

const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
const change = (scope = 'ophanim') => ({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x'], author_labs: ['anthropic']});
let n = 0;
const approve = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `labs_${vendor}_${++n}`, served_model: model});
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-review-labs-'));
  try { const sys = openPantheonLedger({root: path.join(dir, 'ledger')}); return await fn(sys, sys.recorder()); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a cycle that records the requirement is refused with fewer reviewers, and the requirement cannot be lowered', () => withLedger(async (sys, rec) => {
  assert.equal(REQUIRED_REVIEW_LABS, 3);
  await assert.rejects(reviewCycle({ledger: rec, change: change(), turn: approve, n: 1, required_reviewers: 3}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED');
  await assert.rejects(reviewCycle({ledger: rec, change: change(), turn: approve, n: 1, required_reviewers: 1}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED',
    'a requirement below three is not a requirement');
  // The ledger itself refuses such a cycle, whoever opens it.
  const open = extra => rec.openCycle({scope: 'direct', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], prompt: 'p', author_labs: ['anthropic'], ...extra});
  assert.throws(() => open({reviewers: 1, required_reviewers: 3}), /requires 3 independent reviewers and names 1/);
  assert.throws(() => open({reviewers: 1, required_reviewers: 1}), /at least 3; a caller cannot lower it/);
  assert.equal(sys.ledger.read().filter(e => e.kind === 'cycle').length, 0, 'nothing was opened');
  // Three labs: recorded, closes verified.
  const r = await reviewCycle({ledger: rec, change: change(), turn: approve, required_reviewers: 3});
  assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle)).required_reviewers, 3);
  assess(rec, r.cycle);
  assert.equal(rec.closeCycle(r.cycle).outcome, 'verified');
  assert.equal(sys.ledger.verify().ok, true);
}));

// A recorded cycle of one reviewer (as v1 and v2 cycles were opened before the requirement existed), written the way
// such a ledger holds it: the cycle, the reviewer's turn and its review.
function oneReviewerCycle(rec, scope, contract) {
  const prompt = 'review the change';
  const cycle = rec.openCycle({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x'], prompt, reviewers: 1, author_labs: ['anthropic'], ...(contract ? {contract} : {})});
  const seat = {seat_id: 'xai-cycle-review@grok-4.7', vendor: 'xai', mode: 'cycle-review', occupancy_gen: 1};
  const reply = '```json\n{"verdict": "approve", "findings": []}\n```';
  const turn = rec.recordTurn({seat, requested_model: 'grok-4.7', served_model: 'grok-4.7', response_id: `hist_${scope}`, reply, purpose: 'cycle-review', prompt, cites: [cycle]});
  rec.recordReview({seat, model: 'grok-4.7', served_model: 'grok-4.7', response_id: `hist_${scope}`, verdict: 'approve', targets: [cycle], turn});
  return cycle;
}

test('cycles without the field keep their meaning: a recorded v2 or v1 cycle of one reviewer still re-derives and closes as before', () => withLedger(async (sys, rec) => {
  const v2 = oneReviewerCycle(rec, 'v2-scope');
  assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === v2)).required_reviewers, undefined);
  assess(rec, v2);
  assert.equal(rec.closeCycle(v2).outcome, 'verified');
  const v1 = oneReviewerCycle(rec, 'v1-scope', CYCLE_CONTRACT_V1);
  assert.equal(rec.closeCycle(v1).outcome, 'verified');
  assert.equal(sys.ledger.verify().ok, true);
}));

// Independent review, assignment 2 (OpenAI gpt-6-astra, 09d490f), question 5: `reviewCycle` with n: 1 opened a NEW
// default-contract (v2) cycle reviewed by one lab, and it closed verified. A newly opened cycle of any contract needs
// three distinct labs; the default contract records the requirement so the ledger refuses a close on fewer.
test('a newly opened cycle needs three labs, on every contract: n: 1 is refused before anything is opened', () => withLedger(async (sys, rec) => {
  await assert.rejects(reviewCycle({ledger: rec, change: change('new-one-lab'), turn: approve, n: 1}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED');
  await assert.rejects(reviewCycle({ledger: rec, change: change('new-one-lab-v1'), turn: approve, n: 1, contract: CYCLE_CONTRACT_V1}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED');
  await assert.rejects(reviewCycle({ledger: rec, change: change('new-one-seat'), turn: approve, seats: [{vendor: 'xai', model: 'grok-4.7'}]}), e => e.code === 'REVIEW_LABS_BELOW_REQUIRED');
  assert.equal(sys.ledger.read().filter(e => e.kind === 'cycle').length, 0, 'nothing was opened');
  // The default contract now records the requirement, so the ledger itself holds the close to three labs.
  const r = await reviewCycle({ledger: rec, change: change('new-three'), turn: approve});
  assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle)).required_reviewers, REQUIRED_REVIEW_LABS);
  assess(rec, r.cycle);
  assert.equal(rec.closeCycle(r.cycle).labs.length, 3);
  assert.equal(sys.ledger.verify().ok, true);
}));
