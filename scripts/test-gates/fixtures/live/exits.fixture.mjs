// Gate fixture: the file exits in the middle; its remaining tests vanish from every count.
import test from 'node:test';
test('fixture first', () => {});
test('fixture exits', async () => { await new Promise(r => setTimeout(r, 20)); process.exit(0); });
test('fixture never runs', () => {});
