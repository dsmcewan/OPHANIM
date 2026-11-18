// Subscription mode, the pieces without a run: the agy review hook policy (the jail hook with run_command_policy), the
// codex preflight parsers and argv, the grok stream parser and jail argv, the scrubbed env and the worktree check.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, loadPolicy } from "../src/agy/jail-hook.mjs";
import { prepareReviewWorkspace, reviewCardText, reviewLane, REVIEW_CARD, REVIEW_AGENT } from "../src/review-runner/agy.mjs";
import { allowedCommands, compareWorktree, scrubEnv, writeRule } from "../src/review-runner/cli-common.mjs";
import { codexArgv, parseLoginStatus, parseModelList, parseCodexEvents } from "../src/review-runner/codex.mjs";
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

test("codex argv: read-only for a no-write assignment, workspace-write otherwise; -a never; the prompt is the last argument; no sandbox bypass", () => {
  const a4 = codexArgv({ model: "gpt-6.1-sol", worktree: "/w", write_allowed: false, lastMessage: "/o/last-message.md", prompt: "P" });
  assert.deepEqual(a4, ["exec", "--json", "-m", "gpt-6.1-sol", "-C", "/w", "--skip-git-repo-check", "-a", "never", "--sandbox", "read-only", "-o", "/o/last-message.md", "P"]);
  const a2 = codexArgv({ model: "gpt-6-astra", worktree: "/w", write_allowed: true, lastMessage: "/o/l.md", prompt: "P" });
  assert.equal(a2[a2.indexOf("--sandbox") + 1], "workspace-write");
  for (const a of [a2, a4]) assert.ok(!a.some(x => /danger|bypass|full-auto|yolo/.test(x)));
  const ev = parseCodexEvents(['{"type":"thread.started","thread_id":"t"}', "garbage", '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"A"}}', '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}']);
  assert.deepEqual([ev.thread_id, ev.usage, ev.final_text, ev.unparsed, ev.turns_completed], ["t", { input_tokens: 5, output_tokens: 2 }, "A", 1, 2]);
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
