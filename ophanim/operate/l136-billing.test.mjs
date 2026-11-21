// REGISTER L-136 (extending L-124) AT THE OPERATE ENTRY POINTS: `tick`, `watch` and `serve` (ophanim/operate/cli.mjs main,
// real argv parsing; serve through service.mjs), and a killed-and-restarted `tick` process. The owner's decisions of
// 2026-11-19 (docs/billing-policy.md): metered Gemini failover and primary Gemini API execution are OFF unless declared,
// a key in the environment authorizes nothing, a refused stage keeps its work and resumes when the policy changes, every
// billed request is charged BEFORE it is sent and recorded (work.billing), and the budget is counted from the work
// ledger, so a retry, a restart or a later service tick cannot reset it.
//
// THE BILLED PATH REACHED: the fit implement stage's implementer. On this branch it is an Antigravity SDK session on the
// Gemini API (owner direction 2026-11-19; pantheon/src/antigravity): PRIMARY execution of the billing policy, with no
// lane in front of it and no failover behind it. Every model request of the session is one billed request, admitted by
// the policy and recorded on the work ledger before the controller's gateway forwards it. The provider edge is the
// scripted Gemini endpoint of the SDK transport (pantheon/tests/fixtures/dispatch.mjs installScriptedGemini), which
// RECORDS every generation request with the number of work.billing entries already on the work ledger when it arrived;
// the single-turn seats are the scripted --turn module (no Gemini API seat among them).
// THE FAILOVER KIND IS NOT REACHED THROUGH THE IMPLEMENTER HERE (on the base, these tests drove its Antigravity lane
// ladder to the metered spare; docs/OPEN-LIMITATIONS.md L-721). It is still resolved and enforced at every point of
// spend these stages use: the single-turn Gemini seats on a lane (pantheon/tests/l136-billing, quota-failover) and the
// validator's refusal with the failover off (reliability-r2-a3-rest.test.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {main} from './cli.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {readServiceConfig, runService} from './service.mjs';
import {fixture} from './test-fixtures.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const FIXTURES = pathToFileURL(path.join(HERE, 'test-fixtures.mjs')).href;
const DISPATCH = pathToFileURL(path.join(HERE, '../../pantheon/tests/fixtures/dispatch.mjs')).href;
// Synthetic credentials, and names that LOOK like an authorization: the policy reads neither.
const KEYS = {GEMINI_API_KEY: 'AIza-l136-synthetic-not-a-key-0000000000', GOOGLE_API_KEY: 'AIza-l136-synthetic-not-a-key-1111111111',
  METERED_GEMINI_FAILOVER: 'true', GEMINI_API_PRIMARY: '100'};
const jsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const FILES = JSON.stringify({files: [{path: 'alpha.mjs', content: 'export const ok = true;\n'}]});

/** The seat modules the CLI loads: scripted single-turn seats, and scripted clients that record every Gemini request. */
function seatModules(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const turn = path.join(dir, 'turn.mjs'), clients = path.join(dir, 'clients.mjs');
  fs.writeFileSync(turn, `import {scriptedTurn} from ${JSON.stringify(FIXTURES)};\nexport default scriptedTurn();\n`);
  fs.writeFileSync(clients, `import {scriptedClients} from ${JSON.stringify(DISPATCH)};
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
// THE PROVIDER EDGE: each Gemini request, with the work.billing entries persisted on the work ledger when it was sent.
const billings = () => { const f = process.env.L136_WORK_CHAIN; return f && existsSync(f) ? readFileSync(f, 'utf8').split('\\n').filter(l => l.includes('"kind":"work.billing"')).length : 0; };
let hang = false;
const make = scriptedClients([], prompt => (/TRANSPORT NOTE/.test(prompt) ? ${JSON.stringify(FILES)} : 'export const ok = true;\\n'), ({vendor, model}) => {
  if (vendor !== 'agy_google') return null;
  appendFileSync(process.env.L136_EDGE_LOG, JSON.stringify({vendor, model, work_billings: billings(), pid: process.pid}) + '\\n');
  hang = process.env.L136_HANG === '1';
  return null;
});
// L136_HANG: the request is recorded at the edge, then never answered (the process is killed in flight).
const hanging = (v, o) => { const c = make(v, o); if (v !== 'agy_google') return c;
  return {...c, models: {...c.models, generateContentStream: async req => { const s = await c.models.generateContentStream(req); if (hang) await new Promise(() => {}); return s; }}}; };
export default Object.assign(hanging, {providers: make.providers});
`);
  return {turn, clients};
}

