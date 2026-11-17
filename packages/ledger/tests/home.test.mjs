// The ledger home, kind-free: created on first use with its genesis pinned, keys held owner-only outside
// the chain, refused when it is not the pinned ledger or its keys are exposed or swapped, keys rotatable.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedgerHome, keyStore, OPERATOR, CONTROLLER, defineKinds, generateSigner} from '../index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-home-'));
const mode = f => fs.statSync(f).mode & 0o777;
const kinds = defineKinds({note: {authors: () => true, validate: p => (typeof p?.text === 'string' ? null : 'a note has text'), rederive: () => null}});

test('first use creates the ledger, pins its genesis and holds the keys owner-only, outside the chain', () => {
  const dir = tmp(), root = path.join(dir, 'ledger');
  try {
    const a = openLedgerHome({root, kinds});
    assert.match(a.anchor, /^sha256:[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim(), a.anchor);
    assert.equal(mode(path.join(root, 'keys')), 0o700);
    for (const f of fs.readdirSync(path.join(root, 'keys'))) assert.equal(mode(path.join(root, 'keys', f)), 0o600);
    assert.equal(fs.readFileSync(path.join(root, 'chain.jsonl'), 'utf8').includes('PRIVATE KEY'), false);
    assert.deepEqual([a.operator.key_id, a.controller.key_id], [OPERATOR, CONTROLLER]);
    a.ledger.append({kind: 'note', payload: {text: 'one'}, author: {key_id: CONTROLLER}, signer: a.controller, order: a.controller});
    const b = openLedgerHome({root, kinds});
    assert.equal(b.anchor, a.anchor, 'reopened, not recreated');
    assert.equal(b.ledger.read().length, 2);
    // An undefined (non-frozen) registry is checked by defineKinds; a reserved kind is refused.
    assert.throws(() => openLedgerHome({root, kinds: {genesis: {}}}), /reserved/);
    assert.throws(() => openLedgerHome({root}), /kind registry is required/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('a home is refused when it is not the pinned one, has lost its anchor, or its keys are exposed or swapped', () => {
  const dir = tmp(), root = path.join(dir, 'ledger');
  try {
    const {anchor} = openLedgerHome({root, kinds});
    assert.throws(() => openLedgerHome({root, kinds, anchor: 'sha256:' + '0'.repeat(64)}), /not the one the caller pinned/);
    assert.throws(() => openLedgerHome({root, kinds, anchor: 'nope'}), /sha256 genesis hash/);
    assert.equal(openLedgerHome({root, kinds, anchor}).anchor, anchor);
    assert.throws(() => openLedgerHome({root: path.join(dir, 'none'), kinds, anchor}), /does not exist here/);
    openLedgerHome({root: path.join(dir, 'other'), kinds});
    fs.copyFileSync(path.join(dir, 'other', 'keys', 'operator.json'), path.join(root, 'keys', 'operator.json'));
    assert.throws(() => openLedgerHome({root, kinds}), /not the one the ledger's authority names/);
    fs.chmodSync(path.join(root, 'keys', 'operator.json'), 0o644);
    assert.throws(() => openLedgerHome({root, kinds}), /readable by others/);
    fs.rmSync(path.join(root, 'ANCHOR'));
    assert.throws(() => openLedgerHome({root, kinds}), /without its ANCHOR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('rotateKey revokes an admitted key and admits a new one; earlier entries still verify', () => {
  const dir = tmp(), root = path.join(dir, 'ledger');
  try {
    const h = openLedgerHome({root, kinds});
    const first = h.rotateKey('writer');
    h.ledger.append({kind: 'note', payload: {text: 'by the first key'}, author: {key_id: 'writer'}, signer: first, order: h.controller});
    const second = h.rotateKey('writer');
    assert.notEqual(second.publicJwk.x, first.publicJwk.x);
    assert.equal(h.keys.get('writer').publicJwk.x, second.publicJwk.x, 'the store holds the new key');
    assert.throws(() => h.ledger.append({kind: 'note', payload: {text: 'old key'}, author: {key_id: 'writer'}, signer: first, order: h.controller}), /author signature invalid/);
    h.ledger.append({kind: 'note', payload: {text: 'by the second key'}, author: {key_id: 'writer'}, signer: second, order: h.controller});
    const v = h.ledger.verify();
    assert.equal(v.ok, true, v.why);
    assert.deepEqual(h.ledger.read().filter(e => e.kind === 'authority').length, 3, 'admit, revoke, admit');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the key store refuses to overwrite a held key except by explicit rotation', () => {
  const dir = tmp();
  try {
    const ks = keyStore(path.join(dir, 'keys'));
    ks.put(generateSigner('a'));
    assert.throws(() => ks.put(generateSigner('a')), /already held/);
    ks.replace({key_id: 'a', privatePem: 'y', publicJwk: {}});
    assert.equal(ks.get('a').privatePem, 'y');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
