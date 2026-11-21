// EXTERNAL PACKAGES AT A COMMIT as two graph sources (Slice B2, KD2-1, KD2-4; docs/knowledge-graph/slice-b2.md).
//
// Purpose   What OPHANIM's code needs from outside itself in packages, read from git's object store at a commit:
//   ophanim.packages  DECLARED: the package.json files (the root's `workspaces`, each workspace's name, exports and main,
//                     each declared dependency with its declared RANGE) and the lockfiles (package-lock.json: each
//                     installed package's RESOLVED version and integrity, and the dependencies between them). A declared
//                     dependency is its own fact, apart from what the lockfile resolved it to.
//   ophanim.imports   STRUCTURAL: every bare import specifier of the code (code.mjs: only a real import or import(),
//                     never a specifier inside a string or a comment), resolved through the workspace (a workspace
//                     package's exports or main, to a module file of the tree) or the workspace root's lockfile (Node's
//                     node_modules walk from the importer's directory, to an installed package at its resolved version);
//                     `node:` built-ins are packages of the Node runtime, apart from npm packages. A specifier that
//                     resolves to neither is a GAP (an unresolved package node), never guessed.
// Inputs    The repository root and a commit.
// Facts     systems/package/npm/<name>@<version>   an installed package: the lockfile's resolved version and integrity
//                                                  (a public package digest), the lockfile entries; `derived-from` each
//                                                  lockfile; `depends-on` the packages its entry depends on
//           systems/package/workspace/<name>       a workspace package: its directory, exports, main; `derived-from` its
//                                                  package.json; `depends-on` each export target in the tree
//           systems/package/node/<name>            a Node built-in (`node:<name>`); `depends-on` capability/runtime/node
//           systems/package/npm/<name>             UNRESOLVED: named by a declaration or an import, resolved by nothing
//           depends-on  package.json -> the package a declared dependency resolves to (declared range, resolved version)
//           depends-on  a code file -> the package, workspace module or built-in it imports (specifiers, lines, need)
// Must never  Read the working tree or a node_modules directory; take a declared range for the version; guess an alias.
import path from 'node:path';
import {treeAt, blobsAt, resolveCommit} from './git.mjs';
import {fileId} from './repo.mjs';
import {codeAt, grouped, npmPackageId, unresolvedPackageId, builtinId, workspacePackageId, runtimeId} from './code.mjs';

export const PACKAGES_SOURCE = 'ophanim.packages';
export const PACKAGES_EXTRACTOR = 'ophanim.packages.extractor';
export const PACKAGES_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [PACKAGES_SOURCE]});
export const IMPORTS_SOURCE = 'ophanim.imports';
export const IMPORTS_EXTRACTOR = 'ophanim.imports.extractor';
export const IMPORTS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'structural', sources: [IMPORTS_SOURCE]});
export const ROOT_LOCK = 'package-lock.json';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The 1-based line of the first `"key":` at or after line `from` of `text` (a JSON file as committed), or null. */
export function keyLine(text, key, from = 1) {
  const lines = text.split('\n'), needle = JSON.stringify(key) + ':';
  for (let i = Math.max(0, from - 1); i < lines.length; i++) if (lines[i].trimStart().startsWith(needle)) return i + 1;
  return null;
}
const packageName = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/**
 * The package manifests of `commit`: {paths, manifests: Map(path -> {json, text}), locks: Map(path -> {json, text}),
 * workspaces: Map(name -> {name, dir, file, json, line}), broken: [{path, why}]}. Read from git's object store only.
 */
