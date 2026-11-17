// Status proposals and their signed apply (docs/operating-workflow.md): an unsigned proposal names the
// status it was made against and its evidence; apply, with the key holder's keys, records it only while it
// is current, and the recorded status carries the evidence. The cited ledgers are checked in the
// operating-cycle rehearsal (ophanim/tests/board-operating-cycle.test.mjs), which has real ones.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger, propose, proposalRefusal, proposalDigest, applyProposal, evidenceRefusal, renderBoard, EVIDENCE_SCHEMA, EVIDENCE_SCHEMA_V1} from '../status.mjs';

const h = c => 'sha256:' + c.repeat(64);
const commit = 'a'.repeat(40);
const evidence = (over = {}) => ({
  run: {ledger_anchor: h('1'), ledger_head: h('2'), run_json_digest: h('3'), shipped: true, gate_entry: h('4')},
  review: {cycle_ledger_anchor: h('1'), cycle: h('5'), close_entry: h('6'), outcome: 'verified',
    reviewers: [{vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.7', lab: 'xai'}, {vendor: 'openai', model: 'gpt-6-sol', served_model: null, lab: 'openai'},
      {vendor: 'agy_google', model: 'gemini-3.5-pro', served_model: null, lab: 'google'}]},
  commit, tests: {cmd: 'npm test', exit: 0}, ticket: {path: 'tickets/k1.json', digest: h('7'), slice: 'all of it'}, ...over,
});
const to = (state = 'Resolved') => ({state, basis: 'shipped and reviewed', checked: '2026-11-18'});

function withLedger(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-proposal-'));
  try {
    const root = path.join(d, 'ledger');
    openStatusLedger({root});
    // The keys live elsewhere, as the owner's do.
    const keys = path.join(d, 'owner-keys');
    fs.renameSync(path.join(root, 'keys'), keys);
    const S = openStatusLedger({root, keys});
    S.set({item: 'k1', title: 'Chain core', state: 'Ready', basis: 'converged', checked: '2026-11-17', owner_role: 'impl@build'});
    return fn({root, keys, S});
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
}

test('a proposal is made against the latest status without any key, and is well formed or refused', () => withLedger(({root}) => {
  const board = openStatusLedger({root, create: false}).board();
  const p = propose(board, {item: 'k1', to: to(), evidence: evidence()});
  assert.equal(p.from.entry, board.items[0].entry);
  assert.equal(p.from.state, 'Ready');
  assert.equal(proposalRefusal(p), null);
  assert.equal(proposalDigest({...p, locations: {run_ledger: '/x'}}), proposalDigest(p), 'locations are not part of the digest');
  assert.throws(() => propose(board, {item: 'nope', to: to(), evidence: evidence()}), /not on the status board/);
  // To Resolved: a review-cycle close, shipped work, passing tests and a commit are required.
  const refuse = (ev, re, extra = {}) => assert.match(proposalRefusal({...p, evidence: ev, ...extra}) ?? '', re);
  refuse(evidence({review: undefined}), /cites a review-cycle close/);
  refuse(evidence({review: {...evidence().review, close_entry: null, outcome: null}}), /cites a review-cycle close/);
  refuse(evidence({tests: {cmd: 'npm test', exit: 1}}), /tests that passed/);
  refuse(evidence({commit: null}), /names the commit/);
  refuse(evidence({run: {...evidence().run, shipped: false}}), /run that shipped/);
  refuse(evidence({review: {...evidence().review, outcome: 'unverified'}}), /accept_unverified_reason/);
  assert.equal(proposalRefusal({...p, evidence: evidence({review: {...evidence().review, outcome: 'unverified'}}), accept_unverified_reason: 'owner accepts the deferred note'}), null);
  refuse(evidence({review: {...evidence().review, reviewers: [evidence().review.reviewers[0], evidence().review.reviewers[0]]}}), /share a lab/);
  // Three independent labs (86ce18a review, defect 2): a smaller panel is never completion evidence.
  refuse(evidence({review: {...evidence().review, reviewers: evidence().review.reviewers.slice(0, 2)}}), /at least 3 reviewers on 3 distinct labs \(this one has 2\)/);
  refuse(evidence({review: {...evidence().review, reviewers: evidence().review.reviewers.slice(0, 1)}}), /at least 3 reviewers/);
  assert.equal(proposalRefusal({...p, to: to('Ready'), evidence: evidence({review: {...evidence().review, reviewers: evidence().review.reviewers.slice(0, 1)}})}), null,
    'a slice that leaves the item Ready is not completion evidence');
  refuse(evidence({ticket: {path: '/abs/t.json', digest: h('7'), slice: 's'}}), /repository-relative/);
  // Bound to the item (86ce18a review, defect 1): every proposal names this item's own ticket.
  refuse(evidence({ticket: undefined}), /carries evidence.ticket: the ticket of "k1" \(tickets\/k1.json\)/);
  refuse(evidence({ticket: {path: 'tickets/k2.json', digest: h('7'), slice: 's'}}), /not the ticket of "k1"/);
  assert.match(proposalRefusal({...p, to: to('Ready'), evidence: evidence({ticket: undefined})}), /evidence.ticket/, 'any evidence-bearing proposal');
  assert.match(proposalRefusal({...p, to: {...to(), state: 'Done'}}), /to.state/);
  assert.match(proposalRefusal({...p, locations: {run_ledger: 'relative/dir'}}), /absolute/);
  // To a state other than Resolved, an open cycle is fine (a slice that leaves the item Ready).
  assert.equal(proposalRefusal({...p, to: to('Ready'), evidence: evidence({review: {...evidence().review, close_entry: null, outcome: null}})}), null);
}));

// 86ce18a review, defect 1: this test used to apply a change to RESOLVED with no cited ledger on the machine
// (checked: not-available). Completion evidence must now be verifiable at apply, so that is refused (asserted
// below), and the recording mechanics are shown on a change to Ready, which may still be not-available.
test('apply records the status with evidence using keys it only reads; a stale proposal is refused', () => withLedger(({root, keys}) => {
  const resolved = propose(openStatusLedger({root, create: false}).board(), {item: 'k1', to: to(), evidence: evidence()});
  assert.throws(() => applyProposal({root, proposal: resolved, keys}),
    /a change to Resolved is applied only when its completion evidence is verifiable at apply: the run ledger, the review-cycle ledger, run.json, the ticket not available here/);
  const p = propose(openStatusLedger({root, create: false}).board(), {item: 'k1', to: to('Ready'), evidence: evidence()});
  const before = fs.readdirSync(keys).map(f => [f, fs.readFileSync(path.join(keys, f), 'utf8')]);
  assert.throws(() => applyProposal({root, proposal: p}), /can be verified, not changed/, 'no keys under the ledger');
  assert.equal(fs.existsSync(path.join(root, 'keys')), false, 'a missing key directory is not created');
  const r = applyProposal({root, proposal: p, keys});
  assert.deepEqual(fs.readdirSync(keys).map(f => [f, fs.readFileSync(path.join(keys, f), 'utf8')]), before, 'keys only read');
  const item = r.board.items.find(i => i.item === 'k1');
  assert.equal(item.entry, r.entry);
  assert.equal(item.state, 'Ready');
  assert.equal(item.owner_role, 'impl@build', 'carried from the previous status');
  assert.equal(item.evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(item.evidence.proposal, proposalDigest(p));
  assert.equal(item.evidence.checked, 'not-available', 'no cited ledger was on this machine');
  assert.match(renderBoard(r.board), /evidence: commit aaaaaaaaaaaa; tests exit 0; review cycle 555555555555 verified \(xai, openai, google\)/);
  assert.throws(() => applyProposal({root, proposal: p, keys}), /stale proposal/);
  // Reopened from disk, the evidence re-validates.
  assert.equal(openStatusLedger({root, create: false}).board().items[0].evidence.commit, commit);
}));

test('apply refuses a cited ledger it is told about but cannot find', () => withLedger(({root, keys}) => {
  const p = propose(openStatusLedger({root, create: false}).board(), {item: 'k1', to: to(), evidence: evidence(),
    locations: {run_ledger: path.join(root, 'missing-run-ledger')}});
  assert.throws(() => applyProposal({root, proposal: p, keys}), /run ledger named in the proposal is not at/);
}));

test('the evidence field is optional, validated when present, and statuses without it are unchanged', () => withLedger(({root, keys, S}) => {
  assert.equal(evidenceRefusal({schema: EVIDENCE_SCHEMA, proposal: h('9'), checked: 'structural', ...evidence()}, 'Resolved'), null);
  assert.match(evidenceRefusal({schema: 'x'}, 'Ready'), /ophanim.status-evidence\/v1/);
  assert.match(evidenceRefusal({schema: EVIDENCE_SCHEMA, proposal: h('9'), checked: 'maybe', ...evidence()}, 'Ready'), /evidence.checked/);
  // Versioned (86ce18a review, defect 1): a v1 entry, as recorded before, keeps v1's rules (a Resolved status checked
  // nowhere, with no ticket, still verifies); v2, which apply writes from now on, names its ticket and was checked.
  const {ticket: _t, ...noTicket} = evidence();
  assert.equal(evidenceRefusal({schema: EVIDENCE_SCHEMA_V1, proposal: h('9'), checked: 'not-available', ...noTicket}, 'Resolved'), null);
  assert.match(evidenceRefusal({schema: EVIDENCE_SCHEMA, proposal: h('9'), checked: 'not-available', ...evidence()}, 'Resolved'), /checked structurally/);
  assert.match(evidenceRefusal({schema: EVIDENCE_SCHEMA, proposal: h('9'), checked: 'structural', ...noTicket}, 'Ready'), /names the item's ticket/);
  assert.throws(() => S.set({item: 'k2', title: 'X', state: 'Resolved', basis: 'b', checked: '2026-11-18',
    evidence: (({review, ...rest}) => ({schema: EVIDENCE_SCHEMA, proposal: h('9'), checked: 'structural', ...rest}))(evidence())}), /review-cycle close/);
  S.set({item: 'k2', title: 'X', state: 'Resolved', basis: 'b', checked: '2026-11-18'});
  const k2 = openStatusLedger({root, keys, create: false}).board().items.find(i => i.item === 'k2');
  assert.equal(k2.evidence, undefined);
  assert.doesNotMatch(renderBoard(openStatusLedger({root, create: false}).board()), /\| b \(evidence/);
}));

test('a reader never creates a status ledger it was pointed at by mistake', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-proposal-'));
  try {
    assert.throws(() => openStatusLedger({root: path.join(d, 'nothing'), create: false}), /no status ledger at/);
    assert.equal(fs.existsSync(path.join(d, 'nothing')), false);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});
