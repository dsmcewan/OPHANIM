#!/usr/bin/env node
// OFFLINE CHECK of carbon-inspection-probe.mjs through its REAL transport and its REAL command exit status. Each case
// runs the driver's own `main` in a child process (its exit status is the command's) with the REAL default transport
// (pantheon/src/antigravity/turn.mjs runAntigravitySdkTurn), the real python bridge and the installed SDK, against the
// existing scripted provider (pantheon/tests/fixtures/fake-gemini.mjs) on loopback, with a fake key. No provider, no
// credential, no network. Only the test-only `antigravity` options (upstream, key, python, sandbox, node bound) and a
// shorter run deadline differ from the live path, which passes none of them. Not on the live path.
//
// THE SANDBOX. The cases run the session UNJAILED (sandbox {enabled: false, allowUnsandboxed: true}, test-only). One
// case, `sandboxed-conclusion`, runs the default jail (bwrap) and records a LAYOUT-SCOPED finding at this driver: the
// driver hides its whole <state> and makes each session's control directory inside it (controlRoot). The jail sorts
// its binds by path depth and places the research-hide tmpfs right after the repository's bind, so when the
// repository is DEEPER than the control directory (here: the checkout under the scratchpad, <state> from mktemp under
// /tmp) the tmpfs over <state> is emitted after the control directory's bind, covers it, and the bridge cannot chdir:
// the session ends before its first model request. With <state> deeper than the repository the same jail works (a
// separate replay on LEXI reached its request in three layouts). Reported, not changed here.
//
// Without the SDK's python every transport case is reported UNVERIFIED and the check exits 1: nothing is passed by default.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import {spawnSync, execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DRIVER = path.join(path.dirname(SELF), 'carbon-inspection-probe.mjs');
const {values: v} = parseArgs({options: {repo: {type: 'string'}, child: {type: 'string'}, state: {type: 'string'}}, strict: false});
const repo = path.resolve(v.repo ?? '.');
const KEY = 'FAKE-KEY-offline-carbon-probe-0123456789';
const QUIET = 60_000;   // a stalled request: longer than any bound below

// ---- the scenarios: what the scripted provider does, and the bounds of the run ------------------------------------
const SCENARIOS = {
  // The run's deadline (the abort signal) fires while the FIRST request is still unanswered.
  'run-deadline-before-response': {deadlineMs: 12_000, timeoutS: 120, decide: () => ({delayMs: QUIET, parts: []})},
  // The node's bound fires while the first request is still unanswered.
  'node-deadline-before-response': {deadlineMs: 120_000, timeoutS: 8, decide: () => ({delayMs: QUIET, parts: []})},
  // One answer (a read of the scoped file, named gemini-4-carbon, usage 115), then the run's deadline during the second.
  'run-deadline-after-one-response': {deadlineMs: 15_000, timeoutS: 120, decide: firstThenStall},
  // The same, ended by the node's bound.
  'node-deadline-after-one-response': {deadlineMs: 120_000, timeoutS: 10, decide: firstThenStall},
  // Two answers under DISTINCT names for the one requested model: the raw names are kept, nothing is lifted.
  'distinct-names': {deadlineMs: 120_000, timeoutS: 60, decide: ({body, f}) => (f.responsesIn(body) === 0
    ? {parts: [f.fc('view_file', {AbsolutePath: path.join(repo, 'ophanim/operate/self-repair-inspect.mjs')})]}
    : {parts: [f.text(JSON.stringify(report()))], modelVersion: 'gemini-4-neon'})},
  // A read, then a valid report: a satisfied, concluded run.
  'conclusion': {deadlineMs: 120_000, timeoutS: 60, decide: concludes},
  // The same, in the default jail (bwrap): see THE SANDBOX above.
  'sandboxed-conclusion': {deadlineMs: 120_000, timeoutS: 60, jail: true, decide: concludes},
};
function concludes({body, f}) {
  return f.responsesIn(body) === 0 ? {parts: [f.fc('view_file', {AbsolutePath: path.join(repo, 'ophanim/operate/self-repair-inspect.mjs')})]} : {parts: [f.text(JSON.stringify(report()))]};
}
function firstThenStall({body, f}) {
  return f.responsesIn(body) === 0 ? {parts: [f.fc('view_file', {AbsolutePath: path.join(repo, 'ophanim/operate/self-repair-inspect.mjs')})]} : {delayMs: QUIET, parts: []};
}
function report() {
  const ref = 'ophanim/operate/self-repair-inspect.mjs';
  return {question: 'root', sources: [{ref}], observations: [{id: 'o1', text: 'scripted observation of the scoped file', sources: [ref]}], hypotheses: [], dependencies: [],
    unresolved: [], next: [], delegations: [], satisfied: true, material: true, summary: 'scripted conclusion'};
}

