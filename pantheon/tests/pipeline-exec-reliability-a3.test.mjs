// Execution reliability of the five-stage pipeline and its single-turn adapters: regressions for the defects two
// independent reviews of assignment 3 found at commit 09d490f -- independent review, assignment 3 (xAI grok-4.7,
// 09d490f) and (OpenAI gpt-6-astra extra review, 09d490f). Each test asserts the CORRECT behaviour and failed on
// commit 106e5b3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runPipeline, unitKey } from "../src/pipeline/index.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import * as checkpoint from "../src/pipeline/checkpoint.mjs";
import { laneFirstTurn } from "../src/sdk/agy-turn.mjs";
import { digestOf } from "../src/pipeline/util.mjs";
import { tempRepo, seats, unit, scripted, sh, PLANNER } from "./fixtures/pipeline-stages.mjs";
// The metered failover is OFF by default (register L-136): the rows that exercise it opt in explicitly, with a budget.
import { optIn } from "./fixtures/billing.mjs";

const QUOTA = () => Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted" });
const DISPATCH = { unit_id: "a", cohesive: true, specialist_role: "node-esm-library-engineer", difficulty: "medium", rubric: ["file exists"], notes: "" };

// (OpenAI gpt-6-astra extra review, 09d490f), question 1: a single-turn seat on a Gemini lane (here the dispatcher)
// failed over to the metered API inside one admitted turn: two provider requests, one charge, past max_provider_calls 1.
test("single-turn metered failover: charged on its own for every seat, refused past the bound before the API is asked", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")], seat = { vendor: "agy_google", model: "gemini-4-hydrogen-medium" };
  const run = async (name, max) => {
    let sent = 0;
    // The lane admits its call where the real one does, before its spawn (L-301: the per-request contract), then is refused.
    const lane = async ({ charge }) => { charge(); sent++; throw QUOTA(); };
    const api = async ({ model }) => { sent++; return { served_model: model, text: JSON.stringify({ ...DISPATCH, cohesive: false, notes: "fixture ends at dispatch" }) }; };
    const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats({ dispatcher: () => seat }), turns: pipelineTurns({ turn: args => laneFirstTurn(args, { lane, api }), agy: { billing: optIn({ failover: 100 }) } }),
      dir: join(env.root, name), limits: { max_provider_calls: max, judge_vendor: "agy_google" }, sameModel: () => true, planner: PLANNER });
    return { out, sent };
  };
  const capped = await run("capped", 1);
  assert.equal(capped.sent, 1, "the failover past the bound was refused before the API was asked");
  assert.equal(capped.out.provider_calls.total, 1);
  const room = await run("room", 5);
  assert.equal(room.sent, room.out.provider_calls.total, "every request sent is a charged call");
  assert.equal(room.out.provider_calls.by_role.metered_failover, 1);
});

// (OpenAI gpt-6-astra extra review, 09d490f), questions 1 and 9: laneFirstTurn ignored the caller's charge and signal.
test("laneFirstTurn: the failover calls charge() before the API, a refused charge or an aborted signal stops it, and the signal reaches lane and API", async () => {
  const order = [], signals = [];
  const lane = async ({ signal }) => { signals.push(["lane", signal]); order.push("lane"); throw QUOTA(); };
  const api = async ({ signal }) => { signals.push(["api", signal]); order.push("api"); return { text: "ok", served_model: "gemini-4-hydrogen" }; };
  const ac = new AbortController();
  const args = { vendor: "agy_google", model: "gemini-4-hydrogen-medium", prompt: "p", signal: ac.signal, billing: optIn({ failover: 100 }) };
  const r = await laneFirstTurn({ ...args, charge: () => order.push("charge") }, { lane, api });
  assert.equal(r.quota_failover.used, true);
  assert.deepEqual(order, ["lane", "charge", "api"]);
  assert.ok(signals.every(([, s]) => s === ac.signal), "the signal is passed to the lane and to the API");
  order.length = 0;
  await assert.rejects(() => laneFirstTurn({ ...args, charge: () => { order.push("charge"); throw new Error("PROVIDER_CALL_LIMIT: spent"); } }, { lane, api }),
    e => e.quota_failover?.used === false && /PROVIDER_CALL_LIMIT/.test(e.quota_failover.refused));
  assert.deepEqual(order, ["lane", "charge"], "a refused charge: the API is not asked");
  order.length = 0;
  const lateLane = async () => { order.push("lane"); ac.abort(new Error("STAGE_ELAPSED")); throw QUOTA(); };
  await assert.rejects(() => laneFirstTurn({ ...args, charge: () => order.push("charge") }, { lane: lateLane, api }), e => e.quota_failover?.used === false);
  assert.deepEqual(order, ["lane"], "an aborted stage: no charge and no API request");
});

