// Subscription mode, the pieces without a run: the agy review hook policy (the jail hook with run_command_policy), the
// codex preflight parsers, SDK options and event log, the grok stream parser and jail argv, the scrubbed env and the worktree check.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, loadPolicy } from "../src/agy/jail-hook.mjs";
import { prepareReviewWorkspace, reviewCardText, reviewLane, REVIEW_CARD, REVIEW_AGENT } from "../src/review-runner/agy.mjs";
import { allowedCommands, compareWorktree, scrubEnv, writeRule } from "../src/review-runner/cli-common.mjs";
import { codexSdkOptions, codexThreadOptions, findCodexSession, inspectCodexSdk, parseCodexEvents, parseLoginStatus, parseModelList, sdkKeyInjection, sdkSpawnArgv } from "../src/review-runner/codex.mjs";
import { Codex as RealCodex } from "@openai/codex-sdk";
import { grokBwrapArgs, parseGrokStream } from "../src/review-runner/grok.mjs";
import { permissionsFor } from "../src/review-runner/tools.mjs";
import { cardTools } from "../src/agy/workspace.mjs";
import { mkdtemp, cleanup } from "./review-runner-helper.mjs";

after(cleanup);

const OPEN = "Local deterministic fixtures", CLOSED = "Source inspection and existing authorized tests only";
const PASS = 'import test from "node:test";\ntest("ok", () => {});\n';

async function reviewJail({ testing, listed = [] }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "rr-hook-")));
  const wt = join(base, "wt"), ctl = join(base, "ctl"), outside = join(base, "outside");
  for (const d of ["pantheon/tests", "ophanim/operate", "scripts", ".review-tests", ".git"]) await mkdir(join(wt, d), { recursive: true });
  await mkdir(outside);
  for (const f of ["pantheon/tests/other.test.mjs", "pantheon/tests/agy-x.test.mjs", "ophanim/operate/x.test.mjs", "scripts/x.test.mjs", ".review-tests/mine.test.mjs"]) await writeFile(join(wt, f), PASS);
  await writeFile(join(outside, "evil.test.mjs"), PASS);
  await symlink(join(outside, "evil.test.mjs"), join(wt, ".review-tests/link.test.mjs"));
  const permissions = permissionsFor(testing, listed);
  const cmds = allowedCommands({ permissions, worktree: wt, prefixWithCd: true });
  const ws = await prepareReviewWorkspace({ control_dir: ctl, worktree: wt, n: listed.length ? 4 : 1, write_allowed: cmds.write_allowed, run_command_policy: cmds.run_command_policy });
  const policy = loadPolicy(ws.paths.jail);
  const d = (name, args) => decide(policy, { toolCall: { name, args } }).decision;
  return { wt, ctl, ws, policy, cmds, d, run: c => d("run_command", { CommandLine: c }) };
}

