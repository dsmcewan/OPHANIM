// QUESTIONS OVER THE OPT-IN DEPENDENCY SOURCES: what does this need, what needs this (through its functions and across
// the sibling repositories), and what could no reading state.
//
// Purpose   Slice B2's queries (ophanim/graph/impact.mjs: package, needs, authority, impact) answer for this repository.
//           These answer over the graph with the opt-in sources composed as well: a function as a subject, a sibling's
//           file or function as a subject, the dependents of a file counted with the dependents of the functions it
//           defines, the advisory class ported from TELOS's Lachesis (measure.mjs), and an audit of every reading.
//           Each line of an answer names the relationship, the lines it was read from and the source and version that
//           state it. A mention is listed apart and labelled: it is never counted as a dependency.
// Inputs    A graph view at a cursor and a subject as a person writes it: anything B2's subjectOf names (a path, a
//           graph id, npm:<name>@<version>, package:<name>, node:<name>, env:<NAME>, exec:<name>, host:<host>, ...), and
//           also path#function, <sibling>:path, <sibling>:path#function, python:<module>, pypi:<name>[@<version>].
// Outputs   subjectOf(), needs(), neededBy(), audit(), nameOf().
// Must never  Follow a mention; report a subject the graph does not hold as an empty answer (it is NOT_FOUND); call an
//           answer complete when a reading it rests on reported a gap.
import {grammarRefusal, parseId, decodeKey} from '../../../packages/graph/index.mjs';
import {subjectOf as baseSubjectOf} from '../impact.mjs';
import {HOME, repositoryId, fileIdIn, symbolIdIn, pythonModuleId, pypiPackageId} from './ids.mjs';
import {DEPENDENCY_TYPES, dependencies, relevance, classOf, coverageOf} from './measure.mjs';

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const EXTRA = ['need', 'declared_in', 'range', 'undeclared', 'via', 'workspace', 'as_written', 'anchor', 'through', 'imported', 'resolved_as'];
const FILES = ['module', 'test', 'file'];
const PREFIX = {'environment-variable': 'env', executable: 'exec', host: 'host', repository: 'repository'};

/** A node's name as a person writes it (what subjectOf reads back, for the kinds it knows). */
export function nameOf(id) {
  const p = parseId(id), key = decodeKey(p.key);
  if (p.domain === 'systems' && [...FILES, 'symbol'].includes(p.type)) return key;
  if (p.domain === 'systems' && p.type === 'package') return key.replace('/', ':');
  if (p.domain === 'systems' && PREFIX[p.type]) return `${PREFIX[p.type]}:${key}`;
  return p.domain === 'capability' && p.type === 'runtime' ? `runtime:${key}` : `${p.domain}/${p.type}/${key}`;
}
/** The repository a node belongs to, or null for a node no repository owns (a package, a variable, a host). */
function repositoryOf(view, id) {
  const p = parseId(id);
  if (p.domain !== 'systems' || ![...FILES, 'symbol', 'repository'].includes(p.type)) return null;
  if (p.type === 'repository') return decodeKey(p.key);
  const m = /^([a-z][a-z0-9-]{0,31}):/.exec(decodeKey(p.key));
  return m && view.nodeIn(repositoryId(m[1]), 'recorded') ? m[1] : HOME;
}

/** The graph id a written subject names: {id} or {error, why}. */
export function subjectOf(view, s) {
  const missing = {error: 'NOT_FOUND', why: `${s} names nothing the graph holds at cursor ${view.seq}`};
  if (typeof s !== 'string' || !s) return baseSubjectOf(view, s);
  const held = id => (view.nodeIn(id, 'recorded') ? {id} : missing);
  try {
    if (s.startsWith('python:')) return held(pythonModuleId(s.slice(7)));
    if (s.startsWith('pypi:')) { const [n, v = null] = s.slice(5).split('@'); return held(pypiPackageId(n, v)); }
    const sib = /^([a-z][a-z0-9-]{0,31}):(.+)$/.exec(s);
    if (sib && view.nodeIn(repositoryId(sib[1]), 'recorded') && !['repository', 'runtime', 'package', 'workspace', 'commit', 'schema', 'item', 'lock'].includes(sib[1])) {
      const at = sib[2].indexOf('#'), id = at < 0 ? fileIdIn(sib[1], sib[2]) : symbolIdIn(sib[1], sib[2].slice(0, at), sib[2].slice(at + 1));
      if (view.nodeIn(id, 'recorded')) return {id};
    }
    const hash = s.indexOf('#');
    if (hash > 0 && !s.includes(':') && grammarRefusal(s) !== null) return held(symbolIdIn(HOME, s.slice(0, hash), s.slice(hash + 1)));
  } catch { return missing; }
  return baseSubjectOf(view, s);
}

