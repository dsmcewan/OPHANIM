// The xAI SDK route of the API runner (--via api --xai-transport sdk): the reviewer's Chat Completions requests go
// through the official `openai` JavaScript SDK pointed at xAI, instead of the runner's own fetch. Every test here uses a
// SCRIPTED SDK client (deps.xaiClient): no network, no key, no provider call.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT, XAI_SDK } from "../src/review-runner/index.mjs";
import { fixtureRepo, capture, deps, FAKE_KEY, mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { APIError, APIConnectionTimeoutError } from "openai";

after(cleanup);

const FINAL = "# Findings\n\n1. holds — `a.mjs:1`\n\n## Tests run\n\npantheon/tests/other.test.mjs: pass\n\n## Unresolved questions\n\nNone.\n";
const TEST_FILE = "pantheon/tests/other.test.mjs";
const SDK_LIMITS = ["--via", "api", "--xai-transport", "sdk", "--max-turns", "6", "--max-tool-calls", "6", "--max-output-tokens", "1000", "--timeout-s", "30", "--max-wall-s", "600"];
const JAIL = (await sandboxAvailable("bwrap")).ok;

const toolTurn = (served, usage) => ({ id: "c1", model: served, usage,
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
    { id: "tc_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } },
    { id: "tc_2", type: "function", function: { name: "run_tests", arguments: JSON.stringify({ files: [TEST_FILE] }) } }] } }] });
const finalTurn = (served, usage) => ({ id: "c2", model: served, usage, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: FINAL } }] });

/** An SDK error as the `openai` package raises it: a status, headers and an error body (APIError's shape). */
export function sdkError(status, message, { headers = {}, name = "APIError" } = {}) {
  return Object.assign(new Error(`${status} ${message}`), { name, status, headers, error: { message } });
}

/**
 * A scripted stand-in for `new OpenAI({...})`: records the options it was built with and every
 * chat.completions.create(body, options) call; each step returns a completion or throws.
 */
export function fakeXaiClient(steps) {
  const made = [], calls = [];
  const factory = opts => {
    made.push(opts);
    return { chat: { completions: { create: async (body, reqOpts) => {
      calls.push({ body: JSON.parse(JSON.stringify(body)), opts: reqOpts ?? null });
      const step = steps[calls.length - 1];
      if (!step) throw new Error(`fake xAI SDK: no scripted response for call ${calls.length}`);
      return step(body, reqOpts);
    } } } };
  };
  return Object.assign(factory, { made, calls });
}

async function run({ steps, args = [], env, fetchCalls = [], extra = {} } = {}) {
  const repo = await fixtureRepo();
  const outDir = await mkdtemp(join(tmpdir(), "rr-sdk-out-"));
  const out = capture();
  const client = fakeXaiClient(steps);
  const fetch = async (...a) => { fetchCalls.push(a); throw new Error("fetch must not be used on the SDK route"); };
  const d = await deps({ root: repo.root, env: env ?? { XAI_API_KEY: FAKE_KEY }, fetch, out });
  d.xaiClient = client;
  Object.assign(d, extra);
  const code = await main(["--assignment", "3", "--commit", repo.commit, ...SDK_LIMITS, "--out", outDir, ...args], d);
  const files = await readdir(outDir).catch(() => []);
  const read = async f => readFile(join(outDir, f), "utf8");
  const transcript = files.includes("findings-3-xai.transcript.json") ? JSON.parse(await read("findings-3-xai.transcript.json")) : null;
  return { code, out, client, fetchCalls, d, repo, outDir, files, read, transcript };
}

