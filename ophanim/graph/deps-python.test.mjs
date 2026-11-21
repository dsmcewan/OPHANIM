// The Python reader of the dependency sources (ophanim/graph/deps/python.mjs): one file's text, read by lines and
// tokens (NOT a Python parser), gives what the file needs, in the shape of the JavaScript reader (deps/parse.mjs).
// SYNTHETIC: every file below is text in this test; nothing is run and no other file is opened.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPython} from './deps/python.mjs';

const read = text => readPython(text, {file: 'pkg/a.py'});
const lines = (...l) => l.join('\n') + '\n';
const EMPTY = {imports: [], env: [], programs: [], reads: [], writes: [], hosts: [], strings: [], functions: [], module_calls: [],
  unresolved: {programs: [], reads: [], env: []}};

test('IMPORTS: each module with its line, the names taken, and the number of leading dots of a relative import', () => {
  const r = read(lines(
    'import os',
    'import a.b as c',
    'import json, sys as system',
    'from a.b import c, d as e',
    'from . import x',
    'from ..pkg import y',
    'from .sibling import *',
    'from __future__ import annotations',
  ));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.imports, [
    {specifier: 'os', line: 1, kind: 'static', names: [], default: false, namespace: true, level: 0},
    {specifier: 'a.b', line: 2, kind: 'static', names: [], default: false, namespace: true, level: 0},
    {specifier: 'json', line: 3, kind: 'static', names: [], default: false, namespace: true, level: 0},
    {specifier: 'sys', line: 3, kind: 'static', names: [], default: false, namespace: true, level: 0},
    {specifier: 'a.b', line: 4, kind: 'static', names: ['c', 'd'], default: false, namespace: false, level: 0},
    {specifier: '', line: 5, kind: 'static', names: ['x'], default: false, namespace: false, level: 1},
    {specifier: 'pkg', line: 6, kind: 'static', names: ['y'], default: false, namespace: false, level: 2},
    {specifier: 'sibling', line: 7, kind: 'static', names: [], default: false, namespace: true, level: 1},
    {specifier: '__future__', line: 8, kind: 'static', names: ['annotations'], default: false, namespace: false, level: 0},
  ]);
});

test('IMPORTS ACROSS LINES: a parenthesised list and a backslash continuation are one import, on the line it starts', () => {
  const r = read(lines(
    'from x.y import (',
    '    a,  # the first',
    '    b as bee,',
    ')',
    'from z import p, \\',
    '    q',
    'import after',
  ));
  assert.deepEqual(r.imports, [
    {specifier: 'x.y', line: 1, kind: 'static', names: ['a', 'b'], default: false, namespace: false, level: 0},
    {specifier: 'z', line: 5, kind: 'static', names: ['p', 'q'], default: false, namespace: false, level: 0},
    {specifier: 'after', line: 7, kind: 'static', names: [], default: false, namespace: true, level: 0},
  ]);
});

test('AN IMPORT INSIDE A BLOCK is still an import, marked conditional: indented, or after a block header on its line', () => {
  const r = read(lines(
    'try:',
    '    import fast_json as json',
    'except ImportError:',
    '    import json',
    'def late():',
    '    from heavy import thing',
    'if TYPE_CHECKING: from typing import Any',
    'import plain; import second',
  ));
  assert.deepEqual(r.imports, [
    {specifier: 'fast_json', line: 2, kind: 'static', names: [], default: false, namespace: true, level: 0, conditional: true},
    {specifier: 'json', line: 4, kind: 'static', names: [], default: false, namespace: true, level: 0, conditional: true},
    {specifier: 'heavy', line: 6, kind: 'static', names: ['thing'], default: false, namespace: false, level: 0, conditional: true},
    {specifier: 'typing', line: 7, kind: 'static', names: ['Any'], default: false, namespace: false, level: 0, conditional: true},
    {specifier: 'plain', line: 8, kind: 'static', names: [], default: false, namespace: true, level: 0},
    {specifier: 'second', line: 8, kind: 'static', names: [], default: false, namespace: true, level: 0},
  ]);
});

