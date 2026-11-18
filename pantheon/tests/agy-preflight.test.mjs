// The zero-spend preflight's matchers and redaction (src/board/agy-cli.mjs), against the text OBSERVED on agy 1.5.10
// (owner's probe of 5893432, 2026-11-18) and the fake agy that reproduces it. No bwrap, no real agy, no HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPromise } from "../src/board/spawn.mjs";
import { AGY_BAD_FLAG, AGY_NOT_LOGGED_IN, mcpServerNames, parseHooksLoaded, PREFLIGHT_ADVISORY, PREFLIGHT_BLOCKING, redactStrong } from "../src/board/agy-cli.mjs";
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
  assert.deepEqual([PREFLIGHT_BLOCKING, PREFLIGHT_ADVISORY], [["card_tools", "agents", "auth", "log_scan"], ["mcp_list", "discovery", "hooks_discovery"]]);
});
