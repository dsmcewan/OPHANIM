// The zero-spend preflight's matchers and redaction (src/board/agy-cli.mjs), against the text OBSERVED on agy 1.5.10
// (owner's probe of 5893432, 2026-11-18) and the fake agy that reproduces it. No bwrap, no real agy, no HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPromise } from "../src/board/spawn.mjs";
import { AGY_BAD_FLAG, AGY_NOT_LOGGED_IN, CLI_LOG_CAP_BYTES, cliLogEvidence, mcpServerNames, NEGATIVE_LOGIN_NOTE, parseHooksLoaded, parseWorkspaceDirs, PREFLIGHT_ADVISORY, PREFLIGHT_BLOCKING,
  readNewCliLogs, redactStrong, runAgyPreflight, snapshotCliLog } from "../src/board/agy-cli.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { AGY_1_5_10_BAD_FLAG_STDERR, fakeAgy, FAKE_MCP_CREDENTIAL } from "./fixtures/dispatch.mjs";

test("AGY_BAD_FLAG matches the EXACT observed stderr of `agy agents --log-file` and `agy mcp list --log-file` (plural \"flags provided\"), and the usual spellings", () => {
  for (const text of Object.values(AGY_1_5_10_BAD_FLAG_STDERR)) {
    assert.match(text, /\nError: flags provided but not defined: -log-file\n$/, "the fixture text ends exactly as observed");
    assert.match(text, AGY_BAD_FLAG);
  }
  for (const t of ["flag provided but not defined: -x", "unknown flag: --x", "unknown shorthand flag: 'x' in -x", "error: unrecognized option '--x'", "error: unexpected argument '--x' found"]) assert.match(t, AGY_BAD_FLAG, t);
  for (const t of ["", "pantheon-unit-worker\tworkspace\t4 tools", "Flags:\n  -h      Show help"]) assert.doesNotMatch(t, AGY_BAD_FLAG, t);
});

test("the fake agy rejects --log-file on both subcommands with the exact observed stderr and exit 1; without it they exit 0", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fakeAgy(dir), home = join(dir, "home");
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home };
  const a = await spawnPromise(cli, ["agents", "--log-file", join(dir, "x.log")], { cwd: dir, env, timeout: 10000 });
  assert.deepEqual([a.status, a.stdout, a.stderr], [1, "", AGY_1_5_10_BAD_FLAG_STDERR.agents]);
  const m = await spawnPromise(cli, ["mcp", "list", "--log-file", join(dir, "x.log")], { cwd: dir, env, timeout: 10000 });
  assert.deepEqual([m.status, m.stdout, m.stderr], [1, "", AGY_1_5_10_BAD_FLAG_STDERR.mcp_list]);
  const n = await spawnPromise(cli, ["agents"], { cwd: dir, env: { ...env, FAKE_AGY_NOT_LOGGED_IN: "1" }, timeout: 10000 });
  assert.deepEqual([n.status, n.stdout], [0, ""]);
  assert.match(n.stderr, AGY_NOT_LOGGED_IN);
});

test("AGY_NOT_LOGGED_IN: the observed line and its variants", () => {
  for (const t of ["You are not logged into Antigravity.", "error getting token source: You are not logged into Antigravity.", "doRefreshQuota: skipped (not logged in)",
    "Auth mode is unspecified, skipping fetchAvailableModels and returning empty response", "error: not logged in", "Not logged into any account"]) assert.match(t, AGY_NOT_LOGGED_IN, t);
  for (const t of ["logged in as someone", "pantheon-unit-worker"]) assert.doesNotMatch(t, AGY_NOT_LOGGED_IN, t);
});

test("redactStrong: env secrets, Bearer, key=value, --header and 24+ character runs are redacted; absolute paths keep their readable segments", () => {
  const env = { MY_API_TOKEN: "s3cr3t-value-xyz" };
  const out = redactStrong([
    "token=abc12 password: hunter22 api-key=zz API_KEY: q secret=w",
    "Authorization: Bearer abc.def",
    "npx srv --header X-Api:val --api-key " + FAKE_MCP_CREDENTIAL,
    "env s3cr3t-value-xyz",
    "blob AbCdEf0123456789AbCdEf0123456789",
    "E1118 open /home/u/.gemini/config/projects/default-cli-project.json.12345.tmp: read-only file system",
    "path /x/0123456789abcdef0123456789abcdef/y",
  ].join("\n"), env).split("\n");
  assert.deepEqual(out, [
    "token=<redacted> password: <redacted> api-key=<redacted> API_KEY: <redacted> secret=<redacted>",
    "Authorization: <redacted> <redacted>",
    "npx srv --header <redacted> --api-key <redacted>",
    "env <redacted:MY_API_TOKEN>",
    "blob <redacted>",
    "E1118 open /home/u/.gemini/config/projects/default-cli-project.json.12345.tmp: read-only file system",
    "path /x/<redacted>/y",
  ]);
  assert.ok(!out.join("\n").includes("FAKE-CREDENTIAL"));
});

