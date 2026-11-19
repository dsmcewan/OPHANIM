// Wave 2, sub-wave 2b: the stage meter per request, budget stops by code, and a dead lifecycle attempt's integration
// branch. Register ids (self-audit round 3, assignment 3 (sealed bb1287a)):
//   L-301  the stage meter and the pipeline's admission charged a turn's first call BEFORE the turn: a lane that failed
//          before its spawn (no CLI, no jail) was a charged provider call. Now every call is admitted at its point of
//          spend (the per-request contract of sdk/live.mjs); the refusals are still checked up front.
//   L-308  budget stops were classified by the WORDS of a failure (a regex), and a validator out of budget was recorded
//          as a defect of the validation. Now by the meter's CODE, and the validator's budget stop is a transient pending.
//   L-304  a killed lifecycle attempt's integration branch (refs/heads/pantheon/pipeline/<run_id>) was never deleted:
//          each attempt runs in a new directory, and the cleanup ran only for a restart into the same one.
//
// PRODUCTION ENTRY POINTS: tick (scheduler.mjs) over the real work ledger and the stage executors of makeExecutors under
// the default `fit` profile; Pantheon's pipeline with the production pipelineTurns and runAgyWorkerTurn, the Antigravity
// lane being the fixture's fake agy CLI run in the REAL bwrap jail (withDispatch); the killed attempt is a REAL child
// process SIGKILLed mid-stage. Single-turn seats are scripted (no network); every credential is synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {sandboxAvailable} from '../../pantheon/src/agy/sandbox.mjs';
import {runPipeline} from '../../pantheon/src/pipeline/index.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, json, git, LIMITS, FIVE} from './test-fixtures.mjs';

const HERE = import.meta.dirname, ROOT = path.resolve(HERE, '../..');
const box = await sandboxAvailable('bwrap');
const real = {timeout: 300_000};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); } };
const WRITE_ALPHA = 'printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n';
const spendOf = (w, claim) => Math.max(0, ...w.spends(claim).map(s => s.provider_calls));
const branches = (repo, pattern) => git(repo, 'branch', '--list', pattern).split('\n').map(l => l.replace(/^[*+ ]+/, '').trim()).filter(Boolean);

test('the bwrap jail is available on this host (the lane tests run the real boundary, they are never skipped)', () => {
  assert.equal(box.ok, true, `bwrap: ${box.why}`);
});

/** The fit lifecycle on the alpha fixture, with the scripted seats and the fake agy lane: executors and the ledgers. */
function lifecycle(ctx, {turn = scriptedTurn(), investigation = {}, items = ['alpha']} = {}) {
  const repo = ctx.dir;
  const f = fixture(repo, items.map(item => ({item})));
  const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'model', seating: FIVE.seating, facts: FIVE.facts, investigation});
  const at = {repo, statusRoot: f.statusRoot, workRoot: f.workRoot};
  return {repo, f, ex, turn, at, w: () => openWorkLedger({root: f.workRoot, create: false}), last: item => openWorkLedger({root: f.workRoot, create: false}).stages(item).at(-1)};
}

// ---- L-301: the stage meter and the pipeline admission, per request ----------------------------------------------------

