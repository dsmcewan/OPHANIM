// The test-result gate's own tests: what would falsify it. Recorded outputs (fixtures/*.log, from real Node 22 and
// Node 24 runs) for the log reader; live runs of fixtures/live/*.fixture.mjs through the events reporter for the
// exact mode; and, for L-505/L-506, fixture repositories judged by a copy of the gate through CI's own steps (run mode
// and log mode as qualification.yml runs them). Each case says what the gate must decide and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseLog} from './parse-log.mjs';
import * as gate from './check.mjs';
import {evaluateLogs, evaluateEvents, readEvents, PASS, FAIL, UNVERIFIED} from './check.mjs';
import {designated, probeBwrap, baselineDrift, GATE} from './real-bwrap.mjs';
import * as suitesModule from './suites.mjs';
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

test('exact mode: a file that registers no test FAILS (Node reports it as one passing test); a summary counting unreported tests FAILS', () => {
  const none = runLive(['pass.fixture.mjs', 'no-tests.fixture.mjs']);
  assert.equal(none.exit, 0, 'node:test is content with a file that ran nothing');
  const r = evaluateEvents({suite: SUITE, ...none, gated: [], bwrap: WORKS});
  assert.equal(r.verdict, FAIL);
  // Observed on Node 24.22.1: tests 2, pass 2 -- the empty file is counted as one passing test named after itself.
  assert.equal(none.events.find(e => e.type === 'summary' && !e.file).counts.passed, 2);
  assert.match(r.problems.join('\n'), /no result for scripts\/test-gates\/fixtures\/live\/no-tests\.fixture\.mjs: .* or registered no test at all/);
  // A reporter (or a stream) that lost a test's event: the file's own summary still counts it.
  const ok = runLive(['pass.fixture.mjs']);
  const lost = ok.events.filter(e => e.type !== 'test');
  const m = evaluateEvents({suite: SUITE, ...ok, events: lost, gated: [], bwrap: WORKS});
  assert.equal(m.verdict, FAIL);
  assert.match(m.problems.join('\n'), /pass\.fixture\.mjs: its summary counts 1 test\(s\) but 0 were reported/);
  // node:test's own totals stay authoritative: a failure it counted FAILS even if every event reads `pass` (and the
  // runner's exit code is not there to fall back on).
  const thrown = runLive(['timer-throw.fixture.mjs']);
  assert.equal(thrown.events.find(e => e.type === 'summary' && !e.file).counts.failed, 1);
  const relabelled = thrown.events.map(e => (e.type === 'test' ? {...e, status: 'pass', failureType: undefined} : e));
  const t = evaluateEvents({suite: SUITE, ...thrown, events: relabelled, exit: 0, gated: [], bwrap: WORKS});
  assert.equal(t.verdict, FAIL);
  assert.match(t.problems.join('\n'), /the run summary counts failed 1, the events show 0/);
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
  // The knowledge-graph foundation's suite (packages/graph, registered in the root test script by Slice A) is acknowledged here.
  assert.deepEqual(cov.suites.map(s => s.id), ['test:@argo/model-client', 'test:@argo/ledger', 'test:@argo/graph', 'test:pantheon', 'test:proof', 'test:gates:self']);
  for (const s of cov.suites) assert.ok(s.files.length > 0, s.id);
  assert.ok(suites().find(s => s.id === 'test:pantheon').flags.includes('--test-concurrency=2'));
  assert.throws(() => parseNodeTest('node --test a.mjs; rm -rf x', 'x'), /shell syntax/);
  assert.throws(() => parseNodeTest('vitest run', 'x'), /not a `node --test` command/);
  const q = fs.readFileSync(path.join(ROOT, '.github/workflows/qualification.yml'), 'utf8');
  assert.match(q, /scripts\/test-gates\/check\.mjs logs/);
  // L-506: run mode over EVERY suite in CI (a mid-file exit is visible per file only), not just the real-bwrap files.
  assert.match(q, /npm run test:gates -- \\\n\s+--json/);
  assert.doesNotMatch(q, /test:gates -- --only/);
  // L-505: the suites that npm runs carry a per-test timeout where the root script can give one.
  for (const id of ['test:pantheon', 'test:proof', 'test:gates:self']) assert.ok(suites().find(s => s.id === id).flags.includes('--test-timeout=120000'), id);
});

