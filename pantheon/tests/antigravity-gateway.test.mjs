// THE MODEL GATEWAY (src/antigravity/gateway.mjs): the controller's loopback door between the SDK's runtime and the
// Gemini API. Real HTTP on loopback against the scripted provider (fixtures/fake-gemini.mjs): no network, no model.
// Each test names the defect it would catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModelGateway, providerAvailability, GATEWAY_REFUSALS } from "../src/antigravity/gateway.mjs";
import { startFakeGemini, text, QUOTA, notFound } from "./fixtures/fake-gemini.mjs";

const KEY = "REAL-KEY-synthetic-0123456789";
const ROOT = { model: "gemini-4-carbon", marker: "[pantheon-agent:test:root]" };
const SUBS = { model: "gemini-4-hydrogen", ceiling: 2, markers: { "code-explorer": "[pantheon-agent:test:sub:code-explorer]", "test-constructor": "[pantheon-agent:test:sub:test-constructor]" } };
const sysOf = marker => ({ parts: [{ text: `You are an agent. ${marker}` }] });
const body = (marker, session = "s-root", extra = {}) => ({ contents: [{ role: "user", parts: [{ text: "go" }] }], sessionId: session, systemInstruction: sysOf(marker), ...extra });

async function setup(t, { decide = () => ({ parts: [text("ok")] }), models = null, admit = () => {}, over = {} } = {}) {
  const upstream = await startFakeGemini({ decide, models });
  const gw = await startModelGateway({ upstream: upstream.url, apiKey: KEY, root: ROOT, subagents: SUBS, admit, ...over });
  t.after(async () => { await gw.close(); await upstream.close(); });
  const post = (model, b, { token = gw.token, verb = "streamGenerateContent?alt=sse", headers = {} } = {}) =>
    fetch(`${gw.url}/v1beta/models/${model}:${verb}`, { method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { "x-goog-api-key": token }), ...headers }, body: JSON.stringify(b) });
  return { upstream, gw, post };
}

test("a request is forwarded with the controller's key; the runtime's token never reaches the provider and the key never reaches the record", async t => {
  const { upstream, gw, post } = await setup(t);
  const r = await post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(r.status, 200);
  const sse = await r.text();
  assert.match(sse, /^data: \{/);
  assert.equal(JSON.parse(sse.replace(/^data: /, "")).candidates[0].content.parts[0].text, "ok", "the provider's answer is passed through");
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers["x-goog-api-key"], KEY, "the provider is asked with the controller's key");
  assert.ok(!JSON.stringify(upstream.requests[0].headers).includes(gw.token), "the session token stays between the runtime and the gateway");
  const rec = gw.record();
  assert.ok(!JSON.stringify(rec).includes(KEY), "the key is not in the record");
  assert.ok(!JSON.stringify(rec).includes(gw.token), "the token is not in the record");
  assert.deepEqual({ class: rec.requests[0].class, model: rec.requests[0].model, status: rec.requests[0].status, served: rec.requests[0].served_model, forwarded: rec.requests[0].forwarded },
    { class: "root", model: "gemini-4-carbon", status: 200, served: "gemini-4-carbon", forwarded: true });
  assert.equal(rec.requests[0].usage.total_token_count, 115);
  assert.equal(rec.totals.forwarded, 1);
});

test("a caller without the session token is refused and nothing is forwarded", async t => {
  const { upstream, gw, post } = await setup(t);
  for (const token of [null, "wrong-token", KEY]) {
    const r = await post("gemini-4-carbon", body(ROOT.marker), { token });
    assert.equal(r.status, 401, String(token));
    assert.equal((await r.json()).error.message.startsWith(GATEWAY_REFUSALS.UNAUTHORIZED), true);
  }
  assert.equal(upstream.requests.length, 0, "an unauthenticated request never reaches the provider");
  assert.equal(gw.record().totals.refused, 3);
});

test("a model that is neither the implementer's nor the pinned subagent model is refused on the wire", async t => {
  const { upstream, gw, post } = await setup(t);
  const r = await post("gemini-4-argon", body(ROOT.marker));
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.message, /^PANTHEON_MODEL_NOT_ALLOWED/);
  assert.equal(upstream.requests.length, 0);
  assert.equal(gw.record().requests[0].refusal, "PANTHEON_MODEL_NOT_ALLOWED");
});

test("a subagent that would run on the implementer's own model is refused: a clone never reaches the provider", async t => {
  const { upstream, gw, post } = await setup(t);
  const r = await post("gemini-4-carbon", body(SUBS.markers["code-explorer"], "s-child-1"));
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.message, /^PANTHEON_SUBAGENT_NOT_PINNED/);
  assert.equal(upstream.requests.length, 0, "the clone's request is not forwarded");
  // ...and the implementer may not pass itself off on the subagent model either.
  const r2 = await post("gemini-4-hydrogen", body(ROOT.marker));
  assert.equal(r2.status, 403);
  assert.match((await r2.json()).error.message, /^PANTHEON_MODEL_NOT_ALLOWED/);
  assert.equal(gw.record().totals.refused, 2);
});

