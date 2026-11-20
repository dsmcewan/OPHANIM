// The one-turn live probe (scripts/agy-worker-probe.mjs), run as a child process against the FAKE agy under the REAL
// bwrap, with a FAKE HOME (the real ~/.gemini is never touched). The fake follows the probe's four steps — a write
// outside owned_paths, the owned write, ask_subagent (directly as the eager tool, or through call_mcp_tool), the verify
// command — through the jail hook and the MCP relay over the A2A socket, exactly as the probe expects of agy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgy, FAKE_MCP_CREDENTIAL } from "./fixtures/dispatch.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { FD_EXEC_MODULE } from "../src/agy/fd-exec.mjs";
import { CARD_TEMPLATE } from "../src/agy/workspace.mjs";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agy-worker-probe.mjs");
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

const usage = fraction => ({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon, Gemini 4 Hydrogen, Gemini 3.8 Flash", buckets: [
    { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: fraction, reset_time: "2026-11-25T01:58:17Z" },
    { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-18T06:58:17Z" }] },
  { name: "Claude and GPT models", description: "Models within this group: Claude Opus 5.5", buckets: [{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-25T01:58:17Z" }] }] } } });

const WORKER = `agy_write "$dir/forbidden.txt" 'forbidden' && echo "forbidden.txt was written" >&2
agy_write "$dir/allowed/probe.txt" 'probe-ok' || exit 9
if [ "$FAKE_PROBE_MCP" = wrapped ]; then ans=$(agy_mcp probe-helper "Reply with the word PROBE-ANSWER.") || exit 7
else ans=$(agy_ask probe-helper "Reply with the word PROBE-ANSWER.") || exit 7; fi
agy_verify > /dev/null 2>&1 || exit 8
reply=''
`;

async function setup(t, fraction = 0.8) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-probe-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A FAKE HOME (never the real one) with the agy 1.5.10 layout observed on the owner's machine (2026-11-18), including
  // the top-level antigravity-cli files that must be withheld (history.jsonl, conversation_summaries.db,
  // jetbox_summaries_proto.pb) and ~/.gemini/config/projects.
  const fx = join(root, "fx"), home = join(root, "home"), g = join(home, ".gemini"), c = join(g, "antigravity-cli");
  mkdirSync(fx); mkdirSync(join(c, "conversations"), { recursive: true }); mkdirSync(join(c, "plugins")); mkdirSync(join(c, "log"));
  mkdirSync(join(g, "config", "projects"), { recursive: true });
  writeFileSync(join(g, "config", "projects", "default-cli-project.json"), '{"host":1}');
  writeFileSync(join(c, "antigravity-oauth-token"), "fake-token"); writeFileSync(join(c, "installation_id"), "fake-id");
  writeFileSync(join(c, "history.jsonl"), '{"prompt":"host history"}\n'); writeFileSync(join(c, "conversation_summaries.db"), "db"); writeFileSync(join(c, "jetbox_summaries_proto.pb"), "pb");
  for (const f of ["GEMINI.md", "google_accounts.json", "installation_id", "projects.json", "state.json", "trustedFolders.json"]) writeFileSync(join(g, f), `${f}\n`);
  writeFileSync(join(g, "oauth_creds.json"), '{"refresh_token":"fake"}'); writeFileSync(join(g, "settings.json"), "{}");
  writeFileSync(join(c, "settings.json"), '{"cli":1}'); writeFileSync(join(c, "plugins", "p.json"), "plugin");
  writeFileSync(join(c, "conversations", "earlier.db"), "earlier");
  // bin/ as on the owner's host: run_command writes bin/agentapi first (observed 2026-11-18); a per-run writable copy.
  mkdirSync(join(c, "bin")); writeFileSync(join(c, "bin", "language_server"), "ls", { mode: 0o755 });
  const cli = fakeAgy(fx);
  writeFileSync(join(fx, "quota-report.txt"), JSON.stringify(usage(fraction))); writeFileSync(join(fx, "quota-exit"), "0");
  writeFileSync(join(fx, "worker.sh"), WORKER);
  const host = () => tree(home);
  const launches = () => existsSync(join(fx, "agy.log")) ? readFileSync(join(fx, "agy.log"), "utf8").split("\n").filter(Boolean) : [];
  const quotaProbes = () => existsSync(join(fx, "agy.quota.log")) ? readFileSync(join(fx, "agy.quota.log"), "utf8").split("\n").filter(Boolean).length : 0;
  const subs = () => existsSync(join(fx, "agy.log.sub")) ? readFileSync(join(fx, "agy.log.sub"), "utf8").split("\n").filter(Boolean) : [];
  return { root, fx, home, g, c, cli, host, launches, quotaProbes, subs };
}
function probe({ cli, fx, home }, extraEnv = {}, args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, FAKE_AGY_LOG: join(fx, "agy.log"), PANTHEON_AGY_STATE_DIRS: fx, FAKE_AGY_WORKER: join(fx, "worker.sh"), ...extraEnv };
    delete env.PANTHEON_AGY_CLI; delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY;
    const c = spawn(process.execPath, [PROBE, "--cli", cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => { try { resolve({ code, out, err, summary: JSON.parse(out) }); } catch { reject(new Error(`probe printed ${JSON.stringify(out.slice(0, 500))} (${err})`)); } });
  });
}
/** A recursive {relative path: content} listing of a host directory (directories end with "/"). */
const tree = dir => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) { out[r + "/"] = ""; walk(join(d, e.name), r); } else out[r] = readFileSync(join(d, e.name), "utf8"); } }; walk(dir, ""); return out; };
/** The processes of a host-wide agy listing that are THIS test's (their binary under the test's root); never the host's others. */
const ownAgy = (s, listing) => (listing.processes ?? []).filter(p => p.binary === s.cli || p.binary.startsWith(s.root + "/"));
const probeDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith("pantheon-agy-probe-"));

