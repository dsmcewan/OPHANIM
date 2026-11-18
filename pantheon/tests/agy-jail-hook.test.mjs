// The PRE-MUTATION write jail hook (src/agy/jail-hook.mjs), spawned as the CLI would spawn it: hook JSON on stdin,
// one decision JSON on stdout, exit 0, one line per decision in <control_dir>/run/jail.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkerWorkspace, JAIL_HOOK } from "../src/agy/workspace.mjs";

function hook(jail, stdin, mode = "pre") {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [JAIL_HOOK, jail, mode], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => { try { resolve({ code, out: JSON.parse(out), err }); } catch (e) { reject(new Error(`hook printed ${JSON.stringify(out)} (${err})`)); } });
    c.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}
const call = (name, args) => ({ toolCall: { name, args }, stepIdx: 1, conversationId: "c", workspacePaths: [], transcriptPath: "", modelName: "m" });

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "pantheon-jail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, "wt"), ctl = join(root, "ctl"), outside = join(root, "outside");
  for (const d of [wt, join(wt, ".git"), join(wt, "src", "a"), join(wt, "src", "b"), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(wt, ".git", "config"), "[core]\n");
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**", "docs/a.md"], verify_cmd: "node --test tests/a.test.mjs" });
  const log = () => readFileSync(ws.jail_log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  return { root, wt, ctl, outside, ws, log };
}

test("write tools: an owned path is auto-approved; traversal, .git, .agents, unowned paths, relative and missing targets are denied", async t => {
  const { wt, ctl, ws, log } = await setup(t);
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
    ["write_to_file", {}, "deny", /no TargetFile/],
    ["write_to_file", { TargetFile: join(wt, "src/a") }, "deny", /directory/],
  ];
  for (const [name, args, want, why] of cases) {
    const r = await hook(ws.jail, call(name, args));
    assert.equal(r.code, 0);
    assert.equal(r.out.decision, want, `${name} ${JSON.stringify(args)}: ${r.out.reason}`);
    if (why) assert.match(r.out.reason, why);
  }
  const rows = log();
  assert.equal(rows.length, cases.length, "one log line per decision");
  assert.deepEqual(rows.map(r => r.decision), cases.map(c => c[2]));
  assert.equal(rows[0].args.TargetFile, join(wt, "src/a/impl.mjs"));
});

test("symlinks: a final symlink, a symlinked directory that leaves the worktree, and one that leads to an unowned path are denied", async t => {
  const { wt, outside, ws } = await setup(t);
  symlinkSync(outside, join(wt, "src/a/escape"));                // a directory symlink out of the worktree
  symlinkSync(join(outside, "f"), join(wt, "src/a/file-link"));   // a final symlink
  symlinkSync("../b", join(wt, "src/a/to-b"));                    // inside the worktree, but into an unowned path
  for (const [p, why] of [["src/a/escape/x.mjs", /symlink that leaves the worktree/], ["src/a/file-link", /final symlink/], ["src/a/to-b/x.mjs", /resolved src\/b\/x\.mjs.*not one of/]]) {
    const r = await hook(ws.jail, call("write_to_file", { TargetFile: join(wt, p) }));
    assert.equal(r.out.decision, "deny", p);
    assert.match(r.out.reason, why);
  }
});

test("run_command: only the unit's exact verify_cmd, in the worktree", async t => {
  const { wt, ctl, ws, log } = await setup(t);
  const want = [
    [{ CommandLine: "node --test tests/a.test.mjs", Cwd: wt }, "auto_approve"],
    [{ CommandLine: "  node --test tests/a.test.mjs\n" }, "auto_approve"],
    [{ CommandLine: "node --test tests/a.test.mjs && rm -rf /", Cwd: wt }, "deny"],
    [{ CommandLine: "git commit -am x", Cwd: wt }, "deny"],
    [{ CommandLine: "node --test tests/a.test.mjs", Cwd: ctl }, "deny"],
    [{ CommandLine: "node --test tests/a.test.mjs", Cwd: "." }, "deny"],
    [{}, "deny"],
  ];
  for (const [args, decision] of want) assert.equal((await hook(ws.jail, call("run_command", args))).out.decision, decision, JSON.stringify(args));
  assert.match(log().at(-4).reason, /only the unit's verify_cmd may run/);
});

test("MCP: ask_subagent of pantheon-subagents is auto-approved under every accepted spelling; any other MCP tool and unknown tools are denied", async t => {
  const { ws } = await setup(t);
  for (const name of ["ask_subagent", "pantheon-subagents/ask_subagent", "mcp__pantheon-subagents__ask_subagent", "pantheon-subagents__ask_subagent"]) {
    assert.equal((await hook(ws.jail, call(name, { role: "math", question: "q" }))).out.decision, "auto_approve", name);
  }
  assert.equal((await hook(ws.jail, { toolCall: { name: "ask_subagent", server: "pantheon-subagents", args: {} } })).out.decision, "auto_approve");
  for (const name of ["other-server/ask_subagent", "pantheon-subagents/run_anything", "mcp__github__create_pull_request", "browser_open", "run_terminal", "find_by_name"]) {
    const r = await hook(ws.jail, call(name, {}));
    assert.equal(r.out.decision, "deny", name);
  }
  assert.equal((await hook(ws.jail, { toolCall: { name: "ask_subagent", server: "evil", args: {} } })).out.decision, "deny");
});

test("read tools are allowed inside the worktree or the control dir only; malformed input is denied; the hook always exits 0", async t => {
  const { wt, ctl, outside, ws, log } = await setup(t);
  assert.equal((await hook(ws.jail, call("view_file", { AbsolutePath: join(wt, "src/a/x.mjs") }))).out.decision, "allow");
  assert.equal((await hook(ws.jail, call("list_dir", { DirectoryPath: ctl }))).out.decision, "allow");
  assert.equal((await hook(ws.jail, call("grep_search", { SearchPath: wt, Query: "x" }))).out.decision, "allow");
  assert.equal((await hook(ws.jail, call("view_file", { AbsolutePath: "/etc/passwd" }))).out.decision, "deny");
  assert.equal((await hook(ws.jail, call("view_file", { AbsolutePath: join(outside, "secret") }))).out.decision, "deny");
  assert.equal((await hook(ws.jail, call("grep_search", { Query: "x" }))).out.decision, "deny", "no path argument: denied");
  for (const bad of ["{not json", "", "[]", JSON.stringify({ toolCall: {} }), JSON.stringify({ nothing: true })]) {
    const r = await hook(ws.jail, bad);
    assert.deepEqual([r.code, r.out.decision], [0, "deny"], bad);
    assert.match(r.out.reason, /malformed/);
  }
  // A missing policy fails closed too.
  const r = await hook(join(ctl, "missing.json"), call("write_to_file", { TargetFile: join(wt, "src/a/x") }));
  assert.deepEqual([r.code, r.out.decision], [0, "deny"]);
  // PostToolUse is an audit line and an empty answer.
  const post = await hook(ws.jail, call("write_to_file", { TargetFile: join(wt, "src/a/x") }), "post");
  assert.deepEqual(post.out, {});
  assert.equal(log().at(-1).event, "PostToolUse");
});
