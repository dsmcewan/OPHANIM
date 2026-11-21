// THE PYTHON READER of the dependency sources: one Python file's text -> what the file needs, each with its line.
//
// Purpose   The code reader (deps/parse.mjs) parses JavaScript and TypeScript with a real parser. The sibling
//           repositories also hold Python, and this repository has no Python parser and must not gain a dependency. This
//           is a LINE-AND-TOKEN reader, NOT a Python parser: it splits the text into tokens (names, strings, brackets,
//           logical lines), so that a comment, a string, a docstring or a triple-quoted block is never mistaken for
//           code, and then recognises a small set of written forms. It returns the shape readCode returns, so a source
//           can use either reader.
// Inputs    The file's text and its path (kept for symmetry with readCode; this reader does not use it).
// Outputs   readPython(text, {file}) -> {ok: true, imports, env, programs, reads, writes, hosts, strings, functions,
//           module_calls, unresolved: {programs, reads, env}} or {ok: false, why, ...empty lists}.
//             imports    {specifier, line, kind: 'static', names, default: false, namespace, level[, conditional: true]}
//                        `import a.b as c` -> a.b, namespace; `from a.b import c, d as e` -> a.b, names [c, d];
//                        `level` is the number of leading dots of a relative import (specifier may then be '').
//                        `conditional` marks an import that is indented or follows a block header on its line.
//             env        {name, line[, assigned: true]}: os.environ['X'] (assigned when it is the target of `=`),
//                        os.environ.get/pop/setdefault('X'...), os.getenv('X'...), under any alias the file imports.
//             programs   {name, line, call}: subprocess.run|call|check_call|check_output|Popen and os.system, given a
//                        literal list or tuple (its first element) or a literal string (its first word).
//             reads, writes  {path, line, call, relative}: open('literal'[, 'mode']) by its mode, and
//                        Path('literal').read_text()/read_bytes()/write_text()/write_bytes() in one expression.
//             hosts      {host, line}: the host of each http(s) URL inside a string literal (parse.mjs HOST).
//             strings    {value, line}: path-like string literals (parse.mjs PATHLIKE: a `/` or a short extension).
//             functions  {name, line, exported, calls: []}: `def` and `class` at column 0; exported unless the name
//                        starts with `_`. `calls` and `module_calls` are always empty: CALL RESOLUTION IS NOT ATTEMPTED
//                        for Python (it needs scopes and types a token reader does not have).
// Invariants  A line is the 1-based line the thing is written on (a statement over several lines: its first; a URL
//           inside a multi-line string: the line of the URL). What is seen and cannot be resolved is COUNTED in
//           `unresolved` ({line, call}), never guessed. An environment variable is its name; no value, default or
//           literal beside it is kept, and a literal that is not a valid name is counted without being kept.
// What it misses (it is not a parser)
//           - Scope. A name imported anywhere in the file is bound for the whole file; a parameter or an assignment
//             that rebinds it is not seen (only a `def`/`class` of that name, or two different imports of it, unbind it).
//           - Anything reached through a variable: `p = Path('x'); p.read_text()`, `cmd = ['git']; run(cmd)`,
//             `env = os.environ; env['X']` are counted as unresolved or not seen at all, never followed.
//           - Dynamic imports (importlib.import_module, __import__), `__all__`, star-import bindings, `'X' in os.environ`,
//             os.popen / os.exec* / os.spawn* / asyncio subprocesses, Path.open, shutil and every other way to touch a
//             file or run a program than the forms listed above. A write to a computed path is not counted (as in
//             parse.mjs, only reads are).
//           - Every `.read_text(` / `.read_bytes(` on something other than a literal Path is counted as an unresolved
//             read, whatever the receiver is (the reader cannot know it is a path).
//           - A string that is a whole statement (a docstring) is treated as a comment: no host or path is read from it.
//           - Escapes other than \\ \' \" \n \t \r and a continued line are left as written in a string's value.
//           - Python 2 syntax and syntax errors are not diagnosed; only unclosed strings, unbalanced brackets and an
//             import statement that cannot be read refuse the file.
// Must never  Run the file, import it, open another file, or report a reading of a file it refused.

