// THE DEPENDENCY GRAPH's questions: what does this need, what needs this, and what could no reading state.
//
// Purpose   Answer from established relationships only, naming for every line of the answer the relationship, the
//           lines it was read from and the source and version that state it. A mention is listed apart and labelled:
//           it is never counted as a dependency. The advisory class is Lachesis's (measure.mjs).
// Inputs    A graph view at a cursor and a subject as a person writes it: a path, path#function, npm:name, node:name,
//           program:name, pypi:name, action:name, image:name, env:NAME, host:name, <sibling>:path[#function], or a graph id.
// Outputs   subjectOf(), needs(), neededBy(), audit(), nameOf().
// Must never  Follow a mention; report a subject the graph does not hold as an empty answer (it is NOT_FOUND); call an
//           answer complete when a reading it rests on reported a gap.
import {grammarRefusal, idRefusal, parseId, decodeKey} from '../../../packages/graph/index.mjs';
import {HOME, ECOSYSTEMS, repositoryId, fileIdIn, symbolIdIn, packageId, envId, hostId} from './ids.mjs';
import {DEPENDENCY_TYPES, dependencies, relevance, classOf, coverageOf} from './measure.mjs';

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const EXTRA = ['declared_in', 'range', 'undeclared', 'local', 'as_written', 'anchor', 'through', 'imported', 'resolved_as'];
const FILES = ['module', 'test', 'file'];

/** A node's name as a person writes it (the inverse of subjectOf for the kinds it knows). */
export function nameOf(id) {
  const p = parseId(id), key = decodeKey(p.key);
  return p.domain === 'systems' && [...FILES, 'symbol', 'component', 'interface', 'service', 'repository'].includes(p.type) ? key : `${p.domain}/${p.type}/${key}`;
}
/** The repository a node belongs to, or null for a node no repository owns (a package, a variable, a host). */
function repositoryOf(view, id) {
  const p = parseId(id);
  if (p.domain !== 'systems' || ![...FILES, 'symbol', 'change'].includes(p.type)) return p.type === 'repository' ? decodeKey(p.key) : null;
  const m = /^([a-z][a-z0-9-]{0,31}):/.exec(decodeKey(p.key));
  return m && view.nodeIn(repositoryId(m[1]), 'possible') ? m[1] : HOME;
}

/** The graph id a written subject names: {id} or {error: 'NOT_FOUND', why}. */
export function subjectOf(view, s) {
  const missing = {error: 'NOT_FOUND', why: `${s} names nothing the graph holds at cursor ${view.seq}`};
  let id = null;
  try {
    const eco = new RegExp(`^(${ECOSYSTEMS.join('|')}):(.+)$`).exec(s), sib = /^([a-z][a-z0-9-]{0,31}):(.+)$/.exec(s);
    // A graph id names a registered domain and type; a path of four segments only has an id's shape.
    if (idRefusal(s) === null) id = s;
    else if (eco) id = packageId(eco[1], eco[2]);
    else if (s.startsWith('env:')) id = envId(s.slice(4));
    else if (s.startsWith('host:')) id = hostId(s.slice(5));
    else {
      const [repo, rest] = sib ? [sib[1], sib[2]] : [HOME, s], at = rest.indexOf('#');
      id = at < 0 ? fileIdIn(repo, rest) : symbolIdIn(repo, rest.slice(0, at), rest.slice(at + 1));
    }
  } catch { return missing; }
  return view.nodeIn(id, 'established') ? {id} : missing;
}

