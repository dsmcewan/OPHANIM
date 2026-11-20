// THE SELF-REPAIR LANE (ophanim/operate/self-repair.mjs; docs/self-repair.md), through the real scheduler, reconciliation,
// work ledger and git, over fixture repositories with FRESH SYNTHETIC owner keys and scripted stage executors (no provider,
// no network). Each test names the decision it pins (SR-D<n>, the brief's decisions; SR-AM, the owner's amendment of
// 2026-11-20: no binding, no max_open, no backoff, no lane budget; overlapping paths never at once; re-validation on a
// moved base). The mutation runner ophanim/operate/self-repair.mutate.mjs proves each can fail.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {planRefusal} from './stages.mjs';
import {main as cli} from './cli.mjs';
import {CANDIDATE_SCHEMA} from './graph-loop.mjs';
import {detect, select, readRecords, writeRecord, laneConfig, isProtected, bisectLanded, landingRefusal, laneProposal, roundsOf, LANE_ITEM, DEFAULT_CONFIG, RANK}
  from './self-repair.mjs';
import {laneRepo, gateRecord, scriptedRound, addsPlan, commitOn, CALC_OK, LIMITS, REG, g} from './fixtures/self-repair-fixture.mjs';

const LINE = DEFAULT_CONFIG.line;
const run = (f, executors, extra = {}) => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: LIMITS, ...extra});
const refs = f => g(f.repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort();
const events = f => openWorkLedger({root: f.workRoot}).repairs();
const stagesOf = r => r.dispatched.map(d => `${d.item} ${d.stage}:${d.status}`);
const WAIT = {status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'plan', why: 'a scripted transient wait'},
  blocker: {code: 'SCRIPTED_WAIT', what: 'a scripted transient wait (a reviewer seat is busy)', role: 'lead@orch', resume_when: 'the retry is due', transient: true}};
const STRINGS_TEST = "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {trim} from '../lib/strings.mjs';\ntest('trims', () => { assert.equal(trim('  x '), 'x'); });\n";
const stringsPlan = ctx => ({repair: {defect: ctx.selfRepair.defect.id, root_cause: 'trim returns its input instead of removing the surrounding whitespace',
  reproduction: {kind: 'test', file: 'test/strings.test.mjs', name: 'trims', source: STRINGS_TEST}}, slices: [{id: 's1', title: 'fix trim', slot: 'strings', path: 'lib/strings.mjs'}]});
const STRINGS_FIX = {'lib/strings.mjs': 'export const trim = s => s.trim();\n', 'test/strings.test.mjs': STRINGS_TEST};

test('SR-D1 dormant: without the owner-signed self-repair item In progress, tick and reconcile are as before, nothing is recorded, nothing lands', async t => {
  for (const lane of [null, 'Ready', 'Resolved']) {
    const f = laneRepo(t, {lane});
    gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
    const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({'lib/calc.mjs': CALC_OK})});
    const r = await run(f, ex);
    assert.deepEqual(r.dispatched, [], `${lane}: nothing is dispatched`);
    assert.deepEqual(events(f), [], `${lane}: the lane records nothing`);
    assert.deepEqual(refs(f), ['refs/heads/main'], `${lane}: no ref is written`);
    assert.deepEqual(ex.calls, [], `${lane}: no stage executor is called`);
    const rec = reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})});
    assert.ok(!rec.items.some(i => /^self-repair\.r/.test(i.item)), 'no round is an item');
    if (lane === null) assert.equal(r.self_repair, undefined, 'without the item the tick reports exactly what it reported before');
    else {
      assert.equal(r.self_repair.state, 'dormant');
      assert.match(r.self_repair.why, new RegExp(`is ${lane}, not In progress`));
      assert.equal(rec.items.find(i => i.item === LANE_ITEM).gate.gate, 'lane', 'the switch item itself is never planned or dispatched');
    }
  }
});

