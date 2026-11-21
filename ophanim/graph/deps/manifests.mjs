// THE MANIFEST READERS of the dependency sources: the text of a file that DECLARES dependencies -> what it declares.
//
// Purpose   The code readers (deps/parse.mjs, deps/python.mjs) say what code uses. A repository also declares what it
//           needs: packages in package.json and requirements files, exact installs in a lockfile, services in a compose
//           file, actions and runtime versions in CI workflows. Each reader here is a pure function over one file's
//           text; a dependency source reads the text at a commit and turns the reading into facts.
// Inputs    One file's text. No path, no repository, no other file.
// Outputs   Every reader returns {ok: true, ...} or {ok: false, why} (and then NOTHING else: a refused file gives no
//           facts). A `line` is the 1-based line the thing is written on.
//             readPackageJson(text)  -> {name, version, private, type, workspaces: [pattern], engines: {name: range},
//                                       dependencies: [{name, range, kind, line}], scripts: {name: text}}
//                                       kind: dependencies | devDependencies | peerDependencies | optionalDependencies.
//                                       `line` is where the key is written inside its own top-level section.
//             readPackageLock(text)  -> {lockfileVersion, root: {name, version, workspaces}, packages: [{path, name,
//                                       version, resolved_host, integrity, dev, optional, link, line[, target, alias_of,
//                                       peer, dev_optional]}]}. v2 and v3: the `packages` map (the entry '' is the
//                                       project and is `root`); `name` is the path after the last `node_modules/` (a
//                                       workspace directory entry takes the name it states). v1: the nested
//                                       `dependencies` tree, read into the same shape at the path npm installs it.
//             readRequirements(text) -> {requirements: [{name, written, specifier, extras, marker, line[, hashes,
//                                       url_host]}], includes: [{path, line, kind}], options: [{text, line}],
//                                       unresolved: [{line, text}]}. `name` is normalised as PyPI does (lowercase, runs
//                                       of - _ . to -), `written` is the name as written.
//             readCompose(text)      -> {services: [{name, line, image, build, depends_on, env_names, env_files, ports,
//                                       interpolates, partial}], unresolved: [{service, key, line, why}]}.
//                                       `interpolates` are the NAMES of host variables the service's values refer to
//                                       ($X, ${X...}); `partial` marks a service with something this reader did not read.
//             readWorkflow(text)     -> {name, uses: [{action, ref, line, kind[, path, comment]}], node_versions:
//                                       [{value, line[, expression]}], node_version_files: [{path, line}],
//                                       runs: [{line, first_word[, block, assignment]}], unresolved: [{line, text}]}
// Invariants  A credential never leaves a reader. Of a URL only the HOST is kept (lowercase); where text is kept
//           verbatim (a script, an option line, an unresolved line, a version that is a URL) the user:password@ part of
//           every URL in it is removed first. An environment entry is its NAME: no value and no default is kept. What is
//           seen and cannot be read is listed in `unresolved` with its line, never guessed and never dropped.
// What each one is, and is not
//           - package.json / lockfile: JSON.parse, then a scan of the same text for the line of each key. Not read:
//             bundledDependencies, overrides, resolutions, peerDependenciesMeta, and a lockfile's per-package
//             dependency lists (only what is installed, not who asked for it).
//           - requirements: pip's line syntax (comments, backslash continuations, -r/-c, options, PEP 508 names,
//             extras, specifiers, markers, `name @ url`). A VCS, URL, path or archive line without a name, and -e, is
//             unresolved. Markers are kept as text, not evaluated; ${VAR} is not expanded; included files are not opened.
//           - compose: NOT a YAML library. An indentation reader for the subset compose files use: block maps and lists,
//             `key: value`, quoted and plain scalars on one line, inline [a, b] lists, {} and comments. An anchor (&x)
//             names a node that is still read. A second document, a tab indent, a plain scalar over several lines, a
//             list directly inside a list item or a duplicate key refuse the file. An alias (*x), a merge key (<<), a
//             block scalar (| >), a tag, a non-empty {…} or a nested inline collection INSIDE a service leaves the
//             service listed, `partial`, with the reason in `unresolved` (so do `extends`, a long-form port and an
//             environment entry whose name is not a plain name); outside `services` they are skipped. Scalars are text:
//             no YAML typing. Profiles, networks, volumes, secrets and `include`d files are not read.
//           - workflow: NOT a YAML parser; it reads by line. `uses:`, `node-version:`, `node-version-file:` and `run:`
//             are found wherever a line has that key, outside block scalars (so a `uses:` inside a script is not a
//             step). A `run:` with no value (the `defaults.run` map) is not a step. For `run: |` every non-empty line
//             that is not a comment, the continuation of a line ending in `\` or the body of a here-document (<<WORD
//             to the line that is WORD) gives its first word, so shell keywords (if, fi, done) and lines inside
//             multi-line strings are read as first words too (`block: true` marks them: a first word is not yet a
//             program); for `run: >` only the first line of each paragraph. Leading NAME=value words are
//             skipped; a line that only assigns gives `NAME=` and `assignment: true`, never the value. An expression
//             (${{ … }}) is kept as written and not evaluated: a matrix or env reference is not followed.
// Must never  Open a file, run anything, use the network, keep a credential or a value of an environment variable.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEPENDENCY_KINDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

