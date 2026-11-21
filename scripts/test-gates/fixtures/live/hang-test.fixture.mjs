// Gate fixture (L-505): a test whose promise never settles and keeps nothing alive. Node 24.22.1 neither cancels it
// nor ends the file: without a per-test timeout the run waits forever.
import test from 'node:test';
test('fixture before the hang', () => {});
test('fixture hangs forever', () => new Promise(() => {}));
test('fixture after the hang', () => {});
