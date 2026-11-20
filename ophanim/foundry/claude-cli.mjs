// THE CLAUDE COMMAND-LINE SEAT: a model client for Pantheon's pipeline, served by one `claude -p` process per turn.
//
// Purpose   Pantheon's pipeline never imports a vendor SDK: it is given makeClientFor(vendor) and calls the SDK-shaped
//           client it returns (pantheon/src/board/run-item.mjs). This module returns such a client for the Anthropic
//           lab, backed by the Claude command line in print mode, so a seat can be served where the command line is
//           signed in and no API key is at hand. It is the foundry's one live transport in an environment like that.
// Inputs    the command (`cli`, default $OPHANIM_CLAUDE_CLI, else `claude`), the environment it runs with, a spending
//           cap per call and in total (USD, as the command line reports cost), a time limit per turn, an optional
//           effort level, and onCall (one record per turn).
// Outputs   claudeCliClients() -> makeClientFor(vendor), with .providers ({kind, transport: 'claude-cli'}), .calls and
//           .spent(). `kind` is 'live' only when the caller says a real model answers (`live: true`); otherwise
//           'synthetic', which is how Pantheon's records and the capability metrics tell live evidence from a test's.
//           The client answers messages.create as a Messages response, or as its event stream when `stream` is set
//           (message_start, content_block_start, content_block_delta, message_delta, message_stop): what
//           packages/model-client/wire.mjs reads from a provider.
// Invariants  One turn is one process in an empty directory of its own, with no tools, no MCP server, no settings
//           file, no saved session and the per-call cap; the directory is removed afterwards. The served model is the
//           one the command line reports. A turn that fails is an error with a status and a reason, never an answer.
// Must never  Serve another lab; run a turn that carries tools (this seat is text only); start a turn once the total
//           cap is spent; print or record the environment it was given; treat output that is not the command line's
//           JSON result as a reply.
// Limits    Pantheon records this seat's transport as `api`: the pipeline cannot tell this client from the provider's
//           SDK. The run's `providers.transport` is `claude-cli`, and the foundry's trial record says which transport
//           served it. Input tokens are the sum of the uncached, cache-written and cache-read counts the command line reports.
//           Cost is the command line's own figure and is not checked against a price list.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI_ENV = 'OPHANIM_CLAUDE_CLI';
export const TRANSPORT = 'claude-cli';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_SYSTEM = 'You are one seat of a software team. Answer with exactly what the message asks for and nothing else.';
const fail = (status, message, extra = {}) => Object.assign(new Error(message), {status, ...extra});
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => typeof b?.text === 'string').map(b => b.text).join('') : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The system text and the prompt of a Messages request. One user message is sent as it is; a conversation as a labelled transcript. */
export function promptOf(req) {
  const system = textOf(req.system) || null, messages = req.messages ?? [];
  if (messages.length === 1 && messages[0].role === 'user') return {system, prompt: textOf(messages[0].content)};
  return {system, prompt: messages.map(m => `[${m.role}]\n${textOf(m.content)}`).join('\n\n')};
}

function run({cli, env, args, prompt, timeoutMs}) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-claude-seat-'));
    const done = fn => v => { clearTimeout(timer); fs.rmSync(cwd, {recursive: true, force: true}); fn(v); };
    const child = spawn(cli, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', done(e => reject(fail(502, `the Claude command line could not be started (${e.code ?? 'error'})`, {outcome: 'error'}))));
    child.on('close', done(code => {
      if (timedOut) return reject(fail(504, `the Claude command line did not answer within ${timeoutMs} ms`, {outcome: 'timeout'}));
      let json = null;
      try { json = JSON.parse(out); } catch { /* reported below */ }
      if (!json || typeof json !== 'object' || json.type !== 'result') return reject(fail(502, `the Claude command line did not print its JSON result (exit ${code})`, {outcome: 'error'}));
      resolve(json);
    }));
    child.stdin.end(prompt);
  });
}

