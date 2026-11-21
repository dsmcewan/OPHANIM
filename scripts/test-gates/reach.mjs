#!/usr/bin/env node
// T1 REACH (scripts/test-gates/TOOLKIT.md): every tracked test file (*.test.mjs) and committed mutation runner
// (*.mutate.mjs) that reaches any of the given modules -- the list an ownership manifest must grant, and an integration
// must re-run, when those modules change (lessons class brief-manifest-disagree: a manifest omitted tests the slice's own
// changes reached, so they broke outside what the agent could edit).
//
//   node scripts/test-gates/reach.mjs <module|glob>... [--ref COMMIT] [--transitive[=N]] [--json] [--root DIR]
//
// A TEST reaches a module when it imports it: every static and dynamic import specifier (the `SPEC` regex of
// ophanim/graph/extract/repo.mjs, reused; plus a template-literal dynamic import whose path part has no substitution) is
// resolved RELATIVE TO THE FILE (a workspace package name through its package.json `exports`/`main`) to a path of the
// tree, never matched by name. With --transitive the importers of importers are followed, to N levels (default
// TRANSITIVE_BOUND); the output says when the bound cut the walk short.
// A RUNNER reaches a module on any of three bases, each named: `import` (its text imports it), `target` (its mutation
// table, read AS TEXT through mutationTable, edits the module: a change to the module can break the runner's exact-text
// edits), `decides` (one of its deciding test files reaches the module: its baseline can go red). A runner is never
// imported or executed (it runs at import).
// What this reader CANNOT read is said, never silently dropped (lessons class text-reader-misses-new-shape): a test or
// runner with a dynamic import whose specifier is not a literal is listed as `opaque`, and a runner mutation whose table
// names no target or no deciding test as `unread`.
//
// Inputs:  the tracked files of the working tree (git ls-files), or the tree of --ref COMMIT (git's object store only).
// Outputs: text, or JSON with --json ({schema: 'ophanim.toolkit.reach/v1', ...}). Exit 0; 2 on a usage error or a
//          module that names no tracked file (a typo must not read as "nothing reaches it").
// Must never: list, read or report a withheld path (`findings-*`); import a runner; report a name match as an import.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SPEC} from '../../ophanim/graph/extract/repo.mjs';
import {mutationTable, RUNNER} from '../../ophanim/graph/extract/verification.mjs';
import {treeAt, blobsAt, resolveCommit, WITHHELD} from '../../ophanim/graph/extract/git.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TRANSITIVE_BOUND = 8;
export const SCHEMA = 'ophanim.toolkit.reach/v1';
/** git pathspecs that keep withheld paths out of git's own output. */
export const EXCLUDE = [':(exclude,glob)**/findings-*/**', ':(exclude,glob)**/findings-*'];
export const isTest = p => /\.test\.(mjs|js|cjs)$/.test(p);
export const isRunner = p => RUNNER.test(p);
const CODE = /\.(mjs|js|cjs)$/;
const READ = /\.(mjs|js|cjs|json)$/;
// A dynamic import of a template literal: its path part (before ? or #) is static when it holds no substitution.
const TEMPLATE_IMPORT = /\bimport\s*\(\s*`([^`]*)`/g;
// A dynamic import whose argument is not a literal at all (a constant, a call, a URL object).
const OPAQUE_IMPORT = /\bimport\s*\(\s*(?!['"`\s])/g;

/**
 * The repository's files at `ref` (a commit; git's object store) or in the working tree (ref null; tracked files only).
 * {ref, paths: [repo-relative], text: Map path -> string for code and JSON files}. Withheld paths are never listed by
 * git (EXCLUDE) and dropped again by WITHHELD; their bytes are never read.
 */
export function snapshot({root = ROOT, ref = null} = {}) {
  if (ref) {
    const commit = resolveCommit(root, ref);
    const entries = treeAt(root, commit).entries.filter(e => !WITHHELD.test(e.path));
    const readable = entries.filter(e => e.mode !== '120000' && READ.test(e.path));
    const bytes = blobsAt(root, readable.map(e => e.blob));
    return {ref: commit, paths: entries.map(e => e.path).sort(), text: new Map(readable.map(e => [e.path, bytes.get(e.blob).toString('utf8')]))};
  }
  const listed = execFileSync('git', ['-c', 'core.quotepath=off', '-C', root, 'ls-files', '-z', '--', '.', ...EXCLUDE], {encoding: 'utf8', maxBuffer: 1 << 28})
    .split('\0').filter(p => p && !WITHHELD.test(p));
  const paths = [], text = new Map();
  for (const p of listed) {
    const abs = path.join(root, p);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }                      // deleted in the working tree
    if (!st.isFile()) continue;
    paths.push(p);
    if (READ.test(p)) text.set(p, fs.readFileSync(abs, 'utf8'));
  }
  return {ref: 'working tree', paths: paths.sort(), text};
}

