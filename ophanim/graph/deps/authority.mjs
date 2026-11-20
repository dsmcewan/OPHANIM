// WHO IS AUTHORIZED TO CHANGE WHAT, at a commit, as a graph source (the dependency sources; ids.mjs).
//
// Purpose   The ownership manifests docs/execution/*-ownership.json: each one says, for a wave or slice of work, which
//           unit (an agent on a branch) may change which paths, and which paths are reserved for the coordinator. A
//           manifest is a DECLARATION of authority, so the extractor's basis is `declared` -- the only basis `governs`
//           is admitted from. Each manifest is one authorization; it `governs` the files OF THAT COMMIT'S TREE its paths
//           and patterns cover. Nothing is said about a file the tree does not hold.
// Inputs    The repository root and a commit: the manifests' text and the tree's paths at that commit (git.mjs).
// Outputs   ownershipSource(): the adapter; ownershipFacts(): the drafts of one commit; globMatcher() and ownedEntry():
//           the pattern and entry readers, exported for the tests.
// Shapes    Every manifest read so far is `ophanim.wave-ownership/v1`. What occurs in it, and is read:
//             top level   schema; wave (a number or a name: "KG Slice B"); base_commit (as written: 7 or 40 hex);
//                         authorization (text; absent in the first two waves); frozen {name: text}; coordinator_only
//                         [pattern]; dependencies and cross_agent_interfaces [prose]; and the units, as either
//                         `subwaves` {sub-wave: {agent: unit}} or `workers` {agent: unit}
//             a unit      branch; base_commit (a commit, or prose such as "3A integration commit"); starts_after; note;
//                         findings [text]; files, new_files, allowed_extra [entry]; region_limits {entry: prose};
//                         interface_rule (text) or interface_rules [text]
//             an entry    a path or a pattern, optionally followed by a note in parentheses:
//                         `package.json (scripts block only)` -- the note is kept as the entry's qualifier
//           A manifest of another schema, or one that is not a JSON object, is an UNRESOLVED authorization: nothing else
//           is read from it. A key not listed above, or a listed key of another form, is named in `uninterpreted_keys`.
// Patterns  Implemented here, against the tree's file paths: `*` (any run of characters inside one path segment, a
//           leading dot included), `**` (any run across segments; `a/**/b` also matches `a/b`), a trailing `/` (every
//           file under that directory) and `{a,b}` (either; not nested -- the manifests use it throughout). `?`, `[..]`,
//           `\`, `!`, a leading `/`, nested or unbalanced braces and whitespace are NOT read: such an entry is listed
//           in `uninterpreted_entries` and matches nothing.
//           A pattern that matches no file is listed (`unmatched_patterns`); one that matches no file but names a
//           directory of the tree without `/` or `/**` is listed apart (`directory_patterns`) and its files are NOT
//           taken as covered (the manifests write `x-*` and `x-*/**` as two entries). A pattern that matches more than
//           WIDE (200) files is not expanded: it is listed with its count (`wide_patterns`) and the authorization's
//           missing_evidence says so.
// Facts     evidence/authorization/ownership/<name>     the manifest: schema, wave, base commit, the authorization text
//                                                       (600 characters), frozen, the reserved patterns, the prose
//                                                       entries (bounded, never parsed for meaning), the counts and the
//                                                       lists above; `derived-from` its file
//           work/assignment/ownership/<name>/[<sub-wave>/]<agent>   an owning unit: the manifest's assignment of a set of
//                                                       paths to a named agent on a branch (not a team: one seat; not
//                                                       a work-unit: the work ledger's unit of a plan is another thing);
//                                                       the authorization `authorizes` it
//           governs    the authorization -> a file of the tree. `owners`: each unit whose entries cover the file, the
//                      lists and patterns that do, the entries' qualifiers and the unit's region limit for that path.
//                      `reserved: 'coordinator'` with `reserved_patterns`: a coordinator_only pattern covers it -- kept
//                      apart from the owners, and a file that is both carries an `uncertainty` saying so.
// Limits    Paths withheld from every extractor (git.mjs WITHHELD: `findings-*`) are not in the tree read here, so no
//           pattern is matched against them. A manifest is read as it stands at the commit: this source does not say
//           whether its wave is still open, and it does not resolve `base_commit` or compare the tree with that commit.
//           A region limit keyed by something that is not one entry (two paths in one string) is kept as text only.
// Must never  Read the working tree; expand a wide pattern; treat a resemblance of names as coverage; read meaning out
//           of the prose entries; give an agent a coordinator-only path or the coordinator an agent's.
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, resolveCommit} from '../extract/git.mjs';
import {fileId} from '../extract/repo.mjs';

