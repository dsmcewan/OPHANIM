#!/usr/bin/env node
// MUTATION RUNNER for Slice B2 of the knowledge-graph program: the dependency sources of Graph B
// (ophanim/graph/extract/code.mjs, packages.mjs, needs.mjs, pins.mjs, authority.mjs, board.mjs, their registration in
// index.mjs) and the dependency queries (ophanim/graph/impact.mjs). Modelled on ophanim/graph/graph-b.mutate.mjs. Every
// mutation re-introduces a plausible regression of a property Slice B2 states -- a comment's literal recorded as a
// dependency, a literal outside a recognized call recorded as a dependency, an environment value read, an unresolved
// alias guessed, the declared range recorded as the version, test needs merged into run-time needs, a manifest's region
// limits dropped, the working tree read instead of the commit, a new source without its extractorVersion, impact not
// following a new relationship, a mention admitted as a dependency, a withheld path named -- on a DISPOSABLE COPY of this
// tree (never the tree itself; recorded review findings, `findings-*`, are not copied). Only the tests that decide it run
// there (`tests`: each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node ophanim/graph/graph-b2.mutate.mjs [--only D1,D7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys only; no test reaches a provider or the network. D3 reads an
// environment value ONLY for the synthetic names the deciding test plants (FIXTURE_*, OPHANIM_FIXTURE_*): a mutation
// never reads a real variable's value. This file is read as text by ophanim/graph/extract/verification.mjs and is never
// imported by anything (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEPS_TEST = 'ophanim/graph/extract-deps.test.mjs', QUERIES_TEST = 'ophanim/graph/extract-deps-queries.test.mjs', EXTRACT_TEST = 'ophanim/graph/extract.test.mjs';
const SUITES = [DEPS_TEST, QUERIES_TEST, EXTRACT_TEST];
const CODE = 'ophanim/graph/extract/code.mjs', PACKAGES = 'ophanim/graph/extract/packages.mjs', NEEDS = 'ophanim/graph/extract/needs.mjs';
const AUTHORITY = 'ophanim/graph/extract/authority.mjs', INDEX = 'ophanim/graph/extract/index.mjs', IMPACT = 'ophanim/graph/impact.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- KD2-2: what a literal proves --------------------------------------------------------------------------------------
  {id: 'D1', what: 'a comment is not blanked: a literal in a comment is read as code and recorded as a dependency', tests: [[DEPS_TEST, '^deps: a URL, an environment name or a path in a comment']],
    edits: [one(CODE, String.raw`      if (d === SL) { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; comments.push({start: i, end, text: src.slice(i + 2, end)}); mask.blank(i, end); i = end; continue; }`,
      String.raw`      if (d === SL) { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; comments.push({start: i, end, text: src.slice(i + 2, end)}); i = end; continue; }`)]},
  {id: 'D2', what: 'a literal outside a recognized call (a URL assigned to a constant) is recorded as a host dependency', tests: [[DEPS_TEST, '^deps: a URL, an environment name or a path in a comment'], [QUERIES_TEST, '^query: what a component needs']],
    edits: [one(CODE, String.raw`  const sites = [...[...t.matchAll(/(?<![\w$.])fetch\s*\(/g)].map(m => ({api: 'fetch', at: m.index, open: m.index + m[0].length})),`,
      String.raw`  const sites = [...[...t.matchAll(/(?<![\w$.])(?:fetch\s*\(|=\s*(?=['"]))/g)].map(m => ({api: 'fetch', at: m.index, open: m.index + m[0].length})),`)]},
  {id: 'D11', what: 'a mention is admitted as a dependency (the literals origin structural, its mentions typed depends-on)', tests: [[DEPS_TEST, '^deps: (every new source is registered|a URL, an environment name)']],
    edits: [one(NEEDS, "export const LITERALS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'textual', sources: [LITERALS_SOURCE]});",
      "export const LITERALS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'structural', sources: [LITERALS_SOURCE]});"),
    one(NEEDS, "    drafts.push({type: 'mentions', from: fileId(g.first.from), to: g.first.to, ref: g.first.from,", "    drafts.push({type: 'depends-on', from: fileId(g.first.from), to: g.first.to, ref: g.first.from,")]},
  // ---- KD2-3: never values -----------------------------------------------------------------------------------------------
  {id: 'D3', what: 'an environment value is read and recorded (only the synthetic names the test plants)', tests: [[DEPS_TEST, '^deps: no environment value is read']],
    edits: [one(CODE, "    out.push({name, op, api: 'process.env', line: scan.lineAt(m.index)});",
      "    out.push({name, op, api: 'process.env', line: scan.lineAt(m.index), value: /^(FIXTURE_|OPHANIM_FIXTURE_)/.test(name) ? process.env[name] ?? null : null});"),
    one(NEEDS, "  rel('consumes', reads, r => envId(r.name), 'reads it by name (never its value)', ['api']);", "  rel('consumes', reads, r => envId(r.name), 'reads it by name (never its value)', ['api', 'value']);")]},
  // ---- KD2-4: packages ---------------------------------------------------------------------------------------------------
  {id: 'D4', what: 'an unresolved alias is guessed: a file whose path ends like the specifier is taken as its target', tests: [[DEPS_TEST, '^deps: an alias resolves through the workspace or is a gap']],
    edits: [one(PACKAGES, '      const ghost = unresolvedPackageId(name);',
      "      const guess = [...paths].find(p => p.endsWith(s.slice(name.length + 1)) && /\\.m?js$/.test(p)); if (guess) { rows.push({...base, to: fileId(guess), via: 'a guess by file name'}); continue; }\n      const ghost = unresolvedPackageId(name);")]},
  {id: 'D5', what: 'the declared range is recorded as the resolved version of a declared dependency', tests: [[DEPS_TEST, '^deps: an alias resolves through the workspace or is a gap'], [QUERIES_TEST, '^query: what depends on @google/genai']],
    edits: [one(PACKAGES, 'resolved: to ? (ws ? {workspace: ws.dir} : {lockfile: ROOT_LOCK, entry: hit.key, version: hit.entry.version}) : null};',
      'resolved: to ? (ws ? {workspace: ws.dir} : {lockfile: ROOT_LOCK, entry: hit.key, version: String(range)}) : null};')]},
  // ---- KD2-2: test needs apart -------------------------------------------------------------------------------------------
  {id: 'D6', what: 'test needs are merged into run-time needs', tests: [[DEPS_TEST, '^deps: test needs are kept apart']],
    edits: [one(CODE, String.raw`export const needOf = p => (isTest(p) || /\.mutate\.mjs$/.test(p) || /(^|\/)(tests?|fixtures?)\//.test(p) ? 'test' : 'run-time');`,
      "export const needOf = p => 'run-time';")]},
  // ---- KD2-5: authority --------------------------------------------------------------------------------------------------
  {id: 'D7', what: 'a manifest\'s region limits are dropped from its grants', tests: [[DEPS_TEST, '^deps: a manifest'], [QUERIES_TEST, '^query: which manifest authorized']],
    edits: [one(AUTHORITY, "const QUOTED = ['branch', 'base_commit', 'findings', 'files', 'new_files', 'region_limits', 'interface_rules', 'interface_rule', 'allowed_extra', 'note', 'starts_after'];",
      "const QUOTED = ['branch', 'base_commit', 'findings', 'files', 'new_files', 'interface_rules', 'interface_rule', 'allowed_extra', 'note', 'starts_after'];")]},
  // ---- KD2-1: at a commit, with an extractor version ---------------------------------------------------------------------
  {id: 'D8', what: 'the code is read from the working tree instead of the commit', tests: [[DEPS_TEST, '^deps: the working tree is never read']],
    edits: [one(CODE, "    const text = bytes.get(e.blob).toString('utf8'), scan = PY_CODE.test(e.path) ? scanPy(text) : scanJs(text);",
      "    const text = process.getBuiltinModule('node:fs').readFileSync(path.join(repo, e.path), 'utf8'), scan = PY_CODE.test(e.path) ? scanPy(text) : scanJs(text);")]},
  {id: 'D9', what: 'the new sources are composed without their extractorVersion', tests: [[DEPS_TEST, '^deps: every new source is registered'], [EXTRACT_TEST, '^extract: every source of the systems graph declares']],
    edits: [one(INDEX, '  return {...s, extractorVersion: versions.get(m)};', '  return DEPENDENCY_SOURCES.includes(s.id) || s.id === BOARD_SOURCE ? s : {...s, extractorVersion: versions.get(m)};')]},
  {id: 'D12', what: 'a withheld path (recorded review findings) is named in a gap', tests: [[DEPS_TEST, '^deps: no fact names a withheld path']],
    edits: [one(CODE, "gaps.push({kind: 'path', line: scan.lineAt(c.at), why: WITHHELD.test(r.value.p)", "gaps.push({kind: 'path', line: scan.lineAt(c.at), why: false")]},
  // ---- KD2-8: impact follows the new relationships -----------------------------------------------------------------------
  {id: 'D10', what: 'impact does not follow consumes (a file read by path, a variable read by name) although its impact behaviour says to', tests: [[DEPS_TEST, '^deps: no fact names a withheld path; impact follows consumes'], [QUERIES_TEST, '^query: what a change to a lockfile entry']],
    edits: [one(IMPACT, 'export const CHANGE_TYPES = Object.freeze(IMPACT_TYPES.filter(t => !QUALIFY_TYPES.includes(t)));',
      "export const CHANGE_TYPES = Object.freeze(IMPACT_TYPES.filter(t => !QUALIFY_TYPES.includes(t) && t !== 'consumes'));")]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD.test(f)) continue;                                   // recorded review findings are not read, so not copied
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  // The extractors read the repository AT A COMMIT: the copy is a repository of its own, with one commit of this tree.
  const g = args => execFileSync('git', ['-C', dest, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args], {stdio: 'ignore'});
  g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'copy']);
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `graph-b2-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'graph-b2-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