for (const form of ["direct", "wrapped"]) {
  test(`the probe against the fake agy (ask_subagent ${form === "direct" ? "as the eager tool" : "through call_mcp_tool"}): every check passes, exit 0`, needBwrap, async t => {
    const s = await setup(t);
    const hostBefore = s.host();
    const dirsBefore = probeDirs();
    // An AMBIENT agy (as on the owner's machine, 2026-11-19): a process named agy that is not this test's, running
    // throughout. The probe lists it (it is a host-wide listing), and the test must not count it as its own.
    // The decoy is this Node binary under the name agy (ps lists it as <decoyDir>/agy), so it runs on every host the
    // suite runs on: the ambient-process check below is made on every run, never skipped for want of a binary.
    const decoyDir = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-ambient-agy-")));
    symlinkSync(process.execPath, join(decoyDir, "agy"));
    const decoy = spawn(join(decoyDir, "agy"), ["-e", "setTimeout(() => {}, 300_000)"], { stdio: "ignore" });
    let decoyError = null;
    decoy.on("error", e => { decoyError = e; });
    t.after(() => { decoy.kill("SIGKILL"); rmSync(decoyDir, { recursive: true, force: true }); });
    const r = await probe(s, { FAKE_PROBE_MCP: form, FAKE_AGY_GEMINI_WRITES: form === "direct" ? "1" : "refresh" });
    assert.deepEqual(r.summary.aborted, null, JSON.stringify(r.summary.aborted));
    const o = r.summary;
    assert.equal(r.code, 0, `${JSON.stringify(o.checks)} ${o.turn?.error?.message ?? ""} ${o.stderr_tail ?? ""}`);
    assert.deepEqual(Object.keys(o), ["schema", "agy", "lane", "timeout_s", "quota_before", "quota_after", "launch", "preflight", "hook", "checks", "check_evidence", "mcp", "tools_run", "turn",
      "startup_errors", "deprecations", "diagnostics", "stderr_tail", "log_tail", "owner_stated_mechanics", "gemini_state", "aborted", "kept", "kept_contains_credentials"], "stable key order");
    // The zero-spend preflight ran first, in the same jail, and passed: the card's four tools, `agy agents` (exit 0, no
    // flag refused), the login, a clean output and log dir; discovery (advisory) found the worker and the server.
    assert.deepEqual([o.preflight.ok, o.preflight.failed, o.preflight.warnings, Object.keys(o.preflight.checks)], [true, [], ["hooks_discovery"], ["card_tools", "auth", "lane_quota", "agents", "mcp_list", "log_scan", "discovery", "hooks_discovery", "tool_drift"]]);
    // TOOL DRIFT (L-502, self-audit round 3, assignment 4 (sealed fe2a612)): the card's four tools are all classified by the hook.
    assert.deepEqual([o.preflight.checks.tool_drift.ok, o.preflight.checks.tool_drift.methods, o.preflight.checks.tool_drift.discovered], [true, ["card_frontmatter"], ["replace_file_content", "run_command", "view_file", "write_file"]]);
    assert.deepEqual([o.preflight.blocking, o.preflight.advisory], [["card_tools", "auth", "lane_quota", "agents", "log_scan", "tool_drift"], ["mcp_list", "discovery", "hooks_discovery"]]);
    // As observed (2026-11-18): the subcommands loaded 0 hooks.json files from the control dir (not a git repo): a
    // WARNING, surfaced, never blocking.
    assert.deepEqual([o.preflight.checks.hooks_discovery.seen, o.preflight.checks.hooks_discovery.files, o.preflight.checks.hooks_discovery.ok], [true, 0, false]);
    assert.deepEqual(o.preflight.checks.card_tools.tools, ["view_file", "write_file", "replace_file_content", "run_command"]);
    assert.match(o.preflight.checks.agents.stdout, /^pantheon-unit-worker\b/m);
    assert.deepEqual([o.preflight.checks.discovery.ok, o.preflight.checks.discovery.agent_listed, o.preflight.checks.discovery.server_listed], [true, true, true]);
    // `agy mcp list` output is never stored: only the server names.
    assert.deepEqual(o.preflight.checks.mcp_list.servers, ["context7", "pantheon-subagents"]);
    assert.equal(o.preflight.checks.mcp_list.credential_redacted, true);
    assert.ok(!("stdout" in o.preflight.checks.mcp_list) && !("stderr" in o.preflight.checks.mcp_list));
    assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL) && !r.out.includes("FAKE-CREDENTIAL"), "the credential `agy mcp list` printed is nowhere in the summary");
    // NO --log-file on either subcommand (observed: both reject it).
    assert.deepEqual([o.preflight.checks.agents.argv, o.preflight.checks.mcp_list.argv], [[s.cli, "agents"], [s.cli, "mcp", "list"]]);
    assert.deepEqual(s.subs(), ["agents", "mcp list"], "agents and mcp list ran once each, before the turn, without --log-file");
    assert.ok(!("log_file" in o.preflight) && !("log_file_accepted" in o.preflight.checks.agents));
    // The diagnostics the owner reads first: whether the --print session loaded <ctl>/.agents/hooks.json and which
    // directories it took as workspace -- both from the CLI's log FILE (the scratch's log/), read before cleanup.
    const ctl = o.launch.cwd, wt = o.launch.argv[o.launch.argv.indexOf("--add-dir") + 1];
    const direct = form === "direct" ? "mcp_pantheon-subagents_ask_subagent" : "call_mcp_tool";
    assert.deepEqual(Object.keys(o.diagnostics), ["hooks_loaded", "workspace_dirs", "cli_log", "gemini_dir_lines", "negative_login_lines"]);
    assert.deepEqual(o.diagnostics.hooks_loaded, { preflight: { named: 0, files: 0, sources: ["log_dir"] }, turn: { named: 1, files: 1, sources: ["log_dir"] } });
    assert.deepEqual(o.diagnostics.workspace_dirs, { preflight: null, turn: [ctl, wt] });
    const ct = o.diagnostics.cli_log.turn;
    assert.deepEqual([ct.files.map(x => x.name.replace(/\d+/g, "N")), ct.received_by.log_dir, ct.received_by.log_file > 0, ct.workspace_dirs_sources, "tail" in ct], [["cli-N.log"], 2, true, ["log_dir"], false],
      "the lines reached the log/ dir, not the --log-file; the summary keeps no raw tail in cli_log");
    assert.deepEqual(o.diagnostics.cli_log.preflight.files.map(x => x.command), ["agents", "mcp list"]);
    assert.deepEqual([o.diagnostics.negative_login_lines.advisory, o.diagnostics.negative_login_lines.lines.length > 0, o.diagnostics.gemini_dir_lines], [true, true, []],
      "the routine not-logged-in lines (in the log files) are advisory and did not block");
    assert.deepEqual([o.preflight.checks.auth.ok, o.preflight.checks.auth.num_turns, o.preflight.checks.auth.total_tokens, o.preflight.checks.lane_quota.quota_scope.state], [true, 0, 0, "available"]);
    assert.equal(o.kept_contains_credentials, null);
    assert.deepEqual([o.timeout_s, o.launch.argv[o.launch.argv.indexOf("--print-timeout") + 1]], [180, "180s"], "the default print timeout is 180 s");
    assert.deepEqual([o.startup_errors.length === 0, o.deprecations], [form === "direct", []], "no deprecated tool; startup errors only from the refresh writes");
    assert.equal(o.schema, "pantheon.agy-worker-probe/v1");
    assert.deepEqual([o.agy.path, o.agy.version, /^sha256:[0-9a-f]{64}$/.test(o.agy.sha256)], [s.cli, "fake-agy 0.0.0-fixture", true]);
    assert.equal(o.lane, "gemini-3.8-flash-low");
    assert.deepEqual([o.quota_before.state, o.quota_after.state, o.aborted], ["available", "available", null]);
    assert.deepEqual(o.checks, { forbidden_denied: true, allowed_written: true, mcp_called: true, verify_ran: true, gemini_state_untouched: true });
    // Forbidden: denied by the hook BEFORE any write (the first hook call, a deny; the owned write only after it).
    // The observed tool and shapes (agy 1.5.10, 2026-11-18): write_file {Path, Content}; run_command without a Cwd.
    assert.equal(o.hook.payloads[0].toolCall.name, "write_file");
    assert.equal(o.hook.payloads[0].toolCall.args.Path, join(wt, "forbidden.txt"));
    assert.match(o.hook.decisions[0].reason, /forbidden\.txt is not one of the unit's owned paths/, "denied by the owned-path policy, not as an unknown tool");
    assert.deepEqual(o.hook.decisions.map(d => [d.tool, d.decision]), [["write_file", "deny"], ["write_file", "auto_approve"],
      [direct, "auto_approve"], ["run_command", "auto_approve"]]);
    const run = o.hook.payloads[3].toolCall.args;
    // The worker's one command: the unit's verify launcher (it runs `cd '<wt>' && node -e ...` in the verify jail).
    assert.deepEqual([run.CommandLine, "Cwd" in run], [join(ctl, "pantheon-verify"), false], "the exact worker command, no Cwd");
    // The checks' evidence: each from the hook decision AND the call's terminal step.
    const ev = o.check_evidence;
    assert.deepEqual(ev.forbidden.attempts.map(a => [a.decision, a.states]), [["deny", ["ACTIVE", "ERROR"]]]);
    assert.match(ev.forbidden.attempts[0].error, /^tool call denied by pre-tool hook: /);
    assert.deepEqual(ev.allowed.attempts.map(a => [a.decision, a.states]), [["auto_approve", ["ACTIVE", "DONE"]]]);
    assert.deepEqual(ev.verify.attempts.map(a => [a.decision, a.states, a.exact, a.exit_status]), [["auto_approve", ["ACTIVE", "DONE"], true, 0]]);
    assert.deepEqual([ev.verify.exit_status, ev.mcp.shim_answered, ev.unpaired_rows], [0, true, []]);
    assert.ok(o.hook.decisions.every(d => d.cwd.endsWith("/control/probe/.agents")), "every hook ran in .agents/");
    assert.deepEqual([o.hook.call_mcp_tool_seen, o.hook.direct_mcp_seen, o.hook.invoke_subagent_attempted], [form === "wrapped", form === "direct", false]);
    // MCP: reached over the Unix socket inside bwrap; the subagent is a mock; zero API calls.
    assert.deepEqual(o.mcp.shim_calls.map(c => [c.role, c.status, c.vendor]), [["probe-helper", "answered", "mock"]]);
    assert.deepEqual([o.mcp.mock_subagent_turns, o.mcp.api_calls, o.mcp.socket_inside_bwrap], [1, 0, true]);
    assert.deepEqual(o.tools_run.map(x => [x.tool_name, x.state]), [["write_file", "ACTIVE"], ["write_file", "ERROR"], ["write_file", "ACTIVE"], ["write_file", "DONE"],
      [direct, "ACTIVE"], [direct, "DONE"], ["run_command", "ACTIVE"], ["run_command", "DONE"]]);
    assert.deepEqual([o.turn.exit_code, o.turn.status, o.turn.error, o.turn.usage], [0, "SUCCESS", null, { input_tokens: 1234, output_tokens: 56 }]);
    // The launch: bwrap, the argv with the prompt redacted, the token redacted, no forbidden flags.
    // KG-11: bwrap starts through the descriptor closer (node running src/agy/fd-exec.mjs).
    assert.deepEqual([o.launch.argv[0], o.launch.argv[1], o.launch.argv[2]], [process.execPath, FD_EXEC_MODULE, "bwrap"]);
    assert.ok(o.launch.argv.includes("<prompt>") && o.launch.argv.includes("--log-file") && o.launch.argv.includes("--add-dir"));
    assert.ok(!o.launch.argv.some(a => a === "--sandbox" || a.startsWith("--dangerously-skip-permissions")));
    // CREDENTIAL ISOLATION: the A2A token never enters the CLI's environment (the relay reads its token file).
    assert.equal(o.launch.env_added.PANTHEON_A2A_TOKEN, undefined);
    assert.doesNotMatch(r.out, /(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])/, "the A2A token (48 hex digits) appears nowhere");
    assert.ok(o.launch.bwrap_binds.some(b => b.path === join(s.g) && b.mode === "ro"));
    assert.match(o.log_tail, /fake-agy start agent=pantheon-unit-worker model=gemini-3\.8-flash-low/);
    // The gemini state: the host is unchanged; what the CLI wrote went to the per-run scratch copy, which is gone.
    assert.deepEqual(s.host(), hostBefore);
    const w = o.gemini_state.scratch_written;
    assert.equal(w.dir, s.c);
    assert.deepEqual(Object.fromEntries(Object.entries(w.subdirs).map(([k, v]) => [k, v.length])), { brain: 1, cache: 1, conversations: 1, crashes: 0, implicit: 1, log: 3, mcp: 1, presence: 1 },
      "log/: one CLI log per preflight subcommand, one for the turn");
    assert.deepEqual(w.writable_subdirs, { bin: [{ path: "agentapi", size: 26, copied: false, changed: true }, { path: "language_server", size: 2, copied: true, changed: false }] },
      "run_command's agentapi landed in the writable copy of bin/");
    // Host-state attribution: nothing changed on the host; the agy processes around the turn were listed. The listing
    // is HOST-wide (ps), so it is judged only for this test's own fake agy (its binary lives under this test's root):
    // ambient Antigravity processes on the machine running the suite (the owner's, 2026-11-19) are not this test's.
    assert.deepEqual(o.gemini_state.host_changes, []);
    for (const k of ["before", "after"]) assert.ok(Array.isArray(o.gemini_state.host_agy_processes[k].processes), `ps ran ${k} the turn`);
    assert.deepEqual([ownAgy(s, o.gemini_state.host_agy_processes.before), ownAgy(s, o.gemini_state.host_agy_processes.after)], [[], []], "none of this test's agy processes outlived its command");
    assert.ok(Number.isInteger(decoy.pid) && decoyError === null, `the ambient agy decoy is running: ${decoyError?.message ?? `pid ${decoy.pid}`}`);
    assert.ok(o.gemini_state.host_agy_processes.before.processes.some(p => p.pid === decoy.pid), "the ambient agy was listed (host-wide) and did not fail the test");
    assert.deepEqual(w.top_level.map(x => [x.name.replace(/\.\d+\.tmp$/, ".<rand>.tmp"), x.changed]),
      [["antigravity-oauth-token", false], ["installation_id", false], ["jetbox_summaries_proto.pb.<rand>.tmp", true], ["settings.json", false]]);
    assert.deepEqual(w.writable_copies, { "config/projects": [{ path: "default-cli-project.json", size: 2, copied: true, changed: true }] }, "the preflight's project write landed in the copy");
    // What the scratch was given: the allowlist only; history, summaries and databases withheld (names and sizes).
    assert.deepEqual(o.gemini_state.copied, ["antigravity-oauth-token", "installation_id", "settings.json"]);
    assert.deepEqual(o.gemini_state.withheld, [{ name: "conversation_summaries.db", size: 2 }, { name: "history.jsonl", size: 26 }, { name: "jetbox_summaries_proto.pb", size: 2 }]);
    assert.deepEqual(o.gemini_state.writable_copies, [{ path: "config/projects", dest: join(s.g, "config", "projects"), status: "copied", copied: ["default-cli-project.json"] }]);
    assert.ok(o.launch.bwrap_binds.some(b => b.path === join(s.g, "config", "projects") && b.mode === "rw"));
    assert.ok(o.launch.bwrap_binds.some(b => b.path === s.c && b.mode === "rw") && o.launch.bwrap_binds.some(b => b.path === join(s.c, "plugins") && b.mode === "ro"));
    // The owner-stated mechanics, judged from the evidence.
    const m = o.owner_stated_mechanics;
    assert.deepEqual(Object.keys(m), ["add_dir_workspace", "hooks_json_shape", "mcp_lazy_call_mcp_tool", "hook_decision_semantics", "state_mounts"]);
    assert.deepEqual([m.add_dir_workspace.status, m.hooks_json_shape.status, m.hook_decision_semantics.status], ["confirmed", "confirmed", "confirmed"]);
    assert.equal(m.mcp_lazy_call_mcp_tool.status, form === "wrapped" ? "confirmed" : "not exercised");
    // A refresh that tries to rewrite oauth_creds.json hits EROFS, and the probe shows it.
    if (form === "wrapped") {
      assert.equal(m.state_mounts.status, "refuted");
      assert.match(m.state_mounts.evidence.erofs_lines.join("\n"), /oauth_creds\.json refresh write failed: EROFS/); assert.match(o.stderr_tail, /EROFS/);
      assert.deepEqual(m.state_mounts.evidence.erofs_paths, [join(s.g, "oauth_creds.json"), join(s.g, "settings.json")], "the protected paths are listed");
      assert.match(m.state_mounts.evidence.note, /EROFS under a protected path/);
      assert.equal(o.startup_errors.filter(l => /EROFS|read-only/.test(l)).length, 2, "and they are startup errors");
    } else {
      assert.equal(m.state_mounts.status, "confirmed");
      assert.match(m.state_mounts.evidence.note, /writes landed in the scratch copy/);
      assert.equal(m.state_mounts.evidence.writes_in_scratch.length, 11, "the nine state writes, the turn's log/cli-<n>.log and bin/agentapi");
    }
    // One model invocation; the temp repo is cleaned up.
    assert.equal(s.launches().length, 1);
    assert.equal(s.quotaProbes(), 3, "the free quota probe before and after, and the preflight's in-jail /usage (the fixture dir is a writable state dir)");
    assert.deepEqual(probeDirs().filter(n => !dirsBefore.includes(n)), [], "no temp dir left behind");
  });
}

