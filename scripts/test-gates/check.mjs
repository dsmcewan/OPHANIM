#!/usr/bin/env node
// The test-result gate (docs/OPEN-LIMITATIONS.md L-503, L-505, L-506; retrospective failure mode 4). A green run must
// not hide:
//   - a CANCELLED test or file (node:test counts timeouts and tests cut off by their file's end as `cancelled`, not
//     `fail`: under Node 22 whole files were cancelled while the summary said `fail 0`);
//   - a SKIPPED test in a real-bwrap suite (real-bwrap.mjs) on a machine where bwrap works;
//   - a suite that produced no summary at all, or a file that produced no result;
//   - a HUNG file (L-505): Node 24.22.1 does not cancel a test whose promise never settles, nor end a file an open
//     handle keeps alive -- the run waits forever. Run mode bounds every test (--test-timeout: node:test cancels it by
//     name) and every file (a watchdog kills the file's process group and FAILS naming it);
//   - a file that ENDED EARLY (L-506): process.exit(0) mid-file, or a synchronous exit, leaves `fail 0` and exit 0 with
//     the rest of the file's tests missing from every count. Run mode runs each file in its own runner and requires
//     the file's own node:test summary; a failing describe()/before() that node:test leaves out of `fail` FAILS too.
// Where bwrap does not work, real-bwrap skips are UNVERIFIED, never PASS.
//
//   node scripts/test-gates/check.mjs logs SCRIPT=LOG [SCRIPT=LOG ...] [--json FILE]
//       Reads CI's own logs (spec or TAP). SCRIPT is a root suite script (test, test:proof, test:gates:self;
//       "npm test" is accepted for test). Every suite that script runs must be in its log. A text log cannot show a
//       silent mid-file exit; that is run mode's job, and CI runs run mode over every suite.
//   node scripts/test-gates/check.mjs run [--only real-bwrap] [--suite ID ...] [--json FILE] [--out DIR]
//   either mode: [--self-repair-records DIR | --no-self-repair-records] -- whether a whole run feeds the self-repair
//   lane's Detect (feed.mjs; by default only while the owner-signed switch is on, and only for a clean tree)
//                                         [--file-timeout SECONDS] [--test-timeout MS]
//       Runs the suites itself, one `node --test` per file (the suite's flags and file concurrency), with the spec
//       reporter captured and events-reporter.mjs to a file, and judges every file exactly (this is `npm run
//       test:gates`). Defaults: --test-timeout DEFAULT_TEST_TIMEOUT_MS unless the suite sets its own,
//       --file-timeout DEFAULT_FILE_TIMEOUT_S.
//   --report FILE  also write the report (without the run's own output) to FILE, e.g. for $GITHUB_STEP_SUMMARY.
//   --allow-unverified  exit 0 instead of 2 when the only open result is UNVERIFIED (still printed as UNVERIFIED).
//
// Exit: 0 PASS, 1 FAIL, 2 UNVERIFIED (no FAIL, but a real-bwrap skip that this machine cannot judge).
// Inputs:  logs or a fresh run; the bwrap probe; the suites from package.json (suites.mjs).
// Outputs: a report on stdout; with --json, the full record (probe, designated list, per-suite and per-file results).
// Must never: report PASS for a suite with cancelled > 0, with no summary, with an unjudged real-bwrap skip, with a
// file that did not finish or did not report its own summary; retry anything; or leave a hung file's processes running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT, coverage} from './suites.mjs';
import {designated, probeBwrap, baselineDrift} from './real-bwrap.mjs';
import {parseLog} from './parse-log.mjs';
import {FEED_FLAGS, feedFlag, feedDetect, feedLine, gatePartial} from './feed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PASS = 'PASS', FAIL = 'FAIL', UNVERIFIED = 'UNVERIFIED';
const rel = f => (f && path.isAbsolute(f) ? path.relative(ROOT, f) : f);

