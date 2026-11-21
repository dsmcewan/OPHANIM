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
//
// Domains (docs/ledger-provenance-evaluation.md, "Shared ledgers and the run-path gate"). One ledger can
// hold the kinds of several domains (Pantheon's, OPHANIM's). The authority DECLARES them: genesis, or a
// later operator-signed authority entry, names each domain and its kinds (`domains: {name: [kind]}`).
// A reader whose registry supplies a domain re-derives its entries. An entry of a declared domain the
// reader does not supply is checked structurally only (chain linkage, order and author signatures, a
// keyring author, an intact payload): never re-derived, never appended by that reader, and reported in
// `verify().foreign`. An entry of a kind no domain declared before it is refused, as before, so the
// registry stays closed: what a reader passes over is exactly what the ledger's authority named.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, generateKeyPairSync, createHash, randomBytes} from 'node:crypto';
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
const KIND_NAME = /^[a-z][a-z0-9.-]{0,63}$/, DOMAIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;
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
    if (!KIND_NAME.test(kind)) fail(`kind name "${kind}" is not an identifier`);
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

/** A domain declaration: {name: [kind, ...]}, names and kinds identifiers, no reserved kind. */
const validDomains = d => d === undefined || d === null || (typeof d === 'object' && !Array.isArray(d)
  && Object.entries(d).every(([name, ks]) => DOMAIN_NAME.test(name) && Array.isArray(ks)
    && ks.every(k => typeof k === 'string' && KIND_NAME.test(k) && !RESERVED.has(k))));
/** Declarations only grow: a domain's kinds are unioned. */
function mergeDomains(current, add) {
  const out = Object.fromEntries(Object.entries(current ?? {}).map(([d, ks]) => [d, [...ks]]));
  for (const [d, ks] of Object.entries(add ?? {})) out[d] = [...new Set([...(out[d] ?? []), ...ks])].sort();
  return out;
}
// A kind belongs to one domain only.
const domainsDisjoint = d => {
  const seen = new Set();
  for (const ks of Object.values(d)) for (const k of ks) { if (seen.has(k)) return false; seen.add(k); }
  return true;
};
/** The declared domain a kind belongs to, or null. */
export const domainOf = (domains, kind) => Object.entries(domains ?? {}).find(([, ks]) => ks.includes(kind))?.[0] ?? null;

// The authority as of a point in the chain: genesis, then each authority entry applied in order.
function applyAuthority(auth, payload) {
  const keys = {...auth.keys, ...(payload.add ?? {})};
  for (const id of payload.revoke ?? []) delete keys[id];
  return {keys, orderer: payload.orderer ?? auth.orderer, operators: payload.operators ?? auth.operators, pins: auth.pins,
    domains: mergeDomains(auth.domains, payload.domains)};
}
const authorityValid = a => Object.hasOwn(a.keys, a.orderer) && a.operators.length > 0 && a.operators.every(o => Object.hasOwn(a.keys, o))
  && domainsDisjoint(a.domains ?? {});

/**
 * Open a ledger. `anchor` is the genesis hash the reader trusts; it is required, so a ledger is never
 * trusted on the strength of the authority it names for itself.
 *
 * `domains` (optional) names the declared domains this registry supplies. Without it, a reader supplies
 * every declared domain its registry holds at least one kind of. A domain is supplied whole or not at
 * all: a registry missing one kind of a domain it supplies is refused, not passed over.
 */
