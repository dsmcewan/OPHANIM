// The code reader of the dependency sources (ophanim/graph/deps/parse.mjs): one file's text, read with a real parser,
// gives what the file NEEDS, each with the line it is written on. SYNTHETIC: every file below is text in this test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCode} from './deps/parse.mjs';

const read = text => readCode(text, {file: 'lib/a.mjs'});
const lines = (...l) => l.join('\n') + '\n';

test('IMPORTS: every specifier with its line and the names taken, static, dynamic, re-exported and side-effect only', () => {
  const r = read(lines(
    "import fs from 'node:fs';",
    "import * as path from 'node:path';",
    "import OpenAI, {toFile as tf} from 'openai';",
    "import {b, c as d} from './b.mjs';",
    "import './side.mjs';",
    "export {e} from '../e.mjs';",
    "export * from './all.mjs';",
    "const lazy = () => import('@scope/pkg/sub');",
    "// import nothing from 'a-comment';",
    "const s = \"from 'a-string'\";",
  ));
  assert.equal(r.ok, true);
  assert.deepEqual(r.imports, [
    {specifier: 'node:fs', line: 1, kind: 'static', names: [], default: true, namespace: false},
    {specifier: 'node:path', line: 2, kind: 'static', names: [], default: false, namespace: true},
    {specifier: 'openai', line: 3, kind: 'static', names: ['toFile'], default: true, namespace: false},
    {specifier: './b.mjs', line: 4, kind: 'static', names: ['b', 'c'], default: false, namespace: false},
    {specifier: './side.mjs', line: 5, kind: 'static', names: [], default: false, namespace: false},
    {specifier: '../e.mjs', line: 6, kind: 'reexport', names: ['e'], default: false, namespace: false},
    {specifier: './all.mjs', line: 7, kind: 'reexport', names: [], default: false, namespace: true},
    {specifier: '@scope/pkg/sub', line: 8, kind: 'dynamic', names: [], default: false, namespace: false},
  ], 'a specifier in a comment or a string is not an import');
});

test('ENVIRONMENT VARIABLES: the NAME read from process.env, by property, by key and by destructuring; never a value', () => {
  const r = read(lines(
    "const a = process.env.ALPHA_KEY;",
    "const b = process.env['BETA_ROOT'] ?? 'fallback-value';",
    "const {GAMMA, DELTA: local} = process.env;",
    "const other = config.env.NOT_PROCESS;",
    "const all = process.env;",
    "// process.env.IN_A_COMMENT",
  ));
  assert.deepEqual(r.env, [{name: 'ALPHA_KEY', line: 1}, {name: 'BETA_ROOT', line: 2}, {name: 'GAMMA', line: 3}, {name: 'DELTA', line: 3}]);
  assert.ok(!JSON.stringify(r.env).includes('fallback-value'));
});

test('PROGRAMS: what is run through node:child_process, by name; a regular expression\'s exec() is not a program', () => {
  const r = read(lines(
    "import {spawn, execFileSync as run} from 'node:child_process';",
    "import * as cp from 'node:child_process';",
    "spawn('git', ['status']);",
    "run('bwrap', ['--ro-bind', '/', '/']);",
    "cp.execSync('tar -xzf a.tgz');",
    "cp.spawnSync(binary, []);",
    "const m = /x/.exec('git');",
    "other.spawn('not-child-process');",
  ));
  assert.deepEqual(r.programs, [{name: 'git', line: 3, call: 'spawn'}, {name: 'bwrap', line: 4, call: 'execFileSync'}, {name: 'tar', line: 5, call: 'execSync'}]);
  assert.deepEqual(r.unresolved.programs, [{line: 6, call: 'spawnSync'}], 'a program that is not a literal is counted, not guessed');
});

test('FILES READ BY PATH: the literal inside a node:fs read, through path.join and through a constant of the file', () => {
  const r = read(lines(
    "import fs, {readFileSync} from 'node:fs';",
    "import path from 'node:path';",
    "const ROOT = '/somewhere';",
    "const LANES = path.join(ROOT, 'pantheon/src/config', 'lanes.json');",
    "const a = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'a.json'), 'utf8'));",
    "const b = fs.readFileSync(LANES, 'utf8');",
    "const c = fs.readFileSync(new URL('./sibling.json', import.meta.url));",
    "const d = fs.readFileSync(computed());",
    "fs.writeFileSync('out/written.json', '{}');",
    "const e = other.readFileSync('not-fs.json');",
  ));
  assert.deepEqual(r.reads, [
    {path: 'docs/a.json', line: 5, call: 'readFileSync', relative: false},
    {path: 'pantheon/src/config/lanes.json', line: 6, call: 'readFileSync', relative: false, constant: 'LANES'},
    {path: './sibling.json', line: 7, call: 'readFileSync', relative: true},
  ]);
  assert.deepEqual(r.unresolved.reads, [{line: 8, call: 'readFileSync'}], 'a computed path is counted, not guessed');
  assert.deepEqual(r.writes, [{path: 'out/written.json', line: 9, call: 'writeFileSync', relative: false}]);
});

