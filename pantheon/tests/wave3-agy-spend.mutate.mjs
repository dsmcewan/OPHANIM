#!/usr/bin/env node
// MUTATION RUNNER for L-504 invariants 3 (the Antigravity model guard) and 4 (no metered Gemini spend with the failover
// off), L-124 (the point-of-spend guard of the python SDK seat), and invariant 2 on the board's contributor rows (an
// unnamed serving model stays unknown; patch 3b-identity-1): wave 3, sub-wave 3B-1. Every mutation re-introduces
// a plausible regression of one enumerated path, on a DISPOSABLE COPY of this tree (never the tree itself); the two suites
// of this work run there, and the mutation is undone.
//
//   node pantheon/tests/wave3-agy-spend.mutate.mjs [--only G1,S4] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not
// occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): the suites stay
// green with it. A mutation with several edits applies all of them (a path guarded twice regresses only when both go).
// The copy is made under --copy-root (default: the home directory), NOT under /tmp: the agy jail mounts a fresh tmpfs
// there. The suites need bwrap (they run the fake agy CLI inside the real jail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITES = ['pantheon/tests/wave3-agy-guard.test.mjs', 'pantheon/tests/wave3-spend.test.mjs'];
const AGY = 'pantheon/src/board/agy-cli.mjs', RUN = 'pantheon/src/board/run-item.mjs', SUB = 'pantheon/src/review-runner/subscription.mjs';
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- invariant 3: the model guard, per entry point -------------------------------------------------------------
  {id: 'G1', path: 'A1/A2 runAgyCliTurn (single-turn seats, board CLI seats)', what: 'the single-turn seat reads the exit status and quota refusal before the identity (the base order)',
    edits: [one(AGY, '  if (mismatch) throw agyModelMismatch(mismatch, evidence);\n', '')]},
  {id: 'G2', path: 'B1/B2 runAgyWorkerTurn (pipeline implementer, review runner)', what: 'the worker reads its failure, timeout and quota refusal before the identity (the base order)',
    edits: [one(AGY, '  if (mismatch) throw agyModelMismatch(mismatch, more);\n', '')]},
  {id: 'G3', path: 'A1/A2/B1/B2 every CLI entry point', what: 'the identity check compares the agent only: another model passes the early check',
    edits: [one(AGY, 'return reported.agent === agent && reported.model === model ? null', 'return reported.agent === agent ? null')]},
  {id: 'G4', path: 'A1/A2 runAgyCliTurn', what: 'a result with no init is refused without the distinct code or the identities (the base error)',
    edits: [one(AGY, '    throw agyModelMismatch({ requested: { agent, model }, reported: { agent: init?.agent ?? null, model: init?.model ?? null } }, evidence);',
      '    throw Object.assign(new Error(`agy CLI identity mismatch: expected ${agent}/${model}, got none/none`), evidence);')]},
  {id: 'G5', path: 'B1 runAgyWorkerTurn', what: 'a worker result with no init is a lane_failure again: the pipeline ladder steps to another model',
    edits: [one(AGY, '    throw agyModelMismatch({ requested: { agent, model }, reported: { agent: init?.agent ?? null, model: init?.model ?? null } }, { detail: "identity", ...more });',
      '    throw laneFailure("stream", `agy CLI identity mismatch: expected ${agent}/${model}, got none/none`, { detail: "identity", ...more });')]},
  {id: 'G6', path: 'C the python SDK seat', what: 'the SDK seat\'s reported model is not compared: the request is stamped as served (the base)',
    edits: [one(RUN, 'if ((reported !== null && reported !== model) || (reported === null && run.status === 0 && out?.ok === true)) {', 'if (false) {')]},
  {id: 'G7', path: 'B2 the review runner', what: 'a mismatched review run is an ordinary incomplete run again (continuable, its session kept)',
    edits: [one(SUB, '    if (e.code === AGY_MODEL_MISMATCH) {', '    if (false) {')]},
  {id: 'G8', path: 'B2 the review runner', what: 'the findings header stamps the lane as served even for a mismatch',
    edits: [one(SUB, '      ...(r.identity_mismatch ? [`- served_model: none', '      ...(false ? [`- served_model: none')]},
  {id: 'G9', path: 'A2/C the board', what: 'the failed attempt drops the two identities',
    edits: [one(RUN, 'provider_requests: laneCharged,\n          ...(e?.identity ? { identity: e.identity } : {}) });', 'provider_requests: laneCharged });')]},
  {id: 'G10', path: 'A2/C/B the board', what: 'run.error drops the refusal\'s code and identities (the base record)',
    edits: [one(RUN, ', ...(typeof e?.code === "string" ? { code: e.code } : {}), ...(e?.identity ? { identity: e.identity } : {}) };', ' };')]},
  // ---- invariant 2 on the board's contributor rows (patch 3b-identity-1): an unnamed serving model stays unknown --------
  {id: 'I1', path: 'board critique contributor row', what: 'a reviewer turn that named no serving model is recorded with served_model omitted (reads as the model asked)',
    edits: [one(RUN, '...(sm && sm !== r.model ? { served_model: sm } : !sm ? { served_model: null, served_model_source: "unnamed" } : {}) };', '...(sm && sm !== r.model ? { served_model: sm } : {}) };')]},
  {id: 'I2', path: 'board work contributor row', what: 'a work turn that named no serving model is recorded with served_model omitted (reads as the model asked)',
    edits: [one(RUN, '...(typeof workServed === "string" && workServed.trim() ? (workRec?.served_model_source ? { served_model_source: workRec.served_model_source } : {}) : { served_model: null, served_model_source: "unnamed" }) };',
      '...(workRec?.served_model_source ? { served_model_source: workRec.served_model_source } : {}) };')]},
  {id: 'I3', path: 'board critique contributor row', what: 'a serving model the reviewer\'s provider named is dropped from the row',
    edits: [one(RUN, '...(sm && sm !== r.model ? { served_model: sm } : !sm ?', '...(false ? { served_model: sm } : !sm ?')]},
  {id: 'I4', path: 'board work contributor row', what: 'a serving model the worker\'s provider named is dropped from the row',
    edits: [one(RUN, '...(typeof workServed === "string" && workServed.trim() && workServed !== made.seat.model ? { served_model: workServed } : {}),', '')]},
  // ---- invariant 4 / L-124: no metered Gemini call with the failover off, per seat and path -------------------------
  {id: 'S1', path: 'L/P liveTurn -> laneFirstTurn, a lane quota refusal', what: 'laneFirstTurn ignores failover: false and asks the metered API',
    edits: [one('pantheon/src/sdk/agy-turn.mjs', '    if (failover === false) {\n', '    if (false) {\n')]},
  {id: 'S2', path: 'L/P liveTurn -> laneFirstTurn, a Gemini seat with no lane', what: 'AGY_NO_LANE removed: a laneless Gemini seat goes to the metered API',
    edits: [one('pantheon/src/sdk/agy-turn.mjs', 'if (!viaLane && failover === false && vendor === "agy_google") {', 'if (false) {')]},
  {id: 'S3', path: 'L/P liveTurn wiring', what: 'liveTurn does not carry meteredFailover into laneFirstTurn',
    edits: [one('pantheon/src/sdk/live.mjs', 'laneFirstTurn(args, { lane: agySingleTurn, api, failover: meteredFailover })', 'laneFirstTurn(args, { lane: agySingleTurn, api, failover: true })')]},
  {id: 'S4', path: 'I the pipeline implementer', what: 'the implementer ignores agy.meteredFailover: false and asks the metered API',
    edits: [one('pantheon/src/pipeline/turns.mjs', '      if (agy.meteredFailover === false) {', '      if (false) {')]},
  {id: 'S5', path: 'B(api) the board\'s Gemini API seat (operator seat, ticket pin)', what: 'the point-of-spend guard of the API seat removed (the base)',
    edits: [one(RUN, '    if (!METERED_FAILOVER && isMeteredGemini({ vendor, transport: transport ?? "api" })) {', '    if (false) {')]},
  {id: 'S6', path: 'B(sdk) the python SDK seat (L-124)', what: 'the SDK seat\'s point-of-spend guard removed (the base)',
    edits: [one(RUN, '      if (!METERED_FAILOVER && isMeteredGemini({ vendor: "agy_google", transport: "sdk" })) {', '      if (false) {')]},
  {id: 'S7', path: 'B(sdk) the python SDK seat (L-124)', what: 'the metered classification forgets the SDK transport',
    edits: [one('pantheon/src/route/quota-failover.mjs', '(transport === "api" || transport === "sdk")', 'transport === "api"')]},
  {id: 'S8', path: 'B(spare) the walk\'s quota-failover candidate', what: 'both protections of the spare removed: the walk reaches it and the seat is not refused at spend',
    edits: [one('pantheon/src/route/quota-failover.mjs', '    if (c.quota_failover && !meteredFailover) {', '    if (false) {'),
      one(RUN, '    if (!METERED_FAILOVER && isMeteredGemini({ vendor, transport: transport ?? "api" })) {', '    if (false) {')]},
  {id: 'S9', path: 'B the board wiring', what: 'runOpenItem does not carry opts.meteredFailover',
    edits: [one(RUN, 'const METERED_FAILOVER = opts.meteredFailover ?? true;', 'const METERED_FAILOVER = true;')]},
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
  const g = (...a) => execFileSync('git', ['-C', dest, ...a], {stdio: 'ignore'});
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'add', '-A');
  g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'commit', '-q', '-m', 'mutation copy');
}
const runSuites = (dir, logFile) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=300000', ...SUITES], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
// Every edit must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `wave3-agy-spend-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'wave3-agy-spend-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'));
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
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`));
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
      summary.push({id: m.id, path: m.path, what: m.what, files: [...new Set(m.edits.map(e => e.file))], killed, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  [${m.path}] ${m.what}`);
      for (const f of r.failed.slice(0, 4)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