// Run mode's bounds (L-505), set from measured maxima (the slowest test and file of every suite are in the JSON
// record as slowestTestMs / slowestFileMs; at ef78a74 + this change: slowest file 67.6 s, slowest test 67.3 s with its
// own declared 300 s timeout, slowest test without one 18.5 s). The file bound is above the largest per-test timeout a
// test declares itself (300 s, ophanim/tests/qualification.test.mjs), so the gate never kills a file sooner than its
// author allowed. Both are far below the 25-minute CI job. OPHANIM_GATE_TEST_TIMEOUT_MS / OPHANIM_GATE_FILE_TIMEOUT_S
// (and --test-timeout / --file-timeout, which win) change them for one run; the record states the bounds used, and
// suites.mjs fails coverage if qualification.yml sets either.
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const DEFAULT_FILE_TIMEOUT_S = 360;

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
      const bare = segments.find(s => !s.counts && s.header && s.header.pkg === suite.pkg && s.header.script === 'test')
        ?? (expected.length === 1 ? segments.find(s => !s.counts && (s.interrupted.length || s.cancelled.length)) : null);
      if (!seg) {
        problems.push(`no node:test summary for this suite in the log: it did not run, or did not finish (a hung run cut off by the step's timeout ends here)`);
        if (bare) for (const i of bare.interrupted) problems.push(`interrupted: ${i.name}${i.file ? ` [${i.file}]` : ''}`);
        results.push({suite: suite.label, verdict: FAIL, counts: null, problems, unverified, notes});
        continue;
      }
      const c = seg.counts;
      for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) if (!(k in c)) problems.push(`the summary has no "${k}" line`);
      if (c.fail > 0) problems.push(`fail ${c.fail}`);
      // A failing describe()/before() is listed as failing but not counted under fail (Node 24.22.1: `fail 0`, exit 1).
      if (seg.failed.length > (c.fail ?? 0)) {
        problems.push(`the log lists ${seg.failed.length} failure(s) but the summary counts fail ${c.fail ?? 0}: ${seg.failed.map(f => `${f.name}${f.location ? ` at ${f.location}` : ''}${f.why ? ` -- ${f.why}` : ''}`).join('; ')}`);
      }
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

/** Read events-reporter JSON lines. A last line cut off by a kill (unterminated) is dropped, not trusted. */
export function readEvents(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (!l) return;
    try { out.push(JSON.parse(l)); } catch (e) { if (i !== lines.length - 1) throw e; }
  });
  return out;
}

const has = (flags, name) => flags.some(f => f === name || f.startsWith(`${name}=`));

/**
 * Judge one suite's runs. runs: [{files: [absolute], events: [...], exit, hung?: {limitS, ms}, ms?}] -- one run per
 * file in run mode; one run over several files when a caller ran them together. Returns {suite, verdict, counts,
 * problems, unverified, notes, files: {rel: {...}}}.
 *
 * A file is complete only if its own process reported a summary of its own (node:test's per-file test:summary): that
 * is what process.exit(0) mid-file, a synchronous exit, a crash or a kill takes away while the run's totals still
 * read `fail 0` (L-506; observed on Node 24.22.1, see check.test.mjs). A file that registers no test at all looks the
 * same to node:test (one passing pseudo-test named after the file, no summary of its own) and FAILS the same way.
 */
