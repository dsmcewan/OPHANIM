// WHAT THE CODE NEEDS FROM ITS ENVIRONMENT, AT A COMMIT, as three graph sources (Slice B2, KD2-1 to KD2-3;
// docs/knowledge-graph/slice-b2.md).
//
// Purpose   From the code of a commit, lexed once (code.mjs), what a literal PROVES and what it only names:
//   ophanim.environment  STRUCTURAL: environment variables read or set BY NAME (never a value: no extractor reads one);
//                        programs run by a literal command; the running Node (process.execPath); network hosts named by
//                        the URL literal of a recognized request. Read with `consumes`; set or deleted with `produces`
//                        (the variable is the handoff to a child); a program, a host or the runtime with `depends-on`.
//   ophanim.paths        STRUCTURAL: tracked files read by path rather than imported -- an fs read or probe, or a path
//                        built from a known root (code.mjs pathsOf), that resolves to a file of the commit: `consumes`.
//   ophanim.literals     TEXTUAL: every other literal that names a variable the code reads somewhere, a URL's host or a
//                        tracked path -- in a comment, or in a string outside any recognized call -- is a `mentions`,
//                        never a dependency (the registry admits nothing else from a textual basis).
//           Each fact carries the file and the lines it was read from, and whether it is a TEST need (a test file, a
//           mutation runner, a fixture: code.mjs needOf) or a RUN-TIME need; the two are never merged. A recognized
//           call that cannot be resolved (a computed name, a substituted host, a path relative to the working
//           directory) is a gap on the file's node, with its line.
// Inputs    The repository root and a commit (git.mjs; never the working tree).
// Facts     systems/environment-variable/<NAME>, systems/executable/<command>, systems/host/<host>,
//           capability/runtime/node; consumes, produces, depends-on (environment); consumes (paths); mentions (literals).
// Must never  Read an environment value, a secret or a key file; contact a host; read the working tree; record a
//           literal outside a recognized call as a dependency; merge test needs into run-time needs.
import {resolveCommit} from './git.mjs';
import {fileId} from './repo.mjs';
import {codeAt, grouped, envId, executableId, hostId, runtimeId, hostOfUrl, ENV_NAME} from './code.mjs';

export const ENVIRONMENT_SOURCE = 'ophanim.environment';
export const ENVIRONMENT_EXTRACTOR = 'ophanim.environment.extractor';
export const ENVIRONMENT_ORIGIN = Object.freeze({kind: 'extractor', basis: 'structural', sources: [ENVIRONMENT_SOURCE]});
export const PATHS_SOURCE = 'ophanim.paths';
export const PATHS_EXTRACTOR = 'ophanim.paths.extractor';
export const PATHS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'structural', sources: [PATHS_SOURCE]});
export const LITERALS_SOURCE = 'ophanim.literals';
export const LITERALS_EXTRACTOR = 'ophanim.literals.extractor';
export const LITERALS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'textual', sources: [LITERALS_SOURCE]});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const gapNode = (file, key, list, what) => ({entity: fileId(file), ref: file,
  attributes: {[key]: list.slice(0, 16).map(g => ({line: g.line, why: g.why})), [`${key}_count`]: list.length},
  missing_evidence: [`${list.length} ${what} of this file not resolved here (each with its line)`]});

/** The environment facts of `commit`: variables by name, programs, the runtime, hosts; gaps on the file's node. */
export function environmentFacts(repo, commit) {
  const code = codeAt(repo, commit), drafts = [], reads = [], writes = [], programs = [], runtime = [], hosts = [];
  const vars = new Set(), exes = new Set(), named = new Set();
  for (const f of code.files) {
    for (const e of f.env) { vars.add(e.name); (e.op === 'read' ? reads : writes).push({...e, from: f.path, need: f.need}); }
    for (const s of f.spawns) { if (s.command) { exes.add(s.command); programs.push({...s, from: f.path, need: f.need}); } else runtime.push({...s, from: f.path, need: f.need}); }
    for (const h of f.hosts) { named.add(h.host); hosts.push({...h, from: f.path, need: f.need}); }
  }
  for (const v of [...vars].sort()) drafts.push({entity: envId(v), ref: 'process.env', attributes: {name: v}});
  for (const x of [...exes].sort()) drafts.push({entity: executableId(x), ref: 'node:child_process', attributes: {name: x}});
  for (const h of [...named].sort()) drafts.push({entity: hostId(h), ref: 'a URL literal', attributes: {host: h}});
  if (runtime.length) drafts.push({entity: runtimeId('node'), ref: 'process.execPath', attributes: {name: 'node'}});
  // One relationship per (file, target, need): a test need and a run-time need are never one fact.
  const rel = (type, rows, to, basis, keys) => {
    for (const g of grouped(rows, r => `${r.from}\0${to(r)}`, keys)) {
      drafts.push({type, from: fileId(g.first.from), to: to(g.first), ref: g.first.from,
        attributes: {basis, need: g.first.need, lines: g.lines, ...Object.fromEntries(keys.map(k => [`${k}s`, g[k]]))}});
    }
  };
  rel('consumes', reads, r => envId(r.name), 'reads it by name (never its value)', ['api']);
  rel('produces', writes, r => envId(r.name), 'sets or deletes it by name', ['op']);
  rel('depends-on', programs, r => executableId(r.command), 'runs it by a literal command', ['api']);
  rel('depends-on', runtime, () => runtimeId('node'), 'runs the running Node (process.execPath)', ['api']);
  rel('depends-on', hosts, r => hostId(r.host), 'a request URL literal names it (never contacted)', ['api', 'scheme']);
  for (const f of code.files) {
    const gaps = f.gaps.filter(g => ['environment', 'executable', 'host'].includes(g.kind));
    if (gaps.length) drafts.push(gapNode(f.path, 'environment_gaps', gaps, 'environment uses (a computed name, the whole environment, a computed command or host)'));
  }
  return drafts;
}

