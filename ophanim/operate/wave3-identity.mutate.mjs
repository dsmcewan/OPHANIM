#!/usr/bin/env node
// MUTATION RUNNER for wave 3, register L-504 invariant 2 (model identity -- requested model, served model,
// served_model_source, lab -- preserved through every projection). Every mutation re-introduces a plausible regression of
// the invariant on ONE enumerated projection path (the path ids are those of the wave's report and of the subtest names
// in the two test files): a field dropped, a served name replaced by the requested one, a marker lost, or a consumer
// that decides on the requested name instead of the served one. Each is made on a DISPOSABLE COPY of this tree (never on
// the tree itself), the identity tests named for it run there, and the copy is discarded.
//
//   node ophanim/operate/wave3-identity.mutate.mjs [--only W1,W2] [--log DIR] [--copy-root DIR] [--check]
//
// EXIT CODES: 2 when a target does not occur exactly once (the mutation would not apply, or would apply ambiguously),
// 3 when the unmutated suites are not green, 1 when any mutation SURVIVES (its tests still pass); 0 only when every
// mutation applied and was killed. Every mutation is recorded in the log directory (one log per mutation, summary.json).
// The copy root defaults to the home directory: not /tmp, where the agy worker jail mounts a fresh tmpfs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OP = ['ophanim/operate/wave3-identity.test.mjs'];
const PAN = ['pantheon/tests/wave3-identity.test.mjs'];
const BOTH = [...OP, ...PAN];
const ST = 'ophanim/operate/stages.mjs';

