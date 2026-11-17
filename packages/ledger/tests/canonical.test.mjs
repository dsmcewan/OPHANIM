// The canonical form every ledger hash is computed over is unchanged by the move into this package:
// fixed digests recorded from ophanim/board.mjs before the move, the same refusals, and the committed
// status ledger (written before the move) still verifies against its pinned genesis.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, digest, openStatusLedger} from '../index.mjs';

const VECTORS = [
  [null, '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
  [true, 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b'],
  [0, '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9'],
  [-1.5, '37c2b212b94e5372b33df924ea2a91182d90c237d0bf942c1768e794ebef2376'],
  [1e21, '241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c'],
  ['é ', 'e98300a2272cfc7f8d377ef20269e0985d776eea382579ad0af2c8feed847ea2'],
  [[3, 1, 2], '51bda7ab4e44726cde71fcb6e4b515357059bb6b6dd5146d1fc50f73f11678c6'],
  [{b: 1, a: [{d: null, c: 'x'}]}, '8318f57073cb31bc81f91628e2d929f971135519b430a819fde076f2048f0725'],
  [{z: {y: {x: []}}, 'a b': '"q"'}, '016cf94f982c46de6264219719221006031ed639189635059b1ec989af748676'],
];

test('canonical JSON: sorted keys and the digests recorded before the move', () => {
  assert.equal(canonical({b: 1, a: [{d: null, c: 'x'}]}), '{"a":[{"c":"x","d":null}],"b":1}');
  for (const [v, d] of VECTORS) assert.equal(digest(v), d, JSON.stringify(v));
});

test('canonical JSON refuses what is not plain finite JSON', () => {
  assert.throws(() => canonical(NaN), /Plain finite JSON/);
  assert.throws(() => canonical(undefined), /Plain finite JSON/);
  assert.throws(() => canonical(new Date(0)), /Plain finite JSON/);
  const cyc = {}; cyc.self = cyc;
  assert.throws(() => canonical(cyc), /Plain finite JSON/);
  assert.throws(() => canonical(Object.defineProperty({}, 'x', {get: () => 1, enumerable: true})), /accessors refused/);
  let deep = 0; for (let i = 0; i < 62; i++) deep = [deep];
  assert.throws(() => canonical(deep), /nesting bound/);
});

test('the committed status ledger, written before the move, verifies against its pinned genesis', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../status/ledger');
  if (!fs.existsSync(path.join(root, 'chain.jsonl'))) return;   // a checkout without the board
  const anchor = fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim();
  assert.equal(anchor, 'sha256:816a79525846cb2ade6173260237f1236cd5bea103d9027be51ea2981a2b536d');
  const b = openStatusLedger({root, anchor}).board();
  assert.ok(b.entries >= 44 && b.items.length > 0);
});
