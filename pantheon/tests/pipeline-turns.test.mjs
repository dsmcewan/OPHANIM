// The pipeline's LIVE TURN ADAPTER (src/pipeline/turns.mjs) with scripted transports: the single-turn seats go
// through an injected `turn`; the implementer goes through the fixture's fake `agy` CLI (a real child process that
// writes files in the unit's worktree); the metered Gemini API is a scripted client. No network, no live model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { pipelineTurns, apiFilesRefusal, writeApiFiles } from "../src/pipeline/turns.mjs";
import { runAgyCliTurn } from "../src/board/agy-cli.mjs";
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
const WORKER = 'sleep 0.4; mkdir -p "$dir/src/$unit"; printf \'export const id = "%s";\\n\' "$unit" > "$dir/src/$unit/impl.mjs"\n';

async function fixture(t) {
  const env = await tempRepo();
  t.after(env.cleanup);
  return env;
}
const go = (env, plan, turns, limits = {}) => runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns, limits, dir: env.dir, planner: PLANNER });

test("the implementer runs through the agy CLI in its unit's worktree with the A2A endpoint in its environment; two units' turns overlap; the other seats go through the injected turn", async t => {
  const env = await fixture(t);
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "must-not-reach-the-cli";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  await withFakeAgy(env.root, async agy => {
    // Unit b also asks its subagent one question over A2A, from inside the CLI process, and writes the answer down.
    agy.agyWorker(WORKER + 'if [ "$unit" = b ]; then node -e \'fetch(process.env.PANTHEON_A2A_URL,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.PANTHEON_A2A_TOKEN},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{role:"user",parts:[{kind:"text",text:"what is six times seven?"}],metadata:{subagent_role:"math",unit_id:"b"}}}})}).then(r=>r.json()).then(j=>require("fs").writeFileSync(process.argv[1],"// "+j.result.parts[0].data.answer+"\\n"))\' "$dir/src/b/answer.mjs"; fi\n');
    const single = scriptedSingle(), spans = [];
    const turns = pipelineTurns({ turn: single, agy: { run: async a => { const s = { model: a.model, worktree: a.worktree, t0: Date.now(), t1: null }; spans.push(s); try { return await runAgyCliTurn(a); } finally { s.t1 = Date.now(); } } } });
    const plan = [unit("a"), unit("b", { allowed_subagents: ["math"], verify_cmd: "grep -q 42 src/b/answer.mjs && test -f src/b/impl.mjs" })];
    const ticks = []; const timer = setInterval(() => ticks.push(Date.now()), 10);
    const out = await go(env, plan, turns);
    clearInterval(timer);
    assert.equal(out.status, "completed", JSON.stringify(Object.values(out.units).map(u => [u.unit_id, u.status, u.reason])));
    // The CLI was launched once per unit, as the implementer role card, on the lane, with the worktree as its --add-dir.
    const ctx = agy.agyContext();
    assert.deepEqual(ctx.map(c => [c.agent, c.model]).sort(), Array(2).fill(["pantheon-implementer", "gemini-4-hydrogen-medium"]));
    assert.deepEqual(ctx.map(c => c.dir).sort(), ["a", "b"].map(id => join(env.dir, "worktrees", id)));
    for (const c of ctx) assert.deepEqual([c.a2a_url, c.a2a_token, c.google_key], [true, true, false], "A2A in the environment; no Google API key");
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

test("a QUOTA refusal of the lane falls over to the metered API of the same base model; the adapter writes the API's files; the failover is recorded", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyQuota(["gemini-4-hydrogen-medium"]);
    const calls = [];
    const makeClientFor = scriptedClients(calls, () => JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const via = 'api';\n" }] }), () => null, () => null, (_v, model) => model);
    const out = await go(env, [unit("a")], pipelineTurns({ turn: scriptedSingle(), makeClientFor }));
    assert.equal(out.status, "completed", out.units.a.reason);
    assert.deepEqual(agy.agy(), [{ agent: "pantheon-implementer", model: "gemini-4-hydrogen-medium" }], "the lane was tried first, once");
    assert.deepEqual(calls.map(c => [c.vendor, c.model]), [["agy_google", "gemini-4-hydrogen"]], "then the metered API of the lane's base model");
    assert.match(calls[0].prompt, /you have NO tools and NO file access/);
    const at = out.units.a.attempts[0];
    assert.deepEqual([at.status, at.requested_model, at.served_model, at.served_model_source], ["written", "gemini-4-hydrogen-medium", "gemini-4-hydrogen", "provider"]);
    assert.equal(at.quota_failover.used, true);
    assert.deepEqual([at.quota_failover.base, at.quota_failover.lanes, at.quota_failover.after[0].outcome, at.quota_failover.after[0].status], ["gemini-4-hydrogen", ["gemini-4-hydrogen-medium"], "quota", 429]);
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

test("a lane failure that is NOT a quota refusal never reaches the metered API", async t => {
  const env = await fixture(t);
  await withFakeAgy(env.root, async agy => {
    agy.agyFail(["gemini-4-hydrogen-medium"]);
    const calls = [];
    const out = await go(env, [unit("a")], pipelineTurns({ turn: scriptedSingle(), makeClientFor: scriptedClients(calls) }), { max_revisions: 0 });
    assert.equal(out.status, "incomplete");
    const at = out.units.a.attempts[0];
    assert.deepEqual([at.status, at.code, at.quota_failover], ["failed", "TURN_FAILED", undefined]);
    assert.match(at.why, /agy CLI exited 1/);
    assert.equal(calls.length, 0, "the metered Gemini API was not called");
    assert.equal(agy.agy().length, 1);
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