// ---- child: one case through the driver's main, its exit status is the process's ----------------------------------
if (v.child) {
  const sc = SCENARIOS[v.child];
  const f = await import(path.join(repo, 'pantheon/tests/fixtures/fake-gemini.mjs'));
  const {sdkPython} = await import(path.join(repo, 'pantheon/src/antigravity/turn.mjs'));
  const up = await f.startFakeGemini({decide: a => sc.decide({...a, f}), models: {'gemini-4-carbon': {}}});
  const {main} = await import(DRIVER);
  const code = await main(['--repo', repo, '--state', v.state, '--confirm-spend'], {deadlineMs: sc.deadlineMs,
    antigravity: {apiKey: KEY, upstream: up.url, python: sdkPython(), sandbox: sc.jail ? {enabled: true} : {enabled: false, allowUnsandboxed: true}, timeoutS: sc.timeoutS, graceS: 2}});
  fs.writeFileSync(path.join(v.state, 'upstream.json'), JSON.stringify(up.requests.map(r => ({seq: r.seq, model: r.model, verb: r.verb, aborted: r.aborted,
    key_is_fake: r.headers['x-goog-api-key'] === KEY}))));
  await up.close();
  process.exit(code);
}

// ---- parent -----------------------------------------------------------------------------------------------------
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-probe-transport-'));
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GEMINI|GOOGLE)_/.test(k)));   // no real key reaches a child
const cli = (args, env = ENV) => spawnSync(process.execPath, [DRIVER, ...args], {env, encoding: 'utf8', timeout: 120_000});
const child = (name, state) => { const t0 = Date.now(); const p = spawnSync(process.execPath, [SELF, '--child', name, '--repo', repo, '--state', state], {env: ENV, encoding: 'utf8', timeout: 240_000});
  return {status: p.status, ms: Date.now() - t0, stderr: p.stderr, result: JSON.parse(fs.readFileSync(path.join(state, 'probe-result.json'), 'utf8')),
    upstream: JSON.parse(fs.readFileSync(path.join(state, 'upstream.json'), 'utf8'))}; };
const gen = u => u.filter(r => r.verb);
const coordinator = r => r.served.filter(x => x.kind === 'coordinator');

// The real command, no scripted anything (nothing can be sent: no key reaches it).
await check('CLI: no arguments is a usage error (exit 2)', async () => { assert.equal(cli([]).status, 2); });
await check('CLI: --dry-run is a successful preflight (exit 0), nothing sent', async () => {
  const p = cli(['--repo', repo, '--state', tmp(), '--dry-run']); assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).outcome, 'dry-run'); });
await check('CLI: without --confirm-spend it refuses (exit 1)', async () => {
  const p = cli(['--repo', repo, '--state', tmp()]); assert.equal(p.status, 1); assert.equal(JSON.parse(p.stdout).outcome, 'refused'); });
await check('CLI: --confirm-spend with no key is refused by the transport preflight (exit 1), nothing sent', async () => {
  const st = tmp(), p = cli(['--repo', repo, '--state', st, '--confirm-spend']); assert.equal(p.status, 1);
  const out = JSON.parse(p.stdout); assert.equal(out.outcome, 'refused'); assert.match(out.why.join(' '), /NO_API_KEY/);
  assert.equal(fs.existsSync(path.join(st, 'gemini-usage.jsonl')), false, 'nothing was charged'); });

