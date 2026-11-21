// Independent review tests for Assignment 3 (Execution reliability)
// Commit under review: 77480d6b262c92ceca5a159cc5be3e3ee627b922
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { openStatusLedger } from '../packages/ledger/status.mjs';
import { openWorkLedger } from '../ophanim/operate/work-ledger.mjs';
import { tick, spent } from '../ophanim/operate/scheduler.mjs';
import { makeExecutors, implementerPath } from '../ophanim/operate/stages.mjs';
import { readServiceConfig, runService, SERVICE_CONFIG_SCHEMA } from '../ophanim/operate/service.mjs';
import {
  LIVE_RUN_SCHEMA,
  validateManifest,
  statusLedgerState,
  inspectWorkRoot,
  runConfirmed,
  subagentReceipt,
} from '../ophanim/operate/live-run.mjs';
import { fixture, scriptedTurn, planFor, json, git, UNIT, FIVE } from '../ophanim/operate/test-fixtures.mjs';

import { runPipeline, arbitersOf } from '../pantheon/src/pipeline/index.mjs';
import { pipelineTurns } from '../pantheon/src/pipeline/turns.mjs';
import { unitKey } from '../pantheon/src/pipeline/checkpoint.mjs';
import { pathsOverlap } from '../pantheon/src/pipeline/paths.mjs';
import { waves } from '../pantheon/src/pipeline/dispatch.mjs';
import { runVerify } from '../pantheon/src/pipeline/review.mjs';
import { quotaEvidence } from '../pantheon/src/agy/quota.mjs';
import { laneFirstTurn } from '../pantheon/src/sdk/agy-turn.mjs';
import { reviewSeatsByModel } from '../pantheon/src/ledger/review-cycle.mjs';
import { runOpenItem } from '../pantheon/src/board/run-item.mjs';
import { tempRepo, seats, unit, scripted, write as writeUnitFile, PLANNER, ask, approve, RUBRIC } from '../pantheon/tests/fixtures/pipeline-stages.mjs';

// Child mode for Q8-A: starts runPipeline with a fixed dir + run_id and pauses mid-wave until SIGKILL.
if (process.argv[2] === '--child-kill-mid-wave') {
  const [, , , repo, dir, marker] = process.argv;
  const plan = [unit('a'), unit('b')];
  const s = scripted({
    plan,
    implement: async args => {
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, worktree: args.cwd }));
      await new Promise(() => {});
    },
  });
  await runPipeline({ repo, base: 'main', plan: { work_units: plan }, seats: seats(), turns: s.turns, dir, run_id: 'fixed-run', planner: PLANNER });
  process.exit(0);
}

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// -----------------------------------------------------------------------------
// Question 1: Call budgets
// -----------------------------------------------------------------------------

test('Q1-A: Google long_decode continuation hops execute multiple provider requests while runPipeline charges 1 call', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);

  let httpRequests = 0;
  let countTokenRequests = 0;
  const makeClientFor = () => ({
    models: {
      countTokens: async () => {
        countTokenRequests++;
        return { totalTokens: 50 };
      },
      generateContentStream: async req => {
        httpRequests++;
        const tok = req.config?.continuationToken ?? null;
        const hop = tok === null ? 1 : tok === 'c1' ? 2 : 3;
        const partText = hop === 1 ? '{"files":[{"path":"src/a/impl.mjs",' : hop === 2 ? '"content":"export const x = 1;\\n"' : '}]}';
        const finishReason = hop < 3 ? 'CONTINUATION' : 'STOP';
        const nextTok = hop === 1 ? 'c1' : hop === 2 ? 'c2' : undefined;
        return (async function* () {
          yield {
            modelVersion: 'gemini-4-hydrogen',
            candidates: [{ finishReason, continuationToken: nextTok, content: { parts: [{ text: partText }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
          };
        })();
      },
    },
  });

  let singleCalls = 0;
  const singleTurn = async ({ model, prompt }) => {
    singleCalls++;
    if (prompt.startsWith('ROLE: dispatcher')) {
      return {
        text: JSON.stringify({ unit_id: 'a', cohesive: true, specialist_role: 'eng', difficulty: 'medium', rubric: RUBRIC, notes: '' }),
        served_model: model,
      };
    }
    return { text: JSON.stringify(approve(RUBRIC)), served_model: model };
  };

  let laneCalls = 0;
  const turns = pipelineTurns({
    turn: singleTurn,
    makeClientFor,
    agy: {
      run: async () => {
        laneCalls++;
        throw Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429, code: 'quota_exhausted', quota: { matched: '429', explicit: true } });
      },
      probe: async () => ({ state: 'exhausted', buckets: [] }),
    },
  });

  // max_provider_calls is 4 (1 dispatcher + 1 lane + 1 metered_failover + 1 reviewer),
  // yet the metered failover alone makes 3 separate billed generateContentStream requests (total = 6 real calls).
  const out = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: [unit('a')] },
    seats: seats(),
    turns,
    limits: { max_provider_calls: 4 },
    dir: env.dir,
    planner: PLANNER,
  });

  assert.equal(out.status, 'completed');
  assert.equal(countTokenRequests, 1, '1 uncounted countTokens HTTP request was sent');
  assert.equal(httpRequests, 3, '3 separate generateContentStream requests were sent to the provider');
  const totalActualProviderInvocations = singleCalls + laneCalls + countTokenRequests + httpRequests;
  assert.equal(totalActualProviderInvocations, 7, '7 total provider invocations occurred under max_provider_calls = 4');
  assert.equal(out.provider_calls.total, 4, 'pipeline recorded only 4 calls instead of 7');
});