test("mcpServerNames keeps only the first token of entry lines (never the rest); unparseable output keeps a line count only", () => {
  const text = `context7\tstdio\tnpx -y srv --api-key ${FAKE_MCP_CREDENTIAL}\n  headers: Authorization: Bearer ${FAKE_MCP_CREDENTIAL}\n- pantheon-subagents: connected\nName  Status\n${FAKE_MCP_CREDENTIAL}\n`;
  const r = mcpServerNames(text);
  assert.deepEqual(r, { servers: ["context7", "pantheon-subagents"], line_count: 5 });
  assert.ok(!JSON.stringify(r).includes("FAKE-CREDENTIAL"));
  assert.deepEqual(mcpServerNames("::: ???\n"), { servers: null, line_count: 1 });
  assert.deepEqual(mcpServerNames(""), { servers: null, line_count: 0 });
});

test("parseHooksLoaded reads the observed hooks_manager line (the last one wins); none seen is null", () => {
  assert.deepEqual(parseHooksLoaded("x\nI1118 00:00:00.000000 9 hooks_manager.go:54] loaded 0 named hooks from 0 hooks.json file(s)\n"),
    { named: 0, files: 0, lines: ["I1118 00:00:00.000000 9 hooks_manager.go:54] loaded 0 named hooks from 0 hooks.json file(s)"] });
  assert.deepEqual(parseHooksLoaded("loaded 0 named hooks from 0 hooks.json file(s)\nloaded 2 named hooks from 1 hooks.json file(s)").files, 1);
  assert.equal(parseHooksLoaded("nothing"), null);
});

test("the preflight's blocking and advisory checks", () => {
  assert.deepEqual([PREFLIGHT_BLOCKING, PREFLIGHT_ADVISORY], [["card_tools", "auth", "lane_quota", "agents", "log_scan", "tool_drift"], ["mcp_list", "discovery", "hooks_discovery"]]);
});

// ---- the CLI's log FILES (observed on agy 1.5.10: with log/ writable the diagnostics go there, not to stderr) --------

test("readNewCliLogs reads only NEW or GROWN files (the appended bytes), redacts them strongly, and caps the total across calls", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-clilog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "old.log"), "old line\n"); writeFileSync(join(dir, "grow.log"), "first\n");
  const before = await snapshotCliLog(dir);
  const env = { MY_SECRET_TOKEN: "s3cr3t-value-xyz-123" };
  writeFileSync(join(dir, "grow.log"), "first\nsecond Authorization: Bearer abc.def\n");
  writeFileSync(join(dir, "cli-1.log"), `token=abc s3cr3t-value-xyz-123 ${FAKE_MCP_CREDENTIAL}\nI1118 hooks_manager.go:54] loaded 1 named hooks from 1 hooks.json file(s)\n`);
  const r = await readNewCliLogs(dir, before, { env });
  assert.deepEqual(r.files.map(f => [f.name, f.grown, f.truncated]), [["cli-1.log", false, false], ["grow.log", true, false]]);
  assert.doesNotMatch(r.text, /old line|^first$/m, "unchanged files and the bytes already there are not re-read");
  assert.match(r.text, /^second Authorization: <redacted> <redacted>$/m);
  assert.match(r.text, /^token=<redacted> <redacted:MY_SECRET_TOKEN> <redacted>$/m);
  assert.ok(!r.text.includes("FAKE-CREDENTIAL") && !r.text.includes("s3cr3t"));
  assert.equal(parseHooksLoaded(r.text).files, 1);
  // The cap: one budget shared by every read of a run; what is past it is not read, and the record says so.
  const big = mkdtempSync(join(tmpdir(), "pantheon-clilog-big-"));
  t.after(() => rmSync(big, { recursive: true, force: true }));
  const b0 = await snapshotCliLog(big);
  writeFileSync(join(big, "a.log"), "x".repeat(CLI_LOG_CAP_BYTES - 10) + "\n"); writeFileSync(join(big, "b.log"), "y".repeat(100) + "\n");
  const budget = { left: CLI_LOG_CAP_BYTES };
  const c = await readNewCliLogs(big, b0, { budget });
  assert.equal(CLI_LOG_CAP_BYTES, 2 * 1024 * 1024);
  assert.deepEqual([c.bytes_read, c.truncated, c.files.map(f => [f.name, f.read_bytes, f.truncated])], [CLI_LOG_CAP_BYTES, true, [["a.log", CLI_LOG_CAP_BYTES - 9, false], ["b.log", 9, true]]]);
  writeFileSync(join(big, "c.log"), "z\n");
  const d = await readNewCliLogs(big, await snapshotCliLog(join(big, "none")), { budget });
  assert.deepEqual([d.bytes_read, d.truncated, d.text], [0, true, ""], "the budget is spent: nothing more is read");
  assert.deepEqual(await snapshotCliLog(join(big, "absent")), {});
});

