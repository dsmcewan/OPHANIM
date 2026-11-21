// The zero-spend layout bisect (scripts/agy-layout-bisect.mjs) against the FAKE agy under the REAL bwrap, with a FAKE
// HOME (the real one is never touched). As observed on agy 1.5.10 (2026-11-18), the fake's subcommands always print the
// not-logged-in lines, to the log FILE when log/ is writable and to stderr otherwise, and /usage succeeds while it is
// logged in: the bisect must report quota_ok everywhere and the lines as noise. With FAKE_AGY_AUTH_MARKER the fake is
// logged in only while $HOME/.gemini/antigravity-cli/cache/auth-marker is visible: the bisect must then name `cache`.
// The fake loads the workspace hooks only when the cwd is a git repo: H2 is where hooks are discovered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgy, FAKE_MCP_CREDENTIAL } from "./fixtures/dispatch.mjs";
import { sandboxAvailable, GEMINI_STATE_SUBDIRS } from "../src/agy/sandbox.mjs";
import { conclude, readLayout } from "../scripts/agy-layout-bisect.mjs";

const BISECT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "agy-layout-bisect.mjs");
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };
const usage = { conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8 }] }] } } };
const tree = dir => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; if (e.isSymbolicLink()) out[r] = "->"; else if (e.isDirectory()) { out[r + "/"] = ""; walk(join(d, e.name), r); } else out[r] = readFileSync(join(d, e.name), "utf8"); } }; walk(dir, ""); return out; };
const bisectDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith("pantheon-agy-bisect-"));

function run(cli, env, args = []) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env };
    delete e.PANTHEON_AGY_CLI; delete e.GEMINI_API_KEY; delete e.GOOGLE_API_KEY; delete e.FAKE_AGY_LOG;
    const c = spawn(process.execPath, [BISECT, "--cli", cli, ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.on("error", reject);
    c.on("close", code => { try { resolve({ code, out, summary: JSON.parse(out) }); } catch { reject(new Error(`bisect printed ${out.slice(0, 300)} (${err})`)); } });
  });
}

/** A fake HOME with the agy 1.5.10 layout (and a fake agy logged in while cache/auth-marker is visible, when asked). */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-bisect-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = join(root, "fx"), home = join(root, "home"), g = join(home, ".gemini"), c = join(g, "antigravity-cli");
  mkdirSync(fx);
  for (const d of ["cache", "log", "conversations", "plugins"]) mkdirSync(join(c, d), { recursive: true });
  mkdirSync(join(g, "config", "projects"), { recursive: true });
  writeFileSync(join(g, "settings.json"), "{}"); writeFileSync(join(g, "trustedFolders.json"), "{}");
  writeFileSync(join(g, "config", "projects", "default-cli-project.json"), '{"host":1}');
  writeFileSync(join(c, "settings.json"), "{}"); writeFileSync(join(c, "antigravity-oauth-token"), "fake-token"); writeFileSync(join(c, "history.jsonl"), "history\n");
  writeFileSync(join(c, "cache", "auth-marker"), "logged-in"); writeFileSync(join(c, "log", "cli-old.log"), "old"); writeFileSync(join(c, "conversations", "old.db"), "db");
  writeFileSync(join(c, "plugins", "p.json"), "plugin");
  symlinkSync("log/cli-old.log", join(c, "cli.log"));   // observed: the host's antigravity-cli/cli.log is a symlink
  const cli = fakeAgy(fx);
  writeFileSync(join(fx, "quota-report.txt"), JSON.stringify(usage)); writeFileSync(join(fx, "quota-exit"), "0");
  return { root, fx, home, g, c, cli };
}
const ALL = ["L0", "L1", "L2", ...GEMINI_STATE_SUBDIRS.map(d => `L3.${d}`), "L4", "H1", "H2", "H3", "H4"];
/** The layouts whose antigravity-cli/log/ is NOT writable inside (the real dir ro, or a ro-bound log/). */
const LOG_RO = ["L1", "L2", ...GEMINI_STATE_SUBDIRS.filter(d => d !== "log").map(d => `L3.${d}`)];

