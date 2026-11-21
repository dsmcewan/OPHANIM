#!/usr/bin/env node
// MUTATION RUNNER for registers L-150 and L-151: every Gemini request of the python Antigravity SDK seat is authorized and
// charged before it is sent, through spendGemini, at the controller's model gateway (src/antigravity/gateway.mjs, opened
// for the seat by seat-session.mjs), which holds the real credential; the seat gets a scoped token and no key; agy-seat.py
// without one makes no request. Written against the L-150 metering relay; since the owner's decision of 2026-11-20
// (register L-724) the gateway is the one mechanism, and every mutation here is the same regression, made in the gateway
// or its seat session: the one charge per launch, a charge after the forward, the session cap ignored or counting
// answers, an unserved method or another model forwarded, any token accepted, the real key passed to the child, the seat
// running on a key without a capability, an admitted row refunded when its session dies, per-session counts, the run's
// provider-call bound charged once, Vertex let through, the seat's HOME kept, a refusal swallowed by the board or sent
// without its recovery, an upstream that is not Google or loopback accepted, the launcher's up-front check removed, the
// subagent's attribution lost, a refused charge answered with a status the harness retries -- on a DISPOSABLE COPY of
// this tree (never the tree itself); only the tests that decide it run there (`tests`: --test-name-pattern over
// pantheon/tests/l150-billing.test.mjs), and the mutation is undone.
//
//   node pantheon/tests/l150-billing.mutate.mjs [--only M1,M7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does not
// occur exactly once (2), when the unmutated file is not green (3), or when any mutation SURVIVES (1): its deciding tests
// stay green with it. The copy is made under --copy-root (default: the home directory). No mutation can reach a real
// provider: every upstream in the suite is a local fake, and a mutated seat falls back only to a loopback address.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITE = 'pantheon/tests/l150-billing.test.mjs';
const GW = 'pantheon/src/antigravity/gateway.mjs', SS = 'pantheon/src/antigravity/seat-session.mjs', ITEM = 'pantheon/src/board/run-item.mjs', CLI = 'pantheon/src/board/agy-cli.mjs';
const SEAT = 'pantheon/scripts/agy-seat.py', LAUNCH = 'pantheon/bin/agy-seat.mjs';
const one = (file, from, to) => ({file, from, to});
// The tests that decide each mutation (top-level test names, anchored).
const T = {relay3: '^gateway session, three requests', methods: '^gateway session, calls it does not serve', cap: '^gateway session token', sesscap: '^gateway session cap',
  conc: '^gateway sessions competing', bounds: '^gateway session bounds', direct: '^seat direct run', governed: '^seat governed run', search: '^seat web search',
  exhaust: '^seat exhaustion', procs: '^seat concurrency across processes', crash: '^seat crash cancel restart', board: '^board sdk seat: each request',
  bexh: '^board sdk seat exhaustion', seeded: '^board sdk seat seeded', bound: '^board sdk seat provider-call bound', vertex: '^board sdk seat vertex', life: '^gateway session idle and lifetime bounds'};
const CHARGE = 'subagents: { model: null, ceiling: 0, markers: {} }, admit: charge,';
const CAP = '    if (maxRequests !== null && admitted >= maxRequests) {';
const OPEN = '      const session = await openSeatSession({ apiKey: process.env.GEMINI_API_KEY,';

