// The one-turn live probe (scripts/agy-worker-probe.mjs), run as a child process against the FAKE agy under the REAL
// bwrap, with a FAKE HOME (the real ~/.gemini is never touched). The fake follows the probe's four steps — a write
// outside owned_paths, the owned write, ask_subagent (directly as the eager tool, or through call_mcp_tool), the verify
// command — through the jail hook and the MCP relay over the A2A socket, exactly as the probe expects of agy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgy, FAKE_MCP_CREDENTIAL } from "./fixtures/dispatch.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
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
const probeDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith("pantheon-agy-probe-"));

for (const form of ["direct", "wrapped"]) {
  test(`the probe against the fake agy (ask_subagent ${form === "direct" ? "as the eager tool" : "through call_mcp_tool"}): every check passes, exit 0`, needBwrap, async t => {
    const s = await setup(t);
    const hostBefore = s.host();
    const dirsBefore = probeDirs();
    const r = await probe(s, { FAKE_PROBE_MCP: form, FAKE_AGY_GEMINI_WRITES: form === "direct" ? "1" : "refresh" });
    assert.deepEqual(r.summary.aborted, null, JSON.stringify(r.summary.aborted));
    const o = r.summary;
    assert.equal(r.code, 0, `${JSON.stringify(o.checks)} ${o.turn?.error?.message ?? ""} ${o.stderr_tail ?? ""}`);
    assert.deepEqual(Object.keys(o), ["schema", "agy", "lane", "timeout_s", "quota_before", "quota_after", "launch", "preflight", "hook", "checks", "mcp", "tools_run", "turn",
      "startup_errors", "deprecations", "diagnostics", "stderr_tail", "log_tail", "owner_stated_mechanics", "gemini_state", "aborted", "kept", "kept_contains_credentials"], "stable key order");
    // The zero-spend preflight ran first, in the same jail, and passed: the card's four tools, `agy agents` (exit 0, no
    // flag refused), the login, a clean output and log dir; discovery (advisory) found the worker and the server.
    assert.deepEqual([o.preflight.ok, o.preflight.failed, o.preflight.warnings, Object.keys(o.preflight.checks)], [true, [], ["hooks_discovery"], ["card_tools", "agents", "mcp_list", "auth", "log_scan", "discovery", "hooks_discovery"]]);
    assert.deepEqual([o.preflight.blocking, o.preflight.advisory], [["card_tools", "agents", "auth", "log_scan"], ["mcp_list", "discovery", "hooks_discovery"]]);
    // As observed (2026-11-18): the subcommands loaded 0 hooks.json files from the control dir (not a git repo): a
    // WARNING, surfaced, never blocking.
    assert.deepEqual([o.preflight.checks.hooks_discovery.seen, o.preflight.checks.hooks_discovery.files, o.preflight.checks.hooks_discovery.ok], [true, 0, false]);
    assert.deepEqual(o.preflight.checks.card_tools.tools, ["view_file", "write_to_file", "replace_file_content", "run_command"]);
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
    assert.deepEqual(o.diagnostics, { hooks_loaded: { preflight: { named: 0, files: 0 }, turn: null }, gemini_dir_lines: [], auth_lines: [] });
    assert.equal(o.kept_contains_credentials, null);
    assert.deepEqual([o.timeout_s, o.launch.argv[o.launch.argv.indexOf("--print-timeout") + 1]], [180, "180s"], "the default print timeout is 180 s");
    assert.deepEqual([o.startup_errors.length === 0, o.deprecations], [form === "direct", []], "no deprecated tool; startup errors only from the refresh writes");
    assert.equal(o.schema, "pantheon.agy-worker-probe/v1");
    assert.deepEqual([o.agy.path, o.agy.version, /^sha256:[0-9a-f]{64}$/.test(o.agy.sha256)], [s.cli, "fake-agy 0.0.0-fixture", true]);
    assert.equal(o.lane, "gemini-3.8-flash-low");
    assert.deepEqual([o.quota_before.state, o.quota_after.state, o.aborted], ["available", "available", null]);
    assert.deepEqual(o.checks, { forbidden_denied: true, allowed_written: true, mcp_called: true, verify_ran: true, gemini_state_untouched: true });
    // Forbidden: denied by the hook BEFORE any write (the first hook call, a deny; the owned write only after it).
    assert.equal(o.hook.payloads[0].toolCall.name, "write_to_file");
    assert.match(o.hook.payloads[0].toolCall.args.TargetFile, /\/forbidden\.txt$/);
    assert.deepEqual(o.hook.decisions.map(d => [d.tool, d.decision]), [["write_to_file", "deny"], ["write_to_file", "auto_approve"],
      [form === "direct" ? "pantheon-subagents/ask_subagent" : "call_mcp_tool", "auto_approve"], ["run_command", "auto_approve"]]);
    assert.ok(o.hook.decisions.every(d => d.cwd.endsWith("/control/probe/.agents")), "every hook ran in .agents/");
    assert.deepEqual([o.hook.call_mcp_tool_seen, o.hook.direct_mcp_seen, o.hook.invoke_subagent_attempted], [form === "wrapped", form === "direct", false]);
    // MCP: reached over the Unix socket inside bwrap; the subagent is a mock; zero API calls.
    assert.deepEqual(o.mcp.shim_calls.map(c => [c.role, c.status, c.vendor]), [["probe-helper", "answered", "mock"]]);
    assert.deepEqual([o.mcp.mock_subagent_turns, o.mcp.api_calls, o.mcp.socket_inside_bwrap], [1, 0, true]);
    assert.deepEqual(o.tools_run.map(x => [x.tool_name, x.state]), [["write_to_file", "DENIED"], ["write_to_file", "DONE"], [form === "direct" ? "pantheon-subagents/ask_subagent" : "call_mcp_tool", "DONE"], ["run_command", "DONE"]]);
    assert.deepEqual([o.turn.exit_code, o.turn.status, o.turn.error, o.turn.usage], [0, "SUCCESS", null, { input_tokens: 1234, output_tokens: 56 }]);
    // The launch: bwrap, the argv with the prompt redacted, the token redacted, no forbidden flags.
    assert.equal(o.launch.argv[0], "bwrap");
    assert.ok(o.launch.argv.includes("<prompt>") && o.launch.argv.includes("--log-file") && o.launch.argv.includes("--add-dir"));
    assert.ok(!o.launch.argv.some(a => a === "--sandbox" || a.startsWith("--dangerously-skip-permissions")));
    assert.equal(o.launch.env_added.PANTHEON_A2A_TOKEN, "<redacted>");
    assert.doesNotMatch(r.out, /(?<![0-9a-f])[0-9a-f]{48}(?![0-9a-f])/, "the A2A token (48 hex digits) appears nowhere");
    assert.ok(o.launch.bwrap_binds.some(b => b.path === join(s.g) && b.mode === "ro"));
    assert.match(o.log_tail, /fake-agy start agent=pantheon-unit-worker model=gemini-3\.8-flash-low/);
    // The gemini state: the host is unchanged; what the CLI wrote went to the per-run scratch copy, which is gone.
    assert.deepEqual(s.host(), hostBefore);
    const w = o.gemini_state.scratch_written;
    assert.equal(w.dir, s.c);
    assert.deepEqual(Object.fromEntries(Object.entries(w.subdirs).map(([k, v]) => [k, v.length])), { brain: 1, cache: 1, conversations: 1, crashes: 0, implicit: 1, log: 2, mcp: 1, presence: 1 },
      "log/: one CLI log per preflight subcommand");
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
      assert.equal(m.state_mounts.evidence.writes_in_scratch.length, 9);
    }
    // One model invocation; the temp repo is cleaned up.
    assert.equal(s.launches().length, 1);
    assert.equal(s.quotaProbes(), 2, "the free quota probe, before and after");
    assert.deepEqual(probeDirs().filter(n => !dirsBefore.includes(n)), [], "no temp dir left behind");
  });
}

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
  assert.match(o.preflight.checks.agents.stderr, /unknown component: tool "call_mcp_tool" not found in registry/);
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
  assert.deepEqual(r.summary.checks, { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: true });
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