test("cliLogEvidence: hooks, workspaceDirs, EROFS paths and negative-login lines parsed from a log FILE alone, with the source named", () => {
  const log = ["I1118 00:00:00.000000 9 hooks_manager.go:54] loaded 1 named hooks from 1 hooks.json file(s)",
    "I1118 00:00:00.000000 9 workspace.go:12] workspaceDirs=[/ctl /wt]",
    "E1118 00:00:00.000000 9 state.go:7] open /h/.gemini/x.tmp: read-only file system",
    "W1118 00:00:00.000000 9 models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response",
    "E1118 00:00:00.000000 9 project.go:1] failed to resolve project: x"].join("\n");
  const e = cliLogEvidence({ stdout: "pantheon-unit-worker\tworkspace\t4 tools", stderr: "", log_dir: log });
  assert.deepEqual(e.hooks_loaded, { named: 1, files: 1, sources: ["log_dir"] });
  assert.deepEqual([e.workspace_dirs, e.workspace_dirs_sources], [["/ctl", "/wt"], ["log_dir"]]);
  assert.deepEqual([e.erofs_paths, e.negative_login_lines.length, e.project_resolve_errors.length], [["/h/.gemini/x.tmp"], 1, 1]);
  assert.deepEqual(e.log_sources, { stdout_lines: 1, stderr_lines: 0, file_lines: 5, log_file_lines: 0 });
  assert.deepEqual(parseWorkspaceDirs('x workspaceDirs=["/a", "/b c"]').dirs, ["/a", "/b", "c"]);
  assert.equal(parseWorkspaceDirs("none"), null);
});

// ---- runAgyPreflight against the fake agy under the REAL bwrap, with a FAKE HOME (the real one is never touched) ----
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };
const usageOf = fraction => JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon, Gemini 3.8 Flash", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: fraction }] },
  { name: "Claude and GPT models", description: "Models within this group: Claude Opus 5.5", buckets: [{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1 }] }] } } });
async function preflightFixture(t, { gemini = true, fraction = 0.8 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-preflight-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = join(root, "fx"), home = join(root, "home"), ctl = join(root, "control"), wt = join(root, "wt");
  mkdirSync(fx); mkdirSync(home); mkdirSync(wt);
  if (gemini) {
    const g = join(home, ".gemini"), c = join(g, "antigravity-cli");
    mkdirSync(join(c, "log"), { recursive: true }); mkdirSync(join(g, "config", "projects"), { recursive: true });
    writeFileSync(join(c, "antigravity-oauth-token"), "fake-token"); writeFileSync(join(g, "config", "projects", "default-cli-project.json"), "{}");
  }
  const cli = fakeAgy(fx);
  writeFileSync(join(fx, "quota-report.txt"), usageOf(fraction)); writeFileSync(join(fx, "quota-exit"), "0");
  await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "pf", owned_paths: ["allowed/**"], verify_cmd: 'node -e "process.exit(0)"' });
  const launches = () => (existsSync(join(fx, "agy.log")) ? readFileSync(join(fx, "agy.log"), "utf8").split("\n").filter(Boolean).length : 0);
  const run = (env = {}, model = "gemini-3.8-flash-low") => runAgyPreflight({ cli, control_dir: realpathSync(ctl), worktree: realpathSync(wt), model,
    env: { HOME: home, FAKE_AGY_LOG: join(fx, "agy.log"), ...env }, sandbox: { home, agy_state_dirs: [fx] } });
  return { root, fx, home, cli, run, launches };
}

