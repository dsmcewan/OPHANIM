// The system ledger's core (K1, docs/ledger-provenance-evaluation.md).
//
// TELOS's proposal ledger is the model: one signed, hash-chained line, verified before every append,
// forks refused. This generalizes it without touching the pinned TELOS:
//   - one chain, MANY kinds, from a CLOSED registry; each kind names who may author it, validates its
//     payload, and RE-DERIVES the entry from the entries it cites (TELOS's verify() re-runs the test;
//     here every kind re-derives);
//   - every entry is signed by its OWN author's key (not one controller key, not a shared secret), and
//     the orderer co-signs only its place in the chain;
//   - payloads are content-addressed objects; an entry carries their digest, never a copy;
//   - signed checkpoints commit to every earlier entry hash, so verification resumes from the last
//     checkpoint and re-derives only the frontier (OPHANIM P6/P8), while the prefix is still re-hashed.
//
// Strict reading: a torn or unparseable line anywhere is an error, never skipped. Nothing here trusts a
// record it has not re-derived.
import fs from 'node:fs';
import path from 'node:path';
import {sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, generateKeyPairSync} from 'node:crypto';
import {canonical, digest} from './canonical.mjs';

export const LEDGER_SCHEMA = 'ophanim.ledger/v1';
export const CHECKPOINT = 'checkpoint';
// K2: the ledger's authority is its own first entry. `genesis` names the keyring, the orderer and the
// operators (and any pins the caller wants bound, e.g. TELOS's). Readers pin the genesis HASH, so a
// ledger that names its own authority is refused unless that authority is the one they pinned.
// `authority` entries, signed by a current operator, add or revoke keys and change roles from then on.
export const GENESIS = 'genesis';
export const AUTHORITY = 'authority';
const RESERVED = new Set([CHECKPOINT, GENESIS, AUTHORITY]);
const H = value => 'sha256:' + digest(value);
const fail = why => { throw Object.assign(new Error(why), {code: 'LEDGER_REFUSED'}); };

export function generateSigner(key_id) {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  return {key_id, privatePem: privateKey.export({type: 'pkcs8', format: 'pem'}), publicJwk: publicKey.export({format: 'jwk'})};
}
const signBytes = (value, privatePem) => edSign(null, Buffer.from(canonical(value)), createPrivateKey(privatePem)).toString('base64');
const verifyBytes = (value, sig, publicJwk) => {
  try { return edVerify(null, Buffer.from(canonical(value)), createPublicKey({key: publicJwk, format: 'jwk'}), Buffer.from(sig, 'base64')); }
  catch { return false; }
};

/**
 * A closed kind registry. Each kind: { authors(author) -> bool, validate(payload) -> why|null,
 * rederive(entry, view) -> why|null }. `checkpoint` is reserved for the orderer.
 */
export function defineKinds(spec) {
  for (const r of RESERVED) if (Object.hasOwn(spec, r)) fail(`kind "${r}" is reserved`);
  for (const [kind, k] of Object.entries(spec)) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(kind)) fail(`kind name "${kind}" is not an identifier`);
    for (const fn of ['authors', 'validate', 'rederive']) if (typeof k[fn] !== 'function') fail(`kind "${kind}" lacks ${fn}()`);
  }
  return Object.freeze({...spec});
}

// The body an author signs: everything about the entry except its place in the chain and the signatures.
const bodyOf = e => ({schema: e.schema, kind: e.kind, author: e.author, derived_from: e.derived_from, payload_ref: e.payload_ref});
const orderOf = e => ({seq: e.seq, parent: e.parent, body: H(bodyOf(e))});
const hashOf = e => H(e);
// A checkpoint commits to the ordered list of every entry hash before it.
const rootOf = hashes => H({hashes});

const validAuthority = p => p && typeof p === 'object' && p.keyring && typeof p.keyring === 'object'
  && typeof p.orderer === 'string' && Array.isArray(p.operators) && p.operators.length > 0;

