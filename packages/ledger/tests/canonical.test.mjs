// The canonical form every ledger hash is computed over is unchanged by the move into this package:
// fixed digests recorded from ophanim/board.mjs before the move, the same refusals, and the committed
// status ledger (written before the move) still verifies against its pinned genesis.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, digest, openStatusLedger} from '../index.mjs';
import {canonicalCodeUnit, canonicalCas, canonicalizer, digestCodeUnit} from '../canonical.mjs';

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

// The edge policy packages/ledger/canonical.mjs documents, line by line, for all three named forms.
const FORMS = {canonical, canonicalCodeUnit, canonicalCas};

test('edge policy: what every form accepts, and how it writes it', () => {
  for (const [name, c] of Object.entries(FORMS)) {
    assert.equal(c('é'), '"é"', `${name}: no Unicode normalisation`);
    assert.notEqual(c('é'), c('é'), `${name}: NFC and NFD hash apart`);
    assert.equal(c('\ud800'), '"\\ud800"', `${name}: a lone surrogate is escaped`);
    assert.equal(c({'😀': '𝄞'}), '{"😀":"𝄞"}', `${name}: non-BMP written as is`);
    assert.equal(c([1e21, 1e-7, 2 ** 53 + 1, 5e-324]), '[1e+21,1e-7,9007199254740992,5e-324]', `${name}: numbers as JSON.stringify writes them`);
    assert.equal(c({o: {}, a: [], s: ''}), '{"a":[],"o":{},"s":""}', `${name}: empty containers`);
    assert.equal(c(Object.assign(Object.create(null), {b: 1, a: 2})), '{"a":2,"b":1}', `${name}: a null-prototype object is plain`);
    assert.equal(c({constructor: 1, prototype: 2}), '{"constructor":1,"prototype":2}', `${name}: ordinary data keys`);
    assert.equal(c({[Symbol('k')]: 1, a: 1}), '{"a":1}', `${name}: symbol keys are not part of the value`);
    assert.equal(c({toJSON: 1}), '{"toJSON":1}', `${name}: a toJSON data key is data`);
  }
});

test('edge policy: the two key orders, and the only -0 difference', () => {
  const v = {'10': 0, '9': 0, a: 0, '01': 0, '4294967295': 0, '4294967294': 0};
  assert.equal(canonical(v), '{"9":0,"10":0,"4294967294":0,"01":0,"4294967295":0,"a":0}', 'LEDGER_V1: array indexes first, numerically');
  assert.equal(canonicalCodeUnit(v), '{"01":0,"10":0,"4294967294":0,"4294967295":0,"9":0,"a":0}', 'CODE_UNIT_V1: code units throughout');
  assert.equal(canonicalCas(v), canonicalCodeUnit(v));
  assert.equal(canonical({b: 1, a: 2}), canonicalCodeUnit({b: 1, a: 2}), 'they agree without integer-like keys');
  assert.equal(digestCodeUnit({b: 1}), digest({b: 1}));
  assert.equal(canonical(-0), '0', 'LEDGER_V1 writes -0 as 0 (legacy, kept)');
  assert.equal(canonicalCodeUnit({a: -0}), '{"a":0}');
  assert.throws(() => canonicalCas({a: -0}), /Plain finite JSON required: \$\.a is -0/);
  assert.throws(() => canonicalizer({keyOrder: 'locale'}), /unknown key order/);
  assert.throws(() => canonicalizer({keyOrder: 'ledger', negativeZero: 'drop'}), /unknown -0 policy/);
});

test('edge policy: every form refuses what is not plain JSON, loudly and with the path', () => {
  class P { constructor() { this.x = 1; } }
  const cyc = []; cyc.push(cyc);
  let deep = 0; for (let i = 0; i < 61; i++) deep = {d: deep};
  const refused = [
    [undefined, /\$ is undefined/], [{a: 1, b: undefined}, /\$\.b is undefined/], [[1, undefined], /\$\[1\] is undefined/],
    [NaN, /not finite \(NaN\)/], [{a: Infinity}, /\$\.a is not finite/], [[-Infinity], /not finite/],
    [{f() {}}, /\$\.f is a function/], [{s: Symbol('x')}, /is a symbol/], [{n: 1n}, /is a bigint/],
    [[1, , 3], /\$\[1\] is a hole/],                                      // eslint-disable-line no-sparse-arrays
    [new Date(0), /is a Date/], [{m: new Map()}, /\$\.m is a Map/], [new Set(), /is a Set/], [/x/, /is a RegExp/],
    [Buffer.from('x'), /is a Buffer/], [{s: new String('x')}, /is a String/], [new P(), /is a P/],
    [{toJSON() { return 1; }}, /\$\.toJSON is a function/],
    [JSON.parse('{"__proto__":{"x":1}}'), /\$\.__proto__ is a prototype-polluting key/],
    [cyc, /\$\[0\] is a cycle/],
    [Object.defineProperty({}, 'x', {get: () => 1, enumerable: true}), /accessors refused at \$\.x/],
    [Object.defineProperty([0], 0, {get: () => 1}), /accessors refused at \$\[0\]/],
    [deep, /nesting bound exceeded/],
  ];
  for (const [name, c] of Object.entries(FORMS)) {
    for (const [v, why] of refused) assert.throws(() => c(v), why, `${name} must refuse ${String(why)}`);
    assert.throws(() => c(undefined), /Plain finite JSON required/);
  }
  // A shared (non-cyclic) reference is fine: it is written twice.
  const shared = {k: 1};
  assert.equal(canonical({a: shared, b: shared}), '{"a":{"k":1},"b":{"k":1}}');
});