test("agy review hook, assignments 1-3: writes only under .review-tests/, run_command only `cd '<wt>' && node --test <allowed files>` and the suite commands", async () => {
  const j = await reviewJail({ testing: OPEN });
  const cd = `cd '${j.wt}' && `;
  assert.deepEqual(j.policy.owned_paths, [".review-tests/**"]);
  assert.equal(j.d("write_file", { Path: join(j.wt, ".review-tests/new.test.mjs"), Content: PASS }), "auto_approve");
  for (const p of [join(j.wt, "pantheon/x.mjs"), join(j.wt, ".review-tests/../pantheon/x.mjs"), join(j.wt, ".git/config"), "/tmp/x.test.mjs", ".review-tests/rel.test.mjs", join(j.wt, ".review-tests/link.test.mjs")]) {
    assert.equal(j.d("write_file", { Path: p, Content: "x" }), "deny", p);
  }
  for (const c of [`${cd}node --test pantheon/tests/other.test.mjs`, `${cd}node --test pantheon/tests/other.test.mjs ophanim/operate/x.test.mjs .review-tests/mine.test.mjs`,
    `  ${cd}node --test .review-tests/mine.test.mjs  `, `${cd}npm run test:proof`, `${cd}npm --prefix pantheon test`, `${cd}npm test`]) assert.equal(j.run(c), "auto_approve", c);
  for (const c of ["node --test pantheon/tests/other.test.mjs", `${cd}node --test scripts/x.test.mjs`, `${cd}node --test pantheon/tests/other.test.mjs; rm -rf /`,
    `${cd}node --test pantheon/tests/other.test.mjs && curl x`, `${cd}node --test  pantheon/tests/other.test.mjs`, `${cd}node --test --test-reporter=spec pantheon/tests/other.test.mjs`,
    `${cd}node --test /etc/passwd`, `${cd}node --test pantheon/tests/../../outside/evil.test.mjs`, `${cd}node --test .review-tests/link.test.mjs`, `${cd}node --test .review-tests/absent.test.mjs`,
    `${cd}node --test $(id).test.mjs`, `${cd}node --test pantheon/tests/other.test.mjs\nid`, `${cd}npm test -- --x`, `${cd}npm run test:proof; id`, `cd '/tmp' && node --test pantheon/tests/other.test.mjs`, `${cd}node --test`]) {
    assert.equal(j.run(c), "deny", c);
  }
  assert.equal(j.d("run_command", { CommandLine: `${cd}npm test`, Cwd: "/tmp" }), "deny");
  assert.equal(j.d("run_command", { CommandLine: `${cd}npm test`, Cwd: j.wt }), "auto_approve");
  // No MCP, no native subagents; reads stay inside the worktree or the control dir.
  assert.equal(j.d("call_mcp_tool", { ServerName: "pantheon-subagents", ToolName: "ask_subagent", Arguments: { role: "x", question: "q" } }), "deny");
  assert.equal(j.d("mcp_pantheon-subagents_ask_subagent", { role: "x", question: "q" }), "deny");
  assert.equal(j.d("invoke_subagent", { Name: "x" }), "deny");
  assert.equal(j.d("view_file", { AbsolutePath: join(j.wt, "pantheon/tests/other.test.mjs") }), "auto_approve");
  assert.equal(j.d("view_file", { AbsolutePath: "/etc/passwd" }), "deny");
  // The card keeps its write tools; the MCP config has no server.
  assert.deepEqual(cardTools(await readFile(j.ws.paths.card, "utf8")), ["view_file", "write_file", "replace_file_content", "run_command"]);
  assert.deepEqual(JSON.parse(await readFile(j.ws.paths.mcp_config, "utf8")), { mcpServers: {} });
});

test("agy review hook, assignment 4: no write at all, run_command only each listed test file, no suite", async () => {
  const j = await reviewJail({ testing: CLOSED, listed: ["pantheon/tests/agy-x.test.mjs"] });
  const cd = `cd '${j.wt}' && `;
  assert.deepEqual(j.policy.owned_paths, []);
  assert.deepEqual(j.cmds.lines, [`- \`${cd}node --test pantheon/tests/agy-x.test.mjs\``]);
  for (const p of [join(j.wt, ".review-tests/new.test.mjs"), join(j.wt, "pantheon/x.mjs")]) {
    assert.equal(j.d("write_file", { Path: p, Content: "x" }), "deny", p);
    assert.equal(j.d("replace_file_content", { TargetFile: p }), "deny", p);
  }
  assert.equal(j.run(`${cd}node --test pantheon/tests/agy-x.test.mjs`), "auto_approve");
  for (const c of [`${cd}node --test pantheon/tests/other.test.mjs`, `${cd}node --test .review-tests/mine.test.mjs`, `${cd}npm test`, `${cd}npm run test:proof`]) assert.equal(j.run(c), "deny", c);
  assert.deepEqual(cardTools(await readFile(j.ws.paths.card, "utf8")), ["view_file", "run_command"]);
  assert.match(writeRule({ write_allowed: false, worktree: j.wt }), /may not create, change or delete any file/);
});

