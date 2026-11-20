#!/usr/bin/env node
// THE REAL-SDK PROOF OF REGISTER L-150 / L-151 (not a CI test: the CI runner has no SDK). It runs the REAL
// scripts/agy-seat.py with the REAL google-antigravity SDK (its bundled Go harness sends the requests) through the governed
// launcher bin/agy-seat.mjs and the board's SDK seat, against the model gateway, whose upstream is the LOCAL fake Gemini
// API of fixtures/l150-fake-gemini.mjs. NEVER a real provider: every credential is synthetic, the gateway's upstream is
// loopback, and the seat's HTTPS_PROXY is a local trap that records (and refuses) any request that would leave the host.
//
//   node pantheon/tests/fixtures/l150-real-sdk-proof.mjs --python <venv python with google-antigravity> --work <scratch dir>
//
// Prints one JSON report (each cell: what was asserted and what was seen) and exits 1 when any check fails.
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeGemini } from "./l150-fake-gemini.mjs";
import { seatAccounting, readSeatOutcomes } from "../../src/antigravity/seat-session.mjs";
import { billingFromFlags, geminiBilling, geminiUsageFile } from "../../src/route/gemini-billing.mjs";
import { runOpenItem } from "../../src/board/run-item.mjs";
import { withDispatch, seat } from "./dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAT_PY = resolve(HERE, "..", "..", "scripts", "agy-seat.py"), LAUNCHER = resolve(HERE, "..", "..", "bin", "agy-seat.mjs");
const argv = process.argv.slice(2), at = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const PY = resolve(at("--python") ?? ""), WORK = resolve(at("--work") ?? "");
if (!existsSync(PY) || !at("--work")) { console.error("usage: l150-real-sdk-proof.mjs --python <venv python> --work <dir>"); process.exit(2); }
const KEY = "AIza-l150-proof-synthetic-real-key-stand-in", GKEY = "AIza-l150-proof-synthetic-google-key";
const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 60_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(50); } };
const report = { python: PY, cells: [] };
let failed = 0;
function cell(name, checks, seen) {
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) failed++;
  report.cells.push({ name, ok: !bad.length, failed: bad, checks: Object.keys(checks), seen });
  console.error(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? `: ${bad.join("; ")}` : ""}`);
}
const chargedBefore = (edge, base = 0) => edge.every((r, i) => r.usage_rows >= base + i + 1);
const seedRows = (file, n) => { mkdirSync(dirname(file), { recursive: true }); for (let i = 0; i < n; i++) appendFileSync(file, JSON.stringify({ schema: "ophanim.gemini-billing/v1", kind: "primary",
  setting: "gemini_api_primary", vendor: "agy_google", model: "gemini-3.7-flash", purpose: "an earlier session", source: "proof seed", budget: 3, used_before: i, at: new Date().toISOString() }) + "\n"); };

// The trap: any request the seat would send off the host goes through its HTTPS_PROXY, recorded here and refused.
const trapped = [];
const trap = http.createServer((req, res) => { trapped.push({ kind: "http", url: req.url }); res.writeHead(403); res.end(); });
trap.on("connect", (req, sock) => { trapped.push({ kind: "connect", url: req.url }); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
await new Promise(r => trap.listen(0, "127.0.0.1", r));
const TRAP = `http://127.0.0.1:${trap.address().port}`;
const SEAT_NET = { HTTPS_PROXY: TRAP, HTTP_PROXY: TRAP, https_proxy: TRAP, http_proxy: TRAP, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };

