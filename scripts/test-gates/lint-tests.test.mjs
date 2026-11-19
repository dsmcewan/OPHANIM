// The test lint's own tests: each rule fires on the shape the retrospective found, stays quiet on the sound shape
// next to it, and report-only mode exits 0 whatever it finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lintSource, blank} from './lint-tests.mjs';

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

test('scripted terminal status: a fixture returning a status the file asserts fires; an expected value inside the assert does not', () => {
  const src = 'const run = async () => {\n  return {status: "failed", why: "elapsed"};\n};\nassert.equal((await run()).status, "failed");\n';
  assert.deepEqual(rules(src), [[2, 'scripted-terminal-status']]);
  assert.deepEqual(rules('const f = () => ({status: "passed"});\nassert.equal(x.status, "failed");\n'), [], 'the asserted status is not the scripted one');
  assert.deepEqual(rules('assert.deepEqual(r, {status: "failed"});\n'), [], 'an expected object is not a fixture');
});

test('suppression: `test-lint: allow RULE -- reason` on the line or the line above marks the finding suppressed, still listed', () => {
  const f = lintSource('// test-lint: allow truncated-sequence -- the prefix is the contract\nassert.deepEqual(argv.slice(0, 3), ["a", "b", "c"]);\n');
  assert.deepEqual(f.map(x => [x.rule, x.suppressed]), [['truncated-sequence', true]]);
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