/** `text` without the user:password@ part of any URL in it. */
export const withoutCredentials = text => String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');
/** The host of a URL, lowercase, or null when `text` is not a URL with a host (a path, a file: URL). */
export const hostOf = text => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@]*@)?(\[[^\]\s]+\]|[^/:\s?#]+)/i.exec(String(text).trim());
  return m ? m[1].toLowerCase() : null;
};

class Refusal extends Error {}
const refused = e => { if (e instanceof Refusal) return {ok: false, why: e.message}; throw e; };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text0 = v => (typeof v === 'string' ? v : null);
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

// ---- JSON: the value, and the line each key is written on ----------------------------------------------------------------
function parseJsonObject(text) {
  let value;
  try { value = JSON.parse(String(text).replace(/^﻿/, '')); }
  catch (e) { throw new Refusal(`not JSON: ${e.message}`); }
  if (!isObject(value)) throw new Refusal('the document is not a JSON object');
  return value;
}
/**
 * The line of every object key of valid JSON `text`, by its path of keys joined with NUL (`dependencies\0left-pad`).
 * A key under an array is not recorded; a key written twice keeps its last line, as JSON.parse keeps its last value.
 */
function keyLines(text) {
  const lines = new Map(), stack = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') line++;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top && !top.array && top.expectKey) {
        top.key = JSON.parse(text.slice(i, j + 1)); top.expectKey = false;
        if (stack.every(f => !f.array)) lines.set(stack.map(f => f.key).join('\0'), line);
      }
      i = j;
    } else if (c === '{') stack.push({array: false, expectKey: true, key: null});
    else if (c === '[') stack.push({array: true});
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.length && !stack.at(-1).array) stack.at(-1).expectKey = true;
  }
  return lines;
}
const workspacesOf = v => (Array.isArray(v) ? strings(v) : isObject(v) ? strings(v.packages) : []);

/** What a package.json declares. See the header. */
export function readPackageJson(text) {
  let pkg;
  try { pkg = parseJsonObject(text); } catch (e) { return refused(e); }
  const lines = keyLines(String(text));
  const dependencies = [];
  for (const kind of DEPENDENCY_KINDS) {
    if (!isObject(pkg[kind])) continue;
    for (const [name, range] of Object.entries(pkg[kind])) {
      dependencies.push({name, range: typeof range === 'string' ? withoutCredentials(range) : null, kind, line: lines.get(`${kind}\0${name}`) ?? null});
    }
  }
  const pick = v => Object.fromEntries(Object.entries(isObject(v) ? v : {}).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, withoutCredentials(x)]));
  return {ok: true, name: text0(pkg.name), version: text0(pkg.version), private: pkg.private === true, type: text0(pkg.type),
    workspaces: workspacesOf(pkg.workspaces), engines: pick(pkg.engines), dependencies, scripts: pick(pkg.scripts)};
}