export const SOURCE_ID = 'ophanim.ownership';
export const EXTRACTOR = 'ophanim.ownership.extractor';
/** DECLARED: a manifest states who may change what (the registry admits `governs` and `authorizes` from nothing else). */
export const OWNERSHIP_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
export const MANIFEST = /^docs\/execution\/([^/]+)-ownership\.json$/;
export const SCHEMAS = Object.freeze(['ophanim.wave-ownership/v1']);
/** A pattern covering more files than this is recorded with its count, not expanded. */
export const WIDE = 200;
export const authorizationId = name => entityId({domain: 'evidence', type: 'authorization', key: `ownership/${name}`});
export const assignmentId = (name, subwave, agent) => entityId({domain: 'work', type: 'assignment', key: ['ownership', name, ...(subwave ? [subwave] : []), agent].join('/')});

const TOP = ['schema', 'wave', 'base_commit', 'authorization', 'frozen', 'coordinator_only', 'dependencies', 'cross_agent_interfaces', 'subwaves', 'workers'];
const UNIT = ['branch', 'base_commit', 'starts_after', 'note', 'findings', 'files', 'new_files', 'allowed_extra', 'region_limits', 'interface_rule', 'interface_rules'];
const LISTS = ['files', 'new_files', 'allowed_extra'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = xs => [...new Set(xs)].sort();
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const textOr = (v, n) => (typeof v === 'string' ? cut(v, n) : null);
const isTexts = v => Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * A matcher for one pattern over repository paths: {ok: true, test(path)} or {ok: false, why} for a pattern this reader
 * does not implement (see Patterns in the header). A pattern with no special character matches that one path.
 */
export function globMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern) return {ok: false, why: 'a pattern is a non-empty string'};
  if (/[?[\]\\!]/.test(pattern)) return {ok: false, why: '`?`, `[`, `]`, `\\` and `!` are not read'};
  if (/\s/.test(pattern)) return {ok: false, why: 'a pattern has no whitespace'};
  if (pattern.startsWith('/')) return {ok: false, why: 'a pattern is relative to the repository root'};
  const p = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let re = '', inBraces = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      // `**/` at the start of a segment is zero or more whole directories; `**` anywhere else is any run of characters.
      if ((i === 0 || p[i - 1] === '/') && p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') { if (inBraces) return {ok: false, why: 'nested braces are not read'}; inBraces = true; re += '(?:'; }
    else if (c === '}') { if (!inBraces) return {ok: false, why: 'a `}` without its `{`'}; inBraces = false; re += ')'; }
    else if (c === ',' && inBraces) re += '|';
    else re += c.replace(/[.+^$()|]/, '\\$&');
  }
  if (inBraces) return {ok: false, why: 'a `{` without its `}`'};
  const compiled = new RegExp(`^${re}$`);
  return {ok: true, test: path => compiled.test(path)};
}

/** One entry of a path list: {pattern, qualifier} (`path (note)` -> the note), or null when it is not a path entry. */
export function ownedEntry(text) {
  const m = typeof text === 'string' ? /^(\S+)(?:\s+\((.*)\))?$/.exec(text) : null;
  return m ? {pattern: m[1], qualifier: m[2] === undefined ? null : m[2]} : null;
}

/** Every directory of the tree (each proper prefix of a file path), to tell "names a directory" from "names nothing". */
function directoriesOf(paths) {
  const out = new Set();
  for (const p of paths) for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.add(p.slice(0, i));
  return [...out];
}

