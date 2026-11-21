// --continue <transcript>: resuming an incomplete review, with a fake fetch (API mode) and fake CLIs / the fake Codex
// SDK (subscription mode). What may be carried over is the reviewer's own earlier run of the same assignment and nothing else.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { APPENDIX_BEGIN, APPENDIX_END, CLI_CONTINUE_NOTE, CONTINUE_NOTE } from "../src/review-runner/continue.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { fixtureRepo, fakeFetch, capture, deps, LIMITS, FAKE_KEY, sh, mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";
import { fakeAgy } from "./fixtures/dispatch.mjs";

after(cleanup);

const FINAL = "# Findings\n\n1. holds\n\n## Blockers for a live run\n\nNone.\n";
const PROBE = 'import test from "node:test";\ntest("probe", () => {}); // RESTORED-PROBE-MARKER\n';
const sha = b => createHash("sha256").update(b).digest("hex");
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

async function api({ repo, outDir, vendor, n, script, args = [], commit }) {
  const env = { openai: { OPENAI_API_KEY: FAKE_KEY }, xai: { XAI_API_KEY: FAKE_KEY }, gemini: { GEMINI_API_KEY: FAKE_KEY } }[vendor];
  const out = capture(), fetch = fakeFetch(script);
  const d = await deps({ root: repo.root, env, fetch, out });
  // A Google reviewer over the API is primary Gemini API execution, OFF by default (register L-136): these runs opt in
  // explicitly, with a budget, as the owner would.
  const optIn = vendor === "gemini" ? ["--gemini-api-primary", "100"] : [];
  const code = await main(["--assignment", String(n), "--commit", commit ?? repo.commit, ...LIMITS, "--out", outDir, ...optIn, ...args], d);
  return { code, out, fetch, d };
}
const header = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[0];
const oa = (id, output, usage = { input_tokens: 10, output_tokens: 1 }) => () => ({ json: { id, model: "gpt-6-astra-x", status: "completed", usage, output } });
const fc = (call_id, name, args) => ({ type: "function_call", call_id, name, arguments: JSON.stringify(args) });
const msg = text => ({ type: "message", content: [{ type: "output_text", text }] });

