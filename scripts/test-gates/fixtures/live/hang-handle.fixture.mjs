// Gate fixture (L-505): a never-settling test that also holds an interval. The per-test timeout cancels the test by
// name; the interval still keeps the file alive, so the per-file watchdog must end it.
import test from 'node:test';
test('fixture before', () => {});
test('fixture hangs holding a handle', () => new Promise(() => { setInterval(() => {}, 1000); }));
