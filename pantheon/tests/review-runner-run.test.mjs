import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main, EXIT, PLAN_SCHEMA } from "../src/review-runner/index.mjs";
import { fixtureRepo, fakeFetch, capture, deps, LIMITS, FAKE_KEY, sh, mkdtemp, cleanup } from "./review-runner-helper.mjs";

after(cleanup);

const FINAL = "# Findings\n\n1. holds — `a.mjs:1`\n\n## Blockers for a live run\n\nNone.\n\nModel: test-model\n";
const ENV_FOR = { openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", gemini: "GEMINI_API_KEY" };
const ASSIGNMENT_FOR = { openai: "2", xai: "3", gemini: "1" };

// Scripted vendor responses: two tool calls (a source read and a test run: the coverage gate of L-501 requires both for
// a complete review, self-audit round 3, assignment 4 (sealed fe2a612)), then a final answer. The test runs in the
// verify jail (L-404 sibling: tools.mjs).
const TEST_FILE = "pantheon/tests/other.test.mjs";
const SCRIPTS = {
  openai: (served = "gpt-6-astra-2026-11-01") => [
    () => ({ json: { id: "resp_1", model: served, status: "completed", usage: { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } },
      output: [{ type: "reasoning", id: "rs_1" }, { type: "function_call", call_id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) }, { type: "function_call", call_id: "call_2", name: "run_tests", arguments: JSON.stringify({ files: [TEST_FILE] }) }] } }),
    () => ({ json: { id: "resp_2", model: served, status: "completed", usage: { input_tokens: 200, output_tokens: 20, output_tokens_details: { reasoning_tokens: 6 } },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: FINAL }] }] } }),
  ],
  xai: (served = "grok-4.7-0105") => [
    () => ({ json: { id: "c1", model: served, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "tc_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }, { id: "tc_2", type: "function", function: { name: "run_tests", arguments: JSON.stringify({ files: [TEST_FILE] }) } }] } }] } }),
    () => ({ json: { id: "c2", model: served, usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: FINAL } }] } }),
  ],
  gemini: (served = "gemini-4-carbon-001") => [
    () => ({ json: { modelVersion: served, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "hello.txt" } }, thoughtSignature: "sig" }, { functionCall: { name: "run_tests", args: { files: [TEST_FILE] } } }] } }] } }),
    () => ({ json: { modelVersion: served, usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 20, totalTokenCount: 220 },
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: FINAL }] } }] } }),
  ],
};

async function run({ vendor, script, args = [], env, repo, out: outDir, assignment }) {
  repo ??= await fixtureRepo();
  outDir ??= await mkdtemp(join(tmpdir(), "rr-out-"));
  const out = capture(), fetch = fakeFetch(script);
  const d = await deps({ root: repo.root, env: env ?? { [ENV_FOR[vendor]]: FAKE_KEY }, fetch, out });
  // A Google reviewer over the API is primary Gemini API execution, OFF by default (register L-136): these runs opt in
  // explicitly, with a budget, as the owner would.
  const optIn = vendor === "gemini" ? ["--gemini-api-primary", "100"] : [];
  const code = await main(["--assignment", assignment ?? ASSIGNMENT_FOR[vendor], "--commit", repo.commit, ...LIMITS, "--out", outDir, ...optIn, ...args], d);
  const files = await readdir(outDir);
  const read = async f => readFile(join(outDir, f), "utf8");
  return { code, out, fetch, d, repo, outDir, files, read };
}

