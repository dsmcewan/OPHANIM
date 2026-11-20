// THE REPOSITORY AT A COMMIT as a graph source (Slice B, KB1; docs/knowledge-graph/slice-b.md "The extractors").
//
// Purpose   Graph B's structure of OPHANIM itself: files, code modules, tests, exported symbols, imports, contracts
//           (schema ids a module defines), tickets, and the commits that changed each file -- projected by a registered
//           extractor with a STRUCTURAL basis (parsed from the code's structure) from the repository AT A COMMIT, read
//           from git's object store (git.mjs). Never the working tree: the version is the commit id, and a replay that
//           asks for that commit re-derives the same facts.
// Inputs    The repository root and the commit to project (current(): the commit `ref` names now; readAt(commit)).
// Outputs   repoSource(): the adapter packages/graph's projection calls; repoFacts(): the drafts of one commit.
// Facts     systems/repository/<name>               the commit, the counts, the withheld paths (counted, never read)
//           systems/module/<path>                    a code file that is not a test: its blob, size, exports
//           systems/test/<path>                      a test file (*.test.mjs, .js, .cjs): its blob and test-case names
//           systems/file/<path>                      any other file (data, configuration, documents)
//           systems/symbol/<path>#<name>             an exported name; the module `produces` it
//           systems/contract/<schema id>             a schema id an exported constant carries ('scope.name/vN');
//                                                    the symbol `implements` it
//           systems/change/<commit>                  a commit of the ancestry; each file it changed is `derived-from` it
//           work/ticket/<item>, work/item/<item>     a ticket (tickets/*.json, ophanim.ticket/v1): it `depends-on` the
//                                                    item it names; the slot path `implements` it; it `consumes` its copy
//                                                    paths; it is `derived-from` its file
//           depends-on   a file that imports another (a relative specifier resolved in the commit's tree; the regex is
//                        ophanim/ledger/layering.test.mjs's, kept equal to it by extract.test.mjs)
//           consumes     a file that imports a named export of another
//           An import that does not resolve, and a ticket path that is not in the tree, are listed on their node as
//           unresolved (never an edge to nothing).
// Must never  Read the working tree; read a withheld path; record a textual resemblance as a dependency.
import path from 'node:path';
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, historyAt, resolveCommit, WITHHELD} from './git.mjs';

export const SOURCE_ID = 'ophanim.repo';
export const EXTRACTOR = 'ophanim.repo.extractor';
/** The extractor's registration; `keys` (who may write as it) is the composer's, an owner decision for production. */
export const REPO_ORIGIN = Object.freeze({kind: 'extractor', basis: 'structural', sources: [SOURCE_ID]});

