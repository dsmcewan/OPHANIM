// CALLS BETWEEN FUNCTIONS, and for a sibling repository everything its code needs, at a commit, as opt-in graph sources.
//
// Purpose   Slice B2 (ophanim/graph/extract/) states what THIS repository's code needs: packages, built-ins, environment
//           variables, programs, hosts, files read by path. Two things it does not state are stated here, opt-in:
//           (1) for this repository, WHICH FUNCTION CALLS WHICH: a function depends on the function it calls, in its
//               file, in another file, through a re-export or a workspace package, and on the package it calls into;
//           (2) for a SIBLING repository (TELOS, ARGO, LEXI), read from a checkout at a commit and never executed, the
//               whole of it -- imports, packages and what its lockfile resolves, built-ins, environment variable NAMES,
//               programs, files read and written by path, and the calls -- in B2's types and id forms, under the
//               sibling's own file ids, so nothing of a sibling is confused with this repository.
//           Nothing here states for this repository a fact B2's sources hold.
// Inputs    A repository root, a commit, and the repository's name in the graph (`ophanim` for this one). The code is
//           read with a real parser (parse.mjs; Python by python.mjs), the manifests with B2's reader (packages.mjs).
// Outputs   codeSource(); codeFacts() (the drafts); codeOrigin(names); sourceIdOf(name).
// Facts     for every repository
//             systems/symbol <path>#<name>   a top-level function, class or exported name of a file
//             depends-on   function -> function (a call); file -> function (a call outside any top-level function);
//                          function -> package (a call into a package, resolved as B2 resolves the import)
//           for a sibling only
//             systems/package, environment-variable, executable   as B2 names them (ids.mjs)
//             depends-on   file -> file (a relative import; an import through a workspace package's exports), file ->
//                          package (resolved through the nearest lockfile, else unresolved; `undeclared` when no manifest
//                          at or above the file declares it), manifest -> package (a declared dependency), file ->
//                          built-in, file -> Python module, file -> program
//             derived-from package -> the lockfile that resolves it
//             consumes     file -> environment variable; file -> file read by path
//             produces     file -> file written by path; file -> each symbol it defines
// Invariants  Read from git's object store at the commit, never the working tree. A fact names the lines it was read
//           from and, for a sibling, whether the file is a test or run-time (B2's `need`). A path joined to a root the
//           file computes becomes an edge only when exactly ONE tracked file fits, and the edge says the anchor was
//           assumed. What is seen and not resolved is listed or counted, never dropped and never guessed.
// Must never  Record a value of an environment variable, run or import the code it reads, open the network, resolve a
//           name by resemblance, write a sibling's file under this repository's file ids, or restate for this
//           repository what B2's sources state.
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {resolveCommit} from '../extract/git.mjs';
import {manifestsAt, lockEntry, exportTarget, ROOT_LOCK} from '../extract/packages.mjs';
import {needOf} from '../extract/code.mjs';
import {parserVersion} from './parse.mjs';
import {readTree, isPython} from './read.mjs';
import {HOME, repositoryId, fileIdIn, symbolIdIn, npmPackageId, unresolvedPackageId, builtinId, pythonModuleId, envId, executableId} from './ids.mjs';

export const CODE_EXTRACTOR = 'ophanim.calls.extractor';
/** The source id: this repository's calls, or a sibling's code. */
export const sourceIdOf = name => (name === HOME ? 'ophanim.calls' : `sibling.${name}.code`);
/** The extractor's registration for the repositories named; `keys` (who may write as it) is the composer's. */
export const codeOrigin = (names = [HOME]) => Object.freeze({kind: 'extractor', basis: 'structural', sources: names.map(sourceIdOf)});

const KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const PACKAGE_NAME = /^(?:@[A-Za-z0-9~][\w.~-]*\/)?[A-Za-z0-9~][\w.~-]*$/;
const bounded = (xs, n = 64) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const dirOf = p => { const d = path.posix.dirname(p); return d === '.' ? '' : d; };
const join = (dir, p) => path.posix.normalize(dir ? `${dir}/${p}` : p);
const sorted = set => [...set].sort((a, b) => (typeof a === 'number' ? a - b : a < b ? -1 : a > b ? 1 : 0));
const ASSUMED = 'the path is joined to a root this file computes; it is taken as the one tracked file the path names from the repository root or a directory above the file';
const ALTERNATIVES = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const NOTE = 'a module by its import name: the import does not say whether it is the standard library or an installed distribution';

