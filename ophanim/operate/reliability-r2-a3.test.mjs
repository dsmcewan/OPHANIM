// Regression tests for independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6): execution
// reliability. Each test names the finding it pins; each failed on 54572b3.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {readServiceConfig, runService, SERVICE_CONFIG_SCHEMA} from './service.mjs';
import {fixture, scriptedTurn, planFor, json, git, FIVE, LIMITS} from './test-fixtures.mjs';
import {statelessHooks} from './test-restart-child.mjs';
import {subagentReceipt, LIVE_RUN_SCHEMA, validateManifest, statusLedgerState, inspectWorkRoot, runConfirmed} from './live-run.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {runPipeline, unitKey} from '../../pantheon/src/pipeline/index.mjs';
import {tempRepo, seats, unit, scripted, write as writeUnitFile, PLANNER} from '../../pantheon/tests/fixtures/pipeline-stages.mjs';
import {subagentGovernor} from '../../pantheon/src/antigravity/subagents.mjs';

const hook = (ctx, h) => { ctx.implement(h.implement); ctx.review(h.review); ctx.serve(h.serve); };

const mkTmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const abortable = signal => new Promise((_, reject) => {
  const no = () => reject(Object.assign(new Error('the run was aborted'), {code: 'ABORTED'}));
  if (signal?.aborted) return no();
  signal?.addEventListener('abort', no, {once: true});
});

// ---- finding 2.1: an elapsed abort during fit implement

test('finding 2.1: an elapsed abort during fit implement is a retryable STAGE_ELAPSED pending, and a later tick resumes the item', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 2.1: the aborted
  // pipeline returned blocked PIPELINE_UNITS_UNRESOLVED, recorded as a structural block that no later tick dispatched.
  const repo = mkTmp('r2a3-f21-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'slow-item'}]);
  const base = scriptedTurn();
  const slow = makeExecutors({repo, makeClientFor: () => ({}), stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts,
    turn: async args => { if (args.prompt.startsWith('ROLE: dispatcher')) await abortable(args.signal); return base(args); }});
  const t1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: slow,
    limits: {total_provider_calls: 100, stage_provider_calls: 20, elapsed_ms: 1_200, lease_ms: 60_000}});
  assert.match(t1.stopped ?? '', /stage elapsed limit/);
  const impl = openWorkLedger({root: f.workRoot, create: false}).stages('slow-item').find(s => s.stage === 'implement');
  assert.equal(impl.status, 'pending');
  assert.deepEqual([impl.blocker?.code, impl.blocker?.transient], ['STAGE_ELAPSED', true]);
  assert.equal(impl.outputs.stopped.status_reported, 'blocked');
  assert.ok(impl.outputs.run, 'the work of the stopped attempt is kept on the record');

  const fast = makeExecutors({repo, makeClientFor: () => ({}), turn: base, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const t2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: fast,
    limits: {total_provider_calls: 100, stage_provider_calls: 20, elapsed_ms: 60_000, lease_ms: 60_000}, clock: () => Date.now() + 30 * 60_000});
  assert.ok(t2.dispatched.some(d => d.stage === 'implement'), `the item is retried: ${JSON.stringify(t2.dispatched)} ${JSON.stringify(t2.blocked)}`);
});

// ---- finding 7: checkpoints

