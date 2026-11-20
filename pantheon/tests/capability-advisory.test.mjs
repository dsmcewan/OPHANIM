// The advisory record beside each live selection (knowledge graphs, Slice C1, KC4; owner decision 2026-11-20, "Keep the
// seats as we have them for now until we better understand the metrics"): the selection matrix is BYTE-IDENTICAL with and
// without the capability graph, and with a changed graph; each selection records the decision and the snapshot digest; the
// capability snapshot is a ledger input beside facts and seating.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectSeat, selectionPolicy, readPools} from '../src/route/frontier.mjs';
import {capabilitySnapshot, snapshotPayload, snapshotDigestOf} from '../src/capability/graph.mjs';
import {decide} from '../src/capability/eligibility.mjs';
import {defaultSnapshot, ADVISORY_SCHEMA} from '../src/capability/advisory.mjs';
import {pantheonKinds, currentCapability} from '../src/ledger/kinds.mjs';
import {openLedger, createLedger, defineKinds, generateSigner} from '../../packages/ledger/chain.mjs';
import {registries, retireLane, changeLimitation} from './fixtures/capability-helpers.mjs';

const REG = registries();
const strip = choice => JSON.parse(JSON.stringify(choice, (k, v) => (k === 'advisory' ? undefined : v)));
const outcome = f => { try { return {ok: true, value: f()}; } catch (e) { return {ok: false, error: e.message}; } };

// The selection test matrix: every role a table names, every profile and difficulty, and the explicit inputs the existing
// selection tests exercise (context estimates, avoided vendors and labs, ticket pins, operator and per-slot overrides, a
// recorded escalation, a pin the operator override also names).
const ROLES = ['planner', 'implementer', 'reviewer', 'scout', 'explorer', 'judge', 'advocate', 'dispatcher', 'subagent', 'synthesis', 'fast_loop'];
const VARIANTS = [{}, {needsContext: 2000}, {needsContext: 900000}, {avoid: ['openai'], avoidLabs: ['openai']}, {avoidLabs: ['google', 'xai']},
  {pin: 'gemini-4-carbon-low'}, {pin: 'gpt-6-sol'}, {roleOverride: {vendor: 'xai', model: 'grok-4.6', why: 'test'}},
  {slotOverride: {vendor: 'openai', model: 'gpt-6-luna', why: 'test'}}, {pin: 'gpt-6-sol', roleOverride: {vendor: 'openai', model: 'gpt-6-sol', why: 'test'}},
  {explicit: {source: 'escalation', reason: 'a recorded decision', seat: {vendor: 'agy_google', model: 'gemini-4-hydrogen-high'}}}];
const CASES = ROLES.flatMap(role => ['argo', 'legacy', 'fit'].flatMap(profile => ['easy', 'medium', 'hard'].flatMap(difficulty =>
  VARIANTS.map(v => ({role, opts: {profile, difficulty, pools: readPools({rows: []}), ...v}})))));

test('advisory: the selection matrix is byte-identical with and without the capability graph, and with a changed graph', t => {
  const changed = capabilitySnapshot(changeLimitation(retireLane(REG, 'gemini-4-hydrogen-high'), 'L-004', {blocks: true}));
  let selected = 0, refused = 0, advisedIneligible = 0;
  for (const {role, opts} of CASES) {
    const live = outcome(() => selectSeat(role, {...opts, advisory: false}));
    const withGraph = outcome(() => selectSeat(role, opts));
    const withChanged = outcome(() => selectSeat(role, {...opts, capability: changed}));
    const key = `${role} ${JSON.stringify(opts)}`;
    assert.equal(withGraph.ok, live.ok, key);
    assert.equal(withChanged.ok, live.ok, key);
    if (!live.ok) { assert.deepEqual([withGraph.error, withChanged.error], [live.error, live.error], key); refused++; continue; }
    selected++;
    assert.equal(JSON.stringify(strip(withGraph.value)), JSON.stringify(live.value), `${key}: identical without the advisory record`);
    assert.equal(JSON.stringify(strip(withChanged.value)), JSON.stringify(live.value), `${key}: identical under a changed graph`);
    assert.equal(withGraph.value.seat, withGraph.value.candidates[0], 'the seat is still the first candidate');
    assert.equal(withGraph.value.selection.policy_hash, selectionPolicy(opts.profile, {pools: opts.pools}).hash, 'the policy hash is the live policy\'s: the graph is not hashed into it');
    for (const c of withGraph.value.candidates) assert.equal(c.selection.advisory.schema, ADVISORY_SCHEMA, `${key}: every candidate carries its advisory record`);
    advisedIneligible += withChanged.value.candidates.filter(c => c.selection.advisory.eligible === false).length;
  }
  assert.ok(selected > 600 && refused > 0, `${selected} selections and ${refused} refusals compared`);
  assert.ok(advisedIneligible > 100, 'the changed graph judges many live candidates ineligible, and moves none of them');
  t.diagnostic(`${CASES.length} cases: ${selected} selections byte-identical with, without and under a changed graph; ${refused} refused identically; ${advisedIneligible} candidates advised ineligible and kept`);
});

