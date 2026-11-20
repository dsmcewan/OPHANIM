#!/usr/bin/env node
// MUTATION RUNNER for Slice D part 2 of the knowledge-graph program: the graph in the foundry's loop
// (ophanim/operate/graph-loop.mjs and its wiring in scheduler.mjs, gates.mjs, reconcile.mjs, stages.mjs and context.mjs;
// docs/knowledge-graph/slice-d2.md). Modelled on ophanim/graph/graph-d1.mutate.mjs. Every mutation re-introduces a
// plausible regression of a property Slice D part 2 states -- the cursor left out of the input signature, a hypothetical
// relationship blocking, a block without its reason, no unlock on establishment, unrelated work blocked, two items sharing
// a prerequisite merged, a stale plan executed, the team proposal changing a live seat, a discovery executed without an
// owner-signed item, a direct edit of the lessons registry, the graph re-derived in full on each tick, a repeated
// observation duplicated -- on a DISPOSABLE COPY of this tree (never the tree itself), and only the tests that decide it
// run there (`tests`: each [file, --test-name-pattern]); the copy is thrown away.
//
//   node ophanim/operate/graph-d2.mutate.mjs [--only G1,G7] [--log DIR] [--copy-root DIR] [--check]
//
// The copy keeps the repository's HISTORY (a deciding test builds the real graph of this checkout, whose repository source
// reads the commits; coordinator rule, lessons class runner-deciding-tests-changed-not-rerun): a local clone whose sparse
// checkout never materializes a withheld path (recorded review findings, `findings-*`), with this working tree committed
// on top of HEAD. Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when
// a target does not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1):
// its deciding tests stay green with it. Synthetic keys only; no test reaches a provider or the network. This file runs at
// import: it is read as text, never imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOOP_TEST = 'ophanim/operate/graph-d2-loop.test.mjs', STAGES_TEST = 'ophanim/operate/graph-d2-stages.test.mjs', CONC_TEST = 'ophanim/operate/graph-d2-concurrency.test.mjs';
const DEMO_TEST = 'ophanim/operate/graph-d2-demo11.test.mjs', REAL_TEST = 'ophanim/operate/graph-d2-real.test.mjs';
const SUITES = [LOOP_TEST, STAGES_TEST, CONC_TEST, DEMO_TEST, REAL_TEST];
const LOOP = 'ophanim/operate/graph-loop.mjs', SCHED = 'ophanim/operate/scheduler.mjs', GATES = 'ophanim/operate/gates.mjs', REC = 'ophanim/operate/reconcile.mjs', STAGES = 'ophanim/operate/stages.mjs';
const EVENTS = 'packages/graph/events.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});
// The deciding tests, each [file, --test-name-pattern] (constants the runner reader of ophanim/graph/extract/verification.mjs resolves).
const T_CURSOR = [LOOP_TEST, '^KD2-1 the graph cursor'];
const T_MISSING = [LOOP_TEST, '^KD2-2 a MISSING prerequisite blocks'];
const T_HYPOTHETICAL = [LOOP_TEST, '^KD2-2 a HYPOTHETICAL requirement'];
const T_OWN = [LOOP_TEST, '^KD2-2 the prerequisite\'s own work'];
const T_STALE = [LOOP_TEST, '^KD2-3 typed requirements are bound'];
const T_IDEMPOTENT = [LOOP_TEST, '^KD2-5 and KD2-6 the write-back'];
const T_PLANNER = [STAGES_TEST, '^KD2-3 and KD2-4'];
const T_REFUSAL = [STAGES_TEST, '^KD2-3 planRefusal'];
const T_DEMO8 = [CONC_TEST, '^demonstration 8'];
const T_DEMO11 = [DEMO_TEST, '^demonstration 11'];
const T_COST = [REAL_TEST, '^KD2-6 the added cost'];
const T_BOUND = [LOOP_TEST, '^KD2-6 the per-tick bound'];
const T_PROPOSAL = [REAL_TEST, '^KD2-5 a relevant failure mechanism'];

