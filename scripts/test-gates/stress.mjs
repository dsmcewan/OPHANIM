#!/usr/bin/env node
// T4 STRESS (scripts/test-gates/TOOLKIT.md): runs the given test files K AT A TIME, for N rounds, optionally beside L
// busy-loop processes, and reports every failing test by file, name and round. Races that appear only when suites run IN
// PARALLEL (the jail closer's exit 125, L-161, KG-11) hide from `npm run test:gates`, which runs each file on its own;
// this makes them a failing check. Meant for the real-bwrap jail suites.
//
//   node scripts/test-gates/stress.mjs --files <test file>... [--repeat N] [--concurrency K] [--load L]
//                                      [--test-timeout MS] [--file-timeout S] [--json FILE] [--out DIR]
//
// A ROUND runs every given file once, K at a time (rounds run one after another; a file never runs beside itself, as in
// CI). Each file runs in its own `node --test` through the gate's own runFile (scripts/test-gates/check.mjs: its own
// process group, the events reporter, the per-test and per-file bounds), with the cwd and flags of the suite that runs it
// (suites.mjs; a file in no suite runs from the current directory with no flags), and is judged by the gate's own
// evaluateRuns: a failed, cancelled or hung test, a failed suite, a file that ends early, and a skip in a real-bwrap
// suite where bwrap works all FAIL; a real-bwrap skip where bwrap does not work is UNVERIFIED (the race did not run).
// --load L starts L busy-loop processes before the first round and stops them after the last (each also exits when its
// parent goes away).
// Defaults: --repeat DEFAULT_REPEAT, --concurrency min(files, available parallelism), --load 0, and the gate's bounds.
//
// Inputs:  test files; the suites (package.json via suites.mjs); the bwrap probe when a file is a real-bwrap suite.
// Outputs: per round, every failing test (file, name, line, status, message) and every failing file's problems; per
//          test, the rounds it failed in (every round, or intermittent). --json FILE writes the record.
// Exit:    0 PASS, 1 FAIL (any failure in any round), 2 UNVERIFIED or a usage error.
// Must never: report PASS for a round it did not run, retry a failure away, or leave a load process running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runFile, readEvents, evaluateRuns, DEFAULT_TEST_TIMEOUT_MS, DEFAULT_FILE_TIMEOUT_S, PASS, FAIL, UNVERIFIED} from './check.mjs';
import {designated, probeBwrap} from './real-bwrap.mjs';
import {suites, ROOT} from './suites.mjs';

export const SCHEMA = 'ophanim.toolkit.stress/v1';
export const DEFAULT_REPEAT = 5;
const rel = f => path.relative(ROOT, f) || f;
// A busy loop in 50 ms slices that exits when its parent changes (the stress run ended, or was killed).
const SPIN = 'const P=process.ppid;(function s(){const t=Date.now()+50;while(Date.now()<t);if(process.ppid!==P)process.exit(0);setImmediate(s)})()';

/**
 * Start L busy-loop processes; returns {pids, stop}: stop() kills them and resolves once each has exited (and is reaped).
 * They are unref'd, so a caller that never stops them still exits (its 'exit' handler then kills them) instead of being
 * held open by them -- found by mutation S4, whose test file hung; stop() refs them again so its wait is not cut short.
 */
