// VERIFICATION AT A COMMIT as a graph source (Slice B, KB1; docs/knowledge-graph/slice-b.md "The extractors").
//
// Purpose   What the repository DECLARES about its own verification, at a commit: the test suites (through
//           scripts/test-gates/suites.mjs, the gate's own reading of package.json), the CI workflows' test commands
//           (suites.mjs workflowRuns), and the mutation runners' tables -- each mutation, the files it edits and the test
//           files that decide it. A registered extractor with a DECLARED basis: each fact is something a committed file
//           states (a script names its test files, a workflow names the script it runs, a runner names the tests that
//           must kill its mutation).
// Inputs    The repository root and a commit. Read from git's object store only (git.mjs); suites.mjs reads a SKELETON
//           of the commit (every path, empty except package.json files), never the working tree.
// Outputs   verificationSource(); verificationFacts(); mutationTable() (the text parser, exported for the tests).
// Facts     systems/suite/<id>              a suite: `depends-on` each test file it runs; `derived-from` the
//                                           package.json that declares it
//           systems/workflow/<file>         a workflow: its test commands; `depends-on` each suite whose script it runs;
//                                           `derived-from` its file
//           systems/mutation/<runner>#<id>  a mutation: `depends-on` each file it edits and each test file that decides
//                                           it; `derived-from` its runner
//           verifies                        a deciding test file `verifies` the file the mutation edits (the runner
//                                           declares that the test must fail when that file regresses)
//           A target or deciding test the tree does not hold is listed on the mutation as unresolved; a mutation none
//           of whose targets resolves is `unresolved`.
// Must never  IMPORT A MUTATION RUNNER: a runner starts its mutation run at import (no main guard), so it is read as
//           TEXT, never executed. Read the working tree. Claim a mutation was killed: a result is not in the repository.
import path from 'node:path';
import {entityId} from '../../../packages/graph/index.mjs';
import {suites as suitesOf, workflowRuns, workflowSteps} from '../../../scripts/test-gates/suites.mjs';
import {treeAt, blobsAt, skeletonAt, resolveCommit} from './git.mjs';
import {fileId, isTest} from './repo.mjs';

export const SOURCE_ID = 'ophanim.verification';
export const EXTRACTOR = 'ophanim.verification.extractor';
export const VERIFICATION_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
export const RUNNER = /\.mutate\.mjs$/;
export const suiteId = id => entityId({domain: 'systems', type: 'suite', key: id});
export const workflowId = file => entityId({domain: 'systems', type: 'workflow', key: file});
export const mutationId = (runner, id) => entityId({domain: 'systems', type: 'mutation', key: `${runner}#${id}`});
const bounded = (xs, n = 64) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const TEST_FILE = /\.test\.(mjs|js|cjs)$/;

