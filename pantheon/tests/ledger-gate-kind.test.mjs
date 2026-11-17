// K3 `gate`: a ship's gate verdicts re-derive from the heads they name, after the board has moved on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner} from '../../packages/ledger/chain.mjs';
import {gateKinds, gateRecord} from '../src/ledger/gate-kind.mjs';
import {openBoard} from '../src/board/index.mjs';
import {publish, treeSlots} from '../src/board/dag.mjs';
import {merge} from '../src/board/merge.mjs';
import {ship, shipClaim, gatesAt} from '../src/board/integrate.mjs';

const operator = generateSigner('operator'), controller = generateSigner('controller');
const authority = {keyring: {operator: operator.publicJwk, controller: controller.publicJwk}, orderer: 'controller', operators: ['operator']};
const by = s => ({author: {key_id: s.key_id}, signer: s, order: controller});
const authors = a => a.key_id === 'controller';

const REF = 'refs/board/gate-demo', SLOT = 'src/lock.mjs', ITEM = 'lock', CMD = 'node --test tests/lock.test.mjs';
const HUMAN = {vendor: 'human'}, CONTROLLER = {vendor: 'controller'};
const seat = (vendor, mode, id) => ({vendor, seat_id: id, mode, occupancy_gen: 1});
const maker = seat('openai', 'work', 'openai-work'), planner = seat('anthropic', 'plan', 'anthropic-plan'), reviewer = seat('xai', 'critique', 'xai-critique');
const TICKET = {title: 'fence the lock', goal: 'a fenced lease', repo: 'pantheon', constraints: [], forbidden: [],
  acceptance: [{type: 'tests', cmd: CMD, expect: 'exit0'}]};

async function withBoardAndLedger(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-gate-board-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-gate-ledger-'));
  try {
    const board = openBoard(root);
    const anchor = createLedger({dir, authority, operator, order: controller});
    const L = openLedger({dir, kinds: defineKinds(gateKinds({authors, board: {store: board.store, refs: board.refs}})), anchor});
    return await fn(board, L);
  } finally { for (const d of [root, dir]) fs.rmSync(d, {recursive: true, force: true}); }
}

// A real ship's preconditions: a ticket and plan on the board, an artifact on the maker's branch under a
// lease, the controller's passing run citing it, and a cross-lab approval bound to its bytes.
async function drive(board, {release = true} = {}) {
  const ok = r => assert.equal(r.ok, true, r.why);
  ok(await publish({...board, ref: REF, author: HUMAN, msg: 'ticket', entries: [{kind: 'ticket', payload: TICKET}]}));
  const planRef = `refs/seat/${planner.seat_id}/wip`;
  await board.refs.branch({name: planRef, from: REF, author: planner});
  ok(await publish({...board, ref: planRef, author: planner, msg: 'plan', entries: [
    {kind: 'plan', payload: {steps: [{item: ITEM, title: 'fence'}]}},
    {kind: 'work_item', payload: {key: ITEM, title: 'fence', state: 'ready', artifact_slots: [`artifact:${SLOT}`]}},
  ]}));
  ok(await merge({...board, into: REF, from: planRef, author: CONTROLLER, only: ['plan', 'item:']}));
  const wip = `refs/seat/${maker.seat_id}/wip`;
  await board.refs.branch({name: wip, from: REF, author: maker});
  await board.runtime.acquire({resource: `item:${ITEM}`, holder: maker, ttlMs: 120_000});
  const a = await publish({...board, ref: wip, author: maker, lease: {resource: `item:${ITEM}`, gen: 1}, msg: 'work',
    entries: [{kind: 'artifact', payload: {slot: SLOT, path: SLOT, rev: 1}, blob: '// fenced\n'}]});
  ok(a);
  const artifactCid = treeSlots(board.store, a.commit)[`artifact:${SLOT}`];
  const bytes = board.store.get(artifactCid).links.bytes;
  ok(await publish({...board, ref: wip, author: CONTROLLER, msg: 'the suite',
    entries: [{kind: 'repro', payload: {cmd: CMD, exit: 0}, blob: '# pass 1\n', links: {derived_from: [artifactCid]}}]}));
  const rref = `refs/seat/${reviewer.seat_id}/wip`;
  await board.refs.branch({name: rref, from: wip, author: reviewer});
  ok(await publish({...board, ref: rref, author: reviewer, msg: 'review', entries: [{kind: 'critique', links: {target: bytes},
    payload: {target: {slot: SLOT, rev: 1}, verdict: 'approve', findings: []}}]}));
  ok(await merge({...board, into: wip, from: rref, author: CONTROLLER, only: ['critique:']}));
  if (release) await board.runtime.release({resource: `item:${ITEM}`, holder: maker, gen: 1});
  return {wip, artifactCid};
}

