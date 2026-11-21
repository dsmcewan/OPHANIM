// Gate fixture (L-505): every test passes, but one leaves an interval running; the file never ends, and neither does
// the run. Only a per-file watchdog catches it.
import test from 'node:test';
test('fixture passes first', () => {});
test('fixture leaves an interval', () => { setInterval(() => {}, 1000); });
test('fixture passes last', () => {});
