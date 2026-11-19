// `--via subscription` end to end with FAKES only (tests/fixtures/review-clis.mjs: the fake codex binary for the preflight,
// the fake Codex SDK for the run, the fake grok; the fake agy of tests/fixtures/dispatch.mjs under the real bwrap). No
// network, no real CLI, no key: the API keys put in the parent environment here exist only to prove they never reach a
// child. One test drives the REAL @openai/codex-sdk against the fake codex binary.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { CODEX_TESTS_REFUSED } from "../src/review-runner/subscription.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { fixtureRepo, fakeFetch, capture, deps, FAKE_KEY, sh, mkdtemp, cleanup, REAL_ROOT, REVIEW_DIR } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";
import { grokRecommendedAllow } from "../src/review-runner/grok.mjs";
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
// A Grok browser-login stand-in plus the README's string-form permission profile (the preflight refuses a state dir
// whose config.toml loads no allow rule: such a run is cancelled at its first tool call).
const GROK_ALLOW = `[permission]\nallow = [${grokRecommendedAllow().map(r => JSON.stringify(r)).join(", ")}]\n`;
async function grokLogin(f, config = GROK_ALLOW) {
  await mkdir(join(f.home, ".grok"), { recursive: true }); await writeFile(join(f.home, ".grok", "auth.json"), "{}");
  if (config !== null) await writeFile(join(f.home, ".grok", "config.toml"), config);
}
const calls = async log => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

// Codex (2 and 4): the preflight runs the fake binary (--codex-cli, also the SDK's codexPathOverride) and the run the
// fake SDK, unless `realSdk` (the installed @openai/codex-sdk spawning the fake binary) or `extra` deps say otherwise.
async function run(f, { n, args = [], env = {}, realSdk = false, extra = {} }) {
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: f.repo.root, out, fetch, env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, FAKE_CLI_LOG: f.log, ...KEYS, ...env } });
  const reviewer = args[args.indexOf("--reviewer") + 1];
  const codex = args.includes("--reviewer") ? reviewer.startsWith("openai:") : n === 2 || n === 4;
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

const SDK_ARGV = (wt, overrides) => ["exec", "--experimental-json", "--config", 'forced_login_method="chatgpt"', ...overrides.flatMap(c => ["--config", c]), "--model", "gpt-6-astra", "--cd", wt, "--skip-git-repo-check", "--config", 'approval_policy="never"'];

