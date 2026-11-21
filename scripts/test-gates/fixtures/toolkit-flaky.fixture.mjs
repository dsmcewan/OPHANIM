// A deliberately FLAKY synthetic test for scripts/test-gates/stress.mjs (toolkit-stress.test.mjs): it fails on its
// SECOND run only, counted in a file under TOOLKIT_FLAKY_STATE, so one run passes and repeats catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('flaky: fails on its second run only', () => {
  const dir = process.env.TOOLKIT_FLAKY_STATE;
  assert.ok(dir, 'TOOLKIT_FLAKY_STATE names the directory that counts the runs');
  const file = path.join(dir, 'runs');
  const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
  fs.writeFileSync(file, String(n));
  assert.notEqual(n, 2, 'the second run fails');
});