test("the bisect in the OBSERVED pattern (agy 1.5.10, 2026-11-18): /usage succeeds in every layout; the not-logged-in lines go to stderr exactly where log/ is read-only and to the log FILE elsewhere, which is now read: quota_ok everywhere, negative_login_lines_are_noise; hooks from the log files", needBwrap, async t => {
  const f = fixture(t);
  const before = tree(f.home), dirsBefore = bisectDirs();
  const r = await run(f.cli, { HOME: f.home });
  const o = r.summary;
  assert.equal(r.code, 0, o.error ?? "");
  assert.deepEqual(o.layouts.map(l => l.id), ALL);
  assert.ok(o.layouts.every(l => !l.error && !l.skipped), JSON.stringify(o.layouts.filter(l => l.error || l.skipped)));
  const by = Object.fromEntries(o.layouts.map(l => [l.id, l]));
  assert.deepEqual(Object.fromEntries(o.layouts.map(l => [l.id, [l.quota_ok, l.auth]])), Object.fromEntries(ALL.map(id => [id, [true, "ok"]])));
  // Where the lines were: stderr in the read-only-log layouts, the log FILE in the others (H3: --add-dir refused, nothing logged).
  for (const id of ALL.filter(x => x !== "H3")) {
    const s = by[id].negative_login_sources;
    assert.deepEqual([s.stdout_stderr > 0, s.file > 0, by[id].negative_login_lines === s.stdout_stderr + s.file], LOG_RO.includes(id) ? [true, false, true] : [false, true, true], id);
    assert.equal(by[id].log_sources.file_lines > 0, !LOG_RO.includes(id), id);
  }
  assert.equal(o.h_base_layout, "L4", "the current layout is authenticated: the H variants run on it");
  assert.deepEqual(o.conclusion, { login_survives_copy: true, login_lost_when: [], state_subdirs_losing_login: [], negative_login_lines_in: ALL.filter(x => x !== "H3"),
    negative_login_lines_are_noise: true, hooks_discovered_in: ["H2"], mcp_workspace_discovered_in: ALL.filter(x => x !== "H3") });
  // The hooks line of H2 (on L4: log/ writable) was ONLY in the log file: hooks_loaded is read from it.
  assert.deepEqual([by.H2.hooks_loaded, by.H2.log_sources.stderr_lines, by.H1.hooks_loaded, by.L1.hooks_loaded], [{ named: 1, files: 1 }, 0, { named: 0, files: 0 }, { named: 0, files: 0 }]);
  assert.equal(by.H3.hooks_loaded, null, "no matching line anywhere: null");
  assert.deepEqual(by.L4.workspace_dirs, null, "the subcommands print no workspaceDirs line (the fake's --print turn does)");
  assert.ok(by.L1.lines.negative_login.some(l => /You are not logged into Antigravity/.test(l)));
  assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL) && !r.out.includes("FAKE-CREDENTIAL"));
  assert.deepEqual(bisectDirs().filter(n => !dirsBefore.includes(n)), []);
  const after = tree(f.home);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]).sort();
  assert.ok(changed.every(k => /^\.gemini\/antigravity-cli\/log\/cli-\d+\.log$/.test(k) || k === ".gemini/config/projects/default-cli-project.json"), changed.join(" "));
  assert.equal(changed.filter(k => k.includes("/log/")).length, 2, "two log files: L0's agents and mcp list, nothing from the jailed layouts");
});

