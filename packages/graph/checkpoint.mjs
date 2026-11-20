// THE REPLAY CHECKPOINT (register KG-1; its compact format, KG-9; docs/knowledge-graph/checkpoint.md).
//
// Purpose   Open a graph without re-deriving what has not changed. A SNAPSHOT is the projection state replay built, at
//           one ledger position, signed. It is a DERIVED cache, never authoritative, and may be deleted at any time: the
//           only consequence is a slower open.
// Trust     Two parts, and no third. The CHAIN rests on the ledger's own signed checkpoints (packages/ledger verify
//           mode 'frontier': the prefix re-hashed, signatures and payloads checked after the last checkpoint, authority
//           entries always). The DERIVED STATE rests on the snapshot's signature under a key the reader PINS. A snapshot
//           is used only when every check holds (openSnapshot); on any mismatch the caller performs the full open, as
//           without a snapshot, and the reason is recorded. Nothing is partially trusted.
// Inputs    writeSnapshot: an open graph, a directory and a signer ({key_id, privatePem}: packages/ledger
//           generateSigner). openSnapshot (called by openGraph's `snapshot` option): the directory and the pinned keys
//           ({key_id: publicJwk}). Which key signs snapshots is the owner's decision (KG-4): tests use synthetic keys.
//           A source adapter may declare `extractorVersion`, an opaque string naming the code its extractor runs (the
//           domain decides what it digests; this file only records and compares it): a snapshot derived by another
//           version of any source's extractor is refused. An adapter that declares none relies on verifySnapshot.
// Outputs   A file per snapshot, `graph-snapshot-<seq>-<state digest>.json`: one header line (the signed record,
//           ophanim.graph.snapshot/v2) and the serialized state in the compact encoding (encodeState below). A record of
//           an older format is refused as such ("older snapshot format"), never decoded. The graph's verification says
//           which open was taken: {snapshot: {used, seq, refused, reason}}.
// Must never  Write the ledger; let a reader see a partial file (a temporary file, then a rename in the same
//           directory); load a source better than the snapshot recorded it; accept a key the reader did not pin; read
//           a state as anything but exactly what was encoded.
//
// verifySnapshot imports openGraph (kinds.mjs), and openGraph calls openSnapshot: a module cycle of function
// declarations only, used at call time, never at evaluation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey} from 'node:crypto';
import {canonical, digest} from '../ledger/canonical.mjs';
import {defineKinds, openLedger} from '../ledger/chain.mjs';
import {GRAPH_SCHEMA, CONTRACT_VERSION, DOMAINS, RELATIONSHIPS, CLASSIFICATIONS, BASES, ORIGIN_KINDS, STATUSES, ACCESS, SOURCE_STATES, KINDS,
  RECORD_FIELDS, RETRACTION_FIELDS, CHANGE_LIST_MAX} from './schema.mjs';
import {entryHash} from './projection.mjs';
import {openGraph} from './kinds.mjs';

export const SNAPSHOT_SCHEMA = 'ophanim.graph.snapshot/v2';
/** The formats this reader recognizes as older than its own: refused as such, never decoded (KC-4). */
export const OLDER_SNAPSHOT_SCHEMAS = Object.freeze(['ophanim.graph.snapshot/v1']);
export const SNAPSHOT_FILE = /^graph-snapshot-(\d{12})-([0-9a-f]{16})\.json$/;
const H = value => 'sha256:' + digest(value);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = why => { throw Object.assign(new Error(why), {code: 'GRAPH_SNAPSHOT'}); };
const CHUNK = 1 << 20;
// A source whose facts the projection holds as re-derived ('applied'), or as a record that changes none ('recorded');
// any other replay status is a gap: what the snapshot holds of that source was not re-derived.
const WHOLE = new Set(['applied', 'recorded']);

