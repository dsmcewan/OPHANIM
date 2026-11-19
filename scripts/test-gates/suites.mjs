// Every node:test suite this repository runs, derived from the package.json scripts CI invokes -- not a hand list.
//
//   root `test`        -> each `npm --prefix DIR test [-- ARGS]` segment -> DIR/package.json `test` (`node --test ...`)
//   root `test:proof`  -> `node --test GLOBS` from the root
//   root `test:gates:self` -> the gate's own tests
//
// A script this module cannot read as `node --test [flags] [patterns]` throws, so a suite cannot be added in a form
// the gate silently ignores. workflowRuns() lists every test-shaped command in .github/workflows so coverage can be
// checked against the suites (see coverage()).
//
// Inputs:  package.json files; .github/workflows/*.yml.
// Outputs: [{id, label, cwd, flags, patterns, files}] (files: the test files the patterns expand to).
// Must never: return a suite without its files, or skip a script it does not understand.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// node:test's own default patterns (Node 22/24) when `node --test` is given none.
const DEFAULT_PATTERNS = ['**/*.test.{cjs,mjs,js}', '**/*-test.{cjs,mjs,js}', '**/*_test.{cjs,mjs,js}',
  '**/test-*.{cjs,mjs,js}', '**/test.{cjs,mjs,js}', '**/test/**/*.{cjs,mjs,js}'];
// The root scripts that are suites. Each is named in the qualification workflow (coverage() checks it).
export const ROOT_SUITE_SCRIPTS = ['test', 'test:proof', 'test:gates:self'];
// Root scripts named test* that run no suite of their own: the gate (re-runs suites) and the lint (reads sources).
export const NON_SUITE_SCRIPTS = ['test:gates', 'test:lint'];

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Split a `node --test ...` command into flags and patterns; throws on anything else. */
export function parseNodeTest(cmd, where) {
  const words = cmd.trim().split(/\s+/);
  if (words[0] !== 'node' || words[1] !== '--test') throw new Error(`${where}: not a \`node --test\` command: ${cmd}`);
  const flags = [], patterns = [];
  for (const w of words.slice(2)) {
    if (/[;&|<>$`]/.test(w)) throw new Error(`${where}: shell syntax the gate does not model: ${cmd}`);
    (w.startsWith('-') ? flags : patterns).push(w);
  }
  return {flags, patterns};
}

/** The files a `node --test` invocation runs, from cwd, excluding node_modules (as node:test does). */
export function expand(cwd, patterns) {
  const pats = patterns.length ? patterns : DEFAULT_PATTERNS;
  const out = new Set();
  for (const p of pats) {
    for (const f of fs.globSync(p, {cwd, exclude: n => /(^|\/)node_modules$/.test(n)})) {
      if (!f.split(path.sep).includes('node_modules')) out.add(path.resolve(cwd, f));
    }
  }
  return [...out].sort();
}

/** The suites, in the order `npm test` then `npm run test:proof` runs them. */
export function suites(root = ROOT) {
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg.scripts ?? {};
  const out = [];
  for (const name of ROOT_SUITE_SCRIPTS) {
    const cmd = scripts[name];
    if (cmd === undefined) throw new Error(`package.json: missing suite script "${name}"`);
    if (/^\s*node --test\b/.test(cmd)) {
      const {flags, patterns} = parseNodeTest(cmd, `package.json scripts["${name}"]`);
      out.push({id: name, label: name, script: name, cwd: root, flags, patterns, files: expand(root, patterns)});
      continue;
    }
    // `npm --prefix DIR test [-- ARGS]` segments joined by &&.
    for (const seg of cmd.split('&&').map(s => s.trim())) {
      const m = /^npm --prefix (\S+) test(?: -- (.*))?$/.exec(seg);
      if (!m) throw new Error(`package.json scripts["${name}"]: segment the gate does not model: ${seg}`);
      const dir = path.resolve(root, m[1]);
      const sub = readJson(path.join(dir, 'package.json'));
      const t = sub.scripts?.test;
      if (!t) throw new Error(`${m[1]}/package.json: no test script`);
      const {flags, patterns} = parseNodeTest(t, `${m[1]}/package.json scripts.test`);
      const extra = m[2] ? m[2].trim().split(/\s+/) : [];
      // npm appends `-- ARGS` after the script: node:test honours flags there only when no pattern precedes them.
      if (extra.length && patterns.length) throw new Error(`${m[1]}: flags after file patterns are ignored by node --test: ${seg}`);
      out.push({id: `${name}:${sub.name}`, label: `${name}: ${sub.name} test`, script: name, pkg: sub.name, cwd: dir,
        flags: [...flags, ...extra], patterns, files: expand(dir, patterns)});
    }
  }
  return out;
}

/** Every test-shaped command in the workflows: npm test, npm run X, node --test. */
export function workflowRuns(root = ROOT) {
  const dir = path.join(root, '.github/workflows');
  const out = [];
  for (const f of fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort()) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const m of line.matchAll(/\bnpm (?:test\b|run (?:-[\w-]+ )*([\w:.-]+))|\bnode --test\b/g)) {
        out.push({workflow: f, line: i + 1, command: m[0], script: m[0] === 'npm test' ? 'test' : m[1] ?? null});
      }
    });
  }
  return out;
}

/**
 * Coverage: every workflow test command maps to a suite script, every suite script is run by the qualification
 * workflow, and every *.test.mjs in the repo (outside node_modules and recorded review material) is in some suite.
 */
export function coverage(root = ROOT) {
  const all = suites(root);
  const runs = workflowRuns(root);
  const problems = [];
  const testScripts = new Set(ROOT_SUITE_SCRIPTS);
  for (const r of runs) {
    if (r.command === 'node --test') problems.push(`${r.workflow}:${r.line}: a bare \`node --test\` the gate does not model`);
    else if (r.script && r.script.startsWith('test') && !testScripts.has(r.script) && !NON_SUITE_SCRIPTS.includes(r.script))
      problems.push(`${r.workflow}:${r.line}: \`${r.command}\` is not a suite the gate knows`);
  }
  const pkgScripts = Object.keys(readJson(path.join(root, 'package.json')).scripts ?? {});
  for (const s of pkgScripts.filter(n => /^test(:|$)/.test(n))) {
    if (!ROOT_SUITE_SCRIPTS.includes(s) && !NON_SUITE_SCRIPTS.includes(s)) problems.push(`package.json script "${s}" is neither a suite the gate knows nor a declared non-suite script`);
  }
  for (const s of [...ROOT_SUITE_SCRIPTS, ...NON_SUITE_SCRIPTS]) {
    if (!runs.some(r => r.workflow === 'qualification.yml' && r.script === s)) problems.push(`qualification.yml does not run the script "${s}"`);
  }
  const covered = new Set(all.flatMap(s => s.files));
  // docs/ holds recorded review material (reproductions included), not suites; it is not traversed.
  const orphans = fs.globSync('**/*.test.mjs', {cwd: root, exclude: n => n === 'docs' || /(^|\/)(node_modules|\.git)$/.test(n)})
    .filter(f => !f.split(path.sep).includes('node_modules') && !f.includes('/fixtures/'))
    .map(f => path.resolve(root, f)).filter(f => !covered.has(f));
  return {suites: all, runs, problems, orphans: orphans.map(f => path.relative(root, f)).sort()};
}
