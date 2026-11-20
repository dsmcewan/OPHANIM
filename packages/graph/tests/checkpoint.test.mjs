// The replay checkpoint (register KG-1; docs/knowledge-graph/checkpoint.md): a signed snapshot of the projection is used
// only when every check holds, and any mismatch takes the full open with the reason recorded (KP3); the entries after it
// are verified and re-derived as the full open does; a write is atomic, two writers in two real processes leave one
// valid snapshot, retention keeps the newest, and the ledger is never written (KP5); with no snapshot, the full open is
// unchanged (KP7). A REAL packages/ledger chain; SYNTHETIC keys generated per test; no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, sign as edSign, createPrivateKey} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {generateSigner} from '../../ledger/chain.mjs';
import {canonical} from '../../ledger/canonical.mjs';
import {assertion, createProjection, defineOrigins, writeSnapshot, listSnapshots, GRAPH_SCHEMA} from '../index.mjs';
import {world, ORIGINS, SYSTEM, SYSTEM_SNAPSHOT, C, id, src, RUN, T0, at, V1, dirSource, publish} from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ex = (w, minutes) => ({...w.by('extractor'), observed_at: at(minutes)});
const tool = over => assertion({origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const PHANTOM = tool({entity: id('evidence', 'observation', 'phantom'), attributes: {forged: true}});

/** A snapshot key pinned by the reader, and the directory its snapshots go to. */
function pinned(w, name = 'snapshot-key') {
  const signer = generateSigner(name), dir = path.join(w.dir, 'snapshots');
  return {signer, dir, keys: {[signer.key_id]: signer.publicJwk}, opts: {snapshot: {dir, keys: {[signer.key_id]: signer.publicJwk}}}};
}
/** A graph with a source observed and a tool's record, and a snapshot of it at its head. */
function snapped(t, o = {}) {
  const w = world(t, o), g = w.open(), s = pinned(w);
  g.observe(SYSTEM, ex(w, 0));
  g.assert([tool({entity: id('evidence', 'observation', 'o1'), attributes: {outcome: 'pass'}})], w.by('tool'));
  const written = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  return {w, g, s, written};
}
/**
 * A snapshot file rewritten as someone else would write it: `state` edits the serialized state, `body` the signed record;
 * `digests` recomputes the state's projection digest (as a careful forger would); signed by `signer`, under `keyId`.
 */
function forge(file, {state = () => {}, body = () => {}, digests = true, signer, keyId = signer.key_id}) {
  const raw = fs.readFileSync(file), nl = raw.indexOf(0x0a), head = JSON.parse(raw.subarray(0, nl).toString('utf8'));
  const x = JSON.parse(raw.subarray(nl + 1).toString('utf8'));
  state(x);
  const bytes = Buffer.from(JSON.stringify(x));
  const b = {...head.body, state_digest: sha(bytes), state_bytes: bytes.length};
  if (digests) { const p = createProjection({origins: ORIGINS}); p.restore(x); b.projection_digest = p.digest(x.seq); }
  body(b);
  const sig = edSign(null, Buffer.from(canonical(b)), createPrivateKey(signer.privatePem)).toString('base64');
  const out = path.join(path.dirname(file), `graph-snapshot-${String(x.seq).padStart(12, '0')}-${b.state_digest.slice(7, 23)}.json`);
  fs.rmSync(file);
  fs.writeFileSync(out, Buffer.concat([Buffer.from(JSON.stringify({...head, body: b, signature: {key_id: keyId, public: signer.publicJwk, sig}}) + '\n'), bytes]));
  return out;
}
const withPhantom = x => { x.assertions.push([PHANTOM, x.seq, null]); };
const used = g => g.verification.snapshot.used;

test('trust: a snapshot signed by a key the reader has not pinned is refused; the full open is taken and the reason recorded', t => {
  const {w, g, s, written} = snapped(t);
  forge(written.file, {state: withPhantom, signer: generateSigner('rogue-key')});
  const h = w.open(s.opts);
  assert.deepEqual([used(h), h.verification.snapshot.refused], [false, true]);
  assert.match(h.verification.snapshot.reason, /signed by key "rogue-key", which this reader has not pinned/);
  assert.equal(h.view().node(PHANTOM.subject).present, false, 'nothing of it is trusted');
  assert.equal(h.digest(), g.digest(), 'the full open was taken');
});

test('trust: a snapshot whose signature does not verify under the pinned key is refused', t => {
  const {w, g, s, written} = snapped(t);
  // A forger who knows the pinned key's id but not the key: a consistent state and record, signed by another key.
  forge(written.file, {state: withPhantom, signer: generateSigner('forger'), keyId: s.signer.key_id});
  const h = w.open(s.opts);
  assert.equal(used(h), false);
  assert.match(h.verification.snapshot.reason, /signature does not verify under the pinned key "snapshot-key"/);
  assert.deepEqual([h.view().node(PHANTOM.subject).present, h.digest()], [false, g.digest()]);
});

test('trust: a snapshot of another ledger, of a forked or rewritten ledger, or of a shorter one is refused', t => {
  const {w, g, s} = snapped(t);
  // Another ledger: its anchor is not this one's.
  const other = world(t), og = other.open();
  og.observe(SYSTEM, ex(other, 0));
  const os = path.join(other.dir, 'snapshots');
  writeSnapshot(og, {dir: os, signer: s.signer});
  const a = w.open({snapshot: {dir: os, keys: s.keys}});
  assert.equal(used(a), false);
  assert.match(a.verification.snapshot.reason, /of the ledger anchored at sha256:[0-9a-f]+, not /);
  // A fork of this ledger (the same genesis, so the same anchor): copied before its last entry, then a different entry.
  const fork = path.join(w.dir, 'fork');
  fs.mkdirSync(fork);
  const chain = fs.readFileSync(path.join(w.ledgerDir, 'chain.jsonl'), 'utf8').split('\n');
  fs.cpSync(path.join(w.ledgerDir, 'objects'), path.join(fork, 'objects'), {recursive: true});
  fs.writeFileSync(path.join(fork, 'chain.jsonl'), chain.filter(Boolean).filter((l, i, all) => i < all.length - 1).map(l => l + '\n').join(''));
  const shorter = w.open({dir: fork, ...s.opts});
  assert.equal(used(shorter), false);
  assert.match(shorter.verification.snapshot.reason, /covers seq 3, but the ledger holds 2 entries/);
  shorter.assert([tool({entity: id('evidence', 'observation', 'fork-only')})], w.by('tool'));
  const forked = w.open({dir: fork, ...s.opts}), full = w.open({dir: fork});
  assert.equal(used(forked), false);
  assert.match(forked.verification.snapshot.reason, /the ledger's entry at seq 3 is not the one it covers \(a rewritten or forked ledger\)/);
  assert.deepEqual([forked.digest(), forked.view().node(id('evidence', 'observation', 'o1')).present], [full.digest(), false], 'the fork as it is, nothing of the snapshot');
  assert.notEqual(forked.digest(), g.digest());
});

test('trust: a snapshot derived under another contract registry, origin registry, instance or set of sources is refused', t => {
  const {w, g, s, written} = snapped(t);
  const extra = defineOrigins({...Object.fromEntries(Object.entries(ORIGINS).map(([k, o]) => [k, {...o}])), 'synthetic.late-tool': {kind: 'tool', basis: 'measured', keys: ['tool-key']}});
  const o = w.open({origins: extra, ...s.opts});
  assert.equal(used(o), false);
  assert.match(o.verification.snapshot.reason, /derived under origin registry sha256:[0-9a-f]+, not this reader's/);
  const more = w.open({sources: [dirSource(w.srcRoot), dirSource(w.srcRoot, 'synthetic.other')], ...s.opts});
  assert.equal(used(more), false);
  assert.match(more.verification.snapshot.reason, /other registered sources/);
  const elsewhere = w.open({instance: 'elsewhere', ...s.opts});
  assert.equal(used(elsewhere), false);
  assert.match(elsewhere.verification.snapshot.reason, /it is of instance ophanim, not elsewhere/);
  forge(written.file, {body: b => { b.contract = {...b.contract, registry: 'sha256:' + '0'.repeat(64)}; }, signer: s.signer});
  const c = w.open(s.opts);
  assert.equal(used(c), false);
  assert.match(c.verification.snapshot.reason, /derived under contract 1\.1\.0 \(registry sha256:0+\), not this reader's/);
  assert.equal(c.digest(), g.digest());
});

test('trust: a snapshot whose state is not the state it signed, or does not reproduce its projection digest, is refused', t => {
  const {w, g, s, written} = snapped(t);
  // The state edited after signing: one attribute of one record (the projection digest does not cover attributes).
  const raw = fs.readFileSync(written.file, 'utf8');
  assert.equal(raw.split('"outcome":"pass"').length, 2, 'the attribute occurs once in the file');
  fs.writeFileSync(written.file, raw.replace('"outcome":"pass"', '"outcome":"fail"'));
  const a = w.open(s.opts);
  assert.equal(used(a), false);
  assert.match(a.verification.snapshot.reason, /its state is not the state it signed/);
  assert.equal(a.view().node(id('evidence', 'observation', 'o1')).attributes.outcome, 'pass');
  // Signed by the pinned key itself, but its state does not reproduce the projection digest it records.
  fs.writeFileSync(written.file, raw);
  forge(written.file, {state: withPhantom, digests: false, signer: s.signer});
  const b = w.open(s.opts);
  assert.equal(used(b), false);
  assert.match(b.verification.snapshot.reason, /does not reproduce its recorded projection digest/);
  assert.deepEqual([b.view().node(PHANTOM.subject).present, b.digest()], [false, g.digest()]);
});

test('fallback: no snapshot, a partial file, or a refused newest one: the next acceptable snapshot or the full open, and why', t => {
  const w = world(t), g = w.open(), s = pinned(w);
  const none = w.open(s.opts);
  assert.deepEqual(none.verification.snapshot, {used: false, seq: null, refused: false, reason: 'there is no snapshot in the snapshot directory', refusals: []});
  g.observe(SYSTEM, ex(w, 0));
  const first = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  g.assert([tool({entity: id('evidence', 'observation', 'o1')})], w.by('tool'));
  const second = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  // The newest is cut short (as a copy that did not finish would leave it): the older one is used, and the tail re-derived.
  const bytes = fs.readFileSync(second.file);
  fs.writeFileSync(second.file, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const h = w.open(s.opts);
  assert.deepEqual([used(h), h.verification.snapshot.seq, h.verification.snapshot.tail], [true, first.seq, 1]);
  assert.deepEqual(h.verification.snapshot.refusals.map(r => [r.seq, r.reason]), [[second.seq, 'its state is not the state it signed']]);
  assert.equal(h.digest(), g.digest());
  // Both unusable: the full open, with the newest one's reason.
  fs.writeFileSync(first.file, '{"schema": "not a snapshot"');
  const f = w.open(s.opts);
  assert.deepEqual([used(f), f.verification.snapshot.refused, f.verification.snapshot.reason], [false, true, 'its state is not the state it signed']);
  assert.deepEqual(f.verification.snapshot.refusals.map(r => r.seq), [second.seq, first.seq]);
  assert.equal(f.digest(), g.digest());
});

test('extractor: a snapshot derived by another version of a source\'s extractor is refused; the full open reports what it reports today', t => {
  const w = world(t), s = pinned(w);
  const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64);
  const g = w.open({sources: [{...dirSource(w.srcRoot), extractorVersion: A}]});
  g.observe(SYSTEM, ex(w, 0));
  g.assert([tool({entity: id('evidence', 'observation', 'o1')})], w.by('tool'));
  const written = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  assert.deepEqual(JSON.parse(fs.readFileSync(written.file, 'utf8').split('\n')[0]).body.extractors, {[SYSTEM]: A}, 'the snapshot records it');
  assert.equal(used(w.open({sources: [{...dirSource(w.srcRoot), extractorVersion: A}], ...s.opts})), true, 'the same code: used');
  // The extractor's code changed (every fact now carries one more attribute); the source's version did not.
  const changed = {...dirSource(w.srcRoot), extractorVersion: B, readAt: v => dirSource(w.srcRoot).readAt(v).map(d => ({...d, attributes: {...d.attributes, extra: true}}))};
  const fast = w.open({sources: [changed], ...s.opts}), full = w.open({sources: [changed]});
  assert.deepEqual([used(fast), fast.verification.snapshot.refused], [false, true]);
  assert.equal(fast.verification.snapshot.reason, `the extractor of source "${SYSTEM}" is ${B} here, not ${A} as when it was derived (other code yields other facts)`);
  const {snapshot, ...fields} = fast.verification;
  assert.deepEqual([fields, fast.digest()], [full.verification, full.digest()], 'the full open was taken');
  assert.deepEqual([fast.verification.complete, fast.view().sources().map(x => x.replay), fast.view().node(C('sdk-gateway')).present], [false, ['diverged'], false],
    'the old facts are not loaded as applied');
  assert.match(fast.verification.partial[0].why, /the source now yields digest sha256:[0-9a-f]+, not the recorded sha256:[0-9a-f]+; its facts are not applied/);
  // Declared on one side only is a difference too.
  const undeclared = w.open(s.opts);
  assert.equal(used(undeclared), false);
  assert.match(undeclared.verification.snapshot.reason, new RegExp(`is null here, not ${A}`));
  void snapshot;
});

test('fallback: a snapshot directory that exists but cannot be listed takes the full open, with why; the open does not throw', t => {
  const {w, g} = snapped(t);
  const notADirectory = path.join(w.dir, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'a file where the snapshot directory should be');
  const h = w.open({snapshot: {dir: notADirectory, keys: {}}});
  assert.deepEqual(h.verification.snapshot, {used: false, seq: null, refused: false, reason: 'the snapshot directory could not be listed (ENOTDIR)', refusals: []});
  assert.equal(h.digest(), g.digest());
});

test('tail: the chain after the snapshot is verified as the full open verifies it; an entry that fails there fails here', t => {
  const {w, s} = snapped(t);
  w.open().assert([tool({entity: id('evidence', 'observation', 'after')})], w.by('tool'));
  // The last entry's author signature altered on disk: the full open refuses the ledger, and so does the open from a snapshot.
  const file = path.join(w.ledgerDir, 'chain.jsonl'), lines = fs.readFileSync(file, 'utf8').split('\n');
  const last = JSON.parse(lines.at(-2));
  last.author_sig = Buffer.from(Buffer.from(last.author_sig, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64');
  lines[lines.length - 2] = JSON.stringify(last);
  fs.writeFileSync(file, lines.join('\n'));
  assert.throws(() => w.open(), e => e.code === 'GRAPH_CORRUPT' && /author signature invalid/.test(e.message));
  assert.throws(() => w.open(s.opts), e => e.code === 'GRAPH_CORRUPT' && /author signature invalid/.test(e.message));
});

test('tail: each entry after the snapshot is validated under the reader\'s registry, as the full open validates it', t => {
  // Checkpoints every second entry: the entry after the snapshot is covered by a ledger checkpoint, so the chain's
  // frontier verification does not validate it; the tail must.
  const w = world(t, {checkpointEvery: 2}), s = pinned(w);
  // The reader's registry: the same origins, but synthetic.tool is an agent (it may only propose), with the same key.
  const reader = defineOrigins({...Object.fromEntries(Object.entries(ORIGINS).map(([k, o]) => [k, {...o}])), 'synthetic.tool': {kind: 'agent', basis: 'inferred', keys: ['tool-key']}});
  const r = w.open({origins: reader});
  r.observe(SYSTEM, ex(w, 0));
  writeSnapshot(r, {dir: s.dir, signer: s.signer});
  // A writer under the original registry, where synthetic.tool is a tool, records an observation after the snapshot.
  const tg = w.open();
  tg.assert([tool({entity: id('evidence', 'observation', 'by-a-tool')})], w.by('tool'));
  assert.deepEqual(tg.ledger.read().map(e => e.kind), ['genesis', 'graph.assert', 'checkpoint', 'graph.assert', 'checkpoint']);
  assert.throws(() => w.open({origins: reader}), e => e.code === 'GRAPH_CORRUPT' && /agent origin synthetic.tool may not admit an assertion classified observed/.test(e.message));
  assert.throws(() => w.open({origins: reader, ...s.opts}), e => e.code === 'GRAPH_CORRUPT' && /agent origin synthetic.tool may not admit an assertion classified observed/.test(e.message));
});

test('tail: what the entries after the snapshot cannot re-derive is noted against each entry, as the full open notes it', t => {
  const w = world(t), s = pinned(w);
  let gone = false;
  const sources = () => [dirSource(w.srcRoot), dirSource(w.srcRoot, 'synthetic.other', {gone: () => gone})];
  const g = w.open({sources: sources()});
  g.observe(SYSTEM, ex(w, 0));
  writeSnapshot(g, {dir: s.dir, signer: s.signer});
  publish(w.srcRoot, 'synthetic.other', {entities: {[C('other-x')]: {}}, relationships: []});
  g.observe('synthetic.other', ex(w, 1));
  gone = true;
  const full = w.open({sources: sources()}), fast = w.open({sources: sources(), ...s.opts});
  assert.deepEqual([used(fast), fast.verification.snapshot.tail], [true, 1]);
  assert.equal(full.verification.partial.length, 1);
  assert.match(full.verification.partial[0].why, /synthetic.other@sha256:[0-9a-f]+: source "synthetic.other" at .* could not be read/);
  assert.deepEqual([fast.verification.partial, fast.verification.complete], [full.verification.partial, false]);
  assert.equal(fast.digest(), full.digest());
});

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const [world, dir, mode] = process.argv.slice(1);
const {openGraph, writeSnapshot} = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '../index.mjs')).href)});
const {ORIGINS, dirSource} = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'fixture.mjs')).href)});
const signer = JSON.parse(fs.readFileSync(path.join(world, 'snapshot-key.json'), 'utf8'));
const g = openGraph({dir: path.join(world, 'ledger'), anchor: fs.readFileSync(path.join(world, 'anchor'), 'utf8'), origins: ORIGINS, sources: [dirSource(path.join(world, 'src'))]});
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === 'pause') {
  // Stop after the first write of the snapshot's bytes, as a process killed mid-write would.
  const write = fs.writeSync;
  let n = 0;
  fs.writeSync = (...a) => { const r = write(...a); if (++n === 1) { write(1, 'paused\\n'); sleep(600000); } return r; };
} else {
  const go = path.join(world, 'go'), until = Date.now() + 30000;
  while (!fs.existsSync(go) && Date.now() < until) sleep(2);
}
const r = writeSnapshot(g, {dir, signer});
console.log(JSON.stringify({file: path.basename(r.file), seq: r.seq}));
`;
const child = args => spawn(process.execPath, ['--input-type=module', '-e', CHILD, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
const done = c => new Promise(resolve => { let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; }); c.once('close', code => resolve({code, out, err})); });
const temps = dir => fs.readdirSync(dir).filter(n => n.startsWith('.tmp-'));

test('write: atomic -- a writer killed in the middle of a write leaves no partial snapshot; readers use the previous one', {timeout: 120_000}, async t => {
  const {w, g, s, written} = snapped(t);
  fs.writeFileSync(path.join(w.dir, 'snapshot-key.json'), JSON.stringify(s.signer));
  g.assert([tool({entity: id('evidence', 'observation', 'o2')})], w.by('tool'));
  const c = child([w.dir, s.dir, 'pause']), out = [];
  t.after(() => c.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    c.stdout.on('data', d => { out.push(String(d)); if (out.join('').includes('paused')) resolve(); });
    c.once('close', code => reject(new Error(`the writer ended before it paused (${code})`)));
  });
  assert.equal(temps(s.dir).length, 1, 'the writer is in the middle of its write');
  assert.deepEqual(listSnapshots(s.dir).map(x => x.name), [path.basename(written.file)], 'and no reader sees it');
  const mid = w.open(s.opts);
  assert.deepEqual([used(mid), mid.verification.snapshot.seq, mid.verification.snapshot.refusals], [true, written.seq, []]);
  c.kill('SIGKILL');
  await new Promise(resolve => (c.exitCode !== null || c.signalCode ? resolve() : c.once('close', resolve)));
  assert.equal(c.signalCode, 'SIGKILL');
  const after = w.open(s.opts);
  assert.deepEqual([used(after), after.verification.snapshot.seq, after.digest()], [true, written.seq, g.digest()]);
});

test('write: two writers in two real processes at once leave one valid snapshot', {timeout: 120_000}, async t => {
  const {w, g, s, written} = snapped(t);
  fs.writeFileSync(path.join(w.dir, 'snapshot-key.json'), JSON.stringify(s.signer));
  g.assert([tool({entity: id('evidence', 'observation', 'o2')})], w.by('tool'));
  fs.rmSync(written.file);
  const runs = ['a', 'b'].map(() => done(child([w.dir, s.dir, 'race'])));
  fs.writeFileSync(path.join(w.dir, 'go'), '');
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const wrote = results.map(r => JSON.parse(r.out.trim().split('\n').at(-1)));
  assert.deepEqual(wrote.map(x => x.seq), [4, 4]);
  assert.deepEqual(listSnapshots(s.dir).map(x => x.name), [wrote[0].file], 'one snapshot');
  assert.deepEqual(temps(s.dir), [], 'no temporary file left behind');
  const h = w.open(s.opts);
  assert.deepEqual([used(h), h.verification.snapshot.seq, h.verification.snapshot.tail, h.digest()], [true, 4, 0, g.digest()]);
});

test('write: retention keeps the newest N, and writing never touches the ledger', t => {
  const w = world(t), g = w.open(), s = pinned(w);
  g.observe(SYSTEM, ex(w, 0));
  const ledgerBytes = () => fs.readdirSync(w.ledgerDir, {recursive: true}).sort().map(f => { const p = path.join(w.ledgerDir, f); return fs.statSync(p).isFile() ? `${f}:${sha(fs.readFileSync(p))}` : f; }).join('\n');
  const seqs = [];
  for (let i = 0; i < 4; i++) {
    g.assert([tool({entity: id('evidence', 'observation', `r${i}`)})], w.by('tool'));
    const before = ledgerBytes();
    seqs.push(writeSnapshot(g, {dir: s.dir, signer: s.signer}).seq);
    assert.equal(ledgerBytes(), before, 'the ledger is byte for byte as it was');
  }
  assert.deepEqual(listSnapshots(s.dir).map(x => x.seq), [seqs[3], seqs[2]], 'the default keeps two');
  g.assert([tool({entity: id('evidence', 'observation', 'r4')})], w.by('tool'));
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer, retain: 3});
  assert.deepEqual([listSnapshots(s.dir).map(x => x.seq), r.removed], [[r.seq, seqs[3], seqs[2]], []]);
  writeSnapshot(g, {dir: s.dir, signer: s.signer, retain: 1});
  assert.deepEqual(listSnapshots(s.dir).map(x => x.seq), [r.seq]);
  // A projection that is not its ledger's (a write applied without its ledger entry) is never written.
  g.projection.apply({seq: g.ledger.read().length + 1, kind: 'graph.assert', author: {key_id: 'tool-key'}, parent: g.projection.head,
    payload: {schema: GRAPH_SCHEMA, records: [PHANTOM]}});
  assert.throws(() => writeSnapshot(g, {dir: s.dir, signer: s.signer}), e => e.code === 'GRAPH_SNAPSHOT' && /is not an entry of its ledger/.test(e.message));
  assert.throws(() => writeSnapshot(world(t).open(), {dir: s.dir, signer: s.signer}), /nothing to snapshot/);
});

test('no snapshot: the full open is unchanged -- every entry re-derived and validated, what could not be read noted', t => {
  // A ledger with checkpoints (every second entry), its last entry a checkpoint, so 'frontier' would verify less.
  const w = world(t, {checkpointEvery: 2}), g = w.open();
  g.observe(SYSTEM, ex(w, 0));
  g.assert([tool({entity: id('evidence', 'observation', 'o1')}), tool({type: 'verifies', from: id('evidence', 'observation', 'o1'), to: C('session')})], w.by('tool'));
  assert.equal(g.ledger.read().at(-1).kind, 'checkpoint');
  const blind = w.open({sources: [dirSource(w.srcRoot, SYSTEM, {gone: () => true})]});
  assert.deepEqual(Object.keys(blind.verification), ['ok', 'entries', 'head', 'rederived', 'partial', 'complete', 'notes'], 'no snapshot, no snapshot field');
  assert.deepEqual([blind.verification.rederived, blind.verification.complete, blind.verification.notes], [2, false, []]);
  assert.deepEqual(blind.verification.partial.map(p => p.seq), [2, 4]);
  // Every entry is validated under the reader's registry, those a ledger checkpoint covers too.
  const reader = defineOrigins({...Object.fromEntries(Object.entries(ORIGINS).map(([k, o]) => [k, {...o}])), 'synthetic.tool': {kind: 'agent', basis: 'inferred', keys: ['tool-key']}});
  assert.throws(() => w.open({origins: reader}), e => e.code === 'GRAPH_CORRUPT' && /agent origin synthetic.tool may not admit/.test(e.message));
});

test('refresh: a graph opened from a snapshot writes, observes and refreshes as one opened in full, and keeps the snapshot\'s provenance', t => {
  const {w, s, written} = snapped(t, {checkpointEvery: 2});
  const h = w.open(s.opts);
  assert.equal(used(h), true);
  h.assert([tool({entity: id('evidence', 'observation', 'o2')})], w.by('tool'));
  w.publish({...SYSTEM_SNAPSHOT, entities: {...SYSTEM_SNAPSHOT.entities, [C('session')]: {moved: true}}});
  assert.equal(h.observe(SYSTEM, ex(w, 1)).recorded, true);
  assert.equal(h.observe(SYSTEM, ex(w, 2)).recorded, false, 'the same version again is not recorded');
  h.refresh();
  assert.deepEqual([h.verification.snapshot.used, h.verification.snapshot.seq], [true, written.seq]);
  const full = w.open();
  assert.deepEqual([h.digest(), h.reconcile().equal], [full.digest(), true]);
  // A replay from genesis replaces the restored state: the provenance says so.
  h.projection.reset();
  h.refresh();
  assert.deepEqual([h.verification.snapshot.used, h.verification.snapshot.reason, h.digest()],
    [false, 'the state restored from the snapshot was replaced by a replay of the ledger', full.digest()]);
});