/** The contract a projection is derived under: its version and the digest of the registries that decide admission. */
export function contractOf() {
  return {schema: GRAPH_SCHEMA, version: CONTRACT_VERSION, registry: H({domains: DOMAINS, relationships: RELATIONSHIPS, classifications: CLASSIFICATIONS,
    bases: BASES, origin_kinds: ORIGIN_KINDS, statuses: STATUSES, access: ACCESS, source_states: SOURCE_STATES, kinds: KINDS, record_fields: RECORD_FIELDS,
    retraction_fields: RETRACTION_FIELDS, change_list_max: CHANGE_LIST_MAX})};
}
/** The digest of a composed origin registry (defineOrigins). */
export const originsDigest = origins => H(origins);
/** The registered source adapters, as their identity: the facts a source yields name its extractor, authority and ref. */
const adaptersOf = adapters => [...adapters.values()].map(a => ({id: a.id, extractor: a.extractor ?? null, authority: a.authority ?? null, ref: a.ref ?? null}))
  .sort((a, b) => byString(a.id, b.id));
/**
 * Each registered source's extractor version, {source id: string | null (undeclared)}. The facts a source yields at one
 * version are a function of its extractor's code too: a replay by changed code yields other facts (a full open marks
 * that observation diverged), so a snapshot derived by other code is not this reader's.
 */
function extractorsOf(adapters) {
  const out = {};
  for (const a of [...adapters.values()].sort((x, y) => byString(x.id, y.id))) {
    const v = a.extractorVersion ?? null;
    if (v !== null && (typeof v !== 'string' || !v.length)) fail(`source ${a.id}: extractorVersion is a non-empty string, or absent`);
    out[a.id] = v;
  }
  return out;
}
/** Each source as the projection holds it at its cursor: {id, version, digest (of its facts), state, replay, seq}. */
function sourcesHeld(projection) {
  const v = projection.at(projection.seq);
  return v.sources().map(s => ({id: s.id, version: s.version, digest: v.assertion(s.record).record.attributes.digest ?? null, state: s.state, replay: s.replay, seq: s.seq}));
}

const signBody = (body, privatePem) => edSign(null, Buffer.from(canonical(body)), createPrivateKey(privatePem)).toString('base64');
const verifyBody = (body, sig, publicJwk) => {
  try { return edVerify(null, Buffer.from(canonical(body)), createPublicKey({key: publicJwk, format: 'jwk'}), Buffer.from(sig, 'base64')); }
  catch { return false; }
};

function writeAll(fd, bytes) {
  for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, Math.min(CHUNK, bytes.length - at));
}
function syncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch {} finally { if (fd !== null) fs.closeSync(fd); }
}

// ---- the state's compact encoding (register KG-9; docs/knowledge-graph/checkpoint.md section 4a) ------------------------
// The projection state (projection.serialize(): a JSON value) as a STRING TABLE, a SHAPE TABLE and a stream of 32-bit
// words, instead of a JSON object per fact. Every distinct string (an id, a subject, a source's authority and version, a
// digest) is stored once; every object is a shape (its keys, in its own order) followed by its values; every value is
// one word: (payload << 3) | tag. The decoded value is the serialized value exactly: the same strings (latin1 or UTF-16
// code units as given, so a lone surrogate survives), the same numbers (-0 and fractions in a float64 table), the same
// key order, arrays dense. Layout, little-endian, the typed sections aligned:
//   u32 L | preamble (L bytes of JSON) | pad to 8 | numbers: f64 x N | offsets: u32 x (S + 1) | words: i32 x W |
//   latin1 text | UTF-16LE text
// The offsets are byte offsets into the latin1 text followed by the UTF-16LE text: the strings whose every code unit
// fits one byte first (`narrow` of them), then the rest. The decoder refuses (throws) anything else: another encoding,
// sections that do not add up to the bytes, an index out of its table, a word stream not consumed exactly, nesting past
// the bound. It never guesses.
export const STATE_ENCODING = 'ophanim.graph.compact-state/v1';
const T_STRING = 0, T_INT = 1, T_ARRAY = 2, T_OBJECT = 3, T_CONST = 4, T_NUMBER = 5;
const PAYLOAD = 2 ** 28, MAX_NESTING = 128, LITTLE = os.endianness() === 'LE';
const pad8 = n => (8 - (n % 8)) % 8;
const encodingFail = why => fail(`the state cannot be encoded: ${why}`);