/** One relationship as a line of an answer: who states it, on what basis, from which lines. */
function line(view, e, other) {
  const records = e.assertions.map(id => view.assertion(id)).sort((a, b) => byString(a.source.id, b.source.id));
  const a = records[0].record.attributes, lines = new Set();
  for (const r of records) for (const l of [...(r.record.attributes.lines ?? []), ...(r.record.attributes.line ? [r.record.attributes.line] : [])]) if (typeof l === 'number') lines.add(l);
  return {name: nameOf(other), id: other, relationship: e.type, ...(a.basis ? {basis: a.basis} : {}), ...(lines.size ? {lines: [...lines].sort((x, y) => x - y)} : {}),
    stated_by: records.map(r => ({source: r.source.id, version: r.source.version})),
    ...Object.fromEntries(EXTRA.filter(k => a[k] !== undefined && a[k] !== null).map(k => [k, a[k]]))};
}
const groupOf = (view, id, home) => {
  const p = parseId(id), key = decodeKey(p.key), repo = repositoryOf(view, id);
  if (repo !== null && repo !== home) return 'siblings';
  if (p.type === 'package') return key.startsWith('node/') ? 'platform' : 'packages';
  if (p.domain === 'capability' && p.type === 'runtime') return 'platform';
  if (p.type === 'environment-variable') return 'environment';
  if (p.type === 'executable') return 'programs';
  if (p.type === 'host') return 'hosts';
  return FILES.includes(p.type) ? 'files' : p.type === 'symbol' ? 'functions' : 'other';
};
/** The gaps the readings of the repositories an answer touches reported, as sentences. */
function gapsOf(view, ids) {
  const repos = new Set(ids.map(id => repositoryOf(view, id)).filter(Boolean)), out = [];
  for (const repo of [...repos].sort()) for (const a of view.node(repositoryId(repo)).assertions) {
    for (const g of view.assertion(a.id).record.missing_evidence ?? []) out.push(`${repo}: ${g}`);
  }
  return [...new Set(out)].sort(byString);            // an assertion's id follows its content: sorted, the answer does not
}

/** What `subject` needs: its direct dependencies by kind, how many nodes it reaches in all, and what it merely names. */
export function needs(view, subject) {
  const s = subjectOf(view, subject);
  if (s.error) return s;
  const home = repositoryOf(view, s.id) ?? HOME;
  const direct = {packages: [], platform: [], environment: [], programs: [], hosts: [], files: [], functions: [], siblings: [], other: []};
  for (const e of view.edgesOf(s.id, {mode: 'established', types: [...DEPENDENCY_TYPES]})) if (e.from === s.id) direct[groupOf(view, e.to, home)].push(line(view, e, e.to));
  for (const k of Object.keys(direct)) direct[k].sort((a, b) => byString(a.name, b.name));
  const all = dependencies(view, s.id);
  const mentions = view.edgesOf(s.id, {mode: 'established', types: ['mentions']}).filter(e => e.from === s.id).map(e => {
    const l = line(view, e, e.to);
    return {name: l.name, ...(l.lines ? {lines: l.lines} : {}), stated_by: l.stated_by, note: 'named, not used: not a dependency'};
  }).sort((a, b) => byString(a.name, b.name));
  return {query: 'needs', subject: s.id, cursor: view.seq, direct, transitive: {count: all.count}, mentions, coverage: coverageOf(view, {gaps: gapsOf(view, [s.id, ...all.nodes])})};
}

/**
 * What needs `subject`: its direct dependents, and the advisory assessment over everything that reaches it. A file is
 * needed by what needs the file AND by what needs a function it defines; such a line names the function it goes through.
 */
export function neededBy(view, subject) {
  const s = subjectOf(view, subject);
  if (s.error) return s;
  const defined = FILES.includes(parseId(s.id).type) ? view.edgesOf(s.id, {mode: 'established', types: ['produces']}).filter(e => e.from === s.id && parseId(e.to).type === 'symbol').map(e => e.to) : [];
  const seeds = [s.id, ...defined], direct = new Map();
  for (const seed of seeds) for (const e of view.edgesOf(seed, {mode: 'established', types: [...DEPENDENCY_TYPES]})) {
    if (e.to !== seed || seeds.includes(e.from) || direct.has(e.from)) continue;
    direct.set(e.from, {...line(view, e, e.from), ...(seed === s.id ? {} : {through_its: nameOf(seed)})});
  }
  const reached = new Set(), stack = [...seeds];
  while (stack.length) {
    const n = stack.pop();
    for (const e of view.edgesOf(n, {mode: 'established', types: [...DEPENDENCY_TYPES]})) if (e.to === n && !reached.has(e.from) && !seeds.includes(e.from)) { reached.add(e.from); stack.push(e.from); }
  }
  const coverage = coverageOf(view, {gaps: gapsOf(view, [s.id, ...reached])});
  return {query: 'needed-by', subject: s.id, cursor: view.seq, digest: view.digest(), direct: [...direct.values()].sort((x, y) => byString(x.name, y.name)),
    assessment: {...classOf(reached.size, coverage.coverage), relevance: relevance(view, s.id)}, coverage};
}