export function openLedger({dir, kinds, anchor, checkpointEvery = 64, domains = null,
  lockTimeoutMs = 10_000, lockStaleMs = 600_000, log = msg => process.emitWarning(msg, {code: 'LEDGER_LOCK'})}) {
  if (!dir || !path.isAbsolute(dir)) fail('an absolute ledger directory is required');
  if (typeof anchor !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(anchor)) fail('a pinned genesis hash (anchor) is required');
  const file = path.join(dir, 'chain.jsonl');
  const lock = file + '.lock';
  let holdsWriteLock = false;
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

  // An unlocked reader can catch a live append before its final newline. Read again even if the
  // writer has already released its lock. Never discard an incomplete tail or repair the file.
  function readAfterPartial() {
    const deadline = Date.now() + lockTimeoutMs;
    let delay = 1;
    for (;;) {
      const before = fileId();
      const writing = !holdsWriteLock && fs.existsSync(lock) && !staleLock(lock, lockStaleMs);
      const text = fs.readFileSync(file, 'utf8');
      if (!text.length || text.endsWith('\n')) return text;
      if (holdsWriteLock || (!writing && sameId(before, fileId())) || Date.now() >= deadline) {
        fail('ledger ends mid-line (torn append)');
      }
      sleepSync(Math.min(delay, deadline - Date.now()));
      delay = Math.min(2 * delay, 100);
    }
  }

  function read() {
    if (!fs.existsSync(file)) return [];
    let text = fs.readFileSync(file, 'utf8');
    if (text.length && !text.endsWith('\n')) text = readAfterPartial();
    const lines = text.split('\n');
    return lines.slice(0, -1).map((line, i) => { try { return JSON.parse(line); } catch { return fail(`line ${i} is not JSON`); } });
  }

  const supplies = (declared, d) => (domains ? domains.includes(d) : (declared[d] ?? []).some(k => Object.hasOwn(kinds, k)));
  // A kind this registry does not hold, given the domains declared so far: {foreign: domain} when it
  // belongs to a declared domain this reader does not supply, else {why} (refused).
  function unknownKind(kind, auth) {
    const d = domainOf(auth?.domains, kind);
    if (d === null) return {why: `kind "${kind}" is not in the registry, and no domain declared before it names it`};
    if (supplies(auth.domains, d)) return {why: `kind "${kind}" of domain "${d}" is not in the registry, which supplies that domain: the composition is incomplete`};
    return {foreign: d};
  }

  // One entry against everything before it. Returns the reason it is refused, or null. `notes` collects
  // what was accepted without full re-derivation: foreign-domain entries, and the parts a kind reports
  // it could not re-derive (view.note).
  function check(e, i, prev, byHash, auth, {rederive, notes = null}) {
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
      if (!validDomains(payload.domains)) return `entry ${i}: a domain declaration names {domain: [kind]}`;
      const next = applyAuthority(auth, payload);
      return authorityValid(next) ? null : `entry ${i}: the resulting authority has no valid orderer or operator, or declares a kind in two domains`;
    }
    if (e.kind === CHECKPOINT) {
      if (e.author.key_id !== auth.orderer) return `entry ${i}: only the orderer writes checkpoints`;
      const before = [...byHash.keys()];
      if (payload.through !== i || payload.root !== rootOf(before)) return `entry ${i}: checkpoint does not commit to the chain before it`;
      return null;
    }
    if (!Object.hasOwn(kinds, e.kind)) {
      const u = unknownKind(e.kind, auth);
      if (u.why) return `entry ${i}: ${u.why}`;
      notes?.foreign.push({seq: e.seq, kind: e.kind, domain: u.foreign});
      return null;
    }
    const k = kinds[e.kind];
    if (!k.authors(e.author)) return `entry ${i}: ${e.author.key_id} may not author "${e.kind}"`;
    const bad = k.validate(payload);
    if (bad) return `entry ${i}: ${bad}`;
    if (rederive) {
      // entries(): the hashes of every earlier entry, in chain order, for kinds that count what came before.
      // note(why): a part of this entry the kind could not re-derive because its input is not available
      // (a board that is gone, say). The rest was re-derived; verify() reports the note in `partial`.
      const partial = [];
      const view = {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? getObject(byHash.get(h).payload_ref) : null),
        entries: () => [...byHash.keys()], note: why => { partial.push(String(why)); }};
      const why = k.rederive({...e, payload}, view);
      if (why) return `entry ${i}: does not re-derive: ${why}`;
      for (const p of partial) notes?.partial.push({seq: e.seq, kind: e.kind, why: p});
    }
    return null;
  }

  function checkGenesis(e) {
    if (e?.schema !== LEDGER_SCHEMA || e.kind !== GENESIS || e.seq !== 1 || e.parent !== null) return 'entry 0: the chain must open with a genesis';
    if (hashOf(e) !== anchor) return 'entry 0: genesis is not the pinned anchor (a ledger may not name its own authority)';
    const payload = getObject(e.payload_ref);
    if (!validAuthority(payload) || !validDomains(payload.domains)) return 'entry 0: genesis payload is not an authority';
    const a = {keys: payload.keyring, orderer: payload.orderer, operators: payload.operators, domains: mergeDomains({}, payload.domains)};
    if (!authorityValid(a) || !a.operators.includes(e.author?.key_id)) return 'entry 0: genesis is not signed by one of its operators';
    if (!verifyBytes(bodyOf(e), e.author_sig, a.keys[e.author.key_id]) || !verifyBytes(orderOf(e), e.order_sig, a.keys[a.orderer])) return 'entry 0: genesis signatures invalid';
    return null;
  }
  const authorityAfter = (auth, e) => {
    if (e.kind === GENESIS) { const p = getObject(e.payload_ref); return {keys: p.keyring, orderer: p.orderer, operators: p.operators, pins: p.pins ?? null, domains: mergeDomains({}, p.domains)}; }
    if (e.kind === AUTHORITY) return applyAuthority(auth, getObject(e.payload_ref));
    return auth;
  };

  /**
   * Verify the chain. mode "full" re-derives every entry; "frontier" re-hashes the whole prefix
   * (so any edit is caught) but re-checks signatures and re-derives only after the last checkpoint.
   * Over the entries it checked, the result says what was accepted without full re-derivation:
   * `foreign` (domain -> count of entries checked structurally only), `partial` ([{seq, kind, why}]),
   * and `complete`, true only when both are empty.
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
    const notes = {foreign: [], partial: []};
    for (const [i, e] of entries.entries()) {
      const prev = entries[i - 1] ?? null;
      // Authority entries are ALWAYS fully verified, before a checkpoint too. A checkpoint is trusted
      // because the orderer signed it, and who the orderer is comes from the authority entries; letting an
      // unverified authority entry name the orderer lets a forger name itself and sign its own checkpoint
      // (independent review 2026-11-16, RU2). Only ordinary entries may rest on a checkpoint.
      if (i > 0 && i < lastCheckpoint && e?.kind !== AUTHORITY) {
        // Covered by the checkpoint: linkage is re-hashed here, its commitment is checked at the checkpoint.
        if (e?.seq !== i + 1 || e.parent !== (prev ? hashOf(prev) : null)) return {ok: false, why: `entry ${i}: chain linkage broken before the checkpoint`};
      } else {
        const before = notes.foreign.length;
        const why = check(e, i, prev, byHash, auth, {rederive: true, notes});
        if (why) return {ok: false, why};
        if (!RESERVED.has(e.kind) && notes.foreign.length === before) rederived++;
      }
      auth = authorityAfter(auth, e);
      byHash.set(hashOf(e), e);
    }
    const foreign = {};
    for (const f of notes.foreign) foreign[f.domain] = (foreign[f.domain] ?? 0) + 1;
    return {ok: true, entries: entries.length, rederived, head: hashOf(entries.at(-1)), authority: auth,
      foreign, partial: notes.partial, complete: notes.foreign.length === 0 && notes.partial.length === 0};
  }

  // Single writer: an exclusive lock file, then verify-before-append under it. The lock records who
  // holds it ({pid, host, time, nonce}). A waiter backs off with jitter for up to `lockTimeoutMs`, and
  // breaks, and logs, a lock whose holder is a dead process on this host or that is older than
  // `lockStaleMs` (independent review 2026-11-16, SY5: 200 immediate retries, and a crash under the lock
  // blocked every later append). A holder removes only its own lock.
  function locked(fn) {
    const token = JSON.stringify({pid: process.pid, host: LOCK_HOST, time: Date.now(), nonce: randomBytes(8).toString('hex')});
    const deadline = Date.now() + lockTimeoutMs;
    let fd = null, wait = 1;
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx');
        try { fs.writeSync(fd, token); fs.fsyncSync(fd); }
        catch (e) { fs.closeSync(fd); fs.rmSync(lock, {force: true}); throw e; }
        break;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const stale = staleLock(lock, lockStaleMs);
      if (stale && breakLock(lock, stale)) { log(`ledger lock ${lock} broken: ${stale.why}`); continue; }
      const left = deadline - Date.now();
      if (left <= 0) fail('ledger lock held: one writer at a time');
      sleepSync(Math.min(left, wait / 2 + Math.random() * wait));
      wait = Math.min(wait * 2, 100);
    }
    holdsWriteLock = true;
    try { return fn(); }
    finally {
      holdsWriteLock = false;
      fs.closeSync(fd);
      let held = null; try { held = fs.readFileSync(lock, 'utf8'); } catch {}
      if (held === token) fs.rmSync(lock, {force: true});
      else log(`ledger lock ${lock} was broken while this writer held it`);
    }
  }

  function seal({kind, author, derived_from, payload_ref}, signer, order, entries) {
    const prev = entries.at(-1) ?? null;
    const e = {schema: LEDGER_SCHEMA, seq: entries.length + 1, parent: prev ? hashOf(prev) : null, kind, author, derived_from, payload_ref};
    e.author_sig = signBytes(bodyOf(e), signer.privatePem);
    e.order_sig = signBytes(orderOf(e), order.privatePem);
    return e;
  }

  // The verified head (SY5). Append used to re-read and re-hash the whole chain each time, so its cost
  // grew with the chain. This instance remembers the chain as it last verified or wrote it (the entries
  // and their hashes in order, the authority, the last checkpoint) with the file's identity (device,
  // inode, size, mtime, ctime) and a digest of its last line. On the next append, if the file is still
  // that file, the prefix is not re-read or re-hashed. What frontier verification checks against things
  // OUTSIDE the chain file is still checked every time: the payload objects of the genesis, of every
  // authority entry (RU2: authority is never taken on trust) and of the frontier, and the frontier's
  // re-derivation. Any difference (an external edit, another writer's append, a replaced file) drops the
  // cache, and the append runs full frontier verification as before.
  let head = null;
  const fileId = fd => {
    try { const s = fd === undefined ? fs.statSync(file, {bigint: true}) : fs.fstatSync(fd, {bigint: true}); return {dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs}; }
    catch { return null; }
  };
  const sameId = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const lineDigest = bytes => createHash('sha256').update(bytes).digest('hex');
  function tailMatches(id, tailLen, tail) {
    const size = Number(id.size), len = Math.min(size, tailLen + 1);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { if (fs.readSync(fd, buf, 0, len, size - len) !== len) return false; } finally { fs.closeSync(fd); }
    if (len > tailLen && buf[0] !== 0x0a) return false;              // the line before it still ends there
    return lineDigest(buf.subarray(len - tailLen)) === tail;
  }

  // Full frontier verification, then a fresh head. The file must not change while it is read.
  function verifyAndRemember() {
    const before = fileId();
    const state = verify({mode: 'frontier'});
    if (!state.ok) fail(`ledger does not verify, refusing to append: ${state.why}`);
    const raw = fs.readFileSync(file);
    if (!sameId(before, fileId())) fail('ledger changed while it was verified, refusing to append');
    const entries = raw.toString('utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
    const hashes = entries.map(hashOf), last = raw.subarray(raw.lastIndexOf(0x0a, raw.length - 2) + 1);
    return {id: before, tailLen: last.length, tail: lineDigest(last), entries, hashes, index: new Map(hashes.map((x, i) => [x, i])),
      authority: state.authority, lastCheckpoint: entries.findLastIndex(e => e.kind === CHECKPOINT),
      authorityAt: entries.flatMap((e, i) => (i === 0 || e.kind === AUTHORITY ? [i] : []))};
  }

  // The cached head, re-checked against everything outside the chain file; null when the file changed.
  function cachedHead() {
    const h = head;
    if (!h) return null;
    const id = fileId();
    if (!sameId(id, h.id) || !tailMatches(id, h.tailLen, h.tail)) return null;
    const from = Math.max(h.lastCheckpoint, 0);
    for (const i of [...h.authorityAt, ...h.entries.keys().drop(from)]) {
      if (getObject(h.entries[i].payload_ref) === null) fail(`ledger does not verify, refusing to append: entry ${i}: payload object missing or altered`);
    }
    // Re-derive the frontier as verify({mode: 'frontier'}) does: each entry sees only what came before it.
    for (let i = from; i < h.entries.length; i++) {
      const e = h.entries[i];
      if (RESERVED.has(e.kind) || !Object.hasOwn(kinds, e.kind)) continue;
      const earlier = x => (h.index.has(x) && h.index.get(x) < i ? h.entries[h.index.get(x)] : null);
      const view = {entry: earlier, payload: x => (earlier(x) ? getObject(earlier(x).payload_ref) : null),
        entries: () => h.hashes.slice(0, i), note: () => {}};
      const why = kinds[e.kind].rederive({...e, payload: getObject(e.payload_ref)}, view);
      if (why) fail(`ledger does not verify, refusing to append: entry ${i}: does not re-derive: ${why}`);
    }
    return h;
  }

  /**
   * Append one entry. `signer` is the author's own key; `order` is the orderer's. The entry is checked,
   * including re-derivation, BEFORE it is written; a refused entry leaves the ledger unchanged.
   */
  function append({kind, payload, author, derivedFrom = [], signer, order}) {
    if (kind === CHECKPOINT || kind === GENESIS) fail(`a ${kind} is not appended`);
    if (!signer || signer.key_id !== author?.key_id) fail('an entry is signed by its own author');
    return locked(() => {
      let h;
      try { h = cachedHead() ?? verifyAndRemember(); } catch (err) { head = null; throw err; }
      head = h;
      const {entries, authority} = h;
      // A reader appends only what it re-derives: never an entry of a domain it passes over.
      if (kind !== AUTHORITY && !Object.hasOwn(kinds, kind)) {
        const u = unknownKind(kind, authority);
        fail(u.why ?? `kind "${kind}" belongs to domain "${u.foreign}", which this registry does not supply; only a composition that re-derives it may record it`);
      }
      if (!order || order.key_id !== authority.orderer) fail('the orderer co-signs every entry');
      const byHash = {has: x => h.index.has(x), get: x => (h.index.has(x) ? entries[h.index.get(x)] : undefined), keys: () => h.hashes.values()};
      const payload_ref = putObject(payload);
      const e = seal({kind, author, derived_from: [...derivedFrom], payload_ref}, signer, order, entries);
      const notes = {foreign: [], partial: []};
      const why = check(e, entries.length, entries.at(-1) ?? null, byHash, authority, {rederive: true, notes});
      if (why) fail(why);
      const written = [e];
      if ((entries.length + 1) % checkpointEvery === 0) {
        const all = [...h.hashes, hashOf(e)];
        const cp = seal({kind: CHECKPOINT, author: {key_id: order.key_id}, derived_from: [], payload_ref: putObject({through: all.length, root: rootOf(all)})}, order, order, [...entries, e]);
        written.push(cp);
      }
      const lines = written.map(x => JSON.stringify(x) + '\n');
      head = null;                                       // a failed or partial write leaves no cache behind
      const fd = fs.openSync(file, 'a');
      let id;
      try {
        const bytes = Buffer.from(lines.join(''));
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (count === 0) fail('ledger append wrote no bytes');
          offset += count;
        }
        fs.fsyncSync(fd);
        id = fileId(fd);
      } finally { fs.closeSync(fd); }
      // Extend the head with what was just written: the entry was checked above, the checkpoint is ours.
      let auth = authority;
      for (const x of written) {
        auth = authorityAfter(auth, x);
        h.index.set(hashOf(x), entries.length); h.hashes.push(hashOf(x)); entries.push(x);
        if (x.kind === CHECKPOINT) h.lastCheckpoint = entries.length - 1;
        if (x.kind === AUTHORITY) h.authorityAt.push(entries.length - 1);
      }
      const last = Buffer.from(lines.at(-1));
      Object.assign(h, {id, tailLen: last.length, tail: lineDigest(last), authority: auth});
      head = h;
      return {hash: hashOf(e), seq: e.seq, checkpoint: written.length > 1 ? hashOf(written[1]) : null, ...(notes.partial.length ? {partial: notes.partial} : {})};
    });
  }

  return {append, verify, read, payloadOf: e => getObject(e.payload_ref), hashOf};
}