// The same expressions as parse.mjs (not exported there; importing that module would load the TypeScript parser).
const HOST = /https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})(?![a-z0-9.-])/gi;
const PATHLIKE = /^[\w@.~-]+(?:\/[\w@.~-]+)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STRING_PREFIX = /^(?:[rubft]|[bft]r|r[bft])$/i;
const ENV_CALLS = new Set(['os.environ.get', 'os.environ.pop', 'os.environ.setdefault', 'os.getenv']);
const PROGRAM_CALLS = new Set(['subprocess.run', 'subprocess.call', 'subprocess.check_call', 'subprocess.check_output', 'subprocess.Popen', 'os.system']);
const PATH_READS = new Set(['read_text', 'read_bytes']);
const PATH_WRITES = new Set(['write_text', 'write_bytes']);
// A line that starts with one of these may carry its block on the same line, after the header's colon.
const HEADERS = new Set(['if', 'elif', 'else', 'try', 'except', 'finally', 'for', 'while', 'with', 'def', 'class', 'async', 'match', 'case']);
const CLOSES = {')': '(', ']': '[', '}': '{'};
const ESCAPES = {n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"'};
const empty = () => ({imports: [], env: [], programs: [], reads: [], writes: [], hosts: [], strings: [], functions: [], module_calls: [],
  unresolved: {programs: [], reads: [], env: []}});

class Refusal extends Error {}
const refuse = why => { throw new Refusal(why); };
const decode = raw => raw.replace(/\\(\r?\n|[\s\S])/g, (whole, c) => (c.endsWith('\n') ? '' : ESCAPES[c] ?? whole));
const isIdStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c > '\x7f';
const isDigit = c => c >= '0' && c <= '9';

/**
 * The file's tokens, in order: {t: 'name'|'num'|'op'|'str'|'fstr'|'nl', v, line, col}. A `nl` ends a logical line (a
 * newline outside every bracket). A string is one token whatever it spans; an f-string with replacement fields is one
 * `fstr` token carrying its literal pieces and the tokens of each field's expression.
 */
function tokenize(src) {
  const n = src.length;
  let i = 0, line = 1, lineStart = 0;
  const newline = () => { line++; lineStart = i + 1; };

  function string(prefix) {
    const q = src[i], startLine = line, col = i - lineStart - prefix.length;
    const triple = src.startsWith(q.repeat(3), i), close = triple ? q.repeat(3) : q;
    const raw = /r/.test(prefix), fields = /[ft]/.test(prefix), bytes = /b/.test(prefix);
    const unclosed = () => refuse(triple ? `the triple-quoted string opened on line ${startLine} is never closed`
      : `the string opened on line ${startLine} is not closed on that line`);
    i += close.length;
    const pieces = [], exprs = [];
    let from = i, fromLine = line;
    const flush = () => { pieces.push({raw: src.slice(from, i), line: fromLine}); };
    for (;;) {
      if (i >= n) unclosed();
      const c = src[i];
      if (c === '\\') {
        // A raw string keeps the backslash, but a backslash still hides the quote after it.
        if (fields && !raw && src[i + 1] === 'N' && src[i + 2] === '{') { const end = src.indexOf('}', i); if (end < 0) unclosed(); i = end + 1; continue; }
        if (src[i + 1] === '\r' && src[i + 2] === '\n') i++;
        if (src[i + 1] === '\n') { i++; newline(); i++; continue; }
        i += raw && fields && src[i + 1] !== q ? 1 : 2;
        continue;
      }
      if (c === '\n') { if (!triple) unclosed(); newline(); i++; continue; }
      if (src.startsWith(close, i)) break;
      if (fields && c === '{') {
        if (src[i + 1] === '{') { i += 2; continue; }
        flush(); i++;
        field(exprs, startLine);
        from = i; fromLine = line;
        continue;
      }
      i++;
    }
    flush();
    i += close.length;
    if (exprs.length) return {t: 'fstr', pieces, exprs, line: startLine, col};
    const text = pieces[0].raw, plain = fields ? text.replace(/\{\{/g, '{').replace(/\}\}/g, '}') : text;
    return {t: 'str', v: raw ? plain : decode(plain), raw: text, bytes, line: startLine, col};
  }

  // One replacement field of an f-string, from just after its `{` to just after its `}`: the expression's tokens, an
  // optional conversion, and a format spec that may itself hold fields.
  function field(exprs, startLine) {
    const never = () => refuse(`the replacement field of the f-string opened on line ${startLine} is never closed`);
    exprs.push(code(true));
    if (src[i] === '!') { i++; while (i < n && /[a-z]/.test(src[i])) i++; }
    if (src[i] === ':') {
      i++;
      while (i < n && src[i] !== '}') {
        if (src[i] === '{') { i++; field(exprs, startLine); continue; }
        if (src[i] === '\n') newline();
        i++;
      }
    }
    if (src[i] !== '}') never();
    i++;
  }

  // Code, to the end of the text or (inside a replacement field) to the `}`, `:` or `!` that ends its expression.
  function code(inField) {
    const out = [], stack = [];
    const push = (t, v, at) => { out.push({t, v, line, col: at - lineStart}); };
    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        if (!inField && !stack.length && out.length && out.at(-1).t !== 'nl') push('nl', '\n', i);
        newline(); i++; continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '\\') {
        if (src[i + 1] === '\r' && src[i + 2] === '\n') i++;
        if (src[i + 1] === '\n') { i++; newline(); i++; continue; }
        push('op', c, i); i++; continue;
      }
      if (c === '"' || c === "'") { out.push(string('')); continue; }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && (isIdStart(src[j]) || isDigit(src[j]))) j++;
        const word = src.slice(i, j);
        if ((src[j] === '"' || src[j] === "'") && STRING_PREFIX.test(word)) { i = j; out.push(string(word.toLowerCase())); continue; }
        push('name', word, i); i = j; continue;
      }
      if (isDigit(c)) {
        let j = i + 1;
        while (j < n && (isIdStart(src[j]) || isDigit(src[j]) || (src[j] === '.' && isDigit(src[j + 1] ?? '')))) j++;
        push('num', src.slice(i, j), i); i = j; continue;
      }
      if (c === '(' || c === '[' || c === '{') stack.push({c, line});
      else if (c === ')' || c === ']' || c === '}') {
        if (inField && !stack.length && c === '}') return out;
        const open = stack.pop();
        if (!open) refuse(`line ${line}: "${c}" closes nothing`);
        if (open.c !== CLOSES[c]) refuse(`line ${line}: "${c}" closes the "${open.c}" opened on line ${open.line}`);
      } else if (inField && !stack.length && (c === ':' || (c === '!' && src[i + 1] !== '='))) return out;
      push('op', c, i); i++;
    }
    if (stack.length) refuse(`the "${stack.at(-1).c}" opened on line ${stack.at(-1).line} is never closed`);
    return out;
  }
  return code(false);
}