test("codex dry run: the SDK transport, the zero-spend preflights on the SDK's binary (version, login status, model list), the SDK's argv with the prompt on stdin, no model turn", async () => {
  const f = await setup();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "600", "--dry-run"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(r.sdk, [], "no SDK object was constructed: no model turn");
  const c = await calls(f.log);
  assert.deepEqual(c.map(x => x.argv.slice(0, 2).join(" ")), ["--version", "login status", "debug models", "debug prompt-input"]);
  const p = r.plan;
  assert.deepEqual([p.via, p.transport, p.requested_model, p.subscription_coverage, p.model_turns, p.preflight.ok], ["subscription", "codex-sdk", "gpt-6-astra", "documented", 0, true]);
  assert.deepEqual([p.sdk.package, p.sdk.version, p.sdk.ok, p.sdk.binary.path, p.sdk.key_injection.conditional], ["@openai/codex-sdk", "0.170.0", true, f.clis.codex, true]);
  assert.deepEqual(p.argv.slice(0, -1), [f.clis.codex, ...SDK_ARGV(p.worktree.path, p.sdk_options.configOverrides)]);
  // The permission profile: no --sandbox; codex's own rendering of what it will apply was checked before any turn.
  assert.ok(!p.argv.includes("--sandbox"));
  assert.equal(p.sandbox.profile, "ophanim-review");
  assert.deepEqual(p.sandbox.filesystem[":workspace_roots"], { ".": "read", ".review-tests": "write" });
  assert.equal(p.sandbox.network.enabled, true);
  const pp = p.preflight.checks.permission_profile;
  assert.deepEqual([pp.ok, pp.cwd, pp.observed.network, pp.argv.slice(1, 3)], [true, p.worktree.path, "enabled", ["debug", "prompt-input"]]);
  assert.ok(pp.expected_entries.includes(`write ${p.worktree.path}/.review-tests`) && pp.expected_entries.includes("read :minimal"));
  const tmpEntry = pp.expected_entries.find(e => e.startsWith("write ") && !e.endsWith(".review-tests"));
  assert.ok(tmpEntry && !tmpEntry.slice(6).startsWith(p.worktree.path + "/"), "the scratch TMPDIR is outside the worktree");
  assert.ok(p.env.passed.includes("TMPDIR"));
  // L-404 (self-audit round 3, assignment 4 (sealed fe2a612)): codex's sandbox cannot start the verify jail, so codex
  // lists NO test command, says why, and its profile denies node (the node install is no longer a read root).
  assert.deepEqual(p.allowed_commands, [`- none: ${CODEX_TESTS_REFUSED}`]);
  assert.equal(p.sandbox.filesystem[realpathSync(process.execPath)], "deny", "the node binary is denied in codex's sandbox");
  assert.ok(pp.expected_entries.includes(`deny ${realpathSync(process.execPath)}`));
  assert.ok(!Object.entries(p.sandbox.filesystem).some(([k, v]) => v === "read" && realpathSync(process.execPath).startsWith(k + "/")), "the node install is not readable");
  assert.equal(p.argv.at(-1), `(stdin: <prompt sha256:${p.prompt.sha256}>)`);
  assert.deepEqual(p.thread_options, { model: "gpt-6-astra", workingDirectory: p.worktree.path, skipGitRepoCheck: true, approvalPolicy: "never" });
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
  // THE COVERAGE GATE (L-501) with codex's refused tests (L-404): the review read the source but could run no test, so
  // it is `incomplete`, and says why; the reviewer's final message is kept after the header.
  assert.equal(r.code, EXIT.incomplete, r.out.err);
  const [made, ran] = r.sdk;
  assert.deepEqual(made.option_names, ["codexPathOverride", "config", "configOverrides", "env"], "never apiKey or baseUrl");
  assert.ok(made.config_overrides.some(c => c.endsWith(`":workspace_roots"={"."="read"}}`)), "assignment 4: nothing in the worktree is writable");
  assert.ok(made.tmpdir && !made.tmpdir.startsWith(r.plan.worktree.path), "TMPDIR is the scratch dir outside the worktree");
  assert.deepEqual([made.codexPathOverride, made.config, made.env_keylike, made.home], [f.clis.codex, { forced_login_method: "chatgpt" }, [], f.home]);
  assert.deepEqual((await calls(f.log)).map(x => x.keys), [[], [], [], []], "no key reaches the preflight either");
  const t = JSON.parse(await r.read("findings-4-openai.transcript.json"));
  assert.deepEqual(ran.thread_options, { model: "gpt-6.1-sol", workingDirectory: r.plan.worktree.path, skipGitRepoCheck: true, approvalPolicy: "never" });
  assert.equal(ran.resume_id, null);
  assert.equal(ran.has_signal, true, "the wall clock goes to the SDK as an AbortSignal");
  assert.equal(createHash("sha256").update(ran.input).digest("hex"), t.prompt.sha256, "the prompt given to the SDK is the recorded one");
  const md = await r.read("findings-4-openai.md");
  const h = headerOf(md);
  for (const line of ["- status: incomplete", "- via: subscription", "- transport: codex-sdk", "- cli_version: `codex-cli 9.9.9-fake`", "- auth_method_observed: chatgpt",
    "- subscription_coverage: documented", "- requested_model: `gpt-6.1-sol`", "- served_model: `gpt-6.1-sol`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  assert.match(h, /- stop_reason: coverage gate: no test ran although the testing limit allows tests: the codex transport runs no test.*\(the transport ended with: final answer\)\n/);
  assert.match(h, /- coverage: `\{"source_reads":1,"denied_reads":0,"tests_run":0,"tests_allowed":true\}`, gate FAILED .*files read \(sample\): `hello\.txt`\n/);
  assert.match(h, /- served_model_source: input/);
  assert.match(h, /- sandbox: codex permission profile ophanim-review .*writes a scratch TMPDIR outside the worktree.*approvals never/);
  assert.match(h, /- usage_totals: `\{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20\}`/);
  assert.equal(bodyOf(md), "# Findings (fake codex)\n\n1. holds\n\nModel: gpt-6.1-sol\n");
  assert.deepEqual([t.via, t.transport, t.status, t.worktree_check.violations], ["subscription", "codex-sdk", "incomplete", []]);
  assert.deepEqual([t.coverage.source_reads, t.coverage.tests_run, t.coverage.tests_refused, t.coverage_gate.ok], [1, 0, CODEX_TESTS_REFUSED, false]);
  assert.match(t.cli.thread_id, /^01a1f0fe-/, "the thread id is recorded (for --continue)");
  assert.deepEqual([t.cli.commands.length, t.cli.turns_completed, t.cli.errors], [2, 1, ["Reconnecting... 1/5 (stream disconnected)"]], "a retry error event is recorded, not a failure");
  assert.ok(t.cli.own.some(o => o.kind === "your message"));
  for (const s of [md, JSON.stringify(t), r.out.out, r.out.err]) for (const v of Object.values(KEYS)) assert.ok(!s.includes(v));
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
  assert.equal((await sh("git", ["-C", f.repo.root, "worktree", "list"])).trim().split("\n").length, 1);
});

test("codex through the REAL @openai/codex-sdk spawning the fake binary: the argv it builds is the plan's, the prompt goes to stdin, no key in its env", async () => {
  const f = await setup();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "60"], realSdk: true });
  // The fake binary reads nothing and codex runs no test: the coverage gate makes the run incomplete (L-501, L-404).
  assert.equal(r.code, EXIT.incomplete, r.out.err);
  assert.match(r.out.err, /run-review: incomplete \(coverage gate: no source file was read; no test ran/);
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
  assert.deepEqual([t.status, t.cli.turn_failed, t.cli.commands.length], ["failed", "usage limit reached", 2]);
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
  assert.equal(r.code, EXIT.incomplete, r.out.err);   // not a violation; incomplete only for codex's refused tests (L-404)
  assert.match(headerOf(await r.read("findings-2-openai.md")), /- status: incomplete\n[\s\S]*- policy_violations: none/);
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
  // The permission profile codex would apply must be the runner's, exactly (a legacy profile means the overrides were
  // ignored, e.g. a sandbox_mode in the owner's config); none reported, or prompt-input failing, is a refusal too.
  for (const [perms, why] of [["legacy", /would not apply the review's permission profile: file-system entries differ/], ["none", /named no permission profile/], ["fail", /prompt-input` failed/]]) {
    r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_PERMS: perms } });
    assert.equal(r.code, EXIT.refused, perms);
    assert.match(r.out.err, why, perms);
    assert.deepEqual(r.sdk, [], `${perms}: no SDK turn`);
  }
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
  await grokLogin(f);
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
  // L-404 (self-audit round 3, assignment 4 (sealed fe2a612)): the only test commands grok is allowed are the review's
  // verify launchers (per invocation, --allow); the fake ran one, and it ran the test in a verify jail NESTED in grok's.
  assert.deepEqual(probe.argv.slice(0, 5), ["-p", "--output-format", "streaming-json", "-m", "grok-4.7"]);
  const allow = probe.argv.slice(5);
  assert.ok(allow.length >= 2 && allow.every((a, i) => (i % 2 === 0 ? a === "--allow" : /^Bash\(\/\S+\/control\/pantheon-(test \*|suite-[a-z]+)\)$/.test(a))), allow.join(" "));
  assert.deepEqual(r.plan.allowed_commands.every(l => /\/control\/pantheon-(test|suite-[a-z]+)\b/.test(l)), true, "every listed test command is a launcher");
  assert.equal(probe.launcher.exit, 0, `the launcher ran the test in the verify jail: ${probe.launcher.out}`);
  const h = headerOf(md);
  for (const line of ["- status: complete", "- transport: grok-cli", "- subscription_coverage: undocumented", "- served_model: `grok-4.7`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  const t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.coverage.source_reads, t.coverage.denied_reads, t.coverage.tests_run, t.coverage_gate.ok], [1, 0, 1, true], "the coverage gate (L-501) from grok's tool events");
  assert.deepEqual([t.cli.unparsed_lines, t.worktree_check.changed], [1, [".review-tests/probe.test.mjs"]]);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
});

test("grok refusals: no browser login state, or a CLI that asks for a key (never given XAI_API_KEY)", needBwrap, async () => {
  const f = await setup();
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /no Grok browser login found/);
  assert.equal((await calls(f.log)).filter(x => x.argv.includes("-p")).length, 0);
  await grokLogin(f);
  r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "needkey" } });
  assert.equal(r.code, EXIT.refused);
  const h = headerOf(await r.read("findings-3-xai.md"));
  assert.match(h, /- status: refused/);
  assert.match(h, /asked for an API key or a login: subscription mode never supplies XAI_API_KEY/);
});

