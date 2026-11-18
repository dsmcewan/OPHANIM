// The headless multi-turn unit worker (board/agy-cli.mjs runAgyWorkerTurn + agy/workspace.mjs + the jail hook),
// through the fixture's fake `agy` CLI under the REAL bwrap: the fake calls the PreToolUse hooks of the control dir's
// .agents/hooks.json before every write and command, and the stdio MCP server of .agents/mcp_config.json for a
// subagent — the channels the real CLI is documented to use. No network, no live model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgyWorkerTurn, AGY_CLEANUP } from "../src/board/agy-cli.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { startA2AShim } from "../src/pipeline/a2a-shim.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { withFakeAgy } from "./fixtures/dispatch.mjs";
import { sh } from "./fixtures/pipeline-stages.mjs";

const LANE = "gemini-4-hydrogen-medium";
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

const PROMPT = (unit, owned, verify) => [`ROLE: node-esm-library-engineer — the single implementer of work unit "${unit}" (difficulty: medium).`, "",
  "PATHS YOU OWN (the only paths you may create, change or delete):", ...owned.map(p => `- ${p}`), "Do not commit, do not move HEAD.", "",
  "GROUND TRUTH: the controller will run this command in your worktree after you finish; its exit code decides, not your report:", `  ${verify}`, "Run it yourself before you stop."].join("\n");

/** A repo, a linked worktree per unit and a control dir per unit (outside the worktree), under one temp root. */
async function fixture(t, units = ["a"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-agy-worker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), fx = join(root, "fx");
  mkdirSync(repo); mkdirSync(fx); mkdirSync(join(root, "run", "worktrees"), { recursive: true });
  await sh("printf 'base\\n' > README.md && git init -q -b main . && git -c user.name=t -c user.email=t@t.invalid add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m base", repo);
  const out = { root, repo, fx, units: {} };
  for (const u of units) {
    const wt = join(root, "run", "worktrees", u), ctl = join(root, "run", "control", u);
    await sh(`git worktree add -q -b unit-${u} ${wt}`, repo);
    mkdirSync(ctl, { recursive: true, mode: 0o700 });
    out.units[u] = { wt, ctl };
  }
  return out;
}
const sandbox = fx => ({ agy_state_dirs: [fx] });
const verifyOf = u => `test -f src/${u}/impl.mjs`;
async function prepared(f, u, extra = {}) {
  const { wt, ctl } = f.units[u];
  await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: u, owned_paths: [`src/${u}/**`], verify_cmd: verifyOf(u), ...extra });
  return { cli: process.env.PANTHEON_AGY_CLI, control_dir: ctl, worktree: wt, model: LANE, prompt: PROMPT(u, [`src/${u}/**`], verifyOf(u)), timeoutS: 60, sandbox: sandbox(f.fx) };
}

