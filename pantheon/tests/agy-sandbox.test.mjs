// The worker's bwrap containment (src/agy/sandbox.mjs) with the REAL bwrap and a stand-in worker command: inside, the
// worktree is writable; $HOME, the repo checkout, the control dir's hooks.json and the main .git are not; a Unix
// socket the parent created in the control dir (and one in a directory elsewhere) is reachable — the A2A path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, sandboxAvailable, repoGitDirs } from "../src/agy/sandbox.mjs";
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

test("sandboxAvailable reports a missing bwrap instead of throwing", async () => {
  const r = await sandboxAvailable("/nonexistent/bwrap");
  assert.equal(r.ok, false);
  assert.match(r.why, /does not exist/);
});