// OBSERVED (owner's machine, 2026-11-18): gemini_state_untouched read false only because a HOST log file under
// ~/.gemini/antigravity-cli/log/ grew during the probe -- a file the jail cannot reach (it sees the scratch there).
// Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 10: "cannot reach by path" does not
// identify the writer, so the change is UNRESOLVED evidence: gemini_state_untouched is null (not true), the probe exits 1
// (not every check passed), and the change is listed in gemini_state.unresolved_host_changes.
test("a host process writing ~/.gemini/antigravity-cli/log/ during the probe: classified outside_jail_reach (hidden), reported with possible_writer, UNRESOLVED (untouched null, exit 1)", needBwrap, async t => {
  const s = await setup(t);
  const hostLog = join(s.c, "log", "cli-20261114_185251.log");
  writeFileSync(hostLog, "host line\n");
  const timer = setInterval(() => { try { writeFileSync(hostLog, "another host process\n", { flag: "a" }); } catch { /* the test's own dir */ } }, 20);
  let r;
  try { r = await probe(s); } finally { clearInterval(timer); }
  const o = r.summary;
  assert.equal(r.code, 1, JSON.stringify([o.aborted, o.checks]));
  assert.deepEqual(o.checks, { forbidden_denied: true, allowed_written: true, mcp_called: true, verify_ran: true, gemini_state_untouched: null });
  assert.deepEqual(o.gemini_state.unresolved_host_changes.map(c => c.path), [hostLog]);
  assert.equal(o.owner_stated_mechanics.state_mounts.status, "unresolved");
  const ch = o.gemini_state.host_changes.filter(c => c.path === hostLog);
  assert.deepEqual(ch.map(c => [c.change, c.reach, c.jail_view, c.possible_writer, c.unresolved]), [["changed", "outside_jail_reach", "hidden", "another host process", true]]);
  assert.match(ch[0].why, /the jail sees .*agy-state.* at .*antigravity-cli, not the host's/);
  assert.ok(o.gemini_state.host_changes.every(c => c.reach === "outside_jail_reach"));
});

test("a card listing call_mcp_tool (as on the owner's 2026-11-18 run): the PREFLIGHT aborts before any model turn (exit 2), with the CLI's own unknown-component line recorded", needBwrap, async t => {
  const s = await setup(t);
  const hostBefore = s.host();
  const card = join(s.root, "bad-card.md");
  writeFileSync(card, readFileSync(CARD_TEMPLATE, "utf8").replace(/^tools: \[.*\]$/m, "tools: [view_file, grep_search, write_to_file, replace_file_content, run_command, call_mcp_tool]"));
  const r = await probe(s, { FAKE_AGY_GEMINI_WRITES: "1" }, ["--card", card]);
  const o = r.summary;
  assert.equal(r.code, 2);
  assert.equal(o.aborted.spent, "nothing: preflight failed before any model turn");
  assert.match(o.aborted.reason, /^preflight failed: card_tools \(unknown or deprecated on agy 1\.5\.10.*grep_search, call_mcp_tool\); log_scan/);
  assert.deepEqual([o.preflight.failed, o.preflight.warnings], [["card_tools", "log_scan"], ["discovery", "hooks_discovery"]], "the unlisted worker is advisory; the CLI's own error lines block");
  assert.deepEqual([o.preflight.checks.mcp_list.ok, o.preflight.checks.agents.ok, o.preflight.checks.discovery.agent_listed], [true, true, false]);
  assert.match(o.preflight.checks.log_scan.lines.unknown_component.join("\n"), /unknown component: tool "call_mcp_tool" not found in registry/);
  assert.doesNotMatch(o.preflight.checks.agents.stderr, /unknown component/, "with log/ writable the line is in the log FILE, not on stderr");
  assert.deepEqual(o.preflight.checks.log_scan.lines.unknown_component.length > 0 && o.preflight.checks.log_scan.lines.deprecated.length > 0, true);
  assert.match(o.preflight.checks.log_scan.log_text, /Tool "grep_search" is deprecated and has no effect/, "the CLI's log dir (in the scratch) was written and scanned");
  assert.deepEqual(o.checks, { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: true }, "not exercised = null; the host snapshots are equal");
  assert.equal(s.launches().length, 0, "ZERO model invocations");
  assert.deepEqual([o.turn.exit_code, o.launch.argv, o.quota_after], [null, null, null]);
  assert.deepEqual(s.host(), hostBefore);
  assert.doesNotMatch(r.out, /(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])/, "the A2A token appears nowhere");
});

