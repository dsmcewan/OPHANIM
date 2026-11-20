#!/usr/bin/env node
// MUTATION RUNNER for register L-136 (extending L-124): the one centrally enforced Gemini billing policy across the seven
// entry points (operate tick, watch, serve; pantheon-board; pantheon-compare; pantheon-review-cycle; run-review --via api).
// Every mutation re-introduces a plausible regression of the policy -- a default flipped back to on at an entry point, a key
// read as authorization, one setting authorizing the other's kind, a charge made after the send, a budget not enforced or
// reset by a restart, a refusal recorded as a failure that loses the work, the board's reviewer back on the billed SDK seat,
// an enabled setting accepted without a budget, an entry point that does not carry the policy -- on a DISPOSABLE COPY of
// this tree (never the tree itself); the L-136 suites run there, and the mutation is undone.
//
//   node pantheon/tests/l136-billing.mutate.mjs [--only D1,K1] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not
// occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): the suites stay
// green with it. A mutation with several edits applies all of them (a path guarded twice regresses only when both go: the
// work ledger re-derives the budget under its append lock as a second check). The copy is made under --copy-root (default:
// the home directory), NOT under /tmp: the agy jail mounts a fresh tmpfs there. The suites need bwrap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITES = ['pantheon/tests/l136-policy.test.mjs', 'pantheon/tests/l136-billing.test.mjs', 'ophanim/operate/l136-billing.test.mjs'];
// A mutation may name the suites that decide it (`suites`); the others run SUITES. P6 does: where the lifecycle seats its
// Google implementer on the Antigravity SDK, `operate` does not reach the pipeline's lane implementer, so none of the three
// suites above drives that failover any more, and the suite that does is the pipeline's own (register L-721).
const LANE_IMPLEMENTER = 'pantheon/tests/wave3-spend.test.mjs';
const GB = 'pantheon/src/route/gemini-billing.mjs', WL = 'ophanim/operate/work-ledger.mjs', SCH = 'ophanim/operate/scheduler.mjs', RUN = 'pantheon/src/board/run-item.mjs';
const CLI = 'ophanim/operate/cli.mjs', SVC = 'ophanim/operate/service.mjs', BOARD = 'pantheon/bin/pantheon-board.mjs', CMP = 'pantheon/bin/pantheon-compare.mjs';
const CYC = 'pantheon/bin/pantheon-review-cycle.mjs', RR = 'pantheon/src/review-runner/index.mjs', PIPE = 'pantheon/src/pipeline/turns.mjs';
const one = (file, from, to) => ({file, from, to});
const ON = "'metered-gemini-failover': '1000000', 'gemini-api-primary': '1000000'";
// The work ledger's own budget check (re-derived under its append lock): removed where a mutation must reach operate too.
const NO_LEDGER_BUDGET = one(WL, '        return geminiBudgetRefusal({kind: p.kind, budget: p.budget, used});', '        return null;');

