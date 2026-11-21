// A PROVIDER REFUSING THE ACCOUNT STOPS THE RUN; IT USES NO ATTEMPT (register KG-39).
//
// Observed on 2026-11-21 (a live run of the five plan-gate items): every planner call came back from Anthropic as
// 400 invalid_request_error "Your credit balance is too low to access the Anthropic API". The plan stage read that as a
// malformed answer, asked the planner twice more, recorded the plan `failed` -- one of its stage_attempts (3) gone -- and
// the scheduler went on to the next item, which failed the same way; left alone, every runnable item would have spent
// all of its attempts and waited on the owner raising the retry limit. These cells fail on that scheduler: a refusal of
// the ACCOUNT (no credit, a spend cap or exhausted quota, a key that is not valid) is not a property of the item. The
// stage that did not pass under it is recorded PENDING on a transient owner blocker that names the provider and what
// to fix; the stage's meter sends that provider nothing more; the tick stops; and the refusal counts against no
// attempt bound, so the item is planned as soon as the account is restored. Every error below is SYNTHETIC, shaped
// like the vendor SDK's own (status, parsed body, message); nothing reaches a provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openWorkLedger} from './work-ledger.mjs';
import {makeExecutors} from './stages.mjs';
import {tickWithPrimary as tick, fixture, scriptedTurn, planFor, json, APPROVE, FIVE} from './test-fixtures.mjs';
import {accountRefusal, ACCOUNT_REFUSED} from './account-refusal.mjs';

const mkTmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// As @anthropic-ai/sdk's APIError: the status, the parsed body, and a message of the status and the body.
const anthropicError = (status, body) => Object.assign(new Error(`${status} ${JSON.stringify(body)}`), {status, error: body});
// As the openai SDK's APIError: the body's `error` object, its code, and a message of the status and the error's message.
const openaiError = (status, error) => Object.assign(new Error(`${status} ${error.message}`), {status, error, code: error.code ?? null});
const CREDIT = () => anthropicError(400, {type: 'error', error: {type: 'invalid_request_error',
  message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'}, request_id: 'req_synthetic'});
// xAI answers an unknown key with 400 and the message as the body's `error` string (observed 2026-11-21).
const XAI_KEY = () => Object.assign(new Error('400 Incorrect API key provided: xa***yz. You can obtain an API key from https://console.x.ai.'),
  {status: 400, error: 'Incorrect API key provided: xa***yz. You can obtain an API key from https://console.x.ai.'});

test('ACCOUNT REFUSAL, classified: no credit, a spend cap, exhausted quota and a key that is not valid are refusals of the account; a rate limit, a bad request, a vendor error, the network and the meter\'s own refusals are not', () => {
  const seat = {vendor: 'anthropic', model: 'claude-fable-5-2'};
  const cases = [
    [CREDIT(), 'credit', 400],
    [anthropicError(401, {type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}}), 'key', 401],
    [anthropicError(429, {type: 'error', error: {type: 'rate_limit_error', message: 'spend limit', details: {error_code: 'enforced_spend_limit_reached'}}}), 'quota', 429],
    [openaiError(429, {message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota'}), 'quota', 429],
    [openaiError(401, {message: 'Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key'}), 'key', 401],
    [XAI_KEY(), 'key', 400],
    // As @google/genai's ApiError: the status, and the body as the message.
    [Object.assign(new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'), {status: 400}), 'key', 400],
  ];
  for (const [e, kind, status] of cases) {
    const r = accountRefusal(e, seat);
    assert.ok(r, `${e.message.slice(0, 80)}: a refusal of the account`);
    assert.equal(r.code, ACCOUNT_REFUSED);
    assert.deepEqual([r.vendor, r.model, r.kind, r.status], ['anthropic', 'claude-fable-5-2', kind, status], e.message.slice(0, 80));
    assert.ok(typeof r.why === 'string' && r.why.length > 0 && r.why.length <= 300, r.why);
  }
  const rateLimited = anthropicError(429, {type: 'error', error: {type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit'}});
  rateLimited.headers = new Headers({'retry-after': '20'});
  const not = [
    rateLimited,
    anthropicError(400, {type: 'error', error: {type: 'invalid_request_error', message: 'max_tokens: 9999999 > 128000, which is the maximum allowed'}}),
    anthropicError(529, {type: 'error', error: {type: 'overloaded_error', message: 'Overloaded'}}),
    openaiError(500, {message: 'The server had an error while processing your request.', type: 'server_error', code: null}),
    Object.assign(new Error('Connection error.'), {code: 'ECONNRESET'}),
    Object.assign(new Error('PROVIDER_CALL_LIMIT: 4 of 4 stage provider call(s) used'), {code: 'PROVIDER_CALL_LIMIT'}),
    Object.assign(new Error('STAGE_ELAPSED: the stage was stopped'), {code: 'STAGE_ELAPSED'}),
    new Error('anthropic/claude-fable-5-2: the reply did not complete (max_tokens)'),
    null, undefined, 'a string',
  ];
  for (const e of not) assert.equal(accountRefusal(e, seat), null, String(e?.message ?? e));
});

test('ACCOUNT REFUSAL, the planner: a plan refused for the account is PENDING on an owner blocker, the planner is asked once, and the tick stops before the next item', async t => {
  const repo = mkTmp('acct-planner-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'one'}, {item: 'two'}]);
  const turn = scriptedTurn({planner: () => { throw CREDIT(); }});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 1000, stage_provider_calls: 40}});
  assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1, `the planner is asked once in the whole tick: ${JSON.stringify(turn.log)}`);
  assert.equal(r.stop?.code, ACCOUNT_REFUSED, JSON.stringify(r.stop));
  assert.match(r.stop.why, /anthropic/);
  assert.equal(r.dispatched.length, 1, `nothing after the refused stage: ${JSON.stringify(r.dispatched)}`);
  const [first] = r.dispatched, other = first.item === 'one' ? 'two' : 'one';
  const w = openWorkLedger({root: f.workRoot, create: false});
  const plan = w.stages(first.item).find(s => s.stage === 'plan');
  assert.equal(plan.status, 'pending');
  assert.equal(plan.blocker?.code, ACCOUNT_REFUSED, JSON.stringify(plan.blocker));
  assert.equal(plan.blocker.transient, true);
  assert.ok(Number.isFinite(Date.parse(plan.blocker.retry_at ?? '')), 'retried when due');
  assert.equal(plan.blocker.role, 'decision-authority');
  assert.deepEqual(plan.blocker.account, {vendor: 'anthropic', model: turn.log.find(l => l.kind === 'planner').model, kind: 'credit', status: 400});
  assert.match(plan.blocker.what, /credit balance is too low/);
  assert.match(plan.blocker.resume_when, /anthropic/);
  assert.equal(plan.outputs.account_refused.status_reported, 'failed', 'the stage\'s own result is kept beside the refusal');
  assert.equal(w.stages(other).length, 0, `${other}: not dispatched`);
});

test('ACCOUNT REFUSAL, a reviewer: the plan and its open cycle are kept, that provider is sent nothing more in the stage, and the stage waits on the refusal instead of REVIEW_PENDING', async t => {
  const repo = mkTmp('acct-reviewer-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'rev'}]);
  const turn = scriptedTurn({'plan-review': ({vendor}) => { if (vendor === 'xai') throw XAI_KEY(); return APPROVE; }});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 1000, stage_provider_calls: 40}});
  assert.equal(turn.log.filter(l => l.vendor === 'xai').length, 1, `xai is asked once: ${JSON.stringify(turn.log.filter(l => l.vendor === 'xai'))}`);
  assert.equal(r.stop?.code, ACCOUNT_REFUSED);
  const plan = openWorkLedger({root: f.workRoot, create: false}).stages('rev').find(s => s.stage === 'plan');
  assert.equal(plan.status, 'pending');
  assert.equal(plan.blocker?.code, ACCOUNT_REFUSED, JSON.stringify(plan.blocker));
  assert.deepEqual([plan.blocker.account.vendor, plan.blocker.account.kind], ['xai', 'key']);
  assert.ok(plan.outputs.plan && plan.outputs.cycle, 'the plan and its open cycle are kept');
  assert.equal(plan.outputs.account_refused.status_reported, 'pending');
});

test('ACCOUNT REFUSAL uses no attempt: an item refused for the account more times than its stage_attempts is planned once the account is restored', async t => {
  const repo = mkTmp('acct-attempts-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'later'}]);
  let restored = false;
  const turn = scriptedTurn({planner: ({prompt}) => { if (!restored) throw CREDIT(); return json(planFor(prompt)); }});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const base = Date.now(), step = 16 * 60_000;   // past the scheduler's retry_after_ms (15 minutes) each time
  const limits = {total_provider_calls: 1000, stage_provider_calls: 40, iterations: 1, stage_attempts: 3};
  for (let k = 0; k < 4; k++) {
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits, clock: () => base + k * step});
    assert.deepEqual(r.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:pending'], `refusal ${k + 1}: retried, not blocked by the attempt bound: ${JSON.stringify(r.blockers ?? r.blocked)}`);
  }
  restored = true;
  const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits, clock: () => base + 4 * step});
  assert.deepEqual(r.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed'], JSON.stringify(r.blocked));
});

test('ACCOUNT REFUSAL, thrown by an executor: the provider\'s error an executor lets through is read the same way, and the stage waits on it instead of failing', async t => {
  const repo = mkTmp('acct-thrown-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'thrown'}]);
  const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: async () => { throw CREDIT(); }}, limits: {total_provider_calls: 1000, stage_provider_calls: 40}});
  assert.equal(r.stop?.code, ACCOUNT_REFUSED, JSON.stringify(r.stop));
  const plan = openWorkLedger({root: f.workRoot, create: false}).stages('thrown').find(s => s.stage === 'plan');
  assert.equal(plan.status, 'pending');
  assert.equal(plan.blocker?.code, ACCOUNT_REFUSED, JSON.stringify(plan.blocker));
  assert.equal(plan.blocker.account.kind, 'credit');
  assert.equal(plan.outputs.account_refused.status_reported, 'failed');
});
