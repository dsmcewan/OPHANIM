// T4 stress's own tests (scripts/test-gates/stress.mjs; TOOLKIT.md), on tiny synthetic test files
// (fixtures/toolkit-*.fixture.mjs), never the real jail suites: a deliberately flaky test is caught over repeats and named
// with its round, a stable one passes, a race that appears only in parallel is caught at concurrency 2 and not at 1, and
// the load processes are stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stress} from './stress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'stress.mjs');
const FX = n => path.join(HERE, 'fixtures', n);
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const BOUNDS = {testTimeoutMs: 20_000, fileTimeoutS: 60};
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-stress-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stress: a deliberately flaky test is caught over repeats, named by file, test and round; one run alone passes', t => {
  const state = scratch(t), out = scratch(t), json = path.join(out, 'stress.json');
  const once = spawnSync(process.execPath, [TOOL, '--files', FX('toolkit-flaky.fixture.mjs'), '--repeat', '1'], {encoding: 'utf8', env: {...CLEAN_ENV, TOOLKIT_FLAKY_STATE: state}});
  assert.equal(once.status, 0, `one round passes: ${once.stdout}${once.stderr}`);
  fs.rmSync(path.join(state, 'runs'));
  const r = spawnSync(process.execPath, [TOOL, '--files', FX('toolkit-flaky.fixture.mjs'), '--repeat', '3', '--json', json],
    {encoding: 'utf8', env: {...CLEAN_ENV, TOOLKIT_FLAKY_STATE: state}});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /round 2: scripts\/test-gates\/fixtures\/toolkit-flaky\.fixture\.mjs FAIL/);
  assert.match(r.stdout, /fail: flaky: fails on its second run only \(line \d+\)/);
  assert.match(r.stdout, /toolkit-flaky\.fixture\.mjs :: flaky: fails on its second run only -- rounds 2 of 3 \(intermittent\)/);
  const rec = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.deepEqual(rec.rounds.map(x => x.runs[0].verdict), ['PASS', 'FAIL', 'PASS']);
  assert.deepEqual(rec.byTest, [{file: 'scripts/test-gates/fixtures/toolkit-flaky.fixture.mjs', name: 'flaky: fails on its second run only', rounds: [2], pattern: 'intermittent'}]);
});

test('stress: a stable test passes every round', async t => {
  const rec = await stress({files: [FX('toolkit-stable.fixture.mjs')], repeat: 3, concurrency: 2, outDir: scratch(t), ...BOUNDS});
  assert.equal(rec.verdict, 'PASS');
  assert.deepEqual(rec.rounds.map(x => [x.round, x.runs.map(r => [r.verdict, r.tests, r.failures.length])]), [[1, [['PASS', 1, 0]]], [2, [['PASS', 1, 0]]], [3, [['PASS', 1, 0]]]]);
  assert.deepEqual(rec.byTest, []);
});

test('stress: a race that appears only in parallel is caught at concurrency 2 and not at 1', async t => {
  const race = scratch(t);
  process.env.TOOLKIT_RACE_DIR = race;
  t.after(() => { delete process.env.TOOLKIT_RACE_DIR; });
  const files = [FX('toolkit-race-a.fixture.mjs'), FX('toolkit-race-b.fixture.mjs')];
  const serial = await stress({files, repeat: 2, concurrency: 1, outDir: scratch(t), ...BOUNDS});
  assert.equal(serial.verdict, 'PASS', 'one after the other, the twins never meet');
  const parallel = await stress({files, repeat: 2, concurrency: 2, outDir: scratch(t), ...BOUNDS});
  assert.equal(parallel.verdict, 'FAIL');
  assert.ok(parallel.rounds.every(x => x.runs.some(r => r.failures.some(f => f.name === 'race: fails only beside its twin' && f.status === 'fail'))),
    JSON.stringify(parallel.rounds.map(x => x.runs.map(r => r.verdict))));
  assert.deepEqual([...new Set(parallel.byTest.flatMap(x => x.rounds))].sort(), [1, 2], 'caught in every round');
  assert.ok(parallel.byTest.every(x => /toolkit-race-[ab]\.fixture\.mjs$/.test(x.file) && x.name === 'race: fails only beside its twin'), JSON.stringify(parallel.byTest));
});

test('stress: --load starts busy loops beside the rounds and stops them all', async t => {
  const rec = await stress({files: [FX('toolkit-stable.fixture.mjs')], repeat: 1, load: 2, outDir: scratch(t), ...BOUNDS});
  assert.equal(rec.verdict, 'PASS');
  assert.equal(rec.loadPids.length, 2);
  assert.deepEqual(rec.loadPids.filter(alive), [], 'no load process is left running');
});
