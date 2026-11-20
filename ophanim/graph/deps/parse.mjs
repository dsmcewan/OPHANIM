// THE CODE READER of the dependency sources: one JavaScript file's text -> what the file needs, each with its line.
//
// Purpose   The systems graph's repository source (extract/repo.mjs) reads imports with the layering test's regex and
//           stops at the relative import. This reader parses the file (the TypeScript compiler's parser, already a dev
//           dependency of this repository; no type checker, no other file opened) and reports everything a dependency
//           source can state from the file alone: every import, the environment variable NAMES it reads, the programs it
//           runs, the files it reads and writes by path, the hosts and path-like strings it contains, and its top-level
//           functions with the calls they make to an imported name or to another function of the file.
// Inputs    The file's text and its path (for the parser's diagnostics only).
// Outputs   readCode(text, {file}) -> {ok, imports, exports, env, programs, reads, writes, hosts, strings, functions,
//           module_calls, unresolved: {programs, reads}} or {ok: false, why, ...empty lists}. parserVersion().
// Invariants  A line is the 1-based line the thing is written on. A call, a program or a read is recorded only when the
//           callee resolves, in this file, to an import (or a top-level function of the file) that no enclosing function
//           redeclares; what is seen and cannot be resolved (a computed program name or path) is COUNTED in `unresolved`,
//           never guessed. An environment variable is its name; no value, default or literal beside it is kept.
// Must never  Run the file, import it, open another file, or report a reading of a file the parser rejected.
import {createRequire} from 'node:module';
import path from 'node:path';

let TS = null;
/** The parser (loaded on first use). Throws DEPS_PARSER_UNAVAILABLE where the typescript package is not installed. */
function parser() {
  if (!TS) {
    try { TS = createRequire(import.meta.url)('typescript'); }
    catch (e) { throw Object.assign(new Error(`the code reader needs the typescript package (a dev dependency of this repository): ${e.message}`), {code: 'DEPS_PARSER_UNAVAILABLE'}); }
  }
  return TS;
}
/** The parser's version: part of what a reading rests on, recorded by the sources that use it. */
export const parserVersion = () => parser().version;

const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);
const FS = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']);
const PATH = new Set(['node:path', 'path', 'node:path/posix', 'path/posix']);
const URL_MODULES = new Set(['node:url', 'url']);
const RUNS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
const SHELL_RUNS = new Set(['exec', 'execSync']);
const READS = new Set(['readFileSync', 'readFile', 'createReadStream', 'readdirSync', 'readdir']);
const WRITES = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream']);
/** A specifier of the platform itself (not a package): `node:x`, or one of the bare names this reader interprets. */
export const isBuiltin = s => s.startsWith('node:') || CHILD_PROCESS.has(s) || FS.has(s) || PATH.has(s) || URL_MODULES.has(s);
const HOST = /https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})(?![a-z0-9.-])/gi;
const PATHLIKE = /^[\w@.~-]+(?:\/[\w@.~-]+)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const empty = () => ({imports: [], exports: [], env: [], programs: [], reads: [], writes: [], hosts: [], strings: [], functions: [], module_calls: [],
  unresolved: {programs: [], reads: []}});

