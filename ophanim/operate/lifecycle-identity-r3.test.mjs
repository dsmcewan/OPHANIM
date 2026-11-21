// Regression tests for self-audit round 3, assignment 1 (sealed 323361a): the attempt identity and the lifecycle's
// recovery paths (register entries L-101 to L-104). Every test drives a production entry point -- tick, watch or the
// execution service -- over the real stage executors with scripted seats (test-fixtures.mjs), or over scripted
// executors where only the scheduler's own behaviour is under test. No provider is called.
//
// The defect class (L-101): the work ledger's idempotency key and the scheduler's attempt bound were derived from
// {upstream, requirement, returned_by, rereview} only, so every re-route the gate made because something ELSE changed
// (evidence, the ticket, a dependency, the status entry, review capacity) was refused as "already completed for these
// exact inputs", filed under `skipped`, and never looked at again.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {watch} from './scheduler.mjs';
import {tickWithPrimary as tick} from './test-fixtures.mjs';   // every tick declares primary Gemini execution: the fit implementer is an SDK session
import {reconcile} from './reconcile.mjs';
import {openWorkLedger, outputsDigest, handoffRefusal} from './work-ledger.mjs';
import {makeExecutors} from './stages.mjs';
import {readServiceConfig, runService, SERVICE_CONFIG_SCHEMA} from './service.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {SEATING} from '../../pantheon/src/role/seating.mjs';
import {labOf} from '../../pantheon/src/config/models.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, git, TICKET, LIMITS, SIX, APPROVE, ACCEPT, stagesOf} from './test-fixtures.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
// Imported as a namespace: the race test needs the attempt identity the scheduler claims with (gates.mjs attemptInputs).
import * as gates from './gates.mjs';

const SA = 'self-audit round 3, assignment 1 (sealed 323361a)';
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const plans = (w, item) => w.stages(item).filter(s => s.stage === 'plan');
const gateOf = (f, repo, w, item, extra = {}) => reconcile({repo, statusRoot: f.statusRoot, workLedger: w, ...extra}).items.find(i => i.item === item).gate;

// ---- L-101: a stale plan is planned again (tick and watch), never skipped for good ------------------------------
for (const [label, change, why] of [
  ['a cited evidence file changes', (repo, f, k) => { fs.appendFileSync(path.join(repo, 'verify.mjs'), `// change ${k}\n`); git(repo, 'commit', '-qam', `change verify ${k}`); }, /evidence verify\.mjs changed/],
  ['the approved ticket is edited', (repo, f, k) => { const p = path.join(repo, 'tickets', 'target.json'); const t = JSON.parse(fs.readFileSync(p, 'utf8')); t.goal += ` (edit ${k})`; fs.writeFileSync(p, JSON.stringify(t, null, 2) + '\n'); },
    /the ticket was changed after the plan approved it/],
  ['a dependency gets a new status entry', (repo, f, k) => f.S.set({item: 'dep', title: 'Dep', basis: `the dependency, re-checked ${k}`, state: 'Resolved', checked: '2026-11-19'}), /dependency dep changed/],
]) {
  test(`${SA}, Q1/Q5: ${label}; tick re-plans on the present state, watch wakes for it, every time, and an unchanged state is reused`, async () => {
    await withDispatch(async ctx => {
      const repo = ctx.dir;
      const f = fixture(repo, [{item: 'dep', title: 'Dep', basis: 'the dependency', state: 'Resolved'}, {item: 'target', depends_on: ['dep']}]);
      const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {dependencies: ['dep']}))});
      const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
      const r1 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS, only: 'target'});
      assert.deepEqual(stagesOf(r1), ['plan:passed']);
      const w = openWorkLedger({root: f.workRoot});
      // Three successive changes on the SAME requirement: each is new work, re-planned once. (The scheduler's attempt
      // bound, three on the same inputs, would block the fourth plan if the routing basis were not part of the inputs.)
      for (let k = 1; k <= 3; k++) {
        change(repo, f, k);
        const g = gateOf(f, repo, w, 'target');
        assert.equal(g.gate, 'plan');
        assert.match(JSON.stringify(g.stale), why);
        // The production trigger (watch) sees the change and dispatches the re-plan; it is not refused as done.
        const ticks = await watch({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {plan: ex.plan}, limits: LIMITS, once: true, only: 'target'});
        assert.equal(ticks.length, 1);
        assert.deepEqual(stagesOf(ticks[0]), ['plan:passed'], JSON.stringify({skipped: ticks[0].skipped, blocked: ticks[0].blocked}));
        assert.ok(!JSON.stringify(ticks[0].skipped).includes('already completed'), 'nothing is refused as already done');
        const ps = plans(w, 'target');
        assert.equal(ps.length, k + 1);
        assert.notEqual(ps[k].inputs.route, ps[k - 1].inputs.route, 'the re-plan is a new attempt identity: its routing basis changed');
        assert.equal(turn.log.filter(l => l.kind === 'planner').length, k + 1);
      }
      // Nothing changed since: the last re-plan is valid and reused; no further plan is paid for.
      assert.equal(gateOf(f, repo, w, 'target').gate, 'implement');
      const r3 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS, only: 'target'});
      assert.deepEqual(r3.dispatched, []);
      assert.equal(turn.log.filter(l => l.kind === 'planner').length, 4);
    });
  });
}

