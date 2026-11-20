// THE CODE OF A COMMIT, LEXED: what a literal in it proves (Slice B2, KD2-1, KD2-2; docs/knowledge-graph/slice-b2.md).
//
// Purpose   The one reader the dependency sources share (packages.mjs imports, needs.mjs environment, paths and
//           literals): every code file of a commit (JavaScript and Python), lexed into its comments, its string and
//           template literals and a MASKED text (comments blanked; string, template and regular-expression contents
//           blanked, newlines kept), so a recognizer matches code and never text inside a string or a comment. Then the
//           RECOGNIZED CALLS AND READS, the only places where a literal proves a dependency (KD2-2):
//             an import or import() specifier;
//             process.env.NAME / process.env['NAME'] (JavaScript); os.environ['NAME'] / os.environ.get('NAME') /
//               os.getenv('NAME') (Python) -- the NAME only, never a value;
//             spawn, spawnSync, execFile, execFileSync, exec, execSync bound from node:child_process, with a literal
//               command (exec, execSync: its argv[0]); process.execPath, the running Node;
//             fetch, new URL, and http/https request and get, whose URL literal names the host;
//             an fs read, or path.join / resolve / dirname / new URL rooted at a KNOWN ROOT (the module's own file or
//               directory, import.meta, a constant built from them in this file or imported by name from a module that
//               builds one), that resolves to a tracked file of the commit.
//           Every other literal is at most a mention (needs.mjs literalsSource, a textual basis). A literal whose
//           recognized call cannot be resolved (a computed name, a substituted host, a path relative to the working
//           directory) is a GAP, counted with its line, never guessed.
// Inputs    The repository root and a commit (git.mjs: git's object store, never the working tree).
// Outputs   scanJs / scanPy (the lexers, exported for the tests); codeAt(repo, commit): per code file {path, lang, need,
//           imports, env, spawns, hosts, paths, gaps, comments, strings (not consumed by a recognized call)}; the id
//           helpers of the systems-domain types contract 1.2.0 adds; needOf (a test need or a run-time need).
// Must never  Read the working tree, an environment value or a withheld path; contact a host; evaluate code; record a
//           literal outside a recognized call as a dependency.
import path from 'node:path';
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, WITHHELD} from './git.mjs';
import {isTest} from './repo.mjs';

export const JS_CODE = /\.(mjs|js|cjs|mts|ts)$/;
export const PY_CODE = /\.py$/;
/**
 * A TEST need or a RUN-TIME need, by the path of the file that has it: a test file (`*.test.{mjs,js,cjs}`), a mutation
 * runner (`*.mutate.mjs`), or anything under a `test`, `tests`, `fixture` or `fixtures` directory is a test need.
 */
