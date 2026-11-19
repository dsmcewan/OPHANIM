// Regression tests for the remaining findings of independent review round 2, assignment 3 (Google gemini-4-carbon,
// manual, 77480d6): execution reliability. Each test names the finding it pins; each failed on b5b088b (the commit that
// merged the seven blockers' fixes). New exports are reached through namespace imports, so this file loads on b5b088b
// and its tests fail there by assertion.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import * as LR from './live-run.mjs';
import {fixture, scriptedTurn, planFor, json, git, FIVE, SIX, LIMITS, stagesOf} from './test-fixtures.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';

const mkTmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const APPROVE = '```json\n{"verdict":"approve","findings":[]}\n```';
const manifestFor = ({root, f, item, head, name, limits, over = {}}) => LR.validateManifest({schema: LR.LIVE_RUN_SCHEMA, item, candidate_commit: head, profile: 'fit', independence: 'model',
  limits, billing: {scope: 'test', metered_gemini_failover: false, note: ''}, ledgers: {status_root: f.statusRoot, work_root: path.join(root, name, 'work')},
  credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used'}, out_dir: path.join(root, name), ...over}, {baseDir: root});
const confirmed = (root, m, turn, d, extra = {}) => LR.runConfirmed({manifest: m, digest: 'sha256:' + d.repeat(64), file: path.join(root, `${d}.json`)}, {ok: true},
  LR.statusLedgerState(m.ledgers.status_root), LR.inspectWorkRoot(m.ledgers.work_root, m.item),
  {repo: extra.repo, seats: {turn, makeClientFor: () => ({})}, makeExecutorsImpl: extra.makeExecutorsImpl ?? (opts => makeExecutors({...opts, seating: FIVE.seating, facts: FIVE.facts}))});

// ---- finding 2.2 (and 10.1): a deterministic pipeline bound is not retried; the record is verified after it is written

test('finding 2.2: a stage stopped at the pipeline\'s own lower bound, with no unit approved, is not retried by runConfirmed; finding 10.1: run.json and pipeline.json are verified by digest after run.json is written', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), findings 2.2 and 10.1:
  // runConfirmed re-ran implement stage_attempts (3) times against pipeline.max_provider_calls = 1; the verification ran
  // before run.json existed and never checked pipeline.json against the digest of its stage.
  const root = mkTmp('r2a3r-f22-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const f = fixture(repo, [{item: 'cap-item'}]);
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const m = manifestFor({root, f, item: 'cap-item', head, name: 'out', limits: {total_provider_calls: 200, stage_provider_calls: 20, revisions: 1, stage_attempts: 3, elapsed_ms: 60_000,
    pipeline: {max_provider_calls: 1, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 10_000}}});
  const r = await confirmed(root, m, scriptedTurn(), '0', {repo});
  const impls = r.record.stages.filter(s => s.stage === 'implement');
  assert.equal(impls.length, 1, `implement ran once, not stage_attempts times: ${impls.length}`);
  const stop = r.record.budget_stops.find(s => s.source === 'launcher' && s.code === 'PIPELINE_PROVIDER_CALLS');
  assert.ok(stop, JSON.stringify(r.record.budget_stops));
  assert.match(stop.why, /not retried/);

  // 10.1: the child verified run.json itself (its body, by digest) and the pipeline record by its stage's digest.
  const v = r.record.verification;
  assert.equal(v.ok, true, JSON.stringify(v).slice(0, 2000));
  assert.equal(v.run_record?.ok, true, JSON.stringify(v.run_record));
  const onDisk = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(v.run_record.body_digest, 'sha256:' + digest(LR.runRecordBody(onDisk)), 'the verified body is the body on disk');
  assert.ok(v.pipelines?.length >= 1 && v.pipelines.every(p => p.ok && p.digest === p.recorded_digest), JSON.stringify(v.pipelines));
  // A changed pipeline record, and a run.json that misstates a stage, are failures of a fresh verification.
  const stages = openWorkLedger({root: m.ledgers.work_root, create: false}).stages('cap-item');
  const status = LR.statusLedgerState(m.ledgers.status_root);
  const rec = stages.find(s => s.stage === 'implement').outputs.run.record;
  fs.appendFileSync(rec, ' ');
  const tampered = LR.freshVerification({workRoot: m.ledgers.work_root, stages, statusRoot: m.ledgers.status_root, statusBefore: status, runFile: r.file});
  assert.equal(tampered.ok, false);
  assert.match(tampered.pipelines.find(p => !p.ok).why, /changed/);
  fs.writeFileSync(r.file, JSON.stringify({...onDisk, stages: onDisk.stages.map(s => ({...s, status: 'passed'}))}));
  const lied = LR.freshVerification({workRoot: m.ledgers.work_root, stages, statusRoot: m.ledgers.status_root, statusBefore: status, runFile: r.file});
  assert.equal(lied.run_record?.ok, false);
});

// ---- finding 2.3: a reviewer budget stop is a budget stop

test('finding 2.3: a plan review left incomplete by the stage\'s provider-call budget is recorded STAGE_PROVIDER_CALLS, not REVIEW_PENDING', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 2.3.
  const repo = mkTmp('r2a3r-f23-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'budget'}]);
  let retrieved = false;
  const turn = scriptedTurn({'plan-review': () => (retrieved ? APPROVE : (retrieved = true, '```json\n{"requests":[{"op":"file","path":"alpha.mjs"}]}\n```'))});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 100, stage_provider_calls: 4, iterations: 1}});
  const plan = openWorkLedger({root: f.workRoot, create: false}).stages('budget').find(s => s.stage === 'plan');
  assert.equal(plan.status, 'pending');
  assert.equal(plan.blocker?.code, 'STAGE_PROVIDER_CALLS', JSON.stringify(plan.blocker));
  assert.doesNotMatch(plan.blocker.what, /^REVIEW_PENDING/);
  assert.match(plan.blocker.what, /provider-call budget/);
  assert.match(plan.next.why, /budget/);
});