test('L-301 (self-audit round 3, assignment 3 (sealed bb1287a)): the implement stage charges a lane that failed before its spawn NOTHING; a spawned lane is charged once, before its spawn', real, async () => {
  await withDispatch(async ctx => {
    ctx.agyWorker(WRITE_ALPHA);
    const L = lifecycle(ctx, {items: ['alpha', 'beta']});
    await tick({...L.at, executors: {plan: L.ex.plan}, limits: LIMITS});
    assert.deepEqual(['alpha', 'beta'].map(i => `${L.last(i).stage}:${L.last(i).status}`), ['plan:passed', 'plan:passed']);
    // alpha: every lane of the unit's ladder fails BEFORE its spawn -- the agy CLI is absent, and pipelineTurns refuses
    // it before the worker session is admitted. The dispatcher (a scripted seat) answered.
    const cli = process.env.PANTHEON_AGY_CLI;
    process.env.PANTHEON_AGY_CLI = path.join(ctx.dir, 'no-such-agy');
    let t;
    const d0 = L.turn.log.filter(l => l.kind === 'dispatcher').length;
    try { t = await tick({...L.at, executors: {implement: L.ex.implement}, limits: LIMITS, only: 'alpha'}); } finally { process.env.PANTHEON_AGY_CLI = cli; }
    const impl = L.last('alpha');
    assert.equal(impl.stage, 'implement');
    const rec = JSON.parse(fs.readFileSync(impl.outputs.run.record, 'utf8'));
    const failures = Object.values(rec.units).flatMap(u => u.attempts.flatMap(a => a.lane_failures ?? []));
    assert.ok(failures.length >= 2 && failures.every(x => x.kind === 'spawn' && /CLI absent/.test(x.why)), JSON.stringify(failures));
    assert.equal(rec.provider_calls.by_role.implementer, 0, 'no lane was spawned, so none is a provider call');
    const dispatched = L.turn.log.filter(l => l.kind === 'dispatcher').length - d0;
    assert.ok(dispatched >= 1);
    assert.equal(rec.provider_calls.total, dispatched);
    assert.equal(spendOf(L.w(), L.w().claims('alpha').at(-1).hash), dispatched, 'the work ledger was charged the dispatcher\'s call(s) only');
    assert.equal(impl.usage.provider_calls, dispatched);
    assert.equal(t.dispatched[0].provider_calls, dispatched);
    // beta: the CLI is present, so every lane spawns; each is charged exactly once.
    const before = ctx.agy().length;
    await tick({...L.at, executors: {implement: L.ex.implement}, limits: LIMITS, only: 'beta'});
    const ok = L.last('beta');
    assert.equal(`${ok.stage}:${ok.status}`, 'implement:passed', JSON.stringify(ok.next));
    const rec2 = JSON.parse(fs.readFileSync(ok.outputs.run.record, 'utf8'));
    assert.ok(ctx.agy().length > before);
    assert.equal(rec2.provider_calls.by_role.implementer, ctx.agy().length - before, 'one charged call per lane spawned');
    assert.equal(spendOf(L.w(), L.w().claims('beta').at(-1).hash), rec2.provider_calls.total);
  });
});

test('L-301: a review seat whose turn takes the per-request contract and fails before its spawn costs the stage nothing; one that admits is charged at its admission', real, async () => {
  await withDispatch(async ctx => {
    ctx.agyWorker(WRITE_ALPHA);
    const base = scriptedTurn();
    // The change reviewers' transport: the per-request contract. One lab's seat fails before anything is sent (its
    // transport refuses before the spawn, as a lane with no CLI does); the others admit their one call, then answer.
    let failedLab = null;
    const turn = async args => {
      if (!/^You are an independent reviewer of a PLAN|^You are the planner|^ROLE:|validator/.test(args.prompt) && args.admitRequest) {
        failedLab ??= args.vendor;
        if (args.vendor === failedLab) throw Object.assign(new Error('agy CLI absent: nothing was spawned'), {code: 'lane_failure', kind: 'spawn'});
        args.admitRequest({kind: 'request'});
      }
      return base(args);
    };
    const L = lifecycle(ctx, {turn});
    await tick({...L.at, executors: {plan: L.ex.plan, implement: L.ex.implement}, limits: LIMITS});
    const before = base.log.filter(l => l.kind === 'review').length;
    await tick({...L.at, executors: {review: L.ex.review}, limits: LIMITS});
    const rev = L.w().stages('alpha').at(-1);
    assert.equal(rev.stage, 'review');
    assert.equal(rev.status, 'pending', JSON.stringify(rev.blocker));
    const answered = base.log.filter(l => l.kind === 'review').length - before;
    assert.ok(answered >= 2 && failedLab, `${answered} reviews answered`);
    assert.equal(rev.usage.provider_calls, answered, 'the seat that failed before its spawn is not a provider call');
    assert.equal(spendOf(L.w(), L.w().claims('alpha').at(-1).hash), answered);
  });
});

// ---- L-308: budget stops by code ----------------------------------------------------------------------------------------

