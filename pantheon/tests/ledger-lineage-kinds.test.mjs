// K4: turns and reviews with observed lineage, per-seat keys and cold review.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openLedger, createLedger, defineKinds, generateSigner} from '../../packages/ledger/chain.mjs';
import {lineageKinds, lineageRecorder, seatKeyId, labOf} from '../src/ledger/lineage-kinds.mjs';
import {sendTurn} from '../src/sdk/adapter.mjs';

const operator = generateSigner('operator'), controller = generateSigner('controller');
const authority = {keyring: {operator: operator.publicJwk, controller: controller.publicJwk}, orderer: 'controller', operators: ['operator']};

async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-ledger-lineage-'));
  try {
    const anchor = createLedger({dir, authority, operator, order: controller});
    const L = openLedger({dir, kinds: defineKinds(lineageKinds()), anchor});
    return await fn(L, lineageRecorder({ledger: L, operator, order: controller}));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const seat = (seat_id, vendor, occupancy_gen = 1) => ({seat_id, vendor, mode: 'work', occupancy_gen});
const impl = seat('openai-work', 'openai'), checker = seat('xai-critique', 'xai');

test('a turn is signed by the seat occupancy that answered, and records requested and served model', () => withLedger((L, R) => {
  const h = R.recordTurn({seat: impl, requested_model: 'gpt-6-sol', served_model: 'gpt-6-sol-2026-10-01', response_id: 'resp_1', reply: 'diff'});
  const e = L.read().find(x => L.hashOf(x) === h);
  assert.equal(e.author.key_id, seatKeyId(impl));
  assert.deepEqual([L.payloadOf(e).requested_model, L.payloadOf(e).served_model], ['gpt-6-sol', 'gpt-6-sol-2026-10-01']);
  assert.equal(L.verify().ok, true);
  // Another admitted key cannot sign as the implementer's seat.
  const other = generateSigner(seatKeyId(checker));
  L.append({kind: 'authority', payload: {add: {[other.key_id]: other.publicJwk}}, author: {key_id: 'operator'}, signer: operator, order: controller});
  const reply = 'forged diff', reply_sha = 'sha256:' + createHash('sha256').update(reply).digest('hex');
  assert.throws(() => L.append({kind: 'turn', payload: {seat: impl, requested_model: 'gpt-6-sol', served_model: null, response_id: 'resp_9', reply, reply_sha, purpose: null},
    author: {key_id: other.key_id}, signer: other, order: controller}), /not by the seat that answered/);
}));

test('a turn is refused when its reply, its id or its model does not hold', () => withLedger((L, R) => {
  R.recordTurn({seat: impl, requested_model: 'gpt-6-sol', response_id: 'resp_1', reply: 'one'});
  assert.throws(() => R.recordTurn({seat: impl, requested_model: 'gpt-6-sol', response_id: 'placeholder', reply: 'two'}), /placeholder/);
  assert.throws(() => R.recordTurn({seat: impl, requested_model: 'gpt-6-luna', response_id: 'resp_2', reply: 'two'}), /changed model .* without a new occupancy/);
  // A reseat is a new occupancy, with its own key.
  R.recordTurn({seat: {...impl, occupancy_gen: 2}, requested_model: 'gpt-6-luna', response_id: 'resp_3', reply: 'three'});
  assert.equal(L.verify().ok, true);
}));

test('cold review: no seat, lab or response in the lineage of what it reviews', () => withLedger((L, R) => {
  const plan = R.recordTurn({seat: seat('anthropic-plan', 'anthropic'), requested_model: 'claude-sonnet-5', response_id: 'msg_1', reply: 'plan'});
  const work = R.recordTurn({seat: impl, requested_model: 'gpt-6-sol', response_id: 'resp_1', reply: 'diff', cites: [plan]});
  // Cross-lab review of the work: accepted.
  R.recordReview({seat: checker, model: 'grok-4.6', response_id: 'x1', verdict: 'approve', targets: [work]});
  // Same lab as the implementer: refused.
  assert.throws(() => R.recordReview({seat: seat('openai-critique', 'openai'), model: 'gpt-6-luna', response_id: 'r9', verdict: 'approve', targets: [work]}),
    /openai lab is in the lineage/);
  // Transitively: the work cites an Anthropic plan, so no Anthropic model reviews it, including one served
  // through an agy seat (a lane model names its lab).
  assert.equal(labOf('agy_google', 'claude-sonnet-4-6'), 'anthropic');
  assert.throws(() => R.recordReview({seat: seat('agy-critique', 'agy_google'), model: 'claude-sonnet-4-6', response_id: 'a1', verdict: 'approve', targets: [work]}),
    /anthropic lab is in the lineage/);
  // A seat reviewing its own turn: refused even before the lab rule.
  assert.throws(() => R.recordReview({seat: impl, model: 'gpt-6-sol', response_id: 'r2', verdict: 'approve', targets: [work]}), /its own turn/);
  assert.equal(L.verify().ok, true);
}));

test('sendTurn reports the served model on every surface, unary and streamed', async () => {
  async function* iter(xs) { for (const x of xs) yield x; }
  const out = [{type: 'message', content: [{type: 'output_text', text: 'a'}]}];
  const responses = {responses: {create: async req => req.stream
    ? iter([{type: 'response.created', response: {id: 'r1', model: 'grok-4.6-0901'}}, {type: 'response.output_text.delta', delta: 'a'},
        {type: 'response.completed', response: {id: 'r1', status: 'completed', model: 'grok-4.6-0901', output: out}}])
    : {id: 'r1', status: 'completed', model: 'grok-4.6-0901', output_text: 'a', output: out}}};
  for (const onEvent of [undefined, () => {}]) {
    const r = await sendTurn({client: responses, vendor: 'xai', model: 'grok-4.6', prompt: 'q', onEvent});
    assert.equal(r.served_model, 'grok-4.6-0901');
  }
  const messages = {messages: {create: async req => req.stream
    ? iter([{type: 'message_start', message: {model: 'claude-haiku-4-5-20251001'}}, {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
        {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'a'}}, {type: 'message_delta', delta: {stop_reason: 'end_turn'}}, {type: 'message_stop'}])
    : {model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{type: 'text', text: 'a'}]}}};
  for (const onEvent of [undefined, () => {}]) {
    const r = await sendTurn({client: messages, vendor: 'anthropic', model: 'claude-haiku-4-5-20251001', prompt: 'q', history: [], onEvent});
    assert.equal(r.served_model, 'claude-haiku-4-5-20251001');
  }
  const genai = {models: {generateContent: async () => ({modelVersion: 'gemini-3.6-flash-001', candidates: [{finishReason: 'STOP', content: {role: 'model', parts: [{text: 'a'}]}}]})}};
  assert.equal((await sendTurn({client: genai, vendor: 'agy_google', model: 'gemini-3.6-flash', prompt: 'q', history: []})).served_model, 'gemini-3.6-flash-001');
  const silent = {responses: {create: async () => ({id: 'r1', status: 'completed', output_text: 'a', output: out})}};
  assert.equal((await sendTurn({client: silent, vendor: 'xai', model: 'grok-4.6', prompt: 'q'})).served_model, null, 'unreported stays null, never guessed');
});