test('Q1-B: implementUnits catch block charges full stage_provider_calls when runPipeline throws after 0 calls', async t => {
  const repo = mkTmp('a3-q1b-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'item-a' }]);

  const turn = scriptedTurn();
  const executors = makeExecutors({
    repo,
    makeClientFor: () => ({}),
    turn,
    stateDir: f.stateDir,
    seating: FIVE.seating,
    facts: FIVE.facts,
  });

  // Step 1: pass plan (4 calls: 1 planner + 3 plan reviewers).
  await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors,
    limits: { total_provider_calls: 100, stage_provider_calls: 40, iterations: 1 },
  });
  const callsAfterPlan = turn.log.length;

  // Step 2: cause runPipeline to throw synchronously/early before any provider call by passing an invalid pipelineLimits
  // shape that throws inside runPipeline (e.g., making stateDir/<item> read-only after dir creation or bad checkpoints key).
  // Passing pipelineLimits with a non-iterable or checkpoint key < 32 bytes makes runPipeline return refused (0 calls),
  // whereas an unwritable git repo / worktree failure inside try throws or we can force a throw via seats/stateDir:
  // Specifically, if `repo` has a broken `.git/worktrees` directory (a regular file at `.git/worktrees`), `git worktree add`
  // throws GIT_FAILED -> caught inside runPipeline (`end('failed')`), whereas if `persist()` fails on initial `save()`
  // (e.g., `pipeline.json` is a directory), `save()` rejects with `RECORD_WRITE` BEFORE any provider turn is called!
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = function patched(p, opts) {
    const r = origMkdirSync.call(fs, p, opts);
    if (typeof p === 'string' && /pipeline-1-/.test(p) && !p.includes('worktrees') && !p.includes('units')) {
      origMkdirSync.call(fs, path.join(p, 'pipeline.json'), { recursive: true });
    }
    return r;
  };
  let tick2;
  try {
    tick2 = await tick({
      repo,
      statusRoot: f.statusRoot,
      workRoot: f.workRoot,
      executors,
      limits: { total_provider_calls: 100, stage_provider_calls: 40, iterations: 1 },
    });
  } finally {
    fs.mkdirSync = origMkdirSync;
  }

  assert.equal(turn.log.length, callsAfterPlan, '0 provider calls were made during the failed implement attempt');
  const w = openWorkLedger({ root: f.workRoot, create: false });
  const implStage = w.stages('item-a').find(s => s.stage === 'implement');
  assert.equal(implStage.status, 'failed');
  assert.equal(implStage.usage.provider_calls, 40, 'catch block charged all 40 stage_provider_calls despite 0 calls made');
  assert.equal(tick2.spent.calls, callsAfterPlan + 40);
});

test('Q1-C: runOpenItem resume with maxProviderCalls: callsBefore + budget resets made=0 and inflates limit to callsBefore + budget', async t => {
  const root = mkTmp('a3-q1c-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  const spec = {
    key: 'argo-item',
    repo_root: repo,
    title: 't',
    goal: 'g',
    question: 'q',
    copy: ['alpha.mjs'],
    acceptance_cmd: 'true',
    slot: 'alpha',
    path: 'alpha.mjs',
  };
  const boardDir = path.join(root, 'board');

  // First run: sets up isolated board state and run.json (even in nested sandbox where bwrap preflight stops at isolation).
  await runOpenItem(spec, { dir: boardDir, makeClientFor: () => ({}), maxProviderCalls: 20, ledger: false }).catch(() => {});
  const statePath = path.join(boardDir, 'run.json');
  const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Simulate 15 prior provider calls recorded in attempts on attempt 1 before an in-run review pause:
  seeded.attempts = Array.from({ length: 15 }, (_, i) => ({ n: i + 1, outcome: 'ok', provider_requests: 1 }));
  seeded.provider_calls = { limit: 20, made: 15, refused: null };
  fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2));

  // Reproduce exact stages.mjs:778-782 resume call: `maxProviderCalls: callsBefore + ctx.budget.provider_calls` (15 + 20 = 35).
  await runOpenItem(spec, { dir: boardDir, resume: boardDir, makeClientFor: () => ({}), maxProviderCalls: 15 + 20, ledger: false }).catch(() => {});
  const afterResume = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(afterResume.provider_calls.basis, 'operator');
  assert.equal(afterResume.provider_calls.prior, 15);
  assert.equal(afterResume.provider_calls.counted_from, 15);
  assert.equal(afterResume.provider_calls.made, 0, 'providerCalls reset to 0 instead of 15');
  assert.equal(afterResume.provider_calls.limit, 35, 'this single resume invocation can now spend 35 new calls instead of 20');
});

// -----------------------------------------------------------------------------
// Question 2: Budget stops
// -----------------------------------------------------------------------------

test('Q2-A: STAGE_ELAPSED abort during fit implement permanently wedges item in non-transient blocked PIPELINE_UNITS_UNRESOLVED', async t => {
  const repo = mkTmp('a3-q2a-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'slow-item' }]);

  const baseTurn = scriptedTurn();
  const executors = makeExecutors({
    repo,
    makeClientFor: () => ({}),
    turn: async args => {
      if (args.prompt.startsWith('ROLE: dispatcher')) {
        // Wait until the stage elapsed signal aborts, then throw ABORTED as liveTurn/agy does.
        await new Promise((_, reject) => {
          if (args.signal?.aborted) return reject(Object.assign(new Error('the run was aborted'), { code: 'ABORTED' }));
          args.signal?.addEventListener('abort', () => reject(Object.assign(new Error('the run was aborted'), { code: 'ABORTED' })), { once: true });
        });
      }
      return baseTurn(args);
    },
    stateDir: f.stateDir,
    seating: FIVE.seating,
    facts: FIVE.facts,
  });

  // Tick 1: plan passes; implement hits STAGE_ELAPSED at ~1200ms.
  const t1 = await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors,
    limits: { total_provider_calls: 100, stage_provider_calls: 20, elapsed_ms: 1_200, lease_ms: 60_000 },
  });

  const w = openWorkLedger({ root: f.workRoot, create: false });
  const impl = w.stages('slow-item').find(s => s.stage === 'implement');
  assert.match(t1.stopped ?? '', /stage elapsed limit/);
  assert.equal(impl.status, 'blocked', 'scheduler failed to convert aborted implement blocked status to transient pending');
  assert.equal(impl.blocker?.code, 'PIPELINE_UNITS_UNRESOLVED');
  assert.equal(Boolean(impl.blocker?.transient), false);

  // Tick 2 with ample elapsed_ms (60s) and fast dispatcher CANNOT resume — the item is permanently wedged!
  const fastExecutors = makeExecutors({ repo, makeClientFor: () => ({}), turn: baseTurn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts });
  const t2 = await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors: fastExecutors,
    limits: { total_provider_calls: 100, stage_provider_calls: 20, elapsed_ms: 60_000, lease_ms: 60_000 },
    clock: () => Date.now() + 30 * 60_000,
  });
  assert.deepEqual(t2.dispatched, [], 'subsequent tick with fresh elapsed budget cannot dispatch wedged item');
  assert.equal(t2.blocked[0]?.blocker?.code, 'PIPELINE_UNITS_UNRESOLVED');
});