test('L-308 (self-audit round 3, assignment 3 (sealed bb1287a)): a validator that runs out of the stage\'s provider-call budget is a transient STAGE_PROVIDER_CALLS pending, not a validation defect', real, async () => {
  await withDispatch(async ctx => {
    ctx.agyWorker(WRITE_ALPHA);
    // The validator keeps asking for records; its investigation is bounded only by the stage's budget.
    const turn = scriptedTurn({validator: () => json({requests: [{op: 'file', path: 'alpha.mjs'}]})});
    const L = lifecycle(ctx, {turn, investigation: {rounds: 100}});
    await tick({...L.at, executors: {plan: L.ex.plan, implement: L.ex.implement, review: L.ex.review}, limits: LIMITS});
    assert.deepEqual(L.w().stages('alpha').map(s => `${s.stage}:${s.status}`), ['plan:passed', 'implement:passed', 'review:passed']);
    const t = await tick({...L.at, executors: {validate: L.ex.validate}, limits: {...LIMITS, stage_provider_calls: 4}});
    const val = L.w().stages('alpha').at(-1);
    assert.equal(val.stage, 'validate');
    assert.equal(val.status, 'pending', `${val.status}: ${val.next?.why}`);
    assert.equal(val.outputs.cause, 'stage-provider-calls');
    assert.deepEqual([val.blocker.code, val.blocker.transient], ['STAGE_PROVIDER_CALLS', true]);
    assert.match(val.blocker.what, /^STAGE_PROVIDER_CALLS: the validate stage's provider-call budget of 4 was spent \(4 made/);
    assert.equal(val.usage.provider_calls, 4);
    assert.deepEqual(val.usage.budget_exhausted, {code: 'STAGE_PROVIDER_CALLS', charged: 4, budget: 4, refused_charges: 0});
    assert.equal(t.dispatched[0].status, 'pending');
  });
});

test('L-308: a reviewer whose failure merely SAYS "PROVIDER_CALL_LIMIT" (a provider\'s error text) is not a budget stop; the meter\'s own refusal is', real, async () => {
  await withDispatch(async ctx => {
    ctx.agyWorker(WRITE_ALPHA);
    // On alpha, the first change-review seat asked fails with a provider's error text that names the limit; nothing of
    // the stage's budget refused it.
    let saying = null;
    const turn = scriptedTurn({review: ({vendor, item}) => {
      if (item === 'alpha' || saying === null) saying ??= vendor;
      if (vendor === saying && item !== 'beta') throw new Error('upstream 429: PROVIDER_CALL_LIMIT reached for this API key');
      return '```json\n{"verdict": "approve", "findings": []}\n```';
    }});
    const L = lifecycle(ctx, {turn, items: ['alpha', 'beta']});
    await tick({...L.at, executors: {plan: L.ex.plan, implement: L.ex.implement}, limits: LIMITS});
    assert.deepEqual(['alpha', 'beta'].map(i => `${L.last(i).stage}:${L.last(i).status}`), ['implement:passed', 'implement:passed']);
    // The panel is three seats and the stage's budget exactly three calls.
    await tick({...L.at, executors: {review: L.ex.review}, limits: {...LIMITS, stage_provider_calls: 3}, only: 'alpha'});
    const words = L.last('alpha');
    assert.deepEqual([words.stage, words.status], ['review', 'pending']);
    assert.match(words.blocker.what, /^REVIEW_PENDING: 2 of 3 reviews recorded \(.*PROVIDER_CALL_LIMIT reached for this API key/);
    assert.notEqual(words.blocker.code, 'STAGE_PROVIDER_CALLS', 'a reason\'s words are not a budget stop');
    // On beta, a budget of 2 for a panel of 3: the meter refuses the third seat it opens, and THAT is a budget stop.
    await tick({...L.at, executors: {review: L.ex.review}, limits: {...LIMITS, stage_provider_calls: 2}, only: 'beta'});
    const meterStop = L.last('beta');
    assert.deepEqual([meterStop.stage, meterStop.status, meterStop.blocker.code, meterStop.blocker.transient], ['review', 'pending', 'STAGE_PROVIDER_CALLS', true], meterStop.blocker.what);
    assert.match(meterStop.blocker.what, /PROVIDER_CALL_LIMIT: 0 of 2 stage provider call\(s\) used, 2 held by turns in flight/, "refused up front: the two seats opened before it hold the budget");
  });
});

test('L-308: a change reviewer whose investigation ends on the stage\'s budget (no refusal: its "may I ask again" was no) is a STAGE_PROVIDER_CALLS stop; every retrieval round is charged once', real, async () => {
  await withDispatch(async ctx => {
    ctx.agyWorker(WRITE_ALPHA);
    // One reviewer lab keeps asking for records; the others answer at once.
    let asker = null;
    const turn = scriptedTurn({review: ({vendor}) => {
      asker ??= vendor;
      return vendor === asker ? json({requests: [{op: 'file', path: 'alpha.mjs'}]}) : '```json\n{"verdict": "approve", "findings": []}\n```';
    }});
    const L = lifecycle(ctx, {turn, investigation: {rounds: 100}});
    await tick({...L.at, executors: {plan: L.ex.plan, implement: L.ex.implement}, limits: LIMITS});
    const before = turn.log.filter(l => l.kind === 'review').length;
    await tick({...L.at, executors: {review: L.ex.review}, limits: {...LIMITS, stage_provider_calls: 6}});
    const rev = L.last('alpha');
    assert.deepEqual([rev.stage, rev.status], ['review', 'pending']);
    assert.deepEqual([rev.blocker.code, rev.blocker.transient], ['STAGE_PROVIDER_CALLS', true], rev.blocker.what);
    assert.match(rev.blocker.what, /\(6 made, 0 refused\)/, 'no call was refused: the investigation stopped asking');
    const asked = turn.log.filter(l => l.kind === 'review').length - before;
    assert.equal(asked, 6, 'two answers and four retrieval rounds');
    assert.equal(rev.usage.provider_calls, 6, 'each round charged once');
    assert.equal(spendOf(L.w(), L.w().claims('alpha').at(-1).hash), 6);
  });
});

// ---- L-304: a dead attempt's integration branch, through the lifecycle --------------------------------------------------

test('L-304 (self-audit round 3, assignment 3 (sealed bb1287a)): the next implement attempt deletes a SIGKILLed attempt\'s integration branch, and keeps a live run\'s and a finished run\'s', real, async () => {
  await withDispatch(async ctx => {
    const L = lifecycle(ctx);
    await tick({...L.at, executors: {plan: L.ex.plan}, limits: LIMITS});
    assert.equal(`${L.last('alpha').stage}:${L.last('alpha').status}`, 'plan:passed');
    const release = `${process.env.FAKE_AGY_LOG}.release`;
    // The lane holds until released, so the attempt is killed with its unit worktree and integration branch in place.
    ctx.agyWorker(`while [ ! -e "${release}" ]; do sleep 0.1; done\nexit 1\n`);
    const itemDir = path.join(L.f.stateDir, 'alpha');
    const others = [];
    try {
      // ATTEMPT 1, in a real child process: tick dispatches the implement stage, which is SIGKILLed mid-run.
      const url = p => JSON.stringify(pathToFileURL(path.join(ROOT, p)).href);
      const code = `import {tick} from ${url('ophanim/operate/scheduler.mjs')};
        import {makeExecutors} from ${url('ophanim/operate/stages.mjs')};
        import {scriptedTurn, FIVE, LIMITS} from ${url('ophanim/operate/test-fixtures.mjs')};
        import {scriptedClients} from ${url('pantheon/tests/fixtures/dispatch.mjs')};
        const ex = makeExecutors({repo: ${JSON.stringify(L.repo)}, makeClientFor: scriptedClients(), turn: scriptedTurn(), stateDir: ${JSON.stringify(L.f.stateDir)}, independence: 'model', seating: FIVE.seating, facts: FIVE.facts});
        await tick({repo: ${JSON.stringify(L.repo)}, statusRoot: ${JSON.stringify(L.f.statusRoot)}, workRoot: ${JSON.stringify(L.f.workRoot)}, executors: {implement: ex.implement}, limits: LIMITS});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'pipe']});
      let err = ''; child.stderr.on('data', d => { err += d; });
      const closed = new Promise(r => child.on('close', r));
      others.push(child);
      await until(() => branches(L.repo, 'pantheon/pipeline/*').length === 1 && ctx.agy().some(a => a.agent === 'pantheon-unit-worker'), 60_000, `attempt 1's branch and lane (${err.slice(-500)})`);
      child.kill('SIGKILL'); await closed;
      const [killedDir] = fs.readdirSync(itemDir).filter(n => /^pipeline-1-/.test(n)).map(n => path.join(itemDir, n));
      const killedRun = JSON.parse(fs.readFileSync(path.join(killedDir, 'owner.json'), 'utf8')).run_id;
      const killedBranch = `pantheon/pipeline/${killedRun}`;
      assert.deepEqual(branches(L.repo, 'pantheon/pipeline/*'), [killedBranch]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(killedDir, 'pipeline.json'), 'utf8')).status, 'running', 'the attempt died before it ended');
      fs.writeFileSync(release, '');   // the orphaned fake lane may exit now

      // A FINISHED run beside it (it ended incomplete: its unit's verify fails, so its branch is kept as its evidence) and a
      // LIVE run (a real process, its implementer in flight): both are pipeline runs of this item's state directory.
      const {seats, unit, scripted, PLANNER} = await import(pathToFileURL(path.join(ROOT, 'pantheon/tests/fixtures/pipeline-stages.mjs')).href);
      const failing = [unit('z', {verify_cmd: 'false'})];
      const done = await runPipeline({repo: L.repo, base: 'main', plan: {work_units: failing}, seats: seats(), turns: scripted({plan: failing}).turns, dir: path.join(itemDir, 'pipeline-0-finished'), planner: PLANNER, limits: {max_revisions: 0}});
      assert.equal(done.status, 'incomplete');
      const liveCode = `import {runPipeline} from ${url('pantheon/src/pipeline/index.mjs')};
        import {seats, unit, scripted, PLANNER} from ${url('pantheon/tests/fixtures/pipeline-stages.mjs')};
        setInterval(() => {}, 1000);
        const plan = [unit('y')];
        await runPipeline({repo: ${JSON.stringify(L.repo)}, base: 'main', plan: {work_units: plan}, seats: seats(), turns: scripted({plan, implement: () => new Promise(() => {})}).turns,
          dir: ${JSON.stringify(path.join(itemDir, 'pipeline-0-live'))}, planner: PLANNER});`;
      const live = spawn(process.execPath, ['--input-type=module', '-e', liveCode], {cwd: ROOT, env: process.env, stdio: 'ignore'});
      others.push(live);
      await until(() => branches(L.repo, 'pantheon/pipeline/*').length === 3, 60_000, 'the live run\'s branch');
      const liveBranch = `pantheon/pipeline/${JSON.parse(fs.readFileSync(path.join(itemDir, 'pipeline-0-live', 'owner.json'), 'utf8')).run_id}`;
      const finishedBranch = done.integration.branch;
      assert.deepEqual(branches(L.repo, 'pantheon/pipeline/*').sort(), [killedBranch, liveBranch, finishedBranch].sort());

      // ATTEMPT 2, after the killed claim's lease: the lane works now.
      ctx.agyWorker(WRITE_ALPHA);
      await tick({...L.at, executors: {implement: L.ex.implement}, limits: LIMITS, clock: () => Date.now() + 2 * 3_600_000});
      const impl = L.last('alpha');
      assert.equal(`${impl.stage}:${impl.status}`, 'implement:passed', JSON.stringify(impl.next));
      assert.deepEqual(impl.outputs.recovered_branches, [killedBranch], 'the dead attempt\'s branch is reported recovered');
      assert.deepEqual(branches(L.repo, 'pantheon/pipeline/*').sort(), [liveBranch, finishedBranch].sort(), 'only the dead attempt\'s branch is gone');
      assert.ok(fs.existsSync(path.join(itemDir, 'pipeline-0-live', 'owner.json')), 'the live run is untouched');
    } finally {
      fs.writeFileSync(release, '');
      for (const c of others) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    }
  });
});
