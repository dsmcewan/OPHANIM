// K1: the ledger core. One chain, a closed kind registry, per-author signatures, re-derivation before
// every append and on every verify, strict reading, and checkpoints that let verification resume.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, CHECKPOINT} from './chain.mjs';

const lead = generateSigner('seat:lead');
const scout = generateSigner('seat:scout');
const orderer = generateSigner('controller');
const operator = generateSigner('operator');
const keyring = Object.fromEntries([lead, scout, orderer, operator].map(s => [s.key_id, s.publicJwk]));
const authority = {keyring, orderer: 'controller', operators: ['operator']};

// Two kinds with real re-derivation: a `measure` states a value; a `total` must equal the sum of the
// measures it cites, and must cite at least one. Only the lead may write totals.
const kinds = defineKinds({
  measure: {authors: () => true, validate: p => (Number.isInteger(p?.value) ? null : 'value must be an integer'), rederive: () => null},
  total: {
    authors: a => a.key_id === 'seat:lead',
    validate: p => (Number.isInteger(p?.sum) ? null : 'sum must be an integer'),
    rederive: (e, view) => {
      if (!e.derived_from.length) return 'a total cites the measures it sums';
      const parts = e.derived_from.map(h => ({entry: view.entry(h), payload: view.payload(h)}));
      if (parts.some(p => p.entry?.kind !== 'measure')) return 'a total cites only measures';
      const sum = parts.reduce((s, p) => s + p.payload.value, 0);
      return sum === e.payload.sum ? null : `cited measures sum to ${sum}, not ${e.payload.sum}`;
    },
  },
});