test('NOT FOOLED: an import written in a comment, a string, a docstring or a triple-quoted string is not an import', () => {
  const r = read(lines(
    '"""Module docstring.',
    'import in_docstring',
    'from in_docstring import x',
    '"""',
    '# import in_comment',
    'text = "import in_string"',
    "block = '''",
    'import in_block',
    "'''",
    's = "a\\"b"; import real_after_escape',
    'def f():',
    '    """Doc.',
    '    from in_function_docstring import y',
    '    """',
    '    return 1  # from in_trailing_comment import z',
  ));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.imports, [{specifier: 'real_after_escape', line: 10, kind: 'static', names: [], default: false, namespace: true, level: 0}]);
});

test('ENVIRONMENT VARIABLES: the NAME read through os, by key, get and getenv, under an alias too; never a default', () => {
  const r = read(lines(
    'import os',
    'import os as _os',
    'from os import environ, getenv as ge',
    "a = os.environ['ALPHA_KEY']",
    "b = os.environ.get('BETA_ROOT', 'fallback-value')",
    "c = os.getenv('GAMMA', 'another-default')",
    "d = _os.environ.get(\"DELTA\")",
    "e = environ['EPSILON']",
    "f = ge('ZETA')",
    "g = config.environ['NOT_OS']",
    "h = self.os.getenv('NOT_OS_EITHER')",
    "# os.environ['IN_A_COMMENT']",
    "os.environ['SET_HERE'] = 'assigned-value'",
    "same = os.environ['COMPARED'] == 'x'",
    "os.environ.setdefault('DEFAULTED', 'dummy-value')",
    'everything = dict(os.environ)',
  ));
  assert.deepEqual(r.env, [
    {name: 'ALPHA_KEY', line: 4}, {name: 'BETA_ROOT', line: 5}, {name: 'GAMMA', line: 6}, {name: 'DELTA', line: 7},
    {name: 'EPSILON', line: 8}, {name: 'ZETA', line: 9}, {name: 'SET_HERE', line: 13, assigned: true}, {name: 'COMPARED', line: 14},
    {name: 'DEFAULTED', line: 15},
  ]);
  const said = JSON.stringify(r);
  assert.deepEqual(['fallback-value', 'another-default', 'assigned-value', 'dummy-value'].filter(v => said.includes(v)), [], 'no default and no assigned value is kept anywhere in the reading');
});

test('ENVIRONMENT VARIABLES inside an f-string are read, and a name that is not a literal is counted, not guessed', () => {
  const r = read(lines(
    'import os',
    'title = f"""Case {os.environ.get("CASE_NUMBER", "none-given")}',
    '  and {os.environ["CASE_TITLE"]!r:>10}"""',
    'def need(name):',
    '    return os.getenv(name)',
    'x = os.environ[prefix + "_KEY"]',
    'y = os.environ.get(f"{prefix}_URL")',
    "z = os.getenv('not a name')",
  ));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.env, [{name: 'CASE_NUMBER', line: 2}, {name: 'CASE_TITLE', line: 3}]);
  assert.deepEqual(r.unresolved.env, [{line: 5, call: 'getenv'}, {line: 6, call: 'environ'}, {line: 7, call: 'get'}, {line: 8, call: 'getenv'}]);
  assert.equal(JSON.stringify(r).includes('none-given'), false);
});