for (const vendor of ["openai", "xai", "gemini"]) {
  test(`${vendor}: tool round-trip then final answer; served model and usage recorded; key only in the auth header`, async () => {
    const r = await run({ vendor, script: SCRIPTS[vendor]() });
    assert.equal(r.code, EXIT.complete, r.out.err);
    assert.equal(r.fetch.calls.length, 2);
    const [c1, c2] = r.fetch.calls;
    const h = c1.init.headers;
    if (vendor === "gemini") {
      assert.equal(c1.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:generateContent");
      assert.equal(h["x-goog-api-key"], FAKE_KEY);
      assert.equal(h.authorization, undefined);
      assert.ok(c1.body.systemInstruction.parts[0].text.startsWith("# Harness"));
      assert.equal(c1.body.generationConfig.maxOutputTokens, 1000);
      assert.deepEqual(c1.body.tools[0].functionDeclarations.map(f => f.name), ["list_files", "read_file", "grep", "write_test", "run_tests", "run_suite"]);
      const last = c2.body.contents.at(-1);
      assert.equal(last.parts[0].functionResponse.name, "read_file");
      assert.match(last.parts[0].functionResponse.response.output, /1\tline one/);
      assert.equal(c2.body.contents.at(-2).parts[0].thoughtSignature, "sig"); // model parts replayed unchanged
    } else {
      assert.equal(h.authorization, `Bearer ${FAKE_KEY}`);
      assert.equal(h["x-goog-api-key"], undefined);
    }
    if (vendor === "openai") {
      assert.equal(c1.url, "https://api.openai.com/v1/responses");
      assert.equal(c1.body.model, "gpt-6-astra");
      assert.ok(c1.body.instructions.startsWith("# Harness"));
      assert.equal(c1.body.max_output_tokens, 1000);
      assert.equal(c1.body.input[0].role, "user");
      assert.equal(c2.body.previous_response_id, "resp_1");
      assert.equal(c2.body.input[0].type, "function_call_output");
      assert.equal(c2.body.input[0].call_id, "call_1");
      assert.match(c2.body.input[0].output, /2\tline two/);
    }
    if (vendor === "xai") {
      assert.equal(c1.url, "https://api.x.ai/v1/chat/completions");
      assert.equal(c1.body.model, "grok-4.7");
      assert.equal(c1.body.messages[0].role, "system");
      assert.equal(c2.body.messages.at(-1).role, "tool");
      // The whole conversation sent back: system, the same brief, the assistant's tool calls replayed unchanged (a tool
      // message must follow the assistant message that called it), then one result per call, in call order.
      const m2 = c2.body.messages;
      assert.deepEqual(m2.map(m => [m.role, m.tool_call_id]), [["system", undefined], ["user", undefined], ["assistant", undefined], ["tool", "tc_1"], ["tool", "tc_2"]]);
      assert.deepEqual([m2[0], m2[1]], c1.body.messages, "the system prompt and the brief are resent unchanged");
      assert.deepEqual(m2[2], { role: "assistant", content: null, tool_calls: SCRIPTS.xai()[0]().json.choices[0].message.tool_calls });
      assert.match(m2[3].content, /^1\tline one\n2\tline two\n/, "tc_1: the read_file result");
      assert.match(m2[4].content, /^exit_code: 0\n/, "tc_2: the run_tests result");
    }
    const md = r.files.find(f => f.endsWith(".md")), tj = r.files.find(f => f.endsWith(".transcript.json"));
    const lab = { openai: "openai", xai: "xai", gemini: "google" }[vendor];
    assert.equal(md, `findings-${ASSIGNMENT_FOR[vendor]}-${lab}.md`);
    const findings = await r.read(md), transcriptText = await r.read(tj);
    const [header, body] = findings.split("<!-- reviewer's final message, verbatim, follows -->\n\n");
    assert.equal(body, FINAL);
    const served = { openai: "gpt-6-astra-2026-11-01", xai: "grok-4.7-0105", gemini: "gemini-4-carbon-001" }[vendor];
    assert.match(header, new RegExp(`served_model: \`${served.replace(/\./g, "\\.")}\``));
    assert.match(header, /status: complete/);
    assert.match(header, /provider_calls: 2/);
    assert.match(header, /tool_calls: 2/);
    // THE COVERAGE GATE (L-501): the runner's own record of the read and the jailed test run.
    assert.match(header, /- coverage: `\{"source_reads":1,"denied_reads":0,"tests_run":1,"tests_allowed":true\}`, gate passed; files read \(sample\): `hello\.txt`\n/);
    assert.match(header, new RegExp(`commit: \`${r.repo.commit}\``));
    const sum = { openai: '"input_tokens":300,"output_tokens":30,"output_tokens_details":{"reasoning_tokens":10}', xai: '"prompt_tokens":300,"completion_tokens":30,"total_tokens":330', gemini: '"promptTokenCount":300,"candidatesTokenCount":30,"totalTokenCount":330' }[vendor];
    assert.ok(header.includes(sum), header);
    assert.ok(header.includes(createHash("sha256").update(transcriptText).digest("hex")));
    for (const s of [findings, transcriptText, r.out.out, r.out.err]) assert.equal(s.includes(FAKE_KEY), false);
    const t = JSON.parse(transcriptText);
    assert.equal(t.status, "complete");
    assert.deepEqual(t.events.map(e => e.type), ["provider_call", "tool_call", "tool_call", "provider_call"]);
    const tc = t.events[1];
    assert.equal(tc.name, "read_file");
    assert.equal(tc.outcome, "ok");
    assert.match(tc.result_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([t.events[2].name, t.events[2].outcome, t.events[2].exit_code], ["run_tests", "ok", 0], "the test ran (in the verify jail) and passed");
    assert.deepEqual([t.coverage.source_reads, t.coverage.tests_run, t.coverage_gate.ok], [1, 1, true]);
    // the disposable worktree is gone and git no longer lists it
    assert.deepEqual(await readdir(r.d.tmpBase), []);
    const wl = await sh("git", ["-C", r.repo.root, "worktree", "list"]);
    assert.equal(wl.trim().split("\n").length, 1);
  });
}

test("a response naming no served model records served_model null and says so", async () => {
  const s = SCRIPTS.openai(); const strip = f => () => { const r = f(); delete r.json.model; return r; };
  const r = await run({ vendor: "openai", script: s.map(strip) });
  assert.equal(r.code, EXIT.complete);
  const md = await r.read("findings-2-openai.md");
  assert.match(md, /served_model: null \(the provider's response named no served model; the requested name is not substituted\)/);
  assert.doesNotMatch(md, /served_model: `gpt-6-astra`/);
});

test("max turns: stops with a recorded reason, status incomplete, exit 3", async () => {
  const r = await run({ vendor: "openai", script: SCRIPTS.openai(), args: ["--max-turns", "1"] });
  assert.equal(r.code, EXIT.incomplete);
  assert.equal(r.fetch.calls.length, 1);
  const md = await r.read("findings-2-openai.md");
  assert.match(md, /status: incomplete/);
  assert.match(md, /stop_reason: max_turns reached \(1\)/);
  assert.ok(md.endsWith("<!-- reviewer's final message, verbatim, follows -->\n\n"));
});

test("max tool calls: stops before the call over the limit, exit 3", async () => {
  const two = () => ({ json: { id: "r", model: "m", status: "completed", output: [
    { type: "function_call", call_id: "a", name: "read_file", arguments: '{"path":"hello.txt"}' },
    { type: "function_call", call_id: "b", name: "read_file", arguments: '{"path":"hello.txt"}' }] } });
  const r = await run({ vendor: "openai", script: [two], args: ["--max-tool-calls", "1"] });
  assert.equal(r.code, EXIT.incomplete);
  const md = await r.read("findings-2-openai.md");
  assert.match(md, /stop_reason: max_tool_calls reached \(1\)/);
  assert.match(md, /tool_calls: 1/);
});

test("429 is retried once with backoff; a second 5xx stops with a redacted message", async () => {
  const s = SCRIPTS.openai();
  const r = await run({ vendor: "openai", script: [() => ({ status: 429, headers: { "retry-after": "2" }, json: { error: { message: "slow down" } } }), ...s] });
  assert.equal(r.code, EXIT.complete);
  assert.equal(r.fetch.calls.length, 3);
  assert.deepEqual(r.d.sleeps, [2000]);
  const t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.equal(t.events[0].http_status, 429);
  assert.equal(t.provider_calls, 3);

  const err = () => ({ status: 500, json: { error: { message: `boom for key ${FAKE_KEY}` } } });
  const r2 = await run({ vendor: "openai", script: [err, err, err] });
  assert.equal(r2.code, EXIT.incomplete);
  assert.equal(r2.fetch.calls.length, 2);
  const md = await r2.read("findings-2-openai.md");
  assert.match(md, /stop_reason: HTTP 500: boom for key \[REDACTED\]/);
  assert.equal(md.includes(FAKE_KEY), false);
  assert.equal((await r2.read("findings-2-openai.transcript.json")).includes(FAKE_KEY), false);
});

test("--dry-run prints the plan, makes no provider call and needs no key", async () => {
  const repo = await fixtureRepo();
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: repo.root, env: {}, fetch, out });
  const code = await main(["--assignment", "4", "--commit", repo.commit, ...LIMITS, "--dry-run"], d);
  assert.equal(code, EXIT.complete, out.err);
  assert.equal(fetch.calls.length, 0);
  const plan = JSON.parse(out.out);
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.provider_calls, 0);
  assert.equal(plan.vendor, "openai");
  assert.equal(plan.model, "gpt-6.1-sol");
  assert.deepEqual(plan.key, { env: "OPENAI_API_KEY", present: false, sent_as: "Authorization: Bearer" });
  assert.deepEqual(plan.tool_permissions.tools, ["list_files", "read_file", "grep", "run_tests"]);
  assert.deepEqual(plan.tool_permissions.run_tests.files, ["pantheon/tests/agy-fixture.test.mjs", "pantheon/tests/pipeline-a2a.test.mjs"]);
  assert.equal(plan.request.system.sha256, createHash("sha256").update(plan.request.system.text).digest("hex"));
  assert.equal(plan.request.brief.sha256, createHash("sha256").update(plan.request.brief.text).digest("hex"));
  assert.deepEqual(plan.withheld_from_worktree, ["docs/reviews/2026-11-18-independent-review/findings-4-openai.md"]);
  assert.equal(plan.request.brief.text.includes("PRIOR-FINDINGS-UNIQUE-MARKER"), false);
  assert.equal(plan.request.system.text.includes("PRIOR-FINDINGS-UNIQUE-MARKER"), false);
  assert.deepEqual(await readdir(d.tmpBase), []);
});

test("refusals and usage errors: missing key, missing limit, unknown commit, existing findings", async () => {
  const repo = await fixtureRepo();
  // missing key: exit 1, no call
  let r = await run({ vendor: "openai", script: [], env: {}, repo });
  assert.equal(r.code, EXIT.refused);
  assert.equal(r.fetch.calls.length, 0);
  assert.match(r.out.err, /OPENAI_API_KEY is not set/);
  // missing limit: exit 2
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: repo.root, fetch, out });
  assert.equal(await main(["--via", "api", "--assignment", "2", "--commit", repo.commit, "--max-turns", "1", "--max-tool-calls", "1", "--timeout-s", "1"], d), EXIT.usage);
  assert.match(out.err, /--max-output-tokens is required/);
  assert.equal(await main(["--assignment", "5", "--commit", repo.commit, ...LIMITS], d), EXIT.usage);
  assert.equal(await main(["--assignment", "2", "--commit", "abc", ...LIMITS], d), EXIT.usage);
  // unknown commit: exit 1
  assert.equal(await main(["--assignment", "2", "--commit", "f".repeat(40), ...LIMITS, "--dry-run"], d), EXIT.refused);
  // above the cited output limit for the model: exit 2
  assert.equal(await main(["--via", "api", "--assignment", "2", "--commit", repo.commit, "--max-turns", "1", "--max-tool-calls", "1", "--max-output-tokens", "999999", "--timeout-s", "1", "--dry-run"], d), EXIT.usage);
  assert.equal(fetch.calls.length, 0);
  // existing findings: exit 1 unless --force
  const outDir = await mkdtemp(join(tmpdir(), "rr-out-"));
  await writeFile(join(outDir, "findings-2-openai.md"), "EXISTING\n");
  r = await run({ vendor: "openai", script: SCRIPTS.openai(), repo, out: outDir });
  assert.equal(r.code, EXIT.refused);
  assert.equal(r.fetch.calls.length, 0);
  assert.equal(await readFile(join(outDir, "findings-2-openai.md"), "utf8"), "EXISTING\n");
  r = await run({ vendor: "openai", script: SCRIPTS.openai(), repo, out: outDir, args: ["--force"] });
  assert.equal(r.code, EXIT.complete);
});