export const MUTATIONS = [
  // ---- the default flipped back to ON, at each entry point (owner item 1) ----------------------------------------------
  {id: 'D1', path: 'operate tick and watch (cli.mjs)', what: 'no flag resolves to both kinds enabled',
    edits: [one(CLI, '      const billing = billingFromFlags(opts);', `      const billing = billingFromFlags({${ON}, ...opts});`)]},
  {id: 'D2', path: 'operate serve (service.mjs)', what: 'a config without billing resolves to both kinds enabled',
    edits: [one(SVC, '    billing: billingFromConfig(c.billing, `service config ${path.resolve(file)} billing`),',
      '    billing: billingFromConfig(c.billing ?? {metered_gemini_failover: {enabled: true, budget: 1000000}, gemini_api_primary: {enabled: true, budget: 1000000}}, `service config ${path.resolve(file)} billing`),')]},
  {id: 'D3', path: 'pantheon-board run/resume', what: 'no flag resolves to both kinds enabled',
    edits: [one(BOARD, 'const billingPolicy = () => { try { return billingFromFlags(opts); }', `const billingPolicy = () => { try { return billingFromFlags({ ${ON}, ...opts }); }`)]},
  {id: 'D4', path: 'pantheon-compare', what: 'no flag resolves to both kinds enabled',
    edits: [one(CMP, 'try { policy = billingFromFlags(opts); }', `try { policy = billingFromFlags({ ${ON}, ...opts }); }`)]},
  {id: 'D5', path: 'pantheon-review-cycle review/resume', what: 'no flag resolves to both kinds enabled',
    edits: [one(CYC, 'try { return geminiBilling({policy: billingFromFlags(opts),', `try { return geminiBilling({policy: billingFromFlags({${ON}, ...opts}),`)]},
  {id: 'D6', path: 'run-review --via api', what: 'no flag resolves to both kinds enabled',
    edits: [one(RR, '  try { billing = billingFromFlags(v); }', `  try { billing = billingFromFlags({ ${ON}, ...v }); }`)]},
  {id: 'D7', path: 'the central resolution (every entry point)', what: 'an absent setting resolves to enabled',
    edits: [one(GB, '  if (d === undefined || d === null) return Object.freeze({ enabled: false, budget: null, source: "default: absent, off" });',
      '  if (d === undefined || d === null) return Object.freeze({ enabled: true, budget: 1000000, source: "default: absent, on" });')]},
  // ---- a key in the environment read as an authorization (owner item 3) ------------------------------------------------
  {id: 'K1', path: 'the point of spend (every entry point)', what: 'a GEMINI_API_KEY in the environment admits a kind that is off',
    edits: [one(GB, '  if (!set.enabled) {', '  if (!set.enabled && !process.env.GEMINI_API_KEY) {'),
      one(GB, '  const used = ctx.ledger.used(kind);', '  const used = ctx.ledger ? ctx.ledger.used(kind) : 0;'),
      one(GB, '  if (used >= set.budget) {', '  if (used >= (set.budget ?? Infinity)) {'),
      one(GB, '  try { ctx.ledger.record(row); }', '  try { ctx.ledger?.record(row); }')]},
  // ---- the two settings authorize each other's kind (the owner's separate authorization semantics) ----------------------
  {id: 'X1', path: 'the point of spend', what: 'the failover switch authorizes a primary seat',
    edits: [one(GB, '  const set = policy[name];', '  const set = kind === "primary" && policy.metered_gemini_failover.enabled ? policy.metered_gemini_failover : policy[name];')]},
  {id: 'X2', path: 'the point of spend', what: 'the primary setting authorizes a failover',
    edits: [one(GB, '  const set = policy[name];', '  const set = kind === "failover" && policy.gemini_api_primary.enabled ? policy.gemini_api_primary : policy[name];')]},
  // ---- the charge made after the send (owner item 5) --------------------------------------------------------------------
  {id: 'C1', path: 'the point of spend (every entry point)', what: 'the usage row is persisted after the request has gone',
    edits: [one(GB, '  try { ctx.ledger.record(row); }', '  try { setImmediate(() => { try { ctx.ledger.record(row); } catch { /* late */ } }); }')]},
  // ---- the budget not enforced; the budget reset by a restart (owner items 5 and 6) -------------------------------------
  {id: 'B1', path: 'the point of spend and the work ledger', what: 'the declared budget is not enforced (both checks)',
    edits: [one(GB, '  if (used >= set.budget) {', '  if (false) {'), NO_LEDGER_BUDGET]},
  {id: 'R1', path: 'the point of spend and the work ledger', what: 'consumption counted from process memory (this context\'s rows): every new run, restart or stage starts from zero',
    edits: [one(GB, '  const used = ctx.ledger.used(kind);', '  const used = ctx.rows.filter(r => r.kind === kind).length;'), NO_LEDGER_BUDGET]},
  {id: 'R2', path: 'operate (scheduler.mjs)', what: 'the stage counts only its own claim\'s billed requests: a retry, a restart or a later tick starts from zero',
    edits: [one(SCH, '  used: kind => work.billings(kind).length,', '  used: kind => work.billings(kind).filter(b => b.derived_from.includes(claim)).length,'), NO_LEDGER_BUDGET]},
  {id: 'R3', path: 'the usage file (board, compare, review-cycle, review runner)', what: 'only this process\'s rows count: a restart resets the budget',
    edits: [one(GB, '  return Object.freeze({ where: file, used: kind => rows().filter(r => r.kind === kind).length, rows, record });',
      '  return Object.freeze({ where: file, used: kind => rows().filter(r => r.kind === kind && Date.parse(r.at) >= performance.timeOrigin).length, rows, record });')]},
  // ---- a refusal recorded as a failure that loses the work (owner item 4) -----------------------------------------------
  {id: 'W1', path: 'operate (scheduler.mjs)', what: 'a stage the policy refused keeps the status it reported (a structural block or a failure), not the pending that resumes',
    edits: [one(SCH, "    if (!ctx.refusals.length || ['passed', 'returned'].includes(out.status)) return out;", '    if (true) return out;')]},
  {id: 'W2', path: 'operate (scheduler.mjs)', what: 'a changed policy does not wake the refused stage',
    edits: [one(SCH, "    if (gate?.gate !== 'blocked' || !gate.blocker?.transient || !billingChanged(gate.blocker, billing)) return gate;", '    return gate;')]},
  // ---- the board's reviewer and scout back on the billed SDK seat by default (the owner's primary decision) --------------
  {id: 'T1', path: 'pantheon-board (run-item.mjs agyTurn)', what: 'the reviewer and scout default to the python SDK seat again',
    edits: [one(RUN, '(process.env.PANTHEON_AGY_TRANSPORT ?? "cli")', '(process.env.PANTHEON_AGY_TRANSPORT ?? "sdk")')]},
  {id: 'T2', path: 'pantheon-board (run-item.mjs agyTurn, the SDK seat)', what: 'the SDK seat\'s point-of-spend guard removed (L-124)',
    edits: [one(RUN, '      try { geminiAdmission(BILLING, spend); }\n      catch (refusal) { progress({ event: "turn.refused", seat: "agy_google", model, detail: refusal.message.slice(0, 300) }); record(); throw refusal; }\n', ''),
      one(RUN, '      try { spendGemini(BILLING, spend, () => admit()); }', '      try { admit(); }')]},
  // ---- an enabled setting accepted without a budget (owner item 5: declared budgets) -----------------------------------
  {id: 'E1', path: 'the central resolution (flags and configuration)', what: 'enabling without a positive-integer budget is accepted',
    edits: [one(GB, '    if (!(Number.isSafeInteger(d.budget) && d.budget > 0)) {', '    if (false) {'),
      one(GB, '    if (!/^[1-9]\\d*$/.test(s)) invalid(', '    if (false) invalid(')]},
  // ---- an entry point that does not carry the policy to its points of spend ---------------------------------------------
  {id: 'P1', path: 'operate (scheduler.mjs)', what: 'the stage is not handed its billing context',
    edits: [one(SCH, 'claim, billing: stageBilling}); }', 'claim}); }')]},
  {id: 'P2', path: 'pantheon-board run', what: 'runOpenItem is not given the run\'s billing context',
    edits: [one(BOARD, 'runOpts: { seatOverrides, billing, ', 'runOpts: { seatOverrides, ')]},
  {id: 'P3', path: 'pantheon-compare', what: 'the comparison\'s runs are not given its billing context',
    edits: [one(CMP, 'dispatchRunner({ makeClientFor, dir: workDir, cycleTurn, n, runOpts: { billing } })', 'dispatchRunner({ makeClientFor, dir: workDir, cycleTurn, n })'),
      one(CMP, 'dispatchRunner({ makeClientFor, dir: workDir, runOpts: { billing } })', 'dispatchRunner({ makeClientFor, dir: workDir })')]},
  {id: 'P4', path: 'pantheon-review-cycle', what: 'the reviewer turn is not given the billing context',
    edits: [one(CYC, "  return apiTurn({label: 'cycle-review', billing});", "  return apiTurn({label: 'cycle-review'});")]},
  {id: 'P5', path: 'run-review --via api', what: 'the Gemini request is sent without the policy',
    edits: [one(RR, '    if (plan.vendor === "gemini") {\n      try { gemini = spendGemini(', '    if (false) {\n      try { gemini = spendGemini(')]},
  {id: 'P6', path: 'the pipeline\'s lane implementer (pipeline/turns.mjs), at the pipeline\'s turn', what: 'the implementer\'s failover is sent without the policy (only the pipeline\'s admission)',
    suites: [...SUITES, LANE_IMPLEMENTER],
    edits: [one(PIPE, '        spendGemini(billing, { kind: "failover", vendor: spare.vendor, model: spare.model, purpose: "implementer"',
      '        ((_b, _a, admit) => admit())(billing, { kind: "failover", vendor: spare.vendor, model: spare.model, purpose: "implementer"')]},
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
const runSuites = (dir, logFile, suites = SUITES) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=3', '--test-timeout=900000', ...suites], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `l136-billing-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'l136-billing-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  // The baseline is every suite a chosen mutation will be run against.
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), [...new Set(chosen.flatMap(m => m.suites ?? SUITES))]);
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
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), m.suites ?? SUITES);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
      summary.push({id: m.id, path: m.path, what: m.what, files: [...new Set(m.edits.map(e => e.file))], ...(m.suites ? {suites: m.suites} : {}), killed, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
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
