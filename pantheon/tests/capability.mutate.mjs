#!/usr/bin/env node
// MUTATION RUNNER for the capability and model/runtime graph (knowledge graphs, Slice C1; docs/knowledge-graph/slice-c1.md).
// Every mutation re-introduces a plausible regression of a property the slice states -- advisory eligibility moving a live
// seat, lab restricting a producer or no longer excluding a contributing lab's reviewer, owner direction recorded as a
// measurement or read as evidence, qualified-for without a criterion, the SDK seat recorded as isolated, isolation without
// code evidence, a would-be-refused pin not reported, a data change not producing a new decision, the explanation or the
// snapshot digest dropped, model and runtime collapsed, a hypothetical counted as established, an unobserved metric as 0, a
// tampered snapshot admitted, an unknown model resolved to another -- on a DISPOSABLE COPY of this tree (never the tree
// itself). Only the tests that decide it run there (`tests`: each [file, --test-name-pattern]); the copy is thrown away.
//
//   node pantheon/tests/capability.mutate.mjs [--only C1,C7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its deciding
// tests stay green with it. Synthetic keys only; no test reaches a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = 'pantheon/tests/';
const SUITES = [`${T}capability-graph.test.mjs`, `${T}capability-eligibility.test.mjs`, `${T}capability-advisory.test.mjs`, `${T}capability-metrics.test.mjs`];
const C = 'pantheon/src/capability/', GRAPH = `${C}graph.mjs`, ELIG = `${C}eligibility.mjs`, ADV = `${C}advisory.mjs`, METRICS = `${C}metrics.mjs`, KINDS = 'pantheon/src/ledger/kinds.mjs';
const one = (file, from, to) => ({file, from, to});
const t = (file, pattern) => [`${T}capability-${file}.test.mjs`, pattern];