export function startLoad(n) {
  const kids = Array.from({length: n}, () => { const k = spawn(process.execPath, ['-e', SPIN], {stdio: 'ignore'}); k.unref(); return k; });
  const gone = kids.map(k => new Promise(resolve => { if (k.exitCode !== null || k.signalCode !== null) resolve(); else k.once('exit', () => resolve()); }));
  const kill = () => { for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL'); };
  process.once('exit', kill);
  return {pids: kids.map(k => k.pid), stop: async () => { for (const k of kids) k.ref(); kill(); await Promise.all(gone); process.removeListener('exit', kill); }};
}

/** The cwd and flags of the suite that runs `file` (absolute), or the current directory and no flags. */
function placeOf(file, all) {
  const s = all.find(x => x.files.includes(file));
  return s ? {cwd: s.cwd, flags: s.flags, suite: s.id} : {cwd: process.cwd(), flags: [], suite: null};
}

/** The failing tests and suites of one run's events. */
function failuresOf(events) {
  return events.filter(e => (e.type === 'test' && (e.status === 'fail' || e.status === 'cancelled')) || (e.type === 'suite' && e.status === 'fail'))
    .map(e => ({name: e.name, line: e.line ?? null, status: e.type === 'suite' ? 'suite failed' : e.status, message: [e.failureType, e.message].filter(Boolean).join(': ').slice(0, 300)}));
}

/**
 * Run `files` (absolute) for `repeat` rounds, `concurrency` at a time, beside `load` busy loops.
 * Returns {verdict, rounds: [{round, runs: [{file, verdict, exit, ms, tests, failures, problems, unverified}]}], byTest}.
 */
export async function stress({files, repeat = DEFAULT_REPEAT, concurrency = Math.max(1, Math.min(files.length, os.availableParallelism())), load = 0,
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS, fileTimeoutS = DEFAULT_FILE_TIMEOUT_S, outDir, log = () => {}}) {
  let all = [];
  try { all = suites(); } catch { all = []; }
  const {gated} = designated(files);
  const bwrap = gated.length ? probeBwrap() : {works: false, command: 'not probed (no real-bwrap suite among the files)'};
  const spin = load > 0 ? startLoad(load) : null;
  const rounds = [];
  try {
    for (let round = 1; round <= repeat; round++) {
      const runs = new Array(files.length);
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++, file = files[i], place = placeOf(file, all);
          const eventsPath = path.join(outDir, `r${String(round).padStart(3, '0')}-${String(i).padStart(3, '0')}-${path.basename(file)}.jsonl`);
          const r = await runFile({file, cwd: place.cwd, flags: place.flags, eventsPath, fileTimeoutS, testTimeoutMs});
          const events = fs.existsSync(eventsPath) ? readEvents(fs.readFileSync(eventsPath, 'utf8')) : [];
          fs.writeFileSync(eventsPath.replace(/\.jsonl$/, '.log'), r.output);
          const judged = evaluateRuns({suite: {label: `${rel(file)} round ${round}`}, runs: [{files: [file], events, exit: r.exit, hung: r.hung, ms: r.ms}], gated, bwrap});
          runs[i] = {file: rel(file), suite: place.suite, verdict: judged.verdict, exit: r.exit, ms: r.ms, tests: judged.counts.tests,
            failures: failuresOf(events), problems: judged.problems, unverified: judged.unverified};
          log(`round ${round}: ${rel(file)} ${judged.verdict} (${judged.counts.tests} test(s), exit ${r.exit}, ${r.ms}ms)`);
        }
      };
      await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, worker));
      rounds.push({round, runs});
    }
  } finally { await spin?.stop(); }
  const byTest = new Map();
  for (const {round, runs} of rounds) for (const r of runs) {
    const names = r.failures.length ? r.failures.map(f => f.name) : r.verdict === FAIL ? ['(the file: see its problems)'] : [];
    for (const n of names) {
      const k = `${r.file}\0${n}`;
      (byTest.get(k) ?? byTest.set(k, {file: r.file, name: n, rounds: []}).get(k)).rounds.push(round);
    }
  }
  const tally = [...byTest.values()].map(t => ({...t, rounds: [...new Set(t.rounds)], pattern: new Set(t.rounds).size === repeat ? 'every round' : 'intermittent'}));
  const runsAll = rounds.flatMap(r => r.runs);
  const verdict = runsAll.some(r => r.verdict === FAIL) ? FAIL : runsAll.some(r => r.verdict === UNVERIFIED) ? UNVERIFIED : PASS;
  return {schema: SCHEMA, verdict, repeat, concurrency, load, loadPids: spin?.pids ?? [], bwrap: {works: bwrap.works, command: bwrap.command}, files: files.map(rel), rounds, byTest: tally};
}

function render(rec) {
  const L = [`stress: ${rec.verdict} -- ${rec.files.length} file(s), ${rec.repeat} round(s), ${rec.concurrency} at a time, ${rec.load} load process(es)`];
  for (const {round, runs} of rec.rounds) for (const r of runs.filter(x => x.verdict !== PASS)) {
    L.push(`  round ${round}: ${r.file} ${r.verdict} (exit ${r.exit}, ${r.tests} test(s))`);
    for (const f of r.failures) L.push(`    ${f.status}: ${f.name}${f.line ? ` (line ${f.line})` : ''}${f.message ? ` -- ${f.message}` : ''}`);
    for (const p of r.problems) L.push(`    problem: ${p}`);
    for (const u of r.unverified) L.push(`    unverified: ${u}`);
  }
  if (rec.byTest.length) {
    L.push('failing tests, by the rounds they failed in:');
    for (const t of rec.byTest) L.push(`  ${t.file} :: ${t.name} -- rounds ${t.rounds.join(', ')} of ${rec.repeat} (${t.pattern})`);
  }
  return L.join('\n');
}

const whole = (v, what, min = 1) => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new Error(`${what} takes a whole number >= ${min}, not ${v}`); return n; };

export async function main(argv, {out = s => console.log(s)} = {}) {
  const opt = {files: [], json: null, outDir: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') { while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt.files.push(path.resolve(argv[++i])); }
    else if (a === '--repeat') opt.repeat = whole(argv[++i], '--repeat');
    else if (a === '--concurrency') opt.concurrency = whole(argv[++i], '--concurrency');
    else if (a === '--load') opt.load = whole(argv[++i], '--load', 0);
    else if (a === '--test-timeout') opt.testTimeoutMs = whole(argv[++i], '--test-timeout');
    else if (a === '--file-timeout') opt.fileTimeoutS = whole(argv[++i], '--file-timeout');
    else if (a === '--json') opt.json = argv[++i];
    else if (a === '--out') opt.outDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opt.files.length) throw new Error('usage: stress.mjs --files <test file>... [--repeat N] [--concurrency K] [--load L] [--test-timeout MS] [--file-timeout S] [--json FILE] [--out DIR]');
  for (const f of opt.files) if (!fs.existsSync(f)) throw new Error(`no such test file: ${f}`);
  const keep = !!opt.outDir;
  const outDir = opt.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-stress-'));
  fs.mkdirSync(outDir, {recursive: true});
  const onSignal = () => process.exit(130);                // the 'exit' handler stops the load processes
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let rec;
  try {
    rec = await stress({...opt, outDir, log: s => out(s)});
  } finally { if (!keep) fs.rmSync(outDir, {recursive: true, force: true}); }
  out(render(rec));
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rec, null, 2) + '\n');
  return rec.verdict === PASS ? 0 : rec.verdict === FAIL ? 1 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`stress: ${e.message}`); process.exitCode = 2; });
}
