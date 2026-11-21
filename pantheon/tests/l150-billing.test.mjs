// REGISTER L-150 and L-151 (owner decisions 2026-11-20): EVERY Gemini request made inside the python Antigravity SDK seat
// is authorized and charged BEFORE it is sent, through the central billing policy (route/gemini-billing.mjs spendGemini),
// by the controller's loopback model gateway (antigravity/gateway.mjs, opened for the seat by seat-session.mjs: the ONE
// mechanism since the owner's decision of 2026-11-20, register L-724), which alone holds the real credential; a launch is
// not a request; and a direct run of scripts/agy-seat.py without the controller's capability makes no request at all.
//
// THE PROVIDER EDGE ONLY IS FAKE. Upstream of the gateway is always a LOCAL fake Gemini API (fixtures/l150-fake-gemini.mjs)
// that records every request with the number of usage rows ALREADY PERSISTED when it arrived ("charged before it is sent",
// asserted at the edge itself). The SDK is the stub of fixtures/l150-sdk-stub on PYTHONPATH (the CI runner has no SDK):
// it sends the SAME HTTP requests the real google-antigravity 0.1.24 harness was observed to send (the real-SDK proof of
// L-150) -- :streamGenerateContent?alt=sse for every model call, a 503 retried, a tool-call continuation, a subagent's own
// conversation (its own sessionId), the web search's :generateContent -- to the gateway, the session's token as its key.
// Every key here is SYNTHETIC. Driven through the production entry points: the seat's gateway session, scripts/agy-seat.py (directly, and
// through the governed launcher bin/agy-seat.mjs), and runOpenItem's SDK seat (PANTHEON_AGY_TRANSPORT=sdk).
//
// These cells were written against the L-150 metering relay (route/gemini-relay.mjs) and are kept, each one, against the
// gateway that replaced it: what the relay had to show, the gateway shows here.
//
// THE SEAT'S JAIL (knowledge graphs, Slice C2; register L-155): both spawn points now run the seat inside its bwrap jail
// (src/agy/sandbox.mjs sdkSeatJail), so the cells that spawn it through the launcher or the board are real-bwrap cells
// (`jailed`: skipped, and reported UNVERIFIED by the test gate, where bwrap does not work), and the stub writes what it
// records (its environment, a spawn marker) into its out dir, the only place outside the workspace the jail lets it write.
// A jailed seat's pid is its PID namespace's; the crash cell finds the seat's host pid from outside (seatPidOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { billingFromFlags, geminiBilling, geminiUsageFile } from "../src/route/gemini-billing.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { withDispatch, seat } from "./fixtures/dispatch.mjs";
import { startFakeGemini } from "./fixtures/l150-fake-gemini.mjs";

const have = await sandboxAvailable("bwrap");
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "fixtures", "l150-sdk-stub");
const SEAT_PY = join(HERE, "..", "scripts", "agy-seat.py");
const LAUNCHER = join(HERE, "..", "bin", "agy-seat.mjs");
const seatSession = () => import("../src/antigravity/seat-session.mjs");
const BUDGET = "METERED_GEMINI_BUDGET_EXHAUSTED", CAP_ABSENT = "PANTHEON_GATEWAY_CAPABILITY_ABSENT", NO_CAP = "PANTHEON_GATEWAY_UNAUTHORIZED",
  METHOD = "PANTHEON_PATH_NOT_SERVED", SESSION_CAP = "PANTHEON_SESSION_CAP", VERTEX = "PANTHEON_GATEWAY_VERTEX_UNSUPPORTED";
const KEY = "AIza-l150-synthetic-real-key-stand-in-0000", GKEY = "AIza-l150-synthetic-google-key-1111";
const STREAM = "/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse";
const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 20_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(25); } };
/** Each billed request at the edge was preceded by its own persisted usage row: billed request k saw at least `base + k` rows. */
const chargedBefore = (edge, base = 0) => edge.forEach((r, i) => assert.ok(r.usage_rows >= base + i + 1, `request ${i + 1} reached the provider with only ${r.usage_rows} usage row(s) persisted: it was not charged before it was sent`));
const seedRows = (file, n) => { mkdirSync(dirname(file), { recursive: true }); for (let i = 0; i < n; i++) appendFileSync(file, JSON.stringify({ schema: "ophanim.gemini-billing/v1", kind: "primary",
  setting: "gemini_api_primary", vendor: "agy_google", model: "gemini-3.7-flash", purpose: "an earlier session", source: "test seed", budget: 3, used_before: i, at: new Date().toISOString() }) + "\n"); };