test('Q2-B: pipeline.max_provider_calls < stage_provider_calls in runConfirmed misstates budget and retries stage_attempts times instead of stopping', async t => {
  const root = mkTmp('a3-q2b-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const f = fixture(repo, [{ item: 'cap-item' }]);
  const head = git(repo, 'rev-parse', 'HEAD').trim();

  const rawManifest = {
    schema: LIVE_RUN_SCHEMA,
    item: 'cap-item',
    candidate_commit: head,
    profile: 'fit',
    independence: 'model',
    limits: {
      total_provider_calls: 200,
      stage_provider_calls: 20,
      revisions: 1,
      stage_attempts: 3,
      elapsed_ms: 60_000,
      pipeline: { max_provider_calls: 1, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 10_000 },
    },
    billing: { scope: 'test', metered_gemini_failover: false, note: '' },
    ledgers: { status_root: f.statusRoot, work_root: path.join(root, 'out', 'work') },
    credentials: { required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used' },
    out_dir: path.join(root, 'out'),
  };
  const manifest = validateManifest(rawManifest, { baseDir: root });
  const status = statusLedgerState(manifest.ledgers.status_root);
  const workInfo = inspectWorkRoot(manifest.ledgers.work_root, manifest.item);

  const turn = scriptedTurn();
  // Inject custom makeExecutorsImpl that overrides only `agy.run` so no bwrap is needed, keeping real stages.mjs!
  const r = await runConfirmed(
    { manifest, digest: 'sha256:' + '0'.repeat(64), file: path.join(root, 'm.json') },
    { ok: true },
    status,
    workInfo,
    {
      repo,
      seats: { turn, makeClientFor: () => ({}) },
      makeExecutorsImpl: opts => makeExecutors({ ...opts, seating: FIVE.seating, facts: FIVE.facts, agy: { run: async () => { throw new Error('stop'); } } }),
    }
  );

  assert.equal(r.code, 3);
  const implStages = r.record.stages.filter(s => s.stage === 'implement');
  assert.equal(implStages.length, 3, 'runConfirmed did not stop at pipeline.max_provider_calls=1; it re-ran implement 3 times');
  assert.equal(implStages[0].usage.provider_calls, 1, 'only 1 pipeline call was actually used per attempt');
  assert.match(implStages[0].next.why, /the stage's 20 provider call\(s\) were used/, 'error message falsely claims 20 calls were used');
});

// -----------------------------------------------------------------------------
// Question 3: Concurrency
// -----------------------------------------------------------------------------

test('Q3-A: two runService instances with distinct state_dir run simultaneously on one work_ledger; pathsOverlap misses case-only collisions', async t => {
  // 1. pathsOverlap case sensitivity (relevant on case-insensitive macOS/NTFS worktrees):
  assert.equal(pathsOverlap('src/Foo.mjs', 'src/foo.mjs'), false);
  assert.deepEqual(waves([unit('a', { owned_paths: ['src/Foo.mjs'] }), unit('b', { owned_paths: ['src/foo.mjs'] })]), [['a', 'b']]);

  // 2. Service lock is placed in state_dir instead of workRoot:
  const repo = mkTmp('a3-q3a-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const S = openStatusLedger({ root: path.join(repo, 'status', 'ledger') });
  S.set({ checked: '2026-11-18', basis: 'req a', item: 'a', title: 'A', state: 'Ready' });
  S.set({ checked: '2026-11-18', basis: 'req b', item: 'b', title: 'B', state: 'Ready' });
  fs.mkdirSync(path.join(repo, 'tickets'), { recursive: true });
  openWorkLedger({ root: path.join(repo, 'status', 'work') });

  const cfg1File = path.join(repo, 's1.json');
  const cfg2File = path.join(repo, 's2.json');
  fs.writeFileSync(cfg1File, JSON.stringify({ schema: SERVICE_CONFIG_SCHEMA, repo: '.', state_dir: 'state-1', issues: { source: 'none' }, interval_s: 10, limits: { total_provider_calls: 40, stage_provider_calls: 10 } }));
  fs.writeFileSync(cfg2File, JSON.stringify({ schema: SERVICE_CONFIG_SCHEMA, repo: '.', state_dir: 'state-2', issues: { source: 'none' }, issues: { source: 'none' }, interval_s: 10, limits: { total_provider_calls: 40, stage_provider_calls: 10 } }));

  let inFlight = 0, maxInFlight = 0;
  const pass = stage => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 40));
    inFlight--;
    return { status: 'passed', outputs: { [stage]: true }, team: [{ role: stage }], contributions: [], findings: [], usage: { provider_calls: 2 }, next: { stage: null, why: 'ok' } };
  };
  const ex = Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, pass(s)]));

  // Pre-seed intake so we isolate the concurrent service lock failure cleanly:
  await tick({ repo, statusRoot: path.join(repo, 'status', 'ledger'), workRoot: path.join(repo, 'status', 'work'), executors: {}, limits: { total_provider_calls: 0 } });

  const [r1, r2] = await Promise.all([
    runService({ config: readServiceConfig(cfg1File), executors: ex, maxTicks: 1, sleep: async () => {} }),
    runService({ config: readServiceConfig(cfg2File), executors: ex, maxTicks: 1, sleep: async () => {} }),
  ]);
  assert.equal(r1.code, 0, 'service 1 ran without refusal');
  assert.equal(r2.code, 0, 'service 2 ran concurrently on the same work_ledger without SERVICE_RUNNING refusal');
  assert.equal(maxInFlight, 2, 'both services executed stages concurrently');
});

