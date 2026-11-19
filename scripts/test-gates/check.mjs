#!/usr/bin/env node
// The test-result gate (docs/OPEN-LIMITATIONS.md L-503; retrospective failure mode 4). A green run must not hide:
//   - a CANCELLED test or file (node:test counts timeouts and tests cut off by their file's end as `cancelled`, not
//     `fail`: under Node 22 whole files were cancelled while the summary said `fail 0`);
//   - a SKIPPED test in a real-bwrap suite (real-bwrap.mjs) on a machine where bwrap works;
//   - a suite that produced no summary at all, or a file that produced no result.
// Where bwrap does not work, real-bwrap skips are UNVERIFIED, never PASS.
//
//   node scripts/test-gates/check.mjs logs SCRIPT=LOG [SCRIPT=LOG ...] [--json FILE]
//       Reads CI's own logs (spec or TAP). SCRIPT is a root suite script (test, test:proof, test:gates:self;
//       "npm test" is accepted for test). Every suite that script runs must be in its log.
//   node scripts/test-gates/check.mjs run [--only real-bwrap] [--suite ID ...] [--json FILE] [--out DIR]
//       Runs the suites itself, with the spec reporter on stdout and events-reporter.mjs to a file, and judges
//       every file exactly (this is `npm run test:gates`).
//   --report FILE  also write the report (without the run's own output) to FILE, e.g. for $GITHUB_STEP_SUMMARY.
//   --allow-unverified  exit 0 instead of 2 when the only open result is UNVERIFIED (still printed as UNVERIFIED).
//
// Exit: 0 PASS, 1 FAIL, 2 UNVERIFIED (no FAIL, but a real-bwrap skip that this machine cannot judge).
// Inputs:  logs or a fresh run; the bwrap probe; the suites from package.json (suites.mjs).
// Outputs: a report on stdout; with --json, the full record (probe, designated list, per-suite results).
// Must never: report PASS for a suite with cancelled > 0, with no summary, or with an unjudged real-bwrap skip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT, suites as allSuites, coverage} from './suites.mjs';
import {designated, probeBwrap, baselineDrift} from './real-bwrap.mjs';
import {parseLog} from './parse-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PASS = 'PASS', FAIL = 'FAIL', UNVERIFIED = 'UNVERIFIED';
const rel = f => (f && path.isAbsolute(f) ? path.relative(ROOT, f) : f);

function verdict(problems, unverified) { return problems.length ? FAIL : unverified.length ? UNVERIFIED : PASS; }

/** Which files of a suite define a test with this exact name (a string search of their source). */
export function filesNaming(name, files, read = f => fs.readFileSync(f, 'utf8')) {
  return files.filter(f => read(f).includes(name));
}

/** The skip rule, shared by both modes. */
function judgeSkip(skip, gatedFiles, bwrap, problems, unverified, notes) {
  const inGated = skip.files?.filter(f => gatedFiles.includes(f)) ?? [];
  // A skip the log does not tie to any file, whose reason names bwrap, is treated as a real-bwrap skip.
  const bwrapReason = !skip.files?.length && /bwrap/i.test(skip.reason ?? '');
  if (!inGated.length && !bwrapReason) { notes.push(`skipped (not a real-bwrap suite): ${skip.name} -- ${skip.reason || 'no reason'}${skip.files?.length ? ` [${skip.files.map(rel).join(', ')}]` : ' [file not identified]'}`); return; }
  const where = inGated.length ? inGated.map(rel).join(', ') : 'file not identified; the reason names bwrap';
  const msg = `real-bwrap suite skipped a test: ${skip.name} -- ${skip.reason || 'no reason'} [${where}]`;
  if (bwrap.works) problems.push(`${msg} (bwrap works here: \`${bwrap.command}\` exited 0)`);
  else unverified.push(`${msg} (bwrap does not work here: ${bwrap.error ?? `exit ${bwrap.status}`}; cannot tell an environment skip from a hidden one)`);
}

/**
 * Judge CI logs. logs: [{script, text}]; suites: from suites.mjs; gated: absolute paths; bwrap: probe result.
 * Returns [{suite, verdict, counts, problems, unverified, notes}].
 */
