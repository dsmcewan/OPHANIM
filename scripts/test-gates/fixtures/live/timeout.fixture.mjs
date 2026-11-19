// Gate fixture: a test that times out -- node:test counts it as cancelled, not failed.
import test from 'node:test';
test('fixture times out', {timeout: 200}, () => new Promise(r => setTimeout(r, 3000)));
