// Gate fixture (L-506): process.exit(1) mid-file. Node reports a failing test named after the file.
import test from 'node:test';
test('fixture exit1 first', () => {});
test('fixture exits 1', async () => { await new Promise(r => setTimeout(r, 20)); process.exit(1); });
test('fixture exit1 never runs', () => {});
