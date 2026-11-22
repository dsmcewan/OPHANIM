#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, formatReply } from './store.mjs';
import { serveMCP } from './mcp-server.mjs';
import { runGithubBridge } from './github-bridge.mjs';
import { serveDesktopStore } from './desktop-store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals: [command, id] } = parseArgs({ allowPositionals: true, options: {
  agent: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, key: { type: 'string' },
  subject: { type: 'string' }, text: { type: 'string' }, 'text-file': { type: 'string' }, 'reply-to': { type: 'string' },
  note: { type: 'string' }, token: { type: 'string' }, ttl: { type: 'string' }, db: { type: 'string' },
  route: { type: 'string' }, state: { type: 'string' }, evidence: { type: 'string' }, config: { type: 'string' },
  all: { type: 'boolean' }, once: { type: 'boolean' }, banner: { type: 'string' }, ack: { type: 'string' },
} });
// format-reply needs no mailbox: it prints a v2 reply body (banner, text, typed footer) and exits.
if (command === 'format-reply') {
  try {
    process.stdout.write(formatReply({ banner: o.banner, text: o['text-file'] ? readFileSync(o['text-file'], 'utf8') : o.text ?? '', acks: o.ack ? o.ack.split(',') : [] }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  process.exit();
}
const store = new Store(o.db), who = o.agent ?? o.from ?? process.env.OPHANIM_COLLAB_AGENT;
try {
  let result;
  switch (command) {
    case 'mcp': serveMCP(store, who); break;
    case 'desktop-rpc': serveDesktopStore(store); break;
    case 'send': result = store.send({ from: who, to: o.to, key: o.key, subject: o.subject, text: o['text-file'] ? readFileSync(o['text-file'], 'utf8') : o.text, replyTo: o['reply-to'] }); break;
    case 'inbox': result = store.inbox(who, o.all); break;
    case 'ack': result = store.ack(who, id, o.note); break;
    case 'status': result = store.status(); break;
    case 'events': result = store.events(id); break;
    case 'claim': result = store.claim(id, who, o.ttl ? Number(o.ttl) : undefined); break;
    case 'renew': result = store.renew(id, who, o.token, o.ttl ? Number(o.ttl) : undefined); break;
    case 'release': result = store.release(id, who, o.token); break;
    case 'outbox': result = store.outbox(o.route); break;
    case 'delivery-begin': result = store.beginDelivery(id, o.route); break;
    case 'delivery-finish': result = store.finishDelivery(id, o.state, JSON.parse(o.evidence ?? '{}')); break;
    case 'delivery-resolve': result = store.resolveDelivery(id, o.state, JSON.parse(o.evidence ?? '{}')); break;
    case 'delivery-recover': result = store.recoverDeliveries(o.route); break;
    case 'health': result = store.meta(`${o.route}-health`, JSON.parse(o.evidence ?? '{}')); break;
    case 'bridge': await runGithubBridge(store, JSON.parse(readFileSync(o.config ?? join(root, 'config.json'), 'utf8')), o.once); break;
    default: throw new Error('Usage: collab {send|inbox|ack|status|events|claim|renew|release|bridge|mcp|format-reply} [options]');
  }
  if (!['mcp', 'desktop-rpc'].includes(command)) { if (result !== undefined) console.log(JSON.stringify(result, null, 2)); store.close(); }
} catch (e) { console.error(e.message); store.close(); process.exitCode = 1; }
