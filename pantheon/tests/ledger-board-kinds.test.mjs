// The board's runtime records on the ledger: lease rows, budget limits and ref moves, each an entry
// citing the previous one, recorded before the file changes; and the LEASE gate citing lease entries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {openPantheonLedger, CONTROLLER as CTL} from '../src/ledger/system.mjs';
import {gateRecord, gateLeaseCitations} from '../src/ledger/gate-kind.mjs';
import {openBoard} from '../src/board/index.mjs';
import {publish, treeSlots} from '../src/board/dag.mjs';
import {merge} from '../src/board/merge.mjs';

const REF = 'refs/board/runtime-demo', SLOT = 'src/lock.mjs', ITEM = 'lock', CMD = 'node --test tests/lock.test.mjs';
const HUMAN = {vendor: 'human'}, CONTROLLER = {vendor: 'controller'};
const seat = (vendor, mode, id) => ({vendor, seat_id: id, mode, occupancy_gen: 1});
const maker = seat('openai', 'work', 'openai-work'), planner = seat('anthropic', 'plan', 'anthropic-plan'), reviewer = seat('xai', 'critique', 'xai-critique');
const TICKET = {title: 'fence the lock', goal: 'a fenced lease', repo: 'pantheon', constraints: [], forbidden: [],
  acceptance: [{type: 'tests', cmd: CMD, expect: 'exit0'}]};
const ok = r => assert.equal(r.ok, true, r.why);