/** The files read by path at `commit`: consumes, with how (read, probe, path) and the lines; gaps on the file's node. */
export function pathsFacts(repo, commit) {
  const code = codeAt(repo, commit), drafts = [], rows = [];
  for (const f of code.files) for (const p of f.paths) rows.push({...p, from: f.path, need: f.need});
  for (const g of grouped(rows, r => `${r.from}\0${r.target}`, ['how'])) {
    drafts.push({type: 'consumes', from: fileId(g.first.from), to: fileId(g.first.target), ref: g.first.from,
      attributes: {basis: 'a path from a known root', need: g.first.need, lines: g.lines, how: g.how}});
  }
  for (const f of code.files) {
    const gaps = f.gaps.filter(g => g.kind === 'path');
    if (gaps.length) drafts.push(gapNode(f.path, 'path_gaps', gaps, 'fs read(s)'));
  }
  return drafts;
}

// What a comment or a free literal NAMES: a variable the code reads somewhere (by name, as `process.env.NAME`,
// `os.environ`, `$NAME` or the bare name), a URL's host, a tracked path.
const URLS = /\b(?:https?|wss?):\/\/[^\s'"`<>()]+/gi;
const PATHISH = /(?<![\w./@-])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g;
const ENV_FORMS = /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])|\bos\.(?:environ\s*\[\s*|environ\.get\(\s*|getenv\(\s*)['"]([A-Za-z_][A-Za-z0-9_]*)['"]|\$\{?([A-Z_][A-Z0-9_]{2,})\b/g;
const WORDS = /\b[A-Z_][A-Z0-9_]{2,}\b/g;

/** The mentions of `commit` (textual): what comments and free literals name, never a dependency. */
export function literalsFacts(repo, commit) {
  const code = codeAt(repo, commit), tracked = code.tracked.files, drafts = [], rows = [];
  const known = new Set(code.files.flatMap(f => f.env.map(e => e.name)));
  const envs = new Set(), hosts = new Set();
  for (const f of code.files) {
    const add = (to, kind, line) => { if (to !== fileId(f.path)) rows.push({from: f.path, to, in: kind, line}); };
    const fromText = (text, kind, line) => {
      for (const m of text.matchAll(ENV_FORMS)) { const n = m[1] ?? m[2] ?? m[3] ?? m[4]; if (ENV_NAME.test(n) && (m[4] === undefined || known.has(n))) { envs.add(n); add(envId(n), kind, line); } }
      for (const m of text.matchAll(WORDS)) if (known.has(m[0])) { envs.add(m[0]); add(envId(m[0]), kind, line); }
      for (const m of text.matchAll(URLS)) { const h = hostOfUrl(m[0], {complete: true}); if (h?.host && !h.host.includes('$')) { hosts.add(h.host); add(hostId(h.host), kind, line); } }
      for (const m of text.matchAll(PATHISH)) { const p = m[1].replace(/^\.\//, ''); if (tracked.has(p)) add(fileId(p), kind, line); }
    };
    for (const c of f.comments) {
      const lines = c.text.split('\n');
      lines.forEach((l, i) => fromText(l, 'comment', c.line + i));
    }
    for (const s of f.strings) {
      const v = s.value ?? s.head ?? '';
      if (!v) continue;
      if (tracked.has(v)) add(fileId(v), 'string', s.line);
      else if (known.has(v)) { envs.add(v); add(envId(v), 'string', s.line); }
      else { const h = hostOfUrl(v, {complete: s.value !== null}); if (h?.host) { hosts.add(h.host); add(hostId(h.host), 'string', s.line); } }
    }
  }
  for (const v of [...envs].sort()) drafts.push({entity: envId(v), ref: 'a mention', attributes: {name: v}});
  for (const h of [...hosts].sort()) drafts.push({entity: hostId(h), ref: 'a mention', attributes: {host: h}});
  for (const g of grouped(rows, r => `${r.from}\0${r.to}`, ['in'])) {
    drafts.push({type: 'mentions', from: fileId(g.first.from), to: g.first.to, ref: g.first.from,
      attributes: {basis: 'a mention (a comment or a free literal), never a dependency', in: g.in, lines: g.lines}});
  }
  return drafts.sort((a, b) => byString(a.entity ?? '', b.entity ?? ''));
}

const adapter = (id, extractor, authority, facts, repo, ref) => ({id, extractor, ref: 'git', authority,
  current: () => ({version: resolveCommit(repo, ref)}), readAt: version => facts(repo, version)});
/** The adapter of the code's environment needs at the commit `ref` names now. */
export function environmentSource({repo, ref = 'HEAD', extractor = ENVIRONMENT_EXTRACTOR} = {}) {
  return adapter(ENVIRONMENT_SOURCE, extractor, 'the committed code: variable names, commands, request URLs (no value read, no host contacted)',
    environmentFacts, repo, ref);
}
/** The adapter of the files the code reads by path at the commit `ref` names now. */
export function pathsSource({repo, ref = 'HEAD', extractor = PATHS_EXTRACTOR} = {}) {
  return adapter(PATHS_SOURCE, extractor, 'the committed code: files read by a path from a known root', pathsFacts, repo, ref);
}
/** The adapter of the code's mentions (comments and free literals) at the commit `ref` names now. */
export function literalsSource({repo, ref = 'HEAD', extractor = LITERALS_EXTRACTOR} = {}) {
  return adapter(LITERALS_SOURCE, extractor, 'the committed code\'s comments and free literals (textual)', literalsFacts, repo, ref);
}
