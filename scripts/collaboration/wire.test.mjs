// Issue #99: the wire format of collaboration replies. A reply's visible body opens with the sender's identity banner;
// its protocol metadata (kind, acknowledged message IDs) is a strict typed HTML footer on the LAST line, so an ACK ID
// keeps its own boundary however GitHub renders the prose around it. Legacy first-line replies already in flight still
// import. A malformed, concatenated or cross-target ACK never marks a message read. Synthetic stores only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wire from './store.mjs';
import * as bridge from './github-bridge.mjs';

const { Store, replyHeader } = wire;
const IDENTITY = '**[Seat: Claude · Model: (stated by the sender) · Role: Implementer]**';
const BANNER = `> ${IDENTITY}`;
const SCHEMA = 'ophanim.collaboration.reply/v2';
const footer = obj => `<!-- ophanim-collab-reply ${JSON.stringify(obj)} -->`;
const v2 = (acks, { kind = 'REPLY', text = 'Read; working on it.', banner = BANNER } = {}) => `${banner}\n\n${text}\n\n${footer({ schema: SCHEMA, kind, ack: acks })}`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ophanim-collab-wire-'));
  const store = new Store(join(dir, 'mail.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const toClaude = store => store.send({ from: 'codex', to: 'claude', key: `k-${Math.random()}`, text: 'Inspect it.' });
let n = 500;
const comment = body => ({ id: n++, user: { login: 'owner' }, html_url: `https://github.com/test/${n}`, body });

test('wire: a reply that opens with its identity banner acknowledges through its typed footer, and records the asserted identity', t => {
  const store = fixture(t), a = toClaude(store), b = toClaude(store);
  const imported = store.importComment(comment(v2([a.id, b.id])), ['owner']);
  assert.ok(imported, 'the reply is imported');
  assert.notEqual(store.get(a.id).acknowledged_at, null);
  assert.notEqual(store.get(b.id).acknowledged_at, null);
  assert.equal(imported.provenance.asserted_identity, IDENTITY);
  assert.deepEqual(replyHeader(v2([a.id], { kind: 'ACK' })), { kind: 'ACK', acknowledgements: [a.id], format: 'v2', identity: IDENTITY });
});

test('wire: formatReply round-trips -- banner first, footer last, each ACK ID on its own boundary whatever the prose says', () => {
  const ids = ['1c85d58a-a8e9-436c-b569-869c3fc0be34', '0d026120-7ffe-48dc-9987-0e21df0733d9'];
  const text = `ACK ${ids[0]}Read and acting -- this prose names an ID\nACK ${ids[1]}\nand ends without a newline`;
  const body = wire.formatReply({ banner: BANNER, text, acks: ids });
  const lines = body.trimEnd().split('\n');
  assert.equal(lines[0], BANNER);
  assert.equal(lines.at(-1), footer({ schema: SCHEMA, kind: 'REPLY', ack: ids }));
  assert.deepEqual(replyHeader(body), { kind: 'REPLY', acknowledgements: ids, format: 'v2', identity: IDENTITY });
  assert.deepEqual(replyHeader(wire.formatReply({ banner: BANNER, text: 'No ACK.', acks: [] })).acknowledgements, []);
  assert.throws(() => wire.formatReply({ banner: BANNER, text: 'x', acks: [`${ids[0]}Read`] }), wire.MessageRefused, 'a concatenated ID is refused by the formatter');
  assert.throws(() => wire.formatReply({ banner: 'Claude here', text: 'x', acks: [] }), wire.MessageRefused, 'the banner is required');
});

test('wire: a concatenated, malformed or misplaced ACK never marks a message read', t => {
  const store = fixture(t), a = toClaude(store);
  for (const [what, body] of [
    ['legacy ACK with prose joined to the ID', `OPHANIM-COLLAB REPLY\nACK ${a.id}Read and acting.`],
    ['legacy ACK with trailing prose', `OPHANIM-COLLAB REPLY\nACK ${a.id} read, acting`],
    ['legacy header ACK with prose joined', `OPHANIM-COLLAB ACK ${a.id}read`],
    ['footer ID with prose joined', v2([`${a.id}Read`])],
    ['footer with an unknown key', `${BANNER}\n\nx\n\n${footer({ schema: SCHEMA, kind: 'REPLY', ack: [a.id], also: 1 })}`],
    ['footer of another schema', `${BANNER}\n\nx\n\n${footer({ schema: 'ophanim.collaboration.reply/v9', kind: 'REPLY', ack: [a.id] })}`],
    ['footer of another kind', v2([a.id], { kind: 'MESSAGE' })],
    ['footer that is not JSON', `${BANNER}\n\nx\n\n<!-- ophanim-collab-reply {"schema": ${a.id}} -->`],
    ['footer quoted mid-body, not the last line', `${BANNER}\n\nYou wrote:\n${footer({ schema: SCHEMA, kind: 'REPLY', ack: [a.id] })}\nI have not read it.`],
    ['footer without the identity banner', `Read.\n\n${footer({ schema: SCHEMA, kind: 'REPLY', ack: [a.id] })}`],
  ]) {
    store.importComment(comment(body), ['owner']);
    assert.equal(store.get(a.id).acknowledged_at, null, what);
  }
  assert.equal(replyHeader(v2([`${a.id}Read`])), null, 'a malformed footer is not a protocol reply');
  assert.deepEqual(replyHeader(`OPHANIM-COLLAB REPLY\nACK ${'-'.repeat(36)}`).acknowledgements, [], 'only an exact UUID is an ID');
  assert.deepEqual(replyHeader(`OPHANIM-COLLAB REPLY\nACK ${a.id.toUpperCase()}`).acknowledgements, [], 'IDs are lower-case, as the store issues them');
});

test('wire: a footer ACK of a message addressed to another recipient does not mark it read', t => {
  const store = fixture(t), toCodex = store.send({ from: 'claude', to: 'codex', key: 'other', text: 'For Codex.' });
  store.importComment(comment(v2([toCodex.id])), ['owner']);
  assert.equal(store.get(toCodex.id).acknowledged_at, null);
});

test('wire: legacy first-line replies already in flight still import and acknowledge; an unlisted author is still ignored', t => {
  const store = fixture(t), a = toClaude(store), b = toClaude(store);
  assert.ok(store.importComment(comment(`OPHANIM-COLLAB REPLY\nACK ${a.id}\n\nRead.`), ['owner']));
  assert.notEqual(store.get(a.id).acknowledged_at, null);
  assert.equal(store.importComment({ ...comment(v2([b.id])), user: { login: 'someone' } }, ['owner']), null);
  assert.equal(store.get(b.id).acknowledged_at, null);
  assert.equal(replyHeader(`OPHANIM-COLLAB REPLY\nACK ${a.id}`).format, 'legacy');
  const quoting = `OPHANIM-COLLAB REPLY\nACK ${b.id}\n\nThe new footer looks like:\n${footer({ schema: SCHEMA, kind: 'REPLY', ack: [a.id] })}\nand I will use it next time.`;
  assert.deepEqual(replyHeader(quoting), { kind: 'REPLY', acknowledgements: [b.id], format: 'legacy' }, 'a legacy reply that quotes a footer is still a legacy reply, acknowledging only its own header');
});

test('wire: an outbound GitHub body opens with the sender\'s banner, hides its transport tokens in a footer, and is not itself a reply', t => {
  const store = fixture(t);
  const banner = '> **[Seat: Codex · Model: (stated by the sender) · Role: Coach]**';
  const msg = store.send({ from: 'codex', to: 'claude', key: 'banner', subject: 'S', text: `${banner}\n\nPlease review.` });
  const body = bridge.githubBody(msg), lines = body.trimEnd().split('\n');
  assert.equal(lines[0], banner, 'the visible body opens with the sender\'s banner');
  assert.equal(body.split(banner).length, 2, 'the banner is not repeated');
  assert.equal(lines.at(-1), bridge.marker(msg.id), 'the reconcile marker is the hidden last line');
  assert.ok(!/^OPHANIM-COLLAB MESSAGE/m.test(body), 'no visible transport token line');
  assert.equal(replyHeader(body), null);
  assert.match(body, new RegExp(`ophanim-collab-reply \\{"schema":"${SCHEMA.replace(/[./]/g, '\\$&')}","kind":"REPLY","ack":\\["${msg.id}"\\]\\}`), 'it shows the footer the reply must end with');
  const plain = store.send({ from: 'codex', to: 'claude', key: 'plain', subject: 'S', text: 'No banner here.' });
  assert.match(bridge.githubBody(plain).split('\n')[0], /^> \*\*\[Seat: Codex · Model: not stated by the sender · Role: not stated by the sender\]\*\*$/, 'a message without a banner gets one that says what is not known');
});
