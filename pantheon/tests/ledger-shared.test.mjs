// One ledger shared across boards and domains.
//   - gate and contribution entries name their board (`scope`) and re-derive against it, whichever board
//     the ledger was opened with; with that board gone, only what needs no board re-derives, and the
//     verify result says so;
//   - Pantheon's composition on a ledger that also holds another declared domain checks those entries
//     structurally, reports them, and never re-derives or appends them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, openLedgerHome, CONTROLLER} from '../../packages/ledger/index.mjs';
import {openPantheonLedger, pantheonLedgerKinds, pantheonDomains} from '../src/ledger/system.mjs';
import {gateKinds, gateRecord} from '../src/ledger/gate-kind.mjs';
import {chairContributions} from '../src/board/contributions.mjs';
import {openBoard} from '../src/board/index.mjs';
import {publish, treeSlots} from '../src/board/dag.mjs';
import {merge} from '../src/board/merge.mjs';

const REF = 'refs/board/shared', SLOT = 'src/lock.mjs', ITEM = 'lock', CMD = 'node --test tests/lock.test.mjs';
const HUMAN = {vendor: 'human'}, CTL = {vendor: 'controller'};
const seat = (vendor, mode, id) => ({vendor, seat_id: id, mode, occupancy_gen: 1});
const maker = seat('openai', 'work', 'openai-work'), planner = seat('anthropic', 'plan', 'anthropic-plan'), reviewer = seat('xai', 'critique', 'xai-critique');
const ticket = title => ({title, goal: 'a fenced lease', repo: 'pantheon', constraints: [], forbidden: [], acceptance: [{type: 'tests', cmd: CMD, expect: 'exit0'}]});
const tmp = name => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pantheon-ledger-shared-${name}-`)));

// A board ready to ship: ticket, plan, an artifact under a released lease, a passing run, a cross-lab ack.
async function drive(board, title) {
  const ok = r => assert.equal(r.ok, true, r.why);
  ok(await publish({...board, ref: REF, author: HUMAN, msg: 'ticket', entries: [{kind: 'ticket', payload: ticket(title)}]}));
  const planRef = `refs/seat/${planner.seat_id}/wip`;
  await board.refs.branch({name: planRef, from: REF, author: planner});
  ok(await publish({...board, ref: planRef, author: planner, msg: 'plan', entries: [
    {kind: 'plan', payload: {steps: [{item: ITEM, title: 'fence'}]}},
    {kind: 'work_item', payload: {key: ITEM, title: 'fence', state: 'ready', artifact_slots: [`artifact:${SLOT}`]}},
  ]}));
  ok(await merge({...board, into: REF, from: planRef, author: CTL, only: ['plan', 'item:']}));
  const wip = `refs/seat/${maker.seat_id}/wip`;
  await board.refs.branch({name: wip, from: REF, author: maker});
  await board.runtime.acquire({resource: `item:${ITEM}`, holder: maker, ttlMs: 120_000});
  const a = await publish({...board, ref: wip, author: maker, lease: {resource: `item:${ITEM}`, gen: 1}, msg: 'work',
    entries: [{kind: 'artifact', payload: {slot: SLOT, path: SLOT, rev: 1}, blob: `// ${title}\n`}]});
  ok(a);
  const artifactCid = treeSlots(board.store, a.commit)[`artifact:${SLOT}`];
  ok(await publish({...board, ref: wip, author: CTL, msg: 'the suite',
    entries: [{kind: 'repro', payload: {cmd: CMD, exit: 0}, blob: '# pass 1\n', links: {derived_from: [artifactCid]}}]}));
  const rref = `refs/seat/${reviewer.seat_id}/wip`;
  await board.refs.branch({name: rref, from: wip, author: reviewer});
  ok(await publish({...board, ref: rref, author: reviewer, msg: 'review', entries: [{kind: 'critique', links: {target: board.store.get(artifactCid).links.bytes},
    payload: {target: {slot: SLOT, rev: 1}, verdict: 'approve', findings: []}}]}));
  ok(await merge({...board, into: wip, from: rref, author: CTL, only: ['critique:']}));
  await board.runtime.release({resource: `item:${ITEM}`, holder: maker, gen: 1});
  return wip;
}

