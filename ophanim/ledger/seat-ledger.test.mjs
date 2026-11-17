// Seat conversation files checked against the ledger. At handoff seat-sdk recomputes a seat's chain from
// its own file, which is self-attesting: an exchange edited with its chain recomputed passes. With a
// ledger, every stored exchange must also be one of the ledger's turn entries for that seat, in order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openSystemLedger} from './system.mjs';
import {sdkTurn, unmatchedExchange} from '../../pantheon/src/sdk/seat-sdk.mjs';
import {record, replySha, promptSha} from '../../pantheon/src/context/chain.mjs';
import {seatKey} from '../../pantheon/src/seat/identity.mjs';

const MODEL = 'gpt-6-sol';
const LEDGER_SEAT = {seat_id: `openai-work@${MODEL}`, vendor: 'openai', mode: 'work', occupancy_gen: 1};
const stream = items => ({async *[Symbol.asyncIterator]() { for (const i of items) yield i; }});
function client() {
  let n = 0;
  return {responses: {inputTokens: {count: async () => ({input_tokens: 10})}, create: async req => {
    const prompt = typeof req.input === 'string' ? req.input : req.input?.at(-1)?.content ?? '';
    const text = `reply to ${prompt}`, id = `resp_${++n}`;
    const response = {id, model: MODEL, status: 'completed', output_text: text, output: [{type: 'message', content: [{type: 'output_text', text}]}]};
    return stream([{type: 'response.output_text.delta', delta: text}, {type: 'response.completed', response}]);
  }}};
}

async function withSeat(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-seat-ledger-'));
  try {
    const rec = openSystemLedger({root: path.join(dir, 'ledger')}).recorder();
    const home = path.join(dir, 'home'), cwd = path.join(dir, 'work');
    fs.mkdirSync(cwd, {recursive: true});
    const c = client();
    const ledger = {exchanges: () => rec.exchanges(LEDGER_SEAT.seat_id)};
    // One turn as runOpenItem takes it: sdkTurn persists the exchange, then the turn is recorded on the ledger.
    const turn = async (prompt, {withLedger = true, recordIt = true} = {}) => {
      const r = await sdkTurn({vendor: 'openai', purpose: 'work', cwd, prompt, model: MODEL, client: c, home, onEvent: () => {}, ...(withLedger ? {ledger} : {})});
      if (r.ok && recordIt) rec.recordTurn({seat: LEDGER_SEAT, requested_model: MODEL, served_model: r.result.served_model ?? null,
        response_id: r.result.response_id, reply: r.result.text, purpose: 'work', prompt, tools: r.result.tools});
      return r;
    };
    const file = path.join(home, 'seats', `${seatKey({vendor: 'openai', purpose: 'work', cwd})}.json`);
    // Edit the seat file the way a forger would: change the exchanges and recompute the chain, so the
    // self-attesting check at handoff still passes.
    const edit = change => {
      const held = JSON.parse(fs.readFileSync(file, 'utf8'));
      held.exchanges = change(held.exchanges);
      held.chain = record(held.exchanges);
      fs.writeFileSync(file, JSON.stringify(held, null, 2));
    };
    return await fn({turn, edit, file, rec});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('the ledger turn names the digests the seat file holds; an honest seat continues', () => withSeat(async ({turn, file, rec}) => {
  assert.equal((await turn('one')).ok, true);
  assert.equal((await turn('two')).ok, true);
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(held.exchanges.map(x => x.sha), [promptSha('one'), replySha('reply to one'), promptSha('two'), replySha('reply to two')]);
  assert.deepEqual(rec.exchanges(LEDGER_SEAT.seat_id).map(t => t.sha), held.exchanges.map(x => x.sha));
  assert.equal((await turn('three')).ok, true, 'every stored exchange is on the ledger, in order');
  assert.equal(rec.verify().ok, true);
}));

test('an edited seat file whose chain was recomputed is refused as LEDGER_MISMATCH', () => withSeat(async ({turn, edit}) => {
  await turn('one');
  await turn('two');
  edit(xs => xs.map((x, i) => (i === 1 ? {...x, sha: replySha('a reply the model never gave')} : x)));
  // The record is self-consistent, so the file-only check passes it (see the last test); the ledger does not.
  const r = await turn('three', {recordIt: false});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LEDGER_MISMATCH');
  assert.match(r.why, /stored exchange 1 \(assistant\)/);
  assert.equal(r.persisted, false);
}));

test('reordered, injected or unrecorded exchanges are refused; a forged prompt too', () => withSeat(async ({turn, edit, file}) => {
  await turn('one');
  await turn('two');
  const saved = fs.readFileSync(file, 'utf8');
  edit(xs => [...xs.slice(2), ...xs.slice(0, 2)]);
  assert.equal((await turn('x', {recordIt: false})).code, 'LEDGER_MISMATCH', 'reordered');
  fs.writeFileSync(file, saved);
  edit(xs => [...xs, {role: 'user', sha: promptSha('injected'), len: 8, tools: []}]);
  assert.equal((await turn('x', {recordIt: false})).code, 'LEDGER_MISMATCH', 'injected');
  fs.writeFileSync(file, saved);
  edit(xs => xs.map((x, i) => (i === 0 ? {...x, sha: promptSha('a prompt never sent')} : x)));
  assert.equal((await turn('x', {recordIt: false})).code, 'LEDGER_MISMATCH', 'forged prompt');
  fs.writeFileSync(file, saved);
  // A turn persisted to the seat file but never recorded on the ledger (a crash between the two).
  assert.equal((await turn('three', {recordIt: false})).ok, true);
  assert.equal((await turn('four')).code, 'LEDGER_MISMATCH', 'the unrecorded exchange stops the seat');
}));

test('without a ledger the handoff is unchanged: the self-attesting check alone', () => withSeat(async ({turn, edit, file}) => {
  await turn('one', {withLedger: false});
  edit(xs => xs.map((x, i) => (i === 1 ? {...x, sha: replySha('edited')} : x)));
  assert.equal((await turn('two', {withLedger: false})).ok, true, 'a consistent edit passes the file-only check');
  // ...while a chain left inconsistent is still refused by it, as before.
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  held.exchanges[1] = {...held.exchanges[1], sha: replySha('edited again')};
  fs.writeFileSync(file, JSON.stringify(held));
  assert.equal((await turn('three', {withLedger: false})).code, 'CHAIN_MISMATCH');
}));

test('unmatchedExchange: a subsequence of the ledger, in order; a turn recorded without its prompt digest matches any prompt', () => {
  const t = (role, sha) => ({role, sha});
  const ledger = [t('user', 'p1'), t('assistant', 'a1'), t('user', null), t('assistant', 'a2'), t('user', 'p3'), t('assistant', 'a3')];
  assert.equal(unmatchedExchange([t('user', 'p1'), t('assistant', 'a1')], ledger), null);
  assert.equal(unmatchedExchange([t('user', 'p3'), t('assistant', 'a3')], ledger), null, 'another pool may hold the earlier turns');
  assert.equal(unmatchedExchange([t('user', 'anything'), t('assistant', 'a2')], ledger), null);
  assert.equal(unmatchedExchange([t('assistant', 'a2'), t('assistant', 'a1')], ledger), 1);
  assert.equal(unmatchedExchange([t('user', 'p1'), t('assistant', 'zz')], ledger), 1);
});