test("the hook process itself, through the review workspace's wrapper, decides with the review policy (stdin -> one decision line)", async () => {
  const j = await reviewJail({ testing: OPEN });
  const ask = payload => new Promise((res, rej) => {
    const c = spawn(j.ws.paths.hook_command, [], { cwd: join(j.ctl, ".agents"), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", d => (out += d)); c.on("error", rej); c.on("close", () => res(JSON.parse(out.trim()).decision));
    c.stdin.end(JSON.stringify(payload));
  });
  assert.equal(await ask({ toolCall: { name: "run_command", args: { CommandLine: `cd '${j.wt}' && node --test pantheon/tests/other.test.mjs` } } }), "auto_approve");
  assert.equal(await ask({ toolCall: { name: "run_command", args: { CommandLine: `cd '${j.wt}' && rm -rf .` } } }), "deny");
  const log = (await readFile(j.ws.paths.jail_log, "utf8")).trim().split("\n").map(l => JSON.parse(l).decision);
  assert.deepEqual(log, ["auto_approve", "deny"]);
});

test("a worker policy (no run_command_policy) keeps the worker rule: only `cd '<wt>' && <verify_cmd>`", () => {
  const policy = { worktree: "/w", owned_paths: ["a/**"], roles: [], verify_cmd: "npm test", worker_verify_cmd: "cd '/w' && npm test" };
  assert.equal(decide(policy, { toolCall: { name: "run_command", args: { CommandLine: "cd '/w' && npm test" } } }).decision, "auto_approve");
  assert.equal(decide(policy, { toolCall: { name: "run_command", args: { CommandLine: "cd '/w' && node --test a.test.mjs" } } }).decision, "deny");
  assert.equal(decide({ ...policy, run_command_policy: { kind: "other" } }, { toolCall: { name: "run_command", args: { CommandLine: "cd '/w' && npm test" } } }).decision, "deny");
});

test("the review card: named pantheon-reviewer-agent, its tools resolve on agy 1.5.10, and the read-only variant drops the write tools", async () => {
  const text = await readFile(REVIEW_CARD, "utf8");
  assert.match(text, new RegExp(`^name: ${REVIEW_AGENT}$`, "m"));
  assert.deepEqual(cardTools(reviewCardText(text, true)), ["view_file", "write_file", "replace_file_content", "run_command"]);
  assert.deepEqual(cardTools(reviewCardText(text, false)), ["view_file", "run_command"]);
  const lanes = JSON.parse(await readFile(new URL("../src/config/lanes.json", import.meta.url), "utf8"));
  assert.deepEqual([reviewLane(lanes, "gemini-4-carbon").ok, reviewLane(lanes, "gemini-4-carbon").id], [true, "gemini-4-carbon-high"]);
  assert.equal(reviewLane(lanes, "gemini-0-none").ok, false);
});

test("codex preflight parsers: ChatGPT vs API-key login (an API-key mention wins), model listed / missing / unknown", () => {
  assert.equal(parseLoginStatus("Logged in using ChatGPT\n", 0).method, "chatgpt");
  assert.equal(parseLoginStatus("Logged in using an API key - sk-proj-***ABCD\n", 0).method, "api-key");
  assert.equal(parseLoginStatus("Logged in using ChatGPT (API key also set)", 0).method, "api-key");
  assert.equal(parseLoginStatus("Not logged in", 1).method, "none");
  assert.equal(parseLoginStatus("Logged in using ChatGPT", 1).method, "unknown");
  assert.equal(parseLoginStatus("all good", 0).method, "unknown");
  const raw = parseLoginStatus("Logged in using an API key - sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", 0).raw;
  assert.doesNotMatch(raw, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.deepEqual(parseModelList(JSON.stringify({ models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6.1-sol" }] }), "gpt-6.1-sol"), { status: "listed", format: "json", count: 2 });
  assert.equal(parseModelList(JSON.stringify(["gpt-5", "gpt-6-astra"]), "gpt-6-astra").status, "listed");
  assert.equal(parseModelList(JSON.stringify({ models: [{ slug: "gpt-6-astra-mini" }] }), "gpt-6-astra").status, "missing");
  assert.equal(parseModelList("gpt-6-astra   GPT-6 Astra\ngpt-6.1-sol  Sol\n", "gpt-6.1-sol").status, "listed");
  assert.equal(parseModelList("gpt-6-astra-mini   x\n", "gpt-6-astra").status, "missing");
  assert.equal(parseModelList("~~~ ??? ~~~\n", "gpt-6-astra").status, "unknown");
  assert.equal(parseModelList(JSON.stringify({ ok: true }), "gpt-6-astra").status, "unknown");
  assert.equal(parseModelList("", "gpt-6-astra").status, "unknown");
});

test("codex SDK options: the scrubbed env and the pinned binary, never an apiKey or baseUrl; forced ChatGPT login unless allowed; no key in env", () => {
  const o = codexSdkOptions({ env: { HOME: "/h", PATH: "/bin" }, binary: "/b/codex" });
  assert.deepEqual(o, { env: { HOME: "/h", PATH: "/bin" }, codexPathOverride: "/b/codex", config: { forced_login_method: "chatgpt" } });
  assert.ok(!("apiKey" in o) && !("baseUrl" in o));
  assert.equal(codexSdkOptions({ env: {}, binary: "/b", allowApiKeyLogin: true }).config, undefined);
  // A key that slipped past the scrub is refused here too (defence in depth: the SDK passes env through verbatim).
  for (const k of ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]) assert.throws(() => codexSdkOptions({ env: { [k]: "x" }, binary: "/b" }), /refused/);
});

test("codex thread options and the argv the SDK builds: read-only for a no-write assignment, workspace-write otherwise; approval never; resume after the exec-level flags; no bypass", () => {
  const t4 = codexThreadOptions({ model: "gpt-6.1-sol", worktree: "/w", write_allowed: false });
  assert.deepEqual(t4, { model: "gpt-6.1-sol", sandboxMode: "read-only", workingDirectory: "/w", skipGitRepoCheck: true, approvalPolicy: "never" });
  assert.equal(codexThreadOptions({ model: "m", worktree: "/w", write_allowed: true }).sandboxMode, "workspace-write");
  const sdkOptions = codexSdkOptions({ env: {}, binary: "/b/codex" });
  const a = sdkSpawnArgv({ binary: "/b/codex", sdkOptions, threadOptions: t4 });
  assert.deepEqual(a, ["/b/codex", "exec", "--experimental-json", "--config", 'forced_login_method="chatgpt"', "--model", "gpt-6.1-sol", "--sandbox", "read-only", "--cd", "/w", "--skip-git-repo-check", "--config", 'approval_policy="never"']);
  assert.deepEqual(sdkSpawnArgv({ binary: "/b/codex", sdkOptions, threadOptions: t4, resumeId: "01a1f0fe-d28f" }).slice(-2), ["resume", "01a1f0fe-d28f"]);
  assert.ok(!a.some(x => /danger|bypass|full-auto|yolo/.test(x)));
});

test("codex event log: usage summed over turns, the last agent message is final, commands/file changes/non-fatal item errors kept, retries recorded as errors", () => {
  const ev = parseCodexEvents([{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message: "Reconnecting... 1/5 (x)" },
    { type: "item.completed", item: { id: "1", type: "error", message: "model mismatch warning" } },
    { type: "item.completed", item: { id: "2", type: "command_execution", command: "node --test a", aggregated_output: "ok", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "3", type: "file_change", changes: [{ path: ".review-tests/a.test.mjs", kind: "add" }], status: "completed" } },
    { type: "item.started", item: { id: "4", type: "agent_message", text: "draft" } },
    { type: "item.completed", item: { id: "4", type: "agent_message", text: "A" } }, { type: "item.completed", item: { id: "5", type: "reasoning", text: "r" } },
    { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }, { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }]);
  assert.deepEqual([ev.thread_id, ev.usage, ev.final_text, ev.turns_completed, ev.errors.length, ev.item_errors, ev.other_items], ["t", { input_tokens: 5, output_tokens: 2 }, "A", 2, 1, ["model mismatch warning"], { reasoning: 1 }]);
  assert.deepEqual(ev.commands, [{ command: "node --test a", exit_code: 0, status: "completed" }]);
  assert.deepEqual(ev.own.map(o => o.kind), ["command and its output", "file change", "your message"]);
  assert.equal(parseCodexEvents([{ type: "turn.failed", error: { message: "usage limit reached" } }]).turn_failed, "usage limit reached");
});

test("the SDK's CODEX_API_KEY check: only `env.CODEX_API_KEY = args.apiKey;` under `if (args.apiKey) {` passes", () => {
  const ok = "    if (args.apiKey) {\n      env.CODEX_API_KEY = args.apiKey;\n    }\n";
  assert.deepEqual([sdkKeyInjection(ok).conditional, sdkKeyInjection(ok).sites], [true, [2]]);
  assert.equal(sdkKeyInjection("    env.CODEX_API_KEY = args.apiKey ?? process.env.OPENAI_API_KEY;\n").conditional, false, "unconditional");
  assert.equal(sdkKeyInjection(ok + "    env.CODEX_API_KEY ??= defaultKey;\n").conditional, false, "a second site");
  assert.equal(sdkKeyInjection("no key here").conditional, false, "the shape changed: not assumed safe");
});

test("the REAL installed @openai/codex-sdk (no run): the pinned version, the API this runner calls, CODEX_API_KEY only under an apiKey option, and the binary the runner preflights is the one the SDK resolves", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sdk = inspectCodexSdk();
  assert.equal(sdk.ok, true, sdk.why);
  assert.equal(sdk.version, pkg.dependencies["@openai/codex-sdk"], "package.json pins the installed version exactly");
  assert.equal(typeof RealCodex, "function");
  for (const m of ["startThread", "resumeThread"]) assert.equal(typeof RealCodex.prototype[m], "function", m);
  const codex = new RealCodex({ env: { PATH: "/usr/bin:/bin" }, ...(sdk.binary.ok ? {} : { codexPathOverride: "/nonexistent/codex" }) });
  const thread = codex.startThread({ workingDirectory: "/tmp", skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never" });
  assert.equal(typeof thread.runStreamed, "function");
  assert.equal(thread.id, null, "no id before a turn: nothing was spawned");
  assert.equal(codex.resumeThread("01a1f0fe-d28f-7f51-8780-eb527ce4afc2").id, "01a1f0fe-d28f-7f51-8780-eb527ce4afc2");
  assert.deepEqual([sdk.key_injection.conditional, sdk.key_injection.bad], [true, []], "an SDK that sets CODEX_API_KEY without an apiKey option is refused at preflight");
  // The runner's mirror of the SDK's binary resolution names the binary the SDK itself would spawn (a private field,
  // read here only to check the mirror; the runner never reads it).
  if (sdk.binary.ok) {
    assert.equal(new RealCodex({ env: {} }).exec.executablePath, sdk.binary.path);
    assert.deepEqual(new RealCodex({ env: {} }).exec.pathDirs, sdk.binary.path_dirs);
  }
});

test("findCodexSession: a rollout file for the thread under $CODEX_HOME (or ~/.codex)/sessions, else null", async () => {
  const home = await mkdtemp(join(tmpdir(), "rr-codex-home-"));
  const id = "01a1f0fe-d28f-7f51-8780-eb527ce4afc2";
  assert.equal(findCodexSession(id, { HOME: home }), null);
  await mkdir(join(home, ".codex", "sessions", "2026", "11", "18"), { recursive: true });
  await writeFile(join(home, ".codex", "sessions", "2026", "11", "18", `rollout-2026-11-18T23-29-54-${id}.jsonl`), "{}\n");
  assert.match(findCodexSession(id, { HOME: home }), /rollout-.*\.jsonl$/);
  assert.equal(findCodexSession(id, { HOME: "/nonexistent", CODEX_HOME: join(home, ".codex") }) !== null, true);
  assert.equal(findCodexSession("../../etc", { HOME: home }), null);
  assert.equal(findCodexSession(null, { HOME: home }), null);
});

test("grok: the stream is parsed tolerantly; the jail mounts the worktree read-only with .review-tests read-write only when writing is allowed", () => {
  const s = parseGrokStream(['{"type":"start"}', "nope", '{"type":"message","role":"assistant","content":"partial"}', '{"type":"result","result":"FINAL","usage":{"t":1}}', ""]);
  assert.deepEqual([s.final_text, s.unparsed, s.events, s.usage], ["FINAL", 1, 3, { t: 1 }]);
  assert.equal(parseGrokStream(['{"role":"assistant","content":[{"type":"text","text":"AB"}]}']).final_text, "AB");
  assert.equal(parseGrokStream(["x"]).final_text, null);
  const rw = grokBwrapArgs({ worktree: "/w", write_allowed: true, state: { dir: "/h/.grok", scratch: "/r/grok-state" }, cliDir: "/c" });
  const s1 = rw.argv.join(" ");
  assert.match(s1, /--ro-bind \/ \/ .*--tmpfs \/tmp/);
  assert.match(s1, /--ro-bind \/w \/w .*--bind \/w\/\.review-tests \/w\/\.review-tests/);
  assert.match(s1, /--bind \/r\/grok-state \/h\/\.grok/);
  assert.ok(!rw.argv.includes("--unshare-net"), "the network is not cut");
  const ro = grokBwrapArgs({ worktree: "/w", write_allowed: false, state: { dir: "/h/.grok", scratch: "/r/s" }, cliDir: "/c" });
  assert.ok(!ro.binds.some(b => b.mode === "rw" && b.path.startsWith("/w")), "assignment 4: nothing in the worktree is writable");
});

test("scrubEnv removes every key, token and secret (and credentialed proxies); HOME and PATH stay", () => {
  const { env, removed } = scrubEnv({ PATH: "/bin", HOME: "/home/u", OPENAI_API_KEY: "sk", CODEX_API_KEY: "c", XAI_API_KEY: "x", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", NODE_OPTIONS: "--require x",
    HTTPS_PROXY: "http://u:p@proxy:1", HTTP_PROXY: "http://proxy:1", CODEX_HOME: "/c" }, { drop: ["OPENAI_ORG_ID"] });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "HOME", "HTTP_PROXY", "PATH"]);
  assert.deepEqual(removed, ["AWS_SECRET_ACCESS_KEY", "CODEX_API_KEY", "GITHUB_TOKEN", "HTTPS_PROXY", "NODE_OPTIONS", "OPENAI_API_KEY", "XAI_API_KEY"]);
});

test("compareWorktree: a change outside .review-tests/ (any change for assignment 4) and a moved HEAD are violations", () => {
  const st = (head, entries) => ({ head, ok: true, entries: new Map(entries) });
  const before = st("h1", [["node_modules/", "!!"]]);
  const after = st("h1", [["node_modules/", "!!"], [".review-tests/a.test.mjs", "??"], ["pantheon/x.mjs", " M"]]);
  assert.deepEqual(compareWorktree(before, after, { write_allowed: true }).violations, ["pantheon/x.mjs"]);
  assert.deepEqual(compareWorktree(before, after, { write_allowed: false }).violations, [".review-tests/a.test.mjs", "pantheon/x.mjs"]);
  assert.deepEqual(compareWorktree(before, st("h2", [["node_modules/", "!!"]]), { write_allowed: true }).violations, ["HEAD moved from h1 to h2"]);
  assert.deepEqual(compareWorktree(before, before, { write_allowed: false }).violations, []);
});
