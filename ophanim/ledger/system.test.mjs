// The ledger by default: created on first use with its genesis pinned, keys held owner-only outside the
// chain, inputs recorded once across runs, seat keys kept across runs and rotatable.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openSystemLedger, keyStore} from './system.mjs';
import {seatKeyId} from './lineage-kinds.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-system-ledger-'));
const mode = f => fs.statSync(f).mode & 0o777;

test('first use creates the ledger, pins its genesis and holds the keys owner-only, outside the chain', () => {
  const root = path.join(tmp(), 'ledger');
  try {
    const a = openSystemLedger({root});
    assert.match(a.anchor, /^sha256:[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim(), a.anchor);
    assert.equal(mode(path.join(root, 'keys')), 0o700);
    for (const f of fs.readdirSync(path.join(root, 'keys'))) assert.equal(mode(path.join(root, 'keys', f)), 0o600);
    assert.equal(fs.readFileSync(path.join(root, 'chain.jsonl'), 'utf8').includes('PRIVATE KEY'), false, 'no private key on the chain');
    const b = openSystemLedger({root});
    assert.equal(b.anchor, a.anchor, 'reopened, not recreated');
    assert.equal(b.ledger.read().length, 1);
  } finally { fs.rmSync(path.dirname(root), {recursive: true, force: true}); }
});

test('a ledger is refused when it is not the pinned one, has lost its anchor, or its keys are exposed or swapped', () => {
  const dir = tmp(), root = path.join(dir, 'ledger');
  try {
    const {anchor} = openSystemLedger({root});
    assert.throws(() => openSystemLedger({root, anchor: 'sha256:' + '0'.repeat(64)}), /not the one the caller pinned/);
    assert.equal(openSystemLedger({root, anchor}).anchor, anchor);
    assert.throws(() => openSystemLedger({root: path.join(dir, 'none'), anchor}), /does not exist here/);
    // A swapped operator key: the held key is not the one the genesis names.
    const keys = path.join(root, 'keys');
    openSystemLedger({root: path.join(dir, 'other')});
    fs.copyFileSync(path.join(dir, 'other', 'keys', 'operator.json'), path.join(keys, 'operator.json'));
    assert.throws(() => openSystemLedger({root}), /not the one the ledger's authority names/);
    // A key readable by others is refused, not used.
    fs.chmodSync(path.join(keys, 'operator.json'), 0o644);
    assert.throws(() => openSystemLedger({root}), /readable by others/);
    // No anchor, but a chain: refused rather than trusted.
    fs.rmSync(path.join(root, 'ANCHOR'));
    assert.throws(() => openSystemLedger({root}), /without its ANCHOR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('across runs: inputs are recorded once and a seat keeps its key until it is rotated', () => {
  const root = path.join(tmp(), 'ledger');
  try {
    const seat = {seat_id: 'openai-work@gpt-6-sol', vendor: 'openai', mode: 'work', occupancy_gen: 1};
    const first = openSystemLedger({root}).recorder();
    first.recordTurn({seat, requested_model: 'gpt-6-sol', response_id: 'resp_1', reply: 'one'});
    const second = openSystemLedger({root}).recorder();
    second.recordTurn({seat, requested_model: 'gpt-6-sol', response_id: 'resp_2', reply: 'two'});
    const L = second.ledger;
    const kinds = L.read().map(e => e.kind);
    assert.equal(kinds.filter(k => k === 'facts').length, 1, 'facts recorded once, reused by the second run');
    assert.equal(kinds.filter(k => k === 'seating').length, 1);
    assert.equal(kinds.filter(k => k === 'authority').length, 1, 'the seat key was admitted once and reused');
    const turns = L.read().filter(e => e.kind === 'turn');
    assert.equal(new Set(turns.map(e => e.author.key_id)).size, 1);
    // Rotation: the old key is revoked, a new one admitted; earlier turns still verify.
    second.rotateSeatKey(seat);
    const third = openSystemLedger({root}).recorder();
    third.recordTurn({seat, requested_model: 'gpt-6-sol', response_id: 'resp_3', reply: 'three'});
    const v = third.verify();
    assert.equal(v.ok, true, v.why);
    assert.ok(v.authority.keys[seatKeyId(seat)]);
    assert.deepEqual(L.read().filter(e => e.kind === 'authority').length, 3, 'admit, revoke, admit');
  } finally { fs.rmSync(path.dirname(root), {recursive: true, force: true}); }
});

test('the key store refuses to overwrite a held key except by explicit rotation', () => {
  const dir = tmp();
  try {
    const ks = keyStore(path.join(dir, 'keys'));
    ks.put({key_id: 'a', privatePem: 'x', publicJwk: {}});
    assert.throws(() => ks.put({key_id: 'a', privatePem: 'y', publicJwk: {}}), /already held/);
    ks.replace({key_id: 'a', privatePem: 'y', publicJwk: {}});
    assert.equal(ks.get('a').privatePem, 'y');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