test("the reviewer cannot read another reviewer's findings in the worktree", async () => {
  const call = () => ({ json: { id: "r1", model: "m", status: "completed", output: [
    { type: "function_call", call_id: "a", name: "read_file", arguments: JSON.stringify({ path: "docs/reviews/2026-11-18-independent-review/findings-4-openai.md" }) },
    { type: "function_call", call_id: "b", name: "grep", arguments: JSON.stringify({ pattern: "PRIOR-FINDINGS" }) }] } });
  const fin = () => ({ json: { id: "r2", model: "m", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] } });
  const r = await run({ vendor: "openai", script: [call, fin] });
  // THE COVERAGE GATE (L-501, self-audit round 3, assignment 4 (sealed fe2a612)): a denied read, no source read and no
  // test make this "done" an incomplete review, whatever its text says.
  assert.equal(r.code, EXIT.incomplete);
  assert.match(r.out.err, /run-review: incomplete \(coverage gate: no source file was read; 1 read\(s\) were denied by the hook or the sandbox; no test command ran although the testing limit allows tests \(the transport ended with: final answer\)\)/);
  const outputs = r.fetch.calls[1].body.input.map(i => i.output);
  assert.match(outputs[0], /refused/);
  assert.equal(outputs[1], "(no matches)");
  assert.equal(JSON.stringify(r.fetch.calls).includes("PRIOR-FINDINGS-UNIQUE-MARKER"), false);
});

