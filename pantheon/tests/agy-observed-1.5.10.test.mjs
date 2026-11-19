// REGRESSION against what agy 1.5.10 actually did on the owner's machine (the first real worker turn, commit 5efbba5,
// 2026-11-18; tests/fixtures/agy-1.5.10-observed.json). Each test names the defect it catches:
//   - the hook denied the real write tool `write_file {Path, Content}` as unknown, so the owned write was blocked and
//     the forbidden-write deny proved nothing about owned_paths;
//   - run_command carries no Cwd, so the plain verify_cmd would run wherever the CLI runs commands: only the exact
//     `cd '<worktree>' && <verify_cmd>` is approved now;
//   - the probe counted run_command ACTIVE -> ERROR (EROFS on bin/agentapi) as "ran";
//   - gemini_state_untouched failed on a host log file the jail could not reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, loadPolicy, workerVerifyCommand } from "../src/agy/jail-hook.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { bwrapArgs, geminiState, dropGeminiState, jailReach } from "../src/agy/sandbox.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { hostChanges, parseAgyProcesses, toolCallsOf, turnChecks, untouchedBy } from "../scripts/agy-worker-probe.mjs";

const OBS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agy-1.5.10-observed.json"), "utf8"));
const fill = (v, map) => JSON.parse(Object.entries(map).reduce((s, [k, x]) => s.split(k).join(x), JSON.stringify(v)));

async function unit(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-observed-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, "worktrees", "probe"), ctl = join(root, "control", "probe"), home = join(root, "home");
  mkdirSync(wt, { recursive: true });
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "probe", owned_paths: OBS.owned_paths, verify_cmd: OBS.verify_cmd, roles: OBS.roles,
    mcp_server: MCP_SERVER_PATH, a2a_env: { PANTHEON_A2A_SOCKET: join(ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: "t", PANTHEON_A2A_ROLES: OBS.roles.join(","), PANTHEON_UNIT_ID: "probe" } });
  const map = { "<wt>": wt, "<ctl>": ws.control_dir, "<home>": home };
  return { root, wt, ctl: ws.control_dir, home, ws, policy: loadPolicy(ws.jail), payloads: fill(OBS.hook_payloads, map), steps: fill(OBS.tool_steps, map), map };
}
/** The jail.log rows the hook would write for these payloads under `policy`. */
const rowsOf = (policy, payloads) => payloads.map(p => { const d = decide(policy, p); return { tool: p.toolCall.name, args: p.toolCall.args, payload: p, decision: d.decision, reason: d.reason }; });

