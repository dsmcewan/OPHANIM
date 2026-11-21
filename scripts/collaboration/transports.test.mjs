import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { MCPClient } from './mcp-client.mjs';
import { githubTick, marker } from './github-bridge.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const config = { repo: 'test/repo', pr: 1, afterComment: 10, allowedAuthors: ['owner'] };
const message = { from: 'codex', to: 'claude', key: 'review', text: 'Inspect the implementation.' };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ophanim-collab-transport-'));
  const path = join(dir, 'mail.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, path };
}

test('a lost GitHub response is reconciled without reposting, then a real reply is imported', async t => {
  const { store } = fixture(t), msg = store.send(message), comments = [];
  let posts = 0;
  const api = async (endpoint, body) => {
    if (!body) return comments;
    posts++;
    comments.push({ id: 11, user: { login: 'owner' }, html_url: 'https://github.com/test/11', body: body.body });
    throw new Error('response lost after server accepted comment');
  };
  await assert.rejects(githubTick(store, config, api), /response lost/);
  assert.equal(store.get(msg.id).delivery_state, 'uncertain');
  await githubTick(store, config, api);
  assert.equal(posts, 1);
  assert.equal(store.get(msg.id).delivery_state, 'delivered');
  comments.push({ id: 12, user: { login: 'owner' }, body: `OPHANIM-COLLAB REPLY\nACK ${msg.id}\nInspected; here is my finding.`, html_url: 'https://github.com/test/12' });
  await githubTick(store, config, api);
  await githubTick(store, config, api);
  assert.equal(store.inbox('codex').length, 1);
  assert.notEqual(store.get(msg.id).acknowledged_at, null);
});

test('unproven delivery stays held across bridge ticks', async t => {
  const { store } = fixture(t), msg = store.send(message);
  let posts = 0;
  const api = async (_, body) => { if (!body) return []; posts++; throw new Error('network outcome unknown'); };
  await assert.rejects(githubTick(store, config, api));
  await githubTick(store, config, api);
  assert.equal(posts, 1);
  assert.equal(store.get(msg.id).delivery_state, 'uncertain');
  assert.equal(store.get(msg.id).acknowledged_at, null);
});

test('native Claude CLI dispatch records its session receipt without posting a GitHub wake-up', async t => {
  const { store } = fixture(t), msg = store.send(message);
  let sends = 0;
  const api = async (_, body) => { assert.equal(body, undefined); return []; };
  const cloud = async (cfg, text) => {
    sends++; assert.ok(text.includes(marker(msg.id)));
    return { ok: true, session_id: cfg.claudeSessionId, url: 'https://claude.ai/code/session_test' };
  };
  await githubTick(store, { ...config, outboundTransport: 'claude-cloud', claudeSessionId: 'session_test' }, api, cloud);
  await githubTick(store, { ...config, outboundTransport: 'claude-cloud', claudeSessionId: 'session_test' }, api, cloud);
  assert.equal(sends, 1);
  assert.equal(store.get(msg.id).route, 'claude-cloud');
  assert.equal(store.get(msg.id).delivery_evidence.ok, true);
  assert.equal(store.get(msg.id).acknowledged_at, null);
});

test('MCP connects two independent processes and fixes each sender identity', async t => {
  const { path } = fixture(t);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const codex = new MCPClient(process.execPath, [cli, 'mcp', '--db', path, '--agent', 'codex']);
  const claude = new MCPClient(process.execPath, [cli, 'mcp', '--db', path, '--agent', 'claude']);
  t.after(() => { codex.close(); claude.close(); });
  await Promise.all([codex.initialize(), claude.initialize()]);
  const result = await codex.call('collab_send', { to: 'claude', key: 'mcp-1', text: 'Verify the mailbox.' });
  const sent = JSON.parse(result.content[0].text);
  assert.equal(sent.from, 'codex');
  const inbox = JSON.parse((await claude.call('collab_inbox', {})).content[0].text);
  assert.equal(inbox[0].id, sent.id);
  await assert.rejects(codex.call('collab_send', { from: 'claude', to: 'codex', key: 'spoof', text: 'Bad identity override' }), /invalid arguments/i);
  await assert.rejects(codex.call('collab_ack', { id: sent.id, note: 'Wrong reader' }), /recipient/i);
  await claude.call('collab_ack', { id: sent.id, note: 'Read by the receiving process.' });
  const reply = await claude.call('collab_send', { to: 'codex', key: 'mcp-reply', replyTo: sent.id, text: 'Mailbox verified.' });
  assert.equal(JSON.parse(reply.content[0].text).from, 'claude');
  assert.equal(JSON.parse((await codex.call('collab_inbox', {})).content[0].text)[0].text, 'Mailbox verified.');
});

test('simultaneous process retries retain exactly one durable message', async t => {
  const { path, store } = fixture(t), cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const clients = [0, 1].map(() => new MCPClient(process.execPath, [cli, 'mcp', '--db', path, '--agent', 'codex']));
  t.after(() => clients.forEach(c => c.close()));
  await Promise.all(clients.map(c => c.initialize()));
  const results = await Promise.all(clients.map(c => c.call('collab_send', { to: 'claude', key: 'concurrent', text: 'One request' })));
  assert.equal(JSON.parse(results[0].content[0].text).id, JSON.parse(results[1].content[0].text).id);
  assert.equal(store.inbox('claude').length, 1);
});

test('startup waits for a concurrent database creator before changing journal mode', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ophanim-collab-startup-'));
  const path = join(dir, 'fresh.sqlite');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE; CREATE TABLE startup_lock (id INTEGER)');
    process.stdout.write('LOCKED\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250);
  `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const store = new Store(path);
  try { assert.equal(store.inbox('codex').length, 0); } finally { store.close(); }
});
