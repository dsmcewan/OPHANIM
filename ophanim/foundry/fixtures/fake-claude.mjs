#!/usr/bin/env node
// A STAND-IN for the `claude` command line, for tests only. SYNTHETIC: it calls no model and opens no network.
//
// It accepts the arguments ophanim/foundry/claude-cli.mjs passes (`-p --model M ... --output-format json`), reads the
// prompt from stdin and prints one JSON result in the shape the real CLI prints. What it answers is scripted by the JSON
// file FAKE_CLAUDE_SCRIPT names: {files: {"<model>": {"<path>": "<bytes>"}, "*": {...}}, verdict: {"<model>": "approve"},
// cost_usd: {"<model>": n}, delay_ms: {"<model>": n}, error: {"<model>": "text"}, hang: ["<model>"], raw: "not json"}.
// A review prompt (it asks for a VERDICT) is answered with the scripted verdict, or with request_changes when the prompt
// reports a failed acceptance run; a planning prompt (it asks for a TITLE) with a title; anything else with the scripted
// bytes of the file the prompt names. Every call is appended to FAKE_CLAUDE_LOG (model, arguments, the prompt's size).
import fs from 'node:fs';
const argv = process.argv.slice(2), flag = k => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
const script = process.env.FAKE_CLAUDE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8')) : {};
const model = flag('--model') ?? 'unnamed', of = (table, fallback) => table?.[model] ?? table?.['*'] ?? fallback;
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({model, argv, cwd: process.cwd(), prompt_chars: prompt.length, system: flag('--system-prompt')}) + '\n');
if ((script.hang ?? []).includes(model)) await new Promise(() => setInterval(() => {}, 1000));
const delay = of(script.delay_ms, 0);
if (delay) await new Promise(r => setTimeout(r, delay));
if (script.raw !== undefined) { process.stdout.write(String(script.raw)); process.exit(0); }
const error = of(script.error, null);
let text;
if (/VERDICT/i.test(prompt)) text = /exited 1\b/.test(prompt) ? 'VERDICT: request_changes' : `VERDICT: ${of(script.verdict, 'approve')}`;
else if (/TITLE:/i.test(prompt)) text = 'TITLE: a scripted change';
else {
  const files = of(script.files, {}), named = Object.keys(files).filter(p => prompt.includes(p)).sort((a, b) => b.length - a.length);
  text = named.length ? files[named[0]] : 'export const scripted = true;\n';
}
const served = of(script.served, model), out = Math.ceil(text.length / 4);
process.stdout.write(JSON.stringify({type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: Boolean(error), result: error ?? text, session_id: 'fake-session',
  duration_ms: delay, num_turns: 1, total_cost_usd: of(script.cost_usd, 0), usage: {input_tokens: 2, cache_creation_input_tokens: Math.ceil(prompt.length / 4), cache_read_input_tokens: 0, output_tokens: out},
  modelUsage: {[served]: {inputTokens: 2, outputTokens: out, costUSD: of(script.cost_usd, 0)}}}) + '\n');