test('PROGRAMS: the first element of a literal list, or the first word of a literal string, given to subprocess or os.system', () => {
  const r = read(lines(
    'import os, subprocess',
    'import subprocess as sp',
    'from subprocess import Popen, check_output as co',
    "subprocess.run(['git', 'status'], check=True)",
    "subprocess.call('tar -xzf a.tgz', shell=True)",
    'sp.check_call(',
    '    ["docker", "compose", "up"],',
    ')',
    "co(('node', '--version'))",
    "Popen(['/usr/bin/node', script])",
    "os.system('make all')",
    'subprocess.run([sys.executable, "tool.py"])',
    'subprocess.run(cmd, capture_output=True)',
    "subprocess.run(f'{tool} --flag')",
    "other.run(['not-subprocess'])",
    "handler = subprocess.run",
    "subprocess.run(['rsync'] + extra)",
    "subprocess.run(('ls -l'), shell=True)",
    "subprocess.run(['pre' + fix, 'x'])",
  ));
  assert.deepEqual(r.programs, [
    {name: 'git', line: 4, call: 'run'}, {name: 'tar', line: 5, call: 'call'}, {name: 'docker', line: 6, call: 'check_call'},
    {name: 'node', line: 9, call: 'check_output'}, {name: '/usr/bin/node', line: 10, call: 'Popen'}, {name: 'make', line: 11, call: 'system'},
    {name: 'rsync', line: 17, call: 'run'}, {name: 'ls', line: 18, call: 'run'},
  ]);
  assert.deepEqual(r.unresolved.programs, [{line: 12, call: 'run'}, {line: 13, call: 'run'}, {line: 14, call: 'run'}, {line: 19, call: 'run'}],
    'a program that is not a literal is counted, not guessed');
});

test('FILES READ AND WRITTEN: the literal path given to open() by its mode, and to Path(...).read_text and its kin', () => {
  const r = read(lines(
    'from pathlib import Path',
    'import pathlib',
    "a = open('data/in.json')",
    "b = open('./notes.txt', 'r', encoding='utf-8')",
    "c = open('out/log.txt', 'a')",
    "d = open('out/new.bin', mode='wb')",
    "e = Path('conf/settings.toml').read_text()",
    "f = pathlib.Path('conf/blob.bin').read_bytes()",
    "Path('out/report.md').write_text(body)",
    'g = open(computed)',
    'h = open(computed, "w")',
    "i = open('data/either.txt', mode)",
    'j = (ROOT / "x.json").read_text()',
    'k = Path(name).read_bytes()',
    "l = archive.open('not-the-builtin.txt')",
    'target.write_text("ignored: a write to a computed path is not counted")',
  ));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.reads, [
    {path: 'data/in.json', line: 3, call: 'open', relative: false},
    {path: './notes.txt', line: 4, call: 'open', relative: true},
    {path: 'conf/settings.toml', line: 7, call: 'read_text', relative: false},
    {path: 'conf/blob.bin', line: 8, call: 'read_bytes', relative: false},
  ]);
  assert.deepEqual(r.writes, [
    {path: 'out/log.txt', line: 5, call: 'open', relative: false},
    {path: 'out/new.bin', line: 6, call: 'open', relative: false},
    {path: 'out/report.md', line: 9, call: 'write_text', relative: false},
  ]);
  assert.deepEqual(r.unresolved.reads, [{line: 10, call: 'open'}, {line: 12, call: 'open'}, {line: 13, call: 'read_text'}, {line: 14, call: 'read_bytes'}],
    'a computed path, or a literal path whose mode is computed, is counted as a read that could not be resolved');
});

test('A NAME THE FILE REDEFINES is not read as the import or the builtin of that name', () => {
  const r = read(lines(
    'from subprocess import run',
    'def run(cmd):',
    '    return cmd',
    'def open(path):',
    '    return path',
    "run(['git'])",
    "open('data/x.json')",
  ));
  assert.deepEqual([r.programs, r.reads, r.unresolved.programs, r.unresolved.reads], [[], [], [], []]);
});

test('HOSTS AND PATH-LIKE STRINGS: from string literals with the line they are written on; comments and docstrings are not read', () => {
  const r = read(lines(
    '"""See https://docstring.example.test/guide and docs/in-docstring.md."""',
    "BASE = 'https://api.example.test/v1'",
    'url = f"https://files.example.test/{name}"',
    '# https://comment.example.test',
    "p = 'pantheon/src/config/lanes.json'",
    "q = 'plain words are not a path'",
    'QUERY = """',
    'select 1',
    '-- http://Inside.Example.TEST/x',
    '"""',
    "r = b'https://bytes.example.test'",
  ));
  assert.deepEqual(r.hosts, [{host: 'api.example.test', line: 2}, {host: 'files.example.test', line: 3}, {host: 'inside.example.test', line: 9},
    {host: 'bytes.example.test', line: 11}]);
  assert.deepEqual(r.strings, [{value: 'pantheon/src/config/lanes.json', line: 5}]);
});

