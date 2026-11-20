// WHAT A REPOSITORY'S CODE NEEDS, at a commit, as a graph source (the dependency graph; docs/knowledge-graph/dependencies.md).
//
// Purpose   The systems graph's repository source states which file imports which file. This source states the rest of
//           what code depends on, read from the same commit with a real parser (parse.mjs): the packages it imports and
//           the versions the lockfile pins for them, whether a manifest declares them, the platform's own modules, the
//           environment variable NAMES it reads, the programs it runs, the files it reads and writes by path, and which
//           function calls which. The same reading serves this repository and a sibling repository under its own name.
// Inputs    A repository root, a commit, and the repository's name in the graph (`ophanim` for this one).
// Outputs   codeSource(); codeFacts() (the drafts); codeOrigin(names); sourceIdOf(name).
// Facts     systems/component npm:<name>     a package: where a local one lives and its entry file, or the versions and
//                                            integrity digests each lockfile pins; node:<name> a platform module;
//                                            program:<name> a program run by name
//           systems/interface env:<NAME>     an environment variable, by name
//           systems/symbol <path>#<name>     a top-level function, class or exported name of a file
//           depends-on   file -> package (an import; `undeclared` when no manifest at or above the file declares it),
//                        manifest -> package (a declared dependency), lockfile -> package (a pinned version),
//                        file -> platform module, file -> program, file -> file (an import this source resolves and the
//                        repository source cannot: through a local package's exports, or a TypeScript-style specifier;
//                        every relative import for a sibling repository), symbol -> symbol and symbol -> package (a call)
//           consumes     file -> environment variable; file -> file read by path
//           produces     file -> file written by path
// Invariants  Read from git's object store at the commit, never the working tree. A fact names the lines it was read
//           from. A path joined to a root the file computes becomes an edge only when exactly ONE tracked file fits, and
//           the edge says the anchor was assumed. What is seen and not resolved is listed or counted on the file or the
//           repository node, never dropped and never guessed. A file the parser rejects gives no facts and is named.
// Must never  Record a value of an environment variable, run or import the code it reads, open the network, resolve a
//           name by resemblance, or write a sibling's file under this repository's file ids.
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {resolveCommit} from '../extract/git.mjs';
import {parserVersion} from './parse.mjs';
import {readTree} from './read.mjs';
import {HOME, repositoryId, fileIdIn, symbolIdIn, packageId, envId} from './ids.mjs';

export const CODE_EXTRACTOR = 'ophanim.code.extractor';
/** The source id of the code dependencies of the repository named `name`. */
export const sourceIdOf = name => (name === HOME ? 'ophanim.code' : `sibling.${name}.code`);
/** The extractor's registration for the repositories named; `keys` (who may write as it) is the composer's. */
export const codeOrigin = (names = [HOME]) => Object.freeze({kind: 'extractor', basis: 'structural', sources: names.map(sourceIdOf)});

const KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const PACKAGE_NAME = /^(?:@[A-Za-z0-9~][\w.~-]*\/)?[A-Za-z0-9~][\w.~-]*$/;
const LIST = 64;
const bounded = (xs, n = LIST) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const dirOf = p => { const d = path.posix.dirname(p); return d === '.' ? '' : d; };
const join = (dir, p) => path.posix.normalize(dir ? `${dir}/${p}` : p);
const sorted = set => [...set].sort((a, b) => (typeof a === 'number' ? a - b : a < b ? -1 : a > b ? 1 : 0));
const ASSUMED = 'the path is joined to a root this file computes; it is taken as the one tracked file the path names from the repository root or a directory above the file';
const ALTERNATIVES = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

