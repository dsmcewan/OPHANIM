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
import {spawnSync, spawn} from 'node:child_process';
import * as lane from './self-repair.mjs';
import {readRecords, detect, inspectionState, inspectionDirOf, inspectIdle, writeRecord, INSPECTION_SCHEMA, DEFAULT_CONFIG} from './self-repair.mjs';
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
// Finished reports of each kind (synthetic), and a COMPLETE attempt of `commit` with its records, as the inspector leaves it.
const GATE_PASS = {schema: 'ophanim.test-gate/v2', verdict: 'PASS', results: [{suite: 'test', verdict: 'PASS', problems: [], notes: []}]};
const PENTEST_OK = '--- summary ---\nattacks recorded: 0  (REFUSED 0; registered holes 0; new holes 0; known-holes-now-fixed 0)\n\nOK: every attack was refused or confirmed a registered known hole; no new hole, nothing regressed.\n';
const completeAttempt = (f, commit, {at = '2026-11-20T00:00:00.000Z'} = {}) => {
  const rel = file => path.relative(f.records, file);
  const steps = [{name: 'gates', exit: 0, ms: 1, killed: null, record: rel(writeRecord({dir: f.records, kind: 'gate', commit, record: GATE_PASS, at}))},
    {name: 'stress', skipped: 'the first inspection: no earlier inspected commit to compare with'},
    {name: 'pentest', exit: 0, ms: 1, killed: null, record: rel(writeRecord({dir: f.records, kind: 'pentest', commit, record: {report: PENTEST_OK}, at}))}];
  return {schema: INSPECTION_SCHEMA, commit, since: null, attempt: 1, started_at: at, finished_at: at, steps};
};
const writeInspection = (f, name, body) => { fs.mkdirSync(inspectionDirOf(f.stateDir), {recursive: true}); fs.writeFileSync(path.join(inspectionDirOf(f.stateDir), name), JSON.stringify(body)); };
const writer = body => ['node', '-e', `require('fs').writeFileSync(process.argv[process.argv.length - 1], ${JSON.stringify(JSON.stringify(body))})`];
const PENTEST_STUB = ['node', '-e', `process.stdout.write(${JSON.stringify(PENTEST_OK)})`];
// over.inspector (the test's `t`): the start launches a stand-in inspector whose argv carries the attempt token.
const idle = (f, starts, over = {}) => inspectIdle({repo: f.repo, state: f.stateDir, head: over.head ?? f.head, records: f.records, start: plan => { starts.push(plan); return over.inspector ? stubInspector(over.inspector, f, plan.token) : over.pid ?? 2 ** 22 + 7; },
  at: () => over.at ?? new Date().toISOString(), ...(over.config ? {config: over.config} : {})});
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
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
  // The running inspector is a live process whose argv carries the attempt's token (#100), not this test process.
  const inspector = {selfRepair: {startInspection: plan => { starts.push(plan); return stubInspector(t, f, plan.token); }}};
  await tickWith(f, starts, inspector);
  const r = await tickWith(f, starts, inspector);
  assert.equal(r.self_repair.inspection.state, 'running');
  assert.equal(starts.length, 1);
});