const PY = process.env.PANTHEON_ANTIGRAVITY_PYTHON ?? process.env.PANTHEON_AGY_PYTHON ?? null;
let sdkOk = false;
try { sdkOk = !!PY && JSON.parse(execFileSync(PY, [path.join(repo, 'pantheon/scripts/antigravity-bridge.py'), '--identity'], {encoding: 'utf8', timeout: 60_000})).sdk?.status === 'installed'; } catch { sdkOk = false; }
if (!sdkOk) { results.push('UNVERIFIED  the transport cases: no SDK python (set PANTHEON_ANTIGRAVITY_PYTHON)'); process.exitCode = 1; }
else {
  const neverReceived = (name, stop, why) => check(`${name}: exit 3; a request was sent and charged, none answered; no name, usage unknown, nothing lifted`, async () => {
    const c = child(name, tmp()), r = c.result;
    assert.equal(c.status, 3, `exit ${c.status} ${c.stderr.slice(-400)}`);
    assert.deepEqual([r.outcome, r.stop_reason, r.concluded, r.verdict.success], stop, JSON.stringify([r.outcome, r.stop_reason, r.error]));
    assert.ok(gen(c.upstream).length >= 1 && gen(c.upstream).every(x => x.key_is_fake), 'the scripted provider received the request(s), with the fake key');
    assert.ok(r.requests.billed_this_run >= 1, 'the sent request was charged');
    const [n] = coordinator(r), [o] = r.transport_observations;
    assert.deepEqual([n.served_model, n.served_model_source, n.usage], [null, null, 'unknown (none reported)']);
    assert.deepEqual([o.ended, o.gateway, o.served_names, o.unnamed_answers, o.provider_usage, o.lifted], ['threw', true, [], 0, null, {served_model: false, usage: false}]);
    assert.match(o.error_message, why);
    assert.equal(r.findings_text, null);
  });
  const oneRecorded = (name, stop, why) => check(`${name}: exit 3; the provider's one answer is kept: served gemini-4-carbon (provider), usage 115 as reported, the read kept`, async () => {
    const c = child(name, tmp()), r = c.result;
    assert.equal(c.status, 3, `exit ${c.status} ${c.stderr.slice(-400)}`);
    assert.deepEqual([r.outcome, r.stop_reason, r.concluded, r.verdict.success], stop, JSON.stringify([r.outcome, r.stop_reason, r.error]));
    assert.equal(gen(c.upstream).length, 2, 'one answered request and one stalled');
    assert.equal(r.requests.billed_this_run, 2);
    const [n] = coordinator(r), [o] = r.transport_observations;
    assert.deepEqual([o.ended, o.served_names, o.lifted], ['threw', ['gemini-4-carbon'], {served_model: true, usage: true}], JSON.stringify(o));
    assert.equal(o.provider_usage.total_token_count, 115);
    assert.match(o.error_message, why);
    assert.deepEqual([n.served_model, n.served_model_source], ['gemini-4-carbon', 'provider'], 'the lost identity is kept on the ledger node');
    assert.equal(n.usage[0].total_token_count, 115);
    assert.equal(n.ledger_usage.tokens, 115, 'the ledger counts the reported usage, not 0');
    assert.deepEqual(r.examined.map(e => e.path), ['ophanim/operate/self-repair-inspect.mjs']);
    assert.ok(r.verdict.why.some(w => /not satisfied/.test(w)), r.verdict.why.join('; '));
  });
  await neverReceived('run-deadline-before-response', ['cancelled', 'ABORTED', false, false], /./);
  await neverReceived('node-deadline-before-response', ['failed', 'lane_failure', false, false], /failed \(timeout\)/);
  await oneRecorded('run-deadline-after-one-response', ['cancelled', 'ABORTED', false, false], /./);
  await oneRecorded('node-deadline-after-one-response', ['failed', 'lane_failure', false, false], /failed \(timeout\)/);
  await check('distinct-names: exit 3; both provider names kept raw, none lifted onto the node, not verified', async () => {
    const c = child('distinct-names', tmp()), r = c.result;
    assert.equal(c.status, 3, `exit ${c.status} ${c.stderr.slice(-400)}`);
    const [o] = r.transport_observations, [n] = coordinator(r);
    assert.deepEqual([o.served_names, o.lifted?.served_model ?? null], [['gemini-4-carbon', 'gemini-4-neon'], false], JSON.stringify(o));
    assert.equal(n.served_model, null, 'no one name was chosen');
    assert.equal(r.verdict.success, false);
    assert.ok(r.verdict.why.some(w => /distinct names/.test(w)), r.verdict.why.join('; '));
  });
  await check('conclusion: exit 0; satisfied, concluded, verified: served gemini-4-carbon per the provider, findings recorded', async () => {
    const c = child('conclusion', tmp()), r = c.result;
    assert.equal(c.status, 0, `exit ${c.status} ${JSON.stringify(r.verdict)} ${c.stderr.slice(-400)}`);
    assert.deepEqual([r.outcome, r.stop_reason, r.concluded, r.verdict], ['satisfied', 'SATISFIED', true, {success: true, why: []}]);
    const [n] = coordinator(r), [o] = r.transport_observations;
    assert.deepEqual([n.state, n.served_model, n.served_model_source], ['finished', 'gemini-4-carbon', 'provider']);
    assert.deepEqual([o.ended, o.served_names], ['returned', ['gemini-4-carbon']]);
    assert.ok(r.findings_text);
    assert.equal(r.requests.billed_this_run, gen(c.upstream).length, 'every request sent was charged');
  });
  const {sandboxAvailable} = await import(path.join(repo, 'pantheon/src/agy/sandbox.mjs'));
  const bwrap = await sandboxAvailable('bwrap');
  if (!bwrap.ok) results.push(`UNVERIFIED  sandboxed-conclusion: bwrap is not usable here (${bwrap.why})`);
  else await check('FINDING sandboxed-conclusion (the default jail, this layout: repository deeper than <state>): exit 3; the session ends before any model request (the hide tmpfs over <state> follows the control directory\'s bind); nothing charged, nothing named', async () => {
    const st = tmp(), c = child('sandboxed-conclusion', st), r = c.result;
    assert.equal(c.status, 3, `exit ${c.status}`);
    assert.deepEqual([r.outcome, r.concluded, r.requests.billed_this_run, gen(c.upstream).length], ['failed', false, 0, 0], JSON.stringify([r.outcome, r.requests]));
    const [o] = r.transport_observations;
    assert.deepEqual([o.forwarded, o.served_names], [0, []]);
    assert.match(o.error_message, /bwrap: Can't chdir to .*ophanim-research-/);
    const ctl = /chdir to (\S+?):/.exec(o.error_message)?.[1] ?? null;
    assert.ok(ctl && path.dirname(ctl) === st, `the control directory ${ctl} is directly inside <state> ${st}`);
    results.push(`      layout: <state> ${st} (hidden: ${st}, ${path.join(st, 'work')}); controlRoot ${st}; session control dir ${ctl}; generate requests ${gen(c.upstream).length}; upstream ${JSON.stringify(c.upstream)}`);
    results.push(`      bridge: ${o.error_message}`);
  });
}
console.log(results.join('\n'));
