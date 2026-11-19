// The test-result gate's own tests: what would falsify it. Recorded outputs (fixtures/*.log, from real Node 22 and
// Node 24 runs) for the log reader; live runs of fixtures/live/*.fixture.mjs through the events reporter for the
// exact mode. Each case says what the gate must decide and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseLog} from './parse-log.mjs';
import {evaluateLogs, evaluateEvents, readEvents, PASS, FAIL, UNVERIFIED} from './check.mjs';
import {designated, probeBwrap, baselineDrift, GATE} from './real-bwrap.mjs';
import {suites, coverage, parseNodeTest, ROOT} from './suites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures');
const fx = n => fs.readFileSync(path.join(FX, n), 'utf8');
const WORKS = {works: true, command: 'bwrap --ro-bind / / true', status: 0, error: null};
const BROKEN = {works: false, command: 'bwrap --ro-bind / / true', status: 1, error: null, stderr: 'bwrap: No permissions to create new namespace'};
// A suite whose test files are fake: `read` returns the source the skip attribution searches.
const SRC = {'/work/fx/pass.test.mjs': "test('passes', ...); test('skips', {skip: ...})", '/work/fx/pending.test.mjs': "test('never resolves')"};
const read = f => SRC[f] ?? '';
const oneSuite = (script = 'test:proof') => [{id: script, label: script, script, cwd: '/work', files: Object.keys(SRC), flags: [], patterns: []}];