// ---- finding 3.2b: bookkeeping under a race

/**
 * Another scheduler process records the same bookkeeping between this tick's read and its first append: the first time
 * this tick takes the work ledger's append lock, a second tick runs its bookkeeping (synchronous up to its first await)
 * on the same ledger. Its own lock takes pass through.
 */
async function racedTick(f, repo, limits = {}) {
  const lockFile = path.join(f.workRoot, 'chain.jsonl.lock');
  const open = fs.openSync;
  let fired = false, inner = null;
  fs.openSync = function racing(p, flags, ...rest) {
    if (!fired && p === lockFile && flags === 'wx') {
      fired = true;
      inner = tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits: {total_provider_calls: 0}, holder: 'other'});
    }
    return open.call(fs, p, flags, ...rest);
  };
  try {
    const outer = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits: {total_provider_calls: 0, ...limits}});
    return {outer, inner: await inner, fired};
  } finally { fs.openSync = open; }
}

test('finding 3.2b: a release, an intake or a recovery that another scheduler recorded first does not crash the tick', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.2b: the work ledger
  // refused the duplicate under its lock (one release per claim, one intake per source, one recovery per sources), and
  // tick() threw LEDGER_REFUSED.
  const root = mkTmp('r2a3r-f32b-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const setup = (name, items) => { const repo = path.join(root, name); fs.mkdirSync(repo); return {repo, f: fixture(repo, items)}; };

  // (a) intake: the first append of the tick is an intake.
  {
    const {repo, f} = setup('intake', [{item: 'fresh'}]);
    openWorkLedger({root: f.workRoot});
    const r = await racedTick(f, repo);
    assert.ok(r.fired);
    assert.deepEqual(r.outer.intake, [], 'the other process recorded the intake');
    assert.equal(openWorkLedger({root: f.workRoot}).intakes().filter(i => i.ref === 'status:fresh').length, 1);
  }
  // (b) release: an expired claim, released by both.
  {
    const {repo, f} = setup('release', [{item: 'held'}]);
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits: {total_provider_calls: 0}});
    const w = openWorkLedger({root: f.workRoot});
    w.claim({item: 'held', stage: 'plan', attempt: 1, inputs: {upstream: null, requirement: null}, holder: 'dead', budget: {provider_calls: 0, iterations: 1, elapsed_ms: 1, retries: 1}, lease_ms: 1, at: '2026-11-18T00:00:00.000Z'});
    const r = await racedTick(f, repo);
    assert.ok(r.fired);
    assert.equal(r.outer.released_expired[0]?.by_another, true, JSON.stringify(r.outer.released_expired));
    assert.equal(openWorkLedger({root: f.workRoot}).releases().length, 1);
  }
  // (c) recovery: an item Resolved without evidence, searched by both.
  {
    const {repo, f} = setup('recovery', [{item: 'gap', state: 'Resolved', basis: 'done (attested)'}]);
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits: {total_provider_calls: 0, recoveries: 0}});
    const r = await racedTick(f, repo);
    assert.ok(r.fired);
    assert.equal(r.outer.recovery[0]?.by_another, true, JSON.stringify(r.outer.recovery));
    assert.equal(openWorkLedger({root: f.workRoot}).recoveries('gap').length, 1);
  }
});