test("the bisect against a fake that REALLY loses its login when cache/ is emptied (L3.cache, L4): quota_ok false there, the negative lines are then not noise; hooks only in H2; no credential printed, every scratch deleted, the host untouched by the jailed layouts", needBwrap, async t => {
  const f = fixture(t);
  const { c, g } = f;
  const before = tree(f.home), dirsBefore = bisectDirs();
  const r = await run(f.cli, { HOME: f.home, FAKE_AGY_AUTH_MARKER: "cache/auth-marker" });
  const o = r.summary;
  assert.equal(r.code, 0, o.error ?? "");
  assert.equal(o.schema, "pantheon.agy-layout-bisect/v1");
  assert.equal(o.spent, "nothing (no model turn; /usage, agents and mcp list only)");
  assert.deepEqual([o.agy.path, o.agy.version], [f.cli, "fake-agy 0.0.0-fixture"]);
  assert.deepEqual(o.layouts.map(l => l.id), ALL);
  const by = Object.fromEntries(o.layouts.map(l => [l.id, l]));
  assert.ok(o.layouts.every(l => !l.error && !l.skipped), JSON.stringify(o.layouts.filter(l => l.error || l.skipped)));
  const lost = id => id === "L3.cache" || id === "L4";
  assert.deepEqual(Object.fromEntries(o.layouts.map(l => [l.id, [l.quota_ok, l.auth]])), Object.fromEntries(ALL.map(id => [id, lost(id) ? [false, "logged_out"] : [true, "ok"]])));
  assert.equal(o.h_base_layout, "L2", "L4 is logged out, so the H variants run on L2");
  assert.deepEqual(o.conclusion, { login_survives_copy: true, login_lost_when: ["L3.cache", "L4"], state_subdirs_losing_login: ["cache"], negative_login_lines_in: ALL.filter(x => x !== "H3"),
    negative_login_lines_are_noise: false, hooks_discovered_in: ["H2"], mcp_workspace_discovered_in: ALL.filter(x => x !== "H3") });
  assert.deepEqual([by.H1.hooks_loaded, by.H2.hooks_loaded], [{ named: 0, files: 0 }, { named: 1, files: 1 }]);
  assert.deepEqual([by.H3.bad_flag, by.H3.exits.agents, by.H3.exits.mcp_list], [{ agents: true, mcp_list: true }, 1, 1], "--add-dir refused, recorded");
  assert.match(by.H4.note, /ONLY inside this jail.*host trustedFolders\.json is untouched/);
  // The read-only real dir (L1) fails the log and project writes; L2's ro-bound log/ fails the log only; L4 neither.
  assert.equal(by.L1.project_resolve_error, true);
  assert.ok(by.L1.erofs_paths.some(p => p.startsWith(join(c, "log") + "/")) && by.L1.erofs_paths.some(p => p.startsWith(join(g, "config", "projects") + "/")), by.L1.erofs_paths.join(" "));
  assert.deepEqual([by.L2.project_resolve_error, by.L2.erofs_paths.every(p => p.startsWith(join(c, "log") + "/")), by.L2.erofs_paths.length > 0], [false, true, true]);
  assert.deepEqual([by["L3.log"].erofs_paths, by.L4.erofs_paths, by.L4.project_resolve_error], [[], [], false]);
  assert.deepEqual(by.L0.mcp_servers, ["context7", "pantheon-subagents"]);
  assert.ok(by["L3.cache"].lines.negative_login.some(l => /You are not logged into Antigravity/.test(l)));
  // Never the credential; the scratches (copied credentials) deleted.
  assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL) && !r.out.includes("FAKE-CREDENTIAL"));
  assert.deepEqual([o.scratch.kept, o.scratch.contains_credentials], [false, true]);
  assert.match(o.scratch.note, /deleted/);
  assert.deepEqual(bisectDirs().filter(n => !dirsBefore.includes(n)), []);
  // The host: only L0 (the unjailed control) wrote, as a plain agy run would: its log files and the project file.
  const after = tree(f.home);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]).sort();
  assert.ok(changed.every(k => /^\.gemini\/antigravity-cli\/log\/cli-\d+\.log$/.test(k) || k === ".gemini/config/projects/default-cli-project.json"), changed.join(" "));
  assert.equal(changed.filter(k => k.includes("/log/")).length, 2, "two log files: L0's agents and mcp list, nothing from the jailed layouts");
});

