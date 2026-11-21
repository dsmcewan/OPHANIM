// Gate fixture (L-506): every test is registered conditionally and the condition is false; the file runs no test.
import test from 'node:test';
if (process.env.OPHANIM_FIXTURE_NEVER_SET) test('fixture conditional', () => {});
