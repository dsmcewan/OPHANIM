#!/usr/bin/env node
// MUTATION RUNNER for register L-148: bin/pantheon-view.mjs (the live view server) and its launchers scripts/swarm-run.mjs
// and discuss-run.mjs under the one L-136/L-146 Gemini billing contract, through the shared helper (sdk/live.mjs
// operatorGemini) at the server's provider-call boundary, with the record's count-and-append atomic across processes
// (route/gemini-billing.mjs geminiUsageFile). Every mutation re-introduces a plausible regression -- the server's gate
// removed, authorization left to a launcher, a body field or the failover flag honoured, a charge after the send, a count
// read before an await, the record's lock or its re-derivation removed, a stale lock never cleared, the record moved per
// process, the history or the record re-enabling Gemini, a refusal without its code or recovery, a non-Gemini seat
// refused -- on a DISPOSABLE COPY of this tree (never the tree itself); only the tests that decide it run there (`tests`:
// --test-name-pattern over pantheon/tests/l148-billing.test.mjs), and the mutation is undone.
//
//   node pantheon/tests/l148-billing.mutate.mjs [--only V1,V7] [--log DIR] [--copy-root DIR] [--run-bound-ms N] [--check]
//   (a run of the suites that does not end within --run-bound-ms, 20 minutes unless given, is killed and reported as HUNG: exit 4)
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not
// occur exactly once (2), when the unmutated file is not green (3), or when any mutation SURVIVES (1): its deciding tests
// stay green with it. The copy is made under --copy-root (default: the home directory).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITE = 'pantheon/tests/l148-billing.test.mjs';
const VIEW = 'pantheon/bin/pantheon-view.mjs', SERVER = 'pantheon/src/view/server.mjs', LIVE = 'pantheon/src/sdk/live.mjs', GB = 'pantheon/src/route/gemini-billing.mjs';
const SWARM = 'pantheon/scripts/swarm-run.mjs', DISCUSS = 'pantheon/scripts/discuss-run.mjs';
const one = (file, from, to) => ({file, from, to});
// The tests that decide each mutation: the parent test of each group (its cells are its subtests).
const T = {off: '^view off', declared: '^view declared', one: '^view one process', two: '^view two processes', stale: '^view stale lock',
  restart: '^view restart', client: '^view client fields', launch: '^launchers'};
const GATED = '  gemini.clientFor(vendor, { model, purpose: `pantheon-view ${purpose}`, role: label });';
const RAW = '  makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic });';
const WRAP = '      models[m] = async (req, ...more) => { spendGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); return send(req, ...more); };';
const REDERIVE = '        if (GEMINI_KINDS.includes(kind) && Number.isSafeInteger(budget) && budget > 0) {';
const POLICY = '    billing = geminiBilling({ policy: parsed.policy, ledger: file ? geminiUsageFile(file) : null });';
const reEnabledBy = file => `    billing = geminiBilling({ policy: dir && !enabled.length && process.getBuiltinModule("node:fs").existsSync(join(dir, "${file}")) `
  + '? billingFlagsFromArgv(["--gemini-api-primary", "1000"]).policy : parsed.policy, ledger: file ? geminiUsageFile(file) : null });';