// The lock holder's host: the hostname and, on Linux, the pid namespace, so a pid is judged dead only
// where it was recorded.
const LOCK_HOST = (() => { let ns = ''; try { ns = fs.readlinkSync('/proc/self/ns/pid'); } catch {} return os.hostname() + (ns ? ' ' + ns : ''); })();
const sleepSync = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Why the ledger lock at `lock` is stale ({raw, why}, with the bytes judged), or null: live, or gone. */
export function staleLock(lock, staleMs) {
  let raw, st;
  try { st = fs.statSync(lock); raw = fs.readFileSync(lock, 'utf8'); } catch { return null; }
  let rec = null; try { rec = JSON.parse(raw); } catch {}
  if (rec && rec.host === LOCK_HOST && Number.isInteger(rec.pid) && rec.pid > 0 && rec.pid !== process.pid && !pidAlive(rec.pid)) {
    return {raw, why: `its holder, pid ${rec.pid} on this host, is not running`};
  }
  const age = Date.now() - (Number.isFinite(rec?.time) ? rec.time : st.mtimeMs);
  if (age > staleMs) return {raw, why: `it has been held for ${Math.round(age)} ms, longer than the ${staleMs} ms bound${rec ? ` (pid ${rec.pid} on ${rec.host})` : ' (unreadable record)'}`};
  return null;
}
// Break a stale lock: move it aside and remove it only if it is still the lock judged stale; a lock
// taken in between is put back. True when the stale lock was removed.
function breakLock(lock, stale) {
  const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lock, aside); } catch { return false; }
  let raw = null; try { raw = fs.readFileSync(aside, 'utf8'); } catch {}
  if (raw !== stale.raw) { try { fs.linkSync(aside, lock); } catch {} fs.rmSync(aside, {force: true}); return false; }
  fs.rmSync(aside, {force: true});
  return true;
}

