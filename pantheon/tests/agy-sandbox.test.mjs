// The worker's bwrap containment (src/agy/sandbox.mjs) with the REAL bwrap and a stand-in worker command: inside, the
// worktree is writable; $HOME, the repo checkout, the control dir's hooks.json and the main .git are not; a Unix
// socket the parent created in the control dir (and one in a directory elsewhere) is reachable — the A2A path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bwrapArgs, sandboxAvailable, repoGitDirs, geminiState, dropGeminiState, defaultAgyStateDirs, GEMINI_CLI_COPY, GEMINI_STATE_SUBDIRS, GEMINI_WRITABLE_COPIES, GEMINI_WRITABLE_SUBDIR_COPIES, GEMINI_WRITABLE_TREE_COPIES } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { sh } from "./fixtures/pipeline-stages.mjs";

const have = await sandboxAvailable("bwrap");
const run = (argv, opts = {}) => new Promise((resolve, reject) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let out = "", err = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
  c.on("error", reject); c.on("close", code => resolve({ code, out, err }));
});

async function layout(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-bwrap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), wt = join(root, "run", "worktrees", "a"), ctl = join(root, "run", "control", "a"), state = join(root, "agy-state");
  mkdirSync(repo, { recursive: true }); mkdirSync(state); mkdirSync(join(root, "run", "worktrees"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "base\n");
  await sh("git init -q -b main . && git -c user.name=t -c user.email=t@t.invalid add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m base", repo);
  await sh(`git worktree add -q -b unit-a ${wt}`, repo);
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**"], verify_cmd: "true" });
  return { root, repo, wt, ctl, state, ws };
}

test("bwrapArgs: the read-only host, the writable worktree/run/state dirs, the read-only control dir and main .git, the chdir", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { repo, wt, ctl, state } = await layout(t);
  const g = repoGitDirs(wt);
  assert.equal(g.common_dir, join(repo, ".git"));
  assert.equal(g.git_dir, join(repo, ".git", "worktrees", "a"));
  const { argv, binds } = bwrapArgs({ worktree: wt, control_dir: ctl, agy_state_dirs: [state] });
  // --unshare-pid and --new-session: independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 5.
  // The whole argv: the fixed head, every bind with the flag that makes it read-only or writable, in order, the chdir.
  assert.deepEqual(argv, ["bwrap", "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--bind", state, state, "--bind", wt, wt, "--ro-bind", ctl, ctl, "--bind", join(ctl, "run"), join(ctl, "run"), "--ro-bind", join(repo, ".git"), join(repo, ".git"),
    "--chdir", ctl, "--"]);
  assert.ok(!argv.includes("--unshare-net") && !argv.includes("--unshare-all"), "the network is not unshared: the CLI must reach Google");
  assert.deepEqual(binds, [{ mode: "rw", path: state }, { mode: "rw", path: wt }, { mode: "ro", path: ctl }, { mode: "rw", path: join(ctl, "run") }, { mode: "ro", path: join(repo, ".git") }]);
});