test('finding 7: a resumed unit keeps its subagent receipts, a changed sibling re-dispatches it, and this run\'s identity rule is re-applied', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 7: resumed units dropped
  // a2a.calls (subagentReceipt counted 0), unitKey ignored sibling units, and resume skipped sameModel.
  const env = await tempRepo();
  t.after(env.cleanup);
  const checkpoints = {dir: path.join(env.root, 'checkpoints')};
  // Unit a's implementer is an Antigravity SDK seat (Carbon), whose session was admitted one native code-explorer
  // subagent (owner direction 2026-11-19): the receipt is that subagent, as the controller's governor recorded it.
  const CARBON = {vendor: 'agy_google', model: 'gemini-4-carbon', transport: 'antigravity-sdk', effort: 'high'};
  const plan1 = [unit('a', {difficulty: 'hard', allowed_subagents: ['code-explorer']}), unit('b')];
  const base = seats();
  const hardSeats = seats({dispatcher: u => ({vendor: 'openai', model: u.difficulty === 'hard' ? 'gpt-6-astra' : 'gpt-6-luna'}),
    implementer: u => (u.unit_id === 'a' ? {seat: {...CARBON}, ladder: [{...CARBON}]} : base.implementer(u)), reviewerLadder: d => [d]});
  const sessionOf = args => {
    const g = subagentGovernor({implementer: {vendor: args.vendor, model: args.model}, unit_id: args.unit_id, allowed_types: args.allowed_subagents});
    const prompt = 'Find every caller of the unit\'s export and list them with file paths.';
    g.observe({event: 'trajectory_state', trajectory_id: 'root', parent_trajectory_id: '', depth: 0, state: 'RUNNING'});
    assert.equal(g.admit({call_id: 'call-1', trajectory_id: 'root', args: {Subagents: [{TypeName: 'code-explorer', Role: 'caller finder', Prompt: prompt}]}}).allow, true);
    g.observe({event: 'child_started', trajectory_id: 'child-1', parent_trajectory_id: 'root', prompt});
    for (const state of ['RUNNING', 'FULLY_IDLE']) g.observe({event: 'trajectory_state', trajectory_id: 'child-1', parent_trajectory_id: 'root', depth: 1, state});
    return {subagents: {...g.record(), blocked: null}, gateway: {served_models: {'gemini-4-carbon': ['gemini-4-carbon'], 'gemini-4-hydrogen': ['gemini-4-hydrogen']}}};
  };
  const write = async args => {
    await writeUnitFile(args.cwd, `src/${args.unit_id}/impl.mjs`, 'export const v = 1;\n');
    return args.unit_id === 'a' ? {text: 'done', served_model: args.model, served_model_source: 'provider', session: sessionOf(args)} : 'done';
  };
  const s1 = scripted({plan: plan1, implement: async args => {
    if (args.unit_id === 'b') throw Object.assign(new Error('lane down'), {code: 'lane_failure', kind: 'exit'});
    return write(args);
  }});
  const run = (plan, turns, name, extra = {}) => runPipeline({repo: env.repo, base: 'main', plan: {work_units: plan}, seats: hardSeats, turns, dir: path.join(env.root, name), planner: PLANNER, checkpoints, ...extra});
  const run1 = await run(plan1, s1.turns, 'r1');
  assert.equal(run1.units.a.status, 'approved');

  const REQUIRED = {type: 'code-explorer', model: 'gemini-4-hydrogen', min_calls: 1};
  const stageOf = name => [{hash: 'sha256:' + '2'.repeat(64), stage: 'implement', status: 'passed', outputs: {run: {kind: 'pipeline', dir: path.join(env.root, name), record: path.join(env.root, name, 'pipeline.json')}}}];
  const fresh = subagentReceipt(stageOf('r1'), REQUIRED);
  assert.deepEqual([fresh.met, fresh.calls[0].type, fresh.calls[0].implementer, fresh.calls[0].from_checkpoint], [true, 'code-explorer', 'gemini-4-carbon', undefined], JSON.stringify(fresh));
  // Another type, or another model, is not that receipt.
  assert.equal(subagentReceipt(stageOf('r1'), {...REQUIRED, type: 'test-constructor'}).met, false);

  // 7.3: the same plan again: unit a resumes, and its subagent is still on the accepted record.
  const s2 = scripted({plan: plan1, implement: write});
  const run2 = await run(plan1, s2.turns, 'r2');
  assert.equal(run2.units.a.resumed, true);
  assert.equal(s2.calls.filter(c => c.role === 'implementer' && c.unit_id === 'a').length, 0, 'no implementer session was started for the resumed unit');
  const receipt = subagentReceipt(stageOf('r2'), REQUIRED);
  assert.equal(receipt.met, true, JSON.stringify(receipt));
  assert.equal(receipt.calls[0].from_checkpoint, true);
  assert.deepEqual(run2.contributions.filter(c => c.kind === 'subtask').map(c => [c.model, c.from_checkpoint]), [['gemini-4-hydrogen', true]], 'and it is still a contributor of the resumed unit');
  assert.equal(run2.units.a.checkpoint.review.verdict, 'approve', 'the sealed Stage 5 review is restored with the unit');

  // 7.1: a plan that adds a sibling is a different input to the cohesion judgment: a's key changes, a is dispatched again.
  const plan3 = [...plan1, unit('d')];
  assert.notEqual(unitKey({unit: plan1[0], base_commit: run1.base.commit, plan: plan1}), unitKey({unit: plan3[0], base_commit: run1.base.commit, plan: plan3}));
  const s3 = scripted({plan: plan3, implement: write});
  const run3 = await run(plan3, s3.turns, 'r3');
  assert.equal(run3.units.a.resumed, false);
  assert.ok(s3.calls.some(c => c.role === 'dispatcher' && c.unit_id === 'a'), 'unit a was dispatched again');

  // 7.2: a stricter identity rule refuses the recorded judgments of a checkpoint.
  const s4 = scripted({plan: plan1, implement: write});
  const run4 = await run(plan1, s4.turns, 'r4', {sameModel: (asked, served) => asked !== 'gpt-6-astra' && asked === served});
  assert.equal(run4.units.a.resumed, false);
  assert.match(run4.units.a.checkpoint_rejected?.why ?? '', /identity rule/);
});

