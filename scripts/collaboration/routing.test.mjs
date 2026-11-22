// Issue #98: target-scoped routing. A message is routed to ONE allowlisted issue or pull request of the configured
// repository; the bridge reads each allowlisted target's own timeline; a reply acknowledges only messages routed to
// the target it was posted on. Stale, foreign or unconfigured target metadata never changes acknowledgement state, and
// a message with no allowed route is refused cleanly (no send, no retry). Legacy messages (no target) keep the single
// configured PR. Simulated GitHub endpoints and synthetic stores only: no network, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wire from './store.mjs';
import * as bridge from './github-bridge.mjs';

const { Store } = wire;
const BANNER = '> **[Seat: Claude · Model: (stated by the sender) · Role: Implementer]**';
const SCHEMA = 'ophanim.collaboration.reply/v2';
const footer = obj => `<!-- ophanim-collab-reply ${JSON.stringify(obj)} -->`;
const reply = (acks, extra = {}) => `${BANNER}\n\nRead.\n\n${footer({ schema: SCHEMA, kind: 'REPLY', ack: acks, ...extra })}`;
const CONFIG = { repo: 'test/repo', afterComment: 10, allowedAuthors: ['owner'], targets: ['pr:104', 'issue:98'] };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ophanim-collab-routing-'));
  const path = join(dir, 'mail.sqlite');
  const opened = [new Store(path)];
  t.after(() => { for (const s of opened) s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store: opened[0], reopen: () => { opened[0].close(); opened[0] = new Store(path); return opened[0]; } };
}
/** A simulated GitHub: one comment timeline per issue/PR number; records every endpoint read and every post. */
function github() {
  const timelines = new Map(), reads = [], posts = [], down = { read: new Set(), post: new Set() };
  let next = 1000;
  const api = async (endpoint, body) => {
    const m = /^repos\/test\/repo\/issues\/(\d+)\/comments(\?.*)?$/.exec(endpoint);
    if (!m) throw new Error(`unexpected endpoint ${endpoint}`);
    const n = Number(m[1]);
    if (!body && down.read.has(n)) throw new Error(`HTTP 404: issue ${n} not found`);
    // An ambiguous send: GitHub accepts the comment, and the response is lost on the way back.
    if (body && down.post.has(n)) { const c = { id: next++, user: { login: 'owner' }, html_url: `https://github.com/test/repo/issues/${n}#c${next}`, body: body.body };
      posts.push({ n, body: body.body, lost: true }); (timelines.get(n) ?? timelines.set(n, []).get(n)).push(c); throw new Error(`response lost posting to ${n}`); }
    if (!body) { reads.push(n); return [...(timelines.get(n) ?? [])]; }
    const c = { id: next++, user: { login: 'owner' }, html_url: `https://github.com/test/repo/issues/${n}#c${next}`, body: body.body };
    posts.push({ n, body: body.body }); (timelines.get(n) ?? timelines.set(n, []).get(n)).push(c);
    return c;
  };
  const comment = (n, body, id = next++) => { const c = { id, user: { login: 'owner' }, html_url: `https://github.com/test/repo/issues/${n}#c${id}`, body }; (timelines.get(n) ?? timelines.set(n, []).get(n)).push(c); return c; };
  return { api, reads, posts, comment, timelines, down };
}
const route = { ...CONFIG, outboundTransport: 'github' };
const byNumber = (x, y) => x - y;

test('routing: two simultaneous targets keep their own issue/PR -- each message is posted, replied to and acknowledged on its own target only', async t => {
  const { store } = fixture(t), gh = github();
  const a = store.send({ from: 'codex', to: 'claude', key: 'a', text: 'For PR 104.', target: 'pr:104' });
  const b = store.send({ from: 'codex', to: 'claude', key: 'b', text: 'For issue 98.', target: 'issue:98' });
  await bridge.githubTick(store, route, gh.api);
  assert.deepEqual(gh.posts.map(p => p.n).sort(byNumber), [98, 104]);
  assert.ok(gh.posts.find(p => p.n === 104).body.includes(bridge.marker(a.id)) && gh.posts.find(p => p.n === 98).body.includes(bridge.marker(b.id)), 'each message on its own target');
  assert.deepEqual([...new Set(gh.reads)].sort(byNumber), [98, 104], 'only the allowlisted targets are read');
  gh.comment(104, reply([a.id]));
  gh.comment(98, reply([b.id]));
  await bridge.githubTick(store, route, gh.api);
  assert.notEqual(store.get(a.id).acknowledged_at, null);
  assert.notEqual(store.get(b.id).acknowledged_at, null);
  assert.deepEqual(store.inbox('codex').map(m => m.provenance.target).sort(), ['issue:98', 'pr:104'], 'each imported reply records the target it was posted on');
});