test("inside the sandbox the worker writes its worktree and run/, nothing else; it reaches Unix sockets in the control dir and in a bound socket dir", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { root, repo, wt, ctl, state, ws } = await layout(t);
  // The A2A path: a socket the parent listens on, in the control dir (read-only inside) and in a fallback dir elsewhere.
  const sockDir = join(root, "sockfallback");
  mkdirSync(sockDir);
  const servers = [];
  for (const p of [join(ctl, "a2a.sock"), join(sockDir, "a2a.sock")]) {
    const s = createServer(c => c.end("pong\n"));
    await new Promise(r => s.listen(p, r));
    servers.push(s);
  }
  t.after(() => servers.forEach(s => s.close()));
  const home = homedir();
  const probe = join(root, "probe.mjs");
  writeFileSync(probe, `
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
const out = {};
const tryWrite = (k, p) => { try { writeFileSync(p, "x"); out[k] = "written"; } catch (e) { out[k] = e.code; } };
const [wt, run, state, home, repo, hooks, ref, sockA, sockB, tmpProbe] = process.argv.slice(2);
tryWrite("worktree", wt + "/src-a.txt");
tryWrite("run", run + "/x.log");
tryWrite("state", state + "/session.json");
tryWrite("tmp", tmpProbe);
tryWrite("home", home + "/pantheon-bwrap-escape-test");
tryWrite("repo", repo + "/escaped.txt");
tryWrite("hooks", hooks);
tryWrite("ref", ref);
const ping = p => new Promise(r => { const c = connect(p); let d = ""; c.on("data", x => { d += x; }); c.on("end", () => r(d.trim())); c.on("error", e => r(e.code)); });
out.sockA = await ping(sockA); out.sockB = await ping(sockB);
out.cwd = process.cwd();
console.log(JSON.stringify(out));
`);
  const { argv } = bwrapArgs({ worktree: wt, control_dir: ctl, agy_state_dirs: [state], extra_ro: [sockDir, root] });
  const homeBefore = readdirSync(home).sort();
  // A name under /tmp no other process uses (this test's own random dir name): the host's /tmp may hold anything, e.g.
  // an existing /tmp/scratch directory (the owner's machine, 2026-11-19), so a fixed name is not a hermetic probe.
  const tmpProbe = join("/tmp", `${basename(root)}-tmpfs-probe`);
  assert.equal(existsSync(tmpProbe), false, "the probe's /tmp name is unused on the host");
  const r = await run([...argv, process.execPath, probe, wt, join(ctl, "run"), state, home, repo, ws.hooks, join(repo, ".git", "refs", "heads", "evil"), join(ctl, "a2a.sock"), join(sockDir, "a2a.sock"), tmpProbe]);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  // The property is that a write cannot reach the HOST home. When HOME itself lies under /tmp (a test or CI home in a
  // temporary directory), the sandbox's fresh tmpfs at /tmp hides it: inside, the path does not exist and the write
  // fails ENOENT instead of EROFS. Either errno means the write did not land; ENOENT is accepted ONLY in that case, and
  // the host home is checked unchanged below either way.
  const homeUnderTmp = realpathSync(home) === "/tmp" || realpathSync(home).startsWith("/tmp/");
  assert.ok(homeUnderTmp ? ["EROFS", "ENOENT"].includes(out.home) : out.home === "EROFS", `home write inside the sandbox: ${out.home}`);
  assert.deepEqual({ ...out, home: undefined }, { worktree: "written", run: "written", state: "written", tmp: "written", home: undefined, repo: "EROFS", hooks: "EROFS", ref: "EROFS", sockA: "pong", sockB: "pong", cwd: ctl });
  assert.deepEqual(readdirSync(home).sort(), homeBefore, "the host home is unchanged by the sandboxed write attempt");
  assert.equal(readFileSync(join(wt, "src-a.txt"), "utf8"), "x");
  assert.equal(existsSync(join(repo, "escaped.txt")), false);
  assert.equal(existsSync(join(repo, ".git", "refs", "heads", "evil")), false);
  assert.equal(existsSync(join(home, "pantheon-bwrap-escape-test")), false);
  assert.match(readFileSync(ws.hooks, "utf8"), /PreToolUse/);
  assert.equal(existsSync(tmpProbe), false, "/tmp inside is a fresh tmpfs: the write inside did not reach the host /tmp");
  // The worker cannot commit: the main .git is read-only, even though the worktree is writable.
  const commit = await run([...argv, "sh", "-c", `cd ${wt} && git -c user.name=t -c user.email=t@t.invalid add -A && git -c user.name=t -c user.email=t@t.invalid commit -qm evil`]);
  assert.notEqual(commit.code, 0);
  assert.equal((await sh("git log --oneline unit-a", repo)).trim().split("\n").length, 1);
});

/** A recursive listing {relative path: content} of a host directory (missing: null). */
const snapshot = dir => {
  if (!existsSync(dir)) return null;
  const out = {};
  const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) walk(join(d, e.name), r); else out[r] = readFileSync(join(d, e.name), "utf8"); } };
  walk(dir, "");
  return out;
};

/**
 * A fake HOME with the agy 1.5.10 layout OBSERVED on the owner's machine (2026-11-18), the host side of the jail: the
 * top-level files of antigravity-cli (antigravity-oauth-token, conversation_summaries.db, history.jsonl, installation_id,
 * jetbox_summaries_proto.pb, jetski_state.pbtxt, last_check.timestamp, settings.json), state and unknown subdirs, and
 * ~/.gemini/config/projects.
 */