/**
 * makeClientFor(vendor) for Pantheon, served by the Claude command line. `perCallUsd` is passed to each process as its
 * own cap; `maxUsd` is the total this set of clients may spend, checked before each turn against what earlier turns
 * reported.
 */
export function claudeCliClients({cli = process.env[CLI_ENV] ?? 'claude', env = process.env, perCallUsd = 1, maxUsd = 5, timeoutMs = 300000, effort = null, live = false, onCall = () => {}} = {}) {
  if (effort !== null && !EFFORTS.includes(effort)) throw new Error(`claudeCliClients: unknown effort "${effort}" (${EFFORTS.join(', ')})`);
  const calls = [];
  let spent = 0;
  const note = c => { const row = Object.freeze(c); calls.push(row); onCall(row); };
  async function create(req) {
    const started = Date.now(), requested = String(req.model ?? ''), base = {requested, effort, at: new Date(started).toISOString()};
    const refuse = (status, why, extra) => { note({...base, served: null, ms: 0, cost_usd: 0, input_tokens: null, output_tokens: null, outcome: 'refused', why}); return fail(status, why, extra); };
    if (Array.isArray(req.tools) && req.tools.length) throw refuse(400, 'the Claude command-line seat serves text turns only: this turn carries tools');
    if (spent >= maxUsd) throw refuse(402, `the foundry's spending cap is reached: ${Number(spent.toFixed(4))} of ${maxUsd} USD spent`, {code: 'FOUNDRY_BUDGET'});
    const {system, prompt} = promptOf(req);
    const args = ['-p', '--model', requested, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--output-format', 'json',
      '--max-budget-usd', String(Math.min(perCallUsd, Math.max(maxUsd - spent, 0.01))), '--system-prompt', system ?? DEFAULT_SYSTEM, ...(effort ? ['--effort', effort] : [])];
    let json;
    try { json = await run({cli, env, args, prompt, timeoutMs}); }
    catch (e) { note({...base, served: null, ms: Date.now() - started, cost_usd: 0, input_tokens: null, output_tokens: null, outcome: e.outcome ?? 'error', why: e.message}); throw e; }
    const cost = num(json.total_cost_usd), u = json.usage ?? {};
    spent += cost;
    const models = Object.keys(json.modelUsage ?? {}), served = models.includes(requested) ? requested : models[0] ?? null;
    const usage = {input_tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output_tokens: num(u.output_tokens)};
    const row = {...base, served, models, ms: Date.now() - started, cost_usd: cost, ...usage};
    if (json.is_error || typeof json.result !== 'string') {
      const why = `the Claude command line reported an error: ${String(json.result ?? json.subtype ?? 'no result').slice(0, 300)}`;
      note({...row, outcome: 'error', why});
      throw fail(502, why);
    }
    note({...row, outcome: 'ok', why: null});
    const id = `claude-cli:${json.session_id ?? started}`, model = served ?? requested, text = json.result;
    if (!req.stream) return {id, type: 'message', role: 'assistant', model, content: [{type: 'text', text}], stop_reason: 'end_turn', usage};
    return {async *[Symbol.asyncIterator]() {
      yield {type: 'message_start', message: {id, type: 'message', role: 'assistant', model, usage: {input_tokens: usage.input_tokens, output_tokens: 0}}};
      yield {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}};
      yield {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}};
      yield {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: usage.output_tokens}};
      yield {type: 'message_stop'};
    }};
  }
  const makeClientFor = vendor => {
    if (vendor !== 'anthropic') throw new Error(`the Claude command line serves Anthropic models only: no client for "${vendor}"`);
    return {messages: {create}};
  };
  makeClientFor.providers = {kind: live === true ? 'live' : 'synthetic', transport: TRANSPORT};
  makeClientFor.calls = calls;
  makeClientFor.spent = () => ({usd: Number(spent.toFixed(6)), calls: calls.filter(c => c.outcome === 'ok').length});
  return makeClientFor;
}