export function evaluateRuns({suite, runs, gated, bwrap}) {
  const problems = [], unverified = [], notes = [], perFileRecord = {};
  const events = runs.flatMap(r => r.events);
  const tests = events.filter(e => e.type === 'test');
  const count = st => tests.filter(t => t.status === st).length;
  for (const run of runs) {
    const label = run.files.length === 1 ? rel(run.files[0]) : `${run.files.length} files`;
    const total = run.events.find(e => e.type === 'summary' && !e.file);
    const perFile = new Map(run.events.filter(e => e.type === 'summary' && e.file).map(e => [e.file, e]));
    const own = run.events.filter(e => e.type === 'test');
    const before = problems.length;
    if (run.hung) {
      const timedOut = own.filter(t => t.failureType === 'testTimeoutFailure');
      const last = own.filter(t => t.status !== 'cancelled').at(-1);
      const at = timedOut.length
        ? `; timed out (named by node:test): ${timedOut.map(t => `${t.name} at ${rel(t.file)}:${t.line ?? '?'}`).join(', ')}`
        : `; node:test does not report the test in progress (${last ? `last test to finish: ${last.name} at line ${last.line ?? '?'}` : 'no test finished'}); a hang outside any test -- an open handle, a hook, module code -- also ends here`;
      problems.push(`hung: ${label} did not finish within ${run.hung.limitS}s; the gate killed its process group${at}`);
    } else if (!total) problems.push(`no run summary from the runner of ${label}: it did not finish`);
    for (const f of run.files) {
      const s = perFile.get(f);
      const mine = own.filter(t => t.file === f);
      perFileRecord[rel(f)] = {tests: mine.length, summary: s?.counts ?? null, exit: run.exit, hung: run.hung ?? null, ms: run.ms ?? null};
      if (run.hung) continue;
      // Every file asked for must report a result of its own: a file that exits mid-run loses its remaining tests silently.
      if (!s) { problems.push(`no result for ${rel(f)}: the file did not report a summary of its own -- it exited or was killed before its end, or registered no test at all (${mine.length} test(s) reported first${mine.length ? `, the last: ${mine.at(-1).name}` : ''}; runner exit ${run.exit})`); continue; }
      if (s.counts.tests !== mine.length) problems.push(`${rel(f)}: its summary counts ${s.counts.tests} test(s) but ${mine.length} were reported`);
    }
    if (total && total.counts.tests !== own.length) problems.push(`${label}: the run summary counts ${total.counts.tests} test(s) but ${own.length} were reported`);
    // node:test's own totals stay authoritative: a fail or cancellation it counted FAILS even if no event says which.
    for (const [k, st] of [['failed', 'fail'], ['cancelled', 'cancelled']]) {
      const seen = own.filter(t => t.status === st).length;
      if (total && total.counts[k] > seen) problems.push(`${label}: the run summary counts ${k} ${total.counts[k]}, the events show ${seen}`);
    }
    if (run.exit !== 0 && problems.length === before && !own.some(t => t.status === 'fail' || t.status === 'cancelled')
        && !run.events.some(e => e.type === 'suite')) problems.push(`node --test exited ${run.exit} for ${label}`);
  }
  const failed = tests.filter(t => t.status === 'fail');
  if (failed.length) {
    problems.push(`fail ${failed.length} in ${[...new Set(failed.map(t => rel(t.file) ?? '?'))].join(', ')}`);
    for (const t of failed.slice(0, 20)) notes.push(`fail: ${t.name} at ${rel(t.file) ?? '?'}:${t.line ?? '?'} -- ${t.failureType ?? ''}: ${t.message ?? ''}`);
  }
  // A failing describe()/before() is not counted under fail by node:test; it is a failure all the same.
  for (const e of events.filter(e => e.type === 'suite' && e.status === 'fail')) {
    problems.push(`suite failed (node:test does not count it under fail): ${e.name} at ${rel(e.file) ?? '?'}:${e.line ?? '?'} -- ${e.failureType ?? ''}: ${e.message ?? ''}`);
  }
  const cancelled = tests.filter(t => t.status === 'cancelled');
  if (cancelled.length) {
    const byFile = {};
    for (const t of cancelled) (byFile[rel(t.file) ?? '?'] ??= []).push(t);
    problems.push(`cancelled ${cancelled.length} in ${Object.keys(byFile).join(', ')}`);
    for (const [f, ts] of Object.entries(byFile)) for (const t of ts) notes.push(`cancelled: ${t.name} at ${f}:${t.line ?? '?'} -- ${t.failureType}: ${t.message}`);
  }
  for (const e of events.filter(e => e.type === 'summary' && e.file)) {
    if (e.counts?.cancelled > 0 && !cancelled.some(t => t.file === e.file)) problems.push(`cancelled ${e.counts.cancelled} in ${rel(e.file)} (by its summary; no cancelled test was reported)`);
  }
  for (const e of events.filter(e => e.type === 'interrupted')) for (const t of e.tests) problems.push(`interrupted: ${t.name} [${rel(t.file) ?? '?'}]`);
  for (const t of tests.filter(t => t.status === 'skipped')) {
    judgeSkip({name: t.name, reason: t.reason, files: t.file ? [t.file] : []}, gated, bwrap, problems, unverified, notes);
  }
  const slowest = tests.filter(t => t.ms != null).sort((a, b) => b.ms - a.ms)[0];
  const slowFile = runs.filter(r => r.ms != null).sort((a, b) => b.ms - a.ms)[0];
  const counts = {tests: tests.length, pass: count('pass'), fail: failed.length, cancelled: cancelled.length, skipped: count('skipped'), todo: count('todo'),
    slowestTestMs: slowest?.ms ?? null, slowestTest: slowest ? `${slowest.name} [${rel(slowest.file)}]` : null,
    slowestFileMs: slowFile?.ms ?? null, slowestFile: slowFile ? rel(slowFile.files[0]) : null};
  return {suite: suite.label, verdict: verdict(problems, unverified), counts, problems, unverified, notes, files: perFileRecord};
}

