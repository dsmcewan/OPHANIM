#!/usr/bin/env node
// MUTATION RUNNER for wave 3, sub-wave 3B-1 (agent 3b-evidence): register L-504 invariant 1 (a version equals the
// delivered bytes, across every retriever op) and L-106 (the status-entry wake, for every stage). Built like
// wave2-identity.mutate.mjs: every mutation is made on a DISPOSABLE COPY of this tree (never on the tree itself), the
// suites that must kill it run there, and the mutation is undone.
//
//   node ophanim/operate/wave3-evidence.mutate.mjs [--only E1,K2] [--log DIR] [--copy-root DIR] [--check]
//   node ophanim/operate/wave3-evidence.mutate.mjs --base REV [--log DIR] [--copy-root DIR]
//
// Each mutation re-introduces one plausible regression on one enumerated path (the path ids are those of the reports:
// E-* invariant 1, by op and consumer; K-* the wake, by stage). It names one or more edits, each with its file, the EXACT
// text it replaces and the replacement. The runner EXITS NON-ZERO when a target does not occur exactly once (the
// mutation would not apply, or would apply ambiguously), when the unmutated suites are not green, or when any mutation
// SURVIVES (every suite it names still green). Every run is logged in the log directory (one log per mutation, plus
// summary.json).
//
// --base REV is the BASE-FAILURE run, not a mutation run: the copy's owned source files (context.mjs, gates.mjs,
// reconcile.mjs) are replaced by their bytes at REV and the new test files are run; the per-test outcome is printed and
// logged. It exits 0 when it ran (the outcome is the evidence, not a gate).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EV = 'ophanim/operate/wave3-evidence.test.mjs', WAKE = 'ophanim/operate/wave3-wake.test.mjs';
const R2 = 'ophanim/operate/lifecycle-evidence-r2.test.mjs', REVIEW = 'ophanim/operate/lifecycle-evidence-review.test.mjs';
const CTX = 'ophanim/operate/context.mjs', GATES = 'ophanim/operate/gates.mjs', REC = 'ophanim/operate/reconcile.mjs', SCHED = 'ophanim/operate/scheduler.mjs';
const OWNED_SOURCES = [CTX, GATES, REC];
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- L-504 invariant 1: the version each op records, and the re-checks that consume it
  {id: 'E1', path: 'file (contract)', what: 'the file op versions the decoded body instead of the raw bytes', tests: [EV],
    edits: [one(CTX, 'return {source: `file:${p}`, version: sha(b), body, range,', 'return {source: `file:${p}`, version: sha(body), body, range,')]},
  {id: 'E2', path: 'file (re-check)', what: 'the gate\'s file re-check ignores the op\'s admission (the bytes behind the path only, as at 5f24c68)', tests: [EV],
    edits: [one(REC, 'id = admitFile(repo, p).error ? `refused:${raw}` : raw;', 'id = raw;')]},
  {id: 'E3', path: 'list', what: 'a list is versioned by HEAD (the index can change under the same HEAD)', tests: [EV],
    edits: [one(CTX, 'return {source: `list:${prefix || \'.\'}`, version: sha(body), body,', 'return {source: `list:${prefix || \'.\'}`, version: headOf(), body,')]},
  {id: 'E4', path: 'grep (no row)', what: 'grep is versioned by its rows, not the placeholder it delivers (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `grep:${pattern}@${p}`, version: sha(body), body,', 'return {source: `grep:${pattern}@${p}`, version: sha(rows.join(\'\\n\')), body,')]},
  {id: 'E5', path: 'grep (rows)', what: 'grep is versioned by HEAD (the search reads the working tree)', tests: [EV],
    edits: [one(CTX, 'return {source: `grep:${pattern}@${p}`, version: sha(body), body,', 'return {source: `grep:${pattern}@${p}`, version: headOf(), body,')]},
  {id: 'E6', path: 'log (no commit)', what: 'log is versioned by its rows, not the placeholder it delivers (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `log:${p ?? \'*\'}${sel({grep: g})}`, version: sha(body), body,', 'return {source: `log:${p ?? \'*\'}${sel({grep: g})}`, version: sha(rows.join(\'\\n\')), body,')]},
  {id: 'E7', path: 'log (rows)', what: 'log is versioned by HEAD (an unrelated commit moves it)', tests: [EV],
    edits: [one(CTX, 'return {source: `log:${p ?? \'*\'}${sel({grep: g})}`, version: sha(body), body,', 'return {source: `log:${p ?? \'*\'}${sel({grep: g})}`, version: headOf(), body,')]},
  {id: 'E8', path: 'show', what: 'show is versioned by the commit id the caller typed (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `show:${commit}${p ? `:${p}` : \'\'}`, version: sha(out), body: out};', 'return {source: `show:${commit}${p ? `:${p}` : \'\'}`, version: commit, body: out};')]},
  {id: 'E9', path: 'status', what: 'a status view is versioned by the item\'s latest entry, whatever its selection shows (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `status:${item}#history${sel({match, entry})}`, version: sha(body),', 'return {source: `status:${item}#history${sel({match, entry})}`, version: h.at(-1).entry,')]},
  {id: 'E10', path: 'work (version)', what: 'a work view is versioned by the item\'s latest record (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `work:${item}#records${sel({match})}`, version: sha(body),', 'return {source: `work:${item}#records${sel({match})}`, version: work.stages(item).at(-1)?.hash ?? null,')]},
  {id: 'E11', path: 'work (another item, re-check)', what: 'the gate exempts every work view, another item\'s too (as at 5f24c68)', tests: [EV, R2],
    edits: [one(GATES, "if (ev.request.op === 'work' && (rec?.identity?.item === undefined || ev.request.item === rec.identity.item)) return null;", "if (ev.request.op === 'work') return null;")]},
  {id: 'E12', path: 'work (another item, re-reader)', what: 'versionOf no longer serves a work view (another item\'s cannot be re-read)', tests: [EV],
    edits: [one(CTX, "if (!req || typeof req !== 'object' || !OPS.includes(req.op) || ['dossier', 'output'].includes(req.op)) return undefined;",
      "if (!req || typeof req !== 'object' || !OPS.includes(req.op) || ['work', 'dossier', 'output'].includes(req.op)) return undefined;")]},
  {id: 'E13', path: 'record', what: 'a record view is versioned by the hash the caller typed (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, 'return {source: `record:${hash}`, version: sha(body), body};', 'return {source: `record:${hash}`, version: hash, body};')]},
  {id: 'E14', path: 'issue', what: 'an issue is versioned by its body text only (title and state are delivered too)', tests: [EV, R2],
    edits: [one(CTX, 'return {source: `issue:${i.number}`, version: sha(body), body};', 'return {source: `issue:${i.number}`, version: sha(i.body ?? \'\'), body};')]},
  {id: 'E15', path: 'output', what: 'a stored output is versioned by its id', tests: [EV],
    edits: [one(CTX, 'return {source: `output:${id}`, version: sha(body), body};', 'return {source: `output:${id}`, version: id, body};')]},
  {id: 'E16', path: 'dossier (requirement)', what: 'the requirement view is versioned by its status entry (as at 5f24c68)', tests: [EV],
    edits: [one(CTX, '    const version = sha(text);\n', "    const version = kind === 'authoritative-requirement' ? ready.entry : sha(text);\n")]},
  {id: 'E17', path: 'dossier (derived views)', what: 'a derived dossier view is versioned by its name, not its bytes', tests: [EV, R2, REVIEW],
    edits: [one(CTX, '    const version = sha(text);\n', '    const version = sha(source);\n')]},
  {id: 'E18', path: 'dossier (re-check)', what: 'reconcile no longer re-derives a cited dossier view: the version the plan recorded is taken as the present one', tests: [EV, R2],
    edits: [one(REC, 'return v ? (v.get(request.source)?.version ?? null) : undefined;', 'return plan?.outputs?.evidence?.find(e => e.request?.source === request.source)?.version;')]},
  {id: 'E19', path: 'investigate (per-round log)', what: 'the per-round log digests the request instead of the bytes delivered', tests: [EV],
    edits: [one(CTX, 'bytes: r.bytes, sha256: sha(r.text)}', 'bytes: r.bytes, sha256: sha(JSON.stringify(req))}')]},
  {id: 'E20', path: 'evidenceStable', what: 'the dossier\'s stable digest leaves its entries\' versions out', tests: [EV],
    edits: [one(CTX, "stable: 'sha256:' + digest({item, head, core: outside,", "stable: 'sha256:' + digest({item, head, core: outside.map(({version: _v, ...e}) => e),")]},
  {id: 'E21', path: 'validationEvidence', what: 'a validation\'s non-file sources are not re-checked', tests: [EV],
    edits: [one(GATES, "    if (!s?.delivered || s.version === undefined || s.version === null) continue;\n", "    if (!s?.delivered || s.version === undefined || s.version === null || !String(s.source).startsWith('file:')) continue;\n")]},
  // ---- L-106: the status-entry wake, by stage
  ...['plan', 'implement', 'review', 'validate', 'outcome'].map((stage, i) => ({id: `K${i + 1}`, path: `wake: ${stage}`, what: `the status comparison is dropped for ${stage}`, tests: [WAKE],
    edits: [one(GATES, 'if (at && item.entry && at !== item.entry) return {wake: \'status\',', `if (at && item.entry && at !== item.entry && att.stage !== '${stage}') return {wake: 'status',`)]})),
  {id: 'K6', path: 'wake: every stage (field)', what: 'the wake compares the attempt\'s route instead of its status entry', tests: [WAKE],
    edits: [one(GATES, 'const at = att.inputs?.status_entry ?? null;', 'const at = att.inputs?.route ?? null;')]},
  {id: 'K7', path: 'wake: only the affected item', what: 'the status entry a gate reads is the ledger head (every item is woken by any entry)', tests: [WAKE],
    edits: [one(REC, 'let gate = earliestGate({item: s, history:', 'let gate = earliestGate({item: {...s, entry: board.head}, history:')]},
  {id: 'K8', path: 'wake: collision and attempt bound (W6, W7)', what: 'the attempt identity no longer carries the status entry (attemptInputs and the routing basis)', tests: [WAKE],
    edits: [one(GATES, "    ...(gate.entry ? {status_entry: gate.entry} : {})};", '  };'),
      one(GATES, "const routeOf = basis => 'sha256:' + digest({v: ATTEMPT_IDENTITY, entry: item.entry ?? null, ...basis});", "const routeOf = basis => 'sha256:' + digest({v: ATTEMPT_IDENTITY, ...basis});")]},
  {id: 'K9', path: 'wake: the attempt bound (W7)', what: 'the scheduler counts attempts across status entries (the identity fields omit the entry and the route)', tests: [WAKE],
    edits: [one(GATES, "export const IDENTITY_FIELDS = Object.freeze(['upstream', 'requirement', 'returned_by', 'rereview', 'route', 'status_entry']);",
      "export const IDENTITY_FIELDS = Object.freeze(['upstream', 'requirement', 'returned_by', 'rereview']);")]},
  {id: 'K10', path: 'wake: the service trigger', what: 'the service\'s input signature no longer sees the status ledger (its head and the routing)', tests: [WAKE],
    edits: [one(SCHED, "return 'sha256:' + digest({status: head(path.join(statusRoot, 'chain.jsonl')), work:", "return 'sha256:' + digest({status: null, work:"),
      one(SCHED, '    issues: (issues ?? []).map(i => [i.number, i.state, i.title ?? \'\', i.body ?? \'\']).sort((a, b) => a[0] - b[0]), routing});',
        '    issues: (issues ?? []).map(i => [i.number, i.state, i.title ?? \'\', i.body ?? \'\']).sort((a, b) => a[0] - b[0]), routing: null});')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    fs.copyFileSync(from, path.join(dest, f));
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  // A repository of its own (some suites read the repository they run in); nothing here touches this tree's git.
  const g = (...a) => execFileSync('git', ['-C', dest, ...a], {stdio: 'ignore'});
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'add', '-A');
  g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'commit', '-q', '-m', 'mutation copy');
}
const runSuites = (dir, tests, logFile) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=120000', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  const lines = out.split('\n');
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    passed: [...new Set(lines.filter(l => /^✔ /.test(l)).map(l => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))],
    failed: [...new Set(lines.filter(l => /^✖ /.test(l) && !/failing tests/.test(l)).map(l => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};
const apply = (dir, edits) => {
  const orig = new Map();
  for (const e of edits) {
    const file = path.join(dir, e.file);
    if (!orig.has(file)) orig.set(file, fs.readFileSync(file, 'utf8'));
    const now = fs.readFileSync(file, 'utf8');
    if (now.split(e.from).length - 1 !== 1) throw Object.assign(new Error(`the target occurs ${now.split(e.from).length - 1} time(s) in ${e.file}`), {code: 'NOT_ONCE'});
    fs.writeFileSync(file, now.replace(e.from, () => e.to));
  }
  return () => { for (const [file, text] of orig) fs.writeFileSync(file, text); };
};

const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `wave3-evidence-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
// NOT under /tmp by default: the agy worker jail mounts a fresh tmpfs there, so a tree copied under /tmp cannot run its own fake CLI.
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const base = arg('--base');

if (base) {
  const copy = fs.mkdtempSync(path.join(copyRoot, 'wave3-evidence-base-'));
  try {
    copyTree(copy);
    for (const f of OWNED_SOURCES) fs.writeFileSync(path.join(copy, f), execFileSync('git', ['-C', ROOT, 'show', `${base}:${f}`], {maxBuffer: 1 << 28}));
    const r = runSuites(copy, [EV, WAKE], path.join(logDir, `base-${base}.log`));
    console.log(`the new tests with ${OWNED_SOURCES.join(', ')} at ${base}: ${r.pass}/${r.tests} pass, ${r.fail} fail, ${r.cancelled} cancelled, ${r.skipped} skipped`);
    for (const f of r.failed) console.log(`  FAILS  ${f.slice(2, 220)}`);
    for (const p of r.passed) console.log(`  holds  ${p.slice(2, 220)}`);
    fs.writeFileSync(path.join(logDir, `base-${base}.json`), JSON.stringify({base, sources: OWNED_SOURCES, ...r}, null, 2) + '\n');
  } finally { fs.rmSync(copy, {recursive: true, force: true}); }
  process.exit(0);
}

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
// Every target must apply EXACTLY ONCE on this tree, before anything is run (edits of one mutation apply in order).
const bad = [];
for (const m of chosen) {
  const text = new Map();
  for (const e of m.edits) {
    const now = text.get(e.file) ?? fs.readFileSync(path.join(ROOT, e.file), 'utf8');
    const n = now.split(e.from).length - 1;
    if (n !== 1) bad.push(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
    else text.set(e.file, now.replace(e.from, () => e.to));
  }
}
if (bad.length) { for (const b of bad) console.error(b); process.exit(2); }
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copy = fs.mkdtempSync(path.join(copyRoot, 'wave3-evidence-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const suites = [...new Set(chosen.flatMap(m => m.tests))];
  const baseline = runSuites(copy, suites, path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped (${suites.join(', ')})`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) { console.error('the unmutated suites are not green: no mutation result would mean anything'); process.exit(3); }
  for (const m of chosen) {
    let undo;
    try { undo = apply(copy, m.edits); } catch (e) { console.error(`${m.id}: MUTATION DID NOT APPLY (${e.message})`); exit = 2; continue; }
    let r;
    try { r = runSuites(copy, m.tests, path.join(logDir, `${m.id}.log`)); } finally { undo(); }
    const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
    summary.push({id: m.id, path: m.path, what: m.what, files: [...new Set(m.edits.map(e => e.file))], tests: m.tests, killed, count: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled,
      killed_by: r.failed.slice(0, 20)});
    console.log(`${m.id.padEnd(4)} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  [${m.path}] ${m.what}`);
    for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
    if (!killed) exit = 1;
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed; logs in ${logDir}`);
process.exit(exit);
