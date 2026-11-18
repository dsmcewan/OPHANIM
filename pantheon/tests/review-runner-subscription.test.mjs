// `--via subscription` end to end with FAKES only (tests/fixtures/review-clis.mjs: the fake codex binary for the preflight,
// the fake Codex SDK for the run, the fake grok; the fake agy of tests/fixtures/dispatch.mjs under the real bwrap). No
// network, no real CLI, no key: the API keys put in the parent environment here exist only to prove they never reach a
// child. One test drives the REAL @openai/codex-sdk against the fake codex binary.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { fixtureRepo, fakeFetch, capture, deps, FAKE_KEY, sh, mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";
import { fakeAgy } from "./fixtures/dispatch.mjs";

after(cleanup);

const KEYS = { OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: "codex-key-SHOULD-NOT-LEAK-123", XAI_API_KEY: "xai-key-SHOULD-NOT-LEAK-12345", GEMINI_API_KEY: "AIzaSHOULDNOTLEAK0123456789abcdef" };
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

let shared;
async function setup() {
  shared ??= await fixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "rr-sub-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out"), log = join(base, "cli.log");
  await mkdir(bin); await mkdir(home); await mkdir(outDir);
  const clis = fakeReviewClis(bin);
  return { repo: shared, base, bin, home, outDir, log, clis };
}
const calls = async log => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

// Codex (2 and 4): the preflight runs the fake binary (--codex-cli, also the SDK's codexPathOverride) and the run the
// fake SDK, unless `realSdk` (the installed @openai/codex-sdk spawning the fake binary) or `extra` deps say otherwise.
async function run(f, { n, args = [], env = {}, realSdk = false, extra = {} }) {
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: f.repo.root, out, fetch, env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, FAKE_CLI_LOG: f.log, ...KEYS, ...env } });
  const codex = n === 2 || n === 4;
  if (codex && !realSdk) d.CodexSDK = fakeCodexSdk();
  Object.assign(d, extra);
  const cliArg = codex && !args.includes("--codex-cli") && !extra.inspectCodexSdk ? ["--codex-cli", f.clis.codex] : [];
  const code = await main(["--via", "subscription", "--assignment", String(n), "--commit", f.repo.commit, "--out", f.outDir, ...cliArg, ...args], d);
  const plan = (() => { try { return JSON.parse(out.out); } catch { return null; } })();
  const files = await readdir(f.outDir);
  const read = name => readFile(join(f.outDir, name), "utf8");
  return { code, out, fetch, plan, files, read, d, sdk: d.CodexSDK?.calls ?? null };
}
const headerOf = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[0];
const bodyOf = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[1];

test("usage: --via is required, subscription requires --max-wall-s, the API caps are ignored with a note", async () => {
  const f = await setup();
  const out = capture(), d = await deps({ root: f.repo.root, out, fetch: fakeFetch([]) });
  assert.equal(await main(["--assignment", "2", "--commit", f.repo.commit, "--max-turns", "1", "--max-tool-calls", "1", "--max-output-tokens", "1", "--timeout-s", "1"], d), EXIT.usage);
  assert.match(out.err, /--via is required/);
  assert.equal(await main(["--via", "metered", "--assignment", "2", "--commit", f.repo.commit], d), EXIT.usage);
  assert.equal(await main(["--via", "subscription", "--assignment", "2", "--commit", f.repo.commit, "--timeout-s", "5"], d), EXIT.usage);
  assert.match(out.err, /--max-wall-s is required/);
  const r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--max-turns", "9", "--dry-run"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.match(r.out.err, /--max-turns is an API-mode cap.*ignored/);
  assert.deepEqual(r.plan.limits.ignored, ["--max-turns"]);
});

const SDK_ARGV = wt => ["exec", "--experimental-json", "--config", 'forced_login_method="chatgpt"', "--model", "gpt-6-astra", "--sandbox", "workspace-write", "--cd", wt, "--skip-git-repo-check", "--config", 'approval_policy="never"'];