test(`${SA}, Q1: another scheduler completing the same attempt between this tick's reading and its claim is absorbed: read again, not skipped, nothing paid twice`, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-race-'));
  try {
    const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
    const S = openStatusLedger({root: statusRoot});
    S.set({checked: '2026-11-17', basis: 'the requirement of race', item: 'race', title: 'race', state: 'Ready'});
    fs.mkdirSync(path.join(repo, 'tickets'));
    openWorkLedger({root: workRoot});
    const out = {status: 'passed', outputs: {deps: {}, evidence: []}, team: [], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'ok'}};
    let made = 0, raced = false;
    const plan = async () => { made++; return out; };
    // The other holder: at the moment this tick asks the clock for its claim's budget check (after it has read the gate),
    // a second scheduler process records the very same attempt as completed.
    const clock = () => {
      if (!raced && /budgetLeft/.test(new Error().stack)) {
        raced = true;
        const other = openWorkLedger({root: workRoot});
        const g = reconcile({repo, statusRoot, workLedger: other}).items.find(i => i.item === 'race').gate;
        const inputs = gates.attemptInputs(g, other.stages('race'));
        const budget = {provider_calls: 2, iterations: 1, elapsed_ms: 1000, retries: 1};
        const c = other.claim({item: 'race', stage: 'plan', attempt: 1, inputs, holder: 'other', budget});
        other.recordStage({claim: c, stage: 'plan', attempt: 1, status: 'passed', identity: {item: 'race', requirement: 'sha256:' + digest({item: 'race', title: 'race', basis: 'the requirement of race'})},
          inputs, ...out});
        other.release({claim: c, item: 'race', stage: 'plan', outcome: 'completed', why: 'ok'});
      }
      return Date.now();
    };
    const t = await tick({repo, statusRoot, workRoot, executors: {plan}, limits: {total_provider_calls: 100, stage_provider_calls: 2}, clock});
    assert.ok(raced, 'the race was staged');
    assert.equal(made, 0, 'the attempt the other holder completed is not paid for again');
    assert.deepEqual(t.dispatched, []);
    assert.ok(!JSON.stringify(t.skipped).includes('already completed'), JSON.stringify(t.skipped));
    assert.ok(t.skipped.some(s => s.item === 'race' && s.gate === 'implement' && /no executor for implement/.test(s.why)), 'it read again and moved on to the next stage');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// ---- L-101: a plan does not stale itself through the ticket it writes ---------------------------------------------
test(`${SA}, Q1/Q5: a plan citing a dossier view derived from the files in play is not made stale by its own ticket write`, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn({planner: ({prompt}) => { const p = planFor(prompt); p.investigation.operational_position.sources = ['verify.mjs', 'consumers:target']; return json(p); }});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    const r1 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const p = plans(w, 'target')[0];
    assert.ok(p.outputs.evidence.some(e => e.source === 'consumers:target'), 'the plan binds the consumers view');
    assert.equal(p.outputs.ticket_given, null, 'the plan records that it was given no ticket');
    assert.ok(fs.existsSync(path.join(repo, 'tickets', 'target.json')), 'and it wrote one');
    assert.equal(gateOf(f, repo, w, 'target').gate, 'implement', 'the just-approved plan is reused');
    const r2 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    assert.deepEqual(r2.dispatched, []);
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
    // A consumer that appears for real does make it stale: the cut-back is of the plan's own consequence only.
    fs.writeFileSync(path.join(repo, 'uses-alpha.mjs'), 'import {ok} from "./alpha.mjs"; export default ok;\n');
    git(repo, 'add', 'uses-alpha.mjs'); git(repo, 'commit', '-qm', 'a new consumer');
    assert.match(JSON.stringify(gateOf(f, repo, w, 'target').stale), /consumers:target changed/);
  });
});

