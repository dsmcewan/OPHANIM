// Regression tests for independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6): execution
// reliability. Each test names the finding it pins; each failed on 54572b3.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SEATING, candidatesFor } from "../src/role/seating.mjs";
import { ROLES } from "../src/role/roles.mjs";
import { seatTransport } from "../src/route/frontier.mjs";
import { laneLevels } from "../src/route/fit-matrix.mjs";
import { laneFirstTurn } from "../src/sdk/agy-turn.mjs";
import { reviewSeatsByModel } from "../src/ledger/review-cycle.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, write, sh, PLANNER, RUBRIC, approve } from "./fixtures/pipeline-stages.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { quotaEvidence } from "../src/agy/quota.mjs";

// Child mode (finding 8.1): a run with a fixed directory and run_id that hangs in its first implementer turn until killed.
if (process.argv[2] === "--r2a3-child-hang") {
  const [, , , repo, dir, marker] = process.argv;
  const plan = [unit("a")];
  const s = scripted({ plan, implement: async () => { writeFileSync(marker, String(process.pid)); await new Promise(() => {}); } });
  await runPipeline({ repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir, run_id: "fixed-run", planner: PLANNER });
  process.exit(0);
}

// ---- finding 6: metered failover off

test("finding 6: every agy_google seat of the seating table names a declared Antigravity lane (or an API id that has one)", () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6: the reviewer reseat
  // was agy_google/gemini-3.6-flash, which has no lane, so it was served by the metered Gemini API.
  const bad = [];
  for (const role of new Set([...Object.keys(SEATING), ...Object.keys(ROLES)])) {
    let cands;
    try { cands = candidatesFor(role); } catch { continue; }
    for (const c of cands) {
      if (c.vendor !== "agy_google") continue;
      if (seatTransport(c.vendor, c.model) === "agy-cli" || laneLevels(c.model).length) continue;
      bad.push(`${role}: ${c.vendor}/${c.model}`);
    }
  }
  assert.deepEqual(bad, [], "an agy_google seat with no lane can only be answered by the metered API");
  const panel = reviewSeatsByModel({ n: 3, contributions: [{ vendor: "openai", model: "gpt-6-sol", lab: "openai" }] });
  const google = panel.find(s => s.lab === "google");
  assert.ok(google, "the panel still seats Google");
  assert.equal(seatTransport(google.vendor, google.model), "agy-cli");
});

test("finding 6: with the metered failover off, a Gemini seat with no lane is refused and the metered API is never called", async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6.
  let api = 0, lane = 0;
  await assert.rejects(
    laneFirstTurn({ vendor: "agy_google", model: "gemini-3.6-flash", prompt: "q" },
      { lane: async () => { lane++; return { text: "x" }; }, api: async () => { api++; return { text: "x" }; }, failover: false }),
    e => e.code === "AGY_NO_LANE" && /metered/.test(e.message));
  assert.equal(api, 0);
  assert.equal(lane, 0);
  // Failover on: the API seat is served as before; another lab's seat is untouched by the switch.
  await laneFirstTurn({ vendor: "agy_google", model: "gemini-3.6-flash", prompt: "q" }, { lane: async () => ({}), api: async () => { api++; return { text: "x" }; }, failover: true });
  await laneFirstTurn({ vendor: "xai", model: "grok-4.7", prompt: "q" }, { lane: async () => ({}), api: async () => { api++; return { text: "x" }; }, failover: false });
  assert.equal(api, 2);
});

// ---- finding 8.1: process restart

test("finding 8.1: a run SIGKILLed mid-wave leaves its integration branch, and a restart with the same directory and run_id removes it and completes", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 8.1: the restart failed
  // on `git worktree add -b pantheon/pipeline/<run_id>` ("already exists").
  const env = await tempRepo(); t.after(env.cleanup);
  const dir = join(env.root, "same-dir"), marker = join(env.root, "started");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--r2a3-child-hang", env.repo, dir, marker], { stdio: "ignore" });
  const exited = new Promise(r => child.once("exit", r));
  for (let i = 0; i < 500 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(existsSync(marker), "the child reached its implementer turn");
  process.kill(child.pid, "SIGKILL");
  await exited;
  assert.match(await sh("git branch --list 'pantheon/pipeline/*'", env.repo), /pantheon\/pipeline\/fixed-run/);
  const plan = [unit("a")];
  const again = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir, run_id: "fixed-run", planner: PLANNER });
  assert.equal(again.status, "completed", again.reason ?? "");
  assert.equal(again.recovered_branch, "pantheon/pipeline/fixed-run");
  // A FINISHED run's branch is its result: a restart of that run_id is still refused on it.
  const third = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir, run_id: "fixed-run", planner: PLANNER });
  assert.equal(third.status, "failed");
  assert.match(third.reason ?? "", /already exists/);
});

// ---- finding 5: retries and the lane ladder

const single = async ({ model, prompt }) => prompt.startsWith("ROLE: dispatcher")
  ? { text: JSON.stringify({ unit_id: "a", cohesive: true, specialist_role: "eng", difficulty: "medium", rubric: RUBRIC, notes: "" }), served_model: model }
  : { text: JSON.stringify(approve(RUBRIC)), served_model: model };
const EASY = ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-high"].map(model => ({ vendor: "agy_google", model }));
const easySeats = () => seats({ implementer: () => ({ seat: { ...EASY[0] }, ladder: EASY.map(s => ({ ...s })) }) });

