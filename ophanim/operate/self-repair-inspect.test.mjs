// THE RECURSIVE LOOP (owner, 2026-11-20): "If it needs repairs it fixes itself; if not, it does a recursive loop ...
// after it's counted the tickets ... in parallel with the ticket." An idle lane (nothing selectable, no round open)
// inspects itself in the background; a commit is inspected once and one inspection runs at a time; the inspector's
// records feed the next Detect. Fixture repositories with fresh synthetic owner keys; the background process is injected
// (no inspector is spawned here), and runInspection runs with stub commands (no real gates).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from './scheduler.mjs';
import {readRecords, detect, inspectionState, inspectionDirOf, INSPECTION_SCHEMA, DEFAULT_CONFIG} from './self-repair.mjs';
import {runInspection, changedTests, fill} from './self-repair-inspect.mjs';
import {laneRepo, gateRecord, scriptedRound, addsPlan, LIMITS, REG, g} from './fixtures/self-repair-fixture.mjs';

const WAIT = {status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'plan', why: 'a scripted transient wait'}};
const commitFiles = (repo, files, message) => {
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), {recursive: true}); fs.writeFileSync(path.join(repo, f), text); }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', message);
  return g(repo, 'rev-parse', 'HEAD');
};
const GATE_TOOL = {'scripts/test-gates/check.mjs': '// the gate tool (a fixture stand-in)\n'};
/** An idle lane: nothing in the register, no gate record, a commit that carries the gate tool. */
const idleRepo = t => { const f = laneRepo(t, {register: []}); return {...f, head: commitFiles(f.repo, GATE_TOOL, 'the gate tool')}; };
const tickWith = (f, starts, extra = {}) => tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits: LIMITS,
  executors: scriptedRound(f, {plan: addsPlan, fix: () => ({}), onPlan: () => WAIT}),
  selfRepair: {startInspection: plan => { starts.push(plan); return process.pid; }}, ...extra});

test('loop: an idle lane (nothing to repair, no round open) starts a self-inspection of the line head in the background', async t => {
  const f = idleRepo(t), starts = [];
  const r = await tickWith(f, starts);
  assert.equal(r.self_repair.selection.selected, null);
  assert.deepEqual([r.self_repair.inspection.state, r.self_repair.inspection.commit, r.self_repair.inspection.since], ['started', f.head, null]);
  assert.equal(starts.length, 1);
  assert.deepEqual([starts[0].schema, starts[0].commit, starts[0].records, starts[0].since], [INSPECTION_SCHEMA, f.head, f.records, null]);
  assert.deepEqual(starts[0].inspect, DEFAULT_CONFIG.inspect, 'the whole gate run, the stress run and the pentest');
  assert.equal(inspectionState(f.stateDir).running.commit, f.head, 'the running inspection is recorded, so the next tick sees it');
});

test('loop: one inspection at a time -- while one runs, the next tick does not start another', async t => {
  const f = idleRepo(t), starts = [];
  await tickWith(f, starts);
  const r = await tickWith(f, starts);
  assert.equal(r.self_repair.inspection.state, 'running');
  assert.equal(starts.length, 1);
});

test('loop: a commit is inspected once; when the line moves, the next inspection starts, comparing with the last', async t => {
  const f = idleRepo(t), starts = [];
  fs.mkdirSync(inspectionDirOf(f.stateDir), {recursive: true});
  fs.writeFileSync(path.join(inspectionDirOf(f.stateDir), 'last.json'), JSON.stringify({schema: INSPECTION_SCHEMA, commit: f.head, finished_at: '2026-11-20T00:00:00Z', steps: []}));
  const same = await tickWith(f, starts);
  assert.equal(same.self_repair.inspection.state, 'already-inspected');
  assert.equal(starts.length, 0);
  const moved = commitFiles(f.repo, {'lib/more.mjs': 'export const more = 1;\n'}, 'the line moves');
  const next = await tickWith(f, starts);
  assert.deepEqual([next.self_repair.inspection.state, next.self_repair.inspection.commit, next.self_repair.inspection.since], ['started', moved, f.head]);
});

test('loop: when something needs repair the lane repairs it and does not inspect; while a round is open it does not inspect either', async t => {
  const f = idleRepo(t), starts = [];
  gateRecord(f, f.head, [['test/calc.test.mjs', 'adds']]);
  const r1 = await tickWith(f, starts);
  assert.equal(r1.self_repair.opened.defect, 'test:test/calc.test.mjs::adds');
  assert.equal(r1.self_repair.inspection, undefined);
  const r2 = await tickWith(f, starts);
  assert.equal(r2.self_repair.opened, null, 'nothing else is eligible');
  assert.equal(r2.self_repair.inspection, undefined, 'a round is open: the lane is repairing, not idle');
  assert.equal(starts.length, 0);
});

