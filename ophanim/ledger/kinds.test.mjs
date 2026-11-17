// K3: facts, seating, escalation and contribution kinds, each re-derived on the ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner} from './chain.mjs';
import {pantheonKinds, currentFacts, currentSeating, escalationRecorder} from './kinds.mjs';
import {escalationRecord} from '../../pantheon/src/route/protocol.mjs';
import {chairContributions} from '../../pantheon/src/board/contributions.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {publish, putBlob} from '../../pantheon/src/board/dag.mjs';

const operator = generateSigner('operator'), controller = generateSigner('controller');
const authority = {keyring: {operator: operator.publicJwk, controller: controller.publicJwk}, orderer: 'controller', operators: ['operator']};
const by = s => ({author: {key_id: s.key_id}, signer: s, order: controller});
const authors = {inputs: a => a.key_id === 'operator', decisions: a => a.key_id === 'controller'};

async function withLedger(fn, {board = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-kinds-'));
  try {
    const anchor = createLedger({dir, authority, operator, order: controller});
    return await fn(openLedger({dir, kinds: defineKinds(pantheonKinds({authors, board})), anchor}));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

const rejected = {kind: 'acceptance', exit: 1};
const sol = {vendor: 'openai', model: 'gpt-6-sol'};

test('facts carry their evidence: an uncited figure is refused', () => withLedger(L => {
  L.append({kind: 'facts', payload: currentFacts(), ...by(operator)});
  const bad = currentFacts(); bad.models['gpt-6-sol'].window = {value: 1};
  assert.throws(() => L.append({kind: 'facts', payload: bad, ...by(operator)}), /gpt-6-sol\.window carries no source/);
  assert.throws(() => L.append({kind: 'facts', payload: currentFacts(), ...by(controller)}), /may not author "facts"/);
}));

test('seating cites the facts it seats, and every seated model is a fact or a lane', () => withLedger(L => {
  const f = L.append({kind: 'facts', payload: currentFacts(), ...by(operator)}).hash;
  L.append({kind: 'seating', payload: currentSeating(), derivedFrom: [f], ...by(operator)});
  assert.throws(() => L.append({kind: 'seating', payload: currentSeating(), ...by(operator)}), /exactly one facts entry/);
  const bad = {implementer: [{vendor: 'openai', model: 'gpt-7-imagined', basis: 'TASTE', why: 'x'}]};
  assert.throws(() => L.append({kind: 'seating', payload: bad, derivedFrom: [f], ...by(operator)}), /gpt-7-imagined is neither/);
}));

test('an escalation re-derives against the facts it CITES, not the code of the day', () => withLedger(L => {
  // A narrower fact: suppose the docs listed sol's efforts only up to `high`.
  const narrow = currentFacts();
  narrow.models['gpt-6-sol'].efforts = {...narrow.models['gpt-6-sol'].efforts, values: ['none', 'low', 'medium', 'high']};
  const f = L.append({kind: 'facts', payload: narrow, ...by(operator)}).hash;
  const s = L.append({kind: 'seating', payload: currentSeating(), derivedFrom: [f], ...by(operator)}).hash;
  // Decided under those facts: at `high` there is no effort left, so the protocol steps a rung.
  const rec = escalationRecord({role: 'implementer', seat: {...sol, effort: 'high'}, outcome: rejected, facts: narrow});
  assert.equal(rec.decision.action, 'step_rung');
  const first = L.append({kind: 'escalation', payload: rec, derivedFrom: [f, s], ...by(controller)}).hash;
  assert.equal(L.verify().ok, true, 'the current code would raise effort to xhigh; the cited facts say step a rung, and that is what re-derives');
  // The same decision citing nothing is refused; so is one that does not follow from what it cites.
  assert.throws(() => L.append({kind: 'escalation', payload: rec, ...by(controller)}), /cites the facts and the seating/);
  const wrong = escalationRecord({role: 'implementer', seat: {...sol, effort: 'high'}, outcome: rejected});   // current facts: raise_effort
  assert.throws(() => L.append({kind: 'escalation', payload: wrong, derivedFrom: [f, s], ...by(controller)}), /does not follow from its inputs/);
  // Chained by citation, the step count must continue.
  const next = escalationRecord({role: 'implementer', seat: {...rec.decision.to}, outcome: rejected, steps: 1, facts: narrow});
  L.append({kind: 'escalation', payload: next, derivedFrom: [f, s, first], ...by(controller)});
  const skipped = escalationRecord({role: 'implementer', seat: {...rec.decision.to}, outcome: rejected, steps: 3, facts: narrow});
  assert.throws(() => L.append({kind: 'escalation', payload: skipped, derivedFrom: [f, s, first], ...by(controller)}), /step count/);
}));

test('the recorder keeps the run annotations beside the record and chains decisions per piece of work', () => withLedger(L => {
  const r = escalationRecorder({ledger: L, controller, order: controller, operator});
  const a = escalationRecord({role: 'implementer', seat: sol, outcome: rejected});
  const h1 = r.record('slot:a', {slot: 'a', rev: 1, ...a});
  const b = escalationRecord({role: 'implementer', seat: {...a.decision.to}, outcome: rejected, steps: 1});
  const h2 = r.record('slot:a', {slot: 'a', rev: 2, ...b});
  const e2 = L.read().find(e => L.hashOf(e) === h2);
  assert.deepEqual(e2.derived_from, [r.inputs.facts, r.inputs.seating, h1]);
  assert.equal(L.payloadOf(e2).slot, undefined, 'notes are not part of the record');
  assert.equal(r.verify().ok, true);
}));

test('a contribution re-derives from the board heads it names, after the board has moved on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-kinds-board-'));
  try {
    const board = openBoard(root);
    const ref = 'refs/board/demo';
    const repro = exit => ({kind: 'repro', visibility: 'board', payload: {cmd: 'true', exit}, links: {excerpt: putBlob(board.store, Buffer.from(String(exit)))}});
    await publish({...board, ref, author: {vendor: 'controller'}, msg: 'one', budgetCheck: false, entries: [repro(0)]});
    const heads = board.refs.list().map(r => ({name: r.name, cid: r.cid}));
    const projection = chairContributions(board);
    await withLedger(async L => {
      L.append({kind: 'contribution', payload: {heads, projection}, ...by(controller)});
      await publish({...board, ref, author: {vendor: 'controller'}, msg: 'two', budgetCheck: false, entries: [repro(1)]});
      assert.equal(L.verify().ok, true, 'the named heads still produce the recorded projection');
      const forged = {...projection, chairs: projection.chairs.slice(1)};
      assert.throws(() => L.append({kind: 'contribution', payload: {heads, projection: forged}, ...by(controller)}), /not the one these heads produce/);
    }, {board});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