/** Workspace packages of the tree: name -> {dir, exports, main} (package.json files outside node_modules). */
function workspaces(snap) {
  const out = new Map();
  for (const p of snap.paths) {
    if (!(p === 'package.json' || p.endsWith('/package.json')) || p.split('/').includes('node_modules')) continue;
    try {
      const j = JSON.parse(snap.text.get(p) ?? '');
      if (typeof j.name === 'string') out.set(j.name, {dir: path.posix.dirname(p), exports: j.exports, main: j.main});
    } catch { /* not a package manifest this reader understands */ }
  }
  return out;
}

const pick = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.import ?? v.default ?? v.node ?? null) : null);

/** A resolver over the snapshot: (fromFile, specifier) -> a path of the tree, or null (external, unresolvable). */
export function resolver(snap) {
  const paths = new Set(snap.paths), pkgs = workspaces(snap);
  return (from, spec) => {
    const bare = spec.split(/[?#]/)[0];
    if (bare.startsWith('./') || bare.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), bare));
      return paths.has(target) ? target : null;
    }
    if (bare.startsWith('/') || bare.startsWith('node:') || /^[a-z]+:/.test(bare)) return null;
    for (const [name, pkg] of pkgs) {
      if (bare !== name && !bare.startsWith(`${name}/`)) continue;
      const sub = `.${bare.slice(name.length)}`;
      const entry = pkg.exports === undefined ? (sub === '.' ? pkg.main ?? 'index.js' : sub)
        : sub === '.' && (typeof pkg.exports === 'string' || pkg.exports?.import || pkg.exports?.default) ? pick(pkg.exports) : pick(pkg.exports?.[sub]);
      if (!entry) return null;
      const target = path.posix.normalize(path.posix.join(pkg.dir, entry));
      return paths.has(target) ? target : null;
    }
    return null;
  };
}