/** The state value as the compact encoding's bytes (writeSnapshot). Refuses a value that is not plain JSON. */
export function encodeState(value) {
  if (!LITTLE) encodingFail('the compact state is written on little-endian platforms only');
  const strings = new Map(), shapes = new Map(), shapeKeys = [], numbers = [];
  let words = new Int32Array(1 << 16), n = 0;
  const word = w => { if (n === words.length) { const x = new Int32Array(words.length * 2); x.set(words); words = x; } words[n++] = w; };
  const index = (count, what) => { if (count >= PAYLOAD) encodingFail(`more than ${PAYLOAD} ${what}`); return count; };
  const put = (v, depth) => {
    if (depth > MAX_NESTING) encodingFail(`it nests deeper than ${MAX_NESTING}`);
    if (v === null) return word(T_CONST);
    switch (typeof v) {
      case 'boolean': return word(((v ? 2 : 1) << 3) | T_CONST);
      case 'string': { let i = strings.get(v); if (i === undefined) strings.set(v, i = index(strings.size, 'strings')); return word((i << 3) | T_STRING); }
      case 'number':
        if (!Number.isFinite(v)) encodingFail(`it holds a number that is not finite (${v})`);
        if (Number.isInteger(v) && v >= 0 && v < PAYLOAD && !Object.is(v, -0)) return word((v << 3) | T_INT);
        numbers.push(v);
        return word((index(numbers.length - 1, 'numbers') << 3) | T_NUMBER);
      case 'object': {
        if (Array.isArray(v)) {
          word((index(v.length, 'array elements') << 3) | T_ARRAY);
          for (let i = 0; i < v.length; i++) { if (!Object.hasOwn(v, i)) encodingFail('it holds a sparse array'); put(v[i], depth + 1); }
          return;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) encodingFail('it holds an object that is not plain');
        const keys = Object.keys(v), name = JSON.stringify(keys);
        let s = shapes.get(name);
        if (s === undefined) { shapes.set(name, s = index(shapes.size, 'shapes')); shapeKeys.push(keys); }
        word((s << 3) | T_OBJECT);
        for (const k of keys) put(v[k], depth + 1);
        return;
      }
    }
    encodingFail(`it holds a ${typeof v}, which is not JSON`);
  };
  put(value, 0);
  // The string table: the strings whose every code unit fits one byte first (latin1), then the rest (UTF-16LE).
  const all = [...strings.keys()], narrow = [], wide = [];
  for (const s of all) (/[^\u0000-ÿ]/.test(s) ? wide : narrow).push(s);
  const order = [...narrow, ...wide], remap = new Int32Array(all.length);
  order.forEach((s, i) => { remap[strings.get(s)] = i; });
  for (let i = 0; i < n; i++) if ((words[i] & 7) === T_STRING) words[i] = (remap[words[i] >>> 3] << 3) | T_STRING;
  const offsets = new Uint32Array(order.length + 1);
  for (let i = 0, at = 0; i < order.length; i++) { offsets[i] = at; at += order[i].length * (i < narrow.length ? 1 : 2); offsets[i + 1] = at; }
  const latin1 = Buffer.from(narrow.join(''), 'latin1'), utf16 = Buffer.from(wide.join(''), 'utf16le');
  const preamble = Buffer.from(JSON.stringify({encoding: STATE_ENCODING, numbers: numbers.length, strings: order.length, narrow: narrow.length, words: n,
    latin1: latin1.length, utf16: utf16.length, shapes: shapeKeys}));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(preamble.length);
  return Buffer.concat([head, preamble, Buffer.alloc(pad8(4 + preamble.length)), Buffer.from(Float64Array.from(numbers).buffer),
    Buffer.from(offsets.buffer), Buffer.from(words.buffer, 0, n * 4), latin1, utf16]);
}

