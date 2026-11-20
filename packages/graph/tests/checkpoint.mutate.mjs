#!/usr/bin/env node
// MUTATION RUNNER for the knowledge graph's replay checkpoint (register KG-1; packages/graph/checkpoint.mjs, the
// projection's state serializer and restorer, openGraph's `snapshot` option; docs/knowledge-graph/checkpoint.md). Kept
// apart from graph.mutate.mjs and federation.mutate.mjs. Every mutation re-introduces a plausible regression of what a
// snapshot may be trusted for -- its signature not checked, any key accepted, a forked ledger accepted, the registry,
// origin registry, registered sources or extractor versions ignored, an unlistable snapshot directory thrown rather than
// fallen back from, its state or its projection digest not checked, the entries after it
// not applied, verified or noted, a source's replay status upgraded, a refusal not recorded, a partial file visible, a
// write of a projection that is not its ledger's, retention not applied, and the full open changed when no snapshot is
// given -- on a DISPOSABLE COPY of this tree (never the tree itself). Only the tests that decide it run there (`tests`:
// each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node packages/graph/tests/checkpoint.mutate.mjs [--only K1,K7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys only; no test reaches a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const T = 'packages/graph/tests/';
const SUITES = [`${T}checkpoint.test.mjs`, `${T}checkpoint-equality.test.mjs`];
const CK = 'packages/graph/checkpoint.mjs', PROJ = 'packages/graph/projection.mjs', KINDS = 'packages/graph/kinds.mjs';
const one = (file, from, to) => ({file, from, to});
const t = (file, pattern) => [`${T}${file}.test.mjs`, pattern];