/** One runner over several files (the shape of a plain `node --test`): judged by the same rules. */
export function evaluateEvents({suite, events, files, gated, bwrap, exit}) {
  return evaluateRuns({suite, runs: [{files, events, exit}], gated, bwrap});
}

/** node:test's own default file concurrency, or the suite's --test-concurrency. */
export function concurrencyOf(flags) {
  const m = flags.map(f => /^--test-concurrency=(\d+)$/.exec(f)).find(Boolean);
  return m ? Math.max(1, Number(m[1])) : Math.max(1, os.availableParallelism() - 1);
}

const LIVE = new Set();
const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
// The gate itself stopped (a CI step timeout signals it): the files it started go with it, none left orphaned.
const killLiveOnSignal = () => { for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { for (const pid of LIVE) killGroup(pid); process.exit(130); }); };

/**
 * Run one test file in its own `node --test`, in its own process group, with the spec reporter captured and the
 * events reporter to a file. The watchdog kills the whole group -- the runner AND the file's process, which node
 * --test leaves running when only the runner is signalled (observed) -- once the file exceeds fileTimeoutS.
 */
export function runFile({file, cwd, flags, eventsPath, fileTimeoutS, testTimeoutMs}) {
  const args = ['--test', ...flags, ...(has(flags, '--test-timeout') ? [] : [`--test-timeout=${testTimeoutMs}`]),
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(HERE, 'events-reporter.mjs')}`, `--test-reporter-destination=${eventsPath}`, file];
  // NODE_TEST_CONTEXT (set when this runs inside a test) would make the child report to that run, not to our reporters.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    LIVE.add(child.pid);
    const chunks = [];
    for (const s of [child.stdout, child.stderr]) s.on('data', d => chunks.push(d));
    let hung = null;
    const timer = setTimeout(() => { hung = {limitS: fileTimeoutS, ms: Date.now() - t0}; killGroup(child.pid); }, fileTimeoutS * 1000);
    // Whatever the file left running in its group (a grandchild holding the pipes open) goes with the runner.
    child.on('exit', () => { clearTimeout(timer); killGroup(child.pid); });
    child.on('close', (code, signal) => {
      LIVE.delete(child.pid);
      resolve({files: [file], exit: signal ? `signal ${signal}` : code, hung, ms: Date.now() - t0, output: Buffer.concat(chunks).toString('utf8')});
    });
  });
}

async function runSuite(suite, files, outDir, {fileTimeoutS, testTimeoutMs}) {
  const id = suite.id.replace(/[^\w.-]+/g, '_');
  const dir = path.join(outDir, id);
  fs.mkdirSync(dir, {recursive: true});
  const log = path.join(outDir, `${id}.log`);
  const out = fs.createWriteStream(log);
  const conc = concurrencyOf(suite.flags);
  process.stdout.write(`\n> gate: ${suite.label} (${files.length} file(s), cwd ${rel(suite.cwd) || '.'}, ${conc} at a time, test timeout ${has(suite.flags, '--test-timeout') ? 'from the suite' : `${testTimeoutMs}ms`}, file timeout ${fileTimeoutS}s)\n`);
  const runs = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const eventsPath = path.join(dir, `${String(i).padStart(3, '0')}-${path.basename(files[i])}.jsonl`);
      const r = await runFile({file: files[i], cwd: suite.cwd, flags: suite.flags, eventsPath, fileTimeoutS, testTimeoutMs});
      const head = `\n>> ${rel(files[i])} (exit ${r.exit}, ${r.ms}ms${r.hung ? `, HUNG: the gate killed it after ${fileTimeoutS}s` : ''})\n`;
      process.stdout.write(head + r.output); out.write(head + r.output);
      runs[i] = {files: r.files, exit: r.exit, hung: r.hung, ms: r.ms, eventsPath,
        events: fs.existsSync(eventsPath) ? readEvents(fs.readFileSync(eventsPath, 'utf8')) : []};
    }
  };
  await Promise.all(Array.from({length: Math.min(conc, files.length)}, worker));
  await new Promise(r => out.end(r));
  return {runs, log, events: dir};
}

function render(record) {
  const L = [];
  L.push(`## Test gate (${record.mode}) -- ${record.verdict}`, '');
  L.push(`node ${record.node}; bwrap probe: \`${record.bwrap.command}\` -> ${record.bwrap.works ? 'works' : `does NOT work (${record.bwrap.error ?? `exit ${record.bwrap.status}`}${record.bwrap.stderr ? `: ${record.bwrap.stderr}` : ''})`}${record.bwrap.version ? ` [${record.bwrap.version}]` : ''}`, '');
  if (record.bounds) L.push(`Bounds: each test ${record.bounds.testTimeoutMs}ms (unless its suite sets --test-timeout), each file ${record.bounds.fileTimeoutS}s; every file in its own runner.`, '');
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
  const timed = record.results.some(r => r.counts?.slowestFileMs != null);
  L.push(`| Suite | Verdict | Tests | Pass | Fail | Cancelled | Skipped |${timed ? ' Slowest file (ms) | Slowest test (ms) |' : ''}`, `|---|---|---|---|---|---|---|${timed ? '---|---|' : ''}`);
  const n = v => v ?? '';
  for (const r of record.results) L.push(`| ${r.suite} | ${r.verdict} | ${n(r.counts?.tests)} | ${n(r.counts?.pass)} | ${n(r.counts?.fail)} | ${n(r.counts?.cancelled)} | ${n(r.counts?.skipped)} |${timed ? ` ${n(r.counts?.slowestFileMs)} | ${n(r.counts?.slowestTestMs)} |` : ''}`);
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

const positive = (v, what) => { const x = Number(v); if (!(x > 0) || !Number.isFinite(x)) throw new Error(`${what} takes a positive number, not ${v}`); return x; };

export async function main(argv) {
  const mode = argv[0];
  const opt = {json: null, report: null, out: null, only: null, suites: [], allowUnverified: false, logs: [],
    fileTimeoutS: process.env.OPHANIM_GATE_FILE_TIMEOUT_S ? positive(process.env.OPHANIM_GATE_FILE_TIMEOUT_S, 'OPHANIM_GATE_FILE_TIMEOUT_S') : DEFAULT_FILE_TIMEOUT_S,
    testTimeoutMs: process.env.OPHANIM_GATE_TEST_TIMEOUT_MS ? positive(process.env.OPHANIM_GATE_TEST_TIMEOUT_MS, 'OPHANIM_GATE_TEST_TIMEOUT_MS') : DEFAULT_TEST_TIMEOUT_MS};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--report') opt.report = argv[++i];
    else if (a === '--only') opt.only = argv[++i];
    else if (a === '--suite') opt.suites.push(argv[++i]);
    else if (a === '--allow-unverified') opt.allowUnverified = true;
    else if (a === '--file-timeout') opt.fileTimeoutS = positive(argv[++i], '--file-timeout');
    else if (a === '--test-timeout') opt.testTimeoutMs = positive(argv[++i], '--test-timeout');
    else if (Object.values(FEED_FLAGS).includes(a)) i = feedFlag(argv, i, opt);
    else if (mode === 'logs' && a.includes('=')) { const k = a.indexOf('='); opt.logs.push({script: a.slice(0, k), file: a.slice(k + 1)}); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (mode !== 'logs' && mode !== 'run') throw new Error('usage: check.mjs logs SCRIPT=LOG ... | check.mjs run [--only real-bwrap] [--suite ID] [--file-timeout S] [--test-timeout MS]');
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
    // Suites run from their own cwd: the output directory must not depend on it.
    const outDir = path.resolve(opt.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-test-gate-')));
    fs.mkdirSync(outDir, {recursive: true});
    killLiveOnSignal();
    results = [];
    for (const s of suites) {
      if (opt.suites.length && !opt.suites.includes(s.id)) continue;
      const files = opt.only ? s.files.filter(f => gated.includes(f)) : s.files;
      if (!files.length) continue;
      const r = await runSuite(s, files, outDir, opt);
      results.push({...evaluateRuns({suite: s, runs: r.runs, gated, bwrap}), log: r.log, events: r.events});
    }
    if (!results.length) results.push({suite: '(none)', verdict: FAIL, counts: null, problems: ['no suite selected'], unverified: [], notes: []});
  }
  const covProblems = cov.problems.length || cov.orphans.length;
  const worst = results.some(r => r.verdict === FAIL) || covProblems ? FAIL : results.some(r => r.verdict === UNVERIFIED) ? UNVERIFIED : PASS;
  const record = {
    schema: 'ophanim.test-gate/v2', mode: mode === 'run' ? `run${opt.only ? ` --only ${opt.only}` : ''}` : 'logs', verdict: worst,
    node: process.version, bwrap,
    ...(mode === 'run' ? {bounds: {testTimeoutMs: opt.testTimeoutMs, fileTimeoutS: opt.fileTimeoutS}} : {}),
    realBwrap: {gated: gated.map(rel), ungated: ungated.map(rel), drift},
    coverage: {problems: cov.problems, orphans: cov.orphans, suites: suites.map(s => ({id: s.id, cwd: rel(s.cwd) || '.', flags: s.flags, files: s.files.length}))},
    results,
  };
  const text = render(record);
  console.log(text);
  if (opt.report) fs.writeFileSync(opt.report, text + '\n');
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(record, null, 2) + '\n');
  // Feed the self-repair lane's Detect (feed.mjs): a whole run only, and never a cause of this gate's verdict.
  console.log(feedLine(gatePartial(mode, opt)
    ? {skipped: 'a partial gate run (--only, --suite) is not fed: Detect reads the latest gate record as the whole picture'}
    : await feedDetect({kind: 'gate', record, feed: opt.feed})));
  return worst === PASS ? 0 : worst === FAIL ? 1 : opt.allowUnverified ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(`test gate: ${err.message}`); process.exitCode = 1; });
}
