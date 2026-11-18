// The worker's bwrap containment (src/agy/sandbox.mjs) with the REAL bwrap and a stand-in worker command: inside, the
// worktree is writable; $HOME, the repo checkout, the control dir's hooks.json and the main .git are not; a Unix
// socket the parent created in the control dir (and one in a directory elsewhere) is reachable — the A2A path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, sandboxAvailable, repoGitDirs, geminiState, dropGeminiState, defaultAgyStateDirs, GEMINI_STATE_SUBDIRS } from "../src/agy/sandbox.mjs";
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
  assert.deepEqual(argv.slice(0, 11), ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]);
  assert.deepEqual(argv.slice(-3), ["--chdir", ctl, "--"]);
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
const [wt, run, state, home, repo, hooks, ref, sockA, sockB] = process.argv.slice(2);
tryWrite("worktree", wt + "/src-a.txt");
tryWrite("run", run + "/x.log");
tryWrite("state", state + "/session.json");
tryWrite("tmp", "/tmp/scratch");
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
  const r = await run([...argv, process.execPath, probe, wt, join(ctl, "run"), state, home, repo, ws.hooks, join(repo, ".git", "refs", "heads", "evil"), join(ctl, "a2a.sock"), join(sockDir, "a2a.sock")]);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out, { worktree: "written", run: "written", state: "written", tmp: "written", home: "EROFS", repo: "EROFS", hooks: "EROFS", ref: "EROFS", sockA: "pong", sockB: "pong", cwd: ctl });
  assert.equal(readFileSync(join(wt, "src-a.txt"), "utf8"), "x");
  assert.equal(existsSync(join(repo, "escaped.txt")), false);
  assert.equal(existsSync(join(repo, ".git", "refs", "heads", "evil")), false);
  assert.equal(existsSync(join(home, "pantheon-bwrap-escape-test")), false);
  assert.match(readFileSync(ws.hooks, "utf8"), /PreToolUse/);
  assert.equal(existsSync("/tmp/scratch") && readFileSync("/tmp/scratch", "utf8") === "x", false, "/tmp inside is a fresh tmpfs");
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

/** A fake HOME with the agy 1.5.10 layout (observed on the owner's machine, 2026-11-18), the host side of the jail. */
function fakeHome(root) {
  const home = join(root, "home"), g = join(home, ".gemini"), c = join(g, "antigravity-cli");
  mkdirSync(join(c, "conversations"), { recursive: true }); mkdirSync(join(c, "plugins"), { recursive: true }); mkdirSync(join(c, "cache"));
  for (const f of ["GEMINI.md", "google_accounts.json", "installation_id", "projects.json", "state.json", "trustedFolders.json"]) writeFileSync(join(g, f), `${f}\n`);
  writeFileSync(join(g, "settings.json"), "{}");
  writeFileSync(join(g, "oauth_creds.json"), '{"refresh_token":"fake"}');
  writeFileSync(join(c, "settings.json"), '{"cli":"host"}', { mode: 0o640 });
  writeFileSync(join(c, "conversations", "old.db"), "host history");
  writeFileSync(join(c, "cache", "last_conversations.json"), "[1]");
  writeFileSync(join(c, "plugins", "p.json"), "plugin");
  symlinkSync("settings.json", join(c, "linked.json"));
  return { home, g, c };
}