test(`${SA}, Q1/Q5: in a repository that does not ignore the lifecycle's state, a plan citing the repository index is not made stale by its own state files`, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'idx'}]);
    // The target repository ignores only the keys, not the work ledger's sibling state directory (status/operate).
    fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nstatus/ledger/\nstatus/work/\nagy.log\nfake-agy\n');
    git(repo, 'commit', '-qam', 'ignore only the ledgers');
    const turn = scriptedTurn({planner: ({prompt}) => {
      const p = planFor(prompt);
      const index = /source: (index:[0-9a-f]+)/.exec(prompt)?.[1];
      if (index) p.investigation.change_impact.sources = ['alpha.mjs', index];
      return json(p);
    }});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS})), ['plan:passed']);
    const w = openWorkLedger({root: f.workRoot});
    assert.ok(plans(w, 'idx')[0].outputs.evidence.some(e => /^index:/.test(e.source ?? '')), 'the plan binds the index view');
    assert.ok(fs.readdirSync(path.join(f.stateDir, 'idx')).length > 0, 'the plan stage wrote its state files inside the repository');
    assert.equal(gateOf(f, repo, w, 'idx').gate, 'implement');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS})), []);
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
  });
});

// ---- L-101: structural blocks resume on what they wait for ---------------------------------------------------------
test(`${SA}, Q1: a capacity-pending plan is dispatched again when the reviewer pool changes, and once per new status entry; never on an unchanged pool`, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn();
    const shortSeating = Object.fromEntries(Object.entries(SEATING).map(([k, v]) => [k, Array.isArray(v) ? v.filter(r => r.vendor === 'xai') : v]));
    const short = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'lab', seating: shortSeating});
    const run = async ex => stagesOf(await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS}));
    assert.deepEqual(await run(short), ['plan:pending']);
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(plans(w, 'target')[0].blocker.code, 'REVIEW_CAPACITY_PENDING');
    assert.match(plans(w, 'target')[0].blocker.capacity, /^sha256:/, 'the pool it was judged on is recorded');
    const t2 = await tick({repo, ...f, executors: {plan: short.plan}, limits: LIMITS});
    assert.deepEqual(stagesOf(t2), [], 'an unchanged pool is not re-asked');
    assert.equal(t2.blocked.find(b => b.item === 'target')?.blocker.code, 'REVIEW_CAPACITY_PENDING', 'and it is reported blocked');
    // The owner re-records the item Ready (same title and basis): its signed resume. Dispatched once, still short.
    const latest = f.S.board().items.find(i => i.item === 'target');
    f.S.set({item: 'target', title: latest.title, basis: latest.basis, state: 'Ready', checked: '2026-11-19'});
    assert.deepEqual(await run(short), ['plan:pending'], 'a new status entry re-dispatches a structural block');
    assert.deepEqual(await run(short), [], 'once');
    // Capacity returns (the configured pool): dispatched and planned.
    const full = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir, independence: 'lab'});
    assert.equal(gateOf(f, repo, w, 'target').gate, 'blocked', 'a reader with no executors cannot see the pool, and says blocked');
    assert.deepEqual(await run(full), ['plan:passed']);
    assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
  });
});