// ---- finding 1.2: a pipeline run that throws after 0 calls

test('finding 1.2: an implement stage whose pipeline throws before any call is charged 0 provider calls, not its whole stage budget', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.2.
  const repo = mkTmp('r2a3-f12-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'item-a'}]);
  const turn = scriptedTurn();
  const executors = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  const limits = {total_provider_calls: 100, stage_provider_calls: 40, iterations: 1};
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits});
  const before = turn.log.length;
  // The run record cannot be written (pipeline.json is a directory): runPipeline throws RECORD_WRITE on its first save.
  const orig = fs.mkdirSync;
  fs.mkdirSync = function patched(p, opts) {
    const r = orig.call(fs, p, opts);
    if (typeof p === 'string' && /pipeline-1-/.test(p) && !p.includes('worktrees') && !p.includes('units')) orig.call(fs, path.join(p, 'pipeline.json'), {recursive: true});
    return r;
  };
  let t2;
  try { t2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits}); } finally { fs.mkdirSync = orig; }
  assert.equal(turn.log.length, before, 'no provider call was made');
  const impl = openWorkLedger({root: f.workRoot, create: false}).stages('item-a').find(s => s.stage === 'implement');
  assert.equal(impl.status, 'failed');
  assert.equal(impl.usage.provider_calls, 0);
  assert.equal(t2.spent.calls, before);
});

// ---- finding 2.2: the bound a stopped pipeline names

test('finding 2.2: a pipeline stopped by a lower pipeline max_provider_calls names that bound and the calls made, not the stage budget', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 2.2.
  const repo = mkTmp('r2a3-f22-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'cap'}]);
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn: scriptedTurn(), stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts, pipelineLimits: {max_provider_calls: 1}});
  for (let i = 0; i < 2; i++) await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 100, stage_provider_calls: 20, iterations: 1}});
  const impl = openWorkLedger({root: f.workRoot, create: false}).stages('cap').find(s => s.stage === 'implement');
  assert.equal(impl.status, 'failed');
  assert.match(impl.next.why, /PROVIDER_CALL_LIMIT: the run's bound of 1 provider call\(s\) was reached \(1 made/);
  assert.doesNotMatch(impl.next.why, /the stage's 20 provider call\(s\) were used/);
});

// ---- finding 8.2: findings carried from a killed run

test('finding 8.2: findings carried from a killed pipeline run stay carried when the attempt that carried them did not pass', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 8.2.
  const repo = mkTmp('r2a3-f82-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'carry'}]);
  const turn = scriptedTurn();
  const ex = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: f.stateDir, seating: FIVE.seating, facts: FIVE.facts});
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 200, stage_provider_calls: 20, iterations: 1}});
  const planHash = openWorkLedger({root: f.workRoot, create: false}).stages('carry')[0].hash;
  const dead = path.join(f.stateDir, 'carry', 'pipeline-0-100');
  fs.mkdirSync(dead, {recursive: true});
  fs.writeFileSync(path.join(dead, 'attempt.json'), JSON.stringify({item: 'carry', attempt: 1, plan_record: planHash, claim: null}));
  fs.writeFileSync(path.join(dead, 'pipeline.json'), JSON.stringify({run_id: 'dead1', status: 'running', units: {alpha: {unit_id: 'alpha', reviews: [],
    findings: [{attempt: 1, source: 'reviewer', code: 'request_changes', vendor: 'openai', model: 'gpt-6-luna', findings: ['critical defect from killed run']}]}}}));
  for (let i = 0; i < 2; i++) await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 200, stage_provider_calls: 1, iterations: 1}});
  const impls = openWorkLedger({root: f.workRoot, create: false}).stages('carry').filter(s => s.stage === 'implement');
  assert.equal(impls.length, 2);
  for (const s of impls) assert.equal(s.findings.filter(x => /critical defect from killed run/.test(x.text)).length, 1, `attempt ${s.attempt} carries the killed run's finding once`);
});

