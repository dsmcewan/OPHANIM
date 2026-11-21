// THE SELF-REPAIR LANE'S VERIFY (ophanim/operate/self-repair.mjs verifyRepair, reproductionRefusal): decisions 5, 6 and 9 --
// validate's mechanical checks and the anti-cheating refusals -- each on a real commit of a fixture repository, run in a
// clean checkout through the verify jail, with T1 (reach) and T2 (affected runners) used as libraries. No provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {verifyRepair, reproductionRefusal, testFacts, laneConfig, writeRecord, readRecords} from './self-repair.mjs';
import {laneRepo, commitOn, CALC_OK, CALC_TEST} from './fixtures/self-repair-fixture.mjs';

const ADDS = {kind: 'test', file: 'test/calc.test.mjs', name: 'adds'};
const codes = v => v.refusals.map(x => x.code);
const verify = (f, files, extra = {}) => verifyRepair({repo: f.repo, base: f.base, commit: commitOn(f.repo, f.base, files), reproduction: ADDS, ...extra});

test('SR-V honest: a repair that fixes the defect passes every mechanical check, each one run', async t => {
  const f = laneRepo(t);
  const v = await verify(f, {'lib/calc.mjs': CALC_OK}, {paths: ['lib/calc.mjs', 'test/calc.test.mjs']});
  assert.deepEqual(v.refusals, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.runs.map(r => r.check), ['reproduction', 'reach', 'runner', 'pentest', 'lint']);
  assert.equal(v.runs.find(r => r.check === 'reach').file, 'test/calc.test.mjs', 'T1: the test importing the changed module');
  assert.equal(v.runs.find(r => r.check === 'runner').file, 'lib/calc.mutate.mjs', 'T2: the runner whose target changed, run in full');
  assert.equal(v.runs.find(r => r.check === 'runner').killed, 1);
});

test('SR-V6 anti-cheating: a removed or weakened assertion is refused', async t => {
  const f = laneRepo(t);
  const removed = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': CALC_TEST.replace('assert.equal(mul(X, X), X * X);', '')});
  assert.ok(codes(removed).includes('ASSERTION_REMOVED'));
  const weakened = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': CALC_TEST.replace('assert.equal(mul(X, X), X * X);', 'assert.ok(mul(X, X) >= 0);')});
  assert.deepEqual(codes(weakened), ['ASSERTION_REMOVED'], 'a changed assertion is a removed one');
  assert.deepEqual(weakened.runs, [], 'nothing a refused diff would run is run');
});

test('SR-V6 anti-cheating: an added skip, todo or only is refused', async t => {
  const f = laneRepo(t);
  for (const edit of [["test('muls', () =>", "test('muls', {skip: true}, () =>"], ["test('muls', () =>", "test.only('muls', () =>"], ["test('muls', () =>", "test('muls', {todo: 'later'}, () =>"]]) {
    const v = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': CALC_TEST.replace(...edit)});
    assert.deepEqual(codes(v), ['SKIP_ADDED'], edit[1]);
  }
});

test('SR-V6 anti-cheating: a test file\'s test count lowered (a test or the file removed) is refused', async t => {
  const f = laneRepo(t);
  const fewer = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': CALC_TEST.replace("test('muls', () => { assert.equal(mul(X, X), X * X); });", '')});
  assert.ok(codes(fewer).includes('TEST_COUNT_LOWERED'));
  const gone = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/cli.test.mjs': null});
  assert.deepEqual(codes(gone), ['TEST_COUNT_LOWERED']);
  assert.deepEqual(testFacts(CALC_TEST), {assertions: ['assert.equal(add(X, X), X + X); });', 'assert.equal(mul(X, X), X * X); });'], skips: 0, tests: 2});
});

test('SR-V6 anti-cheating: a runner\'s kill count lowered is refused, though no assertion changed', async t => {
  const f = laneRepo(t);
  // X = 1 makes mul's mutation (a * b -> a / b) invisible to the test: 1 / 1 === 1 * 1.
  const v = await verify(f, {'lib/calc.mjs': CALC_OK, 'test/calc.test.mjs': CALC_TEST.replace('const X = 3;', 'const X = 1;')});
  assert.deepEqual(codes(v), ['RUNNER_FAILED', 'KILL_COUNT_LOWERED']);
  const row = v.runs.find(r => r.check === 'runner');
  assert.deepEqual([row.killed, row.killed_at_base], [0, 1]);
});

test('SR-V9 a repair touching a protected path is refused before anything runs', async t => {
  const f = laneRepo(t);
  for (const p of ['package.json', 'scripts/pentest/run.mjs', 'lib/calc.mutate.mjs', 'docs/OPEN-LIMITATIONS.md']) {
    const v = await verify(f, {'lib/calc.mjs': CALC_OK, [p]: 'tampered\n'});
    assert.deepEqual(codes(v), ['PROTECTED_PATH'], p);
    assert.deepEqual(v.runs, []);
  }
  const extra = await verify(f, {'lib/calc.mjs': CALC_OK}, {config: laneConfig({protected_extra: ['lib/calc.mjs']})});
  assert.deepEqual(codes(extra), ['PROTECTED_PATH'], 'an added protected surface is enforced too');
});