test(`${SA}, Q1/Q10: an outcome after the owner recorded a new status entry is proposed against that entry, and the record names both`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'moved'}]);
    const turn = scriptedTurn();
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r1 = await tick({repo, ...f, executors: {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed']);
    const before = f.S.board().items.find(i => i.item === 'moved');
    f.S.set({item: 'moved', title: before.title, basis: before.basis, state: 'Ready', checked: '2026-11-19'});
    const after = f.S.board().items.find(i => i.item === 'moved').entry;
    const r2 = await tick({repo, ...f, executors: ex, limits: LIMITS});
    assert.deepEqual(stagesOf(r2), ['outcome:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const o = w.stages('moved').at(-1);
    assert.equal(o.outputs.made_against, after);
    assert.equal(o.outputs.implemented_against, before.entry);
    assert.equal(JSON.parse(fs.readFileSync(path.join(o.outputs.bundle, 'evidence.json'), 'utf8')).made_against, after);
    assert.equal(gateOf(f, repo, w, 'moved').gate, 'awaiting-owner');
  });
});

// ---- L-101: an identity collision is a visible block, through the service ------------------------------------------
test(`${SA}, Q1/Q7: a gate that re-routes on an unchanged routing basis is reported blocked (ATTEMPT_IDENTITY_COLLISION) by reconcile, tick and the service; it is never silently skipped`, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-collision-'));
  try {
    const S = openStatusLedger({root: path.join(repo, 'status', 'ledger')});
    S.set({checked: '2026-11-17', basis: 'the requirement of loop', item: 'loop', title: 'loop', state: 'Ready'});
    fs.mkdirSync(path.join(repo, 'tickets'));
    openWorkLedger({root: path.join(repo, 'status', 'work')});
    const file = path.join(repo, 'operate.json');
    fs.writeFileSync(file, JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', issues: {source: 'none'}, interval_s: 10, limits: {total_provider_calls: 100, stage_provider_calls: 2}}));
    // A plan that rests on a view nothing here can re-read (an issue, with no issue snapshot): it is stale the moment
    // it passes, for a reason that does not change. Re-planning it once is right; a second time on the same state is not.
    let made = 0;
    // test-lint: allow scripted-terminal-status -- the stub plan, the INPUT: the test asserts how often the service dispatches it (made) and that the re-route is blocked ATTEMPT_IDENTITY_COLLISION, not this plan's own outcome
    const plan = async () => { made++; return {status: 'passed', outputs: {deps: {}, evidence: [{ref: 'issue:9', source: 'issue:9', version: 'sha256:' + '9'.repeat(64), request: {op: 'issue', number: 9}}]},
      team: [], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'ok'}}; };
    const config = readServiceConfig(file);
    const r = await runService({config, executors: {plan}, maxTicks: 2, sleep: async () => {}});
    assert.equal(r.code, 0);
    assert.equal(made, 2, 'planned once, re-planned once on the changed state, then not again');
    const blocked = r.ticks.flatMap(t => t.blocked).filter(b => b.item === 'loop');
    assert.ok(blocked.length >= 1 && blocked.every(b => b.blocker.code === 'ATTEMPT_IDENTITY_COLLISION'), JSON.stringify(r.ticks.map(t => t.blocked)));
    assert.ok(!JSON.stringify(r.ticks.map(t => t.skipped)).includes('already completed'), 'never filed as a skip');
    const log = fs.readFileSync(path.join(config.stateDir, 'service.jsonl'), 'utf8');
    assert.match(log, /"code":"ATTEMPT_IDENTITY_COLLISION"/, 'the service log names the block');
    const w = openWorkLedger({root: path.join(repo, 'status', 'work')});
    const g = reconcile({repo, statusRoot: path.join(repo, 'status', 'ledger'), workLedger: w}).items.find(i => i.item === 'loop').gate;
    assert.equal(g.gate, 'blocked');
    assert.equal(g.blocker.code, 'ATTEMPT_IDENTITY_COLLISION');
    assert.equal(g.routed.gate, 'plan');
    // The owner's new status entry is a change of the routing basis: one more plan, then blocked again.
    S.set({checked: '2026-11-19', basis: 'the requirement of loop', item: 'loop', title: 'loop', state: 'Ready'});
    const r2 = await runService({config, executors: {plan}, maxTicks: 1, sleep: async () => {}});
    assert.deepEqual(r2.ticks[0].dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed']);
    assert.equal(made, 3);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// ---- L-102: a re-derived ticket keeps the owner's declarations -----------------------------------------------------
test(`${SA}, Q4: a revised ticket keeps its declared stakes, and the next planner is still seated by them`, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    ctx.serve((_v, m) => m);
    const f = fixture(repo, [{item: 'crit'}], {tickets: ['crit']});
    fs.writeFileSync(path.join(repo, 'tickets', 'crit.json'), JSON.stringify({...TICKET('crit'), difficulty: 'easy', stakes: 'critical', constraints: ['keep the public API']}, null, 2) + '\n');
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, /Mode: revalidate/.test(prompt)
      ? {ticket_assessment: {still_valid: false, reasons: ['the acceptance command needs a parse check as well']},
        acceptance: [{id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd: 'node verify.mjs'}}, {id: 'a2', criterion: 'alpha.mjs parses', test: {cmd: 'node --check alpha.mjs'}}]}
      : {}))});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(plans(w, 'crit')[0].team.find(t => t.role === 'planner').model, 'claude-fable-5-2');
    const t = readTicket({repo, item: 'crit'});
    assert.ok(plans(w, 'crit')[0].outputs.ticket_revision, 'the ticket was re-derived');
    assert.equal(t.spec.stakes, 'critical', 'the owner\'s stakes are kept');
    assert.deepEqual(t.spec.constraints, ['keep the public API'], 'and the owner\'s constraints');
    f.S.set({item: 'crit', title: 'Alpha for crit', basis: 'restated: alpha.mjs exports ok = true and parses', state: 'Ready', checked: '2026-11-19'});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const second = plans(openWorkLedger({root: f.workRoot}), 'crit')[1];
    assert.ok(second);
    assert.equal(second.team.find(x => x.role === 'planner').model, 'claude-fable-5-2', 'the critical item is still planned by the hard planner');
    assert.equal(second.outputs.planner.selection.tier.declared.stakes, 'critical');
  });
});