const isOp = (tok, v) => tok?.t === 'op' && tok.v === v;
const isName = (tok, v) => tok?.t === 'name' && (v === undefined || tok.v === v);
/** A string literal a path, a program or a variable name can be read from (bytes and f-strings with fields are not). */
const literal = tok => (tok?.t === 'str' && !tok.bytes ? tok.v : null);

/** Split `tokens` where `at(tok, depth0)` says so, outside every bracket. */
function splitTop(tokens, v) {
  const parts = [[]];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.t === 'op' && '([{'.includes(tok.v)) depth++;
    else if (tok.t === 'op' && ')]}'.includes(tok.v)) depth--;
    if (depth === 0 && isOp(tok, v)) parts.push([]); else parts.at(-1).push(tok);
  }
  return parts;
}

/** The statements of one logical line: {tokens, inline} where `inline` marks a statement written after a block header. */
function statementsOf(tokens) {
  let body = tokens, inline = false;
  const out = [];
  if (isName(tokens[0]) && HEADERS.has(tokens[0].v)) {
    // The header ends at the first colon outside brackets that does not belong to a lambda.
    let depth = 0, lambdas = 0, colon = -1;
    for (let k = 0; k < tokens.length && colon < 0; k++) {
      const tok = tokens[k];
      if (tok.t === 'op' && '([{'.includes(tok.v)) depth++;
      else if (tok.t === 'op' && ')]}'.includes(tok.v)) depth--;
      else if (depth === 0 && isName(tok, 'lambda')) lambdas++;
      else if (depth === 0 && isOp(tok, ':')) { if (lambdas) lambdas--; else colon = k; }
    }
    if (colon >= 0) { out.push({tokens: tokens.slice(0, colon), inline: false, header: true}); body = tokens.slice(colon + 1); inline = true; }
  }
  for (const part of splitTop(body, ';')) if (part.length) out.push({tokens: part, inline});
  return out;
}