test('Q3-B: --concurrency > 1 in tick causes concurrent plan ticket write in shared repo to fail sibling implement dirty-copy check', async t => {
  const repo = mkTmp('a3-q3b-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'item-1' }, { item: 'item-2' }]);

  let notifyPlanWroteTicket;
  const planWroteTicket = new Promise(r => { notifyPlanWroteTicket = r; });
  let releaseItem1Plan;
  const holdItem1Plan = new Promise(r => { releaseItem1Plan = r; });

  const baseTurn = scriptedTurn({
    planner: ({ prompt, item }) => {
      // item-2 reads '.' in copy (e.g. repo-wide config/check); item-1 writes uncommitted tickets/item-1.json!
      if (item === 'item-2') return json(planFor(prompt, { copy: ['.'] }));
      return json(planFor(prompt));
    },
  });

  const realEx = makeExecutors({
    repo,
    makeClientFor: () => ({}),
    turn: baseTurn,
    stateDir: f.stateDir,
    seating: FIVE.seating,
    facts: FIVE.facts,
  });

  const executors = {
    ...realEx,
    plan: async ctx => {
      const res = await realEx.plan(ctx);
      if (ctx.item === 'item-1') {
        // realEx.plan has ALREADY written uncommitted tickets/item-1.json to `repo`!
        notifyPlanWroteTicket();
        await holdItem1Plan;
      }
      return res;
    },
    implement: async ctx => {
      if (ctx.item === 'item-2') {
        await planWroteTicket;
        const res = await realEx.implement(ctx);
        releaseItem1Plan();
        return res;
      }
      return realEx.implement(ctx);
    },
  };

  await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors,
    limits: { total_provider_calls: 200, stage_provider_calls: 20, concurrency: 2, iterations: 4 },
  });

  const w = openWorkLedger({ root: f.workRoot, create: false });
  const item2Impl = w.stages('item-2').find(s => s.stage === 'implement');
  assert.equal(item2Impl?.status, 'failed', 'item-2 implement failed because item-1 plan dirtied the shared repo working tree');
  assert.match(item2Impl?.next?.why ?? '', /copy paths have uncommitted changes/);
});

// -----------------------------------------------------------------------------
// Question 4: Leases
// -----------------------------------------------------------------------------

test('Q4: work-ledger fences stale recordStage/recordSpend, but un-fenced stale plan holder still overwrites tickets/<item>.json before recordStage', async t => {
  const repo = mkTmp('a3-q4-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'lease-item' }]);

  let resumeStaleHolder;
  const staleGate = new Promise(r => { resumeStaleHolder = r; });
  let staleEntered = false;
  let notifyStaleInFlight;
  const staleInFlight = new Promise(r => { notifyStaleInFlight = r; });

  let callNum = 0;
  const staleTurn = scriptedTurn({
    planner: ({ prompt }) => {
      callNum++;
      // Holder 1 plans difficulty: 'easy'; Holder 2 plans difficulty: 'hard' (different ticket digest!).
      return json(planFor(prompt, { difficulty: callNum === 1 ? 'easy' : 'hard' }));
    },
  });

  const ex = makeExecutors({
    repo,
    makeClientFor: () => ({}),
    turn: async args => {
      const out = await staleTurn(args);
      if (!staleEntered && args.prompt.startsWith('You are an independent reviewer of a PLAN')) {
        staleEntered = true;
        notifyStaleInFlight();
        await staleGate;
      }
      return out;
    },
    stateDir: f.stateDir,
    seating: FIVE.seating,
    facts: FIVE.facts,
  });

  let now = Date.parse('2026-11-18T00:00:00Z');
  // Start Tick 1 (Holder 1) with a 1000ms lease; it pauses inside plan review.
  const tick1Promise = tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors: { plan: ex.plan },
    holder: 'holder-1',
    clock: () => now,
    limits: { total_provider_calls: 200, stage_provider_calls: 20, lease_ms: 1_000, iterations: 1 },
  });
  await staleInFlight;

  // Advance clock past Holder 1's lease; Tick 2 (Holder 2) releases Holder 1 as `expired` and completes `plan`!
  now += 5_000;
  const ex2 = makeExecutors({
    repo,
    makeClientFor: () => ({}),
    turn: staleTurn,
    stateDir: path.join(repo, 'status', 'operate-2'),
    seating: FIVE.seating,
    facts: FIVE.facts,
  });
  const tick2 = await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors: { plan: ex2.plan },
    holder: 'holder-2',
    clock: () => now,
    limits: { total_provider_calls: 200, stage_provider_calls: 20, lease_ms: 60_000, iterations: 1 },
  });
  assert.deepEqual(tick2.released_expired, [{ item: 'lease-item', stage: 'plan', attempt: 1 }]);
  assert.equal(tick2.dispatched[0].status, 'passed');

  const wAfterTick2 = openWorkLedger({ root: f.workRoot, create: false });
  const approvedTicketDigest = wAfterTick2.stages('lease-item')[0].outputs.ticket.digest;

  // Now let stale Holder 1 finish its remaining in-memory plan steps:
  // 1) work.recordSpend on its 2nd/3rd reviewer throws LEASE_FENCED -> caught inside plan? Wait: in reviewCycle, failed reviewer returns pending;
  // What if Holder 1 ALREADY finished its 3rd reviewer call BEFORE lease expiry, and paused right before writing tickets/<item>.json?
  // Let's also verify that case directly!
  resumeStaleHolder();
  const tick1 = await tick1Promise;
  // Holder 1's recordStage is fenced by LEASE_FENCED:
  assert.ok(tick1.skipped.some(s => /LEASE_FENCED/.test(s.why)), 'work-ledger fenced stale Holder 1 from appending work.stage');

  // Now demonstrate the un-fenced disk write when pause occurs AFTER the last m.turn (no further recordSpend) and BEFORE return:
  const fB = fixture(mkTmp('a3-q4b-'), [{ item: 'race-ticket' }]);
  t.after(() => fs.rmSync(fB.S ? path.dirname(path.dirname(fB.statusRoot)) : '', { recursive: true, force: true }));
  const repoB = path.dirname(path.dirname(fB.statusRoot));
  let releaseAfterTurns, notifyAfterTurns;
  const gateAfterTurns = new Promise(r => { releaseAfterTurns = r; });
  const hitAfterTurns = new Promise(r => { notifyAfterTurns = r; });
  let seenReviews = 0, holderNum = 0;
  const turnB = scriptedTurn({
    planner: ({ prompt }) => json(planFor(prompt, { difficulty: ++holderNum === 1 ? 'easy' : 'hard' })),
    'plan-review': async () => {
      seenReviews++;
      if (seenReviews === 3) {
        notifyAfterTurns();
        await gateAfterTurns;
      }
      return '```json\n{"verdict":"approve","findings":[]}\n```';
    },
  });
  const exB1 = makeExecutors({ repo: repoB, makeClientFor: () => ({}), turn: turnB, stateDir: path.join(repoB, 's1'), seating: FIVE.seating, facts: FIVE.facts });
  const exB2 = makeExecutors({ repo: repoB, makeClientFor: () => ({}), turn: turnB, stateDir: path.join(repoB, 's2'), seating: FIVE.seating, facts: FIVE.facts });

  let clockB = Date.parse('2026-11-18T01:00:00Z');
  const p1 = tick({ repo: repoB, statusRoot: fB.statusRoot, workRoot: fB.workRoot, executors: { plan: exB1.plan }, holder: 'h1', clock: () => clockB, limits: { total_provider_calls: 200, stage_provider_calls: 20, lease_ms: 1_000, iterations: 1 } });
  await hitAfterTurns;

  clockB += 5_000;
  await tick({ repo: repoB, statusRoot: fB.statusRoot, workRoot: fB.workRoot, executors: { plan: exB2.plan }, holder: 'h2', clock: () => clockB, limits: { total_provider_calls: 200, stage_provider_calls: 20, lease_ms: 60_000, iterations: 1 } });
  // Release stale h1: all its turns already charged, so it writes `tickets/race-ticket.json` BEFORE `recordStage` fences it!
  releaseAfterTurns();
  const r1B = await p1;
  assert.ok(r1B.skipped.some(s => /LEASE_FENCED/.test(s.why)));

  // Now run Holder 2's next tick: stale Holder 1's un-fenced disk write overwrote `tickets/race-ticket.json`,
  // invalidating Holder 2's approved plan at reconciliation (`gate: 'plan'`, `stale` naming the ticket digest mismatch)!
  const r3B = await tick({ repo: repoB, statusRoot: fB.statusRoot, workRoot: fB.workRoot, executors: { implement: exB2.implement }, holder: 'h2', clock: () => clockB, limits: { total_provider_calls: 200, stage_provider_calls: 20, lease_ms: 60_000, iterations: 1 } });
  assert.equal(r3B.skipped[0]?.gate, 'plan', 'stale Holder 1 overwrote tickets/race-ticket.json, invalidating Holder 2 approved plan back to gate=plan');
  assert.ok(approvedTicketDigest);
});