test("grok stream: an answer sent as incremental text chunks is the final text (tool output never is); a stream with no assistant text ends incomplete naming its last event types", needBwrap, async () => {
  const f = await setup();
  await grokLogin(f);
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "chunks" } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const md = await r.read("findings-3-xai.md");
  assert.match(bodyOf(md), /^# Findings \(fake grok, chunked\)\n\nPROBE \{/);
  assert.doesNotMatch(bodyOf(md), /NOT THE ANSWER|hmm/);
  const t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.cli.final_source, t.cli.text_chunks, t.cli.complete_messages], ["chunks", 4, 0]);
  r = await run(f, { n: 3, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_MODE: "nofinal", FAKE_GROK_NO_WORK: "1" } });
  assert.equal(r.code, EXIT.incomplete, r.out.err + (await r.read("findings-3-xai.md").catch(() => "")));
  const h = headerOf(await r.read("findings-3-xai.md"));
  assert.match(h, /grok returned no final text \(5 event\(s\), 0 unparsed line\(s\); no assistant message, result event or text chunk was recognised; last event types: start, tool_call, tool_result, thinking_delta, usage/);
  const t2 = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual(t2.cli.no_final_text.last_event_keys, ["type", "usage"]);
});

test("grok, the observed grok 1.0.44 shapes: text chunks after the last tool call are the answer (end_turn); stopReason cancelled with exit 0 is a failed run naming the permission profile; grok_permissions recorded", needBwrap, async () => {
  const f = await setup();
  await grokLogin(f);
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "native" } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.equal(r.plan.preflight.warnings, undefined, "the README's string-form profile: nothing missing");
  let md = await r.read("findings-3-xai.md");
  assert.match(bodyOf(md), /^# Findings \(fake grok, native\)\n\nPROBE \{/);
  assert.doesNotMatch(bodyOf(md), /Next I will write a test|NOT THE ANSWER/);
  // No test rule in the recommended profile any more (L-404): tests run only through the launchers the runner allows.
  assert.match(headerOf(md), /^- grok_permissions: config\.toml permission_mode unset \(default "ask"\); 30 string-form allow rule\(s\): `Read` `Grep` `Edit` `Bash\(cat \*\)`.*`Bash\(git show\)`\n/m);
  let t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.cli.final_source, t.cli.cli_stop_reason, t.cli.num_turns], ["chunks", "end_turn", 3]);
  // The owner's narrow rules are recorded (the runner writes none); the allowances they lack are named before the run.
  await writeFile(join(f.home, ".grok", "config.toml"), '[permission]\nallow = ["Edit"]\n');
  r = await run(f, { n: 3, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_MODE: "cancelled" } });
  assert.equal(r.code, EXIT.incomplete, r.out.err);
  assert.match(r.plan.preflight.warnings.join("\n"), /29 recommended allowance\(s\) missing .*Read, Grep, Bash\(cat \*\)/);
  md = await r.read("findings-3-xai.md");
  const h = headerOf(md);
  assert.match(h, /- status: failed\n/);
  assert.match(h, /- stop_reason: grok ended its turn with stopReason "cancelled", not "end_turn" \(exit 0\): the review did not finish; 1 tool call\(s\) were cancelled \(search_replace: "User cancelled the execution for tool `search_replace`"\)\. This is most likely the Grok CLI's permission profile/);
  assert.ok(h.includes('- grok_permissions: config.toml permission_mode unset (default "ask"); 1 string-form allow rule(s): `Edit`\n'), h);
  assert.equal(bodyOf(md), "", "no final message is written for a failed run");
  t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.status, t.exit_code, t.cli.cli_stop_reason, t.cli.cancelled_tools.map(c => c.tool)], ["failed", 0, "cancelled", ["search_replace"]]);
});