// THE IMPORT-SPECIFIER REGEX of ophanim/ledger/layering.test.mjs (its `SPEC`), reused as the brief directs: every module
// specifier a file imports, statically or dynamically. extract.test.mjs reads the layering test as text and keeps the two
// equal. It also matches the word "from" before a quote in ordinary code; only a relative specifier that resolves to a
// file of the commit's tree becomes an edge, and the rest is listed as unresolved.
export const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
// Named imports and re-exports, for `consumes` of a symbol: `import {a, b as c} from './x.mjs'`, `export {a} from ...`,
// and a default import `import x from './x.mjs'`.
const NAMED = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
const DEFAULT_IMPORT = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*(['"])([^'"]+)\2/g;
const EXPORT_DECL = /^export\s+(?:async\s+)?(function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}/gm;
const EXPORT_DEFAULT = /^export\s+default\b/m;
const SCHEMA_CONST = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*'([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\/v\d+)'/gm;
const TEST_CASE = /\b(?:test|it|describe)\(\s*(['"`])((?:(?!\1)[^\\\n]|\\.){1,200})\1/g;

const CODE = /\.(mjs|js|cjs|ts|mts|py|sh)$/, JS = /\.(mjs|js|cjs)$/;
export const isTest = p => /\.test\.(mjs|js|cjs)$/.test(p);
export const typeOf = p => (isTest(p) ? 'test' : CODE.test(p) ? 'module' : 'file');
/** The graph id of a repository path at the type the extractor gives it. */
export const fileId = p => entityId({domain: 'systems', type: typeOf(p), key: p});
export const changeId = commit => entityId({domain: 'systems', type: 'change', key: commit});
export const symbolId = (p, name) => entityId({domain: 'systems', type: 'symbol', key: `${p}#${name}`});
export const contractId = schema => entityId({domain: 'systems', type: 'contract', key: schema});
export const ticketId = item => entityId({domain: 'work', type: 'ticket', key: item});
export const itemId = item => entityId({domain: 'work', type: 'item', key: item});
const LIST = 64;
const bounded = (xs, n = LIST) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const namesIn = list => list.split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const m = /^(?:type\s+)?([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/.exec(s);
  return m ? {imported: m[1], local: m[2] ?? m[1]} : null;
}).filter(Boolean);

/**
 * The facts of the repository at `commit`, as the extractor's drafts. `name` names the repository node. Reads git's
 * object store only: the tree, the blobs of code and ticket files, and the ancestry.
 */
export function repoFacts(repo, commit, {name = 'ophanim'} = {}) {
  const tree = treeAt(repo, commit), paths = new Set(tree.entries.map(e => e.path));
  const code = tree.entries.filter(e => JS.test(e.path) && e.mode !== '120000');
  const tickets = tree.entries.filter(e => /^tickets\/[^/]+\.json$/.test(e.path));
  const bytes = blobsAt(repo, [...code, ...tickets].map(e => e.blob));
  const text = new Map([...code, ...tickets].map(e => [e.path, bytes.get(e.blob).toString('utf8')]));
  // A fact's ref names WHERE in the source it is, never the version: the version is the observation's (source.version),
  // so a fact the next commit leaves alone is the same fact (a ref with the commit in it changed every fact every commit).
  const drafts = [], ref = p => p;
  const exportsOf = new Map(), unresolved = new Map(), cases = new Map();

  // Exports and contracts first: an import resolves to the symbols the target exports.
  const contracts = new Map();
  for (const e of code) {
    const t = text.get(e.path), names = new Map();
    for (const m of t.matchAll(EXPORT_DECL)) names.set(m[2], m[1].replace('*', ''));
    for (const m of t.matchAll(EXPORT_LIST)) for (const n of namesIn(m[1])) names.set(n.local, 'reexport');
    if (EXPORT_DEFAULT.test(t)) names.set('default', 'default');
    exportsOf.set(e.path, names);
    for (const m of t.matchAll(SCHEMA_CONST)) (contracts.get(m[2]) ?? contracts.set(m[2], []).get(m[2])).push({path: e.path, name: m[1]});
    if (isTest(e.path)) cases.set(e.path, [...new Set([...t.matchAll(TEST_CASE)].map(m => m[2]))]);
  }
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;                       // a package or an absolute path: outside this graph
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec.split(/[?#]/)[0]));
    return paths.has(target) ? target : undefined;
  };
  const deps = new Map(), uses = new Map();
  for (const e of code) {
    const t = text.get(e.path), seen = new Map(), miss = new Set();
    for (const m of t.matchAll(SPEC)) {
      const r = resolve(e.path, m[2]);
      if (r === null) continue;
      if (r === undefined || r === e.path) { if (r === undefined) miss.add(m[2]); continue; }
      (seen.get(r) ?? seen.set(r, new Set()).get(r)).add(m[2]);
    }
    for (const [target, specs] of seen) deps.set(`${e.path}\0${target}`, {from: e.path, to: target, specifiers: [...specs].sort()});
    if (miss.size) unresolved.set(e.path, [...miss].sort());
    const use = (target, imported) => {
      if (!target || !exportsOf.get(target)?.has(imported)) return;
      const k = `${e.path}\0${target}\0${imported}`;
      uses.set(k, {from: e.path, to: target, name: imported});
    };
    for (const m of t.matchAll(NAMED)) { const r = resolve(e.path, m[3]); for (const n of namesIn(m[1])) use(r, n.imported); }
    for (const m of t.matchAll(DEFAULT_IMPORT)) use(resolve(e.path, m[3]), 'default');
  }

  const counts = {files: tree.entries.length, modules: 0, tests: 0, other: 0};
  for (const e of tree.entries) {
    const type = typeOf(e.path);
    counts[type === 'module' ? 'modules' : type === 'test' ? 'tests' : 'other']++;
    const attributes = {path: e.path, blob: e.blob, bytes: e.size, ...(e.mode === '120000' ? {link: true} : {})};
    if (text.has(e.path) && JS.test(e.path)) {
      attributes.lines = text.get(e.path).split('\n').length;
      attributes.exports = bounded([...exportsOf.get(e.path).keys()].sort());
      if (unresolved.has(e.path)) attributes.unresolved_imports = bounded(unresolved.get(e.path), 32);
      if (cases.has(e.path)) attributes.cases = bounded(cases.get(e.path).map(c => c.slice(0, 200)));
    }
    drafts.push({entity: fileId(e.path), ref: ref(e.path), attributes,
      ...(unresolved.has(e.path) ? {missing_evidence: [`${unresolved.get(e.path).length} relative import(s) do not resolve to a file of the tree at this commit`]} : {})});
    for (const [n, kind] of exportsOf.get(e.path) ?? []) {
      drafts.push({entity: symbolId(e.path, n), ref: ref(e.path), attributes: {module: e.path, name: n, kind}});
      drafts.push({type: 'produces', from: fileId(e.path), to: symbolId(e.path, n), ref: ref(e.path), attributes: {}});
    }
  }
  for (const [schema, where] of [...contracts].sort()) {
    drafts.push({entity: contractId(schema), ref: ref(where[0].path), attributes: {schema, carried_by: where.map(w => `${w.path}#${w.name}`).sort()},
      ...(where.length > 1 ? {uncertainty: `${where.length} exported constants carry this schema id: one contract, or a duplicate definition`} : {})});
    for (const w of where) drafts.push({type: 'implements', from: symbolId(w.path, w.name), to: contractId(schema), ref: ref(w.path), attributes: {constant: w.name}});
  }
  for (const d of deps.values()) drafts.push({type: 'depends-on', from: fileId(d.from), to: fileId(d.to), ref: ref(d.from), attributes: {basis: 'import', specifiers: d.specifiers}});
  for (const u of uses.values()) drafts.push({type: 'consumes', from: fileId(u.from), to: symbolId(u.to, u.name), ref: ref(u.from), attributes: {basis: 'named import'}});

  // Tickets: the requirement record a board item's work is cut from (ophanim.ticket/v1).
  for (const e of tickets) {
    let t;
    try { t = JSON.parse(text.get(e.path)); } catch { continue; }
    if (t?.schema !== 'ophanim.ticket/v1' || typeof t.item !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(t.item)) continue;
    const slot = typeof t.path === 'string' ? t.path : null, copy = Array.isArray(t.copy) ? t.copy.filter(c => typeof c === 'string') : [];
    const missing = [...(slot && !paths.has(slot) ? [slot] : []), ...copy.filter(c => !paths.has(c) && ![...paths].some(p => p.startsWith(c + '/')))];
    drafts.push({entity: ticketId(t.item), ref: ref(e.path), attributes: {item: t.item, file: e.path, title: String(t.title ?? '').slice(0, 300),
      slot: slot, copy: bounded(copy), acceptance_cmd: String(t.acceptance_cmd ?? '').slice(0, 600), ...(missing.length ? {unresolved_paths: bounded(missing, 32)} : {})},
      ...(missing.length ? {missing_evidence: [`the ticket names ${missing.length} path(s) not in the tree at this commit`]} : {})});
    drafts.push({entity: itemId(t.item), ref: ref(e.path), attributes: {named_by_ticket: e.path}});
    drafts.push({type: 'depends-on', from: ticketId(t.item), to: itemId(t.item), ref: ref(e.path), attributes: {basis: 'the ticket names its item'}});
    drafts.push({type: 'derived-from', from: ticketId(t.item), to: fileId(e.path), ref: ref(e.path), attributes: {}});
    if (slot && paths.has(slot)) drafts.push({type: 'implements', from: fileId(slot), to: ticketId(t.item), ref: ref(e.path), attributes: {basis: 'the ticket\'s slot path'}});
    for (const c of copy) if (paths.has(c)) drafts.push({type: 'consumes', from: ticketId(t.item), to: fileId(c), ref: ref(e.path), attributes: {basis: 'the ticket\'s copy path'}});
  }

  // The ancestry: each commit, and each file of THIS tree it changed (a file changed under another name is not followed).
  const history = historyAt(repo, commit), touched = new Map();
  for (const c of history) {
    drafts.push({entity: changeId(c.commit), ref: `git:${c.commit}`, attributes: {commit: c.commit, parents: c.parents, date: c.date, subject: c.subject.slice(0, 300),
      changed: c.paths.length}});
    for (const p of c.paths) if (paths.has(p)) {
      const k = `${p}\0${c.commit}`;
      if (!touched.has(k)) { touched.set(k, true); drafts.push({type: 'derived-from', from: fileId(p), to: changeId(c.commit), ref: `git:${c.commit}`, attributes: {basis: 'the commit changed this path'}}); }
    }
  }
  drafts.push({entity: entityId({domain: 'systems', type: 'repository', key: name}), ref: 'git',
    attributes: {commit, ...counts, changes: history.length, withheld: {pattern: String(WITHHELD), count: tree.withheld}},
    ...(tree.withheld ? {missing_evidence: [`${tree.withheld} withheld path(s) (recorded review findings) are counted and never read`]} : {})});
  return drafts;
}

/**
 * The adapter. `repo`: the repository root; `ref`: what current() resolves (a name, read each time: 'HEAD' follows the
 * checkout's commits; a commit id pins it). readAt(commit) reads that commit's objects, never the working tree.
 */
export function repoSource({repo, ref = 'HEAD', name = 'ophanim', extractor = EXTRACTOR} = {}) {
  return {
    id: SOURCE_ID, extractor, ref: 'git',
    authority: `the repository's git object store (commits are immutable; read at a commit, never the working tree)`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => repoFacts(repo, version, {name}),
  };
}