export const MUTATIONS = [
  // ---- KD2-1: the cursor -------------------------------------------------------------------------------------------------
  {id: 'G1', what: 'the graph cursor is left out of the input signature: a change in the graph alone wakes nothing', tests: [T_CURSOR],
    edits: [one(SCHED, '  if (graph) routing = {routing, graph: cursor};', '  if (graph) { /* the cursor is not part of the signature */ }')]},
  // ---- KD2-2: the gates --------------------------------------------------------------------------------------------------
  {id: 'G2', what: 'a hypothetical requirement blocks: every requirement relationship is read as established', tests: [T_HYPOTHETICAL],
    edits: [one(LOOP, '    const established = e.assertions.some(x => view.established(x));', '    const established = true;')]},
  {id: 'G3', what: 'a block without its reason: the prerequisite\'s id and the plan line are dropped', tests: [T_MISSING, T_DEMO11],
    edits: [one(LOOP, "      block = {code: 'GRAPH_PREREQUISITE_MISSING', prerequisite: m.prerequisite, line: m.line, statement: m.statement, implementers: by,",
      "      block = {code: 'GRAPH_PREREQUISITE_MISSING', implementers: by,")]},
  {id: 'G4', what: 'no unlock on establishment: a requirement the plan cited as missing stays missing whatever the graph now states', tests: [T_MISSING, T_DEMO11],
    edits: [one(LOOP, '    const missing = report.requirements.filter(r => !r.exists && !r.implements);', '    const missing = report.requirements.filter(r => (!r.exists || r.cited === GRAPH_ABSENT) && !r.implements);')]},
  {id: 'G5', what: 'unrelated work blocked: a missing prerequisite anywhere blocks every item after its plan', tests: [T_MISSING],
    edits: [one(GATES, '  if (!a?.basis) return a?.advisory?.length ? {...g, graph: {advisory: a.advisory}} : g;',
      "  if (!a?.basis) { const any = graph.anyMissing?.(); if (any) return {...g, gate: 'blocked', stage: g.gate, blocker: {code: 'GRAPH_PREREQUISITE_MISSING', what: `a prerequisite is missing: ${any}`}}; return a?.advisory?.length ? {...g, graph: {advisory: a.advisory}} : g; }"),
      one(LOOP, '        plan: hash => analyze(item, stages.find(s => s.hash === hash) ?? null),', '        plan: hash => analyze(item, stages.find(s => s.hash === hash) ?? null),\n        anyMissing: () => candidates[0]?.prerequisite ?? null,')]},
  {id: 'G6', what: 'two items sharing a prerequisite are merged: only the first of them is queued, the other is taken as the same work', tests: [T_MISSING, T_DEMO8],
    edits: [one(SCHED, '  if (loop) log.queue = queueReport(rec, order, queue, runnable);',
      '  if (loop) { const seen = new Set(); queue = queue.filter(it => { const p = (rec.graph?.shared ?? []).find(s => s.items.includes(it))?.prerequisite; if (!p) return true; if (seen.has(p)) return false; seen.add(p); return true; }); log.queue = queueReport(rec, order, queue, runnable); }')]},
  {id: 'G7', what: 'a stale plan executed: planValidity no longer re-checks the graph facts it cited, nor the reassessments that reached it', tests: [T_STALE],
    edits: [one(GATES, '  if (graph) {\n    for (const r of typed) {', '  if (false) {\n    for (const r of typed) {')]},
  {id: 'G8', what: 'the prerequisite\'s own work is blocked: a plan that implements the prerequisite waits for it too', tests: [T_OWN],
    edits: [one(LOOP, '    const missing = report.requirements.filter(r => !r.exists && !r.implements);', '    const missing = report.requirements.filter(r => !r.exists);')]},
  {id: 'G9', what: 'a prerequisite cycle is not refused as one: each item of it waits for the other', tests: [T_OWN, T_DEMO8],
    edits: [one(LOOP, '  } else if (cycle) {', '  } else if (false) {')]},
  // ---- KD2-3: the planner ------------------------------------------------------------------------------------------------
  {id: 'G10', what: 'the planner\'s graph views are re-derived at the present graph, not the cursor it was given: its own records stale it', tests: [T_PLANNER],
    edits: [one(REC, '        const at = G && Number.isInteger(plan.outputs?.graph?.cursor) ? G.at(plan.outputs.graph.cursor) : null;',
      '        const at = G && Number.isInteger(plan.outputs?.graph?.cursor) ? G.at(undefined) : null;')]},
  {id: 'G11', what: 'typed requirements are not bound to the version the graph states', tests: [T_PLANNER],
    edits: [one(STAGES, 'version: GR.stateOf(r.id).version}))} : {}),', "version: 'absent'}))} : {}),")]},
  {id: 'G12', what: 'a reassessment set no longer reaches planValidity: its plan members are dropped', tests: [T_STALE],
    edits: [one(LOOP, "        if (k !== 'work/plan' && k !== 'work/validation') continue;", "        if (k !== 'work/validation') continue;")]},
  // ---- KD2-4: team proposals ---------------------------------------------------------------------------------------------
  {id: 'G13', what: 'the team proposal changes the live seat: the planner row is replaced by the proposal\'s first eligible capability', tests: [T_PLANNER],
    edits: [one(STAGES, '    return {...r, outputs: {...(r.outputs ?? {}), team_proposal: proposal}};',
      "    return {...r, team: (r.team ?? []).map(t => (t.role === 'planner' && proposal.team?.[0]?.candidates?.[0] ? {...t, model: proposal.team[0].candidates[0]} : t)), outputs: {...(r.outputs ?? {}), team_proposal: proposal}};")]},
  // ---- KD2-5: write-back and discoveries ---------------------------------------------------------------------------------
  {id: 'G14', what: 'a discovery executed without an owner-signed item: the candidate prerequisite is claimed as work', tests: [T_MISSING],
    edits: [one(SCHED, '    const candidates = loop.recordCandidates(fin.graph?.candidates ?? []);',
      "    const candidates = loop.recordCandidates(fin.graph?.candidates ?? []);\n    for (const c of fin.graph?.candidates ?? []) work.claim({item: c.ref.replace(/[^a-z0-9.-]/g, '-').slice(0, 64), stage: 'plan', attempt: 1, inputs: {candidate: c.ref}, holder, budget: {provider_calls: 1, iterations: 1, elapsed_ms: 60000, retries: 0}, at: new Date(clock()).toISOString(), total_provider_calls: L.total_provider_calls});")]},
  {id: 'G15', what: 'a direct edit of the lessons registry: a proposal is also written into ophanim/lessons/corrections.json', tests: [T_PROPOSAL],
    edits: [one(LOOP, '    stats.recorded.proposals++;\n    return {file: f, recorded: true};',
      "    fs.appendFileSync(new URL('../lessons/corrections.json', import.meta.url), '\\n');\n    stats.recorded.proposals++;\n    return {file: f, recorded: true};")]},
  {id: 'G16', what: 'a repeated discovery duplicates: the candidate of one prerequisite is recorded again under a new name', tests: [T_MISSING],
    edits: [one(LOOP, '    if (was && JSON.stringify(was.required_by) === JSON.stringify(c.items)) return null;', "    if (was && JSON.stringify(was.required_by) === JSON.stringify(c.items)) return recordCandidate({...c, prerequisite: c.prerequisite + '#again'}) && null;")]},
  {id: 'G17', what: 'a repeated observation duplicates: the same version of a source is observed (appended) again', tests: [T_IDEMPOTENT, T_DEMO8],
    edits: [one(EVENTS, '  if (was && was.state === \'current\' && was.version === live.version) return {none: `${sourceId}@${live.version} is already observed`};',
      '  if (false) return {none: `${sourceId}@${live.version} is already observed`};')]},
  // ---- KD2-6: bounds -----------------------------------------------------------------------------------------------------
  {id: 'G18', what: 'the graph re-derived in full on each tick: the snapshot is not used to open it', tests: [T_IDEMPOTENT, T_COST],
    edits: [one(LOOP, '...(snapshot ? {snapshot: {dir: snapshot.dir, keys: snapshot.keys}} : {})});', '...{}});')]},
  {id: 'G19', what: 'the per-tick bound on reassessment is not applied: every event\'s set is computed in one tick', tests: [T_BOUND],
    edits: [one(LOOP, '        if (freshSets >= bounds.events) { stats.events.deferred++; continue; }', '        if (false) { stats.events.deferred++; continue; }')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const g = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, encoding: 'utf8', ...opts});
function copyTree(dest) {
  // History kept: a local clone at HEAD whose sparse checkout excludes every withheld path, so none is written to disk.
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', ROOT, dest], {stdio: 'ignore'});
  g(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  g(dest, ['checkout', '-q', g(ROOT, ['rev-parse', 'HEAD']).trim()]);
  // This working tree on top of HEAD: every tracked or untracked (not ignored) file, withheld paths never read.
  const files = g(ROOT, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD.test(f)) continue;
    const from = path.join(ROOT, f), to = path.join(dest, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(to), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.rmSync(to, {force: true}); fs.symlinkSync(fs.readlinkSync(from), to); continue; }
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  g(dest, ['add', '-A']);
  g(dest, ['commit', '-q', '--allow-empty', '-m', 'the working tree under mutation']);
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
// The copy root defaults to the home directory, NOT the OS temp directory: the verify jail (pantheon/src/agy/verify-jail.mjs)
// and the agy worker jail mount a fresh tmpfs on /tmp, so a tree copied there cannot run its own jailed verify command and
// demonstration 11's pipeline unit fails (as ophanim/operate/reliability-wave2b.mutate.mjs and wave3-identity.mutate.mjs
// note). The copy is removed when the run ends; the logs go to the OS temp directory.
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `graph-d2-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = path.join(fs.mkdtempSync(path.join(copyRoot, 'graph-d2-mutate-')), 'tree');
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    for (const f of baseline.failed.slice(0, 8)) console.error(`    ${f.slice(0, 200)}`);
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
      const guarded = path.join(copy, 'ophanim/lessons/corrections.json'), registry = fs.readFileSync(guarded);
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      fs.writeFileSync(guarded, registry);      // a mutation that edits the registry (G15) leaves the copy as it was
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(path.dirname(copy), {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
