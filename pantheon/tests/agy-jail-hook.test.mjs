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
import { prepareWorkerWorkspace, hookWrapper, JAIL_HOOK, HOOK_NAME } from "../src/agy/workspace.mjs";
import { decide } from "../src/agy/jail-hook.mjs";
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
const call = (name, args) => ({ toolCall: { name, args }, stepIdx: 1, conversationId: "c", workspacePaths: [], transcriptPath: "", modelName: "m" });

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "pantheon-jail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, "wt"), ctl = join(root, "ctl"), outside = join(root, "outside");
  for (const d of [wt, join(wt, ".git"), join(wt, "src", "a"), join(wt, "src", "b"), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wt, ".git", "config"), "[core]\n");
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**", "docs/a.md"], verify_cmd: "node --test tests/a.test.mjs",
    roles: ["math", "probe-helper"], mcp_server: MCP_SERVER_PATH, a2a_env: { PANTHEON_A2A_SOCKET: join(ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: "t0ken", PANTHEON_A2A_ROLES: "math,probe-helper", PANTHEON_UNIT_ID: "a" } });
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
    ["write_to_file", { TargetFile: `${wt}/src/a/../../../outside/x` }, "deny", /outside the unit's worktree/],
    ["write_to_file", { TargetFile: `${wt}/src/a/../b/x.mjs` }, "deny", /not one of the unit's owned paths/],
    ["write_to_file", { TargetFile: join(wt, ".git/config") }, "deny", /inside \.git/],
    ["write_to_file", { TargetFile: join(wt, "src/a/.agents/hooks.json") }, "deny", /inside \.agents/],
    ["write_to_file", { TargetFile: join(ctl, ".agents/hooks.json") }, "deny", /outside the unit's worktree/],
    ["write_to_file", { TargetFile: "src/a/impl.mjs" }, "deny", /not absolute/],
    ["write_to_file", {}, "deny", /names no target \(Path, TargetFile, AbsolutePath, File\)/],
    // write_file {Path, Content}: the tool agy 1.5.10 actually emitted (observed 2026-11-18); every check applies to Path.
    ["write_file", { Path: join(wt, "src/a/impl.mjs"), Content: "x" }, "auto_approve"],
    ["write_file", { Path: join(wt, "docs/b.md"), Content: "x" }, "deny", /not one of the unit's owned paths/],
    ["write_file", { Path: `${wt}/src/a/../../../outside/x`, Content: "x" }, "deny", /outside the unit's worktree/],
    ["write_file", { Path: join(wt, ".git/config"), Content: "x" }, "deny", /inside \.git/],
    ["write_file", { Path: "src/a/impl.mjs", Content: "x" }, "deny", /Path "src\/a\/impl\.mjs" is not absolute/],
    ["write_file", { Content: "x" }, "deny", /names no target/],
    ["write_file", { Path: join(wt, "docs/b.md"), TargetFile: join(wt, "src/a/impl.mjs") }, "deny", /docs\/b\.md is not one of/],
    ["replace_file_content", { Path: join(wt, "src/a/x.mjs") }, "auto_approve"],
    ["write_to_file", { AbsolutePath: join(wt, "src/a/y.mjs") }, "auto_approve"],
    ["write_to_file", { File: join(wt, "src/b/y.mjs") }, "deny", /not one of the unit's owned paths/],
    ["write_to_file", { TargetFile: join(wt, "src/a") }, "deny", /directory/],
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

test("read tools are auto-approved inside the worktree or the control dir only (never a bare allow); malformed input is denied", async t => {
  const { wt, ctl, outside, hook } = await setup(t);
  for (const [name, args] of [["view_file", { AbsolutePath: join(wt, "src/a/x.mjs") }], ["list_dir", { DirectoryPath: ctl }], ["grep_search", { SearchPath: wt, Query: "x" }],
    ["find_by_name", { SearchDirectory: wt, Pattern: "*.mjs" }], ["view_file_outline", { AbsolutePath: join(wt, "README.md") }], ["codebase_search", { Query: "x", TargetDirectories: [wt] }]]) {
    assert.equal((await hook(call(name, args))).decision, "auto_approve", name);
  }
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
  // A hook process whose stdout is closed still exits 0 (the write error is swallowed, not a crash).
  const closed = await new Promise(resolve => {
    const c = spawn(process.execPath, [JAIL_HOOK, ws.jail], { stdio: ["pipe", "pipe", "pipe"] });
    c.stdout.destroy();
    c.on("close", code => resolve(code));
    c.stdin.end(JSON.stringify(write));
  });
  assert.equal(closed, 0);
  // The pure decide() fails closed too.
  assert.match(decide(null, write).reason, /hook exception: the policy is not an object/);
  assert.equal(decide({ worktree: wt, owned_paths: ["src/a/**"] }, write).decision, "deny", "no roles: an exception, a deny");
  // A policy that cannot be read still logs next to jail.json when it can (run/ beside it).
  mkdirSync(join(root, "run"), { recursive: true });
  await viaNode(join(root, "garbage.json"));
  const row = JSON.parse(readFileSync(join(root, "run", "jail.log"), "utf8").trim().split("\n").at(-1));
  assert.deepEqual([row.decision, row.payload, typeof row.raw], ["deny", write, "string"]);
});
