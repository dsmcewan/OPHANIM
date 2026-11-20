#!/usr/bin/env node
// MUTATION RUNNER for register L-146: the five operator paths (bin/cross-lab-review.mjs, scripts/live-check, live-ship,
// stream-check, view-check) under the one L-136 Gemini billing policy, through ONE helper (sdk/live.mjs operatorGemini;
// billedTurnModule for the HTTPS module). Every mutation re-introduces a plausible regression -- a script's gate removed,
// the HTTPS module's lane-named seat passed through unbilled again, the failover flag authorizing a primary call, a key
// conferring permission, a charge made after the send, only a turn's first request charged, the budget not counted, the
// policy checked after the credential, an enabled kind accepted without its usage record, a refusal kept as a failed or
// empty review, the record not printed -- on a DISPOSABLE COPY of this tree (never the tree itself); only the tests that
// decide it run there (`tests`: --test-name-pattern over pantheon/tests/l146-billing.test.mjs), and the mutation is undone.
//
//   node pantheon/tests/l146-billing.mutate.mjs [--only G1,P1] [--log DIR] [--copy-root DIR] [--run-bound-ms N] [--check]
//   (a run of the suites that does not end within --run-bound-ms, 20 minutes unless given, is killed and reported as HUNG: exit 4)
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not
// occur exactly once (2), when the unmutated file is not green (3), or when any mutation SURVIVES (1): its deciding tests
// stay green with it. The copy is made under --copy-root (default: the home directory). live-ship's tests need bwrap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITE = 'pantheon/tests/l146-billing.test.mjs';
const LIVE = 'pantheon/src/sdk/live.mjs', GB = 'pantheon/src/route/gemini-billing.mjs', HTTP = 'pantheon/bin/cycle-review-http-turn.mjs';
const XLAB = 'pantheon/bin/cross-lab-review.mjs', CHECK = 'pantheon/scripts/live-check.mjs', STREAM = 'pantheon/scripts/stream-check.mjs';
const VIEW = 'pantheon/scripts/view-check.mjs', SHIP = 'pantheon/scripts/live-ship.mjs';
const one = (file, from, to) => ({file, from, to});
// The tests that decide each mutation: the parent test of each path (its cells are its subtests).
const T = {check: '^live-check', stream: '^stream-check', view: '^view-check', ship: '^live-ship', xlab: '^cross-lab-review', cycle: '^pantheon-review-cycle'};
const SDK = [T.check, T.stream, T.view, T.ship], ALL = [...SDK, T.xlab];
const RAW = 'makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic })';
const WRAP = '      models[m] = async (req, ...more) => { spendGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); return send(req, ...more); };';