test("the observed write_file {Path, Content} payloads: forbidden.txt -> deny BY THE OWNED-PATH POLICY, allowed/probe.txt -> auto_approve (they were both denied as an unknown tool)", async t => {
  const u = await unit(t);
  const [forbidden, allowed] = u.payloads;
  const f = decide(u.policy, forbidden), a = decide(u.policy, allowed);
  assert.equal(f.decision, "deny");
  assert.match(f.reason, /forbidden\.txt is not one of the unit's owned paths/);
  assert.doesNotMatch(f.reason, /not allowed for a unit worker/, "the deny is the path policy, not an unknown-tool deny");
  assert.deepEqual([a.decision, a.reason], ["auto_approve", "allowed/probe.txt is owned by unit probe"]);
  // write_file is NOT approved unchecked: every write check applies to Path.
  const w = args => decide(u.policy, { toolCall: { name: "write_file", args } }).decision;
  assert.equal(w({ Path: `${u.wt}/allowed/../forbidden.txt`, Content: "x" }), "deny");
  assert.equal(w({ Path: "allowed/probe.txt", Content: "x" }), "deny", "relative");
  assert.equal(w({ Path: join(u.wt, ".git", "config"), Content: "x" }), "deny");
  assert.equal(w({ Path: join(u.ctl, ".agents", "hooks.json"), Content: "x" }), "deny");
  assert.equal(w({ Content: "x" }), "deny", "no target");
  // The first present key wins: a Path outside cannot be laundered by an owned TargetFile next to it.
  assert.equal(w({ Path: join(u.wt, "forbidden.txt"), TargetFile: join(u.wt, "allowed", "x") }), "deny");
  assert.equal(w({ Path: 7, TargetFile: join(u.wt, "allowed", "x") }), "deny", "a present non-string Path is not skipped");
  assert.equal(w({ TargetFile: join(u.wt, "allowed", "x") }), "auto_approve", "TargetFile still works as a fallback");
  assert.equal(decide(u.policy, { toolCall: { name: "replace_file_content", args: { Path: join(u.wt, "allowed", "probe.txt") } } }).decision, "auto_approve", "Path for replace_file_content too");
  assert.equal(decide(u.policy, { toolCall: { name: "view_file", args: { Path: join(u.wt, "allowed", "probe.txt") } } }).decision, "auto_approve", "and for reads");
});

test("the observed direct MCP call mcp_pantheon-subagents_ask_subagent {question, role, toolSummary} -> auto_approve", async t => {
  const u = await unit(t);
  assert.deepEqual(decide(u.policy, u.payloads[2]), { decision: "auto_approve", reason: "pantheon-subagents/ask_subagent role probe-helper (direct)" });
});

test("the observed run_command {CommandLine, WaitMsBeforeAsync, toolSummary} with the PLAIN verify_cmd -> DENY now; the exact cd-prefixed worker command -> auto_approve", async t => {
  const u = await unit(t);
  const plain = u.payloads[3];
  assert.deepEqual(Object.keys(plain.toolCall.args).sort(), ["CommandLine", "WaitMsBeforeAsync", "toolSummary"], "observed: no Cwd");
  const d = decide(u.policy, plain);
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /only the unit's verify_cmd may run, exactly as the worker command/);
  const wv = workerVerifyCommand(u.wt, OBS.verify_cmd);
  assert.equal(wv, `cd '${u.wt}' && node -e "process.exit(0)"`);
  assert.equal(u.ws.worker_verify_cmd, wv, "jail.json carries the same string");
  assert.equal(JSON.parse(readFileSync(u.ws.jail, "utf8")).worker_verify_cmd, wv);
  const withCmd = cmd => ({ ...plain, toolCall: { ...plain.toolCall, args: { ...plain.toolCall.args, CommandLine: cmd } } });
  assert.equal(decide(u.policy, withCmd(wv)).decision, "auto_approve");
  assert.equal(decide(u.policy, withCmd(`  ${wv}\n`)).decision, "auto_approve", "trimmed");
  for (const bad of [`${wv}; rm -rf /`, `cd ${u.wt} && node -e "process.exit(0)"`, `cd '${u.wt}/..' && node -e "process.exit(0)"`, `cd '${u.wt}' &&  node -e "process.exit(0)"`]) {
    assert.equal(decide(u.policy, withCmd(bad)).decision, "deny", bad);
  }
  // A Cwd, if one is ever sent, must still be the worktree.
  assert.equal(decide(u.policy, { toolCall: { name: "run_command", args: { CommandLine: wv, Cwd: u.wt } } }).decision, "auto_approve");
  assert.equal(decide(u.policy, { toolCall: { name: "run_command", args: { CommandLine: wv, Cwd: u.ctl } } }).decision, "deny");
  // A worktree path with a quote is escaped, not broken out of.
  assert.equal(workerVerifyCommand("/tmp/it's", "make"), `cd '/tmp/it'\\''s' && make`);
});

test("the probe's step reader on the observed steps: ACTIVE never counts; run_command ACTIVE -> ERROR is verify_ran FALSE; ACTIVE -> DONE is true", async t => {
  const u = await unit(t);
  const calls = toolCallsOf(u.steps);
  assert.deepEqual(calls.map(c => [c.tool_name, c.states, c.ran]), [
    ["write_file", ["ACTIVE", "ERROR"], false], ["write_file", ["ACTIVE", "ERROR"], false],
    ["mcp_pantheon-subagents_ask_subagent", ["ACTIVE", "DONE"], true], ["run_command", ["ACTIVE", "ERROR"], false]]);
  assert.match(calls[3].error, /failed to write agentapi script: .*read-only file system/);
  assert.deepEqual(toolCallsOf([{ tool_name: "run_command", state: "ACTIVE" }]).map(c => c.ran), [false], "ACTIVE alone never ran");

  const wv = workerVerifyCommand(u.wt, OBS.verify_cmd);
  const run = { ...u.payloads[3], toolCall: { ...u.payloads[3].toolCall, args: { ...u.payloads[3].toolCall.args, CommandLine: wv } } };
  const rows = rowsOf(u.policy, [u.payloads[0], u.payloads[1], u.payloads[2], run]);
  const base = { rows, worktree: u.wt, workerVerify: wv, forbiddenAbsent: true, allowedContent: "probe-ok\n", shimCalls: [{ role: "probe-helper", status: "answered" }] };
  const doneSteps = u.steps.map((s, i) => (i === 1 || i === 3 ? { tool_name: "write_file", state: i === 1 ? "ERROR" : "DONE", tool_info: i === 1 ? s.tool_info : null } : s));
  // As observed (run_command ACTIVE -> ERROR): not run.
  assert.equal(turnChecks({ ...base, steps: doneSteps }).verify_ran, false);
  // ACTIVE -> DONE: run (no exit status reported: DONE decides, exit_status null).
  const ok = doneSteps.map((s, i) => (i === 7 ? { tool_name: "run_command", state: "DONE", tool_info: null } : s));
  const c = turnChecks({ ...base, steps: ok });
  assert.deepEqual([c.forbidden_denied, c.allowed_written, c.mcp_called, c.verify_ran, c.evidence.verify.exit_status], [true, true, true, true, null]);
  // DONE with a reported non-zero exit: not run successfully; with 0: run.
  assert.equal(turnChecks({ ...base, steps: ok.map((s, i) => (i === 7 ? { ...s, tool_info: { exit_code: 1 } } : s)) }).verify_ran, false);
  assert.equal(turnChecks({ ...base, steps: ok.map((s, i) => (i === 7 ? { ...s, tool_info: { output: "...\nExit code: 0" } } : s)) }).verify_ran, true);
  // A DONE followed by a later ERROR of the same tool is not a success.
  assert.equal(turnChecks({ ...base, steps: [...ok, { tool_name: "run_command", state: "ERROR", tool_info: { error: { message: "late" } } }] }).verify_ran, false);
  // The plain command (the observed CommandLine) is denied now, so even a DONE step would not count.
  assert.equal(turnChecks({ ...base, rows: rowsOf(u.policy, u.payloads), steps: ok }).verify_ran, false);
});

test("the probe's checks on the run exactly as observed at 5efbba5: no check passes that did not happen", async t => {
  const u = await unit(t);
  const rows = u.payloads.map((p, i) => ({ tool: p.toolCall.name, args: p.toolCall.args, payload: p, ...OBS.hook_decisions_at_5efbba5[i] }));
  const c = turnChecks({ rows, steps: u.steps, worktree: u.wt, workerVerify: OBS.verify_cmd, forbiddenAbsent: true, allowedContent: null, shimCalls: [{ role: "probe-helper", status: "answered" }] });
  assert.equal(c.forbidden_denied, false, "an unknown-tool deny proves nothing about owned_paths");
  assert.equal(c.allowed_written, false);
  assert.equal(c.mcp_called, true, "auto_approve + DONE + a shim call: this one did happen");
  assert.equal(c.verify_ran, false, "ACTIVE -> ERROR (EROFS): it did not run");
  // allowed_written also needs the content and the DONE; mcp_called needs the shim call.
  const u2 = turnChecks({ rows: rowsOf(u.policy, u.payloads), steps: u.steps, worktree: u.wt, workerVerify: OBS.verify_cmd, forbiddenAbsent: true, allowedContent: "probe-ok", shimCalls: [] });
  assert.deepEqual([u2.forbidden_denied, u2.allowed_written, u2.mcp_called], [true, false, false], "the allowed write's call ERRORed; no shim call");
});

test("the observed host change (a host log file under ~/.gemini/antigravity-cli/log/ grew) is OUTSIDE the jail's reach: reported, not a failure; a change under a read-write bind fails", async t => {
  const u = await unit(t);
  const g = join(u.home, ".gemini"), cli = join(g, "antigravity-cli");
  mkdirSync(join(cli, "log"), { recursive: true }); mkdirSync(join(cli, "bin"));
  const gs = await geminiState({ home: u.home, run_dir: join(u.ctl, "run") });
  t.after(() => dropGeminiState(gs));
  const { binds } = bwrapArgs({ worktree: u.wt, control_dir: u.ctl, gemini_state: gs });
  const hostLog = fill(OBS.host_change.path, u.map);
  assert.deepEqual([jailReach(binds, hostLog).reach, jailReach(binds, hostLog).jail_view], ["outside_jail_reach", "hidden"]);
  assert.deepEqual(jailReach(binds, join(cli, "bin", "agentapi")).reach, "outside_jail_reach", "the host bin/ is hidden by the scratch copy");
  assert.deepEqual([jailReach(binds, join(g, "settings.json")).reach, jailReach(binds, join(g, "settings.json")).jail_view], ["outside_jail_reach", "read-only"]);
  assert.equal(jailReach(binds, join(u.wt, "allowed", "x")).reach, "reachable_by_jail");
  assert.equal(jailReach(binds, join(gs.scratch_cli, "log", "x")).reach, "reachable_by_jail", "the scratch is what the jail writes");
  const roots = { cli_state: cli, config_projects: join(g, "config", "projects"), top: g };
  const before = { cli_state: { "log/cli-20261114_185251.log": "1000:1" }, config_projects: null, top: { "settings.json": "2:1" } };
  const after = { cli_state: { "log/cli-20261114_185251.log": "1306:2" }, config_projects: null, top: { "settings.json": "2:1" } };
  const ch = hostChanges(before, after, roots, binds);
  assert.deepEqual(ch.map(c => [c.path, c.change, c.reach, c.possible_writer, c.unresolved]), [[hostLog, "changed", "outside_jail_reach", "another host process", true]]);
  // Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 10: outside the jail's reach BY
  // PATH is where the binds point, not who wrote it; the change is UNRESOLVED evidence, never "untouched".
  assert.equal(untouchedBy(ch), null, "gemini_state_untouched: unresolved, not true");
  assert.equal(untouchedBy([]), true, "only no change at all is untouched");
  // The same change with that log dir bound read-write into the jail (an explicit agy state dir) is a failure.
  const rw = bwrapArgs({ worktree: u.wt, control_dir: u.ctl, gemini_state: gs, agy_state_dirs: [join(cli, "log")] }).binds;
  const ch2 = hostChanges(before, after, roots, rw);
  assert.deepEqual(ch2.map(c => c.reach), ["reachable_by_jail"]);
  assert.equal(untouchedBy(ch2), false);
  assert.equal(untouchedBy(hostChanges(before, after, roots, null)), true, "no jail ran: nothing the jail could have done");
});

// Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 10: a HARD-LINK alias of a host file
// inside a read-write bind changes the host file while its own path stays "outside the jail's reach"; realpath cannot
// name the alias. jailReach now reports such a file (nlink > 1) as unresolved, and the probe's snapshot sees the link.
test("a host file hard-linked from inside a writable bind is UNRESOLVED, not outside_jail_reach; its change is never 'untouched'", async t => {
  const u = await unit(t);
  const g = join(u.home, ".gemini"), cli = join(g, "antigravity-cli");
  mkdirSync(join(cli, "log"), { recursive: true });
  const gs = await geminiState({ home: u.home, run_dir: join(u.ctl, "run") });
  t.after(() => dropGeminiState(gs));
  const { binds } = bwrapArgs({ worktree: u.wt, control_dir: u.ctl, gemini_state: gs });
  const hostFile = join(g, "settings.json");
  writeFileSync(hostFile, "{}\n");
  assert.equal(jailReach(binds, hostFile).reach, "outside_jail_reach", "one link: read-only by path");
  try { linkSync(hostFile, join(u.wt, "alias.json")); } catch (e) { t.skip(`no hard link across these dirs (${e.code})`); return; }
  const r = jailReach(binds, hostFile);
  assert.deepEqual([r.reach, r.nlink], ["unresolved", 2]);
  assert.match(r.why, /2 hard links/);
  const roots = { cli_state: cli, config_projects: join(g, "config", "projects"), top: g };
  const ch = hostChanges({ cli_state: {}, config_projects: null, top: { "settings.json": "a" } }, { cli_state: {}, config_projects: null, top: { "settings.json": "b" } }, roots, binds);
  assert.deepEqual(ch.map(c => [c.reach, c.unresolved]), [["unresolved", true]]);
  assert.equal(untouchedBy(ch), null);
});

test("host agy processes are listed by binary only: args after the binary path are redacted", () => {
  const ps = ["    PID                  STARTED COMMAND",
    "    1 Wed Nov 18 09:00:00 2026 /sbin/init",
    " 4242 Wed Nov 18 09:12:01 2026 /home/u/.local/bin/agy --print secret-prompt --token abc",
    " 4243 Wed Nov 18 09:12:02 2026 /home/u/.gemini/antigravity-cli/bin/language_server_linux_x64 --api_server_url https://x --csrf_token SECRET",
    " 4244 Wed Nov 18 09:12:03 2026 node scripts/agy-worker-probe.mjs"].join("\n");
  const out = parseAgyProcesses(ps);
  assert.deepEqual(out, [
    { pid: 4242, started: "Wed Nov 18 09:12:01 2026", binary: "/home/u/.local/bin/agy", args_redacted: true },
    { pid: 4243, started: "Wed Nov 18 09:12:02 2026", binary: "/home/u/.gemini/antigravity-cli/bin/language_server_linux_x64", args_redacted: true }]);
  assert.doesNotMatch(JSON.stringify(out), /SECRET|secret-prompt|abc/);
});

test("the observed log lines are what the CLI-log parsers read (hooks loaded; workspaceDirs = [ctl, wt])", async t => {
  const { parseHooksLoaded, parseWorkspaceDirs } = await import("../src/board/agy-cli.mjs");
  const u = await unit(t);
  const h = parseHooksLoaded(OBS.log_lines.hooks_loaded);
  assert.deepEqual([h.named, h.files], [1, 1]);
  assert.deepEqual(parseWorkspaceDirs(fill(OBS.log_lines.workspace_dirs, u.map)).dirs, [u.ctl, u.wt]);
});
