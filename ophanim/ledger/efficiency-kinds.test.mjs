// K5: OPHANIM's efficiency records as ledger kinds. Promotions, uses, results and debits re-derive from
// what they cite, the 20-use cap is counted on the chain, and the assessment records on the ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner} from './chain.mjs';
import {efficiencyKinds, efficiencyRecorder, efficiencyTotals, MAX_USES, PROMOTION, USE, RESULT, DEBIT} from './efficiency-kinds.mjs';
import {digest, readRuntimeSnapshot} from '../board.mjs';
import {runRuntime, loadRuntime} from '../runtime.mjs';
import {assessConvergence} from '../efficiency/assessment.mjs';

const operator = generateSigner('operator'), controller = generateSigner('controller'), governor = generateSigner('governance');
const authority = {keyring: Object.fromEntries([operator, controller, governor].map(s => [s.key_id, s.publicJwk])), orderer: 'controller', operators: ['operator']};
const by = s => ({author: {key_id: s.key_id}, signer: s, order: controller});
const authors = {promotion: a => a.key_id === 'governance' || a.key_id === 'controller', events: a => a.key_id === 'controller'};
const sha = n => String(n).repeat(64);
const decisionId = 'sha256:' + sha('d');
const efficiency = {baselineConservativeMs: 5000, candidateConservativeMs: 3000, conservativeSavedMs: 2000, totalAssessmentCostMs: 400};
const promotionPayload = (over = {}) => ({schema: PROMOTION, scopeSha: sha('a'), decisionId, fromSlots: 1, toSlots: 3, maxUses: MAX_USES, efficiency, ...over});
const usePayload = stateDir => ({schema: USE, useId: digest(stateDir), stateDir, scopeSha: sha('a'), decisionId});

async function withLedger(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-efficiency-kinds-')));
  try {
    const anchor = createLedger({dir: path.join(dir, 'ledger'), authority, operator, order: controller});
    const L = openLedger({dir: path.join(dir, 'ledger'), kinds: defineKinds(efficiencyKinds({authors})), anchor});
    return await fn(L, dir);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a promotion re-derives its own figures, and only the promotion authority records one', () => withLedger(L => {
  L.append({kind: 'efficiency.promotion', payload: promotionPayload(), ...by(governor)});
  for (const [bad, why] of [
    [{efficiency: {...efficiency, conservativeSavedMs: 9000}}, /not baseline - candidate/],
    [{efficiency: {...efficiency, totalAssessmentCostMs: -1}}, /non-negative integers/],
    [{maxUses: 200}, /bounded to 20/],
    [{toSlots: 8}, /1 -> 3 slots only/],
  ]) assert.throws(() => L.append({kind: 'efficiency.promotion', payload: promotionPayload(bad), ...by(governor)}), why);
  assert.throws(() => L.append({kind: 'efficiency.promotion', payload: promotionPayload(), ...by(operator)}), /may not author/);
}));

test('a use cites its promotion, and the 20-use cap is counted from the chain itself', () => withLedger(L => {
  const p = L.append({kind: 'efficiency.promotion', payload: promotionPayload(), ...by(governor)}).hash;
  assert.throws(() => L.append({kind: 'efficiency.use', payload: usePayload('/s/0'), ...by(controller)}), /cites exactly one efficiency.promotion/);
  assert.throws(() => L.append({kind: 'efficiency.use', payload: {...usePayload('/s/0'), useId: sha(0)}, derivedFrom: [p], ...by(controller)}), /useId is the digest/);
  assert.throws(() => L.append({kind: 'efficiency.use', payload: {...usePayload('/s/0'), scopeSha: sha('b')}, derivedFrom: [p], ...by(controller)}), /different scope or decision/);
  for (let i = 0; i < MAX_USES; i++) L.append({kind: 'efficiency.use', payload: usePayload(`/s/${i}`), derivedFrom: [p], ...by(controller)});
  assert.throws(() => L.append({kind: 'efficiency.use', payload: usePayload('/s/0'), derivedFrom: [p], ...by(controller)}), /already has a use/);
  assert.throws(() => L.append({kind: 'efficiency.use', payload: usePayload('/s/extra'), derivedFrom: [p], ...by(controller)}), /20 uses are spent/);
  // A second promotion has its own budget.
  const q = L.append({kind: 'efficiency.promotion', payload: promotionPayload({decisionId: 'sha256:' + sha('e')}), ...by(governor)}).hash;
  L.append({kind: 'efficiency.use', payload: {...usePayload('/s/extra'), decisionId: 'sha256:' + sha('e')}, derivedFrom: [q], ...by(controller)});
  const r = efficiencyRecorder({ledger: L, controller, order: controller});
  assert.equal(r.use({scopeSha: sha('a'), decisionId, stateDir: '/s/extra', efficiency}), null, 'the recorder reports a spent promotion');
  assert.deepEqual(r.use({scopeSha: sha('a'), decisionId, stateDir: '/s/3', efficiency}).promotion, p, 'an existing use is returned, not re-counted');
  assert.equal(L.verify().ok, true);
}));