test('loop: a commit is inspected once; when the line moves, the next inspection starts, comparing with the last', async t => {
  const f = idleRepo(t), starts = [];
  writeInspection(f, 'last.json', completeAttempt(f, f.head));
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

// ---- ACQUISITION AND RETRY: an inspection is complete by its evidence, never by having run ----------------------------
test('acquisition: an attempt whose gate tool wrote no report is INCOMPLETE; the lane does not take the head as inspected: it waits, then retries it when due, as attempt 2', async t => {
  const f = idleRepo(t), starts = [];
  const inspect = {...DEFAULT_CONFIG.inspect, gates: ['node', '-e', 'process.exit(1)', '{json}'], stress: ['node', '-e', 'process.exit(9)'], pentest: PENTEST_STUB, nice: null, timeout_ms: 60_000};
  await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: f.head, since: null, attempt: 1, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  const {last, complete, running} = inspectionState(f.stateDir);
  assert.deepEqual([last.commit, last.attempt, last.complete, complete, running], [f.head, 1, false, null, null]);
  assert.match(last.incomplete.join(' '), /gates: no gate record was written/);
  const ended = Date.parse(last.finished_at);
  const soon = idle(f, starts, {at: new Date(ended + 60_000).toISOString()});
  assert.deepEqual([soon.state, soon.attempt, starts.length], ['retry-wait', 1, 0], JSON.stringify(soon));
  assert.equal(soon.next_at, new Date(ended + (DEFAULT_CONFIG.inspect.retry?.first_ms ?? 15 * 60_000)).toISOString());
  const due = idle(f, starts, {at: new Date(ended + (DEFAULT_CONFIG.inspect.retry?.first_ms ?? 15 * 60_000)).toISOString()});
  assert.deepEqual([due.state, due.commit, due.attempt, starts.length, starts[0]?.attempt], ['retrying', f.head, 2, 1, 2], JSON.stringify(due));
  assert.match(due.incomplete.join(' '), /no gate record/);
  assert.equal(inspectionState(f.stateDir).running.attempt, 2, 'the attempt is recorded with the running inspection');
});

test('acquisition: a step killed at its bound is INCOMPLETE even though its tool started; the retry delay doubles per attempt and is capped', async t => {
  const f = idleRepo(t);
  // The gate tool writes a finished report and then hangs past the bound: only the process evidence makes it incomplete.
  const inspect = {...DEFAULT_CONFIG.inspect, gates: ['node', '-e', `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify(GATE_PASS))}); setTimeout(() => {}, 60000)`, '{json}'], pentest: PENTEST_STUB, nice: null, timeout_ms: 1500};
  await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: f.head, since: null, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  const {last} = inspectionState(f.stateDir);
  assert.equal(last.complete, false);
  assert.equal(last.steps.find(s => s.name === 'gates').killed, 'timeout');
  assert.ok(last.steps.find(s => s.name === 'gates').record, 'the report it wrote is kept');
  assert.match(last.incomplete.join(' '), /gates: the run did not finish on its own .*killed: timeout/);
  const r = {first_ms: 1000, max_ms: 5000};
  assert.deepEqual([1, 2, 3, 4, 9].map(n => lane.inspectionRetryMs(n, r)), [1000, 2000, 4000, 5000, 5000]);
});

test('acquisition: a gate run whose tests FAIL is COMPLETE -- its findings are kept for Detect and the head is not inspected again', async t => {
  const f = idleRepo(t), starts = [];
  const gate = {schema: 'ophanim.test-gate/v2', verdict: 'FAIL', results: [{suite: 'test', verdict: 'FAIL', problems: [], notes: ['fail: adds at test/calc.test.mjs:4 -- testCodeFailure: x']}]};
  const inspect = {...DEFAULT_CONFIG.inspect, gates: ['node', '-e', `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify(gate))}); process.exit(1)`, '{json}'], pentest: PENTEST_STUB, nice: null, timeout_ms: 60_000};
  const steps = await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: f.head, since: null, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  assert.deepEqual(steps.find(s => s.name === 'gates').exit, 1, 'the gate tool exits non-zero for failing tests');
  const {last, complete} = inspectionState(f.stateDir);
  assert.deepEqual([last.complete, last.incomplete, complete?.commit], [true, [], f.head]);
  assert.deepEqual(detect({repo: f.repo, commit: f.head, records: readRecords(f.records)}).defects.map(d => d.kind), ['regression']);
  const again = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  assert.deepEqual([again.state, starts.length], ['already-inspected', 0]);
});

test('acquisition: the stress comparison base stays the last COMPLETE head when a later head was inspected incompletely', async t => {
  const f = idleRepo(t), starts = [];
  const a = f.head;
  writeInspection(f, 'complete.json', completeAttempt(f, a));
  const b = commitFiles(f.repo, {'lib/b.mjs': 'export const b = 1;\n'}, 'b');
  writeInspection(f, 'last.json', {schema: INSPECTION_SCHEMA, commit: b, since: a, attempt: 1, started_at: '2026-11-20T01:00:00.000Z', finished_at: '2026-11-20T01:00:00.000Z',
    steps: [{name: 'inspection', error: 'the checkout failed'}], complete: false});
  const c = commitFiles(f.repo, {'lib/c.mjs': 'export const c = 1;\n'}, 'c');
  const r = idle(f, starts, {head: c});
  assert.deepEqual([r.state, r.commit, r.since, r.attempt], ['started', c, a, 1], JSON.stringify(r));
});

test('recovery: an inspector that died without its result is recorded as an interrupted attempt and retried when due; a live inspector is never started beside', async t => {
  const f = idleRepo(t), starts = [];
  const pid = deadPid(), started_at = '2026-11-21T00:00:00.000Z', now = '2026-11-21T02:00:00.000Z';
  writeInspection(f, 'running.json', {schema: INSPECTION_SCHEMA, commit: f.head, pid, started_at, since: null, attempt: 1});
  const r = idle(f, starts, {at: now});
  assert.deepEqual([r.state, r.recovered?.result, r.recovered?.pid, starts.length], ['retry-wait', 'interrupted', pid, 0], JSON.stringify(r));
  const {running, last} = inspectionState(f.stateDir);
  assert.equal(running, null, 'the dead inspector\'s running.json is removed');
  assert.deepEqual([last.commit, last.attempt, last.complete, last.recovered_at], [f.head, 1, false, now]);
  assert.match(last.steps[0].error, new RegExp(`interrupted: the inspector \\(pid ${pid}\\)`));
  const later = idle(f, starts, {at: new Date(Date.parse(now) + (DEFAULT_CONFIG.inspect.retry?.first_ms ?? 15 * 60_000)).toISOString(), inspector: t});
  assert.deepEqual([later.state, later.attempt, starts.length], ['retrying', 2, 1]);
  const beside = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  assert.deepEqual([beside.state, beside.pid, beside.identity, starts.length], ['running', later.pid, 'verified', 1], 'the live inspector (its argv carries the token) blocks a second start');
});

test('legacy state: a last.json written before the rule (no attempt) is judged by its evidence -- one with no reports cannot establish completeness and is retried; one whose reports are on disk is honoured', async t => {
  const f = idleRepo(t), starts = [];
  writeInspection(f, 'last.json', {schema: INSPECTION_SCHEMA, commit: f.head, finished_at: '2026-11-20T00:00:00Z', steps: []});
  const r = idle(f, starts, {at: '2026-11-22T00:00:00.000Z'});
  assert.deepEqual([r.state, r.attempt, starts.length], ['retrying', 2, 1], JSON.stringify(r));
  assert.match(r.incomplete.join(' '), /gates: no result/);
  const g2 = idleRepo(t), s2 = [];
  const {attempt, ...legacy} = completeAttempt(g2, g2.head);
  writeInspection(g2, 'last.json', legacy);
  assert.deepEqual(lane.inspectionCompleteness(legacy, g2.records), {complete: true, why: []});
  assert.equal(idle(g2, s2).state, 'already-inspected');
  fs.rmSync(path.join(g2.records, legacy.steps[0].record));
  assert.match(lane.inspectionCompleteness(legacy, g2.records).why.join(' '), /gates: the report .* is absent/, 'a report that is gone cannot establish completeness');
});

// ---- THE GATE REPORT AT THE COMPLETENESS BOUNDARY: a usable suite, and the verdict its exit gives ----------------------
/** One real inspector attempt whose gate tool writes `body` and exits `code`; the attempt as it left last.json. */
const gateAttempt = async (f, body, code) => {
  const inspect = {...DEFAULT_CONFIG.inspect, gates: ['node', '-e', `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify(body))}); process.exit(${code})`, '{json}'], pentest: PENTEST_STUB, nice: null, timeout_ms: 60_000};
  await runInspection({schema: INSPECTION_SCHEMA, repo: f.repo, commit: f.head, since: null, records: f.records, state: f.stateDir, inspect}, {log: () => {}});
  return inspectionState(f.stateDir).last;
};
const GATE = (verdict, results) => ({schema: 'ophanim.test-gate/v2', verdict, results});
const ROW = (suite, verdict, notes = []) => ({suite, verdict, problems: [], unverified: [], notes});

test('gate report: no suite, a row that is not a suite, or a verdict its exit contradicts is INCOMPLETE and retried, never cached as inspected', async t => {
  for (const [what, body, code, why] of [
    ['results: []', GATE('PASS', []), 0, /no suite results/],
    ['results: [null]', GATE('PASS', [null]), 0, /results\[0\] is not a usable suite row/],
    ['a row with no suite name', GATE('PASS', [{verdict: 'PASS', notes: []}]), 0, /results\[0\] is not a usable suite row/],
    ['notes that are not text', GATE('FAIL', [{suite: 'test', verdict: 'FAIL', notes: [7]}]), 1, /results\[0\] is not a usable suite row/],
    ['only the "(none)" placeholder', GATE('FAIL', [ROW('(none)', 'FAIL')]), 1, /ran no suite/],
    ['PASS with exit 1', GATE('PASS', [ROW('test', 'PASS')]), 1, /PASS report came with exit 1/],
    ['FAIL with exit 0', GATE('FAIL', [ROW('test', 'FAIL', ['fail: adds at test/calc.test.mjs:4 -- x'])]), 0, /FAIL report came with exit 0/],
    ['PASS over a failing suite', GATE('PASS', [ROW('test', 'FAIL')]), 0, /PASS over a suite that did not pass/],
  ]) {
    const f = idleRepo(t), starts = [];
    const last = await gateAttempt(f, body, code);
    assert.equal(last.complete, false, `${what}: ${JSON.stringify(last.incomplete)}`);
    assert.match(last.incomplete.join(' '), why, what);
    assert.equal(inspectionState(f.stateDir).complete, null, `${what}: no complete.json`);
    const r = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
    assert.deepEqual([r.state, r.attempt, starts.length], ['retrying', 2, 1], `${what}: ${JSON.stringify(r)}`);
  }
});

test('gate report: the producer\'s finished layouts are complete -- PASS/0, FAIL/1, UNVERIFIED/2 and UNVERIFIED/0 (allowed), and a row without notes', async t => {
  for (const [what, body, code] of [
    ['PASS, exit 0', GATE('PASS', [ROW('test', 'PASS'), ROW('pantheon', 'PASS')]), 0],
    ['FAIL, exit 1', GATE('FAIL', [ROW('test', 'FAIL', ['fail: adds at test/calc.test.mjs:4 -- x']), ROW('pantheon', 'PASS')]), 1],
    ['FAIL over passing suites (coverage), exit 1', GATE('FAIL', [ROW('test', 'PASS')]), 1],
    ['UNVERIFIED, exit 2', GATE('UNVERIFIED', [ROW('test', 'UNVERIFIED')]), 2],
    ['UNVERIFIED allowed, exit 0', GATE('UNVERIFIED', [ROW('test', 'UNVERIFIED')]), 0],
    ['a row without notes or problems', GATE('PASS', [{suite: 'test', verdict: 'PASS', counts: null}]), 0],
  ]) {
    const f = idleRepo(t);
    const last = await gateAttempt(f, body, code);
    assert.deepEqual([last.complete, last.incomplete], [true, []], what);
  }
});

test('Detect reads a historical gate record with malformed rows: it does not throw, the readable rows\' failing tests are kept, and each skipped row is recorded', async t => {
  const f = idleRepo(t);
  const body = GATE('FAIL', [null, 'text', {suite: 'x', verdict: 'FAIL', notes: 'not a list'}, ROW('test', 'FAIL', ['fail: adds at test/calc.test.mjs:4 -- testCodeFailure: x'])]);
  writeRecord({dir: f.records, kind: 'gate', commit: f.head, record: body});
  const d = detect({repo: f.repo, commit: f.head, records: readRecords(f.records)});
  assert.deepEqual(d.defects.map(x => x.id), ['test:test/calc.test.mjs::adds']);
  assert.deepEqual(d.ignored.map(x => x.why.replace(/^a gate row is not readable: /, '')),
    ['results[0] is not a suite row', 'results[1] is not a suite row', 'results[2] (x): its notes or problems are not lists of text']);
});

// ---- WORKER IDENTITY (#100): a live pid is not an inspector unless the process's own argv carries the attempt's token ----
const INSPECTOR_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'self-repair-inspect.mjs');
/** A stand-in inspector: a live process whose argv is the inspector's (script, --plan <plan.json>, --token <token>). */
const stubInspector = (t, f, token) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', INSPECTOR_PATH, '--plan', path.join(inspectionDirOf(f.stateDir), 'plan.json'), '--token', token], {stdio: 'ignore'});
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child.pid;
};
const runningRecord = (f, over) => writeInspection(f, 'running.json', {schema: INSPECTION_SCHEMA, commit: f.head, since: null, attempt: 1, started_at: new Date().toISOString(), ...over});