/**
 * Create a ledger: write its genesis, signed by an operator and co-signed by the orderer, and return
 * the genesis hash for readers to pin. `authority` is {keyring, orderer, operators, pins?, domains?};
 * `domains` declares the kind sets the ledger is created for ({name: [kind]}).
 */
export function createLedger({dir, authority, operator, order}) {
  if (!dir || !path.isAbsolute(dir)) fail('an absolute ledger directory is required');
  if (!validAuthority(authority)) fail('genesis needs {keyring, orderer, operators}');
  if (!validDomains(authority.domains)) fail('genesis domains are {domain: [kind]}');
  const a = {keys: authority.keyring, orderer: authority.orderer, operators: authority.operators, domains: mergeDomains({}, authority.domains)};
  if (!authorityValid(a)) fail('genesis orderer and operators must be in its keyring, and a kind is in one domain only');
  if (!operator || !authority.operators.includes(operator.key_id)) fail('genesis is signed by one of its operators');
  if (!order || order.key_id !== authority.orderer) fail('genesis is co-signed by its orderer');
  const file = path.join(dir, 'chain.jsonl');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) fail('a ledger already exists here');
  fs.mkdirSync(path.join(dir, 'objects'), {recursive: true});
  const payload = {keyring: authority.keyring, orderer: authority.orderer, operators: authority.operators, pins: authority.pins ?? null,
    ...(authority.domains ? {domains: mergeDomains({}, authority.domains)} : {})};
  const bytes = canonical(payload), ref = 'sha256:' + digest(payload);
  fs.writeFileSync(path.join(dir, 'objects', ref.slice(7) + '.json'), bytes);
  const e = {schema: LEDGER_SCHEMA, seq: 1, parent: null, kind: GENESIS, author: {key_id: operator.key_id}, derived_from: [], payload_ref: ref};
  e.author_sig = signBytes(bodyOf(e), operator.privatePem);
  e.order_sig = signBytes(orderOf(e), order.privatePem);
  fs.writeFileSync(file, JSON.stringify(e) + '\n');
  return hashOf(e);
}