function fakeHome(root) {
  const home = join(root, "home"), g = join(home, ".gemini"), c = join(g, "antigravity-cli");
  mkdirSync(join(c, "conversations"), { recursive: true }); mkdirSync(join(c, "plugins"), { recursive: true }); mkdirSync(join(c, "cache")); mkdirSync(join(c, "log"));
  for (const f of ["GEMINI.md", "google_accounts.json", "installation_id", "projects.json", "state.json", "trustedFolders.json"]) writeFileSync(join(g, f), `${f}\n`);
  writeFileSync(join(g, "settings.json"), "{}");
  writeFileSync(join(g, "oauth_creds.json"), '{"refresh_token":"fake"}');
  writeFileSync(join(c, "settings.json"), '{"cli":"host"}', { mode: 0o640 });
  writeFileSync(join(c, "antigravity-oauth-token"), "fake-oauth-token", { mode: 0o600 });
  for (const f of ["installation_id", "jetski_state.pbtxt", "last_check.timestamp"]) writeFileSync(join(c, f), `${f}\n`);
  writeFileSync(join(c, "history.jsonl"), '{"prompt":"host history"}\n');
  writeFileSync(join(c, "conversation_summaries.db"), "summaries-db");
  writeFileSync(join(c, "jetbox_summaries_proto.pb"), "jetbox");
  writeFileSync(join(c, "conversations", "old.db"), "host history");
  writeFileSync(join(c, "cache", "last_conversations.json"), "[1]");
  writeFileSync(join(c, "log", "old.log"), "host log");
  writeFileSync(join(c, "plugins", "p.json"), "plugin");
  symlinkSync("settings.json", join(c, "linked.json"));
  // bin/ (observed on agy 1.5.10, 2026-11-18: run_command writes bin/agentapi first): a writable COPY in the scratch.
  mkdirSync(join(c, "bin", "helpers"), { recursive: true });
  writeFileSync(join(c, "bin", "language_server"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(c, "bin", "agentapi"), "old agentapi", { mode: 0o700 });
  symlinkSync("language_server", join(c, "bin", "ls-link"));
  writeFileSync(join(c, "bin", "helpers", "h.sh"), "helper");
  const proj = join(g, "config", "projects");
  mkdirSync(join(proj, "nested"), { recursive: true });
  writeFileSync(join(proj, "default-cli-project.json"), '{"p":1}', { mode: 0o640 });
  writeFileSync(join(proj, "nested", "n.json"), "nested");
  writeFileSync(join(g, "config", "other.json"), "{}");
  return { home, g, c, proj };
}

test("~/.gemini (a FAKE home): read-only inside; ~/.gemini/antigravity-cli is a per-run scratch COPY of the ALLOWLISTED top-level files only (history, summaries and databases withheld), its state subdirs (log/ included) empty and writable, an unknown subdir read-only; ~/.gemini/config/projects a writable copy; the host is unchanged and nothing is created under HOME", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { root, repo, wt, ctl } = await layout(t);
  const { home, g, c, proj } = fakeHome(root);
  const before = snapshot(home);
  const st = await geminiState({ home, run_dir: join(ctl, "run") });
  assert.equal(st.enabled, true);
  assert.equal(st.cli_dir, c);
  assert.ok(st.scratch_cli.startsWith(join(ctl, "run", "agy-state") + "/") && st.scratch_cli.endsWith("/antigravity-cli"), st.scratch_cli);
  assert.equal(statSync(st.scratch_root).mode & 0o777, 0o700, "the scratch root (it holds the OAuth token) is 0700");
  const projCopy = join(st.scratch_root, "writable", "config", "projects");
  assert.deepEqual(GEMINI_WRITABLE_SUBDIR_COPIES, ["bin"]);
  assert.deepEqual(st.writable_subdirs, [{ name: "bin", src: join(c, "bin"), dest: join(st.scratch_cli, "bin"), copied: ["agentapi", "language_server"], symlinks: [{ name: "ls-link", target: "language_server" }], skipped: [], readonly_subdirs: ["helpers"] }]);
  assert.equal(statSync(join(st.scratch_cli, "bin", "language_server")).mode & 0o777, 0o755, "bin/ files keep their mode");
  assert.deepEqual(st.mounts, [{ dest: c, src: st.scratch_cli, mode: "rw" }, { dest: join(c, "bin", "helpers"), src: join(c, "bin", "helpers"), mode: "ro" }, { dest: join(c, "plugins"), src: join(c, "plugins"), mode: "ro" },
    { dest: proj, src: projCopy, mode: "rw" }, { dest: join(proj, "nested"), src: join(proj, "nested"), mode: "ro" }]);
  assert.deepEqual(GEMINI_CLI_COPY, ["settings.json", "antigravity-oauth-token", "installation_id", "jetski_state.pbtxt", "last_check.timestamp"]);
  assert.ok(GEMINI_STATE_SUBDIRS.includes("log"));
  assert.deepEqual(GEMINI_WRITABLE_COPIES, ["config/projects"]);
  assert.deepEqual(st.copied, ["antigravity-oauth-token", "installation_id", "jetski_state.pbtxt", "last_check.timestamp", "settings.json"]);
  assert.deepEqual(st.withheld, [{ name: "conversation_summaries.db", size: 12 }, { name: "history.jsonl", size: 26 }, { name: "jetbox_summaries_proto.pb", size: 6 }]);
  assert.deepEqual([st.skipped, st.hidden_state, st.readonly_subdirs], [[{ name: "linked.json", kind: "symlink" }], ["conversations", "cache", "log"], ["plugins"]]);
  assert.deepEqual(st.writable_copies, [{ path: "config/projects", dest: proj, status: "copied", src: projCopy, copied: ["default-cli-project.json"], skipped: [], readonly_subdirs: ["nested"] }]);
  assert.equal(statSync(join(st.scratch_cli, "settings.json")).mode & 0o777, 0o640, "the copy keeps the mode");
  assert.equal(statSync(join(st.scratch_cli, "antigravity-oauth-token")).mode & 0o777, 0o600);
  assert.equal(statSync(join(projCopy, "default-cli-project.json")).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(st.scratch_cli).sort(), [...GEMINI_STATE_SUBDIRS, ...st.copied, "bin", "plugins"].sort());
  for (const f of ["history.jsonl", "conversation_summaries.db", "jetbox_summaries_proto.pb"]) assert.equal(existsSync(join(st.scratch_cli, f)), false, `${f} is NOT in the scratch`);
  assert.deepEqual(snapshot(home), before, "preparing the layout wrote nothing under HOME");
  mkdirSync(join(root, "probe"));
  const { argv, binds } = bwrapArgs({ worktree: wt, control_dir: ctl, gemini_state: st, extra_ro: [join(root, "probe"), home] });
  // Parent-first: ~/.gemini ro, then the scratch rw over antigravity-cli and the projects copy rw over config/projects,
  // then the host's unknown subdirs ro over their mount points inside the scratch; the main .git read-only bind last.
  // The whole argv, every bind in order (bin/helpers, the extra read-only binds and the .git bind included).
  const ro = p => ["--ro-bind", p, p], rw = (src, dest = src) => ["--bind", src, dest], cliDir = join(g, "antigravity-cli");
  assert.deepEqual(argv, ["bwrap", "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    ...ro(join(root, "probe")), ...ro(home), ...ro(g), ...rw(st.scratch_cli, cliDir), ...rw(wt), ...ro(ctl), ...ro(join(cliDir, "plugins")), ...rw(projCopy, proj), ...rw(join(ctl, "run")),
    ...ro(join(cliDir, "bin", "helpers")), ...ro(join(proj, "nested")), ...ro(join(repo, ".git")), "--chdir", ctl, "--"]);
  const at = p => argv.lastIndexOf(p);
  const [i, j, k, l, n] = [at(g), at(c), at(join(c, "plugins")), at(proj), at(join(proj, "nested"))];
  assert.ok(i < j && j < k && j < l && l < n);
  assert.ok(!argv.some(a => a.includes("/.gemini/antigravity/")), "the old antigravity/ layout is gone");
  assert.equal(binds.at(-1).mode, "ro");
  const probe = join(root, "probe", "gemini-probe.mjs");
  writeFileSync(probe, `
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
const [g, log] = process.argv.slice(2), c = g + "/antigravity-cli", p = g + "/config/projects";
const out = {};
const tryIt = (k, f) => { try { out[k] = f() ?? "ok"; } catch (e) { out[k] = e.code; } };
tryIt("read_oauth", () => readFileSync(g + "/oauth_creds.json", "utf8"));
tryIt("write_settings", () => writeFileSync(g + "/settings.json", "{1}"));
tryIt("write_top", () => writeFileSync(g + "/new.json", "x"));
tryIt("read_cli_settings", () => readFileSync(c + "/settings.json", "utf8"));
tryIt("read_cli_token", () => readFileSync(c + "/antigravity-oauth-token", "utf8"));
tryIt("read_history", () => readFileSync(c + "/history.jsonl", "utf8"));
tryIt("read_summaries", () => readFileSync(c + "/conversation_summaries.db", "utf8"));
tryIt("list_conv", () => readdirSync(c + "/conversations").join(","));
tryIt("list_log", () => readdirSync(c + "/log").join(","));
tryIt("write_conv", () => writeFileSync(c + "/conversations/x", "conv"));
tryIt("write_log", () => writeFileSync(c + "/log/cli.log", "log line"));
tryIt("mkdir_brain", () => { mkdirSync(c + "/brain/id1"); writeFileSync(c + "/brain/id1/task.md", "b"); });
tryIt("write_jetbox", () => writeFileSync(c + "/jetbox_summaries_proto.pb.1.tmp", "j"));
tryIt("rewrite_cli_settings", () => writeFileSync(c + "/settings.json", '{"cli":"inside"}'));
tryIt("read_plugin", () => readFileSync(c + "/plugins/p.json", "utf8"));
tryIt("write_plugin", () => writeFileSync(c + "/plugins/x", "x"));
tryIt("read_project", () => readFileSync(p + "/default-cli-project.json", "utf8"));
tryIt("write_project", () => { writeFileSync(p + "/default-cli-project.json.r1.tmp", '{"p":2}'); renameSync(p + "/default-cli-project.json.r1.tmp", p + "/default-cli-project.json"); });
tryIt("read_nested", () => readFileSync(p + "/nested/n.json", "utf8"));
tryIt("write_nested", () => writeFileSync(p + "/nested/x", "x"));
tryIt("write_config", () => writeFileSync(g + "/config/other.json", "x"));
tryIt("write_agentapi", () => writeFileSync(c + "/bin/agentapi", "#!/bin/sh\\n# agentapi\\n"));
tryIt("read_bin_link", () => readFileSync(c + "/bin/ls-link", "utf8"));
tryIt("write_bin_helpers", () => writeFileSync(c + "/bin/helpers/x", "x"));
tryIt("log", () => writeFileSync(log, "agy log line\\n"));
console.log(JSON.stringify(out));
`);
  const r = await run([...argv, process.execPath, probe, g, join(ctl, "run", "agy.log")], { env: { ...process.env, HOME: home } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { read_oauth: '{"refresh_token":"fake"}', write_settings: "EROFS", write_top: "EROFS", read_cli_settings: '{"cli":"host"}', read_cli_token: "fake-oauth-token",
    read_history: "ENOENT", read_summaries: "ENOENT", list_conv: "", list_log: "", write_conv: "ok", write_log: "ok", mkdir_brain: "ok", write_jetbox: "ok", rewrite_cli_settings: "ok",
    read_plugin: "plugin", write_plugin: "EROFS", read_project: '{"p":1}', write_project: "ok", read_nested: "nested", write_nested: "EROFS", write_config: "EROFS",
    write_agentapi: "ok", read_bin_link: "#!/bin/sh\n", write_bin_helpers: "EROFS", log: "ok" },
    "inside: the CLI's state subdirs (log/ included) start empty (host history hidden) and are writable, the withheld files are absent, config/projects is writable; the rest of ~/.gemini and the unknown subdirs are read-only");
  // What the CLI wrote is listed (names and sizes), then the scratch is removed; the HOST is exactly as before.
  const listing = await dropGeminiState(st);
  assert.deepEqual(listing, { dir: c,
    top_level: [{ name: "antigravity-oauth-token", size: 16, copied: true, changed: false }, { name: "installation_id", size: 16, copied: true, changed: false },
      { name: "jetbox_summaries_proto.pb.1.tmp", size: 1, copied: false, changed: true }, { name: "jetski_state.pbtxt", size: 19, copied: true, changed: false },
      { name: "last_check.timestamp", size: 21, copied: true, changed: false }, { name: "settings.json", size: 16, copied: true, changed: true }],
    subdirs: { brain: [{ path: "id1/task.md", size: 1 }], cache: [], conversations: [{ path: "x", size: 4 }], crashes: [], implicit: [], log: [{ path: "cli.log", size: 8 }], mcp: [], presence: [] },
    writable_subdirs: { bin: [{ path: "agentapi", size: 21, copied: true, changed: true }, { path: "language_server", size: 10, copied: true, changed: false }, { path: "ls-link", size: 15, copied: true, changed: false }] },
    writable_copies: { "config/projects": [{ path: "default-cli-project.json", size: 7, copied: true, changed: true }] }, removed: true });
  assert.equal(existsSync(st.scratch_root), false);
  assert.deepEqual(snapshot(home), before, "the host ~/.gemini is unchanged and nothing was created under HOME");
});

test("~/.gemini/antigravity-cli/builtin/ (the CLI's builtin plugin assets; inferred from the 09d490f report) is a per-run writable DEEP copy: writable at every depth inside, the host tree untouched, the writes listed; plugin_data/ stays read-only", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { root, wt, ctl } = await layout(t);
  const { home, c } = fakeHome(root);
  const b = join(c, "builtin");
  mkdirSync(join(b, "plugins", "core", "assets"), { recursive: true }); mkdirSync(join(c, "plugin_data"));
  writeFileSync(join(b, "manifest.json"), '{"v":1}', { mode: 0o640 });
  writeFileSync(join(b, "plugins", "core", "asset.js"), "host asset", { mode: 0o644 });
  writeFileSync(join(b, "plugins", "core", "assets", "icon.svg"), "<svg/>");
  symlinkSync("asset.js", join(b, "plugins", "core", "current.js"));
  writeFileSync(join(c, "plugin_data", "d.json"), "{}");
  const before = snapshot(home);
  const st = await geminiState({ home, run_dir: join(ctl, "run") });
  assert.deepEqual(GEMINI_WRITABLE_TREE_COPIES, ["builtin"]);
  const w = st.writable_subdirs.find(x => x.name === "builtin");
  assert.deepEqual(w, { name: "builtin", src: b, dest: join(st.scratch_cli, "builtin"), deep: true, copied: ["manifest.json", "plugins/core/asset.js", "plugins/core/assets/icon.svg"],
    symlinks: [{ name: "plugins/core/current.js", target: "asset.js" }], skipped: [], bytes: 23, readonly_subdirs: [] });
  assert.ok(!st.mounts.some(m => m.dest.startsWith(b)), "nothing of the host builtin/ is bound into the jail");
  assert.ok(st.readonly_subdirs.includes("plugin_data") && !st.readonly_subdirs.includes("builtin"));
  assert.equal(statSync(join(w.dest, "manifest.json")).mode & 0o777, 0o640, "modes kept");
  const { argv } = bwrapArgs({ worktree: wt, control_dir: ctl, gemini_state: st, extra_ro: [root] });
  const probe = join(root, "builtin-probe.mjs");
  writeFileSync(probe, `
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
const c = process.argv[2], out = {};
const tryIt = (k, f) => { try { out[k] = f() ?? "ok"; } catch (e) { out[k] = e.code; } };
tryIt("read_link", () => readFileSync(c + "/builtin/plugins/core/current.js", "utf8"));
tryIt("rewrite_asset", () => { writeFileSync(c + "/builtin/plugins/core/asset.js.1.tmp", "new asset"); renameSync(c + "/builtin/plugins/core/asset.js.1.tmp", c + "/builtin/plugins/core/asset.js"); });
tryIt("write_deep", () => writeFileSync(c + "/builtin/plugins/core/assets/icon.svg", "<svg id=1/>"));
tryIt("new_plugin", () => { mkdirSync(c + "/builtin/plugins/extra"); writeFileSync(c + "/builtin/plugins/extra/asset.js", "x"); });
tryIt("write_plugin_data", () => writeFileSync(c + "/plugin_data/d.json", "x"));
console.log(JSON.stringify(out));
`);
  const r = await run([...argv, process.execPath, probe, c], { env: { ...process.env, HOME: home } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { read_link: "host asset", rewrite_asset: "ok", write_deep: "ok", new_plugin: "ok", write_plugin_data: "EROFS" });
  const listing = await dropGeminiState(st);
  assert.deepEqual(listing.writable_subdirs.builtin, [
    { path: "manifest.json", size: 7, copied: true, changed: false },
    { path: "plugins/core/asset.js", size: 9, copied: true, changed: true },
    { path: "plugins/core/assets/icon.svg", size: 11, copied: true, changed: true },
    { path: "plugins/core/current.js", size: 8, copied: true, changed: false },
    { path: "plugins/extra/asset.js", size: 1, copied: false, changed: true }]);
  assert.deepEqual(snapshot(home), before, "the host builtin/ (and the rest of HOME) is unchanged");
});

test("config/projects absent on the host: not created, recorded as absent, and the rest of the layout still works", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-gemini-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), run_dir = join(root, "run");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true }); mkdirSync(run_dir);
  const before = snapshot(home);
  const st = await geminiState({ home, run_dir });
  assert.deepEqual(st.writable_copies.map(w => [w.path, w.status]), [["config/projects", "absent"]]);
  assert.deepEqual(st.mounts.map(m => m.dest), [join(home, ".gemini", "antigravity-cli")]);
  assert.equal(existsSync(join(home, ".gemini", "config")), false, "nothing is created under HOME");
  assert.deepEqual((await dropGeminiState(st)).writable_copies, {});
  assert.deepEqual(snapshot(home), before);
});

