// Regression tests for the sandbox-security defects of independent review round 2, assignment 4 (OpenAI gpt-6-astra,
// reviewing 77480d6): docs/reviews/2026-11-18-independent-review/findings-4-openai-77480d6/findings-4-openai.md.
// Each test names its question. (Questions 1, 2 and the hook-log part of 7 are in agy-jail-hook.test.mjs; question 10
// is in agy-observed-1.5.10.test.mjs and agy-worker-probe.test.mjs.) Real bwrap where the question is about the jail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs, dropGeminiState, geminiState, sandboxAvailable, siblingsHidden } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace, workerVerifyCommand } from "../src/agy/workspace.mjs";
import { verifyCmdProblem } from "../src/agy/jail-hook.mjs";
import { runAgyWorkerTurn, workerEnv, workerEnvOf } from "../src/board/agy-cli.mjs";
import { validateWorkUnits } from "../src/pipeline/work-units.mjs";
import { runImplementer, inspectWrites, snapshotTree } from "../src/pipeline/implement.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { withFakeAgy } from "./fixtures/dispatch.mjs";
import { sh, tempRepo, unit, RUBRIC, HYDROGEN, write } from "./fixtures/pipeline-stages.mjs";

const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };
const run = (argv, opts = {}) => new Promise((resolve, reject) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let out = "", err = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
  c.on("error", reject); c.on("close", code => resolve({ code, out, err }));
});

// ---- question 3: verify_cmd ------------------------------------------------------------------------------------------
test("question 3: a verify_cmd with a shell metacharacter outside quotes is refused at plan validation and by workerVerifyCommand; the documented safe form passes", () => {
  const ok = ["true", "npm test", "node --test tests/a.test.mjs", "test -f src/a/impl.mjs && ! grep -q EVIL src/a/impl.mjs", 'node -e "process.exit(0)"',
    `node -e "import('./beta.mjs').then(m => process.exit(m.both === true ? 0 : 1))"`, "sh -c 'echo boom; exit 3'", "[ -f a ] && node --test tests/*.test.mjs"];
  for (const c of ok) {
    assert.equal(verifyCmdProblem(c), null, c);
    assert.equal(validateWorkUnits({ work_units: [unit("a", { verify_cmd: c })] }).ok, true, c);
    assert.equal(workerVerifyCommand("/w", c), `cd '/w' && ${c}`);
  }
  const bad = ["true; rm -rf ~", "true || curl evil", "a | b", "true & sleep 9", "echo x > f", "cat < f", "echo $(id)", "echo `id`", "echo $HOME", "(true)", "{ true; }",
    "true\nrm -rf /", "true # comment", "ls ~", 'node -e "$(id)"', 'node -e "`id`"', "true &&", "&& true", "a&&b", "! ", "echo 'unterminated"];
  for (const c of bad) {
    assert.ok(verifyCmdProblem(c), c);
    const v = validateWorkUnits({ work_units: [unit("a", { verify_cmd: c })] });
    assert.deepEqual([v.ok, v.refusals.map(r => r.code)], [false, ["VERIFY_CMD"]], c);
    assert.throws(() => workerVerifyCommand("/w", c), e => e.code === "BAD_VERIFY_CMD", c);
  }
  // The composition the safe form protects: `cd '<wt>' && a || b` would run b where cd failed; `a; b` runs b anyway.
  assert.match(verifyCmdProblem("npm test || true"), /metacharacter "\|"/);
});