function withLedger(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-ledger-'));
  try {
    const anchor = createLedger({dir, authority, operator, order: orderer});
    return fn(openLedger({dir, kinds, anchor, ...opts}), dir, anchor);
  }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const by = (s, extra = {}) => ({author: {key_id: s.key_id, ...extra}, signer: s, order: orderer});

test('entries from several authors chain, and every one re-derives on verify', () => withLedger(L => {
  const a = L.append({kind: 'measure', payload: {value: 2}, ...by(scout)});
  const b = L.append({kind: 'measure', payload: {value: 3}, ...by(lead)});
  L.append({kind: 'total', payload: {sum: 5}, derivedFrom: [a.hash, b.hash], ...by(lead)});
  assert.deepEqual([L.verify().ok, L.verify().entries, L.verify().rederived], [true, 4, 3], 'genesis plus three');
}));

test('an entry that does not re-derive is refused before it is written', () => withLedger(L => {
  const a = L.append({kind: 'measure', payload: {value: 2}, ...by(scout)});
  assert.throws(() => L.append({kind: 'total', payload: {sum: 9}, derivedFrom: [a.hash], ...by(lead)}), /does not re-derive: cited measures sum to 2/);
  assert.throws(() => L.append({kind: 'total', payload: {sum: 0}, ...by(lead)}), /cites the measures it sums/);
  assert.equal(L.read().length, 2, 'a refused entry leaves the ledger unchanged');
}));

test('the registry is closed, and a kind names who may author it', () => withLedger(L => {
  assert.throws(() => L.append({kind: 'opinion', payload: {}, ...by(lead)}), /not in the registry/);
  const a = L.append({kind: 'measure', payload: {value: 1}, ...by(scout)});
  assert.throws(() => L.append({kind: 'total', payload: {sum: 1}, derivedFrom: [a.hash], ...by(scout)}), /may not author "total"/);
  assert.throws(() => L.append({kind: 'measure', payload: {value: 'x'}, ...by(scout)}), /value must be an integer/);
  for (const r of ['checkpoint', 'genesis', 'authority']) assert.throws(() => defineKinds({[r]: kinds.measure}), /reserved/);
}));

test('an entry is signed by its own author: a key cannot write as another seat', () => withLedger(L => {
  assert.throws(() => L.append({kind: 'measure', payload: {value: 1}, author: {key_id: 'seat:lead'}, signer: scout, order: orderer}), /signed by its own author/);
  assert.throws(() => L.append({kind: 'measure', payload: {value: 1}, ...by(generateSigner('seat:stranger'))}), /not in the keyring/);
  assert.throws(() => L.append({kind: 'measure', payload: {value: 1}, author: {key_id: scout.key_id}, signer: scout, order: lead}), /orderer co-signs/);
}));

test('a citation must point earlier in the chain', () => withLedger(L => {
  assert.throws(() => L.append({kind: 'total', payload: {sum: 1}, derivedFrom: ['sha256:' + '0'.repeat(64)], ...by(lead)}), /not earlier in the chain/);
}));

test('editing, reordering, deleting or truncating anything is caught on verify', () => withLedger((L, dir) => {
  const a = L.append({kind: 'measure', payload: {value: 2}, ...by(scout)});
  L.append({kind: 'measure', payload: {value: 3}, ...by(scout)});
  L.append({kind: 'total', payload: {sum: 2}, derivedFrom: [a.hash], ...by(lead)});
  const file = path.join(dir, 'chain.jsonl');
  const [g, ...lines] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const attempt = (content, re) => { fs.writeFileSync(file, content); const v = L.verify(); assert.equal(v.ok, false); assert.match(v.why, re); };
  const edited = JSON.parse(lines[1]); edited.author.served_model = 'other';
  attempt([g, lines[0], JSON.stringify(edited), lines[2]].join('\n') + '\n', /signature invalid|parent is not/);
  attempt([g, lines[1], lines[0], lines[2]].join('\n') + '\n', /sequence|parent/);
  attempt([g, lines[0], lines[2]].join('\n') + '\n', /sequence|parent/);
  assert.throws(() => { fs.writeFileSync(file, [g, ...lines].join('\n')); L.verify(); }, /torn append/);
  fs.writeFileSync(file, [g, ...lines].join('\n') + '\n');
  assert.equal(L.verify().ok, true, 'restored, it verifies again');
  // The payload is content-addressed: altering the object is caught too.
  const obj = path.join(dir, 'objects', JSON.parse(lines[0]).payload_ref.slice(7) + '.json');
  fs.writeFileSync(obj, JSON.stringify({value: 20}));
  assert.match(L.verify().why, /payload object missing or altered/);
}));

test('checkpoints let verification resume, while any edit before them is still caught', () => withLedger((L, dir) => {
  const hashes = [];
  for (let i = 0; i < 5; i++) hashes.push(L.append({kind: 'measure', payload: {value: i}, ...by(scout)}).hash);
  const entries = L.read();
  assert.deepEqual(entries.map(e => e.kind), ['genesis', 'measure', 'measure', CHECKPOINT, 'measure', 'measure', CHECKPOINT, 'measure'],
    'a checkpoint after every third entry');
  const full = L.verify({mode: 'full'}), frontier = L.verify({mode: 'frontier'});
  assert.deepEqual([full.ok, full.rederived, frontier.ok, frontier.rederived], [true, 5, true, 1], 'only the entry after the last checkpoint');
  L.append({kind: 'total', payload: {sum: 1}, derivedFrom: [hashes[1]], ...by(lead)});
  assert.equal(L.read().at(-1).kind, CHECKPOINT, 'the ninth entry is followed by a checkpoint');
  assert.deepEqual([L.verify({mode: 'frontier'}).rederived, L.verify({mode: 'full'}).rederived], [0, 6], 'only the frontier is re-derived');
  // Edit an entry well before the last checkpoint: the re-hash catches it.
  const file = path.join(dir, 'chain.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const e = JSON.parse(lines[1]); e.author.note = 'x';
  fs.writeFileSync(file, [lines[0], JSON.stringify(e), ...lines.slice(2)].join('\n') + '\n');
  assert.equal(L.verify({mode: 'frontier'}).ok, false);
}, {checkpointEvery: 3}));

test('an append refuses to extend a ledger that no longer verifies', () => withLedger((L, dir) => {
  L.append({kind: 'measure', payload: {value: 1}, ...by(scout)});
  const file = path.join(dir, 'chain.jsonl');
  const [g, line] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const e = JSON.parse(line); e.kind = 'total';
  fs.writeFileSync(file, g + '\n' + JSON.stringify(e) + '\n');
  assert.throws(() => L.append({kind: 'measure', payload: {value: 2}, ...by(scout)}), /does not verify, refusing to append/);
}));

test('K2: a ledger is trusted only through the genesis the reader pinned', () => withLedger((L, dir, anchor) => {
  L.append({kind: 'measure', payload: {value: 1}, ...by(scout)});
  assert.equal(L.verify().ok, true);
  assert.deepEqual(L.verify().authority.operators, ['operator']);
  // A forger rebuilds the same ledger under their own authority: it verifies only against its own anchor.
  const forged = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-ledger-forged-'));
  try {
    const forger = generateSigner('operator');
    createLedger({dir: forged, authority: {...authority, keyring: {...keyring, operator: forger.publicJwk}}, operator: forger, order: orderer});
    const asPinned = openLedger({dir: forged, kinds, anchor});
    assert.match(asPinned.verify().why, /not the pinned anchor/);
  } finally { fs.rmSync(forged, {recursive: true, force: true}); }
  assert.throws(() => openLedger({dir, kinds}), /pinned genesis hash/);
  assert.throws(() => createLedger({dir, authority, operator, order: orderer}), /already exists/);
}));

test('K2: only an operator changes the authority, and a revoked key signs nothing after it', () => withLedger(L => {
  L.append({kind: 'measure', payload: {value: 1}, ...by(scout)});
  assert.throws(() => L.append({kind: 'authority', payload: {revoke: ['seat:lead']}, ...by(scout)}), /only an operator/);
  assert.throws(() => L.append({kind: 'authority', payload: {revoke: ['controller']}, ...by(operator)}), /no valid orderer/);
  const fresh = generateSigner('seat:scout-2');
  L.append({kind: 'authority', payload: {add: {[fresh.key_id]: fresh.publicJwk}, revoke: ['seat:scout']}, ...by(operator)});
  assert.throws(() => L.append({kind: 'measure', payload: {value: 2}, ...by(scout)}), /not in the keyring/);
  L.append({kind: 'measure', payload: {value: 2}, ...by(fresh)});
  const v = L.verify();
  assert.equal(v.ok, true, 'entries signed before the revocation still verify');
  assert.equal(Object.hasOwn(v.authority.keys, 'seat:scout'), false);
}));