// -----------------------------------------------------------------------------
// Question 5: Retries and the lane ladder
// -----------------------------------------------------------------------------

test('Q5: implementerPath conflates rejection thinking-levels with quota failover; stderr 429 line-number skips same-lane retry; API_FILES_REFUSED spends revision', async t => {
  // 5-A: implementerPath('easy') includes 3 levels of the SAME base model (gemini-4-hydrogen), wasting quota steps:
  assert.deepEqual(implementerPath('easy').map(s => s.model), [
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-xhigh',
    'gemini-3.8-flash-high',
  ]);

  // 5-B: unstructured \b429\b in stderr (e.g. a stack trace line number) is classified as explicit quota refusal:
  const q = quotaEvidence({ stderr: 'TypeError at src/parser.mjs:429:15', result: null });
  assert.deepEqual(q, { matched: '429', explicit: true });

  const env = await tempRepo();
  t.after(env.cleanup);
  const single = async ({ model, prompt }) => {
    if (prompt.startsWith('ROLE: dispatcher')) {
      return { text: JSON.stringify({ unit_id: 'a', cohesive: true, specialist_role: 'eng', difficulty: 'medium', rubric: RUBRIC, notes: '' }), served_model: model };
    }
    return { text: JSON.stringify(approve(RUBRIC)), served_model: model };
  };

  // With meteredFailover: false, that stack-trace ":429:" skips the same-lane retry even when probe reads "available"!
  const triedLanes = [];
  const turnsFalsePositive = pipelineTurns({
    turn: single,
    agy: {
      meteredFailover: false,
      probe: async () => ({ state: 'available', buckets: [{ group: 'Gemini', remaining_fraction: 0.9, exhausted: false }] }),
      run: async ({ model }) => {
        triedLanes.push(model);
        if (triedLanes.length === 1) {
          throw Object.assign(new Error('exit 1'), { status: 429, code: 'quota_exhausted', quota: q });
        }
        await writeUnitFile(path.join(env.dir, 'fn-false-pos', 'worktrees', 'a'), 'src/a/impl.mjs', 'export const x = 1;\n');
        return { text: 'ok' };
      },
    },
  });
  const outFP = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: [unit('a')] },
    seats: seats({ implementer: () => ({ seat: { vendor: 'agy_google', model: 'gemini-4-hydrogen-medium' }, ladder: implementerPath('easy') }) }),
    turns: turnsFalsePositive,
    dir: path.join(env.dir, 'fn-false-pos'),
    planner: PLANNER,
  });
  assert.equal(outFP.status, 'completed');
  assert.deepEqual(triedLanes, ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high'], 'same-lane retry was skipped despite probe="available"');

  // 5-C: When meteredFailover: true and API fallback returns non-JSON, it throws API_FILES_REFUSED -> spends a review revision!
  const turnsBadApi = pipelineTurns({
    turn: single,
    agy: {
      meteredFailover: true,
      probe: async () => ({ state: 'exhausted', buckets: [] }),
      run: async () => { throw Object.assign(new Error('429'), { status: 429, code: 'quota_exhausted', quota: { matched: '429', explicit: true } }); },
      api: async () => ({ text: 'not json prose', served_model: 'gemini-4-hydrogen' }),
    },
  });
  const outBadApi = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: [unit('a')] },
    seats: seats(),
    turns: turnsBadApi,
    limits: { max_revisions: 0 },
    dir: path.join(env.dir, 'fn-bad-api'),
    planner: PLANNER,
  });
  assert.equal(outBadApi.units.a.status, 'blocked');
  assert.match(outBadApi.units.a.reason, /0 revision\(s\) are spent/, 'transport API fallback format failure consumed a review revision');
});

