// Gate fixture: a real-bwrap-style skip, as the pantheon suites write it.
import test from 'node:test';
test('fixture runs under bwrap', {skip: 'bwrap unavailable: fixture'}, () => {});
test('fixture plain', () => {});