test('SR-D2 rounds: one new round per tick, any number open (no max_open), each its own work identity under the lane', async t => {
  const f = laneRepo(t, {register: [REG.strings]});
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({}), onPlan: () => WAIT});
  const r1 = await run(f, ex), r2 = await run(f, ex), r3 = await run(f, ex);
  assert.equal(r1.self_repair.opened.item, 'self-repair.r1');
  assert.equal(r1.self_repair.opened.defect, 'test:test/calc.test.mjs::adds', 'the regression ranks first');
  assert.equal(r2.self_repair.opened.item, 'self-repair.r2', 'the next tick opens the next round while round 1 is still open');
  assert.equal(r2.self_repair.opened.defect, 'register:KG-90');
  assert.equal(r3.self_repair.opened, null, 'nothing else is eligible: both defects have an open round');
  const opens = events(f).filter(e => e.event === 'open');
  assert.deepEqual(opens.map(e => e.round), [1, 2], 'one open per tick, at most');
  const rec = reconcile({repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})});
  assert.deepEqual(rec.items.filter(i => /^self-repair\.r/.test(i.item)).map(i => [i.item, i.status]), [['self-repair.r1', 'In progress'], ['self-repair.r2', 'In progress']]);
  // SR-D11: the open event carries the selection's evidence and the routing of every other defect.
  assert.equal(opens[0].evidence.defect.source, 'gate');
  assert.deepEqual(opens[0].queue, ['register:KG-90']);
  assert.equal(opens[1].skipped.find(s => s.id === 'test:test/calc.test.mjs::adds').route, 'deduped');
  // SR-D10 (amended): the rounds' claims are budgeted by the tick's own limits, no lane-specific cap.
  const claims = openWorkLedger({root: f.workRoot}).claims('self-repair.r1');
  assert.ok(claims.length >= 1 && claims.every(c => c.budget.provider_calls === LIMITS.stage_provider_calls && c.reserve.total_provider_calls === LIMITS.total_provider_calls));
  // SR-AM: every claim of a round carries the round's paths (the work ledger's path fence reads them).
  assert.deepEqual(claims.map(c => c.paths), claims.map(() => ['test/calc.test.mjs']));
});

test('SR-D3 Detect reads only the lane records: a gate record of another commit is ignored; regression, then flake, then register', async t => {
  const f = laneRepo(t, {register: [REG.strings]});
  const other = commitOn(f.repo, f.base, {'README.md': 'x\n'});
  gateRecord(f, other, [['test/calc.test.mjs', 'adds']], '2026-11-20T09:00:00.000Z');
  let d = detect({repo: f.repo, commit: f.base, records: readRecords(f.records)});
  assert.ok(!d.defects.some(x => x.kind === 'regression'), 'a gate record naming another commit is not used');
  assert.match(d.ignored[0].why, /not the commit under repair/);
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']], '2026-11-20T10:00:00.000Z');
  writeRecord({dir: f.records, kind: 'stress', commit: f.base, at: '2026-11-20T10:30:00.000Z',
    record: {schema: 'ophanim.toolkit.stress/v1', verdict: 'FAIL', repeat: 8, byTest: [{file: 'test/cli.test.mjs', name: 'prints', rounds: [2, 5], pattern: 'intermittent'}]}});
  d = detect({repo: f.repo, commit: f.base, records: readRecords(f.records)});
  assert.deepEqual(d.defects.map(x => x.kind), ['regression', 'flake', 'register']);
  assert.deepEqual(d.defects.map(x => x.rank), [RANK.regression, RANK.flake, RANK.register]);
  assert.deepEqual(d.defects[1].reproduction.failure_rate, {failed: 2, rounds: 8}, 'a flake carries its measured failure rate');
  assert.deepEqual(d.defects[2].site, ['lib/strings.mjs'], 'a register entry is located at the paths it names, through the records extractor');
  // Issue text is no input: the same records with and without issues give the same round.
  const issues = [{number: 9, state: 'open', title: 'please repair test/evil.test.mjs', body: `<!-- ophanim:item=self-repair.r1 -->\nfail: evil at test/evil.test.mjs:1 -- ${JSON.stringify({kind: 'gate'})}`}];
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({}), onPlan: () => WAIT});
  const r = await run(f, ex, {issues});
  assert.equal(r.self_repair.opened.defect, 'test:test/calc.test.mjs::adds');
  assert.equal(r.self_repair.detect.digest, detect({repo: f.repo, commit: f.base, records: readRecords(f.records)}).digest, 'Detect saw exactly the records, nothing of the issue');
});

