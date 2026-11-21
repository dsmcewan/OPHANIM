// The Claude command-line seat (ophanim/foundry/claude-cli.mjs): a model client Pantheon's pipeline can be given, backed
// by one `claude -p` process per turn. SYNTHETIC: every test runs the stand-in at ophanim/foundry/fixtures/fake-claude.mjs
// (no model, no network, no key).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeCliClients, promptOf, TRANSPORT} from '../foundry/claude-cli.mjs';
import {exchange} from '../../packages/model-client/wire.mjs';

export const FAKE = fileURLToPath(new URL('../foundry/fixtures/fake-claude.mjs', import.meta.url));
const world = (t, script = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-cli-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'script.json'), log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, JSON.stringify(script));
  return {dir, log, env: {...process.env, FAKE_CLAUDE_SCRIPT: file, FAKE_CLAUDE_LOG: log}, logged: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))};
};
const ask = (client, model, text, extra = {}) => client.messages.create({model, max_tokens: 100, messages: [{role: 'user', content: text}], ...extra});

test('one turn is one CLI process: the model named, no tools, no settings, no saved session, a spending cap, an empty working directory; the reply, the served model and the usage come back as a Messages response', async t => {
  const w = world(t, {files: {'*': {'add.mjs': 'export const add = (a, b) => a + b;\n'}}, cost_usd: {'*': 0.0125}}), calls = [];
  const make = claudeCliClients({cli: FAKE, env: w.env, perCallUsd: 0.5, maxUsd: 2, onCall: c => calls.push(c)});
  const r = await ask(make('anthropic'), 'claude-sonnet-5', 'Write add.mjs', {system: 'Own the artifact.'});
  assert.deepEqual([r.content, r.stop_reason, r.model, r.usage.output_tokens > 0], [[{type: 'text', text: 'export const add = (a, b) => a + b;\n'}], 'end_turn', 'claude-sonnet-5', true]);
  const [seen] = w.logged();
  assert.deepEqual([seen.model, seen.system, seen.argv.includes('-p'), seen.argv[seen.argv.indexOf('--tools') + 1], seen.argv.includes('--strict-mcp-config'), seen.argv.includes('--no-session-persistence'),
    seen.argv[seen.argv.indexOf('--setting-sources') + 1], seen.argv[seen.argv.indexOf('--max-budget-usd') + 1], seen.argv[seen.argv.indexOf('--output-format') + 1]],
    ['claude-sonnet-5', 'Own the artifact.', true, '', true, true, '', '0.5', 'json']);
  assert.ok(seen.cwd !== process.cwd() && !fs.existsSync(seen.cwd), 'the turn ran in a directory of its own, removed afterwards');
  assert.deepEqual(calls.map(c => [c.requested, c.served, c.cost_usd, c.outcome, typeof c.ms]), [['claude-sonnet-5', 'claude-sonnet-5', 0.0125, 'ok', 'number']]);
  assert.deepEqual([make.providers, make.spent()], [{kind: 'synthetic', transport: TRANSPORT}, {usd: 0.0125, calls: 1}]);
  assert.deepEqual(claudeCliClients({cli: FAKE, env: w.env, live: true}).providers, {kind: 'live', transport: 'claude-cli'}, 'live only when the caller says a real model answers');
});

test('the packaged model client reads a streamed turn from it exactly as from a provider: text, completion and both halves of the usage', async t => {
  const w = world(t), make = claudeCliClients({cli: FAKE, env: w.env});
  const events = [], stream = await ask(make('anthropic'), 'claude-opus-5-5', 'anything', {stream: true});
  for await (const e of stream) events.push(e.type);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop']);
  const turn = await exchange({request: {model: 'claude-opus-5-5', max_tokens: 100, messages: [{role: 'user', content: 'anything'}]}, options: {headers: {}}, cap: {vendor: 'anthropic', surface: 'messages'}, vendor: 'anthropic', history: []}, make('anthropic'), () => {});
  assert.deepEqual([turn.text, turn.complete, turn.terminal_state, turn.usage.input_tokens > 0, turn.usage.output_tokens > 0], ['export const scripted = true;\n', true, 'end_turn', true, true]);
});