test("the preflight PASSES when the in-jail /usage succeeds although the subcommands print not-logged-in lines (routine, ADVISORY); with log/ writable they are read from the log FILE, with the hooks line", needBwrap, async t => {
  const f = await preflightFixture(t);
  const p = await f.run();
  assert.deepEqual([p.ok, p.failed], [true, []], JSON.stringify(p.failed.map(k => p.checks[k].why)));
  assert.deepEqual([p.checks.auth.ok, p.checks.auth.argv, p.checks.auth.envelope, p.checks.auth.groups, p.checks.auth.num_turns, p.checks.auth.total_tokens],
    [true, [f.cli, "--print", "/usage", "--output-format", "json"], "json", ["Gemini Models", "Claude and GPT models"], 0, 0]);
  assert.deepEqual([p.checks.lane_quota.ok, p.checks.lane_quota.quota_scope.groups, p.checks.lane_quota.quota_scope.state], [true, ["Gemini Models"], "available"]);
  const n = p.diagnostics.negative_login_lines;
  assert.deepEqual([n.advisory, n.note, n.count, [...new Set(n.lines.map(l => l.replace(/^[IWE]1118 [\d:.]+ \d+ /, "")))]], [true, NEGATIVE_LOGIN_NOTE, 4,
    ["models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response", "auth.go:2] error getting token source: You are not logged into Antigravity."]]);
  assert.equal(NEGATIVE_LOGIN_NOTE, "observed on agy 1.5.10 in every layout, including the real read-only directory, whenever the CLI could not write its log file; /usage succeeded in the same layouts");
  assert.ok(!PREFLIGHT_BLOCKING.includes("negative_login_lines") && !PREFLIGHT_ADVISORY.includes("negative_login_lines"));
  // From the log FILES (one per subcommand), not stderr.
  const cl = p.diagnostics.cli_log;
  assert.deepEqual([cl.files.map(x => [x.command, x.name.replace(/\d+/g, "N")]), cl.log_sources.stderr_lines], [[["agents", "cli-N.log"], ["mcp list", "cli-N.log"]], 0]);
  assert.deepEqual([cl.hooks_loaded, p.checks.hooks_discovery.sources, p.checks.hooks_discovery.files], [{ named: 0, files: 0, sources: ["log_dir"] }, ["log_dir"], 0]);
  assert.doesNotMatch(p.checks.agents.stderr, /not logged|hooks_manager/);
  assert.equal(f.launches(), 0, "no model turn");
});

test("the preflight also passes when the negative lines come on STDERR (no ~/.gemini: no log file can be written)", needBwrap, async t => {
  const f = await preflightFixture(t, { gemini: false });
  const p = await f.run();
  assert.deepEqual([p.ok, p.failed], [true, []]);
  assert.ok(p.diagnostics.negative_login_lines.count >= 4);
  assert.deepEqual([p.diagnostics.cli_log.files, p.diagnostics.cli_log.hooks_loaded.sources], [[], ["stderr"]]);
  assert.match(p.checks.agents.stderr, /You are not logged into Antigravity/);
});

test("the preflight BLOCKS with ZERO model invocations when the in-jail /usage fails (logged out: no groups; or not the envelope)", needBwrap, async t => {
  const f = await preflightFixture(t);
  const out = await f.run({ FAKE_AGY_NOT_LOGGED_IN: "1" });
  assert.deepEqual([out.ok, out.failed], [false, ["auth"]]);
  assert.match(out.checks.auth.why, /no quota group with buckets/);
  assert.equal(out.checks.lane_quota.ok, true, "no group to call exhausted");
  writeFileSync(join(f.fx, "quota-report.txt"), "Error: something else\n"); writeFileSync(join(f.fx, "quota-exit"), "1");
  const bad = await f.run();
  assert.deepEqual([bad.ok, bad.failed, bad.checks.auth.exit_code, bad.checks.auth.envelope], [false, ["auth"], 1, "json-text"]);
  assert.equal(f.launches(), 0, "ZERO model invocations");
});

test("the preflight BLOCKS with ZERO model invocations when the LANE's group is exhausted (another group's quota does not matter)", needBwrap, async t => {
  const f = await preflightFixture(t, { fraction: 0 });
  const p = await f.run();
  assert.deepEqual([p.ok, p.failed, p.checks.auth.ok], [false, ["lane_quota"], true]);
  assert.deepEqual([p.checks.lane_quota.quota_scope.state, p.checks.lane_quota.quota_scope.groups], ["exhausted", ["Gemini Models"]]);
  assert.match(p.checks.lane_quota.why, /gemini-3\.8-flash-low's group \(Gemini Models\) is exhausted/);
  const other = await f.run({}, "claude-opus-5.5");
  assert.equal(other.ok, true, "a lane in another group is not blocked by the Gemini group");
  assert.equal(f.launches(), 0, "ZERO model invocations");
});
