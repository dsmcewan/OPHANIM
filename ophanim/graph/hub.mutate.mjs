#!/usr/bin/env node
// MUTATION RUNNER for the hub-readiness determination (ophanim/graph/hub.mjs, fixtures/hub-world.mjs;
// docs/knowledge-graph/hub-and-spoke.md). Modelled on ophanim/graph/graph-d1.mutate.mjs. Every mutation re-introduces a
// plausible regression of a criterion's check, of the verdict, or of determinism -- a search that finds nothing, a digest
// that sees no change, a forbidden link or a short transitive reach accepted, a duplicate import accepted, the hub's cost
// judged by an open it does not make, a spliced chain left off the list, the hub's own facts taken as separated, the
// owner's pending decisions ignored, a hub-signed status or a tick's open ignored, replication judged without its anchors,
// a template's shared anchor ignored, code lineage never measured, a transitive notice not required, a blocking fail
// read as a condition, the path out of order, a random inventory, a template not honoured, a rollback not measured -- on
// a DISPOSABLE COPY of this tree (never the tree itself), and only the tests that decide it run there (`tests`: each
// [file, --test-name-pattern]); the copy is thrown away.
//
//   node ophanim/graph/hub.mutate.mjs [--only H1,H2] [--log DIR] [--copy-root DIR] [--check]
//
// The copy is a local clone whose sparse checkout never materializes a withheld path (recorded review findings,
// `findings-*`), with this working tree committed on top of HEAD (the tests read the code facts at HEAD). Each mutation
// names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not occur
// exactly once (2), when the unmutated suite is not green (3), or when any mutation SURVIVES (1). Synthetic keys only; no
// test reaches a provider or the network. This file is never imported (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HUB_TEST = 'ophanim/graph/hub.test.mjs';
const SUITES = [HUB_TEST];
const HUB = 'ophanim/graph/hub.mjs', WORLD = 'ophanim/graph/fixtures/hub-world.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});
const CRITERIA = '^hub: the criteria from the measurements';