/** The facts of the code of `repo` at `commit`, as the extractor's drafts. */
export function codeFacts(repo, commit, {name = HOME} = {}) {
  const tree = readTree(repo, commit), {paths, text, readings} = tree;
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

  // ---- manifests and lockfiles ------------------------------------------------------------------------------------------
  const manifests = new Map(), locals = new Map(), locked = new Map(), badManifests = [];
  for (const p of [...text.keys()].sort()) {
    if (!/(^|\/)package(-lock)?\.json$/.test(p)) continue;
    let j;
    try { j = JSON.parse(text.get(p)); } catch (e) { badManifests.push({file: p, why: `not JSON: ${e.message}`.slice(0, 200)}); continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) { badManifests.push({file: p, why: 'not an object'}); continue; }
    if (p.endsWith('package-lock.json')) {
      for (const [at, v] of Object.entries(j.packages ?? {})) {
        // The root ('') and a workspace's own entry (a path with no node_modules/) are the project, not a pinned package.
        if (!at.includes('node_modules/') || v?.link) continue;
        const n = at.slice(at.lastIndexOf('node_modules/') + 'node_modules/'.length);
        let registry = null;
        try { registry = v.resolved ? new URL(v.resolved).hostname : null; } catch { /* a local path, not a registry */ }
        (locked.get(n) ?? locked.set(n, []).get(n)).push({version: v.version ?? null, integrity: v.integrity ?? null, registry, lockfile: p, at, dev: Boolean(v.dev)});
      }
      continue;
    }
    const declared = new Map();
    for (const kind of KINDS) for (const [dep, range] of Object.entries(j[kind] ?? {})) {
      if (declared.has(dep)) declared.get(dep).also_in.push(kind); else declared.set(dep, {kind, range: String(range), also_in: []});
    }
    const m = {path: p, dir: dirOf(p), name: typeof j.name === 'string' ? j.name : null, declared, exports: j.exports, main: j.main};
    manifests.set(m.dir, m);
    if (m.name && !locals.has(m.name)) locals.set(m.name, m);
  }
  /** The file a local package's specifier names through its `exports` (or `main`), or null when it names none here. */
  const entryOf = (m, sub) => {
    const pick = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.import ?? v.default ?? v.node ?? v.require) : null);
    let target = null;
    if (m.exports !== undefined) target = sub === '.' ? pick(typeof m.exports === 'string' || m.exports?.['.'] === undefined ? m.exports : m.exports['.']) : pick(m.exports?.[sub]);
    else target = sub === '.' ? (typeof m.main === 'string' ? m.main : 'index.js') : sub;
    if (typeof target !== 'string') return null;
    const p = join(m.dir, target);
    return paths.has(p) ? p : null;
  };
  const declarationFor = (file, pkg) => {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      const d = manifests.get(dir)?.declared.get(pkg);
      if (d) return {declared_in: manifests.get(dir).path, range: d.range, kind: d.kind};
      if (!dir) return null;
    }
  };
  const packageEntity = (pkg, ref) => {
    const local = locals.get(pkg), pins = (locked.get(pkg) ?? []).slice().sort((a, b) => (a.lockfile + a.at < b.lockfile + b.at ? -1 : 1));
    const entry = local ? entryOf(local, '.') : null;
    return entity(packageId('npm', pkg), ref, {ecosystem: 'npm', name: pkg,
      ...(local ? {local: local.dir, manifest: local.path, ...(entry ? {entry} : {})} : {}), ...(pins.length ? {locked: bounded(pins, 16)} : {})},
    local && !entry ? {missing_evidence: [`${local.path} names no entry file that is in the tree at this commit`]} : {});
  };

  // ---- how a specifier resolves ---------------------------------------------------------------------------------------------
  const resolveRelative = (from, spec) => {
    const exact = join(dirOf(from), spec.split(/[?#]/)[0]);
    if (paths.has(exact)) return {path: exact, exact: true};
    const stem = exact.replace(/\.(m|c)?js$/, '');
    for (const alt of ALTERNATIVES) for (const base of stem === exact ? [exact] : [stem, exact]) if (paths.has(base + alt)) return {path: base + alt, exact: false};
    return null;
  };
  const packageOf = spec => { const parts = spec.split('/'); const n = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]; return {pkg: n, sub: spec.length > n.length ? '.' + spec.slice(n.length) : '.'}; };
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
  const counts = {imports: 0, packages: 0, platform: 0, env: 0, programs: 0, reads: 0, writes: 0, calls: 0};
  const unresolved = {computed_programs: 0, computed_reads: 0, reads: 0, calls: 0};
  const envReaders = new Map();

  for (const file of tree.code) {
    const r = readings.get(file), e = tree.entries.get(file), dir = dirOf(file);
    if (!r.ok) { notParsed.push({file, why: r.why}); continue; }
    const node = entity(fid(file), file, {path: file, blob: e.blob, bytes: e.size, functions: r.functions.length});

    // Imports.
    for (const i of r.imports) {
      counts.imports++;
      if (i.specifier.startsWith('.')) {
        const t = resolveRelative(file, i.specifier);
        if (!t) { unresolvedImports.push({file, specifier: i.specifier, line: i.line}); continue; }
        if (t.path === file) continue;
        if (name !== HOME || !t.exact) {
          if (name !== HOME && !entities.has(fid(t.path))) entity(fid(t.path), t.path, {path: t.path, blob: tree.entries.get(t.path).blob, bytes: tree.entries.get(t.path).size});
          gathered('depends-on', fid(file), fid(t.path), file, {basis: 'import', ...(t.exact ? {} : {resolved_as: t.path})}, i.line, i.specifier);
        }
      } else if (isBuiltin(i.specifier)) {
        const mod = i.specifier.replace(/^node:/, '');
        entity(packageId('node', mod), file, {ecosystem: 'node', name: mod});
        gathered('depends-on', fid(file), packageId('node', mod), file, {basis: 'import'}, i.line, i.specifier); counts.platform++;
      } else {
        const {pkg, sub} = packageOf(i.specifier);
        if (!PACKAGE_NAME.test(pkg) || i.specifier.startsWith('/')) { unresolvedImports.push({file, specifier: i.specifier, line: i.line}); continue; }
        packageEntity(pkg, file); counts.packages++;
        const local = locals.get(pkg), declared = local ? null : declarationFor(file, pkg);
        if (local) {
          gathered('depends-on', fid(file), packageId('npm', pkg), file, {basis: 'import', local: local.dir}, i.line, i.specifier);
          const entry = entryOf(local, sub);
          if (entry && entry !== file) {
            if (name !== HOME && !entities.has(fid(entry))) entity(fid(entry), entry, {path: entry, blob: tree.entries.get(entry).blob, bytes: tree.entries.get(entry).size});
            gathered('depends-on', fid(file), fid(entry), file, {basis: 'import through the package\'s exports'}, i.line, i.specifier);
          }
        } else if (declared) gathered('depends-on', fid(file), packageId('npm', pkg), file, {basis: 'import', ...declared}, i.line, i.specifier);
        else {
          if (!undeclared.some(u => u.file === file && u.package === pkg)) undeclared.push({file, package: pkg});
          gathered('depends-on', fid(file), packageId('npm', pkg), file, {basis: 'import', undeclared: true}, i.line, i.specifier,
            {uncertainty: `no package.json at or above ${dir ? dir + '/' : 'the repository root'} declares ${pkg}`});
        }
      }
    }

    // The environment, by name.
    for (const v of r.env) {
      (envReaders.get(v.name) ?? envReaders.set(v.name, {first: file, files: new Set()}).get(v.name)).files.add(file);
      gathered('consumes', fid(file), envId(v.name), file, {basis: 'environment variable read'}, v.line); counts.env++;
    }

    // Programs run by name.
    for (const p of r.programs) {
      const base = p.name.includes('/') ? path.posix.basename(p.name) : p.name;
      if (!base) continue;
      entity(packageId('program', base), file, {ecosystem: 'program', name: base});
      const g = gathered('depends-on', fid(file), packageId('program', base), file, {basis: 'program run', ...(base === p.name ? {} : {as_written: p.name})}, p.line);
      (g.calls ??= new Set()).add(p.call); counts.programs++;
    }
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
      if (name !== HOME && !entities.has(fid(at.target))) entity(fid(at.target), at.target, {path: at.target, blob: tree.entries.get(at.target).blob, bytes: tree.entries.get(at.target).size});
      const g = gathered(type, fid(file), fid(at.target), file, {basis, as_written: p.path, anchor: at.anchor}, p.line, undefined, at.assumed ? {uncertainty: ASSUMED} : {});
      (g.calls ??= new Set()).add(p.call); counts[type === 'consumes' ? 'reads' : 'writes']++;
    }
    unresolved.computed_reads += r.unresolved.reads.length;
    if (missed.length) node.attributes.unresolved_reads = bounded(missed, 16);
    if (directories.length) node.attributes.directories_read = bounded(directories, 16);
    if (r.unresolved.reads.length) node.attributes.computed_reads = r.unresolved.reads.length;
    if (r.unresolved.programs.length) node.attributes.computed_programs = r.unresolved.programs.length;

    // Symbols: every top-level function and class, and every exported name.
    for (const f of r.functions) entity(sid(file, f.name), file, {module: file, name: f.name, kind: f.kind, line: f.line, exported: f.exported});
    for (const x of r.exports) if (x.kind !== 'reexport' && x.name !== '*') entity(sid(file, x.name), file, {module: file, name: x.name, kind: x.kind, line: x.line, exported: true});
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
        const {pkg, sub} = packageOf(c.specifier), local = locals.get(pkg);
        if (!local) {
          if (!entities.has(packageId('npm', pkg))) continue;      // an import this source could not name is already listed
          if (from === fid(file)) continue;                        // the file's import of the package already states this
          const g = edge('depends-on', from, packageId('npm', pkg), file, () => ({attributes: {basis, line: c.line}, imported: new Set()}));
          g.imported.add(c.imported); counts.calls++; continue;
        }
        const entry = entryOf(local, sub);
        def = entry ? definitionOf(entry, c.imported) : null; through = [c.specifier];
      }
      if (!def || !entities.has(sid(def.file, def.name))) { unresolved.calls++; continue; }
      const via = [...through, ...def.through];
      edge('depends-on', from, sid(def.file, def.name), file, () => ({attributes: {basis, line: c.line, ...(via.length ? {through: via} : {})}})); counts.calls++;
    }
  }

  // What manifests declare and lockfiles pin.
  for (const m of [...manifests.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!entities.has(fid(m.path))) entity(fid(m.path), m.path, {path: m.path, blob: tree.entries.get(m.path).blob, bytes: tree.entries.get(m.path).size});
    for (const [dep, d] of [...m.declared].sort()) {
      packageEntity(dep, m.path);
      edge('depends-on', fid(m.path), packageId('npm', dep), m.path, () => ({attributes: {basis: 'declared dependency', kind: d.kind, range: d.range, ...(d.also_in.length ? {also_in: d.also_in} : {})}}));
    }
  }
  for (const [pkg, pins] of [...locked].sort()) for (const lockfile of sorted(new Set(pins.map(p => p.lockfile)))) {
    packageEntity(pkg, lockfile);
    if (!entities.has(fid(lockfile))) entity(fid(lockfile), lockfile, {path: lockfile, blob: tree.entries.get(lockfile).blob, bytes: tree.entries.get(lockfile).size});
    edge('depends-on', fid(lockfile), packageId('npm', pkg), lockfile, () => ({attributes: {basis: 'lockfile entry', versions: sorted(new Set(pins.filter(p => p.lockfile === lockfile).map(p => p.version ?? 'unstated')))}}));
  }
  for (const [n, v] of [...envReaders].sort()) entity(envId(n), v.first, {name: n, read_by: v.files.size});

  const cmp = (a, b) => (a.file + '\0' + (a.package ?? a.specifier) < b.file + '\0' + (b.package ?? b.specifier) ? -1 : 1);
  const root = {entity: repositoryId(name), ref: 'git', attributes: {commit, parser: `typescript ${parserVersion()}`, platform: `node ${process.versions.node.split('.')[0]}`,
    files_read: tree.code.length, counts, unresolved, withheld: tree.withheld,
    ...(notParsed.length ? {not_parsed: bounded(notParsed, 32)} : {}), ...(undeclared.length ? {undeclared_imports: bounded(undeclared.sort(cmp))} : {}),
    ...(unresolvedImports.length ? {unresolved_imports: bounded(unresolvedImports.sort(cmp), 32)} : {}), ...(badManifests.length ? {bad_manifests: badManifests} : {})},
  ...(notParsed.length || unresolvedImports.length || badManifests.length ? {missing_evidence: [
    ...(notParsed.length ? [`${notParsed.length} file(s) the parser rejected give no facts`] : []),
    ...(unresolvedImports.length ? [`${unresolvedImports.length} import(s) name nothing this source can resolve`] : []),
    ...(badManifests.length ? [`${badManifests.length} manifest(s) could not be read`] : [])]} : {})};

  // Finish the gathered edges: sets become sorted lists, in a fixed attribute order.
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
    authority: `the code of the ${name} repository in its git object store, at a commit, as the parser reads it (typescript ${parserVersion()})`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => codeFacts(repo, version, {name}),
  };
}
