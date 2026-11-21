// A STABLE synthetic test for scripts/test-gates/stress.mjs (toolkit-stress.test.mjs): it passes on every run.
import test from 'node:test';
import assert from 'node:assert/strict';

test('stable: passes on every run', () => { assert.equal(1 + 1, 2); });