test('the served model is what the CLI reports, never what was asked for; an effort is passed only when one is set', async t => {
  const w = world(t, {served: {'claude-sonnet-5': 'claude-haiku-4-5-20251001'}}), calls = [];
  const make = claudeCliClients({cli: FAKE, env: w.env, effort: 'low', onCall: c => calls.push(c)});
  const r = await ask(make('anthropic'), 'claude-sonnet-5', 'x');
  await ask(claudeCliClients({cli: FAKE, env: w.env})('anthropic'), 'claude-sonnet-5', 'x');
  assert.deepEqual([r.model, calls[0].requested, calls[0].served], ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(w.logged().map(l => l.argv.includes('--effort') ? l.argv[l.argv.indexOf('--effort') + 1] : null), ['low', null]);
});

test('REFUSALS: another lab, a turn that needs tools, a spent budget, a CLI error, output that is not the CLI\'s JSON and a turn that outlives its time limit each fail the turn with a status and a reason; none is answered', async t => {
  const w = world(t, {cost_usd: {'*': 0.6}, error: {'claude-opus-5-5': 'credit balance too low'}, hang: ['claude-fable-5-2']}), calls = [];
  const make = claudeCliClients({cli: FAKE, env: w.env, maxUsd: 1, timeoutMs: 400, onCall: c => calls.push(c)});
  assert.throws(() => make('openai'), /the Claude command line serves Anthropic models only/);
  await assert.rejects(ask(make('anthropic'), 'claude-sonnet-5', 'x', {tools: [{name: 'bash'}]}), e => e.status === 400 && /text turns only/.test(e.message));
  await assert.rejects(ask(make('anthropic'), 'claude-opus-5-5', 'x'), e => e.status === 502 && /credit balance too low/.test(e.message));
  await assert.rejects(ask(make('anthropic'), 'claude-fable-5-2', 'x'), e => e.status === 504 && /400 ms/.test(e.message));
  // The failed turn reported a cost of 0.6 and it counts: one more turn reaches the cap of 1, and the next is not started.
  await ask(make('anthropic'), 'claude-sonnet-5', 'x');
  await assert.rejects(ask(make('anthropic'), 'claude-sonnet-5', 'x'), e => e.status === 402 && e.code === 'FOUNDRY_BUDGET' && /1\.2 of 1 USD/.test(e.message));
  assert.deepEqual(calls.map(c => [c.outcome, c.cost_usd]), [['refused', 0], ['error', 0.6], ['timeout', 0], ['ok', 0.6], ['refused', 0]]);
  assert.equal(w.logged().length, 3, 'a refused turn starts no process');
  const raw = world(t, {raw: 'Segmentation fault'});
  await assert.rejects(ask(claudeCliClients({cli: FAKE, env: raw.env})('anthropic'), 'claude-sonnet-5', 'x'), e => e.status === 502 && /did not print its JSON result/.test(e.message));
  await assert.rejects(ask(claudeCliClients({cli: '/nonexistent/claude', env: w.env})('anthropic'), 'claude-sonnet-5', 'x'), e => e.status === 502 && /could not be started/.test(e.message));
});

test('a conversation of several messages is sent as a labelled transcript; a single user message is sent as it is', () => {
  assert.deepEqual(promptOf({system: [{type: 'text', text: 'S'}], messages: [{role: 'user', content: [{type: 'text', text: 'only this'}]}]}), {system: 'S', prompt: 'only this'});
  assert.deepEqual(promptOf({messages: [{role: 'user', content: 'a'}, {role: 'assistant', content: 'b'}, {role: 'user', content: 'c'}]}), {system: null, prompt: '[user]\na\n\n[assistant]\nb\n\n[user]\nc'});
});
