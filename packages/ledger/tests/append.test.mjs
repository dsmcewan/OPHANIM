// Independent review 2026-11-16, SY5: append re-read and re-hashed the whole chain each time, and the
// lock was 200 immediate retries with no wait and no stale-lock recovery. Append now keeps the verified
// head per ledger instance, and the lock backs off and recovers from a holder that died.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {openLedger, createLedger, defineKinds, generateSigner, CHECKPOINT, AUTHORITY} from '../chain.mjs';

const chainUrl = new URL('../chain.mjs', import.meta.url).href;
const seat = generateSigner('seat');
const orderer = generateSigner('controller');
const operator = generateSigner('operator');
const keyring = Object.fromEntries([seat, orderer, operator].map(s => [s.key_id, s.publicJwk]));
const authority = {keyring, orderer: 'controller', operators: ['operator']};
let external = true;                               // what an `observed` entry re-derives against
const kinds = defineKinds({
  measure: {authors: () => true, validate: p => (Number.isInteger(p?.value) ? null : 'value must be an integer'), rederive: () => null},
  observed: {authors: () => true, validate: () => null, rederive: () => (external ? null : 'the observed thing is gone')},
});
const by = s => ({author: {key_id: s.key_id}, signer: s, order: orderer});
const measure = (L, value) => L.append({kind: 'measure', payload: {value}, ...by(seat)});