export const MUTATIONS = [
  // ---- trust: the signed record (KP3) ----------------------------------------------------------------------------------
  {id: 'K1', what: 'the snapshot\'s signature is not checked', tests: [t('checkpoint', '^trust: a snapshot whose signature does not verify')],
    edits: [one(CK, "  if (typeof signature.sig !== 'string' || !verifyBody(body, signature.sig, pinned)) return `its signature does not verify under the pinned key \"${signature.key_id}\"`;\n", '')]},
  {id: 'K2', what: 'any key is accepted: a key the reader did not pin, carried in the snapshot itself', tests: [t('checkpoint', '^trust: a snapshot signed by a key the reader has not pinned')],
    edits: [one(CK, "Object.hasOwn(keys, signature.key_id) ? keys[signature.key_id] : null;", "Object.hasOwn(keys, signature.key_id) ? keys[signature.key_id] : signature.public;")]},
  {id: 'K3', what: 'the ledger\'s entry hash at the snapshot\'s seq is not checked: a forked ledger is accepted', tests: [t('checkpoint', '^trust: a snapshot of another ledger')],
    edits: [one(CK, "  if (entryHash(entries[seq - 1]) !== hash) return `the ledger's entry at seq ${seq} is not the one it covers (a rewritten or forked ledger)`;\n", '')]},
  {id: 'K4', what: 'the contract registry digest is ignored', tests: [t('checkpoint', '^trust: a snapshot derived under another contract')],
    edits: [one(CK, "  if (canonical(body.contract) !== canonical(contract)) return", "  if (false) return")]},
  {id: 'K5', what: 'the origin registry digest is ignored', tests: [t('checkpoint', '^trust: a snapshot derived under another contract')],
    edits: [one(CK, "  if (body.origins !== origins) return", "  if (false) return")]},
  {id: 'K6', what: 'the registered sources and the instance are ignored', tests: [t('checkpoint', '^trust: a snapshot derived under another contract')],
    edits: [one(CK, "  if (body.instance !== instance) return", "  if (false) return"), one(CK, "  if (canonical(body.adapters) !== canonical(adapters)) return", "  if (false) return")]},
  {id: 'K7', what: 'the state is not checked against the state digest it signed', tests: [t('checkpoint', '^trust: a snapshot whose state is not'), t('checkpoint', '^fallback:')],
    edits: [one(CK, "  if (state.length !== body.state_bytes || sha(state) !== body.state_digest) return 'its state is not the state it signed';\n", '')]},
  {id: 'K8', what: 'the restored state is not checked against its recorded projection digest', tests: [t('checkpoint', '^trust: a snapshot whose state is not')],
    edits: [one(CK, "    : projection.digest(body.position.seq) !== body.projection_digest ? 'its state does not reproduce its recorded projection digest'\n", '')]},
  {id: 'K21', what: 'a source\'s extractor version is ignored: a snapshot derived by other extractor code loads its facts as applied',
    tests: [t('checkpoint', '^extractor:')],
    edits: [one(CK, '  if (moved !== undefined) return', '  if (false) return')]},
  {id: 'K22', what: 'a snapshot directory that exists but cannot be listed throws instead of falling back to the full open',
    tests: [t('checkpoint', '^fallback: a snapshot directory that exists')],
    edits: [one(CK, '  try { files = listSnapshots(snapshot.dir); } catch (e) { return declined(`the snapshot directory could not be listed (${e.code ?? e.message})`); }',
      '  files = listSnapshots(snapshot.dir);')]},
  // ---- the chain and the entries after the snapshot (KP3) ------------------------------------------------------------
  {id: 'K9', what: 'the chain is not verified on the snapshot path (the ledger\'s frontier verification skipped)', tests: [t('checkpoint', '^tail: the chain after the snapshot')],
    edits: [one(CK, "      try { v = openLedger({dir, kinds: chainOnly(kinds), anchor, checkpointEvery, lockTimeoutMs, lockStaleMs, log}).verify({mode: 'frontier'}); }",
      "      try { const all = ledger.read(); v = {ok: true, entries: all.length, head: entryHash(all.at(-1)), complete: true}; }")]},
  {id: 'K10', what: 'the entries after the snapshot are not applied', tests: [t('checkpoint-equality', '^equality: a snapshot behind the head'), t('checkpoint-equality', '^equality: a source whose version'), t('checkpoint', '^fallback:')],
    edits: [one(CK, '    const tail = applyTail(chain.entries, body.position.seq, kinds, ledger);', '    const tail = {rederived: 0, partial: []};')]},
  {id: 'K11', what: 'an entry after the snapshot is not validated under the reader\'s registry', tests: [t('checkpoint', '^tail: each entry after the snapshot is validated')],
    edits: [one(CK, '    const bad = k.validate(payload);', '    const bad = null;')]},
  {id: 'K12', what: 'what an entry after the snapshot could not re-derive is not noted (complete claimed)', tests: [t('checkpoint', '^tail: what the entries after the snapshot cannot')],
    edits: [one(CK, '    for (const n of notes) partial.push({seq: e.seq, kind: e.kind, why: n});\n', '')]},
  // ---- semantics preserved (KP4) ---------------------------------------------------------------------------------------
  {id: 'K13', what: 'a source\'s replay status is upgraded on restore (recorded unavailable, loaded as applied)', tests: [t('checkpoint-equality', '^never better:')],
    edits: [one(PROJ, '      st.sourceLog = new Map(x.sourceLog);', "      st.sourceLog = new Map(x.sourceLog.map(([s, log]) => [s, log.map(e => ({...e, replay: 'applied'}))]));")]},
  {id: 'K14', what: 'a gap the snapshot holds is not noted: the open from it claims to be complete', tests: [t('checkpoint-equality', '^never better:')],
    edits: [one(CK, "const WHOLE = new Set(['applied', 'recorded']);", "const WHOLE = new Set(['applied', 'recorded', 'unavailable', 'invalid', 'diverged']);")]},
  {id: 'K15', what: 'the restorer lists assertions in another order than replay admitted them (as-of views and traversal differ)',
    tests: [t('checkpoint-equality', '^equality: a snapshot at the head'), t('checkpoint-equality', '^equality: a snapshot behind the head')],
    edits: [one(PROJ, '      for (const [record, admitted, retired] of x.assertions) {', '      for (const [record, admitted, retired] of [...x.assertions].reverse()) {')]},
  // ---- what the open records of itself (KP3) ---------------------------------------------------------------------------
  {id: 'K16', what: 'the refusal reason is not recorded: a silent fallback', tests: [t('checkpoint', '^trust: a snapshot signed by a key'), t('checkpoint', '^fallback:')],
    edits: [one(KINDS, '    else { opened = s.info; projection.reset(); refresh({mode: \'full\'}); }', '    else { opened = {used: false}; projection.reset(); refresh({mode: \'full\'}); }')]},
  // ---- writing (KP5) ---------------------------------------------------------------------------------------------------
  {id: 'K17', what: 'a non-atomic write: the snapshot is written in place, a partial file visible to readers', tests: [t('checkpoint', '^write: atomic')],
    edits: [one(CK, "  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}-${name}`);", '  const tmp = file;')]},
  {id: 'K18', what: 'a snapshot is written of a projection that is not its ledger\'s', tests: [t('checkpoint', '^write: retention')],
    edits: [one(CK, "  if (!at || entryHash(at) !== p.head) fail(", "  if (false) fail(")]},
  {id: 'K19', what: 'retention is not applied: every snapshot is kept', tests: [t('checkpoint', '^write: retention')],
    edits: [one(CK, '    removed: retention(dir, retain)};', '    removed: []};')]},
  // ---- no snapshot (KP7) -----------------------------------------------------------------------------------------------
  {id: 'K20', what: 'the full open\'s behaviour changes when no snapshot is given (it verifies in frontier mode)', tests: [t('checkpoint', '^no snapshot:')],
    edits: [one(KINDS, "  if (!snapshot) refresh({mode: 'full'});", "  if (!snapshot) refresh({mode: 'frontier'});")]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }   // e.g. pantheon's models.json
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `checkpoint-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'checkpoint-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`log: ${logDir}`);
process.exit(exit);