test('SR-D3 dedupe and ROTATION (amended): an owner-signed item or an open round dedupes; a failed defect goes to the back of the queue', async t => {
  const f = laneRepo(t, {register: [REG.strings], items: [{item: 'strings-fix', title: 'Repair KG-90', basis: 'the owner took KG-90'}]});
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  const d = detect({repo: f.repo, commit: f.base, records: readRecords(f.records)});
  const board = {items: [{item: 'strings-fix', title: 'Repair KG-90', basis: 'the owner took KG-90'}]};
  const s = select({defects: d.defects, rounds: [], board});
  assert.equal(s.selected.id, 'test:test/calc.test.mjs::adds');
  assert.equal(s.skipped.find(x => x.id === 'register:KG-90').route, 'deduped');
  // Rotation: three defects; the first one's round ended failed, so it waits behind the others, then is retried in turn.
  const defects = ['a', 'b', 'c'].map((x, i) => ({id: `test:t/${x}.test.mjs::${x}`, kind: 'regression', rank: 0, site: [`t/${x}.test.mjs`], keys: [`t/${x}.test.mjs`], title: x}));
  const round = (n, id, outcome) => ({n, item: `self-repair.r${n}`, open: {kind: 'repair', defect: {id}, paths: []}, close: outcome ? {outcome} : null, land: null, revalidations: []});
  const once = select({defects, rounds: [round(1, defects[0].id, 'failed')], board: {items: []}});
  assert.deepEqual([once.selected.id, ...once.queue.map(q => q.id)], [defects[1].id, defects[2].id, defects[0].id]);
  const twice = select({defects, rounds: [round(1, defects[0].id, 'failed'), round(2, defects[1].id, 'blocked')], board: {items: []}});
  assert.deepEqual([twice.selected.id, ...twice.queue.map(q => q.id)], [defects[2].id, defects[0].id, defects[1].id], 'the longest-waiting attempted defect comes back first');
});

test('SR-D3 and SR-D9 a defect on a protected surface is never selected: it becomes an unsigned owner candidate, once', async t => {
  const f = laneRepo(t, {register: [REG.pentest, REG.owner, REG.nowhere]});
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({})});
  const r = await run(f, ex);
  await run(f, ex);
  assert.equal(r.self_repair.opened, null, 'nothing is selected');
  const routes = events(f).filter(e => e.event === 'route');
  assert.deepEqual(routes.map(e => e.defect.id), ['register:KG-91'], 'routed once, though two ticks saw it');
  assert.match(routes[0].why, /PROTECTED: its subject scripts\/pentest\/run\.mjs/);
  const cand = JSON.parse(fs.readFileSync(path.join(f.stateDir, routes[0].candidate), 'utf8'));
  assert.equal(cand.schema, CANDIDATE_SCHEMA);
  assert.equal(cand.executable, false);
  assert.match(cand.authority, /never executed/);
  const s = select({defects: detect({repo: f.repo, commit: f.base, records: readRecords(f.records)}).defects, rounds: [], board: {items: []}});
  assert.deepEqual(s.skipped.map(x => [x.id, x.route]), [['register:KG-91', 'owner'], ['register:KG-92', 'owner-decision'], ['register:KG-93', 'unlocated']]);
});