test("NOT LOGGED IN (as observed 2026-11-18: `agy agents` exit 0, empty stdout): the auth check BLOCKS with ZERO model invocations; unexercised checks are null; the auth and GeminiDir lines are surfaced; no credential anywhere", needBwrap, async t => {
  const s = await setup(t);
  const hostBefore = s.host();
  const r = await probe(s, { FAKE_AGY_NOT_LOGGED_IN: "1" });
  const o = r.summary;
  assert.equal(r.code, 2);
  assert.equal(o.aborted.spent, "nothing: preflight failed before any model turn");
  assert.deepEqual([o.preflight.ok, o.preflight.failed, o.preflight.warnings], [false, ["auth"], ["discovery", "hooks_discovery"]]);
  assert.deepEqual([o.preflight.checks.agents.exit_code, o.preflight.checks.agents.ok, o.preflight.checks.agents.stdout], [0, true, ""], "exit 0 is not evidence of a session");
  assert.deepEqual([...new Set(o.preflight.checks.auth.lines.map(l => l.replace(/^[IWE]1118 [\d:.]+ \d+ /, "")))], ["models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response",
    "auth.go:2] error getting token source: You are not logged into Antigravity.", "quota.go:5] doRefreshQuota: skipped (not logged in)"], "the observed lines");
  assert.deepEqual(o.diagnostics.auth_lines, o.preflight.checks.auth.lines);
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
  assert.deepEqual(o.gemini_state.writable_copies.map(w => [w.path, w.status]), [["config/projects", "absent"]]);
  assert.equal(s.launches().length, 0);
  assert.deepEqual(s.host(), hostBefore, "nothing created under HOME");
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