test('identity: a verified current inspector (its argv carries the recorded token) suppresses a duplicate launch', async t => {
  const f = idleRepo(t), starts = [], token = 'b7a7a0de-0000-4000-8000-000000000001';
  runningRecord(f, {pid: stubInspector(t, f, token), token});
  await new Promise(r => setTimeout(r, 150));
  const r = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  assert.deepEqual([r.state, r.identity, starts.length], ['running', 'verified', 0], JSON.stringify(r));
});

test('identity: a live unrelated process in the record (this harness, a token it does not carry, a claimed start in 2000) is recovered as interrupted -- it is not signalled, and the next attempt is due on the usual cadence', async t => {
  const f = idleRepo(t), starts = [];
  runningRecord(f, {pid: process.pid, token: 'b7a7a0de-0000-4000-8000-000000000002', started_at: '2000-01-01T00:00:00.000Z'});
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { killed.push([pid, sig]); return realKill.call(process, pid, sig); };
  try {
    const now = '2026-11-22T06:00:00.000Z';
    const r = idle(f, starts, {at: now});
    assert.deepEqual([r.state, r.recovered?.result, r.recovered?.identity, starts.length], ['retry-wait', 'interrupted', 'mismatch', 0], JSON.stringify(r));
    assert.deepEqual(killed.filter(([pid, sig]) => pid === process.pid && sig !== 0), [], 'no signal is sent to the unrelated process');
    const later = idle(f, starts, {at: new Date(Date.parse(now) + (DEFAULT_CONFIG.inspect.retry?.first_ms ?? 15 * 60_000)).toISOString()});
    assert.deepEqual([later.state, later.attempt, starts.length], ['retrying', 2, 1]);
  } finally { process.kill = realKill; }
});