test('a real Node 22 run that cancelled a whole file while the summary said fail 0 FAILS, attributed to the file -- TAP and spec', () => {
  for (const name of ['node22-cancelled.tap.log', 'node22-cancelled.spec.log']) {
    const text = fx(name);
    assert.match(text, /(#|ℹ) fail 0/, `${name}: the recorded run reports fail 0`);
    const [r] = evaluateLogs({logs: [{script: 'test:proof', text}], suites: oneSuite(), gated: [], bwrap: WORKS, read});
    assert.equal(r.verdict, FAIL, name);
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.cancelled, 2);
    assert.ok(r.problems.some(p => /^cancelled 2 in .*pending\.test\.mjs$/.test(p)), `${name}: ${JSON.stringify(r.problems)}`);
  }
});

test('Node 24: a file cut off mid-run and a timed-out test are cancelled, not failed, and both FAIL', () => {
  const file = evaluateLogs({logs: [{script: 'test:proof', text: fx('node24-file-cancelled.spec.log')}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0];
  assert.equal(file.verdict, FAIL);
  assert.ok(file.problems.some(p => /cancelled 1 in pending\.test\.mjs/.test(p)), JSON.stringify(file.problems));
  const t = evaluateLogs({logs: [{script: 'test:proof', text: fx('node24-timeout.spec.log')}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0];
  assert.equal(t.verdict, FAIL);
  assert.equal(t.counts.fail, 0);
  assert.ok(t.problems.some(p => /cancelled 1 in pending2\.test\.mjs/.test(p)), JSON.stringify(t.problems));
  assert.ok(t.notes.some(n => /test timed out after 300ms/.test(n)));
});

test('a skipped test in a real-bwrap suite: FAIL where bwrap works, UNVERIFIED where it does not -- never PASS', () => {
  // The recorded spec run has one skip, `skips`, reason "bwrap unavailable: nope", in pass.test.mjs. Strip the
  // cancellation so the skip is the only open question.
  const text = fx('node22-cancelled.spec.log').replace(/ℹ cancelled 2/, 'ℹ cancelled 0').replace(/✖ failing tests:[\s\S]*$/, '');
  const gated = ['/work/fx/pass.test.mjs'];
  const works = evaluateLogs({logs: [{script: 'test:proof', text}], suites: oneSuite(), gated, bwrap: WORKS, read})[0];
  assert.equal(works.verdict, FAIL);
  assert.ok(works.problems.some(p => /real-bwrap suite skipped a test: skips -- bwrap unavailable: nope \[.*work\/fx\/pass\.test\.mjs\] \(bwrap works here/.test(p)), JSON.stringify(works.problems));
  const broken = evaluateLogs({logs: [{script: 'test:proof', text}], suites: oneSuite(), gated, bwrap: BROKEN, read})[0];
  assert.equal(broken.verdict, UNVERIFIED);
  assert.deepEqual(broken.problems, []);
  assert.match(broken.unverified[0], /bwrap does not work here/);
  // The same skip in a suite file that is NOT a real-bwrap suite is a note, not a failure.
  const plain = evaluateLogs({logs: [{script: 'test:proof', text}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0];
  assert.equal(plain.verdict, PASS, 'the file is identified and is not a real-bwrap suite: its reason does not matter');
  assert.match(plain.notes.join('\n'), /skipped \(not a real-bwrap suite\): skips/);
});

test('a skip the log cannot tie to a file is a real-bwrap skip when its reason names bwrap', () => {
  const text = '﹣ somewhere (0.1ms) # bwrap unavailable: x\nℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\n';
  const r = evaluateLogs({logs: [{script: 'test:proof', text}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0];
  assert.equal(r.verdict, FAIL);
  const other = text.replace('bwrap unavailable: x', 'OPHANIM_TELOS_ROOT not set');
  assert.equal(evaluateLogs({logs: [{script: 'test:proof', text: other}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0].verdict, PASS);
});

test('a recorded passing Node 24 `npm test` run PASSES, every package suite found by its npm header', () => {
  const ss = ['@argo/model-client', '@argo/ledger', 'pantheon'].map(pkg => ({id: `test:${pkg}`, label: `test: ${pkg} test`, script: 'test', pkg, cwd: '/x', files: [], flags: [], patterns: []}));
  const rs = evaluateLogs({logs: [{script: 'npm test', text: fx('npm-test-node24-pass.spec.log')}], suites: ss, gated: [], bwrap: WORKS, read});
  assert.deepEqual(rs.map(r => [r.suite, r.verdict, r.counts.tests]), [['test: @argo/model-client test', PASS, 62], ['test: @argo/ledger test', PASS, 47], ['test: pantheon test', PASS, 1395]]);
  // A package whose segment never printed a summary (the run stopped) FAILS rather than vanishing.
  const cut = fx('npm-test-node24-pass.spec.log').replace(/> pantheon@[\s\S]*$/, '> pantheon@0.0.0 test\n> node --test --test-concurrency=2\n');
  const r = evaluateLogs({logs: [{script: 'npm test', text: cut}], suites: ss, gated: [], bwrap: WORKS, read});
  assert.deepEqual(r.map(x => x.verdict), [PASS, PASS, FAIL]);
  assert.match(r[2].problems[0], /no node:test summary/);
});

test('mixed reporters in one log: a TAP package and a spec package are each read on their own', () => {
  const tap = fx('node22-cancelled.tap.log'), spec = fx('npm-test-node24-pass.spec.log').split('> @argo/ledger@')[0];
  const text = `${spec}> @argo/ledger@0.1.0 test\n> node --test tests/*.test.mjs\n${tap}`;
  const segs = parseLog(text).filter(s => s.counts);
  assert.deepEqual(segs.map(s => [s.header.pkg, s.format, s.counts.cancelled]), [['@argo/model-client', 'spec', 0], ['@argo/ledger', 'tap', 2]]);
  const ss = ['@argo/model-client', '@argo/ledger'].map(pkg => ({id: pkg, label: pkg, script: 'test', pkg, cwd: '/x', files: [], flags: [], patterns: []}));
  assert.deepEqual(evaluateLogs({logs: [{script: 'npm test', text}], suites: ss, gated: [], bwrap: WORKS, read}).map(r => r.verdict), [PASS, FAIL]);
});

test('a log for an unknown suite script, or an empty log, FAILS', () => {
  assert.equal(evaluateLogs({logs: [{script: 'nope', text: ''}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0].verdict, FAIL);
  assert.equal(evaluateLogs({logs: [{script: 'test:proof', text: ''}], suites: oneSuite(), gated: [], bwrap: WORKS, read})[0].verdict, FAIL);
});

// Inside a test file NODE_TEST_CONTEXT is set; a nested `node --test` that inherits it reports to this run, not to
// its own reporters.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
// ---- exact mode: real node:test runs of the live fixtures through events-reporter.mjs ----
function runLive(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-self-'));
  const ev = path.join(dir, 'e.jsonl');
  const abs = files.map(f => path.join(FX, 'live', f));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(HERE, 'events-reporter.mjs')}`, `--test-reporter-destination=${ev}`, ...abs], {encoding: 'utf8', timeout: 60_000, env: CLEAN_ENV});
  const events = readEvents(fs.readFileSync(ev, 'utf8'));
  fs.rmSync(dir, {recursive: true, force: true});
  return {events, files: abs, exit: r.status};
}
const SUITE = {label: 'live'};

test('exact mode: a passing file PASSES; a timed-out test is a cancellation attributed to its file and line', () => {
  const ok = runLive(['pass.fixture.mjs']);
  assert.equal(evaluateEvents({suite: SUITE, ...ok, gated: [], bwrap: WORKS}).verdict, PASS);
  const to = runLive(['pass.fixture.mjs', 'timeout.fixture.mjs']);
  const r = evaluateEvents({suite: SUITE, ...to, gated: [], bwrap: WORKS});
  assert.equal(r.verdict, FAIL);
  assert.equal(r.counts.fail, 0, 'node:test itself reports fail 0');
  assert.match(r.problems.join('\n'), /cancelled 1 in scripts\/test-gates\/fixtures\/live\/timeout\.fixture\.mjs/);
  assert.match(r.notes.join('\n'), /fixture times out at .*timeout\.fixture\.mjs:3 -- testTimeoutFailure/);
});

test('exact mode: the skip is attributed to its file -- FAIL with bwrap working, UNVERIFIED without, a note when the file is not real-bwrap', () => {
  const run = runLive(['bwrap-skip.fixture.mjs']);
  const gated = [path.join(FX, 'live', 'bwrap-skip.fixture.mjs')];
  assert.equal(evaluateEvents({suite: SUITE, ...run, gated, bwrap: WORKS}).verdict, FAIL);
  const u = evaluateEvents({suite: SUITE, ...run, gated, bwrap: BROKEN});
  assert.equal(u.verdict, UNVERIFIED);
  assert.match(u.unverified[0], /fixture runs under bwrap -- bwrap unavailable: fixture \[scripts\/test-gates\/fixtures\/live\/bwrap-skip\.fixture\.mjs\]/);
  const n = evaluateEvents({suite: SUITE, ...run, gated: [], bwrap: WORKS});
  assert.equal(n.verdict, PASS);
  assert.match(n.notes[0], /skipped \(not a real-bwrap suite\)/);
});

test('exact mode: a file that exits mid-run loses tests from every count; the gate FAILS on its missing result', () => {
  const run = runLive(['pass.fixture.mjs', 'exits.fixture.mjs']);
  const r = evaluateEvents({suite: SUITE, ...run, gated: [], bwrap: WORKS});
  assert.equal(r.verdict, FAIL);
  assert.match(r.problems.join('\n'), /no result for scripts\/test-gates\/fixtures\/live\/exits\.fixture\.mjs/);
});

// ---- the designated list, the probe, the suites ----
test('real-bwrap suites are derived from source: a file gated on the bwrap probe is in, a file naming bwrap without it is ungated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-derive-'));
  const call = ['sandbox', 'Available("bw', 'rap")'].join(''); // kept out of this file's own source
  const a = path.join(dir, 'a.test.mjs'), b = path.join(dir, 'b.test.mjs'), c = path.join(dir, 'c.test.mjs');
  fs.writeFileSync(a, `const have = await ${call};`);
  fs.writeFileSync(b, 'assert.equal(argv[0], "bwrap");');
  fs.writeFileSync(c, 'test("x", () => {});');
  assert.ok(GATE.test(`await ${call}`));
  assert.deepEqual(designated([a, b, c]), {gated: [a], ungated: [b]});
  const base = path.join(dir, 'base.json');
  fs.writeFileSync(base, JSON.stringify({gated: ['old.test.mjs']}));
  assert.deepEqual(baselineDrift([path.join(dir, 'new.test.mjs')], {root: dir, baseline: base}), {now: ['new.test.mjs'], new: ['new.test.mjs'], gone: ['old.test.mjs'], baseline: 'base.json'});
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the bwrap probe runs bwrap and records what happened; a missing binary is "does not work", never assumed', () => {
  const missing = probeBwrap({bin: '/nonexistent/bwrap'});
  assert.equal(missing.works, false);
  assert.match(missing.error, /ENOENT/);
  assert.equal(probeBwrap({bin: '/bin/false'}).works, false);
  const real = probeBwrap();
  assert.equal(typeof real.works, 'boolean');
  assert.equal(real.command, 'bwrap --ro-bind / / true');
});

test('every suite CI runs is enumerated from package.json, every test file is in a suite, every workflow test command is known', () => {
  const cov = coverage();
  assert.deepEqual(cov.problems, []);
  assert.deepEqual(cov.orphans, []);
  assert.deepEqual(cov.suites.map(s => s.id), ['test:@argo/model-client', 'test:@argo/ledger', 'test:pantheon', 'test:proof', 'test:gates:self']);
  for (const s of cov.suites) assert.ok(s.files.length > 0, s.id);
  assert.ok(suites().find(s => s.id === 'test:pantheon').flags.includes('--test-concurrency=2'));
  assert.throws(() => parseNodeTest('node --test a.mjs; rm -rf x', 'x'), /shell syntax/);
  assert.throws(() => parseNodeTest('vitest run', 'x'), /not a `node --test` command/);
  const q = fs.readFileSync(path.join(ROOT, '.github/workflows/qualification.yml'), 'utf8');
  assert.match(q, /scripts\/test-gates\/check\.mjs logs/);
  assert.match(q, /npm run test:gates -- --only real-bwrap/);
});