test("codex dry run: the SDK transport, the zero-spend preflights on the SDK's binary (version, login status, model list), the SDK's argv with the prompt on stdin, no model turn", async () => {
  const f = await setup();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "600", "--dry-run"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(r.sdk, [], "no SDK object was constructed: no model turn");
  const c = await calls(f.log);
  assert.deepEqual(c.map(x => x.argv.slice(0, 2).join(" ")), ["--version", "login status", "debug models"]);
  const p = r.plan;
  assert.deepEqual([p.via, p.transport, p.requested_model, p.subscription_coverage, p.model_turns, p.preflight.ok], ["subscription", "codex-sdk", "gpt-6-astra", "documented", 0, true]);
  assert.deepEqual([p.sdk.package, p.sdk.version, p.sdk.ok, p.sdk.binary.path, p.sdk.key_injection.conditional], ["@openai/codex-sdk", "0.170.0", true, f.clis.codex, true]);
  assert.deepEqual(p.argv.slice(0, -1), [f.clis.codex, ...SDK_ARGV(p.worktree.path)]);
  assert.equal(p.argv.at(-1), `(stdin: <prompt sha256:${p.prompt.sha256}>)`);
  assert.deepEqual(p.thread_options, { model: "gpt-6-astra", sandboxMode: "workspace-write", workingDirectory: p.worktree.path, skipGitRepoCheck: true, approvalPolicy: "never" });
  assert.deepEqual([p.sdk_options.apiKey, p.sdk_options.baseUrl, p.sdk_options.codexPathOverride, p.sdk_options.config], ["never passed", "never passed", f.clis.codex, { forced_login_method: "chatgpt" }]);
  assert.equal(p.preflight.checks.login_status.auth_method_observed, "chatgpt");
  assert.equal(p.preflight.checks.model_list.status, "listed");
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"]) { assert.ok(p.env.removed.includes(k), k); assert.ok(!p.env.passed.includes(k), k); }
  assert.ok(p.env.passed.includes("HOME"), "HOME is kept: the CLI's ChatGPT login lives under it");
  assert.ok(p.verified_by_preflight.length && p.assumed.length && p.enforced_by_runner.length);
  assert.ok(!JSON.stringify(p).includes(FAKE_KEY));
  assert.deepEqual(await readdir(f.outDir), []);
  assert.deepEqual(await readdir(r.d.tmpBase), [], "the stand-in worktree is removed");
});