test("OpenAI: continue from the last response id with previous_response_id, the recorded pending outputs and the unrun call; .review-tests restored; header and cumulative totals", async () => {
  const repo = await fixtureRepo(), outDir = await mkdtemp(join(tmpdir(), "rr-cont-"));
  // Run 1: one response asking for three tools; --max-tool-calls 2 leaves the third unrun; then max_turns.
  const r1 = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--max-turns", "1", "--max-tool-calls", "2"],
    script: [oa("resp_1", [fc("c1", "write_test", { name: "probe", content: PROBE }), fc("c2", "read_file", { path: "hello.txt" }), fc("c3", "read_file", { path: "hello.txt", start_line: 2 })])] });
  assert.equal(r1.code, EXIT.incomplete);
  const tpath = join(outDir, "findings-2-openai.transcript.json");
  const t1bytes = await readFile(tpath);
  const t1 = JSON.parse(t1bytes);
  assert.equal(t1.review_tests.captured, true);
  assert.equal(Buffer.from(t1.review_tests.files[0].content_base64, "base64").toString(), PROBE);
  assert.ok(t1.events.filter(e => e.type === "tool_call").every(e => e.result_full === true));
  // Run 2: higher limits; the first request resumes, the model reads the restored probe, then answers.
  const r2 = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--max-turns", "5", "--continue", tpath],
    script: [oa("resp_2", [fc("c4", "read_file", { path: ".review-tests/probe.test.mjs" }), fc("c5", "run_tests", { files: [".review-tests/probe.test.mjs"] })]), oa("resp_3", [msg(FINAL)])] });
  assert.equal(r2.code, EXIT.complete, r2.out.err);
  const [q1, q2] = r2.fetch.calls;
  assert.equal(q1.body.previous_response_id, "resp_1");
  assert.deepEqual(q1.body.input.map(i => [i.type, i.call_id]), [["function_call_output", "c1"], ["function_call_output", "c2"], ["function_call_output", "c3"]]);
  assert.match(q1.body.input[0].output, /wrote \.review-tests\/probe\.test\.mjs/, "the recorded output, sent as it was");
  assert.match(q1.body.input[2].output, /^2\tline two/m, "the call the earlier run never ran was run now");
  assert.match(q2.body.input[0].output, /RESTORED-PROBE-MARKER/, "the reviewer's own file was restored");
  const md = await readFile(join(outDir, "findings-2-openai.md"), "utf8");
  const h = header(md);
  assert.ok(h.includes(`- continued_from: \`${sha(t1bytes)}\``));
  assert.match(h, /- continuation_method: previous_response_id/);
  assert.match(h, /- runs: 2\n- provider_calls_cumulative: 3\n- tool_calls_cumulative: 5\n/);
  // THE COVERAGE GATE (L-501) counts the whole review across its runs: run 1's source reads, run 2's jailed test.
  assert.match(h, /- coverage: `\{"source_reads":1,"denied_reads":0,"tests_run":1,"tests_allowed":true\}`, gate passed/);
  assert.match(h, /- usage_totals_cumulative: `\{"input_tokens":30,"output_tokens":3\}`/);
  assert.ok(md.endsWith(FINAL));
  const files = await readdir(outDir);
  assert.ok(files.includes(`findings-2-openai.transcript.prev-${sha(t1bytes).slice(0, 12)}.json`) && files.includes(`findings-2-openai.prev-${sha(t1bytes).slice(0, 12)}.md`), files.join(","));
  // A complete review is not continued.
  const r3 = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--continue", tpath], script: [] });
  assert.equal(r3.code, EXIT.refused);
  assert.match(r3.out.err, /only an incomplete review is continued/);
  assert.equal(r3.fetch.calls.length, 0);
});

test("Gemini: the recorded model turn and full tool results are replayed as the conversation so far", async () => {
  const repo = await fixtureRepo(), outDir = await mkdtemp(join(tmpdir(), "rr-cont-"));
  const g = (parts, fr = "STOP") => () => ({ json: { modelVersion: "gemini-4-carbon-001", usageMetadata: { totalTokenCount: 5 }, candidates: [{ finishReason: fr, content: { role: "model", parts } }] } });
  const r1 = await api({ repo, outDir, vendor: "gemini", n: 1, args: ["--max-turns", "1"], script: [g([{ functionCall: { name: "read_file", args: { path: "hello.txt" } }, thoughtSignature: "sig" }, { functionCall: { name: "run_tests", args: { files: ["pantheon/tests/other.test.mjs"] } } }])] });
  assert.equal(r1.code, EXIT.incomplete);
  const r2 = await api({ repo, outDir, vendor: "gemini", n: 1, args: ["--continue", join(outDir, "findings-1-google.transcript.json")], script: [g([{ text: FINAL }])] });
  assert.equal(r2.code, EXIT.complete, r2.out.err);
  const c = r2.fetch.calls[0].body.contents;
  assert.deepEqual(c.map(x => x.role), ["user", "model", "user"]);
  assert.equal(c[1].parts[0].thoughtSignature, "sig");
  assert.match(c[2].parts[0].functionResponse.response.output, /1\tline one\n2\tline two/);
  assert.match(header(await readFile(join(outDir, "findings-1-google.md"), "utf8")), /- continuation_method: replayed-history/);
});

