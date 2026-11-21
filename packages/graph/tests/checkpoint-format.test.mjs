// The snapshot's compact format (register KG-9; docs/knowledge-graph/checkpoint.md section 4a): the state's encoding (a
// string table, a shape table and a word stream) returns the serialized state EXACTLY and refuses anything that is not
// exactly the encoding; a snapshot in the older format is refused as such and never decoded, and the full open (or a
// snapshot in this format) is taken (KC-4); the restored id order is checked; and the projection digest, computed from
// the restored order or by sorting, is canonical()'s digest at every cursor (KC-5, the projection digest unchanged). A
// REAL packages/ledger chain; SYNTHETIC keys generated per test; no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, sign as edSign, createPrivateKey} from 'node:crypto';
import {generateSigner} from '../../ledger/chain.mjs';
import {canonical, digest} from '../../ledger/canonical.mjs';
import {assertion, retraction, writeSnapshot, listSnapshots, GRAPH_SCHEMA, SNAPSHOT_SCHEMA} from '../index.mjs';
import {encodeState, decodeState, STATE_ENCODING, OLDER_SNAPSHOT_SCHEMAS} from '../checkpoint.mjs';
import {projectionDigest, STATE_SCHEMA} from '../projection.mjs';
import {world, SYSTEM, SYSTEM_SNAPSHOT, C, id, src, RUN, T0, at, V1} from './fixture.mjs';