function tree(name) {
  const dir = join(WORK, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, "ws"), { recursive: true });
  writeFileSync(join(dir, "ws", "README.md"), "# a workspace under review\n");
  writeFileSync(join(dir, "brief.txt"), "Review the README.");
  // The python, wrapped: its environment and pid are written down, then the REAL venv interpreter runs the REAL seat.
  writeFileSync(join(dir, "python"), `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, "pid"))}\nenv > ${JSON.stringify(join(dir, "env.txt"))}\nexec ${JSON.stringify(PY)} "$@"\n`, { mode: 0o755 });
  return { dir, ws: join(dir, "ws"), py: join(dir, "python") };
}
const envOf = dir => Object.fromEntries((existsSync(join(dir, "env.txt")) ? readFileSync(join(dir, "env.txt"), "utf8").split("\n") : []).map(l => /^([^=]*)=(.*)$/s.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
const args = (t, { role = "reviewer", out = join(t.dir, "out"), more = [] } = {}) => ["--role", role, "--workspace", t.ws, "--model", "gemini-3.7-flash", "--brief", join(t.dir, "brief.txt"), "--out", out, "--timeout", "120", ...more];
function launch(t, { budget, usage = join(t.dir, "usage.jsonl"), upstream, seatArgs, onSpawn = null }) {
  const child = spawn(process.execPath, [LAUNCHER, "--gemini-api-primary", String(budget), "--gemini-usage", usage, "--python", t.py, "--", ...seatArgs],
    { env: { PATH: process.env.PATH, HOME: t.dir, GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY, PANTHEON_AGY_GATEWAY_UPSTREAM: upstream, ...SEAT_NET }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
  onSpawn?.(child);
  return new Promise(r => child.on("close", (code, signal) => {
    const last = (text, f = () => true) => text.trim().split("\n").filter(l => l.startsWith("{")).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && f(o)).at(-1) ?? null;
    r({ code, signal, result: last(stdout), report: last(stderr, o => o.launcher === "agy-seat.mjs"), tail: stderr.slice(-1200) });
  }));
}
const edgeView = fake => fake.requests.map(q => ({ method: q.path.split(":").pop(), subagent: q.subagent, search: q.search, session: q.session, key_is_controllers: q.key === KEY, usage_rows: q.usage_rows }));

// P1 -- three requests with budget 3: exactly three admitted, the fourth refused (a review session needs five).
{
  const t = tree("p1-budget3"), usage = join(t.dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "review", workspace: t.ws, usage });
  const r = await launch(t, { budget: 3, upstream: fake.url, seatArgs: args(t) });
  cell("P1 three requests with budget 3: exactly three admitted, the fourth refused", {
    "exit 5 (ended on the gateway's refusal)": r.code === 5, "the provider saw exactly 3": fake.requests.length === 3, "each charged before it was sent": chargedBefore(fake.requests),
    "the refusal is METERED_GEMINI_BUDGET_EXHAUSTED": r.result?.refused?.code === "METERED_GEMINI_BUDGET_EXHAUSTED", "3 usage rows": jsonl(usage).length === 3,
    "partial output kept": existsSync(join(t.dir, "out", "response.partial.md")) || r.result?.refused?.partial_output_chars === 0,
  }, { edge: edgeView(fake), refused: r.result?.refused, error: r.result?.error?.slice(0, 600) });
  await fake.close();
}
// P2 -- a session able to make 40 requests, budget 3: never a fourth.
{
  const t = tree("p2-forty"), usage = join(t.dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "loop", workspace: t.ws, usage });
  const r = await launch(t, { budget: 3, upstream: fake.url, seatArgs: args(t, { more: ["--max-model-calls", "40"] }) });
  cell("P2 a session able to make 40 requests with budget 3 never sends a fourth", {
    "exit 5": r.code === 5, "the provider saw exactly 3": fake.requests.length === 3, "each charged before it was sent": chargedBefore(fake.requests),
    "refused for the budget": r.result?.refused?.code === "METERED_GEMINI_BUDGET_EXHAUSTED", "progress has turn.refused": jsonl(join(t.dir, "out", "progress.jsonl")).some(p => p.event === "turn.refused"),
  }, { edge: edgeView(fake), refused: r.result?.refused });
  await fake.close();
}
// P3 -- two concurrent sessions competing for the last request: exactly one.
{
  const t = tree("p3-concurrent"), usage = join(t.dir, "usage.jsonl");
  seedRows(usage, 2);
  const fake = await startFakeGemini({ mode: "text", workspace: t.ws, usage });
  const runs = await Promise.all(["a", "b"].map(n => { const sub = { ...tree(`p3-concurrent-${n}`) }; return launch(sub, { budget: 3, usage, upstream: fake.url, seatArgs: args(sub) }); }));
  cell("P3 two concurrent sessions competing for the last request: exactly one admitted", {
    "exits are one 0 and one 5": JSON.stringify(runs.map(x => x.code).sort()) === "[0,5]", "the provider saw exactly 1": fake.requests.length === 1, "3 usage rows": jsonl(usage).length === 3,
  }, { exits: runs.map(x => x.code), edge: edgeView(fake), refused: runs.map(x => x.result?.refused?.code ?? null) });
  await fake.close();
}
// P4 -- cancellation, crash and restart preserve the recorded spending.
{
  const t = tree("p4-crash"), usage = join(t.dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "hang", workspace: t.ws, usage });
  const inFlight = async (name, kill) => {
    const sub = tree(`p4-crash-${name}`), before = fake.requests.length;
    let launcher = null;
    const done = launch(sub, { budget: 3, usage, upstream: fake.url, seatArgs: args(sub), onSpawn: c => { launcher = c; } });
    await until(() => fake.requests.length === before + 1);
    kill({ launcher, seatPid: Number(readFileSync(join(sub.dir, "pid"), "utf8")) });
    return done;
  };
  const crash = await inFlight("seat-sigkill", ({ seatPid }) => process.kill(seatPid, "SIGKILL"));
  const afterCrash = jsonl(usage).length;
  const cancel = await inFlight("launcher-sigterm", ({ launcher }) => launcher.kill("SIGTERM"));
  const afterCancel = jsonl(usage).length;
  const killed = await inFlight("launcher-sigkill", ({ launcher, seatPid }) => { launcher.kill("SIGKILL"); try { process.kill(seatPid, "SIGKILL"); } catch { /* gone */ } });
  const rows = jsonl(usage), acc = seatAccounting({ usage: rows, outcomes: readSeatOutcomes(`${usage}.outcomes.jsonl`) });
  const before = fake.requests.length, rt = tree("p4-crash-restart");
  const restart = await launch(rt, { budget: 3, usage, upstream: fake.url, seatArgs: args(rt) });
  cell("P4 cancellation, crash (SIGKILL) and restart preserve the recorded spending", {
    "the crashed session's request stays counted": afterCrash === 1, "the cancelled session's request stays counted": afterCancel === 2, "the killed controller's request stays counted": rows.length === 3,
    "the killed controller's outcome is unknown": acc.rows.find(x => x.request_id === rows[2]?.identity?.request_id)?.outcome === "unknown",
    "the restart is refused up front (exit 2)": restart.code === 2 && restart.report?.refused?.code === "METERED_GEMINI_BUDGET_EXHAUSTED", "the restart sent nothing": fake.requests.length === before,
  }, { exits: { crash: crash.code ?? crash.signal, cancel: cancel.code ?? cancel.signal, cancel_stopped: cancel.report?.stopped, killed: killed.signal }, accounting: acc });
  await fake.close();
}
// P5 -- a direct run without a capability sends zero requests, keys present (pointed at the fake: a bypass would be seen) or not.
{
  const t = tree("p5-direct");
  const fake = await startFakeGemini({ mode: "review", workspace: t.ws });
  const runDirect = env => new Promise(r => { const c = spawn(t.py, [SEAT_PY, ...args(t)], { env: { PATH: process.env.PATH, HOME: t.dir, ...SEAT_NET, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", d => { out += d; }); c.on("close", code => r({ code, last: JSON.parse(out.trim().split("\n").pop() || "{}") })); });
  const withKeys = await runDirect({ GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY, GOOGLE_GEMINI_BASE_URL: fake.url });
  const without = await runDirect({ GOOGLE_GEMINI_BASE_URL: fake.url });
  cell("P5 direct agy-seat.py without authorization sends zero requests", {
    "keys present: exit 2, PANTHEON_GATEWAY_CAPABILITY_ABSENT": withKeys.code === 2 && withKeys.last?.refused?.code === "PANTHEON_GATEWAY_CAPABILITY_ABSENT",
    "no keys: exit 2, PANTHEON_GATEWAY_CAPABILITY_ABSENT": without.code === 2 && without.last?.refused?.code === "PANTHEON_GATEWAY_CAPABILITY_ABSENT", "the provider saw nothing": fake.requests.length === 0,
  }, { with_keys: withKeys.last?.refused, without: without.last?.refused, runtime: withKeys.last?.runtime?.sdk });
  await fake.close();
}
// P6 -- every billable method the SDK uses: streaming, a retry, continuations, a subagent's requests, the web search, compaction.
{
  const t = tree("p6-review"), usage = join(t.dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "review", failFirst: 1, workspace: t.ws, usage });
  const r = await launch(t, { budget: 20, upstream: fake.url, seatArgs: args(t) });
  const rows = jsonl(usage), env = envOf(t.dir);
  cell("P6a streaming, a retry, the tool-call continuations and a subagent's requests: every one charged before it was sent, attributed", {
    "exit 0": r.code === 0, "6 requests at the provider": fake.requests.length === 6, "every one charged before it was sent": chargedBefore(fake.requests), "6 usage rows": rows.length === 6,
    "all :streamGenerateContent?alt=sse": fake.requests.every(q => q.path.endsWith(":streamGenerateContent") && q.query === "alt=sse"),
    "the retry of the 503 is its own charged request": jsonl(`${usage}.outcomes.jsonl`)[0]?.status === 503,
    "a subagent request, attributed to its own session": rows.some(u => u.lineage.conversation === "subagent" && u.identity.sdk_session !== u.lineage.parent_session),
    "the provider saw the controller's key": fake.requests.every(q => q.key === KEY),
    "no key in the seat's environment": env.GEMINI_API_KEY === undefined && env.GOOGLE_API_KEY === undefined && !readFileSync(join(t.dir, "env.txt"), "utf8").includes(KEY),
    "the capability is in it": /^pantheon-gw-/.test(env.PANTHEON_AGY_GATEWAY_TOKEN ?? ""), "its HOME is the session's": env.HOME === join(t.dir, "out", "home"),
  }, { edge: edgeView(fake), lineage: rows.map(u => [u.request, u.identity.method, u.lineage.conversation]), env_names: Object.keys(env).filter(k => /KEY|RELAY|HOME|GOOGLE|GEMINI/.test(k)).sort() });
  await fake.close();
  const s = tree("p6-scout"), su = join(s.dir, "usage.jsonl");
  const sf = await startFakeGemini({ mode: "scout", workspace: s.ws, usage: su, final: "RAN: nothing" });
  const sr = await launch(s, { budget: 20, upstream: sf.url, seatArgs: args(s, { role: "scout" }) });
  cell("P6b the web search tool's :generateContent request is charged like any other", {
    "exit 0": sr.code === 0, "a :generateContent search at the provider": sf.requests.some(q => q.path.endsWith(":generateContent") && q.search), "every one charged before it was sent": chargedBefore(sf.requests),
    "rows = requests": jsonl(su).length === sf.requests.length,
  }, { edge: edgeView(sf), methods: jsonl(su).map(u => [u.identity.method, u.lineage.conversation]) });
  await sf.close();
  const c = tree("p6-compaction"), cu = join(c.dir, "usage.jsonl");
  const cf = await startFakeGemini({ mode: "loop", workspace: c.ws, usage: cu, promptTokens: 3_000_000 });
  const cr = await launch(c, { budget: 12, upstream: cf.url, seatArgs: args(c, { role: "scout", more: ["--max-model-calls", "12"] }) });
  cell("P6c the harness's own context summarization requests go through the gateway and are charged", {
    "every request at the provider was charged before it was sent": chargedBefore(cf.requests), "rows = requests": jsonl(cu).length === cf.requests.length,
    "the seat's error names the summarization (its requests were among those charged)": /summarization/.test(cr.result?.error ?? "") || cf.requests.length > 1,
  }, { exit: cr.code, requests: cf.requests.length, error: (cr.result?.error ?? "").slice(0, 400) });
  await cf.close();
}
// P7 -- the board's SDK seat (runOpenItem, PANTHEON_AGY_TRANSPORT=sdk) with the real SDK: charged per request, and exhaustion.
for (const budget of [100, 3]) {
  const t = tree(`p7-board-${budget}`), usage = join(t.dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "review", workspace: t.ws, usage });
  const vars = { PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: t.py, PANTHEON_AGY_GATEWAY_UPSTREAM: fake.url, GEMINI_API_KEY: KEY, ...SEAT_NET };
  let run = null;
  await withDispatch(async ({ spec, opts }) => {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      const r = await runOpenItem(spec(`l150-proof-${budget}`), { ...opts(), maxProviderCalls: 60, billing: geminiBilling({ policy: billingFromFlags({ "gemini-api-primary": String(budget) }), ledger: geminiUsageFile(usage) }),
        seatOverrides: { reviewer: seat("agy_google", "gemini-3.8-flash", { transport: "agy" }) } }).catch(e => ({ error: e }));
      run = r?.board && existsSync(join(r.board, "run.json")) ? JSON.parse(readFileSync(join(r.board, "run.json"), "utf8")) : { error: String(r?.error?.message ?? r?.error) };
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  const crit = (run?.attempts ?? []).filter(a => a.vendor === "agy_google" && a.purpose === "critique");
  const want = budget === 100 ? { n: 5, outcome: "ok" } : { n: 3, outcome: "refused_metered" };
  cell(`P7 the board's SDK seat with the real SDK, budget ${budget}`, {
    [`the provider saw ${want.n}`]: fake.requests.length === want.n, "each charged before it was sent": chargedBefore(fake.requests),
    [`the critique attempt: ${want.outcome}, ${want.n} provider requests`]: crit.length === 1 && crit[0].outcome === want.outcome && crit[0].provider_requests === want.n,
    "usage rows = requests": jsonl(usage).length === want.n,
  }, { attempts: crit.map(a => ({ outcome: a.outcome, code: a.code, provider_requests: a.provider_requests })), edge: edgeView(fake), error: run?.error ?? null });
  await fake.close();
}
cell("no request left the host (the seat's HTTPS_PROXY trap saw nothing)", { "the trap is empty": trapped.length === 0 }, { trapped });
await new Promise(r => trap.close(r));
report.ok = failed === 0;
console.log(JSON.stringify(report, null, 1));
process.exit(failed ? 1 : 0);
