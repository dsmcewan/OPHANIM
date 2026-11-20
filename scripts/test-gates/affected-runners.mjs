#!/usr/bin/env node
// T2 AFFECTED RUNNERS (scripts/test-gates/TOOLKIT.md): every committed mutation runner whose TARGET files or DECIDING
// TEST files differ between two commits -- the runners an integration must re-run in full (lessons class
// runner-deciding-tests-changed-not-rerun: integrations re-ran only the runners whose targets changed, and a runner went
// red at baseline because one of its deciding test files had changed; CI runs only --check).
//
//   node scripts/test-gates/affected-runners.mjs <base> <head> [--json] [--root DIR]
//   node scripts/test-gates/affected-runners.mjs <base> <head> --run [--copy-root DIR] [--log DIR] [--root DIR]
//
// Each runner at <head> is read AS TEXT through mutationTable (ophanim/graph/extract/verification.mjs), never imported or
// executed to be read. A runner is listed when
//   - its own file changed (always: a changed table or edit text is a reason on its own),
//   - a file one of its mutations EDITS changed, or
//   - a test file that DECIDES one of its mutations changed.
// A runner whose table this reader cannot fully read (no MUTATIONS, or a mutation with no target or no deciding test)
// is listed too, with that reason: what cannot be read cannot be cleared (lessons class text-reader-misses-new-shape).
// A runner deleted between the two commits is reported as removed (there is nothing to run).
// --run runs each listed runner IN FULL, one after another, from the checkout at --root (whose HEAD must be <head>:
// otherwise the runs would test another tree), passing --copy-root DIR through and --log DIR/<runner path> so the logs do
// not collide; it exits 1 if any runner exits non-zero (or is killed), naming each.
//
// Inputs:  two commits of the repository at --root (git's object store; the diff from git.mjs changedBetween).
// Outputs: the listed runners and their reasons (text, or JSON with --json); with --run each runner's exit status.
// Exit:    0 listed (or every run exited 0); 1 a run exited non-zero; 2 a usage error, an unknown commit, or --run when
//          the checkout's HEAD is not <head>.
// Must never: import a runner to read it; list or read a withheld path (`findings-*`); report a run it did not make.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mutationTable} from '../../ophanim/graph/extract/verification.mjs';
import {treeAt, blobsAt, resolveCommit, changedBetween} from '../../ophanim/graph/extract/git.mjs';
import {ROOT, isRunner, EXCLUDE} from './reach.mjs';

export const SCHEMA = 'ophanim.toolkit.affected-runners/v1';

/** The runners of `head` affected by the diff base..head: {base, head, changed, runners: [{file, reasons}], removed}. */
export function affected({root = ROOT, base, head}) {
  const b = resolveCommit(root, base), h = resolveCommit(root, head);
  const changes = changedBetween(root, b, h), changed = new Set(changes.map(c => c.path));
  const entries = treeAt(root, h).entries.filter(e => isRunner(e.path) && e.mode !== '120000');
  const text = blobsAt(root, entries.map(e => e.blob));
  const runners = [];
  for (const e of entries.sort((x, y) => (x.path < y.path ? -1 : 1))) {
    const table = mutationTable(text.get(e.blob).toString('utf8'));
    const reasons = [];
    if (changed.has(e.path)) reasons.push({kind: 'own', files: [e.path]});
    const targets = new Set(), deciding = new Set(), unread = [];
    for (const m of table.mutations) {
      m.files.forEach(f => targets.add(f));
      m.tests.forEach(t => deciding.add(t));
      if (!m.files.length || !m.tests.length) unread.push(m.id);
    }
    const t = [...targets].filter(f => changed.has(f)).sort(), d = [...deciding].filter(f => changed.has(f)).sort();
    if (t.length) reasons.push({kind: 'target', files: t});
    if (d.length) reasons.push({kind: 'decides', files: d});
    if (!table.mutations.length) reasons.push({kind: 'unread', files: [], note: 'no MUTATIONS table read: the runner cannot be cleared'});
    else if (unread.length) reasons.push({kind: 'unread', files: [], note: `mutation(s) ${unread.join(', ')} have no readable target or deciding test: the runner cannot be cleared`});
    if (reasons.length) runners.push({file: e.path, mutations: table.mutations.length, reasons});
  }
  const removed = changes.filter(c => c.status === 'D' && isRunner(c.path)).map(c => c.path);
  return {base: b, head: h, changed: changes.length, runners, removed};
}