/** `a.b.c` starting at tokens[k]: its text and the index after it, or null. */
function dotted(tokens, k) {
  if (!isName(tokens[k])) return null;
  const parts = [tokens[k].v];
  let j = k + 1;
  while (isOp(tokens[j], '.') && isName(tokens[j + 1])) { parts.push(tokens[j + 1].v); j += 2; }
  return {parts, next: j};
}

/** An import statement's records and the names it binds, or a refusal: an import is never half-read. */
function readImport(tokens, conditional, bind) {
  const line = tokens[0].line, records = [];
  const bad = () => refuse(`line ${line}: an import statement this reader cannot read`);
  const record = (specifier, names, namespace, level) => records.push({specifier, line, kind: 'static', names, default: false, namespace, level,
    ...(conditional ? {conditional: true} : {})});
  let k = 1;
  if (tokens[0].v === 'import') {
    for (;;) {
      const d = dotted(tokens, k);
      if (!d) bad();
      k = d.next;
      const specifier = d.parts.join('.');
      if (isName(tokens[k], 'as')) { if (!isName(tokens[k + 1])) bad(); bind(tokens[k + 1].v, specifier); k += 2; }
      // `import a.b` binds `a`, and `a.b` is then reached through it.
      else bind(d.parts[0], d.parts[0]);
      record(specifier, [], true, 0);
      if (k >= tokens.length) break;
      if (!isOp(tokens[k], ',')) bad();
      k++;
    }
    return records;
  }
  let level = 0;
  while (isOp(tokens[k], '.')) { level++; k++; }
  let specifier = '';
  if (!isName(tokens[k], 'import')) { const d = dotted(tokens, k); if (!d) bad(); specifier = d.parts.join('.'); k = d.next; }
  if (!isName(tokens[k], 'import') || (!specifier && !level)) bad();
  k++;
  const from = '.'.repeat(level) + specifier;
  if (isOp(tokens[k], '*')) { if (k + 1 !== tokens.length) bad(); record(specifier, [], true, level); return records; }
  const wrapped = isOp(tokens[k], '(');
  let end = tokens.length;
  if (wrapped) { if (!isOp(tokens.at(-1), ')')) bad(); k++; end--; }
  const names = [];
  for (;;) {
    if (!isName(tokens[k]) || k >= end) bad();
    const imported = tokens[k].v;
    names.push(imported); k++;
    if (isName(tokens[k], 'as') && k < end) { if (!isName(tokens[k + 1]) || k + 1 >= end) bad(); bind(tokens[k + 1].v, `${from}.${imported}`); k += 2; }
    else bind(imported, `${from}.${imported}`);
    if (k >= end) break;
    if (!isOp(tokens[k], ',')) bad();
    k++;
    if (k >= end) { if (!wrapped) bad(); break; }
  }
  record(specifier, names, false, level);
  return records;
}