test("xAI: a cut-off reply is kept as context and the model is asked for the complete document", async () => {
  const repo = await fixtureRepo(), outDir = await mkdtemp(join(tmpdir(), "rr-cont-"));
  const x = (message, finish_reason) => () => ({ json: { id: "c", model: "grok-4.7-0105", usage: { total_tokens: 3 }, choices: [{ index: 0, finish_reason, message: { role: "assistant", ...message } }] } });
  const r1 = await api({ repo, outDir, vendor: "xai", n: 3, script: [x({ content: "# Findings\n\n1. PARTIAL-CUT" }, "length")] });
  assert.equal(r1.code, EXIT.incomplete);
  const tpath = join(outDir, "findings-3-xai.transcript.json");
  // The resumed review reads and tests (the coverage gate, L-501), then answers.
  const tools = { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } },
    { id: "t2", type: "function", function: { name: "run_tests", arguments: JSON.stringify({ files: ["pantheon/tests/other.test.mjs"] }) } }] };
  const r2 = await api({ repo, outDir, vendor: "xai", n: 3, args: ["--continue", tpath], script: [x(tools, "tool_calls"), x({ content: FINAL }, "stop")] });
  assert.equal(r2.code, EXIT.complete, r2.out.err);
  const m = r2.fetch.calls[0].body.messages;
  assert.deepEqual(m.map(y => y.role), ["system", "user", "assistant", "user"]);
  assert.equal(m[2].content, "# Findings\n\n1. PARTIAL-CUT");
  assert.equal(m[3].content, CONTINUE_NOTE);
  // The continued transcript records the note it added, so a later --continue of a continued run replays it too.
  const t2 = JSON.parse(await readFile(tpath, "utf8"));
  assert.deepEqual(t2.events.filter(e => e.type === "continuation").map(e => e.note), [CONTINUE_NOTE]);
});

test("refusals: another assignment, another commit, another model, an old transcript without full tool results", async () => {
  const repo = await fixtureRepo(), outDir = await mkdtemp(join(tmpdir(), "rr-cont-"));
  await api({ repo, outDir, vendor: "openai", n: 2, args: ["--max-turns", "1"], script: [oa("resp_1", [fc("c1", "read_file", { path: "hello.txt" })])] });
  const tpath = join(outDir, "findings-2-openai.transcript.json");
  let r = await api({ repo, outDir, vendor: "openai", n: 4, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /assignment 2 \(file 2\) vs 4/);
  await sh("git", ["-C", repo.root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "second"]);
  const other = (await sh("git", ["-C", repo.root, "rev-parse", "HEAD"])).trim();
  r = await api({ repo, outDir, vendor: "openai", n: 2, commit: other, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /commit [0-9a-f]{40} vs [0-9a-f]{40}/);
  // An edited transcript (another model; then digests only) with its findings re-pointed at the edited bytes.
  const original = await readFile(tpath, "utf8");
  const rewrite = async t => {
    const bytes = JSON.stringify(t);
    await writeFile(tpath, bytes);
    const mdPath = join(outDir, "findings-2-openai.md");
    await writeFile(mdPath, (await readFile(mdPath, "utf8")).replace(/(- transcript: `[^`]+` sha256 `)[0-9a-f]{64}`/, `$1${sha(bytes)}\``));
  };
  await rewrite({ ...JSON.parse(original), requested_model: "gpt-6.1-sol" });
  r = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /model gpt-6\.1-sol vs gpt-6-astra/);
  const old = JSON.parse(original);
  for (const e of old.events) if (e.type === "tool_call") delete e.result_full;
  await rewrite(old);
  r = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /kept only digests of tool results/);
  const noFiles = JSON.parse(original); delete noFiles.review_tests;
  await rewrite(noFiles);
  r = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /without the contents of \.review-tests/);
  // A transcript that does not match its findings file's sha256 is refused too.
  await writeFile(tpath, original + " ");
  r = await api({ repo, outDir, vendor: "openai", n: 2, args: ["--continue", tpath], script: [] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /names transcript sha256/);
  assert.equal(r.fetch.calls.length, 0);
});

// ---- subscription ---------------------------------------------------------------------------------------------------

