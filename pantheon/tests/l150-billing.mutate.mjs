#!/usr/bin/env node
// MUTATION RUNNER for registers L-150 and L-151: every Gemini request of the python Antigravity SDK seat is authorized and
// charged before it is sent, through spendGemini, at the controller's metering relay (src/route/gemini-relay.mjs), which
// holds the real credential; the seat gets a scoped capability and no key; agy-seat.py without one makes no request. Every
// mutation re-introduces a plausible regression -- the one charge per launch, a charge after the forward, the session cap
// ignored or counting outcomes, an unknown method forwarded, any capability accepted, the real key passed to the child,
// the seat running on a key without a capability, an admitted row refunded when its session dies, per-session counts, the
// run's provider-call bound charged once, Vertex let through, the seat's HOME kept, a refusal swallowed by the board or
// sent without its recovery, an upstream that is not Google or loopback accepted, the launcher's up-front check removed,
// the subagent's attribution lost -- on a DISPOSABLE COPY of this tree (never the tree itself); only the tests that decide
// it run there (`tests`: --test-name-pattern over pantheon/tests/l150-billing.test.mjs), and the mutation is undone.
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
const RELAY = 'pantheon/src/route/gemini-relay.mjs', ITEM = 'pantheon/src/board/run-item.mjs', CLI = 'pantheon/src/board/agy-cli.mjs';
const SEAT = 'pantheon/scripts/agy-seat.py', LAUNCH = 'pantheon/bin/agy-seat.mjs';
const one = (file, from, to) => ({file, from, to});
// The tests that decide each mutation (top-level test names, anchored).
const T = {relay3: '^relay three requests', methods: '^relay unsupported methods', cap: '^relay capability', sesscap: '^relay session cap',
  conc: '^relay concurrent', bounds: '^relay bounds', direct: '^seat direct run', governed: '^seat governed run', search: '^seat web search',
  exhaust: '^seat exhaustion', procs: '^seat concurrency across processes', crash: '^seat crash cancel restart', board: '^board sdk seat: each request',
  bexh: '^board sdk seat exhaustion', seeded: '^board sdk seat seeded', bound: '^board sdk seat provider-call bound', vertex: '^board sdk seat vertex'};
const CHARGE = '      if (m.billed && !charge()) return;\n';
const CAP = '        if (session.admitted >= session.maxRequests) {';
const OPEN = '      const session = relay.openSession({ billing: BILLING, admit: () => admit(),';

