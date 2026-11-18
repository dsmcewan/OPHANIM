// The pipeline's LIVE TURN ADAPTER (src/pipeline/turns.mjs) with scripted transports: the single-turn seats go
// through an injected `turn`; the implementer goes through the fixture's fake `agy` CLI as the pantheon-unit-worker
// card (a real child process, inside the REAL bwrap jail, that writes files in the unit's worktree through the
// PreToolUse jail hook and asks its subagent through the stdio MCP relay over the unit's Unix socket); the metered
// Gemini API is a scripted client. No network, no live model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { pipelineTurns, apiFilesRefusal, writeApiFiles } from "../src/pipeline/turns.mjs";
import { runAgyWorkerTurn } from "../src/board/agy-cli.mjs";
import { withFakeAgy, scriptedClients } from "./fixtures/dispatch.mjs";
import { tempRepo, seats, unit, sh, approve, RUBRIC, PLANNER } from "./fixtures/pipeline-stages.mjs";

// The scripted single-turn seats: a dispatcher that keeps the plan, a reviewer that approves a passing verify_cmd,
// and a subagent. Each call is logged as the transport saw it.
function scriptedSingle(log = []) {
  return Object.assign(async ({ vendor, model, prompt, seat, extra }) => {
    log.push({ role: seat?.role ?? null, vendor, model, extra: extra ?? null });
    if (prompt.startsWith("ROLE: dispatcher")) {
      const u = JSON.parse(/THE UNIT\n([\s\S]*?)\n(?:THE OTHER UNITS|DECIDE)/.exec(prompt)[1]);
      return { text: JSON.stringify({ unit_id: u.unit_id, cohesive: true, specialist_role: u.specialist_role, difficulty: u.difficulty, rubric: RUBRIC, notes: "" }), served_model: model };
    }
    if (prompt.startsWith("ROLE: acceptance reviewer")) return { text: JSON.stringify(/RESULT: exited 0\n/.test(prompt) ? approve(RUBRIC) : { ...approve(RUBRIC), verdict: "request_changes", findings: ["verify failed"], criteria: RUBRIC.map((criterion, i) => ({ criterion, met: i !== 0, evidence: "see output" })) }), served_model: model };
    return { text: "42", served_model: model };
  }, { log });
}
// The default worker of these tests: a slow multi-step write of the unit's implementation.
// (Written through agy_write: the fake CLI asks the PreToolUse jail hook first, as the real CLI does.)
const WORKER = 'sleep 0.4; agy_write "src/$unit/impl.mjs" "export const id = \\"$unit\\";\n" || exit 9\n';

async function fixture(t) {
  const env = await tempRepo();
  t.after(env.cleanup);
  return env;
}
const go = (env, plan, turns, limits = {}) => runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns, limits, dir: env.dir, planner: PLANNER });

