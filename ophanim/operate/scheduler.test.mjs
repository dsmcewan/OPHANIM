// The controller core with scripted stage executors: intake, gates, claims, handoffs, reuse, returns, budgets,
// duplicates and interruption. The real executors (stages.mjs) are tested separately over Pantheon's fakes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger, outputsDigest} from './work-ledger.mjs';
import {tick, watch, verifyHandoff} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'operate-'));
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i.item}`, ...i});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, S, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
const LIMITS = {total_provider_calls: 1000, stage_provider_calls: 10};
// Scripted executors: each passes and records what it was handed. `plan` writes the ticket, as planning must.
function scripted(f, overrides = {}) {
  const seen = [];
  const pass = stage => async ctx => {
    seen.push({stage, item: ctx.item, from: ctx.upstream?.stage ?? null, mode: ctx.gate.mode ?? null});
    if (stage === 'plan') {
      const ticket = {schema: 'ophanim.ticket/v1', item: ctx.item, slice: 'all', proposes: {state: 'Resolved', basis: 'done'}, title: ctx.gate.requirement.title,
        goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: 'a.mjs', copy: [], acceptance_cmd: 'true'};
      fs.writeFileSync(path.join(f.repo, 'tickets', `${ctx.item}.json`), JSON.stringify(ticket));
      const {readTicket} = await import('../../pantheon/src/board/operate.mjs');
      const t = readTicket({repo: f.repo, item: ctx.item});
      // A revised plan differs from the one it revises (it answers the returned findings).
      // test-lint: allow scripted-terminal-status -- a scripted plan, the INPUT of these controller-core tests (the real executors are tested in stages.test.mjs): they assert the dispatch order, handoffs, reuse and budgets, not a stage's own outcome
      return {status: 'passed', identity: {ticket: {path: t.path, digest: t.digest}}, outputs: {plan_version: seen.length, ticket: {path: t.path, digest: t.digest}, deps: {}, evidence: []},
        team: [{role: 'planner', lab: 'anthropic'}], contributions: [], findings: [], usage: {provider_calls: 3}, next: {stage: 'implement', why: 'approved'}};
    }
    // Each run produces its own output (a real revision is a different commit).
    // test-lint: allow scripted-terminal-status -- a scripted stage, the INPUT of these controller-core tests (the real executors are tested in stages.test.mjs): they assert the dispatch order, handoffs, reuse and budgets, not a stage's own outcome
    return {status: 'passed', outputs: {[`${stage}_done`]: true, run: seen.length}, team: [{role: stage}], contributions: [], findings: [], usage: {provider_calls: 2}, next: {stage: null, why: 'ok'}};
  };
  const ex = Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, overrides[s] ?? pass(s)]));
  return {ex, seen};
}

test('a Ready item with no ticket is dispatched by the scheduler through every stage, each handoff verified, to the owner', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  try {
    const {ex, seen} = scripted(f);
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r.dispatched.map(d => d.stage), ['plan', 'implement', 'review', 'validate', 'outcome']);
    assert.deepEqual(seen.map(s => s.from), [null, 'plan', 'implement', 'review', 'validate'], 'each stage received the previous one');
    assert.equal(seen[0].mode, 'author', 'no ticket: planning authors one');
    assert.ok(fs.existsSync(path.join(f.repo, 'tickets', 'alpha.json')), 'planning created the ticket');
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    const rec = reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: w});
    assert.equal(rec.items[0].gate.gate, 'awaiting-owner');
    assert.equal(r.spent.calls, 3 + 2 * 4);
    // Reuse: a second tick dispatches nothing (every stage is valid), and pays nothing.
    const again = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(again.dispatched, []);
  } finally { f.done(); }
});

test('an existing ticket enters the lifecycle at planning, to re-check it (mode revalidate)', async () => {
  const f = fixture([{item: 'beta', title: 'Beta', state: 'Ready'}]);
  try {
    fs.writeFileSync(path.join(f.repo, 'tickets', 'beta.json'), JSON.stringify({schema: 'ophanim.ticket/v1', item: 'beta', slice: 's', proposes: {state: 'Resolved', basis: 'b'},
      title: 't', goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: 'a.mjs', copy: [], acceptance_cmd: 'true'}));
    const {ex, seen} = scripted(f);
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, iterations: 1}});
    assert.deepEqual(seen.map(s => [s.stage, s.mode]), [['plan', 'revalidate']]);
  } finally { f.done(); }
});

test('stale evidence: changing the requirement after planning re-plans; unchanged inputs are reused', async () => {
  const f = fixture([{item: 'gamma', title: 'Gamma', state: 'Ready'}]);
  try {
    const {ex} = scripted(f);
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, iterations: 2}});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'review', 'plan and implement reused');
    f.S.set({item: 'gamma', title: 'Gamma', state: 'Ready', basis: 'a CHANGED requirement', checked: '2026-11-18'});
    const g = reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})}).items[0].gate;
    assert.equal(g.gate, 'plan');
    assert.match(g.stale[0].why.join(), /original requirement changed/);
  } finally { f.done(); }
});

test('failures return to the right stage: an implementation defect to implement, an invalid assumption to plan', async () => {
  const f = fixture([{item: 'delta', title: 'Delta', state: 'Ready'}]);
  try {
    let validations = 0;
    const {ex, seen} = scripted(f, {validate: async ctx => {
      validations++;
      seen.push({stage: 'validate', from: ctx.upstream.stage, mode: ctx.gate.mode ?? null});
      if (validations === 1) return {status: 'returned', outputs: {verdict: 'implementation_defect'}, team: [], contributions: [], findings: [{id: 'v1', severity: 'block', text: 'regression'}],
        usage: {provider_calls: 1}, next: {stage: 'implement', why: 'the change breaks a regression case'}};
      if (validations === 2) return {status: 'returned', outputs: {verdict: 'plan_defect'}, team: [], contributions: [], findings: [{id: 'v2', severity: 'block', text: 'criterion wrong'}],
        usage: {provider_calls: 1}, next: {stage: 'plan', why: 'the acceptance criterion does not test the requirement'}};
      // test-lint: allow scripted-terminal-status -- the third validation's scripted acceptance, the INPUT: the test asserts the order the scheduler routes the two returns in (implement*, then plan*), ending at the outcome
      return {status: 'passed', outputs: {verdict: 'accept'}, team: [], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'outcome', why: 'accepted'}};
    }});
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const order = seen.map(s => `${s.stage}${s.mode === 'revise' ? '*' : ''}`);
    assert.deepEqual(order, ['plan', 'implement', 'review', 'validate', 'implement*', 'review', 'validate', 'plan*', 'implement', 'review', 'validate', 'outcome']);
  } finally { f.done(); }
});

test('duplicates, budgets, interruption and missing executors are bounded', async () => {
  const f = fixture([{item: 'eps', title: 'Eps', state: 'Ready'}, {item: 'zeta', title: 'Zeta', state: 'Ready', depends_on: ['eps']}]);
  try {
    const {ex} = scripted(f);
    // Budget: nothing is dispatched without a declared total.
    const none = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {total_provider_calls: 0}});
    assert.deepEqual(none.dispatched, []);
    assert.match(none.stopped, /provider-call budget/);
    assert.ok(none.blocked.some(b => b.item === 'zeta' && /eps/.test(b.blocker.what)), 'a dependency blocker names what and when it resumes');
    // Duplicate claim: an active claim refuses a second one for the same item.
    const w = openWorkLedger({root: f.workRoot});
    const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1, retries: 1};
    const c = w.claim({item: 'eps', stage: 'plan', attempt: 1, inputs: {x: 1}, holder: 'a', budget, lease_ms: 60_000});
    assert.throws(() => w.claim({item: 'eps', stage: 'plan', attempt: 1, inputs: {x: 1}, holder: 'b', budget}), /already claimed/);
    const busy = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(busy.dispatched.filter(d => d.item === 'eps'), [], 'a claimed item is not dispatched twice');
    // Interruption: the lease expires with no result; the next tick releases it and resumes.
    const later = Date.now() + 120_000;
    const resumed = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, clock: () => later});
    assert.deepEqual(resumed.released_expired.map(x => x.item), ['eps']);
    assert.ok(resumed.dispatched.some(d => d.item === 'eps' && d.stage === 'plan'));
    assert.equal(openWorkLedger({root: f.workRoot}).released(c).outcome, 'expired');
    // A missing executor is reported, never skipped silently.
    const g = fixture([{item: 'eta', title: 'Eta', state: 'Ready'}]);
    try {
      const r = await tick({repo: g.repo, statusRoot: g.statusRoot, workRoot: g.workRoot, executors: {}, limits: LIMITS});
      assert.match(r.skipped[0].why, /no executor for plan/);
    } finally { g.done(); }
  } finally { f.done(); }
});

test('the trigger: watch ticks only when its inputs change, and a dependency resolving wakes the waiting item', async () => {
  const f = fixture([{item: 'one', title: 'One', state: 'Ready'}, {item: 'two', title: 'Two', state: 'Ready', depends_on: ['one']}]);
  try {
    const {ex, seen} = scripted(f);
    const state = {last: null};
    const run = () => watch({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, once: true, state});
    await run();
    assert.ok(seen.every(s => s.item === 'one'), 'two waits on one');
    assert.deepEqual((await run()), [], 'no change, no tick');
    f.S.set({item: 'one', title: 'One', state: 'Resolved', basis: 'done', checked: '2026-11-18'});
    await run();
    assert.ok(seen.some(s => s.item === 'two' && s.stage === 'plan'), 'the dependency resolving woke two');
  } finally { f.done(); }
});

test('a handoff that does not re-derive is refused by the receiving stage and by the ledger', async () => {
  const f = fixture([{item: 'theta', title: 'Theta', state: 'Ready'}]);
  try {
    const {ex} = scripted(f);
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: {...LIMITS, iterations: 1}});
    const w = openWorkLedger({root: f.workRoot});
    const plan = w.stages('theta')[0];
    assert.throws(() => verifyHandoff(w, {item: 'theta', gate: 'review', from: plan.hash}), /receives from implement/);
    const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1, retries: 1};
    const claim = w.claim({item: 'theta', stage: 'implement', attempt: 1, inputs: {forged: true}, holder: 'x', budget});
    assert.throws(() => w.recordStage({claim, from: plan.hash, stage: 'implement', attempt: 1, status: 'passed', identity: plan.identity,
      inputs: {upstream: 'sha256:' + 'f'.repeat(64)}, outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null}),
    /inputs are not the outputs/);
    assert.ok(outputsDigest(plan.outputs));
  } finally { f.done(); }
});

test('missing authority: with no controller key the tick refuses (NO_AUTHORITY) rather than skipping work', async () => {
  const f = fixture([{item: 'iota', title: 'Iota', state: 'Ready'}]);
  try {
    const {ex} = scripted(f);
    await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits: LIMITS}); // creates the ledger and records intake
    fs.rmSync(path.join(f.workRoot, 'keys'), {recursive: true, force: true});
    await assert.rejects(() => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS}), e => e.code === 'NO_AUTHORITY');
    assert.equal(openWorkLedger({root: f.workRoot}).verify().ok, true, 'the ledger still verifies; nothing was recorded without authority');
  } finally { f.done(); }
});

test('a plan pending on a transient failure is retried once due and within the attempt bound; a structural block is not re-dispatched', async () => {
  const f = fixture([{item: 'flaky', title: 'Flaky', state: 'Ready'}, {item: 'short', title: 'Short', state: 'Ready'}]);
  try {
    let down = 2;
    const {ex: base} = scripted(f);
    const plan = async ctx => {
      if (ctx.item === 'short') return {status: 'pending', usage: {provider_calls: 0}, outputs: {mode: ctx.gate.mode},
        blocker: {what: 'REVIEW_CAPACITY_PENDING: two labs outside the planner', role: 'check@review', resume_when: 'a reviewer lab becomes available'}};
      if (down-- > 0) return {status: 'pending', usage: {provider_calls: 3}, outputs: {mode: ctx.gate.mode},
        blocker: {what: 'REVIEW_PENDING: a plan reviewer failed', role: 'check@review', resume_when: 'the reviewer is available', transient: true}};
      return base.plan(ctx);
    };
    const ex = {...base, plan};
    const L = {...LIMITS, retry_after_ms: 60_000};
    let t = Date.parse('2026-11-17T00:00:00Z');
    const run = async () => (await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: L, clock: () => t})).dispatched.map(d => `${d.item}:${d.stage}:${d.status}`);
    assert.deepEqual(await run(), ['flaky:plan:pending', 'short:plan:pending'], 'each is recorded once in the tick');
    t += 30_000;
    assert.deepEqual(await run(), [], 'not before the retry is due');
    t += 60_000;
    assert.deepEqual(await run(), ['flaky:plan:pending'], 'the transient one is retried when due; the structural one waits');
    t += 120_000;
    assert.deepEqual(await run(), ['flaky:plan:passed', 'flaky:implement:passed', 'flaky:review:passed', 'flaky:validate:passed', 'flaky:outcome:passed'], 'the retried plan hands on; the structural one is not dispatched');
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(w.stages('flaky').filter(s => s.stage === 'plan').map(s => s.attempt), [1, 2, 3]);
    assert.deepEqual(w.stages('short').map(s => s.status), ['pending']);
  } finally { f.done(); }
});

test('the item selector: with `only`, intake still records every item, but only the selected one is dispatched; every other runnable item is skipped "outside the --item scope"', async () => {
  const f = fixture(['one', 'two', 'three'].map(item => ({item, title: item, state: 'Ready'})));
  try {
    const {ex, seen} = scripted(f);
    const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, only: 'two'});
    assert.deepEqual([...new Set(seen.map(s => s.item))], ['two']);
    assert.deepEqual(r.dispatched.map(d => `${d.item}:${d.stage}`), ['plan', 'implement', 'review', 'validate', 'outcome'].map(s => `two:${s}`));
    assert.deepEqual(r.intake.sort(), ['status:one', 'status:three', 'status:two']);
    assert.deepEqual(r.skipped, [{item: 'one', gate: 'plan', why: 'outside the --item scope'}, {item: 'three', gate: 'plan', why: 'outside the --item scope'}]);
    assert.deepEqual(r.scope, {only: 'two', on_ledger: true, gate: 'plan', runnable: true});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual([w.claims('one').length, w.claims('three').length, w.stages('two').length], [0, 0, 5]);
    // An item that is not on the ledger dispatches nothing, and says so.
    const none = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, only: 'nope'});
    assert.deepEqual([none.dispatched, none.scope], [[], {only: 'nope', on_ledger: false, gate: null, runnable: false}]);
    await assert.rejects(tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS, only: ''}), /names one status item/);
  } finally { f.done(); }
});
