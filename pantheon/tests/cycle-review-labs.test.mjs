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

test('cycles without the field keep their meaning: a v2 or v1 cycle of one reviewer still opens and closes as before', () => withLedger(async (sys, rec) => {
  const v2 = await reviewCycle({ledger: rec, change: change('v2-scope'), turn: approve, n: 1});
  assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === v2.cycle)).required_reviewers, undefined);
  assess(rec, v2.cycle);
  assert.equal(rec.closeCycle(v2.cycle).outcome, 'verified');
  const v1 = await reviewCycle({ledger: rec, change: change('v1-scope'), turn: approve, n: 1, contract: CYCLE_CONTRACT_V1});
  assert.equal(rec.closeCycle(v1.cycle).outcome, 'verified');
  assert.equal(sys.ledger.verify().ok, true);
}));
