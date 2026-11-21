#!/usr/bin/env node
// Test lint (docs/OPEN-LIMITATIONS.md L-503; retrospective failure mode 4, "tests that could not fail").
// REPORT-ONLY by default: it lists findings and exits 0. CI ENFORCES it: the qualification workflow's lint step runs it
// with --enforce, and the gate's coverage check (suites.mjs qualificationBounds) fails if that step stops enforcing.
//
//   node scripts/test-gates/lint-tests.mjs [--json FILE] [--enforce] [PATH ...]
//
// Rules (heuristics over source text, for a reviewer to judge -- not proofs):
//   vacuous-conditional-assert  an assert inside `if (x)` / `if (x != null)` whose body asserts on x itself (x in a
//                               compared argument, not only in the failure message), with no else branch: when x is
//                               absent the assert never runs and the test passes (`if (tier) assert(...)` in
//                               planner-tier.test.mjs). A numeric loop index (`if (i)`: after the first iteration) is
//                               not a presence test.
//   truncated-sequence          `.slice(` on a sequence that is then compared with deepEqual/equal/strictEqual --
//                               inline in the assert, or through a variable assigned from a `.slice(` (each
//                               declarator on its own, in its own scope) -- so items past the cut are never checked
//                               (`.slice(0, 5)` hid re-dispatches). One element selected from the slice (`.find(`,
//                               `.findLast(`, `.at(`, `[n]`) is not a sequence; a slice inside another call's
//                               arguments still counts (a helper over a cut log hides the same items).
//   scripted-terminal-status    a fixture (a returned object literal) hard-codes a terminal status ('failed',
//                               'passed', 'completed', ...) that the same file then asserts: the outcome under test
//                               may be chosen by the fixture (`status: 'failed'` for the elapsed stop).
//
// Suppression, for a finding judged sound: a comment `test-lint: allow RULE -- reason` on the finding's line or the
// line above it, the reason specific to that line (at least MIN_REASON_WORDS words: where the rest is checked, or why
// the status is an input). Suppressed findings are still counted and listed as suppressed, with their reasons. A
// suppression with no `-- reason`, or a shorter one, is REJECTED: the finding counts as unsuppressed (and fails
// --enforce), listed with why.
// Enforcement switch: `--enforce` or OPHANIM_TEST_LINT=enforce makes any unsuppressed finding exit 1.
//
// Inputs:  *.test.mjs under the given paths (default: the repository, without node_modules and docs/).
// Outputs: the report on stdout (file:line, rule, snippet; counts per rule; top files); --json writes the findings.
// Must never: change a test file, or exit non-zero in report-only mode because of findings.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RULES = ['vacuous-conditional-assert', 'truncated-sequence', 'scripted-terminal-status'];
const TERMINAL = ['failed', 'passed', 'completed', 'succeeded', 'success', 'cancelled', 'canceled', 'aborted', 'done',
  'error', 'errored', 'rejected', 'accepted', 'approved', 'timed_out', 'timeout', 'stopped', 'killed', 'refused', 'denied'];

