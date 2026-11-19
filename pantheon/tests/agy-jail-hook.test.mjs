// The PRE-MUTATION jail hook (src/agy/jail-hook.mjs), spawned as the CLI would spawn it (owner-stated, 2026-11-18): the
// absolute command from .agents/hooks.json — the per-unit wrapper — run with cwd = .agents/, hook JSON on stdin, EXACTLY
// one decision line on stdout ("auto_approve" or "deny", never empty: an empty stdout would ALLOW), exit 0, one line
// per invocation (raw stdin + parsed payload + decision) in <control_dir>/run/jail.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { prepareWorkerWorkspace, hookWrapper, JAIL_HOOK, HOOK_NAME, HOOK_TIMEOUT_S } from "../src/agy/workspace.mjs";
import { decide, STDIN_TIMEOUT_MS, WRAPPER_TIMEOUT_S, WRITE_FAILED_EXIT, stdinTimeoutMs } from "../src/agy/jail-hook.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";

/** Run a hook command as agy does (sh -c <command>, cwd = .agents/); returns {code, lines, out, err}. */
function runCommand(command, cwd, stdin) {
  return new Promise((resolve, reject) => {
    const c = spawn("sh", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => resolve({ code, out, err, lines: out.split("\n").filter(Boolean) }));
    c.stdin.on("error", () => {});
    c.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}
const one = r => { assert.equal(r.lines.length, 1, `exactly one decision line, got ${JSON.stringify(r.out)} (${r.err})`); return JSON.parse(r.lines[0]); };
const A2A_TOKEN = "t0ken-a2a-0123456789abcdef";
const call = (name, args) => ({ toolCall: { name, args }, stepIdx: 1, conversationId: "c", workspacePaths: [], transcriptPath: "", modelName: "m" });

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "pantheon-jail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, "wt"), ctl = join(root, "ctl"), outside = join(root, "outside");
  for (const d of [wt, join(wt, ".git"), join(wt, "src", "a"), join(wt, "src", "b"), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wt, ".git", "config"), "[core]\n");
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**", "docs/a.md"], verify_cmd: "node --test tests/a.test.mjs",
    roles: ["math", "probe-helper"], mcp_server: MCP_SERVER_PATH, a2a_env: { PANTHEON_A2A_SOCKET: join(ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: A2A_TOKEN, PANTHEON_A2A_ROLES: "math,probe-helper", PANTHEON_UNIT_ID: "a" } });
  const log = () => readFileSync(ws.jail_log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const agentsDir = join(ws.control_dir, ".agents");
  const command = JSON.parse(readFileSync(ws.hooks, "utf8"))[HOOK_NAME].PreToolUse[0].hooks[0].command;
  const hook = async stdin => one(await runCommand(command, agentsDir, stdin));
  return { root, wt, ctl: ws.control_dir, outside, ws, log, hook, command, agentsDir };
}

test("hooks.json: the owner-stated shape, no BOM, one PreToolUse group matching .*, an absolute executable wrapper with no arguments; mcp_config marks ask_subagent eager", async t => {
  const { ws, command } = await setup(t);
  const bytes = readFileSync(ws.hooks);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no UTF-8 BOM");
  assert.equal(bytes[0], "{".charCodeAt(0));
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), { "pantheon-jail": { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: ws.hook_command, timeout: 30 }] }] } });
  assert.ok(isAbsolute(command) && !/\s/.test(command), "an absolute command with no arguments");
  assert.equal(command, join(ws.control_dir, "pantheon-jail-hook"));
  accessSync(command, constants.X_OK);
  assert.match(readFileSync(command, "utf8"), /^#!\/bin\/sh\n/);
  assert.ok(readFileSync(command, "utf8").includes(JAIL_HOOK) && readFileSync(command, "utf8").includes(ws.jail));
  const mcp = JSON.parse(readFileSync(ws.mcp_config, "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["pantheon-subagents"]);
  assert.deepEqual(mcp.mcpServers["pantheon-subagents"].tools, { ask_subagent: { eager: true } });
  assert.deepEqual(mcp.mcpServers["pantheon-subagents"].args, [MCP_SERVER_PATH]);
  const jail = JSON.parse(readFileSync(ws.jail, "utf8"));
  assert.deepEqual([jail.roles, jail.mcp.server, jail.mcp.tool, jail.mcp.wrapper, jail.hard_deny], [["math", "probe-helper"], "pantheon-subagents", "ask_subagent", "call_mcp_tool", ["invoke_subagent", "define_subagent"]]);
});

test("write tools: an owned path is auto-approved; traversal, .git, .agents, unowned paths, relative and missing targets are denied", async t => {
  const { wt, ctl, log, hook } = await setup(t);
  const cases = [
    ["write_to_file", { TargetFile: join(wt, "src/a/impl.mjs") }, "auto_approve"],
    ["replace_file_content", { TargetFile: join(wt, "src/a/deep/x.mjs") }, "auto_approve"],
    ["multi_replace_file_content", { TargetFile: join(wt, "docs/a.md") }, "auto_approve"],
    ["write_to_file", { TargetFile: join(wt, "docs/b.md") }, "deny", /not one of the unit's owned paths/],
    ["write_to_file", { TargetFile: join(wt, "src/b/impl.mjs") }, "deny", /not one of the unit's owned paths/],
    // A `..` (or `.`) component is refused AS WRITTEN, before normalisation (independent review round 2, assignment 4
    // (OpenAI gpt-6-astra, 77480d6), question 2: a symlink then `..` means something else on disk than lexically).
    ["write_to_file", { TargetFile: `${wt}/src/a/../../../outside/x` }, "deny", /has a "\.\." component: traversal is refused before normalisation/],
    ["write_to_file", { TargetFile: `${wt}/src/a/../b/x.mjs` }, "deny", /has a "\.\." component/],
    ["write_to_file", { TargetFile: `${wt}/src/a/../a/x.mjs` }, "deny", /has a "\.\." component/],
    ["write_to_file", { TargetFile: `${wt}/src/a/./x.mjs` }, "deny", /has a "\." component/],
    ["write_to_file", { TargetFile: join(wt, ".git/config") }, "deny", /inside \.git/],
    ["write_to_file", { TargetFile: join(wt, "src/a/.agents/hooks.json") }, "deny", /inside \.agents/],
    ["write_to_file", { TargetFile: join(ctl, ".agents/hooks.json") }, "deny", /outside the unit's worktree/],
    ["write_to_file", { TargetFile: "src/a/impl.mjs" }, "deny", /not absolute/],
    ["write_to_file", {}, "deny", /names no target \(Path, TargetFile, AbsolutePath, File\)/],
    // write_file {Path, Content}: the tool agy 1.5.10 actually emitted (observed 2026-11-18); every check applies to Path.
    ["write_file", { Path: join(wt, "src/a/impl.mjs"), Content: "x" }, "auto_approve"],
    ["write_file", { Path: join(wt, "docs/b.md"), Content: "x" }, "deny", /not one of the unit's owned paths/],
    ["write_file", { Path: `${wt}/src/a/../../../outside/x`, Content: "x" }, "deny", /traversal is refused/],
    ["write_file", { Path: join(wt, ".git/config"), Content: "x" }, "deny", /inside \.git/],
    ["write_file", { Path: "src/a/impl.mjs", Content: "x" }, "deny", /Path "src\/a\/impl\.mjs" is not absolute/],
    ["write_file", { Content: "x" }, "deny", /names no target/],
    ["write_file", { Path: join(wt, "docs/b.md"), TargetFile: join(wt, "src/a/impl.mjs") }, "deny", /docs\/b\.md is not one of/],
    ["replace_file_content", { Path: join(wt, "src/a/x.mjs") }, "auto_approve"],
    ["write_to_file", { AbsolutePath: join(wt, "src/a/y.mjs") }, "auto_approve"],
    ["write_to_file", { File: join(wt, "src/b/y.mjs") }, "deny", /not one of the unit's owned paths/],
    ["write_to_file", { TargetFile: join(wt, "src/a") }, "deny", /directory/],
    // EVERY path argument is checked, and they must agree (independent review round 2, assignment 4 (OpenAI
    // gpt-6-astra, 77480d6), question 2): an owned Path used to launder an unowned TargetFile (only the first was read).
    ["replace_file_content", { Path: join(wt, "src/a/x.mjs"), TargetFile: join(wt, "docs/b.md") }, "deny", /TargetFile|docs\/b\.md is not one of/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), AbsolutePath: join(ctl, ".agents/hooks.json") }, "deny", /outside the unit's worktree/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), File: join(wt, ".git/config") }, "deny", /inside \.git/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), TargetFile: join(wt, "src/a/y.mjs") }, "deny", /name different files .*conflicting targets are refused/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), TargetFile: join(wt, "src/a/x.mjs"), Content: "/etc/passwd" }, "auto_approve"],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), DestinationPath: join(wt, "docs/b.md") }, "deny", /docs\/b\.md is not one of/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), Extra: { SourceFile: "/etc/shadow" } }, "deny", /outside the unit's worktree/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), Other: join(wt, "src/b/x.mjs") }, "deny", /src\/b\/x\.mjs is not one of/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), Where: "~/.bashrc" }, "deny", /not absolute/],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), TargetFiles: [join(wt, "src/a/x.mjs"), join(wt, "README.md")] }, "deny", /README\.md is not one of/],
    ["write_to_file", { TargetFile: join(wt, "src/a/z.mjs"), CodeContent: "/x", EmptyFile: false, ReplacementChunks: [{ TargetContent: "/a", ReplacementContent: "/b" }] }, "auto_approve"],
    ["write_file", { Path: join(wt, "src/a/x.mjs"), TargetFile: 7 }, "deny", /TargetFile is not a path/],
  ];
  for (const [name, args, want, why] of cases) {
    const d = await hook(call(name, args));
    assert.equal(d.decision, want, `${name} ${JSON.stringify(args)}: ${d.reason}`);
    if (why) assert.match(d.reason, why);
  }
  const rows = log();
  assert.equal(rows.length, cases.length, "one log line per invocation");
  assert.deepEqual(rows.map(r => r.decision), cases.map(c => c[2]));
  assert.equal(rows[0].args.TargetFile, join(wt, "src/a/impl.mjs"));
  // The raw stdin is logged verbatim, with the parsed payload; the hook ran in .agents/ (owner-stated).
  assert.equal(rows[0].raw, JSON.stringify(call(...cases[0].slice(0, 2))));
  assert.deepEqual(rows[0].payload, call(...cases[0].slice(0, 2)));
  assert.equal(rows[0].cwd, join(ctl, ".agents"));
});