/** One relationship as a line of an answer: who states it, on what basis, from which lines. */
function line(view, e, other) {
  const records = e.assertions.map(id => view.assertion(id)).sort((a, b) => byString(a.source.id, b.source.id));
  const a = records[0].record.attributes, lines = new Set();
  for (const r of records) for (const l of [...(r.record.attributes.lines ?? []), ...(r.record.attributes.line ? [r.record.attributes.line] : [])]) if (typeof l === 'number') lines.add(l);
  return {name: nameOf(other), id: other, relationship: e.type, ...(a.basis ? {basis: a.basis} : {}), ...(lines.size ? {lines: [...lines].sort((x, y) => x - y)} : {}),
    stated_by: records.map(r => ({source: r.source.id, version: r.source.version})),
    ...Object.fromEntries(EXTRA.filter(k => a[k] !== undefined).map(k => [k, a[k]]))};
}
const groupOf = (view, id, home) => {
  const p = parseId(id), key = decodeKey(p.key), repo = repositoryOf(view, id);
  if (repo !== null && repo !== home) return 'siblings';
  if (p.type === 'component') return key.startsWith('node:') ? 'platform' : key.startsWith('program:') ? 'programs' : 'packages';
  if (p.type === 'interface' && key.startsWith('env:')) return 'environment';
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
  const direct = {packages: [], platform: [], environment: [], programs: [], files: [], functions: [], siblings: [], other: []};
  for (const e of view.edgesOf(s.id, {mode: 'established', types: [...DEPENDENCY_TYPES]})) if (e.from === s.id) direct[groupOf(view, e.to, home)].push(line(view, e, e.to));
  for (const k of Object.keys(direct)) direct[k].sort((a, b) => byString(a.name, b.name));
  for (const p of direct.packages) { const locked = view.node(p.id).attributes.locked; if (Array.isArray(locked)) p.locked = [...new Set(locked.map(l => l.version).filter(Boolean))].sort(); }
  const all = dependencies(view, s.id);
  const mentions = view.edgesOf(s.id, {mode: 'established', types: ['mentions']}).filter(e => e.from === s.id).map(e => {
    const l = line(view, e, e.to);
    return {name: l.name, ...(l.lines ? {lines: l.lines} : {}), stated_by: l.stated_by, note: 'named in a string: not a dependency'};
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

/** What each repository's readings could not state, the state of every source, and where a sibling's own declared weave and this repository's reading of it agree. */
export function audit(view) {
  const sources = view.sources().map(s => ({id: s.id, state: s.state, version: s.version})).sort((a, b) => byString(a.id, b.id));
  const names = view.subjects().filter(s => grammarRefusal(s) === null && parseId(s).domain === 'systems' && parseId(s).type === 'repository' && view.nodeIn(s, 'possible')).map(s => decodeKey(parseId(s).key)).sort();
  const repositories = names.map(name => {
    const node = view.node(repositoryId(name)), a = node.attributes;
    const gaps = node.assertions.flatMap(x => (view.assertion(x.id).record.missing_evidence ?? []).map(why => ({source: x.source.id, why})));
    const weaveGap = gaps.find(g => g.source === `sibling.${name}.weave`);
    const weave = a.weave?.stated !== undefined ? {...a.weave, ...agreement(view, `sibling.${name}.weave`, `sibling.${name}.code`)}
      : weaveGap ? {stated: null, why: weaveGap.why} : undefined;
    return {repository: name, commit: a.commit ?? null, files_read: a.files_read ?? null, counts: a.counts ?? null, unresolved: a.unresolved ?? null,
      not_parsed: a.not_parsed ?? [], undeclared_imports: a.undeclared_imports ?? [], unresolved_imports: a.unresolved_imports ?? [], ...(weave ? {weave} : {}), gaps};
  });
  return {query: 'audit', cursor: view.seq, digest: view.digest(), repositories, pins: pinsOf(view, names), sources};
}
/**
 * Each digest this repository pins of a sibling's file, compared with the sibling's own file. The pin is what this
 * repository DECLARES (pins.mjs); the file's digest is what the sibling's source states at the commit it was read at
 * (code.mjs `content_sha256`). They are compared only when the sibling was read at the pinned commit.
 */
function pinsOf(view, names) {
  const out = [];
  for (const name of names.filter(n => n !== HOME)) {
    const repo = view.node(repositoryId(name)).attributes;
    if (repo.pinned_commit === undefined) continue;
    const pinned = [];
    for (const s of view.subjects()) {
      if (!s.startsWith('depends-on(') || !s.includes(`/${name}:`)) continue;
      for (const a of view.query(s, 'established')) {
        const r = view.assertion(a.id).record;
        if (r.attributes.basis === 'digest pin' && repositoryOf(view, r.to) === name) pinned.push({id: r.to, path: decodeKey(parseId(r.to).key).slice(name.length + 1), pinned: r.attributes.sha256});
      }
    }
    pinned.sort((a, b) => byString(a.path, b.path));
    const base = {repository: name, pinned_commit: repo.pinned_commit ?? null, read_at: repo.commit ?? null};
    if (!repo.commit) { out.push({...base, checked: false, pinned: pinned.length, why: 'the sibling was not read: the digests of its files are not at hand'}); continue; }
    if (repo.commit !== repo.pinned_commit) { out.push({...base, checked: false, pinned: pinned.length, why: 'the sibling was read at another commit than the pinned one'}); continue; }
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