test("the implementer runs as the unit worker through the agy CLI in the bwrap jail, from its control dir, with its worktree added; its subagent call goes over MCP and the unit's socket; two units' turns overlap", async t => {
  const env = await fixture(t);
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "must-not-reach-the-cli";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  await withFakeAgy(env.root, async agy => {
    // Unit b also asks its subagent one question (ask_subagent over the MCP relay) and writes the answer down.
    agy.agyWorker(WORKER + 'if [ "$unit" = b ]; then ans=$(agy_ask math "what is six times seven?") || exit 7; agy_write src/b/answer.mjs "// $ans\n" || exit 9; fi\n');
    const single = scriptedSingle(), spans = [];
    const turns = pipelineTurns({ turn: single, agy: { run: async a => { const s = { model: a.model, worktree: a.worktree, control_dir: a.control_dir, t0: Date.now(), t1: null, r: null }; spans.push(s); try { return (s.r = await runAgyWorkerTurn(a)); } finally { s.t1 = Date.now(); } } } });
    const plan = [unit("a"), unit("b", { allowed_subagents: ["math"], verify_cmd: "grep -q 42 src/b/answer.mjs && test -f src/b/impl.mjs" })];
    const ticks = []; const timer = setInterval(() => ticks.push(Date.now()), 10);
    const out = await go(env, plan, turns);
    clearInterval(timer);
    assert.equal(out.status, "completed", JSON.stringify(Object.values(out.units).map(u => [u.unit_id, u.status, u.reason])));
    // The CLI was launched once per unit, as the unit-worker card, on the lane, with the worktree as its --add-dir.
    const ctx = agy.agyContext();
    assert.deepEqual(ctx.map(c => [c.agent, c.model, c.mode, c.cleanup]).sort(), Array(2).fill(["pantheon-unit-worker", "gemini-4-hydrogen-medium", "accept-edits", "all"]));
    assert.deepEqual(ctx.map(c => c.dir).sort(), ["a", "b"].map(id => join(env.dir, "worktrees", id)));
    for (const c of ctx) assert.deepEqual([c.a2a_socket, c.a2a_token, c.google_key, c.dangerous], [true, true, false, false], "the A2A socket in the environment; no Google API key");
    for (const c of ctx) assert.deepEqual([c.sandbox, c.log_file], [false, join(env.dir, "control", c.dir.split("/").at(-1), "run", "agy.log")], "no --sandbox inside bwrap; the CLI log in the unit's writable run dir");
    // From the controller's control dir, in the jail; the hook approved each write before it happened.
    for (const s of spans) {
      assert.equal(s.control_dir, join(env.dir, "control", s.worktree.split("/").at(-1)));
      assert.equal(s.r.sandbox.kind, "bwrap");
      assert.ok(s.r.jail_log.some(l => l.event === "PreToolUse" && l.decision === "auto_approve" && /impl\.mjs$/.test(l.args.TargetFile ?? "")));
    }
    // Non-blocking: the two CLI processes overlapped, and the event loop kept ticking while they ran.
    const [a, b] = ["a", "b"].map(id => spans.find(s => s.worktree.endsWith(`/${id}`)));
    assert.ok(a.t0 < b.t1 && b.t0 < a.t1, `a [${a.t0},${a.t1}] and b [${b.t0},${b.t1}] did not overlap`);
    const during = ticks.filter(x => x >= Math.min(a.t0, b.t0) && x <= Math.max(a.t1, b.t1));
    assert.ok(during.length >= 10, `only ${during.length} timer ticks while the workers ran: the event loop was blocked`);
    // The written files were read from disk by the controller; Antigravity's output carries the required input model.
    for (const id of ["a", "b"]) {
      const at = out.units[id].attempts[0];
      assert.deepEqual([at.status, at.requested_model, at.served_model, at.served_model_source], ["written", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-medium", "input"]);
      assert.equal(at.quota_failover, undefined);
      assert.match(await sh(`git show ${out.integration.branch}:src/${id}/impl.mjs`, env.repo), new RegExp(`id = "${id}"`));
    }
    assert.match(await sh(`git show ${out.integration.branch}:src/b/answer.mjs`, env.repo), /42/);
    // The subagent answered through the injected turn, over the unit's A2A shim; the dispatcher and the reviewer too.
    assert.deepEqual(out.units.b.a2a.calls.map(c => [c.role, c.status, c.vendor]), [["math", "answered", "xai"]]);
    assert.deepEqual(single.log.map(l => l.role).sort(), ["dispatcher", "dispatcher", "reviewer", "reviewer", "subagent"]);
    for (const l of single.log.filter(x => x.role === "reviewer")) assert.deepEqual(l.extra, { reasoning: { context: "all_turns" } }, "reasoning.context is passed through to the transport");
    assert.deepEqual(out.provider_calls.by_role, { dispatcher: 2, implementer: 2, subagent: 1, reviewer: 2 });
  });
});

test("a worker write outside the unit's owned paths is denied by the jail hook BEFORE it happens; the pipeline's post-turn jail then sees nothing to discard", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyWorker(WORKER + 'agy_write README.md "hijacked\n" && exit 9\n');
    const out = await go(env, [unit("a")], pipelineTurns({ turn: scriptedSingle() }));
    assert.equal(out.status, "completed", out.units.a.reason);
    const at = out.units.a.attempts[0];
    assert.deepEqual([at.status, at.violations], ["written", []]);
    assert.deepEqual(at.changed, [{ path: "src/a/impl.mjs", state: "added" }]);
    const log = readFileSync(join(env.dir, "control", "a", "run", "jail.log"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    assert.ok(log.some(l => l.args?.TargetFile?.endsWith("/README.md") && l.decision === "deny"));
    assert.doesNotMatch(await sh(`git show ${out.integration.branch}:README.md`, env.repo), /hijacked/);
  });
});

test("a QUOTA refusal of the lane falls over to the metered API of the same base model; the adapter writes the API's files; the failover is recorded", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyQuota(["gemini-4-hydrogen-medium"]);
    agy.agyQuotaReport("Five-hour: 3% used\nWeekly: 9% used\n");
    const calls = [];
    const makeClientFor = scriptedClients(calls, () => JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const via = 'api';\n" }] }), () => null, () => null, (_v, model) => model);
    const out = await go(env, [unit("a")], pipelineTurns({ turn: scriptedSingle(), makeClientFor }));
    assert.equal(out.status, "completed", out.units.a.reason);
    assert.deepEqual(agy.agy(), [{ agent: "pantheon-unit-worker", model: "gemini-4-hydrogen-medium" }], "the lane was tried first, once");
    assert.equal(agy.agyQuotaProbes(), 1, "the quota was probed once");
    assert.deepEqual(calls.map(c => [c.vendor, c.model]), [["agy_google", "gemini-4-hydrogen"]], "then the metered API of the lane's base model");
    assert.match(calls[0].prompt, /you have NO tools and NO file access/);
    const at = out.units.a.attempts[0];
    assert.deepEqual([at.status, at.requested_model, at.served_model, at.served_model_source], ["written", "gemini-4-hydrogen-medium", "gemini-4-hydrogen", "provider"]);
    assert.equal(at.quota_failover.used, true);
    assert.deepEqual([at.quota_failover.base, at.quota_failover.lanes, at.quota_failover.after[0].outcome, at.quota_failover.after[0].status, at.quota_failover.after[0].explicit], ["gemini-4-hydrogen", ["gemini-4-hydrogen-medium"], "quota", 429, true]);
    assert.equal(typeof at.quota_failover.probe.state, "string", "the probe's reading is on the record");
    assert.deepEqual(at.changed, [{ path: "src/a/impl.mjs", state: "added" }]);
    assert.match(await sh(`git show ${out.integration.branch}:src/a/impl.mjs`, env.repo), /via = 'api'/);
    assert.deepEqual(JSON.parse(readFileSync(join(env.dir, "pipeline.json"), "utf8")).units.a.attempts[0].quota_failover, at.quota_failover, "and it is on the record on disk");
  });
});