export const MUTATIONS = [
  // ---- each script's gate removed (owner items 1 and 6) -----------------------------------------------------------------
  {id: 'G1', path: 'cross-lab-review', what: 'the HTTPS module is called directly, without billedTurnModule', tests: [T.xlab],
    edits: [one(XLAB, "const review = billedTurnModule(turn, gemini.billing, {purpose: 'cross-lab review'});", 'const review = turn;')]},
  {id: 'G2', path: 'live-check', what: 'the client is made directly, without the gated factory', tests: [T.check],
    edits: [one(CHECK, '  const client = gemini.clientFor(vendor, { model, purpose: "live-check" });', `  const client = ${RAW};`)]},
  {id: 'G3', path: 'stream-check', what: 'the client is made directly, without the gated factory', tests: [T.stream],
    edits: [one(STREAM, '  const client = gemini.clientFor(vendor, { model, purpose: "stream-check" });', `  const client = ${RAW};`)]},
  {id: 'G4', path: 'view-check', what: 'the view server is given the ungated factory', tests: [T.view],
    edits: [one(VIEW, 'const makeClientFor = v => gemini.clientFor(v, { model: models[v] ?? ADAPTERS[v]?.default_model ?? null, purpose: "view-check" });',
      'const makeClientFor = v => makeClient(v, { OpenAI, GoogleGenAI, Anthropic });')]},
  {id: 'G5', path: 'live-ship', what: 'each turn\'s client is made directly, without the gated factory', tests: [T.ship],
    edits: [one(SHIP, 'client: gemini.clientFor(vendor, { model, purpose }), home });', `client: ${RAW}, home });`)]},
  // ---- the coordinator's finding: a lane-named seat of the HTTPS module passed through as a subscription lane -------------
  {id: 'L1', path: 'billedTurnModule (cross-lab-review, review-cycle --turn)', what: 'the module\'s declaration is ignored: a lane-named seat passes through unbilled', tests: [T.xlab, T.cycle],
    edits: [one(LIVE, '(metered || seatTransport(args.vendor, args.model) !== "agy-cli")', '(seatTransport(args.vendor, args.model) !== "agy-cli")')]},
  {id: 'L2', path: 'cycle-review-http-turn.mjs', what: 'the module no longer declares its Gemini calls metered', tests: [T.xlab, T.cycle],
    edits: [one(HTTP, 'turn.meteredGeminiApi = true;', '')]},
  // ---- authorization: the failover switch, a key, the default (owner items 1, 2, 3) -------------------------------------
  {id: 'X1', path: 'the scripts\' flag resolution', what: '--metered-gemini-failover N authorizes primary calls', tests: ALL,
    edits: [one(GB, 'return { argv: rest, policy: billingFromFlags(flags),', 'return { argv: rest, policy: billingFromFlags({ "gemini-api-primary": flags["metered-gemini-failover"], ...flags }),')]},
  {id: 'K1', path: 'the gated factory (SDK scripts)', what: 'a GEMINI_API_KEY in the environment hands out the ungated client', tests: SDK,
    edits: [one(LIVE, '    if (!isMeteredGemini({ vendor, transport: "api" })) return client(vendor);', '    if (!isMeteredGemini({ vendor, transport: "api" }) || process.env.GEMINI_API_KEY) return client(vendor);')]},
  {id: 'D1', path: 'the scripts\' flag resolution', what: 'no flag resolves to primary enabled', tests: ALL,
    edits: [one(GB, 'return { argv: rest, policy: billingFromFlags(flags),', 'return { argv: rest, policy: billingFromFlags({ "gemini-api-primary": "1000000", ...flags }),')]},
  // ---- pre-send charging (owner item 5) ---------------------------------------------------------------------------------
  {id: 'C1', path: 'the gated client (SDK scripts)', what: 'each request is charged after it has been sent', tests: SDK,
    edits: [one(LIVE, WRAP, '      models[m] = async (req, ...more) => { const out = await send(req, ...more); spendGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); return out; };')]},
  {id: 'C2', path: 'billedTurnModule (cross-lab-review, review-cycle --turn)', what: 'the call is charged after the module has sent it', tests: [T.xlab, T.cycle],
    edits: [one(LIVE, '      spendGemini(bill, { kind: "primary", vendor: args.vendor, model: args.model, purpose, role: args.seat?.role ?? null, transport: "api" });\n    }\n    return turn({ ...args, ...(bill ? { billing: bill } : {}) });',
      '      const out = await turn({ ...args, ...(bill ? { billing: bill } : {}) });\n      spendGemini(bill, { kind: "primary", vendor: args.vendor, model: args.model, purpose, role: args.seat?.role ?? null, transport: "api" });\n      return out;\n    }\n    return turn({ ...args, ...(bill ? { billing: bill } : {}) });')]},
  {id: 'O1', path: 'the gated client (SDK scripts)', what: 'only the first request through a client is charged: a hop, a retry, a later request go uncharged', tests: SDK,
    edits: [one(LIVE, WRAP, '      models[m] = async (req, ...more) => { if (++request === 1) spendGemini(billing, { ...spend, model: req?.model ?? model, request }); return send(req, ...more); };')]},
  // ---- budgets (owner items 4 and 7) ------------------------------------------------------------------------------------
  {id: 'B1', path: 'the scripts\' usage record', what: 'the budget is not enforced: consumption is never counted', tests: ALL,
    edits: [one(LIVE, '    billing = geminiBilling({ policy: parsed.policy, ledger: file ? geminiUsageFile(file) : null });',
      '    billing = geminiBilling({ policy: parsed.policy, ledger: file ? { ...geminiUsageFile(file), used: () => 0 } : null });')]},
  {id: 'U1', path: 'live-check, stream-check, view-check', what: 'enabling without --gemini-usage is accepted (a silent default record in the working directory)', tests: [T.check, T.stream, T.view],
    edits: [one(LIVE, '    const file = dir ? join(dir, "gemini-billing.jsonl") : parsed.usage !== null ? resolve(parsed.usage) : null;',
      '    const file = dir ? join(dir, "gemini-billing.jsonl") : parsed.usage !== null ? resolve(parsed.usage) : resolve("gemini-billing.jsonl");')]},
  // ---- the policy before the credential ---------------------------------------------------------------------------------
  {id: 'P1', path: 'the gated factory (SDK scripts)', what: 'the client is made (the key read) before the policy is checked: a no-key run fails by the key, not the policy', tests: SDK,
    edits: [one(LIVE, '    geminiAdmission(billing, spend);\n    const real = client(vendor);', '    const real = client(vendor);\n    geminiAdmission(billing, spend);')]},
  // ---- fail closed, keeping the evidence (owner item 7) and the record (owner item 5) -----------------------------------
  {id: 'E1', path: 'cross-lab-review', what: 'a refused seat is reported as a failed seat: no refusal record is kept', tests: [T.xlab],
    edits: [one(XLAB, '    if (!isGeminiBillingRefusal(e)) {', '    if (true) {')]},
  {id: 'E2', path: 'cross-lab-review', what: 'a refused seat is written as an empty review', tests: [T.xlab],
    edits: [one(XLAB, '    writeFileSync(refused, JSON.stringify(', "    writeFileSync(join(D, `review-${vendor}.md`), ''); if (0) writeFileSync(refused, JSON.stringify(")]},
  {id: 'R1', path: 'every script', what: 'the billing record (rows, refusals) is not printed or kept', tests: ALL,
    edits: [one(LIVE, '    console.log(`gemini_billing ${JSON.stringify(rec)}`);\n    if (dir) {', '    if (false) {')]},
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
}
/** The longest ONE run of the suites may take (--run-bound-ms). A run that does not end is not a result: it is HUNG. */
const RUN_BOUND_MS = 20 * 60_000;
const bound = Number(arg('--run-bound-ms', RUN_BOUND_MS));
if (!Number.isInteger(bound) || bound < 1) { console.error('--run-bound-ms is a positive whole number of milliseconds'); process.exit(2); }
/** After a run that was cut: kill what it left working in the copy (best effort; found through /proc, so on Linux). */
const reap = dir => {
  let n = 0;
  try {
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      let cwd; try { cwd = fs.readlinkSync(`/proc/${p}/cwd`); } catch { continue; }
      if (cwd === dir || cwd.startsWith(dir + path.sep)) { try { process.kill(Number(p), 'SIGKILL'); n += 1; } catch { /* gone */ } }
    }
  } catch { /* no /proc here */ }
  return n;
};
// A test that fails and leaves a listener or a child behind keeps `node --test` from ending. That is a defect of the
// TEST (the same hang would hold up CI on a real regression), and it is reported as one, not waited for forever.
const bounded = (dir, r) => {
  const hung = r.error?.code === 'ETIMEDOUT';
  const reaped = hung ? reap(dir) : 0;
  return {hung, out: `${r.stdout ?? ''}${r.stderr ?? ''}${hung ? `\n[runner] the run did not end within ${bound} ms and was killed; ${reaped} process(es) left in the copy were killed too\n` : ''}`};
};
// KILLED means a test FAILED. A run that only timed a test out, or ended without a count, went red too, and says so; a
// run that did not end is not a result at all.
const outcomeOf = (r, red) => r.hung ? 'hung' : !red ? 'survived' : r.fail > 0 ? 'killed' : r.cancelled > 0 ? 'killed-by-timeout' : 'killed-no-count';
const LABEL = {killed: 'KILLED  ', survived: 'SURVIVED', hung: 'HUNG    ', 'killed-by-timeout': 'KILLED (a test timed out; none failed)', 'killed-no-count': 'KILLED (the run ended without a count)'};
const tally = summary => { const n = k => summary.filter(x => x.outcome === k).length;
  return `${n('killed-by-timeout') + n('killed-no-count') ? ` (${n('killed-by-timeout')} by a timeout only, ${n('killed-no-count')} without a count)` : ''}${n('hung') ? `, ${n('hung')} HUNG` : ''}`; };
const runSuite = (dir, logFile, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), SUITE],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}, timeout: bound, killSignal: 'SIGKILL'});
  const {hung, out} = bounded(dir, r);
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, hung, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `l146-billing-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'l146-billing-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuite(copy, path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped${baseline.hung ? `; DID NOT END within ${bound} ms` : ''}`);
  if (baseline.hung || baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated tests are not green: no mutation result would mean anything');
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
      const r = runSuite(copy, path.join(logDir, `${m.id}.log`), m.tests);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = !r.hung && r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      const outcome = outcomeOf(r, killed);
      summary.push({id: m.id, path: m.path, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, outcome, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${LABEL[outcome]} ${r.pass}/${r.tests} pass, ${r.fail} fail  [${m.path}] ${m.what}`);
      for (const f of r.failed.slice(0, 4)) console.log(`    ${f.slice(0, 200)}`);
      if (r.hung) { console.log(`    the suites did not end within ${bound} ms: a test that fails here leaves something running (a listener, a child); fix the test`); exit = Math.max(exit, 4); }
      else if (!killed) exit = Math.max(exit, 1);
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, suite: SUITE, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed${tally(summary)}; logs: ${logDir}`);
process.exit(exit);
