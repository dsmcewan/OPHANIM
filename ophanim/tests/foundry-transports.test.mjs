// The concrete foundry transports (ophanim/foundry/transports.mjs): the Claude command-line seat, a generic SDK seat
// wrapping pantheon's liveClients, and realTransports() wiring all four labs. SYNTHETIC: the CLI seat runs the fake at
// fixtures/fake-claude.mjs; the SDK seat is driven by an injected stand-in liveClients (no vendor SDK, no network, no key).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeCliTransport, sdkTransport, realTransports} from '../foundry/transports.mjs';

const FAKE = fileURLToPath(new URL('../foundry/fixtures/fake-claude.mjs', import.meta.url));
const world = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tr-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 's.json'); fs.writeFileSync(file, JSON.stringify({})); return {env: {...process.env, FAKE_CLAUDE_SCRIPT: file, FAKE_CLAUDE_LOG: path.join(dir, 'l.jsonl')}}; };
const ask = (clientFor, vendor, surface = 'messages') => clientFor(vendor)[surface].create({model: 'm', max_tokens: 10, messages: [{role: 'user', content: 'x'}]});

test('claudeCliTransport serves anthropic/api, is reachable when its CLI resolves, and builds a working Claude seat', async t => {
  const w = world(t);
  const tr = claudeCliTransport({cli: FAKE, env: w.env});
  assert.deepEqual([tr.id, tr.vendors, tr.live], ['claude-cli', ['anthropic'], false]);
  assert.equal(tr.reachable(), true, 'the CLI path exists');
  assert.equal(claudeCliTransport({cli: '/nonexistent/claude', env: w.env}).reachable(), false);
  const make = tr.make({maxUsd: 2}); const r = await ask(make, 'anthropic');
  assert.equal(r.stop_reason, 'end_turn');
  assert.throws(() => make('openai'), /Anthropic models only/);
});

test('sdkTransport dispatches its vendors to the injected liveClients, is reachability-gated, and counts its calls', async () => {
  // A stand-in liveClients: makeClientFor(vendor) -> the vendor-correct surface. openai uses responses.create; others messages.create.
  const calls = [];
  const fakeLive = async () => { const mk = vendor => (vendor === 'openai'
    ? {responses: {create: async () => { calls.push(vendor); return {output_text: vendor}; }}}
    : {messages: {create: async () => { calls.push(vendor); return {content: [{type: 'text', text: vendor}]}; }}});
    return mk; };
  const tr = sdkTransport({id: 'live-api', vendors: ['openai', 'xai'], live: true, reachable: () => true, open: fakeLive});
  assert.deepEqual([tr.id, tr.vendors, tr.live, tr.reachable()], ['live-api', ['openai', 'xai'], true, true]);
  const make = tr.make({maxUsd: 5});
  assert.equal((await ask(make, 'openai', 'responses')).output_text, 'openai');
  assert.equal((await ask(make, 'xai')).content[0].text, 'xai');
  assert.deepEqual(make.spent(), {usd: 0, calls: 2}, 'the SDK seat has no USD figure here: it meters calls, not dollars');
  assert.throws(() => make('anthropic'), /live-api does not serve anthropic/);
  assert.equal(sdkTransport({id: 'x', vendors: ['openai'], reachable: () => false, open: fakeLive}).reachable(), false);
});

test('realTransports wires all four labs; the SDK labs are not reachable without their SDK and credential', () => {
  const trs = realTransports({env: {}});   // no credentials
  const byId = Object.fromEntries(trs.map(t => [t.id, t]));
  const vendors = new Set(trs.flatMap(t => t.vendors));
  assert.deepEqual([...vendors].sort(), ['agy_google', 'anthropic', 'openai', 'xai']);
  // With an empty environment no API credential is present, so the SDK seats are not reachable here.
  for (const t of trs) if (t.id !== 'claude-cli') assert.equal(t.reachable(), false, `${t.id} needs its SDK and a credential`);
});