test('a result re-derives its saving from the cited promotion; a debit is non-negative and never double-charged', () => withLedger(L => {
  const p = L.append({kind: 'efficiency.promotion', payload: promotionPayload(), ...by(governor)}).hash;
  const u = L.append({kind: 'efficiency.use', payload: usePayload('/s/1'), derivedFrom: [p], ...by(controller)}).hash;
  const result = {schema: RESULT, traceSha: sha(1), executionMs: 3200, assessmentCostMs: 300, observedSavingMs: 5000 - 3200 - 300};
  assert.throws(() => L.append({kind: 'efficiency.result', payload: {...result, observedSavingMs: 4999}, derivedFrom: [u], ...by(controller)}), /baseline gives 1500/);
  assert.throws(() => L.append({kind: 'efficiency.result', payload: result, derivedFrom: [p], ...by(controller)}), /cites exactly one efficiency.use/);
  assert.throws(() => L.append({kind: 'efficiency.result', payload: {...result, executionMs: -1, observedSavingMs: 4701}, derivedFrom: [u], ...by(controller)}), /non-negative integer times/);
  L.append({kind: 'efficiency.result', payload: result, derivedFrom: [u], ...by(controller)});
  assert.throws(() => L.append({kind: 'efficiency.result', payload: result, derivedFrom: [u], ...by(controller)}), /already realized/);

  const debit = (traceSha, assessmentCostMs, charged, interrupted = null) => ({schema: DEBIT, traceSha, assessmentCostMs, charged, interrupted});
  assert.throws(() => L.append({kind: 'efficiency.debit', payload: debit(sha(2), -50000, true), derivedFrom: [u], ...by(controller)}), /non-negative integer cost/);
  assert.throws(() => L.append({kind: 'efficiency.debit', payload: debit(sha(1), 300, true), derivedFrom: [u], ...by(controller)}), /not charged twice/);
  assert.throws(() => L.append({kind: 'efficiency.debit', payload: debit(sha(2), 70, false), derivedFrom: [u], ...by(controller)}), /is charged/);
  L.append({kind: 'efficiency.debit', payload: debit(sha(1), 300, false), derivedFrom: [u], ...by(controller)});
  L.append({kind: 'efficiency.debit', payload: debit(sha(2), 70, true, sha(9)), derivedFrom: [u], ...by(controller)});
  assert.throws(() => L.append({kind: 'efficiency.debit', payload: debit(sha(2), 0, true), derivedFrom: [u], ...by(controller)}), /already debited/);
  assert.throws(() => L.append({kind: 'efficiency.debit', payload: debit(sha(3), 5, true), derivedFrom: [u], ...by(operator)}), /may not author/);

  const totals = efficiencyTotals(L, p);
  assert.deepEqual({...totals, head: undefined}, {qualifiedConvergences: 1, uses: 1, originalOptimizationCostMs: 400,
    additionalAssessmentCostMs: 70, unmeasuredAssessments: 1, measuredNetMs: 1500 - 400 - 70, head: undefined});
}));

test('totals are read only from a ledger that verifies: an edited debit stops them', () => withLedger((L, dir) => {
  const r = efficiencyRecorder({ledger: L, controller, order: controller});
  const {promotion, use} = r.use({scopeSha: sha('a'), decisionId, stateDir: '/s/1', efficiency});
  const h = r.debit({use, traceSha: sha(2), assessmentCostMs: 70});
  assert.equal(r.debit({use, traceSha: sha(2), assessmentCostMs: 999}), h, 'a re-assessment of the same trace is not charged again');
  assert.equal(r.totals(promotion).additionalAssessmentCostMs, 70);
  // Make the debit negative on disk: the payload object no longer matches its hash, and nothing is totalled.
  const file = objectFile(dir, L.read().find(x => L.hashOf(x) === h).payload_ref);
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), assessmentCostMs: -100000}));
  assert.throws(() => r.totals(promotion), /does not verify: .*payload object missing or altered/);
}));