/** What a package-lock.json installs. See the header. */
export function readPackageLock(text) {
  let lock;
  try { lock = parseJsonObject(text); } catch (e) { return refused(e); }
  const version = lock.lockfileVersion ?? (isObject(lock.dependencies) && !isObject(lock.packages) ? 1 : null);
  if (!isObject(lock.packages) && !isObject(lock.dependencies)) return {ok: false, why: 'no `packages` map (lockfile v2, v3) and no `dependencies` tree (v1)'};
  if (![1, 2, 3].includes(version)) return {ok: false, why: `lockfileVersion ${JSON.stringify(version)} is not one this reader knows (1, 2, 3)`};
  const lines = keyLines(String(text));
  const entry = (path, name, e, line) => {
    const resolved = text0(e.resolved);
    return {path, name, version: e.version === undefined ? null : withoutCredentials(e.version), resolved_host: resolved === null ? null : hostOf(resolved),
      integrity: text0(e.integrity), dev: e.dev === true, optional: e.optional === true, link: e.link === true, line,
      // A link's `resolved` is the directory in the repository it points at, not a URL.
      ...(e.link === true && resolved !== null && hostOf(resolved) === null && !/^[a-z][a-z0-9+.-]*:/i.test(resolved) ? {target: resolved} : {}),
      ...(typeof e.name === 'string' && e.name !== name ? {alias_of: e.name} : {}),
      ...(e.peer === true ? {peer: true} : {}), ...(e.devOptional === true ? {dev_optional: true} : {})};
  };
  const packages = [];
  let root = {name: text0(lock.name), version: text0(lock.version), workspaces: []};
  if (isObject(lock.packages)) {
    for (const [path, e] of Object.entries(lock.packages)) {
      if (!isObject(e)) continue;
      if (path === '') { root = {name: text0(e.name) ?? root.name, version: text0(e.version) ?? root.version, workspaces: workspacesOf(e.workspaces)}; continue; }
      const at = path.lastIndexOf('node_modules/');
      packages.push(entry(path, at < 0 ? text0(e.name) : path.slice(at + 'node_modules/'.length), e, lines.get(`packages\0${path}`) ?? null));
    }
  } else {
    const walk = (deps, prefix, keys) => {
      for (const [name, e] of Object.entries(deps)) {
        if (!isObject(e)) continue;
        const path = `${prefix}node_modules/${name}`, key = [...keys, name];
        packages.push(entry(path, name, e, lines.get(key.join('\0')) ?? null));
        if (isObject(e.dependencies)) walk(e.dependencies, `${path}/`, [...key, 'dependencies']);
      }
    };
    walk(lock.dependencies, '', ['dependencies']);
  }
  return {ok: true, lockfileVersion: version, root, packages};
}

// ---- pip requirements ----------------------------------------------------------------------------------------------------
const REQUIREMENT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(.*)$/;
const CLAUSE = '(?:~=|===?|!=|<=?|>=?)\\s*[A-Za-z0-9_.*+!-]+';
const SPECIFIER = new RegExp(`^(?:${CLAUSE}(?:\\s*,\\s*${CLAUSE})*)?$`);
const ARCHIVE = /\.(?:whl|zip|tgz|tar\.gz|tar\.bz2|tar\.xz|egg)$/i;
/** A project name as the Python package index compares names. */
export const pypiName = name => name.toLowerCase().replace(/[-_.]+/g, '-');