test("XAI SDK: the SDK client is built for xAI only (base URL, key, no SDK retries, the per-call timeout); the run loops tools to a final answer", { skip: !JAIL && "bwrap unavailable" }, async () => {
  const fetchCalls = [];
  const r = await run({ fetchCalls, steps: [() => toolTurn("grok-4.7", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }),
    () => finalTurn("grok-4.7", { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 })] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.equal(fetchCalls.length, 0, "the runner's own fetch is never used on the SDK route");
  assert.equal(r.client.made.length, 1);
  assert.deepEqual(r.client.made[0], { apiKey: FAKE_KEY, baseURL: XAI_SDK.base_url, maxRetries: 0, timeout: 30_000 });
  assert.equal(XAI_SDK.base_url, "https://api.x.ai/v1");
  assert.equal(r.client.calls.length, 2);
  const [c1, c2] = r.client.calls;
  assert.equal(c1.body.model, "grok-4.7");
  assert.equal(c1.body.messages[0].role, "system");
  assert.equal(c1.body.max_completion_tokens, 1000);
  assert.deepEqual(c2.body.messages.map(m => [m.role, m.tool_call_id]), [["system", undefined], ["user", undefined], ["assistant", undefined], ["tool", "tc_1"], ["tool", "tc_2"]]);
  assert.ok(c1.opts?.signal, "every SDK call carries an abort signal (the per-call timeout)");
  const t = r.transcript;
  assert.equal(t.via, "api");
  assert.equal(t.transport, "xai-sdk");
  assert.equal(t.sdk.package, "openai");
  assert.match(t.sdk.version, /^\d+\.\d+\.\d+/);
  assert.equal(t.sdk.method, "chat.completions.create");
  assert.equal(t.sdk.request_path, "/v1/chat/completions");
  assert.equal(t.status, "complete");
  assert.deepEqual(t.served_models, ["grok-4.7"]);
  assert.equal(t.provider_calls, 2);
  assert.ok(t.coverage_gate.ok, JSON.stringify(t.coverage_gate));
  assert.equal(t.coverage.tests_run, 1);
  assert.deepEqual(t.worktree_check.violations, []);
  // The bound brief, by digest: what the coordinator compares with the binding.
  assert.match(t.prompt.readme_sha256, /^[0-9a-f]{64}$/);
  assert.match(t.prompt.assignment_sha256, /^[0-9a-f]{64}$/);
  assert.equal(t.prompt.harness_template.sha256, t.hashes.harness_template);
  // Usage recorded per call; no cost field was supplied, so cost is UNAVAILABLE, never a zero.
  const calls = t.events.filter(e => e.type === "provider_call");
  assert.deepEqual(calls.map(e => e.transport), ["xai-sdk", "xai-sdk"]);
  assert.deepEqual(calls.map(e => e.cost), [{ reported: false, value: null, field: null }, { reported: false, value: null, field: null }]);
  assert.deepEqual(t.cost_totals, { reported_calls: 0, unreported_calls: 2, value: null, field: null });
  assert.equal(JSON.stringify(t).includes(FAKE_KEY), false, "the key never reaches the transcript");
  const md = await r.read("findings-3-xai.md");
  assert.match(md, /- transport: xai-sdk \(openai@\d/);
  assert.match(md, /- cost: unavailable \(no call reported a cost\)/);
});

test("XAI SDK: a reported cost of zero is a reading, distinct from a call that reported none", { skip: !JAIL && "bwrap unavailable" }, async () => {
  const r = await run({ steps: [() => toolTurn("grok-4.7", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_in_usd_ticks: 0 }),
    () => finalTurn("grok-4.7", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const calls = r.transcript.events.filter(e => e.type === "provider_call");
  assert.deepEqual(calls[0].cost, { reported: true, value: 0, field: "cost_in_usd_ticks" });
  assert.deepEqual(calls[1].cost, { reported: false, value: null, field: null });
  assert.deepEqual(r.transcript.cost_totals, { reported_calls: 1, unreported_calls: 1, value: 0, field: "cost_in_usd_ticks" });
  assert.match(await r.read("findings-3-xai.md"), /- cost: 0 cost_in_usd_ticks over 1 call\(s\) that reported one; 1 call\(s\) reported none/);
});

test("XAI SDK: a 429 is retried once inside max_turns (no SDK-level retry); a second 5xx stops, kept as the outcome", async () => {
  const r = await run({ steps: [() => { throw sdkError(429, "slow down", { headers: { "retry-after": "2" } }); }, () => { throw sdkError(503, "unavailable"); }] });
  assert.equal(r.code, EXIT.incomplete);
  assert.equal(r.client.calls.length, 2);
  assert.deepEqual(r.d.sleeps, [2000]);
  const calls = r.transcript.events.filter(e => e.type === "provider_call");
  assert.deepEqual(calls.map(e => [e.attempt, e.http_status, e.sdk_error]), [[1, 429, "APIError"], [2, 503, "APIError"]]);
  assert.equal(r.transcript.provider_calls, 2);
  assert.match(r.transcript.stop_reason, /HTTP 503: unavailable/);
  assert.equal(r.transcript.status, "incomplete");
});

test("XAI SDK: the retry never exceeds max_turns", async () => {
  const r = await run({ args: ["--max-turns", "1"], steps: [() => { throw sdkError(429, "slow down"); }] });
  assert.equal(r.code, EXIT.incomplete);
  assert.equal(r.client.calls.length, 1, "with max_turns 1 the 429 is not retried");
  assert.equal(r.transcript.provider_calls, 1);
});

test("XAI SDK: a timeout and a connection failure are recorded outcomes, never a final answer", async () => {
  for (const [name, message] of [["APIConnectionTimeoutError", "Request timed out."], ["APIConnectionError", "Connection error."]]) {
    const r = await run({ steps: [() => { throw Object.assign(new Error(message), { name }); }] });
    assert.equal(r.code, EXIT.incomplete, name);
    const ev = r.transcript.events.find(e => e.type === "provider_call");
    assert.equal(ev.sdk_error, name);
    assert.match(r.transcript.stop_reason, new RegExp(`network error: ${name}: ${message.replace(".", "\\.")}`));
    assert.equal(r.transcript.status, "incomplete");
  }
});

test("XAI SDK: a response naming no served model is recorded as null (missing provenance), never the requested name", { skip: !JAIL && "bwrap unavailable" }, async () => {
  const r = await run({ steps: [() => toolTurn(undefined, null), () => finalTurn(undefined, null)] });
  assert.deepEqual(r.transcript.served_models, [null]);
});

test("XAI SDK: the whole run is bounded by --max-wall-s (checked before every provider call)", async () => {
  let t = Date.parse("2026-11-22T00:00:00Z");
  const r = await run({ args: ["--max-wall-s", "60"], extra: { now: () => new Date(t) },
    steps: [() => { t += 61_000; return toolTurn("grok-4.7", null); }, () => finalTurn("grok-4.7", null)] });
  assert.equal(r.code, EXIT.incomplete);
  assert.equal(r.client.calls.length, 1, "no request is sent after the wall clock is spent");
  assert.match(r.transcript.stop_reason, /max_wall_s reached \(60\)/);
});

test("XAI SDK: a change to a source file in the review copy is a policy violation, and the review is incomplete", { skip: !JAIL && "bwrap unavailable" }, async () => {
  const tmpBase = await mkdtemp(join(tmpdir(), "rr-sdk-tmp-"));
  const edit = async () => {
    const [d] = (await readdir(tmpBase)).filter(n => n.startsWith("ophanim-review-"));
    await writeFile(join(tmpBase, d, "worktree", "hello.txt"), "tampered\n");
  };
  const r = await run({ extra: { tmpBase }, steps: [async () => { await edit(); return toolTurn("grok-4.7", null); }, () => finalTurn("grok-4.7", null)] });
  assert.equal(r.code, EXIT.incomplete);
  assert.deepEqual(r.transcript.worktree_check.violations, ["hello.txt"]);
  assert.equal(r.transcript.status, "incomplete");
  assert.match(r.transcript.stop_reason, /policy violation: the review copy changed outside \.review-tests\/: hello\.txt/);
});

test("XAI SDK: usage -- sdk is for an xAI reviewer only, needs --max-wall-s, and is an API-mode transport", async () => {
  const repo = await fixtureRepo();
  const out = capture();
  const d = await deps({ root: repo.root, env: { XAI_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY }, fetch: null, out });
  const base = ["--commit", repo.commit, "--max-turns", "6", "--max-tool-calls", "6", "--max-output-tokens", "1000", "--timeout-s", "30", "--dry-run"];
  assert.equal(await main(["--assignment", "2", "--via", "api", "--xai-transport", "sdk", "--max-wall-s", "60", ...base], d), EXIT.usage);
  assert.match(out.err, /--xai-transport sdk is for an xAI reviewer/);
  assert.equal(await main(["--assignment", "3", "--via", "api", "--xai-transport", "sdk", ...base], d), EXIT.usage);
  assert.match(out.err, /--max-wall-s is required with --xai-transport sdk/);
  assert.equal(await main(["--assignment", "3", "--via", "subscription", "--xai-transport", "sdk", "--max-wall-s", "60", "--commit", repo.commit, "--dry-run"], d), EXIT.usage);
  assert.match(out.err, /--xai-transport applies to --via api only/);
  assert.equal(await main(["--assignment", "3", "--via", "api", "--xai-transport", "grpc", "--max-wall-s", "60", ...base], d), EXIT.usage);
  // The plan of a dry run names the transport and the SDK, and sends nothing.
  const o2 = capture();
  const d2 = await deps({ root: repo.root, env: { XAI_API_KEY: FAKE_KEY }, fetch: null, out: o2 });
  d2.xaiClient = fakeXaiClient([]);
  assert.equal(await main(["--assignment", "3", "--via", "api", "--xai-transport", "sdk", "--max-wall-s", "60", ...base], d2), EXIT.complete, o2.err);
  const plan = JSON.parse(o2.out);
  assert.equal(plan.transport, "xai-sdk");
  assert.equal(plan.sdk.base_url, "https://api.x.ai/v1");
  assert.equal(plan.limits.max_wall_s, 60);
  assert.equal(d2.xaiClient.made.length, 0, "a dry run builds no client");
});

test("XAI SDK: --continue refuses a transcript of another transport (the old CLI result, or the fetch route) in either direction", async () => {
  const repo = await fixtureRepo();
  const outDir = await mkdtemp(join(tmpdir(), "rr-sdk-cont-"));
  const write = async (t, md = "# x\n") => {
    await writeFile(join(outDir, "findings-3-xai.transcript.json"), JSON.stringify({ schema: "ophanim.review-transcript/v1", assignment: 3, lab: "xAI", vendor: "xai", requested_model: "grok-4.7",
      commit: repo.commit, status: "incomplete", events: [], ...t }));
    await writeFile(join(outDir, "findings-3-xai.md"), md);
  };
  const go = async (extraArgs) => {
    const out = capture();
    const d = await deps({ root: repo.root, env: { XAI_API_KEY: FAKE_KEY }, fetch: null, out });
    d.xaiClient = fakeXaiClient([]);
    const code = await main(["--assignment", "3", "--commit", repo.commit, "--max-turns", "6", "--max-tool-calls", "6", "--max-output-tokens", "1000", "--timeout-s", "30", "--via", "api",
      "--out", outDir, "--continue", join(outDir, "findings-3-xai.transcript.json"), ...extraArgs], d);
    return { code, out, d };
  };
  await write({ via: "subscription", transport: "grok-cli" });
  let r = await go(["--xai-transport", "sdk", "--max-wall-s", "60"]);
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /refused/);
  await write({ via: "api" });
  r = await go(["--xai-transport", "sdk", "--max-wall-s", "60"]);
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /transport/);
  await write({ via: "api", transport: "xai-sdk" });
  r = await go([]);
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /transport/);
  assert.equal(r.d.xaiClient.calls.length, 0);
});

test("XAI SDK: the real SDK's own error classes -- a 429 with its Headers, then a timeout -- are recorded by class and status", async () => {
  const r = await run({ steps: [() => { throw APIError.generate(429, { error: { message: "rate limited" } }, "rate limited", new Headers({ "retry-after": "3" })); },
    () => { throw new APIConnectionTimeoutError(); }] });
  assert.equal(r.code, EXIT.incomplete);
  assert.deepEqual(r.d.sleeps, [3000], "Retry-After read from the SDK's Headers");
  const calls = r.transcript.events.filter(e => e.type === "provider_call");
  assert.deepEqual(calls.map(e => [e.attempt, e.http_status ?? null, e.sdk_error]), [[1, 429, "RateLimitError"], [2, null, "APIConnectionTimeoutError"]]);
  assert.match(r.transcript.stop_reason, /^network error: APIConnectionTimeoutError: Request timed out\./);
});
