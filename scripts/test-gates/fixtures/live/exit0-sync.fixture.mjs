// Gate fixture (L-506): process.exit(0) synchronously inside a test. Node 24.22.1 reports the whole file as ONE passing
// test named after the file, `fail 0`, exit 0: three tests vanish.
import test from 'node:test';
test('fixture sync first', () => {});
test('fixture exits synchronously', () => { process.exit(0); });
test('fixture sync never runs', () => {});