/** What a pip requirements file declares. See the header. */
export function readRequirements(text) {
  const src = String(text).replace(/^﻿/, '');
  if (src.includes('\0')) return {ok: false, why: 'the text holds a NUL byte: not a requirements file'};
  const out = {ok: true, requirements: [], includes: [], options: [], unresolved: []};
  const physical = src.split('\n').map(l => l.replace(/\r$/, ''));
  for (let k = 0; k < physical.length; k++) {
    const line = k + 1;
    let joined = physical[k];
    while (joined.endsWith('\\') && k + 1 < physical.length) joined = `${joined.slice(0, -1)} ${physical[++k]}`;
    const l = joined.replace(/(^|\s+)#.*$/, '').trim();
    if (!l) continue;
    const unresolved = () => out.unresolved.push({line, text: withoutCredentials(l).replace(/\s+/g, ' ')});
    if (l.startsWith('-')) {
      const inc = /^(--requirement|--constraint|-r|-c)(?:\s+|=)?(.*)$/.exec(l);
      if (inc && inc[2]) out.includes.push({path: withoutCredentials(inc[2].trim()), line, kind: /^(--requirement|-r)$/.test(inc[1]) ? 'requirement' : 'constraint'});
      else if (inc || /^(-e|--editable)(\s|=|$)/.test(l)) unresolved();
      else out.options.push({text: withoutCredentials(l).replace(/\s+/g, ' '), line});
      continue;
    }
    // Options after a requirement (--hash=...) are not part of its specifier.
    const [head, ...perRequirement] = l.split(/\s+(?=--)/);
    const m = REQUIREMENT.exec(head);
    if (!m || ARCHIVE.test(m[1])) { unresolved(); continue; }
    const hashes = perRequirement.filter(o => /^--hash[=\s]/.test(o)).length;
    const base = {name: pypiName(m[1]), written: m[1], specifier: '', extras: m[2] === undefined ? [] : m[2].split(',').map(x => x.trim()).filter(Boolean)};
    const rest = m[3].trim(), more = hashes ? {hashes} : {};
    if (rest.startsWith('@')) {
      const [url, marker] = rest.slice(1).trim().split(/\s+;\s*/, 2);
      if (!url) { unresolved(); continue; }
      out.requirements.push({...base, marker: marker?.trim() || null, line, ...more, url_host: hostOf(url)});
      continue;
    }
    const semi = rest.indexOf(';');
    const specifier = (semi < 0 ? rest : rest.slice(0, semi)).trim().replace(/^\((.*)\)$/, '$1').trim();
    if (!SPECIFIER.test(specifier)) { unresolved(); continue; }
    out.requirements.push({...base, specifier: specifier.replace(/\s+/g, ''), marker: semi < 0 ? null : rest.slice(semi + 1).trim() || null, line, ...more});
  }
  return out;
}

// ---- the YAML subset of compose files -----------------------------------------------------------------------------------
// Nodes: {kind: 'map', entries: [{key, line, value}]}, {kind: 'seq', items}, {kind: 'scalar', value}, {kind: 'null'},
// and {kind: 'opaque', what}: something whose extent is known and whose content is not read. Every node has its line.
const isItem = c => c === '-' || c.startsWith('- ');
const ANCHOR = /^&[^\s[\]{},]+(?:\s+|$)/;
const DOUBLE_ESCAPES = {n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/'};

function parseYamlSubset(text) {
  const L = [];
  String(text).replace(/^﻿/, '').split('\n').forEach((raw0, k) => {
    const raw = raw0.replace(/\r$/, ''), line = k + 1;
    if (/^\s*(#|$)/.test(raw)) return;
    const lead = /^[ \t]*/.exec(raw)[0];
    if (!lead && /^(---|\.\.\.)(\s|$)/.test(raw)) {
      if (L.length || !/^---\s*(#.*)?$/.test(raw)) throw new Refusal(`line ${line}: a second document; only one is read`);
      return;
    }
    L.push({indent: lead.length, tab: lead.includes('\t'), content: raw.slice(lead.length).trimEnd(), line});
  });
  if (!L.length) throw new Refusal('the document is empty');
  let i = 0;
  const fail = (line, why) => { throw new Refusal(`line ${line}: ${why}`); };
  // Block scalar content is never looked at, so a tab only matters on a line that is read as structure.
  const structural = l => (l.tab ? fail(l.line, 'a tab in the indentation') : l);
  const afterValue = (s, line) => { const t = s.trim(); if (t && !t.startsWith('#')) fail(line, 'text after a value that has ended'); };

  const quoted = (s, line) => {
    const q = s[0];
    let j = 1, value = '';
    for (; j < s.length; j++) {
      const c = s[j];
      if (q === "'") { if (c !== "'") value += c; else if (s[j + 1] === "'") { value += "'"; j++; } else break; }
      else if (c === '\\') { const e = s[++j]; value += DOUBLE_ESCAPES[e] ?? `\\${e ?? ''}`; }
      else if (c === '"') break;
      else value += c;
    }
    if (j >= s.length) fail(line, 'a quoted scalar that does not end on its line');
    return {value, rest: s.slice(j + 1)};
  };
  /** `key: rest` at the start of `content`, or null when the content is not a map entry. */
  const splitKey = (content, line) => {
    if (content[0] === '"' || content[0] === "'") {
      const q = quoted(content, line), m = /^\s*:(?:\s+|$)/.exec(q.rest);
      return m ? {key: q.value, rest: q.rest.slice(m[0].length).trim()} : null;
    }
    if (content[0] === '[' || content[0] === '{') return null;
    if (content.startsWith('? ')) fail(line, 'a complex key');
    const m = /:(?:\s|$)|\s#/.exec(content);
    if (!m || m[0][0] !== ':' || m.index === 0) return null;
    return {key: content.slice(0, m.index).trim(), rest: content.slice(m.index + 1).trim()};
  };
  /** A [..] or {..} that starts `rest`, taking following lines until it closes. */
  const flow = (rest, line) => {
    let s = rest, depth = 0, q = null, end = -1, nested = false;
    for (let j = 0; end < 0; j++) {
      if (j >= s.length) { if (i >= L.length) fail(line, 'a flow collection that is never closed'); s += ` ${L[i++].content}`; }
      const c = s[j];
      if (q) { if (q === '"' && c === '\\') j++; else if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '[' || c === '{') { if (depth++) nested = true; }
      else if ((c === ']' || c === '}') && --depth === 0) end = j;
    }
    afterValue(s.slice(end + 1), line);
    const body = s.slice(1, end);
    if (s[0] === '{') return body.trim() ? {kind: 'opaque', what: 'a flow map', line} : {kind: 'map', entries: [], line};
    if (nested) return {kind: 'opaque', what: 'a list holding another collection', line};
    const items = [];
    let from = 0;
    q = null;
    for (let j = 0; j <= body.length; j++) {
      const c = body[j];
      if (q) { if (q === '"' && c === '\\') j++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (j < body.length && c !== ',') continue;
      const item = body.slice(from, j).trim();
      from = j + 1;
      if (!item) continue;
      if (item[0] === '*') return {kind: 'opaque', what: 'an alias', line};
      if (item[0] === '"' || item[0] === "'") { const r = quoted(item, line); afterValue(r.rest, line); items.push({kind: 'scalar', value: r.value, line}); }
      else items.push({kind: 'scalar', value: item, line});
    }
    return {kind: 'seq', items, line};
  };
  /** The value written after `key:` or `- ` on line `l`; `i` is already past that line. */
  const valueAfter = (rest0, l, indent, inMap) => {
    // An anchor names the node for an alias elsewhere; the node itself is written here and is read.
    let rest = rest0.replace(ANCHOR, '');
    if (rest.startsWith('#')) rest = '';
    const skipDeeper = () => { while (i < L.length && L[i].indent > indent) i++; };
    let node;
    if (rest === '') {
      const next = L[i];
      if (next && next.indent > indent) return block(next.indent);
      if (inMap && next && next.indent === indent && isItem(next.content)) return seq(indent);
      return {kind: 'null', line: l.line};
    }
    if (rest[0] === '|' || rest[0] === '>') {
      if (!/^[|>](?:[+-]?[1-9]?|[1-9][+-]?)(?:\s+#.*)?$/.test(rest)) fail(l.line, 'a block scalar header this reader cannot read');
      skipDeeper();
      return {kind: 'opaque', what: 'a block scalar', line: l.line};
    }
    if (rest[0] === '*') { afterValue(rest.replace(/^\*[^\s[\]{},]+/, ''), l.line); node = {kind: 'opaque', what: 'an alias', line: l.line}; }
    else if (rest[0] === '!') { skipDeeper(); return {kind: 'opaque', what: 'a tagged value', line: l.line}; }
    else if (rest[0] === '[' || rest[0] === '{') node = flow(rest, l.line);
    else if (rest[0] === '"' || rest[0] === "'") { const r = quoted(rest, l.line); afterValue(r.rest, l.line); node = {kind: 'scalar', value: r.value, line: l.line}; }
    else { const c = /\s#/.exec(rest); node = {kind: 'scalar', value: (c ? rest.slice(0, c.index) : rest).trim(), line: l.line}; }
    if (i < L.length && L[i].indent > indent) fail(L[i].line, 'indented deeper than the value above it (a plain scalar over several lines is not read)');
    return node;
  };
  const lineUp = indent => { if (i < L.length && L[i].indent > indent) fail(L[i].line, 'the indentation does not line up with a block above it'); };
  function map(indent) {
    const node = {kind: 'map', entries: [], line: L[i].line};
    while (i < L.length && L[i].indent === indent && !isItem(L[i].content)) {
      const l = structural(L[i]), kv = splitKey(l.content, l.line);
      if (!kv) fail(l.line, 'neither `key: value` nor a list item');
      if (node.entries.some(e => e.key === kv.key)) fail(l.line, `the key "${kv.key}" is written twice`);
      i++;
      node.entries.push({key: kv.key, line: l.line, value: valueAfter(kv.rest, l, indent, true)});
    }
    lineUp(indent);
    return node;
  }
  function seq(indent) {
    const node = {kind: 'seq', items: [], line: L[i].line};
    while (i < L.length && L[i].indent === indent && isItem(L[i].content)) {
      const l = structural(L[i]), after = l.content.slice(1), rest = after.trim();
      if (isItem(rest)) fail(l.line, 'a list written directly inside a list item');
      if (rest && splitKey(rest.replace(ANCHOR, ''), l.line)) {
        // `- key: value` opens a map whose keys sit at the column of `key`.
        const inner = indent + 1 + (after.length - after.trimStart().length);
        L[i] = {indent: inner, tab: false, content: rest.replace(ANCHOR, ''), line: l.line};
        node.items.push(map(inner));
        continue;
      }
      i++;
      node.items.push(valueAfter(rest, l, indent, false));
    }
    lineUp(indent);
    return node;
  }
  function block(indent) { return isItem(structural(L[i]).content) ? seq(indent) : map(indent); }
  const root = block(L[0].indent);
  if (i < L.length) fail(L[i].line, 'the indentation does not line up with a block above it');
  return root;
}

const INTERPOLATION = /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
const entryOf = (node, key) => (node?.kind === 'map' ? node.entries.find(e => e.key === key) : undefined);
const describe = node => (node.kind === 'opaque' ? node.what : node.kind === 'seq' ? 'a list' : node.kind === 'scalar' ? 'a plain value' : `a ${node.kind}`);

/** What a docker compose file declares. See the header: this reads a subset of YAML and says where it stopped. */
export function readCompose(text) {
  let root;
  try { root = parseYamlSubset(text); } catch (e) { return refused(e); }
  if (root.kind !== 'map') return {ok: false, why: 'the document is not a map'};
  const top = entryOf(root, 'services');
  if (top?.value.kind !== 'map') return {ok: false, why: 'no `services` map at the top level'};
  const unresolved = [], services = [];
  for (const e of top.value.entries) {
    const s = {name: e.key, line: e.line, image: null, build: null, depends_on: [], env_names: [], env_files: [], ports: [], interpolates: [], partial: false};
    services.push(s);
    const note = (key, line, why) => { unresolved.push({service: e.key, key, line, why}); s.partial = true; };
    if (e.value.kind === 'null') continue;
    if (e.value.kind !== 'map') { note(null, e.line, `the service is ${describe(e.value)}, not a map`); continue; }
    // Everything under the service: what was not read, and the host variables its values refer to.
    const names = new Set();
    const walk = (node, path) => {
      if (node.kind === 'opaque') note(path, node.line, `${node.what} is not read`);
      else if (node.kind === 'seq') for (const item of node.items) walk(item, path);
      else if (node.kind === 'scalar') for (const m of node.value.matchAll(INTERPOLATION)) names.add(m[1] ?? m[2]);
      else if (node.kind === 'map') {
        for (const en of node.entries) {
          const at = path ? `${path}.${en.key}` : en.key;
          if (en.key === '<<') note(at, en.line, 'a merge key: what it merges in is not read'); else walk(en.value, at);
        }
      }
    };
    walk(e.value, '');
    s.interpolates = [...names].sort();
    const field = key => { const en = entryOf(e.value, key); return en && en.value.kind !== 'null' && en.value.kind !== 'opaque' ? en : null; };
    const scalarOf = (node, key) => (node?.kind === 'scalar' ? node.value : null) ?? (node && node.kind !== 'null' && node.kind !== 'opaque' ? (note(key, node.line, `${describe(node)} where a plain value is expected`), null) : null);

    const image = field('image');
    if (image) s.image = scalarOf(image.value, 'image');
    const build = field('build');
    if (build?.value.kind === 'scalar') s.build = {context: build.value.value, dockerfile: null, target: null};
    else if (build?.value.kind === 'map') s.build = Object.fromEntries(['context', 'dockerfile', 'target'].map(k => [k, scalarOf(entryOf(build.value, k)?.value, `build.${k}`)]));
    else if (build) note('build', build.line, `${describe(build.value)} where a path or a map is expected`);

    const depends = field('depends_on');
    if (depends?.value.kind === 'map') s.depends_on = depends.value.entries.map(en => en.key);
    else if (depends?.value.kind === 'seq') s.depends_on = depends.value.items.map(it => scalarOf(it, 'depends_on')).filter(v => v !== null);
    else if (depends) note('depends_on', depends.line, `${describe(depends.value)} where a list or a map is expected`);

    // An environment entry is kept by NAME only; the value is read into memory by the subset reader and dropped here.
    const environment = field('environment');
    const envName = (name, line) => {
      if (!ENV_NAME.test(name)) note('environment', line, 'an entry whose name is not a plain variable name');
      else if (!s.env_names.includes(name)) s.env_names.push(name);
    };
    if (environment?.value.kind === 'map') for (const en of environment.value.entries) envName(en.key, en.line);
    else if (environment?.value.kind === 'seq') {
      for (const it of environment.value.items) {
        if (it.kind === 'scalar') envName(it.value.split('=')[0].trim(), it.line);
        else if (it.kind !== 'opaque') note('environment', it.line, `${describe(it)} where NAME or NAME=value is expected`);
      }
    } else if (environment) note('environment', environment.line, `${describe(environment.value)} where a list or a map is expected`);

    const envFile = field('env_file');
    if (envFile?.value.kind === 'scalar') s.env_files = [envFile.value.value];
    else if (envFile?.value.kind === 'seq') {
      for (const it of envFile.value.items) {
        const path = it.kind === 'map' ? scalarOf(entryOf(it, 'path')?.value, 'env_file') : scalarOf(it, 'env_file');
        if (path !== null) s.env_files.push(path); else if (it.kind === 'map' && !entryOf(it, 'path')) note('env_file', it.line, 'an entry with no path');
      }
    } else if (envFile) note('env_file', envFile.line, `${describe(envFile.value)} where a path or a list is expected`);

    const ports = field('ports');
    if (ports?.value.kind === 'seq') {
      for (const it of ports.value.items) {
        if (it.kind === 'scalar') s.ports.push(it.value);
        else if (it.kind === 'map') note('ports', it.line, 'a port written as a map is not read');
      }
    } else if (ports) note('ports', ports.line, `${describe(ports.value)} where a list is expected`);

    const ext = entryOf(e.value, 'extends');
    if (ext) note('extends', ext.line, 'extends another service: what it inherits is not read');
  }
  const include = entryOf(root, 'include');
  if (include) unresolved.push({service: null, key: 'include', line: include.line, why: 'includes other files: their services are not read'});
  unresolved.sort((a, b) => a.line - b.line);
  return {ok: true, services, unresolved};
}

// ---- GitHub workflow, by line ----------------------------------------------------------------------------------------------
const WORKFLOW_KEY = /^(\s*)((?:-\s+)*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:(?:\s+(.*))?$/;
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const BLOCK_SCALAR = /^([|>])(?:[+-]?[1-9]?|[1-9][+-]?)(?:\s+#.*)?$/;
/** A one-line YAML scalar: its text without quotes, and the comment after it. */
function scalarText(value) {
  const v = value.trim();
  if (v[0] === '"' || v[0] === "'") {
    const end = v.indexOf(v[0], 1);
    if (end > 0) { const rest = v.slice(end + 1).trim(); return {text: v.slice(1, end), comment: rest.startsWith('#') ? rest.slice(1).trim() : null}; }
  }
  const c = /(?:^|\s)#/.exec(v);
  return c ? {text: v.slice(0, c.index).trim(), comment: v.slice(c.index + c[0].length).trim()} : {text: v, comment: null};
}
/** The command word of a shell line: leading NAME=value words are passed over and never kept. */
function firstWord(textOfLine) {
  let t = textOfLine.trim();
  for (let a; (a = /^[A-Za-z_][A-Za-z0-9_]*=[^\s'"`$(]*\s+/.exec(t));) t = t.slice(a[0].length);
  const assigns = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
  if (assigns) return {first_word: `${assigns[1]}=`, assignment: true};
  return t ? {first_word: t.split(/\s+/)[0]} : null;
}
function usesOf(text, line, comment) {
  const more = comment ? {comment} : {};
  if (text.startsWith('./') || text.startsWith('../')) return {action: text, ref: null, line, kind: 'local', ...more};
  if (text.startsWith('docker://')) {
    const rest = text.slice('docker://'.length), at = rest.indexOf('@'), colon = rest.lastIndexOf(':');
    const cut = at >= 0 ? at : colon > rest.lastIndexOf('/') ? colon : -1;
    return {action: `docker://${cut < 0 ? rest : rest.slice(0, cut)}`, ref: cut < 0 ? null : rest.slice(cut + 1), line, kind: 'docker', ...more};
  }
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/([^@\s]+))?@(\S+)$/.exec(text);
  if (!m) return null;
  return {action: m[1], ref: m[3], line, kind: m[2]?.startsWith('.github/workflows/') ? 'workflow' : 'action', ...(m[2] ? {path: m[2]} : {}), ...more};
}

/** What a GitHub workflow file uses and runs, read by line. See the header: this is not a YAML parser. */
export function readWorkflow(text) {
  const src = String(text).replace(/^﻿/, '');
  const L = src.split('\n').map(l => l.replace(/\r$/, ''));
  const out = {ok: true, name: null, uses: [], node_versions: [], node_version_files: [], runs: [], unresolved: []};
  let jobs = false;
  const version = (value, line) => { if (value) out.node_versions.push({value, line, ...(value.includes('${{') ? {expression: true} : {})}); };
  for (let k = 0; k < L.length; k++) {
    if (/^\s*(#|$)/.test(L[k])) continue;
    const m = WORKFLOW_KEY.exec(L[k]);
    if (!m) continue;
    const column = m[1].length + m[2].length, key = m[3] ?? m[4] ?? m[5], line = k + 1, value = (m[6] ?? '').trim();
    const style = BLOCK_SCALAR.exec(value)?.[1];
    if (style) {
      // The block is every following line indented deeper than the key; nothing in it is a key of the workflow.
      let continued = false, paragraph = true, heredoc = null;
      for (k++; k < L.length; k++) {
        const body = L[k].trim();
        if (!body) { paragraph = true; continued = false; continue; }
        if (L[k].length - L[k].trimStart().length <= column) break;
        // The body of a here-document is input to the command above it, not commands.
        if (heredoc !== null) { if (body === heredoc) heredoc = null; continue; }
        const comment = body.startsWith('#');
        if (key === 'run' && style === '|' && !comment) heredoc = HEREDOC.exec(body)?.[2] ?? null;
        if (key === 'run' && !comment && (style === '|' ? !continued : paragraph)) { const w = firstWord(body); if (w) out.runs.push({line: k + 1, ...w, block: true}); }
        if (!comment) paragraph = false;
        continued = !comment && body.endsWith('\\');
      }
      k--;
      continue;
    }
    const {text: plain, comment} = scalarText(value);
    if (key === 'jobs' && column === 0) jobs = true;
    else if (key === 'name' && column === 0 && out.name === null && plain) out.name = plain;
    else if (key === 'uses' && plain) {
      const u = usesOf(plain, line, comment);
      if (u) out.uses.push(u); else out.unresolved.push({line, text: withoutCredentials(plain)});
    } else if (key === 'node-version-file' && plain) out.node_version_files.push({path: plain, line});
    else if (key === 'node-version') {
      if (plain.startsWith('[')) for (const item of plain.replace(/^\[|\]$/g, '').split(',')) version(scalarText(item).text, line);
      else if (plain) version(plain, line);
      else {
        // A list written under the key, one `- value` per line.
        for (let j = k + 1; j < L.length; j++) {
          if (/^\s*(#|$)/.test(L[j])) continue;
          const item = /^(\s*)-\s+(.+)$/.exec(L[j]);
          if (!item || item[1].length < column) break;
          version(scalarText(item[2]).text, j + 1);
        }
      }
    } else if (key === 'run' && plain) { const w = firstWord(plain); if (w) out.runs.push({line, ...w}); }
  }
  if (!jobs) return {ok: false, why: 'no `jobs:` at the top level: not a workflow file'};
  return out;
}