/** Blank comments and string/template/regex contents (keeping length and newlines) so structure can be scanned. */
export function blank(src) {
  const out = src.split('');
  let i = 0;
  const fill = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let lastSig = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; fill(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; fill(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; else if (c !== '`' && src[j] === '\n') break; j++; }
      fill(i + 1, j); i = j + 1; lastSig = c; continue;
    }
    // A regex literal starts where an operand cannot end.
    if (c === '/' && (lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { fill(i + 1, j); i = j + 1; lastSig = '/'; continue; }
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}

function matchClose(b, open) {
  const pairs = {'(': ')', '{': '}', '[': ']'};
  const want = pairs[b[open]]; let depth = 0;
  for (let i = open; i < b.length; i++) {
    if (b[i] === b[open]) depth++;
    else if (b[i] === want && --depth === 0) return i;
  }
  return -1;
}

/** Split blanked argument text at its top-level commas. */
function topLevelArgs(text) {
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out;
}

/** The [start, end) of each top-level argument of the call whose parentheses are at `open`..`close` (blanked text). */
function argRanges(b, open, close) {
  const out = []; let depth = 0, from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = b[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push([from, i]); from = i + 1; }
  }
  if (b.slice(from, close).trim()) out.push([from, close]);
  return out;
}

// How many leading arguments of an assert call are compared values; the rest are the failure message. An unknown
// method counts every argument as a value.
const VALUE_ARGS = {'': 1, ok: 1, ifError: 1, equal: 2, notEqual: 2, strictEqual: 2, notStrictEqual: 2, deepEqual: 2,
  notDeepEqual: 2, deepStrictEqual: 2, notDeepStrictEqual: 2, partialDeepStrictEqual: 2, match: 2, doesNotMatch: 2,
  throws: 2, doesNotThrow: 2, rejects: 2, doesNotReject: 2};
const valueArgs = (method, n) => method === 'fail' ? (n >= 2 ? n : 0) : (VALUE_ARGS[method ?? ''] ?? n);

/**
 * Is `name` (tested by the `if` at `at`) a NUMERIC loop index of a loop enclosing it: `for (let i = 0; ...)`, or
 * `for (const [i, x] of xs.entries())` when the body indexes with it (`xs[i - 1]`: an array's entries, not a Map's)?
 */
function loopIndex(b, name, at, bodyB) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const n = name.replace(/\$/g, '\\$');
  for (const f of b.slice(0, at).matchAll(/\bfor\s*\(/g)) {
    const fo = f.index + f[0].length - 1, fc = matchClose(b, fo);
    if (fc < 0 || fc > at) continue;
    let k = fc + 1; while (/\s/.test(b[k] ?? '')) k++;
    if (!(b[k] === '{' ? at < matchClose(b, k) : at === k)) continue;
    const head = b.slice(fo + 1, fc);
    if (new RegExp(`^\\s*(?:let|var)\\s+${n}\\s*=\\s*\\d+\\s*[;,]`).test(head)) return true;
    if (new RegExp(`^\\s*(?:const|let|var)\\s*\\[\\s*${n}\\s*,[^\\]]*\\]\\s+of\\s+[\\s\\S]*\\.entries\\(\\s*\\)\\s*$`).test(head)
      && new RegExp(`\\[\\s*${n}\\s*-\\s*\\d+\\s*\\]`).test(bodyB)) return true;
  }
  return false;
}

/**
 * Does this (blanked) expression text compare a truncated sequence: a `.slice(...)` from which no single element is
 * then selected? `xs.slice(k).find(p)`, `.findLast(p)`, `.at(n)` and `[n]` yield one element, not the sequence; any
 * other use (`.map`, `.join`, `.length`, `.every`, the slice itself) keeps the cut in what is compared.
 */
function truncates(t) {
  for (const s of t.matchAll(/\.slice\s*\(/g)) {
    const close = matchClose(t, s.index + s[0].length - 1);
    if (close < 0) return true;
    if (!/^\s*(?:(?:\?\.|\.)\s*(?:find|findLast|at)\s*\(|(?:\?\.)?\[)/.test(t.slice(close + 1))) return true;
  }
  return false;
}

/** The block a declaration at `i` is scoped to: the innermost unclosed `{` before it, to its `}` (else the file). */
function blockOf(b, i) {
  let depth = 0, j = i - 1;
  for (; j >= 0; j--) { if (b[j] === '}') depth++; else if (b[j] === '{') { if (depth === 0) break; depth--; } }
  if (j < 0) return [0, b.length];
  const end = matchClose(b, j);
  return [j, end < 0 ? b.length : end];
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const snippetAt = (src, line) => src.split('\n')[line - 1].trim().slice(0, 160);
const norm = e => e.replace(/\?\./g, '.').replace(/\s+/g, '');

const ASSERT_CALL = /\bassert(?:\.(\w+))?\s*\(/g;

// A suppression must say why the finding is sound, specifically: at least this many words after `--`.
export const MIN_REASON_WORDS = 5;

/** The suppression of `rule` on one line: null (none), {reason} (accepted), or {rejected} (no specific reason). */
export function suppressionOn(text, rule) {
  const m = new RegExp(`test-lint: allow ${rule}\\b(.*)$`).exec(text ?? '');
  if (!m) return null;
  const r = /^\s*--\s*(.*?)\s*(?:\*\/.*)?$/.exec(m[1]);
  if (!r) return {rejected: 'no `-- reason` after the rule'};
  const words = r[1].split(/\s+/).filter(w => /[A-Za-z]/.test(w)).length;
  if (words < MIN_REASON_WORDS) return {rejected: `the reason "${r[1]}" has ${words} word(s), fewer than ${MIN_REASON_WORDS}: name where the property is checked or why the status is an input`};
  return {reason: r[1]};
}

/** Findings in one file's source. */
export function lintSource(src, file = '<src>') {
  const b = blank(src);
  const findings = [];
  const lines = src.split('\n');
  const add = (rule, idx, detail) => {
    const line = lineOf(src, idx);
    // On the finding's line or the line above it. A suppression without a specific reason does not suppress.
    const seen = [lines[line - 1], lines[line - 2]].map(t => suppressionOn(t, rule)).filter(Boolean);
    const ok = seen.find(s => s.reason);
    findings.push({file, line, rule, snippet: snippetAt(src, line), detail, suppressed: Boolean(ok),
      ...(ok ? {reason: ok.reason} : seen.length ? {suppression_rejected: seen[0].rejected} : {})});
  };

  // (a) vacuous conditional assert
  for (const m of b.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1, close = matchClose(b, open);
    if (close < 0) continue;
    const cond = src.slice(open + 1, close).trim();
    // Presence tests only: `x`, `x.y`, `x?.y`, `x[0]`, `x.length`, `x != null`, `x !== undefined`, `x !== null`.
    const cm = /^([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|\[\d+\])*)(?:\s*!==?\s*(?:null|undefined))?$/.exec(cond);
    if (!cm) continue;
    const subject = cm[1].replace(/\.length$/, '');
    let k = close + 1; while (/\s/.test(b[k] ?? '')) k++;
    let bodyEnd;
    if (b[k] === '{') bodyEnd = matchClose(b, k);
    else { bodyEnd = b.indexOf(';', k); const nl = b.indexOf('\n', k); if (bodyEnd < 0 || (nl >= 0 && nl < bodyEnd && !/[,(]\s*$/.test(b.slice(k, nl)))) bodyEnd = nl < 0 ? b.length : nl; }
    if (bodyEnd < 0) continue;
    const body = src.slice(k, bodyEnd + 1), bodyB = b.slice(k, bodyEnd + 1);
    if (!/\bassert\b/.test(bodyB)) continue;
    // A numeric loop index is not a presence test: `if (i)` is "after the first iteration".
    if (loopIndex(b, subject, m.index, bodyB)) continue;
    // The asserted value must be the one whose presence was tested: the subject in a compared argument, not only in the
    // failure message.
    let refersToSubject = false;
    for (const a of bodyB.matchAll(ASSERT_CALL)) {
      const ao = a.index + a[0].length - 1, ac = matchClose(bodyB, ao);
      if (ac < 0) continue;
      const args = argRanges(bodyB, ao, ac), values = args.slice(0, valueArgs(a[1], args.length));
      if (values.some(([s, e]) => norm(body.slice(s, e)).includes(norm(subject)))) { refersToSubject = true; break; }
    }
    if (!refersToSubject) continue;
    let e = bodyEnd + 1; while (/\s/.test(b[e] ?? '')) e++;
    if (b.startsWith('else', e)) continue;
    add('vacuous-conditional-assert', m.index, `asserts on \`${subject}\` only when it is present; nothing fails when it is absent`);
  }

  // (b) truncated sequence: inline, then through a variable. Each declarator of a declaration is read on its own
  // (`const a = f(), b = x.slice(0, 2)` assigns the slice to b, not to a), and is visible in its own scope only: a
  // `const`/`let` in the block it is declared in (all of it: a closure may read it), a `var` in the whole file.
  const decls = []; // {name, at, from, to, sliced}
  for (const m of b.matchAll(/\b(const|let|var)\s+/g)) {
    const start = m.index + m[0].length;
    let end = b.indexOf(';', start); const nl = b.indexOf('\n', start);
    if (end < 0 || (nl >= 0 && nl < end)) end = nl < 0 ? b.length : nl;
    const [from, to] = m[1] === 'var' ? [0, b.length] : blockOf(b, m.index);
    let at = start;
    for (const part of topLevelArgs(b.slice(start, end))) {
      const d = /^\s*([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(part);
      if (d) decls.push({name: d[1], at: at + d[0].length - d[0].trimStart().length, from, to, sliced: truncates(part.slice(d[0].length))});
      at += part.length + 1;
    }
  }
  // The declaration a name at `p` refers to: the innermost scope holding p (any sliced one, if several share it).
  const slicedAt = (name, p) => {
    const holding = decls.filter(d => d.name === name && d.from <= p && p <= d.to);
    const inner = Math.max(...holding.map(d => d.from));
    return holding.find(d => d.from === inner && d.sliced) ?? null;
  };
  for (const a of b.matchAll(ASSERT_CALL)) {
    if (!/^(deepEqual|deepStrictEqual|equal|strictEqual)$/.test(a[1] ?? '')) continue;
    const ao = a.index + a[0].length - 1, ac = matchClose(b, ao);
    if (ac < 0) continue;
    // The compared values only: the third argument is the failure message.
    const args = topLevelArgs(b.slice(ao + 1, ac)).slice(0, 2).join(',');
    if (truncates(args)) { add('truncated-sequence', a.index, `assert.${a[1]} compares a .slice() of a sequence: items past the cut are not checked`); continue; }
    for (const name of new Set([...args.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)/g)].map(x => x[1]))) {
      const d = slicedAt(name, a.index);
      if (d) { add('truncated-sequence', a.index, `assert.${a[1]} compares \`${name}\`, assigned from a .slice() at line ${lineOf(src, d.at)}`); break; }
    }
  }

  // (c) scripted terminal status: a returned object literal hard-codes a terminal status the file also asserts.
  const asserted = new Set();
  for (const a of b.matchAll(ASSERT_CALL)) {
    const ao = a.index + a[0].length - 1, ac = matchClose(b, ao);
    if (ac < 0) continue;
    for (const s of src.slice(ao + 1, ac).matchAll(/["'`]([a-z_]+)["'`]/g)) if (TERMINAL.includes(s[1])) asserted.add(s[1]);
  }
  for (const m of src.matchAll(/\bstatus\s*:\s*["'`]([a-z_]+)["'`]/g)) {
    if (!TERMINAL.includes(m[1]) || !asserted.has(m[1])) continue;
    if (/^\s/.test(b[m.index]) ) continue; // inside a string or comment
    // Is it in an object literal that a function returns? Look back to the nearest unclosed `{`.
    let depth = 0, i = m.index;
    for (; i >= 0; i--) { if (b[i] === '}') depth++; else if (b[i] === '{') { if (depth === 0) break; depth--; } }
    if (i < 0) continue;
    const before = b.slice(Math.max(0, i - 40), i);
    if (!/(\breturn\s*|=>\s*\(?\s*|\bresolve\s*\(\s*)$/.test(before)) continue;
    // ...and not the expected value of an assert (an object literal inside an assert's arguments).
    const lineText = src.split('\n')[lineOf(src, m.index) - 1];
    if (/\bassert\b/.test(lineText) && lineText.indexOf('assert') < lineText.indexOf('status')) continue;
    add('scripted-terminal-status', m.index, `a fixture returns status '${m[1]}', which this file asserts: check the outcome is not chosen by the fixture`);
  }
  return findings;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'docs']);
export function testFiles(paths) {
  const out = [];
  const walk = p => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) if (!SKIP_DIRS.has(n)) walk(path.join(p, n)); }
    else if (p.endsWith('.test.mjs')) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

export function report(findings, {files, enforce}) {
  const live = findings.filter(f => !f.suppressed);
  const L = [];
  L.push(`## Test lint (${enforce ? 'ENFORCING' : 'report-only'}) -- ${live.length} finding(s) in ${new Set(live.map(f => f.file)).size} of ${files} test file(s)`, '');
  for (const f of findings) {
    const note = f.suppressed ? ` (suppressed: ${f.reason})` : f.suppression_rejected ? ` (suppression REJECTED: ${f.suppression_rejected})` : '';
    L.push(`${f.file}:${f.line}  ${f.rule}${note}  ${f.snippet}`);
  }
  L.push('', '| Rule | Findings | Suppressed |', '|---|---|---|');
  for (const r of RULES) L.push(`| ${r} | ${live.filter(f => f.rule === r).length} | ${findings.filter(f => f.rule === r && f.suppressed).length} |`);
  const rejected = findings.filter(f => f.suppression_rejected).length;
  if (rejected) L.push('', `${rejected} suppression(s) REJECTED for want of a specific reason (\`-- <at least ${MIN_REASON_WORDS} words>\`): counted as findings.`);
  const per = {};
  for (const f of live) per[f.file] = (per[f.file] ?? 0) + 1;
  const top = Object.entries(per).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  if (top.length) { L.push('', 'Top files:'); for (const [f, n] of top) L.push(`- ${f}: ${n}`); }
  L.push('', enforce ? 'Enforcing: any unsuppressed finding fails.' : 'Report-only: exit 0 whatever the count. Enforce with --enforce or OPHANIM_TEST_LINT=enforce.');
  return L.join('\n');
}

export function main(argv) {
  let json = null, enforce = process.env.OPHANIM_TEST_LINT === 'enforce';
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = argv[++i];
    else if (argv[i] === '--enforce') enforce = true;
    else paths.push(path.resolve(argv[i]));
  }
  const files = testFiles(paths.length ? paths : [ROOT]);
  const findings = files.flatMap(f => lintSource(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)));
  console.log(report(findings, {files: files.length, enforce}));
  if (json) fs.writeFileSync(json, JSON.stringify({schema: 'ophanim.test-lint/v1', enforce, files: files.length, findings}, null, 2) + '\n');
  return enforce && findings.some(f => !f.suppressed) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