test('FUNCTIONS: each top-level def and class with its line; a leading underscore is not exported; calls are not attempted', () => {
  const r = read(lines(
    'import helpers',
    '@decorated',
    'def public(x):',
    '    def nested(): pass',
    '    return helpers.work(x)',
    'async def fetch(): pass',
    'def _private(): pass',
    'class Box(Base):',
    '    def method(self): pass',
    'class _Hidden: pass',
    'if FLAG:',
    '    def conditional(): pass',
    'public(1)',
  ));
  assert.deepEqual(r.functions, [
    {name: 'public', line: 3, exported: true, calls: []},
    {name: 'fetch', line: 6, exported: true, calls: []},
    {name: '_private', line: 7, exported: false, calls: []},
    {name: 'Box', line: 8, exported: true, calls: []},
    {name: '_Hidden', line: 10, exported: false, calls: []},
  ]);
  assert.deepEqual(r.module_calls, []);
});

test('STRINGS ARE TOKENS, NOT TEXT: prefixes, escaped quotes and nested quotes in an f-string do not derail the reading', () => {
  const r = read(lines(
    'import os',
    "a = 'it\\'s # not a comment'  # a real comment: import nothing",
    String.raw`b = rb"\d+\"" + R'\''`,
    'c = f"{d["key"]} {{literal}} {os.getenv("FROM_NESTED")}"',
    'd = f"{value:{width}.{precision}} {x!r} {a != b}"',
    String.raw`e = f'\N{BULLET} {{not a field}}'`,
    'import after_all_of_that',
  ));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.imports.map(i => [i.specifier, i.line]), [['os', 1], ['after_all_of_that', 7]]);
  assert.deepEqual(r.env, [{name: 'FROM_NESTED', line: 4}]);
});

test('A FILE THAT DOES NOT CLOSE WHAT IT OPENS is refused, with the line, and gives no facts', () => {
  const triple = read(lines('import os', 'x = """never closed', 'import hidden'));
  assert.deepEqual(triple, {ok: false, why: 'the triple-quoted string opened on line 2 is never closed', ...EMPTY});
  const bracket = read(lines('import os', 'x = call(1,', '  [2, 3]'));
  assert.deepEqual(bracket, {ok: false, why: 'the "(" opened on line 2 is never closed', ...EMPTY});
  const wrong = read(lines('x = (1, 2]'));
  assert.deepEqual(wrong, {ok: false, why: 'line 1: "]" closes the "(" opened on line 1', ...EMPTY});
  const stray = read(lines('import os', 'x = 1)'));
  assert.deepEqual(stray, {ok: false, why: 'line 2: ")" closes nothing', ...EMPTY});
  const single = read(lines("x = 'not closed on its line", 'import os'));
  assert.deepEqual(single, {ok: false, why: 'the string opened on line 1 is not closed on that line', ...EMPTY});
  const field = read(lines('x = f"{never closed'));
  assert.deepEqual(field, {ok: false, why: 'the replacement field of the f-string opened on line 1 is never closed', ...EMPTY});
});

test('AN IMPORT STATEMENT THAT CANNOT BE READ refuses the file rather than guessing what it imports', () => {
  assert.deepEqual(read(lines('import os', 'from a import')), {ok: false, why: 'line 2: an import statement this reader cannot read', ...EMPTY});
  assert.deepEqual(read(lines('import 3')), {ok: false, why: 'line 1: an import statement this reader cannot read', ...EMPTY});
});

test('the same text gives the same reading, and an empty file reads as nothing', () => {
  const text = lines('import os', "def f(): return os.getenv('X')");
  assert.deepEqual(read(text), read(text));
  assert.deepEqual(readPython(''), {ok: true, ...EMPTY});
});