test("a ~/.gemini without antigravity-cli: the probe refuses (AGY_STATE_LAYOUT, exit 2, nothing spent) and creates nothing under HOME", needBwrap, async t => {
  const s = await setup(t);
  rmSync(s.c, { recursive: true });
  const hostBefore = s.host();
  const r = await probe(s);
  assert.equal(r.code, 2);
  assert.match(r.summary.aborted.reason, /the jail could not be built \(AGY_STATE_LAYOUT\): .*antigravity-cli does not exist/);
  assert.equal(r.summary.gemini_state.error.code, "AGY_STATE_LAYOUT");
  // Since L-401 the quota probe runs in the worker's jail too, so the layout refusal comes before the host snapshot:
  // nothing was snapshotted (null), and the host is unchanged (below).
  assert.deepEqual(r.summary.checks, { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: null });
  assert.deepEqual([s.launches().length, s.subs().length], [0, 0]);
  assert.deepEqual(s.host(), hostBefore);
});

test("the probe aborts with ZERO model invocations when the lane's Gemini quota is depleted (exit 2)", needBwrap, async t => {
  const s = await setup(t, 0);
  const r = await probe(s);
  assert.equal(r.code, 2);
  assert.equal(r.summary.quota_before.state, "exhausted");
  assert.match(r.summary.aborted.reason, /reads "exhausted", not "available": no turn is spent/);
  assert.equal(s.launches().length, 0, "the fake agy was never asked for a model turn");
  assert.equal(s.quotaProbes(), 1);
  assert.equal(r.summary.launch.argv, null);
  assert.deepEqual(r.summary.checks, { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: null }, "aborted before the host snapshot: nothing is known");
});