test("(a) under real bwrap the worker writes only owned files; a write outside them is denied by the PreToolUse hook BEFORE it happens", needBwrap, async t => {
  const f = await fixture(t);
  await withFakeAgy(f.fx, async agy => {
    const { wt, ctl } = f.units.a;
    agy.agyWorker(`agy_write src/a/impl.mjs 'export const a = 1;
' || exit 9
agy_write README.md 'hijacked' && echo "README written" >&2
agy_write "${ctl}/.agents/hooks.json" '{}' && echo "hooks written" >&2
agy_write "${f.repo}/.git/config" 'x' && echo "git written" >&2
agy_verify >/dev/null 2>&1 || exit 8
reply=''
`);
    const r = await runAgyWorkerTurn(await prepared(f, "a"));
    assert.equal(readFileSync(join(wt, "src/a/impl.mjs"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(wt, "README.md"), "utf8"), "base\n", "the denied write never happened");
    assert.match(readFileSync(join(ctl, ".agents/hooks.json"), "utf8"), /PreToolUse/);
    assert.equal(r.sandbox.enabled, true);
    assert.equal(r.sandbox.kind, "bwrap");
    // The jail log records every decision; the denies are there with their reasons, the approvals for the owned write and verify.
    const pre = r.jail_log.filter(l => l.event === "PreToolUse");
    const by = p => pre.filter(l => l.args.TargetFile === p).map(l => l.decision);
    assert.ok(by(join(wt, "src/a/impl.mjs")).every(d => d === "auto_approve") && by(join(wt, "src/a/impl.mjs")).length > 0);
    for (const p of [join(wt, "README.md"), join(ctl, ".agents/hooks.json"), join(f.repo, ".git/config")]) {
      assert.ok(by(p).length > 0 && by(p).every(d => d === "deny"), `${p}: ${by(p)}`);
    }
    assert.match(pre.find(l => l.args.TargetFile === join(wt, "README.md")).reason, /not one of the unit's owned paths/);
    assert.ok(pre.some(l => l.tool === "run_command" && l.decision === "auto_approve" && l.args.CommandLine === verifyOf("a")));
    assert.ok(r.jail_log.some(l => l.event === "PostToolUse" && l.args.TargetFile === join(wt, "src/a/impl.mjs")), "PostToolUse audits the write");
    // The worker's strict JSON summary is parsed when it is the whole final message.
    assert.deepEqual([r.summary.unit_id, r.summary.status, r.summary.changed_paths, r.summary.verify], ["a", "done", ["src/a/impl.mjs"], { cmd: verifyOf("a"), exit_code: 0 }]);
    assert.equal((await sh("git status --porcelain", wt)).trim(), "?? src/", "only the owned file changed");
  });
});

test("(a') a command other than verify_cmd is denied before it runs, and a write the CLI would make without asking the hook still cannot leave the jail", needBwrap, async t => {
  const f = await fixture(t);
  await withFakeAgy(f.fx, async agy => {
    const { wt } = f.units.a;
    // agy_run goes through the hook; the direct printf models a tool the hook never saw: bwrap still stops it.
    agy.agyWorker(`agy_run "touch ${wt}/src/a/ran" || echo denied >&2
printf x > "${f.repo}/escaped.txt" 2>/dev/null || true
printf x > "$HOME/pantheon-agy-escape" 2>/dev/null || true
`);
    const r = await runAgyWorkerTurn(await prepared(f, "a"));
    assert.equal(existsSync(join(wt, "src/a/ran")), false);
    assert.equal(existsSync(join(f.repo, "escaped.txt")), false);
    assert.equal(existsSync(join(process.env.HOME, "pantheon-agy-escape")), false);
    assert.match(r.jail_log.find(l => l.tool === "run_command").reason, /only the unit's verify_cmd may run/);
  });
});

test("(b) the worker reaches ask_subagent through the stdio MCP relay over the unit's Unix socket, inside bwrap (socket in the control dir and in a fallback dir)", needBwrap, async t => {
  const f = await fixture(t, ["a", "b"]);
  await withFakeAgy(f.fx, async agy => {
    agy.agyWorker(`ans=$(agy_ask math "what is six times seven?") || exit 7
mkdir -p "$dir/src/$unit"; agy_write "src/$unit/impl.mjs" "// $ans
" || exit 9
`);
    const fallback = realpathSync(mkdtempSync(join(tmpdir(), "pa2a-")));
    t.after(() => rmSync(fallback, { recursive: true, force: true }));
    const asked = [];
    for (const [u, socket] of [["a", join(f.units.a.ctl, "a2a.sock")], ["b", join(fallback, "a2a.sock")]]) {
      const shim = await startA2AShim({ unit_id: u, allowed_subagents: ["math"], socket, seatFor: () => ({ vendor: "xai", model: "grok-4.5" }),
        subagentTurn: async ({ prompt }) => { asked.push(prompt); return { text: "42", served_model: "grok-4.5" }; } });
      t.after(() => shim.close());
      const env = { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: u };
      const args = await prepared(f, u, { mcp_server: MCP_SERVER_PATH, roles: ["math"], a2a_env: env });
      const r = await runAgyWorkerTurn({ ...args, env, a2a_socket: shim.socket });
      assert.equal(r.subagent_calls, 1, u);
      assert.match(readFileSync(join(f.units[u].wt, `src/${u}/impl.mjs`), "utf8"), /"answer":"42"/);
      assert.deepEqual(shim.calls.map(c => [c.role, c.status]), [["math", "answered"]]);
      assert.ok(r.jail_log.some(l => /ask_subagent/.test(l.tool) && l.decision === "auto_approve"), "the MCP tool was approved by the hook");
      if (u === "b") assert.ok(r.sandbox.binds.some(b => b.mode === "ro" && b.path === fallback), "the fallback socket dir is bound");
    }
    assert.equal(asked.length, 2);
    const cfg = JSON.parse(readFileSync(join(f.units.a.ctl, ".agents/mcp_config.json"), "utf8"));
    assert.deepEqual(Object.keys(cfg.mcpServers), ["pantheon-subagents"]);
    assert.deepEqual([cfg.mcpServers["pantheon-subagents"].command, cfg.mcpServers["pantheon-subagents"].args], [process.execPath, [MCP_SERVER_PATH]]);
  });
});

test("(c) two worker turns run concurrently: they overlap in time and the event loop keeps ticking", needBwrap, async t => {
  const f = await fixture(t, ["a", "b"]);
  await withFakeAgy(f.fx, async agy => {
    agy.agyWorker(`sleep 0.6; agy_write "src/$unit/impl.mjs" 'export const x = 1;
' || exit 9
`);
    const spans = {};
    const ticks = []; const timer = setInterval(() => ticks.push(Date.now()), 10);
    await Promise.all(["a", "b"].map(async u => { const a = await prepared(f, u); const t0 = Date.now(); await runAgyWorkerTurn(a); spans[u] = [t0, Date.now()]; }));
    clearInterval(timer);
    assert.ok(spans.a[0] < spans.b[1] && spans.b[0] < spans.a[1], JSON.stringify(spans));
    const during = ticks.filter(x => x >= Math.min(spans.a[0], spans.b[0]) && x <= Math.max(spans.a[1], spans.b[1]));
    assert.ok(during.length >= 20, `only ${during.length} ticks: the event loop was blocked`);
    for (const u of ["a", "b"]) assert.ok(existsSync(join(f.units[u].wt, `src/${u}/impl.mjs`)));
  });
});

/** The pipeline's implementer turn (turns.mjs) on unit a, with a recording metered API. */
async function implementerTurn(f, { api = async () => ({ text: JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const via = 'api';\n" }] }), served_model: "gemini-4-hydrogen" }) } = {}) {
  const calls = [];
  const turns = pipelineTurns({ turn: async () => ({ text: "" }), agy: { sandbox: sandbox(f.fx), api: async a => { calls.push(a); return api(a); } } });
  const { wt, ctl } = f.units.a;
  const go = () => turns.implementer({ vendor: "agy_google", model: LANE, prompt: PROMPT("a", ["src/a/**"], verifyOf("a")), cwd: wt, control_dir: ctl, owned_paths: ["src/a/**"], verify_cmd: verifyOf("a"),
    unit_id: "a", env: {}, attempt: 1 });
  return { calls, go };
}

test("(d) quota: explicit 429 -> metered API, recorded with the probe; soft phrase + probe available/unknown -> lane_failure; probe exhausted -> metered; metered failing -> quota_exhausted", needBwrap, async t => {
  const f = await fixture(t);
  await withFakeAgy(f.fx, async agy => {
    // 1. explicit 429 RESOURCE_EXHAUSTED: metered, whatever the probe says.
    agy.agyQuota([LANE]); agy.agyQuotaReport("Five-hour: 10% used\nWeekly: 20% used\n");
    let x = await implementerTurn(f);
    let r = await x.go();
    assert.deepEqual([r.transport, r.served_model, x.calls.length, x.calls[0].model], ["api", "gemini-4-hydrogen", 1, "gemini-4-hydrogen"]);
    assert.equal(r.quota_failover.used, true);
    assert.deepEqual([r.quota_failover.after[0].explicit, r.quota_failover.after[0].status, r.quota_failover.probe.state], [true, 429, "available"]);
    assert.equal(agy.agyQuotaProbes(), 1, "probed once");
    assert.equal(readFileSync(join(f.units.a.wt, "src/a/impl.mjs"), "utf8"), "export const via = 'api';\n");
    rmSync(join(f.units.a.wt, "src"), { recursive: true, force: true });
    delete process.env.FAKE_AGY_QUOTA;

    // 2. a soft phrase ("weekly quota reached") and the probe says available: not a quota refusal; no metered call.
    agy.agyQuotaSoft([LANE]);
    x = await implementerTurn(f);
    let e = await x.go().then(() => null, err => err);
    assert.deepEqual([e?.code, e?.kind, x.calls.length], ["lane_failure", "exit", 0]);
    assert.equal(e.quota_probe.state, "available");
    assert.match(e.message, /not a proven quota refusal/);
    // ... and unknown (nothing recognisable) is the same.
    agy.agyQuotaReport("Refreshing...\n");
    e = await x.go().then(() => null, err => err);
    assert.deepEqual([e?.code, e?.quota_probe?.state, x.calls.length], ["lane_failure", "unknown", 0]);

    // 3. soft phrase, probe exhausted: metered.
    agy.agyQuotaReport("Weekly: 100% used (limit reached), resets in 2 days\n");
    x = await implementerTurn(f);
    r = await x.go();
    assert.deepEqual([r.transport, x.calls.length, r.quota_failover.probe.state, r.quota_failover.after[0].explicit], ["api", 1, "exhausted", false]);
    rmSync(join(f.units.a.wt, "src"), { recursive: true, force: true });

    // 4. the metered API cannot answer either: quota_exhausted.
    x = await implementerTurn(f, { api: async () => { throw Object.assign(new Error("429 from the API too"), { status: 429 }); } });
    e = await x.go().then(() => null, err => err);
    assert.deepEqual([e?.code, e?.status, x.calls.length], ["quota_exhausted", 429, 1]);
    assert.equal(e.quota_failover.probe.state, "exhausted");

    // 5. the API's files pass the same pre-mutation owned-path check before anything is written.
    x = await implementerTurn(f, { api: async () => ({ text: JSON.stringify({ files: [{ path: "src/a/ok.mjs", content: "1" }, { path: "README.md", content: "mine" }] }) }) });
    e = await x.go().then(() => null, err => err);
    assert.equal(e?.code, "API_FILES_REFUSED");
    assert.equal(existsSync(join(f.units.a.wt, "src/a/ok.mjs")), false);
    assert.equal(readFileSync(join(f.units.a.wt, "README.md"), "utf8"), "base\n");
  });
});

test("(e) failure kinds: timeout (process and print-timeout), exit, stream (no result, unparseable), spawn", needBwrap, async t => {
  const f = await fixture(t);
  await withFakeAgy(f.fx, async agy => {
    const base = await prepared(f, "a");
    const kind = async (setup, over = {}) => { setup(); const e = await runAgyWorkerTurn({ ...base, ...over }).then(() => null, err => err);
      for (const k of ["FAKE_AGY_HANG", "FAKE_AGY_PRINT_TIMEOUT", "FAKE_AGY_FAIL", "FAKE_AGY_STREAM", "FAKE_AGY_GARBLE"]) delete process.env[k]; return e; };
    const hang = await kind(() => agy.agyHang([LANE]), { timeoutS: 1, graceS: 0 });
    assert.deepEqual([hang?.code, hang?.kind], ["lane_failure", "timeout"]);
    const pt = await kind(() => agy.agyPrintTimeout([LANE]));
    assert.deepEqual([pt?.code, pt?.kind], ["lane_failure", "timeout"]);
    const ex = await kind(() => agy.agyFail([LANE]));
    assert.deepEqual([ex?.code, ex?.kind], ["lane_failure", "exit"]);
    assert.match(ex.message, /agy CLI exited 1/);
    const st = await kind(() => agy.agyStream([LANE]));
    assert.deepEqual([st?.code, st?.kind], ["lane_failure", "stream"]);
    const gb = await kind(() => agy.agyGarble([LANE]));
    assert.deepEqual([gb?.code, gb?.kind], ["lane_failure", "stream"]);
    assert.match(gb.message, /unparseable/);
    const sp = await kind(() => {}, { cli: join(f.fx, "no-such-agy") });
    assert.deepEqual([sp?.code, sp?.kind], ["lane_failure", "spawn"]);
    // A quota refusal is its own code, with the evidence.
    const q = await kind(() => agy.agyQuota([LANE]));
    delete process.env.FAKE_AGY_QUOTA;
    assert.deepEqual([q?.code, q?.status, q?.quota?.explicit], ["quota_exhausted", 429, true]);
  });
});

test("(f) argv has --mode=accept-edits and no --dangerously-skip-permissions or --sandbox; env has ANTIGRAVITY_AGY_CLEANUP=all and no Google API key", needBwrap, async t => {
  const f = await fixture(t);
  const before = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY };
  process.env.GEMINI_API_KEY = "must-not-reach-the-cli"; process.env.GOOGLE_API_KEY = "nor-this";
  t.after(() => { for (const [k, v] of [["GEMINI_API_KEY", before.g], ["GOOGLE_API_KEY", before.o]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await withFakeAgy(f.fx, async agy => {
    const r = await runAgyWorkerTurn({ ...(await prepared(f, "a")), env: { GEMINI_API_KEY: "nor-via-env" } });
    const inner = r.launch.args.slice(r.launch.args.indexOf("--") + 1);
    assert.deepEqual(inner.slice(1), ["--agent", "pantheon-unit-worker", "--model", LANE, "--mode=accept-edits", "--add-dir", f.units.a.wt, "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "60s", "--print", "<prompt>"]);
    assert.equal(r.launch.cmd, "bwrap");
    assert.equal(r.launch.cwd, f.units.a.ctl);
    assert.deepEqual(r.cleanup_env, AGY_CLEANUP);
    assert.equal(AGY_CLEANUP.documented, false);
    const [ctx] = agy.agyContext();
    assert.deepEqual([ctx.agent, ctx.mode, ctx.cleanup, ctx.google_key, ctx.dangerous, ctx.sandbox, ctx.dir], ["pantheon-unit-worker", "accept-edits", "all", false, false, false, f.units.a.wt]);
  });
});

test("(g) bwrap missing -> SANDBOX_UNAVAILABLE, unless allowUnsandboxed (then the run says it was unjailed); the pipeline turn refuses the same way", async t => {
  const f = await fixture(t);
  await withFakeAgy(f.fx, async agy => {
    const base = await prepared(f, "a");
    const e = await runAgyWorkerTurn({ ...base, sandbox: { bwrap: "/nonexistent/bwrap" } }).then(() => null, err => err);
    assert.equal(e?.code, "SANDBOX_UNAVAILABLE");
    assert.equal(agy.agy().length, 0, "the CLI was never launched");
    const off = await runAgyWorkerTurn({ ...base, sandbox: { enabled: false } }).then(() => null, err => err);
    assert.equal(off?.code, "SANDBOX_UNAVAILABLE", "disabling the sandbox is not enough");
    const r = await runAgyWorkerTurn({ ...base, sandbox: { bwrap: "/nonexistent/bwrap", allowUnsandboxed: true } });
    assert.deepEqual([r.sandbox.enabled, r.sandbox.allowUnsandboxed], [false, true]);
    assert.notEqual(r.launch.cmd, "bwrap");
    const turns = pipelineTurns({ turn: async () => ({ text: "" }), agy: { bwrap: "/nonexistent/bwrap" } });
    const pe = await turns.implementer({ vendor: "agy_google", model: LANE, prompt: base.prompt, cwd: f.units.a.wt, control_dir: f.units.a.ctl, owned_paths: ["src/a/**"], verify_cmd: verifyOf("a"), unit_id: "a" }).then(() => null, err => err);
    assert.equal(pe?.code, "SANDBOX_UNAVAILABLE");
  });
});
