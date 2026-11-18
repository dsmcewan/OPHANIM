// The one-turn live probe (scripts/agy-worker-probe.mjs), run as a child process against the FAKE agy under the REAL
// bwrap, with a FAKE HOME (the real ~/.gemini is never touched). The fake follows the probe's four steps — a write
// outside owned_paths, the owned write, ask_subagent (directly as the eager tool, or through call_mcp_tool), the verify
// command — through the jail hook and the MCP relay over the A2A socket, exactly as the probe expects of agy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgy } from "./fixtures/dispatch.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";

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
  const fx = join(root, "fx"), home = join(root, "home"), g = join(home, ".gemini");
  mkdirSync(fx); mkdirSync(join(g, "antigravity", "conversations"), { recursive: true }); mkdirSync(join(g, "antigravity", "mcp")); mkdirSync(join(g, "config"));
  writeFileSync(join(g, "oauth_creds.json"), '{"refresh_token":"fake"}'); writeFileSync(join(g, "settings.json"), "{}");
  writeFileSync(join(g, "antigravity", "conversations", "earlier.pb"), "earlier");
  const cli = fakeAgy(fx);
  writeFileSync(join(fx, "quota-report.txt"), JSON.stringify(usage(fraction))); writeFileSync(join(fx, "quota-exit"), "0");
  writeFileSync(join(fx, "worker.sh"), WORKER);
  const host = () => ({ conv: readdirSync(join(g, "antigravity", "conversations")).sort(), mcp: readdirSync(join(g, "antigravity", "mcp")).sort(), oauth: readFileSync(join(g, "oauth_creds.json"), "utf8"), settings: readFileSync(join(g, "settings.json"), "utf8") });
  const launches = () => existsSync(join(fx, "agy.log")) ? readFileSync(join(fx, "agy.log"), "utf8").split("\n").filter(Boolean) : [];
  const quotaProbes = () => existsSync(join(fx, "agy.quota.log")) ? readFileSync(join(fx, "agy.quota.log"), "utf8").split("\n").filter(Boolean).length : 0;
  return { root, fx, home, g, cli, host, launches, quotaProbes };
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
const probeDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith("pantheon-agy-probe-"));

for (const form of ["direct", "wrapped"]) {
  test(`the probe against the fake agy (ask_subagent ${form === "direct" ? "as the eager tool" : "through call_mcp_tool"}): every check passes, exit 0`, needBwrap, async t => {
    const s = await setup(t);
    const hostBefore = s.host();
    const dirsBefore = probeDirs();
    const r = await probe(s, { FAKE_PROBE_MCP: form, FAKE_AGY_GEMINI_WRITES: form === "direct" ? "1" : "refresh" });
    const o = r.summary;
    assert.equal(r.code, 0, `${JSON.stringify(o.checks)} ${o.turn?.error?.message ?? ""} ${o.stderr_tail ?? ""}`);
    assert.deepEqual(Object.keys(o), ["schema", "agy", "lane", "quota_before", "quota_after", "launch", "hook", "checks", "mcp", "tools_run", "turn", "stderr_tail", "log_tail", "owner_stated_mechanics", "gemini_state", "aborted", "kept"], "stable key order");
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
    // The gemini state: the host is unchanged; what the CLI wrote went to the per-run scratch, which is gone.
    assert.deepEqual(s.host(), hostBefore);
    assert.deepEqual(Object.values(o.gemini_state.scratch_written), [["fake-agy-conversation.pb"], ["pantheon-subagents.json"]]);
    // The owner-stated mechanics, judged from the evidence.
    const m = o.owner_stated_mechanics;
    assert.deepEqual(Object.keys(m), ["add_dir_workspace", "hooks_json_shape", "mcp_lazy_call_mcp_tool", "hook_decision_semantics", "state_mounts"]);
    assert.deepEqual([m.add_dir_workspace.status, m.hooks_json_shape.status, m.hook_decision_semantics.status], ["confirmed", "confirmed", "confirmed"]);
    assert.equal(m.mcp_lazy_call_mcp_tool.status, form === "wrapped" ? "confirmed" : "not exercised");
    // A refresh that tries to rewrite oauth_creds.json hits EROFS, and the probe shows it.
    if (form === "wrapped") { assert.equal(m.state_mounts.status, "refuted"); assert.match(m.state_mounts.evidence.erofs_lines.join("\n"), /oauth_creds\.json refresh write failed: EROFS/); assert.match(o.stderr_tail, /EROFS/); }
    else assert.equal(m.state_mounts.status, "confirmed");
    // One model invocation; the temp repo is cleaned up.
    assert.equal(s.launches().length, 1);
    assert.equal(s.quotaProbes(), 2, "the free quota probe, before and after");
    assert.deepEqual(probeDirs().filter(n => !dirsBefore.includes(n)), [], "no temp dir left behind");
  });
}

test("the probe aborts with ZERO model invocations when the lane's Gemini quota is depleted (exit 2)", needBwrap, async t => {
  const s = await setup(t, 0);
  const r = await probe(s);
  assert.equal(r.code, 2);
  assert.equal(r.summary.quota_before.state, "exhausted");
  assert.match(r.summary.aborted.reason, /reads "exhausted", not "available": no turn is spent/);
  assert.equal(s.launches().length, 0, "the fake agy was never asked for a model turn");
  assert.equal(s.quotaProbes(), 1);
  assert.equal(r.summary.launch.argv, null);
});

test("the probe says so and spends nothing when agy is absent (exit 2)", async t => {
  const s = await setup(t);
  const r = await probe({ ...s, cli: join(s.fx, "no-such-agy") });
  assert.equal(r.code, 2);
  assert.match(r.summary.aborted.reason, /agy not found/);
  assert.equal(s.quotaProbes(), 0);
});

test("the probe imports no API client: metered failover is impossible by construction (and it spawns asynchronously only)", () => {
  const src = readFileSync(PROBE, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
  assert.deepEqual(imports.filter(i => !i.startsWith("node:")).sort(), ["../src/agy/jail-hook.mjs", "../src/agy/quota.mjs", "../src/agy/sandbox.mjs", "../src/agy/workspace.mjs",
    "../src/board/agy-cli.mjs", "../src/board/spawn.mjs", "../src/pipeline/a2a-shim.mjs"]);
  assert.doesNotMatch(src, /model-client|sdk\/adapter|pipeline\/turns|import\(/);
  assert.doesNotMatch(src, /spawnSync|execSync|execFileSync/);
});
