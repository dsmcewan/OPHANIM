// Gate fixture: passes. Not a test of the repository (not *.test.mjs); run only by check.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
test('fixture passes', () => assert.equal(1 + 1, 2));