test("a pinned subagent's requests go to Hydrogen and are attributed to its type and session", async t => {
  const { upstream, gw, post } = await setup(t);
  await (await post("gemini-4-carbon", body(ROOT.marker))).text();
  await (await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-child-1"))).text();
  await (await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-child-1"))).text();
  await (await post("gemini-4-hydrogen", body(SUBS.markers["test-constructor"], "s-child-2"))).text();
  assert.deepEqual(upstream.requests.map(r => r.model), ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-4-hydrogen"]);
  const rec = gw.record();
  assert.deepEqual(rec.requests.map(r => r.class), ["root", "subagent", "subagent", "subagent"]);
  assert.deepEqual(rec.sessions.filter(s => s.class === "subagent").map(s => ({ session: s.session, type: s.type, requests: s.requests, model: s.model, total: s.usage.total_token_count })),
    [{ session: "s-child-1", type: "code-explorer", requests: 2, model: "gemini-4-hydrogen", total: 230 }, { session: "s-child-2", type: "test-constructor", requests: 1, model: "gemini-4-hydrogen", total: 115 }]);
  assert.equal(rec.subagent_sessions, 2);
});

test("a subagent session past the ceiling is refused on the wire, whatever the hook admitted", async t => {
  const { upstream, gw, post } = await setup(t);
  for (const s of ["s-1", "s-2"]) assert.equal((await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], s))).status, 200);
  const third = await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-3"));
  assert.equal(third.status, 429);
  assert.match((await third.json()).error.message, /^PANTHEON_SUBAGENT_CEILING: 2 subagent session\(s\) are live and the ceiling is 2/);
  assert.equal((await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-1"))).status, 200, "an admitted session keeps working");
  assert.equal(upstream.requests.length, 3);
  assert.equal(gw.record().subagent_sessions, 2);
});

test("with a ceiling of 0 no subagent request is forwarded at all", async t => {
  const { upstream, post } = await setup(t, { over: { subagents: { ...SUBS, ceiling: 0 } } });
  const r = await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-1"));
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.message, /^PANTHEON_MODEL_NOT_ALLOWED/);
  assert.equal(upstream.requests.length, 0);
});

test("every request is admitted BEFORE it is forwarded, and a refused admission means the request is not made", async t => {
  const order = [];
  let left = 2;
  const { upstream, gw, post } = await setup(t, {
    decide: () => { order.push("provider"); return { parts: [text("ok")] }; },
    admit: info => { if (left-- <= 0) throw Object.assign(new Error("the run's provider-call bound (2) is exhausted"), { code: "PROVIDER_LIMIT" }); order.push(`admit:${info.class}:${info.n}`); },
  });
  assert.equal((await post("gemini-4-carbon", body(ROOT.marker))).status, 200);
  assert.equal((await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-1"))).status, 200);
  const refused = await post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(refused.status, 403, "a refused charge is final: it is not answered with a status the SDK's harness retries (429, 500, 503)");
  const err = (await refused.json()).error;
  assert.match(err.message, /^PANTHEON_PROVIDER_LIMIT/);
  assert.deepEqual(order, ["admit:root:1", "provider", "admit:subagent:1", "provider"], "the charge precedes each call, and the refused one made none");
  assert.equal(upstream.requests.length, 2);
  const rec = gw.record();
  assert.equal(rec.budget_refusals, 1);
  assert.equal(rec.requests.at(-1).refusal, "PANTHEON_PROVIDER_LIMIT");
  assert.equal(rec.stop?.kind, "budget");
});

test("the provider's refusals are passed through and classified by status: quota, unavailable model, credential", async t => {
  const answers = { "gemini-4-carbon": QUOTA };
  const { gw, post } = await setup(t, { decide: ({ model }) => answers[model] ?? { parts: [text("ok")] } });
  const q = await post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(q.status, 429);
  assert.equal((await q.json()).error.status, "RESOURCE_EXHAUSTED", "the provider's own error body reaches the runtime");
  assert.deepEqual({ kind: gw.record().stop.kind, status: gw.record().stop.status, provider_status: gw.record().stop.provider_status }, { kind: "quota", status: 429, provider_status: "RESOURCE_EXHAUSTED" });

  const u = await setup(t, { decide: ({ model }) => notFound(model) });
  assert.equal((await u.post("gemini-4-carbon", body(ROOT.marker))).status, 404);
  assert.equal(u.gw.record().stop.kind, "model_unavailable");

  const a = await setup(t, { decide: () => ({ status: 401, error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } }) });
  assert.equal((await a.post("gemini-4-carbon", body(ROOT.marker))).status, 401);
  assert.equal(a.gw.record().stop.kind, "auth");
});

test("the provider's statement of the model that answered is recorded per request; a different model than asked is a mismatch on the record", async t => {
  const { gw, post } = await setup(t, { decide: ({ model }) => ({ parts: [text("ok")], modelVersion: model === "gemini-4-hydrogen" ? "gemini-4-argon" : "gemini-4-carbon-20261101" }) });
  await (await post("gemini-4-carbon", body(ROOT.marker))).text();
  await (await post("gemini-4-hydrogen", body(SUBS.markers["code-explorer"], "s-1"))).text();
  const rec = gw.record();
  assert.deepEqual(rec.requests.map(r => r.served_model), ["gemini-4-carbon-20261101", "gemini-4-argon"]);
  assert.deepEqual(rec.served_models, { "gemini-4-carbon": ["gemini-4-carbon-20261101"], "gemini-4-hydrogen": ["gemini-4-argon"] });
});

test("aborting the gateway cuts a request in flight, and nothing is forwarded afterwards", async t => {
  const { upstream, gw, post } = await setup(t, { decide: () => ({ parts: [text("late")], delayMs: 5000 }) });
  const pending = post("gemini-4-carbon", body(ROOT.marker)).then(r => r.text()).then(() => "answered", () => "cut");
  await new Promise(r => setTimeout(r, 200));
  gw.abort("the stage was stopped");
  assert.equal(await pending, "cut", "the in-flight request ends with the abort");
  await new Promise(r => setTimeout(r, 100));
  assert.equal(upstream.requests[0].aborted, true, "the provider-side request was cancelled too");
  const after = await post("gemini-4-carbon", body(ROOT.marker)).then(r => r.status, () => "closed");
  assert.ok(after === "closed" || after === 503, "an aborted gateway forwards nothing more");
  assert.equal(upstream.requests.length, 1);
  assert.equal(gw.record().aborted, "the stage was stopped");
});

test("a stop that arrives while a request is still being admitted is honoured: the request is not forwarded after an abort, nor after a close", async t => {
  // Independent review, 2026-11-19: the stop was checked once, on arrival. A request already past that check (its body
  // being read, its admission pending) was admitted and forwarded after the stop.
  for (const stopWith of ["abort", "close"]) {
    let release, entered;
    const pending = new Promise(r => { release = r; }), inAdmit = new Promise(r => { entered = r; });
    const { upstream, gw, post } = await setup(t, { admit: async () => { entered(); await pending; } });
    const sent = post("gemini-4-carbon", body(ROOT.marker)).then(r => r.status, () => "connection cut");
    await inAdmit;                                  // the request is past the first reading of the stop, waiting on its charge
    const closing = stopWith === "abort" ? (gw.abort("stopped by the caller"), null) : gw.close();
    release();
    const status = await sent;
    await closing;
    assert.ok(status === 503 || status === "connection cut", `${stopWith}: the request was answered ${status}`);
    assert.deepEqual(upstream.requests.filter(x => x.verb), [], `${stopWith}: nothing reached the provider after the stop`);
    assert.equal(gw.record().totals.forwarded, 0, stopWith);
  }
});

test("a request on a stopped session is refused before it is charged: one whose body was still arriving at the stop, and one that arrives after it", async t => {
  // The stop is read once the whole request is in hand, so both are refused at the same place. Read on arrival only, the
  // first would go on to its charge: a request that can no longer be sent would be charged to the run's bound.
  const charged = [];
  const { upstream, gw, post } = await setup(t, { admit: info => { charged.push(info.class); } });
  const payload = Buffer.from(JSON.stringify(body(ROOT.marker)));
  const slow = request(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length, "x-goog-api-key": gw.token } });
  const answer = new Promise((resolve, reject) => { slow.on("error", reject); slow.on("response", res => { let s = ""; res.setEncoding("utf8"); res.on("data", c => { s += c; }); res.on("end", () => resolve({ status: res.statusCode, text: s })); }); });
  slow.write(payload.subarray(0, 16));                            // the headers and the first bytes of the body
  while (gw.record().requests.length < 1) await new Promise(r => setTimeout(r, 5));   // the gateway has the request, not its body
  gw.abort("stopped by the caller");
  slow.end(payload.subarray(16));
  const first = await answer;
  const second = await post("gemini-4-carbon", body(ROOT.marker));
  assert.deepEqual([first.status, second.status], [503, 503]);
  assert.match(JSON.parse(first.text).error.message, /^PANTHEON_GATEWAY_ABORTED: the session was stopped: stopped by the caller/);
  assert.deepEqual(charged, [], "neither request was charged");
  assert.deepEqual(upstream.requests, [], "and neither reached the provider");
  assert.deepEqual(gw.record().requests.map(r => [r.refusal, r.forwarded]), [[GATEWAY_REFUSALS.ABORTED, false], [GATEWAY_REFUSALS.ABORTED, false]]);
});