test('one ledger, two boards: each gate and contribution re-derives against the board it names', async () => {
  const dirA = tmp('a'), dirB = tmp('b'), dirL = tmp('ledger');
  try {
    const A = openBoard(dirA), B = openBoard(dirB);
    const sys = openPantheonLedger({root: path.join(dirL, 'ledger'), board: A});
    const rec = sys.recorder(), recA = rec.board(dirA), recB = rec.board(dirB);
    A.useLedger(recA); B.useLedger(recB);
    const wipA = await drive(A, 'board a'), wipB = await drive(B, 'board b');
    const by = {author: {key_id: CONTROLLER}, signer: sys.controller, order: sys.controller};
    const gA = await gateRecord({...A, ref: REF, from: wipA, actor: CTL, leaseLedger: recA});
    const gB = await gateRecord({...B, ref: REF, from: wipB, actor: CTL, leaseLedger: recB});
    assert.deepEqual([gA.scope, gB.scope], [dirA, dirB], 'each verdict names its board');
    // Before entries named their board, B's verdict was judged against the board the ledger was opened with.
    const {scope, lease_scope, ...unscoped} = gB;
    assert.throws(() => sys.ledger.append({kind: 'gate', payload: unscoped, ...by}), /not on this board/);
    recA.recordGate(gA); recB.recordGate(gB);
    const contribution = (board, root) => ({scope: root, heads: board.refs.list().map(r => ({name: r.name, cid: r.cid})), projection: chairContributions(board)});
    sys.ledger.append({kind: 'contribution', payload: contribution(A, dirA), ...by});
    sys.ledger.append({kind: 'contribution', payload: contribution(B, dirB), ...by});

    // Forgeries for the other board are refused through the ledger opened with A.
    assert.throws(() => sys.ledger.append({kind: 'gate', payload: {...gB, claim: {...gB.claim, tests_passed: !gB.claim.tests_passed}}, ...by}), /not the verdict these heads produce/);
    assert.throws(() => sys.ledger.append({kind: 'gate', payload: {...gB, scope: dirA, lease_scope: dirA}, ...by}), /lease rows|not on this board/);
    const forged = contribution(B, dirB);
    assert.throws(() => sys.ledger.append({kind: 'contribution', payload: {...forged, projection: {...forged.projection, chairs: []}}, ...by}), /not the one these heads produce/);

    // Both boards move on; the ledger re-derives every verdict, opened with either board.
    for (const [board, wip] of [[A, wipA], [B, wipB]]) {
      const shipped = await import('../src/board/integrate.mjs').then(m => m.ship({...board, ref: REF, from: wip, actor: CTL}));
      assert.equal(shipped.ok, true, shipped.why);
    }
    for (const opened of [A, B]) {
      const v = openPantheonLedger({root: path.join(dirL, 'ledger'), board: opened}).ledger.verify();
      assert.equal(v.ok, true, v.why);
      assert.equal(v.complete, true, 'nothing passed over');
    }

    // Board B is gone: its verdicts' lease citations still re-derive, its heads and claims cannot, and the
    // result says which entries were not fully re-derived.
    fs.rmSync(dirB, {recursive: true, force: true});
    const L = openPantheonLedger({root: path.join(dirL, 'ledger'), board: A}).ledger;
    const v = L.verify();
    assert.equal(v.ok, true, v.why);
    assert.equal(v.complete, false);
    const gone = new Set(v.partial.map(p => p.kind));
    for (const k of ['gate', 'contribution', 'ref.move']) assert.ok(gone.has(k), `${k} for the removed board is reported`);
    assert.ok(v.partial.every(p => p.why.includes(dirB)), 'only the removed board is reported');
    // With the board gone, what needs no board still refuses a forgery: lease rows that are not the ledger's.
    assert.throws(() => L.append({kind: 'gate', payload: {...gB, leases: {'item:x': {state: 'active', expires_at: '2099-01-01T00:00:00.000Z', gen: 1, holder: {seat_id: 'x'}}}}, ...by}),
      /lease rows are not the ones/);
  } finally { for (const d of [dirA, dirB, dirL]) fs.rmSync(d, {recursive: true, force: true}); }
});

