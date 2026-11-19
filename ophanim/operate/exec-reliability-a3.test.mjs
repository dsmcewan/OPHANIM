// EXECUTION RELIABILITY of the controller: regressions for the defects two independent reviews of assignment 3 found at
// commit 09d490f -- independent review, assignment 3 (xAI grok-4.7, 09d490f) and (OpenAI gpt-6-astra extra review,
// 09d490f). Each test asserts the CORRECT behaviour and failed on commit 106e5b3.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick, spent} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors} from './stages.mjs';
import {verifyInChild, statusLedgerState} from './live-run.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture as gitFixture, scriptedTurn, FIVE} from './test-fixtures.mjs';

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rel-a3-'));
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-18', basis: `the requirement of ${i.item}`, state: 'Ready', title: i.item, ...i});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
const BUDGET = {provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1};

// (xAI grok-4.7, 09d490f), questions 2 and 9; (OpenAI gpt-6-astra extra review, 09d490f), questions 2 and 9: a stage
// that returned `passed` after its elapsed signal aborted was recorded passed, released completed, reused as a valid
// handoff, and the next stage started (and could charge) in the same tick.
test('an elapsed abort is not a handoff: a late `passed` is recorded pending STAGE_ELAPSED, no next stage starts, and it is not reused', async () => {
  const f = fixture([{item: 'alpha'}]);
  try {
    let implemented = 0;
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits: {total_provider_calls: 10, stage_provider_calls: 2, elapsed_ms: 60_000, lease_ms: 1000, iterations: 5},
      executors: {
        plan: async ctx => { ctx.charge(); await new Promise(res => ctx.signal.addEventListener('abort', () => setTimeout(res, 20))); assert.equal(ctx.signal.aborted, true);
          // test-lint: allow scripted-terminal-status -- this late 'passed' is the INPUT: the test asserts the scheduler records the plan pending STAGE_ELAPSED with status_reported 'passed' and starts no next stage
          return {status: 'passed', outputs: {late: true}, team: [], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'approved'}}; },
        implement: async ctx => { implemented++; ctx.charge(); return {status: 'failed', outputs: {}, usage: {provider_calls: 1}, next: {stage: 'implement', why: 'x'}}; },
      }});
    const w = openWorkLedger({root: f.workRoot});
    const [plan] = w.stages('alpha');
    assert.equal(plan.status, 'pending', JSON.stringify(plan.outputs));
    assert.deepEqual([plan.blocker.code, plan.blocker.transient, plan.outputs.stopped.code, plan.outputs.stopped.status_reported], ['STAGE_ELAPSED', true, 'STAGE_ELAPSED', 'passed']);
    assert.equal(w.releases().find(x => x.stage === 'plan').outcome, 'blocked');
    assert.equal(implemented, 0, 'no further stage started in the tick');
    assert.deepEqual(r.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:pending']);
    assert.match(r.stopped, /stage elapsed limit/);
    const gate = reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'alpha').gate;
    assert.notEqual(gate.gate, 'implement');
    assert.equal(gate.reuse?.plan, undefined, 'the late plan is not reused');
    assert.equal(spent(w).calls, 1);
  } finally { f.done(); }
});

// (xAI grok-4.7, 09d490f), question 9; (OpenAI gpt-6-astra extra review, 09d490f), questions 1 and 9: the lifecycle's
// call meter invoked turn(args) without the stage's signal, so a live adapter could not abort an in-flight request, and
// without a charge for the metered failover a single-turn Gemini seat makes inside one turn.
test('the lifecycle meter hands every turn the stage signal and a charge() that is its own metered, bounded call', async () => {
  await withDispatch(async ctx => {
    const g = gitFixture(ctx.dir, [{item: 'ticketed'}], {tickets: ['ticketed']});
    const base = scriptedTurn(), seen = [];
    const turn = async args => {
      seen.push({signal: args.signal instanceof AbortSignal, charge: typeof args.charge});
      if (seen.length === 1) args.charge();   // the planner's first turn fails over once: one more charged call
      return base(args);
    };
    const ex = makeExecutors({repo: ctx.dir, makeClientFor: ctx.makeClientFor, turn, stateDir: g.stateDir, independence: 'model', seating: FIVE.seating, facts: FIVE.facts});
    const r = await tick({repo: ctx.dir, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: {plan: ex.plan}, limits: {total_provider_calls: 40, stage_provider_calls: 20, iterations: 1}});
    assert.ok(seen.length >= 2, JSON.stringify(r.dispatched));
    assert.ok(seen.every(s => s.signal && s.charge === 'function'), JSON.stringify(seen));
    const w = openWorkLedger({root: g.workRoot});
    const claim = w.claims('ticketed')[0];
    assert.equal(Math.max(...w.spends(claim.hash).map(s => s.provider_calls)), seen.length + 1, 'the failover is charged on the ledger as its own call');
  });
});

