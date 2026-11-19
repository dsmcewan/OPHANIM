// The test lint's own tests: each rule fires on the shape the retrospective found, stays quiet on the sound shape
// next to it, and report-only mode exits 0 whatever it finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lintSource, blank, MIN_REASON_WORDS} from './lint-tests.mjs';

const LINT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lint-tests.mjs');
const rules = src => lintSource(src).filter(f => !f.suppressed).map(f => [f.line, f.rule]);

test('vacuous conditional assert: `if (x) assert(..x..)` fires; an else branch, or an assert on something else, does not', () => {
  assert.deepEqual(rules('const tier = r.tier;\nif (tier) assert.equal(tier, "fast");\n'), [[2, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (r?.tier !== undefined) {\n  assert.equal(r.tier, "fast");\n}\n'), [[1, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (tier) assert.equal(tier, "fast"); else assert.fail("no tier");\n'), []);
  assert.deepEqual(rules('if (verbose) assert.equal(count, 3);\n'), [], 'the condition is not the asserted value');
  assert.deepEqual(rules('if (a === b) assert.equal(a, 1);\n'), [], 'a comparison is not a presence test');
});

test('truncated sequence: .slice( inside deepEqual/equal, or through a variable, fires; slice elsewhere does not', () => {
  assert.deepEqual(rules('assert.deepEqual(calls.slice(0, 5), want);\n'), [[1, 'truncated-sequence']]);
  assert.deepEqual(rules('const head = seen.slice(0, 8);\nfoo();\nassert.deepStrictEqual(head, [1, 2]);\n'), [[3, 'truncated-sequence']]);
  assert.deepEqual(rules('const s = name.slice(1);\nassert.ok(s);\nassert.match(x.slice(2), /y/);\n'), [], 'ok/match are not sequence equality');
  assert.deepEqual(rules('assert.deepEqual(calls, want); // calls.slice(0, 5)\n'), [], 'a comment is not code');
  assert.deepEqual(rules('assert.equal(v.ok, true, JSON.stringify(v).slice(0, 2000));\n'), [], 'the message argument is not compared');
});

test('truncated sequence: each declarator of a declaration is its own -- the slice of one is not charged to another, nor missed', () => {
  // A false positive at 09bc5fb (ophanim/tests/runtime-boundaries.test.mjs): `context` was charged with the slice of
  // `specs`, its neighbour in the same `const`, and every assert on `context` in the file was flagged.
  assert.deepEqual(rules('const context = setup(), specs = all.slice(0, 2);\nassert.equal(context.effects.length, 0);\n'), []);
  // A false negative at 09bc5fb: only the first declarator was read, so a slice assigned to a later one was never seen.
  assert.deepEqual(rules('const n = 0, head = seen.slice(0, 2);\nassert.deepEqual(head, [1, 2]);\n'), [[2, 'truncated-sequence']]);
  assert.deepEqual(rules('let a = f(x, y), b = g([1, 2]);\nassert.deepEqual([a, b], [1, 2]);\n'), [], 'commas inside calls and arrays do not split a declarator');
  assert.deepEqual(rules('const {x} = o, ys = list.slice(1);\nassert.deepEqual(ys, [2]);\n'), [[2, 'truncated-sequence']], 'after a destructuring declarator');
});

test('scripted terminal status: a fixture returning a status the file asserts fires; an expected value inside the assert does not', () => {
  const src = 'const run = async () => {\n  return {status: "failed", why: "elapsed"};\n};\nassert.equal((await run()).status, "failed");\n';
  assert.deepEqual(rules(src), [[2, 'scripted-terminal-status']]);
  assert.deepEqual(rules('const f = () => ({status: "passed"});\nassert.equal(x.status, "failed");\n'), [], 'the asserted status is not the scripted one');
  assert.deepEqual(rules('assert.deepEqual(r, {status: "failed"});\n'), [], 'an expected object is not a fixture');
});

test('suppression: `test-lint: allow RULE -- reason` on the line or the line above marks the finding suppressed, still listed', () => {
  const f = lintSource('// test-lint: allow truncated-sequence -- the prefix is the contract\nassert.deepEqual(argv.slice(0, 3), ["a", "b", "c"]);\n');
  assert.deepEqual(f.map(x => [x.rule, x.suppressed, x.reason]), [['truncated-sequence', true, 'the prefix is the contract']]);
  const same = lintSource('assert.deepEqual(argv.slice(0, 3), ["a", "b", "c"]); // test-lint: allow truncated-sequence -- argv past three is checked below\n');
  assert.deepEqual(same.map(x => [x.suppressed, x.reason]), [[true, 'argv past three is checked below']]);
  const other = lintSource('// test-lint: allow scripted-terminal-status -- names another rule, not this one\nassert.deepEqual(argv.slice(0, 3), ["a"]);\n');
  assert.deepEqual(other.map(x => x.suppressed), [false], 'a suppression names the rule it suppresses');
});

test('suppression hygiene: no `-- reason`, or a reason under MIN_REASON_WORDS words, is REJECTED -- the finding stays unsuppressed', () => {
  assert.equal(MIN_REASON_WORDS, 5);
  const at = comment => lintSource(`${comment}\nassert.deepEqual(argv.slice(0, 3), ["a", "b", "c"]);\n`)[0];
  for (const [comment, why] of [
    ['// test-lint: allow truncated-sequence', /no `-- reason`/],
    ['// test-lint: allow truncated-sequence --', /has 0 word\(s\), fewer than 5/],
    ['// test-lint: allow truncated-sequence -- intended', /"intended" has 1 word\(s\)/],
    ['// test-lint: allow truncated-sequence -- ok, fixture', /has 2 word\(s\)/],
    ['// test-lint: allow truncated-sequence -- see the test below', /has 4 word\(s\)/],
    ['/* test-lint: allow truncated-sequence -- fixture */', /"fixture" has 1 word\(s\)/],
    ['// test-lint: allow truncated-sequence reason without the separator', /no `-- reason`/],
  ]) {
    const f = at(comment);
    assert.equal(f.suppressed, false, comment);
    assert.match(f.suppression_rejected, why, comment);
  }
  // Five words is a reason; a valid suppression on either line wins over a rejected one on the other.
  assert.equal(at('// test-lint: allow truncated-sequence -- the rest is checked below').suppressed, true);
  const both = lintSource('// test-lint: allow truncated-sequence -- the rest is checked below\nassert.deepEqual(argv.slice(0, 3), ["a"]); // test-lint: allow truncated-sequence\n')[0];
  assert.deepEqual([both.suppressed, both.suppression_rejected], [true, undefined]);
});

test('--enforce: a reasonless suppression fails like an unsuppressed finding, a reasoned one passes; the report lists both, with why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-supp-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'OPHANIM_TEST_LINT'));
  const lint = (...args) => spawnSync(process.execPath, [LINT, ...args], {encoding: 'utf8', env});
  try {
    const file = path.join(dir, 'x.test.mjs');
    fs.writeFileSync(file, '// test-lint: allow truncated-sequence -- ok\nassert.deepEqual(a.slice(0, 2), [1, 2]);\n');
    const json = path.join(dir, 'lint.json');
    const bare = lint('--enforce', '--json', json, dir);
    assert.equal(bare.status, 1, bare.stdout);
    assert.match(bare.stdout, /ENFORCING\) -- 1 finding\(s\)/);
    assert.match(bare.stdout, /x\.test\.mjs:2 {2}truncated-sequence \(suppression REJECTED: the reason "ok" has 1 word\(s\)/);
    assert.match(bare.stdout, /1 suppression\(s\) REJECTED for want of a specific reason/);
    const rec = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.deepEqual(rec.findings.map(f => [f.line, f.suppressed, Boolean(f.suppression_rejected)]), [[2, false, true]]);
    assert.equal(lint(dir).status, 0, 'report-only still exits 0');
    fs.writeFileSync(file, '// test-lint: allow truncated-sequence -- the first two are the contract; the rest is checked in y.test.mjs\nassert.deepEqual(a.slice(0, 2), [1, 2]);\n');
    const reasoned = lint('--enforce', dir);
    assert.equal(reasoned.status, 0, reasoned.stdout);
    assert.match(reasoned.stdout, /ENFORCING\) -- 0 finding\(s\)/);
    assert.match(reasoned.stdout, /x\.test\.mjs:2 {2}truncated-sequence \(suppressed: the first two are the contract; the rest is checked in y\.test\.mjs\)/);
    assert.match(reasoned.stdout, /\| truncated-sequence \| 0 \| 1 \|/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('blank() keeps positions and newlines and hides strings, comments and regex bodies', () => {
  const src = 'a("if (x) {", /}/); // }\nb`${"{"}`;\n';
  const b = blank(src);
  assert.equal(b.length, src.length);
  assert.equal(b.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(b, /[{}]/);
});

test('report-only exits 0 with findings and prints counts per rule; --enforce exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.test.mjs'), 'if (t) assert.ok(t.ok);\nassert.deepEqual(a.slice(0, 2), [1, 2]);\n');
    const r = spawnSync(process.execPath, [LINT, dir], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /report-only\) -- 2 finding\(s\) in 1 of 1 test file/);
    assert.match(r.stdout, /\| vacuous-conditional-assert \| 1 \| 0 \|/);
    assert.match(r.stdout, /\| truncated-sequence \| 1 \| 0 \|/);
    assert.match(r.stdout, /x\.test\.mjs:1 {2}vacuous-conditional-assert {2}if \(t\) assert\.ok\(t\.ok\);/);
    assert.equal(spawnSync(process.execPath, [LINT, '--enforce', dir], {encoding: 'utf8'}).status, 1);
    assert.equal(spawnSync(process.execPath, [LINT, dir], {encoding: 'utf8', env: {...process.env, OPHANIM_TEST_LINT: 'enforce'}}).status, 1);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