test("symlinks: a final symlink, a symlinked directory that leaves the worktree, and one that leads to an unowned path are denied", async t => {
  const { wt, outside, hook } = await setup(t);
  symlinkSync(outside, join(wt, "src/a/escape"));                // a directory symlink out of the worktree
  symlinkSync(join(outside, "f"), join(wt, "src/a/file-link"));   // a final symlink
  symlinkSync("../b", join(wt, "src/a/to-b"));                    // inside the worktree, but into an unowned path
  for (const [p, why] of [["src/a/escape/x.mjs", /symlink that leaves the worktree/], ["src/a/file-link", /final symlink/], ["src/a/to-b/x.mjs", /resolved src\/b\/x\.mjs.*not one of/]]) {
    const d = await hook(call("write_to_file", { TargetFile: join(wt, p) }));
    assert.equal(d.decision, "deny", p);
    assert.match(d.reason, why);
  }
});

// run_command carries no Cwd (observed on agy 1.5.10, 2026-11-18: {CommandLine, WaitMsBeforeAsync, toolSummary}), so the
// one approved command is the exact worker command that cds into the worktree; the plain verify_cmd is denied.
test("run_command: only the unit's exact WORKER command `cd '<worktree>' && <verify_cmd>` (a Cwd, if sent, must be the worktree); the plain verify_cmd is denied", async t => {
  const { wt, ctl, ws, log, hook } = await setup(t);
  const wv = `cd '${ws.worktree}' && node --test tests/a.test.mjs`;
  assert.equal(ws.worker_verify_cmd, wv);
  assert.deepEqual([JSON.parse(readFileSync(ws.jail, "utf8")).worker_verify_cmd, JSON.parse(readFileSync(ws.jail, "utf8")).schema], [wv, "pantheon.agy-jail/v3"]);
  const want = [
    [{ CommandLine: wv, WaitMsBeforeAsync: 5000, toolSummary: "Verify unit" }, "auto_approve"],
    [{ CommandLine: `  ${wv}\n` }, "auto_approve"],
    [{ CommandLine: wv, Cwd: wt }, "auto_approve"],
    [{ CommandLine: "node --test tests/a.test.mjs", WaitMsBeforeAsync: 5000 }, "deny"],
    [{ CommandLine: "node --test tests/a.test.mjs", Cwd: wt }, "deny"],
    [{ CommandLine: `${wv} && rm -rf /` }, "deny"],
    [{ CommandLine: "git commit -am x" }, "deny"],
    [{ CommandLine: wv, Cwd: ctl }, "deny"],
    [{ CommandLine: wv, Cwd: "." }, "deny"],
    [{}, "deny"],
  ];
  for (const [args, decision] of want) assert.equal((await hook(call("run_command", args))).decision, decision, JSON.stringify(args));
  assert.match(log().at(-4).reason, /only the unit's verify_cmd may run, exactly as the worker command/);
});

test("MCP: ask_subagent with an allowed role is auto-approved both DIRECTLY (eager) and through call_mcp_tool; other servers, tools, roles, invoke_subagent and define_subagent are denied", async t => {
  const { hook, log } = await setup(t);
  for (const name of ["ask_subagent", "pantheon-subagents/ask_subagent", "mcp__pantheon-subagents__ask_subagent", "pantheon-subagents__ask_subagent"]) {
    assert.equal((await hook(call(name, { role: "math", question: "q" }))).decision, "auto_approve", name);
  }
  assert.equal((await hook({ toolCall: { name: "ask_subagent", server: "pantheon-subagents", args: { role: "probe-helper", question: "q" } } })).decision, "auto_approve");
  // The lazy form (owner-stated): call_mcp_tool {ServerName, ToolName, Arguments}; Arguments may arrive as a JSON string.
  const wrapped = (ServerName, ToolName, Arguments) => call("call_mcp_tool", { ServerName, ToolName, Arguments });
  assert.equal((await hook(wrapped("pantheon-subagents", "ask_subagent", { role: "probe-helper", question: "q" }))).decision, "auto_approve");
  assert.equal((await hook(wrapped("pantheon-subagents", "ask_subagent", JSON.stringify({ role: "math", question: "q" })))).decision, "auto_approve");
  const denied = [
    [wrapped("pantheon-subagents", "ask_subagent", { role: "devops", question: "q" }), /role "devops" is not one of/],
    [wrapped("pantheon-subagents", "ask_subagent", { question: "q" }), /names no role/],
    [wrapped("pantheon-subagents", "run_anything", { role: "math" }), /not allowed/],
    [wrapped("github", "create_pull_request", {}), /github\/create_pull_request/],
    [wrapped(undefined, undefined, {}), /not allowed/],
    [wrapped("pantheon-subagents", "ask_subagent", "{not json"), /not a JSON object/],
    [call("pantheon-subagents/ask_subagent", { role: "devops", question: "q" }), /role "devops"/],
    [call("ask_subagent", { question: "q" }), /names no role/],
    [call("invoke_subagent", { Name: "x", Prompt: "p" }), /native subagents would escape the jail/],
    [call("define_subagent", { Name: "x" }), /native subagents would escape the jail/],
  ];
  for (const [payload, why] of denied) {
    const d = await hook(payload);
    assert.equal(d.decision, "deny", JSON.stringify(payload));
    assert.match(d.reason, why);
  }
  for (const name of ["other-server/ask_subagent", "pantheon-subagents/run_anything", "mcp__github__create_pull_request", "browser_open", "run_terminal", "search_web", "read_url_content"]) {
    assert.equal((await hook(call(name, { role: "math" }))).decision, "deny", name);
  }
  assert.equal((await hook({ toolCall: { name: "ask_subagent", server: "evil", args: { role: "math" } } })).decision, "deny");
  const row = log().find(r => r.tool === "call_mcp_tool" && r.decision === "auto_approve");
  assert.deepEqual(row.mcp, { form: "call_mcp_tool", server: "pantheon-subagents", tool: "ask_subagent", role: "probe-helper" });
});

test("MCP is denied when the unit has no MCP server configured", async t => {
  const root = mkdtempSync(join(tmpdir(), "pantheon-jail-nomcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "wt"));
  const ws = await prepareWorkerWorkspace({ control_dir: join(root, "ctl"), worktree: join(root, "wt"), unit_id: "a", owned_paths: ["x/**"], roles: ["math"] });
  const d = one(await runCommand(ws.hook_command, join(ws.control_dir, ".agents"), call("call_mcp_tool", { ServerName: "pantheon-subagents", ToolName: "ask_subagent", Arguments: { role: "math" } })));
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /no pantheon-subagents MCP server configured/);
});

test("read tools are auto-approved inside the worktree only (never a bare allow); malformed input is denied", async t => {
  const { wt, ctl, outside, hook } = await setup(t);
  for (const [name, args] of [["view_file", { AbsolutePath: join(wt, "src/a/x.mjs") }], ["grep_search", { SearchPath: wt, Query: "x" }],
    ["find_by_name", { SearchDirectory: wt, Pattern: "*.mjs" }], ["view_file_outline", { AbsolutePath: join(wt, "README.md") }], ["codebase_search", { Query: "x", TargetDirectories: [wt] }]]) {
    assert.equal((await hook(call(name, args))).decision, "auto_approve", name);
  }
  // The control dir is no longer readable: its .agents/mcp_config.json holds the A2A bearer token (independent review
  // round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 7). A symlink from the worktree into it is denied too.
  symlinkSync(ctl, join(wt, "src", "a", "ctl-link"));
  for (const [name, args] of [["list_dir", { DirectoryPath: ctl }], ["view_file", { AbsolutePath: join(ctl, ".agents", "mcp_config.json") }],
    ["read_file", { Path: join(ctl, ".agents", "mcp_config.json") }], ["view_file", { AbsolutePath: join(wt, "src/a/ctl-link/.agents/mcp_config.json") }]]) {
    const d = await hook(call(name, args));
    assert.equal(d.decision, "deny", `${name} ${JSON.stringify(args)}`);
  }
  assert.match((await hook(call("read_file", { Path: join(ctl, ".agents", "mcp_config.json") }))).reason, /inside the control dir/);
  assert.match((await hook(call("view_file", { AbsolutePath: `${wt}/src/a/../../README.md` }))).reason, /traversal is refused/);
  assert.equal((await hook(call("view_file", { AbsolutePath: "/etc/passwd" }))).decision, "deny");
  assert.equal((await hook(call("view_file", { AbsolutePath: join(outside, "secret") }))).decision, "deny");
  assert.equal((await hook(call("codebase_search", { Query: "x", TargetDirectories: [wt, "/etc"] }))).decision, "deny");
  assert.equal((await hook(call("grep_search", { Query: "x" }))).decision, "deny", "no path argument: denied");
  for (const bad of ["{not json", "", "[]", JSON.stringify({ toolCall: {} }), JSON.stringify({ nothing: true }), JSON.stringify(call("write_to_file", "{bad"))]) {
    const d = await hook(bad);
    assert.equal(d.decision, "deny", bad);
    assert.match(d.reason, /malformed/);
  }
});

// Assignment 3 Antigravity run, read_file (findings-3-google-77480d6, agy 1.5.11): the installed CLI advertised read_file
// {Path} as its only file-reading tool and the hook denied every source read ("tool read_file is not allowed for a unit
// worker"). It is a read tool now, with view_file's containment: inside the worktree approved, outside denied.
test("read_file (observed on agy 1.5.11) is a read tool: auto-approved inside the worktree, denied outside it and in the control dir", async t => {
  const { wt, outside, hook, log } = await setup(t);
  writeFileSync(join(wt, "package.json"), "{}\n");
  const d = await hook(call("read_file", { Path: join(wt, "package.json") }));
  assert.deepEqual([d.decision, d.reason], ["auto_approve", "a read inside the worktree"]);
  assert.notEqual(log().at(-1).reason, "tool read_file is not allowed for a unit worker");
  for (const p of ["/etc/passwd", join(outside, "secret"), "package.json"]) assert.equal((await hook(call("read_file", { Path: p }))).decision, "deny", p);
  assert.equal((await hook(call("read_file", {}))).decision, "deny", "no path: denied");
  // The CLI's other advertised tools without an observed argument shape stay denied (deny by default).
  for (const name of ["edit_file", "list_resources", "read_resource", "manage_task"]) assert.equal((await hook(call(name, { Path: join(wt, "package.json") }))).decision, "deny", name);
});

// Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 7: the hook log kept the raw payload,
// so a token the model echoed into a tool call (or a Bearer header in a command) was stored verbatim.
test("the hook log redacts the unit's A2A token (read from the control dir's MCP config) and Bearer/token= pairs", async t => {
  const { wt, hook, log } = await setup(t);
  const leaky = call("write_file", { Path: join(wt, "src/a/x.mjs"), Content: `const t = "${A2A_TOKEN}"; // Authorization: Bearer sk-abcdefghijklmnop token=zzzzzzzzzzzz` });
  assert.equal((await hook(leaky)).decision, "auto_approve");
  const row = log().at(-1), text = JSON.stringify(row);
  assert.ok(!text.includes(A2A_TOKEN), "the A2A token never reaches jail.log");
  assert.ok(!text.includes("sk-abcdefghijklmnop") && !text.includes("zzzzzzzzzzzz"), text);
  assert.equal(row.raw_redacted, true);
  assert.equal(row.args.Path, join(wt, "src/a/x.mjs"), "paths stay readable");
});

test("fail closed: an unreadable jail.json, one that is not JSON, a policy missing fields, a wrapper whose node prints nothing — each prints exactly one deny and exits 0", async t => {
  const { ws, wt, agentsDir, root } = await setup(t);
  const write = call("write_to_file", { TargetFile: join(wt, "src/a/x.mjs") });
  const viaNode = async (jail, stdin = write) => {
    const r = await runCommand(`'${process.execPath}' '${JAIL_HOOK}' '${jail}'`, agentsDir, stdin);
    assert.equal(r.code, 0, r.err);
    return one(r);
  };
  const cases = [];
  mkdirSync(join(root, "a-dir.json"));                                               // unreadable: EISDIR
  cases.push([join(root, "a-dir.json"), /hook exception: the jail policy .* could not be read/]);
  cases.push([join(root, "missing.json"), /hook exception: .*ENOENT/]);
  writeFileSync(join(root, "garbage.json"), "this is not json");
  cases.push([join(root, "garbage.json"), /hook exception: .*could not be read/]);
  const policy = JSON.parse(readFileSync(ws.jail, "utf8"));
  for (const k of ["roles", "owned_paths", "worktree"]) {
    const { [k]: _gone, ...rest } = policy;
    writeFileSync(join(root, `no-${k}.json`), JSON.stringify(rest));
    cases.push([join(root, `no-${k}.json`), new RegExp(`hook exception: .*lacks ${k}`)]);
  }
  for (const [jail, why] of cases) {
    const d = await viaNode(jail);
    assert.equal(d.decision, "deny", jail);
    assert.match(d.reason, why, jail);
  }
  // stdin that is not JSON, with a good policy.
  const d = await viaNode(ws.jail, "\u0000\u0001 not json");
  assert.deepEqual([d.decision, /malformed hook input: not JSON/.test(d.reason)], ["deny", true]);
  // A broken node behind the wrapper prints nothing: the wrapper itself answers with a deny (an empty stdout would ALLOW).
  const broken = join(root, "broken-hook");
  writeFileSync(broken, hookWrapper({ node: "/nonexistent/node", policy: ws.jail }), { mode: 0o755 });
  const r = await runCommand(broken, agentsDir, write);
  assert.equal(r.code, 0);
  assert.deepEqual(one(r), { decision: "deny", reason: "hook exception: the jail hook printed nothing" });
  // A hook process whose stdout is closed could not deliver its decision: that is NOT silently an answer (an empty
  // stdout ALLOWS), it exits WRITE_FAILED_EXIT so the wrapper prints the deny (independent review round 2, assignment 4
  // (OpenAI gpt-6-astra, 77480d6), question 1: the write error used to be swallowed with exit 0).
  const closed = await new Promise(resolve => {
    const c = spawn(process.execPath, [JAIL_HOOK, ws.jail], { stdio: ["pipe", "pipe", "pipe"] });
    c.stdout.destroy();
    c.on("close", code => resolve(code));
    c.stdin.end(JSON.stringify(write));
  });
  assert.equal(closed, WRITE_FAILED_EXIT);
  // The pure decide() fails closed too.
  assert.match(decide(null, write).reason, /hook exception: the policy is not an object/);
  assert.equal(decide({ worktree: wt, owned_paths: ["src/a/**"] }, write).decision, "deny", "no roles: an exception, a deny");
  // A policy that cannot be read still logs next to jail.json when it can (run/ beside it).
  mkdirSync(join(root, "run"), { recursive: true });
  await viaNode(join(root, "garbage.json"));
  const row = JSON.parse(readFileSync(join(root, "run", "jail.log"), "utf8").trim().split("\n").at(-1));
  assert.deepEqual([row.decision, row.payload, typeof row.raw], ["deny", write, "string"]);
});

// ---- Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 1: FAIL CLOSED ON TIME --------
// The wrapper used to buffer node's output in $(...) until node exited; a node stuck past the CLI's 30 s hook timeout was
// killed with the wrapper and left an EMPTY stdout, which ALLOWS (owner-stated). And the node hook's stdin timer printed
// a deny but never exited. These assert the DECISION TEXT and the time it took, not only an exit code.

/** Spawn `cmd` (sh -c) with stdin kept OPEN (as a CLI that never closes it); resolve {code, out, first_ms, ms}. */
function runOpenStdin(cmd, cwd, stdin, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const c = spawn("sh", ["-c", cmd], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", first_ms = null;
    c.stdout.on("data", d => { if (first_ms === null) first_ms = Date.now() - t0; out += d; });
    c.on("error", reject);
    c.on("close", code => { c.stdin.destroy(); resolve({ code, out, lines: out.split("\n").filter(Boolean), first_ms, ms: Date.now() - t0 }); });
    c.stdin.on("error", () => {});
    c.stdin.write(typeof stdin === "string" ? stdin : JSON.stringify(stdin));   // never ended
  });
}
const fakeNode = (root, name, body) => { const p = join(root, name); writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };

test("the wrapper kills a node that gives no decision within its own timeout and prints a deny that says so (not an empty stdout)", async t => {
  const { ws, root, agentsDir, wt } = await setup(t);
  const w = join(root, "stuck-hook");
  writeFileSync(w, hookWrapper({ node: fakeNode(root, "stuck-node", "exec sleep 600"), policy: ws.jail, timeout_s: 1 }), { mode: 0o755 });
  const r = await runOpenStdin(w, agentsDir, call("write_file", { Path: join(wt, "src/a/x.mjs") }));
  assert.equal(r.code, 0);
  assert.deepEqual(one(r), { decision: "deny", reason: "hook exception: the jail hook gave no decision within 1 s (the wrapper killed it)" });
  assert.ok(r.ms < 8000, `answered in ${r.ms} ms, well before the CLI's 30 s hook timeout`);
  // The default wrapper's timer is under the CLI's hook timeout (and over the node's stdin timer); one at or over it is refused.
  assert.ok(WRAPPER_TIMEOUT_S < HOOK_TIMEOUT_S && STDIN_TIMEOUT_MS < WRAPPER_TIMEOUT_S * 1000);
  assert.match(readFileSync(ws.hook_command, "utf8"), new RegExp(`sleep ${WRAPPER_TIMEOUT_S} `));
  assert.throws(() => hookWrapper({ policy: ws.jail, timeout_s: HOOK_TIMEOUT_S }), /under the CLI's 30 s hook timeout/);
});

test("the wrapper forwards a complete decision AS SOON AS node prints it, even when node then hangs; partial or non-decision output is a deny", async t => {
  const { ws, root, agentsDir } = await setup(t);
  const w1 = join(root, "w1");
  writeFileSync(w1, hookWrapper({ node: fakeNode(root, "approve-hang", `printf '%s\\n' '{"decision":"auto_approve","reason":"x"}'; exec sleep 600`), policy: ws.jail, timeout_s: 3 }), { mode: 0o755 });
  const r1 = await runOpenStdin(w1, agentsDir, "{}");
  assert.deepEqual(one(r1), { decision: "auto_approve", reason: "x" }, "exactly the one complete line, and no second decision after the kill");
  assert.ok(r1.first_ms !== null && r1.first_ms < 2500, `forwarded at ${r1.first_ms} ms, before the 3 s watchdog`);
  for (const [name, body] of [["partial", `printf '%s' '{"decision":"auto_approve","reason":"x"}'; exec sleep 600`],
    ["partial-exit", `printf '%s' '{"decision":"auto_approve","reason":"a}'; exit 3`], ["garbage", "echo '{}'; echo 'allow'"], ["silent-fail", "exit 3"]]) {
    const w = join(root, `w-${name}`);
    writeFileSync(w, hookWrapper({ node: fakeNode(root, `n-${name}`, body), policy: ws.jail, timeout_s: 1 }), { mode: 0o755 });
    const d = one(await runOpenStdin(w, agentsDir, "{}"));
    assert.equal(d.decision, "deny", name);
    assert.match(d.reason, /^hook exception: the jail hook (printed nothing|gave no decision within 1 s)/, name);
  }
});

test("the node hook with a stdin that never closes prints a deny AND exits (the CLI keeps stdin open); the real wrapper forwards it", async t => {
  const { ws, wt, agentsDir, log } = await setup(t);
  const env = { ...process.env, PANTHEON_JAIL_STDIN_TIMEOUT_MS: "300" };
  const r = await runOpenStdin(`'${process.execPath}' '${JAIL_HOOK}' '${ws.jail}'`, agentsDir, '{"toolCall":', { env });
  assert.equal(r.code, 0);
  assert.deepEqual(one(r), { decision: "deny", reason: "hook exception: stdin did not close within 300 ms" });
  assert.ok(r.ms < 5000, `the process exited after ${r.ms} ms (it used to linger until killed)`);
  const viaWrapper = await runOpenStdin(ws.hook_command, agentsDir, call("write_file", { Path: join(wt, "src/a/x.mjs") }), { env });
  assert.deepEqual(one(viaWrapper), { decision: "deny", reason: "hook exception: stdin did not close within 300 ms" });
  assert.ok(viaWrapper.ms < 5000);
  assert.equal(log().at(-1).decision, "deny");
  // The env variable may only LOWER the timer.
  assert.equal(stdinTimeoutMs({ PANTHEON_JAIL_STDIN_TIMEOUT_MS: "999999" }), STDIN_TIMEOUT_MS);
  assert.equal(stdinTimeoutMs({}), STDIN_TIMEOUT_MS);
});
