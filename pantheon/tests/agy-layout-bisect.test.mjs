// The zero-spend layout bisect (scripts/agy-layout-bisect.mjs) against the FAKE agy under the REAL bwrap, with a FAKE
// HOME (the real one is never touched). The fake is "logged in" only while $HOME/.gemini/antigravity-cli/cache/auth-marker
// is visible (FAKE_AGY_AUTH_MARKER), and loads the workspace hooks only when the cwd is a git repo: the bisect must
// name `cache` as the state subdir whose emptying loses the login, and H2 as the variant where hooks are discovered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAgy, FAKE_MCP_CREDENTIAL } from "./fixtures/dispatch.mjs";
import { sandboxAvailable, GEMINI_STATE_SUBDIRS } from "../src/agy/sandbox.mjs";
import { conclude } from "../scripts/agy-layout-bisect.mjs";

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

test("the bisect against the fake agy: the login is lost exactly when cache/ is emptied (L3.cache, L4), hooks are discovered only in H2; no credential printed, every scratch deleted, the host untouched by the jailed layouts", needBwrap, async t => {
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
  const before = tree(home), dirsBefore = bisectDirs();
  const r = await run(cli, { HOME: home, FAKE_AGY_AUTH_MARKER: "cache/auth-marker" });
  const o = r.summary;
  assert.equal(r.code, 0, o.error ?? "");
  assert.equal(o.schema, "pantheon.agy-layout-bisect/v1");
  assert.equal(o.spent, "nothing (no model turn; /usage, agents and mcp list only)");
  assert.deepEqual([o.agy.path, o.agy.version], [cli, "fake-agy 0.0.0-fixture"]);
  assert.deepEqual(o.layouts.map(l => l.id), ["L0", "L1", "L2", ...GEMINI_STATE_SUBDIRS.map(d => `L3.${d}`), "L4", "H1", "H2", "H3", "H4"]);
  const by = Object.fromEntries(o.layouts.map(l => [l.id, l]));
  assert.ok(o.layouts.every(l => !l.error && !l.skipped), JSON.stringify(o.layouts.filter(l => l.error || l.skipped)));
  assert.deepEqual(Object.fromEntries(o.layouts.map(l => [l.id, l.auth])), { L0: "ok", L1: "ok", L2: "ok", ...Object.fromEntries(GEMINI_STATE_SUBDIRS.map(d => [`L3.${d}`, d === "cache" ? "logged_out" : "ok"])),
    L4: "logged_out", H1: "ok", H2: "ok", H3: "ok", H4: "ok" });
  assert.equal(o.h_base_layout, "L2", "L4 is logged out, so the H variants run on L2");
  assert.deepEqual(o.conclusion, { login_survives_copy: true, login_lost_when: ["L3.cache", "L4"], state_subdirs_losing_login: ["cache"], hooks_discovered_in: ["H2"],
    mcp_workspace_discovered_in: ["L0", "L1", "L2", ...GEMINI_STATE_SUBDIRS.map(d => `L3.${d}`), "L4", "H1", "H2", "H4"] });
  assert.deepEqual([by.H1.hooks_loaded, by.H2.hooks_loaded], [{ named: 0, files: 0 }, { named: 1, files: 1 }]);
  assert.deepEqual([by.H3.bad_flag, by.H3.exits.agents, by.H3.exits.mcp_list], [{ agents: true, mcp_list: true }, 1, 1], "--add-dir refused, recorded");
  assert.match(by.H4.note, /ONLY inside this jail.*host trustedFolders\.json is untouched/);
  // The read-only real dir (L1) fails the log and project writes; L2's ro-bound log/ fails the log only; L4 neither.
  assert.equal(by.L1.project_resolve_error, true);
  assert.ok(by.L1.erofs_paths.some(p => p.startsWith(join(c, "log") + "/")) && by.L1.erofs_paths.some(p => p.startsWith(join(g, "config", "projects") + "/")), by.L1.erofs_paths.join(" "));
  assert.deepEqual([by.L2.project_resolve_error, by.L2.erofs_paths.every(p => p.startsWith(join(c, "log") + "/")), by.L2.erofs_paths.length > 0], [false, true, true]);
  assert.deepEqual([by["L3.log"].erofs_paths, by.L4.erofs_paths, by.L4.project_resolve_error], [[], [], false]);
  assert.deepEqual(by.L0.mcp_servers, ["context7", "pantheon-subagents"]);
  assert.ok(by["L3.cache"].lines.auth.some(l => /You are not logged into Antigravity/.test(l)));
  // Never the credential; the scratches (copied credentials) deleted.
  assert.ok(!r.out.includes(FAKE_MCP_CREDENTIAL) && !r.out.includes("FAKE-CREDENTIAL"));
  assert.deepEqual([o.scratch.kept, o.scratch.contains_credentials], [false, true]);
  assert.match(o.scratch.note, /deleted/);
  assert.deepEqual(bisectDirs().filter(n => !dirsBefore.includes(n)), []);
  // The host: only L0 (the unjailed control) wrote, as a plain agy run would: its log files and the project file.
  const after = tree(home);
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

test("conclude: unknown when L2 did not run; no subdir blamed when L2 itself is logged out", () => {
  assert.deepEqual(conclude([]), { login_survives_copy: null, login_lost_when: [], state_subdirs_losing_login: [], hooks_discovered_in: [], mcp_workspace_discovered_in: [] });
  const c = conclude([{ id: "L2", auth: "logged_out" }, { id: "L3.cache", auth: "logged_out" }]);
  assert.deepEqual([c.login_survives_copy, c.state_subdirs_losing_login], [false, []]);
});