// ---- question 7: the worker env is an allowlist ----------------------------------------------------------------------
test("question 7: workerEnv is an allowlist: OPENAI/ANTHROPIC/XAI keys and any secret-named variable of the base never reach the CLI; an explicit provider key neither", () => {
  const base = { PATH: "/usr/bin", HOME: "/h", LANG: "C.UTF-8", TERM: "xterm", TMPDIR: "/t", LC_ALL: "C", AGY_FOO: "1", ANTIGRAVITY_BAR: "2",
    OPENAI_API_KEY: "sk-openai-dummy-000000", ANTHROPIC_API_KEY: "sk-ant-dummy-000000", XAI_API_KEY: "xai-dummy-000000", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g",
    GITHUB_TOKEN: "ghp_dummy", AWS_SECRET_ACCESS_KEY: "s", DATABASE_URL: "postgres://u:p@h/db", RANDOM_THING: "x", AGY_SESSION_TOKEN: "t-dummy-0000000",
    FAKE_AGY_X: "f", PANTHEON_AGY_ENV_PASS: "FAKE_AGY_*,EXTRA_ONE" , EXTRA_ONE: "e" };
  const { env, dropped } = workerEnvOf({ PANTHEON_A2A_TOKEN: "a2a-unit-token-0000", PANTHEON_A2A_SOCKET: "/s", PANTHEON_UNIT_ID: "a", OPENAI_API_KEY: "sk-explicit-dummy-0000" }, base);
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "RANDOM_THING", "AGY_SESSION_TOKEN"]) {
    assert.equal(env[k], undefined, k);
    assert.ok(dropped.includes(k), k);
  }
  assert.deepEqual([env.PATH, env.HOME, env.LANG, env.TERM, env.TMPDIR, env.LC_ALL, env.AGY_FOO, env.ANTIGRAVITY_BAR, env.FAKE_AGY_X, env.EXTRA_ONE], ["/usr/bin", "/h", "C.UTF-8", "xterm", "/t", "C", "1", "2", "f", "e"]);
  // The unit's non-secret A2A env is the caller's explicit choice and passes; its TOKEN never does (credential
  // isolation, owner direction 2026-11-19: the relay reads it from its token file).
  assert.deepEqual([env.PANTHEON_A2A_SOCKET, env.PANTHEON_UNIT_ID, env.PANTHEON_A2A_TOKEN, env.ANTIGRAVITY_AGY_CLEANUP, env.AGY_CLI_DISABLE_AUTO_UPDATE], ["/s", "a", undefined, "all", "true"]);
  assert.ok(dropped.includes("PANTHEON_A2A_TOKEN"));
  assert.ok(!JSON.stringify(env).includes("a2a-unit-token"), "no A2A token value in the env");
  assert.ok(!JSON.stringify(env).includes("dummy"), "no provider credential value in the env");
  // The default base is process.env, filtered the same way.
  process.env.OPENAI_API_KEY_R2A4_PROBE = "sk-should-not-pass";
  try { assert.equal(workerEnv().OPENAI_API_KEY_R2A4_PROBE, undefined); } finally { delete process.env.OPENAI_API_KEY_R2A4_PROBE; }
});

// ---- question 7: scratch made after argument validation; removal errors surfaced -------------------------------------
async function jailFixture(t, { under = tmpdir(), units = ["a"] } = {}) {
  const root = realpathSync(mkdtempSync(join(under, "pantheon-r2a4-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), home = join(root, "home"), fx = join(root, "fx");
  mkdirSync(repo); mkdirSync(fx); mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true }); mkdirSync(join(root, "run", "worktrees"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "fake-oauth-token");
  await sh("printf 'base\\n' > README.md && git init -q -b main . && git -c user.name=t -c user.email=t@t.invalid add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m base", repo);
  const out = { root, repo, home, fx, units: {} };
  for (const u of units) {
    const wt = join(root, "run", "worktrees", u), ctl = join(root, "run", "control", u);
    await sh(`git worktree add -q -b unit-${u} ${wt}`, repo);
    mkdirSync(ctl, { recursive: true, mode: 0o700 });
    out.units[u] = { wt, ctl };
  }
  return out;
}
const scratchDirs = ctl => { try { return readdirSync(join(ctl, "run", "agy-state")); } catch { return []; } };

test("question 7: a refused worker argument creates no scratch copy of the OAuth token (validation first), and a failed spawn drops it", needBwrap, async t => {
  const f = await jailFixture(t);
  const { wt, ctl } = f.units.a;
  await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**"], verify_cmd: "true" });
  const base = { cli: "/bin/true", control_dir: ctl, worktree: wt, model: "gemini-3.8-flash-low", prompt: "p", timeoutS: 5, sandbox: { home: f.home, agy_state_dirs: [] }, env: { HOME: f.home } };
  await assert.rejects(runAgyWorkerTurn({ ...base, conversation: "bad id; rm -rf" }), e => e.code === "BAD_INPUT");
  assert.deepEqual(scratchDirs(ctl), [], "nothing was created before the argument was refused");
  await assert.rejects(runAgyWorkerTurn({ ...base, agent: "not-a-pantheon-card" }), e => e.code === "BAD_INPUT" || e.code === "NO_WORKSPACE");
  assert.deepEqual(scratchDirs(ctl), []);
  // A run that fails after the jail was built (the CLI exits without a result) still removes the scratch.
  await assert.rejects(runAgyWorkerTurn(base), e => e.code === "lane_failure");
  assert.deepEqual(scratchDirs(ctl), [], "the scratch (with its OAuth token copy) was removed on the failure path");
});

test("question 7: a scratch that cannot be removed is SURFACED (removed: false, removal_error), not swallowed", async t => {
  const f = await jailFixture(t);
  const st = await geminiState({ home: f.home, run_dir: join(f.units.a.ctl, "run") });
  t.after(() => rmSync(st.scratch_root, { recursive: true, force: true }));
  const ok = await dropGeminiState({ ...st }, { keep: true });
  assert.equal(ok.removed, false, "kept: not removed");
  const listing = await dropGeminiState(st);
  assert.deepEqual([listing.removed, listing.removal_error ?? null], [true, null]);
  // A failing removal (a test running as root cannot make rm fail with permissions; a busy mount is not available to a
  // test either): the remover is injected. A removal that "succeeds" but leaves the root, and one that throws, are both
  // reported; on 8e6d5e0 every removal error was swallowed by .catch(() => {}).
  const st2 = await geminiState({ home: f.home, run_dir: join(f.units.a.ctl, "run") });
  t.after(() => rmSync(st2.scratch_root, { recursive: true, force: true }));
  const l2 = await dropGeminiState(st2, { remove: async () => {} });
  assert.equal(l2.removed, false);
  assert.match(l2.removal_error.code, /STILL_PRESENT/);
  assert.equal(l2.removal_error.contains_credentials, true);
  const l3 = await dropGeminiState({ ...st2 }, { remove: async () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); } });
  assert.deepEqual([l3.removed, l3.removal_error.code], [false, "EBUSY"]);
});