export const MUTATIONS = [
  {id: 'H1', what: 'R1: the withheld-value search counts no restricted value it finds', tests: [[HUB_TEST, '^hub: R1 ']],
    edits: [one(HUB, 'found: {restricted: found.filter(x => planted.restricted.has(x)).length,', 'found: {restricted: 0,')]},
  {id: 'H2', what: 'R1: the department-ledger digest sees no change (the hub could rewrite a ledger unseen)', tests: [[HUB_TEST, '^hub: R1 ']],
    edits: [one(HUB, "[d, H(Object.entries(filesUnder(path.join(w.root, d, 'ledger'))).sort(([a], [b]) => byString(a, b)))]", '[d, H(d)]')]},
  {id: 'H3', what: 'R2: a forbidden link (to a withheld node, or of a type the policy does not permit) is not a failure', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 's.run.r2.provenance && !s.run.r2.forbidden_linked.length && s.run.r2.transitive.reaches.length === 3', 's.run.r2.provenance && s.run.r2.transitive.reaches.length === 3')]},
  {id: 'H4', what: 'R2: a transitive reach that stops short of a department is accepted', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, '!s.run.r2.forbidden_linked.length && s.run.r2.transitive.reaches.length === 3', '!s.run.r2.forbidden_linked.length && s.run.r2.transitive.reaches.length > 0')]},
  {id: 'H5', what: 'R3: a catch-up that imports an export twice is accepted', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'c.imported_now === c.expected_now && c.duplicates === 0 && c.chain_equals_outbox', 'c.imported_now === c.expected_now && c.chain_equals_outbox')]},
  {id: 'H6', what: 'R4: the hub\'s cost judged by a snapshot open the hub as built never makes', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'const asBuiltFits = r4x1 && r4x1.full_open_ms !== null && r4x1.full_open_ms <= 1000;', 'const asBuiltFits = r4x1 && median(r4x1.snapshot_open_ms) <= 1000;')]},
  {id: 'H7', what: 'R5: a spliced chain (KG-14) is left off the list of accepted ingestion faults', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, "accepted = ['splice', 'fork', 'rollback',", "accepted = ['fork', 'rollback',")]},
  {id: 'H8', what: 'R6: the hub\'s own facts taken as separated because a department cannot be named as the central', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'enforced = d6.department_named_as_the_central.refused && !d6.hub_own_fact_without_export.recorded;', 'enforced = d6.department_named_as_the_central.refused;')]},
  {id: 'H9', what: 'R7: the owner\'s pending decisions (KG-4) ignored', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, "pending = /pending owner/i.test(rf.register['KG-4']?.status ?? '');", 'pending = false;')]},
  {id: 'H10', what: 'R7: a status the hub signs into a department is not a governance failure', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'const r7ok = gv.central_writes_department.refused && gv.hub_signed_status_in_replica.refused && ', 'const r7ok = gv.central_writes_department.refused && ')]},
  {id: 'H11', what: 'R8: a tick\'s cost leaves out the central open', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'per_tick_as_built_ms: o.full_open_ms === null || catchUp === null ? null : Math.round(o.full_open_ms + catchUp),', 'per_tick_as_built_ms: catchUp === null ? null : Math.round(catchUp),')]},
  {id: 'H12', what: 'R9: replication judged without requiring distinct anchors', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'rp.fresh.distinct === rp.fresh.anchors && rp.fresh.roots_disjoint && rf.replication_symbols.length', 'rp.fresh.roots_disjoint && rf.replication_symbols.length')]},
  {id: 'H13', what: 'R10: replicas from one template sharing an anchor (KG-8) is not a failure', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'const r10fail = twinsSame.length > 0 || rp.impersonation', 'const r10fail = rp.impersonation')]},
  {id: 'H14', what: 'R11: code lineage never measured (always a gap)', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, "ln.code_fields.length && ln.contract_version_named ? 'condition' : 'gap'", "'gap'")]},
  {id: 'H15', what: 'R12: a notice that does not reach the transitive dependent (Compliance) is accepted', tests: [[HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'defectOk = lr.defect.notices.finance > 0 && lr.defect.notices.compliance > 0 && ', 'defectOk = lr.defect.notices.finance > 0 && ')]},
  {id: 'H16', what: 'the verdict reads a blocking failure as a condition', tests: [[HUB_TEST, '^hub: the verdict'], [HUB_TEST, CRITERIA]],
    edits: [one(HUB, 'const failing = open.filter(c => c.blocking).map(c => c.id);', 'const failing = [];')]},
  {id: 'H17', what: 'the path to production out of PRIORITY order', tests: [[HUB_TEST, '^hub: the verdict']],
    edits: [one(HUB, 'const rank = c => (PRIORITY.indexOf(c.id) + 1 || 99);', 'const rank = () => 0;')]},
  {id: 'H18', what: 'determinism: a department\'s inventory drawn at random', tests: [[HUB_TEST, '^hub: determinism']],
    edits: [one(WORLD, "const accessOf = i => (i % 10 === 0 ? 'restricted' : i % 10 <= 4 ? 'internal' : 'public');", "const accessOf = () => (Math.random() < 0.1 ? 'restricted' : Math.random() < 0.45 ? 'internal' : 'public');")]},
  {id: 'H19', what: 'R10: the replica creator ignores the template (so the shared-anchor hole is never exercised)', tests: [[HUB_TEST, '^hub: R10 ']],
    edits: [one(WORLD, 'const g = Object.fromEntries(KEY_IDS.map(k => [k, template?.[k] ?? generateSigner(k)]));', 'const g = Object.fromEntries(KEY_IDS.map(k => [k, generateSigner(k)]));')]},
  {id: 'H20', what: 'R5: a rollback of the hub\'s projection is not measured', tests: [[HUB_TEST, '^hub: R5 guards']],
    edits: [one(HUB, 'projection_reverted: nodeAfter !== null && nodeAfter !== nodeNow,', 'projection_reverted: false,')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const g = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, encoding: 'utf8', ...opts});
const EXCLUDE = [':(exclude,glob)findings-*', ':(exclude,glob)findings-*/**', ':(exclude,glob)**/findings-*', ':(exclude,glob)**/findings-*/**'];
function copyTree(dest) {
  // A local clone at HEAD whose sparse checkout excludes every withheld path, so none is written to disk.
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', ROOT, dest], {stdio: 'ignore'});
  g(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  g(dest, ['checkout', '-q', g(ROOT, ['rev-parse', 'HEAD']).trim()]);
  // This working tree on top of HEAD: every tracked or untracked (not ignored) file, withheld paths excluded by pathspec.
  const files = g(ROOT, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.', ...EXCLUDE]).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD.test(f)) continue;
    const from = path.join(ROOT, f), to = path.join(dest, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(to), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.rmSync(to, {force: true}); fs.symlinkSync(fs.readlinkSync(from), to); continue; }
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(fs.realpathSync(path.join(ROOT, nm)), path.join(dest, nm), 'dir');
  }
  g(dest, ['add', '-A']);
  g(dest, ['commit', '-q', '--allow-empty', '-m', 'the working tree under mutation']);
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `hub-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = path.join(fs.mkdtempSync(path.join(copyRoot, 'hub-mutate-')), 'tree');
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suite is not green: no mutation result would mean anything');
    for (const f of baseline.failed.slice(0, 8)) console.error(`    ${f.slice(0, 200)}`);
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
  fs.rmSync(path.dirname(copy), {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