/** The specifiers a file's text imports ({spec, line}), and its opaque dynamic imports ({line, text}). */
export function importsOf(text) {
  const lineAt = i => text.slice(0, i).split('\n').length;
  const specs = [];
  for (const m of text.matchAll(SPEC)) specs.push({spec: m[2], line: lineAt(m.index)});
  for (const m of text.matchAll(TEMPLATE_IMPORT)) {
    const part = m[1].split(/[?#]/)[0];
    if (!part.includes('${')) specs.push({spec: part, line: lineAt(m.index)});
  }
  const opaque = [];
  for (const m of text.matchAll(OPAQUE_IMPORT)) {
    const line = lineAt(m.index);
    opaque.push({line, text: text.split('\n')[line - 1].trim().slice(0, 160)});
  }
  for (const m of text.matchAll(TEMPLATE_IMPORT)) {
    if (m[1].split(/[?#]/)[0].includes('${')) { const line = lineAt(m.index); opaque.push({line, text: text.split('\n')[line - 1].trim().slice(0, 160)}); }
  }
  return {specs, opaque};
}

/** importers: Map module -> Set of files that import it; opaque: Map file -> [{line, text}]. */
export function importGraph(snap) {
  const resolve = resolver(snap), importers = new Map(), opaque = new Map();
  for (const [file, text] of snap.text) {
    if (!CODE.test(file)) continue;
    const {specs, opaque: o} = importsOf(text);
    for (const {spec} of specs) {
      const target = resolve(file, spec);
      if (!target || target === file) continue;
      (importers.get(target) ?? importers.set(target, new Set()).get(target)).add(file);
    }
    if (o.length) opaque.set(file, o);
  }
  return {importers, opaque};
}

/** The given modules (paths or globs) as tree paths: {modules, unknown}. */
export function expandModules(snap, args) {
  const modules = new Set(), unknown = [];
  for (const a of args) {
    const p = a.replace(/^\.\//, '');
    if (WITHHELD.test(p)) { unknown.push(a); continue; }
    const hits = /[*?[{]/.test(p) ? snap.paths.filter(f => path.matchesGlob(f, p)) : snap.paths.includes(p) ? [p] : [];
    if (!hits.length) unknown.push(a);
    for (const h of hits) modules.add(h);
  }
  return {modules: [...modules].sort(), unknown};
}

/**
 * Reach of `modules` (tree paths) in `snap`: {tests, runners, opaque, unread, depth, truncated}.
 *   tests:   [{file, level, modules (the given modules it imports directly), via (a chain file -> ... -> module)}]
 *   runners: [{file, basis: ['import'|'target'|'decides'], targets, decides, level?}]
 *   opaque:  tests and runners NOT reached whose dynamic imports this reader cannot resolve: [{file, imports}]
 *   unread:  runner mutations the text reader could not read a target or a deciding test for: [{file, id, missing}]
 * depth 1 is direct importers only; truncated is true when the walk stopped at `depth` with importers left to follow.
 */
export function reach(snap, modules, {depth = 1, graph = importGraph(snap)} = {}) {
  const given = new Set(modules), parent = new Map(), level = new Map(modules.map(m => [m, 0]));
  let frontier = [...given];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const t of frontier) for (const f of [...(graph.importers.get(t) ?? [])].sort()) {
      if (level.has(f)) continue;
      level.set(f, d); parent.set(f, t); next.push(f);
    }
    frontier = next;
  }
  const truncated = frontier.some(t => [...(graph.importers.get(t) ?? [])].some(f => !level.has(f)));
  const chain = f => { const out = [f]; while (parent.has(out.at(-1))) out.push(parent.get(out.at(-1))); return out; };
  const direct = f => modules.filter(m => graph.importers.get(m)?.has(f));
  const tests = [...level].filter(([f, l]) => l > 0 && isTest(f)).map(([f, l]) => ({file: f, level: l, modules: direct(f), via: chain(f)}))
    .sort((a, b) => a.level - b.level || (a.file < b.file ? -1 : 1));
  const reachedTests = new Set(tests.map(t => t.file));
  const runners = [], unread = [];
  for (const file of snap.paths.filter(isRunner)) {
    const table = mutationTable(snap.text.get(file) ?? '');
    const targets = new Set(), deciding = new Set();
    for (const m of table.mutations) {
      for (const f of m.files) targets.add(f);
      for (const t of m.tests) deciding.add(t);
      const missing = [...(m.files.length ? [] : ['target']), ...(m.tests.length ? [] : ['deciding test'])];
      if (missing.length) unread.push({file, id: m.id, missing});
    }
    if (!table.mutations.length) unread.push({file, id: null, missing: ['the MUTATIONS table']});
    const hitTargets = [...targets].filter(f => given.has(f)).sort(), hitDecides = [...deciding].filter(f => reachedTests.has(f)).sort();
    const basis = [...(level.get(file) > 0 ? ['import'] : []), ...(hitTargets.length ? ['target'] : []), ...(hitDecides.length ? ['decides'] : [])];
    if (basis.length) runners.push({file, basis, targets: hitTargets, decides: hitDecides, ...(level.get(file) > 0 ? {level: level.get(file), via: chain(file)} : {})});
  }
  const reached = new Set([...reachedTests, ...runners.map(r => r.file)]);
  const opaque = [...graph.opaque].filter(([f]) => (isTest(f) || isRunner(f)) && !reached.has(f)).map(([file, imports]) => ({file, imports})).sort((a, b) => (a.file < b.file ? -1 : 1));
  return {tests, runners, opaque, unread, depth, truncated};
}

function render(r) {
  const L = [`reach of ${r.modules.length} module(s) at ${r.ref}${r.depth > 1 ? ` (transitive, ${r.depth} level(s)${r.truncated ? ', CUT SHORT by the bound: importers remain past it' : ''})` : ' (direct importers)'}:`];
  for (const m of r.modules) L.push(`  module ${m}`);
  L.push(`${r.tests.length} test file(s):`);
  for (const t of r.tests) L.push(`  ${t.file}${t.level > 1 ? `  [level ${t.level}: ${t.via.join(' -> ')}]` : `  [imports ${t.modules.join(', ')}]`}`);
  L.push(`${r.runners.length} runner(s):`);
  for (const x of r.runners) L.push(`  ${x.file}  [${x.basis.join('+')}${x.targets.length ? `; edits ${x.targets.join(', ')}` : ''}${x.decides.length ? `; decided by ${x.decides.join(', ')}` : ''}]`);
  if (r.opaque.length) {
    L.push(`${r.opaque.length} other test/runner file(s) hold a dynamic import this reader cannot resolve (they MAY reach a module; check by hand):`);
    for (const o of r.opaque) L.push(`  ${o.file}:${o.imports.map(i => i.line).join(',')}`);
  }
  if (r.unread.length) {
    L.push(`${r.unread.length} runner mutation(s) whose target or deciding test the text reader could not read:`);
    for (const u of r.unread) L.push(`  ${u.file}${u.id ? ` ${u.id}` : ''}: no ${u.missing.join(', no ')}`);
  }
  return L.join('\n');
}

export function parseDepth(a) {
  if (a === '--transitive') return TRANSITIVE_BOUND;
  const n = Number(a.slice('--transitive='.length));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--transitive=N takes a positive whole number, not ${a}`);
  return n;
}

export function main(argv, {out = s => console.log(s)} = {}) {
  let root = ROOT, ref = null, depth = 1, json = false;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') ref = argv[++i];
    else if (a === '--root') root = path.resolve(argv[++i]);
    else if (a === '--json') json = true;
    else if (a === '--transitive' || a.startsWith('--transitive=')) depth = parseDepth(a);
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else args.push(a);
  }
  if (!args.length) throw new Error('usage: reach.mjs <module|glob>... [--ref COMMIT] [--transitive[=N]] [--json] [--root DIR]');
  const snap = snapshot({root, ref});
  const {modules, unknown} = expandModules(snap, args);
  if (unknown.length) { console.error(`not a tracked file at ${snap.ref} (or a withheld path): ${unknown.join(', ')}`); return 2; }
  const r = {schema: SCHEMA, ref: snap.ref, modules, ...reach(snap, modules, {depth})};
  out(json ? JSON.stringify(r, null, 2) : render(r));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`reach: ${e.message}`); process.exitCode = 2; }
}