test("the ~/.gemini layout: off without a ~/.gemini; AGY_STATE_LAYOUT (and nothing created) when ~/.gemini/antigravity-cli is absent or a symlink; \"rw\" binds ~/.gemini writable and \"off\" adds nothing (the explicit overrides); no writable state dir is defaulted", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-gemini-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run_dir = join(root, "run");
  mkdirSync(run_dir);
  const home = join(root, "home");
  mkdirSync(home);
  assert.deepEqual([(await geminiState({ home, run_dir })).enabled, (await geminiState({ home, run_dir })).why], [false, `${join(home, ".gemini")} is not a directory`]);
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini", "settings.json"), "{}");
  const e = await geminiState({ home, run_dir }).then(() => null, err => err);
  assert.equal(e?.code, "AGY_STATE_LAYOUT");
  assert.match(e.message, /antigravity-cli does not exist.*never creates anything under the real home.*Run agy once outside the jail.*"rw" or "off"/);
  assert.deepEqual(readdirSync(join(home, ".gemini")), ["settings.json"], "no mount point was created on the host");
  assert.equal(existsSync(join(run_dir, "agy-state")), false, "and no scratch was left behind");
  symlinkSync(root, join(home, ".gemini", "antigravity-cli"));
  assert.equal((await geminiState({ home, run_dir }).then(() => null, err => err))?.code, "AGY_STATE_LAYOUT", "a symlinked antigravity-cli is refused, not followed");
  rmSync(join(home, ".gemini", "antigravity-cli"));
  const rw = await geminiState({ home, run_dir, mode: "rw" });
  assert.deepEqual([rw.enabled, rw.mounts], [true, []]);
  assert.equal(existsSync(join(home, ".gemini", "antigravity-cli")), false, "rw creates nothing");
  assert.equal((await geminiState({ home, run_dir, mode: "off" })).enabled, false);
  assert.deepEqual(defaultAgyStateDirs({ HOME: root }), [], "~/.gemini is no longer a default writable state dir");
  assert.deepEqual(defaultAgyStateDirs({ HOME: root, PANTHEON_AGY_STATE_DIRS: `${root}:/nonexistent` }), [root]);
});

test("sandboxAvailable reports a missing bwrap instead of throwing", async () => {
  const r = await sandboxAvailable("/nonexistent/bwrap");
  assert.equal(r.ok, false);
  assert.match(r.why, /does not exist/);
});
