#!/usr/bin/env node
// OFFLINE CHECK of carbon-inspection-probe.mjs: the REAL runResearch, work ledger, billing policy and team runner, with a
// SCRIPTED session in place of the SDK (no provider, no key, no network). Not a test suite file and not on the live path:
// the live path passes no `sdk`, and run() uses runResearch's real default. It needs a clean checkout at the pinned commit.
//   node scripts/research/carbon-inspection-probe.offline.mjs --repo <clean checkout at 4e5cdd2>
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {run, MODEL, SCOPE, BUDGET} from './carbon-inspection-probe.mjs';

const {values: v} = parseArgs({options: {repo: {type: 'string'}}});
const repo = path.resolve(v.repo ?? '.');
const EXAMINED = [{tool: 'view_file', path: SCOPE[0], kind: 'file', sha256: 'sha256:' + 'a'.repeat(64), bytes: 10}];
const report = (over = {}) => ({question: 'root', sources: [{ref: SCOPE[0]}], observations: [{id: 'o1', text: 'scripted observation', sources: [SCOPE[0]]}], hypotheses: [], dependencies: [],
  unresolved: [], next: [], delegations: [], satisfied: true, material: true, summary: 'scripted conclusion', ...over});
function scripted(behave) {
  const calls = [];
  const sdk = async ({seat, prompt, admit, research, budget, timeoutS, worktree}) => {
    calls.push({model: seat.model, scope: research?.scope ?? null, tools: research?.tools ?? null, hide: research?.hide ?? null, budget, timeoutS, worktree});
    admit({class: 'root', type: null, model: seat.model, n: 1});
    return behave({seat, prompt, calls});
  };
  return {sdk, calls};
}
const state = () => fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-probe-offline-'));
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; } };

await check('refuses without --confirm-spend and sends nothing', async () => {
  const s = scripted(() => { throw new Error('must not be called'); });
  const r = await run({repo, state: state()}, {sdk: s.sdk});
  assert.equal(r.outcome, 'refused'); assert.equal(s.calls.length, 0);
});
await check('dry run: the plan and the bounded graph context, nothing sent', async () => {
  const r = await run({repo, state: state(), dryRun: true});
  assert.equal(r.outcome, 'dry-run'); assert.ok(r.context_text.length > 0 && Buffer.byteLength(r.context_text) <= 6200);
  assert.deepEqual(r.plan.scope, SCOPE); assert.equal(r.plan.billing.gemini_api_primary.budget, BUDGET);
});
await check('refuses a state directory inside the repository', async () => {
  const r = await run({repo, state: path.join(repo, 'probe-state'), confirmSpend: true});
  assert.equal(r.outcome, 'refused'); assert.match(r.why.join(' '), /inside the repository/);
});
await check('one coordinator on Carbon, the two files only, served model and examined paths kept, within the budget', async () => {
  const s = scripted(() => ({text: JSON.stringify(report()), examined: [{tool: 'view_file', path: SCOPE[0], kind: 'file', sha256: 'sha256:' + 'a'.repeat(64), bytes: 10}],
    served_model: MODEL, served_model_source: 'provider', usage: {total_token_count: 10}}));
  const st = state();
  const r = await run({repo, state: st, confirmSpend: true}, {sdk: s.sdk});
  assert.equal(r.outcome, 'satisfied', JSON.stringify(r).slice(0, 400));
  assert.deepEqual([...new Set(s.calls.map(c => c.model))], [MODEL]);
  assert.deepEqual(s.calls[0].scope, SCOPE);
  assert.deepEqual(s.calls[0].tools, ['view_file', 'list_directory', 'search_directory', 'find_file']);
  assert.ok(s.calls[0].hide.includes(st), 'the state directory is hidden from the session');
  assert.ok(r.requests.billed_all_attempts <= BUDGET);
  assert.deepEqual(r.served.map(x => [x.served_model, x.served_model_source]), [[MODEL, 'provider']]);
  assert.ok(fs.existsSync(path.join(st, 'probe-result.json')));
});
await check('a delegation is refused (max_depth 1): no specialist session runs', async () => {
  const s = scripted(({calls}) => ({text: JSON.stringify(calls.length === 1 ? report({satisfied: false, material: false, summary: 'needs more',
    unresolved: [{id: 'u1', question: 'what about it?', why: 'x'}], delegations: [{addresses: 'u1', question: 'Trace where the inspection writes last.json and why.', specialty: 'execution-trace', scope: [SCOPE[0]], expected_evidence: 'file and line', why: 'it decides whether the next idle tick retries'}]}) : report()),
    examined: EXAMINED, served_model: MODEL, served_model_source: 'provider', usage: null}));
  const r = await run({repo, state: state(), confirmSpend: true}, {sdk: s.sdk});
  assert.deepEqual([...new Set(s.calls.map(c => c.model))], [MODEL], 'no Hydrogen session');
  assert.ok(r.refusals.some(x => x.code === 'RESEARCH_DEPTH_EXCEEDED'), JSON.stringify(r.refusals));
});
await check('the budget of 6 holds across attempts with the same state', async () => {
  const st = state(), many = scripted(({calls}) => ({text: JSON.stringify(report({satisfied: false, material: false, summary: 'not yet', unresolved: [{id: 'u1', question: 'q?', why: 'x'}]})), examined: EXAMINED, served_model: MODEL, served_model_source: 'provider', usage: null}));
  await run({repo, state: st, confirmSpend: true}, {sdk: many.sdk});
  const r2 = await run({repo, state: st, confirmSpend: true}, {sdk: many.sdk});
  assert.ok(r2.requests.billed_all_attempts <= BUDGET, `billed ${r2.requests.billed_all_attempts}`);
});
await check('a response served by another model is recorded as served, never relabelled', async () => {
  const s = scripted(() => ({text: JSON.stringify(report()), examined: EXAMINED, served_model: 'gemini-4-neon', served_model_source: 'provider', usage: null}));
  const r = await run({repo, state: state(), confirmSpend: true}, {sdk: s.sdk});
  assert.ok(r.served.some(x => x.served_model === 'gemini-4-neon'), JSON.stringify(r.served));
});
await check('the model guard refuses a request for another model before it is sent (only the guard can: the request names a model the policy would bill)', async () => {
  let sentAfter = 0;
  const sdk = async ({seat, admit}) => {
    admit({class: 'root', type: null, model: seat.model, n: 1});
    try { admit({class: 'root', type: null, model: 'gemini-4-hydrogen', n: 2}); sentAfter++; } catch (e) { if (e.code !== 'MODEL_GUARD') throw e; return {text: JSON.stringify(report()), examined: EXAMINED, served_model: MODEL, served_model_source: 'provider', usage: null}; }
    throw new Error('the guard let a hydrogen request through');
  };
  const r = await run({repo, state: state(), confirmSpend: true}, {sdk});
  assert.equal(sentAfter, 0);
  assert.deepEqual(r.requests.guard_models.sort(), ['gemini-4-carbon', 'gemini-4-hydrogen']);
  assert.equal(r.requests.billed_this_run, 1, 'the refused request was never billed');
});
console.log(results.join('\n'));
