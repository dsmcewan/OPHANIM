// ME3: the canonical-JSON differential. Before the unification this repository carried a dozen
// canonicalizers that agreed on ordinary JSON and disagreed at the edges. This test runs every one of
// them -- the replaced copies frozen verbatim as they stood at 3b98973, the pinned verifiers and the
// fixture module read live from their (hash-pinned) files, and TELOS's own when a checkout is given --
// over an adversarial corpus, and proves:
//
//   1. on plain JSON with no integer-like key every implementation that accepts a value writes the same
//      bytes as the unified one;
//   2. integer-like keys split them into exactly two families, LEDGER_V1 and CODE_UNIT_V1, and each
//      unified form is byte-identical to its family;
//   3. each unified form reproduces the copy it replaced on everything that copy wrote as valid JSON,
//      and refuses (loudly) exactly the non-JSON inputs that copy dropped, mangled or wrote as invalid
//      JSON -- the list is fixed here, so a new divergence fails;
//   4. every committed ledger (status/ledger, pantheon/tests/fixtures/cycle-v1-ledger) re-hashes
//      identically, object for object and entry for entry, under the replaced ledger copy, the unified
//      form, the pinned verifier's and TELOS's, and verifies to the same head;
//   5. the inputs the pinned governance checks hash (fixture requests, planning policies, worker
//      artifacts) canonicalise identically under the unified form, the pinned verifiers, the pinned
//      fixture module and TELOS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {canonical, canonicalCodeUnit, canonicalCas, digest} from '../../packages/ledger/canonical.mjs';
import {openLedger} from '../../packages/ledger/chain.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {pantheonSystemKinds} from '../../pantheon/src/ledger/system.mjs';
import {canonicalize as boardCanonicalize} from '../../pantheon/src/board/canon.mjs';
import * as board from '../board.mjs';
import * as contract from '../governance/check-contract.mjs';
import * as fixtures from '../fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = text => createHash('sha256').update(text).digest('hex');