test("ANY abort stops the gateway, whatever its reason says: an empty reason, or a signal aborted with an error that has no message, is still a stop", async t => {
  // Independent review of 6ee0fea: the stop was kept as its reason text, and an empty text read as "not stopped": the
  // next request was charged and forwarded with the key.
  for (const stopWith of ["an empty reason", "no reason", "a signal whose error has no message"]) {
    const charged = [], ac = new AbortController();
    const { upstream, gw, post } = await setup(t, { admit: info => { charged.push(info.class); }, over: { signal: ac.signal } });
    if (stopWith === "an empty reason") gw.abort(""); else if (stopWith === "no reason") gw.abort(); else ac.abort(new Error());
    const r = await post("gemini-4-carbon", body(ROOT.marker));
    assert.equal(r.status, 503, stopWith);
    assert.match((await r.json()).error.message, /^PANTHEON_GATEWAY_ABORTED: the session was stopped: \S/, `${stopWith}: the refusal still says, in words, that it was stopped`);
    assert.deepEqual([charged, upstream.requests.length, gw.record().totals.forwarded], [[], 0, 0], stopWith);
    assert.match(gw.record().aborted, /\S/, `${stopWith}: the record says the gateway was stopped`);
  }
});

test("a stopped gateway answers a request as it arrives: it does not wait for a body that may never come, and a path it does not serve is not answered as if it were open", async t => {
  // Independent review of 6ee0fea, which had removed the check on arrival as a duplicate of the one after the body: it
  // was the only one that answers without the body, so a stalled upload was held (up to the size bound) and never answered.
  const charged = [];
  const { upstream, gw } = await setup(t, { admit: info => { charged.push(info.class); } });
  gw.abort("stopped by the caller");
  const payload = Buffer.from(JSON.stringify(body(ROOT.marker)));
  const stalled = request(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length, "x-goog-api-key": gw.token } });
  const answer = new Promise(resolve => { stalled.on("error", e => resolve({ status: `connection error: ${e.code ?? e.message}`, text: "" })); stalled.on("response", res => { let s = ""; res.setEncoding("utf8"); res.on("data", c => { s += c; }); res.on("end", () => resolve({ status: res.statusCode, text: s })); }); });
  stalled.write(payload.subarray(0, 16));                        // the rest of the body never comes
  const first = await Promise.race([answer, new Promise(resolve => setTimeout(() => resolve({ status: "no answer within 2 s", text: "" }), 2000))]);
  stalled.destroy();
  assert.equal(first.status, 503);
  assert.match(first.text, /PANTHEON_GATEWAY_ABORTED: the session was stopped: stopped by the caller/);
  const elsewhere = await fetch(`${gw.url}/v1beta/models`, { headers: { "x-goog-api-key": gw.token } });
  assert.equal(elsewhere.status, 503, "stopped comes before what is served");
  assert.deepEqual([charged, upstream.requests.length], [[], 0]);
  assert.deepEqual(gw.record().requests.map(r => r.refusal), [GATEWAY_REFUSALS.ABORTED, GATEWAY_REFUSALS.ABORTED]);
});

