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

// Refinements for the rule misreads the 3B-2 review found (each with the true case it must still catch). The shapes are
// those of pantheon/tests/agy-sandbox, context-chain, route-protocol, role-seating and route-task-profile at 09bc5fb.
test('truncated sequence, scope: a sliced variable taints its own block only -- a helper\'s `c` is not every `c` in the file', () => {
  const helper = 'const run = argv => new Promise(resolve => {\n  const c = spawn(argv[0], argv.slice(1));\n  c.on("close", resolve);\n});\n';
  assert.deepEqual(rules(`${helper}test("t", async () => {\n  const {c} = fake();\n  assert.equal(c.code, 0);\n});\n`), []);
  const tests = 'test("a", () => {\n  const v = check(A.slice(0, 2));\n  use(v);\n});\ntest("b", () => {\n  const v = check(A);\n  assert.equal(v.ok, true);\n});\n';
  assert.deepEqual(rules(tests), [], 'another test\'s `v`');
  // Still caught: in its block, in a nested block, from a closure written before the declaration, in either argument.
  assert.deepEqual(rules('test("a", () => {\n  const head = seen.slice(0, 2);\n  assert.deepEqual(head, [1, 2]);\n});\n'), [[3, 'truncated-sequence']]);
  assert.deepEqual(rules('test("a", () => {\n  const head = seen.slice(0, 2);\n  for (const x of xs) {\n    assert.deepEqual([1, 2], head);\n  }\n});\n'), [[4, 'truncated-sequence']]);
  assert.deepEqual(rules('test("a", () => {\n  const check = () => assert.deepEqual(head, [1, 2]);\n  const head = seen.slice(0, 2);\n  check();\n});\n'), [[2, 'truncated-sequence']]);
  assert.deepEqual(rules('const head = seen.slice(0, 2);\ntest("a", () => {\n  assert.deepEqual(want, head);\n});\n'), [[3, 'truncated-sequence']], 'a module-level slice, reversed arguments');
  assert.deepEqual(rules('if (x) {\n  var head = seen.slice(0, 2);\n}\nassert.deepEqual(head, [1]);\n'), [[4, 'truncated-sequence']], 'a var is not block-scoped');
  // An inner declaration of the same name shadows the outer one in its own block only.
  assert.deepEqual(rules('const head = seen.slice(0, 2);\n{\n  const head = seen;\n  assert.deepEqual(head, [1]);\n}\nassert.deepEqual(head, [1, 2]);\n'), [[6, 'truncated-sequence']]);
  assert.deepEqual(rules('const head = seen;\n{\n  const head = seen.slice(0, 2);\n  assert.deepEqual(head, [1]);\n}\nassert.deepEqual(head, [1, 2]);\n'), [[4, 'truncated-sequence']]);
});

test('truncated sequence, selection: one element selected from a slice (.find, .findLast, .at, [n]) is not a truncated sequence; .join, .length, .map, .every are', () => {
  assert.deepEqual(rules('const revised = sent.slice(before).find(s => s.ok);\nassert.equal(revised.effort, "high");\n'), []);
  assert.deepEqual(rules('assert.equal(sent.slice(2).find(s => s.ok).effort, "high");\nassert.equal(xs.slice(0, 2)[1], "b");\nassert.equal(xs.slice(-3).at(-1), "c");\nassert.equal(xs.slice(1)?.findLast(p)?.n, 1);\n'), []);
  // Still caught (review-runner-subscription.test.mjs:86 at 09bc5fb is the first shape, judged a defect).
  assert.deepEqual(rules('assert.deepEqual(c.map(x => x.argv.slice(0, 2).join(" ")), ["a b"]);\n'), [[1, 'truncated-sequence']]);
  assert.deepEqual(rules('assert.equal(calls.slice(0, 5).length, 5);\n'), [[1, 'truncated-sequence']], 'a window\'s length hides what is past it');
  assert.deepEqual(rules('assert.deepEqual(["a"], calls.slice(0, 2).map(c => c.name));\n'), [[1, 'truncated-sequence']], 'reversed arguments');
  assert.deepEqual(rules('assert.equal(calls.slice(0, 2).every(c => c.ok), true);\n'), [[1, 'truncated-sequence']]);
  assert.deepEqual(rules('assert.deepEqual([xs.slice(1).find(p), ys.slice(0, 2)], [1, [2, 3]]);\n'), [[1, 'truncated-sequence']], 'one selected slice does not excuse another');
  assert.deepEqual(rules('const head = calls.slice(0, 2).find(p).items.slice(0, 1);\nassert.deepEqual(head, [1]);\n'), [[2, 'truncated-sequence']]);
});

test('vacuous conditional assert, message: the subject only in the failure message is not an assert on it; in a compared argument it is', () => {
  assert.deepEqual(rules('if (tied.length) assert.doesNotMatch(c.why, /largest/,\n  `tied with ${tied.map(t => t.model)}`);\n'), []);
  assert.deepEqual(rules('if (rev) assert.ok(found, `${rev.id} was reviewed`);\nif (rev) assert.equal(a, b, String(rev));\nif (x) assert.fail(`unexpected ${x}`);\n'), []);
  // Still caught: the subject compared, in either position, by any assert method; an unknown method counts every argument.
  assert.deepEqual(rules('if (rev) assert.ok(rev.ok, "the review passed");\n'), [[1, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (x) assert.equal(1, x.n, "message");\n'), [[1, 'vacuous-conditional-assert']], 'reversed arguments');
  assert.deepEqual(rules('if (x) assert.match(out, x.re, "message");\n'), [[1, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (x) assert.throws(() => f(x), /boom/);\n'), [[1, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (x) assert.custom(y, x);\n'), [[1, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('if (spec.key) assert.deepEqual(reply.effects, [{key: spec.key}]);\n'), [[1, 'vacuous-conditional-assert']], 'tests/fixtures.test.mjs:16 at 09bc5fb');
});

test('vacuous conditional assert, loop index: `if (i)` on a numeric loop index is "after the first", not a presence test', () => {
  assert.deepEqual(rules('for (const [i, c] of models.entries()) {\n  if (i) assert.ok(rank(c) >= rank(models[i - 1]));\n}\n'), []);
  assert.deepEqual(rules('for (let i = 0; i < xs.length; i++) if (i) assert.ok(xs[i] > xs[i - 1]);\n'), []);
  assert.deepEqual(rules('for (let i = 1, n = xs.length; i < n; i++) {\n  if (i) assert.equal(xs[i], i);\n}\n'), []);
  // Still caught: an entries() key that is not used as an array index (a Map's key may be anything), Object.entries keys,
  // a value that is not a loop index, and another subject inside an index loop.
  assert.deepEqual(rules('for (const [k, v] of byName.entries()) {\n  if (k) assert.equal(k.id, v);\n}\n'), [[2, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('for (const [k, v] of Object.entries(o)) {\n  if (k) assert.ok(k.length > v);\n}\n'), [[2, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('let i = find();\nif (i) assert.equal(i.x, 1);\n'), [[2, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('for (let i = 0; i < n; i++) {\n  const x = xs[i];\n  if (x) assert.equal(1, x.n);\n}\n'), [[3, 'vacuous-conditional-assert']]);
  assert.deepEqual(rules('for (const i of ids) {\n  if (i) assert.equal(i.n, 1);\n}\n'), [[2, 'vacuous-conditional-assert']], 'a for-of value is not an index');
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