// ---- finding 1.3: the per-file (runOpenItem) implement path

test('finding 1.3: a resumed runOpenItem attempt is bounded by its own stage budget, and every one of its calls is charged on the work ledger', async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.3: a resume passed
  // callsBefore + budget as an operator bound counted from the resume, and runOpenItem was never given ctx.charge.
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'fresh'}]);
    hook(ctx, statelessHooks());
    ctx.agyMode('frozen');
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    const charged = new Map();
    const executors = {...ex, implement: c => ex.implement({...c, charge: n => { charged.set(c.attempt, (charged.get(c.attempt) ?? 0) + n); return c.charge(n); }})};
    for (let i = 0; i < 2; i++) await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: {...LIMITS, iterations: i === 0 ? 10 : 2}});
    const w = openWorkLedger({root: f.workRoot});
    const impls = w.stages('fresh').filter(s => s.stage === 'implement');
    assert.deepEqual(impls.map(s => s.status), ['failed', 'passed']);
    const resumed = impls[1];
    assert.equal(resumed.outputs.resumed_from, impls[0].hash);
    const run = JSON.parse(fs.readFileSync(path.join(resumed.outputs.run?.board ?? resumed.outputs.board, 'run.json'), 'utf8'));
    assert.equal(run.provider_calls.limit, LIMITS.stage_provider_calls, 'the resumed attempt may make at most its stage budget of new calls');
    for (const s of impls) assert.equal(charged.get(s.attempt) ?? 0, s.usage.provider_calls, `attempt ${s.attempt}: every call is charged before it is made`);
  });
});

// ---- finding 3.2a: one service per work ledger

test('finding 3.2a: two services with different state_dirs on one work ledger: the second is refused', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.2a: the lock was in
  // state_dir, so both ran stages at once on one work ledger.
  const repo = mkTmp('r2a3-f32-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const S = openStatusLedger({root: path.join(repo, 'status', 'ledger')});
  S.set({checked: '2026-11-18', basis: 'req a', item: 'a', title: 'A', state: 'Ready'});
  fs.mkdirSync(path.join(repo, 'tickets'), {recursive: true});
  openWorkLedger({root: path.join(repo, 'status', 'work')});
  const cfg = n => {
    const file = path.join(repo, `s${n}.json`);
    fs.writeFileSync(file, JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', state_dir: `state-${n}`, issues: {source: 'none'}, interval_s: 10, limits: {total_provider_calls: 40, stage_provider_calls: 10}}));
    return readServiceConfig(file);
  };
  const pass = stage => async () => { await new Promise(r => setTimeout(r, 40)); return {status: 'passed', outputs: {[stage]: true}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: null, why: 'ok'}}; };
  const ex = Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, pass(s)]));
  const [r1, r2] = await Promise.all([1, 2].map(n => runService({config: cfg(n), executors: ex, maxTicks: 1, sleep: async () => {}})));
  assert.deepEqual([r1.code, r2.code].sort(), [0, 1]);
  assert.match(r1.refused ?? r2.refused, /already running on this work ledger/);
});

// ---- finding 4: a stale lease holder's side effects

test('finding 4: a plan holder whose lease expired writes no ticket; its successor\'s approved plan stands', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 4: the stale holder's
  // recordStage was fenced, but it had already overwritten tickets/<item>.json, returning the successor's plan to `plan`.
  const repo = mkTmp('r2a3-f4-');
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const f = fixture(repo, [{item: 'race'}]);
  let release, hit;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { hit = r; });
  let reviews = 0, holders = 0;
  const turn = scriptedTurn({
    planner: ({prompt}) => json(planFor(prompt, {difficulty: ++holders === 1 ? 'easy' : 'hard'})),
    'plan-review': async () => { if (++reviews === 3) { hit(); await gate; } return '```json\n{"verdict":"approve","findings":[]}\n```'; },
  });
  const ex1 = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: path.join(repo, 's1'), seating: FIVE.seating, facts: FIVE.facts});
  const ex2 = makeExecutors({repo, makeClientFor: () => ({}), turn, stateDir: path.join(repo, 's2'), seating: FIVE.seating, facts: FIVE.facts});
  let clock = Date.parse('2026-11-18T01:00:00Z');
  const limits = lease => ({total_provider_calls: 200, stage_provider_calls: 20, lease_ms: lease, iterations: 1});
  const p1 = tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex1.plan}, holder: 'h1', clock: () => clock, limits: limits(1_000)});
  await reached;
  clock += 5_000;
  await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex2.plan}, holder: 'h2', clock: () => clock, limits: limits(60_000)});
  const ticketFile = path.join(repo, 'tickets', 'race.json');
  const approved = fs.readFileSync(ticketFile, 'utf8');
  release();
  const r1 = await p1;
  assert.ok(r1.skipped.some(s => /LEASE_FENCED/.test(s.why)), JSON.stringify(r1.skipped));
  assert.equal(fs.readFileSync(ticketFile, 'utf8'), approved, 'the stale holder did not overwrite the approved ticket');
  const w = openWorkLedger({root: f.workRoot, create: false});
  assert.deepEqual(w.stages('race').map(s => `${s.stage}:${s.status}`), ['plan:passed']);
  const r3 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {implement: async () => ({status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, blocker: {what: 'x', role: 'lead@orch', resume_when: 'later'}})},
    holder: 'h2', clock: () => clock, limits: limits(60_000)});
  assert.equal(r3.dispatched[0]?.stage, 'implement', `the successor's approved plan still hands on: ${JSON.stringify(r3.skipped)}`);
});