export const MUTATIONS = [
  // ---- per-request charging (owner items 1, 2, 10) ---------------------------------------------------------------------
  {id: 'M1', path: 'run-item SDK seat + gateway session', what: 'the one charge per launch restored: charged once at the spawn, the gateway forwarding uncharged', tests: [T.board, T.bexh],
    edits: [one(SS, CHARGE, 'subagents: { model: null, ceiling: 0, markers: {} }, admit: () => {},'),
      one(ITEM, OPEN, '      spendGemini(BILLING, spend, () => admit()); record();\n' + OPEN)]},
  {id: 'M2', path: 'gateway session', what: 'each request is charged after it was forwarded', tests: [T.relay3, T.governed],
    edits: [one(SS, CHARGE, 'subagents: { model: null, ceiling: 0, markers: {} }, admit: info => { setTimeout(() => { try { charge(info); } catch { /* charged late */ } }, 150); },')]},
  {id: 'M11', path: 'run-item SDK seat', what: 'the run\'s provider-call bound is charged once at the spawn, not per request', tests: [T.board, T.bound],
    edits: [one(ITEM, OPEN, '      admit();\n' + OPEN), one(ITEM, '        model, billing: BILLING, admit: () => admit(),', '        model, billing: BILLING, admit: () => {},')]},
  // ---- the session's own bound (owner items 3, 4) ----------------------------------------------------------------------
  {id: 'M20', path: 'gateway', what: 'the idle bound is ignored: a session idle past it still admits', tests: [T.life],
    edits: [one(GW, '    else if (idleMs !== null && now - last > idleMs) expired =', '    else if (false) expired =')]},
  {id: 'M21', path: 'gateway', what: 'the lifetime bound is ignored: an active session never expires', tests: [T.life],
    edits: [one(GW, '    if (lifetimeMs !== null && now - opened > lifetimeMs) expired =', '    if (false) expired =')]},
  {id: 'M3', path: 'gateway', what: 'the session\'s maximum request count is ignored', tests: [T.sesscap],
    edits: [one(GW, CAP, '    if (false) {')]},
  {id: 'M9', path: 'gateway', what: 'the session cap counts answered requests instead of admissions', tests: [T.sesscap],
    edits: [one(GW, CAP, '    if (maxRequests !== null && requests.filter(r => r.answered).length >= maxRequests) {')]},
  // ---- fail closed (owner item 9) --------------------------------------------------------------------------------------
  {id: 'M4', path: 'gateway', what: 'a method the gateway does not serve is forwarded instead of refused', tests: [T.methods],
    edits: [one(GW, '    if (req.method !== "POST" || !m || !verbs.has(m[2])) {', '    if (req.method !== "POST" || !m) {')]},
  {id: 'M16', path: 'gateway', what: 'an upstream that is neither a Google API host nor loopback is accepted (the real key sent anywhere)', tests: [T.cap],
    edits: [one(GW, '  if (!(loopback || google)) return', '  if (false) return')]},
  {id: 'M22', path: 'gateway', what: 'a model other than the seat\'s is served', tests: [T.methods],
    edits: [one(GW, '    if (!allowedModel(model)) {', '    if (false) {'), one(GW, '    if (!type && model !== root.model) {', '    if (false) {')]},
  // ---- the capability (D2, L-151) --------------------------------------------------------------------------------------
  {id: 'M5', path: 'gateway', what: 'the token check removed: a request without one rides the open session', tests: [T.cap],
    edits: [one(GW, '    if (got.length !== want.length || !timingSafeEqual(got, want)) {', '    if (false) {')]},
  {id: 'M6', path: 'agySdkEnvOf', what: 'the real GEMINI_API_KEY is passed to the SDK child', tests: [T.governed, T.board],
    edits: [one(CLI, '    if (!AGY_SDK_WITHHELD.includes(k) && workerEnvAllows(k, pass)) env[k] = v; else dropped.push(k);',
      '    if (k === "GEMINI_API_KEY" || (!AGY_SDK_WITHHELD.includes(k) && workerEnvAllows(k, pass))) env[k] = v; else dropped.push(k);')]},
  {id: 'M13', path: 'agySdkEnvOf', what: 'the child keeps the controller\'s HOME (its ADC file and logins in reach)', tests: [T.governed],
    edits: [one(CLI, '  if (typeof home === "string" && home) env.HOME = home;\n', '')]},
  {id: 'M7', path: 'agy-seat.py', what: 'agy-seat.py runs without a capability when a key is in its environment (a credential-based exception)', tests: [T.direct],
    edits: [one(SEAT, '  cap, refused = gateway_capability()\n',
      '  cap, refused = gateway_capability()\n  if refused is not None and os.environ.get("GEMINI_API_KEY"):\n    cap, refused = {"url": os.environ.get("GOOGLE_GEMINI_BASE_URL") or "http://127.0.0.1:9", "token": os.environ["GEMINI_API_KEY"]}, None\n')]},
  {id: 'M18', path: 'bin/agy-seat.mjs', what: 'the launcher spawns the seat without the policy\'s up-front check', tests: [T.crash],
    edits: [one(LAUNCH, 'try { geminiAdmission(billing, spend); }', 'try { /* no up-front check */ }')]},
  // ---- crash, cancellation and restart (owner item 7) ------------------------------------------------------------------
  {id: 'M8', path: 'gateway session', what: 'an admitted request is refunded (its row dropped) when its session dies before the answer', tests: [T.crash],
    edits: [one(SS, 'status: summary, fetchImpl, signal });',
      'status: summary, signal, fetchImpl: async (...a) => { try { return await fetchImpl(...a); } catch (e) { if (billing.ledger?.where) { const fs = process.getBuiltinModule("node:fs"), f = billing.ledger.where; '
      + 'const lines = fs.readFileSync(f, "utf8").split("\\n").filter(Boolean); lines.pop(); fs.writeFileSync(f, lines.map(l => l + "\\n").join("")); } throw e; } } });')]},
  // ---- concurrency (owner item 5) --------------------------------------------------------------------------------------
  {id: 'M10', path: 'gateway session', what: 'each session counts its own requests (a per-session ledger): concurrent sessions overspend', tests: [T.conc, T.procs],
    edits: [one(SS, '  let admitted = 0, root = null, closed = false;',
      '  let admitted = 0, root = null, closed = false;\n  billing = (rows => ({ ...billing, refusals: [], rows: [], ledger: { where: "per-session", used: k => rows.filter(r => r.kind === k).length, record: r => { rows.push(r); } } }))([]);')]},
  // ---- exhaustion and its record (owner items 6, 8) --------------------------------------------------------------------
  {id: 'M14', path: 'run-item SDK seat', what: 'the board drops the gateway session\'s billing refusal (the seat\'s exit is a plain error)', tests: [T.bexh],
    edits: [one(ITEM, '      if (refused) throw Object.assign(refused, { provider_requests: made });\n', '')]},
  {id: 'M15', path: 'gateway session', what: 'a refusal is sent without its recovery condition', tests: [T.relay3],
    edits: [one(SS, 'throw Object.assign(new Error(`${SEAT_REFUSED_MARK} ${code}: ${r.why} (recovery: ${r.recovery})`), { code });', 'throw Object.assign(new Error(`${SEAT_REFUSED_MARK} ${code}: ${r.why}`), { code });')]},
  {id: 'M19', path: 'gateway session', what: 'a subagent\'s request is not attributed to it (every conversation recorded as the root)', tests: [T.governed, T.board],
    edits: [one(SS, 'const conversation = sdk_session === null ? "unattributed" : sdk_session === root ? "root" : "subagent";', 'const conversation = sdk_session === null ? "unattributed" : "root";')]},
  {id: 'M23', path: 'gateway', what: 'a refused charge is answered with a status the SDK\'s harness retries (429): each retry asks the run\'s admission again', tests: [T.bound],
    edits: [one(GW, '      refuse(res, rec, 403, GATEWAY_REFUSALS.BUDGET, String(e?.message ?? e).slice(0, 900), "PERMISSION_DENIED");', '      refuse(res, rec, 429, GATEWAY_REFUSALS.BUDGET, String(e?.message ?? e).slice(0, 900), "RESOURCE_EXHAUSTED");')]},
  // ---- Vertex (D8) -----------------------------------------------------------------------------------------------------
  {id: 'M12', path: 'run-item SDK seat', what: 'Vertex through the SDK seat is not refused by the board', tests: [T.vertex],
    edits: [one(ITEM, '      if (process.env.PANTHEON_AGY_VERTEX_PROJECT) {', '      if (false) {')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
}
const runSuite = (dir, logFile, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), SUITE],
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
// Every edit must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `l150-billing-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'l150-billing-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuite(copy, path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
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
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, path: m.path, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  [${m.path}] ${m.what}`);
      for (const f of r.failed.slice(0, 4)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, suite: SUITE, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
