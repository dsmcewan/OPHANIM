#!/usr/bin/env node
// CO1 readability metrics for ophanim/ (or any .mjs files named on the command line).
//
// Purpose: measure what the independent review's CO1 finding measured -- how much of a file is
//   comment and how long its lines are -- so a reformatting slice can report before and after.
// Inputs:  optional file paths (repository-relative); with none, every tracked ophanim/**/*.mjs.
//          --rev <commit> reads the files' bytes at that commit instead of the working tree.
// Outputs: a Markdown table on stdout, one row per named file plus a total row: lines, comment
//   lines, comment-line ratio, lines over 120 characters, longest line.
// A "comment line" is a line that holds any part of a comment (line or block). Comments are found
//   from the TypeScript parse tree, so text inside strings, templates and regular expressions never
//   counts. Needs the root devDependency `typescript`.
// It only reads; it never writes a file.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], {encoding: 'utf8', maxBuffer: 1 << 28});

// Number of lines that contain any comment text: every comment range attached to any node of the
// parse tree, de-duplicated by start position, expanded to the lines it spans.
function commentLines(text) {
  const source = ts.createSourceFile('x.mjs', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const lineOf = pos => source.getLineAndCharacterOfPosition(pos).line;
  const lines = new Set(), seen = new Set();
  const visit = node => {
    for (const ranges of [ts.getLeadingCommentRanges(text, node.pos), ts.getTrailingCommentRanges(text, node.end)]) {
      for (const r of ranges ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        for (let l = lineOf(r.pos); l <= lineOf(r.end); l++) lines.add(l);
      }
    }
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return lines.size;
}

export function metrics(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const comments = commentLines(text);
  return {
    lines: lines.length,
    comments,
    ratio: lines.length ? comments / lines.length : 0,
    over120: lines.filter(l => l.length > 120).length,
    longest: Math.max(0, ...lines.map(l => l.length)),
  };
}

function main(argv) {
  let rev = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rev') rev = argv[++i];
    else files.push(argv[i]);
  }
  const list = files.length ? files
    : git('ls-files', 'ophanim').split('\n').filter(f => f.endsWith('.mjs'));
  const read = f => rev ? git('show', `${rev}:${f}`) : fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pct = x => `${(100 * x).toFixed(1)}%`;
  const total = {lines: 0, comments: 0, over120: 0, longest: 0};
  console.log('| file | lines | comment lines | comment ratio | lines > 120 | longest |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const f of list) {
    const m = metrics(read(f));
    for (const k of ['lines', 'comments', 'over120']) total[k] += m[k];
    total.longest = Math.max(total.longest, m.longest);
    if (files.length) console.log(`| ${f} | ${m.lines} | ${m.comments} | ${pct(m.ratio)} | ${m.over120} | ${m.longest} |`);
  }
  console.log(`| TOTAL (${list.length} files) | ${total.lines} | ${total.comments} | ` +
    `${pct(total.comments / total.lines)} | ${total.over120} | ${total.longest} |`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