// ---- finding 10: the run record

test('finding 10: run.json lists a reviewer\'s stage-budget stop, verifies an open plan ledger by its domain rules, and lists the final gate\'s blocker', async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 10.
  const root = mkTmp('r2a3-f10-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, {recursive: true});
  const f = fixture(repo, [{item: 'dep-item', state: 'Resolved'}, {item: 'rec-item', depends_on: ['dep-item']}]);
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const manifest = (name, over = {}) => validateManifest({schema: LIVE_RUN_SCHEMA, item: 'rec-item', candidate_commit: head, profile: 'fit', independence: 'model',
    limits: {total_provider_calls: 30, stage_provider_calls: 4, revisions: 1, stage_attempts: 1, elapsed_ms: 60_000,
      pipeline: {max_provider_calls: 4, max_revisions: 1, max_concurrent_units: 1, verify_timeout_ms: 10_000}},
    billing: {scope: 'test', gemini_api_implementer: true, metered_gemini_failover: false, note: ''}, ledgers: {status_root: f.statusRoot, work_root: path.join(root, name, 'work')},
    credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'required'}, out_dir: path.join(root, name), ...over}, {baseDir: root});
  const run = (m, turn, d) => runConfirmed({manifest: m, digest: 'sha256:' + d.repeat(64), file: path.join(root, `${d}.json`)}, {ok: true}, statusLedgerState(m.ledgers.status_root),
    inspectWorkRoot(m.ledgers.work_root, m.item), {repo, seats: {turn, makeClientFor: () => ({})},
      makeExecutorsImpl: opts => makeExecutors({...opts, seating: FIVE.seating, facts: FIVE.facts, agy: {run: async () => { throw new Error('stop'); }}})});
  // 10.1 / 10.2: the planner and two reviewers use 4 calls (one reviewer retrieves once); the third reviewer is refused at the stage budget.
  let retrieved = false;
  const r1 = await run(manifest('out1'), scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {dependencies: ['dep-item']})),
    'plan-review': () => (retrieved ? '```json\n{"verdict":"approve","findings":[]}\n```' : (retrieved = true, '```json\n{"requests":[{"op":"file","path":"alpha.mjs"}]}\n```'))}), 'a');
  assert.match(r1.record.stages[0].blocker?.what ?? '', /provider-call budget|PROVIDER_CALL_LIMIT/);
  assert.ok(r1.record.budget_stops.some(s => s.source === 'stage' && s.stage === 'plan'), JSON.stringify(r1.record.budget_stops));
  assert.equal(r1.record.verification.run_ledgers.length, 1, 'the open plan ledger is verified');
  assert.equal(r1.record.verification.run_ledgers[0].ok, true, JSON.stringify(r1.record.verification.run_ledgers[0]));
  assert.match(r1.record.verification.run_ledgers[0].check, /^domain /);
  // 10.3: the dependency is reopened before the run: the loop ends on a blocked gate without ticking it.
  f.S.set({checked: '2026-11-18', basis: 'reopened before confirm', item: 'dep-item', title: 'dep', state: 'Ready'});
  const r3 = await run(manifest('out3'), scriptedTurn(), 'c');
  assert.ok(r3.record.final_gate.blocker);
  assert.ok(r3.record.blockers.some(b => b.source === 'final_gate'), JSON.stringify(r3.record.blockers));
});