test("the API fallback's answer must be the strict files object: prose, or a path outside the unit, is a failed attempt and nothing is written", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyQuota(["gemini-4-hydrogen-medium"]);
    for (const [answer, want] of [["Here is the file:\nexport const x = 1;", /not one JSON value/], [JSON.stringify({ files: [{ path: "README.md", content: "mine now\n" }] }), /not one of the unit's owned paths/]]) {
      const calls = [];
      const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: seats(), limits: { max_revisions: 0 }, dir: join(env.dir, String(calls.length) + answer.length), planner: PLANNER,
        turns: pipelineTurns({ turn: scriptedSingle(), makeClientFor: scriptedClients(calls, () => answer) }) });
      assert.equal(out.status, "incomplete");
      const at = out.units.a.attempts[0];
      assert.deepEqual([at.status, at.code], ["failed", "TURN_FAILED"]);
      assert.match(at.why, want);
      assert.deepEqual(at.changed, []);
      assert.equal(out.units.a.merged, false);
    }
    assert.equal((await sh("git status --porcelain", env.repo)).trim(), "");
  });
});

test("a lane failure that is NOT a quota refusal never reaches the metered API: it is thrown as lane_failure and the pipeline retries once, then steps down its ladder", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyFail(["gemini-4-hydrogen-medium"]);
    agy.agyWorker(WORKER);
    const calls = [];
    const out = await go(env, [unit("a")], pipelineTurns({ turn: scriptedSingle(), makeClientFor: scriptedClients(calls) }), { max_revisions: 0 });
    assert.equal(out.status, "completed", out.units.a.reason);
    const at = out.units.a.attempts[0];
    assert.deepEqual(at.lane_failures.map(f => [f.model, f.kind, f.cause, f.next]), [["gemini-4-hydrogen-medium", "exit", "lane", "same_lane"], ["gemini-4-hydrogen-medium", "exit", "lane", "next_rung"]]);
    assert.match(at.lane_failures[0].why, /agy CLI exited 1/);
    assert.deepEqual([at.status, at.model, at.quota_failover], ["written", "gemini-4-hydrogen-high", undefined]);
    assert.equal(calls.length, 0, "the metered Gemini API was not called");
    assert.equal(agy.agyQuotaProbes(), 0, "an ordinary failure is not probed");
    assert.deepEqual(agy.agy().map(x => x.model), ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high"]);
  });
});