// ---- question 7: the records are redacted ----------------------------------------------------------------------------
test("question 7: the A2A token echoed by the worker is redacted from stderr_tail, tool_steps, jail_log, the text and the JSON summary", needBwrap, async t => {
  const f = await jailFixture(t);
  const { wt, ctl } = f.units.a;
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef";
  await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**"], verify_cmd: "true", roles: ["math"], mcp_server: MCP_SERVER_PATH,
    a2a_env: { PANTHEON_A2A_SOCKET: join(ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "a" } });
  await withFakeAgy(f.fx, async agy => {
    agy.agyWorker(`tok=$(node -e 'process.stdout.write(require("fs").readFileSync(JSON.parse(require("fs").readFileSync(".agents/mcp_config.json","utf8")).mcpServers["pantheon-subagents"].env.PANTHEON_A2A_TOKEN_FILE,"utf8").trim())')
echo "leaked $tok" >&2
mkdir -p "$dir/src/a"; agy_write "src/a/$tok.txt" "x" || true
reply="{\\"unit_id\\":\\"a\\",\\"status\\":\\"done\\",\\"notes\\":\\"$tok\\"}"
`);
    const r = await runAgyWorkerTurn({ cli: process.env.PANTHEON_AGY_CLI, control_dir: ctl, worktree: wt, model: "gemini-4-hydrogen-medium", prompt: "PATHS YOU OWN\n- src/a/**\nDo not commit", timeoutS: 60,
      env: { PANTHEON_A2A_TOKEN: token }, sandbox: { agy_state_dirs: [f.fx] } });
    assert.ok(existsSync(join(wt, "src", "a", `${token}.txt`)), "the worker really used the token (the fake, a credential-bearing agy, read it from the token file its MCP config names)");
    for (const [k, v] of Object.entries({ stderr_tail: r.stderr_tail, tool_steps: r.tool_steps, jail_log: r.jail_log, text: r.text, summary: r.summary, launch: r.launch, cli_log: r.cli_log })) {
      assert.ok(!JSON.stringify(v ?? null).includes(token), `${k} carries the A2A token`);
    }
    assert.equal(r.summary.notes, "<redacted>");
    assert.match(r.stderr_tail, /leaked/);
    assert.ok(!readFileSync(join(ctl, "run", "jail.log"), "utf8").includes(token), "the hook log on disk too");
  });
});

// ---- question 5: the PID namespace -----------------------------------------------------------------------------------
test("question 5: inside the jail /proc lists only the jail's processes (--unshare-pid), not the host's", needBwrap, async t => {
  const f = await jailFixture(t);
  const { wt, ctl } = f.units.a;
  await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "a", owned_paths: ["src/a/**"], verify_cmd: "true" });
  const { argv } = bwrapArgs({ worktree: wt, control_dir: ctl });
  assert.ok(argv.includes("--unshare-pid") && argv.includes("--new-session") && argv.includes("--die-with-parent"));
  assert.ok(!argv.includes("--unshare-net"), "the network stays shared by design (the CLI must reach Google)");
  const r = await run([...argv, "sh", "-c", `ls /proc | grep -c '^[0-9][0-9]*$'; test -e /proc/${process.pid} && echo host-visible || echo host-hidden`]);
  assert.equal(r.code, 0, r.err);
  const [count, host] = r.out.trim().split("\n");
  assert.equal(host, "host-hidden", "the controller's own pid is not visible");
  assert.ok(Number(count) < 10, `only the jail's few processes are listed (${count})`);
});