export const needOf = p => (isTest(p) || /\.mutate\.mjs$/.test(p) || /(^|\/)(tests?|fixtures?)\//.test(p) ? 'test' : 'run-time');

// ---- ids (contract 1.2.0 systems-domain types; and the registered ones the sources reuse) -----------------------------
export const npmPackageId = (name, version) => entityId({domain: 'systems', type: 'package', key: `npm/${name}@${version}`});
export const unresolvedPackageId = name => entityId({domain: 'systems', type: 'package', key: `npm/${name}`});
export const builtinId = name => entityId({domain: 'systems', type: 'package', key: `node/${name}`});
export const workspacePackageId = name => entityId({domain: 'systems', type: 'package', key: `workspace/${name}`});
export const envId = name => entityId({domain: 'systems', type: 'environment-variable', key: name});
export const executableId = name => entityId({domain: 'systems', type: 'executable', key: name});
export const hostId = host => entityId({domain: 'systems', type: 'host', key: host});
export const runtimeId = name => entityId({domain: 'capability', type: 'runtime', key: name});
export const repositoryId = name => entityId({domain: 'systems', type: 'repository', key: name});
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- the JavaScript lexer ---------------------------------------------------------------------------------------------
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Characters after which a `/` starts a regular expression (an operand cannot end there): ( , = : [ ! & | ? { } ; + - * % < > ~ ^
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^'].map(c => c.charCodeAt(0)));
const ESC = {n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0'};
const cook = raw => (raw.includes('\\') ? raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/gs, (_, e) => {
  if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
  if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
  if (e === '\n' || e === '\r\n') return '';
  return ESC[e] ?? e;
}) : raw);
const lineStarts = src => { const s = [0]; for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) s.push(i + 1); return s; };
const lineAtOf = starts => offset => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
const isIdent = c => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;
const isSpace = c => c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
const SQ = 39, DQ = 34, BT = 96, SL = 47, ST = 42, BS = 92, NL = 10, DOLLAR = 36, LB = 123, RB = 125, LSQ = 91, RSQ = 93;
const decoder = new TextDecoder('utf-16le');
/** A mask over `src`: blank(a, b) turns every character but a newline into a space; text() is the masked string. */
function masker(src) {
  const buf = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) buf[i] = src.charCodeAt(i);
  return {blank: (a, b) => { for (let k = a; k < b; k++) if (buf[k] !== NL) buf[k] = 32; }, text: () => decoder.decode(buf)};
}

/**
 * Lex JavaScript (or TypeScript, as text): {masked, strings: Map(offset of the opening quote -> {quote, value, head,
 * end}), comments: [{start, end, text}], lineAt(offset)}. A string's `value` is its cooked text; a template literal with
 * a substitution has `value: null` and `head`, its cooked text before the first `${`. Regular-expression literals are
 * recognized where an operand cannot end (their bodies are blanked like a string's, never read as code).
 */
export function scanJs(src) {
  const n = src.length, strings = new Map(), comments = [], mask = masker(src), stack = [];
  let i = 0, prevSig = 0, prevWord = '';
  // A template's text from `j` (just after its opening backtick, or after a substitution's closing brace).
  const templateFrom = (tpl, j) => {
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === BS) { k += 2; continue; }
      if (c === BT) { tpl.raw.push(src.slice(j, k)); mask.blank(j, k); tpl.end = k + 1; if (!tpl.subst) tpl.value = tpl.head = cook(tpl.raw.join('')); return k + 1; }
      if (c === DOLLAR && src.charCodeAt(k + 1) === LB) {
        tpl.raw.push(src.slice(j, k)); mask.blank(j, k);
        if (!tpl.subst) { tpl.subst = true; tpl.head = cook(tpl.raw.join('')); }
        stack.push({tpl, depth: 0});
        return k + 2;
      }
      k++;
    }
    mask.blank(j, n); tpl.end = n; tpl.value = null; tpl.head ??= cook(tpl.raw.join('')); return n;
  };
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); const end = e === -1 ? n : e; comments.push({start: 0, end, text: src.slice(0, end)}); mask.blank(0, end); i = end; }
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (isIdent(c)) { let j = i + 1; while (j < n && isIdent(src.charCodeAt(j))) j++; prevWord = src.slice(i, j); prevSig = 97; i = j; continue; }
    if (c === SL) {
      const d = src.charCodeAt(i + 1);
      if (d === SL) { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; comments.push({start: i, end, text: src.slice(i + 2, end)}); mask.blank(i, end); i = end; continue; }
      if (d === ST) { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; comments.push({start: i, end, text: src.slice(i + 2, Math.max(i + 2, end - 2))}); mask.blank(i, end); i = end; continue; }
      if (prevSig === 0 || REGEX_AFTER.has(prevSig) || KEYWORDS.has(prevWord)) {
        let j = i + 1, cls = false;
        while (j < n) {
          const x = src.charCodeAt(j);
          if (x === NL) break;
          if (x === BS) { j += 2; continue; }
          if (x === LSQ) cls = true; else if (x === RSQ) cls = false; else if (x === SL && !cls) break;
          j++;
        }
        if (src.charCodeAt(j) === SL) { mask.blank(i + 1, j); j++; while (j < n && isIdent(src.charCodeAt(j))) j++; i = j; prevSig = SL; prevWord = ''; continue; }
      }
    }
    if (c === SQ || c === DQ) {
      let j = i + 1;
      while (j < n) { const x = src.charCodeAt(j); if (x === c || x === NL) break; j += x === BS ? 2 : 1; }
      const stop = Math.min(j, n);
      strings.set(i, {quote: c === SQ ? "'" : '"', value: cook(src.slice(i + 1, stop)), head: null, end: Math.min(j + 1, n)});
      mask.blank(i + 1, stop); i = Math.min(j + 1, n); prevSig = c; prevWord = ''; continue;
    }
    if (c === BT) {
      const tpl = {quote: '`', value: null, head: null, end: null, raw: [], subst: false};
      strings.set(i, tpl);
      i = templateFrom(tpl, i + 1); prevSig = BT; prevWord = ''; continue;
    }
    if (stack.length && (c === LB || c === RB)) {
      const top = stack.at(-1);
      if (c === LB) top.depth++;
      else if (top.depth > 0) top.depth--;
      else { stack.pop(); i = templateFrom(top.tpl, i + 1); prevSig = BT; prevWord = ''; continue; }
    }
    prevSig = c; prevWord = ''; i++;
  }
  for (const s of strings.values()) { delete s.raw; delete s.subst; }
  return {lang: 'js', masked: mask.text(), strings, comments, lineAt: lineAtOf(lineStarts(src))};
}

