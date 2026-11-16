// K2: the system chain anchors the board DAG and TELOS proposal chains, and re-derives each anchor by
// reading that ledger again. Rewriting either underlying ledger breaks verification.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openLedger, createLedger, defineKinds, generateSigner} from './chain.mjs';
import {anchorKinds, boardResolver, telosResolver} from './anchors.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {publish, putBlob} from '../../pantheon/src/board/dag.mjs';

const operator = generateSigner('operator'), orderer = generateSigner('controller');
const authority = {keyring: {operator: operator.publicJwk, controller: orderer.publicJwk}, orderer: 'controller', operators: ['operator']};
const by = s => ({author: {key_id: s.key_id}, signer: s, order: orderer});
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), name));

test('a board commit is anchored while it stays in the ref history, and a rewrite breaks the anchor', async () => {
  const root = tmp('ophanim-anchor-board-'), dir = tmp('ophanim-anchor-ledger-');
  try {
    const board = openBoard(root);
    const ref = 'refs/board/demo';
    const seat = {vendor: 'controller'};
    const repro = exit => ({kind: 'repro', visibility: 'board', payload: {cmd: 'true', exit},
      links: {excerpt: putBlob(board.store, Buffer.from(`exit ${exit}`))}});
    const one = await publish({...board, ref, author: seat, msg: 'one', budgetCheck: false,
      entries: [repro(0)]});
    assert.equal(one.ok, true, one.why);
    const anchor = createLedger({dir, authority, operator, order: orderer});
    const L = openLedger({dir, kinds: defineKinds(anchorKinds({board: boardResolver(board)})), anchor});
    const commit = board.refs.resolve(ref);
    L.append({kind: 'board.anchor', payload: {ref, commit}, ...by(orderer)});
    assert.throws(() => L.append({kind: 'board.anchor', payload: {ref, commit: 'commit:' + 'f'.repeat(64)}, ...by(orderer)}), /no longer in/);
    // The board moves on: the anchored commit is still in history, so the anchor still re-derives.
    await publish({...board, ref, author: seat, msg: 'two', budgetCheck: false,
      entries: [repro(1)]});
    assert.equal(L.verify().ok, true);
    // Point the ref at an unrelated history (a rewrite): the anchor no longer re-derives.
    const rewritten = openLedger({dir, kinds: defineKinds(anchorKinds({board: {reaches: () => false}})), anchor});
    assert.match(rewritten.verify().why, /does not re-derive: commit .* is no longer in refs\/board\/demo/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(dir, {recursive: true, force: true}); }
});

const TELOS_ROOT = process.env.OPHANIM_TELOS_ROOT;
test('a TELOS proposal head is anchored and re-derived by the pinned TELOS code', {skip: !TELOS_ROOT && 'OPHANIM_TELOS_ROOT not set'}, async () => {
  const work = tmp('ophanim-anchor-telos-'), dir = tmp('ophanim-anchor-ledger-');
  try {
    const telos = await import(pathToFileURL(path.join(TELOS_ROOT, 'merkle-dag/proposal-ledger.mjs')).href);
    const {generateKeypair} = await import(pathToFileURL(path.join(TELOS_ROOT, 'merkle-dag/crypto.mjs')).href);
    const keys = generateKeypair();
    const telosDir = path.join(work, '.telos');
    const proposal_id = telos.deriveProposalId(['sha256:' + 'a'.repeat(64)]);
    const add = stage => telos.atomicAppendProposalEvent(telosDir,
      (parent_event_hash, sequence) => telos.makeProposalEvent({proposal_id, stage, sequence, parent_event_hash}, keys.privatePem), {publicJwk: keys.publicJwk});
    add('draft'); add('negotiation');
    const resolver = await telosResolver({telosRoot: TELOS_ROOT, dirFor: () => telosDir, publicJwk: keys.publicJwk});
    const anchor = createLedger({dir, authority, operator, order: orderer});
    const L = openLedger({dir, kinds: defineKinds(anchorKinds({telos: resolver})), anchor});
    const head = resolver.head(proposal_id);
    L.append({kind: 'telos.anchor', payload: {proposal_id, ...head}, ...by(orderer)});
    assert.throws(() => L.append({kind: 'telos.anchor', payload: {proposal_id, events: 2, head: 'sha256:' + '0'.repeat(64)}, ...by(orderer)}), /not the anchored head/);
    add('candidate');                                    // TELOS grows: the anchored prefix still holds
    assert.equal(L.verify().ok, true);
    // Rewrite TELOS's own ledger. Truncated to one event it is still a valid TELOS chain, but shorter than
    // the anchored head; reordered, TELOS itself refuses it. Either way the anchor stops re-deriving.
    const file = path.join(telosDir, 'proposal.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(file, lines[0] + '\n');
    assert.match(L.verify().why, /fewer than the 2 anchored/);
    fs.writeFileSync(file, [lines[0], lines[2], lines[1]].join('\n') + '\n');
    assert.match(L.verify().why, /TELOS chain does not verify/);
  } finally { fs.rmSync(work, {recursive: true, force: true}); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the TELOS resolver loads only the pinned source', async () => {
  const fake = tmp('ophanim-fake-telos-');
  try {
    fs.mkdirSync(path.join(fake, 'merkle-dag'), {recursive: true});
    fs.writeFileSync(path.join(fake, 'merkle-dag/proposal-ledger.mjs'), 'export const readProposalEvents = () => ({events: [], errors: []});');
    await assert.rejects(telosResolver({telosRoot: fake, dirFor: () => fake, publicJwk: {}}), /differs from the pin/);
  } finally { fs.rmSync(fake, {recursive: true, force: true}); }
});