async function subSetup() {
  const repo = await fixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "rr-cont-sub-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out");
  await mkdir(bin); await mkdir(home); await mkdir(outDir);
  const clis = fakeReviewClis(bin);
  return { repo, base, bin, home, outDir, clis };
}
async function sub(f, { n, args = [], env = {} }) {
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: f.repo.root, out, fetch, env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, OPENAI_API_KEY: FAKE_KEY, ...env } });
  const codex = n === 2 || n === 4;
  if (codex) d.CodexSDK = fakeCodexSdk();
  const code = await main(["--via", "subscription", "--assignment", String(n), "--commit", f.repo.commit, "--out", f.outDir, "--max-wall-s", "60", ...(codex ? ["--codex-cli", f.clis.codex] : []), ...args], d);
  return { code, out, fetch, sdk: d.CodexSDK?.calls ?? null, plan: (() => { try { return JSON.parse(out.out); } catch { return null; } })() };
}

test("codex: a failed run is continued by resuming its own thread (the SDK's resumeThread) with the NEW worktree and the same sandbox; .review-tests restored", async () => {
  const f = await subSetup();
  const r1 = await sub(f, { n: 2, env: { FAKE_CLI_MODE: "partial", FAKE_CLI_WRITE: ".review-tests/mine.test.mjs" } });
  assert.equal(r1.code, EXIT.incomplete);
  const tpath = join(f.outDir, "findings-2-openai.transcript.json");
  const t1bytes = await readFile(tpath);
  const t1 = JSON.parse(t1bytes);
  assert.deepEqual([t1.status, t1.stop_reason], ["failed", "codex reported turn.failed: usage limit reached"]);
  const promptFile = join(f.base, "prompt.txt");
  const r2 = await sub(f, { n: 2, args: ["--continue", tpath], env: { FAKE_CLI_PROMPT_FILE: promptFile, FAKE_CLI_CHECK: ".review-tests/mine.test.mjs" } });
  assert.equal(r2.code, EXIT.incomplete, r2.out.err);   // finished, but codex runs no test (L-404): the coverage gate (L-501)
  assert.match(r2.out.err, /coverage gate: no test ran although the testing limit allows tests: the codex transport runs no test/);
  assert.equal(r2.plan.continue.method, "codex-sdk-resume");
  assert.equal(r2.plan.continue.thread_id, t1.cli.thread_id);
  const ran = r2.sdk.find(c => c.kind === "run");
  assert.equal(ran.resume_id, t1.cli.thread_id);
  assert.deepEqual([ran.thread_options.workingDirectory, "sandboxMode" in ran.thread_options, ran.thread_options.approvalPolicy], [r2.plan.worktree.path, false, "never"]);
  const made = r2.sdk.find(c => c.kind === "new");
  assert.ok(made.config_overrides.some(c => c.includes(`":workspace_roots"={"."="read", ".review-tests"="write"}`)) && made.config_overrides.includes('default_permissions="ophanim-review"'),
    "the resumed thread runs under the same permission profile, rebuilt for the new run");
  assert.deepEqual(r2.plan.preflight.checks.permission_profile.cwd, r2.plan.worktree.path);
  assert.notEqual(t1.argv[t1.argv.indexOf("--cd") + 1], r2.plan.worktree.path, "the earlier worktree is gone; the resumed thread works in the rebuilt one");
  const prompt = await readFile(promptFile, "utf8");
  // The plan's whole argv: this run's exec-level flags (the permission profile as the SDK was given it, the NEW worktree,
  // approval never), then resume of the earlier thread, then the stdin marker naming the digest of the prompt the SDK sent.
  assert.deepEqual(r2.plan.argv, [f.clis.codex, "exec", "--experimental-json", "--config", 'forced_login_method="chatgpt"', ...made.config_overrides.flatMap(c => ["--config", c]),
    "--model", "gpt-6-astra", "--cd", r2.plan.worktree.path, "--skip-git-repo-check", "--config", 'approval_policy="never"', "resume", t1.cli.thread_id, `(stdin: <prompt sha256:${sha(prompt)}>)`],
  "the SDK puts resume after the exec-level --cd/--sandbox");
  assert.ok(prompt.startsWith(CLI_CONTINUE_NOTE), "a resumed thread gets the continuation note, then the same prompt");
  assert.ok(!prompt.includes(APPENDIX_BEGIN), "no replayed appendix: the thread has its own history");
  const md = await readFile(join(f.outDir, "findings-2-openai.md"), "utf8");
  assert.match(md, /CHECK \.review-tests\/mine\.test\.mjs present/);
  const h = header(md);
  assert.ok(h.includes(`- continued_from: \`${sha(t1bytes)}\``));
  assert.ok(h.includes(`- continuation_method: codex-sdk-resume (thread \`${t1.cli.thread_id}\` resumed with this run's worktree and sandbox)`));
  assert.match(h, /- runs: 2\n/);
});