async function withOperate(items, fn) {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, items.map(item => ({item})));
    const seats = seatModules(fs.mkdtempSync(path.join(os.tmpdir(), 'l136-seats-')));
    const edge = path.join(seats.turn, '..', 'edge.jsonl');
    const saved = Object.fromEntries([...Object.keys(KEYS), 'L136_EDGE_LOG', 'L136_WORK_CHAIN', 'L136_HANG'].map(k => [k, process.env[k]]));
    Object.assign(process.env, KEYS, {L136_EDGE_LOG: edge, L136_WORK_CHAIN: path.join(f.workRoot, 'chain.jsonl')});
    try {
      const at = ['--repo', repo, '--status-ledger', f.statusRoot, '--work-ledger', f.workRoot, '--turn', seats.turn, '--clients', seats.clients, '--total-provider-calls', '400'];
      const cli = async (argv, extra = {}) => {
        const out = [], err = [];
        const code = await main(argv, {log: s => out.push(s), err: s => err.push(s), env: {}, ...extra});
        let json = null;
        try { json = JSON.parse(out.join('\n')); } catch { json = null; }
        return {code, json, said: `exit ${code}\n${out.join('\n').slice(-2500)}\n${err.filter(l => !l.startsWith('{')).join('\n').slice(-1500)}`};
      };
      const ledger = () => openWorkLedger({root: f.workRoot});
      await fn({...ctx, repo, f, at, cli, edge: () => jsonl(edge), ledger, seats, edgeFile: edge,
        implement: item => ledger().stages(item).filter(s => s.stage === 'implement'), billings: kind => ledger().billings(kind)});
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(path.dirname(seats.turn), {recursive: true, force: true});
    }
  });
}
/** The SDK implementer refused by the policy before it is started: pending (transient, woken by a policy change), the run record kept, nothing billed. */
function refusedPending(rec, code, settings) {
  assert.equal(rec.status, 'pending', JSON.stringify(rec.blocker));
  assert.deepEqual([rec.blocker.code, rec.blocker.transient, rec.blocker.role, rec.blocker.billing.settings.primary], [code, true, 'decision-authority', settings]);
  assert.ok(rec.usage.gemini.refusals.length >= 1 && rec.usage.gemini.refusals.every(r => r.kind === 'primary' && r.code === code && r.provider_requests === 0), JSON.stringify(rec.usage.gemini));
  assert.equal(rec.usage.gemini.billed.gemini_api_primary, 0);
  assert.ok(rec.outputs.run?.record && fs.existsSync(rec.outputs.run.record), 'the pipeline run record (its work) is kept');
  assert.equal(rec.outputs.billing_refused.status_reported, 'blocked', 'the unit block it reported is kept beside the billing refusal');
}
/** Each billed request was preceded by its own work.billing entry. */
const chargedBefore = edge => edge.forEach((r, i) => assert.ok(r.work_billings >= i + 1, `billed request ${i + 1} was sent with only ${r.work_billings} work.billing entr(ies): it was not charged before it was sent`));