test("~/.gemini (a FAKE home): read-only inside; ~/.gemini/antigravity-cli is a per-run scratch COPY (its settings.json readable from the copy, the state subdirs empty and writable, an unknown subdir read-only from the host); the host is unchanged and nothing is created under HOME", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { root, wt, ctl } = await layout(t);
  const { home, g, c } = fakeHome(root);
  const before = snapshot(home);
  const st = await geminiState({ home, run_dir: join(ctl, "run") });
  assert.equal(st.enabled, true);
  assert.equal(st.cli_dir, c);
  assert.ok(st.scratch_cli.startsWith(join(ctl, "run", "agy-state") + "/") && st.scratch_cli.endsWith("/antigravity-cli"), st.scratch_cli);
  assert.deepEqual(st.mounts, [{ dest: c, src: st.scratch_cli, mode: "rw" }, { dest: join(c, "plugins"), src: join(c, "plugins"), mode: "ro" }]);
  assert.deepEqual([st.copied, st.skipped, st.hidden_state, st.readonly_subdirs], [["settings.json"], [{ name: "linked.json", kind: "symlink" }], ["conversations", "cache"], ["plugins"]]);
  assert.equal(statSync(join(st.scratch_cli, "settings.json")).mode & 0o777, 0o640, "the copy keeps the mode");
  assert.deepEqual(readdirSync(st.scratch_cli).sort(), [...GEMINI_STATE_SUBDIRS, "plugins", "settings.json"].sort());
  assert.deepEqual(snapshot(home), before, "preparing the layout wrote nothing under HOME");
  mkdirSync(join(root, "probe"));
  const { argv, binds } = bwrapArgs({ worktree: wt, control_dir: ctl, gemini_state: st, extra_ro: [join(root, "probe"), home] });
  // Parent-first: ~/.gemini ro, then the scratch rw over antigravity-cli, then the host's unknown subdir ro over its
  // mount point inside the scratch; the main .git read-only bind last.
  const i = argv.lastIndexOf(g), j = argv.lastIndexOf(c), k = argv.lastIndexOf(join(c, "plugins"));
  assert.deepEqual([argv.slice(i - 2, i + 1), argv.slice(j - 2, j + 1), argv.slice(k - 2, k + 1)],
    [["--ro-bind", g, g], ["--bind", st.scratch_cli, c], ["--ro-bind", join(c, "plugins"), join(c, "plugins")]]);
  assert.ok(i < j && j < k);
  assert.ok(!argv.some(a => a.includes("/.gemini/antigravity/")), "the old antigravity/ layout is gone");
  assert.equal(binds.at(-1).mode, "ro");
  const probe = join(root, "probe", "gemini-probe.mjs");
  writeFileSync(probe, `
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
const [g, log] = process.argv.slice(2), c = g + "/antigravity-cli";
const out = {};
const tryIt = (k, f) => { try { out[k] = f() ?? "ok"; } catch (e) { out[k] = e.code; } };
tryIt("read_oauth", () => readFileSync(g + "/oauth_creds.json", "utf8"));
tryIt("write_settings", () => writeFileSync(g + "/settings.json", "{1}"));
tryIt("write_top", () => writeFileSync(g + "/new.json", "x"));
tryIt("read_cli_settings", () => readFileSync(c + "/settings.json", "utf8"));
tryIt("list_conv", () => readdirSync(c + "/conversations").join(","));
tryIt("write_conv", () => writeFileSync(c + "/conversations/x", "conv"));
tryIt("mkdir_brain", () => { mkdirSync(c + "/brain/id1"); writeFileSync(c + "/brain/id1/task.md", "b"); });
tryIt("write_jetbox", () => writeFileSync(c + "/jetbox_summaries_proto.pb.1.tmp", "j"));
tryIt("rewrite_cli_settings", () => writeFileSync(c + "/settings.json", '{"cli":"inside"}'));
tryIt("read_plugin", () => readFileSync(c + "/plugins/p.json", "utf8"));
tryIt("write_plugin", () => writeFileSync(c + "/plugins/x", "x"));
tryIt("log", () => writeFileSync(log, "agy log line\\n"));
console.log(JSON.stringify(out));
`);
  const r = await run([...argv, process.execPath, probe, g, join(ctl, "run", "agy.log")], { env: { ...process.env, HOME: home } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { read_oauth: '{"refresh_token":"fake"}', write_settings: "EROFS", write_top: "EROFS", read_cli_settings: '{"cli":"host"}', list_conv: "",
    write_conv: "ok", mkdir_brain: "ok", write_jetbox: "ok", rewrite_cli_settings: "ok", read_plugin: "plugin", write_plugin: "EROFS", log: "ok" },
    "inside: the CLI's state subdirs start empty (host history hidden) and are writable; the rest of ~/.gemini and the unknown subdir are read-only");
  // What the CLI wrote is listed (names and sizes), then the scratch is removed; the HOST is exactly as before.
  const listing = await dropGeminiState(st);
  assert.deepEqual(listing, { dir: c,
    top_level: [{ name: "jetbox_summaries_proto.pb.1.tmp", size: 1, copied: false, changed: true }, { name: "settings.json", size: 16, copied: true, changed: true }],
    subdirs: { brain: [{ path: "id1/task.md", size: 1 }], cache: [], conversations: [{ path: "x", size: 4 }], crashes: [], implicit: [], mcp: [], presence: [] } });
  assert.equal(existsSync(st.scratch_root), false);
  assert.deepEqual(snapshot(home), before, "the host ~/.gemini is unchanged and nothing was created under HOME");
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