test('HOSTS AND OTHER STRINGS: a URL\'s host with its line; strings are kept for the textual source, comments are not', () => {
  const r = read(lines(
    "const BASE = 'https://api.example.test/v1';",
    "const u = `https://files.example.test/${id}`;",
    "// https://comment.example.test",
    "const p = 'pantheon/src/config/lanes.json';",
  ));
  assert.deepEqual(r.hosts, [{host: 'api.example.test', line: 1}, {host: 'files.example.test', line: 2}]);
  assert.deepEqual(r.strings.filter(s => s.value.includes('lanes')), [{value: 'pantheon/src/config/lanes.json', line: 4}]);
});

test('FUNCTIONS AND CALLS: each top-level function with the calls it makes to an imported name, a namespace member or a function of the file', () => {
  const r = read(lines(
    "import {digest} from './crypto.mjs';",
    "import * as store from './store.mjs';",
    "import make from './make.mjs';",
    "function helper(x) { return digest(x); }",
    "export function save(x) { const h = helper(x); store.put(h, x); return make(h); }",
    "export const load = async id => { const digest = id => id; return digest(id); };",
    "const quiet = function (store) { return store.put(1); };",
    "export class Box { open() { return helper(1); } }",
    "helper(0);",
  ));
  const by = Object.fromEntries(r.functions.map(f => [f.name, f]));
  assert.deepEqual(Object.keys(by), ['helper', 'save', 'load', 'quiet', 'Box']);
  assert.deepEqual([by.helper.exported, by.save.exported, by.Box.exported, by.helper.line, by.Box.line], [false, true, true, 4, 8]);
  assert.deepEqual(by.helper.calls, [{line: 4, imported: 'digest', specifier: './crypto.mjs'}]);
  assert.deepEqual(by.save.calls, [{line: 5, local: 'helper'}, {line: 5, imported: 'put', specifier: './store.mjs'}, {line: 5, imported: 'default', specifier: './make.mjs'}]);
  assert.deepEqual(by.load.calls, [], 'a name declared inside the function shadows the import: no call is recorded');
  assert.deepEqual(by.quiet.calls, [], 'a parameter shadows the namespace import');
  assert.deepEqual(by.Box.calls, [{line: 8, local: 'helper'}]);
  assert.deepEqual(r.module_calls, [{line: 9, local: 'helper'}], 'a call at the top level belongs to the module');
});

test('A FILE THAT DOES NOT PARSE is reported, with what the parser said, and gives no facts', () => {
  const r = read("import {a from './a.mjs';\nexport const = ;\n");
  assert.equal(r.ok, false);
  assert.match(r.why, /^the parser reports \d+ syntax error\(s\); first at line 1: /);
  assert.deepEqual([r.imports, r.env, r.programs, r.reads, r.functions], [[], [], [], [], []]);
});

test('A TYPESCRIPT FILE is read as TypeScript by its extension: type-only syntax is not a syntax error', () => {
  const text = lines("import type {T} from './types.ts';", "import {make} from './make.ts';", "export function f(x: T): string { return make<T>(x) as string; }");
  const ts = readCode(text, {file: 'src/a.ts'});
  assert.equal(ts.ok, true);
  assert.deepEqual(ts.imports.map(i => i.specifier), ['./types.ts', './make.ts']);
  assert.deepEqual(ts.functions[0].calls, [{line: 3, imported: 'make', specifier: './make.ts'}]);
  assert.deepEqual(readCode(text, {file: 'src/a.mjs'}).functions[0].calls, [], 'read as JavaScript, make<T>(x) is two comparisons and no call: the extension decides');
});

test('the same text gives the same reading', () => {
  const text = lines("import {a} from './a.mjs';", "export function f() { return a(process.env.X); }");
  assert.deepEqual(read(text), read(text));
});