test("callers without the session token cannot grow the record without bound: they are counted, and a bounded number of rows is kept", async t => {
  const { upstream, gw, post } = await setup(t);
  for (let i = 0; i < 60; i++) assert.equal((await post("gemini-4-carbon", body(ROOT.marker), { token: `wrong-${i}` })).status, 401);
  const rec = gw.record();
  assert.equal(rec.unauthorized, 60, "every one is counted");
  assert.ok(rec.requests.filter(r => r.refusal === GATEWAY_REFUSALS.UNAUTHORIZED).length <= 20, "and at most twenty rows are kept for them");
  assert.deepEqual(upstream.requests, []);
  // The session itself is still served and recorded.
  assert.equal((await post("gemini-4-carbon", body(ROOT.marker))).status, 200);
  assert.equal(gw.record().totals.forwarded, 1);
});

test("a key that is not a clean header value is refused before it is sent, and its text is in no message", async t => {
  // A pasted key with a line break: the HTTP layer rejects the header and quotes the value in its error.
  const BAD = "SYNTH-KEY-first-line\nsecond-line";
  // (A gateway that started is closed: a missing refusal fails this test, and leaves no listener that keeps the run from ending.)
  await assert.rejects(startModelGateway({ upstream: "http://127.0.0.1:9", apiKey: BAD, root: ROOT, subagents: SUBS }).then(g => g.close()),
    e => e.code === "NO_API_KEY" && !e.message.includes("SYNTH-KEY") && /not usable as a key/.test(e.message));
  const a = await providerAvailability({ upstream: "http://127.0.0.1:9", apiKey: BAD, model: "gemini-4-carbon" });
  assert.deepEqual([a.available, a.kind, a.status], [false, "auth", null]);
  assert.ok(!JSON.stringify(a).includes("SYNTH-KEY"), "the key's text is not in the availability record");
});

