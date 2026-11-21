// Gate fixture (L-506): an uncaught exception thrown from a timer, attributed by node:test to the running test.
import test from 'node:test';
test('fixture timer first', () => {});
test('fixture timer throws', async () => { setTimeout(() => { throw new Error('fixture boom in a timer'); }, 10); await new Promise(r => setTimeout(r, 100)); });
test('fixture timer after', () => {});