// ---- finding 3.3: one checkout, several items

test('finding 3.3: a ticket the lifecycle wrote (this item\'s or a concurrent item\'s) does not fail an implement whose copy covers tickets/', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.3: with copy ["."],
  // the uncommitted tickets/<item>.json of item-1's plan failed item-2's dirty-copy check. Item-2's own ticket did too,
  // concurrency or not: the check is what was wrong.
  const repo = mkTmp('r2a3r-f33-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'item-1'}, {item: 'item-2'}]);
  const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {copy: ['.']}))});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 200, stage_provider_calls: 20, concurrency: 2, iterations: 4}});
  const w = openWorkLedger({root: f.workRoot, create: false});
  for (const item of ['item-1', 'item-2']) {
    const impl = w.stages(item).find(s => s.stage === 'implement');
    assert.ok(impl, `${item} reached implement`);
    assert.doesNotMatch(impl.next?.why ?? '', /copy paths have uncommitted changes/, `${item}: ${impl.next?.why} ${impl.outputs?.dirty ?? ''}`);
  }
});

test('finding 3.3: a real uncommitted change under the copy paths still fails the dirty-copy check', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.3 (the check is kept).
  const repo = mkTmp('r2a3r-f33b-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'dirty'}]);
  const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {copy: ['.']}))});
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const plan = async ctx => { const r = await ex.plan(ctx); fs.writeFileSync(path.join(repo, 'stray.txt'), 'uncommitted\n'); return r; };
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {...ex, plan}, limits: {total_provider_calls: 200, stage_provider_calls: 20, iterations: 2}});
  const impl = openWorkLedger({root: f.workRoot, create: false}).stages('dirty').find(s => s.stage === 'implement');
  assert.match(impl?.next?.why ?? '', /copy paths have uncommitted changes/);
  assert.match(impl.outputs.dirty, /stray\.txt/);
  assert.doesNotMatch(impl.outputs.dirty, /tickets/);
});

test('findings 3.3 and 9: validate runs its tests without blocking the event loop, bounded by the stage\'s elapsed budget', async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), findings 3.3 and 9: validate ran
  // each test with execFileSync (the whole process blocked, every sibling's timers too) for up to 10 minutes, past the
  // stage's elapsed budget and its stop signal.
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'slow'}]);
    // The flag lives under /var/tmp: validate's commands run in the verify jail (credential isolation,
    // pantheon/src/agy/verify-jail.mjs), whose fresh /tmp and hidden homes would hide a flag in the fixture repo.
    const flagDir = fs.mkdtempSync('/var/tmp/operate-slow-flag-'), flag = path.join(flagDir, 'slow.flag');
    const cmd = `[ -f '${flag}' ] && sleep 20; node verify.mjs`;
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {acceptance: [{id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd}}]}))});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const {validate, ...upToReview} = ex;
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: upToReview, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:passed'], JSON.stringify(r1.dispatched));
    fs.writeFileSync(flag, '');
    let ticks = 0;
    const beat = setInterval(() => { ticks++; }, 50);
    const t0 = Date.now();
    let during = null;
    try {
      await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits: {...LIMITS, elapsed_ms: 1_500},
        executors: {validate: async ctx => { const before = ticks; const out = await validate(ctx); during = ticks - before; return out; }}});
    } finally { clearInterval(beat); }
    const took = Date.now() - t0;
    assert.ok(took < 10_000, `validate stopped at the stage's elapsed budget, not after its 20 s test (${took} ms)`);
    assert.ok(during >= 5, `the event loop ran while validate's test ran (${during} beats)`);
    const val = openWorkLedger({root: f.workRoot}).stages('slow').find(s => s.stage === 'validate');
    assert.equal(val.blocker?.code, 'STAGE_ELAPSED', JSON.stringify(val.blocker));
    fs.rmSync(flagDir, {recursive: true, force: true});
  });
});

// ---- finding 6: a disabled-failover quota refusal in validate