// ---- L-103: a cut derived dossier view can be continued by the seat it was shown to --------------------------------
test(`${SA}, Q6: the planner continues a cut derived view through its own retriever, and the gap is resolved`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'target'}]);
    for (let i = 0; i < 60; i++) f.S.set({item: `dep-${i}`, title: `Dep ${i}`, state: 'Ready', basis: 'b'.repeat(100), depends_on: ['target'], checked: '2026-11-18'});
    let next = null;
    const turn = scriptedTurn({planner: ({prompt, item}) => {
      if (item !== 'target') return json(planFor(prompt));
      const line = prompt.split('\n').find(l => l.includes('source: status:target#relations') && l.includes('PARTIAL'));
      const m = line ? /\| next: (\{.*\})$/.exec(line) : null;
      if (m && !next) { next = JSON.parse(m[1]); return json({requests: [next]}); }
      return json(planFor(prompt));
    }});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS, only: 'target'});
    assert.equal(next?.op, 'dossier');
    const p = plans(openWorkLedger({root: f.workRoot}), 'target')[0];
    const asked = p.outputs.context.investigations.filter(x => x.role === 'planner').flatMap(x => x.requests).find(r => r.request?.op === 'dossier');
    assert.equal(asked?.ok, true, JSON.stringify(asked));
    assert.equal(asked.source, 'status:target#relations');
    assert.equal(p.outputs.context.unresolved.find(u => u.source === 'status:target#relations'), undefined, 'the gap is closed by the continuation');
  });
});

// ---- L-104 -----------------------------------------------------------------------------------------------------------
test(`${SA}, Q3: under fit, a resumed plan version without work_units is not approved; it is revised to carry them`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'units'}]);
    let down = true, units = false;
    const turn = scriptedTurn({
      planner: ({prompt}) => { const p = planFor(prompt); if (!units) delete p.work_units; return json(p); },
      'plan-review': ({vendor}) => { if (down && vendor === 'xai') throw new Error('xai unavailable'); return APPROVE; },
    });
    let t = Date.parse('2026-11-19T00:00:00Z');
    const L = {...LIMITS, retry_after_ms: 60_000};
    const argo = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'argo', independence: 'lab'});
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {plan: argo.plan}, limits: L, clock: () => t})), ['plan:pending']);
    down = false; units = true; t += 120_000;
    const fit = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, profile: 'fit', independence: 'lab'});
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {plan: fit.plan}, limits: L, clock: () => t})), ['plan:passed']);
    const p = plans(openWorkLedger({root: f.workRoot}), 'units').at(-1);
    assert.ok(Array.isArray(p.outputs.plan.work_units) && p.outputs.plan.work_units.length, 'approved only with work units');
    assert.equal(p.outputs.versions.length, 2, 'the resumed version was reviewed, then revised in its own cycle');
    assert.ok(p.outputs.plan.answers.some(a => a.finding === 'controller-work-units'), 'the revision answers the controller\'s finding');
  });
});