test('identity: a real inspector process with ANOTHER attempt\'s token is a mismatch, recovered, not a running inspector', async t => {
  const f = idleRepo(t), starts = [];
  runningRecord(f, {pid: stubInspector(t, f, 'b7a7a0de-0000-4000-8000-00000000000a'), token: 'b7a7a0de-0000-4000-8000-00000000000b'});
  await new Promise(r => setTimeout(r, 150));
  const r = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  assert.deepEqual([r.state === 'running', r.recovered?.identity], [false, 'mismatch'], JSON.stringify(r));
});

test('identity: both running.json writers record the attempt token -- the lane before and after the launch, the inspector with its own pid; the spawned argv carries it', async t => {
  const f = idleRepo(t), starts = [];
  const r = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  const token = starts[0]?.token;
  assert.match(String(token), /^[0-9a-f-]{36}$/, 'the plan carries a token');
  assert.deepEqual([r.state, inspectionState(f.stateDir).running.token], ['started', token]);
  const lane = await import('./self-repair.mjs');
  assert.deepEqual(lane.inspectorArgv('/x/plan.json', token), [INSPECTOR_PATH, '--plan', '/x/plan.json', '--token', token], 'the spawned argv is the inspector, its plan and the token');
  const inspect = {...DEFAULT_CONFIG.inspect, gates: [...writer(GATE_PASS), '{json}'], pentest: PENTEST_STUB, nice: null, timeout_ms: 60_000};
  let seen = null;
  const plan = {schema: INSPECTION_SCHEMA, repo: f.repo, commit: f.head, since: null, attempt: 1, token, records: f.records, state: f.stateDir, inspect};
  await runInspection(plan, {log: line => { if (!seen) seen = inspectionState(f.stateDir).running; }});
  assert.deepEqual([seen?.token, seen?.pid], [token, process.pid], 'the inspector\'s own record: the same token, its own pid');
  assert.equal(inspectionState(f.stateDir).last.token, token, 'its result names the attempt');
});