export const MUTATIONS = [
  // ---- per-request charging (owner items 1, 2, 10) ---------------------------------------------------------------------
  {id: 'M1', path: 'run-item SDK seat + relay', what: 'the one charge per launch restored: charged once at the spawn, the relay forwarding uncharged', tests: [T.board, T.bexh],
    edits: [one(RELAY, CHARGE, '      if (false && m.billed && !charge()) return;\n'),
      one(ITEM, '      const relay = await startGeminiRelay({ apiKey: process.env.GEMINI_API_KEY,', '      spendGemini(BILLING, spend, () => admit()); record();\n      const relay = await startGeminiRelay({ apiKey: process.env.GEMINI_API_KEY,')]},
  {id: 'M2', path: 'relay', what: 'each request is charged after it was forwarded', tests: [T.relay3, T.governed],
    edits: [one(RELAY, CHARGE, ''), one(RELAY, '      const tap = responseTap();', '      if (m.billed && !charge()) return;\n      const tap = responseTap();')]},
  {id: 'M11', path: 'run-item SDK seat', what: 'the run\'s provider-call bound is charged once at the spawn, not per request', tests: [T.board, T.bound],
    edits: [one(ITEM, OPEN, '      admit();\n      const session = relay.openSession({ billing: BILLING, admit: () => {},')]},
  // ---- the session's own bound (owner items 3, 4) ----------------------------------------------------------------------
  {id: 'M3', path: 'relay', what: 'the session\'s maximum request count is ignored', tests: [T.sesscap],
    edits: [one(RELAY, CAP, '        if (false) {')]},
  {id: 'M9', path: 'relay', what: 'the session cap counts completed outcomes instead of admissions', tests: [T.sesscap],
    edits: [one(RELAY, CAP, '        if (session.outcomes.filter(o => !o.refused && o.status === 200).length >= session.maxRequests) {')]},
  // ---- fail closed (owner item 9) --------------------------------------------------------------------------------------
  {id: 'M4', path: 'relay', what: 'an unknown method is forwarded (uncharged) instead of refused', tests: [T.methods],
    edits: [one(RELAY, '  if (!m || !Object.hasOwn(RELAY_METHODS, m[3])) return null;',
      '  if (!m) return null;\n  if (!Object.hasOwn(RELAY_METHODS, m[3])) return { version: m[1], model: m[2], name: m[3], billed: false, stream: false, sse: false };')]},
  {id: 'M16', path: 'relay', what: 'an upstream that is neither a Google API host nor loopback is accepted (the real key sent anywhere)', tests: [T.cap],
    edits: [one(RELAY, '  if (!(loopback || google) || u.username', '  if (false || u.username')]},
  // ---- the capability (D2, L-151) --------------------------------------------------------------------------------------
  {id: 'M5', path: 'relay', what: 'the capability check removed: a request without one rides the open session', tests: [T.cap],
    edits: [one(RELAY, '    const session = sessionOf(token);', '    const session = sessionOf(token) ?? [...sessions.values()][0] ?? null;')]},
  {id: 'M6', path: 'agySdkEnvOf', what: 'the real GEMINI_API_KEY is passed to the SDK child', tests: [T.governed, T.board],
    edits: [one(CLI, '    if (!AGY_SDK_WITHHELD.includes(k) && workerEnvAllows(k, pass)) env[k] = v; else dropped.push(k);',
      '    if (k === "GEMINI_API_KEY" || (!AGY_SDK_WITHHELD.includes(k) && workerEnvAllows(k, pass))) env[k] = v; else dropped.push(k);')]},
  {id: 'M13', path: 'agySdkEnvOf', what: 'the child keeps the controller\'s HOME (its ADC file and logins in reach)', tests: [T.governed],
    edits: [one(CLI, '  if (typeof home === "string" && home) env.HOME = home;\n', '')]},
  {id: 'M7', path: 'agy-seat.py', what: 'agy-seat.py runs without a capability when a key is in its environment (a credential-based exception)', tests: [T.direct],
    edits: [one(SEAT, '  cap, refused = relay_capability()\n',
      '  cap, refused = relay_capability()\n  if refused is not None and os.environ.get("GEMINI_API_KEY"):\n    cap, refused = {"url": os.environ.get("GOOGLE_GEMINI_BASE_URL") or "http://127.0.0.1:9", "token": os.environ["GEMINI_API_KEY"]}, None\n')]},
  {id: 'M18', path: 'bin/agy-seat.mjs', what: 'the launcher spawns the seat without the policy\'s up-front check', tests: [T.crash],
    edits: [one(LAUNCH, 'try { geminiAdmission(billing, spend); }', 'try { /* no up-front check */ }')]},
  // ---- crash, cancellation and restart (owner item 7) ------------------------------------------------------------------
  {id: 'M8', path: 'relay', what: 'an admitted request is refunded (its row dropped) when its session dies before the answer', tests: [T.crash],
    edits: [one(RELAY, '        outcome({ ...where, request_id, seq: n, method: m.name, model: m.model, billed: m.billed, status: "upstream_error",',
      '        if (row && session.billing.ledger?.where) { const fs = process.getBuiltinModule("node:fs"), f = session.billing.ledger.where; '
      + 'fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\\n").filter(l => l && !l.includes(request_id)).map(l => l + "\\n").join("")); }\n'
      + '        outcome({ ...where, request_id, seq: n, method: m.name, model: m.model, billed: m.billed, status: "upstream_error",')]},
  // ---- concurrency (owner item 5) --------------------------------------------------------------------------------------
  {id: 'M10', path: 'relay', what: 'each session counts its own requests (a per-session ledger): concurrent sessions overspend', tests: [T.conc, T.procs],
    edits: [one(RELAY, '      id, token, billing, admit, onAdmitted,',
      '      id, token, billing: (rows => ({ ...billing, refusals: [], rows: [], ledger: { where: "per-session", used: k => rows.filter(r => r.kind === k).length, record: r => { rows.push(r); } } }))([]), admit, onAdmitted,')]},
  // ---- exhaustion and its record (owner items 6, 8) --------------------------------------------------------------------
  {id: 'M14', path: 'run-item SDK seat', what: 'the board drops the relay\'s billing refusal (the seat\'s exit is a plain error)', tests: [T.bexh],
    edits: [one(ITEM, '      if (refused) throw Object.assign(refused, { provider_requests: made });\n', '')]},
  {id: 'M15', path: 'relay', what: 'a refusal is sent without its recovery condition', tests: [T.relay3],
    edits: [one(RELAY, '    const message = `${RELAY_MARK} ${code}: ${why} (recovery: ${recovery})`;', '    const message = `${RELAY_MARK} ${code}: ${why}`;'),
      one(RELAY, 'metadata: { recovery } }] } }));', 'metadata: {} }] } }));')]},
  {id: 'M19', path: 'relay', what: 'a subagent\'s request is not attributed to it (every conversation recorded as the root)', tests: [T.governed, T.board],
    edits: [one(RELAY, 'const conversation = sdk_session === null ? "unattributed" : sdk_session === session.root ? "root" : "subagent";', 'const conversation = sdk_session === null ? "unattributed" : "root";')]},
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