test("the gateway does not start without a key, nor without the implementer's model and marker", async t => {
  // A gateway that started is closed here, so a missing refusal fails this test and leaves no listener behind.
  const start = async over => { const gw = await startModelGateway({ upstream: "http://127.0.0.1:9", apiKey: KEY, root: ROOT, subagents: SUBS, ...over }); await gw.close(); return "started"; };
  for (const apiKey of [undefined, null, "", "   "]) await assert.rejects(start({ apiKey }), { code: "NO_API_KEY" }, `key ${JSON.stringify(apiKey)}`);
  // Without its marker the implementer's own requests would be recorded as nobody's; without its model none would be served.
  for (const root of [undefined, { model: ROOT.model }, { marker: ROOT.marker }, { model: "", marker: ROOT.marker }]) await assert.rejects(start({ root }), /pass root \{model, marker\}/, `root ${JSON.stringify(root)}`);
  assert.equal(await start({}), "started", "and with both it starts");
});

test("a request over the size bound is refused while it arrives: it is not held whole, not charged and not forwarded", async t => {
  const charged = [];
  const { upstream, gw, post } = await setup(t, { admit: info => { charged.push(info.class); }, over: { maxBodyBytes: 2048 } });
  const outcome = await post("gemini-4-carbon", body(ROOT.marker, "s-root", { padding: "x".repeat(8192) })).then(r => r.status, () => "connection cut");
  assert.ok(outcome === 413 || outcome === "connection cut", `the oversized request was answered ${outcome}`);
  assert.deepEqual(charged, [], "it was not charged");
  assert.deepEqual(upstream.requests, [], "and it did not reach the provider");
  assert.deepEqual(gw.record().requests.map(r => [r.refusal, r.forwarded]), [[GATEWAY_REFUSALS.TOO_LARGE, false]]);
  // A request within the bound is still served by the same gateway.
  assert.equal((await post("gemini-4-carbon", body(ROOT.marker))).status, 200);
  assert.deepEqual(charged, ["root"]);
  // The bound is a positive whole number of bytes, or the gateway does not start.
  for (const maxBodyBytes of [0, -1, 1.5, "2048", null]) await assert.rejects(startModelGateway({ upstream: upstream.url, apiKey: KEY, root: ROOT, subagents: SUBS, maxBodyBytes }).then(g => g.close()), /maxBodyBytes/, `bound ${JSON.stringify(maxBodyBytes)}`);
});

test("only the generation calls of an allowed model are served: any other path or verb is refused", async t => {
  const { upstream, gw } = await setup(t);
  const h = { "x-goog-api-key": gw.token, "content-type": "application/json" };
  assert.equal((await fetch(`${gw.url}/v1beta/models`, { headers: h })).status, 404);
  assert.equal((await fetch(`${gw.url}/v1beta/models/gemini-4-carbon:embedContent`, { method: "POST", headers: h, body: "{}" })).status, 404);
  assert.equal((await fetch(`${gw.url}/upload/v1beta/files`, { method: "POST", headers: h, body: "{}" })).status, 404);
  assert.equal(upstream.requests.length, 0);
});

test("availability is asked of the provider with the controller's key: a model it serves, and one it does not", async t => {
  const { gw } = await setup(t, { models: { "gemini-4-carbon": { inputTokenLimit: 1048576, outputTokenLimit: 65536 } } });
  const yes = await gw.availability("gemini-4-carbon");
  assert.deepEqual({ available: yes.available, status: yes.status, input: yes.limits.input_token_limit, output: yes.limits.output_token_limit }, { available: true, status: 200, input: 1048576, output: 65536 });
  const no = await gw.availability("gemini-4-neon");
  assert.deepEqual({ available: no.available, status: no.status, kind: no.kind }, { available: false, status: 404, kind: "model_unavailable" });
  assert.deepEqual(gw.record().availability.map(a => [a.model, a.available]), [["gemini-4-carbon", true], ["gemini-4-neon", false]]);
});