export function evaluateLogs({logs, suites, gated, bwrap, read}) {
  const results = [];
  for (const {script, text, source} of logs) {
    const name = script === 'npm test' ? 'test' : script;
    const expected = suites.filter(s => s.script === name);
    const segments = parseLog(text);
    const withSummary = segments.filter(s => s.counts);
    if (!expected.length) {
      results.push({suite: script, verdict: FAIL, counts: null, problems: [`"${script}" is not a suite script the gate knows (${source ?? 'log'})`], unverified: [], notes: []});
      continue;
    }
    for (const suite of expected) {
      const problems = [], unverified = [], notes = [];
      // The segment for this suite: by npm header when the log has one; a single-suite script may have only its root header.
      let seg = withSummary.find(s => s.header && (s.header.pkg === suite.pkg && s.header.script === 'test'));
      if (!seg && expected.length === 1) {
        const own = withSummary.filter(s => !s.header || s.header.script === suite.script);
        seg = own.length === 1 ? own[0] : null;
        if (own.length > 1) problems.push(`${own.length} summaries in a log of one suite: cannot tell which is this suite's`);
      }
      // A segment without a summary that names this suite still carries interruptions/cancellations.
      const bare = segments.find(s => !s.counts && s.header && s.header.pkg === suite.pkg && s.header.script === 'test');
      if (!seg) {
        problems.push(`no node:test summary for this suite in the log: it did not run, or did not finish`);
        if (bare) for (const i of bare.interrupted) problems.push(`interrupted: ${i.name}${i.file ? ` [${i.file}]` : ''}`);
        results.push({suite: suite.label, verdict: FAIL, counts: null, problems, unverified, notes});
        continue;
      }
      const c = seg.counts;
      for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) if (!(k in c)) problems.push(`the summary has no "${k}" line`);
      if (c.fail > 0) problems.push(`fail ${c.fail}`);
      if (c.cancelled > 0) {
        const files = [...new Set(seg.cancelled.map(x => x.file).filter(Boolean))];
        problems.push(`cancelled ${c.cancelled}${files.length ? ` in ${files.join(', ')}` : ' (the log does not say which file)'}`);
        for (const x of seg.cancelled) notes.push(`cancelled: ${x.name ?? '?'}${x.location ? ` at ${x.location}` : ''}${x.why ? ` -- ${x.why}` : ''}`);
      } else if (seg.cancelled.length) {
        problems.push(`the log lists ${seg.cancelled.length} cancelled test(s) but the summary says cancelled ${c.cancelled ?? 'nothing'}`);
      }
      for (const i of seg.interrupted) problems.push(`interrupted: ${i.name}${i.file ? ` [${i.file}]` : ''}`);
      if ((c.skipped ?? 0) !== seg.skipped.length) notes.push(`the summary says skipped ${c.skipped}, the log lists ${seg.skipped.length} skipped test line(s)`);
      if ((c.skipped ?? 0) > seg.skipped.length) {
        // Skips the log counted but did not list: they cannot be cleared.
        const n = c.skipped - seg.skipped.length;
        const any = suite.files.some(f => gated.includes(f));
        if (any) (bwrap.works ? problems : unverified).push(`${n} skipped test(s) not listed in the log, in a suite with real-bwrap files`);
      }
      for (const s of seg.skipped) {
        judgeSkip({...s, files: filesNaming(s.name, suite.files, read)}, gated, bwrap, problems, unverified, notes);
      }
      results.push({suite: suite.label, verdict: verdict(problems, unverified), counts: c, format: seg.format, problems, unverified, notes});
    }
  }
  return results;
}