test("the probe says so and spends nothing when agy is absent (exit 2)", async t => {
  const s = await setup(t);
  const r = await probe({ ...s, cli: join(s.fx, "no-such-agy") });
  assert.equal(r.code, 2);
  assert.match(r.summary.aborted.reason, /agy not found/);
  assert.equal(s.quotaProbes(), 0);
});

test("NOT LOGGED IN inside the jail (the host-side quota probe passed): the in-jail /usage returns no groups and the auth check BLOCKS with ZERO model invocations; the negative and GeminiDir lines are advisory diagnostics; no credential anywhere", needBwrap, async t => {
  const s = await setup(t);
  const hostBefore = s.host();
  const r = await probe(s, { FAKE_AGY_NOT_LOGGED_IN: "1" });
  const o = r.summary;
  assert.equal(r.code, 2);
  assert.equal(o.quota_before.state, "available", "the host-side probe (a minimal env) is logged in");
  assert.equal(o.aborted.spent, "nothing: preflight failed before any model turn");
  assert.deepEqual([o.preflight.ok, o.preflight.failed, o.preflight.warnings], [false, ["auth"], ["discovery", "hooks_discovery"]]);
  assert.match(o.aborted.reason, /^preflight failed: auth \(\/usage returned no quota group with buckets/);
  assert.deepEqual([o.preflight.checks.auth.envelope, o.preflight.checks.auth.groups, o.preflight.checks.auth.num_turns], ["json", [], 0]);
  assert.match(o.preflight.checks.auth.stderr, /Auth mode is unspecified/);
  assert.deepEqual([o.preflight.checks.agents.exit_code, o.preflight.checks.agents.ok, o.preflight.checks.agents.stdout], [0, true, ""], "exit 0 is not evidence of a session");
  assert.deepEqual([...new Set(o.diagnostics.negative_login_lines.lines.map(l => l.replace(/^[IWE]1118 [\d:.]+ \d+ /, "")))].sort(), ["auth.go:2] error getting token source: You are not logged into Antigravity.",
    "models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response", "quota.go:5] doRefreshQuota: skipped (not logged in)"], "the observed lines, advisory");
  assert.equal(o.diagnostics.negative_login_lines.advisory, true);
  assert.equal(o.diagnostics.gemini_dir_lines.length, 2, "benign, recorded (once per subcommand), not blocking");
  for (const l of o.diagnostics.gemini_dir_lines) assert.match(l, /Failed to resolve GeminiDir "\.gemini": \.gemini must be an absolute path: path is not absolute, falling back to default$/);
  assert.ok(!o.preflight.failed.includes("log_scan"));
  assert.equal(s.launches().length, 0, "ZERO model invocations");
  assert.deepEqual(o.checks, { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: true });
  assert.deepEqual([o.turn.exit_code, o.launch.argv, o.quota_after], [null, null, null]);
  assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL) && !r.out.includes("FAKE-CREDENTIAL"), "the mcp list credential never reaches the summary");
  assert.deepEqual(s.host(), hostBefore, "the host is unchanged");
});

