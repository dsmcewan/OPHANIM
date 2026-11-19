// Gate fixture (L-506): a describe() that throws while registering. Its tests never exist; Node 24.22.1 reports
// `fail 0` (a suite is not counted) and exits 1.
import {describe, it, test} from 'node:test';
test('fixture describe first', () => {});
describe('fixture group that throws', () => { throw new Error('fixture registration boom'); it('fixture never registered', () => {}); });
