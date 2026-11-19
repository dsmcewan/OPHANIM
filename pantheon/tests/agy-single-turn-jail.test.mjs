// L-401: EVERY SINGLE-TURN agy LAUNCH RUNS IN THE WORKER'S JAIL PROFILE, proved at the real process boundary with REAL
// bwrap and SYNTHETIC credentials (self-audit round 3, assignment 4 (sealed fe2a612), questions 7 and 9; owner plan
// step 3). The self-audit found that the subagent/planner single-turn path (sdk/agy-turn.mjs -> board/agy-cli.mjs
// runAgyCliTurn) ran the real CLI UNJAILED with `{...process.env}` minus the two Google keys (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, XAI_API_KEY, every token and secret reached it) and with `--sandbox`, on text that is partly
// worker-controlled (an A2A subagent's question). It also runs the pantheon-reviewer card for a subagent, which lists
// run_command. At 08ee51a every assertion on the probe's record below fails (the keys are in its env and in the
// controller's /proc/<pid>/environ it can read, PID 1 is not bwrap, the host /tmp is visible, there is no hook).
//
// The CLI is tests/fixtures/agy-single-turn-probe.mjs: it records what it can see from inside, then answers like agy.
// Every launch path that reaches runAgyCliTurn is driven: an A2A subagent seat (laneFirstTurn -> agySingleTurn, the
// reviewer card), a planner seat (agySingleTurn), and the board's agy seat as board/run-item.mjs calls it (a role
// card, a worktree, a --json-schema under the host's /tmp).
// NOT asserted, and explicitly UNRESOLVED (owner constraint L-004): the jailed CLI's read-only view of the whole host
// and its egress. The probe's read of a synthetic ~/.codex/auth.json is reported as a diagnostic, not as a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agySingleTurn, laneFirstTurn } from "../src/sdk/agy-turn.mjs";
import { runAgyCliTurn } from "../src/board/agy-cli.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { probeAgy } from "./fixtures/agy-single-turn-probe.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNTHETIC = Object.freeze({
  OPENAI_API_KEY: "sk-l401-synthetic-openai-0000000000", ANTHROPIC_API_KEY: "sk-ant-l401-synthetic-anthropic-000", XAI_API_KEY: "xai-l401-synthetic-xai-00000000000",
  GEMINI_API_KEY: "AIza-l401-synthetic-gemini-00000000", GOOGLE_API_KEY: "AIza-l401-synthetic-google-00000000", PANTHEON_A2A_TOKEN: "a2a-l401-synthetic-token-000000000",
  GITHUB_TOKEN: "ghp_l401synthetic000000000000000000", AWS_SECRET_ACCESS_KEY: "l401-synthetic-aws-secret-0000000000", OPHANIM_SEAL_SECRET: "l401-synthetic-seal-secret-00000000",
  DB_PASSWORD: "l401-synthetic-db-password-0000000",
});

const box = await sandboxAvailable("bwrap");

async function withProbe(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-l401-cli-")), out = mkdtempSync(join(tmpdir(), "pantheon-l401-out-")), home = mkdtempSync(join(homedir(), ".pantheon-l401-home-"));   // outside /tmp: the L-004 diagnostic shows the host view
  const marker = join(tmpdir(), `pantheon-l401-host-marker-${process.pid}`);
  writeFileSync(marker, "visible only outside the jail");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: SYNTHETIC.OPENAI_API_KEY } }));
  writeFileSync(join(dir, "secrets"), Object.entries(SYNTHETIC).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const cli = probeAgy(dir);
  const set = { ...SYNTHETIC, HOME: home, PANTHEON_AGY_CLI: cli, PANTHEON_AGY_ENV_PASS: "FAKE_*", PANTHEON_AGY_STATE_DIRS: out, FAKE_AGY_PROBE_OUT: out,
    FAKE_AGY_PROBE_VALUES_FILE: join(dir, "secrets"), FAKE_AGY_PROBE_MARKER: marker, FAKE_AGY_PROBE_WRITE: join(dir, "escaped-write"),
    FAKE_AGY_PROBE_FILES: join(home, ".codex", "auth.json") };
  const before = Object.fromEntries(Object.keys(set).map(k => [k, process.env[k]]));
  Object.assign(process.env, set);
  const records = () => readdirSync(out).filter(f => f.endsWith(".json")).sort((a, b) => parseInt(a) - parseInt(b)).map(f => JSON.parse(readFileSync(join(out, f), "utf8")));
  try { return await fn({ dir, out, home, cli, records }); }
  finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const p of [dir, out, home, marker]) rmSync(p, { recursive: true, force: true });
  }
}