test('identity: a very fast finish -- the inspector completes before the lane records its pid -- leaves the complete result standing, not an interrupted one', async t => {
  const f = idleRepo(t), starts = [];
  const finishing = plan => {
    starts.push(plan);
    const body = {...completeAttempt(f, plan.commit), token: plan.token};
    body.complete = true; body.incomplete = [];
    writeInspection(f, 'last.json', body); writeInspection(f, 'complete.json', body);
    fs.rmSync(path.join(inspectionDirOf(f.stateDir), 'running.json'), {force: true});
    return spawnSync(process.execPath, ['-e', '0']).pid;
  };
  const r = inspectIdle({repo: f.repo, state: f.stateDir, head: f.head, records: f.records, start: finishing, at: () => '2030-01-01T00:00:00.000Z'});
  assert.equal(r.state, 'started');
  const again = idle(f, starts, {at: '2030-01-01T00:01:00.000Z'});
  assert.equal(again.state, 'already-inspected', JSON.stringify(again));
  assert.equal(inspectionState(f.stateDir).last.complete, true, 'last.json is still the complete result');
  assert.equal(starts.length, 1);
});

test('identity: a legacy record with no token and a live pid is conservative within the finite attempt envelope, labelled unverified, and recovered after it', async t => {
  const f = idleRepo(t), starts = [];
  const lane = await import('./self-repair.mjs');
  const envelope = lane.attemptEnvelopeMs(DEFAULT_CONFIG.inspect);
  assert.equal(envelope, 3 * DEFAULT_CONFIG.inspect.timeout_ms + 10 * 60_000);
  const started_at = '2026-11-22T00:00:00.000Z';
  runningRecord(f, {pid: process.pid, started_at});
  const within = idle(f, starts, {at: new Date(Date.parse(started_at) + envelope - 1000).toISOString()});
  assert.deepEqual([within.state, within.identity, starts.length], ['running', 'unverified', 0], JSON.stringify(within));
  assert.match(within.identity_why, /no identity token/);
  const after = idle(f, starts, {at: new Date(Date.parse(started_at) + envelope + 1000).toISOString()});
  assert.deepEqual([after.recovered?.result, after.recovered?.identity], ['interrupted', 'expired'], JSON.stringify(after));
});

