// The ledger's layering (docs/ledger-provenance-evaluation.md, "Layering"):
//   packages/ledger imports nothing from ophanim/ or pantheon/; pantheon/ imports nothing from ophanim/;
//   the core's canonical form is byte-identical to ophanim/board.mjs's; and a ledger a Pantheon run writes
//   with Pantheon's composition verifies when OPHANIM opens it with the full one (same names, same rules).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as board from '../board.mjs';
import * as core from '../../packages/ledger/canonical.mjs';
import {openLedger} from '../../packages/ledger/chain.mjs';
import {systemKinds, openSystemLedger, CONTROLLER} from './system.mjs';
import {PROMOTION, MAX_USES} from './efficiency-kinds.mjs';
import {pantheonSystemKinds, openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {publish} from '../../pantheon/src/board/dag.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-layering-'));

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(mjs|js|cjs|ts|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}
// Every module specifier a file imports, statically or dynamically, resolved against the file.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
const imports = file => [...fs.readFileSync(file, 'utf8').matchAll(SPEC)].map(m => m[2])
  .filter(s => s.startsWith('.') || s.startsWith('/')).map(s => path.resolve(path.dirname(file), s));
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

test('packages/ledger imports nothing outside itself; pantheon/ imports nothing from ophanim/', () => {
  const pkg = path.join(REPO, 'packages/ledger'), pantheon = path.join(REPO, 'pantheon'), ophanim = path.join(REPO, 'ophanim');
  const bad = [];
  for (const f of sources(pkg)) for (const t of imports(f)) if (!inside(t, pkg)) bad.push(`${path.relative(REPO, f)} -> ${path.relative(REPO, t)}`);
  for (const f of sources(pantheon)) for (const t of imports(f)) if (inside(t, ophanim)) bad.push(`${path.relative(REPO, f)} -> ${path.relative(REPO, t)}`);
  assert.deepEqual(bad, []);
});

test('the core\'s canonical form and digest are ophanim/board.mjs\'s, byte for byte', () => {
  const values = [null, false, 0, -0, 1.5e-7, 2 ** 53, 'x', '\u0000😀', [], {}, [1, [2, [3]]],
    {b: {d: 1, c: [true, null]}, a: 'z', '': 0, 'é': 1}, Object.assign(Object.create(null), {k: 'v'})];
  for (const v of values) {
    assert.equal(core.canonical(v), board.canonical(v));
    assert.equal(core.digest(v), board.digest(v));
  }
  for (const v of [NaN, Infinity, undefined, () => 1, new Map(), new Date(0)]) {
    assert.throws(() => core.canonical(v));
    assert.throws(() => board.canonical(v));
  }
});