test('SR-D4 DIAGNOSE: a plan whose reproduction does not fail on the base, or that names none, is not accepted', async t => {
  const f = laneRepo(t);
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  const muls = ctx => ({...addsPlan(ctx), repair: {...addsPlan(ctx).repair, reproduction: {kind: 'test', file: 'test/calc.test.mjs', name: 'muls'}}});
  const ex = scriptedRound(f, {plan: muls, fix: () => ({'lib/calc.mjs': CALC_OK})});
  await run(f, ex);
  const w = openWorkLedger({root: f.workRoot});
  const plan = w.stages('self-repair.r1').find(s => s.stage === 'plan');
  assert.equal(plan.outputs.self_repair.accepted, false);
  assert.equal(plan.outputs.self_repair.refusals[0].code, 'REPRODUCTION_DOES_NOT_FAIL');
  assert.ok(!ex.calls.some(([s]) => s === 'implement'), 'nothing is implemented on a plan without a failing reproduction');
  const g2 = laneRepo(t);
  gateRecord(g2, g2.base, [['test/calc.test.mjs', 'adds']]);
  const bare = scriptedRound(g2, {plan: () => ({slices: [{path: 'lib/calc.mjs'}]}), fix: () => ({})});
  await run(g2, bare);
  const p2 = openWorkLedger({root: g2.workRoot}).stages('self-repair.r1').find(s => s.stage === 'plan');
  assert.equal(p2.outputs.self_repair.refusals[0].code, 'REPRODUCTION_SHAPE');
  // The real plan stage checks the same shape (stages.mjs planRefusal, `repair`).
  const defect = {id: 'test:test/calc.test.mjs::adds'};
  assert.ok(planRefusal({}, {repair: defect}).some(w => /self-repair round's plan states repair/.test(w)));
  assert.ok(planRefusal({repair: {defect: defect.id, root_cause: 'add subtracts its second argument', reproduction: {kind: 'test', file: 'test/calc.test.mjs'}}}, {repair: defect}).every(w => !/repair/.test(w)));
  assert.deepEqual(planRefusal({}, {}).filter(w => /repair/.test(w)), [], 'an ordinary item\'s plan is not asked for one');
});

test('SR-D5 SR-D6 a repair the mechanical checks refuse is returned to implement and never lands', async t => {
  const f = laneRepo(t);
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  // The "fix" weakens the test instead: the reproduction passes, the assertion is gone.
  const cheat = {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': fs.readFileSync(path.join(f.repo, 'test/calc.test.mjs'), 'utf8').replace('assert.equal(mul(X, X), X * X);', 'assert.ok(true);')};
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => cheat});
  const r = await run(f, ex);
  const val = openWorkLedger({root: f.workRoot}).stages('self-repair.r1').find(s => s.stage === 'validate');
  assert.equal(val.status, 'returned');
  assert.equal(val.next.stage, 'implement');
  assert.deepEqual(val.outputs.self_repair.refusals.map(x => x.code), ['ASSERTION_REMOVED']);
  assert.ok(!ex.calls.some(([s]) => s === 'validate'), 'the validator is never asked about a refused repair');
  assert.deepEqual(r.self_repair.landed, []);
  assert.deepEqual(refs(f).filter(x => x === LINE).map(x => g(f.repo, 'rev-parse', x)), [f.base], 'the line stays at its start');
});

test('SR-D7 landing: ONE commit on the line, a fast-forward, the revert recorded, on no other ref', async t => {
  const f = laneRepo(t);
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  const r = await run(f, scriptedRound(f, {plan: addsPlan, fix: () => ({'lib/calc.mjs': CALC_OK})}));
  const land = events(f).find(e => e.event === 'land');
  assert.equal(g(f.repo, 'rev-parse', LINE), land.commit);
  assert.equal(land.parent, f.base);
  assert.equal(g(f.repo, 'rev-parse', `${land.commit}^`), f.base, 'one commit on the base');
  assert.equal(land.revert, `git revert --no-edit ${land.commit}`);
  assert.equal(g(f.repo, 'rev-parse', 'refs/heads/main'), f.base, 'the owner\'s branch is untouched');
  assert.deepEqual(refs(f), ['refs/heads/main', LINE, 'refs/heads/pantheon/self-repair.r1'], 'the line, and the implement stage\'s own work branch');
  assert.deepEqual(r.self_repair.closed.map(c => [c.round, c.outcome]), [[1, 'landed']]);
  assert.equal(landingRefusal({ref: 'refs/heads/main'}), `LANDING_REF: a repair lands only on the line ${LINE}, never on refs/heads/main`);
  // The work ledger refuses a second landing of the round, a landing on another line, and one that is no fast-forward.
  const w = openWorkLedger({root: f.workRoot});
  const other = commitOn(f.repo, f.base, {'README.md': 'x\n'});
  assert.throws(() => w.recordRepair({event: 'land', round: 1, line: LINE, commit: other, parent: f.base, revert: `git revert --no-edit ${other}`}), /closed|already landed/);
  // The unsigned outcome proposal of a round (stages.mjs outcome): names the lane, signs nothing.
  const lp = laneProposal({bundle: {item: 'self-repair.r1', commit: land.commit, base: f.base, run: {shipped: true}}, round: {lane_entry: 'sha256:x'}});
  assert.equal(lp.signed, false);
  assert.equal(lp.revert, land.revert);
});

test('SR-AM a round whose base moved because another round landed first is RE-VALIDATED on the new line head before it lands', async t => {
  const f = laneRepo(t, {register: [REG.strings]});
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  let now = Date.parse('2026-11-20T12:00:00.000Z');
  const clock = () => now;
  let waited = false;
  const ex = scriptedRound(f, {
    plan: ctx => (ctx.selfRepair.defect.id === 'register:KG-90' ? stringsPlan(ctx) : addsPlan(ctx)),
    fix: ctx => (ctx.selfRepair.defect.id === 'register:KG-90' ? STRINGS_FIX : {'lib/calc.mjs': CALC_OK}),
    onPlan: ctx => (ctx.item === 'self-repair.r1' && !waited ? (waited = true, WAIT) : null)});
  const t1 = await run(f, ex, {clock});
  assert.equal(t1.self_repair.opened.item, 'self-repair.r1');
  now += 60_000;
  const t2 = await run(f, ex, {clock});
  assert.equal(t2.self_repair.opened.item, 'self-repair.r2', 'round 2 opens while round 1 waits');
  assert.deepEqual(t2.self_repair.landed.map(l => l.round), [2], 'round 2 lands first');
  const mid = g(f.repo, 'rev-parse', LINE);
  now += 20 * 60_000;
  const t3 = await run(f, ex, {clock});
  assert.deepEqual(t3.self_repair.revalidated.map(x => [x.round, x.ok]), [[1, true]], 'round 1 is re-validated on the moved head');
  const rv = events(f).find(e => e.event === 'revalidate' && e.round === 1);
  assert.equal(rv.parent, mid);
  const land = events(f).find(e => e.event === 'land' && e.round === 1);
  assert.equal(land.commit, rv.commit, 'what lands is exactly the re-validated commit');
  assert.equal(land.parent, mid, 'still a fast-forward: one commit on the moved head');
  assert.notEqual(land.commit, openWorkLedger({root: f.workRoot}).stages('self-repair.r1').find(s => s.stage === 'implement').outputs.commit, 'the reviewed patch, re-applied');
  assert.equal(g(f.repo, 'rev-parse', `${LINE}^`), mid);
});

test('SR-AM two rounds never claim overlapping paths at once: Detect waits, the ledger refuses the open and the claim', async t => {
  const f = laneRepo(t, {register: []});
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds'], ['test/calc.test.mjs', 'muls']]);
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({}), onPlan: () => WAIT});
  await run(f, ex);
  const r2 = await run(f, ex);
  assert.equal(r2.self_repair.opened, null);
  const d = select({defects: detect({repo: f.repo, commit: f.base, records: readRecords(f.records)}).defects, rounds: roundsOf(openWorkLedger({root: f.workRoot})), board: {items: []}});
  assert.equal(d.skipped.find(s => s.id === 'test:test/calc.test.mjs::muls').route, 'waiting');
  const w = openWorkLedger({root: f.workRoot});
  assert.throws(() => w.recordRepair({event: 'open', round: 2, kind: 'repair', defect: {id: 'x'}, paths: ['test/*.mjs'], base: f.base, line: LINE}), /PATHS_CLAIMED/);
  const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1};
  w.claim({item: 'self-repair.r9', stage: 'plan', attempt: 1, inputs: {a: 1}, holder: 'x', budget, paths: ['lib/calc.mjs']});
  assert.throws(() => w.claim({item: 'self-repair.r8', stage: 'plan', attempt: 1, inputs: {a: 2}, holder: 'x', budget, paths: ['lib/**']}), e => e.code === 'PATHS_CLAIMED');
  assert.ok(w.claim({item: 'self-repair.r7', stage: 'plan', attempt: 1, inputs: {a: 3}, holder: 'x', budget, paths: ['test/other.test.mjs']}), 'disjoint paths run at once');
});