test("codex run, assignment 4: the SDK gets the scrubbed env, the pinned binary, no apiKey/baseUrl, read-only thread options; the events become the transcript; the final message verbatim", async () => {
  const f = await setup();
  const r = await run(f, { n: 4, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const [made, ran] = r.sdk;
  assert.deepEqual(made.option_names, ["codexPathOverride", "config", "env"], "never apiKey or baseUrl");
  assert.deepEqual([made.codexPathOverride, made.config, made.env_keylike, made.home], [f.clis.codex, { forced_login_method: "chatgpt" }, [], f.home]);
  assert.deepEqual((await calls(f.log)).map(x => x.keys), [[], [], []], "no key reaches the preflight either");
  const t = JSON.parse(await r.read("findings-4-openai.transcript.json"));
  assert.deepEqual(ran.thread_options, { model: "gpt-6.1-sol", sandboxMode: "read-only", workingDirectory: r.plan.worktree.path, skipGitRepoCheck: true, approvalPolicy: "never" });
  assert.equal(ran.resume_id, null);
  assert.equal(ran.has_signal, true, "the wall clock goes to the SDK as an AbortSignal");
  assert.equal(createHash("sha256").update(ran.input).digest("hex"), t.prompt.sha256, "the prompt given to the SDK is the recorded one");
  const md = await r.read("findings-4-openai.md");
  const h = headerOf(md);
  for (const line of ["- status: complete", "- via: subscription", "- transport: codex-sdk", "- cli_version: `codex-cli 9.9.9-fake`", "- auth_method_observed: chatgpt",
    "- subscription_coverage: documented", "- requested_model: `gpt-6.1-sol`", "- served_model: `gpt-6.1-sol`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  assert.match(h, /- served_model_source: input/);
  assert.match(h, /- sandbox: codex read-only .*approvals never/);
  assert.match(h, /- usage_totals: `\{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20\}`/);
  assert.equal(bodyOf(md), "# Findings (fake codex)\n\n1. holds\n\nModel: gpt-6.1-sol\n");
  assert.deepEqual([t.via, t.transport, t.status, t.worktree_check.violations], ["subscription", "codex-sdk", "complete", []]);
  assert.match(t.cli.thread_id, /^01a1f0fe-/, "the thread id is recorded (for --continue)");
  assert.deepEqual([t.cli.commands.length, t.cli.turns_completed, t.cli.errors], [1, 1, ["Reconnecting... 1/5 (stream disconnected)"]], "a retry error event is recorded, not a failure");
  assert.ok(t.cli.own.some(o => o.kind === "your message"));
  for (const s of [md, JSON.stringify(t), r.out.out, r.out.err]) for (const v of Object.values(KEYS)) assert.ok(!s.includes(v));
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
  assert.equal((await sh("git", ["-C", f.repo.root, "worktree", "list"])).trim().split("\n").length, 1);
});

test("codex through the REAL @openai/codex-sdk spawning the fake binary: the argv it builds is the plan's, the prompt goes to stdin, no key in its env", async () => {
  const f = await setup();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "60"], realSdk: true });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const log = await calls(f.log);
  const exec = log.find(x => x.argv?.[0] === "exec");
  assert.deepEqual([f.clis.codex, ...exec.argv], r.plan.argv.slice(0, -1), "the SDK spawned exactly the argv the plan records");
  assert.deepEqual(exec.keys, [], "no CODEX_API_KEY (or any key) in the env the SDK gave the CLI");
  const t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  const stdin = log.find(x => x.stdin_bytes !== undefined);
  assert.deepEqual([stdin.stdin_bytes, stdin.originator], [t.prompt.bytes, "codex_sdk_ts"]);
  assert.equal(t.cli.thread_id, "01a1f0fe-0000-7000-8000-0000000000b1");
  assert.match(bodyOf(await r.read("findings-2-openai.md")), /^# Findings \(fake codex binary\)\n\nModel: gpt-6-astra in \//);
  // A failure the CLI reports reaches the findings as `failed` with its message.
  const r2 = await run(f, { n: 2, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_MODE: "fail" }, realSdk: true });
  assert.equal(r2.code, EXIT.incomplete);
  assert.match(headerOf(await r2.read("findings-2-openai.md")), /- status: failed\n- stop_reason: codex reported turn\.failed: usage limit reached\n/);
  assert.match(JSON.parse(await r2.read("findings-2-openai.transcript.json")).cli.sdk_error, /Codex Exec exited with code 1: fatal: usage limit reached/);
});

test("codex failure is explicit: turn.failed and a thrown SDK error are status `failed` with the message; no findings body", async () => {
  const f = await setup();
  let r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "fail" } });
  assert.equal(r.code, EXIT.incomplete);
  let md = await r.read("findings-2-openai.md");
  assert.match(headerOf(md), /- status: failed\n- stop_reason: codex reported turn\.failed: usage limit reached\n/);
  assert.equal(bodyOf(md), "");
  let t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.deepEqual([t.status, t.cli.turn_failed, t.cli.commands.length], ["failed", "usage limit reached", 1]);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_MODE: "throw" } });
  assert.equal(r.code, EXIT.incomplete);
  md = await r.read("findings-2-openai.md");
  assert.match(headerOf(md), /- status: failed\n- stop_reason: the Codex SDK reported a failure: Codex Exec exited with code 1: ChatGPT login is required/);
  t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.deepEqual([t.cli.events, t.cli.thread_id], [0, null]);
});