test("codex without the earlier thread on this machine: a new session whose prompt appends ONLY the reviewer's own earlier messages and tool results; .review-tests restored", async () => {
  const f = await subSetup();
  const r1 = await sub(f, { n: 2, env: { FAKE_CLI_MODE: "partial", FAKE_CLI_WRITE: ".review-tests/mine.test.mjs" } });
  assert.equal(r1.code, EXIT.incomplete);
  const tpath = join(f.outDir, "findings-2-openai.transcript.json");
  const t1bytes = await readFile(tpath);
  await rm(join(f.home, ".codex", "sessions"), { recursive: true, force: true });   // the thread's rollout is gone
  const promptFile = join(f.base, "prompt.txt");
  const r2 = await sub(f, { n: 2, args: ["--continue", tpath], env: { FAKE_CLI_PROMPT_FILE: promptFile, FAKE_CLI_CHECK: ".review-tests/mine.test.mjs" } });
  assert.equal(r2.code, EXIT.incomplete, r2.out.err);   // codex runs no test (L-404): the coverage gate (L-501)
  assert.equal(r2.plan.continue.method, "replayed-own-transcript");
  assert.match(r2.plan.continue.resume_support.source, /resumeThread/);
  assert.equal(r2.sdk.find(c => c.kind === "run").resume_id, null);
  const prompt = await readFile(promptFile, "utf8");
  const a = prompt.slice(prompt.indexOf(APPENDIX_BEGIN));
  assert.ok(prompt.indexOf(APPENDIX_BEGIN) > 0 && a.includes(APPENDIX_END));
  assert.match(a, /EARLIER-OWN-MESSAGE/); assert.match(a, /EARLIER-OWN-OUTPUT/);
  for (const other of ["**Hook fail-closed.**", "**Earliest gate.**", "**Call budgets.**", "PRIOR-FINDINGS-UNIQUE-MARKER"]) assert.ok(!prompt.includes(other), other);
  assert.ok(prompt.startsWith("# Harness (command-line agent)"));
  const md = await readFile(join(f.outDir, "findings-2-openai.md"), "utf8");
  assert.match(md, /CHECK \.review-tests\/mine\.test\.mjs present/);
  const h = header(md);
  assert.ok(h.includes(`- continued_from: \`${sha(t1bytes)}\``));
  assert.match(h, /- continuation_method: replayed-own-transcript/);
  assert.match(h, /- runs: 2\n/);
  assert.match(h, /- usage_totals_cumulative: `\{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20\}`/);
  assert.match(h, /- policy_violations: none/);
  // via mismatch: an API invocation cannot continue a subscription transcript.
  const r3 = await api({ repo: f.repo, outDir: f.outDir, vendor: "openai", n: 2, args: ["--continue", join(f.outDir, `findings-2-openai.transcript.prev-${sha(t1bytes).slice(0, 12)}.json`)], script: [] });
  assert.equal(r3.code, EXIT.refused);
});