const describe = r => r.reasons.map(x => (x.kind === 'own' ? 'its own file changed' : x.kind === 'target' ? `edits changed ${x.files.join(', ')}`
  : x.kind === 'decides' ? `decided by changed ${x.files.join(', ')}` : x.note)).join('; ');

function render(a) {
  const L = [`${a.base.slice(0, 12)}..${a.head.slice(0, 12)}: ${a.changed} changed file(s); ${a.runners.length} runner(s) affected`];
  for (const r of a.runners) L.push(`  ${r.file}  [${describe(r)}]`);
  for (const f of a.removed) L.push(`  removed: ${f} (deleted; nothing to run)`);
  return L.join('\n');
}

/** Run each listed runner in full; returns [{file, exit}] (exit: a code, or `signal NAME`). */
export function runAll({root, runners, copyRoot = null, logDir = null, log = s => console.log(s)}) {
  // NODE_TEST_CONTEXT (set when this runs inside a test) would make a runner's nested `node --test` report elsewhere.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const out = [];
  for (const r of runners) {
    const args = [path.join(root, r.file), ...(copyRoot ? ['--copy-root', path.resolve(copyRoot)] : []),
      ...(logDir ? ['--log', path.join(path.resolve(logDir), r.file.replace(/[^\w.-]+/g, '_'))] : [])];
    log(`\n> affected runner: node ${[r.file, ...args.slice(1)].join(' ')}  (${describe(r)})`);
    const p = spawnSync(process.execPath, args, {cwd: root, env, stdio: 'inherit'});
    const exit = p.error ? `error ${p.error.message}` : p.signal ? `signal ${p.signal}` : p.status;
    log(`< ${r.file}: exit ${exit}`);
    out.push({file: r.file, exit});
  }
  return out;
}

export function main(argv, {out = s => console.log(s)} = {}) {
  let root = ROOT, json = false, run = false, copyRoot = null, logDir = null;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = path.resolve(argv[++i]);
    else if (a === '--json') json = true;
    else if (a === '--run') run = true;
    else if (a === '--copy-root') copyRoot = argv[++i];
    else if (a === '--log') logDir = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2 || ((copyRoot || logDir) && !run)) throw new Error('usage: affected-runners.mjs <base> <head> [--json] | <base> <head> --run [--copy-root DIR] [--log DIR]  [--root DIR]');
  const a = affected({root, base: pos[0], head: pos[1]});
  if (!run) { out(json ? JSON.stringify({schema: SCHEMA, ...a}, null, 2) : render(a)); return 0; }
  const at = resolveCommit(root, 'HEAD');
  if (at !== a.head) { console.error(`--run: the checkout at ${root} is at ${at.slice(0, 12)}, not ${a.head.slice(0, 12)}: the runners would test another tree`); return 2; }
  const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', '.', ...EXCLUDE], {encoding: 'utf8'}).stdout.split('\n').filter(Boolean).length;
  out(render(a));
  if (dirty) out(`note: the working tree has ${dirty} uncommitted change(s); each runner copies the working tree, so the runs include them`);
  const results = runAll({root, runners: a.runners, copyRoot, logDir, log: out});
  const bad = results.filter(r => r.exit !== 0);
  out(`\naffected runners: ${results.length} run, ${results.length - bad.length} exited 0, ${bad.length} did not${bad.length ? `: ${bad.map(r => `${r.file} (exit ${r.exit})`).join(', ')}` : ''}`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`affected-runners: ${e.message}`); process.exitCode = 2; }
}
