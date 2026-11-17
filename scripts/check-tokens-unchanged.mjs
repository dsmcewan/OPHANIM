#!/usr/bin/env node
// CO1 no-behaviour-change check: a reformatting/documentation change to a JavaScript module must leave
// its code exactly as it was, so that only comments and whitespace differ.
//
// Purpose: prove, for every changed .mjs file, that the code before and after is the same program.
// Inputs:  --base <commit> (default HEAD) and optional repository-relative paths; with no paths, every
//          .mjs file under ophanim/ that differs between <commit> and the working tree.
// Outputs: one line per file and a summary on stdout; exit status 1 if any file differs in code.
// For each file it compares, between the base bytes and the working-tree bytes:
//   1. the token stream: every leaf token of the TypeScript parse tree (kind and exact text), so
//      comments and whitespace are ignored and nothing else is;
//   2. the normalised syntax tree: every node's kind, nested, with leaf text. Two files with the same
//      tokens can still parse differently when a line break changes automatic semicolon insertion
//      (`return` followed by a newline, for example); this comparison catches that;
//   3. the parse diagnostics (both must be empty) and `node --check` on the new file.
// It never writes a file. Needs the root devDependency `typescript` (the tokenizer and parser).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], {encoding: 'utf8', maxBuffer: 1 << 28});

function parse(text) {
  const source = ts.createSourceFile('x.mjs', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const tokens = [];
  // Normalised tree: kind names nested with parentheses, leaves carry their exact text.
  // JSDoc blocks (`/** ... */`) are comments: the parser attaches them as child nodes, so drop them.
  const isDoc = node => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
  const tree = node => {
    const children = node.getChildren(source).filter(child => !isDoc(child));
    if (!children.length) {
      const leaf = [ts.SyntaxKind[node.kind], node.getText(source)];
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(leaf);
      return JSON.stringify(leaf);
    }
    return `${ts.SyntaxKind[node.kind]}(${children.map(tree).join(',')})`;
  };
  const shape = tree(source);
  return {tokens, shape, diagnostics: source.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))};
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function compare(before, after) {
  const a = parse(before), b = parse(after);
  const problems = [];
  if (a.diagnostics.length || b.diagnostics.length) problems.push(`parse diagnostics: ${[...a.diagnostics, ...b.diagnostics].join('; ')}`);
  const n = Math.max(a.tokens.length, b.tokens.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a.tokens[i]) !== JSON.stringify(b.tokens[i])) {
      problems.push(`token ${i} differs: ${JSON.stringify(a.tokens[i])} -> ${JSON.stringify(b.tokens[i])}`);
      break;
    }
  }
  if (a.shape !== b.shape) problems.push('syntax tree differs');
  return {ok: !problems.length, problems, tokens: b.tokens.length, tokenSha: sha(JSON.stringify(b.tokens)), treeSha: sha(b.shape)};
}

function main(argv) {
  let base = 'HEAD';
  const named = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i];
    else named.push(argv[i]);
  }
  const files = named.length ? named
    : git('diff', '--name-only', base, '--', 'ophanim').split('\n').filter(f => f.endsWith('.mjs'));
  let failed = 0;
  for (const file of files) {
    const before = git('show', `${base}:${file}`);
    const after = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const result = compare(before, after);
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], {stdio: 'pipe'});
    } catch (error) {
      result.ok = false;
      result.problems.push(`node --check failed: ${String(error.stderr).trim()}`);
    }
    const bytes = before === after ? 'bytes identical' : 'bytes changed';
    console.log(`${result.ok ? 'SAME' : 'DIFF'} ${file}: ${result.tokens} tokens, token sha ${result.tokenSha}, ` +
      `tree sha ${result.treeSha}, ${bytes}${result.ok ? '' : `\n  ${result.problems.join('\n  ')}`}`);
    if (!result.ok) failed++;
  }
  console.log(`${files.length - failed}/${files.length} files have identical tokens and syntax tree against ${base}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