test(`${SA}, Q5/Q7: a plan blocked on evidence is not re-planned by its own work-ledger record, whatever the dossier budget`, async () => {
  for (const basis of ['the requirement: alpha.mjs exports ok = true', 'the requirement: alpha.mjs exports ok = true. ' + 'Context paragraph. '.repeat(3747)]) {
    await withDispatch(async ctx => {
      const repo = ctx.dir;
      const f = fixture(repo, [{item: 'target', basis}]);
      const turn = scriptedTurn({planner: () => json({insufficient: {gaps: ['the cause is not visible'], needed: ['a trace']}})});
      const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
      const r = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
      assert.deepEqual(stagesOf(r), ['plan:blocked'], `basis of ${basis.length} chars`);
      assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1);
      // New evidence does wake it (the stable digest moves for evidence, not for the record).
      fs.writeFileSync(path.join(repo, 'trace.md'), 'alpha.mjs is imported by verify.mjs only\n');
      git(repo, 'add', 'trace.md'); git(repo, 'commit', '-qm', 'a trace');
      assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS})), ['plan:blocked']);
      assert.equal(turn.log.filter(l => l.kind === 'planner').length, 2);
    });
  }
});

test(`${SA}, Q5: a file the validator relied on changes; the validation is not reused, it runs again`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    fs.writeFileSync(path.join(repo, 'consumer-contract.md'), 'Importers of alpha.mjs require ok to be a boolean.\n');
    const f = fixture(repo, [{item: 'val-ev'}]);
    const turn = scriptedTurn({validator: ({prompt}) => (prompt.includes('## Retrieved')
      ? json({...JSON.parse(/```json\n([\s\S]*)\n```/.exec(ACCEPT)[1]), sources: ['consumer-contract.md']})
      : json({requests: [{op: 'file', path: 'consumer-contract.md'}]}))});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const four = {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate};
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: four, limits: LIMITS})), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const val = w.stages('val-ev').find(s => s.stage === 'validate');
    const src = val.outputs.sources.find(s => s.ref === 'file:consumer-contract.md');
    assert.equal(src.version, sha(fs.readFileSync(path.join(repo, 'consumer-contract.md'))), 'bound to the bytes it was given');
    assert.equal(gateOf(f, repo, w, 'val-ev').gate, 'outcome');
    fs.writeFileSync(path.join(repo, 'consumer-contract.md'), 'Importers of alpha.mjs now require ok to be the string "yes".\n');
    const g = gateOf(f, repo, w, 'val-ev');
    assert.equal(g.gate, 'validate');
    assert.match(JSON.stringify(g.stale), /evidence consumer-contract\.md changed/);
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: four, limits: LIMITS})), ['validate:passed'], 'validated again, on the present contract');
    assert.equal(turn.log.filter(l => l.kind === 'validator').length, 4);
    assert.equal(gateOf(f, repo, w, 'val-ev').gate, 'outcome');
  });
});