// A board whose runtime records on the system ledger, as runOpenItem wires it by default.
async function withBoard(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-board-kinds-'));
  try {
    const root = path.join(dir, 'board');
    const board = openBoard(root);
    const sys = openPantheonLedger({root: path.join(dir, 'ledger'), board});
    const rec = sys.recorder().board(root);
    board.useLedger(rec);
    const L = sys.ledger, controller = sys.keys.get(CTL);
    // A record appended straight to the ledger with the controller's own key: what a forger holding that
    // key could write. Every refusal below is the kind's re-derivation, not a signature failure.
    const forge = (kind, payload, derivedFrom = []) => L.append({kind, payload, derivedFrom, author: {key_id: CTL}, signer: controller, order: controller});
    const latest = (kind, pred) => L.read().filter(e => e.kind === kind && pred(L.payloadOf(e))).map(e => ({hash: L.hashOf(e), p: L.payloadOf(e)})).at(-1);
    return await fn({board, L, rec, root, forge, latest});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// The gate test's ship preconditions, on a board that records on the ledger.
async function drive(board) {
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
  ok(await board.runtime.acquire({resource: `item:${ITEM}`, holder: maker, ttlMs: 120_000}));
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
  return {wip, planRef, rref};
}

test('lease rows: every grant, renewal, release, expiry and fence is an entry; generations are monotonic and holders consistent', () => withBoard(async ({board, L, root, forge, latest}) => {
  const R = 'item:solo', a = seat('openai', 'work', 'a'), b = seat('xai', 'work', 'b'), c = seat('anthropic', 'work', 'c');
  const t0 = Date.now();
  ok(await board.runtime.acquire({resource: R, holder: a, ttlMs: 1000, now: t0}));
  ok(await board.runtime.acquire({resource: R, holder: a, ttlMs: 1000, now: t0 + 10}));          // renewal, same gen
  ok(await board.runtime.renew({resource: R, holder: a, gen: 1, ttlMs: 1000, now: t0 + 20}));
  ok(await board.runtime.release({resource: R, holder: a, gen: 1, now: t0 + 30}));
  ok(await board.runtime.acquire({resource: R, holder: b, ttlMs: 1000, now: t0 + 40}));           // gen 2
  ok(await board.runtime.acquire({resource: R, holder: c, ttlMs: 1000, now: t0 + 5000}));         // b expired: gen 3
  ok(await board.runtime.fence({resource: R, holder: a, reason: 'operator takeover', now: t0 + 5100}));  // gen 4
  const rows = L.read().filter(e => e.kind === 'lease').map(e => L.payloadOf(e)).filter(p => p.resource === R);
  assert.deepEqual(rows.map(p => [p.event, p.gen, p.holder.seat_id]), [
    ['granted', 1, 'a'], ['renewed', 1, 'a'], ['renewed', 1, 'a'], ['released', 1, 'a'],
    ['granted', 2, 'b'], ['expired', 2, 'b'], ['granted', 3, 'c'], ['fenced', 4, 'a']]);
  assert.ok(rows.every(p => p.scope === root));
  assert.equal(L.verify().ok, true);

  // Forged records, signed with the controller's own key, refused by re-derivation.
  const prev = latest('lease', p => p.resource === R);
  const base = {scope: root, resource: R, holder: {seat_id: 'a'}, when: new Date(t0 + 6000).toISOString(), expires_at: new Date(t0 + 9000).toISOString()};
  assert.throws(() => forge('lease', {...base, event: 'granted', gen: 5}, [prev.hash]), /still active/);
  assert.throws(() => forge('lease', {...base, event: 'fenced', gen: 7, reason: 'skip'}, [prev.hash]), /gen 5, not 7/);
  assert.throws(() => forge('lease', {...base, event: 'renewed', gen: 4, holder: {seat_id: 'b'}}, [prev.hash]), /held by a, not b/);
  assert.throws(() => forge('lease', {...base, event: 'renewed', gen: 3}, [prev.hash]), /not the active gen 4/);
  assert.throws(() => forge('lease', {...base, event: 'released', gen: 4}), /does not cite the previous lease entry/);
  assert.throws(() => forge('lease', {...base, event: 'expired', gen: 4}, [prev.hash]), /does not expire until/);
  assert.throws(() => forge('lease', {...base, event: 'released', gen: 4, when: new Date(t0).toISOString()}, [prev.hash]), /time runs backwards/);
  assert.throws(() => forge('lease', {...base, event: 'observed', state: 'active', gen: 4}, [prev.hash]), /observed only when/);
  // The honest record is accepted.
  forge('lease', {...base, event: 'released', gen: 4}, [prev.hash]);
  assert.equal(L.verify().ok, true);
}));

test('live: a lease row edited in the file is refused at its next change, and the file is left as it was', () => withBoard(async ({board}) => {
  const R = 'item:edited', a = seat('openai', 'work', 'a');
  ok(await board.runtime.acquire({resource: R, holder: a, ttlMs: 60_000}));
  // Someone rewrites the table: the active lease now names another holder.
  const file = path.join(board.runtime.dir, 'leases.json');
  const table = JSON.parse(fs.readFileSync(file, 'utf8'));
  table[R].holder = {seat_id: 'thief'};
  fs.writeFileSync(file, JSON.stringify(table));
  const before = fs.readFileSync(file, 'utf8');
  // Without a ledger the thief's release went through; with one, its record does not re-derive.
  await assert.rejects(board.runtime.release({resource: R, holder: {seat_id: 'thief'}, gen: 1}), /held by a, not thief/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the refused change was not written');
  // Put back, the honest holder releases.
  table[R].holder = a;
  fs.writeFileSync(file, JSON.stringify(table));
  ok(await board.runtime.release({resource: R, holder: a, gen: 1}));
}));

test('the LEASE gate cites the lease entries it read; rows dropped, added or uncited are refused', () => withBoard(async ({board, L, rec, forge}) => {
  const {wip} = await drive(board);                          // the maker still holds item:lock
  const now = Date.now();
  const payload = await gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER, now, leaseLedger: rec});
  assert.equal(payload.lease_scope, rec.scope);
  assert.equal(payload.claim.gates.find(g => g.gate === 'LEASE').ok, false, 'the held lease refuses LEASE');
  const cites = gateLeaseCitations(rec);
  assert.equal(cites.length, 1);
  forge('gate', payload, cites);
  assert.equal(L.verify().ok, true);
  // The rows and the verdict forged together (LEASE green, the row dropped): the ledger's lease entries say otherwise.
  const green = {...payload, leases: {}, claim: {...payload.claim}};
  assert.throws(() => forge('gate', green, cites), /lease rows are not the ones the ledger's lease entries derive/);
  assert.throws(() => forge('gate', payload, []), /does not cite exactly the latest lease entries/);
  const {lease_scope, ...unscoped} = payload;
  assert.throws(() => forge('gate', unscoped, cites), /cited without naming their lease_scope/);
  // A runtime table that disagrees with the ledger is not recorded at all.
  const file = path.join(board.runtime.dir, 'leases.json');
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  t[`item:${ITEM}`].expires_at = new Date(now + 9e9).toISOString();
  fs.writeFileSync(file, JSON.stringify(t));
  await assert.rejects(gateRecord({...board, ref: REF, from: wip, actor: CONTROLLER, now, leaseLedger: rec}), /not the one the ledger's lease entries derive/);
}));

test('budget limits: a new cap cites the one it replaces, and the declared limits are read from the ledger', () => withBoard(async ({board, L, root, forge, latest}) => {
  board.runtime.setBudget({max_turns: 1});
  ok(await publish({...board, ref: REF, author: HUMAN, msg: 'ticket', entries: [{kind: 'ticket', payload: TICKET}]}));
  assert.equal(board.runtime.budget().exhausted, true);
  // budget.json raised by hand: without a ledger that unblocked scheduling; with one, the ledger's cap holds.
  const file = path.join(board.runtime.dir, 'budget.json');
  fs.writeFileSync(file, JSON.stringify({max_turns: 100, declared_at: new Date().toISOString()}));
  const b = board.runtime.budget();
  assert.equal(b.exhausted, true, 'the edited file does not raise the cap');
  assert.equal(b.declared.max_turns, 1);
  assert.equal(b.declared_binding, 'ledger');
  assert.equal(b.declared_file_mismatch, true);
  // Raising it is a new entry citing the previous one.
  board.runtime.setBudget({max_turns: 5});
  const caps = L.read().filter(e => e.kind === 'budget');
  assert.equal(caps.length, 2);
  assert.deepEqual(caps[1].derived_from, [L.hashOf(caps[0])]);
  assert.equal(board.runtime.budget().exhausted, false);
  assert.equal(board.runtime.budget().declared_file_mismatch, false);
  // Forged caps: uncited, cited out of order, or not a cap.
  const prev = latest('budget', p => p.scope === root);
  const at = new Date(Date.now() + 1000).toISOString();
  assert.throws(() => forge('budget', {scope: root, limits: {max_turns: 1e6}, declared_at: at}), /does not cite the previous budget entry/);
  assert.throws(() => forge('budget', {scope: root, limits: {max_turns: 1e6}, declared_at: at}, [L.hashOf(caps[0])]), /does not cite the previous budget entry/);
  assert.throws(() => forge('budget', {scope: root, limits: {max_turns: 1e6}, declared_at: new Date(0).toISOString()}, [prev.hash]), /declared before the limit it replaces/);
  assert.throws(() => forge('budget', {scope: root, limits: {max_turns: -1}, declared_at: at}, [prev.hash]), /non-negative integer/);
  forge('budget', {scope: root, limits: {max_turns: 3}, declared_at: at}, [prev.hash]);
  assert.equal(board.runtime.budget().declared.max_turns, 3);
  assert.equal(L.verify().ok, true);
}));

test('ref moves: each swap is an entry citing the previous move; a ref moved by hand or rewritten without a reset is refused', () => withBoard(async ({board, L, root, forge, latest}) => {
  const {wip} = await drive(board);
  const moves = L.read().filter(e => e.kind === 'ref.move').map(e => L.payloadOf(e));
  for (const {name, cid} of board.refs.list()) assert.equal(moves.filter(m => m.name === name).at(-1).to, cid, `${name} is where its last move left it`);
  assert.ok(moves.every(m => m.scope === root && m.reset === false));
  assert.equal(L.verify().ok, true);

  // A ref file moved by hand (back to the board head) is caught at the next move, which does not happen.
  const head = board.refs.resolve(wip), boardHead = board.refs.resolve(REF);
  fs.writeFileSync(board.refs.refPath(wip), boardHead + '\n');
  const r = await publish({...board, ref: wip, author: CONTROLLER, msg: 'after the edit',
    entries: [{kind: 'repro', payload: {cmd: CMD, exit: 0}, blob: '# pass 2\n'}]});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LEDGER_REFUSED');
  assert.match(r.why, /moved off the ledger/);
  assert.equal(board.refs.resolve(wip), boardHead, 'the refused move did not happen');
  fs.writeFileSync(board.refs.refPath(wip), head + '\n');

  // Two branches from the same head: moving one onto the other rewrites history.
  const A = `refs/seat/${planner.seat_id}/a`, B = `refs/seat/${planner.seat_id}/b`;
  for (const name of [A, B]) ok(await board.refs.branch({name, from: REF, author: planner}));
  const pa = await publish({...board, ref: A, author: planner, msg: 'a', entries: [{kind: 'plan', payload: {steps: [{item: 'x', title: 'a'}]}}]});
  const pb = await publish({...board, ref: B, author: planner, msg: 'b', entries: [{kind: 'plan', payload: {steps: [{item: 'x', title: 'b'}]}}]});
  ok(pa); ok(pb);
  const rewrite = await board.refs.swap({name: A, expected: pa.commit, next: pb.commit, author: planner, msg: 'rewrite'});
  assert.equal(rewrite.code, 'LEDGER_REFUSED');
  assert.match(rewrite.why, /does not descend from .* not a recorded reset/);
  assert.equal(board.refs.resolve(A), pa.commit);
  // Said as a reset, it lands, and is recorded as one.
  ok(await board.refs.swap({name: A, expected: pa.commit, next: pb.commit, author: planner, msg: 'reset onto b', reset: true}));
  assert.equal(latest('ref.move', p => p.name === A).p.reset, true);

  // Forged moves, signed with the controller's own key.
  const prev = latest('ref.move', p => p.name === wip);
  const move = {scope: root, name: wip, from: head, to: pb.commit, msg: 'forged', by: 'controller', reset: false};
  assert.throws(() => forge('ref.move', move, [prev.hash]), /does not descend/);
  assert.throws(() => forge('ref.move', {...move, to: 'commit:' + 'a'.repeat(64)}, [prev.hash]), /not a commit in this board's store/);
  assert.throws(() => forge('ref.move', {...move, from: boardHead, to: head}, [prev.hash]), /moved off the ledger/);
  assert.throws(() => forge('ref.move', {...move, from: boardHead, to: head}), /does not cite the previous ref.move entry/);
  // The honest record (a no-op move to where it is) is accepted.
  forge('ref.move', {...move, to: head}, [prev.hash]);
  assert.equal(L.verify().ok, true);
  // The reflog stays for display.
  assert.ok(board.refs.reflog().length >= moves.length);
}));

test('without a ledger the board behaves as before: no records, edits go unchecked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-board-noledger-'));
  try {
    const board = openBoard(root);
    const a = seat('openai', 'work', 'a');
    ok(await board.runtime.acquire({resource: 'item:x', holder: a}));
    const file = path.join(board.runtime.dir, 'leases.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    t['item:x'].holder = {seat_id: 'thief'};
    fs.writeFileSync(file, JSON.stringify(t));
    ok(await board.runtime.release({resource: 'item:x', holder: {seat_id: 'thief'}, gen: 1}));
    board.runtime.setBudget({max_turns: 1});
    assert.equal(board.runtime.budget().declared_binding, 'file');
    assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a ref whose file cannot be written is undone on the ledger, so the ledger and the file never disagree', () => withBoard(async ({board, L}) => {
  ok(await publish({...board, ref: REF, author: HUMAN, msg: 'ticket', entries: [{kind: 'ticket', payload: TICKET}]}));
  const C = `refs/seat/${planner.seat_id}/c`;
  // Fail only the final rename, after the move is on the ledger: the narrow window this closes.
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to) === board.refs.refPath(C)) throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); return rename(from, to); };
  syncBuiltinESMExports();
  let r;
  try { r = await board.refs.branch({name: C, from: REF, author: planner}); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(r.ok, false);
  assert.equal(board.refs.resolve(C), null, 'the ref was not created');
  const moves = L.read().filter(e => e.kind === 'ref.move' && L.payloadOf(e).name === C).map(e => L.payloadOf(e));
  assert.deepEqual(moves.map(m => [m.reset, m.to === null]), [[false, false], [true, true]], 'recorded, then undone back to no ref');
  assert.match(moves[1].msg, /^undo: the ref file could not be written/);
  assert.equal(L.verify().ok, true);
  // With the fault gone, the same creation goes through: the ledger agrees the ref does not exist.
  ok(await board.refs.branch({name: C, from: REF, author: planner}));
  assert.equal(board.refs.resolve(C), board.refs.resolve(REF));
  assert.equal(L.verify().ok, true);
}));