test("a SOFT quota phrase with a probe that does not read exhausted is a lane failure (no metered call); a probe that reads exhausted makes it a quota refusal", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyQuotaSoft(["gemini-4-hydrogen-medium"]);
    agy.agyQuotaReport("Weekly: 40% used\n");
    const calls = [];
    let out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: seats(), limits: { max_revisions: 0 }, dir: join(env.dir, "soft-available"), planner: PLANNER,
      turns: pipelineTurns({ turn: scriptedSingle(), makeClientFor: scriptedClients(calls) }) });
    let at = out.units.a.attempts[0];
    assert.deepEqual(at.lane_failures.map(f => [f.kind, f.cause]), [["exit", "lane"], ["exit", "lane"]]);
    assert.match(at.lane_failures[0].why, /not a proven quota refusal/);
    assert.equal(calls.length, 0);
    agy.agyQuotaReport("Weekly: 100% used, limit reached\n");
    out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: seats(), limits: { max_revisions: 0 }, dir: join(env.dir, "soft-exhausted"), planner: PLANNER,
      turns: pipelineTurns({ turn: scriptedSingle(), makeClientFor: scriptedClients(calls, () => JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const via = 'api';\n" }] }), () => null, () => null, (_v, m) => m) }) });
    at = out.units.a.attempts[0];
    assert.deepEqual([at.status, at.quota_failover?.used, at.quota_failover?.probe?.state, at.quota_failover?.after?.[0]?.explicit], ["written", true, "exhausted", false]);
    assert.deepEqual(calls.map(c => c.model), ["gemini-4-hydrogen"]);
  });
});

test("the adapter refuses API files that are patterns, absolute, repeated or would be written through a symlink", async t => {
  assert.match(apiFilesRefusal({ files: [{ path: "/etc/passwd", content: "" }] }), /leading "\/"/);
  assert.match(apiFilesRefusal({ files: [{ path: "a/../../b", content: "" }] }), /\.\./);
  assert.match(apiFilesRefusal({ files: [{ path: "src/*.mjs", content: "" }] }), /pattern/);
  assert.match(apiFilesRefusal({ files: [{ path: "a", content: "" }, { path: "a", content: "" }] }), /twice/);
  assert.match(apiFilesRefusal({ files: [], note: "x" }), /unknown key/);
  assert.equal(apiFilesRefusal({ files: [{ path: "src/a/x.mjs", content: "" }] }, ["src/a/**"]), null);
  const env = await fixture(t);
  const outside = join(env.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(env.repo, "link"));
  await assert.rejects(writeApiFiles({ cwd: env.repo, files: [{ path: "ok.txt", content: "x" }, { path: "link/escaped.txt", content: "x" }] }), /outside the worktree; nothing was written/);
  assert.equal(existsSync(join(outside, "escaped.txt")), false);
  assert.equal(existsSync(join(env.repo, "ok.txt")), false, "nothing is written when any path is refused");
});