/** What `text` (the file `file`) needs, read by the parser. See the header for the shape. */
export function readCode(text, {file = 'file.mjs'} = {}) {
  const ts = parser(), K = ts.SyntaxKind;
  // TypeScript files are read as TypeScript (a sibling repository's source); everything else as JavaScript.
  const kind = /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const errors = sf.parseDiagnostics ?? [];
  if (errors.length) {
    const first = errors[0];
    return {ok: false, why: `the parser reports ${errors.length} syntax error(s); first at line ${sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1}: ` +
      ts.flattenDiagnosticMessageText(first.messageText, ' '), ...empty()};
  }
  const out = {ok: true, ...empty()};
  const literal = n => (n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral) ? n.text : null);

  // ---- imports, and what each local name is bound to --------------------------------------------------------------------
  const named = new Map(), spaces = new Map(), specifierNodes = new Set();
  for (const s of sf.statements) {
    if (s.kind === K.ImportDeclaration && literal(s.moduleSpecifier) !== null) {
      const spec = s.moduleSpecifier.text, c = s.importClause, names = [];
      specifierNodes.add(s.moduleSpecifier);
      let dflt = false, ns = false;
      if (c?.name) { dflt = true; named.set(c.name.text, {specifier: spec, imported: 'default'}); if (isBuiltin(spec)) spaces.set(c.name.text, spec); }
      if (c?.namedBindings?.kind === K.NamespaceImport) { ns = true; spaces.set(c.namedBindings.name.text, spec); }
      if (c?.namedBindings?.kind === K.NamedImports) for (const e of c.namedBindings.elements) {
        const imported = (e.propertyName ?? e.name).text;
        names.push(imported); named.set(e.name.text, {specifier: spec, imported});
      }
      out.imports.push({specifier: spec, line: lineOf(s), kind: 'static', names, default: dflt, namespace: ns});
    } else if (s.kind === K.ExportDeclaration && literal(s.moduleSpecifier) !== null) {
      specifierNodes.add(s.moduleSpecifier);
      const names = s.exportClause?.kind === K.NamedExports ? s.exportClause.elements.map(e => (e.propertyName ?? e.name).text) : [];
      out.imports.push({specifier: s.moduleSpecifier.text, line: lineOf(s), kind: 'reexport', names, default: false, namespace: s.exportClause?.kind !== K.NamedExports});
    }
  }

  // ---- exports: the names other files may take, and where a re-exported or aliased one really is ----------------------
  const exportedBy = s => Boolean(s.modifiers?.some(m => m.kind === K.ExportKeyword));
  const defaulted = s => Boolean(s.modifiers?.some(m => m.kind === K.DefaultKeyword));
  const fnLike = n => n && (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression);
  for (const s of sf.statements) {
    const line = lineOf(s);
    if (s.kind === K.FunctionDeclaration && exportedBy(s)) out.exports.push({name: defaulted(s) ? 'default' : s.name.text, line, kind: 'function'});
    else if (s.kind === K.ClassDeclaration && exportedBy(s)) out.exports.push({name: defaulted(s) ? 'default' : s.name.text, line, kind: 'class'});
    else if (s.kind === K.VariableStatement && exportedBy(s)) {
      for (const d of s.declarationList.declarations) if (d.name.kind === K.Identifier) out.exports.push({name: d.name.text, line, kind: fnLike(d.initializer) ? 'function' : 'value'});
    } else if (s.kind === K.ExportAssignment) out.exports.push({name: 'default', line, kind: fnLike(s.expression) ? 'function' : 'value'});
    else if (s.kind === K.ExportDeclaration) {
      const from = literal(s.moduleSpecifier);
      if (s.exportClause?.kind === K.NamedExports) for (const e of s.exportClause.elements) {
        const inner = (e.propertyName ?? e.name).text;
        out.exports.push(from === null ? {name: e.name.text, line, kind: 'alias', local: inner} : {name: e.name.text, line, kind: 'reexport', specifier: from, imported: inner});
      } else if (from !== null) out.exports.push({name: s.exportClause?.name?.text ?? '*', line, kind: 'reexport', specifier: from, imported: '*'});
    }
  }

  // ---- the file's top-level functions and constants ------------------------------------------------------------------------
  const isFn = n => n && (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression);
  const exported = s => Boolean(s.modifiers?.some(m => m.kind === K.ExportKeyword));
  const units = [], constants = new Map();
  for (const s of sf.statements) {
    if ((s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration)) {
      units.push({name: s.name?.text ?? 'default', node: s, exported: exported(s)});
    } else if (s.kind === K.VariableStatement) {
      for (const d of s.declarationList.declarations) {
        if (d.name.kind !== K.Identifier) continue;
        if (isFn(d.initializer)) units.push({name: d.name.text, node: d, exported: exported(s)});
        else if (d.initializer) constants.set(d.name.text, d.initializer);
      }
    }
  }
  const local = new Set(units.map(u => u.name));
  const unitOf = new Map(units.map(u => [u.node, u]));

  /** Every name a subtree declares (parameters, variables, functions, classes, catch bindings): what may shadow. */
  const declaredIn = root => {
    const names = new Set();
    const bind = n => { if (!n) return; if (n.kind === K.Identifier) names.add(n.text); else if (n.elements) for (const e of n.elements) bind(e.name); };
    const walk = n => {
      if (n.kind === K.Parameter || n.kind === K.VariableDeclaration || n.kind === K.BindingElement) bind(n.name);
      else if ((n.kind === K.FunctionDeclaration || n.kind === K.ClassDeclaration || n.kind === K.FunctionExpression || n.kind === K.ClassExpression) && n !== root && n.name) names.add(n.name.text);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(root, walk);
    return names;
  };

  // ---- resolution: what an expression calls, and what path an expression names ----------------------------------------------
  const calleeOf = (expr, shadows) => {
    if (expr.kind === K.Identifier) {
      if (shadows.has(expr.text)) return null;
      const b = named.get(expr.text);
      return b ? {...b} : local.has(expr.text) ? {local: expr.text} : null;
    }
    if (expr.kind === K.PropertyAccessExpression && expr.expression.kind === K.Identifier && !shadows.has(expr.expression.text)) {
      const spec = spaces.get(expr.expression.text);
      return spec ? {specifier: spec, imported: expr.name.text} : null;
    }
    return null;
  };
  const relative = p => p.startsWith('./') || p.startsWith('../') || p === '.' || p === '..';
  const pathOf = (expr, shadows, depth = 0) => {
    if (!expr || depth > 3) return null;
    const lit = literal(expr);
    if (lit !== null) return {path: lit, relative: relative(lit)};
    if (expr.kind === K.NewExpression && expr.expression.kind === K.Identifier && expr.expression.text === 'URL' && literal(expr.arguments?.[0]) !== null) {
      const p = expr.arguments[0].text;
      return /^[a-z][a-z0-9+.-]*:/i.test(p) ? null : {path: relative(p) ? p : './' + p, relative: true};
    }
    if (expr.kind === K.CallExpression) {
      const c = calleeOf(expr.expression, shadows);
      if (c && URL_MODULES.has(c.specifier) && c.imported === 'fileURLToPath') return pathOf(expr.arguments[0], shadows, depth + 1);
      if (c && PATH.has(c.specifier) && (c.imported === 'join' || c.imported === 'resolve')) {
        // Leading non-literal arguments are the anchor (a root this file computes); after the first literal every
        // argument must be a literal, or the path is not known from this file.
        const parts = [];
        for (const a of expr.arguments) { const l = literal(a); if (l !== null) parts.push(l); else if (parts.length) return null; }
        if (!parts.length) return null;
        const joined = path.posix.normalize(parts.join('/'));
        return {path: relative(parts[0]) && !relative(joined) ? './' + joined : joined, relative: relative(parts[0])};
      }
      return null;
    }
    if (expr.kind === K.Identifier && !shadows.has(expr.text) && constants.has(expr.text)) {
      const p = pathOf(constants.get(expr.text), new Set(), depth + 1);
      return p ? {...p, constant: p.constant ?? expr.text} : null;
    }
    return null;
  };

  // ---- one walk, in document order -------------------------------------------------------------------------------------------
  const seen = {env: new Set(), hosts: new Set(), strings: new Set()};
  const once = (set, key) => (set.has(key) ? false : (set.add(key), true));
  const isProcessEnv = (n, shadows) => n?.kind === K.PropertyAccessExpression && n.name.text === 'env' && n.expression.kind === K.Identifier &&
    n.expression.text === 'process' && !shadows.has('process');
  const env = (name, node) => { if (ENV_NAME.test(name) && once(seen.env, `${name}\0${lineOf(node)}`)) out.env.push({name, line: lineOf(node)}); };
  const hostsIn = (textOf, node) => { for (const m of textOf.matchAll(HOST)) { const host = m[1].toLowerCase(); if (once(seen.hosts, `${host}\0${lineOf(node)}`)) out.hosts.push({host, line: lineOf(node)}); } };

  const walk = (n, ctx) => {
    const unit = unitOf.get(n);
    if (unit && !ctx.unit) {
      const record = {name: unit.name, kind: unit.node.kind === K.ClassDeclaration ? 'class' : 'function',
        line: lineOf(unit.node.kind === K.VariableDeclaration ? unit.node.parent.parent : unit.node), exported: unit.exported, calls: []};
      out.functions.push(record);
      ctx = {unit: record, shadows: declaredIn(n), keys: new Set()};
    }
    if (n.kind === K.CallExpression && n.expression.kind === K.ImportKeyword && literal(n.arguments[0]) !== null) {
      specifierNodes.add(n.arguments[0]);
      out.imports.push({specifier: n.arguments[0].text, line: lineOf(n), kind: 'dynamic', names: [], default: false, namespace: false});
    } else if (n.kind === K.CallExpression || n.kind === K.NewExpression) {
      const c = calleeOf(n.expression, ctx.shadows), line = lineOf(n);
      if (c?.specifier && CHILD_PROCESS.has(c.specifier) && RUNS.has(c.imported)) {
        const l = literal(n.arguments?.[0]);
        const name = l === null ? null : SHELL_RUNS.has(c.imported) ? l.trim().split(/\s+/)[0] : l;
        if (name) out.programs.push({name, line, call: c.imported}); else out.unresolved.programs.push({line, call: c.imported});
      } else if (c?.specifier && FS.has(c.specifier) && (READS.has(c.imported) || WRITES.has(c.imported))) {
        const p = pathOf(n.arguments?.[0], ctx.shadows), list = READS.has(c.imported) ? 'reads' : 'writes';
        if (p) out[list].push({path: p.path, line, call: c.imported, relative: p.relative, ...(p.constant ? {constant: p.constant} : {})});
        else if (list === 'reads') out.unresolved.reads.push({line, call: c.imported});
      } else if (c && !(c.specifier && isBuiltin(c.specifier)) && !(c.local && c.local === ctx.unit?.name)) {
        const key = c.local ? `local\0${c.local}` : `${c.specifier}\0${c.imported}`;
        const call = c.local ? {line, local: c.local} : {line, imported: c.imported, specifier: c.specifier};
        if (ctx.unit) { if (once(ctx.keys, key)) ctx.unit.calls.push(call); }
        else if (once(ctx.keys, key)) out.module_calls.push(call);
      }
    }
    if (n.kind === K.PropertyAccessExpression && isProcessEnv(n.expression, ctx.shadows)) env(n.name.text, n);
    else if (n.kind === K.ElementAccessExpression && isProcessEnv(n.expression, ctx.shadows) && literal(n.argumentExpression) !== null) env(n.argumentExpression.text, n);
    else if (n.kind === K.VariableDeclaration && n.name.kind === K.ObjectBindingPattern && isProcessEnv(n.initializer, ctx.shadows)) {
      for (const e of n.name.elements) { const key = e.propertyName ?? e.name; if (!e.dotDotDotToken && key.kind === K.Identifier) env(key.text, n); }
    }
    if ((n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral) && !specifierNodes.has(n)) {
      hostsIn(n.text, n);
      if (n.text.length >= 3 && n.text.length <= 300 && PATHLIKE.test(n.text) && (n.text.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(n.text)) &&
        once(seen.strings, `${n.text}\0${lineOf(n)}`)) out.strings.push({value: n.text, line: lineOf(n)});
    } else if (n.kind === K.TemplateHead || n.kind === K.TemplateMiddle || n.kind === K.TemplateTail) hostsIn(n.text, n);
    ts.forEachChild(n, child => walk(child, ctx));
  };
  walk(sf, {unit: null, shadows: new Set(), keys: new Set()});
  // A dynamic import is found during the walk; keep the imports in the order they are written.
  out.imports.sort((a, b) => a.line - b.line);
  return out;
}