export const MUTATIONS = [
  // ---- the pipeline's run record and its projections (pantheon/src/pipeline) -------------------------------------
  {id: 'W1', path: 'R1', what: 'the run record\'s de-duplication key omits the marker again: two answers of one served model under two markers become one row', file: 'pantheon/src/pipeline/record.mjs',
    from: 'c.served_model ?? "", c.served_model_source ?? ""].join("\\u0000");', to: 'c.served_model ?? ""].join("\\u0000");', tests: BOTH},
  {id: 'W2', path: 'R1', what: 'contributionsOf takes a work row\'s served model from the model asked', file: 'pantheon/src/pipeline/record.mjs',
    from: 'vendor: a.vendor, model: a.model, served_model: a.served_model ?? null, ...src(a) });', to: 'vendor: a.vendor, model: a.model, served_model: a.model, ...src(a) });', tests: BOTH},
  {id: 'W3', path: 'R1', what: 'contributionsOf drops every marker', file: 'pantheon/src/pipeline/record.mjs',
    from: '  const p = run?.planner ?? null;\n  const src = x => (x?.served_model_source ? { served_model_source: x.served_model_source } : {});',
    to: '  const p = run?.planner ?? null;\n  const src = x => ({});', tests: BOTH},
  {id: 'W4', path: 'R2', what: 'arbitersOf takes the dispatcher\'s served model from the model asked', file: 'pantheon/src/pipeline/record.mjs',
    from: 'vendor: d.vendor, model: d.model, served_model: d.served_model, ...src(d), rubric_hash: d.rubric_hash });', to: 'vendor: d.vendor, model: d.model, served_model: d.model, ...src(d), rubric_hash: d.rubric_hash });', tests: BOTH},
  {id: 'W5', path: 'R3', what: 'the Stage 5 finding names its reviewer\'s served model as the model asked', file: 'pantheon/src/pipeline/index.mjs',
    from: 'requested_model: review.requested_model ?? review.model, served_model: review.served_model ?? null,', to: 'requested_model: review.requested_model ?? review.model, served_model: review.model,', tests: BOTH},
  {id: 'W6', path: 'R5', what: 'the checkpoint\'s reviewer drops its marker', file: 'pantheon/src/pipeline/index.mjs',
    from: 'reviewer: { vendor: rv.vendor, model: rv.model, served_model: rv.served_model, ...(rv.served_model_source ? { served_model_source: rv.served_model_source } : {}) },',
    to: 'reviewer: { vendor: rv.vendor, model: rv.model, served_model: rv.served_model },', tests: PAN},
  {id: 'W7', path: 'R6', what: 'a resumed unit\'s arbiter takes the served model from the model asked', file: 'pantheon/src/pipeline/index.mjs',
    from: 'model: got.record.dispatch.model, served_model: got.record.dispatch.served_model ?? null,', to: 'model: got.record.dispatch.model, served_model: got.record.dispatch.model,', tests: PAN},
  {id: 'W8', path: 'R6', what: 'a resumed unit\'s lineage loses its served models', file: 'pantheon/src/pipeline/index.mjs',
    from: '          contributions: clone(got.record.contributions),', to: '          contributions: clone(got.record.contributions).map(c => ({ ...c, served_model: c.model })),', tests: PAN},
  {id: 'W9', path: 'R4', what: 'Stage 5 excludes a unit\'s authors by the model asked only, not the model that served them', file: 'pantheon/src/pipeline/index.mjs',
    from: '.map(c => ({ vendor: c.vendor, model: c.model, served_model: c.served_model ?? null })));', to: '.map(c => ({ vendor: c.vendor, model: c.model, served_model: null })));', tests: PAN},
  {id: 'W10', path: 'R7', what: 'a recorded dispatch that names no serving model is resumed again', file: 'pantheon/src/pipeline/checkpoint.mjs',
    from: '    if (!str(d.served_model)) return `the checkpoint\'s dispatcher (${d.model}) names no serving model: a judging answer is admitted only on the model that answered`;\n', to: '', tests: PAN},
  {id: 'W46', path: 'P1g', what: 'a model-guard refusal is recorded as TURN_FAILED again: its code and both identities are lost', file: 'pantheon/src/pipeline/implement.mjs',
    from: '    if (e?.code === "AGY_MODEL_MISMATCH") return Object.assign(rec, { code: "AGY_MODEL_MISMATCH", identity: e.identity ?? null,', to: '    if (false) return Object.assign(rec, { code: "AGY_MODEL_MISMATCH", identity: e.identity ?? null,', tests: PAN},
  {id: 'W47', path: 'P1g', what: 'a model-guard refusal is revised on the same lane (a second attempt) instead of blocking the unit', file: 'pantheon/src/pipeline/index.mjs',
    from: 'if (a.code === "PROVIDER_LIMIT" || a.code === "AGY_MODEL_MISMATCH" || a.code === "TURN_FAILED" && signal?.aborted)', to: 'if (a.code === "PROVIDER_LIMIT" || a.code === "TURN_FAILED" && signal?.aborted)', tests: PAN},
  // ---- the change scope, the review cycle and its ledger -----------------------------------------------------------
  {id: 'W11', path: 'G1', what: 'the cycle\'s contributor rows drop the identity of their contribution', file: 'pantheon/src/ledger/review-cycle.mjs',
    from: '  const id = who ? {requested_model: who.requested_model, served_model: who.served_model, ...(who.served_model_source ? {served_model_source: who.served_model_source} : {})} : {};',
    to: '  const id = {};', tests: BOTH},
  {id: 'W12', path: 'G2', what: 'openCycle records a contributor row\'s served model as the model asked', file: 'pantheon/src/ledger/cycle-kinds.mjs',
    from: '...(x.model && x.served_model !== undefined ? {served_model: x.served_model ?? null} : {}),', to: '...(x.model && x.served_model !== undefined ? {served_model: x.requested_model ?? null} : {}),', tests: BOTH},
  {id: 'W13', path: 'G2', what: 'the v3 cycle kind no longer checks a contributor row\'s stated identity', file: 'pantheon/src/ledger/cycle-kinds.mjs',
    from: '  for (const x of p.contributors) { const why = contributorIdentityRefusal(x); if (why) return `a ${CYCLE_CONTRACT_V3} cycle\'s ${why}`; }\n', to: '', tests: PAN},
  {id: 'W14', path: 'G4', what: 'a resumed cycle\'s retained reviews drop their marker', file: 'pantheon/src/ledger/review-cycle.mjs',
    from: 'served_model: r.served_model, ...(r.served_model_source ? {served_model_source: r.served_model_source} : {}), lab: r.lab, turn: r.turn, review: r.hash,',
    to: 'served_model: r.served_model, lab: r.lab, turn: r.turn, review: r.hash,', tests: PAN},
  {id: 'W15', path: 'G6', what: 'a reassessment reads the model asked as the model that served a recorded review', file: 'pantheon/src/review/identity.mjs',
    from: '    const why = reviewerRefusal({ vendor: r.seat.vendor, model: r.model, served_model: r.served_model ?? null }, keys, policy);',
    to: '    const why = reviewerRefusal({ vendor: r.seat.vendor, model: r.model, served_model: r.model }, keys, policy);', tests: PAN},
  {id: 'W16', path: 'B1', what: 'the change scope carries an unnamed served model as the model asked again (no marker)', file: 'pantheon/src/review/scope.mjs',
    from: ' : { served_model_source: "unnamed" }),', to: ' : {}),', tests: BOTH},
  {id: 'W17', path: 'B2', what: 'the change scope (and so the panel\'s exclusions) names the model asked in place of the model that served', file: 'pantheon/src/review/scope.mjs',
    from: 'const row = { purpose: t.purpose, vendor: t.vendor, model: t.served_model ?? t.model ?? null,', to: 'const row = { purpose: t.purpose, vendor: t.vendor, model: t.model ?? null,', tests: BOTH},
  // ---- the outcome's proposal and the status ledger's evidence ----------------------------------------------------
  {id: 'W18', path: 'T1', what: 'the status evidence refuses a reviewer\'s marker again', file: 'packages/ledger/status.mjs',
    from: "only(x, ['vendor', 'model', 'served_model', 'served_model_source', 'lab'])", to: "only(x, ['vendor', 'model', 'served_model', 'lab'])", tests: BOTH},
  {id: 'W19', path: 'T1', what: 'the status evidence accepts a marker inconsistent with the names', file: 'packages/ledger/status.mjs',
    from: '&& str(x.lab) && markerOk(x);', to: '&& str(x.lab);', tests: PAN},
  {id: 'W20', path: 'T2', what: 'the evidence re-check no longer compares a reviewer\'s marker with its review\'s answering turn', file: 'packages/ledger/status.mjs',
    from: '  for (const r of review.reviewers.filter(x => x.served_model_source !== undefined)) {', to: '  for (const r of review.reviewers.filter(x => false)) {', tests: OP},
  {id: 'W21', path: 'B3', what: 'the proposal\'s reviewers drop their marker', file: 'pantheon/src/board/operate.mjs',
    from: 'served_model: p.served_model ?? null, ...(x.source ? { served_model_source: x.source } : {}), lab: x.lab };', to: 'served_model: p.served_model ?? null, lab: x.lab };', tests: OP},
  // ---- the lifecycle's stage projections (ophanim/operate/stages.mjs) ------------------------------------------------
  {id: 'W22', path: 'S3', what: 'dedupe keys a row without its served model and marker again', file: ST,
    from: "|${r.lab}|${Object.hasOwn(r, 'served_model') ? r.served_model ?? 'null' : ''}|${r.served_model_source ?? ''}`, r])).values()];", to: "|${r.lab}`, r])).values()];", tests: OP},
  {id: 'W23', path: 'S1', what: 'an authored row of an unnamed answer carries no marker (it reads as served by the model asked)', file: ST,
    from: " : {served_model_source: 'unnamed'});", to: ' : {});', tests: OP},
  {id: 'W24', path: 'S1', what: 'an authored row names the model asked as the model that served', file: ST, from: '      const model = c.served_model ?? c.model;', to: '      const model = c.model;', tests: OP},
  {id: 'W25', path: 'S2', what: 'an arbiter row names the dispatcher asked as the model that served', file: ST, from: '    const model = a.served_model ?? a.model;', to: '    const model = a.model;', tests: OP},
  {id: 'W26', path: 'S4/S5', what: 'a team row takes the served model from the seat asked', file: ST,
    from: 'const answered = x => ({vendor: x.vendor ?? null, model: x.model ?? null, served_model: x.served_model ?? null,', to: 'const answered = x => ({vendor: x.vendor ?? null, model: x.model ?? null, served_model: x.model ?? null,', tests: OP},
  {id: 'W27', path: 'S6', what: 'a unit finding drops its Stage 5 reviewer\'s served identity', file: ST,
    from: "      ...(f.source === 'reviewer' ? withServed(f) : {}), lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.served_model ?? f.model) : null}))))]",
    to: "      lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.served_model ?? f.model) : null}))))]", tests: OP},
  {id: 'W48', path: 'S7', what: 'a killed attempt\'s carried finding drops its reviewer\'s served identity and marker', file: ST,
    from: "        ...(f.source === 'reviewer' ? withServed(f) : {}), lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.served_model ?? f.model) : null, carried_from:",
    to: "        lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.served_model ?? f.model) : null, carried_from:", tests: OP},
  {id: 'W28', path: 'S9', what: 'the next run\'s Stage 5 exclusions take a returning dispatcher\'s omitted served name as unknown again', file: ST,
    from: 'return {vendor: c.vendor, model: i.requested_model, served_model: i.served_model, requested_model: i.requested_model,', to: 'return {vendor: c.vendor, model: i.requested_model, served_model: c.served_model ?? null, requested_model: i.requested_model,', tests: OP},
  {id: 'W29', path: 'S11', what: 'the planner\'s served row drops the name it was asked as', file: ST,
    from: "model: x.served_model || planner.model, ...(x.served_model && x.served_model !== planner.model ? {requested_model: planner.model} : {}),", to: 'model: x.served_model || planner.model,', tests: OP},
  {id: 'W30', path: 'S15', what: 'a resumed plan\'s lineage rows keep only the recorded name again', file: ST,
    from: '        const stated = c.requested_model !== undefined || c.served_model !== undefined;', to: '        const stated = false;', tests: OP},
  {id: 'W31', path: 'S16', what: 'a cycle finder row drops its reviewer\'s served model', file: ST,
    from: '    ...(r?.served_model && r.served_model !== r.model ? {served_model: r.served_model} : {}), ...(r?.served_model_source ? {served_model_source: r.served_model_source} : {}), lab: r?.lab ?? null,',
    to: '    ...(r?.served_model_source ? {served_model_source: r.served_model_source} : {}), lab: r?.lab ?? null,', tests: OP},
  {id: 'W32', path: 'S13/S14', what: 'a finding fed to a revision (critique, dispatcher return) loses its reviewer\'s served model', file: ST,
    from: "const findingContribution = (f, via) => ({purpose: isAdvisory(f) ? 'dispatcher-return' : 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab,",
    to: "const findingContribution = (f, via) => ({purpose: isAdvisory(f) ? 'dispatcher-return' : 'critique', vendor: f.vendor ?? null, model: f.model ?? null, lab: f.lab,", tests: OP},
  {id: 'W33', path: 'S13', what: 'the implement stage\'s critique row loses its reviewer\'s served model', file: ST,
    from: "...critiques.filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab,",
    to: "...critiques.filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, lab: f.lab,", tests: OP},
  {id: 'W34', path: 'S18', what: 'the review stage\'s team drops each reviewer\'s marker', file: ST,
    from: '      ...(x.served_model_source ? {served_model_source: x.served_model_source} : {}), lab: x.lab, verdict: x.verdict}));', to: '      lab: x.lab, verdict: x.verdict}));', tests: OP},
  {id: 'W35', path: 'S20', what: 'the validator reads the passing review\'s reviewers without their served model', file: ST,
    from: "rows: st.reviews.map(r => ({vendor: r.seat.vendor, model: r.model, ...(r.served_model ? {served_model: r.served_model} : {}),", to: 'rows: st.reviews.map(r => ({vendor: r.seat.vendor, model: r.model,', tests: OP},
  {id: 'W36', path: 'S21', what: 'the validator\'s record drops its marker', file: ST,
    from: 'served_model: judged?.served_model ?? null, ...(judged?.served_model_source ? {served_model_source: judged.served_model_source} : {}),', to: 'served_model: judged?.served_model ?? null,', tests: OP},
  {id: 'W37', path: 'S21', what: 'the validator is admitted (and recorded) on the model asked in place of the model that answered', file: ST,
    from: '      const served = reply.served_model ?? null;', to: '      const served = seat.model;', tests: OP},
  // ---- the live run's record (ophanim/operate/live-run.mjs) ---------------------------------------------------------
  {id: 'W38', path: 'V1', what: 'servedIdentities drops a team row\'s marker', file: 'ophanim/operate/live-run.mjs',
    from: "'served_model', 'requested_model', 'served_model_source', 'standing', 'authored', 'shared_lab'])});", to: "'served_model', 'requested_model', 'standing', 'authored', 'shared_lab'])});", tests: OP},
  {id: 'W39', path: 'V2', what: 'servedIdentities drops the validator\'s marker', file: 'ophanim/operate/live-run.mjs',
    from: "...pick(s.outputs[k], ['vendor', 'model', 'lab', 'served_model', 'requested_model', 'served_model_source'])});", to: "...pick(s.outputs[k], ['vendor', 'model', 'lab', 'served_model'])});", tests: OP},
  {id: 'W40', path: 'V4', what: 'subagentReceipt drops a call\'s marker', file: 'ophanim/operate/live-run.mjs',
    from: '      served_model_source: c.served_model_source ?? null, answer_digest: c.answer_digest ?? null,', to: '      answer_digest: c.answer_digest ?? null,', tests: OP},
  {id: 'W41', path: 'V4', what: 'subagentReceipt counts a call by the model asked, not the model that served it', file: 'ophanim/operate/live-run.mjs',
    from: '&& c.served_model && sameModel(c.served_model, req.model));', to: '&& sameModel(c.model, req.model));', tests: OP},
  // ---- the public record ----------------------------------------------------------------------------------------------
  {id: 'W42', path: 'U1', what: 'the provenance seat rows drop the marker', file: 'ophanim/public/provenance.mjs',
    from: "...seat(r.hash, {...p, requested_model: turn?.requested_model ?? p.model, served_model_source: turn?.served_model_source ?? null}), turn: p.turn ?? null,",
    to: '...seat(r.hash, {...p, requested_model: turn?.requested_model ?? p.model}), turn: p.turn ?? null,', tests: OP},
  {id: 'W43', path: 'U1', what: 'the provenance counts an input-stamped served name as reported by its provider', file: 'ophanim/public/provenance.mjs',
    from: "served_reported: reviews.filter(r => r.served_model !== null && !['input', 'unnamed'].includes(r.served_model_source)).length,", to: 'served_reported: reviews.filter(r => r.served_model !== null).length,', tests: OP},
  {id: 'W44', path: 'U2', what: 'the evidence section drops a reviewer\'s marker', file: 'ophanim/public/record.mjs',
    from: "${cell(r.served_model ?? 'not reported')}${r.served_model_source ? ` (${cell(r.served_model_source)})` : ''} |", to: "${cell(r.served_model ?? 'not reported')} |", tests: OP},
  {id: 'W45', path: 'U3', what: 'the work section shows one name and no marker again', file: 'ophanim/public/record.mjs',
    from: "const note = [...(asked && served && asked !== served ? [`asked ${asked}`] : []), ...(t.served_model_source ? [t.served_model_source] : [])];", to: 'const note = [];', tests: OP},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean)
    // The copy needs the code and its tests, not the independent review evidence or the execution records.
    .filter(f => !/^docs\/(reviews|execution)\//.test(f) && f !== 'docs/OPEN-LIMITATIONS.md');
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
const runSuites = (dir, tests, logFile) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=300000', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
// Every target must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.map(m => ({m, n: fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1})).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${m.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation target(s), each occurring exactly once`); process.exit(0); }
const logDir = path.resolve(arg('--log', path.join(os.homedir(), `wave3-identity-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const copy = fs.mkdtempSync(path.join(copyRoot, 'wave3-identity-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, BOTH, path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !Number.isFinite(baseline.tests)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    process.exit(3);
  }
  for (const m of chosen) {
    const file = path.join(copy, m.file), orig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, orig.replace(m.from, () => m.to));
    if (fs.readFileSync(file, 'utf8') === orig) { console.error(`${m.id}: MUTATION DID NOT APPLY`); exit = 2; continue; }
    const r = runSuites(copy, m.tests ?? BOTH, path.join(logDir, `${m.id}.log`));
    fs.writeFileSync(file, orig);
    const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
    summary.push({id: m.id, path: m.path, what: m.what, file: m.file, killed, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
    console.log(`${m.id} [${m.path}] ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  (${m.what})`);
    for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
    if (!killed) exit = exit || 1;
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed; logs in ${logDir}`);
process.exit(exit);