export const MUTATIONS = [
  // ---- the boundary: the server's own factory (owner items 1, 2, 5) ------------------------------------------------------
  {id: 'V1', path: 'pantheon-view', what: 'the server\'s client factory is back to makeClient: the gate removed', tests: [T.off, T.launch],
    edits: [one(VIEW, GATED, RAW)]},
  {id: 'V2', path: 'pantheon-view + launchers', what: 'authorization only in the launchers: the server ungated, the launchers refuse their own Gemini seat', tests: [T.off],
    edits: [one(VIEW, GATED, RAW),
      one(SWARM, '  const s = spec[seat];', '  const s = spec[seat]; if (s.vendor === "agy_google") return { ok: false, why: "GEMINI_PRIMARY_DISABLED: refused by the launcher", ms: 0 };'),
      one(DISCUSS, '  const s = SEATS[seat];', '  const s = SEATS[seat]; if (s.vendor === "agy_google") return { ok: false, why: "GEMINI_PRIMARY_DISABLED: refused by the launcher", ms: 0 };')]},
  {id: 'V20', path: 'the gated factory', what: 'the client is made (the key read) before the policy is checked: a no-key server fails by the key, not the policy', tests: [T.off],
    edits: [one(LIVE, '    geminiAdmission(billing, spend);\n    const real = client(vendor);', '    const real = client(vendor);\n    geminiAdmission(billing, spend);')]},
  // ---- authorization (owner items 3, 4, 8) -------------------------------------------------------------------------------
  {id: 'V3', path: 'server.mjs + pantheon-view', what: 'a POST /turn body field is honoured as authorization (an ungated client for it)', tests: [T.client],
    edits: [one(SERVER, '          vendor: v, purpose: purpose ?? "view", prompt,', '          vendor: v, purpose: purpose ?? "view", prompt, grant: parsed.gemini_api_primary ?? parsed.budget,'),
      one(SERVER, 'async function runTurn({ vendor, purpose = "view", prompt, model, label, reseat = false }) {', 'async function runTurn({ vendor, purpose = "view", prompt, model, label, reseat = false, grant }) {'),
      one(SERVER, 'purpose, label: label ?? null });', 'purpose, label: label ?? null, grant });'),
      one(VIEW, 'const makeClientFor = (vendor, { model = null, purpose = "view", label = null } = {}) =>\n', 'const makeClientFor = (vendor, { model = null, purpose = "view", label = null, grant } = {}) => grant ? makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }) :\n')]},
  {id: 'V4', path: 'the flag resolution', what: '--metered-gemini-failover N authorizes primary calls', tests: [T.off],
    edits: [one(GB, 'return { argv: rest, policy: billingFromFlags(flags),', 'return { argv: rest, policy: billingFromFlags({ "gemini-api-primary": flags["metered-gemini-failover"], ...flags }),')]},
  {id: 'V13', path: 'operatorGemini', what: 'the run history re-enables Gemini: a start with no flag reuses an earlier authorization', tests: [T.restart],
    edits: [one(LIVE, POLICY, reEnabledBy('gemini-billing-runs.jsonl'))]},
  {id: 'V14', path: 'operatorGemini', what: 'the persisted usage record re-enables Gemini: a start with no flag is on once anything was charged', tests: [T.restart],
    edits: [one(LIVE, POLICY, reEnabledBy('gemini-billing.jsonl'))]},
  {id: 'V19', path: 'operatorGemini', what: '--gemini-usage is accepted beside the server\'s own record', tests: [T.off],
    edits: [one(LIVE, '    if (dir && parsed.usage !== null) throw invalidScript(', '    if (false) throw invalidScript(')]},
  // ---- pre-send charging (owner item 5) ----------------------------------------------------------------------------------
  {id: 'V5', path: 'the gated client', what: 'each request is charged after it has been sent', tests: [T.declared],
    edits: [one(LIVE, WRAP, '      models[m] = async (req, ...more) => { const out = await send(req, ...more); spendGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); return out; };')]},
  // ---- concurrency (owner item 6) ----------------------------------------------------------------------------------------
  {id: 'V6', path: 'the gated client + the record', what: 'the count is read before an await and the record trusts it (an in-process overrun)', tests: [T.one],
    edits: [one(LIVE, WRAP, '      models[m] = async (req, ...more) => { const row = admitGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); '
      + 'await new Promise(r => setTimeout(r, 200)); billing.ledger.record(row); billing.rows.push(row); return send(req, ...more); };'),
    one(GB, REDERIVE, '        if (false) {')]},
  {id: 'V7', path: 'geminiUsageFile', what: 'the record\'s lock removed: two processes count and append unlocked', tests: [T.two],
    edits: [one(GB, '      withRecordLock(file, () => {', '      (fn => fn())(() => {')]},
  {id: 'V8', path: 'geminiUsageFile', what: 'the count is not re-derived under the lock: the admission\'s count is trusted', tests: [T.two],
    edits: [one(GB, REDERIVE, '        if (false) {')]},
  {id: 'V9', path: 'geminiUsageFile', what: 'a stale lock is never cleared: any lock, a dead holder\'s included, is waited on', tests: [T.stale],
    edits: [one(GB, '!seatLock.takeClaim(lock);', '!(existsSync(lock) ? false : seatLock.takeClaim(lock));')]},
  // ---- restarts (owner item 7) -------------------------------------------------------------------------------------------
  {id: 'V10', path: 'pantheon-view', what: 'the record in a per-process location: a restart resets the allowance', tests: [T.restart],
    edits: [one(VIEW, 'runDir: () => join(home, "view"),', 'runDir: () => join(home, "view", String(process.pid)),')]},
  {id: 'V18', path: 'operatorGemini (serve)', what: 'SIGTERM ends the server without its exit record', tests: [T.off, T.restart],
    edits: [one(LIVE, '    for (const [signal, n] of [["SIGINT", 2], ["SIGTERM", 15]]) process.once(signal, () => process.exit(128 + n));\n', '')]},
  // ---- refusals and recovery (owner items 9, 10) -------------------------------------------------------------------------
  {id: 'V11', path: 'server.mjs runTurn', what: 'the refusal is published without its code or recovery condition', tests: [T.off, T.launch],
    edits: [one(SERVER, '      const refusal = billingRefusal(err);', '      const refusal = null;')]},
  {id: 'V12', path: 'the gated factory', what: 'a non-Gemini seat is refused when Gemini is off', tests: [T.off, T.launch],
    edits: [one(LIVE, '    if (!isMeteredGemini({ vendor, transport: "api" })) return client(vendor);', '    if (!isMeteredGemini({ vendor, transport: "api" }) && billing.policy.gemini_api_primary.enabled) return client(vendor);')]},
  {id: 'V17', path: 'operatorGemini (serve)', what: 'a refusal is not journaled when it is made (only at exit)', tests: [T.off, T.declared],
    edits: [one(LIVE, '    if (serve) history({ event: "refusal",', '    if (false) history({ event: "refusal",')]},
  // ---- the launchers hold no authority (owner items 5, 8; design D1, D5) -------------------------------------------------
  {id: 'V15', path: 'swarm-run, discuss-run', what: 'a billing flag given to a launcher is accepted', tests: [T.launch],
    edits: [one(SWARM, 'if (billingFlag) {', 'if (false) {'), one(DISCUSS, 'if (billingFlag) {', 'if (false) {')]},
  {id: 'V16', path: 'swarm-run, discuss-run', what: 'a refused seat is recorded without its code and recovery condition', tests: [T.launch],
    edits: [one(SWARM, '  if (!ok) return { ok: false, why: refusedSeat(seat, layer, r?.results?.[0]), ms };', '  if (!ok) return { ok: false, why: r?.results?.[0]?.why ?? "failed", ms };'),
      one(DISCUSS, '  if (!ok) return { ok: false, why: refusedSeat(seat, round, r?.results?.[0]), ms: Date.now() - t0 };', '  if (!ok) return { ok: false, why: r?.results?.[0]?.why ?? "failed", ms: Date.now() - t0 };')]},
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `l148-billing-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'l148-billing-mutate-'));
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