test("--keep keeps the scratch and says it holds credentials; a missing agy exits 2", needBwrap, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-bisect-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = join(root, "fx"), home = join(root, "home");
  mkdirSync(fx); mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const cli = fakeAgy(fx);
  const r = await run(cli, { HOME: home }, ["--keep"]);
  t.after(() => rmSync(r.summary.scratch.root, { recursive: true, force: true }));
  assert.equal(r.code, 0);
  assert.equal(r.summary.scratch.kept, true);
  assert.match(r.summary.scratch.note, /KEPT at .*COPIED CREDENTIALS/);
  assert.ok(readdirSync(r.summary.scratch.root).length > 0);
  const m = await run(join(fx, "no-such-agy"), { HOME: home });
  assert.equal(m.code, 2);
  assert.match(m.summary.error, /agy not found/);
});

test("conclude: unknown when L2 did not run; no subdir blamed when L2 itself is logged out; the login from quota_ok ONLY, the negative lines noise when quota_ok holds wherever they appear", () => {
  assert.deepEqual(conclude([]), { login_survives_copy: null, login_lost_when: [], state_subdirs_losing_login: [], negative_login_lines_in: [], negative_login_lines_are_noise: null, hooks_discovered_in: [], mcp_workspace_discovered_in: [] });
  const c = conclude([{ id: "L2", quota_ok: false, negative_login_lines: 2 }, { id: "L3.cache", quota_ok: false, negative_login_lines: 0 }]);
  assert.deepEqual([c.login_survives_copy, c.state_subdirs_losing_login, c.negative_login_lines_are_noise], [false, [], false]);
  // The observed pattern: lines in L1/L2/L3.* (not L3.log) and /usage ok everywhere.
  const obs = conclude([{ id: "L0", quota_ok: true, negative_login_lines: 0 }, { id: "L1", quota_ok: true, negative_login_lines: 4 }, { id: "L2", quota_ok: true, negative_login_lines: 4 },
    { id: "L3.cache", quota_ok: true, negative_login_lines: 4 }, { id: "L3.log", quota_ok: true, negative_login_lines: 0 }, { id: "L4", quota_ok: true, negative_login_lines: 0 }]);
  assert.deepEqual([obs.login_survives_copy, obs.login_lost_when, obs.negative_login_lines_in, obs.negative_login_lines_are_noise], [true, [], ["L1", "L2", "L3.cache"], true]);
});

test("readLayout: quota_ok and auth from /usage alone; the negative lines counted from stdout/stderr AND the log files; hooks and workspaceDirs from a log file", () => {
  const usageOut = JSON.stringify(usage);
  const neg = "E1118 00:00:00.000000 1 auth.go:2] error getting token source: You are not logged into Antigravity.";
  const l = readLayout({ usage: { status: 0, stdout: usageOut, stderr: "" }, agents: { status: 0, stdout: "", stderr: neg, log: "" },
    mcp_list: { status: 0, stdout: "context7\tstdio", stderr: "", log: `${neg}\nI1118 hooks_manager.go:54] loaded 1 named hooks from 1 hooks.json file(s)\nI1118 workspace.go:12] workspaceDirs=[/ctl]\n` } });
  assert.deepEqual([l.quota_ok, l.auth, l.negative_login_lines, l.negative_login_sources, l.hooks_loaded, l.workspace_dirs, l.log_sources],
    [true, "ok", 2, { stdout_stderr: 1, file: 1 }, { named: 1, files: 1 }, ["/ctl"], { stderr_lines: 1, file_lines: 3 }]);
  const out = readLayout({ usage: { status: 0, stdout: JSON.stringify({ ...usage, command: { name: "usage", data: { groups: [] } } }), stderr: "" }, agents: { status: 0, stdout: "", stderr: "" }, mcp_list: { status: 0, stdout: "", stderr: "" } });
  assert.deepEqual([out.quota_ok, out.auth, out.negative_login_lines, out.hooks_loaded], [false, "logged_out", 0, null]);
  const unk = readLayout({ usage: { status: null, stdout: "", stderr: "spawn failed" }, agents: { status: 0, stdout: "", stderr: neg }, mcp_list: { status: 0, stdout: "", stderr: "" } });
  assert.deepEqual([unk.quota_ok, unk.auth], [false, "unknown"], "a negative subcommand line alone never makes it logged_out");
});