function scratch(t, prefix = "l150-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const billingOf = (dir, budget) => geminiBilling({ policy: billingFromFlags({ "gemini-api-primary": String(budget) }), ledger: geminiUsageFile(join(dir, "usage.jsonl")) });
async function post(url, token, path = STREAM, body = { contents: [{ role: "user", parts: [{ text: "hi" }] }], sessionId: "-42" }, extra = {}) {
  const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-goog-api-key": token } : {}), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  // The refusal's code: the caller's own (after the mark) when the charge was refused, else the gateway's.
  const message = json?.error?.message ?? "";
  const reason = /PANTHEON_GATEWAY_REFUSED ([A-Z_]+):/.exec(message)?.[1] ?? /^(PANTHEON_[A-Z_]+)/.exec(message)?.[1] ?? null;
  return { status: r.status, text, json, reason, recovery: /\(recovery: (.*)\)$/s.exec(message)?.[1] ?? null };
}

// The python the seat is spawned with: the stub SDK on PYTHONPATH; its environment is written to `env.txt` and a spawn
// marker to `pid`, both in its --out dir (the seat's environment is scrubbed and its jail writes nothing else, so the
// stub finds the out dir in its own arguments).
function stubPython(dir) {
  const py = join(dir, "python");
  writeFileSync(py, `#!/bin/sh\nout=""; prev=""; for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done\nmkdir -p "$out"\necho $$ > "$out/pid"\nenv > "$out/env.txt"\nPYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(STUB)} exec python3 "$@"\n`, { mode: 0o755 });
  return py;
}
const envOf = dir => Object.fromEntries((existsSync(join(dir, "env.txt")) ? readFileSync(join(dir, "env.txt"), "utf8").split("\n") : []).map(l => /^([^=]*)=(.*)$/s.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
/** The host pid of the seat whose --out is `out` (a jailed seat's own pid is its PID namespace's): its python process. */
function seatPidOf(out) {
  for (const d of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    let argv;
    try { argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (/python/.test(argv[0] ?? "") && argv.includes(SEAT_PY) && argv[argv.indexOf("--out") + 1] === out) return Number(d);
  }
  throw new Error(`no seat process with --out ${out}`);
}
function seatTree(dir) {
  const ws = join(dir, "ws"); mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "README.md"), "# a workspace under review\n");
  writeFileSync(join(dir, "brief.txt"), "Review the README.");
  return ws;
}
const seatArgs = (dir, ws, { role = "reviewer", out = join(dir, "out"), more = [] } = {}) =>
  ["--role", role, "--workspace", ws, "--model", "gemini-3.7-flash", "--brief", join(dir, "brief.txt"), "--out", out, "--timeout", "60", ...more];
/** One governed standalone run (bin/agy-seat.mjs): {code, result (the seat's last stdout line), report (the launcher's line)}. */
function launch(dir, { budget, usage = join(dir, "usage.jsonl"), upstream, python, args, env = {}, onSpawn = null }) {
  const flags = budget === null ? [] : ["--gemini-api-primary", String(budget), "--gemini-usage", usage];
  const child = spawn(process.execPath, [LAUNCHER, ...flags, "--python", python, "--", ...args],
    { env: { ...process.env, GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY, PANTHEON_AGY_GATEWAY_UPSTREAM: upstream, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
  onSpawn?.(child);
  return new Promise(resolve => child.on("close", (code, signal) => {
    const lastJson = (text, test = () => true) => text.trim().split("\n").filter(l => l.startsWith("{")).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && test(o)).at(-1) ?? null;
    resolve({ code, signal, stdout, stderr, result: lastJson(stdout), report: lastJson(stderr, o => o.launcher === "agy-seat.mjs"), said: `exit ${code ?? signal}\n${stdout.slice(-1500)}\n${stderr.slice(-2500)}` });
  }));
}

/** agy-seat.py run directly (no controller), asynchronously, so the in-process fake provider can answer anything it sends. */
function runSeat(py, args, env) {
  const child = spawn(py, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise(resolve => child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); }));
}

test("python3 is on this host (the seat cells run the real agy-seat.py over the stub SDK; they are never skipped)", () => {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, String(r.error ?? r.stderr));
});

// ---- the seat's session on the model gateway (antigravity/seat-session.mjs over gateway.mjs) --------------------------
// One session is one launch of the seat and one gateway. `open` starts it over the local fake provider.
async function open(t, { dir, billing, fake, over = {} }) {
  const { openSeatSession } = await seatSession();
  const s = await openSeatSession({ apiKey: KEY, upstream: fake.url, model: "gemini-3.7-flash", billing, ...over });
  t.after(() => s.close());
  return { s, url: s.env.PANTHEON_AGY_GATEWAY_URL, token: s.env.PANTHEON_AGY_GATEWAY_TOKEN };
}

test("gateway session, three requests with budget 3: exactly three admitted, each charged before it was sent, the fourth refused with its code and recovery; nothing is charged for the launch", async t => {
  const dir = scratch(t), billing = billingOf(dir, 3);
  const fake = await startFakeGemini({ mode: "text", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const admitted = [];
  const { s, url, token } = await open(t, { dir, billing, fake, over: { outcomes: join(dir, "outcomes.jsonl"), admit: row => admitted.push(row.request), spend: { purpose: "critique", role: "reviewer" }, lineage: { board_run: { key: "l150" } } } });
  assert.deepEqual(jsonl(join(dir, "usage.jsonl")), [], "opening a session charges nothing");
  const got = [];
  for (let i = 0; i < 4; i++) got.push(await post(url, token));
  assert.deepEqual(got.map(g => g.status), [200, 200, 200, 403]);
  assert.equal(fake.requests.length, 3, "exactly three reached the provider");
  chargedBefore(fake.requests);
  assert.ok(fake.requests.every(q => q.key === KEY), "forwarded with the controller's credential, never the session's token");
  assert.equal(got[3].reason, BUDGET);
  assert.match(got[3].json.error.message, /^PANTHEON_PROVIDER_LIMIT: PANTHEON_GATEWAY_REFUSED METERED_GEMINI_BUDGET_EXHAUSTED: .*\(recovery: .*declare a larger budget/);
  assert.match(got[3].recovery, /declare a larger budget/);
  const rows = jsonl(join(dir, "usage.jsonl"));
  assert.deepEqual(rows.map(u => [u.kind, u.transport, u.model, u.request, u.used_before, u.identity.seq, u.identity.method, u.identity.sdk_session, u.lineage.board_run.key, u.lineage.conversation]),
    [1, 2, 3].map(n => ["primary", "sdk", "gemini-3.7-flash", n, n - 1, n, "streamGenerateContent", "-42", "l150", "root"]));
  assert.deepEqual(admitted, [1, 2, 3], "the caller's per-request admission ran for each admitted request, never for the refused one");
  assert.deepEqual(billing.refusals.map(x => [x.code, x.used, x.identity?.seq]), [[BUDGET, 3, 4]], "the refusal is recorded with its request identity");
  const outcomes = jsonl(join(dir, "outcomes.jsonl"));
  assert.deepEqual(outcomes.map(o => [o.seq, o.gateway_session === s.id, o.forwarded, o.status, o.refusal, o.usage?.total_token_count ?? null]),
    [[1, true, true, 200, null, 107], [2, true, true, 200, null, 107], [3, true, true, 200, null, 107], [4, true, false, 403, "PANTHEON_PROVIDER_LIMIT", null]]);
  assert.deepEqual([s.admitted, s.summary().admitted, s.summary().refused.map(x => x.code)], [3, 3, [BUDGET]]);
});

test("gateway session, calls it does not serve are refused and recorded, nothing forwarded or charged: another method, another path, another query, another model, a websocket upgrade, and countTokens too", async t => {
  const dir = scratch(t), billing = billingOf(dir, 10);
  const fake = await startFakeGemini({ mode: "text", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const { s, url, token } = await open(t, { dir, billing, fake });
  const refused = [];
  for (const path of ["/v1beta/models/gemini-3.7-flash:embedContent", "/v1beta/models/gemini-3.7-flash:batchGenerateContent", "/v1beta/cachedContents",
    "/upload/v1beta/files", "/v1beta/tunedModels/x:generateContent", "/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=json",
    "/v1beta/models/gemini-3.7-flash:generateContent?alt=sse", "/v1internal:streamGenerateContent?alt=sse",
    "/v1beta1/projects/p/locations/global/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse",
    // countTokens: the relay this replaces passed it through uncharged; the gateway serves the generation calls only.
    "/v1beta/models/gemini-3.7-flash:countTokens"]) {
    const g = await post(url, token, path);
    refused.push([path, g.status, g.reason]);
  }
  const list = await fetch(`${url}/v1beta/models`, { headers: { "x-goog-api-key": token } });
  refused.push(["GET /v1beta/models", list.status, /^(PANTHEON_[A-Z_]+)/.exec((await list.json())?.error?.message ?? "")?.[1] ?? null]);
  assert.deepEqual(refused.filter(([, status, reason]) => !(status === 404 && reason === METHOD)), [], "each is refused as a call that is not served");
  // Another model than the seat's: refused on the wire (the relay forwarded any model).
  const other = await post(url, token, "/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse");
  assert.deepEqual([other.status, other.reason], [403, "PANTHEON_MODEL_NOT_ALLOWED"]);
  // The Live API's bidirectional stream: a websocket upgrade is a transport the gateway does not carry.
  const upgrade = await new Promise(resolve => {
    const req = http.request(`${url}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`, { headers: { connection: "Upgrade", upgrade: "websocket", "x-goog-api-key": token, "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("response", res => { res.resume(); resolve(res.statusCode); }); req.on("upgrade", () => resolve("upgraded")); req.on("error", () => resolve("error")); req.end();
  });
  assert.equal(upgrade, 404);
  assert.equal(fake.requests.length, 0, "nothing reached the provider");
  assert.deepEqual(jsonl(join(dir, "usage.jsonl")), [], "nothing was charged");
  assert.equal(s.summary().refused.length, refused.length + 2, "every refusal is on the session's account");
});

test("gateway session token: a request without one, with a wrong one, with the real key, or with another session's is not served, and a closed session's gateway is gone; nothing forwarded or charged; the key goes to Google or loopback only", async t => {
  const dir = scratch(t), billing = billingOf(dir, 10);
  const fake = await startFakeGemini({ mode: "text", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const { s, url, token } = await open(t, { dir, billing, fake });
  const closed = await open(t, { dir, billing, fake });
  const got = [await post(url, null), await post(url, "pantheon-gw-not-a-session"), await post(url, KEY), await post(url, closed.token)];
  assert.deepEqual(got.map(g => [g.status, g.reason]), Array(4).fill([401, NO_CAP]), "another session's token is no token here");
  await closed.s.close();
  const after = await post(closed.url, closed.token).then(g => g.status, () => "unreachable");
  assert.equal(after, "unreachable", "a closed session's gateway is gone: its token is worth nothing");
  assert.deepEqual([fake.requests.length, jsonl(join(dir, "usage.jsonl")).length, s.admitted], [0, 0, 0]);
  assert.equal((await post(url, token)).status, 200, "control: the open session's own token is admitted");
  // A session that opened anyway is closed at once, so a regression fails this assertion instead of holding the process open.
  const { openSeatSession } = await seatSession();
  const started = p => p.then(async x => { await x.close(); return x; });
  await assert.rejects(started(openSeatSession({ apiKey: KEY, upstream: "https://attacker.example.com", model: "gemini-3.7-flash", billing })), /PANTHEON_UPSTREAM_NOT_ALLOWED: .*only to a Google API host/);
  await assert.rejects(started(openSeatSession({ apiKey: "", upstream: fake.url, model: "gemini-3.7-flash", billing })), /holds the real Gemini credential/);
});

test("gateway session cap: the session's maximum request count is enforced beside the budget, and counts admissions, not outcomes", async t => {
  const dir = scratch(t), billing = billingOf(dir, 10);
  const fake = await startFakeGemini({ mode: "text", failFirst: 2, usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const { s, url, token } = await open(t, { dir, billing, fake, over: { maxRequests: 2 } });
  const got = [await post(url, token), await post(url, token), await post(url, token)];
  assert.deepEqual(got.map(g => g.status), [503, 503, 403], "two admitted (their provider answered 503), the third refused with a status the harness does not retry");
  assert.equal(got[2].reason, SESSION_CAP);
  assert.deepEqual([fake.requests.length, jsonl(join(dir, "usage.jsonl")).length, s.admitted], [2, 2, 2], "an admitted request counts whatever its outcome");
  assert.deepEqual(s.summary().refused.map(x => [x.code, /new launch opens a new session/.test(x.recovery)]), [[SESSION_CAP, true]]);
});

test("gateway sessions competing for the last request: exactly one admitted (two sessions of one controller, and two controllers over one record)", async t => {
  const dir = scratch(t);
  seedRows(join(dir, "usage.jsonl"), 2);
  const fake = await startFakeGemini({ mode: "text", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const billing = billingOf(dir, 3);
  const a = await open(t, { dir, billing, fake }), b = await open(t, { dir, billing, fake });
  const one = await Promise.all([post(a.url, a.token), post(b.url, b.token), post(a.url, a.token), post(b.url, b.token)]);
  assert.deepEqual(one.map(g => g.status).sort(), [200, 403, 403, 403]);
  assert.equal(fake.requests.length, 1, "one controller: exactly one reached the provider");
  // Two controllers, each with its own billing context over the SAME record: the record's lock decides.
  const dir2 = scratch(t);
  seedRows(join(dir2, "usage.jsonl"), 2);
  const fake2 = await startFakeGemini({ mode: "text", usage: join(dir2, "usage.jsonl") }); t.after(() => fake2.close());
  const s1 = await open(t, { dir: dir2, billing: billingOf(dir2, 3), fake: fake2 }), s2 = await open(t, { dir: dir2, billing: billingOf(dir2, 3), fake: fake2 });
  const two = await Promise.all([post(s1.url, s1.token), post(s2.url, s2.token)]);
  assert.deepEqual(two.map(g => g.status).sort(), [200, 403]);
  assert.deepEqual([fake2.requests.length, jsonl(join(dir2, "usage.jsonl")).length], [1, 3]);
});

test("gateway session bounds: an oversized body and a request over the session's concurrency are refused, never charged", async t => {
  const dir = scratch(t), billing = billingOf(dir, 10);
  const fake = await startFakeGemini({ mode: "hang", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const { s, url, token } = await open(t, { dir, billing, fake, over: { maxBodyBytes: 1024, maxConcurrent: 1 } });
  const big = await post(url, token, STREAM, { contents: [{ parts: [{ text: "".padStart(4096, "x") }] }] }).then(g => [g.status, g.reason], () => ["cut", "PANTHEON_REQUEST_TOO_LARGE"]);
  assert.equal(big[1], "PANTHEON_REQUEST_TOO_LARGE", "refused while it arrived (answered 413, or cut)");
  const inflight = post(url, token).catch(() => null);
  await until(() => fake.requests.length === 1);
  const over = await post(url, token);
  assert.deepEqual([over.status, over.reason], [429, "PANTHEON_SESSION_BUSY"]);
  assert.deepEqual([fake.requests.length, jsonl(join(dir, "usage.jsonl")).length], [1, 1], "only the in-flight request was charged");
  await s.close();
  await inflight;
});


// ---- scripts/agy-seat.py: no metered execution without the controller's capability (L-151) ---------------------------
test("seat direct run without a capability sends zero requests, with keys in its environment or none", async t => {
  const dir = scratch(t), ws = seatTree(dir), py = stubPython(dir);
  const fake = await startFakeGemini({ mode: "review", workspace: ws }); t.after(() => fake.close());
  const cases = [
    ["keys present", { GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY, GOOGLE_GEMINI_BASE_URL: fake.url }],
    ["no keys", { GOOGLE_GEMINI_BASE_URL: fake.url }],
    ["a URL without a token", { GEMINI_API_KEY: KEY, PANTHEON_AGY_GATEWAY_URL: fake.url }],
    ["a non-loopback gateway", { GEMINI_API_KEY: KEY, PANTHEON_AGY_GATEWAY_URL: "http://gateway.example.com:80", PANTHEON_AGY_GATEWAY_TOKEN: "forged" }],
  ];
  for (const [name, extra] of cases) {
    const env = { PATH: process.env.PATH, HOME: dir, ...extra };
    const r = await runSeat(py, [SEAT_PY, ...seatArgs(dir, ws, { out: join(dir, `out-${name.replace(/\W+/g, "-")}`) })], env);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.deepEqual([r.status, out.ok, out.refused?.code, out.refused?.provider_requests], [2, false, CAP_ABSENT, 0], `${name}: ${r.stdout}${r.stderr}`);
    assert.match(out.refused.recovery, /bin\/agy-seat\.mjs|pantheon-board/);
  }
  assert.equal(fake.requests.length, 0, "no request reached the provider");
});

test("seat governed run: every request of the session -- each model call, the retry, the continuation, the subagent's -- is charged before it is sent, with its identity and lineage; the child holds no key", jailed, async t => {
  const dir = scratch(t), ws = seatTree(dir), py = stubPython(dir);
  const fake = await startFakeGemini({ mode: "review", failFirst: 1, workspace: ws, usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const r = await launch(dir, { budget: 10, upstream: fake.url, python: py, args: seatArgs(dir, ws) });
  assert.equal(r.code, 0, r.said);
  assert.equal(r.result?.ok, true, r.said);
  // The SDK's call paths, as the real harness takes them: a 503 retried, the view_file continuation, the invoke_subagent
  // continuation, the subagent's own conversation, the root's turn on the subagent's answer.
  assert.deepEqual(fake.requests.map(q => [q.path.split(":").pop(), q.subagent, q.fn_responses.length]),
    [["streamGenerateContent", false, 0], ["streamGenerateContent", false, 0], ["streamGenerateContent", false, 1], ["streamGenerateContent", false, 2], ["streamGenerateContent", true, 0], ["streamGenerateContent", false, 2]]);
  chargedBefore(fake.requests);
  assert.ok(fake.requests.every(q => q.key === KEY), "the provider saw the controller's key");
  const rows = jsonl(join(dir, "usage.jsonl"));
  assert.equal(rows.length, 6, "six requests, six charges: a launch is not one request");
  const root = rows[0].identity.sdk_session;
  assert.deepEqual(rows.map(u => [u.request, u.lineage.conversation, u.lineage.parent_session === root, u.identity.sdk_session === root]),
    [[1, "root", true, true], [2, "root", true, true], [3, "root", true, true], [4, "root", true, true], [5, "subagent", true, false], [6, "root", true, true]]);
  assert.equal(rows[4].lineage.subagent_session, fake.requests[4].session);
  assert.equal(new Set(rows.map(u => u.identity.gateway_session)).size, 1);
  const outcomes = jsonl(join(dir, "usage.jsonl.outcomes.jsonl"));
  assert.deepEqual(outcomes.map(o => [`${o.gateway_session}#${o.seq}` === rows[o.seq - 1].identity.request_id, o.status]), [[true, 503], [true, 200], [true, 200], [true, 200], [true, 200], [true, 200]]);
  assert.deepEqual([r.report?.gateway?.admitted, r.result?.gateway?.admitted], [6, 6]);
  // THE CHILD'S ENVIRONMENT: the capability, a HOME of its own, and no credential.
  const env = envOf(join(dir, "out"));
  assert.deepEqual([env.GEMINI_API_KEY, env.GOOGLE_API_KEY], [undefined, undefined]);
  assert.ok(!readFileSync(join(dir, "out", "env.txt"), "utf8").includes(KEY), "the real key's value is nowhere in the child's environment");
  assert.match(env.PANTHEON_AGY_GATEWAY_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(env.PANTHEON_AGY_GATEWAY_TOKEN ?? "", /^pantheon-gw-[0-9a-f]{48}$/);
  assert.equal(env.HOME, join(dir, "out", "home"));
});

test("seat web search: the SDK's :generateContent search request is charged like any other", jailed, async t => {
  const dir = scratch(t), ws = seatTree(dir), py = stubPython(dir);
  const fake = await startFakeGemini({ mode: "scout", workspace: ws, usage: join(dir, "usage.jsonl"), final: "RAN: nothing" }); t.after(() => fake.close());
  const r = await launch(dir, { budget: 10, upstream: fake.url, python: py, args: seatArgs(dir, ws, { role: "scout" }) });
  assert.equal(r.code, 0, r.said);
  assert.deepEqual(fake.requests.map(q => [q.path.split(":").pop(), q.search, q.session !== null]), [["streamGenerateContent", false, true], ["generateContent", true, false], ["streamGenerateContent", false, true]]);
  chargedBefore(fake.requests);
  assert.deepEqual(jsonl(join(dir, "usage.jsonl")).map(u => [u.identity.method, u.lineage.conversation]), [["streamGenerateContent", "root"], ["generateContent", "unattributed"], ["streamGenerateContent", "root"]]);
});

test("seat exhaustion: a session able to make 40 requests with a budget of 3 never sends a fourth; the turn ends on the refusal with its output and progress kept", jailed, async t => {
  const dir = scratch(t), ws = seatTree(dir), py = stubPython(dir);
  const fake = await startFakeGemini({ mode: "loop", workspace: ws, usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const r = await launch(dir, { budget: 3, upstream: fake.url, python: py, args: seatArgs(dir, ws, { more: ["--max-model-calls", "40"] }) });
  assert.equal(r.code, 5, r.said);
  assert.equal(fake.requests.length, 3, "never a fourth");
  chargedBefore(fake.requests);
  assert.deepEqual([r.result?.ok, r.result?.refused?.code, r.result?.refused?.admitted], [false, BUDGET, 3], r.said);
  assert.match(r.result.refused.recovery ?? "", /declare a larger budget/);
  const kept = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
  assert.equal(kept.refused.code, BUDGET, "result.json records the refusal");
  assert.ok(jsonl(join(dir, "out", "progress.jsonl")).some(p => p.event === "turn.refused" && /METERED_GEMINI_BUDGET_EXHAUSTED/.test(p.detail)));
  assert.equal(jsonl(join(dir, "usage.jsonl")).length, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, "out", "gateway-session.json"), "utf8")).gateway.admitted, 3);
});

test("seat concurrency across processes: two governed launches competing for the last request over one record, exactly one admitted", jailed, async t => {
  const dir = scratch(t), ws = seatTree(dir);
  seedRows(join(dir, "usage.jsonl"), 2);
  const fake = await startFakeGemini({ mode: "text", workspace: ws, usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  const runs = await Promise.all(["a", "b"].map(n => { const d = join(dir, n); mkdirSync(d); return launch(d, { budget: 3, usage: join(dir, "usage.jsonl"), upstream: fake.url, python: stubPython(d), args: seatArgs(dir, ws, { out: join(d, "out") }) }); }));
  assert.deepEqual(runs.map(x => x.code).sort(), [0, 5], runs.map(x => x.said).join("\n----\n"));
  assert.equal(fake.requests.length, 1, "exactly one request reached the provider");
  assert.equal(jsonl(join(dir, "usage.jsonl")).length, 3);
  assert.equal(runs.find(x => x.code === 5).result.refused.code, BUDGET);
});

test("seat crash cancel restart: a session killed (SIGKILL) or cancelled (SIGTERM) after admission, and a controller killed in flight, leave every admitted request counted; a restart counts them", jailed, async t => {
  const { seatAccounting, readSeatOutcomes } = await seatSession();
  const dir = scratch(t), ws = seatTree(dir), usage = join(dir, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "hang", workspace: ws, usage }); t.after(() => fake.close());
  const inFlight = async (name, kill) => {
    const d = join(dir, name); mkdirSync(d);
    const before = fake.requests.length;
    let launcher = null;
    const done = launch(d, { budget: 3, usage, upstream: fake.url, python: stubPython(d), args: seatArgs(dir, ws, { out: join(d, "out") }), onSpawn: c => { launcher = c; } });
    await until(() => fake.requests.length === before + 1);
    kill({ launcher, seatPid: seatPidOf(join(d, "out")) });
    return done;
  };
  // (a) the SDK session crashes: its process is SIGKILLed while its request is in flight.
  const crashed = await inFlight("crash", ({ seatPid }) => process.kill(seatPid, "SIGKILL"));
  assert.notEqual(crashed.code, 0, crashed.said);
  assert.equal(jsonl(usage).length, 1, "the crashed session's admitted request stays counted");
  // (b) the session is cancelled: the launcher is stopped (SIGTERM) and stops its seat.
  const cancelled = await inFlight("cancel", ({ launcher }) => launcher.kill("SIGTERM"));
  assert.equal(cancelled.report?.stopped, true, cancelled.said);
  assert.equal(jsonl(usage).length, 2, "the cancelled session's admitted request stays counted");
  // (c) the controller itself is SIGKILLed in flight: no outcome is ever written, the request stays counted, outcome unknown.
  const killed = await inFlight("controller", ({ launcher, seatPid }) => { launcher.kill("SIGKILL"); try { process.kill(seatPid, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(killed.signal, "SIGKILL");
  const rows = jsonl(usage);
  assert.equal(rows.length, 3);
  const acc = seatAccounting({ usage: rows, outcomes: readSeatOutcomes(`${usage}.outcomes.jsonl`) });
  assert.equal(acc.admitted, 3);
  assert.ok(acc.unknown >= 1, `the killed controller's request has no outcome: ${JSON.stringify(acc.rows)}`);
  assert.equal(acc.rows.find(x => x.request_id === rows[2].identity.request_id).outcome, "unknown");
  // (d) a restart with the same budget counts all three: refused before anything is spawned, nothing sent.
  const d = join(dir, "restart"); mkdirSync(d);
  const before = fake.requests.length;
  const restart = await launch(d, { budget: 3, usage, upstream: fake.url, python: stubPython(d), args: seatArgs(dir, ws, { out: join(d, "out") }) });
  assert.equal(restart.code, 2, restart.said);
  assert.equal(restart.report?.refused?.code, BUDGET);
  assert.deepEqual([fake.requests.length, existsSync(join(d, "out", "pid"))], [before, false], "nothing spawned or sent");
});

// ---- the board's SDK seat (runOpenItem, PANTHEON_AGY_TRANSPORT=sdk) -------------------------------------------------
async function boardSeat(t, { budget, seed = 0, maxProviderCalls = 50, charge = null, env = {}, mode = "review" } = {}) {
  const dir = scratch(t, "l150-board-"), py = stubPython(dir), usage = join(dir, "usage.jsonl");
  if (seed) seedRows(usage, seed);
  const fake = await startFakeGemini({ mode, usage }); t.after(() => fake.close());
  const onCharge = charge ? charge(fake) : null;
  const billing = billingOf(dir, budget);
  const vars = { PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: py, PANTHEON_AGY_GATEWAY_UPSTREAM: fake.url, GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY,
    OPENAI_API_KEY: "sk-l150-synthetic-openai", ...env };
  let out;
  await withDispatch(async ({ spec, opts }) => {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      const r = await runOpenItem(spec("l150-sdk"), { ...opts(), maxProviderCalls, billing, ...(onCharge ? { onCharge } : {}),
        seatOverrides: { reviewer: seat("agy_google", "gemini-3.8-flash", { transport: "agy" }) } }).catch(e => ({ error: e }));
      const board = r?.board ?? null;
      const run = board && existsSync(join(board, "run.json")) ? JSON.parse(readFileSync(join(board, "run.json"), "utf8")) : null;
      const seatDirs = run ? readdirSync(join(run.repo_root, "outputs", "open-items", "l150-sdk", "agy_google")).map(n => join(run.repo_root, "outputs", "open-items", "l150-sdk", "agy_google", n)) : [];
      out = { r, run, seatDirs, partial: seatDirs.map(s => join(s, "response.partial.md")).filter(existsSync).map(f => readFileSync(f, "utf8")),
        seatEnv: envOf(seatDirs.find(s => existsSync(join(s, "env.txt"))) ?? dir), spawned: seatDirs.some(s => existsSync(join(s, "pid"))) };
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  return { ...out, fake, usage: jsonl(usage), billing, env: out.seatEnv };
}
const critique = run => (run?.attempts ?? []).filter(a => a.vendor === "agy_google" && a.purpose === "critique");

test("board sdk seat: each request is charged as it is made -- usage rows, the attempt's provider requests and the run's provider calls all count the requests, not the launch", jailed, async t => {
  const b = await boardSeat(t, { budget: 100 });
  assert.ok(b.run, JSON.stringify(b.r?.error?.message ?? b.r));
  assert.deepEqual(critique(b.run).map(a => [a.outcome, a.provider_requests]), [["ok", 5]], JSON.stringify(b.run.attempts));
  assert.equal(b.fake.requests.length, 5);
  chargedBefore(b.fake.requests);
  assert.deepEqual(b.usage.map(u => [u.transport, u.model, u.purpose, u.lineage.board_run.key, u.lineage.seat.launch]), Array(5).fill(["sdk", "gemini-3.8-flash", "critique", "l150-sdk", "critique-1"]));
  assert.deepEqual(b.usage.map(u => u.lineage.conversation), ["root", "root", "root", "subagent", "root"], "the subagent's request is attributed to it");
  assert.equal(b.run.billing.rows.filter(u => u.transport === "sdk").length, 5, "run.json carries every usage row");
  assert.equal(b.run.provider_calls.made, b.run.attempts.reduce((n, a) => n + a.provider_requests, 0), "the run's provider calls are the attempts' requests");
  assert.deepEqual([b.env.GEMINI_API_KEY, b.env.GOOGLE_API_KEY, b.env.OPENAI_API_KEY], [undefined, undefined, undefined], "the seat holds no credential");
  assert.match(b.env.PANTHEON_AGY_GATEWAY_TOKEN ?? "", /^pantheon-gw-/);
});

test("board sdk seat exhaustion: a budget of 3 admits three requests, refuses the fourth as a billing refusal (recoverable), keeps the seat's output; a restart counts them", jailed, async t => {
  const b = await boardSeat(t, { budget: 3 });
  assert.equal(b.fake.requests.length, 3, "never a fourth");
  assert.deepEqual(critique(b.run).map(a => [a.outcome, a.code, a.provider_requests]), [["refused_metered", BUDGET, 3]], JSON.stringify(b.run?.attempts));
  assert.equal(b.run.shipped, false);
  assert.ok(b.run.billing.refusals.some(x => x.code === BUDGET && x.transport === "sdk"), "the refusal is on run.json");
  assert.deepEqual(b.partial, ["VERDICT: approve"], "the seat's partial output is kept");
  const again = await boardSeat(t, { budget: 3, seed: 3 });
  assert.deepEqual([again.fake.requests.length, again.spawned], [0, false], "a restart over the spent record sends nothing and spawns nothing");
  assert.deepEqual(critique(again.run).map(a => [a.code, a.provider_requests]), [[BUDGET, 0]]);
});

test("board sdk seat seeded record: two earlier sessions' spending is counted, so only the last unit of the budget is admitted", jailed, async t => {
  const b = await boardSeat(t, { budget: 3, seed: 2 });
  assert.equal(b.fake.requests.length, 1);
  chargedBefore(b.fake.requests, 2);
  assert.deepEqual(critique(b.run).map(a => [a.code, a.provider_requests]), [[BUDGET, 1]]);
});

test("board sdk seat provider-call bound: the run's admission is charged per request, before each is sent, and its refusal refuses the next request", jailed, async t => {
  const charges = [];
  const b = await boardSeat(t, { budget: 100, charge: fake => c => {
    if (c.vendor !== "agy_google") return;
    charges.push(fake.requests.length);
    if (charges.length > 2) throw new Error("the stage's charge is spent");
  } });
  assert.equal(b.fake.requests.length, 2, "the third request was refused by the run's own admission");
  assert.deepEqual(charges, [0, 1, 2], "one charge per request, each made before its request reached the provider (the refused one included)");
  assert.deepEqual(critique(b.run).map(a => [a.code, a.provider_requests]), [["PROVIDER_CALL_LIMIT", 2]]);
  assert.deepEqual(b.usage.length, 2);
});

test("board sdk seat vertex: Vertex through the SDK seat is refused before anything is admitted or spawned (the gateway carries the Gemini API only)", async t => {
  const b = await boardSeat(t, { budget: 100, env: { PANTHEON_AGY_VERTEX_PROJECT: "synthetic-project" } });
  assert.deepEqual([b.fake.requests.length, b.usage.length, b.spawned], [0, 0, false]);
  assert.deepEqual(critique(b.run).map(a => [a.code, a.provider_requests]), [[VERTEX, 0]]);
});

// ---- the channel's idle and lifetime bounds (owner item 4 of the L-150 decision) ---------------------------------------
test("gateway session idle and lifetime bounds: a session idle past its bound, or past its lifetime while active, is over: the next request is refused with PANTHEON_SESSION_EXPIRED, nothing charged or forwarded", async t => {
  const dir = scratch(t), billing = billingOf(dir, 10);
  const fake = await startFakeGemini({ mode: "text", usage: join(dir, "usage.jsonl") }); t.after(() => fake.close());
  // Idle: one request inside the bound, then a pause longer than it.
  const idle = await open(t, { dir, billing, fake, over: { idleMs: 150, lifetimeMs: 60_000 } });
  assert.equal((await post(idle.url, idle.token)).status, 200);
  await sleep(400);
  const late = await post(idle.url, idle.token);
  assert.deepEqual([late.status, late.reason], [401, "PANTHEON_SESSION_EXPIRED"], "a session idle past its bound is over");
  assert.equal(fake.requests.length, 1, "the refused request was not forwarded");
  assert.equal(jsonl(join(dir, "usage.jsonl")).length, 1, "the refused request was not charged");
  // Lifetime: requests every 60 ms keep the session from idling; past its lifetime it is over all the same.
  const life = await open(t, { dir, billing, fake, over: { idleMs: 60_000, lifetimeMs: 300 } });
  const statuses = [];
  for (const end = Date.now() + 700; Date.now() < end;) { statuses.push((await post(life.url, life.token)).status); await sleep(60); }
  assert.equal(statuses[0], 200, "a request inside the lifetime is served");
  assert.equal(statuses.at(-1), 401, "past its lifetime the session is over although it never idled");
  const served = statuses.filter(x => x === 200).length;
  assert.equal(fake.requests.length, 1 + served, "only the requests inside the lifetime were forwarded");
  assert.equal(jsonl(join(dir, "usage.jsonl")).length, 1 + served, "only the requests inside the lifetime were charged");
});