test("DISCOVERY is advisory: listings that show only the GLOBAL configuration (as observed) do not block; the turn runs and passes", needBwrap, async t => {
  const s = await setup(t);
  const r = await probe(s, { FAKE_AGY_GLOBAL_ONLY: "1" });
  const o = r.summary;
  assert.equal(r.code, 0, JSON.stringify(o.aborted ?? o.checks));
  assert.deepEqual([o.preflight.ok, o.preflight.failed, o.preflight.warnings], [true, [], ["discovery", "hooks_discovery"]]);
  assert.deepEqual([o.preflight.checks.discovery.agent_listed, o.preflight.checks.discovery.server_listed], [false, false]);
  assert.match(o.preflight.checks.discovery.note, /advisory/);
  assert.deepEqual(o.preflight.checks.mcp_list.servers, ["context7"]);
  assert.equal(s.launches().length, 1);
  assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL));
});

test("~/.gemini/config/projects absent on the host: it is not created; the CLI's write fails read-only and log_scan blocks before any turn (the path kept in the redacted line)", needBwrap, async t => {
  const s = await setup(t);
  rmSync(join(s.g, "config", "projects"), { recursive: true });
  const hostBefore = s.host();
  const r = await probe(s);
  const o = r.summary;
  assert.equal(r.code, 2);
  assert.deepEqual(o.preflight.failed, ["log_scan"]);
  assert.match(o.preflight.checks.log_scan.lines.read_only.join("\n"), /\/\.gemini\/config\/projects\/default-cli-project\.json\.\d+\.tmp: read-only file system/);
  // The refusal names the path that failed, in the check's reason and in the probe's abort message.
  // (one write per preflight subcommand, so one path each, under the per-pid tmp name)
  const tmpPath = `${join(s.g, "config", "projects", "default-cli-project.json")}\\.\\d+\\.tmp`.replace(/\//g, "\\/");
  assert.match(o.preflight.checks.log_scan.why, new RegExp(`^found: read_only \\(a write was refused under a read-only mount: ${tmpPath}(, ${tmpPath})*\\)$`));
  assert.match(o.aborted.reason, new RegExp(`log_scan \\(found: read_only \\(a write was refused under a read-only mount: ${tmpPath}`));
  assert.deepEqual([...new Set(o.preflight.checks.log_scan.read_only_paths.map(p => p.replace(/\.\d+\.tmp$/, ".<rand>.tmp")))], [join(s.g, "config", "projects", "default-cli-project.json.<rand>.tmp")]);
  assert.deepEqual(o.gemini_state.writable_copies.map(w => [w.path, w.status]), [["config/projects", "absent"]]);
  assert.equal(s.launches().length, 0);
  assert.deepEqual(s.host(), hostBefore, "nothing created under HOME");
});

test("builtin plugin assets (~/.gemini/antigravity-cli/builtin/plugins/<p>/asset.js, rewritten at startup -- inferred from the 09d490f report): the preflight's write lands in the per-run copy and does not block; the host is unchanged", needBwrap, async t => {
  const s = await setup(t);
  mkdirSync(join(s.c, "builtin", "plugins", "core"), { recursive: true });
  writeFileSync(join(s.c, "builtin", "plugins", "core", "asset.js"), "// host asset\n");
  const hostBefore = s.host();
  const r = await probe(s);
  const o = r.summary;
  assert.equal(r.code, 0, JSON.stringify(o.aborted ?? o.checks));
  assert.ok(!o.preflight.failed.includes("log_scan"), JSON.stringify(o.preflight.checks.log_scan));
  assert.deepEqual(o.preflight.checks.log_scan.lines.read_only, []);
  assert.deepEqual(o.gemini_state.scratch_written.writable_subdirs.builtin.map(f => [f.path, f.copied, f.changed]), [["plugins/core/asset.js", true, true]]);
  assert.deepEqual(s.host(), hostBefore, "the host builtin/ is untouched");
});

test("--keep keeps the scratch and says it holds credentials", needBwrap, async t => {
  const s = await setup(t);
  const r = await probe(s, { FAKE_AGY_NOT_LOGGED_IN: "1" }, ["--keep"]);
  t.after(() => { if (r.summary.kept) rmSync(r.summary.kept, { recursive: true, force: true }); });
  assert.equal(r.code, 2);
  assert.equal(r.summary.kept_contains_credentials, true);
  const states = join(r.summary.kept, "control", "probe", "run", "agy-state");
  const [id] = readdirSync(states);
  assert.equal(statSync(join(states, id)).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(states, id, "antigravity-cli", "antigravity-oauth-token"), "utf8"), "fake-token");
  assert.equal(existsSync(join(states, id, "antigravity-cli", "history.jsonl")), false);
});

test("the probe imports no API client: metered failover is impossible by construction (and it spawns asynchronously only)", () => {
  const src = readFileSync(PROBE, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
  assert.deepEqual(imports.filter(i => !i.startsWith("node:")).sort(), ["../src/agy/jail-hook.mjs", "../src/agy/quota.mjs", "../src/agy/sandbox.mjs", "../src/agy/workspace.mjs",
    "../src/board/agy-cli.mjs", "../src/board/spawn.mjs", "../src/pipeline/a2a-shim.mjs"]);
  assert.doesNotMatch(src, /model-client|sdk\/adapter|pipeline\/turns|import\(/);
  assert.doesNotMatch(src, /spawnSync|execSync|execFileSync/);
});
