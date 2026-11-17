// Domains: one ledger, the kinds of several domains. The authority declares each domain's kinds; a reader
// re-derives the domains it supplies, checks a declared domain it does not supply structurally only,
// never appends it, and says so in the verify result. A kind no domain declared is refused, as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, AUTHORITY, domainOf} from '../chain.mjs';
import {openLedgerHome, CONTROLLER} from '../home.mjs';

const operator = generateSigner('operator'), controller = generateSigner('controller');
const keyring = {operator: operator.publicJwk, controller: controller.publicJwk};
const by = s => ({author: {key_id: s.key_id}, signer: s, order: controller});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-domains-'));

// Domain "a": a measure. Domain "b": a total that must equal the measures it cites.
const measure = {authors: () => true, validate: p => (Number.isInteger(p?.value) ? null : 'value must be an integer'), rederive: () => null};
const total = {authors: () => true, validate: p => (Number.isInteger(p?.sum) ? null : 'sum must be an integer'),
  rederive: (e, view) => {
    const sum = e.derived_from.reduce((s, h) => s + view.payload(h).value, 0);
    return sum === e.payload.sum ? null : `cited measures sum to ${sum}, not ${e.payload.sum}`;
  }};
const both = defineKinds({measure, total}), onlyA = defineKinds({measure});
const DOMAINS = {a: ['measure'], b: ['total']};

function withLedger(fn, {domains = DOMAINS} = {}) {
  const dir = tmp();
  try {
    const anchor = createLedger({dir, authority: {keyring, orderer: 'controller', operators: ['operator'], ...(domains ? {domains} : {})}, operator, order: controller});
    return fn({dir, anchor, writer: openLedger({dir, kinds: both, anchor}), reader: openLedger({dir, kinds: onlyA, anchor})});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a reader checks a declared domain it does not supply structurally, reports it, and never appends it', () => withLedger(({writer, reader}) => {
  const m = writer.append({kind: 'measure', payload: {value: 2}, ...by(controller)}).hash;
  writer.append({kind: 'total', payload: {sum: 2}, derivedFrom: [m], ...by(controller)});
  const w = writer.verify();
  assert.deepEqual([w.ok, w.rederived, w.complete, w.foreign], [true, 2, true, {}]);
  const r = reader.verify();
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.rederived, r.foreign, r.complete], [1, {b: 1}, false], 'the total is passed over, and the result says so');
  assert.throws(() => reader.append({kind: 'total', payload: {sum: 2}, derivedFrom: [m], ...by(controller)}), /belongs to domain "b", which this registry does not supply/);
  reader.append({kind: 'measure', payload: {value: 5}, ...by(controller)});
  assert.equal(writer.verify().complete, true, 'the writer still re-derives everything');
  assert.equal(domainOf(r.authority.domains, 'total'), 'b');
}));