test(`${SA}, Q2: the ledger keeps the ticket identity across a handoff; a record naming another ticket is refused`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-ticket-id-'));
  try {
    const w = openWorkLedger({root: path.join(root, 'work')});
    const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1};
    const req = 'sha256:' + 'a'.repeat(64);
    const identity = {item: 'x', requirement: req, ticket: {path: 'tickets/x.json', digest: 'sha256:' + 'b'.repeat(64)}};
    const c1 = w.claim({item: 'x', stage: 'plan', attempt: 1, inputs: {}, holder: 'h', budget});
    const plan = w.recordStage({claim: c1, stage: 'plan', attempt: 1, status: 'passed', identity, inputs: {}, outputs: {p: 1}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null});
    w.release({claim: c1, item: 'x', stage: 'plan', outcome: 'completed', why: 'ok'});
    const inputs = {upstream: outputsDigest({p: 1})};
    const c2 = w.claim({item: 'x', stage: 'implement', attempt: 1, inputs, holder: 'h', budget});
    // test-lint: allow scripted-terminal-status -- the implement records offered to the ledger, the INPUT: the test asserts recordStage refuses the two that name another ticket and verifies the one that keeps it
    const rec = id => ({claim: c2, from: plan, stage: 'implement', attempt: 1, status: 'passed', identity: id, inputs, outputs: {i: 1}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: null});
    assert.throws(() => w.recordStage(rec({...identity, ticket: {path: 'tickets/x.json', digest: 'sha256:' + 'c'.repeat(64)}})), /keeps the ticket identity/);
    assert.throws(() => w.recordStage(rec({item: 'x', requirement: req})), /keeps the ticket identity/);
    const impl = w.recordStage(rec(identity));
    assert.equal(w.verify().ok, true);
    assert.equal(handoffRefusal(w, {item: 'x', stage: 'review', from: impl, requirement: req}), null);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test(`${SA}, Q10: an awaiting-owner outcome is re-checked on reuse; a proposal that changed is produced again`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'oc'}]);
    const turn = scriptedTurn();
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: ex, limits: LIMITS})), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    const w = openWorkLedger({root: f.workRoot});
    const o = w.stages('oc').at(-1);
    assert.equal(gateOf(f, repo, w, 'oc').gate, 'awaiting-owner');
    fs.writeFileSync(o.outputs.proposal_path, fs.readFileSync(o.outputs.proposal_path, 'utf8').replace('"Resolved"', '"Ready"'));
    const g = gateOf(f, repo, w, 'oc');
    assert.equal(g.gate, 'outcome');
    assert.match(JSON.stringify(g.stale), /the proposal file changed/);
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: ex, limits: LIMITS})), ['outcome:passed']);
    assert.equal(gateOf(f, repo, w, 'oc').gate, 'awaiting-owner');
  });
});

test(`${SA}, Q2: a revision returned to planning revises the plan its chain rests on, not merely the newest passed plan`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'rev'}]);
    const turn = scriptedTurn();
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    const v0 = fs.readFileSync(path.join(repo, 'verify.mjs'), 'utf8');
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    fs.writeFileSync(path.join(repo, 'verify.mjs'), v0 + '// v1\n');
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const [p1, p2] = plans(w, 'rev');
    assert.ok(p1 && p2 && p2.status === 'passed');
    fs.writeFileSync(path.join(repo, 'verify.mjs'), v0);   // p2 is stale again, p1 valid: the chain rests on p1
    let returned = false;
    // test-lint: allow scripted-terminal-status -- the stub implement, the INPUT that returns the work to planning once: the test asserts which plan the revision revises (p3 of p1), not this stage's status
    const implement = async () => { if (returned) return {status: 'passed', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'review', why: 'ok'}};
      returned = true;
      return {status: 'returned', outputs: {}, team: [], contributions: [], findings: [{id: 'f1', severity: 'block', text: 'the plan misses a case'}], usage: {provider_calls: 0}, next: {stage: 'plan', why: 'the plan misses a case'}}; };
    await tick({repo, ...f, executors: {plan: ex.plan, implement}, limits: LIMITS});
    const p3 = plans(w, 'rev').at(-1);
    assert.equal(p3.inputs.mode, 'revise');
    assert.equal(p3.outputs.plan.version.previous, p1.outputs.plan_digest, 'the revision is of p1');
  });
});