export const MUTATIONS = [
  // ---- advisory: live selection unchanged (owner decision 3, KC4) ------------------------------------------------------
  {id: 'C1', what: 'eligibility changes the live selected seat (eligible candidates are moved first)', tests: [t('advisory', '^advisory: the selection matrix'), t('eligibility', '^demonstration 4')],
    edits: [one(ADV, '  const candidates = choice.candidates.map((c, rank) => ({...c, selection: {...c.selection, advisory: tag(c, rank)}}));',
      '  const candidates = choice.candidates.map((c, rank) => ({...c, selection: {...c.selection, advisory: tag(c, rank)}})).sort((a, b) => Number(b.selection.advisory.eligible) - Number(a.selection.advisory.eligible));')]},
  {id: 'C11', what: 'the snapshot digest is not recorded beside the selection', tests: [t('advisory', '^every live selection records'), t('advisory', '^a pin the graph would refuse')],
    edits: [one(ADV, '      return {schema: ADVISORY_SCHEMA, advisory: true, mode: d.mode, snapshot: snap.digest, decision: d.digest,',
      '      return {schema: ADVISORY_SCHEMA, advisory: true, mode: d.mode, snapshot: null, decision: d.digest,')]},
  {id: 'C9', what: 'a data change does not produce a new decision (the recorded decision is cached by requirements alone)', tests: [t('eligibility', '^demonstration 4')],
    edits: [one(ADV, '  const key = `${snap.digest}|${digest(req)}`;', '  const key = digest(req);')]},
  // ---- lab: work by evidence, review by lab (owner decision 2) ---------------------------------------------------------
  {id: 'C2', what: 'lab restricts a producer (the contributing-lab exclusion applied to every role)', tests: [t('eligibility', '^lab:')],
    edits: [one(ELIG, '  if (reviews) {', '  if (true) {')]},
  {id: 'C3', what: 'a contributing lab\'s reviewer is not excluded', tests: [t('eligibility', '^lab:')],
    edits: [one(ELIG, "    if (lab.lab && req.avoid_labs.includes(lab.lab)) no('independence', `the ${lab.lab} lab contributed to the work under review (reviewer independence)`, {lab: lab.lab});\n", '')]},
  // ---- evidence types: owner direction is never a measurement, never evidence --------------------------------------------
  {id: 'C4', what: 'a seating-table preference recorded as a measurement', tests: [t('graph', '^owner direction is never a measurement')],
    edits: [one(GRAPH, "difficulty: row.difficulty ?? null, basis: row.basis, why: row.why ?? null, authority, evidence_type: 'owner-direction',",
      "difficulty: row.difficulty ?? null, basis: row.basis, why: row.why ?? null, authority, evidence_type: 'measured',")]},
  {id: 'C13', what: 'an owner-directed placement read as eligibility evidence (an unplaced capability excluded)', tests: [t('eligibility', '^automatic:')],
    edits: [one(ELIG, "  if (!n.established) no('established', ", "  if (!placementsOf(ix, req.role, occupantOf(ix, cap)).length) no('placement', 'no owner-directed placement');\n  if (!n.established) no('established', ")]},
  {id: 'C5', what: 'qualified-for emitted without an owner-defined criterion', tests: [t('metrics', '^no qualified-for')],
    edits: [one(METRICS, "  if (criterion === null) return {criterion: null, emitted: [], why: 'no owner-defined",
      "  if (criterion === null) return {criterion: null, emitted: Object.keys(capabilities).map(c => ({type: 'qualified-for', from: c, to: 'implementer'})), why: 'no owner-defined")]},
  {id: 'C15', what: 'an unobserved metric reported as 0 (tokens of attempts that reported no usage)', tests: [t('metrics', '^metrics:')],
    edits: [one(METRICS, '{input: null, output: null, n: 0, missing: m.tokens.missing}', '{input: 0, output: 0, n: 0, missing: m.tokens.missing}')]},
  // ---- the bubble (owner decision 1, KC2) -------------------------------------------------------------------------------
  {id: 'C6', what: 'the SDK seat recorded as isolated (a component that does not hold counted as holding)', tests: [t('graph', '^the bubble: the SDK seat')],
    edits: [one(GRAPH, "export const bubbleHolds = b => BUBBLE.every(k => b?.[k]?.holds === true || b?.[k]?.holds === 'not-applicable');",
      "export const bubbleHolds = b => BUBBLE.every(k => b?.[k]?.holds !== 'unresolved');")]},
  {id: 'C7', what: 'isolation claimed without code evidence (the declared value taken without its quotes)', tests: [t('graph', '^the bubble: isolation is never claimed'), t('graph', '^the bubble: the SDK seat')],
    edits: [one(GRAPH, "    : (declared === true || declared === 'not-applicable') && evidence.length && !missing.length ? declared : 'unresolved';",
      "    : (declared === true || declared === 'not-applicable') ? declared : 'unresolved';")]},
  // ---- eligibility: modes and explanation (KC3) -------------------------------------------------------------------------
  {id: 'C8', what: 'a pinned ineligible capability not reported as one that would be refused', tests: [t('eligibility', '^pinned:'), t('advisory', '^a pin the graph would refuse')],
    edits: [one(ELIG, "      ...(req.mode === 'pinned' ? {would_refuse: !ok,", "      ...(req.mode === 'pinned' ? {would_refuse: false,")]},
  {id: 'C10', what: 'the explanation dropped (no explanation and no reason per exclusion)', tests: [t('eligibility', '^automatic:'), t('eligibility', '^pinned:')],
    edits: [one(ELIG, '    lineage: Object.fromEntries(Object.entries(lineage).sort()), unresolved, explanation};', '    lineage: Object.fromEntries(Object.entries(lineage).sort()), unresolved, explanation: []};'),
      one(ELIG, "    else excluded.push({capability: decodeTail(cap), why: unresolved.length ? [{check: 'unresolved', why: unresolved.join('; ')}, ...j.why] : j.why});",
        '    else excluded.push({capability: decodeTail(cap), why: []});')]},
  {id: 'C19', what: 'an unknown pinned model resolved to another capability instead of unresolved', tests: [t('graph', '^negative cases: an unknown model')],
    edits: [one(ELIG, '  return ix.node(id) ? id : null;', "  return ix.node(id) ? id : ix.ofType('capability')[0]?.id ?? null;")]},
  // ---- the graph: model apart from runtime, the hypothetical never established (KC1, demonstration 12) -------------------
  {id: 'C12', what: 'model and runtime collapsed into one entity (a capability keyed by its model alone)', tests: [t('graph', '^model and runtime are separate'), t('graph', '^extraction:')],
    edits: [one(GRAPH, 'export const capabilityKey = (profile, vendor, model) => `${profile}/${vendor}/${model}`;', 'export const capabilityKey = (profile, vendor, model) => `${vendor}/${model}`;')]},
  {id: 'C14', what: 'a hypothetical (an unverified model claim) counted as established in a graph view', tests: [t('graph', '^negative cases: an unverified model claim')],
    edits: [one(GRAPH, '{established: r => establishedIds.has(r.id)}', '{established: () => true}')]},
  // ---- the ledger input (KC4) -------------------------------------------------------------------------------------------
  {id: 'C18', what: 'a capability snapshot whose digest is not the digest of its sources is admitted as a ledger input', tests: [t('advisory', '^the capability snapshot is a ledger input')],
    edits: [one(KINDS, "        if (snapshotDigestOf(e.payload) !== e.payload.digest) return 'the capability snapshot digest is not the digest of its sources';\n", '')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }   // e.g. pantheon's models.json
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `capability-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'capability-mutate-'));
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