test('finding 6: a validator refused for quota with the metered failover off is a pending METERED_FAILOVER_DISABLED block, not a failure with no blocker', async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6.
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'q'}]);
    const turn = scriptedTurn({validator: () => { throw Object.assign(new Error('agy: 429 RESOURCE_EXHAUSTED'), {status: 429, code: 'quota_exhausted', quota_failover: {used: false, disabled: true, lanes: ['x']}}); }});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', meteredFailover: false, ...SIX});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const val = openWorkLedger({root: f.workRoot}).stages('q').find(s => s.stage === 'validate');
    assert.ok(val, 'the item reached validate');
    assert.equal(val.status, 'pending', `${val.status}: ${val.next?.why}`);
    assert.equal(val.blocker?.code, 'METERED_FAILOVER_DISABLED');
    assert.equal(val.blocker.transient, true);
  });
});

// ---- finding 8.3: plan author state across a kill

test('finding 8.3: a plan attempt that dies mid-cycle loses neither its author\'s investigation nor its contributions on resume', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 8.3: with no stage record
  // of the attempt that opened the cycle, the resume recorded the author's delivery as unknown.
  const repo = mkTmp('r2a3r-f83-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'killed'}]);
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn: scriptedTurn(), stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  // The attempt dies after its reviews, before its stage record (the fence is the last thing it calls before closing).
  let dies = true;
  const plan = ctx => ex.plan({...ctx, fence: () => { if (dies) { dies = false; throw new Error('killed mid-cycle'); } }});
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits: {total_provider_calls: 100, stage_provider_calls: 20, iterations: 1}});
  let w = openWorkLedger({root: f.workRoot, create: false});
  assert.equal(w.stages('killed')[0].status, 'failed');
  assert.equal(w.stages('killed')[0].outputs.cycle, undefined, 'the dead attempt left no record of its cycle');
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan}, limits: {total_provider_calls: 100, stage_provider_calls: 20, iterations: 1}});
  w = openWorkLedger({root: f.workRoot, create: false});
  const passed = w.stages('killed').find(s => s.stage === 'plan' && s.status === 'passed');
  assert.ok(passed, JSON.stringify(w.stages('killed').map(s => [s.status, s.next?.why])));
  assert.equal(passed.outputs.context.author_delivery, undefined, `the author's delivery is known: ${JSON.stringify(passed.outputs.context.author_delivery)}`);
  assert.ok(passed.outputs.context.author_log, 'the accepted planner\'s investigation is on the record');
  assert.ok(passed.contributions.some(c => c.purpose === 'plan' && c.via === 'the planner wrote the plan the ticket derives from'));
});

// ---- finding 9: the elapsed bound

test('finding 9: a live run\'s stage gets the run\'s remaining elapsed time (no lease grace taken from it); the preflight and the verifier are bounded by it', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: lease_ms = elapsed_ms
  // took a 10% (up to 60 s) grace from every stage; the preflight ran before the bound started and the verifier had a
  // fixed 120 s.
  const root = mkTmp('r2a3r-f9-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const f = fixture(repo, [{item: 'timed'}]);
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const m = manifestFor({root, f, item: 'timed', head, name: 'out', limits: {total_provider_calls: 50, stage_provider_calls: 5, revisions: 1, stage_attempts: 1, elapsed_ms: 60_000,
    pipeline: {max_provider_calls: 5, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 10_000}}});
  let given = null;
  await confirmed(root, m, scriptedTurn(), '9', {repo, makeExecutorsImpl: () => ({plan: async ctx => { given = ctx.budget.elapsed_ms;
    return {status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, blocker: {what: 'x', role: 'lead@orch', resume_when: 'later'}, next: {stage: 'plan', why: 'x'}}; }})});
  assert.ok(given > 58_000, `the plan stage was given ${given} ms of a 60000 ms run`);
  // The verifier: what is left of the bound, never the fixed 120 s past it.
  assert.equal(typeof LR.verifyTimeout, 'function');
  assert.equal(LR.verifyTimeout(Date.now() + 30_000) <= 30_000, true);
  assert.equal(LR.verifyTimeout(Date.now() - 1_000), LR.VERIFY_FLOOR_MS);
  // The preflight: with the bound spent it refuses at once instead of running its probes.
  const cli = path.join(root, 'fake-agy');
  fs.writeFileSync(cli, '#!/bin/sh\nsleep 30\n', {mode: 0o755});
  const t0 = Date.now();
  const pf = await LR.agyPreflight({env: {...process.env, PANTHEON_AGY_CLI: cli, HOME: root}, deadline: Date.now() - 1});
  assert.ok(Date.now() - t0 < 10_000, `the preflight returned at once (${Date.now() - t0} ms)`);
  assert.deepEqual(pf.failed, pf.failed.includes('sandbox') ? ['sandbox'] : ['elapsed'], JSON.stringify(pf));
});