test("the post-run git check: a change outside .review-tests/ is a policy violation; inside it is allowed for 1-3 and a violation for 4", async () => {
  const f = await setup();
  let r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CLI_WRITE: "pantheon/evil.mjs" } });
  assert.equal(r.code, EXIT.incomplete);
  let h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, /- status: policy_violation/);
  assert.match(h, /- policy_violations: `pantheon\/evil\.mjs`/);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_WRITE: ".review-tests/mine.test.mjs" } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.match(headerOf(await r.read("findings-2-openai.md")), /- policy_violations: none/);
  r = await run(f, { n: 4, args: ["--max-wall-s", "60"], env: { FAKE_CLI_WRITE: ".review-tests/x.test.mjs" } });
  assert.equal(r.code, EXIT.incomplete);
  h = headerOf(await r.read("findings-4-openai.md"));
  assert.match(h, /- status: policy_violation/);
  assert.match(h, /- policy_violations: `\.review-tests\/x\.test\.mjs`/);
});

test("codex refusals, never a fallback: API-key login, no login, model missing, unreadable catalog, binary absent, an SDK that would inject CODEX_API_KEY", async () => {
  const f = await setup();
  let r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_LOGIN: "apikey" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /reports an API key/);
  assert.equal(r.plan.preflight.checks.login_status.auth_method_observed, "api-key");
  assert.doesNotMatch(r.out.out, /ABCDEFGHIJKLMNOPQRSTUVWX/, "the login status text is recorded redacted");
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--allow-api-key-in-cli", "--dry-run"], env: { FAKE_CODEX_LOGIN: "apikey" } });
  assert.equal(r.code, EXIT.complete, "explicitly allowed");
  assert.equal(r.plan.sdk_options.config, undefined, "and then no forced ChatGPT login");
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_LOGIN: "none" } });
  assert.equal(r.code, EXIT.refused);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_MODELS: "missing" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /does not list gpt-6-astra/);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--dry-run"], env: { FAKE_CODEX_MODELS: "garbage" } });
  assert.equal(r.code, EXIT.refused);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--dry-run", "--skip-model-check"], env: { FAKE_CODEX_MODELS: "garbage" } });
  assert.equal(r.code, EXIT.complete);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--codex-cli", join(f.base, "absent")] });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /never falls back to the API/);
  // Without --codex-cli the binary is the SDK's own; when its platform package is missing, that is a refusal.
  const noBinary = () => ({ ok: true, version: "0.170.0", entry: "/x", key_injection: { conditional: true, sites: [262], bad: [] }, binary: { ok: false, why: "the Codex CLI binaries were not found" } });
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], extra: { inspectCodexSdk: noBinary } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /the codex binary the SDK would spawn was not found \(the Codex CLI binaries were not found\)/);
  // An SDK whose source sets CODEX_API_KEY without an apiKey option would bill the API: refused, not worked around.
  const keyed = () => ({ ok: true, version: "9.9.9", entry: "/x", key_injection: { conditional: false, sites: [10], bad: [{ line: 10, text: "env.CODEX_API_KEY = process.env.OPENAI_API_KEY;" }] }, binary: { ok: true, path: f.clis.codex, path_dirs: [] } });
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], extra: { inspectCodexSdk: keyed } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /sets CODEX_API_KEY other than only when an apiKey option is passed .*refuses/);
  assert.deepEqual(r.sdk, [], "no SDK object was constructed");
  assert.equal(r.fetch.calls.length, 0);
  assert.ok(!r.files.some(x => x.startsWith("findings-2")));
});