// The authority as of a point in the chain: genesis, then each authority entry applied in order.
function applyAuthority(auth, payload) {
  const keys = {...auth.keys, ...(payload.add ?? {})};
  for (const id of payload.revoke ?? []) delete keys[id];
  return {keys, orderer: payload.orderer ?? auth.orderer, operators: payload.operators ?? auth.operators, pins: auth.pins};
}
const authorityValid = a => Object.hasOwn(a.keys, a.orderer) && a.operators.length > 0 && a.operators.every(o => Object.hasOwn(a.keys, o));

/**
 * Open a ledger. `anchor` is the genesis hash the reader trusts; it is required, so a ledger is never
 * trusted on the strength of the authority it names for itself.
 */
export function openLedger({dir, kinds, anchor, checkpointEvery = 64}) {
  if (!dir || !path.isAbsolute(dir)) fail('an absolute ledger directory is required');
  if (typeof anchor !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(anchor)) fail('a pinned genesis hash (anchor) is required');
  const file = path.join(dir, 'chain.jsonl');
  const objects = path.join(dir, 'objects');
  fs.mkdirSync(objects, {recursive: true});
  const objectPath = ref => path.join(objects, ref.slice('sha256:'.length) + '.json');

  function putObject(value) {
    const ref = H(value), p = objectPath(ref), bytes = canonical(value);
    if (fs.existsSync(p)) { if ('sha256:' + digest(JSON.parse(fs.readFileSync(p, 'utf8'))) !== ref) fail(`object collision at ${ref}`); }
    else fs.writeFileSync(p, bytes);
    return ref;
  }
  function getObject(ref) {
    if (typeof ref !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(ref)) return null;
    const p = objectPath(ref);
    if (!fs.existsSync(p)) return null;
    let value; try { value = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    return H(value) === ref ? value : null;           // tampered object: refused, never repaired
  }

  function read() {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) !== '') fail('ledger ends mid-line (torn append)');
    return lines.slice(0, -1).map((line, i) => { try { return JSON.parse(line); } catch { return fail(`line ${i} is not JSON`); } });
  }

  // One entry against everything before it. Returns the reason it is refused, or null.
  function check(e, i, prev, byHash, auth, {rederive}) {
    const keyOf = id => (typeof id === 'string' && auth && Object.hasOwn(auth.keys, id) ? auth.keys[id] : null);
    if (i === 0) return checkGenesis(e);
    if (e?.kind === GENESIS) return `entry ${i}: only the first entry is a genesis`;
    if (e?.schema !== LEDGER_SCHEMA) return `entry ${i}: unknown schema`;
    if (e.seq !== i + 1) return `entry ${i}: sequence ${e.seq} does not continue the chain`;
    if (e.parent !== (prev ? hashOf(prev) : null)) return `entry ${i}: parent is not the previous entry (fork, reorder or deletion)`;
    if (!Array.isArray(e.derived_from) || e.derived_from.some(h => !byHash.has(h))) return `entry ${i}: cites an entry that is not earlier in the chain`;
    const orderKey = keyOf(auth.orderer);
    if (!e.order_sig || !verifyBytes(orderOf(e), e.order_sig, orderKey)) return `entry ${i}: order signature invalid`;
    const authorKey = keyOf(e.author?.key_id);
    if (!authorKey) return `entry ${i}: author key "${e.author?.key_id}" is not in the keyring`;
    if (!e.author_sig || !verifyBytes(bodyOf(e), e.author_sig, authorKey)) return `entry ${i}: author signature invalid`;
    const payload = getObject(e.payload_ref);
    if (payload === null) return `entry ${i}: payload object missing or altered`;
    if (e.kind === AUTHORITY) {
      if (!auth.operators.includes(e.author.key_id)) return `entry ${i}: only an operator changes the authority`;
      const next = applyAuthority(auth, payload);
      return authorityValid(next) ? null : `entry ${i}: the resulting authority has no valid orderer or operator`;
    }
    if (e.kind === CHECKPOINT) {
      if (e.author.key_id !== auth.orderer) return `entry ${i}: only the orderer writes checkpoints`;
      const before = [...byHash.keys()];
      if (payload.through !== i || payload.root !== rootOf(before)) return `entry ${i}: checkpoint does not commit to the chain before it`;
      return null;
    }
    if (!Object.hasOwn(kinds, e.kind)) return `entry ${i}: kind "${e.kind}" is not in the registry`;
    const k = kinds[e.kind];
    if (!k.authors(e.author)) return `entry ${i}: ${e.author.key_id} may not author "${e.kind}"`;
    const bad = k.validate(payload);
    if (bad) return `entry ${i}: ${bad}`;
    if (rederive) {
      // entries(): the hashes of every earlier entry, in chain order, for kinds that count what came before.
      const view = {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? getObject(byHash.get(h).payload_ref) : null),
        entries: () => [...byHash.keys()]};
      const why = k.rederive({...e, payload}, view);
      if (why) return `entry ${i}: does not re-derive: ${why}`;
    }
    return null;
  }

  function checkGenesis(e) {
    if (e?.schema !== LEDGER_SCHEMA || e.kind !== GENESIS || e.seq !== 1 || e.parent !== null) return 'entry 0: the chain must open with a genesis';
    if (hashOf(e) !== anchor) return 'entry 0: genesis is not the pinned anchor (a ledger may not name its own authority)';
    const payload = getObject(e.payload_ref);
    if (!validAuthority(payload)) return 'entry 0: genesis payload is not an authority';
    const a = {keys: payload.keyring, orderer: payload.orderer, operators: payload.operators};
    if (!authorityValid(a) || !a.operators.includes(e.author?.key_id)) return 'entry 0: genesis is not signed by one of its operators';
    if (!verifyBytes(bodyOf(e), e.author_sig, a.keys[e.author.key_id]) || !verifyBytes(orderOf(e), e.order_sig, a.keys[a.orderer])) return 'entry 0: genesis signatures invalid';
    return null;
  }
  const authorityAfter = (auth, e) => {
    if (e.kind === GENESIS) { const p = getObject(e.payload_ref); return {keys: p.keyring, orderer: p.orderer, operators: p.operators, pins: p.pins ?? null}; }
    if (e.kind === AUTHORITY) return applyAuthority(auth, getObject(e.payload_ref));
    return auth;
  };

  /**
   * Verify the chain. mode "full" re-derives every entry; "frontier" re-hashes the whole prefix
   * (so any edit is caught) but re-checks signatures and re-derives only after the last checkpoint.
   */
  function verify({mode = 'full'} = {}) {
    const entries = read();
    const byHash = new Map();
    let lastCheckpoint = -1;
    if (mode === 'frontier') {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.kind === CHECKPOINT) { lastCheckpoint = i; break; }
    }
    if (!entries.length) return {ok: false, why: 'empty ledger: no genesis'};
    let rederived = 0, auth = null;
    for (const [i, e] of entries.entries()) {
      const prev = entries[i - 1] ?? null;
      if (i > 0 && i < lastCheckpoint) {
        // Covered by the checkpoint: linkage is re-hashed here, its commitment is checked at the checkpoint.
        if (e?.seq !== i + 1 || e.parent !== (prev ? hashOf(prev) : null)) return {ok: false, why: `entry ${i}: chain linkage broken before the checkpoint`};
        if ((e.kind === AUTHORITY) && getObject(e.payload_ref) === null) return {ok: false, why: `entry ${i}: authority payload missing or altered`};
      } else {
        const why = check(e, i, prev, byHash, auth, {rederive: true});
        if (why) return {ok: false, why};
        if (!RESERVED.has(e.kind)) rederived++;
      }
      auth = authorityAfter(auth, e);
      byHash.set(hashOf(e), e);
    }
    return {ok: true, entries: entries.length, rederived, head: hashOf(entries.at(-1)), authority: auth};
  }

  // Single writer: an exclusive lock file, then verify-before-append under it.
  function locked(fn) {
    const lock = file + '.lock';
    let fd = null;
    for (let i = 0; i < 200 && fd === null; i++) { try { fd = fs.openSync(lock, 'wx'); } catch {} }
    if (fd === null) fail('ledger lock held: one writer at a time');
    try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, {force: true}); }
  }

  function seal({kind, author, derived_from, payload_ref}, signer, order, entries) {
    const prev = entries.at(-1) ?? null;
    const e = {schema: LEDGER_SCHEMA, seq: entries.length + 1, parent: prev ? hashOf(prev) : null, kind, author, derived_from, payload_ref};
    e.author_sig = signBytes(bodyOf(e), signer.privatePem);
    e.order_sig = signBytes(orderOf(e), order.privatePem);
    return e;
  }

  /**
   * Append one entry. `signer` is the author's own key; `order` is the orderer's. The entry is checked,
   * including re-derivation, BEFORE it is written; a refused entry leaves the ledger unchanged.
   */
  function append({kind, payload, author, derivedFrom = [], signer, order}) {
    if (kind === CHECKPOINT || kind === GENESIS) fail(`a ${kind} is not appended`);
    if (!signer || signer.key_id !== author?.key_id) fail('an entry is signed by its own author');
    return locked(() => {
      const state = verify({mode: 'frontier'});
      if (!state.ok) fail(`ledger does not verify, refusing to append: ${state.why}`);
      if (!order || order.key_id !== state.authority.orderer) fail('the orderer co-signs every entry');
      const entries = read();
      const byHash = new Map(entries.map(x => [hashOf(x), x]));
      const payload_ref = putObject(payload);
      const e = seal({kind, author, derived_from: [...derivedFrom], payload_ref}, signer, order, entries);
      const why = check(e, entries.length, entries.at(-1) ?? null, byHash, state.authority, {rederive: true});
      if (why) fail(why);
      const written = [e];
      if ((entries.length + 1) % checkpointEvery === 0) {
        const all = [...entries, e];
        const cp = seal({kind: CHECKPOINT, author: {key_id: order.key_id}, derived_from: [], payload_ref: putObject({through: all.length, root: rootOf(all.map(hashOf))})}, order, order, all);
        written.push(cp);
      }
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, written.map(x => JSON.stringify(x) + '\n').join('')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return {hash: hashOf(e), seq: e.seq, checkpoint: written.length > 1 ? hashOf(written[1]) : null};
    });
  }

  return {append, verify, read, payloadOf: e => getObject(e.payload_ref), hashOf};
}