function manifestFacts({name, file, text, paths, dirs, withheld}) {
  const auth = authorizationId(name);
  const unresolved = (why, attributes = {}) => [{entity: auth, ref: file, status: 'unresolved', attributes: {file, ...attributes}, missing_evidence: [why]}];
  let j;
  try { j = JSON.parse(text); } catch { return unresolved(`${file} is not valid JSON at this commit: nothing is read from it`); }
  if (!plain(j)) return unresolved(`${file} is not a JSON object: nothing is read from it`);
  if (!SCHEMAS.includes(j.schema)) {
    return unresolved(`schema ${JSON.stringify(typeof j.schema === 'string' ? cut(j.schema, 80) : j.schema ?? null)} is not one this reader interprets (${SCHEMAS.join(', ')}): nothing else is read from it`,
      {schema: typeof j.schema === 'string' ? cut(j.schema, 80) : null, uninterpreted_keys: bounded(Object.keys(j).filter(k => k !== 'schema').sort())});
  }
  const unknown = new Set(Object.keys(j).filter(k => !TOP.includes(k)));
  // A known key of another form is not interpreted either: it is named, and its value is left out.
  const take = (key, ok) => { if (!Object.hasOwn(j, key)) return undefined; if (ok(j[key])) return j[key]; unknown.add(key); return undefined; };
  const wave = take('wave', v => ['string', 'number'].includes(typeof v)), base = take('base_commit', v => typeof v === 'string');
  const authorization = take('authorization', v => typeof v === 'string'), frozen = take('frozen', v => plain(v) && Object.values(v).every(x => typeof x === 'string'));
  const reserved = take('coordinator_only', Array.isArray) ?? [], dependencies = take('dependencies', isTexts) ?? [], interfaces = take('cross_agent_interfaces', isTexts) ?? [];
  const groups = [...Object.entries(take('subwaves', v => plain(v) && Object.values(v).every(plain)) ?? {}).map(([s, units]) => [s, units]), [null, take('workers', plain) ?? {}]];

  // What each pattern covers, once per distinct pattern of this manifest.
  const cover = new Map(), unmatched = new Set(), directory = new Set(), wide = new Map(), unread = new Set();
  const covered = entry => {
    const e = ownedEntry(entry), m = e ? globMatcher(e.pattern) : null;
    if (!m?.ok) { unread.add(typeof entry === 'string' ? cut(entry, 200) : cut(String(JSON.stringify(entry)), 200)); return null; }
    if (!cover.has(e.pattern)) {
      const hit = paths.filter(m.test);
      if (hit.length > WIDE) wide.set(e.pattern, hit.length);
      else if (!hit.length) (dirs.some(m.test) ? directory : unmatched).add(e.pattern);
      cover.set(e.pattern, hit.length > WIDE ? [] : hit);
    }
    return {...e, files: cover.get(e.pattern)};
  };
  const edges = new Map();                                 // path -> {owners: Map unit -> {...}, reserved: Set pattern}
  const edge = p => edges.get(p) ?? edges.set(p, {owners: new Map(), reserved: new Set()}).get(p);
  for (const entry of reserved) { const c = covered(entry); if (c) for (const p of c.files) edge(p).reserved.add(c.pattern); }

  const drafts = [], units = [], skipped = [];
  for (const [subwave, members] of groups) for (const [agent, u] of Object.entries(members)) {
    const label = subwave === null ? agent : `${subwave}/${agent}`;
    if (!plain(u) || !NAME.test(agent) || (subwave !== null && !NAME.test(subwave))) { skipped.push(cut(label, 120)); continue; }
    const odd = new Set(Object.keys(u).filter(k => !UNIT.includes(k)));
    const get = (key, ok) => { if (!Object.hasOwn(u, key)) return undefined; if (ok(u[key])) return u[key]; odd.add(key); return undefined; };
    const mine = new Set();
    for (const list of LISTS) for (const entry of get(list, Array.isArray) ?? []) {
      const c = covered(entry);
      if (!c) continue;
      for (const p of c.files) {
        const o = edge(p).owners.get(label) ?? edge(p).owners.set(label, {lists: new Set(), patterns: new Set(), qualifiers: new Set(), limits: new Set()}).get(label);
        o.lists.add(list); o.patterns.add(c.pattern);
        if (c.qualifier) o.qualifiers.add(cut(c.qualifier, 200));
        mine.add(p);
      }
    }
    // A region limit narrows what the unit may change in a path it owns; it never grants a path by itself.
    const limits = Object.entries(get('region_limits', v => plain(v) && Object.values(v).every(x => typeof x === 'string')) ?? {});
    for (const [key, limit] of limits) {
      const e = ownedEntry(key), m = e ? globMatcher(e.pattern) : null;
      if (m?.ok) for (const p of mine) if (m.test(p)) edges.get(p).owners.get(label).limits.add(cut(limit, 300));
    }
    const rule = get('interface_rule', v => typeof v === 'string'), rules = get('interface_rules', isTexts) ?? [];
    const id = assignmentId(name, subwave, agent), at = `${file}#${label}`;
    units.push(label);
    drafts.push({entity: id, ref: at, attributes: {manifest: name, subwave, agent, branch: textOr(get('branch', v => typeof v === 'string'), 200), base_commit: textOr(get('base_commit', v => typeof v === 'string'), 120),
      starts_after: textOr(get('starts_after', v => typeof v === 'string'), 200), note: textOr(get('note', v => typeof v === 'string'), 400),
      findings: bounded((get('findings', isTexts) ?? []).map(x => cut(x, 200)), 16), interface_rules: bounded([...(rule === undefined ? [] : [rule]), ...rules].map(x => cut(x, 300)), 8),
      ...Object.fromEntries(LISTS.map(list => [list, bounded((Array.isArray(u[list]) ? u[list] : []).map(x => (typeof x === 'string' ? cut(x, 400) : cut(String(JSON.stringify(x)), 80))), 40)])),
      region_limits: bounded(limits.map(([key, limit]) => ({path: cut(key, 200), limit: cut(limit, 300)})), 16), governed_files: mine.size, uninterpreted_keys: bounded([...odd].sort())}});
    drafts.push({type: 'authorizes', from: auth, to: id, ref: at, attributes: {subwave, agent}});
  }

  const governs = [...edges].sort(([a], [b]) => byString(a, b)).map(([p, e]) => {
    const owners = [...e.owners].sort(([a], [b]) => byString(a, b)).map(([unit, o]) => ({unit, lists: LISTS.filter(l => o.lists.has(l)), patterns: bounded(uniq(o.patterns), 8),
      ...(o.qualifiers.size ? {qualifiers: bounded(uniq(o.qualifiers), 4)} : {}), ...(o.limits.size ? {region_limits: bounded(uniq(o.limits), 4)} : {})}));
    return {type: 'governs', from: auth, to: fileId(p), ref: file, attributes: {...(owners.length ? {owners: bounded(owners, 8)} : {}),
      ...(e.reserved.size ? {reserved: 'coordinator', reserved_patterns: bounded(uniq(e.reserved), 8)} : {})},
      ...(owners.length && e.reserved.size ? {uncertainty: 'the manifest both reserves this path for the coordinator and lists it for a unit'} : {})};
  });
  const missing = [
    ...(authorization === undefined ? ['the manifest states no authorization text'] : []),
    ...(wide.size ? [`${wide.size} pattern(s) match more than ${WIDE} files each and are not expanded into relationships: each is listed with its count (wide_patterns)`] : []),
    ...(directory.size ? [`${directory.size} pattern(s) name a directory without a trailing \`/\` or \`/**\`: the files under it are not taken as covered`] : []),
    ...(unread.size ? [`${unread.size} path entry(ies) are not a path or pattern this reader interprets: they are listed, not matched (uninterpreted_entries)`] : []),
    ...(skipped.length ? [`${skipped.length} unit(s) are not an object with a name this reader reads and are not assignments: ${cut(skipped.join(', '), 600)}`] : []),
    ...(withheld && cover.size ? [`${withheld} withheld path(s) of the tree (recorded review findings) are never matched against a pattern`] : []),
  ];
  return [
    {entity: auth, ref: file, attributes: {file, schema: j.schema, wave: wave === undefined ? null : typeof wave === 'string' ? cut(wave, 120) : wave, base_commit: textOr(base, 120),
      authorization: textOr(authorization, 600), frozen: frozen === undefined ? null : Object.fromEntries(Object.entries(frozen).slice(0, 16).map(([k, v]) => [cut(k, 80), cut(v, 300)])),
      coordinator_only: bounded(reserved.map(x => (typeof x === 'string' ? cut(x, 400) : cut(String(JSON.stringify(x)), 80)))), dependencies: bounded(dependencies.map(x => cut(x, 400)), 16),
      cross_agent_interfaces: bounded(interfaces.map(x => cut(x, 400)), 16), units: bounded(units, 64), governed_files: governs.length,
      owned_files: governs.filter(g => g.attributes.owners).length, reserved_files: governs.filter(g => g.attributes.reserved).length,
      unmatched_patterns: bounded(uniq(unmatched).map(x => cut(x, 400))), directory_patterns: bounded(uniq(directory).map(x => cut(x, 400))),
      wide_patterns: bounded([...wide].sort(([a], [b]) => byString(a, b)).map(([pattern, count]) => ({pattern: cut(pattern, 400), count}))),
      uninterpreted_entries: bounded(uniq(unread)), uninterpreted_keys: bounded([...unknown].sort())}, ...(missing.length ? {missing_evidence: missing} : {})},
    {type: 'derived-from', from: auth, to: fileId(file), ref: file, attributes: {}},
    ...drafts, ...governs,
  ];
}

/** The facts of every ownership manifest of the tree at `commit`, as the extractor's drafts (manifests in path order). */
export function ownershipFacts(repo, commit) {
  const tree = treeAt(repo, commit), paths = tree.entries.map(e => e.path);
  const manifests = tree.entries.filter(e => MANIFEST.test(e.path) && e.mode !== '120000');
  if (!manifests.length) return [];
  const bytes = blobsAt(repo, manifests.map(e => e.blob)), dirs = directoriesOf(paths);
  return manifests.flatMap(e => manifestFacts({name: MANIFEST.exec(e.path)[1], file: e.path, text: bytes.get(e.blob).toString('utf8'), paths, dirs, withheld: tree.withheld}));
}

/** The adapter: the manifests at the commit `ref` names now (readAt: that commit's objects). */
export function ownershipSource({repo, ref = 'HEAD', extractor = EXTRACTOR} = {}) {
  return {
    id: SOURCE_ID, extractor, ref: 'docs/execution',
    authority: 'the ownership manifests docs/execution/*-ownership.json (who may change which paths; coordinator-written, read here) and the tree they are matched against, at a commit',
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => ownershipFacts(repo, version),
  };
}