function withLedger(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-append-'));
  try {
    const anchor = createLedger({dir, authority, operator, order: orderer});
    return fn(openLedger({dir, kinds, anchor, ...opts}), dir, anchor);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timed = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

test('a reader sees a complete signed append even when the writer has published only the first half', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-reader-'));
  const file = path.join(dir, 'chain.jsonl');
  const latch = new Int32Array(new SharedArrayBuffer(4));
  const anchor = createLedger({dir, authority, operator, order: orderer});
  const L = openLedger({dir, kinds, anchor});
  const writer = new Worker(new URL('./fixtures/partial-append.mjs', import.meta.url), {
    workerData: {dir, anchor, seat, orderer, latch},
  });
  const exited = once(writer, 'exit');
  const releaseWriter = () => { Atomics.store(latch, 0, 1); Atomics.notify(latch, 0); };
  try {
    assert.deepEqual(await once(writer, 'message'), ['partial']);
    // Hold the writer until read() has actually observed its incomplete tail twice. A single
    // unconditional re-read cannot pass, and the interleaving is independent of CPU speed.
    let partialReads = 0;
    const readFile = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (name, ...args) => {
      const bytes = readFile(name, ...args);
      if (name === file && !bytes.toString().endsWith('\n') && ++partialReads === 2) releaseWriter();
      return bytes;
    });
    assert.deepEqual(L.read().map(e => e.kind), ['genesis', 'measure']);
    assert.deepEqual(await exited, [0]);
    assert.equal(L.verify().ok, true);
    // The same missing delimiter with no completing writer really is corruption.
    fs.truncateSync(file, fs.statSync(file).size - 1);
    assert.throws(() => L.read(), /torn append/);
    assert.throws(() => measure(L, 2), /torn append/);
  } finally {
    releaseWriter();
    try { await exited; } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('SY5: append time for entry 1000 is within a small constant factor of entry 10', () => withLedger((L, dir, anchor) => {
  const around = {};
  for (let n = 1; n <= 1010; n++) {
    const ms = timed(() => measure(L, n));
    if ((n >= 10 && n < 20) || n >= 1000) (around[n < 1000 ? 'early' : 'late'] ??= []).push(ms);
  }
  const early = median(around.early), late = median(around.late);
  assert.equal(L.verify().ok, true);
  assert.ok(L.read().filter(e => e.kind === CHECKPOINT).length >= 15, 'checkpoints were written along the way');
  // For contrast, the uncached path (a fresh instance verifies the whole frontier and re-hashes the prefix).
  const cold = median(Array.from({length: 5}, (_, i) => timed(() => measure(openLedger({dir, kinds, anchor}), i))));
  console.log(`# append median: entry 10-19 ${early.toFixed(3)} ms, entry 1000-1009 ${late.toFixed(3)} ms (x${(late / early).toFixed(2)}); uncached at 1015: ${cold.toFixed(3)} ms`);
  assert.ok(late < early * 4 + 1, `entry 1000 took ${late.toFixed(3)} ms against ${early.toFixed(3)} ms for entry 10`);
}));

test('SY5: an external edit after caching is still caught, even with the mtime put back', () => withLedger((L, dir) => {
  for (let i = 0; i < 7; i++) measure(L, i);
  const file = path.join(dir, 'chain.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.trimEnd().split('\n');
  // Same length, an early entry, before the last checkpoint: flip one character of its order signature.
  const e = JSON.parse(lines[2]);
  e.order_sig = (e.order_sig[0] === 'A' ? 'B' : 'A') + e.order_sig.slice(1);
  const edited = [...lines.slice(0, 2), JSON.stringify(e), ...lines.slice(3)].join('\n') + '\n';
  // test-lint: allow truncated-sequence -- edited is the WHOLE file rebuilt from lines.slice(0, 2), the edited entry and lines.slice(3), no line dropped; the two whole files' lengths are compared
  assert.equal(edited.length, original.length, 'the edit keeps the file size');
  const {atime, mtime} = fs.statSync(file);
  fs.writeFileSync(file, edited);
  fs.utimesSync(file, atime, mtime);
  assert.throws(() => measure(L, 99), /does not verify, refusing to append/);
  // Restored, the same instance appends again; the last line edited is caught too.
  fs.writeFileSync(file, original);
  measure(L, 8);
  const now = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const last = JSON.parse(now.at(-1)); last.author_sig = (last.author_sig[0] === 'A' ? 'B' : 'A') + last.author_sig.slice(1);
  fs.writeFileSync(file, [...now.slice(0, -1), JSON.stringify(last)].join('\n') + '\n');
  assert.throws(() => measure(L, 100), /does not verify, refusing to append: entry \d+: author signature invalid/);
}, {checkpointEvery: 3}));

test('SY5: another writer\'s append is verified, and the cache follows it', () => withLedger((L, dir, anchor) => {
  measure(L, 1); measure(L, 2);
  const other = openLedger({dir, kinds, anchor});
  measure(other, 3);
  const r = measure(L, 4);
  assert.equal(r.seq, 1 + 4 + 1, 'continues after the other writer (and the checkpoint after entry 3)');
  assert.equal(L.verify().ok, true);
  assert.deepEqual(L.read().map(e => e.kind), ['genesis', 'measure', 'measure', CHECKPOINT, 'measure', 'measure', CHECKPOINT]);
}, {checkpointEvery: 3}));

test('SY5: on the cached path the frontier still re-derives, and its payloads and the authority\'s are re-hashed', () => withLedger((L, dir) => {
  measure(L, 1);
  L.append({kind: AUTHORITY, payload: {add: {extra: generateSigner('extra').publicJwk}}, ...by(operator)});
  for (let i = 0; i < 5; i++) measure(L, i);                         // the authority entry is now before a checkpoint
  assert.ok(L.read().findIndex(e => e.kind === AUTHORITY) < L.read().findLastIndex(e => e.kind === CHECKPOINT));
  const obj = ref => path.join(dir, 'objects', ref.slice(7) + '.json');
  const authRef = L.read().find(e => e.kind === AUTHORITY).payload_ref;
  const saved = fs.readFileSync(obj(authRef));
  fs.writeFileSync(obj(authRef), JSON.stringify({add: {}}));
  assert.throws(() => measure(L, 9), /entry 2: payload object missing or altered/);
  fs.writeFileSync(obj(authRef), saved);
  measure(L, 9);
  L.append({kind: 'observed', payload: {}, ...by(seat)});
  assert.notEqual(L.read().at(-1).kind, CHECKPOINT, 'the observed entry is in the frontier');
  external = false;
  try { assert.throws(() => measure(L, 10), /entry \d+: does not re-derive: the observed thing is gone/); }
  finally { external = true; }
  measure(L, 11);
  assert.equal(L.verify().ok, true);
}, {checkpointEvery: 3}));

// A writer that dies holding the lock: the child appends an entry whose re-derivation kills its own
// process, so it exits while holding the lock, mid-append.
function crashUnderLock(dir, anchor) {
  const code = `
    import {openLedger, defineKinds} from ${JSON.stringify(chainUrl)};
    const [dir, anchor, seat, order] = JSON.parse(process.argv[1]);
    const kinds = defineKinds({measure: {authors: () => true, validate: () => null, rederive: () => null},
      crash: {authors: () => true, validate: () => null, rederive: () => process.kill(process.pid, 'SIGKILL')}});
    openLedger({dir, kinds, anchor}).append({kind: 'crash', payload: {}, author: {key_id: seat.key_id}, signer: seat, order});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([dir, anchor, seat, orderer])], {encoding: 'utf8'});
}

test('SY5: a lock left by a writer that died on this host is broken, logged, and the append goes ahead', () => withLedger((L, dir, anchor) => {
  measure(L, 1);
  const r = crashUnderLock(dir, anchor);
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  const lock = path.join(dir, 'chain.jsonl.lock');
  const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(record.pid, r.pid, 'the lock names its holder');
  assert.ok(record.host && record.time && record.nonce);
  const logged = [];
  const M = openLedger({dir, kinds, anchor, log: m => logged.push(m)});
  const ms = timed(() => measure(M, 2));
  assert.equal(fs.existsSync(lock), false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`broken: its holder, pid ${r.pid} on this host, is not running`));
  assert.ok(ms < 2000, `recovered at once (${ms.toFixed(0)} ms), not after the age bound`);
  assert.equal(M.verify().ok, true);
  assert.equal(M.read().length, 3, 'the crashed append wrote nothing');
}));

test('SY5: a live holder is waited for with backoff, then refused; an old lock from elsewhere is broken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-append-lock-'));
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  try {
    const anchor = createLedger({dir, authority, operator, order: orderer});
    const lock = path.join(dir, 'chain.jsonl.lock');
    const logged = [];
    const L = openLedger({dir, kinds, anchor, lockTimeoutMs: 300, lockStaleMs: 5_000, log: m => logged.push(m)});
    // Read this host's identity from a real lock record.
    crashUnderLock(dir, anchor);
    const host = JSON.parse(fs.readFileSync(lock, 'utf8')).host;
    fs.writeFileSync(lock, JSON.stringify({pid: sleeper.pid, host, time: Date.now(), nonce: 'live'}));
    const ms = timed(() => assert.throws(() => measure(L, 1), /ledger lock held: one writer at a time/));
    assert.ok(ms >= 280 && ms < 2_000, `waited out the timeout (${ms.toFixed(0)} ms)`);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).nonce, 'live', 'a live lock is left alone');
    assert.deepEqual(logged, []);
    // A lock from another host is not judged by its pid; once older than the bound it is broken.
    fs.writeFileSync(lock, JSON.stringify({pid: 1, host: 'elsewhere', time: Date.now() - 6_000, nonce: 'old'}));
    measure(L, 2);
    assert.match(logged.at(-1), /broken: it has been held for \d+ ms, longer than the 5000 ms bound \(pid 1 on elsewhere\)/);
    // A torn lock record (a crash between creating and writing it) is judged by the file's age.
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 6_000); fs.utimesSync(lock, old, old);
    measure(L, 3);
    assert.match(logged.at(-1), /unreadable record/);
    assert.equal(L.verify().ok, true);
  } finally { sleeper.kill(); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('SY5: a holder whose lock was broken does not remove the next holder\'s lock', () => withLedger((L, dir, anchor) => {
  const lock = path.join(dir, 'chain.jsonl.lock');
  const logged = [];
  const kindsWithSteal = defineKinds({...kinds, steal: {authors: () => true, validate: () => null,
    rederive: () => { fs.writeFileSync(lock, JSON.stringify({pid: 1, host: 'elsewhere', time: Date.now(), nonce: 'next'})); return null; }}});
  const M = openLedger({dir, kinds: kindsWithSteal, anchor, log: m => logged.push(m)});
  M.append({kind: 'steal', payload: {}, ...by(seat)});
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).nonce, 'next');
  assert.match(logged[0], /was broken while this writer held it/);
}));