/** Read events-reporter JSON lines. */
export function readEvents(text) {
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Judge one suite run from its events. files: the files it was asked to run (absolute).
 * exit: the node --test exit code. Returns {suite, verdict, counts, problems, unverified, notes, files: {...}}.
 */
export function evaluateEvents({suite, events, files, gated, bwrap, exit}) {
  const problems = [], unverified = [], notes = [];
  const total = events.find(e => e.type === 'summary' && !e.file);
  const perFile = new Map(events.filter(e => e.type === 'summary' && e.file).map(e => [e.file, e]));
  const tests = events.filter(e => e.type === 'test');
  if (!total) problems.push('no run summary: the run did not finish');
  const c = total?.counts ?? {};
  if (c.failed > 0) problems.push(`fail ${c.failed}`);
  if (c.cancelled > 0) {
    const byFile = {};
    for (const t of tests.filter(t => t.status === 'cancelled')) (byFile[rel(t.file) ?? '?'] ??= []).push(t);
    for (const [f, e] of perFile) if (e.counts?.cancelled > 0 && !byFile[rel(f)]) byFile[rel(f)] = [];
    problems.push(`cancelled ${c.cancelled} in ${Object.keys(byFile).join(', ') || '(no file reported)'}`);
    for (const [f, ts] of Object.entries(byFile)) for (const t of ts) notes.push(`cancelled: ${t.name} at ${f}:${t.line ?? '?'} -- ${t.failureType}: ${t.message}`);
  }
  for (const e of events.filter(e => e.type === 'interrupted')) for (const t of e.tests) problems.push(`interrupted: ${t.name} [${rel(t.file) ?? '?'}]`);
  // Every file asked for must report a result of its own: a file that exits mid-run loses its remaining tests silently.
  for (const f of files) if (!perFile.has(f)) problems.push(`no result for ${rel(f)}: the file did not report a summary (it exited or was killed before the end)`);
  for (const t of tests.filter(t => t.status === 'skipped')) {
    judgeSkip({name: t.name, reason: t.reason, files: t.file ? [t.file] : []}, gated, bwrap, problems, unverified, notes);
  }
  if (exit !== 0 && !problems.length) problems.push(`node --test exited ${exit}`);
  const counts = {tests: c.tests, pass: c.passed, fail: c.failed, cancelled: c.cancelled, skipped: c.skipped, todo: c.todo};
  return {suite: suite.label, verdict: verdict(problems, unverified), counts, problems, unverified, notes};
}

function runSuite(suite, files, outDir) {
  const events = path.join(outDir, `${suite.id.replace(/[^\w.-]+/g, '_')}.jsonl`);
  const log = path.join(outDir, `${suite.id.replace(/[^\w.-]+/g, '_')}.log`);
  const args = ['--test', ...suite.flags, '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(HERE, 'events-reporter.mjs')}`, `--test-reporter-destination=${events}`, ...files];
  return new Promise(resolve => {
    process.stdout.write(`\n> gate: ${suite.label} (${files.length} file(s), cwd ${rel(suite.cwd) || '.'})\n`);
    const out = fs.createWriteStream(log);
    // NODE_TEST_CONTEXT (set when this runs inside a test) would make the child report to that run, not to our reporters.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    const child = spawn(process.execPath, args, {cwd: suite.cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
    for (const s of [child.stdout, child.stderr]) s.on('data', d => { process.stdout.write(d); out.write(d); });
    child.on('close', (code, signal) => { out.end(); resolve({exit: signal ? `signal ${signal}` : code, events, log}); });
  });
}

function render(record) {
  const L = [];
  L.push(`## Test gate (${record.mode}) -- ${record.verdict}`, '');
  L.push(`node ${record.node}; bwrap probe: \`${record.bwrap.command}\` -> ${record.bwrap.works ? 'works' : `does NOT work (${record.bwrap.error ?? `exit ${record.bwrap.status}`}${record.bwrap.stderr ? `: ${record.bwrap.stderr}` : ''})`}${record.bwrap.version ? ` [${record.bwrap.version}]` : ''}`, '');
  L.push(`Real-bwrap suites (derived from source: test files gated on sandboxAvailable("bwrap")): ${record.realBwrap.gated.length}`);
  for (const f of record.realBwrap.gated) L.push(`- ${f}${record.realBwrap.drift.new.includes(f) ? '  **NEW: not in the recorded baseline (scripts/test-gates/real-bwrap-suites.json)**' : ''}`);
  for (const f of record.realBwrap.drift.gone) L.push(`- ${f}  **GONE: in the baseline, no longer gated on bwrap**`);
  if (record.realBwrap.ungated.length) L.push(`Test files that name bwrap without that gate (they fail rather than skip; not skip-gated): ${record.realBwrap.ungated.join(', ')}`);
  L.push('');
  if (record.coverage.problems.length || record.coverage.orphans.length) {
    L.push('Coverage problems:');
    for (const p of record.coverage.problems) L.push(`- ${p}`);
    for (const o of record.coverage.orphans) L.push(`- test file in no suite: ${o}`);
    L.push('');
  }
  L.push('| Suite | Verdict | Tests | Pass | Fail | Cancelled | Skipped |', '|---|---|---|---|---|---|---|');
  const n = v => v ?? '';
  for (const r of record.results) L.push(`| ${r.suite} | ${r.verdict} | ${n(r.counts?.tests)} | ${n(r.counts?.pass)} | ${n(r.counts?.fail)} | ${n(r.counts?.cancelled)} | ${n(r.counts?.skipped)} |`);
  L.push('');
  for (const r of record.results) {
    if (!r.problems.length && !r.unverified.length && !r.notes.length) continue;
    L.push(`### ${r.suite}: ${r.verdict}`);
    for (const p of r.problems) L.push(`- FAIL: ${p}`);
    for (const u of r.unverified) L.push(`- UNVERIFIED: ${u}`);
    for (const x of r.notes.slice(0, 50)) L.push(`- note: ${x}`);
    if (r.notes.length > 50) L.push(`- note: ... ${r.notes.length - 50} more`);
    L.push('');
  }
  return L.join('\n');
}

export async function main(argv) {
  const mode = argv[0];
  const opt = {json: null, report: null, out: null, only: null, suites: [], allowUnverified: false, logs: []};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--report') opt.report = argv[++i];
    else if (a === '--only') opt.only = argv[++i];
    else if (a === '--suite') opt.suites.push(argv[++i]);
    else if (a === '--allow-unverified') opt.allowUnverified = true;
    else if (mode === 'logs' && a.includes('=')) { const k = a.indexOf('='); opt.logs.push({script: a.slice(0, k), file: a.slice(k + 1)}); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (mode !== 'logs' && mode !== 'run') throw new Error('usage: check.mjs logs SCRIPT=LOG ... | check.mjs run [--only real-bwrap] [--suite ID]');
  if (opt.only && opt.only !== 'real-bwrap') throw new Error(`--only takes real-bwrap, not ${opt.only}`);
  const cov = coverage();
  const suites = cov.suites;
  const bwrap = probeBwrap();
  const {gated, ungated} = designated([...new Set(suites.flatMap(s => s.files))]);
  const drift = baselineDrift(gated);
  let results;
  if (mode === 'logs') {
    const logs = opt.logs.map(({script, file}) => ({script, source: file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}));
    results = evaluateLogs({logs, suites, gated, bwrap});
    for (const l of opt.logs) if (!fs.existsSync(l.file)) for (const r of results) if (r.suite.startsWith(l.script === 'npm test' ? 'test' : l.script)) r.problems.unshift(`log missing: ${l.file}`);
  } else {
    const outDir = opt.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-test-gate-'));
    fs.mkdirSync(outDir, {recursive: true});
    results = [];
    for (const s of suites) {
      if (opt.suites.length && !opt.suites.includes(s.id)) continue;
      const files = opt.only ? s.files.filter(f => gated.includes(f)) : s.files;
      if (!files.length) continue;
      const r = await runSuite(s, files, outDir);
      const events = fs.existsSync(r.events) ? readEvents(fs.readFileSync(r.events, 'utf8')) : [];
      results.push({...evaluateEvents({suite: s, events, files, gated, bwrap, exit: r.exit}), log: r.log, events: r.events});
    }
    if (!results.length) results.push({suite: '(none)', verdict: FAIL, counts: null, problems: ['no suite selected'], unverified: [], notes: []});
  }
  const covProblems = cov.problems.length || cov.orphans.length;
  const worst = results.some(r => r.verdict === FAIL) || covProblems ? FAIL : results.some(r => r.verdict === UNVERIFIED) ? UNVERIFIED : PASS;
  const record = {
    schema: 'ophanim.test-gate/v1', mode: mode === 'run' ? `run${opt.only ? ` --only ${opt.only}` : ''}` : 'logs', verdict: worst,
    node: process.version, bwrap,
    realBwrap: {gated: gated.map(rel), ungated: ungated.map(rel), drift},
    coverage: {problems: cov.problems, orphans: cov.orphans, suites: suites.map(s => ({id: s.id, cwd: rel(s.cwd) || '.', flags: s.flags, files: s.files.length}))},
    results,
  };
  const text = render(record);
  console.log(text);
  if (opt.report) fs.writeFileSync(opt.report, text + '\n');
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(record, null, 2) + '\n');
  return worst === PASS ? 0 : worst === FAIL ? 1 : opt.allowUnverified ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(`test gate: ${err.message}`); process.exitCode = 1; });
}