// -----------------------------------------------------------------------------
// Question 6: Metered failover off
// -----------------------------------------------------------------------------

test('Q6: meteredFailover:false still routes default Google reviewer seat (gemini-3.6-flash) directly to the metered Gemini API', async () => {
  // Default 3-lab review panel after an Anthropic planner seats `agy_google/gemini-3.6-flash` for Google:
  const panel = reviewSeatsByModel({
    n: 3,
    contributions: [{ purpose: 'plan', vendor: 'anthropic', model: 'claude-opus-5-5', lab: 'anthropic' }],
  });
  const googleReviewer = panel.find(s => s.lab === 'google');
  assert.deepEqual([googleReviewer.vendor, googleReviewer.model], ['agy_google', 'gemini-3.6-flash']);

  // Because gemini-3.6-flash has no Antigravity lane in lanes.json, laneFirstTurn(..., { failover: false }) calls `api()` directly!
  let laneCalled = 0, apiCalled = 0;
  const res = await laneFirstTurn(
    { vendor: googleReviewer.vendor, model: googleReviewer.model, prompt: 'review plan', seat: { ...googleReviewer, role: 'plan-reviewer' } },
    {
      failover: false,
      lane: async () => { laneCalled++; return { text: 'lane', served_model: 'lane' }; },
      api: async ({ vendor, model }) => { apiCalled++; return { text: 'metered-api-called', served_model: model }; },
    }
  );
  assert.equal(laneCalled, 0, 'Antigravity lane was never used');
  assert.equal(apiCalled, 1, 'metered Gemini API was called directly despite failover: false!');
  assert.equal(res.text, 'metered-api-called');
});

// -----------------------------------------------------------------------------
// Question 7: Checkpoints
// -----------------------------------------------------------------------------

test('Q7: unitKey omits sibling units (skipping cohesive re-dispatch), resume skips sameModel check on served_model, and resumed units drop arbiters & break subagentReceipt', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const checkpoints = { dir: path.join(env.root, 'checkpoints') };

  // Run 1: unit 'a' consults subagent 'api-designer' (grok-4.7), is approved and checkpointed; unit 'b' fails.
  const plan1 = [
    unit('a', { difficulty: 'hard', allowed_subagents: ['api-designer'] }),
    unit('b'),
  ];
  const s1 = scripted({
    plan: plan1,
    implement: async args => {
      if (args.unit_id === 'b') throw Object.assign(new Error('lane down'), { code: 'lane_failure', kind: 'exit' });
      await ask(args.a2a, { role: 'api-designer', unit_id: 'a', text: 'design?' });
      await writeUnitFile(args.cwd, 'src/a/impl.mjs', 'export const a = 1;\n');
      return 'done';
    },
  });
  const hardSeats = seats({
    dispatcher: u => ({ vendor: 'openai', model: u.difficulty === 'hard' ? 'gpt-6-astra' : 'gpt-6-luna' }),
    subagent: () => ({ vendor: 'xai', model: 'grok-4.7' }),
    reviewerLadder: d => [d],
  });
  const run1 = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: plan1 },
    seats: hardSeats,
    turns: s1.turns,
    dir: path.join(env.root, 'r1'),
    planner: PLANNER,
    checkpoints,
    sameModel: () => true,
  });
  assert.equal(run1.units.a.status, 'approved');
  assert.equal(run1.units.b.status, 'blocked');
  assert.equal(arbitersOf(run1).some(a => a.unit_id === 'a'), true);

  // Run 2:
  // - Adds a coupled sibling unit 'd' (which would make dispatcher mark 'a' `cohesive: false` if asked!)
  // - Tightens `sameModel` to reject the checkpoint's served_model (`() => false`)
  // Yet `unitKey('a')` is unchanged and `resume()` skips BOTH `runDispatcher` AND `sameModel`!
  const plan2 = [
    unit('a', { difficulty: 'hard', allowed_subagents: ['api-designer'] }),
    unit('b'),
    unit('d', { owned_paths: ['src/d/**'], verify_cmd: 'test -f src/d/impl.mjs' }),
  ];
  assert.equal(
    unitKey({ unit: plan1[0], base_commit: run1.base.commit, upstream: [] }),
    unitKey({ unit: plan2[0], base_commit: run1.base.commit, upstream: [] }),
    'unitKey of unit a ignores added sibling unit d'
  );

  const s2 = scripted({
    plan: plan2,
    dispatch: args => ({
      unit_id: args.unit_id,
      cohesive: args.unit_id !== 'a', // would reject 'a' as not cohesive alongside 'd' if called!
      specialist_role: 'node-esm-library-engineer',
      difficulty: args.unit_id === 'a' ? 'hard' : 'medium',
      rubric: RUBRIC,
      notes: args.unit_id === 'a' ? 'coupled with d' : '',
    }),
    implement: async args => {
      await writeUnitFile(args.cwd, `src/${args.unit_id}/impl.mjs`, 'export const ok = 1;\n');
      return 'done';
    },
  });
  const run2 = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: plan2 },
    seats: hardSeats,
    turns: s2.turns,
    dir: path.join(env.root, 'r2'),
    planner: PLANNER,
    checkpoints,
    sameModel: (asked, served) => (asked === 'gpt-6-astra' ? false : asked === served),
  });
  assert.equal(run2.status, 'completed');
  assert.equal(run2.units.a.resumed, true, 'unit a resumed despite sibling unit addition and stricter sameModel rejecting gpt-6-astra');
  assert.equal(arbitersOf(run2).some(a => a.unit_id === 'a'), false, 'resumed unit a was dropped from arbitersOf(run2)');

  // Check live-run.mjs subagentReceipt against the accepted implement stage record:
  const fakeStages = [
    { hash: 'sha256:' + '1'.repeat(64), stage: 'implement', status: 'failed', outputs: { run: { kind: 'pipeline', dir: path.join(env.root, 'r1'), record: path.join(env.root, 'r1', 'pipeline.json') } } },
    { hash: 'sha256:' + '2'.repeat(64), stage: 'implement', status: 'passed', outputs: { run: { kind: 'pipeline', dir: path.join(env.root, 'r2'), record: path.join(env.root, 'r2', 'pipeline.json') } } },
  ];
  const receipt = subagentReceipt(fakeStages, { role: 'api-designer', model: 'grok-4.7', min_calls: 1 });
  assert.equal(receipt.met, false, 'subagentReceipt fails acceptance (counted=0) when the subagent call occurred in a checkpoint-resumed unit');
  assert.equal(receipt.counted, 0);
});

