// A synthetic RACE for scripts/test-gates/stress.mjs (toolkit-stress.test.mjs): this file and its twin
// (toolkit-race-a.fixture.mjs) each hold a marker in TOOLKIT_RACE_DIR for WINDOW_MS and fail if they see the other's:
// each passes on its own and one after the other, and fails only when the two run AT THE SAME TIME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ME = 'running-b', WINDOW_MS = 1200;

test('race: fails only beside its twin', async () => {
  const dir = process.env.TOOLKIT_RACE_DIR;
  assert.ok(dir, 'TOOLKIT_RACE_DIR names the shared directory');
  const mine = path.join(dir, ME);
  fs.writeFileSync(mine, String(process.pid));
  let beside = [];
  try {
    for (const end = Date.now() + WINDOW_MS; Date.now() < end && !beside.length;) {
      beside = fs.readdirSync(dir).filter(n => n.startsWith('running-') && n !== ME);
      await new Promise(r => setTimeout(r, 25));
    }
    if (beside.length) await new Promise(r => setTimeout(r, WINDOW_MS));   // stay visible, so the twin sees this one too
  } finally { fs.rmSync(mine, {force: true}); }
  assert.deepEqual(beside, [], 'ran beside its twin');
});