/** Lex Python: comments (#), strings (prefixes, triple quotes; an f-string with a field is `value: null`), masked text. */
export function scanPy(src) {
  const n = src.length, strings = new Map(), comments = [], mask = masker(src);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; comments.push({start: i, end, text: src.slice(i + 1, end)}); mask.blank(i, end); i = end; continue; }
    const pre = (c === "'" || c === '"' || /[rRbBuUfF]/.test(c)) && (i === 0 || !isIdent(src.charCodeAt(i - 1))) ? /^([rRbBuUfF]{0,2})(['"])/.exec(src.slice(i, i + 4)) : null;
    if (pre) {
      const q = pre[2], at = i + pre[1].length, triple = src.startsWith(q.repeat(3), at), open = at + (triple ? 3 : 1);
      const close = triple ? q.repeat(3) : q, rawStr = /r/i.test(pre[1]), fstr = /f/i.test(pre[1]);
      let j = open;
      while (j < n && !src.startsWith(close, j) && (triple || src[j] !== '\n')) j += src[j] === '\\' && !rawStr ? 2 : 1;
      const body = src.slice(open, Math.min(j, n)), text = rawStr ? body : cook(body);
      const field = fstr ? text.search(/\{(?!\{)/) : -1;
      strings.set(at, {quote: q, value: field === -1 ? text : null, head: field === -1 ? text : text.slice(0, field), end: Math.min(j + close.length, n)});
      mask.blank(open, Math.min(j, n)); i = Math.min(j + close.length, n); continue;
    }
    i++;
  }
  return {lang: 'py', masked: mask.text(), strings, comments, lineAt: lineAtOf(lineStarts(src))};
}

// ---- recognizers ------------------------------------------------------------------------------------------------------
const ws = (t, i) => { while (i < t.length && /\s/.test(t[i])) i++; return i; };
/** The literal at `i` of the masked text (after whitespace): {at, value, head, end} or null. */
const literalAt = (scan, i) => { const at = ws(scan.masked, i), s = scan.strings.get(at); return s ? {at, ...s} : null; };

/** Every import of a JavaScript file: [{kind: static|export|side|dynamic, at, specifier (null: not a literal), clause}]. */
export function importsOf(scan) {
  const t = scan.masked, out = [];
  for (const m of t.matchAll(/(?<![\w$.])(import|export)\b(?!\s*\.\s*meta)/g)) {
    let i = ws(t, m.index + m[0].length);
    if (m[1] === 'import' && t[i] === '(') {
      const lit = literalAt(scan, i + 1);
      out.push({kind: 'dynamic', at: m.index, specifier: lit && lit.value !== null ? lit.value : null, literal: lit?.at ?? null, head: lit?.head ?? null});
      continue;
    }
    if (m[1] === 'import' && scan.strings.has(i)) { const s = scan.strings.get(i); out.push({kind: 'side', at: m.index, specifier: s.value, literal: i, clause: ''}); continue; }
    // `import CLAUSE from 'x'` / `export CLAUSE from 'x'`: the clause is a default name, a namespace or a braced list.
    const f = /^((?:type\s+)?(?:[\w$]+\s*(?:,\s*)?)?(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]*\})?)\s*from\s*(?=['"])/.exec(t.slice(i, i + 4000));
    if (!f || !f[1].trim()) continue;
    if (m[1] === 'export' && !/^\s*(\*|\{)/.test(f[1])) continue;
    const at = i + f[0].length, s = scan.strings.get(at);
    if (s) out.push({kind: m[1] === 'import' ? 'static' : 'export', at: m.index, specifier: s.value, literal: at, clause: f[1]});
  }
  return out;
}

/** The local names a file binds from module(s) `mods`: {named: Map(local -> imported), spaces: Set(local namespace/default)}. */
export function bindingsOf(imports, mods) {
  const named = new Map(), spaces = new Set();
  for (const im of imports) {
    if (im.kind !== 'static' || !mods.includes(im.specifier)) continue;
    const c = im.clause.replace(/^type\s+/, '');
    const def = /^([\w$]+)/.exec(c);
    if (def) spaces.add(def[1]);
    const ns = /\*\s*as\s+([\w$]+)/.exec(c);
    if (ns) spaces.add(ns[1]);
    const br = /\{([^}]*)\}/.exec(c);
    if (br) for (const part of br[1].split(',')) { const p = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part); if (p) named.set(p[2] ?? p[1], p[1]); }
  }
  return {named, spaces};
}
const FS = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'], CP = ['node:child_process', 'child_process'], PATH = ['node:path', 'path'];
const URLMOD = ['node:url', 'url'], HTTP = ['node:http', 'http', 'node:https', 'https'];
const SPAWN_API = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
const FS_READ = ['readFileSync', 'readFile', 'createReadStream', 'openSync', 'open'], FS_PROBE = ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'stat', 'access'];
const esc = s => s.replace(/[$]/g, '\\$');
/** Calls of `api` names bound from `mods` in this file: [{api, at (of the name), open (index after the parenthesis)}]. */
function callsOf(scan, imports, mods, apis) {
  const {named, spaces} = bindingsOf(imports, mods), t = scan.masked, out = [];
  const locals = [...named].filter(([, imp]) => apis.includes(imp));
  if (locals.length) for (const m of t.matchAll(new RegExp(`(?<![\\w$.])(${locals.map(([l]) => esc(l)).join('|')})\\s*\\(`, 'g'))) out.push({api: named.get(m[1]), at: m.index, open: m.index + m[0].length});
  if (spaces.size) for (const m of t.matchAll(new RegExp(`(?<![\\w$.])(${[...spaces].map(esc).join('|')})\\.(?:promises\\.)?(${apis.join('|')})\\s*\\(`, 'g'))) out.push({api: m[2], at: m.index, open: m.index + m[0].length});
  return out.sort((a, b) => a.at - b.at);
}