test('routing: a misplaced ACK -- a reply on one target naming a message routed to another -- imports the reply but acknowledges nothing, and records why', async t => {
  const { store } = fixture(t), gh = github();
  const b = store.send({ from: 'codex', to: 'claude', key: 'b', text: 'For issue 98.', target: 'issue:98' });
  gh.comment(104, reply([b.id]));
  gh.comment(104, `OPHANIM-COLLAB REPLY\nACK ${b.id}\n\nLegacy form, wrong target.`);
  await bridge.githubTick(store, route, gh.api);
  assert.equal(store.get(b.id).acknowledged_at, null);
  assert.equal(store.inbox('codex').length, 2, 'the replies themselves are kept');
  assert.ok(store.events(b.id).some(e => e.kind === 'ack-refused' && e.data.reason === 'target-mismatch' && e.data.posted_on === 'pr:104' && e.data.routed_to === 'issue:98'));
});

test('routing: stale, foreign or unconfigured target metadata in a reply footer never changes acknowledgement state', async t => {
  const { store } = fixture(t), gh = github();
  const a = store.send({ from: 'codex', to: 'claude', key: 'a', text: 'For PR 104.', target: 'pr:104' });
  for (const target of ['issue:98', 'pr:999', 'pr:87', 'pr:0', 'PR:104', 104]) gh.comment(104, reply([a.id], { target }));
  await bridge.githubTick(store, route, gh.api);
  assert.equal(store.get(a.id).acknowledged_at, null, 'no footer naming another, an unconfigured or a malformed target acknowledges');
  gh.comment(104, reply([a.id], { target: 'pr:104' }));
  await bridge.githubTick(store, route, gh.api);
  assert.notEqual(store.get(a.id).acknowledged_at, null, 'a footer naming the target it is posted on does');
  gh.comment(555, reply([a.id]));
  await bridge.githubTick(store, route, gh.api);
  assert.ok(!gh.reads.includes(555), 'an unconfigured target is never read');
});

test('routing: an edited reply and a restarted bridge keep one durable reply per revision, idempotent acknowledgement and no repost', async t => {
  const f = fixture(t), gh = github();
  const a = f.store.send({ from: 'codex', to: 'claude', key: 'a', text: 'For PR 104.', target: 'pr:104' });
  await bridge.githubTick(f.store, route, gh.api);
  const c = gh.comment(104, reply([a.id]));
  await bridge.githubTick(f.store, route, gh.api);
  const acked = f.store.get(a.id).acknowledged_at;
  assert.notEqual(acked, null);
  c.body = reply([a.id]).replace('Read.', 'Read; edited.');
  const s2 = f.reopen();
  await bridge.githubTick(s2, route, gh.api);
  await bridge.githubTick(s2, route, gh.api);
  assert.equal(gh.posts.length, 1, 'the restart does not post the message again');
  assert.equal(s2.inbox('codex').length, 2, 'the original and the edited revision, once each');
  assert.equal(s2.get(a.id).acknowledged_at, acked, 'acknowledgement is unchanged by the edit and the restart');
});

