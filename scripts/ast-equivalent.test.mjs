import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameProgram, normalize} from './ast-equivalent.mjs';

// What a reformat may change: the checker must say SAME. Each row is [name, before, after].
const SAME = [
  ['whitespace, semicolons and comments', 'const a = 1; f(a)', 'const a = 1\n// note\nf(a);\n;'],
  ['parentheses', 'if (x && y) f()', 'if ((x && y)) f()'],
  ['quote style', "f('a', \"b\")", 'f("a", \'b\')'],
  ['number spelling', 'f(1e3, 0xff)', 'f(1E3, 0xFF)'],
  ['trailing commas', 'f([1, 2], {a: 1})', 'f([1, 2,], {a: 1,},)'],
  ['a line break inside a template placeholder', 'f(`v=${x ? y : z}`)', 'f(`v=${x\n ? y\n : z}`)'],
  ['a string split across lines', "f('hello world')", "f('hello ' +\n  'world')"],
  ['a template split across lines', 'f(`a ${x} b ${y} c`)', 'f(`a ${x} b ` +\n  `${y} c`)'],
  ['a string joined into a template', 'f(`ab ${x}`)', "f('a' + `b ${x}`)"],
  ['a split literal under a parenthesised property access', 'f(`abc`.length)', 'f((`a` + `bc`).length)'],
  ['an if/else re-wrapped', 'if (x) y(); else z();', 'if (x)\n  y();\nelse\n  z();'],
  ['a tagged template that is unchanged', 'String.raw`a${x}b`', 'String.raw`a${x}b`'],
];

// What a reformat must never change: the checker must say DIFFERENT.
const DIFFERENT = [
  ['object key order', 'f({b: 1, a: 2})', 'f({a: 2, b: 1})'],
  ['array element order', 'f([1, 2])', 'f([2, 1])'],
  ['call argument order', 'f(a, b)', 'f(b, a)'],
  ['a logical operator', 'f(x && y)', 'f(x || y)'],
  ['nullish vs or', 'f(x ?? 0)', 'f(x || 0)'],
  ['a string value', "f('hello')", "f('hello!')"],
  ['a string differing only in case', "f('Hello')", "f('hello')"],
  ['a template text', 'f(`a ${x} end`)', 'f(`a ${x} fin`)'],
  ['a number value', 'f(1e3)', 'f(1e4)'],
  ['an embedded expression', 'f(`a ${x} b`)', 'f(`a ${y} ` + `b`)'],
  ['embedded expressions swapped', 'f(`${x} ${y}`)', 'f(`${y} ` + `${x}`)'],
  ['a split text that changed in one half', 'f(`a b`)', 'f(`a ` + `c`)'],
  ['a split that lost its parentheses (precedence)', 'f(`abc`.length)', 'f(`a` + `bc`.length)'],
  ['a non-literal operand (`+` coerces it)', 'f(`a${x}b`)', "f('a' + x + 'b')"],
  ['a tagged template text', 'String.raw`a${x}b`', 'String.raw`a${x}c`'],
  ['a tagged template escape vs the character (raw text differs)', 'String.raw`\\n`', 'String.raw`\n`'],
  ['statement order', 'a(); b()', 'b(); a()'],
  ['const to let', 'const s = 1', 'let s = 1'],
  ['const to var', 'const s = 1', 'var s = 1'],
  ['let to var', 'let s = 1', 'var s = 1'],
  ['a dropped await', 'async () => { await f() }', 'async () => { f() }'],
  ['a dropped async', 'async (x) => x', '(x) => x'],
  ['a dropped optional chain', 'f(x?.[k])', 'f(x[k])'],
  ['a dropped spread', 'f([x, ...y])', 'f([x, y])'],
  ['a dropped rest parameter', 'function f(...a) {}', 'function f(a) {}'],
  ['a dropped generator star', 'function* g() {}', 'function g() {}'],
  ['yield* turned into yield', 'function* g() { yield* h() }', 'function* g() { yield h() }'],
  ['an arrow expression turned into a block', 'f(x => x + 1)', 'f(x => { return x + 1 })'],
  ['an empty statement body vs an empty block', 'if (x) ; else y()', 'if (x) {} else y()'],
  ['a line break that triggers semicolon insertion', 'function f() { return x }', 'function f() { return\nx }'],
];

for (const [name, before, after] of SAME) {
  test(`same program: ${name}`, () => assert.equal(sameProgram(before, after), true));
}
for (const [name, before, after] of DIFFERENT) {
  test(`different program: ${name}`, () => assert.equal(sameProgram(before, after), false));
}

test('a source that does not parse is an error, never a quiet match', () => {
  assert.throws(() => normalize('const = ;', 'broken.mjs'), /broken\.mjs/);
  assert.throws(() => sameProgram('const = ;', 'const = ;'), /before/);
});