test("the wall clock aborts the SDK turn (its AbortSignal) and the run is incomplete; a stream that ignores the abort is abandoned after the grace", async () => {
  const f = await setup();
  const t0 = Date.now();
  let r = await run(f, { n: 2, args: ["--max-wall-s", "1"], env: { FAKE_CLI_MODE: "hang" } });
  assert.equal(r.code, EXIT.incomplete);
  assert.ok(Date.now() - t0 < 20_000);
  let h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, /- status: incomplete\n- stop_reason: wall clock reached \(1 s\): the SDK's abort signal stopped codex\n/);
  let t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.deepEqual([t.killed_for, t.cli.aborted_by_wall_clock, t.cli.abort_stalled], ["timeout", true, false]);
  assert.match(t.cli.thread_id, /^01a1f0fe-/, "the thread id from before the abort is kept");
  r = await run(f, { n: 2, args: ["--max-wall-s", "1", "--force"], env: { FAKE_CLI_MODE: "deaf" }, extra: { codexAbortGraceMs: 200 } });
  assert.equal(r.code, EXIT.incomplete);
  h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, /- stop_reason: wall clock reached \(1 s\): the SDK's abort signal stopped codex; its event stream had not ended 0\.2 s later, so the runner stopped waiting/);
});

test("grok, assignment 3: inside bwrap -- worktree read-only, .review-tests writable, state dir a scratch copy; XAI_API_KEY scrubbed; coverage undocumented; unknowns printed", needBwrap, async () => {
  const f = await setup();
  await mkdir(join(f.home, ".grok")); await writeFile(join(f.home, ".grok", "auth.json"), "{}");
  const r = await run(f, { n: 3, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual([r.plan.transport, r.plan.subscription_coverage, r.plan.unknowns.length > 0], ["grok-cli", "undocumented", true]);
  assert.equal(r.plan.argv[0], "bwrap");
  assert.ok(r.plan.argv.includes("--die-with-parent"));
  const md = await r.read("findings-3-xai.md");
  const probe = JSON.parse(/PROBE (\{.*\})/.exec(bodyOf(md))[1]);
  assert.deepEqual([probe.worktree_root, probe.review_tests, probe.state, probe.state_login_visible, probe.tmp], ["EROFS", "ok", "ok", true, "ok"]);
  assert.equal(existsSync(join(f.home, ".grok", "written-in-run.txt")), false, "the real state dir is untouched (the run wrote its scratch copy)");
  assert.deepEqual(probe.keys, [], "no XAI_API_KEY (nor any other key) inside the jail");
  assert.deepEqual(probe.argv, ["-p", "--output-format", "streaming-json", "-m", "grok-4.7"]);
  const h = headerOf(md);
  for (const line of ["- status: complete", "- transport: grok-cli", "- subscription_coverage: undocumented", "- served_model: `grok-4.7`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  const t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.cli.unparsed_lines, t.worktree_check.changed], [1, [".review-tests/probe.test.mjs"]]);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
});

test("grok refusals: no browser login state, or a CLI that asks for a key (never given XAI_API_KEY)", needBwrap, async () => {
  const f = await setup();
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /no Grok browser login found/);
  assert.equal((await calls(f.log)).filter(x => x.argv.includes("-p")).length, 0);
  await mkdir(join(f.home, ".grok")); await writeFile(join(f.home, ".grok", "auth.json"), "{}");
  r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "needkey" } });
  assert.equal(r.code, EXIT.refused);
  const h = headerOf(await r.read("findings-3-xai.md"));
  assert.match(h, /- status: refused/);
  assert.match(h, /asked for an API key or a login: subscription mode never supplies XAI_API_KEY/);
});

