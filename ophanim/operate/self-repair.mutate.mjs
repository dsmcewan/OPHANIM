#!/usr/bin/env node
// MUTATION RUNNER for the self-repair lane (ophanim/operate/self-repair.mjs and its wiring in scheduler.mjs and
// work-ledger.mjs; docs/self-repair.md). Modelled on ophanim/operate/graph-d2.mutate.mjs. Every mutation re-introduces a
// plausible regression of one decision -- the lane awake without the owner's switch, a protected defect selected, a
// protected diff accepted, each anti-cheating check disabled, a landing on another ref, the rollback bisect blaming the
// newest landing, a moved base landed without re-validation, two rounds over overlapping paths, the queue never rotating,
// a plan accepted without a failing reproduction, a gate record of another commit used, the ranking reversed, an open
// round's defect selected again, a reverted defect not routed to the owner, the validate wrapper or the round's claimed
// paths dropped from the scheduler -- on a DISPOSABLE COPY of this tree (never the tree itself), and only the tests that
// decide it run there (`tests`: each [file, --test-name-pattern]); the copy is thrown away.
//
//   node ophanim/operate/self-repair.mutate.mjs [--only SR1,SR7] [--log DIR] [--copy-root DIR] [--check]
//
// The copy keeps the repository's history: a local clone whose sparse checkout never materializes a withheld path
// (recorded review findings, `findings-*`), with this working tree committed on top of HEAD. Each mutation names its
// edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not occur exactly once
// (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its deciding tests stay green with
// it. Synthetic keys only; no test reaches a provider or the network. This file runs at import: it is read as text, never
// imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANE_TEST = 'ophanim/operate/self-repair.test.mjs', VERIFY_TEST = 'ophanim/operate/self-repair-verify.test.mjs', PEN_TEST = 'ophanim/operate/pentest/g-self-repair.test.mjs';
const FEED_TEST = 'ophanim/operate/self-repair-feed.test.mjs', LOOP_TEST = 'ophanim/operate/self-repair-inspect.test.mjs', LEARN_TEST = 'ophanim/operate/self-repair-learning.test.mjs';
const STAGES_MOD = 'ophanim/operate/stages.mjs';
const INSPECTOR = 'ophanim/operate/self-repair-inspect.mjs';
const SUITES = [LANE_TEST, VERIFY_TEST, PEN_TEST, FEED_TEST, LOOP_TEST, LEARN_TEST];
const LANE = 'ophanim/operate/self-repair.mjs', LEDGER = 'ophanim/operate/work-ledger.mjs', SCHED = 'ophanim/operate/scheduler.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});
// The deciding tests, each [file, --test-name-pattern].
const T_D1 = [LANE_TEST, '^SR-D1 dormant'];
const T_D2 = [LANE_TEST, '^SR-D2 rounds'];
const T_D3 = [LANE_TEST, '^SR-D3 Detect reads only'];
const T_ROT = [LANE_TEST, '^SR-D3 dedupe and ROTATION'];
const T_PROT = [LANE_TEST, '^SR-D3 and SR-D9'];
const T_D4 = [LANE_TEST, '^SR-D4 DIAGNOSE'];
const T_D5D6 = [LANE_TEST, '^SR-D5 SR-D6'];
const T_D7 = [LANE_TEST, '^SR-D7 landing'];
const T_MOVED = [LANE_TEST, '^SR-AM a round whose base moved'];
const T_OVERLAP = [LANE_TEST, '^SR-AM two rounds never claim'];
const T_D8 = [LANE_TEST, '^SR-D8 the rollback bisect'];
const T_DEMO = [LANE_TEST, '^SR-DEMO'];
const T_V9 = [VERIFY_TEST, '^SR-V9'];
const T_V6_ASSERT = [VERIFY_TEST, '^SR-V6 anti-cheating: a removed'];
const T_V6_SKIP = [VERIFY_TEST, '^SR-V6 anti-cheating: an added skip'];
const T_V6_COUNT = [VERIFY_TEST, '^SR-V6 anti-cheating: a test file'];
const T_V6_KILL = [VERIFY_TEST, '^SR-V6 anti-cheating: a runner'];
const T_G2 = [PEN_TEST, '^G2 '];
const T_G4 = [PEN_TEST, '^G4 '];
const T_G5 = [PEN_TEST, '^G5 '];
const T_G6 = [PEN_TEST, '^G6 '];
const T_G7 = [PEN_TEST, '^G7 '];