test('an entry without a scope re-derives against the opened board, as before, and is refused with none', async () => {
  const dirA = tmp('a'), dirL = tmp('ledger');
  try {
    const A = openBoard(dirA);
    const wip = await drive(A, 'board a');
    const operator = generateSigner('operator'), controller = generateSigner('controller');
    const anchor = createLedger({dir: dirL, operator, order: controller,
      authority: {keyring: {operator: operator.publicJwk, controller: controller.publicJwk}, orderer: 'controller', operators: ['operator']}});
    const by = {author: {key_id: 'controller'}, signer: controller, order: controller};
    const {scope, ...old} = await gateRecord({...A, ref: REF, from: wip, actor: CTL});
    assert.equal(scope, dirA);
    const withA = openLedger({dir: dirL, kinds: defineKinds(gateKinds({board: {store: A.store, refs: A.refs}})), anchor});
    withA.append({kind: 'gate', payload: old, ...by});
    assert.equal(withA.verify().ok, true);
    const none = openLedger({dir: dirL, kinds: defineKinds(gateKinds({})), anchor}).verify();
    assert.match(none.why, /names no board \(scope\), and no board was opened/);
  } finally { for (const d of [dirA, dirL]) fs.rmSync(d, {recursive: true, force: true}); }
});

// Another domain on the same ledger, declared by its own composition: Pantheon does not know its kinds.
const demoKinds = () => ({...pantheonLedgerKinds(), 'demo.note': {authors: a => a.key_id === CONTROLLER,
  validate: p => (typeof p?.text === 'string' ? null : 'a note has text'), rederive: e => (e.payload.text.length < 100 ? null : 'too long')}});
const demoDomains = () => ({...pantheonDomains(), demo: ['demo.note']});

test('Pantheon on a ledger that also holds another domain: checked structurally, reported, never appended', () => {
  const dir = tmp('domains'), root = path.join(dir, 'ledger');
  try {
    const W = openLedgerHome({root, kinds: defineKinds(demoKinds()), domains: demoDomains()});
    const by = {author: {key_id: CONTROLLER}, signer: W.controller, order: W.controller};
    W.ledger.append({kind: 'demo.note', payload: {text: 'from the other domain'}, ...by});
    // Before domains were declared, this open was refused: kind "demo.note" is not in the registry.
    const P = openPantheonLedger({root});
    const v = P.ledger.verify();
    assert.equal(v.ok, true, v.why);
    assert.deepEqual([v.foreign, v.complete], [{demo: 1}, false]);
    assert.throws(() => P.ledger.append({kind: 'demo.note', payload: {text: 'x'}, ...by}), /belongs to domain "demo", which this registry does not supply/);
    P.recorder();                                       // records facts and seating: Pantheon keeps writing its own kinds
    assert.ok(P.ledger.read().some(e => e.kind === 'facts'));
    const all = openLedgerHome({root, kinds: defineKinds(demoKinds()), domains: demoDomains()}).ledger.verify();
    assert.deepEqual([all.ok, all.complete], [true, true], 'the full composition re-derives both domains');

    // A forged foreign entry is refused: its payload edited in place.
    const note = P.ledger.read().find(e => e.kind === 'demo.note');
    const obj = path.join(root, 'objects', note.payload_ref.slice(7) + '.json');
    const kept = fs.readFileSync(obj, 'utf8');
    fs.writeFileSync(obj, JSON.stringify({text: 'rewritten'}));
    assert.throws(() => openPantheonLedger({root}), /payload object missing or altered/);
    fs.writeFileSync(obj, kept);
    assert.equal(openPantheonLedger({root}).ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('a kind no domain declared is still refused: the registry stays closed', () => {
  const dir = tmp('undeclared'), root = path.join(dir, 'ledger');
  try {
    // A ledger written without declarations (as every ledger before this change was).
    const W = openLedgerHome({root, kinds: defineKinds(demoKinds())});
    W.ledger.append({kind: 'demo.note', payload: {text: 'undeclared'}, author: {key_id: CONTROLLER}, signer: W.controller, order: W.controller});
    assert.throws(() => openPantheonLedger({root}), /kind "demo.note" is not in the registry, and no domain declared before it names it/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