/** The state value the compact encoding's `bytes` hold; throws, saying why, if they are not exactly that encoding. */
export function decodeState(bytes) {
  const bad = why => { throw new Error(`its state is not ${STATE_ENCODING}: ${why}`); };
  if (!LITTLE) bad('the compact state is read on little-endian platforms only');
  if (bytes.length < 4) bad('it is shorter than its preamble');
  const L = bytes.readUInt32LE(0);
  if (4 + L > bytes.length) bad('its preamble runs past its end');
  let pre = null;
  try { pre = JSON.parse(bytes.toString('utf8', 4, 4 + L)); } catch {}
  if (!plain(pre) || pre.encoding !== STATE_ENCODING) bad('its preamble does not name the encoding');
  const count = k => (Number.isInteger(pre[k]) && pre[k] >= 0 && pre[k] < PAYLOAD ? pre[k] : bad(`its preamble's ${k} is not a count`));
  const N = count('numbers'), S = count('strings'), S1 = count('narrow'), W = count('words'), B1 = count('latin1'), B2 = count('utf16');
  if (S1 > S) bad('it has more latin1 strings than strings');
  if (!Array.isArray(pre.shapes) || pre.shapes.length >= PAYLOAD) bad('its shapes are not a list');
  let at = 4 + L + pad8(4 + L);
  if (at + 8 * N + 4 * (S + 1) + 4 * W + B1 + B2 !== bytes.length) bad('its sections do not add up to its length');
  const view = (Type, length) => {
    const offset = bytes.byteOffset + at, size = length * Type.BYTES_PER_ELEMENT;
    const v = offset % Type.BYTES_PER_ELEMENT === 0 ? new Type(bytes.buffer, offset, length) : new Type(new Uint8Array(bytes.subarray(at, at + size)).buffer);
    at += size;
    return v;
  };
  const numbers = view(Float64Array, N), offsets = view(Uint32Array, S + 1), words = view(Int32Array, W);
  for (let i = 0; i < N; i++) if (!Number.isFinite(numbers[i])) bad('a number is not finite');
  // Each string is its own (flat) string, read from its bytes: the first S1 as latin1, one byte a code unit, the rest as
  // UTF-16LE, two bytes a code unit. (Slices of one large string would compare and serialize slower.)
  if (offsets[0] !== 0 || offsets[S1] !== B1 || offsets[S] !== B1 + B2) bad('its string offsets do not span its texts');
  const table = new Array(S);
  for (let i = 0; i < S; i++) {
    const from = offsets[i], to = offsets[i + 1];
    if (to < from) bad('its string offsets go backwards');
    if (i < S1) table[i] = bytes.toString('latin1', at + from, at + to);
    else if ((to - from) % 2) bad('a UTF-16 string is not whole code units');
    else table[i] = bytes.toString('utf16le', at + from, at + to);
  }
  // One template per shape, its keys in its order (own data properties, "__proto__" included): an object is a copy of
  // its template with its values written in.
  const keysOf = pre.shapes, templates = keysOf.map(keys => {
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string') || new Set(keys).size !== keys.length) bad('a shape is not a list of distinct keys');
    const t = {};
    for (const k of keys) Object.defineProperty(t, k, {value: null, writable: true, enumerable: true, configurable: true});
    return t;
  });
  let p = 0;
  const get = depth => {
    if (p >= W) bad('its words end inside a value');
    if (depth > MAX_NESTING) bad(`it nests deeper than ${MAX_NESTING}`);
    const w = words[p++], x = w >>> 3;
    if (w < 0) bad('a word is out of range');
    switch (w & 7) {
      case T_STRING: return x < S ? table[x] : bad('a string index is out of its table');
      case T_INT: return x;
      case T_ARRAY: {
        if (x > W - p) bad('an array is longer than the words left');
        if (x === 0) return [];
        const a = new Array(x);
        for (let i = 0; i < x; i++) a[i] = get(depth + 1);
        return a;
      }
      case T_OBJECT: {
        if (x >= templates.length) bad('a shape index is out of its table');
        const keys = keysOf[x], o = {...templates[x]};
        for (let i = 0; i < keys.length; i++) o[keys[i]] = get(depth + 1);
        return o;
      }
      case T_CONST: return x === 0 ? null : x === 1 ? false : x === 2 ? true : bad('a constant is not null, false or true');
      case T_NUMBER: return x < N ? numbers[x] : bad('a number index is out of its table');
    }
    return bad('a word has no tag');
  };
  const value = get(0);
  if (p !== W) bad('words are left after its value');
  return value;
}