test('operate tick: with a key present and nothing declared the SDK implementer is refused and recorded, the stage waits pending with its work; the same policy refuses again; the policy declared wakes it, the request is charged before it is sent and recorded; the budget spent refuses the next item', {timeout: 300_000}, async () => {
  await withOperate(['alpha', 'beta'], async o => {
    // (a) the key present (and look-alike variables), nothing declared.
    const off = await o.cli(['tick', '--init', '--item', 'alpha', '--iterations', '2', ...o.at]);
    assert.equal(off.code, 0, off.said);
    assert.deepEqual(off.json.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed', 'implement:pending'], off.said);
    assert.deepEqual(o.edge(), [], 'no billed Gemini request reached the provider edge');
    assert.deepEqual(o.billings(), [], 'nothing charged as Gemini usage');
    refusedPending(o.implement('alpha')[0], 'GEMINI_PRIMARY_DISABLED', {enabled: false, budget: null});
    assert.deepEqual([off.json.billing.gemini_api_primary.enabled, off.json.billing.used.gemini_api_primary], [false, 0]);
    // The same policy again: the refused stage is not re-dispatched (it waits for its retry or a policy change); nothing billed.
    const again = await o.cli(['tick', '--item', 'alpha', ...o.at]);
    assert.deepEqual(again.json.dispatched, [], again.said);
    assert.ok(again.json.blockers.some(b => b.item === 'alpha' && b.code === 'GEMINI_PRIMARY_DISABLED'), again.said);
    assert.deepEqual(o.edge(), []);
    // (b) the owner declares primary Gemini execution with a budget: the pending stage is woken at once and resumed.
    const on = await o.cli(['tick', '--item', 'alpha', '--iterations', '1', '--gemini-api-primary', '1', ...o.at]);
    assert.deepEqual(on.json.dispatched.map(d => `${d.stage}:${d.status}`), ['implement:passed'], on.said);
    assert.equal(o.edge().length, 1);
    chargedBefore(o.edge());
    const [row] = o.billings('primary');
    assert.deepEqual([row.item, row.stage, row.kind, row.vendor, row.purpose, row.role, row.source, row.budget, row.used_before],
      ['alpha', 'implement', 'primary', 'agy_google', 'implementer', 'implementer', 'flag --gemini-api-primary 1', 1, 0], 'the usage record: kind, seat, model, purpose, source, budget');
    const passed = o.implement('alpha').at(-1);
    assert.deepEqual([passed.usage.gemini.billed.gemini_api_primary, passed.usage.gemini.policy.gemini_api_primary.budget], [1, 1], 'the stage record carries the policy it ran under and what it billed');
    // (c) the budget spent (on alpha): beta's session is refused before it is admitted or sent.
    const spent = await o.cli(['tick', '--item', 'beta', '--iterations', '2', '--gemini-api-primary', '1', ...o.at]);
    assert.deepEqual(spent.json.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed', 'implement:pending'], spent.said);
    assert.equal(o.edge().length, 1, 'no further request was sent');
    refusedPending(o.implement('beta')[0], 'METERED_GEMINI_BUDGET_EXHAUSTED', {enabled: true, budget: 1});
    // The owner raises the budget: woken and resumed.
    const raised = await o.cli(['tick', '--item', 'beta', '--iterations', '1', '--gemini-api-primary', '2', ...o.at]);
    assert.deepEqual(raised.json.dispatched.map(d => `${d.stage}:${d.status}`), ['implement:passed'], raised.said);
    chargedBefore(o.edge());
    assert.deepEqual(o.billings('primary').map(b => [b.item, b.used_before, b.budget]), [['alpha', 0, 1], ['beta', 1, 2]]);
    // A malformed or unbudgeted flag: a usage error before anything runs.
    for (const bad of [['--gemini-api-primary', '0'], ['--gemini-api-primary', 'true'], ['--metered-gemini-failover', 'x']]) {
      const r = await o.cli(['tick', '--item', 'alpha', ...bad, ...o.at]);
      assert.equal(r.code, 2, r.said);
      assert.match(r.said, /GEMINI_BILLING_INVALID/);
    }
  });
});

test('operate watch --once: refused and recorded with a key present and nothing declared; the declared policy resumes and bills it; the spent budget refuses the next', {timeout: 300_000}, async () => {
  await withOperate(['alpha', 'beta'], async o => {
    const off = await o.cli(['watch', '--once', '--init', '--item', 'alpha', '--iterations', '2', ...o.at]);
    assert.equal(off.code, 0, off.said);
    assert.deepEqual(off.json.ticks[0].dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed', 'implement:pending'], off.said);
    assert.deepEqual(o.edge(), []);
    refusedPending(o.implement('alpha')[0], 'GEMINI_PRIMARY_DISABLED', {enabled: false, budget: null});
    const on = await o.cli(['watch', '--once', '--item', 'alpha', '--iterations', '1', '--gemini-api-primary', '1', ...o.at]);
    assert.deepEqual(on.json.ticks[0].dispatched.map(d => `${d.stage}:${d.status}`), ['implement:passed'], on.said);
    chargedBefore(o.edge());
    assert.equal(o.billings('primary').length, 1);
    const spent = await o.cli(['watch', '--once', '--item', 'beta', '--iterations', '2', '--gemini-api-primary', '1', ...o.at]);
    assert.deepEqual(spent.json.ticks[0].dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed', 'implement:pending'], spent.said);
    assert.equal(o.edge().length, 1);
    refusedPending(o.implement('beta')[0], 'METERED_GEMINI_BUDGET_EXHAUSTED', {enabled: true, budget: 1});
  });
});

test('operate serve (service config billing): with a key present and no billing declared the SDK implementer is refused and recorded, the stages wait with their work; the declared policy wakes them and holds across ticks; the budget consumed in one tick refuses a later tick\'s request; a retried refused attempt stays refused; an unbudgeted config is refused before anything runs', {timeout: 300_000}, async () => {
  await withOperate(['alpha', 'beta'], async o => {
    const stateDir = path.join(o.repo, 'status', 'operate', 'service');
    const config = billing => {
      const file = path.join(o.repo, 'status', `service-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify({schema: 'ophanim.operate-service/v1', repo: o.repo, status_ledger: o.f.statusRoot, work_ledger: o.f.workRoot, state_dir: stateDir,
        seats: {turn: o.seats.turn, clients: o.seats.clients}, interval_s: 10, limits: {total_provider_calls: 400, stage_provider_calls: 40, iterations: 12, stage_attempts: 3},
        ...(billing ? {billing} : {})}));
      return file;
    };
    // Enabled without a budget: refused before anything runs (no ledger, no status file).
    const bad = await o.cli(['serve', '--config', config({gemini_api_primary: {enabled: true}})]);
    assert.equal(bad.code, 2, bad.said);
    assert.match(bad.said, /GEMINI_BILLING_INVALID: gemini_api_primary is enabled .* without a declared budget/);
    assert.equal(fs.existsSync(path.join(o.f.workRoot, 'ANCHOR')), false, 'nothing ran');
    fs.mkdirSync(o.f.workRoot, {recursive: true});
    openWorkLedger({root: o.f.workRoot});
    let now = Date.parse('2026-11-19T12:00:00Z');
    // (a) A config that declares NO billing, with the key present: both items are planned, and each implement's session is
    // refused before it is admitted and recorded; the stages wait pending with their work; nothing reaches the edge.
    const r0 = await runService({config: readServiceConfig(config(null)), maxTicks: 3, clock: () => now, sleep: async () => { now += 1000; }});
    assert.equal(r0.code, 0, JSON.stringify(r0));
    assert.deepEqual(o.edge(), [], 'no billed Gemini request reached the provider edge');
    assert.deepEqual(o.billings(), [], 'nothing charged as Gemini usage');
    for (const item of ['alpha', 'beta']) refusedPending(o.implement(item).at(-1), 'GEMINI_PRIMARY_DISABLED', {enabled: false, budget: null});
    const off = JSON.parse(fs.readFileSync(path.join(stateDir, 'service-status.json'), 'utf8'));
    assert.deepEqual([off.billing.gemini_api_primary.enabled, off.billing.metered_gemini_failover.enabled, off.billing.used.gemini_api_primary], [false, false, 0]);
    // (b) ONE service, ONE declared policy (budget 1), across its ticks: the changed policy wakes both refused stages; alpha's
    // request is charged before it is sent, then beta's is refused -- the budget consumed is counted from the ledger.
    const c1 = readServiceConfig(config({gemini_api_primary: {enabled: true, budget: 1}}));
    const r1 = await runService({config: c1, maxTicks: 3, clock: () => now, sleep: async () => { now += 1000; }});
    assert.equal(r1.code, 0, JSON.stringify(r1));
    assert.equal(o.billings('primary').length, 1);
    assert.equal(o.edge().length, 1);
    chargedBefore(o.edge());
    assert.equal(o.implement('alpha').at(-1).status, 'passed');
    refusedPending(o.implement('beta').at(-1), 'METERED_GEMINI_BUDGET_EXHAUSTED', {enabled: true, budget: 1});
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'service-status.json'), 'utf8'));
    assert.deepEqual([status.billing.gemini_api_primary.budget, status.billing.used.gemini_api_primary], [1, 1], 'the service status shows the policy and the consumption');
    // (c) A RESTART of the service with the same policy, its retry due: the refused attempt is retried and refused again.
    const triedBefore = o.implement('beta').length;
    now += 16 * 60_000;
    const r2 = await runService({config: c1, maxTicks: 1, clock: () => now, sleep: async () => {}});
    assert.equal(r2.code, 0);
    const betaTries = o.implement('beta');
    assert.equal(betaTries.length, triedBefore + 1, 'the due retry ran');
    refusedPending(betaTries.at(-1), 'METERED_GEMINI_BUDGET_EXHAUSTED', {enabled: true, budget: 1});
    assert.equal(o.edge().length, 1, 'the retry sent nothing: a restart did not reset the budget');
    // The owner raises the budget in the config: the next service run wakes beta at once.
    const r3 = await runService({config: readServiceConfig(config({gemini_api_primary: {enabled: true, budget: 2}})), maxTicks: 1, clock: () => now, sleep: async () => {}});
    assert.equal(r3.code, 0);
    assert.equal(o.implement('beta').at(-1).status, 'passed');
    chargedBefore(o.edge());
    assert.deepEqual(o.billings('primary').map(b => [b.item, b.source.endsWith('billing.gemini_api_primary'), b.budget]), [['alpha', true, 1], ['beta', true, 2]]);
  });
});

test('operate tick, KILLED and restarted: the billed request was recorded before it was sent, so the restarted run counts it and refuses the next one under the same budget', {timeout: 300_000}, async () => {
  await withOperate(['alpha'], async o => {
    const plan = await o.cli(['tick', '--init', '--item', 'alpha', '--iterations', '1', ...o.at]);
    assert.deepEqual(plan.json.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed'], plan.said);
    // A tick in its own process, killed while its billed request is in flight (the edge never answers it).
    const preload = path.join(path.dirname(o.seats.turn), 'scripted-gemini.preload.mjs');
    fs.writeFileSync(preload, `import {installScriptedGemini} from ${JSON.stringify(DISPATCH)};\ninstallScriptedGemini();\n`);
    const child = spawn(process.execPath, ['--import', preload, CLI, 'tick', '--item', 'alpha', '--iterations', '1', '--lease-ms', '20000', '--gemini-api-primary', '1', ...o.at],
      {env: {...process.env, L136_HANG: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const t0 = Date.now();
    while (o.edge().length === 0) {
      if (Date.now() - t0 > 120_000) { child.kill('SIGKILL'); assert.fail(`the billed request never reached the edge:\n${stderr.slice(-2000)}`); }
      await new Promise(r => setTimeout(r, 100));
    }
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
    assert.equal(o.edge().length, 1);
    chargedBefore(o.edge());
    assert.equal(o.billings('primary').length, 1, 'the killed run\'s billed request is on the work ledger');
    assert.deepEqual(o.implement('alpha'), [], 'the killed attempt recorded no stage');
    // THE RESTART, with the same budget, once the killed claim's lease has expired.
    await new Promise(r => setTimeout(r, 21_000));
    process.env.L136_HANG = '0';
    const restart = await o.cli(['tick', '--item', 'alpha', '--iterations', '1', '--gemini-api-primary', '1', ...o.at]);
    assert.deepEqual(restart.json.dispatched.map(d => `${d.stage}:${d.status}`), ['implement:pending'], restart.said);
    assert.equal(o.edge().length, 1, 'nothing more was sent: the restart did not reset the budget');
    refusedPending(o.implement('alpha')[0], 'METERED_GEMINI_BUDGET_EXHAUSTED', {enabled: true, budget: 1});
  });
});