/** The facts of the code of `repo` at `commit`, as the extractor's drafts. */
export function codeFacts(repo, commit, {name = HOME} = {}) {
  const tree = readTree(repo, commit), {paths, readings} = tree, home = name === HOME;
  const {manifests, locks, workspaces, broken} = manifestsAt(repo, commit);
  const fid = p => fileIdIn(name, p), sid = (p, n) => symbolIdIn(name, p, n);
  const entities = new Map(), edges = new Map();
  const entity = (id, ref, attributes, extra = {}) => { if (!entities.has(id)) entities.set(id, {entity: id, ref, attributes, ...extra}); return entities.get(id); };
  const edge = (type, from, to, ref, make) => { const k = `${type}\0${from}\0${to}`; if (!edges.has(k)) edges.set(k, {type, from, to, ref, ...make()}); return edges.get(k); };
  /** An edge whose specifiers and lines accumulate over the file's statements. */
  const gathered = (type, from, to, ref, attributes, line, specifier, extra = {}) => {
    const e = edge(type, from, to, ref, () => ({attributes: {...attributes}, ...extra, lines: new Set(), specifiers: new Set()}));
    e.lines.add(line); if (specifier !== undefined) e.specifiers.add(specifier);
    return e;
  };
  const fileNode = p => entity(fid(p), p, {path: p, blob: tree.entries.get(p).blob, bytes: tree.entries.get(p).size});

  // ---- how a specifier resolves ---------------------------------------------------------------------------------------------
  /** The lockfile Node would read for `file`: this repository's is the workspace root's (as B2); a sibling's the nearest above the file. */
  const lockFor = file => {
    if (home) return locks.has(ROOT_LOCK) ? {path: ROOT_LOCK, dir: '', lock: locks.get(ROOT_LOCK)} : null;
    for (let d = dirOf(file); ; d = dirOf(d)) { const p = join(d, 'package-lock.json'); if (locks.has(p)) return {path: p, dir: d, lock: locks.get(p)}; if (!d) return null; }
  };
  const within = (dir, base) => (base ? dir.slice(base.length + 1) : dir);
  /** The module a workspace package's specifier names (B2's exportTarget), or null. */
  const workspaceFile = (ws, sub) => {
    const e = exportTarget(ws.json.exports, sub) ?? (ws.json.exports === undefined ? {target: sub === '.' ? (typeof ws.json.main === 'string' ? ws.json.main : 'index.js') : sub} : null);
    const p = e ? join(ws.dir, e.target) : null;
    return p && paths.has(p) ? p : null;
  };
  /** What a package name imported from `file` is: {workspace}, {id, version, entry, lockfile} or {id, unresolved}. */
  const packageOf = (file, pkg) => {
    const ws = workspaces.get(pkg);
    if (ws) return {workspace: ws};
    const at = lockFor(file), hit = at ? lockEntry(at.lock, within(dirOf(file), at.dir), pkg) : null;
    if (hit?.entry.link) { const linked = [...workspaces.values()].find(w => w.dir === join(at.dir, hit.entry.resolved)); return linked ? {workspace: linked} : {id: unresolvedPackageId(pkg), unresolved: true}; }
    if (hit && typeof hit.entry.version === 'string') return {id: npmPackageId(hit.entry.name ?? pkg, hit.entry.version), version: hit.entry.version, entry: hit.key, lockfile: at.path, integrity: hit.entry.integrity ?? null};
    return {id: unresolvedPackageId(pkg), unresolved: true};
  };
  const packageEntity = (pkg, p, ref) => (p.unresolved
    ? entity(p.id, ref, {name: pkg}, {status: 'unresolved', missing_evidence: ['imported or declared, but no lockfile at or above it resolves an installed entry for it at this commit']})
    : entity(p.id, ref, {name: pkg, version: p.version, ...(p.integrity ? {integrity: [p.integrity]} : {}), locks: [{lockfile: p.lockfile, entry: p.entry}]}));
  const declarationFor = (file, pkg) => {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      const m = manifests.get(join(dir, 'package.json'));
      for (const kind of m ? KINDS : []) if (Object.hasOwn(m.json?.[kind] ?? {}, pkg)) return {declared_in: join(dir, 'package.json'), range: String(m.json[kind][pkg]), kind};
      if (!dir) return null;
    }
  };
  const resolveRelative = (from, spec) => {
    const exact = join(dirOf(from), spec.split(/[?#]/)[0]);
    if (paths.has(exact)) return {path: exact, exact: true};
    const stem = exact.replace(/\.(m|c)?js$/, '');
    for (const alt of ALTERNATIVES) for (const base of stem === exact ? [exact] : [stem, exact]) if (paths.has(base + alt)) return {path: base + alt, exact: false};
    return null;
  };
  const packageName = spec => { const parts = spec.split('/'); const n = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]; return {pkg: n, sub: spec.length > n.length ? '.' + spec.slice(n.length) : '.'}; };
  /** Where an imported name is really defined: {file, name, through} following aliases and re-exports, or null. */
  const definitionOf = (file, imported, through = [], depth = 0) => {
    const r = readings.get(file);
    if (!r?.ok || depth > 6) return null;
    const follow = e => { const t = resolveRelative(file, e.specifier); return t ? definitionOf(t.path, e.imported === '*' ? imported : e.imported, [...through, file], depth + 1) : null; };
    const e = r.exports.find(x => x.name === imported);
    if (e?.kind === 'reexport') return follow(e);
    if (e?.kind === 'alias') return {file, name: r.functions.some(f => f.name === e.local) ? e.local : e.name, through};
    if (e) return {file, name: imported === 'default' ? (r.functions.find(f => f.line === e.line)?.name ?? 'default') : imported, through};
    for (const star of r.exports.filter(x => x.name === '*' && x.imported === '*')) { const d = follow(star); if (d) return d; }
    return null;
  };

  const undeclared = [], unresolvedImports = [], notParsed = [];
  const counts = {calls: 0, ...(home ? {} : {imports: 0, packages: 0, platform: 0, env: 0, programs: 0, reads: 0, writes: 0})};
  const unresolved = {calls: 0, ...(home ? {} : {computed_programs: 0, computed_reads: 0, reads: 0})};
  const envReaders = new Map();

  /**
   * A Python import of a sibling. A relative one (leading dots) is exact: the module beside the file, level by level.
   * An absolute one is a module of the repository only when exactly ONE directory (the root, or one above the file)
   * holds it; otherwise it is a module by its import name.
   */
  const moduleAt = (anchor, mod) => [join(anchor, `${mod}.py`), join(anchor, `${mod}/__init__.py`)].find(p => paths.has(p)) ?? null;
  function pythonImport(file, i, need) {
    const written = '.'.repeat(i.level ?? 0) + i.specifier, mod = i.specifier.split('.').filter(Boolean).join('/');
    const link = (target, extra = {}) => { if (target !== file) gathered('depends-on', fid(file), fid(target), file, {basis: 'import', need, ...extra}, i.line, written); };
    const under = (anchor, extra) => {
      const hits = [...(mod ? [moduleAt(anchor, mod)] : []), ...i.names.map(n => moduleAt(anchor, mod ? `${mod}/${n}` : n))].filter(Boolean);
      for (const h of hits) link(h, extra);
      return hits.length > 0;
    };
    if (i.level > 0) {
      let base = dirOf(file), outside = false;
      for (let up = 1; up < i.level; up++) { if (!base) outside = true; base = dirOf(base); }
      if (outside || !under(base, {})) unresolvedImports.push({file, specifier: written, line: i.line});
      return;
    }
    const anchors = ['', ...(() => { const out = []; for (let d = dirOf(file); d; d = dirOf(d)) out.push(d); return out; })()].filter(a => moduleAt(a, mod));
    if (anchors.length === 1) { under(anchors[0], anchors[0] ? {anchor: `a directory above the file (${anchors[0]}/)`} : {anchor: 'the repository root'}); return; }
    if (anchors.length > 1) { unresolvedImports.push({file, specifier: written, line: i.line, why: 'more than one directory holds a module of this name'}); return; }
    const top = i.specifier.split('.')[0];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) { unresolvedImports.push({file, specifier: written, line: i.line}); return; }
    entity(pythonModuleId(top), file, {name: top, ecosystem: 'python', note: NOTE});
    gathered('depends-on', fid(file), pythonModuleId(top), file, {basis: 'import', need}, i.line, written); counts.platform++;
  }

  for (const file of tree.code) {
    const r = readings.get(file), e = tree.entries.get(file), dir = dirOf(file), need = needOf(file);
    if (!r.ok) { notParsed.push({file, why: r.why}); continue; }
    // A sibling's file may already be a node, made when an earlier file imported it: its own reading completes it here.
    // For this repository the file's node is the repository source's; this source adds only what its reading could not resolve.
    const node = home ? null : entity(fid(file), file, {});
    if (node) Object.assign(node.attributes, {path: file, blob: e.blob, bytes: e.size, content_sha256: tree.digests.get(file), need, functions: r.functions.length});

    // Everything a sibling's file needs. (For this repository B2's sources state all of it.)
    for (const i of home ? [] : r.imports) {
      counts.imports++;
      if (isPython(file)) { pythonImport(file, i, need); continue; }
      if (i.specifier.startsWith('.')) {
        const t = resolveRelative(file, i.specifier);
        if (!t) { unresolvedImports.push({file, specifier: i.specifier, line: i.line}); continue; }
        if (t.path === file) continue;
        fileNode(t.path);
        gathered('depends-on', fid(file), fid(t.path), file, {basis: 'import', need, ...(t.exact ? {} : {resolved_as: t.path})}, i.line, i.specifier);
      } else if (isBuiltin(i.specifier)) {
        const mod = i.specifier.replace(/^node:/, '');
        entity(builtinId(mod), file, {name: `node:${mod}`, runtime: 'node'});
        gathered('depends-on', fid(file), builtinId(mod), file, {basis: 'import', need}, i.line, i.specifier); counts.platform++;
      } else {
        const {pkg, sub} = packageName(i.specifier);
        if (!PACKAGE_NAME.test(pkg) || i.specifier.startsWith('/')) { unresolvedImports.push({file, specifier: i.specifier, line: i.line}); continue; }
        const p = packageOf(file, pkg); counts.packages++;
        if (p.workspace) {
          const entry = workspaceFile(p.workspace, sub);
          if (!entry) { unresolvedImports.push({file, specifier: i.specifier, line: i.line, why: `the workspace package ${pkg} exports no module for it that is in the tree`}); continue; }
          if (entry !== file) { fileNode(entry); gathered('depends-on', fid(file), fid(entry), file, {basis: 'import through the workspace package\'s exports', need, workspace: p.workspace.dir}, i.line, i.specifier); }
          continue;
        }
        packageEntity(pkg, p, file);
        const declared = declarationFor(file, pkg);
        if (!declared && !undeclared.some(u => u.file === file && u.package === pkg)) undeclared.push({file, package: pkg});
        gathered('depends-on', fid(file), p.id, file, {basis: 'import', need, ...(declared ?? {undeclared: true})}, i.line, i.specifier,
          declared ? {} : {uncertainty: `no package.json at or above ${dir ? dir + '/' : 'the repository root'} declares ${pkg}`});
      }
    }
    for (const v of home ? [] : r.env) {
      (envReaders.get(v.name) ?? envReaders.set(v.name, {first: file, files: new Set()}).get(v.name)).files.add(file);
      gathered('consumes', fid(file), envId(v.name), file, {basis: 'environment variable read', need}, v.line); counts.env++;
    }
    for (const p of home ? [] : r.programs) {
      const base = p.name.includes('/') ? path.posix.basename(p.name) : p.name;
      if (!base) continue;
      entity(executableId(base), file, {name: base});
      const g = gathered('depends-on', fid(file), executableId(base), file, {basis: 'program run', need, ...(base === p.name ? {} : {as_written: p.name})}, p.line);
      (g.calls ??= new Set()).add(p.call); counts.programs++;
    }
    if (!home) {
      unresolved.computed_programs += r.unresolved.programs.length;
      // Files read and written by path.
      const missed = [], directories = [];
      const place = p => {
        if (p.relative) { const t = join(dir, p.path); return paths.has(t) ? {target: t, anchor: 'the file\'s own directory'} : {why: 'no tracked file fits', at: t}; }
        if (p.path.startsWith('/')) return {why: 'an absolute path'};
        const fits = new Map();
        if (paths.has(path.posix.normalize(p.path))) fits.set(path.posix.normalize(p.path), 'the repository root');
        for (let d = dir; d; d = dirOf(d)) { const t = join(d, p.path); if (paths.has(t) && !fits.has(t)) fits.set(t, d === dir ? 'the file\'s own directory' : `a directory above the file (${d}/)`); }
        if (fits.size === 1) { const [[target, anchor]] = fits; return {target, anchor, assumed: true}; }
        return fits.size ? {why: 'more than one tracked file fits', candidates: sorted(fits.keys())} : {why: 'no tracked file fits', at: path.posix.normalize(p.path)};
      };
      for (const [list, type, basis] of [[r.reads, 'consumes', 'file read by path'], [r.writes, 'produces', 'file written by path']]) for (const p of list) {
        const at = place(p);
        if (!at.target) {
          const under = at.at && [...paths].some(x => x.startsWith(at.at.replace(/\/$/, '') + '/'));
          if (under) directories.push({as_written: p.path, line: p.line});
          else if (type === 'consumes') { missed.push({as_written: p.path, line: p.line, why: at.why, ...(at.candidates ? {candidates: at.candidates} : {})}); unresolved.reads++; }
          continue;
        }
        if (at.target === file) continue;
        fileNode(at.target);
        const g = gathered(type, fid(file), fid(at.target), file, {basis, need, as_written: p.path, anchor: at.anchor}, p.line, undefined, at.assumed ? {uncertainty: ASSUMED} : {});
        (g.calls ??= new Set()).add(p.call); counts[type === 'consumes' ? 'reads' : 'writes']++;
      }
      unresolved.computed_reads += r.unresolved.reads.length;
      if (missed.length) node.attributes.unresolved_reads = bounded(missed, 16);
      if (directories.length) node.attributes.directories_read = bounded(directories, 16);
      if (r.unresolved.reads.length) node.attributes.computed_reads = r.unresolved.reads.length;
      if (r.unresolved.programs.length) node.attributes.computed_programs = r.unresolved.programs.length;
    }

    // Symbols: every top-level function and class, and every exported name.
    const symbols = new Set();
    for (const f of r.functions) { symbols.add(f.name); entity(sid(file, f.name), file, {module: file, name: f.name, kind: f.kind, line: f.line, exported: f.exported}); }
    for (const x of r.exports) if (x.kind !== 'reexport' && x.name !== '*') { symbols.add(x.name); entity(sid(file, x.name), file, {module: file, name: x.name, kind: x.kind, line: x.line, exported: true}); }
    // For this repository the repository source states which file defines a symbol; for a sibling nothing else does.
    if (!home) for (const n of symbols) edge('produces', fid(file), sid(file, n), file, () => ({attributes: {basis: 'the file defines it'}}));
  }

  // Calls, once every file's symbols are known.
  for (const file of tree.code) {
    const r = readings.get(file);
    if (!r.ok) continue;
    for (const [from, calls] of [[fid(file), r.module_calls], ...r.functions.map(f => [sid(file, f.name), f.calls])]) for (const c of calls) {
      const basis = from === fid(file) ? 'call outside any top-level function' : 'call';
      if (c.local) { edge('depends-on', from, sid(file, c.local), file, () => ({attributes: {basis, line: c.line}})); counts.calls++; continue; }
      let def = null, through = [];
      if (c.specifier.startsWith('.')) { const t = resolveRelative(file, c.specifier); def = t ? definitionOf(t.path, c.imported) : null; }
      else {
        const {pkg, sub} = packageName(c.specifier);
        if (!PACKAGE_NAME.test(pkg)) continue;                     // not a package: the import is listed as unresolved
        const p = packageOf(file, pkg);
        if (!p.workspace) {
          if (from === fid(file)) continue;                        // the file's import of the package already states this
          if (!home) packageEntity(pkg, p, file);                  // (this repository's package nodes are B2's)
          const g = edge('depends-on', from, p.id, file, () => ({attributes: {basis, line: c.line}, imported: new Set()}));
          g.imported.add(c.imported); counts.calls++; continue;
        }
        const entry = workspaceFile(p.workspace, sub);
        def = entry ? definitionOf(entry, c.imported) : null; through = [c.specifier];
      }
      if (!def || !entities.has(sid(def.file, def.name))) { unresolved.calls++; continue; }
      const via = [...through, ...def.through];
      edge('depends-on', from, sid(def.file, def.name), file, () => ({attributes: {basis, line: c.line, ...(via.length ? {through: via} : {})}})); counts.calls++;
    }
  }

  if (!home) {
    // What a sibling's manifests declare and its lockfiles resolve.
    for (const [file, m] of [...manifests].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      fileNode(file);
      const declared = new Map();
      for (const kind of KINDS) for (const [dep, range] of Object.entries(m.json?.[kind] ?? {})) if (!declared.has(dep)) declared.set(dep, {kind, range: String(range)});
      for (const [dep, d] of [...declared].sort()) {
        const p = packageOf(join(dirOf(file), 'x'), dep);
        if (p.workspace) { const entry = workspaceFile(p.workspace, '.'); if (entry) { fileNode(entry); edge('depends-on', fid(file), fid(entry), file, () => ({attributes: {basis: 'declared dependency on a workspace package', kind: d.kind, range: d.range, workspace: p.workspace.dir}})); } continue; }
        packageEntity(dep, p, file);
        edge('depends-on', fid(file), p.id, file, () => ({attributes: {basis: 'declared dependency', kind: d.kind, range: d.range}}));
      }
    }
    for (const [lockPath, lock] of [...locks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      fileNode(lockPath);
      for (const [key, v] of Object.entries(lock.json?.packages ?? {})) {
        // The root ('') and a workspace's own entry (a path with no node_modules/) are the project, not a resolved package.
        if (!key.includes('node_modules/') || !v || v.link || typeof v.version !== 'string') continue;
        const pkg = v.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), id = npmPackageId(pkg, v.version);
        const node = entity(id, lockPath, {name: pkg, version: v.version, ...(v.integrity ? {integrity: [v.integrity]} : {}), locks: []});
        if (!node.attributes.locks.some(l => l.lockfile === lockPath && l.entry === key) && node.attributes.locks.length < 8) node.attributes.locks.push({lockfile: lockPath, entry: key});
        edge('derived-from', id, fid(lockPath), lockPath, () => ({attributes: {basis: 'the lockfile resolves it', ...(v.dev ? {dev: true} : {})}}));
      }
    }
    for (const [n, v] of [...envReaders].sort()) entity(envId(n), v.first, {name: n});
  }

  const cmp = (a, b) => (a.file + '\0' + (a.package ?? a.specifier) < b.file + '\0' + (b.package ?? b.specifier) ? -1 : 1);
  const gaps = [...(notParsed.length ? [`${notParsed.length} file(s) the parser rejected give no facts`] : []),
    ...(unresolvedImports.length ? [`${unresolvedImports.length} import(s) name nothing this source can resolve`] : []),
    ...(!home && broken.length ? [`${broken.length} manifest(s) could not be read`] : [])];
  const root = {entity: repositoryId(name), ref: 'git', attributes: {[home ? 'calls_read_at' : 'read_at']: commit, parser: `typescript ${parserVersion()}`,
    readers: `typescript ${parserVersion()} for JavaScript and TypeScript; a line-and-token reader for Python (no calls)`,
    files_read: tree.code.length, counts, unresolved, ...(home ? {} : {withheld: tree.withheld}),
    ...(notParsed.length ? {not_parsed: bounded(notParsed, 32)} : {}), ...(undeclared.length ? {undeclared_imports: bounded(undeclared.sort(cmp))} : {}),
    ...(unresolvedImports.length ? {unresolved_imports: bounded(unresolvedImports.sort(cmp), 32)} : {}), ...(!home && broken.length ? {bad_manifests: broken.map(b => ({file: b.path, why: b.why}))} : {})},
  ...(gaps.length ? {missing_evidence: gaps} : {})};

  // Finish the gathered edges: sets become sorted lists.
  const finish = e => {
    const {lines, specifiers, calls, imported, attributes, ...rest} = e, a = {...attributes};
    if (specifiers?.size) a.specifiers = sorted(specifiers);
    if (calls?.size) a.calls = sorted(calls);
    if (lines?.size) a.lines = sorted(lines);
    if (imported?.size) a.imported = sorted(imported);
    return {...rest, attributes: a};
  };
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [root, ...[...entities.values()].sort((a, b) => byId(a.entity, b.entity)),
    ...[...edges.values()].map(finish).sort((a, b) => byId(`${a.type}\0${a.from}\0${a.to}`, `${b.type}\0${b.from}\0${b.to}`))];
}

/**
 * The adapter. `repo`: the repository root; `ref`: what current() resolves ('HEAD' follows the checkout; a commit id pins
 * it); `name`: the repository's name in the graph. readAt(commit) reads that commit's objects, never the working tree.
 */
export function codeSource({repo, ref = 'HEAD', name = HOME, extractor = CODE_EXTRACTOR} = {}) {
  return {
    id: sourceIdOf(name), extractor, ref: 'git',
    authority: name === HOME ? `the calls between the functions of this repository's code at a commit, as the parser reads it (typescript ${parserVersion()})`
      : `the code of the ${name} repository in its git object store, at a commit, as the parser reads it (typescript ${parserVersion()})`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => codeFacts(repo, version, {name}),
  };
}