/** The arguments of the call whose `(` is tokens[open]: each argument's tokens, or null when it never closes here. */
function argumentsOf(tokens, open) {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (tokens[k].t !== 'op') continue;
    if ('([{'.includes(tokens[k].v)) depth++;
    else if (')]}'.includes(tokens[k].v) && --depth === 0) return splitTop(tokens.slice(open + 1, k), ',').filter(a => a.length);
  }
  return null;
}

/** What `text` (a Python file) needs, read by tokens. See the header for the shape and for what is missed. */
export function readPython(text, {file = 'file.py'} = {}) {
  void file;
  let tokens;
  try { tokens = tokenize(String(text).replace(/^﻿/, '')); }
  catch (e) { if (e instanceof Refusal) return {ok: false, why: e.message, ...empty()}; throw e; }
  const out = {ok: true, ...empty()};

  // ---- logical lines: imports, what each name is bound to, top-level functions, docstrings ---------------------------
  // A name is bound to the dotted thing it was imported as; null once the file gives it a second meaning.
  const bound = new Map();
  const bind = (name, to) => bound.set(name, bound.has(name) && bound.get(name) !== to ? null : to);
  try {
    let start = 0;
    for (let k = 0; k <= tokens.length; k++) {
      if (k < tokens.length && tokens[k].t !== 'nl') continue;
      const lineTokens = tokens.slice(start, k);
      start = k + 1;
      if (!lineTokens.length) continue;
      const indent = lineTokens[0].col;
      for (const s of statementsOf(lineTokens)) {
        const [first, second, third] = s.tokens;
        if (isName(first, 'import') || isName(first, 'from')) out.imports.push(...readImport(s.tokens, indent > 0 || s.inline, bind));
        const named = isName(first, 'async') && isName(second, 'def') ? third : isName(first, 'def') || isName(first, 'class') ? second : null;
        if (isName(named)) {
          bound.set(named.v, null);
          if (indent === 0 && s.header) out.functions.push({name: named.v, line: first.line, exported: !named.v.startsWith('_'), calls: []});
        }
        if (s.tokens.every(t => t.t === 'str' || t.t === 'fstr')) for (const t of s.tokens) t.doc = true;
      }
    }
  } catch (e) { if (e instanceof Refusal) return {ok: false, why: e.message, ...empty()}; throw e; }

  // ---- one pass over the tokens, in the order they are written -------------------------------------------------------
  const seen = {env: new Set(), hosts: new Set(), strings: new Set()};
  const once = (set, key) => (set.has(key) ? false : (set.add(key), true));
  const relative = p => p.startsWith('./') || p.startsWith('../') || p === '.' || p === '..';
  const hostsIn = (raw, line) => {
    for (const m of raw.matchAll(HOST)) {
      const host = m[1].toLowerCase(), at = line + (raw.slice(0, m.index).match(/\n/g)?.length ?? 0);
      if (once(seen.hosts, `${host}\0${at}`)) out.hosts.push({host, line: at});
    }
  };
  const env = (name, line, call, assigned) => {
    if (name === null || !ENV_NAME.test(name)) out.unresolved.env.push({line, call});
    else if (once(seen.env, `${name}\0${line}`)) out.env.push({name, line, ...(assigned ? {assigned: true} : {})});
  };

  const scan = T => {
    for (let k = 0; k < T.length; k++) {
      const tok = T[k];
      if (tok.t === 'fstr') { if (!tok.doc) for (const p of tok.pieces) hostsIn(p.raw, p.line); for (const e of tok.exprs) scan(e); continue; }
      if (tok.t === 'str') {
        if (tok.doc) continue;
        hostsIn(tok.raw, tok.line);
        if (!tok.bytes && tok.v.length >= 3 && tok.v.length <= 300 && PATHLIKE.test(tok.v) && (tok.v.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(tok.v)) &&
          once(seen.strings, `${tok.v}\0${tok.line}`)) out.strings.push({value: tok.v, line: tok.line});
        continue;
      }
      // A read through a method of something this reader cannot name: counted unless the literal-Path form claimed it.
      if (isOp(tok, '.') && isName(T[k + 1]) && PATH_READS.has(T[k + 1].v) && isOp(T[k + 2], '(') && !T[k + 1].claimed) {
        out.unresolved.reads.push({line: T[k + 1].line, call: T[k + 1].v});
        continue;
      }
      if (tok.t !== 'name' || isOp(T[k - 1], '.') || isName(T[k - 1], 'def') || isName(T[k - 1], 'class')) continue;
      const chain = dotted(T, k), head = chain.parts[0], e = chain.next, line = tok.line;
      const to = bound.has(head) ? bound.get(head) : head === 'open' && chain.parts.length === 1 ? 'open' : null;
      if (to === null) continue;
      // `call` is the name the thing has where it is defined, whatever alias the file gives it.
      const what = [to, ...chain.parts.slice(1)].join('.'), call = what.split('.').at(-1);
      const called = isOp(T[e], '(') ? argumentsOf(T, e) : null;

      if (what === 'os.environ' && isOp(T[e], '[')) {
        const whole = literal(T[e + 1]) !== null && isOp(T[e + 2], ']');
        env(whole ? T[e + 1].v : null, line, 'environ', whole && isOp(T[e + 3], '=') && !isOp(T[e + 4], '='));
      } else if (ENV_CALLS.has(what) && called) {
        env(called[0]?.length === 1 ? literal(called[0][0]) : null, line, call);
      } else if (PROGRAM_CALLS.has(what) && called) {
        const a = called[0] ?? [];
        let name = null;
        if (a.length === 1 && literal(a[0]) !== null) name = a[0].v.trim().split(/\s+/)[0];
        // A list or tuple whose first element is a literal on its own: `['git', ...]`, `['git'] + rest`. A string in
        // plain parentheses is still a command line.
        else if (isOp(a[0], '[') && literal(a[1]) !== null && (isOp(a[2], ',') || isOp(a[2], ']'))) name = a[1].v;
        else if (isOp(a[0], '(') && literal(a[1]) !== null && isOp(a[2], ',')) name = a[1].v;
        else if (isOp(a[0], '(') && literal(a[1]) !== null && isOp(a[2], ')') && a.length === 3) name = a[1].v.trim().split(/\s+/)[0];
        if (name) out.programs.push({name, line, call}); else out.unresolved.programs.push({line, call});
      } else if (what === 'open' && called) {
        // open(path[, mode]) or open(file=, mode=): the mode decides whether this is a read or a write.
        const positional = called.filter(a => !(isName(a[0]) && isOp(a[1], '=') && !isOp(a[2], '=')));
        const keyword = name => called.find(a => isName(a[0], name) && isOp(a[1], '=') && !isOp(a[2], '='))?.slice(2);
        const pathArg = positional[0] ?? keyword('file'), modeArg = positional[1] ?? keyword('mode');
        const path = pathArg?.length === 1 ? literal(pathArg[0]) : null;
        const mode = !modeArg ? 'r' : modeArg.length === 1 ? literal(modeArg[0]) : null;
        if (mode !== null && /[wax+]/.test(mode)) { if (path !== null) out.writes.push({path, line, call: 'open', relative: relative(path)}); }
        else if (mode !== null && path !== null) out.reads.push({path, line, call: 'open', relative: relative(path)});
        else out.unresolved.reads.push({line, call: 'open'});
      } else if (what === 'pathlib.Path' && called?.length === 1 && called[0].length === 1 && literal(called[0][0]) !== null &&
        isOp(T[e + 2], ')') && isOp(T[e + 3], '.') && isName(T[e + 4]) && isOp(T[e + 5], '(')) {
        const method = T[e + 4].v, path = called[0][0].v;
        if (PATH_READS.has(method)) { T[e + 4].claimed = true; out.reads.push({path, line, call: method, relative: relative(path)}); }
        else if (PATH_WRITES.has(method)) out.writes.push({path, line, call: method, relative: relative(path)});
      }
    }
  };
  scan(tokens);
  return out;
}