// ---- the replaced copies, verbatim as of 3b98973 --------------------------------------------------
// packages/ledger/canonical.mjs canonical, byte-identical to the copy ophanim/board.mjs carried.
function legacyLedger(value){
  const seen=new Set();
  function walk(v,depth=0){
    if(depth>60)throw Error('JSON nesting bound exceeded');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw Error('Plain finite JSON required');
    seen.add(v);
    const out=Array.isArray(v)?v.map(item=>walk(item,depth+1)):Object.fromEntries(Object.keys(v).sort().map(k=>{
      const d=Object.getOwnPropertyDescriptor(v,k);if(d.get||d.set)throw Error('JSON accessors refused');return [k,walk(v[k],depth+1)];
    }));
    seen.delete(v);return out;
  }
  return JSON.stringify(walk(value));
}
// pantheon/src/board/canon.mjs canonicalize (board content ids).
function legacyCas(value, path = "$") {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalize: ${path} is not finite (${value})`);
    if (Object.is(value, -0)) throw new TypeError(`canonicalize: ${path} is -0, which is indistinguishable from 0 once serialised`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v, i) => legacyCas(v, `${path}[${i}]`)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(k => {
      if (value[k] === undefined) throw new TypeError(`canonicalize: ${path}.${k} is undefined`);
      return `${JSON.stringify(k)}:${legacyCas(value[k], `${path}.${k}`)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalize: ${path} is a ${typeof value}, which has no canonical form`);
}
// `stable`, three identical copies: pantheon/src/board/contributions.mjs (projection digest),
// pantheon/src/route/frontier.mjs (selection-policy hash), pantheon/src/route/protocol.mjs (escalation digest).
const legacyStable = v => Array.isArray(v) ? `[${v.map(legacyStable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${legacyStable(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const compare=(a,b)=>a<b?-1:a>b?1:0;
// ophanim/efficiency/admission.mjs canonical (admission digests).
function legacyAdmission(value){
  if(Array.isArray(value))return `[${value.map(legacyAdmission).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort(compare).map(key=>`${JSON.stringify(key)}:${legacyAdmission(value[key])}`).join(',')}}`;
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  throw Error('Finite JSON admission evidence required');
}
// ophanim/efficiency/analyze.mjs canonical (analysis digests).
function legacyAnalyze(value){
  if(Array.isArray(value))return `[${value.map(legacyAnalyze).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort(compare).map(key=>`${JSON.stringify(key)}:${legacyAnalyze(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// ---- implementations left in place, read live from their files ------------------------------------
// A function the file does not export is lifted from the file's own text, so this runs the bytes the pins cover.
const lift = (file, start, end, params, args) => {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');
  const from = text.indexOf(start), to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${file}: ${start} not found`);
  return new Function(...params, `${text.slice(from, to)}\nreturn ${params.length ? start.match(/function (\w+)/)[1] : start.match(/const (\w+)/)[1]};`)(...args);
};
const fail = message => { throw Error(message); };
const pinnedLarge = lift('ophanim/governance/check-efficiency.mjs', 'function canonicalLarge(value) {', 'const digest = value =>',
  ['fail', 'requireThat'], [fail, (c, m) => { if (!c) fail(m); }]);
const cacheSorted = lift('packages/model-client/request.mjs', 'const sorted=', '\nexport function cacheKey', [], []);

const TELOS = process.env.OPHANIM_TELOS_ROOT && fs.existsSync(path.join(process.env.OPHANIM_TELOS_ROOT, 'merkle-dag/vendor.mjs'))
  ? process.env.OPHANIM_TELOS_ROOT : null;
const telos = TELOS ? {
  vendor: (await import(pathToFileURL(path.join(TELOS, 'merkle-dag/vendor.mjs')).href)).canonicalize,
  sign: (await import(pathToFileURL(path.join(TELOS, 'build-gate/sign.mjs')).href)).canonicalize,
} : null;

// Every implementation, its family by key order, and where it lives.
const IMPLS = {
  'unified canonical': {fn: canonical, family: 'ledger'},
  'unified canonicalCodeUnit': {fn: canonicalCodeUnit, family: 'code-unit'},
  'unified canonicalCas': {fn: canonicalCas, family: 'code-unit'},
  'legacy ledger (packages/ledger, ophanim/board.mjs)': {fn: legacyLedger, family: 'ledger'},
  'legacy board cid (pantheon/src/board/canon.mjs)': {fn: legacyCas, family: 'code-unit'},
  'legacy stable (contributions, frontier, protocol)': {fn: legacyStable, family: 'code-unit'},
  'legacy admission (ophanim/efficiency/admission.mjs)': {fn: legacyAdmission, family: 'code-unit'},
  'legacy analyze (ophanim/efficiency/analyze.mjs)': {fn: legacyAnalyze, family: 'code-unit'},
  'pinned check-contract canonical': {fn: contract.canonical, family: 'ledger'},
  'pinned check-efficiency canonicalLarge': {fn: pinnedLarge, family: 'ledger'},
  'pinned ophanim/fixtures.mjs canonical': {fn: fixtures.canonical, family: 'code-unit'},
  'model-client cache key (sorted + JSON.stringify)': {fn: v => JSON.stringify(cacheSorted(v)), family: 'ledger'},
  ...telos ? {
    'TELOS merkle-dag/vendor.mjs canonicalize': {fn: telos.vendor, family: 'ledger'},
    'TELOS build-gate/sign.mjs canonicalize': {fn: telos.sign, family: 'ledger'},
  } : {},
};
const run = (fn, v) => { try { const out = fn(v); return typeof out === 'string' ? out : `<non-string ${String(out)}>`; } catch (e) { return `THROW ${e.constructor.name}`; } };
const validJson = out => { if (out.startsWith('THROW') || out.startsWith('<')) return false; try { JSON.parse(out); return true; } catch { return false; } };

// ---- the corpus -------------------------------------------------------------------------------------
const sparse = [1, , 3];                                       // eslint-disable-line no-sparse-arrays
const cyc = {a: 1}; cyc.self = cyc;
const nullProto = Object.assign(Object.create(null), {b: 2, a: 1});
class Point { constructor() { this.y = 2; this.x = 1; } }
let deep61 = 0; for (let i = 0; i < 61; i++) deep61 = [deep61];
let deep45 = 0; for (let i = 0; i < 45; i++) deep45 = [deep45];
const CORPUS = {
  // plain JSON, no integer-like keys: every accepting implementation must agree
  'key order': {b: 1, a: 2, c: {z: 1, y: 2}},
  'nested arrays and objects': [[1, [2, [3]]], {a: [{c: 'x', b: null}]}],
  'empty containers': {o: {}, a: [], s: '', n: [{}, []]},
  'code-unit vs locale order': {'é': 1, e: 2, E: 3, 'Z': 4, '_': 5, '': 6, 'a b': 7},
  'unicode NFC': {s: 'é'},
  'unicode NFD': {s: 'é'},
  'non-BMP': {s: '😀𝄞', '😀': 1, '￿': 2},
  'lone high surrogate': {s: '\ud800'},
  'lone low surrogate as key': {'\udc00': 1},
  'escapes': {s: '"\\\n\t\u0000\u001f\u007f  /'},
  'large and small numbers': [1e21, 1e-7, 123456789012345680000, 5e-324, 1.7976931348623157e308, 0.1 + 0.2],
  'integers beyond 2^53': [2 ** 53, 2 ** 53 + 1, -(2 ** 64), 9007199254740993],
  'exponent forms parsed': JSON.parse('[1E3, 1e+3, 10e2, 1.0, -0.0e0]').slice(0, 4),
  'constructor and prototype keys': {constructor: 1, prototype: 2, toString: 3},
  'toJSON as a data key': {toJSON: 1},
  'null-prototype object': nullProto,
  'deep 45': deep45,
  // integer-like keys: the two families split
  'integer-like keys': {'10': 'ten', '9': 'nine', a: 'a', '01': 'zero-one', '-1': 'minus'},
  'array-index boundary keys': {'4294967295': 'not an index', '4294967294': 'max index', '10': 'ten', '9': 'nine'},
  // values that are not JSON
  '-0': -0,
  '-0 member': {a: -0},
  'NaN': NaN,
  'Infinity member': {a: Infinity},
  'undefined': undefined,
  'undefined member': {a: 1, b: undefined},
  'undefined element': [1, undefined],
  'function member': {f() {}},
  'symbol member': {s: Symbol('x')},
  'symbol key': {[Symbol('k')]: 1, a: 1},
  'BigInt': {n: 10n},
  'sparse array': sparse,
  'Date': new Date(0),
  'Date member': {d: new Date(0)},
  'Map': new Map([['a', 1]]),
  'class instance': new Point(),
  'boxed string': {s: new String('x')},
  'toJSON method': {toJSON() { return 'replaced'; }},
  'own __proto__ key': JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'),
  'cycle': cyc,
  'accessor': Object.defineProperty({}, 'x', {get: () => 1, enumerable: true}),
  'deep 61': deep61,
};
const INTEGER_KEYED = new Set(['integer-like keys', 'array-index boundary keys']);
const PLAIN = Object.keys(CORPUS).slice(0, Object.keys(CORPUS).indexOf('integer-like keys'));

const results = Object.fromEntries(Object.entries(CORPUS).map(([name, v]) =>
  [name, Object.fromEntries(Object.entries(IMPLS).map(([impl, {fn}]) => [impl, run(fn, v)]))]));

test('the disagreement table (printed for the record)', t => {
  for (const [name, row] of Object.entries(results)) {
    const groups = new Map();
    for (const [impl, out] of Object.entries(row)) groups.set(out, [...(groups.get(out) ?? []), impl]);
    if (groups.size > 1) t.diagnostic(`${name}: ${[...groups].map(([out, impls]) => `${out.slice(0, 60)} <- ${impls.length} impl(s): ${impls.join('; ')}`).join(' | ')}`);
  }
});

test('on plain JSON without integer-like keys, every accepting implementation writes the unified bytes', () => {
  for (const name of PLAIN) {
    const want = canonical(CORPUS[name]);
    assert.equal(canonicalCodeUnit(CORPUS[name]), want, name);
    for (const [impl, out] of Object.entries(results[name])) {
      if (out.startsWith('THROW')) continue;
      assert.equal(out, want, `${name}: ${impl}`);
    }
  }
  // Only the bounds and the unsafe-key rule of the pinned verifiers refuse anything here.
  assert.match(results['constructor and prototype keys']['pinned check-contract canonical'], /THROW/);
  assert.match(results['deep 45']['pinned check-contract canonical'], /THROW/);
});

test('integer-like keys split the implementations into exactly the two families', () => {
  for (const name of INTEGER_KEYED) {
    const ledger = canonical(CORPUS[name]), codeUnit = canonicalCodeUnit(CORPUS[name]);
    assert.notEqual(ledger, codeUnit, name);
    for (const [impl, {family}] of Object.entries(IMPLS)) assert.equal(results[name][impl], family === 'ledger' ? ledger : codeUnit, `${name}: ${impl}`);
  }
  assert.equal(canonical(CORPUS['integer-like keys']), '{"9":"nine","10":"ten","-1":"minus","01":"zero-one","a":"a"}');
  assert.equal(canonicalCodeUnit(CORPUS['integer-like keys']), '{"-1":"minus","01":"zero-one","10":"ten","9":"nine","a":"a"}');
  assert.equal(canonical(CORPUS['array-index boundary keys']), '{"9":"nine","10":"ten","4294967294":"max index","4294967295":"not an index"}');
  assert.equal(canonicalCodeUnit(CORPUS['array-index boundary keys']), '{"10":"ten","4294967294":"max index","4294967295":"not an index","9":"nine"}');
  assert.equal(canonicalCas({'10': 1, '9': 2}), '{"10":1,"9":2}');
});

// Where a unified form now refuses what the copy it replaced accepted. Everything else must match exactly,
// and every listed input is one no JSON.parse output can contain, so no persisted record is affected.
const STRUCTURAL = ['sparse array', 'Date', 'Date member', 'Map', 'class instance', 'boxed string', 'own __proto__ key', 'accessor', 'deep 61'];
const LAX = ['NaN', 'Infinity member', 'undefined', 'undefined member', 'undefined element', 'function member', 'symbol member', 'sparse array',
  'Date', 'Date member', 'Map', 'class instance', 'boxed string', 'toJSON method', 'own __proto__ key', 'accessor', 'deep 61'];
const TIGHTENED = [
  ['unified canonical', 'legacy ledger (packages/ledger, ophanim/board.mjs)', ['sparse array', 'own __proto__ key']],
  ['unified canonicalCas', 'legacy board cid (pantheon/src/board/canon.mjs)', STRUCTURAL],
  ['unified canonicalCodeUnit', 'legacy admission (ophanim/efficiency/admission.mjs)', STRUCTURAL],
  ['unified canonicalCodeUnit', 'legacy stable (contributions, frontier, protocol)', LAX],
  ['unified canonicalCodeUnit', 'legacy analyze (ophanim/efficiency/analyze.mjs)', LAX],
];
test('each unified form reproduces the copy it replaced, and refuses only the listed non-JSON inputs', () => {
  for (const [unified, legacy, tightened] of TIGHTENED) {
    const refusedNow = [];
    for (const [name, row] of Object.entries(results)) {
      if (row[unified] === row[legacy] || (row[unified].startsWith('THROW') && row[legacy].startsWith('THROW'))) continue;
      assert.match(row[unified], /^THROW/, `${name}: ${unified} must equal ${legacy} or refuse`);
      refusedNow.push(name);
    }
    assert.deepEqual(refusedNow, tightened, `${unified} vs ${legacy}`);
  }
  // What the lax copies wrote for those inputs: hashes no stored record could reproduce, or collisions.
  for (const legacy of ['legacy stable (contributions, frontier, protocol)', 'legacy analyze (ophanim/efficiency/analyze.mjs)']) {
    assert.equal(results['undefined member'][legacy], '{"a":1,"b":undefined}', 'the bare word undefined, which no reader can parse');
    assert.equal(results['sparse array'][legacy], '[1,,3]');
    assert.equal(results['NaN'][legacy], 'null', 'NaN hashed equal to null');
    assert.equal(results['Date'][legacy], '{}', 'every Date hashed equal to {}');
    assert.equal(validJson(results['function member'][legacy]), false);
  }
  assert.equal(results['-0']['unified canonical'], '0', 'LEDGER_V1 keeps writing -0 as 0');
  assert.equal(results['-0']['unified canonicalCodeUnit'], '0');
  assert.match(results['-0']['unified canonicalCas'], /^THROW/, 'a content id refuses -0');
});

// ---- committed ledgers ------------------------------------------------------------------------------
const LEDGERS = [
  {name: 'status/ledger', dir: path.join(REPO, 'status/ledger'), pinned: {81: 'sha256:76892bd2bff0f050c01591dc42b0241112c350d86df14f0ec94e676fd4b60503'}},
  {name: 'pantheon cycle-v1 fixture', dir: path.join(REPO, 'pantheon/tests/fixtures/cycle-v1-ledger'), expected: true},
];
const bodyOf = e => ({schema: e.schema, kind: e.kind, author: e.author, derived_from: e.derived_from, payload_ref: e.payload_ref});
const LEDGER_FAMILY = Object.entries(IMPLS).filter(([, {family}]) => family === 'ledger').map(([impl]) => impl);

for (const L of LEDGERS) {
  test(`${L.name}: every object and entry re-hashes identically under every ledger-family implementation`, t => {
    if (!fs.existsSync(path.join(L.dir, 'chain.jsonl'))) return t.skip('no committed ledger in this checkout');
    const objects = fs.readdirSync(path.join(L.dir, 'objects'));
    assert.ok(objects.length > 0);
    let compared = 0;
    const same = (value, label) => {
      const want = legacyLedger(value);
      for (const impl of LEDGER_FAMILY) assert.equal(run(IMPLS[impl].fn, value), want, `${label}: ${impl}`);
      assert.equal(canonicalCodeUnit(value), want, `${label}: no committed record has an integer-like key`);
      compared++;
      return want;
    };
    for (const f of objects) {
      const text = fs.readFileSync(path.join(L.dir, 'objects', f), 'utf8'), value = JSON.parse(text);
      const bytes = same(value, f);
      assert.equal('sha256:' + sha(bytes), 'sha256:' + f.replace(/\.json$/, ''), `${f} is named by its legacy digest`);
      assert.equal(digest(value), sha(bytes));
    }
    const entries = fs.readFileSync(path.join(L.dir, 'chain.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    let parent = null;
    for (const e of entries) {
      assert.equal(e.parent, parent, `entry ${e.seq} links to the legacy hash of its predecessor`);
      same(bodyOf(e), `entry ${e.seq} body`);
      same({seq: e.seq, parent: e.parent, body: 'sha256:' + sha(legacyLedger(bodyOf(e)))}, `entry ${e.seq} order`);
      parent = 'sha256:' + sha(same(e, `entry ${e.seq}`));
      if (L.pinned?.[e.seq]) assert.equal(parent, L.pinned[e.seq], `entry ${e.seq} hash is the one recorded before ME3`);
    }
    // The unified implementation verifies the chain to the same head the legacy hashes give.
    let verified;
    if (L.expected) {
      const expected = JSON.parse(fs.readFileSync(path.join(L.dir, 'EXPECTED.json'), 'utf8'));
      assert.equal(parent, expected.head);
      verified = openLedger({dir: L.dir, kinds: pantheonSystemKinds(), anchor: expected.anchor}).verify();
    } else {
      const anchor = fs.readFileSync(path.join(L.dir, 'ANCHOR'), 'utf8').trim();
      verified = openStatusLedger({root: L.dir, anchor, create: false}).ledger.verify();
    }
    assert.equal(verified.ok, true, verified.why);
    assert.equal(verified.head, parent, 'unified head equals the legacy head');
    assert.equal(verified.entries, entries.length);
    t.diagnostic(`${L.name}: ${objects.length} objects, ${entries.length} entries, ${compared} values compared across ${LEDGER_FAMILY.length} implementations`);
  });
}

// ---- inputs the pinned governance checks and TELOS hash --------------------------------------------
test('the inputs the pinned verifiers and TELOS hash canonicalise identically everywhere', t => {
  const inputs = [];
  for (const options of [{}, {count: 2}, {count: 9, department: 'facilities', namespace: 'x'}, {missingCase: 1}, {routingAliasCase: 2}]) {
    inputs.push(fixtures.makeFixtures(options));
  }
  for (const batches of [[{}], [{}, {}], [{maxSlots: 3}]]) {
    try { inputs.push(fixtures.createPlanning({batches}).policy); } catch {}
  }
  for (const options of [{}, {version: 'synthetic-v2', routingAliases: {'office-support': 'facilities'}}]) {
    const workers = fixtures.createWorkers({...options, delayMs: 0}).map(({id, version, kinds, scopes}) => ({id, version, kinds, scopes}));
    const artifact = {schema: 'ophanim.synthetic-worker-artifact/v1', sourceSha: 'f'.repeat(64), options, workers};
    inputs.push(workers, artifact, {id: 'release', artifactSha: contract.hash(artifact), stateSchema: 'ophanim.runtime/v1', workers});
  }
  const pinnedFamily = ['pinned check-contract canonical', 'pinned check-efficiency canonicalLarge', 'pinned ophanim/fixtures.mjs canonical',
    ...telos ? ['TELOS merkle-dag/vendor.mjs canonicalize'] : []];
  for (const [i, v] of inputs.entries()) {
    const want = canonical(v);
    assert.equal(board.canonical(v), want);
    assert.equal(canonicalCodeUnit(v), want);
    assert.equal(boardCanonicalize(v), want);
    for (const impl of pinnedFamily) assert.equal(IMPLS[impl].fn(v), want, `input ${i}: ${impl}`);
    assert.equal(contract.hash(v), digest(v));
    assert.equal(fixtures.digest(v), digest(v));
  }
  t.diagnostic(`${inputs.length} governance inputs compared; TELOS ${telos ? 'included' : 'not given (set OPHANIM_TELOS_ROOT)'}`);
});
