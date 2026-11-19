// SELF-AUDIT repro (assignment 1, Q2; doc overclaim). PASSING = DEFECT PRESENT.
// work-ledger.mjs's header says a work.stage handoff is verified on append so that "the identity (item, ticket,
// requirement) matches the previous stage's". The re-derivation (and handoffRefusal) compares item and requirement
// only: an implement record naming ANOTHER ticket than the plan it received from is accepted and verifies.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger, outputsDigest, handoffRefusal} from '../ophanim/operate/work-ledger.mjs';

test('DEFECT: a handoff whose ticket identity differs from its upstream is accepted by the ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-ticket-id-'));
  try {
    const w = openWorkLedger({root: path.join(root, 'work')});
    const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1};
    const req = 'sha256:' + 'a'.repeat(64);
    const identity = {item: 'x', requirement: req, ticket: {path: 'tickets/x.json', digest: 'sha256:' + 'b'.repeat(64)}};
    const c1 = w.claim({item: 'x', stage: 'plan', attempt: 1, inputs: {}, holder: 'h', budget});
    const plan = w.recordStage({claim: c1, stage: 'plan', attempt: 1, status: 'passed', identity, inputs: {}, outputs: {p: 1}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null});
    w.release({claim: c1, item: 'x', stage: 'plan', outcome: 'completed', why: 'ok'});
    const c2 = w.claim({item: 'x', stage: 'implement', attempt: 1, inputs: {upstream: outputsDigest({p: 1})}, holder: 'h', budget});
    const other = {...identity, ticket: {path: 'tickets/x.json', digest: 'sha256:' + 'c'.repeat(64)}};
    const impl = w.recordStage({claim: c2, from: plan, stage: 'implement', attempt: 1, status: 'passed', identity: other,
      inputs: {upstream: outputsDigest({p: 1})}, outputs: {i: 1}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null});
    assert.ok(impl, 'DEFECT: accepted');
    assert.equal(w.verify().ok, true, 'DEFECT: and it verifies');
    assert.equal(handoffRefusal(w, {item: 'x', stage: 'review', from: impl, requirement: req}), null, 'DEFECT: and a review may start from it');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