const ex = (w, minutes) => ({...w.by('extractor'), observed_at: at(minutes)});
const tool = over => assertion({origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const used = g => g.verification.snapshot.used;
const split = file => { const raw = fs.readFileSync(file), nl = raw.indexOf(0x0a); return {raw, nl, head: JSON.parse(raw.subarray(0, nl).toString('utf8')), state: raw.subarray(nl + 1)}; };
function pinned(w) {
  const signer = generateSigner('snapshot-key'), dir = path.join(w.dir, 'snapshots');
  return {signer, dir, keys: {[signer.key_id]: signer.publicJwk}, opts: {snapshot: {dir, keys: {[signer.key_id]: signer.publicJwk}}}};
}
/** A graph whose history holds every kind of entry: observations of a changing source, records, a supersede, a hypothesis, a retraction. */
function storied(t, o = {}) {
  const w = world(t, o), g = w.open();
  g.observe(SYSTEM, ex(w, 0));
  const ob = tool({entity: id('evidence', 'observation', 'o1'), attributes: {outcome: 'pass', note: 'é, ✓ and a lone \ud800 surrogate', n: -0, f: 0.25, big: 2 ** 40}});
  g.assert([ob, tool({type: 'verifies', from: ob.subject, to: C('session')})], w.by('tool'));
  const o2 = tool({entity: ob.subject, supersedes: [ob.id], attributes: {outcome: 'fail'}});
  g.supersede([o2], w.by('tool'));
  g.assert([assertion({entity: id('evidence', 'hypothesis', 'h1'), origin: 'synthetic.agent', classification: 'hypothetical', source: src('synthetic.notes'),
    observed_at: T0, missing_evidence: ['a guess']})], w.by('agent'));
  g.retract([retraction({retracts: o2.id, origin: 'synthetic.tool', reason: 'superseded run', observed_at: at(6)})], w.by('tool'));
  w.publish({...SYSTEM_SNAPSHOT, entities: {...SYSTEM_SNAPSHOT.entities, [C('sdk-gateway')]: {version: 2}}});
  g.observe(SYSTEM, ex(w, 7));
  return {w, g};
}
/** Every own key of every object, in its order, at every path: deepStrictEqual does not compare key order. */
const keyOrder = (v, at = '$', out = []) => {
  if (Array.isArray(v)) v.forEach((x, i) => keyOrder(x, `${at}[${i}]`, out));
  else if (v !== null && typeof v === 'object') { out.push(`${at}:${Object.keys(v).join(',')}`); for (const k of Object.keys(v)) keyOrder(v[k], `${at}.${k}`, out); }
  return out;
};
const exactly = (back, value, what) => {
  assert.deepStrictEqual(back, value, what);
  assert.deepEqual(keyOrder(back), keyOrder(value), `${what}: every object's keys in their order`);
  assert.equal(JSON.stringify(back), JSON.stringify(value), what);
};
/** The value of the edges of JSON the state may hold: strings of every width, numbers of every kind, keys of every kind. */
const EDGES = {
  strings: ['', 'a', 'latin1 é ÿ \u0000 \u0080', 'wide ✓ 日本 \u{1F600}', 'lone \ud800 and \udfff surrogates', 'x'.repeat(5000), 'a', 'wide ✓ 日本 \u{1F600}'],
  numbers: [0, -0, 1, -1, 2 ** 28 - 1, 2 ** 28, 2 ** 53 - 1, -(2 ** 53), 0.1, 1e300, -1e-300, 5e-324],
  constants: [null, true, false],
  objects: [{}, {'10': 'ten', '9': 'nine', b: 1, a: 2, '': 'empty key'}, JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}')],
  arrays: [[], [[]], [[[[1, [2, [3]]]]]], Array.from({length: 300}, (_, i) => ({i, s: `s${i % 7}`}))],
};

test('format: the compact encoding returns the state exactly -- every string, number, key order and nesting -- and stores each string once', t => {
  const {g} = storied(t);
  const state = g.projection.serialize(), bytes = encodeState(state);
  exactly(decodeState(bytes), state, 'a graph\'s state');
  assert.ok(bytes.length < Buffer.byteLength(JSON.stringify(state)), 'smaller than its JSON');
  // The string table: each distinct string (values and none of the keys, which are the shapes') stored once.
  const pre = JSON.parse(bytes.toString('utf8', 4, 4 + bytes.readUInt32LE(0)));
  const values = new Set(), walk = v => { if (typeof v === 'string') values.add(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x); };
  walk(state);
  assert.deepEqual([pre.encoding, pre.strings], [STATE_ENCODING, values.size]);
  const back = decodeState(encodeState(EDGES));
  exactly(back, EDGES, 'the edges of JSON');
  assert.ok(Object.is(back.numbers[1], -0), '-0 stays -0');
  assert.equal(Object.getPrototypeOf(back.objects[2]), Object.prototype, 'a "__proto__" key is an own property, never the prototype');
  assert.deepEqual(back.objects[2].__proto__, {polluted: true});
  assert.equal({}.polluted, undefined);
  // A state that does not start at a multiple of 8 (a copy is decoded) reads the same.
  const shifted = Buffer.concat([Buffer.alloc(3), encodeState(EDGES)]).subarray(3);
  exactly(decodeState(shifted), EDGES, 'decoded from bytes that are not aligned');
});

test('format: the decoder refuses anything that is not exactly the encoding; the encoder refuses a state that is not plain JSON', () => {
  const good = encodeState(EDGES), L = good.readUInt32LE(0), pre = JSON.parse(good.toString('utf8', 4, 4 + L));
  const body = 4 + L + ((8 - ((4 + L) % 8)) % 8);
  const wordsAt = body + 8 * pre.numbers + 4 * (pre.strings + 1);
  const edit = (f) => { const b = Buffer.from(good); f(b); return b; };
  const withPreamble = change => { const p = Buffer.from(JSON.stringify({...pre, ...change})), h = Buffer.alloc(4); h.writeUInt32LE(p.length);
    return Buffer.concat([h, p, Buffer.alloc((8 - ((4 + p.length) % 8)) % 8), good.subarray(body)]); };
  const cases = {
    'empty': Buffer.alloc(0),
    'cut short': good.subarray(0, good.length - 1),
    'one byte more': Buffer.concat([good, Buffer.alloc(1)]),
    'JSON (the older format\'s state)': Buffer.from(JSON.stringify({schema: 'ophanim.graph.projection-state/v1', seq: 0, head: null, log: []})),
    'another encoding': withPreamble({encoding: 'ophanim.graph.compact-state/v0'}),
    'a count that is not one': withPreamble({words: -1}),
    'more latin1 strings than strings': withPreamble({narrow: pre.strings + 1}),
    'a shape with a key twice': withPreamble({shapes: [...pre.shapes.slice(0, -1), ['a', 'a']]}),
    'a string index out of its table': edit(b => b.writeInt32LE((pre.strings << 3) | 0, wordsAt + 4)),
    'a word out of range': edit(b => b.writeInt32LE(-8, wordsAt + 4)),
    'a word with no tag': edit(b => b.writeInt32LE(7, wordsAt + 4)),
    'a constant that is not one': edit(b => b.writeInt32LE((3 << 3) | 4, wordsAt + 4)),
    'an array longer than the words left': edit(b => b.writeInt32LE((pre.words << 3) | 2, wordsAt + 4)),
    'a number that is not finite': edit(b => b.writeDoubleLE(NaN, body)),
    'offsets that go backwards': edit(b => b.writeUInt32LE(0xffffff, body + 8 * pre.numbers + 4)),
  };
  // Encodings consistent in every count, assembled by hand: a word stream that ends inside its value, or holds words after it.
  const assemble = (shapes, words) => {
    const p = Buffer.from(JSON.stringify({encoding: STATE_ENCODING, numbers: 0, strings: 1, narrow: 1, words: words.length, latin1: 1, utf16: 0, shapes})), h = Buffer.alloc(4);
    h.writeUInt32LE(p.length);
    return Buffer.concat([h, p, Buffer.alloc((8 - ((4 + p.length) % 8)) % 8), Buffer.from(Uint32Array.from([0, 1]).buffer), Buffer.from(Int32Array.from(words).buffer), Buffer.from('a', 'latin1')]);
  };
  assert.deepEqual([decodeState(assemble([], [0])), decodeState(assemble([['k', 'v']], [3, 0, 0]))], ['a', {k: 'a', v: 'a'}], 'the hand-made encodings are sound');
  cases['words that end inside a value'] = assemble([['k', 'v']], [3, 0]);
  cases['words left after its value'] = assemble([], [0, 0]);
  for (const [what, bytes] of Object.entries(cases)) assert.throws(() => decodeState(bytes), new RegExp(`^Error: its state is not ${STATE_ENCODING.replace(/[./]/g, '\\$&')}: `), what);
  let deep = 1;
  for (let i = 0; i < 200; i++) deep = [deep];
  for (const [what, v] of Object.entries({undefined: {a: undefined}, 'a hole': [1, , 3], NaN: [NaN], Infinity: {x: Infinity}, 'a Date': [new Date(0)], 'a Map': new Map(), 'a function': [() => 1], 'a BigInt': [1n], 'nesting past the bound': deep})) {
    assert.throws(() => encodeState(v), e => e.code === 'GRAPH_SNAPSHOT' && /^the state cannot be encoded: /.test(e.message), what);
  }
});

test('format: writeSnapshot writes this format: the record\'s schema and encoding, the state at a multiple of 8, the state its compact encoding', t => {
  const {w, g} = storied(t), s = pinned(w);
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  const {head, nl, state} = split(r.file);
  assert.deepEqual([head.schema, head.body.schema, head.body.state_encoding, SNAPSHOT_SCHEMA], ['ophanim.graph.snapshot/v2', 'ophanim.graph.snapshot/v2', STATE_ENCODING, 'ophanim.graph.snapshot/v2']);
  assert.equal((nl + 1) % 8, 0, 'the header line is padded so the state starts at a multiple of 8');
  assert.deepEqual([state.length, sha(state)], [head.body.state_bytes, head.body.state_digest]);
  exactly(decodeState(state), g.projection.serialize(), 'the state written');
  assert.equal(decodeState(state).schema, STATE_SCHEMA);
  assert.equal(used(w.open(s.opts)), true);
});

/** A snapshot as the previous format wrote it (record v1, the state as JSON), signed by `signer`: what an older writer left. */
function olderSnapshot(file, signer) {
  const {head, state} = split(file), x = decodeState(state);
  const {order, ...rest} = x;
  void order;
  const bytes = Buffer.from(JSON.stringify({...rest, schema: 'ophanim.graph.projection-state/v1'}));
  const {state_encoding, ...b} = head.body;
  void state_encoding;
  const body = {...b, schema: 'ophanim.graph.snapshot/v1', state_digest: sha(bytes), state_bytes: bytes.length};
  const sig = edSign(null, Buffer.from(canonical(body)), createPrivateKey(signer.privatePem)).toString('base64');
  const out = path.join(path.dirname(file), `graph-snapshot-${String(body.position.seq).padStart(12, '0')}-${body.state_digest.slice(7, 23)}.json`);
  fs.writeFileSync(out, Buffer.concat([Buffer.from(JSON.stringify({schema: 'ophanim.graph.snapshot/v1', body, signature: {key_id: signer.key_id, public: signer.publicJwk, sig}}) + '\n'), bytes]));
  return {file: out, bytes};
}

test('format: a snapshot in the older format is refused as an older snapshot format and never decoded; the full open, or a snapshot in this format, is taken', t => {
  const {w, g} = storied(t), s = pinned(w);
  assert.deepEqual(OLDER_SNAPSHOT_SCHEMAS, ['ophanim.graph.snapshot/v1']);
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  const v1 = olderSnapshot(r.file, s.signer);
  fs.rmSync(r.file);
  // Only the older one: refused, with its reason; the full open is taken and nothing of the snapshot is trusted.
  const h = w.open(s.opts), full = w.open();
  assert.deepEqual([used(h), h.verification.snapshot.refused], [false, true]);
  assert.equal(h.verification.snapshot.reason, 'older snapshot format: ophanim.graph.snapshot/v1, not ophanim.graph.snapshot/v2 (the next writeSnapshot writes this reader\'s format)');
  const {snapshot, ...fields} = h.verification;
  void snapshot;
  assert.deepEqual([fields, h.digest()], [full.verification, full.digest()], 'the full open');
  // Its state is never read as this format's: the decoder refuses the older state's bytes too.
  assert.throws(() => decodeState(v1.bytes), /^Error: its state is not ophanim\.graph\.compact-state\/v1: /);
  // An older one newer than a snapshot in this format: refused as older, and the one in this format used.
  fs.rmSync(v1.file);
  const back = w.open(), first = writeSnapshot(back, {dir: s.dir, signer: s.signer});
  back.assert([tool({entity: id('evidence', 'observation', 'after')})], w.by('tool'));
  const newer = writeSnapshot(back, {dir: s.dir, signer: s.signer, retain: 3});
  olderSnapshot(newer.file, s.signer);
  fs.rmSync(newer.file);
  assert.deepEqual(listSnapshots(s.dir).map(x => x.seq), [newer.seq, first.seq]);
  const o = w.open(s.opts);
  assert.deepEqual([used(o), o.verification.snapshot.seq, o.verification.snapshot.tail], [true, first.seq, 1]);
  assert.deepEqual(o.verification.snapshot.refusals.map(x => [x.seq, x.reason.split(':')[0]]), [[newer.seq, 'older snapshot format']]);
  assert.equal(o.digest(), w.open().digest());
  // The next write is in this reader's format.
  assert.equal(split(writeSnapshot(o, {dir: s.dir, signer: s.signer}).file).head.schema, SNAPSHOT_SCHEMA);
});

/** The snapshot file rewritten with its state edited by `change` and re-signed by `signer`, the recorded digest kept. */
function resign(file, signer, change) {
  const {head, state} = split(file), x = decodeState(state);
  change(x);
  const bytes = encodeState(x), body = {...head.body, state_digest: sha(bytes), state_bytes: bytes.length};
  const sig = edSign(null, Buffer.from(canonical(body)), createPrivateKey(signer.privatePem)).toString('base64');
  fs.rmSync(file);
  fs.writeFileSync(path.join(path.dirname(file), `graph-snapshot-${String(body.position.seq).padStart(12, '0')}-${body.state_digest.slice(7, 23)}.json`),
    Buffer.concat([Buffer.from(JSON.stringify({...head, body, signature: {...head.signature, sig}}) + '\n'), bytes]));
}

test('format: the restored id order is checked -- a permutation of the assertions, strictly increasing by id -- or the snapshot is refused', t => {
  const {w, g} = storied(t), s = pinned(w);
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  const copy = fs.readFileSync(r.file);
  resign(r.file, s.signer, x => { const o = x.order; [o[0], o[1]] = [o[1], o[0]]; });
  const a = w.open(s.opts);
  assert.equal(used(a), false);
  assert.equal(a.verification.snapshot.reason, 'the projection state does not restore: its id order is not the order of its ids');
  assert.equal(a.digest(), g.digest());
  fs.rmSync(listSnapshots(s.dir).map(x => path.join(s.dir, x.name))[0]);
  fs.writeFileSync(r.file, copy);
  resign(r.file, s.signer, x => { x.order[1] = x.order[0]; });
  const b = w.open(s.opts);
  assert.deepEqual([used(b), b.verification.snapshot.reason], [false, 'the projection state does not restore: its id order does not list each assertion once']);
});

/**
 * THE ORACLE: the projection digest as its definition states it, computed by packages/ledger's canonical() digest from
 * the serialized state and the view's head and sources -- never by projection.mjs's digest code.
 */
function reference(g, c) {
  const x = g.projection.serialize(), v = g.view(c), byId = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const rows = x.assertions.filter(([, admitted]) => admitted <= c).map(([r, admitted, retired]) => {
    const ret = retired && retired.seq <= c ? retired : null;
    return [r.id, admitted, ret?.seq ?? null, ret?.how ?? null, ret?.by ?? null];
  }).sort(byId);
  const retractions = x.retractions.filter(([, seq]) => seq <= c).map(([r]) => r.id).sort();
  return 'sha256:' + digest({schema: 'ophanim.graph.projection/v1', contract: GRAPH_SCHEMA, seq: c, head: v.head, assertions: rows, retractions,
    sources: v.sources().map(s => [s.id, s.seq, s.version, s.state, s.replay])});
}

test('digest: the projection digest is canonical()\'s at every cursor -- sorted (the full open) or in the restored id order (a snapshot) -- and stays so after a write', t => {
  const {w, g} = storied(t, {checkpointEvery: 2}), s = pinned(w);
  writeSnapshot(g, {dir: s.dir, signer: s.signer});
  const full = w.open(), fast = w.open(s.opts);
  assert.equal(used(fast), true);
  for (let c = 0; c <= full.projection.seq; c++) {
    const want = reference(full, c);
    assert.deepEqual([full.digest(c), fast.digest(c)], [want, want], `cursor ${c}`);
  }
  // A write after the restore: the restored order no longer covers the assertions, and the digest is still canonical()'s.
  fast.assert([tool({entity: id('evidence', 'observation', 'late')})], w.by('tool'));
  const again = w.open();
  for (let c = 0; c <= again.projection.seq; c++) assert.deepEqual([fast.digest(c), again.digest(c)], [reference(again, c), reference(again, c)], `after the write, cursor ${c}`);
  // A row cell that is not a string, a finite number or null is written by canonical() itself (its keys sorted).
  const rest = {schema: 'ophanim.graph.projection/v1', contract: GRAPH_SCHEMA, seq: 1, head: null, retractions: [], sources: []};
  for (const rows of [[['sha256:a', 1, 2, 'retracted', {z: 1, a: 2}]], [['sha256:a', 1, null, null, null], ['sha256:b', 2, 3, 'superseded', 'sha256:c']], []]) {
    assert.equal(projectionDigest(rows, rest), 'sha256:' + digest({...rest, assertions: rows}), JSON.stringify(rows));
  }
  assert.throws(() => projectionDigest([], {...rest, extra: 1}), /the projection digest is over/);
});