// (OpenAI gpt-6-astra extra review, 09d490f), question 7: a fabricated checkpoint -- invented review digest, rubric hash
// and reviewer, with a valid tree and a passing verify_cmd -- was resumed as approved with zero provider calls.
test("a fabricated checkpoint (shape-valid digests, a reviewer that never reviewed) is not resumed; a sealed one whose review was changed is not either", async t => {
  const env = await tempRepo({ "src/a/impl.mjs": "export const id=\"a\";\n" }); t.after(env.cleanup);
  const plan = [unit("a")], checkpoints = { dir: join(env.root, "checkpoints") };
  const go = name => runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir: join(env.root, name), run_id: name, checkpoints, planner: PLANNER });
  const base = (await sh("git rev-parse HEAD", env.repo)).trim(), tree = (await sh("git rev-parse HEAD^{tree}", env.repo)).trim();
  const forged = { unit_key: unitKey({ unit: plan[0], base_commit: base, plan }), unit_id: "a", base_commit: base, unit_base_commit: base, commit: base, tree, upstream: [],
    review_digest: "sha256:" + "0".repeat(64), rubric_hash: "sha256:" + "1".repeat(64), reviewer: { vendor: "invented", model: "never-reviewed", served_model: null },
    verify: { cmd: plan[0].verify_cmd, exit_code: 0 }, contributions: [{ kind: "work", role: "implementer", vendor: "invented", model: "never-wrote", served_model: null }] };
  // Written by someone without the controller's checkpoint key (any key but this run's).
  await checkpoint.writeCheckpoint({ dir: checkpoints.dir, patch: "", key: Buffer.alloc(32, 7), record: forged });
  const one = await go("one");
  assert.equal(one.units.a.resumed, false, `fabricated approval accepted with ${one.provider_calls.total} call(s)`);
  assert.match(one.units.a.checkpoint_rejected?.why ?? "", /seal does not verify/);
  assert.ok(one.provider_calls.total > 0, "the unit ran");
  // A genuine checkpoint, resealed by a key holder after its review was swapped for another: the approval re-derives
  // from the review it carries, so it is refused.
  assert.equal(one.units.a.status, "approved");
  const file = one.units.a.checkpoint.file, rec = JSON.parse(readFileSync(file, "utf8"));
  const key = checkpoint.checkpointKey({ dir: checkpoints.dir });
  const review = { ...rec.review, model: "gpt-0-never-seated" };
  const swapped = { ...rec, review, reviewer: { ...rec.reviewer, model: "gpt-0-never-seated" }, review_digest: digestOf(review) };
  writeFileSync(file, JSON.stringify({ ...swapped, seal: checkpoint.sealOf(swapped, key) }, null, 2));
  const two = await go("two");
  assert.equal(two.units.a.resumed, false);
  assert.match(two.units.a.checkpoint_rejected?.why ?? "", /reviewer openai\/gpt-0-never-seated is not on the unit's reviewer ladder|asked as gpt-0-never-seated and served by gpt-6-luna: this run's identity rule refuses it/);
  // The genuine checkpoint two wrote resumes.
  const three = await go("three");
  assert.deepEqual([three.units.a.resumed, three.provider_calls.total], [true, 0]);
});

// (OpenAI gpt-6-astra extra review, 09d490f), question 8; (xAI grok-4.7, 09d490f), question 8: a standalone run killed
// during its first provider call left pipeline.json with zero calls, and a restart into the same run directory failed
// on the orphaned integration worktree; a unit worktree left by SIGKILL stayed registered.
test("a run killed mid-call has the call on disk, and a restart into the same directory removes the dead run's worktrees", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const dir = join(env.root, "run");
  const url = f => pathToFileURL(join(import.meta.dirname, f)).href;
  const code = `
    import fs from "node:fs";
    import { runPipeline } from ${JSON.stringify(url("../src/pipeline/index.mjs"))};
    import { seats, unit, scripted } from ${JSON.stringify(url("./fixtures/pipeline-stages.mjs"))};
    const plan = [unit("a")];
    const s = scripted({ plan, implement: async args => { args.admitRequest({ kind: "lane" }); fs.writeFileSync(${JSON.stringify(join(dir, "call-sent"))}, args.cwd); await new Promise(() => {}); } });
    setInterval(() => {}, 1000);
    await runPipeline({ repo: ${JSON.stringify(env.repo)}, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir: ${JSON.stringify(dir)} });`;
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  const closed = new Promise(r => child.on("close", r));
  try {
    for (const end = Date.now() + 15000; !existsSync(join(dir, "call-sent"));) { if (Date.now() > end) throw new Error("the child did not reach the implementer"); await new Promise(r => setTimeout(r, 20)); }
    const unitWorktree = readFileSync(join(dir, "call-sent"), "utf8");
    child.kill("SIGKILL"); await closed;
    const killed = JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8"));
    assert.deepEqual([killed.provider_calls.total, killed.provider_calls.by_role.implementer], [2, 1], "the dispatcher's and the in-flight implementer's calls are on disk");
    assert.match(await sh("git worktree list --porcelain", env.repo), new RegExp(unitWorktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const plan = [unit("a")];
    const again = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir, planner: PLANNER });
    assert.equal(again.status, "completed", again.reason ?? again.units.a.reason);
    assert.ok(again.recovered_worktrees.includes(unitWorktree), JSON.stringify(again.recovered_worktrees));
    assert.doesNotMatch(await sh("git worktree list --porcelain", env.repo), new RegExp(join(dir, "worktrees").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

// The run directory is held by one live run: a second run into it while the first is alive is refused, not allowed to
// remove the first run's worktrees.
test("a run directory held by a live run is refused to a second run", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const dir = join(env.root, "run"), plan = [unit("a")];
  let release, entered;
  const gate = new Promise(r => { release = r; }), inside = new Promise(r => { entered = r; });
  const s = scripted({ plan, implement: async args => { entered(); await gate; await sh(`mkdir -p src/a && echo 'export const id = "a";' > src/a/impl.mjs`, args.cwd); return "done"; } });
  const first = runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir, planner: PLANNER });
  await inside;
  try {
    const second = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir, planner: PLANNER });
    assert.equal(second.status, "refused");
    assert.match(second.reason, /held by a live run/);
    assert.equal(JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8")).status, "running", "the refused run did not overwrite the live run's record");
  } finally { release(); }
  assert.equal((await first).status, "completed");
});