test('SR-D8 the rollback bisect is bounded to the landed repairs: the earliest landing that fails where its parent passes', async () => {
  const landings = [{round: 1, commit: 'c1', parent: 'c0'}, {round: 2, commit: 'c2', parent: 'c1'}, {round: 3, commit: 'c3', parent: 'c2'}, {round: 4, commit: 'c4', parent: 'c3'}];
  const failing = new Set(['c2', 'c3', 'c4']);
  const b = await bisectLanded({landings, fails: async c => failing.has(c)});
  assert.equal(b.culprit.round, 2);
  assert.equal(b.fails_at, 'c2');
  assert.equal(b.passes_at, 'c1');
  assert.ok(b.runs.length <= 4, 'a bisect, not a scan');
  assert.equal((await bisectLanded({landings, fails: async () => true})).culprit, null, 'a failure before the first landing is no landed repair\'s');
  assert.equal((await bisectLanded({landings, fails: async c => c === 'c9'})).culprit, null);
});

test('SR-D9 the protected surfaces may only be added to', () => {
  assert.throws(() => laneConfig({protected: []}), /only be added to/);
  const c = laneConfig({protected_extra: ['lib/secret.mjs']});
  assert.ok(isProtected('lib/secret.mjs', c));
  for (const p of ['packages/ledger/status.mjs', 'scripts/pentest/run.mjs', 'ophanim/operate/pentest/d-authorization.test.mjs', 'x/y.mutate.mjs', 'package.json', 'ophanim/operate/self-repair.mjs',
    'pantheon/src/route/frontier.mjs', 'docs/OPEN-LIMITATIONS.md', 'PACKAGES/LEDGER/x.mjs']) assert.ok(isProtected(p, c), `${p} is protected`);
  assert.equal(isProtected('ophanim/operate/reliability-r2-a3.test.mjs', c), false);
  assert.throws(() => laneConfig({line: 'refs/tags/x'}), /branch ref/);
});