// (xAI grok-4.7, 09d490f), question 8: a kill after Stage 5's review was saved and before its feedback was copied into
// the unit's findings lost that feedback: the next implement attempt carried units[].findings only. And a unit worktree
// a SIGKILLed attempt left registered was never removed.
test('carry reads a request_changes review\'s feedback, and a dead attempt\'s registered worktrees are removed', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const g = gitFixture(repo, [{item: 'ticketed'}], {tickets: ['ticketed']});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn: scriptedTurn(), stateDir: g.stateDir, independence: 'model', seating: FIVE.seating, facts: FIVE.facts});
    await tick({repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: {plan: ex.plan}, limits: {total_provider_calls: 40, stage_provider_calls: 20, iterations: 1}});
    const w = openWorkLedger({root: g.workRoot});
    const plan = w.stages('ticketed').find(s => s.stage === 'plan' && s.status === 'passed');
    assert.ok(plan);
    const dead = path.join(g.stateDir, 'ticketed', 'pipeline-1-1');
    fs.mkdirSync(path.join(dead, 'worktrees'), {recursive: true});
    fs.writeFileSync(path.join(dead, 'attempt.json'), JSON.stringify({item: 'ticketed', attempt: 1, plan_record: plan.hash}) + '\n');
    fs.writeFileSync(path.join(dead, 'pipeline.json'), JSON.stringify({run_id: 'dead', status: 'running', units: {alpha: {unit_id: 'alpha',
      findings: [{attempt: 1, source: 'controller', code: 'WRITE_JAIL', findings: ['KEPT_ON_DISK']}],
      reviews: [{n: 2, status: 'request_changes', feedback: ['ONLY_IN_THE_REVIEW_SAVE'], vendor: 'openai', model: 'gpt-6-luna'}]}}}) + '\n');
    // The dead process's worktree, still registered, and its owner (a pid that has exited).
    const orphan = path.join(dead, 'worktrees', 'alpha');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', orphan, 'HEAD'], {stdio: 'ignore'});
    const gone = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
    fs.writeFileSync(path.join(dead, 'owner.json'), JSON.stringify({pid: Number(gone), host: os.hostname(), run_id: 'dead'}) + '\n');
    const ac = new AbortController(); ac.abort();
    const gate = reconcile({repo, statusRoot: g.statusRoot, workLedger: w}).items.find(i => i.item === 'ticketed').gate;
    assert.equal(gate.gate, 'implement');
    const out = await ex.implement({item: 'ticketed', gate, upstream: plan, attempt: 2,
      budget: {provider_calls: 20, iterations: 1, elapsed_ms: 60_000, retries: 1}, repo, work: w, signal: ac.signal, claim: null, charge: () => { throw new Error('no call expected'); }});
    const texts = (out.findings ?? []).map(x => x.text);
    assert.ok(texts.includes('KEPT_ON_DISK') && texts.includes('ONLY_IN_THE_REVIEW_SAVE'), JSON.stringify(texts));
    const fromReview = out.findings.find(x => x.text === 'ONLY_IN_THE_REVIEW_SAVE');
    assert.deepEqual([fromReview.cause, fromReview.attempt, fromReview.model], ['in-run-review', 2, 'gpt-6-luna']);
    assert.doesNotMatch(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {encoding: 'utf8'}), new RegExp(orphan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(orphan), false);
  });
});

// (OpenAI gpt-6-astra extra review, 09d490f), questions 1 and 3: two scheduler processes that both passed the budget
// check each claimed and charged against total_provider_calls 1. The claim now reserves its budget atomically, under
// the ledger's append lock: the second claim is refused, and a ledger with older (non-reserving) claims still verifies.
test('a claim reserves its stage budget against the total atomically: a claim past the remainder is refused by the ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rel-a3-reserve-'));
  try {
    const a = openWorkLedger({root}), b = openWorkLedger({root});   // two handles: two processes' views
    const at = new Date().toISOString();
    a.claim({item: 'old', stage: 'plan', attempt: 1, inputs: {}, holder: 'h', budget: BUDGET, at});   // an older claim: no reservation
    a.claim({item: 'alpha', stage: 'plan', attempt: 1, inputs: {}, holder: 'p1', budget: BUDGET, at, total_provider_calls: 2});
    assert.throws(() => b.claim({item: 'beta', stage: 'plan', attempt: 1, inputs: {}, holder: 'p2', budget: BUDGET, at, total_provider_calls: 2}), /PROVIDER_CALL_BUDGET: 0 of 2/);
    b.claim({item: 'beta', stage: 'plan', attempt: 1, inputs: {}, holder: 'p2', budget: BUDGET, at, total_provider_calls: 3});
    assert.equal(openWorkLedger({root}).verify().ok, true);
    assert.deepEqual(openWorkLedger({root}).claims().map(c => c.reserve?.total_provider_calls ?? null), [null, 2, 3]);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

// (OpenAI gpt-6-astra extra review, 09d490f), question 10: the fresh-process verifier's verdict travelled on stdout
// only, and a child that exited 0 with nothing captured left the run unconfirmed. The child now writes its verdict to a
// file the launcher names (fsync'd before exit), read first.
test('verifyInChild reads the child\'s verdict from the file it names', async () => {
  const f = fixture([{item: 'v'}]);
  try {
    openWorkLedger({root: f.workRoot});
    const r = await verifyInChild({workRoot: f.workRoot, item: 'v', statusRoot: f.statusRoot, statusBefore: statusLedgerState(f.statusRoot)});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.process.verdict_from, 'file');
    assert.notEqual(r.process.pid, process.pid);
  } finally { f.done(); }
});
