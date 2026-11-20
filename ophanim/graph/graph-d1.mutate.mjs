#!/usr/bin/env node
// MUTATION RUNNER for Slice D part 1 of the knowledge-graph program: the work and learning graphs, read only
// (ophanim/graph/work.mjs, learning.mjs, reassess.mjs, why.mjs, their registration in extract/index.mjs). Modelled on
// ophanim/graph/graph-b2.mutate.mjs. Every mutation re-introduces a plausible regression of a property Slice D part 1
// states -- a shared prerequisite merging tickets, a missing prerequisite reported as existing, a shared mechanism
// admitted from similar text, a hypothesis shown as established, a withheld path read, reassessment widened to unrelated
// work or claiming completion, an unreadable source's work reported current, two writers recording one finding twice, the
// work ledger opened writable, free text admitted as a requirement, a source without its extractorVersion, a gap filled
// by resemblance -- on a DISPOSABLE COPY of this tree (never the tree itself), and only the tests that decide it run there
// (`tests`: each [file, --test-name-pattern]); the copy is thrown away.
//
//   node ophanim/graph/graph-d1.mutate.mjs [--only S1,R2] [--log DIR] [--copy-root DIR] [--check]
//
// The copy keeps the repository's HISTORY (the why-it-exists tests read the commit that introduced a file): a local clone
// whose sparse checkout never materializes a withheld path (recorded review findings, `findings-*`), with this working
// tree committed on top of HEAD. Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS
// NON-ZERO when a target does not occur exactly once (2), when the unmutated suites are not green (3), or when any
// mutation SURVIVES (1): its deciding tests stay green with it. Synthetic keys only; no test reaches a provider or the
// network. This file is read as text by ophanim/graph/extract/verification.mjs and is never imported (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK_TEST = 'ophanim/graph/graph-d1-work.test.mjs', LEARNING_TEST = 'ophanim/graph/graph-d1-learning.test.mjs', REASSESS_TEST = 'ophanim/graph/graph-d1-reassess.test.mjs';
const WHY_TEST = 'ophanim/graph/graph-d1-why.test.mjs', CONC_TEST = 'ophanim/graph/graph-d1-concurrency.test.mjs', EXTRACT_TEST = 'ophanim/graph/extract.test.mjs';
const SUITES = [WORK_TEST, LEARNING_TEST, REASSESS_TEST, WHY_TEST, CONC_TEST, EXTRACT_TEST];
const WORK = 'ophanim/graph/work.mjs', LEARNING = 'ophanim/graph/learning.mjs', REASSESS = 'ophanim/graph/reassess.mjs', WHY = 'ophanim/graph/why.mjs', INDEX = 'ophanim/graph/extract/index.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- KD1-2: shared prerequisites ---------------------------------------------------------------------------------------
  {id: 'S1', what: 'a shared prerequisite merges the tickets: the later item\'s ticket is recorded as superseding the first\'s', tests: [[WORK_TEST, '^demonstration 1: a shared prerequisite is RECORDED as a report']],
    edits: [one(WORK, '    const w = same ? {appended: false} : record.supersedes.length ? graph.supersede([record], by) : graph.assert([record], by);',
      "    const merge = f.items.length > 1 ? [assertion({type: 'supersedes', from: ticketId(f.items[1].item), to: ticketId(f.items[0].item), origin: WORK_RULE, classification: 'derived', observed_at, inputs, source: draft.source, attributes: {merged_into: f.items[0].item}})] : [];\n    const w = same ? {appended: false} : record.supersedes.length ? graph.supersede([record], by) : graph.assert([record, ...merge], by);")]},
  {id: 'S2', what: 'a missing prerequisite is reported as existing because the graph holds the node a plan names', tests: [[WORK_TEST, '^demonstration 1: two or more independent items']],
    edits: [one(WORK, '  return {exists: false, basis: null, by: [], sources: [],',
      "  if (view.nodeIn(target, 'established')) return {exists: true, basis: 'the graph holds it', by: [target], sources: view.query(target, 'established').map(sourceOf)};\n  return {exists: false, basis: null, by: [], sources: [],")]},
  // ---- KD1-3, KD1-4: mechanisms are declared, similarity is a hypothesis ---------------------------------------------------
  {id: 'L1', what: 'shares-failure-mechanism-with is admitted from text similarity (the similarity rule declared, its link derived)', tests: [[LEARNING_TEST, '^learning: shares-failure-mechanism-with is admitted ONLY']],
    edits: [one(LEARNING, "export const SIMILARITY_ORIGIN = Object.freeze({kind: 'rule', basis: 'textual'});", "export const SIMILARITY_ORIGIN = Object.freeze({kind: 'rule', basis: 'declared'});"),
      one(LEARNING, "  return assertion({type: 'shares-failure-mechanism-with', from: a, to: b, origin: SIMILARITY_RULE, classification: 'hypothetical', inputs: [], observed_at,",
        "  return assertion({type: 'shares-failure-mechanism-with', from: a, to: b, origin: SIMILARITY_RULE, classification: 'derived', inputs: compared, observed_at,")]},
  {id: 'L2', what: 'a hypothetical mechanism link is shown as established by the learning-reuse query', tests: [[LEARNING_TEST, '^learning: shares-failure-mechanism-with is admitted ONLY']],
    edits: [one(LEARNING, "const mechanismLinks = (view, id) => view.edgesOf(id, {mode: 'established', types: ['shares-failure-mechanism-with']});",
      "const mechanismLinks = (view, id) => view.edgesOf(id, {mode: 'possible', types: ['shares-failure-mechanism-with']});")]},
  {id: 'L3', what: 'a withheld path (recorded review findings) is read: the guard before every read is dropped', tests: [[LEARNING_TEST, '^learning: review findings from the cycle LEDGER']],
    edits: [one(LEARNING, "  if (typeof p === 'string' && WITHHELD.test(p)) throw", "  if (false && typeof p === 'string' && WITHHELD.test(p)) throw")]},
  // ---- KD1-5: targeted reassessment --------------------------------------------------------------------------------------
  {id: 'R1', what: 'reassessment invalidates unrelated work: every work node is reassessed on any change (a global invalidation)', tests: [[REASSESS_TEST, '^demonstrations? 2']],
    edits: [one(REASSESS, '    if (isWork(id)) visit(id, c.why, c.path, 0);', "    if (isWork(id)) visit(id, c.why, c.path, 0);\n    for (const s of view.subjects()) if (isWork(s)) visit(s, 'all work is reassessed on any change', [], 0);")]},
  {id: 'R2', what: 'reassessment emits a completion claim: the outcome proposal on the chain is reported as standing', tests: [[REASSESS_TEST, '^demonstrations 2 and 7: ']],
    edits: [one(REASSESS, "completion: 'not claimed', note: set.note}});", "completion: set.members.some(m => m.role === 'completion claim') ? 'claimed: the outcome proposal stands' : 'not claimed', note: set.note}});")]},
  {id: 'R3', what: 'the work of a source that cannot be read is reported with its ordinary status, as if current', tests: [[REASSESS_TEST, '^demonstration 7: MISSING evidence']],
    edits: [one(REASSESS, 'status: unverifiable ? `unverifiable: ${ch.source} is ${ch.state}` : status,', 'status: status,')]},
  // ---- KD1-7: two writers, one finding -----------------------------------------------------------------------------------
  {id: 'C1', what: 'a duplicate claim from two writers: each writer stamps the finding with itself, so one prerequisite is recorded twice', tests: [[CONC_TEST, '^demonstration 8: '], [WORK_TEST, '^demonstration 1: a shared prerequisite is RECORDED']],
    edits: [one(WORK, '      existence: {exists: f.existence.exists, basis: f.existence.basis, by: f.existence.by.slice(0, 16), gap: f.existence.gap ?? null}, report: f.report};',
      '      existence: {exists: f.existence.exists, basis: f.existence.basis, by: f.existence.by.slice(0, 16), gap: f.existence.gap ?? null}, report: f.report, recorded_by: process.pid};')]},
  // ---- KD1-1: read only, declared only -----------------------------------------------------------------------------------
  {id: 'W1', what: 'the work-ledger source is opened writable (create: true)', tests: [[WORK_TEST, '^work: an absent work ledger is refused']],
    edits: [one(WORK, '  return openWorkLedger({root, anchor, create: false, keys: null});', '  return openWorkLedger({root, anchor, create: true, keys: null});')]},
  {id: 'W2', what: 'a free-text capability is admitted as a typed requirement (a feature named by its text)', tests: [[WORK_TEST, '^work: (the work ledger is projected READ ONLY|requirementsOf types only graph ids)']],
    edits: [one(WORK, "if (field === 'capabilities') free.push(cut(id, 300));",
      "if (field === 'capabilities') { free.push(cut(id, 300)); typed.push({id: entityId({domain: 'capability', type: 'feature', key: id}), type: 'requires-capability', why: 'matched by its text', field}); }")]},
  // ---- KD1-9: registration ----------------------------------------------------------------------------------------------
  {id: 'V1', what: 'the new sources are composed without their extractorVersion', tests: [[WORK_TEST, '^work: every source of Slice D part 1'], [EXTRACT_TEST, '^extract: every source of the systems graph declares']],
    edits: [one(INDEX, '  return {...s, extractorVersion: versions.get(m)};', '  return [LEARNING_SOURCE, WORK_GRAPH_SOURCE, CYCLE_LEARNING_SOURCE].includes(s.id) ? s : {...s, extractorVersion: versions.get(m)};')]},
  // ---- KD1-6: why it exists ---------------------------------------------------------------------------------------------
  {id: 'Y1', what: 'a gap in why-it-exists is filled by inference: an item whose name resembles the file is taken as its requirement', tests: [[WHY_TEST, '^why it exists: a GAP is never filled by inference']],
    edits: [one(WHY, "  if (!requirements.length) gaps.push({category: 'requirement',",
      String.raw`  if (!requirements.length) { const base = keyOf(subject).split('/').at(-1).replace(/\.[a-z]+$/, ''); const guess = view.subjects().find(s => kindOf(s) === 'work/item' && keyOf(s).split('-').some(w => w.length > 3 && base.includes(w))); if (guess) requirements.push({to: guess, kind: 'status item', basis: 'resemblance', join: 'the item is named like the file', inputs: [], sources: []}); }
  if (!requirements.length) gaps.push({category: 'requirement',`)]},
  {id: 'Y2', what: 'a shallow checkout\'s boundary commit is named as the one that introduced a path already in its tree, and its message read for a decision', tests: [[WHY_TEST, '^why it exists: a SHALLOW checkout']],
    edits: [one(WHY, "first = earliest?.history_cut ? null : earliest;", "first = earliest;"),
      one(WHY, "  const cut = commits[0]?.history_cut === true;", "  const cut = false;")]},
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
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `graph-d1-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = path.join(fs.mkdtempSync(path.join(copyRoot, 'graph-d1-mutate-')), 'tree');
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
  fs.rmSync(path.dirname(copy), {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