test('a forged foreign entry is refused structurally: an altered payload, a forged signature, an unknown author', () => withLedger(({dir, writer, anchor}) => {
  const m = writer.append({kind: 'measure', payload: {value: 2}, ...by(controller)}).hash;
  writer.append({kind: 'total', payload: {sum: 2}, derivedFrom: [m], ...by(controller)});
  const file = path.join(dir, 'chain.jsonl');
  const honest = fs.readFileSync(file, 'utf8');
  const lines = honest.trimEnd().split('\n').map(l => JSON.parse(l));
  const reread = () => openLedger({dir, kinds: onlyA, anchor}).verify();
  // The payload object edited in place: its digest no longer matches.
  const obj = path.join(dir, 'objects', lines[2].payload_ref.slice(7) + '.json');
  const kept = fs.readFileSync(obj, 'utf8');
  fs.writeFileSync(obj, JSON.stringify({sum: 3}));
  assert.match(reread().why, /payload object missing or altered/);
  fs.writeFileSync(obj, kept);
  // The entry pointed at another payload: the author signature no longer covers it.
  const swapped = {...lines[2], payload_ref: lines[1].payload_ref};
  fs.writeFileSync(file, [lines[0], lines[1], swapped].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.match(reread().why, /author signature invalid|order signature invalid/);
  // Signed by a key the ledger's authority never admitted.
  fs.writeFileSync(file, [lines[0], lines[1], {...lines[2], author: {key_id: 'stranger'}}].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.match(reread().why, /not in the keyring|signature invalid/);
  fs.writeFileSync(file, honest);
  assert.equal(reread().ok, true, 'the honest chain is accepted');
}));

test('the registry stays closed: an undeclared kind, an incomplete composition and a kind in two domains are refused', () => {
  // Nothing declared: an unknown kind is refused, as it always was.
  withLedger(({writer, reader}) => {
    writer.append({kind: 'total', payload: {sum: 0}, ...by(controller)});
    assert.match(reader.verify().why, /kind "total" is not in the registry, and no domain declared before it names it/);
  }, {domains: null});
  // A reader that claims domain "b" must re-derive it, not pass over it.
  withLedger(({dir, anchor, writer}) => {
    writer.append({kind: 'total', payload: {sum: 0}, ...by(controller)});
    assert.match(openLedger({dir, kinds: onlyA, anchor, domains: ['a', 'b']}).verify().why, /of domain "b" is not in the registry, which supplies that domain/);
    // An authority entry may not put a declared kind into a second domain.
    assert.throws(() => writer.append({kind: AUTHORITY, payload: {domains: {c: ['total']}}, ...by(operator)}), /declares a kind in two domains/);
    assert.throws(() => writer.append({kind: AUTHORITY, payload: {domains: {c: ['genesis']}}, ...by(operator)}), /a domain declaration names/);
    assert.throws(() => writer.append({kind: AUTHORITY, payload: {domains: {c: ['x']}}, ...by(controller)}), /only an operator changes the authority/);
  });
  assert.throws(() => createLedger({dir: tmp(), authority: {keyring, orderer: 'controller', operators: ['operator'], domains: {a: ['measure'], b: ['measure']}}, operator, order: controller}), /one domain only/);
});

test('a declaration applies from its entry on, and a kind can report a part it could not re-derive', () => withLedger(({dir, anchor, writer}) => {
  writer.append({kind: AUTHORITY, payload: {domains: {b: ['total']}}, ...by(operator)});
  writer.append({kind: 'total', payload: {sum: 0}, ...by(controller)});
  const r = openLedger({dir, kinds: onlyA, anchor}).verify();
  assert.deepEqual([r.ok, r.foreign], [true, {b: 1}]);
  // view.note: accepted, and reported in `partial`.
  const noting = defineKinds({measure: {...measure, rederive: (e, view) => { view.note('the input is gone'); return null; }}, total});
  const N = openLedger({dir, kinds: noting, anchor});
  const out = N.append({kind: 'measure', payload: {value: 1}, ...by(controller)});
  assert.deepEqual(out.partial.map(p => p.why), ['the input is gone']);
  const v = N.verify();
  assert.deepEqual([v.ok, v.complete, v.partial.length], [true, false, 1]);
}, {domains: {a: ['measure']}}));

test('the ledger home declares a composition\'s domains: in genesis, and before the first entry of one added later', () => {
  const dir = tmp(), root = path.join(dir, 'ledger');
  try {
    const A = openLedgerHome({root, kinds: onlyA, domains: {a: ['measure']}});
    A.ledger.append({kind: 'measure', payload: {value: 1}, author: {key_id: CONTROLLER}, signer: A.controller, order: A.controller});
    assert.deepEqual(A.ledger.verify().authority.domains, {a: ['measure']});
    const B = openLedgerHome({root, kinds: both, domains: DOMAINS});
    assert.equal(B.ledger.read().length, 2, 'opening does not write');
    const m = B.ledger.read()[1];
    B.ledger.append({kind: 'total', payload: {sum: 1}, derivedFrom: [B.ledger.hashOf(m)], author: {key_id: CONTROLLER}, signer: B.controller, order: B.controller});
    assert.deepEqual(B.ledger.read().map(e => e.kind), ['genesis', 'measure', 'authority', 'total'], 'domain "b" is declared just before its first entry');
    const again = openLedgerHome({root, kinds: onlyA, domains: {a: ['measure']}}).ledger.verify();
    assert.deepEqual([again.ok, again.foreign], [true, {b: 1}]);
    assert.throws(() => openLedgerHome({root, kinds: both, domains: {a: ['measure']}}), /kind "total" is in 0 of the supplied domains/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