export const MUTATIONS = [
  // ---- decision 1 (as amended): the owner's switch -----------------------------------------------------------------------
  {id: 'SR1', what: 'the dormancy check: the lane is awake whatever state the self-repair item is in', tests: [T_D1],
    edits: [one(LANE, "  if (s.state !== 'In progress') return {on: false,", '  if (false) return {on: false,')]},
  // ---- decision 9: the protected surfaces, enforced twice ---------------------------------------------------------------
  {id: 'SR2', what: 'the protected check in Detect: a defect on an outer wheel is selected', tests: [T_PROT],
    edits: [one(LANE, '    const prot = protectedSite(d, config);', '    const prot = null;')]},
  {id: 'SR3', what: 'the protected check in validate: a diff touching an outer wheel is accepted', tests: [T_V9, T_G4],
    edits: [one(LANE, '  for (const f of files) if (isProtected(f.path, config)) refusals.push(', '  for (const f of []) if (isProtected(f.path, config)) refusals.push(')]},
  // ---- decision 6: the anti-cheating checks -----------------------------------------------------------------------------
  {id: 'SR4', what: 'a removed or weakened assertion is accepted', tests: [T_V6_ASSERT, T_G5],
    edits: [one(LANE, "    if (removed.length) out.push({code: 'ASSERTION_REMOVED'", "    if (false) out.push({code: 'ASSERTION_REMOVED'")]},
  {id: 'SR5', what: 'an added skip, todo or only is accepted', tests: [T_V6_SKIP, T_G5],
    edits: [one(LANE, '    if (b.skips > a.skips) out.push(', '    if (false) out.push(')]},
  {id: 'SR6', what: 'a lowered test count is accepted', tests: [T_V6_COUNT],
    edits: [one(LANE, '    if (b.tests < a.tests) out.push(', '    if (false) out.push(')]},
  {id: 'SR7', what: 'a lowered mutation-runner kill count is accepted', tests: [T_V6_KILL, T_G5],
    edits: [one(LANE, "        if (killed < row.killed_at_base) refusals.push({code: 'KILL_COUNT_LOWERED'", "        if (false) refusals.push({code: 'KILL_COUNT_LOWERED'")]},
  // ---- decision 7: the landing ref ---------------------------------------------------------------------------------------
  {id: 'SR8', what: 'the work ledger admits a landing on another ref than the round\'s line', tests: [T_G6],
    edits: [one(LEDGER, '  if (p.line !== open.line) return `LANDING_REF:', '  if (false) return `LANDING_REF:')]},
  {id: 'SR9', what: 'the lane\'s landing refusal admits any ref', tests: [T_D7],
    edits: [one(LANE, '  return ref === config.line ? null : ', '  return true ? null : ')]},
  // ---- decision 8: the rollback bisect -----------------------------------------------------------------------------------
  {id: 'SR10', what: 'the rollback bisect blames the newest landing, not the earliest that fails where its parent passes', tests: [T_D8],
    edits: [one(LANE, '  return {culprit: landings[hi - 1],', '  return {culprit: landings.at(-1),')]},
  {id: 'SR11', what: 'a rollback does not route the reverted defect to the owner', tests: [T_DEMO],
    edits: [one(LANE, "    route({id: culprit.defect, kind: 'reverted',", "    ({id: culprit.defect, kind: 'reverted',")]},
  // ---- the amendment: re-validation on a moved base ---------------------------------------------------------------------
  {id: 'SR12', what: 'the lane lands a round whose base moved without re-validating it on the new head', tests: [T_MOVED],
    edits: [one(LANE, '    if (parentOf(repo, commit) !== head) {', '    if (false) {')]},
  {id: 'SR13', what: 'the work ledger admits a landing on a moved base without a passing re-validation', tests: [T_G2],
    edits: [one(LEDGER, '  if (p.parent !== open.base && !prior.some(', '  if (false && !prior.some(')]},
  // ---- the amendment: overlapping paths never at once -------------------------------------------------------------------
  {id: 'SR14', what: 'the claim path fence is gone: a round claims paths another live claim holds', tests: [T_OVERLAP, T_G7],
    edits: [one(LEDGER, '            if (both.length) return `PATHS_CLAIMED:', '            if (false) return `PATHS_CLAIMED:')]},
  {id: 'SR15', what: 'the work ledger opens a round over the paths of an open round', tests: [T_G7],
    edits: [one(LEDGER, '    if (clash) return `PATHS_CLAIMED:', '    if (false) return `PATHS_CLAIMED:')]},
  {id: 'SR16', what: 'Detect selects a defect whose site overlaps an open round\'s paths', tests: [T_OVERLAP],
    edits: [one(LANE, '    const overlap = claimed.find(', '    const overlap = null && claimed.find(')]},
  {id: 'SR17', what: 'the scheduler drops a round\'s paths from its claims', tests: [T_D2],
    edits: [one(SCHED, '        ...(round ? {paths: lane.claimPaths(item)} : {})}); }', '        ...({})}); }')]},
  // ---- the amendment: rotation -------------------------------------------------------------------------------------------
  {id: 'SR18', what: 'the queue never rotates: a defect whose round failed stays at the front', tests: [T_ROT],
    edits: [one(LANE, '  const queue = [...fresh, ...tried];', '  const queue = [...eligible];')]},
  // ---- decisions 2 to 5 ---------------------------------------------------------------------------------------------------
  {id: 'SR19', what: 'an open round\'s defect is selected again', tests: [T_D2],
    edits: [one(LANE, "      : open.some(r => r.open.defect.id === d.id) ? {route: 'deduped'", "      : false ? {route: 'deduped'")]},
  {id: 'SR20', what: 'Detect uses a gate record that names another commit than the one under repair', tests: [T_D3],
    edits: [one(LANE, '  if (gate && gate.commit !== commit) ignored.push(', '  if (false) ignored.push(')]},
  {id: 'SR21', what: 'the ranking is reversed: register entries before flakes before regressions', tests: [T_D3],
    edits: [one(LANE, '.sort((a, b) => a.d.rank - b.d.rank || a.i - b.i)', '.sort((a, b) => b.d.rank - a.d.rank || a.i - b.i)')]},
  {id: 'SR22', what: 'a plan whose reproduction does not fail on the base is accepted', tests: [T_D4],
    edits: [one(LANE, "    if (!run.fails) return {ok: false, refusals: [{code: 'REPRODUCTION_DOES_NOT_FAIL'", "    if (false) return {ok: false, refusals: [{code: 'REPRODUCTION_DOES_NOT_FAIL'")]},
  {id: 'SR23', what: 'the scheduler runs a round\'s stages without the lane\'s wrapper: validate\'s mechanical checks never run', tests: [T_D5D6],
    edits: [one(SCHED, '      const exec = isRound(item) && lane?.on ? lane.wrap(gate.gate, executors[gate.gate]) : executors[gate.gate];', '      const exec = executors[gate.gate];')]},
  // ---- feeding Detect (owner, 2026-11-20: "wire the gate and stress records into Detect") -------------------------------
  {id: 'SR24', what: 'the feeder ignores the switch: records are written while the lane is dormant', tests: [[FEED_TEST, '^feed: with the lane OFF']],
    edits: [one(LANE, '    if (!sw.on) return {skipped: sw.why};', '    if (false) return {skipped: sw.why};')]},
  {id: 'SR25', what: 'the feeder ignores a dirty tree: a run on uncommitted changes is attributed to HEAD', tests: [[FEED_TEST, '^feed: a working tree that is not its commit']],
    edits: [one(LANE, '  if (changes.length) return {skipped:', '  if (false) return {skipped:')]},
  {id: 'SR26', what: "Verify's own stress run feeds Detect", tests: [[FEED_TEST, '^feed: Verify']],
    edits: [one(LANE, "'--files', '{file}', '--repeat', '{rounds}', '--json', '{json}', '--no-self-repair-records']),", "'--files', '{file}', '--repeat', '{rounds}', '--json', '{json}']),")]},
  // ---- the recursive loop: self-inspection (owner, 2026-11-20) ---------------------------------------------------------
  {id: 'SR27', what: 'the idle lane does nothing: the recursive loop is dropped', tests: [[LOOP_TEST, '^loop: an idle lane']],
    edits: [one(LANE, 'log.inspection = inspectIdle({repo, state, head, config, records: recordsDir, start: startInspection, at});', 'log.inspection = undefined;')]},
  {id: 'SR28', what: 'the lane inspects while a round is open (it is repairing, not idle)', tests: [[LOOP_TEST, '^loop: when something needs repair']],
    edits: [one(LANE, '        if (!rounds().some(r => !r.close)) log.inspection = inspectIdle(', '        if (true) log.inspection = inspectIdle(')]},
  {id: 'SR29', what: 'a second inspection starts while one runs', tests: [[LOOP_TEST, '^loop: one inspection at a time']],
    edits: [one(LANE, "    if (running && alive(running.pid)) return {state: 'running',", "    if (false) return {state: 'running',")]},
  {id: 'SR30', what: 'the same commit is inspected again and again', tests: [[LOOP_TEST, '^loop: a commit is inspected once']],
    edits: [one(LANE, "    if (done) return {state: 'already-inspected',", "    if (false) return {state: 'already-inspected',")]},
  {id: 'SR31', what: 'the inspector never stresses the tests changed since the last inspection', tests: [[LOOP_TEST, '^inspector: the gate run']],
    edits: [one(INSPECTOR, '    const files = plan.since ? changedTests(co.dir, plan.since, plan.commit) : [];', '    const files = [];')]},
  // ---- acquisition and retry: an inspection is complete by its evidence (2026-11-22) -----------------------------------
  {id: 'SR37', what: 'an incomplete inspection is taken as complete (the head is never inspected again)', tests: [[LOOP_TEST, '^acquisition: an attempt whose gate tool wrote no report']],
    edits: [one(LANE, '  return {complete: why.length === 0, why};', '  return {complete: true, why};')]},
  {id: 'SR38', what: 'a step killed at its bound counts as finished', tests: [[LOOP_TEST, '^acquisition: a step killed at its bound']],
    edits: [one(LANE, '    if (!Number.isInteger(s.exit) || s.killed) {', '    if (false) {')]},
  {id: 'SR39', what: 'a gate run whose tests fail is judged incomplete (retried for ever, its findings treated as noise)', tests: [[LOOP_TEST, '^acquisition: a gate run whose tests FAIL']],
    edits: [one(LANE, "const REPORT_VERDICTS = Object.freeze(['PASS', 'FAIL', 'UNVERIFIED']);", "const REPORT_VERDICTS = Object.freeze(['PASS', 'UNVERIFIED']);")]},
  {id: 'SR40', what: 'the stress comparison base is the last attempt, complete or not', tests: [[LOOP_TEST, '^acquisition: the stress comparison base']],
    edits: [one(LANE, '    const base = judged.find(j => j.x.commit !== head && j.c.complete)?.x.commit ?? null;', '    const base = last?.commit ?? null;')]},
  {id: 'SR41', what: 'an incomplete attempt is retried at once, with no delay', tests: [[LOOP_TEST, '^acquisition: an attempt whose gate tool wrote no report']],
    edits: [one(LANE, "      if (Date.parse(now) < Date.parse(due)) return {state: 'retry-wait',", "      if (false) return {state: 'retry-wait',")]},
  {id: 'SR42', what: "a dead inspector's attempt is not recorded as interrupted", tests: [[LOOP_TEST, '^recovery: an inspector that died']],
    edits: [one(LANE, "  if (!finished && SHA.test(running.commit ?? '')) {", '  if (false) {')]},
  {id: 'SR43', what: 'the inspector records an incomplete attempt as the last complete one', tests: [[LOOP_TEST, '^acquisition: an attempt whose gate tool wrote no report']],
    edits: [one(INSPECTOR, "    if (c.complete) writeJsonAtomic(path.join(dir, 'complete.json'), body);", "    writeJsonAtomic(path.join(dir, 'complete.json'), body);")]},
  {id: 'SR44', what: 'a legacy last.json is trusted without its evidence', tests: [[LOOP_TEST, '^legacy state:']],
    edits: [one(LANE, "    if (at.length !== 1) { why.push(at.length ? `${name}: recorded ${at.length} times` : `${name}: no result`); continue; }", '    if (at.length !== 1) continue;')]},
  {id: 'SR45', what: 'a gate report with no suite results is taken as complete', tests: [[LOOP_TEST, '^gate report: no suite']],
    edits: [one(LANE, "    if (!body.results.length) return 'the gate report has no suite results';", '')]},
  {id: 'SR46', what: "a report's verdict is not checked against the tool's exit", tests: [[LOOP_TEST, '^gate report: no suite']],
    edits: [one(LANE, '  const exitBad = () => (exit !== null && ', '  const exitBad = () => (false && ')]},
  {id: 'SR47', what: 'a gate report row that is not a suite is accepted', tests: [[LOOP_TEST, '^gate report: no suite']],
    edits: [one(LANE, "    if (bad >= 0) return `the gate report's results[${bad}] is not a usable suite row`;", '')]},
  {id: 'SR48', what: "Detect reads a historical gate record's rows unchecked (a malformed row stops it)", tests: [[LOOP_TEST, '^Detect reads a historical gate record']],
    edits: [one(LANE, '  for (const r of gateRows(rec).rows) {', '  for (const r of rec.record?.results ?? []) {')]},
  {id: 'SR49', what: 'a finished UNVERIFIED gate run allowed to exit 0 is retried for ever', tests: [[LOOP_TEST, "^gate report: the producer's finished layouts"]],
    edits: [one(LANE, "gate: {PASS: [0], FAIL: [1], UNVERIFIED: [2, 0]}", "gate: {PASS: [0], FAIL: [1], UNVERIFIED: [2]}")]},
  // ---- learning: the lane's own history and recurrence (owner, 2026-11-20: "Recursive") ----------------------------------
  {id: 'SR32', what: "a round's Diagnose is not handed the lane's history", tests: [[LEARN_TEST, '^learning: a defect back after']],
    edits: [one(LANE, '        history: r.open.history ?? [], recurrence: r.open.recurrence ?? null} : null;', '        history: [], recurrence: null} : null;'), one(LANE, 'history: history.slice(-20), recurrence, paths: d.site,', 'paths: d.site,')]},
  {id: 'SR33', what: 'a defect back after its landed repair is not recurring', tests: [[LEARN_TEST, '^learning: recurrence is']],
    edits: [one(LANE, "  if (returned.length) return {kind: 'returned',", "  if (false) return {kind: 'returned',")]},
  {id: 'SR34', what: 'no lesson candidate is routed for a recurring defect', tests: [[LEARN_TEST, '^learning: a defect back after']],
    edits: [one(LANE, '      if (recurrence) { const c = writeLessonCandidate(', '      if (false) { const c = writeLessonCandidate(')]},
  {id: 'SR35', what: 'a defect back after its repair landed is skipped as awaiting the merge (the lane never repairs it again)', tests: [[LEARN_TEST, '^learning: a failing test measured at a commit']],
    edits: [one(LANE, "      : landed.has(d.id) && !back(d, landed.get(d.id)) ? {route: 'landed',", "      : landed.has(d.id) ? {route: 'landed',")]},
  {id: 'SR36', what: "the planner prompt drops the lane's history", tests: [[LEARN_TEST, '^learning: Diagnose is shown']],
    edits: [one(STAGES_MOD, '      ...(selfRepair.history?.length ? [', '      ...(false ? [')]},
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
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(fs.realpathSync(path.join(ROOT, nm)), path.join(dest, nm), 'dir');
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
// The copy root defaults to the home directory, NOT the OS temp directory (as the other runners of this tree: the verify
// jail mounts a fresh tmpfs on /tmp). The copy is removed when the run ends; the logs go to the OS temp directory.
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `self-repair-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = path.join(fs.mkdtempSync(path.join(copyRoot, 'self-repair-mutate-')), 'tree');
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