// ---- the mutation table, read as text ------------------------------------------------------------------------------
// Adapted from pull request 70's `mutationTargets` (ophanim/graph/extract.mjs on branch ccr-3b496a5e-q1czrf, read only):
// its constants, its test-list tables and its `{id: '...'` chunking are taken; added here: the table is bounded to the
// MUTATIONS array, lists may span lines and spread each other, EVERY file a mutation edits is read (`file:`, `one(...)`
// and shared edit constants), helper calls that build a test path (`t('schema', ...)`) are evaluated, name patterns are
// kept apart from files, and a runner's default deciding tests (`m.tests ?? SUITES`, or its SUITE/SUITES) are applied to
// a mutation that names none -- and SAID so (`defaulted`).
const CONST = /\b([A-Z][A-Z0-9_]*)\s*=\s*(?:'([^'\n]+)'|`([^`\n]*)`)/g;
const LIST = /\b([A-Z][A-Z0-9_]*)\s*=\s*\[/g;
const OBJ = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{/g;
const HELPER = /\bconst\s+([a-z][\w]*)\s*=\s*\(?\s*([a-z]\w*)(?:\s*,\s*[a-z]\w*)*\s*\)?\s*=>\s*\[\s*(`[^`]*`|'[^']*'|[A-Z]\w*)/g;

/**
 * The runner's text with every comment blanked to spaces (newlines kept), string and template literals left as they are.
 * A quote inside a comment (`// the runner's ...`) would otherwise open a string for `balanced` and the chunking below
 * (coordinator fix at integration: the checkpoint runner read 16 of 20 mutations; lessons text-reader-misses-new-shape).
 */
function blankComments(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { const j = text.indexOf('\n', i); const end = j === -1 ? text.length : j; out += ' '.repeat(end - i); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); const end = j === -1 ? text.length : j + 2; out += text.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    out += c; i++;
  }
  return out;
}

/** The text from `open` (an opening bracket) to its match, skipping quoted strings; null when unbalanced. */
function balanced(text, open) {
  const close = {'[': ']', '{': '}', '(': ')'}[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i++; while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++; } continue; }
    if (c === text[open]) depth++;
    else if (c === close && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}
const strings = s => [...s.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => m[1].replace(/\\(.)/g, '$1'));

/**
 * The mutations a runner's SOURCE TEXT lists: {listed, mutations: [{id, what, files, tests, patterns, defaulted}]}.
 * Text only; nothing of the runner is executed. A mutation whose files this cannot read is still listed (files: []).
 */
export function mutationTable(source) {
  const text = blankComments(source);
  const startAt = text.search(/\bMUTATIONS\s*=\s*\[/);
  if (startAt === -1) return {listed: 0, mutations: []};
  const open = text.indexOf('[', startAt), region = balanced(text, open) ?? text.slice(open), head = text.slice(0, startAt);
  // Constants in source order: `NAME = 'text'`, and `NAME = `${OTHER}text`` whose every substitution is an earlier constant
  // (pantheon/tests/capability.mutate.mjs; coordinator fix at integration). One that substitutes anything else is not read.
  const consts = new Map();
  const tmpl = body => { let ok = true; const v = body.replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (_, k) => (consts.has(k) ? consts.get(k) : (ok = false, ''))); return ok && !v.includes('${') ? v : null; };
  for (const m of head.matchAll(CONST)) {
    const v = m[2] !== undefined ? m[2] : tmpl(m[3]);
    if (v !== null) consts.set(m[1], v);
  }
  // Lists `NAME = [...]` (multi-line, with spreads), objects `const T = {k: '^pattern' | ['file', ...]}`.
  const rawLists = new Map(), objects = new Map();
  for (const m of head.matchAll(LIST)) { const body = balanced(head, m.index + m[0].length - 1); if (body) rawLists.set(m[1], body); }
  for (const m of head.matchAll(OBJ)) {
    const body = balanced(head, m.index + m[0].length - 1);
    if (!body) continue;
    const o = new Map();
    for (const e of body.matchAll(/(\w+):\s*(\[[^\]]*\]|'(?:[^'\\\n]|\\.)*')/g)) o.set(e[1], e[2].startsWith('[') ? strings(e[2]) : strings(e[2])[0]);
    objects.set(m[1], o);
  }
  const listCache = new Map();
  const valueOf = (tok, depth = 0) => {
    if (depth > 8) return [];
    if (tok.startsWith("'")) return strings(tok);
    if (/^[A-Z]\w*\.\w+$/.test(tok)) { const [o, k] = tok.split('.'); const v = objects.get(o)?.get(k); return v === undefined ? [] : [v].flat(); }
    if (consts.has(tok)) return [consts.get(tok)];
    if (rawLists.has(tok)) {
      if (!listCache.has(tok)) { listCache.set(tok, []); listCache.set(tok, elements(rawLists.get(tok), depth + 1)); }
      return listCache.get(tok);
    }
    return [];
  };
  // Helpers that build a [file, pattern] pair: `const t = (file, pattern) => [`${T}${file}.test.mjs`, pattern]`.
  const helpers = new Map();
  for (const m of head.matchAll(HELPER)) helpers.set(m[1], {param: m[2], first: m[3]});
  const callOf = (name, args) => {
    const h = helpers.get(name);
    if (!h) return [];
    const arg = strings(args)[0] ?? '';
    // A helper whose first element is a CONSTANT (`t = pattern => [TEST, pattern]`, federation.mutate.mjs): the file is the
    // constant and every argument of the call is a pattern (coordinator fix at integration).
    if (/^[A-Z]\w*$/.test(h.first)) return [consts.get(h.first) ?? '', ...strings(args)];
    const first = h.first.startsWith("'") ? strings(h.first)[0]
      : h.first.slice(1, -1).replace(/\$\{(\w+)\}/g, (_, v) => (v === h.param ? arg : consts.get(v) ?? ''));
    return [first, ...strings(args).slice(1)];
  };
  // The values of a list literal's elements: strings, constants, spreads, `T.key` and helper calls (a call's
  // arguments are read to their balanced close, so a parenthesis inside a string argument does not end it).
  function elements(body, depth = 0) {
    const out = [], inner = body.slice(1, -1), TOKEN = /\.\.\.([A-Z]\w*)|([a-z]\w*)\(|'((?:[^'\\\n]|\\.)*)'|\b([A-Z]\w*(?:\.\w+)?)\b|`([^`\n]*)`/y;
    for (let i = 0; i < inner.length;) {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(inner);
      if (!m) { i++; continue; }
      if (m[1]) out.push(...valueOf(m[1], depth));
      else if (m[2]) {
        const args = balanced(inner, i + m[0].length - 1) ?? '()';
        out.push(...callOf(m[2], args));
        i += m[0].length - 1 + args.length;
        continue;
      } else if (m[3] !== undefined) out.push(m[3].replace(/\\(.)/g, '$1'));
      else if (m[4]) out.push(...valueOf(m[4], depth));
      else if (m[5] !== undefined) { const v = tmpl(m[5]); if (v !== null) out.push(v); }
      i = TOKEN.lastIndex;
    }
    return out;
  }
  // THE EDIT HELPER'S SHAPE, read from its own definition (coordinator fix at integration): most runners write
  // `one(FILE, from, to)`, but a runner may write `one(from, to, file = DEFAULT)` (packages/graph/tests/federation.mutate.mjs),
  // so the argument that names the file, and its default, come from `const one = (...) =>`, never from position alone.
  const sig = /\bconst\s+one\s*=\s*\(([^)]*)\)\s*=>/.exec(head);
  const params = sig ? sig[1].split(',').map(x => x.trim()) : [];
  const fileAt = Math.max(0, params.findIndex(x => /^file\b/.test(x)));
  const fileDefault = /=\s*([A-Z]\w*|'[^'\n]+')/.exec(params[fileAt] ?? '')?.[1] ?? null;
  // One JS argument at `i`: a string literal (with escapes), a constant or a bare word; returns [text, next index].
  const argAt = (t, i) => {
    while (/\s/.test(t[i] ?? '')) i++;
    const q = t[i];
    if (q === "'" || q === '"' || q === '`') { let j = i + 1; while (j < t.length && t[j] !== q) j += t[j] === '\\' ? 2 : 1; return [t.slice(i, j + 1), j + 1]; }
    const m = /^[\w.$]+/.exec(t.slice(i)); return m ? [m[0], i + m[0].length] : [null, i];
  };
  // The file each `one(...)` call in `t` edits.
  const oneFiles = t => {
    if (fileAt === 0) return [...t.matchAll(/\bone\(\s*([A-Z]\w*|'[^'\n]+')/g)].flatMap(x => valueOf(x[1]));
    const out = [];
    for (const m of t.matchAll(/\bone\(/g)) {
      let i = m.index + m[0].length, args = [], a;
      for (let k = 0; k <= fileAt; k++) { [a, i] = argAt(t, i); if (a === null) break; args.push(a); while (/\s/.test(t[i] ?? '')) i++; if (t[i] !== ',') break; i++; }
      const f = args[fileAt] ?? fileDefault;
      if (f && /^([A-Z]\w*|'[^'\n]+')$/.test(f)) out.push(...valueOf(f));
    }
    return out;
  };
  // Shared edits: `NAME = one(FILE, ...)` or `NAME = [one(FILE, ...), ...]`.
  const editFiles = new Map();
  for (const m of head.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*(\[\s*)?one\(/g)) {
    const at = m.index + m[0].length - 1, body = m[2] ? balanced(head, head.indexOf('[', m.index)) : balanced(head, at);
    if (body) editFiles.set(m[1], oneFiles(body));
  }
  // The runner's default deciding tests.
  const dflt = /\bm\.tests\s*\?\?\s*([A-Z]\w*)/.exec(text)?.[1] ?? (rawLists.has('SUITES') ? 'SUITES' : consts.has('SUITE') ? 'SUITE' : rawLists.has('SUITE') ? 'SUITE' : null);
  const defaults = dflt ? valueOf(dflt) : [];
  // A GENERATED FAMILY, expanded as text (never evaluated): `...['a', 'b'].map((x, i) => ({id: `K${i + 1}`, ...}))` is
  // one mutation per element, ids PREFIX1..PREFIXn, each with the body's files and tests. Blanked out of the region
  // after, so it is not read again as part of the entry before it.
  const FAMILY = /\.\.\.\[([^\]]*)\]\.map\(\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\(\{\s*id:\s*`([A-Za-z_]*)\$\{\s*\3\s*\+\s*1\s*\}`/g;
  const families = [];
  let rest = region;
  for (const m of region.matchAll(FAMILY)) {
    const open = m.index + m[0].lastIndexOf('({') + 1, body = balanced(region, open);   // region[open] is the object's `{`
    if (!body) continue;
    families.push({elements: strings(m[1]), param: m[2], prefix: m[4], body: body.slice(body.indexOf('`', body.indexOf('id:')) + 1).replace(/^[^`]*`/, '')});
    rest = rest.slice(0, m.index) + ' '.repeat(open + body.length - m.index) + rest.slice(open + body.length);
  }
  const chunks = [...rest.split(/\{\s*id:\s*'/).slice(1),
    ...families.flatMap(f => f.elements.map((el, i) => `${f.prefix}${i + 1}'${f.body.replace(/`([^`]*)`/g, (_, s) => `'${s.replace(new RegExp(`\\$\\{${f.param}\\}`, 'g'), el).replace(/'/g, "\\'")}'`)}`))];
  const mutations = [];
  for (const c of chunks) {
    const id = /^([A-Za-z0-9_.-]+)'/.exec(c)?.[1];
    if (!id) continue;
    const what = (/\bwhat:\s*'((?:[^'\\\n]|\\.)*)'/.exec(c)?.[1] ?? '').replace(/\\(.)/g, '$1');
    const files = new Set();
    for (const m of c.matchAll(/\bfile:\s*([A-Z]\w*|'[^'\n]+')/g)) for (const v of valueOf(m[1])) files.add(v);
    for (const v of oneFiles(c)) files.add(v);
    for (const m of c.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) for (const v of editFiles.get(m[1]) ?? []) files.add(v);
    const t = /\btests:\s*/.exec(c);
    let named = null;
    if (t) {
      const at = t.index + t[0].length;
      const spec = c[at] === '[' ? balanced(c, at) : /^[A-Z]\w*(?:\.\w+)?/.exec(c.slice(at))?.[0] ?? '';
      named = spec.startsWith('[') ? elements(spec) : valueOf(spec);
    }
    const all = named ?? defaults, testFiles = [...new Set(all.filter(x => TEST_FILE.test(x)))].sort();
    const patterns = [...new Set(all.filter(x => !TEST_FILE.test(x)))].sort();
    // Name patterns alone decide within the runner's own suite file(s).
    const deciding = testFiles.length ? testFiles : patterns.length ? [...new Set(defaults.filter(x => TEST_FILE.test(x)))].sort() : [];
    mutations.push({id, what: what.slice(0, 400), files: [...files].sort(), tests: deciding, patterns, defaulted: named === null || (!testFiles.length && patterns.length > 0)});
  }
  return {listed: chunks.length, mutations};
}

// ---- the facts ------------------------------------------------------------------------------------------------------
/** The verification facts of the repository at `commit`, as the extractor's drafts. */
export function verificationFacts(repo, commit) {
  const tree = treeAt(repo, commit), paths = new Set(tree.entries.map(e => e.path)), drafts = [];
  const ref = p => p;                                    // where, not which version (the observation carries that)
  // Suites and workflows through the gate's own reader, over a skeleton of the commit.
  const sk = skeletonAt(repo, commit, p => p === 'package.json' || p.endsWith('/package.json') || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  let suites, runs, steps;
  try {
    suites = suitesOf(sk.dir);
    runs = workflowRuns(sk.dir);
    steps = new Map([...new Set(runs.map(r => r.workflow))].map(w => [w, workflowSteps(blobsAt(repo, [tree.entries.find(e => e.path === `.github/workflows/${w}`).blob]).values().next().value.toString('utf8')).length]));
  } finally { sk.dispose(); }
  const rel = abs => path.relative(sk.dir, abs).split(path.sep).join('/');
  const byScript = new Map();
  for (const s of suites) {
    const files = s.files.map(rel).sort(), cwd = rel(s.cwd) || '.', declared = cwd === '.' ? 'package.json' : `${cwd}/package.json`;
    const missing = files.filter(f => !paths.has(f));
    drafts.push({entity: suiteId(s.id), ref: ref(declared), attributes: {id: s.id, label: s.label, script: s.script, package: s.pkg ?? null, cwd, flags: s.flags,
      patterns: s.patterns, files: files.length, declared_in: declared}});
    if (paths.has(declared)) drafts.push({type: 'derived-from', from: suiteId(s.id), to: fileId(declared), ref: ref(declared), attributes: {basis: 'the script that declares the suite'}});
    for (const f of files) if (!missing.includes(f)) drafts.push({type: 'depends-on', from: suiteId(s.id), to: fileId(f), ref: ref(declared), attributes: {basis: 'the suite runs this file'}});
    (byScript.get(s.script) ?? byScript.set(s.script, []).get(s.script)).push(s.id);
  }
  const byWorkflow = new Map();
  for (const r of runs) (byWorkflow.get(r.workflow) ?? byWorkflow.set(r.workflow, []).get(r.workflow)).push(r);
  for (const [w, rs] of [...byWorkflow].sort()) {
    const file = `.github/workflows/${w}`, suitesRun = [...new Set(rs.flatMap(r => byScript.get(r.script) ?? []))].sort();
    drafts.push({entity: workflowId(file), ref: ref(file), attributes: {file, steps: steps.get(w) ?? null,
      runs: bounded(rs.map(r => ({line: r.line, command: r.command, script: r.script}))), suites: suitesRun,
      other_scripts: [...new Set(rs.map(r => r.script).filter(s => s && !byScript.has(s)))].sort()}});
    drafts.push({type: 'derived-from', from: workflowId(file), to: fileId(file), ref: ref(file), attributes: {}});
    for (const s of suitesRun) drafts.push({type: 'depends-on', from: workflowId(file), to: suiteId(s), ref: ref(file), attributes: {basis: 'the workflow runs this suite\'s script'}});
  }
  // Mutation runners, read as text.
  const runners = tree.entries.filter(e => RUNNER.test(e.path));
  const text = blobsAt(repo, runners.map(e => e.blob)), verified = new Map();
  for (const r of runners) {
    const table = mutationTable(text.get(r.blob).toString('utf8')), ids = new Set();
    for (const m of table.mutations) {
      if (ids.has(m.id)) continue;                       // an id the text repeats (inside an edit's text) is read once
      ids.add(m.id);
      const files = m.files.filter(f => paths.has(f)), tests = m.tests.filter(f => paths.has(f));
      const unresolved = [...m.files.filter(f => !paths.has(f)), ...m.tests.filter(f => !paths.has(f))];
      const missing = [...(unresolved.length ? [`${unresolved.length} file(s) the runner names are not in the tree at this commit`] : []),
        ...(!m.files.length ? ['the runner text names no file this reader can resolve for this mutation'] : []),
        ...(!m.tests.length ? ['the runner text names no deciding test file for this mutation'] : [])];
      drafts.push({entity: mutationId(r.path, m.id), ref: ref(r.path), status: files.length ? 'unverified' : 'unresolved', missing_evidence: missing,
        attributes: {runner: r.path, id: m.id, what: m.what, files: m.files, tests: m.tests, patterns: bounded(m.patterns, 32), defaulted: m.defaulted,
          ...(unresolved.length ? {unresolved} : {}), result: null}});
      drafts.push({type: 'derived-from', from: mutationId(r.path, m.id), to: fileId(r.path), ref: ref(r.path), attributes: {basis: 'the runner lists this mutation'}});
      for (const f of new Set([...files, ...tests])) drafts.push({type: 'depends-on', from: mutationId(r.path, m.id), to: fileId(f), ref: ref(r.path),
        attributes: {role: [files.includes(f) ? 'target' : null, tests.includes(f) ? 'decides' : null].filter(Boolean).join('+')}});
      for (const t of tests) for (const f of files) if (t !== f && isTest(t)) {
        const k = `${t}\0${f}`;
        (verified.get(k) ?? verified.set(k, {test: t, file: f, mutations: []}).get(k)).mutations.push(`${r.path}#${m.id}`);
      }
    }
  }
  for (const v of [...verified.values()].sort((a, b) => (`${a.test}${a.file}` < `${b.test}${b.file}` ? -1 : 1))) {
    drafts.push({type: 'verifies', from: fileId(v.test), to: fileId(v.file), ref: ref(v.mutations[0].split('#')[0]),
      attributes: {basis: 'a mutation runner declares this test decides mutations of this file', mutations: bounded(v.mutations.sort(), 32)}});
  }
  return drafts;
}

/** The adapter: the repository's declared verification, at the commit `ref` names now (readAt: that commit's objects). */
export function verificationSource({repo, ref = 'HEAD', extractor = EXTRACTOR} = {}) {
  return {
    id: SOURCE_ID, extractor, ref: 'git',
    authority: 'the committed package.json scripts, CI workflows and mutation runners (read as text) at a commit',
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => verificationFacts(repo, version),
  };
}
