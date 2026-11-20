#!/usr/bin/env node
// MUTATION RUNNER for the integration toolkit (scripts/test-gates/TOOLKIT.md: reach.mjs, affected-runners.mjs,
// manifest-reach.mjs, stress.mjs). Modelled on ophanim/graph/graph-d1.mutate.mjs. Every mutation re-introduces the failure
// a tool exists to end -- a dynamic import missed or an import matched by name (reach), a runner's edited file not
// counted, a withheld path listed and read, a changed deciding test or a runner's own change not listed (affected
// runners), a failing --run reported as success, an unreadable runner cleared, a hold ignored, the base commit replaced by
// HEAD, a missing test that does not fail the manifest, a runner editing a changeable module not required (manifest
// reach), the repeats, the concurrency, the failing test's name or the load processes' end dropped (stress) -- on a
// DISPOSABLE COPY of this tree (never the tree itself), and only the tests that decide it run there (`tests`: each
// [file, --test-name-pattern]); the copy is thrown away.
//
//   node scripts/test-gates/toolkit.mutate.mjs [--only R1,S2] [--log DIR] [--copy-root DIR] [--check]
//
// The copy is a local clone at HEAD whose sparse checkout never materializes a withheld path (recorded review findings,
// `findings-*`), with this working tree committed on top. Each mutation names its edits: {file, from, to}, the EXACT text
// replaced. The runner EXITS NON-ZERO when a target does not occur exactly once (2), when the unmutated suites are not
// green (3), or when any mutation SURVIVES (1): its deciding tests stay green with it. The deciding tests build synthetic
// repositories and synthetic test files only; no test reaches a provider or the network. This file runs at import: it is
// read as text by ophanim/graph/extract/verification.mjs (and by the toolkit itself), never imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REACH_TEST = 'scripts/test-gates/toolkit-reach.test.mjs', AFFECTED_TEST = 'scripts/test-gates/toolkit-affected.test.mjs';
const MANIFEST_TEST = 'scripts/test-gates/toolkit-manifest.test.mjs', STRESS_TEST = 'scripts/test-gates/toolkit-stress.test.mjs';
const SUITES = [REACH_TEST, AFFECTED_TEST, MANIFEST_TEST, STRESS_TEST];
const REACH = 'scripts/test-gates/reach.mjs', AFFECTED = 'scripts/test-gates/affected-runners.mjs', MANIFEST = 'scripts/test-gates/manifest-reach.mjs', STRESS = 'scripts/test-gates/stress.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- T1 reach -----------------------------------------------------------------------------------------------------------
  {id: 'R1', what: 'a dynamic import is not read as an import: only static specifiers are resolved', tests: [[REACH_TEST, '^reach: a static and a DYNAMIC import']],
    edits: [one(REACH, '  for (const m of text.matchAll(SPEC)) specs.push({spec: m[2], line: lineAt(m.index)});',
      String.raw`  for (const m of text.matchAll(SPEC)) if (!/^import\s*\(/.test(m[0])) specs.push({spec: m[2], line: lineAt(m.index)});`)]},
  {id: 'R2', what: 'an import is matched by the module\'s file name, not resolved relative to the importing file', tests: [[REACH_TEST, '^reach: a static and a DYNAMIC import']],
    edits: [one(REACH, '      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), bare));',
      '      const target = snap.paths.find(p => path.posix.basename(p) === path.posix.basename(bare)) ?? bare;')]},
  {id: 'R3', what: 'a runner whose mutation table edits the module is not reached (only imports count)', tests: [[REACH_TEST, '^reach: a runner is reached']],
    edits: [one(REACH, "...(hitTargets.length ? ['target'] : [])", "...([].length ? ['target'] : [])")]},
  {id: 'R4', what: 'withheld paths are listed and read: the git exclusion and the WITHHELD filter are both dropped', tests: [[REACH_TEST, '^reach: withheld paths are never listed or read']],
    edits: [one(REACH, "'ls-files', '-z', '--', '.', ...EXCLUDE]", "'ls-files', '-z', '--', '.']"),
      one(REACH, String.raw`.split('\0').filter(p => p && !WITHHELD.test(p));`, String.raw`.split('\0').filter(p => p);`)]},
  // ---- T2 affected runners ------------------------------------------------------------------------------------------------
  {id: 'A1', what: 'a changed DECIDING test does not list its runner (only targets count: the lessons class itself)', tests: [[AFFECTED_TEST, '^affected runners: a changed DECIDING test']],
    edits: [one(AFFECTED, "    if (d.length) reasons.push({kind: 'decides', files: d});", "    if (false && d.length) reasons.push({kind: 'decides', files: d});")]},
  {id: 'A2', what: 'a runner whose own file changed is not listed', tests: [[AFFECTED_TEST, '^affected runners: an unrelated change lists none']],
    edits: [one(AFFECTED, "    if (changed.has(e.path)) reasons.push({kind: 'own', files: [e.path]});", '    // the runner\'s own change is not a reason')]},
  {id: 'A3', what: '--run reports success when a runner exits non-zero', tests: [[AFFECTED_TEST, '^affected runners: --run propagates']],
    edits: [one(AFFECTED, '  return bad.length ? 1 : 0;', '  return 0;')]},
  {id: 'A4', what: 'a runner whose table cannot be read is cleared (not listed)', tests: [[AFFECTED_TEST, '^affected runners: a runner whose table cannot be read']],
    edits: [one(AFFECTED, '    if (!table.mutations.length) reasons.push(', '    if (false) reasons.push(')]},
  // ---- T3 manifest reach --------------------------------------------------------------------------------------------------
  {id: 'M1', what: 'a declared hold is ignored: a held test is reported missing', tests: [[MANIFEST_TEST, '^manifest reach: the reached test granted, or held']],
    edits: [one(MANIFEST, '    const h = holds.find(x => matches(file, [x.path]));', '    const h = null;')]},
  {id: 'M2', what: 'the manifest is judged against HEAD, not its base commit', tests: [[MANIFEST_TEST, '^manifest reach: the base commit is read']],
    edits: [one(MANIFEST, '        const base = worktree ? null : ref ?? agent.base_commit ?? manifest.base_commit;', "        const base = worktree ? null : ref ?? 'HEAD';")]},
  {id: 'M3', what: 'a missing test does not fail the manifest (exit 0)', tests: [[MANIFEST_TEST, '^manifest reach: a manifest missing a reached test']],
    edits: [one(MANIFEST, "  return results.some(r => r.verdict === 'FAIL') ? 1 : 0;", '  return 0;')]},
  {id: 'M4', what: 'a runner that edits a changeable module is not required (only importing runners are)', tests: [[MANIFEST_TEST, '^manifest reach: a manifest missing a reached test']],
    edits: [one(MANIFEST, "...r.runners.filter(x => x.basis.includes('import') || x.basis.includes('target'))", "...r.runners.filter(x => x.basis.includes('import'))")]},
  // ---- T4 stress ----------------------------------------------------------------------------------------------------------
  {id: 'S1', what: 'the repeats are dropped: one round only', tests: [[STRESS_TEST, '^stress: a deliberately flaky test']],
    edits: [one(STRESS, '    for (let round = 1; round <= repeat; round++) {', '    for (let round = 1; round <= 1; round++) {')]},
  {id: 'S2', what: 'the files run one at a time whatever the concurrency', tests: [[STRESS_TEST, '^stress: a race that appears only in parallel']],
    edits: [one(STRESS, '      await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, worker));', '      await Promise.all(Array.from({length: 1}, worker));')]},
  {id: 'S3', what: 'a failing test is not named: the run is reported without its failing tests', tests: [[STRESS_TEST, '^stress: a deliberately flaky test']],
    edits: [one(STRESS, '            failures: failuresOf(events), problems', '            failures: [], problems')]},
  {id: 'S4', what: 'the load processes are left running after the last round', tests: [[STRESS_TEST, '^stress: --load']],
    edits: [one(STRESS, '  } finally { await spin?.stop(); }', '  } finally { }')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const g = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, encoding: 'utf8', ...opts});
