// GEMINI GOES THROUGH ANTIGRAVITY FIRST; the metered Gemini API is only a 429/quota failover (owner direction
// 2026-11-17). Shown on the walk itself (route/quota-failover.mjs), through the real dispatcher under argo and fit,
// on a single-turn seat (sdk/agy-turn.mjs laneFirstTurn), and on the CLI transport, which must not block the process.
// Providers are scripted and the agy CLI is the fixture's fake: these show routing and recording, not a live quota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOpenItem } from "../src/board/run-item.mjs";
import { runAgyCliTurn, agyQuotaRefusal } from "../src/board/agy-cli.mjs";
import { routeSeats, cooldownKeyOf } from "../src/route/quota-failover.mjs";
import { selectSeat, antigravityFirst } from "../src/route/frontier.mjs";
import { agySingleTurn, laneFirstTurn } from "../src/sdk/agy-turn.mjs";
import { classifyFailure, openCooldownStore } from "../../packages/model-client/index.mjs";
import { withDispatch, WORK, seat } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const runJson = r => JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
const quota = () => Object.assign(new Error("agy: 429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted" });
const LANE = { vendor: "agy_google", model: "gemini-4-carbon-high", transport: "agy-cli", pool: "agy_google" };
const SPARE = { vendor: "agy_google", model: "gemini-4-carbon", transport: "api", pool: "agy_google", quota_failover: { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"] },
  selection: { quota_failover: { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"], used: false } } };
const NEXT = { vendor: "openai", model: "gpt-6-astra", transport: "api", pool: "openai" };

test("the walk: the metered API is reached only after its lane was refused for QUOTA, and the result says so", async () => {
  const asked = [];
  const routed = await routeSeats({ candidates: [LANE, SPARE, NEXT], invoke: async c => { asked.push(c.model); if (c.transport === "agy-cli") throw quota(); return `answer from ${c.model}`; } });
  assert.deepEqual(asked, ["gemini-4-carbon-high", "gemini-4-carbon"]);
  assert.equal(routed.value, "answer from gemini-4-carbon");
  assert.equal(routed.seat.quota_failover.used, true);
  assert.equal(routed.seat.selection.quota_failover.used, true, "the selection the turn records carries it");
  assert.deepEqual(routed.quota_failover.after.map(a => [a.lane, a.outcome, a.source, a.status, a.code]), [["gemini-4-carbon-high", "quota", "attempt", 429, "quota_exhausted"]]);
  assert.equal(SPARE.selection.quota_failover.used, false, "the candidate itself is not mutated");
});

test("the walk: any other lane failure never moves the turn to the metered API", async () => {
  // A transient failure (retryable, not quota): the lane is retried, then the walk passes OVER the API seat.
  const asked = [], skipped = [];
  const transient = () => Object.assign(new Error("upstream unavailable"), { status: 503, headers: { "retry-after": "0" } });
  assert.deepEqual(classifyFailure(transient()), { retryable: true, retryMs: 0, quota: false });
  const routed = await routeSeats({ candidates: [LANE, SPARE, NEXT], onSkip: s => skipped.push(s),
    invoke: async c => { asked.push(c.model); if (c.transport === "agy-cli") throw transient(); return c.model; } });
  assert.deepEqual(asked, ["gemini-4-carbon-high", "gemini-4-carbon-high", "gpt-6-astra"], "the API id of the lane's model was never asked");
  assert.equal(routed.quota_failover, null);
  assert.deepEqual(skipped.map(s => s.seat.model), ["gemini-4-carbon"]);
  assert.match(skipped[0].why, /not used: no quota refusal of that lane/);
  // With nothing after it, the turn fails rather than fall to the metered API.
  await assert.rejects(routeSeats({ candidates: [LANE, SPARE], invoke: async c => { if (c.transport === "agy-cli") throw transient(); return c.model; } }), e => e.code === "POOLS_UNAVAILABLE");
  // A non-retryable failure (an unclassified CLI error) is thrown as it is.
  const asked2 = [];
  await assert.rejects(routeSeats({ candidates: [LANE, SPARE, NEXT], invoke: async c => { asked2.push(c.model); throw new Error("agy CLI identity mismatch"); } }), /identity mismatch/);
  assert.deepEqual(asked2, ["gemini-4-carbon-high"]);
});

test("the walk: a lane's quota cooldown is its own authority, counts as quota evidence, and never closes the API pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-quota-walk-"));
  try {
    const cooldown = openCooldownStore(dir);
    assert.equal(cooldownKeyOf(LANE), "agy_cli_oauth:gemini-4-carbon");
    assert.equal(cooldownKeyOf({ ...LANE, model: "gemini-4-hydrogen-xhigh" }), "agy_cli_oauth:gemini-4-hydrogen", "per base model: two levels of one model share a quota");
    assert.equal(cooldownKeyOf(SPARE), "agy_google", "an API seat keeps its pool");
    const asked = [];
    const invoke = async c => { asked.push(c.model); if (c.transport === "agy-cli") throw quota(); return c.model; };
    const first = await routeSeats({ candidates: [LANE, SPARE], invoke, cooldown });
    assert.equal(first.value, "gemini-4-carbon", "the lane's refusal did not close the API pool of the same vendor name");
    assert.equal((await cooldown.get("agy_cli_oauth:gemini-4-carbon")).reason, "quota");
    assert.equal(await cooldown.get("agy_google"), null);
    // Next turn: the lane is still in its quota cooldown. It is not called again, and that recorded refusal is the evidence.
    const again = await routeSeats({ candidates: [LANE, SPARE], invoke, cooldown });
    assert.deepEqual(asked, ["gemini-4-carbon-high", "gemini-4-carbon", "gemini-4-carbon"]);
    assert.deepEqual(again.quota_failover.after.map(a => [a.lane, a.source]), [["gemini-4-carbon-high", "cooldown"]]);
    // Another lane of the same base model is not offered while that authority is closed; a different base model is.
    const other = await routeSeats({ candidates: [{ ...LANE, model: "gemini-4-carbon-low" }, { ...LANE, model: "gemini-4-argon-high" }], invoke: async c => c.model, cooldown });
    assert.equal(other.value, "gemini-4-argon-high");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("antigravityFirst: a metered Gemini API id in a policy order stands behind its lane; other seats are untouched", () => {
  const order = antigravityFirst([{ vendor: "anthropic", model: "claude-fable-5-2" }, { vendor: "agy_google", model: "gemini-4-carbon" }, { vendor: "agy_google", model: "gemini-4-argon", effort: "low" }, { vendor: "agy_google", model: "gemini-3.6-flash" }]);
  assert.deepEqual(order.map(c => `${c.model}${c.quota_failover ? "*" : ""}`), ["claude-fable-5-2", "gemini-4-carbon-high", "gemini-4-carbon*", "gemini-4-argon-low", "gemini-4-argon*", "gemini-3.6-flash"]);
  assert.deepEqual(order[2].quota_failover, { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"] });
  // An explicit operator seat or a ticket pin naming the API id is used as named.
  assert.deepEqual(selectSeat("reviewer", { roleOverride: seat("agy_google", "gemini-4-carbon") }).candidates.map(c => [c.model, c.transport, c.quota_failover]), [["gemini-4-carbon", "api", undefined]]);
  // A recorded escalation to a lane keeps that lane's quota failover.
  const esc = selectSeat("implementer", { profile: "fit", explicit: { seat: { vendor: "agy_google", model: "gemini-4-hydrogen-xhigh" }, source: "escalation", reason: "recorded" } });
  assert.deepEqual(esc.candidates.map(c => [c.model, c.transport, Boolean(c.quota_failover)]), [["gemini-4-hydrogen-xhigh", "agy-cli", false], ["gemini-4-hydrogen", "api", true]]);
});

test("the CLI transport raises Antigravity's quota refusal in the shape classifyFailure classifies as quota, and nothing else", () => {
  for (const said of [{ result: { status: "ERROR", error: "429 RESOURCE_EXHAUSTED: quota exceeded" } }, { stderr: "Error: You have exceeded your current quota" }, { result: { status: "RESOURCE_EXHAUSTED" } }, { stderr: "HTTP 429 Too Many Requests" }, { result: { error: { message: "rate limit reached", code: 429 } } }]) {
    const q = agyQuotaRefusal(said);
    assert.deepEqual([q?.status, q?.code], [429, "quota_exhausted"], JSON.stringify(said));
    assert.equal(classifyFailure(Object.assign(new Error("x"), q)).quota, true);
  }
  for (const said of [{ result: { status: "ERROR", error: "internal error" } }, { stderr: "print timeout" }, { result: { status: "SUCCESS" } }, {}, { stderr: "wrote 4290 bytes" }]) {
    assert.equal(agyQuotaRefusal(said), null, JSON.stringify(said));
  }
});

test("argo through the real dispatcher: the Google seat's lane answers; on a lane quota refusal the metered API answers and the turn records it", async () => {
  const anthropicDown = c => (c.vendor === "anthropic" && /TITLE:/.test(c.prompt) ? { error: Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" }) } : null);
  // 1. The lane answers: no metered Gemini API request at all.
  await withDispatch(async ({ spec, opts, calls, agy, fault }) => {
    fault(anthropicDown);
    const r = await runOpenItem(spec("argoLane"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const plan = runJson(r).turns.find(t => t.purpose === "plan");
    assert.deepEqual([plan.vendor, plan.model, plan.transport, plan.quota_failover], ["agy_google", "gemini-4-carbon-high", "agy-cli", undefined]);
    assert.deepEqual(agy(), [{ agent: "pantheon-planner", model: "gemini-4-carbon-high" }]);
    assert.ok(!calls.some(c => c.vendor === "agy_google"), "the metered Gemini API was not called");
  });
  // 2. The lane is refused for quota: the API id answers, and the turn, its attempt and its selection say why.
  await withDispatch(async ({ spec, opts, calls, agy, agyQuota, fault }) => {
    fault(anthropicDown); agyQuota(["gemini-4-carbon-high"]);
    const r = await runOpenItem(spec("argoQuota"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const plan = run.turns.find(t => t.purpose === "plan");
    assert.deepEqual([plan.vendor, plan.model, plan.transport], ["agy_google", "gemini-4-carbon", "api"]);
    assert.equal(plan.quota_failover.used, true);
    assert.deepEqual(plan.quota_failover.lanes, ["gemini-4-carbon-high"]);
    assert.deepEqual(plan.quota_failover.after.map(a => [a.lane, a.outcome, a.status, a.code]), [["gemini-4-carbon-high", "quota", 429, "quota_exhausted"]]);
    assert.equal(plan.selection.quota_failover.used, true);
    assert.match(plan.selection.quota_failover.rule, /refused for quota/);
    const attempts = run.attempts.filter(a => a.purpose === "plan").map(a => [a.model, a.transport, a.outcome, Boolean(a.quota_failover?.used)]);
    assert.deepEqual(attempts, [["claude-fable-5-2", "api", "quota", false], ["gemini-4-carbon-high", "agy-cli", "quota", false], ["gemini-4-carbon", "api", "ok", true]]);
    assert.deepEqual(agy(), [{ agent: "pantheon-planner", model: "gemini-4-carbon-high" }], "the lane was tried first, once");
    assert.equal(calls.filter(c => c.vendor === "agy_google").length, 1);
    // The lane and the API id that answered for it are one contributor identity.
    assert.equal(run.planner_vendor, "agy_google");
  });
  // 3. The lane fails for another reason: the metered API is NOT called; the turn's error is the lane's.
  await withDispatch(async ({ spec, opts, calls, agyFail, fault }) => {
    fault(anthropicDown); agyFail(["gemini-4-carbon-high"]);
    const r = await runOpenItem(spec("argoOther"), opts());
    assert.equal(r.shipped, false);
    assert.match(r.error.message, /agy CLI exited 1/);
    assert.ok(!calls.some(c => c.vendor === "agy_google"), "no silent move to the metered API");
    const run = runJson(r);
    assert.deepEqual(run.attempts.filter(a => a.purpose === "plan").map(a => [a.model, a.outcome]), [["claude-fable-5-2", "quota"], ["gemini-4-carbon-high", "error"]]);
  });
});

test("fit through the real dispatcher: the implementer walks its lane ladder; the metered API answers only when the pick's lane was refused for quota", async () => {
  // The pick is refused for quota: the NEXT LANE answers, not the API.
  await withDispatch(async ({ spec, opts, calls, agy, agyQuota }) => {
    agyQuota(["gemini-4-hydrogen-high"]);
    const r = await runOpenItem(spec("fitLadder", { difficulty: "medium" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const work = runJson(r).turns.find(t => t.purpose === "work");
    assert.deepEqual([work.model, work.transport, work.selection.rank, work.quota_failover], ["gemini-4-argon-high", "agy-cli", 1, undefined]);
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer").map(a => a.model), ["gemini-4-hydrogen-high", "gemini-4-argon-high"]);
    assert.ok(!calls.some(c => c.vendor === "agy_google"));
  });
  // Every lane of the hard ladder is refused for quota: the API id of the PICK's base model answers.
  await withDispatch(async ({ spec, opts, calls, agyQuota }) => {
    agyQuota(["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"]);
    const r = await runOpenItem(spec("fitSpare", { difficulty: "hard" }), opts({ profile: "fit", seatOverrides: { planner: seat("agy_google", "gemini-4-carbon-low") } }));
    const run = runJson(r);
    const work = run.turns.find(t => t.purpose === "work");
    assert.deepEqual([work?.model, work?.transport, work?.quota_failover?.used, work?.settings.effort], ["gemini-4-carbon", "api", true, "high"], JSON.stringify(r.error));
    assert.deepEqual(calls.filter(c => WORK.test(c.prompt)).map(c => [c.vendor, c.model, c.effort]), [["agy_google", "gemini-4-carbon", "high"]]);
  });
  // The pick fails for another reason: neither the API nor anything else writes the work.
  await withDispatch(async ({ spec, opts, calls, agyFail }) => {
    agyFail(["gemini-4-hydrogen-medium"]);
    const r = await runOpenItem(spec("fitOther", { difficulty: "easy" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, false);
    assert.match(r.error.message, /agy CLI exited 1/);
    assert.equal(calls.filter(c => WORK.test(c.prompt)).length, 0, "no silent move to the metered API");
  });
});

test("a single-turn seat: lane first; the API only as the lane's quota failover, and it says so", async () => {
  const asked = [];
  const api = async ({ vendor, model }) => { asked.push(`api:${vendor}/${model}`); return { text: "from api", response_id: "r1", served_model: model }; };
  const laneOk = async ({ vendor, model }) => { asked.push(`lane:${vendor}/${model}`); return { text: "from lane", response_id: "c1", served_model: model, served_model_source: "input" }; };
  // A Gemini API id is served by its lane (-high with no effort; the seat's effort otherwise).
  const a = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "p" }, { lane: laneOk, api });
  assert.deepEqual([a.text, a.served_model, a.transport, a.requested_model, a.quota_failover], ["from lane", "gemini-4-carbon-high", "agy-cli", "gemini-4-carbon", undefined]);
  await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-hydrogen", prompt: "p", seat: { effort: "xhigh" } }, { lane: laneOk, api });
  // Another lab's seat, and a Gemini model with no lane, are untouched.
  await laneFirstTurn({ vendor: "openai", model: "gpt-6-luna", prompt: "p" }, { lane: laneOk, api });
  assert.deepEqual(asked, ["lane:agy_google/gemini-4-carbon-high", "lane:agy_google/gemini-4-hydrogen-xhigh", "api:openai/gpt-6-luna"]);
  // Quota on the lane: the API id of the same model answers, marked.
  asked.length = 0;
  const laneQuota = async ({ model }) => { asked.push(`lane:${model}`); throw quota(); };
  const q = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-hydrogen-xhigh", prompt: "p" }, { lane: laneQuota, api });
  assert.deepEqual(asked, ["lane:gemini-4-hydrogen-xhigh", "api:agy_google/gemini-4-hydrogen"]);
  assert.deepEqual([q.text, q.transport, q.quota_failover.used, q.quota_failover.lanes, q.quota_failover.after[0].outcome], ["from api", "api", true, ["gemini-4-hydrogen-xhigh"], "quota"]);
  // Any other lane failure is thrown; the API is not asked.
  asked.length = 0;
  await assert.rejects(laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "p" }, { lane: async () => { throw new Error("agy CLI timed out after 900s"); }, api }), /timed out/);
  assert.deepEqual(asked, []);
  // failover: false (a run that allows no metered Gemini spend): the quota refusal is thrown, marked; the API is not asked.
  asked.length = 0;
  await assert.rejects(laneFirstTurn({ vendor: "agy_google", model: "gemini-4-hydrogen-xhigh", prompt: "p" }, { lane: laneQuota, api, failover: false }),
    e => e.status === 429 && e.quota_failover?.used === false && e.quota_failover.disabled === true && e.quota_failover.lanes[0] === "gemini-4-hydrogen-xhigh");
  assert.deepEqual(asked, ["lane:gemini-4-hydrogen-xhigh"]);
  // A lane whose base model has no API id has no failover, even on quota.
  await assert.rejects(laneFirstTurn({ vendor: "agy_google", model: "gemini-3.8-flash-high", prompt: "p" }, { lane: laneQuota, api }), e => e.status === 429);
  // Through the real single-turn seat and the fake CLI.
  await withDispatch(async ({ agy, agyQuota }) => {
    const r = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "review this", seat: { role: "cycle-reviewer" } }, { lane: agySingleTurn, api });
    assert.deepEqual([r.text, r.served_model, r.served_model_source], ["VERDICT: approve", "gemini-4-carbon-high", "input"]);
    assert.deepEqual(agy(), [{ agent: "pantheon-reviewer", model: "gemini-4-carbon-high" }]);
    agyQuota(["gemini-4-carbon-high"]);
    const f = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "review this", seat: { role: "cycle-reviewer" } }, { lane: agySingleTurn, api });
    assert.deepEqual([f.text, f.served_model, f.quota_failover.used], ["from api", "gemini-4-carbon", true]);
  });
});

test("the agy path is non-blocking: no synchronous child process on it, and two lane turns overlap in time", async () => {
  // 1. No spawnSync / execFileSync / execSync in any module on the Antigravity path.
  for (const file of ["src/board/agy-cli.mjs", "src/board/spawn.mjs", "src/sdk/agy-turn.mjs", "src/sdk/live.mjs", "src/route/quota-failover.mjs", "src/route/fit-matrix.mjs"]) {
    assert.doesNotMatch(readFileSync(join(HERE, "..", file), "utf8"), /\b(spawnSync|execFileSync|execSync)\b/, `${file} uses a synchronous child process`);
  }
  const runItem = readFileSync(join(HERE, "..", "src/board/run-item.mjs"), "utf8");
  const agyTurn = runItem.slice(runItem.indexOf("async function agyTurn("), runItem.indexOf("async function turn("));
  assert.ok(agyTurn.length > 1000, "the agyTurn body was found");
  assert.doesNotMatch(agyTurn, /\b(spawnSync|execFileSync|execSync)\b/);
  assert.match(readFileSync(join(HERE, "..", "src/board/spawn.mjs"), "utf8"), /import \{ spawn \} from 'node:child_process'/);
  // 2. Two concurrent turns through a slow fake CLI overlap, and the event loop keeps turning while they run.
  const dir = mkdtempSync(join(tmpdir(), "pantheon-agy-async-"));
  const sd = process.env.PANTHEON_AGY_STATE_DIRS;
  try {
    const cli = join(dir, "slow-agy");
    writeFileSync(cli, `#!/bin/sh
agent="none"; model="none"
for a in "$@"; do case "$prev" in --agent) agent="$a" ;; --model) model="$a" ;; esac; prev="$a"; done
date +%s%N > "${dir}/start-$model"
sleep 0.6
date +%s%N > "${dir}/end-$model"
printf '{"event":"init","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
printf '{"event":"result","result":{"status":"SUCCESS","conversation_id":"c","num_turns":1,"response":"export const ok = true;"}}\\n'
`, { mode: 0o755 });
    const worktree = join(dir, "wt"); mkdirSync(worktree);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    // Wave 1 (agent 4): every agy launch is jailed, so the fake may write only to a declared state dir; it writes its
    // timestamps into its own dir.
    process.env.PANTHEON_AGY_STATE_DIRS = dir;
    const turn = model => runAgyCliTurn({ cli, repo: join(HERE, ".."), worktree, role: "implementer", model, prompt: "p", timeoutS: 30 });
    const [a, b] = await Promise.all([turn("gemini-4-hydrogen-medium"), turn("gemini-4-hydrogen-high")]);
    const elapsed = Date.now() - t0;
    clearInterval(timer);
    assert.equal(a.text, "export const ok = true;"); assert.equal(b.text, "export const ok = true;");
    const at = name => Number(BigInt(readFileSync(join(dir, name), "utf8").trim()) / 1000000n);
    const [s1, e1, s2, e2] = [at("start-gemini-4-hydrogen-medium"), at("end-gemini-4-hydrogen-medium"), at("start-gemini-4-hydrogen-high"), at("end-gemini-4-hydrogen-high")];
    assert.ok(s1 < e2 && s2 < e1, `the two turns overlapped in time (${s1}-${e1} and ${s2}-${e2})`);
    assert.ok(elapsed < 1100, `two 0.6s turns took ${elapsed}ms: they ran concurrently, not one after the other`);
    assert.ok(ticks >= 10, `the event loop turned ${ticks} times while the CLI ran: the process was not blocked`);
    assert.equal(readdirSync(dir).filter(f => f.startsWith("start-")).length, 2);
  } finally { if (sd === undefined) delete process.env.PANTHEON_AGY_STATE_DIRS; else process.env.PANTHEON_AGY_STATE_DIRS = sd; rmSync(dir, { recursive: true, force: true }); }
});