test(`${SA}, Q1: an implement stage pending on review capacity is dispatched again when the reviewer pool grows (the later-stage wake), not before`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'later'}]);
    const turn = scriptedTurn();
    // The four configured labs under the lab rule: the change the implement stage would make (its predicted contributors
    // with the planner's) leaves no three review labs -- a recorded capacity pending before any work (see SYNTH).
    const four = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17'});
    const r1 = await tick({repo, ...f, executors: {plan: four.plan, implement: four.implement}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:pending']);
    const w = openWorkLedger({root: f.workRoot});
    const pending = w.stages('later').at(-1);
    assert.equal(pending.blocker.code, 'REVIEW_CAPACITY_PENDING');
    assert.equal(pending.usage.provider_calls, 0, 'nothing was launched');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {implement: four.implement}, limits: LIMITS})), [], 'the same pool is not re-asked');
    const six = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r3 = await tick({repo, ...f, executors: {implement: six.implement}, limits: LIMITS});
    assert.deepEqual(stagesOf(r3), ['implement:passed']);
    const passed = w.stages('later').filter(s => s.stage === 'implement').at(-1);
    assert.equal(passed.handoff.from, pending.handoff.from, 'the same approved plan is implemented');
    assert.notEqual(passed.inputs.route, pending.inputs.route, 'a wake is a new attempt identity');
  });
});

test(`${SA}, Q1: a change review pending on capacity is dispatched again when the reviewer pool grows (the later-stage wake through review), not before`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'rev-cap'}]);
    const turn = scriptedTurn();
    const six = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    // The four configured labs for the review only: the planner's and the implementers' labs contributed, so no three
    // review labs are left (see SYNTH in test-fixtures.mjs).
    const four = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17'});
    const r1 = await tick({repo, ...f, executors: {plan: six.plan, implement: six.implement, review: four.review}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:pending']);
    const w = openWorkLedger({root: f.workRoot});
    const pending = w.stages('rev-cap').at(-1);
    assert.equal(pending.blocker.code, 'REVIEW_CAPACITY_PENDING');
    assert.equal(pending.blocker.capacity, four.review.capacity(), 'the pool it was judged on is recorded');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {review: four.review}, limits: LIMITS})), [], 'the same pool is not re-asked');
    const r3 = await tick({repo, ...f, executors: {review: six.review}, limits: LIMITS});
    assert.deepEqual(stagesOf(r3), ['review:passed']);
    const passed = w.stages('rev-cap').at(-1);
    assert.equal(passed.handoff.from, pending.handoff.from, 'the same implementation is reviewed');
    assert.notEqual(passed.inputs.route, pending.inputs.route, 'a wake is a new attempt identity');
  });
});

test(`${SA}, Q1: a validation pending on capacity (no eligible validator) is dispatched again when the reviewer pool grows (the later-stage wake through validate), not before`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'val-cap'}]);
    const turn = scriptedTurn();
    const six = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const r1 = await tick({repo, ...f, executors: {plan: six.plan, implement: six.implement, review: six.review}, limits: LIMITS});
    assert.deepEqual(stagesOf(r1), ['plan:passed', 'implement:passed', 'review:passed']);
    const w = openWorkLedger({root: f.workRoot});
    // A pool whose every seat, in every role's table (the validator is sought in all of them), is of a lab that
    // contributed to the work: no validator is eligible.
    const contributed = new Set((w.stages('val-cap').find(s => s.stage === 'implement').outputs.contributions ?? []).map(c => c.lab).filter(Boolean));
    const shortSeating = Object.fromEntries(Object.entries(SIX.seating).map(([role, rows]) => [role, Array.isArray(rows) ? rows.filter(r => contributed.has(labOf(r.vendor, r.model))) : rows]));
    const short = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', seating: shortSeating, facts: SIX.facts});
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {validate: short.validate}, limits: LIMITS})), ['validate:pending']);
    const pending = w.stages('val-cap').at(-1);
    assert.equal(pending.blocker.code, 'REVIEW_CAPACITY_PENDING');
    assert.match(pending.blocker.what, /no eligible validator/);
    assert.equal(turn.log.filter(l => l.kind === 'validator').length, 0, 'no validator was asked');
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: {validate: short.validate}, limits: LIMITS})), [], 'the same pool is not re-asked');
    const r3 = await tick({repo, ...f, executors: {validate: six.validate}, limits: LIMITS});
    assert.deepEqual(stagesOf(r3), ['validate:passed']);
    const passed = w.stages('val-cap').at(-1);
    assert.equal(passed.handoff.from, pending.handoff.from, 'the same review is validated');
    assert.notEqual(passed.inputs.route, pending.inputs.route, 'a wake is a new attempt identity');
  });
});
