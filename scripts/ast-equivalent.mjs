#!/usr/bin/env node
// Same-program check for a JavaScript module that was reformatted: are two versions the same syntax tree?
//
// Purpose: prove that a change which only re-spells a module (re-wrapping, re-quoting, adding or dropping
//   semicolons, parentheses and trailing commas, splitting a long string across lines) did not change what
//   it does. Looser than scripts/check-tokens-unchanged.mjs, which is the CO1 gate and the one to use for
//   CO1: that script requires an identical TOKEN stream, so it also rejects the re-spellings below.
// Inputs:  two files, `ast-equivalent.mjs <before> <after>`; or `--base <rev> <path>...`, which compares each
//          repository-relative path at <rev> with the working tree.
// Outputs: one SAME/DIFF line per file on stdout; exit status 1 if any file differs or does not parse.
// What is erased (the TypeScript parse tree has no node for it): whitespace, comments, semicolons, parentheses,
//   trailing commas, quote style, and how a number is spelled (1E3 is 1e3). Empty statements are dropped from
//   statement lists only, so `if (x) ;` and `if (x) {}` still differ.
// What is joined: string-typed literal forms. A string literal, a template literal, or `+` of two such forms is
//   already a string, so `'a ' + 'b'` equals `'a b'`, and `'a ' + `b ${x}`` equals `a b ${x}`: same text, same
//   embedded expressions. `'a' + x` is NOT joined: `+` coerces x differently from a template.
// Everything else must match exactly: node kinds, identifiers, operators, literal values, statement order,
//   object key order. It never writes a file. Needs the root devDependency `typescript`.
// Tests: node --test scripts/ast-equivalent.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const K = ts.SyntaxKind;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The parts of a string-typed literal form: text pieces and `{e: tree}` embedded expressions, or null.
function parts(node) {
  switch (node.kind) {
    case K.ParenthesizedExpression: return parts(node.expression);
    case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return [node.text];
    case K.TemplateExpression: {
      const out = [node.head.text];
      for (const span of node.templateSpans) out.push({e: norm(span.expression)}, span.literal.text);
      return out;
    }
    case K.BinaryExpression: {
      if (node.operatorToken.kind !== K.PlusToken) return null;
      const left = parts(node.left), right = parts(node.right);
      return left && right ? [...left, ...right] : null;
    }
  }
  return null;
}
// Adjacent text pieces become one.
function mergeText(list) {
  const out = [];
  for (const piece of list) {
    if (typeof piece === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out;
}

// `tagged` is true for the template of a tagged template, whose raw text (`String.raw`) is observable: it is
// compared as written, so an escape and the character it stands for differ, and it is never joined.
function norm(node, tagged = false) {
  if (!tagged) {
    const joined = parts(node);
    if (joined) return ['S', ...mergeText(joined)];
  }
  if (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode) return null;
  if (node.kind === K.ParenthesizedExpression) return norm(node.expression);
  const kind = K[node.kind];
  switch (node.kind) {
    case K.Identifier: case K.PrivateIdentifier: return [kind, node.text];
    case K.StringLiteral: return ['Str', node.text];
    case K.NoSubstitutionTemplateLiteral: return ['Tpl', node.text, node.getText()];
    case K.TemplateHead: case K.TemplateMiddle: case K.TemplateTail: return [kind, node.text, node.getText()];
    case K.TaggedTemplateExpression: return [kind, norm(node.tag), norm(node.template, true)];
    case K.NumericLiteral: return ['Num', node.text]; // the parser already normalises 1E3, 0xFF and 1_000
    case K.BigIntLiteral: return [kind, node.text.toLowerCase()];
    case K.RegularExpressionLiteral: return [kind, node.text];
    case K.BinaryExpression:
      return [kind, K[node.operatorToken.kind], norm(node.left), norm(node.right)];
    case K.PrefixUnaryExpression: case K.PostfixUnaryExpression:
      return [kind, K[node.operator], norm(node.operand)];
    case K.NewExpression:
      return [kind, norm(node.expression), (node.arguments ?? []).map(arg => norm(arg))];
  }
  const out = [kind];
  // let/const/var live in flags, not in a child node
  if (node.flags & ts.NodeFlags.Const) out.push('const');
  if (node.flags & ts.NodeFlags.Let) out.push('let');
  ts.forEachChild(node, child => {
    if (child.kind === K.EmptyStatement && (node.kind === K.SourceFile || node.kind === K.Block)) return;
    const tree = norm(child);
    if (tree) out.push(tree);
  });
  return out;
}

/** The normalised tree of one module's source, as a string. Throws if the source does not parse. */
export function normalize(source, name = 'module.mjs') {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) {
    throw new Error(`${name}: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, ' ')}`);
  }
  return JSON.stringify(norm(file));
}

/** True when the two sources are the same program up to the re-spellings listed above. */
export function sameProgram(before, after) {
  return normalize(before, 'before') === normalize(after, 'after');
}

function main(argv) {
  const jobs = [];
  if (argv[0] === '--base') {
    const [, rev, ...paths] = argv;
    if (!rev || !paths.length) return usage();
    for (const rel of paths) {
      const before = execFileSync('git', ['-C', ROOT, 'show', `${rev}:${rel}`], {encoding: 'utf8', maxBuffer: 1 << 28});
      jobs.push([rel, before, fs.readFileSync(path.join(ROOT, rel), 'utf8')]);
    }
  } else if (argv.length === 2) {
    jobs.push([argv[1], fs.readFileSync(argv[0], 'utf8'), fs.readFileSync(argv[1], 'utf8')]);
  } else return usage();
  let different = 0;
  for (const [name, before, after] of jobs) {
    let same = false, why = '';
    try { same = sameProgram(before, after); } catch (error) { why = ` (${error.message})`; }
    console.log(`${same ? 'SAME' : 'DIFF'} ${name}${why}`);
    if (!same) different++;
  }
  console.log(`${jobs.length - different}/${jobs.length} files are the same program`);
  return different ? 1 : 0;
}
function usage() {
  console.error('usage: ast-equivalent.mjs <before> <after>\n       ast-equivalent.mjs --base <rev> <path>...');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