/**
 * What each reading of a repository could not state, the state of every source, each pinned digest against the
 * sibling's own file, and where a sibling's own declared weave and this repository's reading of it agree.
 */
export function audit(view) {
  const sources = view.sources().map(s => ({id: s.id, state: s.state, version: s.version})).sort((a, b) => byString(a.id, b.id));
  // The repositories some source of this directory read: this one (its calls) and each sibling.
  const names = view.subjects().filter(s => grammarRefusal(s) === null && parseId(s).domain === 'systems' && parseId(s).type === 'repository' && view.nodeIn(s, 'recorded')).map(s => decodeKey(parseId(s).key))
    .filter(n => { const a = view.node(repositoryId(n)).attributes; return a.read_at !== undefined || a.calls_read_at !== undefined; }).sort();
  const repositories = names.map(name => {
    const node = view.node(repositoryId(name)), a = node.attributes;
    const gaps = node.assertions.flatMap(x => (view.assertion(x.id).record.missing_evidence ?? []).map(why => ({source: x.source.id, why}))).sort((x, y) => byString(x.source + x.why, y.source + y.why));
    const weaveGap = gaps.find(g => g.source === `sibling.${name}.weave`);
    const weave = a.weave?.stated !== undefined ? {...a.weave, ...agreement(view, `sibling.${name}.weave`, `sibling.${name}.code`)}
      : weaveGap ? {stated: null, why: weaveGap.why} : undefined;
    return {repository: name, read_at: a.read_at ?? a.calls_read_at ?? null, files_read: a.files_read ?? null, counts: a.counts ?? null, unresolved: a.unresolved ?? null,
      not_parsed: a.not_parsed ?? [], undeclared_imports: a.undeclared_imports ?? [], unresolved_imports: a.unresolved_imports ?? [], ...(weave ? {weave} : {}), gaps};
  });
  return {query: 'audit', cursor: view.seq, digest: view.digest(), repositories, pins: pinsOf(view, names), sources};
}
/**
 * Each digest this repository pins of a sibling's file, compared with the sibling's own file. The pin is what this
 * repository DECLARES (B2's pins source: the pinned commit on the sibling's repository node, the sha256 on the edge);
 * the file's digest is what the sibling's source states at the commit it was read at (code.mjs `content_sha256`). They
 * are compared only when the sibling was read at the pinned commit. No fact depends on this comparison.
 */
function pinsOf(view, names) {
  const out = [];
  for (const name of names.filter(n => n !== HOME)) {
    const repo = view.node(repositoryId(name)).attributes;
    if (typeof repo.pinned_in !== 'string') continue;
    const pinned = [];
    for (const s of view.subjects()) {
      if (!s.startsWith('depends-on(') || !s.includes(`/${name}:`)) continue;
      for (const a of view.query(s, 'established')) {
        const r = view.assertion(a.id).record;
        if (typeof r.attributes.table === 'string' && typeof r.attributes.sha256 === 'string' && repositoryOf(view, r.to) === name) pinned.push({id: r.to, path: decodeKey(parseId(r.to).key).slice(name.length + 1), pinned: r.attributes.sha256});
      }
    }
    pinned.sort((a, b) => byString(a.path, b.path));
    const base = {repository: name, pinned_commit: repo.commit ?? null, pinned_in: repo.pinned_in, read_at: repo.read_at ?? null};
    if (!repo.read_at) { out.push({...base, checked: false, pinned: pinned.length, why: 'the sibling was not read: the digests of its files are not at hand'}); continue; }
    if (repo.read_at !== repo.commit) { out.push({...base, checked: false, pinned: pinned.length, why: 'the sibling was read at another commit than the pinned one'}); continue; }
    const found = pinned.map(p => ({...p, found: view.node(p.id).attributes.content_sha256 ?? null}));
    out.push({...base, checked: true, pinned: pinned.length, matching: found.filter(p => p.found === p.pinned).length,
      differing: found.filter(p => p.found !== null && p.found !== p.pinned).map(p => ({path: p.path, pinned: p.pinned, found: p.found})), absent: found.filter(p => p.found === null).map(p => p.path)});
  }
  return out;
}
/** Of the dependencies source `declared` states, how many source `read` states too, split by whether they join files or functions. */
function agreement(view, declared, read) {
  const out = {files: {declared: 0, also_read_here: 0}, functions: {declared: 0, also_read_here: 0}};
  for (const s of view.subjects()) {
    if (!s.startsWith('depends-on(')) continue;
    const by = new Set(view.query(s, 'established').map(a => a.source.id));
    if (!by.has(declared)) continue;
    const k = s.includes('/systems/symbol/') ? 'functions' : 'files';
    out[k].declared++; if (by.has(read)) out[k].also_read_here++;
  }
  return {agreement: out};
}
