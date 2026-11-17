// K1: the ledger core. One chain, a closed kind registry, per-author signatures, re-derivation before
// every append and on every verify, strict reading, and checkpoints that let verification resume.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, CHECKPOINT} from '../chain.mjs';

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

test('view.entries() lists only the entries before the one being checked, in chain order', () => {
  // A `tally` must equal the number of measures written before it. It cites nothing, so it can only
  // count through entries(). Later entries never leak into an earlier entry's view.
  const seen = [];
  const counting = defineKinds({
    measure: {authors: () => true, validate: () => null, rederive: () => null},
    tally: {
      authors: () => true,
      validate: p => (Number.isInteger(p?.n) ? null : 'n must be an integer'),
      rederive: (e, view) => {
        const hashes = view.entries();
        seen.push(hashes.length);
        const n = hashes.filter(h => view.entry(h).kind === 'measure').length;
        return n === e.payload.n ? null : `there are ${n} earlier measures, not ${e.payload.n}`;
      },
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-ledger-view-'));
  try {
    const anchor = createLedger({dir, authority, operator, order: orderer});
    const L = openLedger({dir, kinds: counting, anchor});
    const by = s => ({author: {key_id: s.key_id}, signer: s, order: orderer});
    L.append({kind: 'measure', payload: {v: 1}, ...by(lead)});
    L.append({kind: 'tally', payload: {n: 1}, ...by(lead)});
    assert.throws(() => L.append({kind: 'tally', payload: {n: 2}, ...by(lead)}), /1 earlier measures, not 2/);
    L.append({kind: 'measure', payload: {v: 2}, ...by(scout)});
    L.append({kind: 'tally', payload: {n: 2}, ...by(lead)});
    seen.length = 0;
    assert.equal(L.verify().ok, true);
    assert.deepEqual(seen, [2, 4], 'on replay each tally sees the genesis and what came before it, nothing after');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// Independent review 2026-11-16, RU2: with write access to the directory and no legitimate key, a forger
// rewrites the chain as genesis -> forged authority (naming itself operator, orderer and seat) -> its own
// checkpoint -> its own entry. Frontier verification used to skip the authority entry's signature while
// applying it, so the forged checkpoint verified and append extended the forgery.
test('RU2: an authority entry before a checkpoint is verified, so a forger cannot name itself orderer', async () => {
  const {sign, createPrivateKey} = await import('node:crypto');
  const {canonical, digest} = await import('../canonical.mjs');
  const {LEDGER_SCHEMA} = await import('../chain.mjs');
  const H = v => 'sha256:' + digest(v);
  const bodyOf = e => ({schema: e.schema, kind: e.kind, author: e.author, derived_from: e.derived_from, payload_ref: e.payload_ref});
  const orderOf = e => ({seq: e.seq, parent: e.parent, body: H(bodyOf(e))});
  const sig = (v, pem) => sign(null, Buffer.from(canonical(v)), createPrivateKey(pem)).toString('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-ru2-'));
  try {
    const note = defineKinds({note: {authors: a => a.key_id === 'seat', validate: () => null, rederive: () => null}});
    const op = generateSigner('operator'), ord = generateSigner('orderer'), seat = generateSigner('seat');
    const anchor = createLedger({dir, operator: op, order: ord,
      authority: {keyring: {operator: op.publicJwk, orderer: ord.publicJwk, seat: seat.publicJwk}, orderer: 'orderer', operators: ['operator']}});
    openLedger({dir, kinds: note, anchor}).append({kind: 'note', payload: {text: 'honest'}, author: {key_id: 'seat'}, signer: seat, order: ord});
    const mallory = generateSigner('mallory'), file = path.join(dir, 'chain.jsonl');
    const genesis = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    const put = v => { fs.writeFileSync(path.join(dir, 'objects', H(v).slice(7) + '.json'), canonical(v)); return H(v); };
    const forge = (prev, seq, kind, author, payload) => {
      const e = {schema: LEDGER_SCHEMA, seq, parent: H(prev), kind, author: {key_id: author}, derived_from: [], payload_ref: put(payload)};
      e.author_sig = sig(bodyOf(e), mallory.privatePem); e.order_sig = sig(orderOf(e), mallory.privatePem); return e;
    };
    const auth = forge(genesis, 2, 'authority', 'operator', {add: {operator: mallory.publicJwk, orderer: mallory.publicJwk, seat: mallory.publicJwk}});
    const cp = forge(auth, 3, 'checkpoint', 'orderer', {through: 2, root: H({hashes: [H(genesis), H(auth)]})});
    const forged = forge(cp, 4, 'note', 'seat', {text: 'written without any legitimate key'});
    fs.writeFileSync(file, [genesis, auth, cp, forged].map(e => JSON.stringify(e) + '\n').join(''));
    const reader = openLedger({dir, kinds: note, anchor});
    for (const mode of ['frontier', 'full']) {
      const v = reader.verify({mode});
      assert.equal(v.ok, false, `${mode} verification refuses the forgery`);
      assert.match(v.why, /entry 1: .*signature invalid/);
    }
    assert.throws(() => reader.append({kind: 'note', payload: {text: 'again'}, author: {key_id: 'seat'},
      signer: {...mallory, key_id: 'seat'}, order: {...mallory, key_id: 'orderer'}}), /does not verify, refusing to append/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