export function manifestsAt(repo, commit) {
  const tree = treeAt(repo, commit), paths = new Set(tree.entries.map(e => e.path));
  const wanted = tree.entries.filter(e => /(^|\/)package(-lock)?\.json$/.test(e.path) && !/(^|\/)node_modules\//.test(e.path) && e.mode !== '120000');
  const bytes = blobsAt(repo, wanted.map(e => e.blob)), manifests = new Map(), locks = new Map(), broken = [];
  for (const e of wanted) {
    const text = bytes.get(e.blob).toString('utf8');
    let json;
    try { json = JSON.parse(text); } catch (err) { broken.push({path: e.path, why: `not JSON: ${err.message.slice(0, 120)}`}); continue; }
    (e.path.endsWith('package-lock.json') ? locks : manifests).set(e.path, {json, text});
  }
  const workspaces = new Map(), root = manifests.get('package.json');
  const dirs = [...new Set([...manifests.keys()].map(p => path.posix.dirname(p)))];
  for (const w of Array.isArray(root?.json.workspaces) ? root.json.workspaces : Array.isArray(root?.json.workspaces?.packages) ? root.json.workspaces.packages : []) {
    if (typeof w !== 'string') continue;
    for (const dir of dirs.filter(d => d !== '.' && (d === w.replace(/\/$/, '') || path.posix.matchesGlob(d, w)))) {
      const file = `${dir}/package.json`, m = manifests.get(file);
      if (typeof m?.json.name === 'string') workspaces.set(m.json.name, {name: m.json.name, dir, file, json: m.json, pattern: w, line: keyLine(root.text, 'workspaces')});
    }
  }
  return {paths, manifests, locks, workspaces, broken};
}

/** The export target of `sub` ('.' or './x') in a package's `exports` (the import, node, default conditions), or null. */
export function exportTarget(exp, sub) {
  const pick = v => {
    if (typeof v === 'string') return {target: v, condition: null};
    if (Array.isArray(v)) { for (const x of v) { const r = pick(x); if (r) return r; } return null; }
    if (v && typeof v === 'object') for (const c of ['import', 'node', 'default']) if (Object.hasOwn(v, c)) { const r = pick(v[c]); if (r) return {target: r.target, condition: r.condition ?? c}; }
    return null;
  };
  if (exp === undefined || exp === null) return null;
  if (typeof exp === 'string' || Array.isArray(exp)) return sub === '.' ? pick(exp) : null;
  const keys = Object.keys(exp);
  if (!keys.some(k => k.startsWith('.'))) return sub === '.' ? pick(exp) : null;
  if (Object.hasOwn(exp, sub)) return pick(exp[sub]);
  for (const k of keys) if (k.includes('*')) {
    const [a, b] = k.split('*');
    if (sub.startsWith(a) && sub.endsWith(b) && sub.length >= a.length + b.length) { const r = pick(exp[k]); if (r) return {...r, target: r.target.replace('*', sub.slice(a.length, sub.length - b.length))}; }
  }
  return null;
}

/** A workspace package's module for `sub`: {file, export, condition} or {why} (no exports entry, or a target not in the tree). */
function workspaceModule(ws, sub, paths) {
  const e = exportTarget(ws.json.exports, sub) ?? (sub === '.' && ws.json.exports === undefined && typeof ws.json.main === 'string' ? {target: ws.json.main, condition: 'main'} : null);
  if (!e) return {why: `${ws.name} declares no export "${sub}"${ws.json.exports === undefined && sub === '.' ? ' and no main' : ''}`};
  const file = path.posix.normalize(path.posix.join(ws.dir, e.target));
  return paths.has(file) ? {file, export: sub, condition: e.condition} : {why: `${ws.name} exports "${sub}" as ${e.target}, which is not in the tree at this commit`};
}

/** The installed entry Node finds for `name` from directory `dir` in a lockfile's tree (its node_modules walk), or null. */
export function lockEntry(lock, dir, name) {
  const pk = lock?.json.packages ?? {};
  for (let d = dir; ; d = path.posix.dirname(d)) {
    const key = `${d === '.' || d === '' ? '' : `${d}/`}node_modules/${name}`;
    if (Object.hasOwn(pk, key)) return {key, entry: pk[key]};
    if (d === '.' || d === '' || d === '/') return null;
  }
}
const nameOfKey = (key, entry) => entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
/** Where an installed entry lives (its own directory, for the walk to its dependencies). */
const dirOfKey = key => key;

/** The facts of the package manifests and lockfiles at `commit` (declared). */
export function packagesFacts(repo, commit) {
  const {paths, manifests, locks, workspaces, broken} = manifestsAt(repo, commit), drafts = [];
  // Installed packages: one node per (name, version) across every lockfile, its entries listed.
  const pkgs = new Map(), links = new Map();
  for (const [lockPath, lock] of [...locks].sort((a, b) => byString(a[0], b[0]))) {
    const pk = lock.json.packages ?? {}, from = keyLine(lock.text, 'packages') ?? 1;
    for (const [key, entry] of Object.entries(pk)) {
      if (!key.includes('node_modules/') || !entry || typeof entry !== 'object') continue;
      if (entry.link) { links.set(`${lockPath}\0${key}`, entry.resolved); continue; }
      if (typeof entry.version !== 'string') continue;
      const name = nameOfKey(key, entry), id = npmPackageId(name, entry.version);
      const p = pkgs.get(id) ?? pkgs.set(id, {id, name, version: entry.version, integrity: new Set(), resolved: new Set(), locks: [], engines: entry.engines ?? null}).get(id);
      if (entry.integrity) p.integrity.add(entry.integrity);
      if (entry.resolved) p.resolved.add(entry.resolved);
      p.locks.push({lockfile: lockPath, entry: key, line: keyLine(lock.text, key, from), dev: Boolean(entry.dev), optional: Boolean(entry.optional)});
    }
  }
  for (const p of [...pkgs.values()].sort((a, b) => byString(a.id, b.id))) {
    const integrity = [...p.integrity].sort();
    drafts.push({entity: p.id, ref: p.locks[0].lockfile, attributes: {name: p.name, version: p.version, integrity: integrity.length === 1 ? integrity[0] : integrity, resolved: [...p.resolved].sort()[0] ?? null,
      locks: bounded(p.locks), ...(p.engines ? {engines: p.engines} : {})},
      ...(integrity.length > 1 ? {uncertainty: `${integrity.length} integrity digests are recorded for ${p.name}@${p.version} by different lockfiles`} : {})});
    for (const [lockfile, entries] of Object.entries(Object.groupBy(p.locks, l => l.lockfile))) {
      drafts.push({type: 'derived-from', from: p.id, to: fileId(lockfile), ref: lockfile, attributes: {basis: 'the lockfile records this installed version', entries: entries.map(e => e.entry), lines: entries.map(e => e.line)}});
    }
  }
  // The dependencies between installed packages, resolved in each lockfile's own tree.
  const deps = new Map(), unresolved = new Map();
  for (const [lockPath, lock] of [...locks].sort((a, b) => byString(a[0], b[0]))) {
    for (const [key, entry] of Object.entries(lock.json.packages ?? {})) {
      if (!key.includes('node_modules/') || entry?.link || typeof entry?.version !== 'string') continue;
      const from = npmPackageId(nameOfKey(key, entry), entry.version);
      for (const field of ['dependencies', 'optionalDependencies']) for (const [dep, range] of Object.entries(entry[field] ?? {})) {
        const hit = lockEntry(lock, dirOfKey(key), dep);
        if (!hit || hit.entry.link || typeof hit.entry.version !== 'string') { (unresolved.get(from) ?? unresolved.set(from, []).get(from)).push(`${dep}@${range} (${lockPath})`); continue; }
        const to = npmPackageId(nameOfKey(hit.key, hit.entry), hit.entry.version);
        if (to === from) continue;
        const k = `${from}\0${to}`, d = deps.get(k) ?? deps.set(k, {from, to, ranges: new Set(), lockfiles: new Set(), optional: field === 'optionalDependencies'}).get(k);
        d.ranges.add(String(range)); d.lockfiles.add(lockPath);
      }
    }
  }
  for (const d of [...deps.values()].sort((a, b) => byString(`${a.from}${a.to}`, `${b.from}${b.to}`))) {
    drafts.push({type: 'depends-on', from: d.from, to: d.to, ref: [...d.lockfiles].sort()[0], attributes: {basis: 'the lockfile entry lists this dependency', declared: [...d.ranges].sort(), lockfiles: [...d.lockfiles].sort(), optional: d.optional}});
  }
  for (const [id, list] of unresolved) {
    const at = drafts.find(x => x.entity === id);
    at.attributes.unresolved_dependencies = bounded(list.sort());
    at.missing_evidence = [`${list.length} dependency(ies) of the lockfile entry resolve to no installed entry of the same lockfile (an optional platform package, or an incomplete lockfile)`];
  }
  // Workspace packages.
  for (const ws of [...workspaces.values()].sort((a, b) => byString(a.name, b.name))) {
    const id = workspacePackageId(ws.name), exp = ws.json.exports;
    drafts.push({entity: id, ref: ws.file, attributes: {name: ws.name, version: ws.json.version ?? null, dir: ws.dir, workspace_pattern: ws.pattern, declared_in: 'package.json', line: ws.line,
      exports: exp ?? null, main: ws.json.main ?? null}});
    drafts.push({type: 'derived-from', from: id, to: fileId(ws.file), ref: ws.file, attributes: {basis: 'the workspace package\'s own package.json'}});
    const subs = exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some(k => k.startsWith('.')) ? Object.keys(exp).filter(k => !k.includes('*')) : ['.'];
    for (const sub of subs.sort()) {
      const m = workspaceModule(ws, sub, paths);
      if (m.file) drafts.push({type: 'depends-on', from: id, to: fileId(m.file), ref: ws.file, attributes: {basis: 'the package exports this module', export: sub, condition: m.condition, line: keyLine(manifests.get(ws.file).text, sub)}});
    }
  }
  // Declared dependencies: the package.json's range, and what the workspace root's lockfile resolved it to.
  const rootLock = locks.get(ROOT_LOCK) ?? null, ghosts = new Map();
  for (const [file, m] of [...manifests].sort((a, b) => byString(a[0], b[0]))) {
    const dir = path.posix.dirname(file), resolved = new Map();
    for (const field of DEP_FIELDS) for (const [name, range] of Object.entries(m.json[field] ?? {})) {
      const line = keyLine(m.text, name, keyLine(m.text, field) ?? 1);
      const ws = workspaces.get(name), hit = ws ? null : lockEntry(rootLock, dir === '.' ? '' : dir, name);
      const to = ws ? workspacePackageId(name) : hit && !hit.entry.link && typeof hit.entry.version === 'string' ? npmPackageId(nameOfKey(hit.key, hit.entry), hit.entry.version) : null;
      const row = {field, declared: String(range), line, resolved: to ? (ws ? {workspace: ws.dir} : {lockfile: ROOT_LOCK, entry: hit.key, version: hit.entry.version}) : null};
      const target = to ?? unresolvedPackageId(name);
      if (!to) (ghosts.get(target) ?? ghosts.set(target, {name, by: []}).get(target)).by.push(`${file}#${field}`);
      (resolved.get(target) ?? resolved.set(target, []).get(target)).push(row);
    }
    for (const [to, rows] of [...resolved].sort((a, b) => byString(a[0], b[0]))) {
      drafts.push({type: 'depends-on', from: fileId(file), to, ref: file, attributes: {basis: 'a declared dependency (its declared range, and the version the lockfile resolved)', declarations: rows}});
    }
  }
  for (const [id, g] of [...ghosts].sort((a, b) => byString(a[0], b[0]))) {
    drafts.push({entity: id, ref: g.by[0].split('#')[0], status: 'unresolved', attributes: {name: g.name, declared_by: bounded(g.by.sort())},
      missing_evidence: ['declared, but the workspace root\'s lockfile at this commit installs no entry Node would resolve for it']});
  }
  for (const b of broken) drafts.push({entity: fileId(b.path), ref: b.path, attributes: {package_manifest_unreadable: b.why}, missing_evidence: [`${b.path} is not JSON at this commit: its declarations are not read`]});
  return drafts;
}

/** The facts of the code's bare imports at `commit` (structural): packages, workspace modules, built-ins, gaps. */
export function importsFacts(repo, commit) {
  const {paths, locks, workspaces} = manifestsAt(repo, commit), code = codeAt(repo, commit), rootLock = locks.get(ROOT_LOCK) ?? null;
  const drafts = [], rows = [], ghosts = new Map(), builtins = new Map(), gaps = new Map();
  for (const f of code.files) {
    for (const im of f.imports) {
      const s = im.specifier;
      if (s === null || s.startsWith('.') || s.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue;
      const base = {from: f.path, specifier: s, line: im.line, need: f.need};
      if (s.startsWith('node:')) { const name = s.slice(5); builtins.set(name, true); rows.push({...base, to: builtinId(name), via: 'the Node runtime'}); continue; }
      const name = packageName(s), sub = s === name ? '.' : `./${s.slice(name.length + 1)}`, ws = workspaces.get(name);
      if (ws) {
        const m = workspaceModule(ws, sub, paths);
        if (m.file) { if (m.file !== f.path) rows.push({...base, to: fileId(m.file), via: `workspace ${name} exports "${sub}"${m.condition ? ` (${m.condition})` : ''}`}); continue; }
        (gaps.get(f.path) ?? gaps.set(f.path, []).get(f.path)).push({specifier: s, line: im.line, why: m.why}); continue;
      }
      const hit = lockEntry(rootLock, path.posix.dirname(f.path), name);
      if (hit?.entry.link) {
        const target = [...workspaces.values()].find(w => w.dir === hit.entry.resolved);
        const m = target ? workspaceModule(target, sub, paths) : {why: `the lockfile links ${name} to ${hit.entry.resolved}, which is not a workspace of the root package.json`};
        if (m.file) { if (m.file !== f.path) rows.push({...base, to: fileId(m.file), via: `${ROOT_LOCK}#${hit.key} links the workspace ${target.name}`}); }
        else (gaps.get(f.path) ?? gaps.set(f.path, []).get(f.path)).push({specifier: s, line: im.line, why: m.why});
        continue;
      }
      if (hit && typeof hit.entry.version === 'string') { rows.push({...base, to: npmPackageId(nameOfKey(hit.key, hit.entry), hit.entry.version), via: `${ROOT_LOCK}#${hit.key}`}); continue; }
      const ghost = unresolvedPackageId(name);
      (ghosts.get(ghost) ?? ghosts.set(ghost, {name, by: new Set()}).get(ghost)).by.add(f.path);
      rows.push({...base, to: ghost, via: null});
    }
    for (const g of f.gaps.filter(x => x.kind === 'import')) (gaps.get(f.path) ?? gaps.set(f.path, []).get(f.path)).push({specifier: null, line: g.line, why: g.why});
  }
  if (builtins.size) drafts.push({entity: runtimeId('node'), ref: 'the node: specifiers of the code', attributes: {name: 'node'}});
  for (const name of [...builtins.keys()].sort()) {
    drafts.push({entity: builtinId(name), ref: `node:${name}`, attributes: {name: `node:${name}`, runtime: 'node'}});
    drafts.push({type: 'depends-on', from: builtinId(name), to: runtimeId('node'), ref: `node:${name}`, attributes: {basis: 'a node: built-in module is part of the Node runtime'}});
  }
  for (const [id, g] of [...ghosts].sort((a, b) => byString(a[0], b[0]))) {
    drafts.push({entity: id, ref: [...g.by].sort()[0], status: 'unresolved', attributes: {name: g.name, imported_by: bounded([...g.by].sort())},
      missing_evidence: ['imported, but resolved neither through a workspace package nor through the workspace root\'s lockfile at this commit']});
  }
  for (const g of grouped(rows, r => `${r.from}\0${r.to}`, ['specifier', 'via', 'need'])) {
    drafts.push({type: 'depends-on', from: fileId(g.first.from), to: g.first.to, ref: g.first.from,
      attributes: {basis: g.via.length ? 'an import specifier, resolved' : 'an import specifier that resolves to nothing', specifiers: g.specifier, lines: g.lines, need: g.first.need, via: g.via[0] ?? null}});
  }
  for (const [file, list] of [...gaps].sort((a, b) => byString(a[0], b[0]))) {
    drafts.push({entity: fileId(file), ref: file, attributes: {import_gaps: bounded(list.map(x => ({specifier: x.specifier, line: x.line, why: x.why})), 16)},
      missing_evidence: [`${list.length} import(s) of this file are not resolved here (a computed specifier, or a workspace export the tree lacks)`]});
  }
  return drafts;
}

/** The adapter of the declared package manifests and lockfiles at the commit `ref` names now. */
export function packagesSource({repo, ref = 'HEAD', extractor = PACKAGES_EXTRACTOR} = {}) {
  return {id: PACKAGES_SOURCE, extractor, ref: 'package.json',
    authority: 'the committed package.json files and lockfiles',
    current: () => ({version: resolveCommit(repo, ref)}), readAt: version => packagesFacts(repo, version)};
}
/** The adapter of the code's bare imports at the commit `ref` names now. */
export function importsSource({repo, ref = 'HEAD', extractor = IMPORTS_EXTRACTOR} = {}) {
  return {id: IMPORTS_SOURCE, extractor, ref: 'git',
    authority: 'the committed code\'s imports, resolved through the workspace and the root lockfile',
    current: () => ({version: resolveCommit(repo, ref)}), readAt: version => importsFacts(repo, version)};
}