test("grok permission refusals (round 2, 77480d6): no config.toml, or only the structured `rules = [...]` array grok 1.0.44 loads as zero rules, is refused before any model turn; --grok-permissions-inspect runs the CLI's own count in the jail and refuses 0 loaded", needBwrap, async () => {
  const f = await setup();
  await grokLogin(f, null);
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "native" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /permissions: no .*config\.toml: under the default "ask" profile a headless run cancels every tool call/);
  await writeFile(join(f.home, ".grok", "config.toml"), readFileSync(join(REAL_ROOT, REVIEW_DIR, "findings-runs-77480d6", "grok-effective-permission-profile.toml"), "utf8").replace(/^allow = .*$/m, ""));
  r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "native" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /has no string-form \[permission\] allow rule \(it has 6 structured `rules = \[\.\.\.\]` allow rule\(s\), which grok 1\.0\.44 loaded as zero rules/);
  assert.equal((await calls(f.log)).filter(x => x.argv.includes("-p")).length, 0, "no model turn");
  // The CLI's own inspection, run in the jail against the scratch copy (it sees the copied config.toml).
  await writeFile(join(f.home, ".grok", "config.toml"), GROK_ALLOW);
  r = await run(f, { n: 3, args: ["--max-wall-s", "60", "--dry-run", "--grok-permissions-inspect", "inspect --json"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const pi = r.plan.preflight.checks.permissions_inspect;
  assert.deepEqual([pi.argv.slice(1), pi.ok, pi.loaded, pi.sources.length], [["inspect", "--json"], true, 6, 1]);
  assert.match(r.plan.preflight.warnings.join(""), /loaded 6 rule\(s\), fewer than the 30 string-form rule\(s\)/);
  r = await run(f, { n: 3, args: ["--max-wall-s", "60", "--dry-run", "--grok-permissions-inspect", "inspect --json"], env: { FAKE_GROK_INSPECT_LOADED: "0" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /the Grok CLI reports 0 loaded permission rules/);
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
    // A reviewer reads the source first (the coverage gate counts the hook-approved read: coverage.mjs, L-501).
    'agy_read "$dir/hello.txt" >/dev/null || true',
    'agy_write "$dir/.review-tests/mine.test.mjs" \'import test from "node:test"; test("ok", () => {});\' || true',
    'agy_write "$dir/pantheon/evil.mjs" "x" || true',
    // The listed test command is the review's verify launcher in its control dir (the CLI's cwd); the jail hook
    // approves it and it runs the files in a verify jail. A shell command is denied.
    'agy_run "$(pwd)/pantheon-test pantheon/tests/other.test.mjs .review-tests/mine.test.mjs" > "$(pwd)/run/launcher.out" 2>&1 || { cat "$(pwd)/run/launcher.out" >&2; exit 9; }',
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
  assert.deepEqual(decisions, [["view_file", "auto_approve"], ["write_file", "auto_approve"], ["write_file", "deny"], ["run_command", "auto_approve"], ["run_command", "deny"]]);
  // THE COVERAGE GATE (L-501): one source read, no denied read, one test run through the launcher.
  assert.deepEqual([t.coverage.source_reads, t.coverage.denied_reads, t.coverage.tests_run, t.coverage.files_read_sample, t.coverage_gate.ok], [1, 0, 1, ["hello.txt"], true]);
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

// ---- --reviewer <lab>:<model>: another lab's reviewer on an assignment, with that lab's transport ------------------
const overrideHeader = (h, { lab, model, def }) => {
  for (const line of [`- lab: ${lab}`, `- requested_model: \`${model}\``, `- default_reviewer: ${def}`]) assert.ok(h.includes(line), line);
  assert.match(h, new RegExp(`^- reviewer_override: true \\(--reviewer ${lab.toLowerCase()}:${model.replace(/\./g, "\\.")}\\)$`, "m"));
};

test("--reviewer openai:<model> on assignment 1: codex-sdk transport, its ChatGPT-only guard and model check, assignment 1's write rule; plan names the substitution and findings-1-openai", async () => {
  const f = await setup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "60", "--dry-run", "--reviewer", "openai:gpt-6-astra"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const p = r.plan;
  assert.deepEqual([p.transport, p.lab, p.vendor, p.requested_model, p.reviewer_override, p.reviewer], ["codex-sdk", "OpenAI", "openai", "gpt-6-astra", true, "openai:gpt-6-astra"]);
  assert.deepEqual(p.default_reviewer, { lab: "Google", vendor: "gemini", model: "gemini-4-carbon" });
  assert.match(p.out.findings, /findings-1-openai\.md$/);
  assert.equal(p.sdk_options.config.forced_login_method, "chatgpt", "the ChatGPT-only guard");
  assert.equal(p.preflight.checks.model_list.status, "listed");
  assert.deepEqual(p.sandbox.filesystem[":workspace_roots"], { ".": "read", ".review-tests": "write" }, "assignment 1 writes .review-tests/ only");
  // The same model check as the lab's own assignments: an unlisted model is refused; an API-key login too.
  let x = await run(f, { n: 1, args: ["--max-wall-s", "60", "--dry-run", "--reviewer", "openai:gpt-9-nope"] });
  assert.equal(x.code, EXIT.refused); assert.match(x.out.err, /does not list gpt-9-nope/);
  x = await run(f, { n: 1, args: ["--max-wall-s", "60", "--dry-run", "--reviewer", "openai:gpt-6-astra"], env: { FAKE_CODEX_LOGIN: "apikey" } });
  assert.equal(x.code, EXIT.refused); assert.match(x.out.err, /reports an API key/);
});

test("--reviewer on a codex run: the header and transcript record the substitution; assignment 4 still writes nothing", async () => {
  const f = await setup();
  const r = await run(f, { n: 4, args: ["--max-wall-s", "60", "--reviewer", "openai:gpt-6-astra"] });
  assert.equal(r.code, EXIT.incomplete, r.out.err);   // codex runs no test (L-404): the coverage gate (L-501)
  assert.ok(r.files.includes("findings-4-openai.md"));
  overrideHeader(headerOf(await r.read("findings-4-openai.md")), { lab: "OpenAI", model: "gpt-6-astra", def: "OpenAI, `gpt-6.1-sol`" });
  const t = JSON.parse(await r.read("findings-4-openai.transcript.json"));
  assert.deepEqual([t.reviewer_override, t.reviewer, t.default_reviewer.model, t.requested_model], [true, "openai:gpt-6-astra", "gpt-6.1-sol", "gpt-6-astra"]);
  assert.ok(r.sdk.find(c => c.kind === "new").config_overrides.some(c => c.endsWith(`":workspace_roots"={"."="read"}}`)), "assignment 4: nothing writable");
  const d = await run(f, { n: 2, args: ["--max-wall-s", "60", "--dry-run"] });
  assert.equal(d.plan.reviewer_override, false, "without the flag: no override");
});

test("--reviewer xai:<model> on assignment 1: the grok CLI in the runner's jail; findings-1-xai", needBwrap, async () => {
  const f = await setup();
  await grokLogin(f);
  const r = await run(f, { n: 1, args: ["--max-wall-s", "60", "--dry-run", "--reviewer", "xai:grok-4.7"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual([r.plan.transport, r.plan.lab, r.plan.requested_model, r.plan.reviewer_override, r.plan.default_reviewer.lab], ["grok-cli", "xAI", "grok-4.7", true, "Google"]);
  assert.match(r.plan.out.findings, /findings-1-xai\.md$/);
  assert.equal(r.plan.argv[0], "bwrap");
});

test("--reviewer google:<model> on assignment 4: agy with the lane check and the review hook; assignment 4's hook owns no path", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 4, args: ["--max-wall-s", "120", "--dry-run", "--agy-cli", f.cli, "--reviewer", "google:gemini-4-carbon"], env: f.env });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const p = r.plan;
  assert.deepEqual([p.transport, p.lab, p.lane, p.reviewer_override, p.default_reviewer.model], ["agy-cli", "Google", "gemini-4-carbon-high", true, "gpt-6.1-sol"]);
  assert.deepEqual(p.hook_policy.owned_paths, [], "assignment 4 writes nothing, whoever reviews it");
  assert.match(p.out.findings, /findings-4-google\.md$/);
  const x = await run(f, { n: 4, args: ["--max-wall-s", "120", "--dry-run", "--agy-cli", f.cli, "--reviewer", "google:gemini-0-nope"], env: f.env });
  assert.equal(x.code, EXIT.refused, "the same lane check as assignment 1");
});

test("--reviewer refusals: bad syntax and an unknown lab are usage errors, before anything runs", async () => {
  const f = await setup();
  for (const [spec, why] of [["gemini-4-carbon", /must be <lab>:<model>/], ["google:", /must be <lab>:<model>/], ["Google:gemini-4-carbon", /must be <lab>:<model>/], ["anthropic:claude-x", /unknown lab "anthropic"/], ["google:a b", /must be <lab>:<model>/]]) {
    const r = await run(f, { n: 3, args: ["--max-wall-s", "60", "--dry-run", "--reviewer", spec] });
    assert.equal(r.code, EXIT.usage, spec); assert.match(r.out.err, why, spec);
  }
  assert.deepEqual(await calls(f.log), [], "no CLI was started");
});

test("--continue refuses when the reviewer override differs from the transcript's (either way)", async () => {
  const f = await setup();
  const r1 = await run(f, { n: 4, args: ["--max-wall-s", "60", "--reviewer", "openai:gpt-6-astra"], env: { FAKE_CLI_MODE: "partial" } });
  assert.equal(r1.code, EXIT.incomplete, r1.out.err);
  const tpath = join(f.outDir, "findings-4-openai.transcript.json");
  let r = await run(f, { n: 4, args: ["--max-wall-s", "60", "--continue", tpath] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /model gpt-6-astra vs gpt-6\.1-sol.*reviewer override openai:gpt-6-astra vs none/);
  r = await run(f, { n: 4, args: ["--max-wall-s", "60", "--continue", tpath, "--reviewer", "openai:gpt-6-astra"] });
  assert.equal(r.code, EXIT.incomplete, r.out.err);   // accepted (not refused); incomplete only for codex's refused tests (L-404)
  // A default run continued with a --reviewer naming the very same model is a different review too.
  const g = await setup();
  const d1 = await run(g, { n: 4, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "partial" } });
  assert.equal(d1.code, EXIT.incomplete);
  r = await run(g, { n: 4, args: ["--max-wall-s", "60", "--continue", join(g.outDir, "findings-4-openai.transcript.json"), "--reviewer", "openai:gpt-6.1-sol"] });
  assert.equal(r.code, EXIT.refused); assert.match(r.out.err, /reviewer override none vs openai:gpt-6\.1-sol/);
});