test('routing: legacy in-flight messages (no target) keep the configured PR, and are acknowledged there only', async t => {
  const { store } = fixture(t), gh = github();
  const config = { ...route, pr: 87 };
  const old = store.send({ from: 'codex', to: 'claude', key: 'old', text: 'Sent before routing.' });
  assert.equal(old.target, undefined, 'a message sent without a target has the same payload as before');
  await bridge.githubTick(store, config, gh.api);
  assert.deepEqual(gh.posts.map(p => p.n), [87]);
  assert.deepEqual([...new Set(gh.reads)].sort(byNumber), [87, 98, 104]);
  gh.comment(104, `OPHANIM-COLLAB REPLY\nACK ${old.id}`);
  await bridge.githubTick(store, config, gh.api);
  assert.equal(store.get(old.id).acknowledged_at, null, 'not on another target');
  gh.comment(87, `OPHANIM-COLLAB REPLY\nACK ${old.id}\n\nRead.`);
  await bridge.githubTick(store, config, gh.api);
  assert.notEqual(store.get(old.id).acknowledged_at, null, 'the legacy reply on the configured PR acknowledges it');
  const legacyOnly = { repo: 'test/repo', pr: 87, afterComment: 10, allowedAuthors: ['owner'] };
  const again = store.send({ from: 'codex', to: 'claude', key: 'again', text: 'Legacy config.' });
  await bridge.githubTick(store, legacyOnly, gh.api);
  assert.ok(gh.posts.at(-1).n === 87 && gh.posts.at(-1).body.includes(bridge.marker(again.id)), 'a config with only `pr` behaves as before');
});

test('routing: a message with no allowed route is refused cleanly -- nothing is sent, the tick does not fail, it is not retried, and status shows it', async t => {
  const { store } = fixture(t), gh = github();
  const stray = store.send({ from: 'codex', to: 'claude', key: 'stray', text: 'For an unconfigured PR.', target: 'pr:555' });
  const bare = store.send({ from: 'codex', to: 'claude', key: 'bare', text: 'No target, and no default PR configured.' });
  await bridge.githubTick(store, route, gh.api);
  await bridge.githubTick(store, route, gh.api);
  assert.equal(gh.posts.length, 0);
  for (const m of [stray, bare]) {
    const got = store.get(m.id);
    assert.equal(got.delivery_state, 'refused');
    assert.equal(got.delivery_evidence.reason, 'NO_ROUTE');
  }
  assert.deepEqual(store.status().refused_deliveries.map(r => r.id).sort(), [stray.id, bare.id].sort());
  for (const bad of ['pr:', 'pull:5', 'pr:-1', 'pr:1.5', 'issue:01', ' pr:5', { kind: 'pr', number: 5 }]) {
    assert.throws(() => store.send({ from: 'codex', to: 'claude', key: `bad-${JSON.stringify(bad)}`, text: 'x', target: bad }), wire.MessageRefused, `target ${JSON.stringify(bad)}`);
  }
});

test('routing: the outbound body names its route in a machine-parseable footer and the reply footer to copy carries the target', t => {
  const { store } = fixture(t);
  const a = store.send({ from: 'codex', to: 'claude', key: 'a', text: 'For PR 104.', target: 'pr:104' });
  const body = bridge.githubBody(a, { repo: 'test/repo', target: 'pr:104' });
  assert.ok(body.includes(`<!-- ophanim-collab-route ${JSON.stringify({ repo: 'test/repo', target: 'pr:104' })} -->`));
  assert.ok(body.includes(footer({ schema: SCHEMA, kind: 'REPLY', ack: [a.id], target: 'pr:104' })));
  assert.equal(body.trimEnd().split('\n').at(-1), bridge.marker(a.id), 'the reconcile marker stays the last line');
  assert.equal(wire.replyHeader(body), null, 'the body is not itself a reply');
  assert.deepEqual(wire.replyHeader(wire.formatReply({ banner: BANNER, text: 'x', acks: [a.id], target: 'pr:104' })).target, 'pr:104');
  assert.throws(() => wire.formatReply({ banner: BANNER, text: 'x', acks: [a.id], target: 'pr:0' }), wire.MessageRefused);
});

test('routing: one repository item is one target -- a config naming the same number as both pr: and issue: is refused, in either order, before any read or send', async t => {
  const { store } = fixture(t);
  store.send({ from: 'codex', to: 'claude', key: 'a', text: 'x', target: 'pr:104' });
  for (const targets of [['pr:104', 'issue:104'], ['issue:104', 'pr:104']]) {
    const gh = github();
    await assert.rejects(bridge.githubTick(store, { ...route, targets }, gh.api), /names item 104 as both/);
    assert.deepEqual([gh.reads.length, gh.posts.length], [0, 0], targets.join(','));
  }
  const gh = github();
  await assert.rejects(bridge.githubTick(store, { ...route, pr: 87, targets: ['issue:87'] }, gh.api), /names item 87 as both/, 'the legacy pr counts as pr:87');
  assert.deepEqual([gh.reads.length, gh.posts.length], [0, 0]);
});