/** The snapshot files in `dir`, newest first (by the seq they cover, then by name). */
export function listSnapshots(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.map(n => SNAPSHOT_FILE.exec(n)).filter(Boolean).map(m => ({name: m[0], seq: Number(m[1])}))
    .sort((a, b) => b.seq - a.seq || byString(b.name, a.name));
}

/** Keep the newest `retain` snapshots in `dir`; the names removed. */
function retention(dir, retain) {
  const removed = [];
  for (const s of listSnapshots(dir).slice(retain)) {
    try { fs.rmSync(path.join(dir, s.name)); removed.push(s.name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return removed;
}

/**
 * Write a snapshot of `graph` (openGraph's result) into `dir`, signed by `signer`. Atomic: a temporary file in `dir`,
 * then a rename, so a reader never sees a partial file; two writers of the same state write the same name, and one
 * file remains. Keeps the newest `retain` snapshots. Never writes the ledger. WHEN to write is the caller's choice.
 * {file, seq, hash, state_digest, projection_digest, bytes, removed}.
 */
export function writeSnapshot(graph, {dir, signer, retain = 2} = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('a snapshot directory is an absolute path');
  if (!signer?.key_id || !signer?.privatePem) fail('a snapshot is signed by a key: {key_id, privatePem}');
  if (!Number.isInteger(retain) || retain < 1) fail('retention keeps at least one snapshot');
  const p = graph.projection;
  if (p.seq === 0) fail('the graph has applied no entry: there is nothing to snapshot');
  const at = graph.ledger.read()[p.seq - 1];
  if (!at || entryHash(at) !== p.head) fail(`the projection's position (seq ${p.seq}) is not an entry of its ledger; refresh the graph first`);
  const bytes = encodeState(p.serialize());
  const body = {schema: SNAPSHOT_SCHEMA, anchor: graph.anchor, instance: p.instance, position: {seq: p.seq, hash: p.head}, contract: contractOf(),
    origins: originsDigest(p.origins), adapters: adaptersOf(p.adapters), extractors: extractorsOf(p.adapters), sources: sourcesHeld(p), projection_digest: p.digest(p.seq),
    state_encoding: STATE_ENCODING, state_digest: sha(bytes), state_bytes: bytes.length};
  const signature = {key_id: signer.key_id, public: createPublicKey(createPrivateKey(signer.privatePem)).export({format: 'jwk'}), sig: signBody(body, signer.privatePem)};
  // The header line is padded with JSON whitespace so that the state starts at a multiple of 8 bytes: a reader then
  // views its typed sections in place (decodeState copies a section that is not aligned).
  const line = JSON.stringify({schema: SNAPSHOT_SCHEMA, body, signature});
  const header = Buffer.from(line + ' '.repeat(pad8(Buffer.byteLength(line) + 1)) + '\n');
  fs.mkdirSync(dir, {recursive: true});
  const name = `graph-snapshot-${String(p.seq).padStart(12, '0')}-${body.state_digest.slice(7, 23)}.json`, file = path.join(dir, name);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}-${name}`);
  let fd = fs.openSync(tmp, 'wx');
  try {
    writeAll(fd, header);
    writeAll(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, {force: true});
    throw e;
  }
  syncDir(dir);
  return {file, seq: p.seq, hash: p.head, state_digest: body.state_digest, projection_digest: body.projection_digest, bytes: header.length + bytes.length,
    removed: retention(dir, retain)};
}

// ---- reading ----------------------------------------------------------------------------------------------------------
/** Why a snapshot's signed record is refused by this reader, or null. Decided from the record alone. */
function headerRefusal(head, {keys, anchor, contract, origins, instance, adapters, extractors}) {
  // An older format is refused as such before anything of it is read: its state is never decoded as this format's (KC-4).
  const older = [head?.schema, head?.body?.schema].find(s => OLDER_SNAPSHOT_SCHEMAS.includes(s));
  if (older) return `older snapshot format: ${older}, not ${SNAPSHOT_SCHEMA} (the next writeSnapshot writes this reader's format)`;
  if (!plain(head) || head.schema !== SNAPSHOT_SCHEMA || !plain(head.body) || !plain(head.signature)) return `the record is not ${SNAPSHOT_SCHEMA}`;
  const {body, signature} = head;
  if (body.schema !== SNAPSHOT_SCHEMA || body.state_encoding !== STATE_ENCODING) return `the record is not ${SNAPSHOT_SCHEMA}`;
  const pinned = typeof signature.key_id === 'string' && Object.hasOwn(keys, signature.key_id) ? keys[signature.key_id] : null;
  if (!pinned) return `it is signed by key "${signature.key_id}", which this reader has not pinned`;
  if (typeof signature.sig !== 'string' || !verifyBody(body, signature.sig, pinned)) return `its signature does not verify under the pinned key "${signature.key_id}"`;
  if (body.anchor !== anchor) return `it is of the ledger anchored at ${body.anchor}, not ${anchor}`;
  if (canonical(body.contract) !== canonical(contract)) return `it was derived under contract ${body.contract?.version} (registry ${body.contract?.registry}), not this reader's ${contract.version} (registry ${contract.registry})`;
  if (body.origins !== origins) return `it was derived under origin registry ${body.origins}, not this reader's ${origins}`;
  if (body.instance !== instance) return `it is of instance ${body.instance}, not ${instance}`;
  if (canonical(body.adapters) !== canonical(adapters)) return 'it was derived with other registered sources than this reader\'s';
  const was = id => (plain(body.extractors) && Object.hasOwn(body.extractors, id) ? body.extractors[id] : null);
  const moved = Object.keys(extractors).find(id => was(id) !== extractors[id]);
  if (moved !== undefined) return `the extractor of source "${moved}" is ${extractors[moved]} here, not ${was(moved)} as when it was derived (other code yields other facts)`;
  return null;
}

/** Why the ledger refuses the position a snapshot covers, or null: its entry at that seq must be the one recorded. */
function positionRefusal({seq, hash} = {}, entries, kinds) {
  if (!Number.isInteger(seq) || seq < 1) return 'its position is not a ledger seq';
  if (seq > entries.length) return `it covers seq ${seq}, but the ledger holds ${entries.length} entries (a rewritten or replaced ledger)`;
  if (entryHash(entries[seq - 1]) !== hash) return `the ledger's entry at seq ${seq} is not the one it covers (a rewritten or forked ledger)`;
  if (!Object.hasOwn(kinds, entries[seq - 1].kind)) return `the ledger's entry at seq ${seq} is not a graph entry`;
  return null;
}

/** Restore `projection` from the state bytes and check them against the record; why it is refused, or null. */
function stateRefusal(body, state, projection) {
  if (state.length !== body.state_bytes || sha(state) !== body.state_digest) return 'its state is not the state it signed';
  let x;
  try { x = decodeState(state); } catch (e) { return e.message; }
  try { projection.restore(x); } catch (e) { return e.message; }
  let why;
  try {
    why = projection.seq !== body.position.seq || projection.head !== body.position.hash ? 'its state is not at the position it covers'
    : projection.digest(body.position.seq) !== body.projection_digest ? 'its state does not reproduce its recorded projection digest'
      : canonical(sourcesHeld(projection)) !== canonical(body.sources) ? 'its state does not hold the sources it records'
        : null;
  } catch (e) { why = `its restored state cannot be checked: ${e.message}`; }
  if (why) projection.reset();
  return why;
}

/**
 * Apply the verified entries after the snapshot by the normal path: for each graph entry, what the ledger checks when
 * it re-derives an entry (the payload intact, its author, the payload's validation) and then the kind's re-derivation
 * itself (the projection's sync: checked against the state before it, then applied). What could not be re-derived is
 * noted against that entry, as the ledger notes it. {rederived, partial} or {why}.
 */
function applyTail(entries, from, kinds, ledger) {
  const partial = [];
  let rederived = 0;
  const index = new Map();
  for (let i = from - 1; i < entries.length; i++) index.set(entryHash(entries[i]), i);
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (!Object.hasOwn(kinds, e.kind)) continue;                 // genesis, checkpoint, authority: the chain's, verified there
    const k = kinds[e.kind];
    const payload = ledger.payloadOf(e);
    if (payload === null) return {why: `entry ${i}: payload object missing or altered`};
    if (!k.authors(e.author)) return {why: `entry ${i}: ${e.author?.key_id} may not author "${e.kind}"`};
    const bad = k.validate(payload);
    if (bad) return {why: `entry ${i}: ${bad}`};
    const notes = [];
    const earlier = h => (index.has(h) && index.get(h) < i ? entries[index.get(h)] : null);
    const view = {entry: earlier, payload: h => (earlier(h) ? ledger.payloadOf(earlier(h)) : null), note: why => { notes.push(String(why)); }};
    const why = k.rederive({...e, payload}, view);
    if (why) return {why: `entry ${i}: does not re-derive: ${why}`};
    for (const n of notes) partial.push({seq: e.seq, kind: e.kind, why: n});
    rederived++;
  }
  return {rederived, partial};
}

/** The kinds for verifying the chain alone: every check the ledger makes, but re-derivation left to the snapshot path. */
const chainOnly = kinds => defineKinds(Object.fromEntries(Object.entries(kinds).map(([name, k]) => [name, {...k, rederive: () => null}])));

/**
 * OPEN FROM A SNAPSHOT (openGraph's `snapshot` option: {dir, keys}). Uses the newest snapshot in `dir` for which ALL
 * hold: its signature verifies under a key of `keys` (the reader's pinned set); its anchor is the ledger's; the ledger's
 * own entry at its seq has its recorded hash; its contract, registry, origin registry, instance and registered sources
 * are the reader's; its state is the one it signed and reproduces its recorded projection digest. Then the chain is
 * verified in frontier mode, the projection is restored, and the entries after the snapshot are applied by the normal
 * path, each re-derived. {used: true, verification} or {used: false, info}: the caller then performs the full open.
 */
export function openSnapshot({snapshot, dir, anchor, ledger, kinds, projection, checkpointEvery, lockTimeoutMs, lockStaleMs, log}) {
  if (!plain(snapshot) || typeof snapshot.dir !== 'string' || !path.isAbsolute(snapshot.dir) || !plain(snapshot.keys)) {
    throw Object.assign(new Error('snapshot is {dir: an absolute directory, keys: {key_id: public key}}'), {code: 'GRAPH_REFUSED'});
  }
  const expect = {keys: snapshot.keys, anchor, contract: contractOf(), origins: originsDigest(projection.origins), instance: projection.instance,
    adapters: adaptersOf(projection.adapters), extractors: extractorsOf(projection.adapters)};
  const refusals = [];
  // Declined: the caller performs the full open, and the reason is recorded in its verification.
  const declined = reason => ({used: false, info: {used: false, seq: refusals[0]?.seq ?? null, refused: refusals.length > 0, reason, refusals}});
  // A directory that exists but cannot be listed is a reason to take the full open, never an error of the open.
  let files;
  try { files = listSnapshots(snapshot.dir); } catch (e) { return declined(`the snapshot directory could not be listed (${e.code ?? e.message})`); }
  if (!files.length) return declined('there is no snapshot in the snapshot directory');
  let chain = null;
  for (const f of files) {
    const refuse = reason => { refusals.push({file: f.name, seq: f.seq, reason}); };
    let raw;
    try { raw = fs.readFileSync(path.join(snapshot.dir, f.name)); } catch (e) { refuse(`it could not be read (${e.code ?? e.message})`); continue; }
    const nl = raw.indexOf(0x0a);
    let head = null;
    try { head = nl > 0 ? JSON.parse(raw.subarray(0, nl).toString('utf8')) : null; } catch {}
    const why = head === null ? 'it is not a snapshot record (a partial or foreign file)' : headerRefusal(head, expect);
    if (why) { refuse(why); continue; }
    if (!chain) {
      let v;
      try { v = openLedger({dir, kinds: chainOnly(kinds), anchor, checkpointEvery, lockTimeoutMs, lockStaleMs, log}).verify({mode: 'frontier'}); }
      catch (e) { v = {ok: false, why: e.message}; }
      if (!v.ok) return declined(`the ledger does not verify: ${v.why}`);
      let entries;
      try { entries = ledger.read(); } catch (e) { return declined(`the ledger could not be read: ${e.message}`); }
      if (entries.length < v.entries || entryHash(entries[v.entries - 1]) !== v.head) return declined('the ledger changed while it was verified');
      chain = {v, entries: entries.slice(0, v.entries)};
    }
    const body = head.body;
    const at = positionRefusal(body.position, chain.entries, kinds) ?? stateRefusal(body, raw.subarray(nl + 1), projection);
    if (at) { refuse(at); continue; }
    const tail = applyTail(chain.entries, body.position.seq, kinds, ledger);
    if (tail.why) { projection.reset(); refuse(`the entries after it do not re-derive on its state: ${tail.why}`); continue; }
    // The sources it holds without having re-derived them are noted, as a full open notes a source it cannot read: a
    // snapshot never loads a source better than it recorded it.
    const gaps = body.sources.filter(s => !WHOLE.has(s.replay)).map(s => ({seq: s.seq, kind: chain.entries[s.seq - 1].kind,
      why: `${s.id}@${s.version}: replay ${s.replay}, as the snapshot at seq ${body.position.seq} recorded it; its facts are not re-derived here`}));
    const partial = [...gaps, ...tail.partial];
    return {used: true, verification: {ok: true, entries: chain.v.entries, head: chain.v.head, rederived: tail.rederived, partial,
      complete: chain.v.complete && partial.length === 0, notes: [],
      snapshot: {used: true, seq: body.position.seq, hash: body.position.hash, file: f.name, key_id: head.signature.key_id, state_digest: body.state_digest,
        projection_digest: body.projection_digest, sources: body.sources, tail: tail.rederived, refused: false, reason: null, refusals}}};
  }
  return declined(refusals[0].reason);
}

/**
 * THE AUDIT: open the graph both ways, from its snapshot and by the full open, and compare. `options` are openGraph's,
 * with `snapshot`. {ok, used, seq, recorded, full, snapshot, differences, reason}. Writes nothing. How often to run it
 * is the owner's decision.
 */
export function verifySnapshot(options) {
  const {snapshot, ...rest} = options;
  if (!snapshot) fail('verifySnapshot compares an open from a snapshot with the full open: name the snapshot');
  const full = openGraph(rest), fast = openGraph({...rest, snapshot}), s = fast.verification.snapshot;
  const result = {used: s.used, seq: s.seq, recorded: s.projection_digest ?? null, reason: s.reason, refusals: s.refusals,
    full: {seq: full.projection.seq, digest: full.digest()}, snapshot: {seq: fast.projection.seq, digest: fast.digest()}};
  if (!s.used) return {ok: false, ...result, differences: [`the snapshot was not used: ${s.reason}`]};
  const differences = [];
  const atFull = full.digest(s.seq), atFast = fast.digest(s.seq);
  if (atFull !== s.projection_digest) differences.push(`at seq ${s.seq} the full open's digest is ${atFull}, the snapshot recorded ${s.projection_digest}`);
  if (atFast !== atFull) differences.push(`at seq ${s.seq} the open from the snapshot gives ${atFast}, the full open ${atFull}`);
  if (fast.digest() !== full.digest()) differences.push(`at the head the open from the snapshot gives ${fast.digest()}, the full open ${full.digest()}`);
  const fields = v => canonical({ok: v.ok, entries: v.entries, head: v.head, partial: v.partial, complete: v.complete, notes: v.notes});
  if (fields(fast.verification) !== fields(full.verification)) differences.push('the verification fields differ');
  return {ok: differences.length === 0, ...result, at: {seq: s.seq, full: atFull, snapshot: atFast}, differences};
}