test('loop: the tickets and the lane in one tick -- the owner-signed item is taken in, and the round the lane opens beside it is dispatched in that same tick', async t => {
  const f = laneRepo(t, {register: [REG.strings], items: [{item: 'build-1'}]}), starts = [];
  gateRecord(f, f.base, [['test/calc.test.mjs', 'adds']]);
  const r = await tickWith(f, starts);
  assert.ok(r.intake.includes('status:build-1'), `the ticket is counted: ${JSON.stringify(r.intake)}`);
  assert.equal(r.self_repair.opened.item, 'self-repair.r1', 'and the round the lane opens beside it is dispatched in the same tick');
});

test('inspector: the gate run, the stress run of the changed tests and the pentest each write a record naming the commit; the next Detect reads them', async t => {
  const f = laneRepo(t, {register: []});
  const since = f.base;
  const head = commitFiles(f.repo, {...GATE_TOOL, 'test/calc.test.mjs': fs.readFileSync(path.join(f.repo, 'test/calc.test.mjs'), 'utf8') + '// changed\n'}, 'a changed test');
  const gate = {schema: 'ophanim.test-gate/v2', verdict: 'FAIL', results: [{suite: 'test', verdict: 'FAIL', problems: [], notes: ['fail: adds at test/calc.test.mjs:4 -- testCodeFailure: x']}]};
  const stress = {schema: 'ophanim.toolkit.stress/v1', verdict: 'FAIL', repeat: 2, files: ['test/calc.test.mjs'], byTest: [{file: 'test/calc.test.mjs', name: 'multiplies', rounds: [2], pattern: 'intermittent'}]};
  const writer = body => ['node', '-e', `require('fs').writeFileSync(process.argv[process.argv.length - 1], ${JSON.stringify(JSON.stringify(body))})`];
  const inspect = {gates: [...writer(gate), '{json}'], stress: [...writer(stress), '{files}', '{json}'], pentest: ['node', '-e', 'console.log("=== PENTEST (stub) ===")'], rounds: 2, nice: null, timeout_ms: 60_000};
  const steps = await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: head, since, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  assert.deepEqual(steps.map(s => [s.name, s.exit, Boolean(s.record)]), [['gates', 0, true], ['stress', 0, true], ['pentest', 0, true]], JSON.stringify(steps));
  const recs = readRecords(f.records);
  assert.deepEqual([recs.gate.length, recs.stress.length, recs.pentest.length], [1, 1, 1]);
  assert.ok([...recs.gate, ...recs.stress, ...recs.pentest].every(r => r.commit === head), 'every record names the inspected commit');
  const {running, last} = inspectionState(f.stateDir);
  assert.equal(running, null, 'running.json is removed at the end');
  assert.deepEqual([last.commit, last.since, last.steps.length], [head, since, 3]);
  const d = detect({repo: f.repo, commit: head, records: recs});
  assert.deepEqual(d.defects.map(x => x.kind), ['regression', 'flake'], 'what the inspection found is what the next round repairs (and nothing else: the register is empty)');
});

test('inspector: the first inspection (no earlier commit) skips the stress run; the changed-tests list and the command templates', async t => {
  const f = laneRepo(t, {register: []});
  const head = commitFiles(f.repo, GATE_TOOL, 'the gate tool');
  const inspect = {gates: ['node', '-e', 'process.exit(0)', '{json}'], stress: ['node', '-e', 'process.exit(9)'], pentest: ['node', '-e', 'console.log("ok")'], rounds: 1, nice: null, timeout_ms: 60_000};
  const steps = await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: head, since: null, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  assert.match(steps.find(s => s.name === 'gates').error, /no gate record was written/, 'a gate tool that wrote nothing is reported, not invented');
  assert.match(steps.find(s => s.name === 'stress').skipped, /first inspection/);
  assert.ok(steps.find(s => s.name === 'pentest').record);
  assert.deepEqual(changedTests(f.repo, f.base, head), [], 'only test files are listed');
  assert.deepEqual(fill(['x', '{files}', '--repeat', '{rounds}', '{json}', '{other}'], {files: ['a.test.mjs', 'b.test.mjs'], rounds: 3, json: '/j'}), ['x', 'a.test.mjs', 'b.test.mjs', '--repeat', '3', '/j', '{other}']);
});