test('every live selection records the advisory decision beside it: the snapshot digest, the decision digest and a verdict per candidate', () => {
  const snap = defaultSnapshot();
  const s = selectSeat('reviewer', {profile: 'argo', avoid: ['openai'], avoidLabs: ['openai'], needsContext: 4000});
  for (const c of s.candidates) {
    const a = c.selection.advisory;
    assert.deepEqual([a.advisory, a.snapshot, typeof a.decision], [true, snap.digest, 'string']);
    assert.match(a.capability, /^(api|agy-cli|agy-sdk)\//);
    assert.equal(typeof a.eligible, 'boolean');
  }
  const rec = s.seat.selection.advisory.record;
  assert.equal(rec.mode, 'automatic');
  assert.deepEqual(rec.requirements.avoid_labs, ['openai']);
  assert.ok(rec.explanation.length >= 3 && rec.explanation.some(x => /^review by lab: the contributing labs openai are excluded/.test(x)));
  // The record re-derives: the same requirements over the snapshot it names give the decision it names.
  const again = decide(snap, rec.requirements);
  assert.equal(again.digest, rec.digest);
  assert.equal(s.candidates[1].selection.advisory.record, undefined, 'the whole decision rides on the seat; the fallbacks carry its digest');
  assert.equal(s.candidates[1].selection.advisory.decision, rec.digest);
  // A quota failover is judged as one: the metered Gemini API id behind its lane.
  const fit = selectSeat('implementer', {profile: 'fit', difficulty: 'hard'});
  const spare = fit.candidates.find(c => c.quota_failover);
  assert.deepEqual([spare.model, spare.selection.advisory.capability, spare.selection.advisory.eligible], ['gemini-4-carbon', 'api/agy_google/gemini-4-carbon', true]);
});

test('a pin the graph would refuse is recorded as one that would be refused, and the pinned seat is still the one selected', () => {
  const changed = capabilitySnapshot(retireLane(REG, 'gemini-4-carbon-low'));
  const s = selectSeat('planner', {pin: 'gemini-4-carbon-low', capability: changed});
  assert.equal(s.seat.model, 'gemini-4-carbon-low', 'live: the ticket pin is honoured as before');
  assert.equal(s.selection.source, 'ticket-pin');
  const rec = s.seat.selection.advisory.record;
  assert.deepEqual([rec.mode, rec.target.capability, rec.target.would_refuse], ['pinned', 'agy-cli/agy_google/gemini-4-carbon-low', true]);
  assert.match(rec.explanation.join('\n'), /pinned agy_google\/gemini-4-carbon-low: WOULD BE REFUSED: retired/);
  assert.equal(s.seat.selection.advisory.snapshot, changed.digest);
});

test('the capability snapshot is a ledger input beside facts and seating: recorded, re-derived, and a tampered one refused', () => {
  const operator = generateSigner('operator'), controller = generateSigner('controller');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-kind-'));
  try {
    const anchor = createLedger({dir, authority: {keyring: {operator: operator.publicJwk, controller: controller.publicJwk}, orderer: 'controller', operators: ['operator']}, operator, order: controller});
    const L = openLedger({dir, kinds: defineKinds(pantheonKinds({authors: {inputs: a => a.key_id === 'operator', decisions: a => a.key_id === 'controller'}})), anchor});
    const by = s => ({author: {key_id: s.key_id}, signer: s, order: controller});
    const payload = currentCapability();
    assert.equal(payload.digest, defaultSnapshot().digest, 'the snapshot the live selections name');
    assert.equal(payload.digest, selectSeat('planner').selection.advisory.snapshot);
    L.append({kind: 'capability', payload, ...by(operator)});
    assert.equal(L.verify().ok, true);
    assert.throws(() => L.append({kind: 'capability', payload, ...by(controller)}), /may not author "capability"/);
    assert.throws(() => L.append({kind: 'capability', payload: {...payload, digest: 'sha256:' + '0'.repeat(64)}, ...by(operator)}), /digest is not the digest of its sources/);
    // A source at the version this checkout holds must re-derive to the facts digest it records.
    const lie = structuredClone(payload);
    lie.sources[1].digest = 'sha256:' + '1'.repeat(64);
    lie.digest = snapshotDigestOf(lie);
    assert.throws(() => L.append({kind: 'capability', payload: lie, ...by(operator)}), /pantheon\.models at sha256:[0-9a-f]+ re-derives to .*not the recorded/);
    // A source at another version (an older checkout's) is noted as not re-derived, never assumed either way.
    const older = structuredClone(payload);
    older.sources[2].version = 'sha256:' + '2'.repeat(64);
    older.digest = snapshotDigestOf(older);
    L.append({kind: 'capability', payload: older, ...by(operator)});
    assert.equal(L.verify().ok, true);
    assert.equal(snapshotPayload(defaultSnapshot()).digest, payload.digest);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