test("agy: an incomplete run keeps its conversation state; --continue passes --conversation <id> with that state restored", needBwrap, async () => {
  const f = await subSetup();
  const fx = join(f.base, "fx"); await mkdir(fx);
  const g = join(f.home, ".gemini"), c = join(g, "antigravity-cli");
  await mkdir(join(c, "log"), { recursive: true }); await mkdir(join(g, "config", "projects"), { recursive: true });
  await writeFile(join(c, "antigravity-oauth-token"), "fake-token");
  const cli = fakeAgy(fx);
  await writeFile(join(fx, "quota-report.txt"), JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
    { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon", buckets: [{ id: "w", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9 }] }] } } }));
  await writeFile(join(fx, "quota-exit"), "0");
  const first = join(fx, "first.sh"), second = join(fx, "second.sh");
  await writeFile(first, ['agy_write "$dir/.review-tests/mine.test.mjs" \'import test from "node:test"; test("ok", () => {});\' || true',
    'mkdir -p "$HOME/.gemini/antigravity-cli/conversations" && echo db > "$HOME/.gemini/antigravity-cli/conversations/conv-1.db"',
    'printf \'{"event":"init","conversation_id":"conv-1","init":{"model":"%s","agent":"%s"}}\\n\' "$model" "$agent"', "exit 0", ""].join("\n"));
  await writeFile(second, ['agy_read "$dir/hello.txt" >/dev/null || true', 'agy_run "$(pwd)/pantheon-test pantheon/tests/other.test.mjs" >/dev/null 2>&1 || true',
    'printf \'%s %s %s\\n\' "$conv" "$([ -f "$HOME/.gemini/antigravity-cli/conversations/$conv.db" ] && echo state-restored || echo no-state)" "$([ -f "$dir/.review-tests/mine.test.mjs" ] && echo tests-restored || echo no-tests)" >> "$FAKE_AGY_LOG.resume"',
    'reply="# Findings (resumed)"', ""].join("\n"));
  const env = { FAKE_AGY_LOG: join(fx, "agy.log"), PANTHEON_AGY_STATE_DIRS: fx };
  const r1 = await sub(f, { n: 1, args: ["--agy-cli", cli], env: { ...env, FAKE_AGY_WORKER: first } });
  assert.equal(r1.code, EXIT.incomplete, r1.out.err);
  const t1 = JSON.parse(await readFile(join(f.outDir, "findings-1-google.transcript.json"), "utf8"));
  assert.deepEqual([t1.cli.conversation_id, t1.agy_state.dir, t1.agy_state.saved], ["conv-1", "findings-1-google.agy-state", ["conversations", "brain"]]);
  assert.ok(existsSync(join(f.outDir, "findings-1-google.agy-state", "conversations", "conv-1.db")));
  assert.ok(!existsSync(join(f.outDir, "findings-1-google.agy-state", "antigravity-oauth-token")), "no token is kept");
  const r2 = await sub(f, { n: 1, args: ["--agy-cli", cli, "--continue", join(f.outDir, "findings-1-google.transcript.json")], env: { ...env, FAKE_AGY_WORKER: second } });
  assert.equal(r2.code, EXIT.complete, r2.out.err);
  assert.equal(r2.plan.continue.method, "agy --conversation");
  // The whole argv of the continued run: the earlier conversation resumed, and every other flag as on a first run (the
  // slash commands still disabled, the new worktree, the prompt only by its digest).
  const wt2 = r2.plan.worktree.path;
  assert.deepEqual(r2.plan.argv, ["<bwrap jail prefix>", cli, "--agent", "pantheon-reviewer-agent", "--conversation", "conv-1", "--model", "gemini-4-carbon-high", "--mode=accept-edits",
    "--add-dir", wt2, "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", `${r2.plan.print_timeout_s}s`,
    "--log-file", join(wt2, "..", "control", "run", "agy.log"), "--print", `<prompt sha256:${r2.plan.prompt.sha256}>`]);
  assert.equal((await readFile(join(fx, "agy.log.resume"), "utf8")).trim(), "conv-1 state-restored tests-restored");
  const h = header(await readFile(join(f.outDir, "findings-1-google.md"), "utf8"));
  assert.match(h, /- continuation_method: agy --conversation \(conversation `conv-1`, state restored\)/);
  assert.match(h, /- runs: 2\n/);
});