test('identity: where the process table cannot be read (no /proc, as on macOS or Windows) a live pid is unverified -- running within the envelope, recovered after it', async t => {
  const f = idleRepo(t), starts = [];
  const lane = await import('./self-repair.mjs');
  const started_at = '2026-11-22T00:00:00.000Z', envelope = lane.attemptEnvelopeMs(DEFAULT_CONFIG.inspect);
  runningRecord(f, {pid: process.pid, token: 'b7a7a0de-0000-4000-8000-00000000000c', started_at});
  const procfs = path.join(f.root ?? f.repo, 'no-such-proc');
  const within = inspectIdle({repo: f.repo, state: f.stateDir, head: f.head, records: f.records, start: () => 1, at: () => new Date(Date.parse(started_at) + 1000).toISOString(), procfs});
  assert.deepEqual([within.state, within.identity], ['running', 'unverified'], JSON.stringify(within));
  assert.match(within.identity_why, /process table/);
  const after = inspectIdle({repo: f.repo, state: f.stateDir, head: f.head, records: f.records, start: () => 1, at: () => new Date(Date.parse(started_at) + envelope + 1000).toISOString(), procfs});
  assert.equal(after.recovered?.identity, 'expired', JSON.stringify(after));
});

test('identity: a genuine inspector under a non-ASCII state directory (état-λ) is verified -- the argv is compared as bytes, not decoded as latin1', async t => {
  const base = idleRepo(t), starts = [];
  const f = {...base, stateDir: path.join(path.dirname(base.stateDir), 'état-λ')};
  fs.mkdirSync(f.stateDir, {recursive: true});
  const token = 'b7a7a0de-0000-4000-8000-0000000000e1';
  runningRecord(f, {pid: stubInspector(t, f, token), token});
  await new Promise(r => setTimeout(r, 150));
  const r = idle(f, starts, {at: '2030-01-01T00:00:00.000Z'});
  assert.deepEqual([r.state, r.identity, starts.length], ['running', 'verified', 0], JSON.stringify(r));
});

test('identity: a process entry whose cmdline cannot be read is UNREADABLE (not dead) -- trusted within the envelope with its reason, expired after it; an absent entry is dead and recovered at once', async t => {
  const f = idleRepo(t), starts = [];
  const lane = await import('./self-repair.mjs');
  const procfs = path.join(path.dirname(f.stateDir), 'fake-proc'), pid = 424242;
  fs.mkdirSync(path.join(procfs, String(pid), 'cmdline'), {recursive: true});   // reading it fails with EISDIR
  const started_at = '2026-11-22T00:00:00.000Z', envelope = lane.attemptEnvelopeMs(DEFAULT_CONFIG.inspect);
  const call = (at, p = pid) => inspectIdle({repo: f.repo, state: f.stateDir, head: f.head, records: f.records, start: plan => { starts.push(plan); return 1; }, at: () => at, procfs});
  runningRecord(f, {pid, token: 'b7a7a0de-0000-4000-8000-0000000000e2', started_at});
  const within = call(new Date(Date.parse(started_at) + 1000).toISOString());
  assert.deepEqual([within.state, within.identity, starts.length], ['running', 'unreadable', 0], JSON.stringify(within));
  assert.match(within.identity_why, /EISDIR/);
  const after = call(new Date(Date.parse(started_at) + envelope + 1000).toISOString());
  assert.equal(after.recovered?.identity, 'expired', JSON.stringify(after));
  runningRecord(f, {pid: pid + 1, token: 'b7a7a0de-0000-4000-8000-0000000000e3', started_at: new Date().toISOString()});
  const gone = call(new Date().toISOString());
  assert.deepEqual([gone.recovered?.identity, gone.recovered?.result], ['dead', 'interrupted'], JSON.stringify(gone));
});