// ---- PROTECTIONS TAKEN OVER FROM THE L-150 METERING RELAY (owner decision 2026-11-20, register L-724) ----------------
// The owner made this gateway the one mechanism and had the relay retired. What the relay protected and the gateway did
// not is tested here: where the real key may be sent, a session's own request count, its concurrency, its idle and
// lifetime bounds, the exact query a call may carry, a body that is not a request, a durable record of each request's
// outcome, and the session's own account for the seat.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const outcomeRows = file => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

test("the real key is forwarded only to a Google API host over https, or to a loopback provider: any other upstream is refused before the gateway starts, and the availability question is not asked of it", async () => {
  const start = upstream => startModelGateway({ upstream, apiKey: KEY, root: ROOT });
  for (const bad of ["https://evil.example.com", "http://generativelanguage.googleapis.com", "https://googleapis.com.evil.example", "https://user:pw@generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/?x=1", "not a url"]) {
    // A gateway that starts all the same is closed here, so that this test fails instead of holding the process open.
    const got = await start(bad).then(gw => gw.close().then(() => ({ code: "STARTED", message: "" })), e => e);
    assert.deepEqual([got.code, String(got.message).includes(KEY)], [GATEWAY_REFUSALS.UPSTREAM, false], bad);
  }
  for (const good of ["https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/", "http://127.0.0.1:9", "http://localhost:9"]) { const gw = await start(good); await gw.close(); }
  let asked = 0;
  const a = await providerAvailability({ upstream: "https://evil.example.com", apiKey: KEY, model: "gemini-4-carbon", fetchImpl: async () => { asked += 1; return new Response("{}"); } });
  assert.deepEqual([a.available, asked, /only to a Google API host/.test(a.why)], [false, 0, true]);
});

test("a session's own maximum request count is enforced on the wire, beside the caller's charge: the request past it is refused before it is charged or sent, and the count is of admissions, not of answers", async t => {
  const charged = [];
  const { upstream, gw, post } = await setup(t, { decide: ({ seq }) => (seq === 1 ? { status: 500, error: { code: 500, message: "boom", status: "INTERNAL" } } : { parts: [text("ok")] }),
    admit: info => { charged.push(info.n); }, over: { maxRequests: 2 } });
  assert.deepEqual([(await post("gemini-4-carbon", body(ROOT.marker))).status, (await post("gemini-4-carbon", body(ROOT.marker))).status], [500, 200], "a request the provider failed was still admitted: it counts");
  const third = await post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(third.status, 403, "the cap is final: not a status the SDK's harness retries");
  assert.match((await third.json()).error.message, /^PANTHEON_SESSION_CAP: the session has made 2 of its 2 permitted request\(s\)/);
  assert.deepEqual([charged.length, upstream.requests.length, gw.record().session_cap], [2, 2, { max_requests: 2, admitted: 2, refused: 1 }]);
  // A request whose CHARGE was refused was not made: it takes no unit of the session's count.
  let calls = 0;
  const one = await setup(t, { admit: () => { if (++calls === 1) throw Object.assign(new Error("refused once"), { code: "PROVIDER_LIMIT" }); }, over: { maxRequests: 1 } });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await one.post("gemini-4-carbon", body(ROOT.marker))).status);
  assert.deepEqual([statuses, one.upstream.requests.length], [[403, 200, 403], 1], "refused charge, then the one permitted request, then the cap");
});

test("a session's requests in flight are bounded: the one over the bound is refused, not charged and not sent, and the bound frees when a request ends", async t => {
  let release; const held = new Promise(r => { release = r; });
  const charged = [];
  // The scripted provider holds its answer until released, and never longer than two seconds: a gateway that does not
  // enforce the bound fails this test, it does not hang it.
  const { upstream, gw, post } = await setup(t, { decide: async () => { await Promise.race([held, sleep(2000)]); return { parts: [text("ok")] }; }, admit: () => { charged.push(1); }, over: { maxConcurrent: 1 } });
  t.after(() => release());
  const first = post("gemini-4-carbon", body(ROOT.marker));
  while (upstream.requests.length < 1) await sleep(5);
  const second = await post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(second.status, 429);
  assert.match((await second.json()).error.message, /^PANTHEON_SESSION_BUSY: the session has 1 request\(s\) in flight, its bound is 1/);
  assert.deepEqual([charged.length, upstream.requests.length], [1, 1]);
  release(); await (await first).text();
  assert.equal((await post("gemini-4-carbon", body(ROOT.marker))).status, 200, "the bound is of requests in flight");
});