test('a recorded verdict re-derives after the board moves on, refusals and leases included', () => withBoardAndLedger(async (board, L) => {
  const {wip} = await drive(board, {release: false});
  const now = Date.now();
  // Judged while the maker still holds its lease: LEASE refuses, and the lease rows and `now` are recorded.
  const held = await gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER, now});
  assert.equal(held.claim.tests_passed, true);
  assert.equal(held.claim.gates.find(g => g.gate === 'LEASE').ok, false);
  assert.ok(held.leases[`item:${ITEM}`], 'the lease LEASE read is part of the entry');
  const h1 = L.append({kind: 'gate', payload: held, ...by(controller)}).hash;

  await board.runtime.release({resource: `item:${ITEM}`, holder: maker, gen: 1});
  const green = await gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER, now: now + 1});
  assert.equal(green.why, undefined);
  assert.equal(green.claim.why, null, 'every gate holds');
  assert.equal(green.claim.checker_ack && green.claim.tests_passed && green.claim.bound_to_current_bytes, true);
  L.append({kind: 'gate', payload: green, derivedFrom: [h1], ...by(controller)});

  // The board moves on: the ship lands, then the maker's branch keeps going.
  const shipped = await ship({...board, ref: REF, from: wip, actor: CONTROLLER});
  assert.equal(shipped.ok, true, shipped.why);
  await publish({...board, ref: wip, author: CONTROLLER, msg: 'later', entries: [{kind: 'repro', payload: {cmd: CMD, exit: 1}, blob: 'later\n'}]});
  assert.notEqual(board.refs.resolve(REF), green.heads.find(h => h.name === REF).cid);
  const liveNow = await shipClaim({...board, ref: REF, from: wip, actor: CONTROLLER});
  assert.equal(liveNow.tests_passed, false, 'live, the same question now has another answer (nothing left to ship)');

  const v = L.verify();
  assert.equal(v.ok, true, v.why);
  assert.equal(v.rederived, 2, 'both verdicts re-derived from the heads they name');
}));

test('a forged verdict is refused: flipped tests_passed, a quietly green gate, a dropped lease', () => withBoardAndLedger(async (board, L) => {
  const {wip} = await drive(board, {release: false});
  const now = Date.now();
  const rec = await gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER, now});
  // TESTS is red on a branch with no passing run: build that case by naming the board head as `from`.
  const red = await gateRecord({...board, ref: REF, from: REF, actor: CONTROLLER, now});
  assert.equal(red.claim.tests_passed, false);
  const flipped = {...red, claim: {...red.claim, tests_passed: true}};
  assert.throws(() => L.append({kind: 'gate', payload: flipped, ...by(controller)}), /not the verdict these heads produce/);
  const greenLease = {...rec, claim: {...rec.claim, gates: rec.claim.gates.map(g => (g.gate === 'LEASE' ? {...g, ok: true, why: null, held: []} : g))}};
  assert.throws(() => L.append({kind: 'gate', payload: greenLease, ...by(controller)}), /not the verdict these heads produce/);
  // Dropping the lease rows changes the input, and the recorded claim no longer follows from it.
  assert.throws(() => L.append({kind: 'gate', payload: {...rec, leases: {}}, ...by(controller)}), /not the verdict these heads produce/);
  // Recorded after the lease expired, the same rows do not hold: `now` is part of the verdict.
  assert.throws(() => L.append({kind: 'gate', payload: {...rec, now: now + 10 * 60_000}, ...by(controller)}), /not the verdict these heads produce/);
  // Only the controller records verdicts.
  assert.throws(() => L.append({kind: 'gate', payload: rec, ...by(operator)}), /may not author "gate"/);
  L.append({kind: 'gate', payload: rec, ...by(controller)});
  assert.equal(L.verify().ok, true);
}));

test('heads that are not on this board are refused', () => withBoardAndLedger(async (board, L) => {
  const {wip} = await drive(board);
  const rec = await gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER});
  // A commit from another board: a real cid, just not one this store holds.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-gate-other-'));
  try {
    const elsewhere = openBoard(other);
    const r = await publish({...elsewhere, ref: REF, author: HUMAN, msg: 'ticket', entries: [{kind: 'ticket', payload: {...TICKET, title: 'another board'}}]});
    assert.equal(r.ok, true, r.why);
    assert.equal(board.store.has(r.commit), false, 'content-addressed: a different board, a different commit');
    const foreign = {...rec, heads: rec.heads.map(h => (h.name === REF ? {...h, cid: r.commit} : h))};
    assert.throws(() => L.append({kind: 'gate', payload: foreign, ...by(controller)}), /not on this board/);
  } finally { fs.rmSync(other, {recursive: true, force: true}); }
  const made = {...rec, heads: rec.heads.map(h => (h.name === wip ? {...h, cid: 'commit:' + '0'.repeat(64)} : h))};
  assert.throws(() => L.append({kind: 'gate', payload: made, ...by(controller)}), /not on this board/);
  // On this board, but never the board ref's head: the wip commit is not in REF's history.
  const sideways = {...rec, heads: rec.heads.map(h => (h.name === REF ? {...h, cid: rec.heads.find(x => x.name === wip).cid} : h))};
  assert.throws(() => L.append({kind: 'gate', payload: sideways, ...by(controller)}), /no longer in refs\/board\/gate-demo's history/);
  L.append({kind: 'gate', payload: rec, ...by(controller)});
  assert.equal(L.verify().ok, true);
}));

test('gatesAt is the live dry run, read through named heads', () => withBoardAndLedger(async board => {
  const {wip} = await drive(board);
  const now = Date.now();
  const heads = [REF, wip].map(name => ({name, cid: board.refs.resolve(name)}));
  const live = await shipClaim({...board, ref: REF, from: wip, actor: CONTROLLER, now});
  assert.deepEqual(gatesAt({store: board.store, heads, ref: REF, from: wip, actor: CONTROLLER, now}), live);
  // A chair is refused by the pinned evaluation exactly as by a live one (law 6).
  const chair = await shipClaim({...board, ref: REF, from: wip, actor: maker, now});
  assert.deepEqual(gatesAt({store: board.store, heads, ref: REF, from: wip, actor: maker, now}), chair);
  assert.throws(() => gatesAt({store: board.store, heads, ref: REF, from: wip, actor: CONTROLLER}), /`now` is part of the verdict/);
}));