test('coverage FAILS a workflow that runs the gate on real-bwrap files only, drops a step bound, or overrides the gate bounds', () => {
  const q = fs.readFileSync(path.join(ROOT, '.github/workflows/qualification.yml'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-wf-'));
  const check = yml => { fs.mkdirSync(path.join(dir, '.github/workflows'), {recursive: true}); fs.writeFileSync(path.join(dir, '.github/workflows/qualification.yml'), yml);
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json')); return suitesModule.qualificationBounds(dir); };
  try {
    assert.deepEqual(check(q), []);
    assert.match(check(q.replace('npm run test:gates -- \\', 'npm run test:gates -- --only real-bwrap \\')).join('\n'), /does not run over every suite/);
    assert.match(check(q.replace(/(- name: npm test\n(?:.*\n)*?)\s+timeout-minutes: \d+\n/, '$1')).join('\n'), /step running "test" has no timeout-minutes/);
    // The gate step bounded at the job's own limit FAILS (both read from the workflow, so a change of either number
    // keeps this check).
    const jobMin = /^\s{4}timeout-minutes:\s*(\d+)/m.exec(q)[1];
    const atJob = q.replace(/(- name: Test gate, every suite[^\n]*\n(?:.*\n)*?\s+timeout-minutes: )\d+/, `$1${jobMin}`);
    assert.notEqual(atJob, q, 'the gate step has a bound of its own to raise');
    assert.match(check(atJob).join('\n'), new RegExp(`step running "test:gates" may run ${jobMin} minutes, not below the job's ${jobMin}`));
    assert.match(check(q.replace('--out "$RUNNER_TEMP/test-gate-run"', '--out "$RUNNER_TEMP/test-gate-run" --file-timeout 99999')).join('\n'), /overrides the gate's per-test or per-file bound/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Through the gate's own entry point: a loosened workflow turns its verdict to FAIL (exit 1), a sound one does not.
  const repo = fixtureRepo();
  try {
    const verdictFor = yml => {
      fs.writeFileSync(path.join(repo, '.github/workflows/qualification.yml'), yml);
      const json = path.join(repo, 'cov.json');
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts/test-gates/check.mjs'), 'logs', '--json', json], {cwd: repo, env: CLEAN_ENV, encoding: 'utf8', timeout: 60_000});
      return {status: r.status, problems: JSON.parse(fs.readFileSync(json, 'utf8')).coverage.problems};
    };
    assert.deepEqual(verdictFor(q), {status: 0, problems: []});
    const loose = verdictFor(q.replace('npm run test:gates -- \\', 'npm run test:gates -- --only real-bwrap \\'));
    assert.equal(loose.status, 1);
    assert.match(loose.problems.join('\n'), /does not run over every suite/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('L-503: coverage FAILS a workflow whose test-lint step stops enforcing -- report-only, its exit status discarded, disabled, narrowed to some paths, or a test:lint that is not the lint', () => {
  const q = fs.readFileSync(path.join(ROOT, '.github/workflows/qualification.yml'), 'utf8');
  const realScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const LINT_RUN = 'npm run --silent test:lint -- --enforce --json "$RUNNER_TEMP/test-lint.json" >> "$GITHUB_STEP_SUMMARY"';
  assert.ok(q.includes(`run: ${LINT_RUN}\n`), 'the lint step as this test edits it');
  assert.equal(realScripts['test:lint'], 'node scripts/test-gates/lint-tests.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lint-wf-'));
  const check = (yml, scripts = {}) => {
    fs.mkdirSync(path.join(dir, '.github/workflows'), {recursive: true});
    fs.writeFileSync(path.join(dir, '.github/workflows/qualification.yml'), yml);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({scripts: {...realScripts, ...scripts}}));
    return suitesModule.qualificationBounds(dir).join('\n');
  };
  const run = text => q.replace(`run: ${LINT_RUN}\n`, () => text);
  try {
    assert.equal(check(q), '');
    // Back to report-only (the step as it was before L-503 was enforced): FAIL.
    assert.match(check(q.replace(LINT_RUN, LINT_RUN.replace('-- --enforce ', '-- '))), /:\d+: the test-lint step does not pass --enforce: it is report-only/);
    assert.match(check(q.replace(LINT_RUN, 'npm run --silent test:lint >> "$GITHUB_STEP_SUMMARY"')), /does not pass --enforce/);
    // Enforcement carried by the script itself is enforcement; a test:lint that is not the lint is not.
    assert.equal(check(q.replace(LINT_RUN, LINT_RUN.replace('-- --enforce ', '-- ')), {'test:lint': 'node scripts/test-gates/lint-tests.mjs --enforce'}), '');
    for (const other of ['node -e 0', 'true', 'echo node scripts/test-gates/lint-tests.mjs']) {
      assert.match(check(q, {'test:lint': other}), /the "test:lint" script .* is not `node scripts\/test-gates\/lint-tests\.mjs \.\.\.`/, other);
    }
    // Enforcing on part of the repository only is not enforcing the lint.
    assert.match(check(q.replace(LINT_RUN, LINT_RUN.replace('--enforce ', '--enforce scripts '))), /the test-lint step names scripts: the lint must run over the whole repository/);
    assert.match(check(q, {'test:lint': 'node scripts/test-gates/lint-tests.mjs --enforce ophanim scripts'}), /the "test:lint" script names ophanim scripts/);
    assert.equal(check(q.replace(LINT_RUN, `${LINT_RUN} 2>&1`), {'test:lint': 'node scripts/test-gates/lint-tests.mjs --json x.json'}), '', 'flags and redirections are not paths');
    // Its exit status discarded: FAIL, whatever form the discarding takes.
    for (const after of [' || true', ' || :', ' || echo "lint failed"', ' | tee "$RUNNER_TEMP/lint.txt"', '; exit 0', ' && echo done', ' &']) {
      assert.match(check(q.replace(LINT_RUN, LINT_RUN + after)), /may discard the lint's exit status/, after);
    }
    assert.match(check(run(`run: |\n          set +e\n          ${LINT_RUN}\n`)), /turns off errexit/);
    assert.match(check(run(`continue-on-error: true\n        run: ${LINT_RUN}\n`)), /has continue-on-error/);
    assert.match(check(q.replace(/(- name: Test lint[^\n]*\n\s+)if: always\(\)/, '$1if: false')), /never runs \(if: false\)/);
    assert.match(check(q.replace(/\n\s+- name: Test lint[^\n]*\n(?:\s{8}.*\n)+/, '\n')), /no step runs `npm run test:lint`/);
    // The forms that keep the status pass: the status captured and re-raised, a continued line, a folded block.
    assert.equal(check(run(`run: |\n          status=0\n          ${LINT_RUN} || status=$?\n          echo "lint exit $status"\n          exit $status\n`)), '');
    assert.match(check(run(`run: |\n          status=0\n          ${LINT_RUN} || status=$?\n          exit 0\n`)), /may discard the lint's exit status/);
    assert.equal(check(run(`run: |\n          npm run --silent test:lint -- \\\n            --enforce --json "$RUNNER_TEMP/test-lint.json" >> "$GITHUB_STEP_SUMMARY"\n`)), '');
    assert.match(check(run(`run: |\n          npm run --silent test:lint -- \\\n            --json "$RUNNER_TEMP/test-lint.json" >> "$GITHUB_STEP_SUMMARY"\n`)), /does not pass --enforce/);
    assert.equal(check(run(`run: >-\n          npm run --silent test:lint -- --enforce\n          --json "$RUNNER_TEMP/test-lint.json"\n`)), '');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Through the gate's own entry point: the report-only lint step turns the gate's verdict to FAIL (exit 1).
  const repo = fixtureRepo();
  try {
    const json = path.join(repo, 'cov.json');
    const verdict = yml => {
      fs.writeFileSync(path.join(repo, '.github/workflows/qualification.yml'), yml);
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts/test-gates/check.mjs'), 'logs', '--json', json], {cwd: repo, env: CLEAN_ENV, encoding: 'utf8', timeout: 60_000});
      return {status: r.status, problems: JSON.parse(fs.readFileSync(json, 'utf8')).coverage.problems.join('\n')};
    };
    assert.deepEqual(verdict(q), {status: 0, problems: ''});
    const reportOnly = verdict(q.replace(LINT_RUN, LINT_RUN.replace('-- --enforce ', '-- ')));
    assert.equal(reportOnly.status, 1);
    assert.match(reportOnly.problems, /the test-lint step does not pass --enforce/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// ---- L-505 / L-506 falsifiers through the real entry points, as CI runs them ----
// A disposable repository holds a copy of the gate (scripts/test-gates/*.mjs) and of qualification.yml, and suites of
// real test files that hang, exit, crash or are killed. The gate finds its root from its own location, so the copy
// judges the fixture repository exactly as the original judges this one. Each CI step is taken from the copied
// qualification.yml and run as GitHub runs it (bash -eo pipefail, RUNNER_TEMP, GITHUB_STEP_SUMMARY); a step's
// timeout-minutes is emulated by killing its process group after STEP_LIMIT_MS -- a step without one would run to the
// job's timeout, which is exactly L-505, so the test refuses to wait for it.
const GATE_FILES = ['check.mjs', 'events-reporter.mjs', 'parse-log.mjs', 'suites.mjs', 'real-bwrap.mjs', 'lint-tests.mjs'];
const STEP_LIMIT_MS = 15_000;
const LIVE = path.join(FX, 'live');
const BOUNDS = {OPHANIM_GATE_FILE_TIMEOUT_S: '5', OPHANIM_GATE_TEST_TIMEOUT_MS: '1500'};

function fixtureRepo({pkg = ['pass.fixture.mjs'], proof = ['pass.fixture.mjs']} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-repo-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), {recursive: true}); fs.writeFileSync(path.join(repo, rel), text); };
  for (const f of GATE_FILES) put(`scripts/test-gates/${f}`, fs.readFileSync(path.join(HERE, f), 'utf8'));
  put('.github/workflows/qualification.yml', fs.readFileSync(path.join(ROOT, '.github/workflows/qualification.yml'), 'utf8'));
  put('package.json', JSON.stringify({name: 'gate-fixture-repo', version: '0.0.0', private: true, type: 'module', scripts: {
    test: 'npm --prefix pkg test',
    'test:proof': 'node --test --test-timeout=1500 proof/*.fixture.mjs',
    'test:gates': 'node scripts/test-gates/check.mjs run',
    'test:gates:self': 'node --test self/*.fixture.mjs',
    'test:lint': 'node scripts/test-gates/lint-tests.mjs',
  }}, null, 2));
  // Like packages/model-client: the package script names its files, so no per-test timeout reaches it from the root.
  put('pkg/package.json', JSON.stringify({name: 'fx-pkg', version: '0.0.0', private: true, type: 'module', scripts: {test: 'node --test test/*.fixture.mjs'}}));
  for (const f of pkg) put(`pkg/test/${f}`, fs.readFileSync(path.join(LIVE, f), 'utf8'));
  for (const f of proof) put(`proof/${f}`, fs.readFileSync(path.join(LIVE, f), 'utf8'));
  // A real-bwrap-designated file (the gate reads the probe call from source) that never skips: CI's real-bwrap rerun
  // always has something to run, as in this repository.
  put('proof/gated.fixture.mjs', "import test from 'node:test';\n// designated like the real suites: sandboxAvailable(\"bwrap\") -- this fixture never skips\ntest('fixture gated passes', () => {});\n");
  put('self/pass.fixture.mjs', fs.readFileSync(path.join(LIVE, 'pass.fixture.mjs'), 'utf8'));
  return repo;
}

/** The steps of a workflow (kept here, not imported, so these tests also run against an older gate). */
function stepsOf(yml) {
  const out = [];
  let ind = null, cur = null;
  for (const line of yml.split('\n')) {
    const m = /^(\s*)- /.exec(line);
    if (m && (ind === null || m[1].length === ind) && (ind !== null || out.length === 0)) { ind = m[1].length; cur = {text: line}; out.push(cur); continue; }
    if (cur && (!line.trim() || /^\s*/.exec(line)[0].length > ind)) cur.text += `\n${line}`; else cur = null;
  }
  return out;
}

/** The `run:` script of the first step whose text contains `needle`, and its timeout-minutes. */
function ciStep(repo, needle) {
  const yml = fs.readFileSync(path.join(repo, '.github/workflows/qualification.yml'), 'utf8');
  const step = stepsOf(yml).find(s => s.text.split('\n').some(l => !/^\s*#/.test(l) && l.includes(needle)));
  assert.ok(step, `qualification.yml has a step running ${needle}`);
  const lines = step.text.split('\n');
  const i = lines.findIndex(l => /^\s*run:/.test(l));
  const head = lines[i].replace(/^\s*run:\s*/, '');
  let script;
  if (head === '|' || head === '>-') {
    const body = lines.slice(i + 1).filter(l => l.trim());
    const ind = Math.min(...body.map(l => /^\s*/.exec(l)[0].length));
    const block = [];
    for (const l of lines.slice(i + 1)) { if (l.trim() && /^\s*/.exec(l)[0].length < ind) break; block.push(l.slice(ind)); }
    script = head === '|' ? block.join('\n') : block.map(l => l.trim()).filter(Boolean).join(' ');
  } else script = head;
  const t = /^\s*timeout-minutes:\s*(\d+)/m.exec(step.text);
  return {script, timeoutMinutes: t ? Number(t[1]) : null};
}

/** Run one CI step's script as GitHub does. Resolves {code, ms, killed, summary}. */
function runStep(repo, needle, {env = {}} = {}) {
  const {script, timeoutMinutes} = ciStep(repo, needle);
  const temp = path.join(repo, '.runner-temp');
  fs.mkdirSync(temp, {recursive: true});
  const summary = path.join(temp, 'step-summary.md');
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {cwd: repo, detached: true, stdio: 'ignore',
      env: {...CLEAN_ENV, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, ...env}});
    let killed = false;
    // No timeout-minutes: GitHub would let the step run to the job's own limit. Give it the same short limit so the
    // test ends, and report that the step was unbounded.
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, STEP_LIMIT_MS);
    child.on('exit', () => { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    child.on('close', code => resolve({code, ms: Date.now() - t0, killed, timeoutMinutes, temp}));
  });
}
const gateRecord = (temp, name) => JSON.parse(fs.readFileSync(path.join(temp, name), 'utf8'));
const byLabel = (rec, label) => rec.results.find(r => r.suite === label) ?? assert.fail(`no result for ${label}: ${rec.results.map(r => r.suite)}`);

test('L-505/L-506 run mode as CI runs it: every hung, exited, crashed and killed file FAILS, named, within the bounds', async () => {
  const repo = fixtureRepo({
    pkg: ['pass.fixture.mjs', 'open-handle.fixture.mjs', 'hang-handle.fixture.mjs', 'exit1.fixture.mjs', 'killed.fixture.mjs', 'exits.fixture.mjs'],
    proof: ['pass.fixture.mjs', 'hang-test.fixture.mjs', 'exit0-sync.fixture.mjs', 'describe-throws.fixture.mjs', 'timer-throw.fixture.mjs'],
  });
  try {
    const step = await runStep(repo, 'npm run test:gates', {env: BOUNDS});
    // CI's step: bounded, and the gate ends it itself (no kill from the step limit), with exit 1 (FAIL).
    assert.ok(step.timeoutMinutes && step.timeoutMinutes < 25, 'the run-mode step has its own timeout-minutes');
    assert.equal(step.killed, false, 'the gate finished by itself within the per-file bounds');
    assert.equal(step.code, 1);
    const rec = gateRecord(step.temp, 'test-gate-run.json');
    assert.equal(rec.mode, 'run', 'CI runs run mode over every suite, not --only real-bwrap');
    const pkg = byLabel(rec, 'test: fx-pkg test'), proof = byLabel(rec, 'test:proof');
    assert.equal(pkg.verdict, FAIL);
    assert.equal(proof.verdict, FAIL);
    assert.equal(byLabel(rec, 'test:gates:self').verdict, PASS);
    const P = pkg.problems.join('\n'), Q = proof.problems.join('\n'), N = proof.notes.join('\n') + '\n' + pkg.notes.join('\n');
    // L-505: an open handle after every test passed -- the watchdog kills the file and names it.
    assert.match(P, /hung: pkg\/test\/open-handle\.fixture\.mjs did not finish within 5s; the gate killed its process group; node:test does not report the test in progress \(last test to finish: fixture passes last/);
    // L-505: a never-settling test holding a handle -- the test is named (per-test timeout), the file killed.
    assert.match(P, /hung: pkg\/test\/hang-handle\.fixture\.mjs did not finish within 5s; .*timed out \(named by node:test\): fixture hangs holding a handle at pkg\/test\/hang-handle\.fixture\.mjs:5/);
    // L-505: a never-settling test without a handle -- cancelled by name, the file carries on.
    assert.match(Q, /cancelled 1 in proof\/hang-test\.fixture\.mjs/);
    assert.match(N, /cancelled: fixture hangs forever at proof\/hang-test\.fixture\.mjs:5 -- testTimeoutFailure/);
    // L-506: exits and kills, each attributed to its file.
    assert.match(P, /no result for pkg\/test\/exits\.fixture\.mjs: the file did not report a summary of its own .*the last: fixture first; runner exit 0/);
    assert.match(Q, /no result for proof\/exit0-sync\.fixture\.mjs: the file did not report a summary of its own/);
    assert.match(P, /fail \d+ in .*pkg\/test\/exit1\.fixture\.mjs/);
    assert.match(P, /fail \d+ in .*pkg\/test\/killed\.fixture\.mjs/);
    assert.match(Q, /suite failed \(node:test does not count it under fail\): fixture group that throws at proof\/describe-throws\.fixture\.mjs:5/);
    assert.match(N, /fail: fixture timer throws at proof\/timer-throw\.fixture\.mjs:4 -- uncaughtException/);
    // Nothing the watchdog killed is left running.
    for (const f of ['open-handle', 'hang-handle']) {
      const ps = spawnSync('pgrep', ['-f', path.join(repo, `pkg/test/${f}.fixture.mjs`)], {encoding: 'utf8'});
      assert.equal(ps.stdout.trim(), '', `${f}: no process left`);
    }
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('L-505/L-506 log mode as CI runs it: each npm step is bounded, a hung package suite and an uncounted failure FAIL', async () => {
  const repo = fixtureRepo({
    pkg: ['pass.fixture.mjs', 'open-handle.fixture.mjs'],
    proof: ['pass.fixture.mjs', 'hang-test.fixture.mjs', 'describe-throws.fixture.mjs'],
  });
  try {
    const npmTest = await runStep(repo, 'npm test 2>&1');
    // L-505: the open handle hangs `npm test`; only the step's own timeout ends it before the job's.
    assert.ok(npmTest.timeoutMinutes && npmTest.timeoutMinutes < 25, 'the npm test step has a timeout-minutes below the job');
    assert.equal(npmTest.killed, true, 'npm test hangs on the open handle until its step limit');
    const proofStep = await runStep(repo, 'npm run test:proof 2>&1');
    assert.ok(proofStep.timeoutMinutes && proofStep.timeoutMinutes < 25);
    assert.equal(proofStep.killed, false, 'the per-test timeout of test:proof ends the never-settling test by itself');
    const self = await runStep(repo, 'npm run test:gates:self 2>&1');
    assert.equal(self.code, 0);
    const logs = await runStep(repo, 'check.mjs logs');
    assert.equal(logs.code, 1);
    const rec = gateRecord(logs.temp, 'test-gate-logs.json');
    const pkg = byLabel(rec, 'test: fx-pkg test'), proof = byLabel(rec, 'test:proof');
    assert.equal(pkg.verdict, FAIL);
    assert.match(pkg.problems.join('\n'), /no node:test summary for this suite in the log/);
    assert.equal(proof.verdict, FAIL);
    const Q = proof.problems.join('\n');
    assert.match(Q, /cancelled 1 in proof\/hang-test\.fixture\.mjs/);
    // L-506: node:test says fail 0 for a describe() that threw while registering; the log still lists it.
    assert.equal(proof.counts.fail, 0);
    assert.match(Q, /the log lists 1 failure\(s\) but the summary counts fail 0: fixture group that throws at proof\/describe-throws\.fixture\.mjs:5:1 -- Error: fixture registration boom/);
    assert.equal(byLabel(rec, 'test:gates:self').verdict, PASS);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('L-506: a silent process.exit(0) in a file that is NOT real-bwrap FAILS in CI (run mode over every suite); its text log shows nothing', async () => {
  const repo = fixtureRepo({pkg: ['pass.fixture.mjs', 'exits.fixture.mjs']});
  try {
    const run = await runStep(repo, 'npm run test:gates', {env: BOUNDS});
    assert.equal(run.code, 1);
    const pkg = byLabel(gateRecord(run.temp, 'test-gate-run.json'), 'test: fx-pkg test');
    assert.equal(pkg.verdict, FAIL);
    assert.match(pkg.problems.join('\n'), /no result for pkg\/test\/exits\.fixture\.mjs/);
    // What the text log says about the same run: exit 0, fail 0, one test fewer -- nothing a log reader can see.
    const npmTest = await runStep(repo, 'npm test 2>&1');
    assert.equal(npmTest.code, 0, 'node:test exits 0 after process.exit(0) mid-file');
    const text = fs.readFileSync(path.join(npmTest.temp, 'npm-test.log'), 'utf8');
    assert.match(text, /ℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0/);
    assert.doesNotMatch(text, /fixture never runs/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('a clean fixture repository PASSES both gate steps as CI runs them (the bounds do not fail healthy files)', async () => {
  const repo = fixtureRepo();
  try {
    const run = await runStep(repo, 'npm run test:gates', {env: BOUNDS});
    assert.equal(run.code, 0, JSON.stringify(gateRecord(run.temp, 'test-gate-run.json').results.map(r => r.problems)));
    for (const s of ['npm test 2>&1', 'npm run test:proof 2>&1', 'npm run test:gates:self 2>&1']) assert.equal((await runStep(repo, s)).code, 0, s);
    const logs = await runStep(repo, 'check.mjs logs');
    assert.equal(logs.code, 0, JSON.stringify(gateRecord(logs.temp, 'test-gate-logs.json').results.map(r => r.problems)));
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('run mode bounds: the defaults are well below the 25-minute job, and the file bound exceeds every timeout a test declares', () => {
  assert.ok(gate.DEFAULT_TEST_TIMEOUT_MS <= 5 * 60_000, `per-test ${gate.DEFAULT_TEST_TIMEOUT_MS}ms`);
  assert.ok(gate.DEFAULT_FILE_TIMEOUT_S <= 6 * 60, `per-file ${gate.DEFAULT_FILE_TIMEOUT_S}s`);
  let maxDeclared = 0;
  for (const s of suites()) for (const f of s.files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\btimeout:\s*([\d_]+)\s*[,}]/g)) maxDeclared = Math.max(maxDeclared, Number(m[1].replace(/_/g, '')));
  assert.ok(maxDeclared > 0);
  assert.ok(gate.DEFAULT_FILE_TIMEOUT_S * 1000 > maxDeclared, `the file bound ${gate.DEFAULT_FILE_TIMEOUT_S}s must exceed the largest declared test timeout ${maxDeclared}ms`);
  assert.deepEqual(['--test-timeout=1', '--test-concurrency=3'].map(f => f.split('=')[0]), ['--test-timeout', '--test-concurrency']);
  assert.equal(gate.concurrencyOf(['--test-concurrency=2']), 2);
});

test('L-503 the test-lint step as CI runs it: an unsuppressed finding or a reasonless suppression FAILS the job, a reasoned one passes; the report and the JSON record are kept', async () => {
  const repo = fixtureRepo();
  try {
    const lintStep = async () => {
      const step = await runStep(repo, 'test:lint');
      const summary = fs.readFileSync(path.join(step.temp, 'step-summary.md'), 'utf8');
      const rec = JSON.parse(fs.readFileSync(path.join(step.temp, 'test-lint.json'), 'utf8'));
      fs.rmSync(step.temp, {recursive: true, force: true});
      return {code: step.code, killed: step.killed, summary, rec};
    };
    let s = await lintStep();
    assert.deepEqual([s.code, s.killed, s.rec.enforce], [0, false, true], s.summary);
    assert.match(s.summary, /## Test lint \(ENFORCING\) -- 0 finding\(s\)/);
    // A test that may be unable to fail (its sequence is cut): the step FAILS the job, and says where.
    fs.mkdirSync(path.join(repo, 'lintme'));
    const file = path.join(repo, 'lintme', 'seq.test.mjs'), body = 'assert.deepEqual(calls.slice(0, 2), ["a", "b"]);\n';
    fs.writeFileSync(file, body);
    s = await lintStep();
    assert.equal(s.code, 1, s.summary);
    assert.match(s.summary, /ENFORCING\) -- 1 finding\(s\)[\s\S]*lintme\/seq\.test\.mjs:1 {2}truncated-sequence {2}assert\.deepEqual\(calls\.slice/);
    assert.deepEqual(s.rec.findings.map(f => [f.file, f.line, f.rule, f.suppressed]), [['lintme/seq.test.mjs', 1, 'truncated-sequence', false]]);
    // A suppression without a specific reason does not suppress: still FAIL.
    fs.writeFileSync(file, `// test-lint: allow truncated-sequence -- intended\n${body}`);
    s = await lintStep();
    assert.equal(s.code, 1, s.summary);
    assert.match(s.summary, /lintme\/seq\.test\.mjs:2 {2}truncated-sequence \(suppression REJECTED: the reason "intended" has 1 word/);
    // A specific reason: the finding is suppressed, the job passes, and the summary keeps the finding with its reason.
    fs.writeFileSync(file, `// test-lint: allow truncated-sequence -- only the first two calls are the contract of this case\n${body}`);
    s = await lintStep();
    assert.equal(s.code, 0, s.summary);
    assert.match(s.summary, /lintme\/seq\.test\.mjs:2 {2}truncated-sequence \(suppressed: only the first two calls are the contract of this case\)/);
    assert.deepEqual(s.rec.findings.map(f => [f.suppressed, f.reason]), [[true, 'only the first two calls are the contract of this case']]);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});