/** process.env reads, writes and deletes by NAME; computed and whole-environment uses as gaps. Never a value. */
export function envOf(scan) {
  const t = scan.masked, out = [], gaps = [], consumed = new Set();
  if (scan.lang === 'py') {
    for (const m of t.matchAll(/(?<![\w.])os\.(environ\s*\[|environ\.get\s*\(|getenv\s*\()/g)) {
      const lit = literalAt(scan, m.index + m[0].length);
      if (lit && lit.value !== null && ENV_NAME.test(lit.value)) { out.push({name: lit.value, op: 'read', api: `os.${m[1].replace(/\s/g, '')}`, line: scan.lineAt(m.index)}); consumed.add(lit.at); }
      else gaps.push({kind: 'environment', line: scan.lineAt(m.index), why: 'os.environ read with a computed name'});
    }
    return {env: out, gaps, consumed};
  }
  for (const m of t.matchAll(/(?<![\w$.])process\s*\.\s*env\b/g)) {
    let i = ws(t, m.index + m[0].length), name = null, end = i;
    if (t[i] === '.' && /[A-Za-z_$]/.test(t[ws(t, i + 1)] ?? '')) { const w = /^[\w$]+/.exec(t.slice(ws(t, i + 1))); name = w[0]; end = ws(t, i + 1) + w[0].length; }
    else if (t[i] === '[') {
      const lit = literalAt(scan, i + 1);
      if (lit && lit.value !== null && ENV_NAME.test(lit.value) && t[ws(t, lit.end)] === ']') { name = lit.value; end = ws(t, lit.end) + 1; consumed.add(lit.at); }
      else { gaps.push({kind: 'environment', line: scan.lineAt(m.index), why: 'process.env read with a computed name'}); continue; }
    } else { gaps.push({kind: 'environment', line: scan.lineAt(m.index), why: 'the whole environment (process.env) is used, not a variable by name'}); continue; }
    const after = t.slice(ws(t, end), ws(t, end) + 4), before = t.slice(Math.max(0, m.index - 12), m.index);
    const op = /\bdelete\s+$/.test(before) ? 'delete' : /^(=(?!=)|\?\?=|\|\|=|&&=|\+=)/.test(after) ? 'write' : 'read';
    out.push({name, op, api: 'process.env', line: scan.lineAt(m.index)});
  }
  return {env: out, gaps, consumed};
}

/** Programs run by a literal command through node:child_process; process.execPath as the running Node; the rest as gaps. */
export function spawnsOf(scan, imports) {
  const out = [], gaps = [], consumed = new Set(), t = scan.masked;
  if (scan.lang !== 'js') return {spawns: out, gaps, consumed};
  for (const c of callsOf(scan, imports, CP, SPAWN_API)) {
    const lit = literalAt(scan, c.open), line = scan.lineAt(c.at);
    if (lit && lit.value !== null) {
      const shell = c.api === 'exec' || c.api === 'execSync';
      const words = lit.value.trim().split(/\s+/), argv0 = shell ? words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) : lit.value.trim();
      if (argv0 && /^[\w./@+-]+$/.test(argv0)) { out.push({command: argv0, api: c.api, line}); consumed.add(lit.at); continue; }
    }
    if (/^\s*process\s*\.\s*execPath\b/.test(t.slice(c.open, c.open + 40))) { out.push({command: null, runtime: 'node', api: c.api, line}); continue; }
    gaps.push({kind: 'executable', line, why: `${c.api} of a command that is not a literal`});
  }
  return {spawns: out, gaps, consumed};
}

const URL_HOST = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)([:/?#]|$)/i;
/** The host a URL literal names, or null: the literal text must reach past the host (a substituted host is not named). */
export function hostOfUrl(value, {complete}) {
  const m = URL_HOST.exec(value ?? '');
  if (!m || !m[2] || (!complete && !m[3])) return null;
  return {scheme: m[1].toLowerCase(), host: m[2].toLowerCase()};
}
/** Hosts named by the URL literal of a recognized request (fetch, new URL, http/https request and get); gaps otherwise. */
export function hostsOf(scan, imports) {
  const out = [], gaps = [], consumed = new Set(), t = scan.masked;
  if (scan.lang !== 'js') return {hosts: out, gaps, consumed};
  const sites = [...[...t.matchAll(/(?<![\w$.])fetch\s*\(/g)].map(m => ({api: 'fetch', at: m.index, open: m.index + m[0].length})),
    ...[...t.matchAll(/(?<![\w$.])new\s+URL\s*\(/g)].map(m => ({api: 'new URL', at: m.index, open: m.index + m[0].length})),
    ...callsOf(scan, imports, HTTP, ['request', 'get']).map(c => ({...c, api: `http ${c.api}`}))];
  for (const s of sites) {
    const lit = literalAt(scan, s.open);
    if (!lit) { if (s.api !== 'new URL') gaps.push({kind: 'host', line: scan.lineAt(s.at), why: `${s.api} of a URL that is not a literal`}); continue; }
    const h = hostOfUrl(lit.value ?? lit.head, {complete: lit.value !== null});
    if (h && h.host) { out.push({...h, api: s.api, line: scan.lineAt(s.at)}); consumed.add(lit.at); }
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(lit.value ?? lit.head ?? '')) gaps.push({kind: 'host', line: scan.lineAt(s.at), why: `${s.api} of a URL whose host is substituted`});
  }
  return {hosts: out, gaps, consumed};
}

// ---- path expressions rooted at a known root ----------------------------------------------------------------------------
// A value: {kind: 'path' | 'url', p: a repository-relative POSIX path ('.' is the root), dir: whether it names a directory},
// or {kind: 'lit', s} for a string argument. `null`: not evaluable here (a variable, an absolute machine path, a path
// outside the repository): never guessed.
const inside = p => p !== '..' && !p.startsWith('../') && !path.posix.isAbsolute(p);
/** The path-expression evaluator of one file: eval(i) -> {value, end, lits (the string literals it read)} or null. */
function evaluator(scan, env) {
  const t = scan.masked;
  const ident = i => /^[A-Za-z_$][\w$]*/.exec(t.slice(i, i + 80))?.[0] ?? null;
  const nsCall = (i, mods, fns) => {
    const w = ident(i);
    if (!w) return null;
    const b = env.bind(mods);
    let j = i + w.length;
    if (t[j] === '.' && b.spaces.has(w)) { const f = ident(j + 1); if (f && fns.includes(f)) { j = ws(t, j + 1 + f.length); return t[j] === '(' ? {fn: f, open: j + 1} : null; } return null; }
    if (fns.includes(b.named.get(w))) { j = ws(t, j); return t[j] === '(' ? {fn: b.named.get(w), open: j + 1} : null; }
    return null;
  };
  const urlJoin = (base, spec) => {
    if (!base || base.kind !== 'url' || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('/')) return null;
    const dir = base.dir ? base.p : path.posix.dirname(base.p);
    const p = path.posix.normalize(path.posix.join(dir, spec.split(/[?#]/)[0]));
    return inside(p) ? {kind: 'url', p, dir: spec.endsWith('/') || /(^|\/)\.\.?$/.test(spec)} : null;
  };
  function evalAt(i0) {
    const lits = [];
    const suffix = (v, i) => {                                 // `.pathname` / `.href` after a URL value
      const m = /^\s*\.\s*(pathname|href)\b/.exec(t.slice(i, i + 20));
      if (!m) return {value: v, end: i};
      return {value: v && v.kind === 'url' ? (m[1] === 'pathname' ? {...v, kind: 'path'} : v) : null, end: i + m[0].length};
    };
    const args = (i, max) => {                                 // `a, b, ...)` from just after `(`
      const vals = [];
      i = ws(t, i);
      if (t[i] === ')') return {vals, end: i + 1};
      for (let k = 0; k < max; k++) {
        const v = expr(i);
        if (!v) return null;
        vals.push(v.value); i = ws(t, v.end);
        if (t[i] === ',') { i = ws(t, i + 1); if (t[i] === ')') return {vals, end: i + 1}; continue; }
        return t[i] === ')' ? {vals, end: i + 1} : null;
      }
      return null;
    };
    function expr(i) {
      i = ws(t, i);
      const s = scan.strings.get(i);
      if (s) { lits.push(i); return {value: s.value === null ? null : {kind: 'lit', s: s.value}, end: s.end}; }
      if (t.startsWith('import.meta.dirname', i)) return {value: {kind: 'path', p: path.posix.dirname(env.file), dir: true}, end: i + 19};
      if (t.startsWith('import.meta.url', i)) return suffix({kind: 'url', p: env.file, dir: false}, i + 15);
      const nu = /^new\s+URL\s*\(/.exec(t.slice(i, i + 20));
      if (nu) {
        const a = args(i + nu[0].length, 2);
        if (!a) return null;
        const [x, y] = a.vals;
        return suffix(a.vals.length === 2 && x?.kind === 'lit' ? urlJoin(y, x.s) : a.vals.length === 1 && x?.kind === 'url' ? x : null, a.end);
      }
      const p = nsCall(i, PATH, ['join', 'resolve', 'dirname']);
      if (p) {
        const a = args(p.open, 16);
        if (!a) return null;
        const [b, ...rest] = a.vals;
        if (p.fn === 'dirname') return {value: a.vals.length === 1 && b?.kind === 'path' ? {kind: 'path', p: path.posix.dirname(b.p), dir: true} : null, end: a.end};
        if (!b || b.kind !== 'path' || !rest.every(x => x?.kind === 'lit') || (p.fn === 'resolve' && rest.some(x => x.s.startsWith('/')))) return {value: null, end: a.end};
        const q = path.posix.normalize(path.posix.join(b.p, ...rest.map(x => x.s)));
        return {value: inside(q) ? {kind: 'path', p: q, dir: false} : null, end: a.end};
      }
      const u = nsCall(i, URLMOD, ['fileURLToPath', 'pathToFileURL']);
      if (u) {
        const a = args(u.open, 1);
        if (!a) return null;
        const v = a.vals[0];
        if (u.fn === 'fileURLToPath') return {value: v?.kind === 'url' ? {...v, kind: 'path'} : null, end: a.end};
        return suffix(v?.kind === 'path' ? {...v, kind: 'url'} : null, a.end);
      }
      const w = ident(i);
      if (w && env.roots.has(w) && !/^\s*[([]/.test(t.slice(i + w.length, i + w.length + 3))) return suffix(env.roots.get(w), i + w.length);
      return null;
    }
    const r = expr(i0);
    return r ? {...r, lits} : null;
  }
  return evalAt;
}
const bindingsMemo = imports => { const memo = new Map(); return mods => { const k = mods.join(); if (!memo.has(k)) memo.set(k, bindingsOf(imports, mods)); return memo.get(k); }; };
const DECL = /(?<![\w$.])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;

/**
 * The ROOT CONSTANTS of a JavaScript file: `const NAME = <a path expression>` whose value is the module's file or
 * directory, a path under it, or a constant imported by name (`importedRoots`). {roots: Map(local name -> value),
 * exported: Map(name -> value)}. In source order; a later declaration of the same name replaces an earlier one.
 */
export function rootsOf(scan, imports, {file, tracked, importedRoots = new Map()}) {
  const roots = new Map(importedRoots), exported = new Map(), t = scan.masked;
  if (scan.lang !== 'js') return {roots, exported, spans: []};
  const evalAt = evaluator(scan, {file, roots, bind: bindingsMemo(imports)}), spans = [];
  for (const m of t.matchAll(DECL)) {
    const r = evalAt(m.index + m[0].length);
    if (!r || !r.value || r.value.kind === 'lit') continue;
    const stop = ws(t, r.end);
    if (stop < t.length && !/[;,)}]/.test(t[stop]) && !t.slice(r.end, stop).includes('\n')) continue;
    const v = {...r.value, dir: r.value.dir || r.value.p === '.' || tracked.dirs.has(r.value.p)};
    roots.set(m[2], v);
    if (m[1]) exported.set(m[2], v);
    spans.push({at: m.index + m[0].length, end: r.end, lits: r.lits, value: v});
  }
  return {roots, exported, spans};
}

/**
 * The tracked files a JavaScript file names by a path rooted at a known root: [{target, how (read | probe | path), line}],
 * the gaps (an fs read of a path relative to the working directory, or of a path the tree does not hold), and the string
 * literals consumed (those inside a recognized read or a path expression that names a tracked file or a root).
 */
export function pathsOf(scan, imports, {file, tracked, roots, rootLits = []}) {
  const out = [], gaps = [], consumed = new Set(), t = scan.masked;
  if (scan.lang !== 'js') return {paths: out, gaps, consumed};
  const bind = bindingsMemo(imports), evalAt = evaluator(scan, {file, roots, bind});
  const named = v => v && (v.kind === 'path' || v.kind === 'url') && !v.dir && !tracked.dirs.has(v.p) && v.p !== '.';
  const record = (v, how, at) => {
    if (!named(v) || v.p === file || !tracked.files.has(v.p)) return false;
    out.push({target: v.p, how, line: scan.lineAt(at)});
    return true;
  };
  const spans = [];
  for (const c of callsOf(scan, imports, FS, [...FS_READ, ...FS_PROBE])) {
    const how = FS_READ.includes(c.api) ? 'read' : 'probe', r = evalAt(c.open);
    if (!r) continue;
    spans.push([c.open, r.end]);
    for (const l of r.lits) consumed.add(l);
    if (r.value?.kind === 'lit') { if (how === 'read' && !path.posix.isAbsolute(r.value.s)) gaps.push({kind: 'path', line: scan.lineAt(c.at), why: `${c.api} of a path relative to the working directory: not resolved`}); continue; }
    if (!record(r.value, how, c.at) && named(r.value) && how === 'read') gaps.push({kind: 'path', line: scan.lineAt(c.at), why: WITHHELD.test(r.value.p)
      ? `${c.api} of a withheld path (recorded review findings are counted, never read or named)` : `${c.api} of ${r.value.p}, which is not a tracked file at this commit`});
  }
  const within = i => spans.some(([a, b]) => i >= a && i < b);
  for (const m of t.matchAll(/(?<![\w$.])(?:new\s+URL\s*\(|(?:[A-Za-z_$][\w$]*\.)?(?:join|resolve|dirname|fileURLToPath|pathToFileURL)\s*\()/g)) {
    if (within(m.index)) continue;
    const r = evalAt(m.index);
    if (!r || !r.value || r.value.kind === 'lit') continue;
    spans.push([m.index, r.end]);
    if (record(r.value, 'path', m.index) || r.value.dir || r.value.p === '.') for (const l of r.lits) consumed.add(l);
  }
  // A root constant's own literals (`ROOT = path.resolve(HERE, '../..')`) are consumed: they build a root, not a mention.
  for (const l of rootLits) consumed.add(l);
  return {paths: out, gaps, consumed};
}

// ---- one commit's code, lexed and recognized once per process --------------------------------------------------------
const cache = new Map();
/**
 * Every code file of `commit` (JavaScript and Python; withheld paths are not in the tree), lexed and recognized:
 * {commit, tracked: {files, dirs}, files: [{path, lang, need, imports, env, spawns, hosts, paths, gaps, comments,
 * strings}]} where `strings` are the code's literals NOT consumed by a recognized call (the literals source's
 * candidates for a mention). Cached per commit, as git.mjs caches the tree and the blobs.
 */
export function codeAt(repo, commit) {
  const key = `${repo}\0${commit}`;
  if (cache.has(key)) return cache.get(key);
  const tree = treeAt(repo, commit);
  const files = new Set(tree.entries.map(e => e.path)), dirs = new Set();
  for (const p of files) { let d = path.posix.dirname(p); while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = path.posix.dirname(d); } }
  const tracked = {files, dirs};
  const code = tree.entries.filter(e => (JS_CODE.test(e.path) || PY_CODE.test(e.path)) && e.mode !== '120000');
  const bytes = blobsAt(repo, code.map(e => e.blob));
  const rows = code.map(e => {
    const text = bytes.get(e.blob).toString('utf8'), scan = PY_CODE.test(e.path) ? scanPy(text) : scanJs(text);
    return {path: e.path, lang: scan.lang, need: needOf(e.path), scan, imports: scan.lang === 'js' ? importsOf(scan) : [], importedRoots: new Map(), roots: null};
  });
  // Root constants exported by one module and imported BY NAME by another (a relative import): to a fixed point, so a
  // re-exported root reaches its importers. A root no module builds is never assumed.
  const importedFrom = r => {
    const imported = new Map();
    for (const im of r.imports) if (im.kind === 'static' && im.specifier?.startsWith('.')) {
      const theirs = byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(r.path), im.specifier)))?.roots?.exported;
      const br = /\{([^}]*)\}/.exec(im.clause ?? '');
      if (theirs?.size && br) for (const part of br[1].split(',')) { const p = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part); if (p && theirs.has(p[1])) imported.set(p[2] ?? p[1], theirs.get(p[1])); }
    }
    return imported;
  };
  const byPath = new Map(rows.map(r => [r.path, r]));
  for (const r of rows) r.roots = rootsOf(r.scan, r.imports, {file: r.path, tracked});
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const r of rows) {
      const imported = importedFrom(r);
      if (imported.size === r.importedRoots.size) continue;
      r.importedRoots = imported; changed = true;
      r.roots = rootsOf(r.scan, r.imports, {file: r.path, tracked, importedRoots: imported});
    }
    if (!changed) break;
  }
  const out = rows.map(r => {
    const env = envOf(r.scan), sp = spawnsOf(r.scan, r.imports), ho = hostsOf(r.scan, r.imports);
    const pa = pathsOf(r.scan, r.imports, {file: r.path, tracked, roots: r.roots.roots, rootLits: r.roots.spans.flatMap(s => s.lits)});
    const consumed = new Set([...r.imports.map(i => i.literal).filter(x => x !== null && x !== undefined), ...env.consumed, ...sp.consumed, ...ho.consumed, ...pa.consumed]);
    const strings = [...r.scan.strings].filter(([at]) => !consumed.has(at)).map(([at, s]) => ({at, line: r.scan.lineAt(at), value: s.value, head: s.head}));
    const gaps = [...env.gaps, ...sp.gaps, ...ho.gaps, ...pa.gaps];
    for (const im of r.imports) if (im.specifier === null && im.kind === 'dynamic') gaps.push({kind: 'import', line: r.scan.lineAt(im.at), why: 'import() of a specifier that is not a literal'});
    return {path: r.path, lang: r.lang, need: r.need, imports: r.imports.map(im => ({kind: im.kind, specifier: im.specifier, line: r.scan.lineAt(im.at)})),
      env: env.env, spawns: sp.spawns, hosts: ho.hosts, paths: pa.paths, gaps, comments: r.scan.comments.map(c => ({text: c.text, line: r.scan.lineAt(c.start)})), strings};
  });
  const result = Object.freeze({commit, tracked, files: out});
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

/** Group recognized occurrences into one relationship per (from, to): their lines (bounded) and the distinct values of `keys`. */
export function grouped(rows, keyOf, keys = []) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, {first: r, lines: [], ...Object.fromEntries(keys.map(x => [x, new Set()]))});
    const g = m.get(k);
    if (!g.lines.includes(r.line)) g.lines.push(r.line);
    for (const x of keys) if (r[x] !== undefined && r[x] !== null) g[x].add(r[x]);
  }
  return [...m.values()].map(g => ({...g, lines: g.lines.sort((a, b) => a - b).slice(0, 16), ...Object.fromEntries(keys.map(x => [x, [...g[x]].sort()]))}));
}