function copyTree(dest) {
  // A local clone at HEAD whose sparse checkout excludes every withheld path, so none is written to disk.
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', ROOT, dest], {stdio: 'ignore'});
  g(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  g(dest, ['checkout', '-q', g(ROOT, ['rev-parse', 'HEAD']).trim()]);
  // This working tree on top of HEAD: every tracked or untracked (not ignored) file, withheld paths never read.
  const files = g(ROOT, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
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
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  g(dest, ['add', '-A']);
  g(dest, ['commit', '-q', '--allow-empty', '-m', 'the working tree under mutation']);
}
// Each run is BOUNDED (RUN_LIMIT_MS): a file that never exits (mutation S4's test file did, before stress.mjs unref'd its
// load processes) is killed and reported HUNG -- never a kill, never an endless wait.
const RUN_LIMIT_MS = 600_000;
const runSuites = (dir, logFile, files, patterns = []) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env, timeout: RUN_LIMIT_MS, killSignal: 'SIGKILL'});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, hung: r.error?.code === 'ETIMEDOUT', tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `toolkit-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = path.join(fs.mkdtempSync(path.join(copyRoot, 'toolkit-mutate-')), 'tree');
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.hung || baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
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
      const killed = !r.hung && r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, hung: r.hung, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : r.hung ? 'HUNG    ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}${r.hung ? ` (killed after ${RUN_LIMIT_MS / 1000}s)` : ''}`);
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