// ---- agy (assignment 1) with the fake agy under the real bwrap -------------------------------------------------
const usage = fraction => JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon, Gemini 3.8 Flash", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: fraction }] }] } } });
async function agySetup() {
  const f = await setup();
  const fx = join(f.base, "fx");
  await mkdir(fx);
  const g = join(f.home, ".gemini"), c = join(g, "antigravity-cli");
  await mkdir(join(c, "log"), { recursive: true }); await mkdir(join(g, "config", "projects"), { recursive: true });
  await writeFile(join(c, "antigravity-oauth-token"), "fake-token");
  const cli = fakeAgy(fx);
  await writeFile(join(fx, "quota-report.txt"), usage(0.8)); await writeFile(join(fx, "quota-exit"), "0");
  const worker = join(fx, "review-worker.sh");
  await writeFile(worker, [
    'agy_write "$dir/.review-tests/mine.test.mjs" \'import test from "node:test"; test("ok", () => {});\' || true',
    'agy_write "$dir/pantheon/evil.mjs" "x" || true',
    'agy_run "cd \'$dir\' && node --test pantheon/tests/other.test.mjs .review-tests/mine.test.mjs" >/dev/null 2>&1 || true',
    'agy_run "cd \'$dir\' && rm -rf pantheon" >/dev/null 2>&1 || true',
    'reply="# Findings (fake agy reviewer)"', ""].join("\n"));
  const env = { FAKE_AGY_LOG: join(fx, "agy.log"), PANTHEON_AGY_STATE_DIRS: fx, FAKE_AGY_WORKER: worker };
  return { ...f, fx, cli, env, launches: async () => (existsSync(join(fx, "agy.log")) ? (await readFile(join(fx, "agy.log"), "utf8")).trim().split("\n").filter(Boolean) : []) };
}

test("agy dry run, assignment 1: the jailed zero-spend preflight (/usage, lane quota, card, agents) and the plan; zero model turns", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--dry-run", "--agy-cli", f.cli], env: f.env });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const p = r.plan;
  assert.deepEqual([p.transport, p.lane, p.preflight.ok, p.preflight.checks.lane_quota.state], ["agy-cli", "gemini-4-carbon-high", true, "available"]);
  for (const a of ["--agent", "pantheon-reviewer-agent", "--model", "gemini-4-carbon-high", "--mode=accept-edits", "--add-dir", "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "--log-file"]) assert.ok(p.argv.includes(a), a);
  assert.ok(!p.argv.some(a => a === "--sandbox" || a === "--dangerously-skip-permissions"));
  assert.deepEqual(p.hook_policy.owned_paths, [".review-tests/**"]);
  assert.deepEqual(await f.launches(), [], "no model turn");
  r.plan.preflight.ok && assert.ok(!JSON.stringify(p).includes("fake-token"));
});

test("agy run, assignment 1: the hook approves the .review-tests write and the listed test command, denies the rest; findings written with the lane as served model", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--agy-cli", f.cli], env: f.env });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual((await f.launches()).map(l => l.split(" ")), [["pantheon-reviewer-agent", "gemini-4-carbon-high"]]);
  const t = JSON.parse(await r.read("findings-1-google.transcript.json"));
  const decisions = t.cli.jail_decisions.map(d => [d.tool, d.decision]);
  assert.deepEqual(decisions, [["write_file", "auto_approve"], ["write_file", "deny"], ["run_command", "auto_approve"], ["run_command", "deny"]]);
  assert.deepEqual(t.worktree_check, { ...t.worktree_check, changed: [".review-tests/mine.test.mjs"], violations: [] });
  const md = await r.read("findings-1-google.md");
  const h = headerOf(md);
  for (const line of ["- status: complete", "- transport: agy-cli", "- subscription_coverage: documented", "- requested_model: `gemini-4-carbon`", "- lane: `gemini-4-carbon-high`", "- served_model: `gemini-4-carbon-high`"]) assert.ok(h.includes(line + "\n"), line);
  assert.equal(bodyOf(md), "# Findings (fake agy reviewer)");
  for (const v of Object.values(KEYS)) assert.ok(!md.includes(v) && !JSON.stringify(t).includes(v));
  assert.deepEqual(await readdir(r.d.tmpBase), []);
});

test("agy refuses before any model turn when the in-jail /usage shows no login (no fallback)", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--agy-cli", f.cli], env: { ...f.env, FAKE_AGY_NOT_LOGGED_IN: "1" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /agy preflight auth/);
  assert.deepEqual(await f.launches(), []);
  assert.equal(r.fetch.calls.length, 0);
});