/**
 * Create a ledger: write its genesis, signed by an operator and co-signed by the orderer, and return
 * the genesis hash for readers to pin. `authority` is {keyring, orderer, operators, pins?}.
 */
export function createLedger({dir, authority, operator, order}) {
  if (!dir || !path.isAbsolute(dir)) fail('an absolute ledger directory is required');
  if (!validAuthority(authority)) fail('genesis needs {keyring, orderer, operators}');
  const a = {keys: authority.keyring, orderer: authority.orderer, operators: authority.operators};
  if (!authorityValid(a)) fail('genesis orderer and operators must be in its keyring');
  if (!operator || !authority.operators.includes(operator.key_id)) fail('genesis is signed by one of its operators');
  if (!order || order.key_id !== authority.orderer) fail('genesis is co-signed by its orderer');
  const file = path.join(dir, 'chain.jsonl');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) fail('a ledger already exists here');
  fs.mkdirSync(path.join(dir, 'objects'), {recursive: true});
  const payload = {keyring: authority.keyring, orderer: authority.orderer, operators: authority.operators, pins: authority.pins ?? null};
  const bytes = canonical(payload), ref = 'sha256:' + digest(payload);
  fs.writeFileSync(path.join(dir, 'objects', ref.slice(7) + '.json'), bytes);
  const e = {schema: LEDGER_SCHEMA, seq: 1, parent: null, kind: GENESIS, author: {key_id: operator.key_id}, derived_from: [], payload_ref: ref};
  e.author_sig = signBytes(bodyOf(e), operator.privatePem);
  e.order_sig = signBytes(orderOf(e), order.privatePem);
  fs.writeFileSync(file, JSON.stringify(e) + '\n');
  return hashOf(e);
}