test("a session idle past its bound, or past its lifetime while active, is over: the next request is refused, nothing is charged or sent, and the token is worth nothing afterwards", async t => {
  const charged = [];
  const idle = await setup(t, { admit: () => { charged.push("idle"); }, over: { idleMs: 60 } });
  assert.equal((await idle.post("gemini-4-carbon", body(ROOT.marker))).status, 200);
  await sleep(120);
  const late = await idle.post("gemini-4-carbon", body(ROOT.marker));
  assert.equal(late.status, 401, "expired is final: not a status the SDK's harness retries");
  assert.match((await late.json()).error.message, /^PANTHEON_SESSION_EXPIRED: the session was idle for more than 60 ms/);
  assert.equal((await idle.post("gemini-4-carbon", body(ROOT.marker))).status, 401, "an expired session stays expired");
  const life = await setup(t, { admit: () => { charged.push("life"); }, over: { lifetimeMs: 150, idleMs: 10_000 } });
  assert.equal((await life.post("gemini-4-carbon", body(ROOT.marker))).status, 200);
  await sleep(90);
  assert.equal((await life.post("gemini-4-carbon", body(ROOT.marker))).status, 200, "active, inside its lifetime");
  await sleep(90);
  const over = await life.post("gemini-4-carbon", body(ROOT.marker));
  assert.match((await over.json()).error.message, /^PANTHEON_SESSION_EXPIRED: the session is past its lifetime of 150 ms/);
  assert.deepEqual([charged, idle.upstream.requests.length, life.upstream.requests.length], [["idle", "life", "life"], 1, 2]);
});

test("a call carries exactly the query its verb takes: a stream may say alt=sse and nothing else, a whole answer says nothing; any other query is refused before it is charged", async t => {
  const charged = [];
  const { upstream, post } = await setup(t, { admit: () => { charged.push(1); } });
  for (const verb of ["streamGenerateContent?alt=json", "streamGenerateContent?alt=sse&key=abc", "streamGenerateContent?alt=sse&alt=sse", "generateContent?alt=sse", "generateContent?key=abc"]) {
    const r = await post("gemini-4-carbon", body(ROOT.marker), { verb });
    assert.equal(r.status, 404, verb);
    assert.match((await r.json()).error.message, /^PANTHEON_PATH_NOT_SERVED/, verb);
  }
  assert.deepEqual([charged.length, upstream.requests.length], [0, 0]);
  for (const verb of ["streamGenerateContent?alt=sse", "streamGenerateContent", "generateContent"]) assert.equal((await post("gemini-4-carbon", body(ROOT.marker), { verb })).status, 200, verb);
  assert.deepEqual(upstream.requests.map(r => r.path), ["/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse", "/v1beta/models/gemini-4-carbon:streamGenerateContent", "/v1beta/models/gemini-4-carbon:generateContent"]);
});

test("a body that is not a JSON object is not a request: it is refused before it is charged, and nothing is sent", async t => {
  const charged = [];
  const { upstream, gw } = await setup(t, { admit: () => { charged.push(1); } });
  for (const raw of ["not json", "[1,2]", "\"text\"", "null", ""]) {
    const r = await fetch(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gw.token }, body: raw });
    assert.equal(r.status, 400, JSON.stringify(raw));
    assert.match((await r.json()).error.message, /^PANTHEON_REQUEST_MALFORMED: the request body is not a JSON object/);
  }
  assert.deepEqual([charged.length, upstream.requests.length, gw.record().requests.map(r => r.refusal)], [0, 0, Array(5).fill(GATEWAY_REFUSALS.MALFORMED)]);
});