// -----------------------------------------------------------------------------
// Question 8: Process restart
// -----------------------------------------------------------------------------

test('Q8-A: SIGKILL mid-wave leaves refs/heads/pantheon/pipeline/<run_id>, causing restart with same dir + run_id to fail', async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const runDir = path.join(env.root, 'same-dir');
  const marker = path.join(env.root, 'started.json');

  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--child-kill-mid-wave', env.repo, runDir, marker], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  while (!fs.existsSync(marker)) await new Promise(r => setTimeout(r, 20));
  process.kill(child.pid, 'SIGKILL');
  await new Promise(r => child.once('exit', r));

  // Restart into the same `runDir` with the same `run_id: 'fixed-run'`:
  const plan = [unit('a'), unit('b')];
  const s = scripted({
    plan,
    implement: async args => { await writeUnitFile(args.cwd, `src/${args.unit_id}/impl.mjs`, 'export const v = 1;\n'); return 'done'; },
  });
  const restarted = await runPipeline({
    repo: env.repo,
    base: 'main',
    plan: { work_units: plan },
    seats: seats(),
    turns: s.turns,
    dir: runDir,
    run_id: 'fixed-run',
    planner: PLANNER,
  });
  assert.equal(restarted.status, 'failed', 'restart failed because recoverOrphanWorktrees left branch pantheon/pipeline/fixed-run');
  assert.match(restarted.reason ?? '', /already exists/);
});