test("finding 5.1: a quota refusal steps the implementer to the next rung on ANOTHER base model, not the same model's next thinking level", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.1.
  const env = await tempRepo(); t.after(env.cleanup);
  const tried = [];
  const turns = pipelineTurns({ turn: single, agy: { meteredFailover: false, probe: async () => ({ state: "exhausted", buckets: [] }),
    run: async ({ model, worktree }) => {
      tried.push(model);
      if (model.startsWith("gemini-4-hydrogen")) throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted", quota: { matched: "RESOURCE_EXHAUSTED", explicit: true } });
      await write(worktree, "src/a/impl.mjs", "export const x = 1;\n");
      return { text: "ok" };
    } } });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: easySeats(), turns, dir: env.dir, planner: PLANNER });
  assert.equal(out.status, "completed", out.reason ?? "");
  assert.deepEqual(tried, ["gemini-4-hydrogen-medium", "gemini-3.8-flash-high"]);
  const step = out.units.a.escalations.find(e => e.kind === "lane_failover");
  assert.deepEqual(step.skipped_same_base.map(s => s.model), ["gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh"]);
});

test("finding 5.2: a 429 in free text (a stack-trace line number) is not explicit quota evidence; a 429 status is", () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.2.
  for (const stderr of ["TypeError at src/parser.mjs:429:15", "    at parse (file:///x/y.mjs:429:7)", "request id 429-abc", "read 429 bytes"]) {
    assert.notEqual(quotaEvidence({ stderr })?.explicit, true, stderr);
  }
  for (const said of [{ stderr: "HTTP 429 Too Many Requests" }, { stderr: "status: 429" }, { stderr: "error 429" }, { stderr: "429 Too Many Requests" },
    { stderr: "{\"code\": 429, \"message\": \"x\"}" }, { result: { error: { code: 429 } } }, { status: 429 }, { stderr: "RESOURCE_EXHAUSTED" }]) {
    assert.equal(quotaEvidence(said)?.explicit, true, JSON.stringify(said));
  }
});

test("finding 5.3: a metered-failover answer refused (API_FILES_REFUSED) steps the lane ladder and spends no review revision", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.3.
  const env = await tempRepo(); t.after(env.cleanup);
  const tried = [];
  const turns = pipelineTurns({ turn: single, agy: { meteredFailover: true, probe: async () => ({ state: "exhausted", buckets: [] }),
    run: async ({ model, worktree }) => {
      tried.push(model);
      if (model.startsWith("gemini-4-hydrogen")) throw Object.assign(new Error("429"), { status: 429, code: "quota_exhausted", quota: { matched: "429", explicit: true } });
      await write(worktree, "src/a/impl.mjs", "export const x = 1;\n");
      return { text: "ok" };
    },
    api: async () => ({ text: "not json prose", served_model: "gemini-4-hydrogen" }) } });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: easySeats(), turns, limits: { max_revisions: 0 }, dir: env.dir, planner: PLANNER });
  assert.equal(out.units.a.status, "approved", out.units.a.reason ?? "");
  assert.deepEqual(tried, ["gemini-4-hydrogen-medium", "gemini-3.8-flash-high"]);
  assert.equal(out.units.a.findings.filter(f => f.code === "TURN_FAILED").length, 0, "the refused failover answer is not a finding that spends a revision");
});

// ---- finding 1.1: multi-request turns

test("finding 1.1: every Google continuation hop is a charged provider call, and a hop over the bound is refused, not sent", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.1: the metered
  // failover's 3 billed continuation hops were charged as 1 call.
  const env = await tempRepo(); t.after(env.cleanup);
  let hops = 0;
  const makeClientFor = () => ({ models: { countTokens: async () => ({ totalTokens: 50 }), generateContentStream: async req => {
    hops++;
    const tok = req.config?.continuationToken ?? null, hop = tok === null ? 1 : tok === "c1" ? 2 : 3;
    const text = hop === 1 ? '{"files":[{"path":"src/a/impl.mjs",' : hop === 2 ? '"content":"export const x = 1;\\n"' : "}]}";
    return (async function* () {
      yield { modelVersion: "gemini-4-hydrogen", candidates: [{ finishReason: hop < 3 ? "CONTINUATION" : "STOP", continuationToken: hop === 1 ? "c1" : hop === 2 ? "c2" : undefined, content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
    })();
  } } });
  const turns = () => pipelineTurns({ turn: single, makeClientFor, agy: { probe: async () => ({ state: "exhausted", buckets: [] }),
    run: async () => { throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted", quota: { matched: "RESOURCE_EXHAUSTED", explicit: true } }); } } });
  const one = seats({ implementer: () => ({ seat: { ...EASY[2] }, ladder: [{ ...EASY[2] }] }) });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: one, turns: turns(), dir: join(env.root, "ok"), planner: PLANNER });
  assert.equal(out.status, "completed", JSON.stringify(out.units.a.attempts.map(a => [a.code, a.why])) + out.units.a.reason);
  assert.equal(hops, 3);
  // dispatcher + lane + metered failover + 2 further hops + reviewer
  assert.equal(out.provider_calls.total, 6);
  assert.equal(out.provider_calls.by_role.continuation, 2);
  // A bound of 3 (dispatcher, lane, failover) admits the failover's first request and refuses its second.
  hops = 0;
  const capped = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: one, turns: turns(), limits: { max_provider_calls: 3 }, dir: join(env.root, "capped"), planner: PLANNER });
  assert.equal(hops, 1, "the hop over the bound was not sent");
  assert.equal(capped.provider_calls.total, 3);
  assert.ok(capped.provider_calls.refused_at_limit >= 1);
  assert.notEqual(capped.units.a.status, "approved");
});
