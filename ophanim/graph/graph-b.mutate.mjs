#!/usr/bin/env node
// MUTATION RUNNER for Slice B of the knowledge-graph program: the systems and evidence graph's extractors
// (ophanim/graph/extract/), impact, reassessment and traceability (ophanim/graph/impact.mjs) and the context operation
// (ophanim/operate/context.mjs `graph`). Modelled on packages/graph/tests/graph.mutate.mjs. Every mutation re-introduces a
// plausible regression of a property Slice B states -- the working tree read instead of the commit, a mention admitted as
// a dependency, a mutation runner executed instead of read as text, impact following a qualification or widened to the
// whole graph, a reassessment over every node, the context operation returning a summary without its references, its
// byte or node bound removed, a traceability gap filled by a name match, a missing source reported as current, the
// status ledger opened writable, an unresolved citation shown as an entry, a fact's ref carrying the version -- on a
// DISPOSABLE COPY of this tree (never the tree itself; recorded review findings, `findings-*`, are not copied). Only the
// tests that decide it run there (`tests`: each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node ophanim/graph/graph-b.mutate.mjs [--only B1,B7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys only; no test reaches a provider. This file is read as text by
// ophanim/graph/extract/verification.mjs and is never imported by anything (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRACT_TEST = 'ophanim/graph/extract.test.mjs', IMPACT_TEST = 'ophanim/graph/impact.test.mjs', CONTEXT_TEST = 'ophanim/graph/graph-context.test.mjs', CLI_TEST = 'ophanim/graph/cli.test.mjs';
const SUITES = [EXTRACT_TEST, IMPACT_TEST, CONTEXT_TEST, CLI_TEST];
const REPO = 'ophanim/graph/extract/repo.mjs', RECORDS = 'ophanim/graph/extract/records.mjs', VERIFY = 'ophanim/graph/extract/verification.mjs';
const LEDGERS = 'ophanim/graph/extract/ledgers.mjs', IMPACT = 'ophanim/graph/impact.mjs', CONTEXT = 'ophanim/operate/context.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- KB1: the extractors ---------------------------------------------------------------------------------------------
  {id: 'B1', what: 'the repository extractor reads the working tree instead of the commit', tests: [[EXTRACT_TEST, '^extract: the repository is read at a commit']],
    edits: [one(REPO, "  const text = new Map([...code, ...tickets].map(e => [e.path, bytes.get(e.blob).toString('utf8')]));",
      "  const text = new Map([...code, ...tickets].map(e => [e.path, process.getBuiltinModule('node:fs').readFileSync(path.join(repo, e.path), 'utf8')]));")]},
  {id: 'B2', what: 'a mention is admitted as depends-on (the records origin declared, its citation edges typed depends-on)', tests: [[EXTRACT_TEST, '^extract: the register']],
    edits: [one(RECORDS, "export const RECORDS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'textual', sources: [SOURCE_ID]});",
      "export const RECORDS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});"),
    one(RECORDS, "    drafts.push({type: 'mentions', from: fileId(c.path), to: recordId(c.id), ref: c.path,", "    drafts.push({type: 'depends-on', from: fileId(c.path), to: recordId(c.id), ref: c.path,")]},
  {id: 'B3', what: 'a mutation runner is executed (imported) instead of read as text', tests: [[EXTRACT_TEST, '^extract: mutation runners are read as TEXT']],
    edits: [one(VERIFY, "    const table = mutationTable(text.get(r.blob).toString('utf8')), ids = new Set();",
      "    const table = (process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['--input-type=module', '-e', text.get(r.blob).toString('utf8')], {cwd: repo, stdio: 'ignore'}), mutationTable(text.get(r.blob).toString('utf8'))), ids = new Set();")]},
  {id: 'B12', what: 'the status ledger is opened writable (create: true): an absent ledger is created, keys and all', tests: [[EXTRACT_TEST, '^extract: the status ledger is read ONLY']],
    edits: [one(LEDGERS, '  return openStatusLedger({root, anchor, create: false, keys: null});', '  return openStatusLedger({root, anchor, create: true, keys: null});')]},
  {id: 'B13', what: 'an id cited by code but defined by no register entry is shown as an entry (not unresolved)', tests: [[EXTRACT_TEST, '^extract: the register']],
    edits: [one(RECORDS, "    drafts.push({entity: recordId(id), ref: `${register}#${id}`, status: 'unresolved',", "    drafts.push({entity: recordId(id), ref: `${register}#${id}`,")]},
  {id: 'B14', what: 'a fact\'s ref carries the commit: every commit changes every fact (a global invalidation by the back door)', tests: [[IMPACT_TEST, '^reassess:']],
    edits: [one(REPO, '  const drafts = [], ref = p => p;', '  const drafts = [], ref = p => `${p}@${commit.slice(0, 12)}`;')]},
  // ---- KB2: impact and reassessment --------------------------------------------------------------------------------------
  {id: 'B4', what: 'impact propagates through a qualification (verifies) as if the verified module itself had changed', tests: [[IMPACT_TEST, '^impact: only change-carrying']],
    edits: [one(IMPACT, 'export const CHANGE_TYPES = Object.freeze(IMPACT_TYPES.filter(t => !QUALIFY_TYPES.includes(t)));', 'export const CHANGE_TYPES = Object.freeze([...IMPACT_TYPES]);')]},
  {id: 'B5', what: 'impact is an undirected walk over every relationship type, to the ceilings: a global invalidation', tests: [[IMPACT_TEST, '^impact: a real component change']],
    edits: [one(IMPACT, "    : closure(view, walkFrom, {direction: 'reverse', types: [...CHANGE_TYPES], depth: opts.depth, maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, mode: 'established'});",
      "    : neighborhood(view, walkFrom, {direction: 'both', depth: 16, maxNodes: 10000, maxEdges: 50000, mode: 'established'});")]},
  {id: 'B6', what: 'a change event is reassessed from every node of the graph, not from what changed', tests: [[IMPACT_TEST, '^reassess:']],
    edits: [one(IMPACT, '    const a = affected(P, event, {depth: bounds.depth, maxNodes: bounds.maxNodes, maxEdges: bounds.maxEdges, types: [...CHANGE_TYPES]});',
      "    const a = affected(P, {...event, nodes: graph.view(event.seq).subjects().filter(x => !x.includes('('))}, {depth: bounds.depth, maxNodes: bounds.maxNodes, maxEdges: bounds.maxEdges, types: [...CHANGE_TYPES]});")]},
  {id: 'B11', what: 'a missing (unavailable) source is reassessed as if it were current: nothing is reported unverifiable', tests: [[IMPACT_TEST, '^reassess:']],
    edits: [one(IMPACT, "  if (state === 'current') {", "  if (state === 'current' || state === 'unavailable') {")]},
  // ---- KB3: traceability -------------------------------------------------------------------------------------------------
  {id: 'B10', what: 'a traceability gap is filled by inference: a status item whose name resembles the file is taken as its requirement', tests: [[IMPACT_TEST, '^trace:']],
    edits: [one(IMPACT, "  if (!requirements.length) gaps.push({category: 'requirement', why: 'no source states the requirement that introduced it: no ticket names it as its slot, and no introduced-because-of relationship is recorded'});",
      "  if (!requirements.length) for (const s of view.subjects().filter(x => x.includes('/work/item/') && keyOf(subject).split('/').pop().split('.')[0].split('-').some(w => w.length > 3 && keyOf(x).includes(w)))) requirements.push({kind: 'status item (by name)', id: s, sources: []});")]},
  // ---- KB4: the context operation ----------------------------------------------------------------------------------------
  {id: 'B7', what: 'the graph op returns a summary of each node without its source references, versions or retrieval', tests: [[CONTEXT_TEST, '^graph op: references with source']],
    edits: [one(CONTEXT, '    ...r.rows.map(x => JSON.stringify(x)),', '    ...r.rows.map(x => JSON.stringify({node: x.node, kind: x.kind, why: x.why})),')]},
  {id: 'B8', what: 'the dossier\'s graph view has no byte bound (its share of the initial view removed)', tests: [[CONTEXT_TEST, '^dossier: the graph view']],
    edits: [one(CONTEXT, '      const room = Math.min(GRAPH_RETRIEVAL.dossier_bytes, left());', '      const room = Infinity;')]},
  {id: 'B9', what: 'the graph op\'s traversal bounds are not clamped: a request takes the traversal ceilings', tests: [[CONTEXT_TEST, '^graph op: bounded in nodes']],
    edits: [one(CONTEXT, '  const C = GRAPH_RETRIEVAL.ceilings, pick = (v, d, c, lo = 1) => Math.min(Number.isInteger(v) && v >= lo ? v : d, c);',
      '  const C = {depth: 16, maxNodes: 10000, maxEdges: 50000}, pick = (v, d, c, lo = 1) => Math.min(Number.isInteger(v) && v >= lo ? v : d, c);')]},
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `graph-b-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'graph-b-mutate-'));
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