const objectFile = (dir, ref) => path.join(dir, 'ledger', 'objects', ref.slice('sha256:'.length) + '.json');

const worker = {id: 'w', version: '1', kinds: ['k'], scopes: ['s'], run: async ({obligation}) => ({output: {id: obligation.id}})};
const spec = id => ({id, kind: 'k', scope: 's', outputKey: id, dependsOn: [], inputs: {}, expected: null, maxAttempts: 1});
const governance = {verifyCandidate: async () => ({ok: true, planRef: null, evidenceRefs: []}), authorizePlan: async () => ({ok: true})};

test('the assessment records its result and debit on the ledger and measures from the ledger, not the side files', () => withLedger(async (L, dir) => {
  const stateDir = path.join(dir, 'state'), root = path.join(dir, 'efficiency');
  fs.mkdirSync(stateDir);
  const startedAt = Date.now();
  await runRuntime({stateDir, obligations: [spec('a'), spec('b')], workers: [worker], governance, slots: 3});
  const scopeSha = sha('a'), usesDir = path.join(root, 'scopes', scopeSha, 'uses');
  fs.mkdirSync(usesDir, {recursive: true});
  const r = efficiencyRecorder({ledger: L, controller, order: controller});
  const granted = r.use({scopeSha, decisionId, stateDir, efficiency});
  const useFile = path.join(usesDir, `${digest(stateDir)}.json`);
  fs.writeFileSync(useFile, JSON.stringify({schema: 'ophanim.efficiency/v1', stateDir, decisionId, scopeSha}));
  // A forged side file: on the file path it is merely not counted; on the ledger path it is never read.
  fs.writeFileSync(path.join(usesDir, 'invented.result.json'), JSON.stringify({traceSha: sha('f'), executionMs: 1, assessmentCostMs: 0, observedSavingMs: 4999}));
  fs.mkdirSync(path.join(usesDir, 'assessment-costs'));
  const promotion = {expected: {scopeSha, fromSlots: 1, toSlots: 3}, efficiency};
  const args = {root, stateDir, scope: {graph: [], configuration: {slots: 3, workerRegistry: [{id: 'w', version: '1', kinds: ['k'], scopes: ['s']}]}, policy: {}},
    state: loadRuntime(stateDir), boardCommit: readRuntimeSnapshot(stateDir).commit,
    output: {convergence: 'accepted_change', slots: 3, dispatches: 2, durationMs: 1200, startedAt, endedAt: Date.now(), outputs: {}, effects: [], measurements: {}, limits: {modelCalls: 0}},
    request: {}, replayRequest: null, priorRuntime: null, attempts: [], verifications: [], events: [], governance: {identity: 'stub'},
    use: {slots: 3, use: useFile, promotion, ledger: granted}, interrupted: {traceSha: sha(7)}, ledger: r};
  const record = await assessConvergence(args);
  const value = JSON.parse(fs.readFileSync(record.reportFile, 'utf8')).measuredValue;
  const own = JSON.parse(fs.readFileSync(useFile.replace(/\.json$/, '.result.json'), 'utf8'));
  assert.equal(value.qualifiedConvergences, 1);
  assert.equal(value.measuredNetMs, own.observedSavingMs - 400, 'the realized result carries its assessment cost; the debit is not charged');
  assert.equal(value.unmeasuredAssessments, 1);
  assert.equal(value.measuredNetIsUpperBound, true);
  const kinds = L.read().map(e => e.kind);
  assert.deepEqual(kinds.slice(1), ['efficiency.promotion', 'efficiency.use', 'efficiency.result', 'efficiency.debit']);
  const debit = L.payloadOf(L.read().at(-1));
  assert.equal(debit.charged, false);
  assert.equal(debit.traceSha, record.traceSha);
  assert.equal(value.ledger.result, L.hashOf(L.read().at(-2)));
  assert.equal(L.verify().ok, true);

  // A ledger that no longer verifies stops the next assessment before it relies on anything.
  const file = objectFile(dir, L.read().at(-1).payload_ref);
  fs.writeFileSync(file, JSON.stringify({...debit, charged: true}));
  await assert.rejects(assessConvergence(args), /Efficiency ledger does not verify, refusing to rely on it/);
}));