test('OPHANIM\'s composition registers every Pantheon kind under the same name and rule, and adds its own', () => {
  const root = tmp();
  try {
    const b = openBoard(path.join(root, 'board'));
    for (const at of [null, b]) {
      const p = pantheonSystemKinds({board: at}), o = systemKinds({board: at});
      for (const [name, k] of Object.entries(p)) {
        assert.ok(Object.hasOwn(o, name), `${name} is in OPHANIM's composition`);
        for (const fn of ['authors', 'validate', 'rederive']) assert.equal(String(o[name][fn]), String(k[fn]), `${name}.${fn} is the same rule`);
      }
      const extra = Object.keys(o).filter(n => !Object.hasOwn(p, n));
      assert.ok(extra.length > 0 && extra.every(n => n.startsWith('efficiency.')), `OPHANIM adds only its efficiency kinds: ${extra}`);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a ledger written with Pantheon\'s composition verifies under OPHANIM\'s, and OPHANIM can keep writing it', async () => {
  const root = tmp();
  try {
    const boardRoot = path.join(root, 'board'), ledgerRoot = path.join(root, 'ledger');
    const b = openBoard(boardRoot);
    const P = openPantheonLedger({root: ledgerRoot, board: b});
    const rec = P.recorder();
    b.useLedger(rec.board(boardRoot));
    const seat = {seat_id: 'openai-work@gpt-6-sol', vendor: 'openai', mode: 'work', occupancy_gen: 1};
    const t = rec.recordTurn({seat, requested_model: 'gpt-6-sol', response_id: 'resp_1', reply: 'work'});
    rec.recordReview({seat: {seat_id: 'xai-critique', vendor: 'xai', mode: 'critique', occupancy_gen: 1}, model: 'grok-4.6', response_id: 'resp_2', verdict: 'approve', targets: [t]});
    rec.board(boardRoot).recordBudget({max_turns: 4}, '2026-11-17T00:00:00.000Z');
    const c = await publish({...b, ref: 'refs/board/layering', author: {vendor: 'human'}, msg: 'ticket',
      entries: [{kind: 'ticket', payload: {title: 't', goal: 'g', repo: 'pantheon', constraints: [], forbidden: [], acceptance: [{type: 'tests', cmd: 'true', expect: 'exit0'}]}}]});
    assert.equal(c.ok, true, c.why);
    P.ledger.append({kind: 'board.anchor', payload: {ref: 'refs/board/layering', commit: c.commit}, author: {key_id: CONTROLLER}, signer: P.controller, order: P.controller});
    const kinds = new Set(P.ledger.read().map(e => e.kind));
    for (const k of ['facts', 'seating', 'turn', 'review', 'budget', 'ref.move', 'board.anchor']) assert.ok(kinds.has(k), k);
    assert.equal(P.ledger.verify().ok, true);

    const O = openSystemLedger({root: ledgerRoot, board: b});
    assert.equal(O.anchor, P.anchor);
    const v = O.ledger.verify();
    assert.equal(v.ok, true, v.why);
    assert.equal(v.rederived, P.ledger.read().filter(e => !['genesis', 'authority', 'checkpoint'].includes(e.kind)).length, 'every entry re-derived');
    O.recorder().recordTurn({seat, requested_model: 'gpt-6-sol', response_id: 'resp_3', reply: 'more'});
    assert.equal(openPantheonLedger({root: ledgerRoot, board: b}).ledger.verify().ok, true, 'Pantheon still reads what OPHANIM appended with Pantheon kinds');
    // Read without keys, as a verifier would: the bare chain with Pantheon's registry.
    const raw = openLedger({dir: ledgerRoot, kinds: pantheonSystemKinds({board: b}), anchor: P.anchor});
    assert.equal(raw.verify().ok, true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

// "Shared ledgers and the run-path gate": before domains were declared, Pantheon's composition refused a
// ledger holding OPHANIM's efficiency entries (kind "efficiency.promotion" is not in the registry).
test('Pantheon opens a ledger that holds OPHANIM\'s entries: checked structurally, reported, never appended', () => {
  const root = tmp();
  try {
    const ledgerRoot = path.join(root, 'ledger');
    const O = openSystemLedger({root: ledgerRoot});
    const promotion = {schema: PROMOTION, scopeSha: 'a'.repeat(64), decisionId: 'sha256:' + 'd'.repeat(64), fromSlots: 1, toSlots: 3, maxUses: MAX_USES,
      efficiency: {baselineConservativeMs: 5000, candidateConservativeMs: 3000, conservativeSavedMs: 2000, totalAssessmentCostMs: 400}};
    const by = {author: {key_id: CONTROLLER}, signer: O.keys.get(CONTROLLER), order: O.keys.get(CONTROLLER)};
    O.ledger.append({kind: 'efficiency.promotion', payload: promotion, ...by});
    assert.deepEqual(O.ledger.verify().authority.domains.ophanim.includes('efficiency.promotion'), true, 'the genesis declares OPHANIM\'s kind set');

    const P = openPantheonLedger({root: ledgerRoot});
    const v = P.ledger.verify();
    assert.equal(v.ok, true, v.why);
    assert.deepEqual([v.foreign, v.complete], [{ophanim: 1}, false], 'the efficiency entry is passed over, and the result says so');
    assert.throws(() => P.ledger.append({kind: 'efficiency.promotion', payload: promotion, ...by}), /belongs to domain "ophanim"/);
    P.recorder();                                       // Pantheon keeps recording its own kinds on it
    const all = openSystemLedger({root: ledgerRoot}).ledger.verify();
    assert.deepEqual([all.ok, all.complete], [true, true], 'OPHANIM re-derives everything, Pantheon\'s entries included');

    // A forged OPHANIM entry is refused by Pantheon too: its payload edited in place.
    const e = P.ledger.read().find(x => x.kind === 'efficiency.promotion');
    const obj = path.join(ledgerRoot, 'objects', e.payload_ref.slice(7) + '.json');
    const kept = fs.readFileSync(obj, 'utf8');
    fs.writeFileSync(obj, JSON.stringify({...promotion, maxUses: 1000}));
    assert.throws(() => openPantheonLedger({root: ledgerRoot}), /payload object missing or altered/);
    fs.writeFileSync(obj, kept);
    assert.equal(openPantheonLedger({root: ledgerRoot}).ledger.verify().ok, true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