test('SR-CLI the view is a dry run: the lane state, what the next round would select, what it routes to the owner; nothing written', async t => {
  const f = laneRepo(t, {lane: null, register: [REG.strings, REG.pentest]});
  const out = [];
  const code = await cli(['self-repair', '--json', '--repo', f.repo], {log: s => out.push(s), err: () => {}});
  assert.equal(code, 0);
  const v = JSON.parse(out[0]);
  assert.equal(v.lane.on, false);
  assert.equal(v.next.id, 'register:KG-90');
  assert.deepEqual(v.owner.map(o => o.id), ['register:KG-91']);
  assert.equal(v.written, 'nothing');
  assert.ok(!fs.existsSync(f.workRoot), 'no work ledger is created');
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'self-repair')), 'no candidate or record is written');
  assert.deepEqual(refs(f), ['refs/heads/main']);
  const rec = path.join(f.d, 'gate.json');
  fs.writeFileSync(rec, JSON.stringify({schema: 'ophanim.test-gate/v2', results: []}));
  assert.equal(await cli(['self-repair', 'record', '--kind', 'gate', '--commit', f.base, '--file', rec, '--repo', f.repo], {log: () => {}, err: () => {}}), 0);
  assert.equal(readRecords(f.records).gate[0].commit, f.base);
});