test('routing: a target written in another form than the configured one is not that route -- the message is refused, and a footer naming it acknowledges nothing', async t => {
  const { store } = fixture(t), gh = github();
  const alias = store.send({ from: 'codex', to: 'claude', key: 'alias', text: 'x', target: 'issue:104' });
  const a = store.send({ from: 'codex', to: 'claude', key: 'a', text: 'x', target: 'pr:104' });
  await bridge.githubTick(store, route, gh.api);
  assert.equal(store.get(alias.id).delivery_state, 'refused');
  assert.deepEqual(gh.posts.map(p => p.n), [104], 'only the message routed to pr:104 is posted');
  gh.comment(104, reply([a.id], { target: 'issue:104' }));
  await bridge.githubTick(store, route, gh.api);
  assert.equal(store.get(a.id).acknowledged_at, null);
});

test('routing: a failure stays with its target -- one unreadable timeline or one lost send does not stop the other targets; the tick reports every failure at the end', async t => {
  const { store } = fixture(t), gh = github();
  const a = store.send({ from: 'codex', to: 'claude', key: 'a', text: 'For PR 104.', target: 'pr:104' });
  const b = store.send({ from: 'codex', to: 'claude', key: 'b', text: 'For issue 98.', target: 'issue:98' });
  gh.down.read.add(104);
  await assert.rejects(bridge.githubTick(store, route, gh.api), /pr:104: HTTP 404/);
  assert.equal(store.get(b.id).delivery_state, 'delivered', 'the healthy target\'s message is sent');
  assert.deepEqual([store.get(a.id).delivery_state, gh.posts.filter(p => p.n === 104).length], ['queued', 0], 'the unreadable target\'s message waits, unsent');
  const health = store.meta('github-health');
  assert.deepEqual([health.ok, Object.keys(health.failed_targets)], [false, ['pr:104']]);
  gh.comment(98, reply([b.id]));
  gh.down.read.delete(104); gh.down.post.add(104);
  const c = store.send({ from: 'codex', to: 'claude', key: 'c', text: 'Also for issue 98.', target: 'issue:98' });
  await assert.rejects(bridge.githubTick(store, route, gh.api), /pr:104: response lost/);
  assert.notEqual(store.get(b.id).acknowledged_at, null, 'the healthy target\'s reply is imported and acknowledges');
  assert.equal(store.get(a.id).delivery_state, 'uncertain', 'a lost send stays reconcilable, never replayed');
  assert.equal(store.get(c.id).delivery_state, 'delivered', 'and the next message on another target is still sent');
  gh.down.post.delete(104);
  await bridge.githubTick(store, route, gh.api);
  assert.equal(store.get(a.id).delivery_state, 'delivered', 'reconciled by its marker on its own timeline, not reposted');
  assert.equal(gh.posts.filter(p => p.n === 104).length, 1);
  assert.equal(store.meta('github-health').ok, true);
});

test('routing: messages waiting on a failed target never starve another target -- 19, 20 or 21 queued for an unreadable pr:104 still let issue:98 deliver', async t => {
  for (const blocked of [19, 20, 21]) {
    const { store } = fixture(t), gh = github();
    for (let i = 0; i < blocked; i++) store.send({ from: 'codex', to: 'claude', key: `old-${i}`, text: `Older ${i}.`, target: 'pr:104' });
    const b = store.send({ from: 'codex', to: 'claude', key: 'b', text: 'For issue 98.', target: 'issue:98' });
    gh.down.read.add(104);
    for (let tick = 0; tick < 3; tick++) await assert.rejects(bridge.githubTick(store, route, gh.api), /pr:104/);
    assert.equal(store.get(b.id).delivery_state, 'delivered', `${blocked} blocked: the issue:98 message is delivered`);
    assert.deepEqual(gh.posts.map(p => p.n), [98], `${blocked} blocked: once, and nothing is written to the unreadable target`);
  }
});

