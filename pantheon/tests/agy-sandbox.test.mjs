// The worker's bwrap containment (src/agy/sandbox.mjs) with the REAL bwrap and a stand-in worker command: inside, the
// worktree is writable; $HOME, the repo checkout, the control dir's hooks.json and the main .git are not; a Unix
// socket the parent created in the control dir (and one in a directory elsewhere) is reachable — the A2A path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, sandboxAvailable, repoGitDirs, geminiState, dropGeminiState, defaultAgyStateDirs } from "../src/agy/sandbox.mjs";
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

test("~/.gemini (a FAKE home): read-only inside, so the login stays readable and settings.json cannot be written; conversations/ and mcp/ are per-run scratch, writable inside, and the host dirs are unchanged; the --log-file target is writable", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  const { root, wt, ctl } = await layout(t);
  const home = join(root, "home"), g = join(home, ".gemini");
  mkdirSync(join(g, "antigravity", "conversations"), { recursive: true });   // mcp/ is missing on the host: created as an empty mount point
  mkdirSync(join(g, "config"), { recursive: true });
  writeFileSync(join(g, "oauth_creds.json"), '{"refresh_token":"fake"}');
  writeFileSync(join(g, "settings.json"), "{}");
  writeFileSync(join(g, "antigravity", "conversations", "old.pb"), "old");
  const before = { gemini: snapshot(g), conv: snapshot(join(g, "antigravity", "conversations")) };
  const st = await geminiState({ home, run_dir: join(ctl, "run") });
  assert.equal(st.enabled, true);
  assert.deepEqual(st.created_mountpoints, [join(g, "antigravity", "mcp")], "the missing mount point is created empty, and recorded");
  assert.deepEqual(st.mounts.map(m => m.dest), [join(g, "antigravity", "conversations"), join(g, "antigravity", "mcp")]);
  for (const m of st.mounts) assert.ok(m.src.startsWith(join(ctl, "run", "agy-state") + "/"), m.src);
  mkdirSync(join(root, "probe"));
  const { argv, binds } = bwrapArgs({ worktree: wt, control_dir: ctl, gemini_state: st, extra_ro: [join(root, "probe"), home] });
  // Parent-first: ~/.gemini read-only before the deeper scratch binds over it; the main .git read-only bind last.
  const at = p => binds.findIndex(b => b.path === p);
  assert.ok(at(g) >= 0 && at(g) < at(join(g, "antigravity", "conversations")) && at(g) < at(join(g, "antigravity", "mcp")));
  assert.deepEqual(binds.find(b => b.path === g), { mode: "ro", path: g });
  assert.deepEqual(binds.find(b => b.path === join(g, "antigravity", "mcp")), { mode: "rw", path: join(g, "antigravity", "mcp"), src: st.mounts[1].src });
  assert.equal(binds.at(-1).mode, "ro");
  const i = argv.indexOf(join(g, "antigravity", "mcp"));
  assert.deepEqual(argv.slice(i - 2, i + 1), ["--bind", st.mounts[1].src, join(g, "antigravity", "mcp")]);
  const probe = join(root, "probe", "gemini-probe.mjs");
  writeFileSync(probe, `
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
const [g, log] = process.argv.slice(2);
const out = {};
const tryIt = (k, f) => { try { out[k] = f() ?? "ok"; } catch (e) { out[k] = e.code; } };
tryIt("read_oauth", () => readFileSync(g + "/oauth_creds.json", "utf8"));
tryIt("write_oauth", () => writeFileSync(g + "/oauth_creds.json", "refreshed"));
tryIt("write_settings", () => writeFileSync(g + "/settings.json", "{1}"));
tryIt("mkdir_config", () => writeFileSync(g + "/config/x", "x"));
tryIt("write_conv", () => writeFileSync(g + "/antigravity/conversations/x", "conv"));
tryIt("list_conv", () => readdirSync(g + "/antigravity/conversations").join(","));
tryIt("write_mcp", () => writeFileSync(g + "/antigravity/mcp/x", "schema"));
tryIt("write_antigravity", () => writeFileSync(g + "/antigravity/other", "x"));
tryIt("log", () => appendFileSync(log, "agy log line\\n"));
console.log(JSON.stringify(out));
`);
  const r = await run([...argv, process.execPath, probe, g, join(ctl, "run", "agy.log")], { env: { ...process.env, HOME: home } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { read_oauth: '{"refresh_token":"fake"}', write_oauth: "EROFS", write_settings: "EROFS", mkdir_config: "EROFS", write_conv: "ok",
    list_conv: "x", write_mcp: "ok", write_antigravity: "EROFS", log: "ok" }, "inside: the per-run scratch starts empty; the rest of ~/.gemini is read-only");
  assert.equal(readFileSync(join(ctl, "run", "agy.log"), "utf8"), "agy log line\n");
  // What the CLI wrote is listed, then the scratch is removed; the HOST state is exactly as before.
  const listing = await dropGeminiState(st);
  assert.deepEqual(listing, { [join(g, "antigravity", "conversations")]: ["x"], [join(g, "antigravity", "mcp")]: ["x"] });
  assert.equal(existsSync(st.scratch_root), false);
  assert.deepEqual(snapshot(join(g, "antigravity", "conversations")), before.conv);
  assert.deepEqual(snapshot(join(g, "antigravity", "mcp")), {});
  assert.deepEqual(snapshot(g), before.gemini);
});

test("the ~/.gemini layout: off without a ~/.gemini, \"rw\" binds it writable (the explicit override), and no writable state dir is defaulted any more", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-gemini-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual([(await geminiState({ home: root, run_dir: root })).enabled, (await geminiState({ home: root, run_dir: root })).why], [false, `${join(root, ".gemini")} is not a directory`]);
  mkdirSync(join(root, ".gemini"));
  const rw = await geminiState({ home: root, run_dir: root, mode: "rw" });
  assert.deepEqual([rw.enabled, rw.mounts, rw.created_mountpoints], [true, [], []]);
  assert.equal(existsSync(join(root, ".gemini", "antigravity")), false, "rw creates nothing");
  assert.equal((await geminiState({ home: root, run_dir: root, mode: "off" })).enabled, false);
  assert.deepEqual(defaultAgyStateDirs({ HOME: root }), [], "~/.gemini is no longer a default writable state dir");
  assert.deepEqual(defaultAgyStateDirs({ HOME: root, PANTHEON_AGY_STATE_DIRS: `${root}:/nonexistent` }), [root]);
});

test("sandboxAvailable reports a missing bwrap instead of throwing", async () => {
  const r = await sandboxAvailable("/nonexistent/bwrap");
  assert.equal(r.ok, false);
  assert.match(r.why, /does not exist/);
});