test('SR-V5 validate requires: the reproduction passes, every reached test, the pentest (no new hole) and the lint', async t => {
  const f = laneRepo(t);
  const still = await verify(f, {'README.md': 'nothing repaired\n'});
  assert.deepEqual(codes(still), ['REPRODUCTION_STILL_FAILS']);
  const broke = await verify(f, {'lib/calc.mjs': CALC_OK.replace('(a, b) => a * b', '(a, b) => a + b')});
  assert.deepEqual(codes(broke), ['REACH_TEST_FAILED']);
  const hole = await verify(f, {'lib/calc.mjs': CALC_OK, HOLE: 'x\n'});
  assert.deepEqual(codes(hole), ['PENTEST_NEW_HOLE']);
  assert.deepEqual(hole.runs.find(r => r.check === 'pentest').new_holes, ['X1-fixture-hole']);
  const lint = await verify(f, {'lib/calc.mjs': CALC_OK, LINT_FAIL: 'x\n'});
  assert.deepEqual(codes(lint), ['LINT_FAILED']);
  const outside = await verify(f, {'lib/calc.mjs': CALC_OK, 'README.md': 'x\n'}, {paths: ['lib/calc.mjs']});
  assert.deepEqual(codes(outside), ['OUTSIDE_CLAIMED_PATHS']);
  const two = commitOn(f.repo, commitOn(f.repo, f.base, {'README.md': 'x\n'}), {'lib/calc.mjs': CALC_OK});
  assert.ok(codes(await verifyRepair({repo: f.repo, base: f.base, commit: two, reproduction: ADDS})).includes('ONE_COMMIT'));
});

test('SR-V4 and SR-V5 a flake: its reproduction is a stress record with failures; validate needs R stress rounds with none', async t => {
  const f = laneRepo(t);
  const rec = writeRecord({dir: f.records, kind: 'stress', commit: f.base, record: {schema: 'ophanim.toolkit.stress/v1', repeat: 4, byTest: [{file: 'test/calc.test.mjs', name: 'adds', rounds: [1, 3], pattern: 'intermittent'}]}});
  const records = readRecords(f.records);
  const digest = records.stress[0].digest;
  assert.ok(fs.existsSync(rec));
  const defect = {id: 'test:test/calc.test.mjs::adds'};
  const flake = {kind: 'stress', file: 'test/calc.test.mjs', name: 'adds', record: digest, failure_rate: {failed: 2, rounds: 4}};
  const ok = await reproductionRefusal({repo: f.repo, base: f.base, repair: {defect: defect.id, root_cause: 'add subtracts its second argument', reproduction: flake}, defect, records});
  assert.equal(ok.ok, true);
  const none = await reproductionRefusal({repo: f.repo, base: f.base, repair: {defect: defect.id, root_cause: 'add subtracts its second argument', reproduction: {...flake, name: 'muls'}}, defect, records});
  assert.deepEqual(none.refusals.map(x => x.code), ['REPRODUCTION_DOES_NOT_FAIL']);
  const config = laneConfig({flake_rounds: 3});
  const fixed = await verify(f, {'lib/calc.mjs': CALC_OK}, {reproduction: flake, config});
  assert.equal(fixed.ok, true, JSON.stringify(fixed.refusals));
  assert.deepEqual(fixed.runs.find(r => r.check === 'reproduction'), {check: 'reproduction', kind: 'stress', cmd: fixed.runs[0].cmd, exit: 0, rounds: 3, failures: 0, verdict: 'PASS'});
  const unfixed = await verify(f, {'README.md': 'x\n'}, {reproduction: flake, config});
  assert.deepEqual(codes(unfixed), ['REPRODUCTION_STILL_FAILS']);
});

test('SR-V4 a new reproduction test (its source in the plan) must fail on the base and be the very file the repair carries', async t => {
  const f = laneRepo(t);
  const source = "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from '../lib/calc.mjs';\ntest('adds two', () => { assert.equal(add(2, 2), 4); });\n";
  const rep = {kind: 'test', file: 'test/adds.test.mjs', name: 'adds two', source};
  const defect = {id: 'test:test/calc.test.mjs::adds'};
  const r = await reproductionRefusal({repo: f.repo, base: f.base, repair: {defect: defect.id, root_cause: 'add subtracts its second argument', reproduction: rep}, defect});
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(f.repo, rep.file)), 'the reproduction was run in a checkout, never written into the repository');
  const same = await verify(f, {'lib/calc.mjs': CALC_OK, [rep.file]: source}, {reproduction: rep});
  assert.equal(same.ok, true, JSON.stringify(same.refusals));
  const other = await verify(f, {'lib/calc.mjs': CALC_OK, [rep.file]: source.replace('add(2, 2), 4', 'add(0, 0), 0')}, {reproduction: rep});
  assert.deepEqual(codes(other), ['REPRODUCTION_CHANGED']);
});