test('routing: dispatch is bounded per tick and oldest-first per route; unconfigured routes are refused terminally; the desktop worker\'s outbox is unchanged', async t => {
  const { store } = fixture(t), gh = github();
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push(store.send({ from: 'codex', to: 'claude', key: `m-${i}`, text: `Message ${i}.`, target: i % 2 ? 'issue:98' : 'pr:104' }).id);
  const stray = store.send({ from: 'codex', to: 'claude', key: 'stray', text: 'Unconfigured.', target: 'pr:555' });
  assert.equal(store.outbox('github').length, 20, 'the default outbox is still the 20 oldest');
  await bridge.githubTick(store, route, gh.api);
  assert.equal(gh.posts.length, 20, 'at most 20 sends in one tick');
  await bridge.githubTick(store, route, gh.api);
  assert.equal(gh.posts.length, 25);
  const posted = gh.posts.map(p => ids.findIndex(id => p.body.includes(bridge.marker(id))));
  for (const n of [98, 104]) {
    const order = gh.posts.filter(p => p.n === n).map(p => ids.findIndex(id => p.body.includes(bridge.marker(id))));
    assert.deepEqual(order, [...order].sort((x, y) => x - y), `oldest first on ${n}`);
  }
  assert.deepEqual(posted, [...Array(25).keys()], 'and oldest first overall');
  assert.equal(store.get(stray.id).delivery_state, 'refused');
  await bridge.githubTick(store, route, gh.api);
  assert.equal(gh.posts.length, 25, 'nothing is sent again');
  const codexBound = [], firstTwenty = [];
  for (let i = 0; i < 22; i++) {
    const id = store.send({ from: 'claude', to: 'codex', key: `d-${i}`, text: `To Codex ${i}.` }).id;
    codexBound.push(id);
    if (i < 20) firstTwenty.push(id);
  }
  assert.deepEqual(store.outbox('desktop').map(m => m.id), firstTwenty, 'the desktop worker still reads its 20 oldest');
  assert.equal(store.beginDelivery(codexBound[21], 'desktop').delivery_state, 'dispatching', 'a queued message outside the first 20 can be claimed');
  assert.throws(() => store.beginDelivery(codexBound[21], 'desktop'), /already claimed/);
  assert.throws(() => store.beginDelivery(codexBound[0], 'github'), /already claimed or unavailable/, 'a route never claims another recipient\'s message');
});

test('routing: selection filters before it limits -- 999, 1,000 or 1,001 older messages for an unreadable target do not delay a healthy one past the first tick', async t => {
  for (const blocked of [999, 1000, 1001]) {
    const { store } = fixture(t), gh = github();
    for (let i = 0; i < blocked; i++) store.send({ from: 'codex', to: 'claude', key: `old-${i}`, text: 'x', target: 'pr:104' });
    const b = store.send({ from: 'codex', to: 'claude', key: 'b', text: 'For issue 98.', target: 'issue:98' });
    gh.down.read.add(104);
    await assert.rejects(bridge.githubTick(store, route, gh.api), /pr:104/);
    assert.equal(store.get(b.id).delivery_state, 'delivered', `${blocked} blocked: delivered in the first tick`);
    assert.deepEqual(gh.posts.map(p => p.n), [98], `${blocked} blocked: once, and nothing written to the unreadable target`);
  }
});

test('routing: an unconfigured-route backlog is refused at most 20 per tick and never crowds out a healthy message; eligible sends stay bounded and oldest first', async t => {
  const { store } = fixture(t), gh = github();
  const strays = [];
  for (let i = 0; i < 1001; i++) strays.push(store.send({ from: 'codex', to: 'claude', key: `stray-${i}`, text: 'x', target: 'pr:555' }).id);
  const healthy = [];
  for (let i = 0; i < 25; i++) healthy.push(store.send({ from: 'codex', to: 'claude', key: `h-${i}`, text: `Healthy ${i}.`, target: 'issue:98' }).id);
  await bridge.githubTick(store, route, gh.api);
  const refused = () => strays.filter(id => store.get(id).delivery_state === 'refused').length;
  assert.equal(refused(), 20, 'refusals are bounded per tick');
  assert.deepEqual(gh.posts.map(p => healthy.findIndex(id => p.body.includes(bridge.marker(id)))), [...Array(20).keys()], 'the 20 oldest healthy messages are sent in the first tick, oldest first');
  await bridge.githubTick(store, route, gh.api);
  assert.equal(refused(), 40);
  assert.equal(gh.posts.length, 25, 'the rest in the next tick, none twice');
  assert.equal(store.outbox('github').length, 20, 'the default outbox (desktop and CLI contract) is unchanged');
});