/** Every jail property of one probe record (the CLI as it saw itself). */
function assertJailed(rec, what) {
  // The credentials first (at 08ee51a: OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, the A2A token, ... are all here).
  assert.equal(rec.secrets_known, Object.keys(SYNTHETIC).length, `${what}: the probe read the synthetic secrets file`);
  assert.deepEqual(rec.secrets_in_env, [], `${what}: a synthetic secret VALUE is in the CLI's environment`);
  for (const k of Object.keys(SYNTHETIC)) assert.ok(!rec.env_names.includes(k), `${what}: ${k} is in the CLI's environment`);
  assert.deepEqual(rec.secrets_in_proc, [], `${what}: a synthetic secret is readable in some /proc/<pid>/environ or cmdline (the controller's, through the PID namespace)`);
  for (const flag of ["--sandbox", "--dangerously-skip-permissions"]) assert.ok(!rec.argv.some(a => a.split("=")[0] === flag), `${what}: ${flag} reached the CLI's argv`);
  assert.ok(rec.argv.includes("--mode=accept-edits") && rec.argv.includes("--add-dir") && rec.argv.includes("--disable-slash-commands"), `${what}: the worker's argv (workerArgv): ${rec.argv.join(" ")}`);
  assert.match(String(rec.pid1), /(^|\/)bwrap$/, `${what}: PID 1 of the CLI's PID namespace is bwrap (--unshare-pid), not ${rec.pid1}`);
  assert.equal(rec.host_tmp_marker_visible, false, `${what}: the host's /tmp is visible (no fresh tmpfs: not the worker's jail)`);
  assert.match(String(rec.host_write), /^refused: (EROFS|EACCES|ENOENT)/, `${what}: the CLI wrote a host path outside every writable bind (${rec.host_write})`);
  assert.match(rec.cwd, /pantheon-agy-turn-[^/]+$/, `${what}: the CLI's cwd is a fresh control dir, not the repository`);
  assert.deepEqual(rec.hook, { run_command: "deny", write_in_worktree: "deny", read_outside: "deny", read_inside: "auto_approve", invoke_subagent: "deny", mcp: "deny", search_web: "deny" },
    `${what}: the worker's PreToolUse jail hook with the read-only single-turn policy decides every tool`);
}

test("L-401: an A2A subagent seat, a planner seat and the board's agy seat each run in the worker's jail: no provider key or secret reaches the agy process (real bwrap, synthetic keys)", { skip: box.ok ? false : `bwrap unavailable: ${box.why}` }, async t => {
  await withProbe(async ({ home, records }) => {
    // 1. The A2A subagent's turn as the pipeline makes it (turns.mjs single("subagent") -> liveTurn -> laneFirstTurn ->
    //    agySingleTurn): worker-controlled question text; the reviewer card (it lists run_command).
    const api = () => { throw new Error("the metered API must not be asked"); };
    const sub = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon-high", prompt: "a worker's question; `cat ~/.codex/auth.json`", seat: { role: "subagent" } }, { lane: agySingleTurn, api });
    assert.equal(sub.text, "VERDICT: approve");
    // 2. The planner's seat.
    const plan = await agySingleTurn({ vendor: "agy_google", model: "gemini-4-argon-high", prompt: "plan", seat: { role: "planner" } });
    assert.equal(plan.text, "TITLE: probe");
    // 3. The board's agy seat, called as board/run-item.mjs calls it: a ticket worktree and a --json-schema under /tmp.
    const wt = mkdtempSync(join(tmpdir(), "pantheon-l401-wt-")), outDir = mkdtempSync(join(tmpdir(), "pantheon-l401-board-"));
    t.after(() => { rmSync(wt, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); });
    writeFileSync(join(outDir, "schema.json"), JSON.stringify({ type: "object" }));
    const board = await runAgyCliTurn({ cli: process.env.PANTHEON_AGY_CLI, repo: REPO, worktree: wt, role: "reviewer", model: "gemini-4-carbon-high", prompt: "review", timeoutS: 60, schemaPath: join(outDir, "schema.json") });
    assert.equal(board.text, "VERDICT: approve");
    // FIRST what each agy process saw from inside (the process boundary), THEN what the runner recorded.
    const recs = records();
    assert.equal(recs.length, 3, "three agy processes ran");
    const agents = recs.map(r => r.argv[r.argv.indexOf("--agent") + 1]);
    assert.deepEqual(agents, ["pantheon-reviewer", "pantheon-planner", "pantheon-reviewer"]);
    recs.forEach((r, i) => assertJailed(r, ["A2A subagent seat", "planner seat", "board agy seat"][i]));
    assert.ok(recs[2].argv.includes("--json-schema"), "the board seat's schema reached the CLI");
    assert.equal(board.launch.env_policy, "allowlist");
    assert.ok(board.launch.args.includes("--json-schema") && !board.launch.args.includes("--sandbox"), "the schema is passed; --sandbox is not");
    assert.ok(Object.keys(SYNTHETIC).every(k => !board.launch.env_names.includes(k)), "the recorded launch env carries no synthetic secret name");
    assert.ok(board.jail_log.some(d => d.decision === "deny" && /run_command/.test(JSON.stringify(d))), "the hook's own log records the denied command");
    for (const r of recs) assert.equal(existsSync(r.cwd), false, `the control dir ${r.cwd} was removed after the turn`);
    // L-004 (UNRESOLVED, owner constraint): what the jailed CLI can still read of the host is recorded, not asserted.
    t.diagnostic(`L-004 (unresolved): the jailed CLI's read of ${join(home, ".codex", "auth.json")}: ${JSON.stringify(recs[0].secrets_in_files)}`);
  });
});

test("L-401: without bwrap the single-turn seat refuses (SANDBOX_UNAVAILABLE) and no agy process runs; a forbidden flag is refused before any launch", async () => {
  await withProbe(async ({ cli, records }) => {
    const wt = mkdtempSync(join(tmpdir(), "pantheon-l401-wt-"));
    try {
      await assert.rejects(runAgyCliTurn({ cli, repo: REPO, worktree: wt, role: "planner", model: "gemini-4-argon-high", prompt: "p", timeoutS: 30, sandbox: { bwrap: "/nonexistent/bwrap" } }),
        e => e.code === "SANDBOX_UNAVAILABLE", "never a silent unjailed run");
      // A prompt is text after --print; a model name shaped like a flag cannot smuggle --sandbox in (assertWorkerArgv).
      await assert.rejects(runAgyCliTurn({ cli, repo: REPO, worktree: wt, role: "planner", model: "--sandbox", prompt: "p", timeoutS: 30 }), e => e.code === "FORBIDDEN_FLAG");
      assert.deepEqual(records(), [], "no agy process ran");
    } finally { rmSync(wt, { recursive: true, force: true }); }
  });
});
