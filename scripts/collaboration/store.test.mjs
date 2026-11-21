import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ophanim-collab-'));
  let now = 100000;
  const store = new Store(join(dir, 'messages.sqlite'), () => now);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file: join(dir, 'messages.sqlite'), advance: n => { now += n; } };
}
const message = overrides => ({ from: 'codex', to: 'claude', key: 'request-1', subject: 'Review collaboration transport', text: 'Please inspect the source.', ...overrides });

test('messages survive reopening; polling never acknowledges them', t => {
  const { store, file } = fixture(t);
  const sent = store.send(message());
  const other = new Store(file);
  try {
    assert.equal(other.inbox('claude')[0].id, sent.id);
    assert.equal(other.inbox('claude')[0].acknowledged_at, null);
  } finally { other.close(); }
  assert.equal(store.inbox('claude').length, 1);
});

test('repeated request keys deduplicate; changed payloads conflict', t => {
  const { store } = fixture(t);
  assert.equal(store.send(message()).id, store.send(message()).id);
  assert.throws(() => store.send(message({ text: 'Changed request' })), /conflict/i);
  assert.equal(store.inbox('claude').length, 1);
});

test('delivery and acknowledgement are distinct, recipient acknowledgements are idempotent', t => {
  const { store } = fixture(t), sent = store.send(message());
  assert.throws(() => store.ack('codex', sent.id, 'read'), /recipient/i);
  store.beginDelivery(sent.id, 'github');
  store.finishDelivery(sent.id, 'delivered', { url: 'https://github.com/example/comment' });
  assert.equal(store.inbox('claude')[0].acknowledged_at, null);
  store.ack('claude', sent.id, 'Read and accepted the review task.');
  store.ack('claude', sent.id, 'Read and accepted the review task.');
  assert.equal(store.inbox('claude').length, 0);
  assert.equal(store.events(sent.id).filter(e => e.kind === 'acknowledged').length, 1);
});

test('an interrupted delivery is held until evidence reconciles it', t => {
  const { store } = fixture(t), sent = store.send(message());
  store.beginDelivery(sent.id, 'github');
  assert.throws(() => store.beginDelivery(sent.id, 'github'), /claimed|delivery/i);
  store.recoverDeliveries('github');
  assert.equal(store.get(sent.id).delivery_state, 'uncertain');
  assert.equal(store.outbox('github').length, 0);
  store.finishDelivery(sent.id, 'delivered', { url: 'https://github.com/example/reconciled' });
  assert.equal(store.get(sent.id).delivery_state, 'delivered');
});

test('leases prevent a second owner and fence expired owners', t => {
  const { store, advance } = fixture(t);
  const first = store.claim('task:relay-review', 'codex', 1000);
  assert.throws(() => store.claim('task:relay-review', 'claude', 1000), /claimed/i);
  advance(1001);
  const second = store.claim('task:relay-review', 'claude', 1000);
  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => store.release('task:relay-review', 'codex', first.token), /stale/i);
  assert.throws(() => store.renew('task:relay-review', 'codex', first.token, 1000), /stale/i);
  assert.equal(store.release('task:relay-review', 'claude', second.token).released, true);
});

test('oversized messages, unknown agents and missing reply targets are rejected', t => {
  const { store } = fixture(t);
  assert.throws(() => store.send(message({ text: 'a'.repeat(32769) })), /size|long/i);
  assert.throws(() => store.send(message({ from: 'unregistered' })), /agent/i);
  assert.throws(() => store.send(message({ replyTo: 'missing' })), /reply/i);
});

test('GitHub imports require the configured author and marker, and deduplicate', t => {
  const { store } = fixture(t);
  const sent = store.send(message());
  const reply = { id: 101, user: { login: 'dsmcewan' }, html_url: 'https://github.com/example/101', body: `OPHANIM-COLLAB REPLY\nACK ${sent.id}\nI will inspect it.` };
  assert.equal(store.importComment({ ...reply, user: { login: 'stranger' } }, ['dsmcewan']), null);
  assert.equal(store.importComment({ ...reply, body: 'Unrelated PR discussion' }, ['dsmcewan']), null);
  const imported = store.importComment(reply, ['dsmcewan']);
  assert.equal(store.importComment(reply, ['dsmcewan']).id, imported.id);
  assert.equal(store.get(sent.id).acknowledged_at, 100000);
  assert.equal(store.inbox('codex').length, 1);
  assert.equal(store.inbox('codex')[0].provenance.author, 'dsmcewan');
});

test('unknown or mismatched GitHub ACK does not acknowledge another recipient', t => {
  const { store } = fixture(t), sent = store.send(message({ from: 'claude', to: 'codex' }));
  store.importComment({ id: 102, user: { login: 'dsmcewan' }, body: `OPHANIM-COLLAB ACK ${sent.id}` }, ['dsmcewan']);
  assert.equal(store.get(sent.id).acknowledged_at, null);
});

test('edited GitHub replies retain both immutable message versions', t => {
  const { store } = fixture(t);
  const comment = { id: 103, user: { login: 'dsmcewan' }, body: 'OPHANIM-COLLAB REPLY\nOriginal finding' };
  const first = store.importComment(comment, ['dsmcewan']);
  const edited = store.importComment({ ...comment, body: 'OPHANIM-COLLAB REPLY\nCorrected finding' }, ['dsmcewan']);
  assert.notEqual(first.id, edited.id);
  assert.equal(store.get(first.id).text, comment.body);
  assert.equal(store.inbox('codex').length, 2);
});