test("--keep leaves the worktree in place", async () => {
  const r = await run({ vendor: "xai", script: SCRIPTS.xai(), args: ["--keep"] });
  assert.equal(r.code, EXIT.complete);
  const kept = await readdir(r.d.tmpBase);
  assert.equal(kept.length, 1);
  assert.ok((await readdir(join(r.d.tmpBase, kept[0], "worktree"))).includes("hello.txt"));
  await sh("git", ["-C", r.repo.root, "worktree", "remove", "--force", join(r.d.tmpBase, kept[0], "worktree")]);
});

test("--via api --reviewer google:<model> on assignment 3: the Gemini endpoint and key, the assignment's own brief, tools and withheld files; findings-3-google records the substitution", async () => {
  const repo = await fixtureRepo();
  const dry = await run({ vendor: "gemini", script: [], repo, assignment: "3", args: ["--dry-run", "--reviewer", "google:gemini-4-carbon"] });
  assert.equal(dry.code, EXIT.complete, dry.out.err);
  const p = JSON.parse(dry.out.out);
  const base = JSON.parse((await run({ vendor: "xai", script: [], repo, assignment: "3", args: ["--dry-run"] })).out.out);
  assert.deepEqual([p.vendor, p.lab, p.model, p.reviewer_override, p.reviewer, p.key.env], ["gemini", "Google", "gemini-4-carbon", true, "google:gemini-4-carbon", "GEMINI_API_KEY"]);
  assert.deepEqual(p.default_reviewer, { lab: "xAI", vendor: "xai", model: base.model });
  assert.equal(p.endpoint, "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:generateContent");
  assert.match(p.out.findings, /findings-3-google\.md$/);
  for (const k of ["brief", "system", "tools"]) assert.equal(p.request[k].sha256, base.request[k].sha256, `the same ${k} as assignment 3's own reviewer`);
  assert.deepEqual([p.tool_permissions, p.withheld_from_worktree], [base.tool_permissions, base.withheld_from_worktree]);
  const r = await run({ vendor: "gemini", script: SCRIPTS.gemini(), repo, assignment: "3", args: ["--reviewer", "google:gemini-4-carbon"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.ok(r.files.includes("findings-3-google.md"), r.files.join(","));
  const md = await r.read("findings-3-google.md");
  assert.match(md, /^- lab: Google$/m);
  assert.match(md, /^- default_reviewer: xAI, `[^`]+` \(the README's reviewer for this assignment\)$/m);
  assert.match(md, /^- reviewer_override: true \(--reviewer google:gemini-4-carbon\)$/m);
  const t = JSON.parse(await r.read("findings-3-google.transcript.json"));
  assert.deepEqual([t.reviewer_override, t.reviewer, t.default_reviewer.lab], [true, "google:gemini-4-carbon", "xAI"]);
  const bad = await run({ vendor: "gemini", script: [], repo, assignment: "3", args: ["--dry-run", "--reviewer", "meta:llama"] });
  assert.equal(bad.code, EXIT.usage); assert.match(bad.out.err, /unknown lab "meta"/);
});