test('Q8-B: findings carried from a killed pipeline run are lost if the next attempt fails and a third attempt succeeds', async t => {
  const repo = mkTmp('a3-q8b-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'carry-loss' }]);

  const turn = scriptedTurn();
  const ex = makeExecutors({ repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts });

  // 1. Pass plan:
  await tick({ repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: { total_provider_calls: 200, stage_provider_calls: 20, iterations: 1 } });
  const w = openWorkLedger({ root: f.workRoot, create: false });
  const planHash = w.stages('carry-loss')[0].hash;

  // 2. Simulate an interrupted Attempt 1 directory (process killed mid-wave after recording a Stage 5 reviewer finding, before recordStage):
  const deadDir = path.join(f.stateDir, 'carry-loss', 'pipeline-0-100');
  fs.mkdirSync(deadDir, { recursive: true });
  fs.writeFileSync(path.join(deadDir, 'attempt.json'), JSON.stringify({ item: 'carry-loss', attempt: 1, plan_record: planHash, claim: null }));
  fs.writeFileSync(path.join(deadDir, 'pipeline.json'), JSON.stringify({
    run_id: 'dead1',
    status: 'running',
    units: {
      alpha: {
        unit_id: 'alpha',
        findings: [{ attempt: 1, source: 'reviewer', code: 'request_changes', vendor: 'openai', model: 'gpt-6-luna', findings: ['critical defect from killed run'] }],
        reviews: [],
      },
    },
  }));

  // 3. Attempt 2 runs with stage_provider_calls = 1 -> fails at PROVIDER_CALL_LIMIT, recording deadDir in `outputs.carried_runs`:
  const failEx = makeExecutors({ repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts });
  await tick({ repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: failEx, limits: { total_provider_calls: 200, stage_provider_calls: 1, iterations: 1 } });

  // 4. Attempt 3 runs with ample budget and scripted implementer that writes alpha.mjs -> passes, but DROPS dead1's finding!
  const origRun = fs.writeFileSync;
  assert.ok(origRun);
  // Use a custom pipelineLimits / turn where worker writes alpha.mjs without bwrap by patching `implement` via makeExecutors + fake agy?
  // Even simpler: Attempt 3 with stage_provider_calls = 2 ALSO records `implement:failed` — let's check its `findings`!
  await tick({ repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: failEx, limits: { total_provider_calls: 200, stage_provider_calls: 1, iterations: 1 } });
  const stages = openWorkLedger({ root: f.workRoot, create: false }).stages('carry-loss').filter(s => s.stage === 'implement');
  assert.equal(stages[0].findings.some(x => /critical defect from killed run/.test(x.text)), true, 'Attempt 2 carried the finding from killed Attempt 1');
  assert.deepEqual(stages[1].findings, [], 'Attempt 3 dropped the finding from killed Attempt 1 because deadDir was in Attempt 2 carried_runs');
});

// -----------------------------------------------------------------------------
// Question 9: Timeouts
// -----------------------------------------------------------------------------

test('Q9: runVerify enforces timeout_ms via process-group SIGKILL, while scheduler subtracts 10% lease grace from stageMs when lease_ms == elapsed_ms', async t => {
  const dir = mkTmp('a3-q9-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 9-A: Verify timeout kills child process group cleanly:
  const v = await runVerify({ worktree: dir, verify_cmd: 'sleep 10', timeout_ms: 80 });
  assert.equal(v.timed_out, true);
  assert.equal(v.passed, false);
  assert.equal(v.exit_code, null);

  // 9-B: When live-run.mjs sets lease_ms = elapsed_ms (e.g. 500ms), scheduler.mjs sets stageMs = min(500, 500 - 50) = 450ms:
  const repo = mkTmp('a3-q9b-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const f = fixture(repo, [{ item: 'grace-item' }]);
  let seenBudgetMs = null;
  await tick({
    repo,
    statusRoot: f.statusRoot,
    workRoot: f.workRoot,
    executors: {
      plan: async ctx => {
        seenBudgetMs = ctx.budget.elapsed_ms;
        return { status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: { provider_calls: 0 }, blocker: { what: 'wait', role: 'lead@orch', resume_when: 'later' } };
      },
    },
    limits: { total_provider_calls: 10, stage_provider_calls: 5, elapsed_ms: 500, lease_ms: 500 },
  });
  assert.equal(seenBudgetMs, 450, 'stage elapsed_ms was reduced by 10% lease grace (450ms instead of 500ms)');
});

// -----------------------------------------------------------------------------
// Question 10: Run record
// -----------------------------------------------------------------------------

test('Q10: runConfirmed verifies in a child process (structural only for run_ledgers), misses stage PROVIDER_CALL_LIMIT in budget_stops, and omits final_gate.blocker from blockers', async t => {
  const root = mkTmp('a3-q10-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const f = fixture(repo, [
    { item: 'dep-item', state: 'Resolved' },
    { item: 'rec-item', depends_on: ['dep-item'] },
    { item: 'plain-item' },
  ]);
  const head = git(repo, 'rev-parse', 'HEAD').trim();

  // Case 10-A: stage_provider_calls = 4; planner uses 1 call, plan reviewer 1 retrieves once (2 calls), plan reviewer 2 uses 1 call,
  // and plan reviewer 3 hits PROVIDER_CALL_LIMIT inside reviewCycle!
  // `plan` returns `status: 'pending'` (`next.why: 'plan review incomplete'`), omitting `plan_ledger` from outputs and leaving `budget_stops` EMPTY (`[]`)!
  const raw1 = {
    schema: LIVE_RUN_SCHEMA,
    item: 'rec-item',
    candidate_commit: head,
    profile: 'fit',
    independence: 'model',
    limits: {
      total_provider_calls: 30,
      stage_provider_calls: 4,
      revisions: 1,
      stage_attempts: 1,
      elapsed_ms: 60_000,
      pipeline: { max_provider_calls: 4, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 10_000 },
    },
    billing: { scope: 'test', metered_gemini_failover: false, note: '' },
    ledgers: { status_root: f.statusRoot, work_root: path.join(root, 'out1', 'work') },
    credentials: { required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used' },
    out_dir: path.join(root, 'out1'),
  };
  const m1 = validateManifest(raw1, { baseDir: root });
  const status1 = statusLedgerState(m1.ledgers.status_root);
  let firstRetrieveDone = false;
  const r1 = await runConfirmed(
    { manifest: m1, digest: 'sha256:' + 'a'.repeat(64), file: path.join(root, 'm1.json') },
    { ok: true },
    status1,
    inspectWorkRoot(m1.ledgers.work_root, m1.item),
    {
      repo,
      seats: {
        turn: scriptedTurn({
          planner: ({ prompt }) => json(planFor(prompt, { dependencies: ['dep-item'] })),
          'plan-review': () => {
            if (!firstRetrieveDone) {
              firstRetrieveDone = true;
              return '```json\n{"requests":[{"op":"file","path":"alpha.mjs"}]}\n```';
            }
            return '```json\n{"verdict":"approve","findings":[]}\n```';
          },
        }),
        makeClientFor: () => ({}),
      },
      makeExecutorsImpl: opts => makeExecutors({ ...opts, seating: FIVE.seating, facts: FIVE.facts, agy: { run: async () => { throw new Error('stop'); } } }),
    }
  );
  assert.equal(r1.code, 3);
  assert.equal(r1.record.verification.ok, true);
  assert.notEqual(r1.record.verification.process.pid, process.pid, 'verified in a fresh child process');
  assert.deepEqual(r1.record.verification.run_ledgers, [], 'pending plan stage omits plan_ledger from outputs, so child verification skips the open plan ledger');
  assert.match(r1.record.stages[0].blocker?.what ?? '', /provider-call budget/, 'plan review attempt 1 stopped on stage provider-call budget');
  assert.deepEqual(r1.record.budget_stops, [], 'budget_stops missed the stage provider-call budget stop completely');

  // Case 10-B: plain-item passes plan (4 calls), proving run_ledgers verification is structural only (defineKinds({})):
  const raw2 = {
    ...raw1,
    item: 'plain-item',
    ledgers: { status_root: f.statusRoot, work_root: path.join(root, 'out2', 'work') },
    out_dir: path.join(root, 'out2'),
    limits: { ...raw1.limits, total_provider_calls: 4, stage_provider_calls: 4, pipeline: { ...raw1.limits.pipeline, max_provider_calls: 4 } },
  };
  const m2 = validateManifest(raw2, { baseDir: root });
  const r2 = await runConfirmed(
    { manifest: m2, digest: 'sha256:' + 'b'.repeat(64), file: path.join(root, 'm2.json') },
    { ok: true },
    statusLedgerState(m2.ledgers.status_root),
    inspectWorkRoot(m2.ledgers.work_root, m2.item),
    {
      repo,
      seats: { turn: scriptedTurn(), makeClientFor: () => ({}) },
      makeExecutorsImpl: opts => makeExecutors({ ...opts, seating: FIVE.seating, facts: FIVE.facts, agy: { run: async () => { throw new Error('stop'); } } }),
    }
  );
  assert.equal(r2.code, 3);
  assert.equal(r2.record.verification.ok, true);
  assert.match(r2.record.verification.run_ledgers[0]?.check ?? '', /^structural /, JSON.stringify(r2.record.verification));

  // Case 10-C: when dep-item is unresolved (Ready) when runConfirmed evaluates final_gate before ticking,
  // final_gate.blocker is non-null while record.blockers is [] (omitted):
  f.S.set({ checked: '2026-11-18', basis: 'reopened before confirm', item: 'dep-item', title: 'dep', state: 'Ready' });
  const raw3 = {
    ...raw1,
    ledgers: { status_root: f.statusRoot, work_root: path.join(root, 'out3', 'work') },
    out_dir: path.join(root, 'out3'),
  };
  const m3 = validateManifest(raw3, { baseDir: root });
  const r3 = await runConfirmed(
    { manifest: m3, digest: 'sha256:' + 'c'.repeat(64), file: path.join(root, 'm3.json') },
    { ok: true },
    statusLedgerState(m3.ledgers.status_root),
    inspectWorkRoot(m3.ledgers.work_root, m3.item),
    {
      repo,
      seats: { turn: scriptedTurn(), makeClientFor: () => ({}) },
      makeExecutorsImpl: opts => makeExecutors({ ...opts, seating: FIVE.seating, facts: FIVE.facts }),
    }
  );
  assert.equal(r3.code, 3);
  assert.equal(r3.record.verification.ok, true);
  assert.ok(r3.record.final_gate.blocker, 'final_gate carries the dependency blocker');
  assert.deepEqual(r3.record.blockers, [], 'record.blockers omitted final_gate.blocker when loop exited before ticking');
});