test("each request's outcome is written as it ends, to a record of its own that no count reads: an answered request, a refused one and one the provider failed; neither the key nor the token is in it", async t => {
  const dir = mkdtempSync(join(tmpdir(), "gw-outcomes-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run", "outcomes.jsonl");
  const { gw, post } = await setup(t, { decide: ({ seq }) => (seq === 2 ? QUOTA : { parts: [text("ok")] }), over: { outcomes: file } });
  await (await post("gemini-4-carbon", body(ROOT.marker))).text();
  assert.equal(outcomeRows(file).length, 1, "written when the request ended, not when the session did");
  await (await post("gemini-4-carbon", body(ROOT.marker))).text();
  await (await post("gemini-4-argon", body(ROOT.marker))).text();
  const rows = outcomeRows(file);
  assert.deepEqual(rows.map(r => [r.seq, r.model, r.class, r.forwarded, r.status, r.refusal, r.served_model, r.usage?.total_token_count ?? null]), [
    [1, "gemini-4-carbon", "root", true, 200, null, "gemini-4-carbon", 115], [2, "gemini-4-carbon", "root", true, 429, null, null, null], [3, "gemini-4-argon", "root", false, 403, GATEWAY_REFUSALS.MODEL, null, null]]);
  assert.ok(rows.every(r => r.schema === "pantheon.gateway-outcome/v1" && typeof r.at === "string"));
  const text_ = readFileSync(file, "utf8");
  assert.ok(!text_.includes(KEY) && !text_.includes(gw.token));
});

test("a websocket upgrade is not a transport the gateway carries: it is refused and recorded, and nothing is sent", async t => {
  const { upstream, gw } = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent`, { method: "GET", headers: { connection: "Upgrade", upgrade: "websocket", "x-goog-api-key": gw.token, "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    req.on("response", res => { res.resume(); resolve(res.statusCode); }); req.on("upgrade", res => resolve(res.statusCode)); req.on("error", reject); req.end();
  });
  assert.notEqual(status, 101);
  assert.deepEqual([upstream.requests.length, gw.record().requests.map(r => r.refusal)], [0, [GATEWAY_REFUSALS.PATH]]);
});

test("the session's own account is served to the holder of its token and to nobody else: it is no provider request, and it is not counted as one", async t => {
  const { upstream, gw } = await setup(t, { over: { status: () => ({ admitted: 3, refused: [{ code: "METERED_GEMINI_BUDGET_EXHAUSTED" }] }) } });
  const get = token => fetch(`${gw.url}/_pantheon/session`, { headers: token ? { "x-goog-api-key": token } : {} });
  const ok = await get(gw.token);
  assert.deepEqual([ok.status, await ok.json()], [200, { admitted: 3, refused: [{ code: "METERED_GEMINI_BUDGET_EXHAUSTED" }] }]);
  assert.equal((await get("wrong")).status, 401);
  assert.equal((await get(null)).status, 401);
  assert.deepEqual([upstream.requests.length, gw.record().totals.received], [0, 2], "the two callers without the token are on the record; the account itself is not a request");
  const none = await setup(t);
  assert.equal((await fetch(`${none.gw.url}/_pantheon/session`, { headers: { "x-goog-api-key": none.gw.token } })).status, 404, "a gateway given no account serves none");
});

// ---- Findings of the independent review of f4bd6bc (2026-11-20) ---------------------------------------------------------
test("THE REAL KEY DOES NOT FOLLOW A REDIRECT: an upstream that answers 3xx is not followed to another origin; the session is given the 3xx and the key reaches no one else", async t => {
  // Finding 1: the upstream is checked when the gateway starts, and a 307 then carried the key to an origin nobody checked.
  const seen = [];
  const elsewhere = createServer((req, res) => { seen.push(req.headers["x-goog-api-key"] ?? null); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise(r => elsewhere.listen(0, "127.0.0.1", r));
  const hop = createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://localhost:${elsewhere.address().port}${req.url}` }); res.end(); });
  await new Promise(r => hop.listen(0, "127.0.0.1", r));
  const charged = [];
  const gw = await startModelGateway({ upstream: `http://127.0.0.1:${hop.address().port}`, apiKey: KEY, root: ROOT, subagents: SUBS, admit: i => { charged.push(i.n); } });
  t.after(async () => { await gw.close(); await new Promise(r => hop.close(r)); await new Promise(r => elsewhere.close(r)); });
  const r = await fetch(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gw.token }, body: JSON.stringify(body(ROOT.marker)), redirect: "manual" });
  assert.deepEqual([r.status, seen, charged], [307, [], [1]], "the redirect is the session's answer; nothing was sent on, and the one request made was charged");
  const a = await providerAvailability({ upstream: `http://127.0.0.1:${hop.address().port}`, apiKey: KEY, model: "gemini-4-carbon" });
  assert.deepEqual([a.available, seen], [false, []], "the availability probe does not follow it either");
});

test("A REQUEST THAT WAS CHARGED AND THEN FAILED IS NOT A REFUSAL: the session's record says it was charged", async t => {
  // Finding 3: a request admitted and charged whose upstream was unreachable was accounted as refused, "nothing was charged".
  const charged = [];
  const dead = createServer(); await new Promise(r => dead.listen(0, "127.0.0.1", r)); const port = dead.address().port; await new Promise(r => dead.close(r));
  const gw = await startModelGateway({ upstream: `http://127.0.0.1:${port}`, apiKey: KEY, root: ROOT, subagents: SUBS, admit: i => { charged.push(i.n); }, maxRequests: 1 });
  t.after(() => gw.close());
  const post = () => fetch(`${gw.url}/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gw.token }, body: JSON.stringify(body(ROOT.marker)) });
  const statuses = [(await post()).status, (await post()).status];
  assert.deepEqual([statuses, charged], [[502, 403], [1]], "the first was charged and failed upstream; the second was refused by the cap, uncharged");
  assert.deepEqual(gw.record().requests.map(x => [x.seq, x.charged === true, x.refusal]), [[1, true, "PANTHEON_UPSTREAM_FAILED"], [2, false, "PANTHEON_SESSION_CAP"]]);
});