test('SR-DEMO a planted defect with a failing test in a gate record: one tick opens round 1, which lands on the line; a regression it planted is rolled back by a later round', async t => {
  const f = laneRepo(t, {register: []});
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']], '2026-11-20T10:00:00.000Z');
  // The repair fixes add -- and plants a regression T1 cannot see (test/cli.test.mjs runs the CLI as a separate process).
  const planted = CALC_OK.replace("sep = ','", "sep = ';'");
  const ex = scriptedRound(f, {plan: addsPlan, fix: () => ({'lib/calc.mjs': planted})});
  const t1 = await run(f, ex);
  assert.deepEqual(stagesOf(t1), ['self-repair.r1 plan:passed', 'self-repair.r1 implement:passed', 'self-repair.r1 review:passed', 'self-repair.r1 validate:passed', 'self-repair.r1 outcome:passed']);
  const landed = t1.self_repair.landed[0];
  assert.equal(g(f.repo, 'rev-parse', LINE), landed.commit, 'round 1 landed on the line in the same tick');
  const val = openWorkLedger({root: f.workRoot}).stages('self-repair.r1').find(s => s.stage === 'validate');
  assert.equal(val.outputs.self_repair.ok, true);
  assert.deepEqual(val.outputs.self_repair.runs.map(x => x.check), ['reproduction', 'reach', 'runner', 'pentest', 'lint']);
  // A later gate record, at the line's head, shows the planted regression.
  gateRecord(f, landed.commit, [['test/cli.test.mjs', 'prints']], '2026-11-20T11:00:00.000Z');
  const t2 = await run(f, ex);
  assert.deepEqual(t2.self_repair.rollback, {round: 2, culprit: 1, commit: landed.commit});
  const rb = events(f).filter(e => e.round === 2);
  assert.deepEqual(rb.map(e => e.event), ['open', 'revalidate', 'land', 'close']);
  assert.equal(rb[0].kind, 'rollback');
  assert.deepEqual(rb[0].evidence.bisect.map(x => [x.commit, x.fails]), [[landed.commit, true], [f.base, false]], 'it fails at the landed repair and passes at its parent');
  const head = g(f.repo, 'rev-parse', LINE);
  assert.equal(g(f.repo, 'rev-parse', `${head}^`), landed.commit, 'the rollback is one commit on the line');
  assert.equal(g(f.repo, 'rev-parse', `${head}^{tree}`), g(f.repo, 'rev-parse', `${f.base}^{tree}`), 'the line is back to the tree before the repair');
  assert.equal(rb[3].outcome, 'landed');
  // The reverted defect is the owner's now: routed, and never selected again.
  const route = events(f).find(e => e.event === 'route');
  assert.equal(route.defect.id, 'test:test/calc.test.mjs::adds');
  gateRecord(f, head, [['test/calc.test.mjs', 'adds']], '2026-11-20T12:00:00.000Z');
  const t3 = await run(f, ex);
  assert.equal(t3.self_repair.opened, null);
  assert.equal(g(f.repo, 'rev-parse', 'refs/heads/main'), f.base);
});