// ---- question 8: other units' control dirs ---------------------------------------------------------------------------
// Under /tmp the jail already sees a fresh tmpfs, so the leak needs control dirs OUTSIDE /tmp (as on the reviewer's run,
// whose TMPDIR was elsewhere): /var/tmp here.
const varTmp = (() => { try { const d = mkdtempSync("/var/tmp/pantheon-r2a4-probe-"); rmSync(d, { recursive: true }); return true; } catch { return false; } })();
test("question 8: another unit's control dir (its MCP config with the bearer token, its socket) is hidden inside this unit's jail", { skip: !have.ok ? `bwrap unavailable: ${have.why}` : !varTmp ? "/var/tmp is not writable" : false }, async t => {
  const f = await jailFixture(t, { under: "/var/tmp", units: ["a", "b"] });
  for (const u of ["a", "b"]) {
    await prepareWorkerWorkspace({ control_dir: f.units[u].ctl, worktree: f.units[u].wt, unit_id: u, owned_paths: [`src/${u}/**`], verify_cmd: "true", roles: ["math"], mcp_server: MCP_SERVER_PATH,
      a2a_env: { PANTHEON_A2A_SOCKET: join(f.units[u].ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: `token-of-unit-${u}-0123456789`, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: u } });
  }
  const { argv, hidden, binds } = bwrapArgs({ worktree: f.units.a.wt, control_dir: f.units.a.ctl });
  assert.deepEqual([hidden.mode, hidden.paths], ["parent", [join(f.root, "run", "control")]]);
  assert.ok(binds.some(b => b.mode === "tmpfs" && b.path === join(f.root, "run", "control")));
  const other = join(f.units.b.ctl, "a2a.token"), mine = join(f.units.a.ctl, ".agents", "hooks.json");
  const r = await run([...argv, "sh", "-c", `cat '${other}' 2>/dev/null && echo OTHER-READ; ls '${join(f.root, "run", "control")}'; cat '${mine}' >/dev/null && echo MINE-READ; ls '${f.units.a.wt}' >/dev/null && echo WT-OK`]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /OTHER-READ|token-of-unit-b/, "unit b's MCP config (and token) is not readable from unit a's jail");
  assert.deepEqual(r.out.trim().split("\n"), ["a", "MINE-READ", "WT-OK"], "only this unit's control dir is there; it and the worktree still work");
  // On 8e6d5e0 the host bind exposed it (the same command, without the hiding).
  assert.ok(readFileSync(other, "utf8").includes("token-of-unit-b"), "the file exists on the host");
});

test("question 8: when the control dir's parent is not dedicated, the EXISTING sibling control dirs are hidden one by one (and the limit is recorded); under /tmp the jail's own tmpfs hides them", { skip: varTmp ? false : "/var/tmp is not writable" }, t => {
  const base = realpathSync(mkdtempSync("/var/tmp/pantheon-r2a4-sib-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "a")); mkdirSync(join(base, "b", ".agents"), { recursive: true }); mkdirSync(join(base, "plain")); mkdirSync(join(base, "wt"));
  writeFileSync(join(base, "b", "jail.json"), "{}"); writeFileSync(join(base, "notes.txt"), "x");
  const h = siblingsHidden(join(base, "a"), [join(base, "wt")]);
  assert.deepEqual([h.mode, h.paths], ["siblings", [join(base, "b")]], "only the control-dir-looking sibling; never the worktree or a plain dir");
  assert.match(h.why, /one created later would stay visible/);
  assert.deepEqual(siblingsHidden(join(base, "b"), [join(base, "a", "x")]).paths, [], "a sibling holding a needed path is never hidden");
  const t2 = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-r2a4-sib-")));
  t.after(() => rmSync(t2, { recursive: true, force: true }));
  if (t2.startsWith("/tmp/")) assert.equal(siblingsHidden(join(t2, "a"), []).mode, "none");
});

// ---- question 6: the post-turn audit sees what git status misses ----------------------------------------------------
async function implementerFixture(t, files = { "README.md": "base\n", "lib/util.mjs": "export const u = 1;\n", "bin/tool.sh": "#!/bin/sh\n" }) {
  const env = await tempRepo(files);
  t.after(() => env.cleanup());
  const wt = join(env.root, "wt");
  await sh(`git worktree add -q -b unit-a ${wt}`, env.repo);
  return { ...env, wt };
}
const implement = (wt, turn) => runImplementer({ unit: unit("a"), worktree: wt, seat: HYDROGEN[0], turn, rubric: RUBRIC });

test("question 6: a mode-only change of an unowned file (0644 -> 0600, no executable bit) is a write-jail violation and is discarded", async t => {
  const f = await implementerFixture(t);
  chmodSync(join(f.wt, "lib", "util.mjs"), 0o644);
  await sh("git add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m mode --allow-empty", f.wt);
  const rec = await implement(f.wt, async ({ cwd }) => { await write(cwd, "src/a/impl.mjs", "export const ok = 1;\n"); chmodSync(join(cwd, "lib", "util.mjs"), 0o600); return { text: "done" }; });
  assert.equal((await sh("git status --porcelain", f.wt)).trim(), "", "git itself sees no change");
  assert.deepEqual([rec.status, rec.code], ["refused", "WRITE_JAIL"]);
  assert.ok(rec.violations.some(v => v.path === "lib/util.mjs" && v.code === "OUTSIDE_OWNED" && /filesystem snapshot/.test(v.why)), JSON.stringify(rec.violations));
});

test("question 6: a write restored to the original bytes, a hard link to an unowned file, a chmod'ed unowned directory and a touched .git pointer are all violations", async t => {
  for (const [name, act, path, code] of [
    ["restored", cwd => { const p = join(cwd, "lib", "util.mjs"), b = readFileSync(p); writeFileSync(p, "evil\n"); writeFileSync(p, b); }, "lib/util.mjs", "OUTSIDE_OWNED"],
    ["hardlink", cwd => { mkdirSync(join(cwd, "src", "a"), { recursive: true }); linkSync(join(cwd, "README.md"), join(cwd, "src", "a", "alias")); }, "README.md", "OUTSIDE_OWNED"],
    ["dirmode", cwd => chmodSync(join(cwd, "lib"), 0o700), "lib", "OUTSIDE_OWNED"],
    ["gitpointer", cwd => { const p = join(cwd, ".git"); writeFileSync(p, readFileSync(p, "utf8")); }, ".git", "GIT_POINTER_CHANGED"],
    ["emptydir", cwd => mkdirSync(join(cwd, "zzz")), "zzz", "OUTSIDE_OWNED"],
  ]) {
    const f = await implementerFixture(t);
    const rec = await implement(f.wt, async ({ cwd }) => { await write(cwd, "src/a/impl.mjs", "export const ok = 1;\n"); act(cwd); return { text: "done" }; });
    assert.deepEqual([rec.status, rec.code], ["refused", "WRITE_JAIL"], `${name}: ${JSON.stringify(rec.violations)}`);
    assert.ok(rec.violations.some(v => v.path === path && v.code === code), `${name}: ${JSON.stringify(rec.violations)}`);
  }
});

test("question 6: owned writes (new files, new owned directories, an owned file rewritten) still pass the snapshot audit", async t => {
  const f = await implementerFixture(t, { "README.md": "base\n", "src/a/old.mjs": "export const o = 1;\n" });
  const rec = await implement(f.wt, async ({ cwd }) => {
    await write(cwd, "src/a/impl.mjs", "export const ok = 1;\n"); await write(cwd, "src/a/deep/x.mjs", "x\n"); mkdirSync(join(cwd, "src", "a", "empty"));
    writeFileSync(join(cwd, "src", "a", "old.mjs"), "export const o = 2;\n"); chmodSync(join(cwd, "src", "a", "old.mjs"), 0o600);
    return { text: "done" };
  });
  assert.deepEqual([rec.status, rec.violations], ["written", []]);
  // The snapshot holds the .git pointer file and nothing inside a .git directory; owned files carry a content hash.
  const snap = await snapshotTree(f.wt, { hashIf: p => p.startsWith("src/a/") });
  assert.equal(snap[".git"].type, "file");
  assert.ok(!Object.keys(snap).some(p => p.startsWith(".git/")));
  assert.match(snap["src/a/old.mjs"].hash, /^sha256:/);
  assert.equal(snap["README.md"].hash, undefined);
  // inspectWrites without a snapshot keeps its old (git-only) behaviour for other callers.
  assert.equal((await inspectWrites({ worktree: f.wt, owned_paths: ["src/a/**"], checkpoint: rec.checkpoint })).ok, true);
});
