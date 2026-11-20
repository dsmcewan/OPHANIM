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
// The metered failover is OFF by default (register L-136): the rows that exercise it opt in explicitly, with a budget.
import { optIn } from "./fixtures/billing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const runJson = r => JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
const quota = () => Object.assign(new Error("agy: 429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted" });
const LANE = { vendor: "agy_google", model: "gemini-4-carbon-high", transport: "agy-cli", pool: "agy_google" };
const SPARE = { vendor: "agy_google", model: "gemini-4-carbon", transport: "api", pool: "agy_google", quota_failover: { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"] },
  selection: { quota_failover: { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"], used: false } } };
const NEXT = { vendor: "openai", model: "gpt-6-astra", transport: "api", pool: "openai" };

test("the walk: the metered API is reached only after its lane was refused for QUOTA, and the result says so", async () => {
  const asked = [];
  const routed = await routeSeats({ candidates: [LANE, SPARE, NEXT], billing: optIn({ failover: 100 }), invoke: async c => { asked.push(c.model); if (c.transport === "agy-cli") throw quota(); return `answer from ${c.model}`; } });
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
    const billing = optIn({ failover: 100 });
    const first = await routeSeats({ candidates: [LANE, SPARE], invoke, cooldown, billing });
    assert.equal(first.value, "gemini-4-carbon", "the lane's refusal did not close the API pool of the same vendor name");
    assert.equal((await cooldown.get("agy_cli_oauth:gemini-4-carbon")).reason, "quota");
    assert.equal(await cooldown.get("agy_google"), null);
    // Next turn: the lane is still in its quota cooldown. It is not called again, and that recorded refusal is the evidence.
    const again = await routeSeats({ candidates: [LANE, SPARE], invoke, cooldown, billing });
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
    const r = await runOpenItem(spec("argoQuota"), opts({ billing: optIn({ failover: 100 }) }));
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

test("fit through the real dispatcher: the Google implementer is the Gemini API itself; no lane is started for it, and a quota refusal moves to the next rung of its ladder", async () => {
  // Owner direction 2026-11-19: the fit matrix's Google implementer has no Antigravity CLI lane in front of it and no
  // metered failover behind it (it IS the Gemini API), so the lane walk above is never entered for it.
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("fitHard", { difficulty: "hard" }), opts({ profile: "fit", billing: optIn({ primary: 100 }) }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const work = runJson(r).turns.find(t => t.purpose === "work");
    assert.deepEqual([work.model, work.transport, work.selection.rank, work.quota_failover, work.settings.effort], ["gemini-4-carbon", "api", 0, undefined, "high"]);
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer"), [], "no agy CLI lane was started for the implementer");
    assert.deepEqual(calls.filter(c => WORK.test(c.prompt)).map(c => [c.vendor, c.model, c.effort]), [["agy_google", "gemini-4-carbon", "high"]]);
  });
  // The pick is refused for quota. That refusal closes the Gemini API's credential pool (the cooldown is the pool's, as
  // for every API seat), and the implementer's whole ladder is on that pool: the work stage ends there. No Antigravity
  // lane and no other seat writes the work in its place.
  await withDispatch(async ({ spec, opts, calls, agy, fault }) => {
    fault(c => (c.model === "gemini-4-carbon" && WORK.test(c.prompt) ? { error: quota() } : null));
    const r = await runOpenItem(spec("fitQuota", { difficulty: "hard" }), opts({ profile: "fit", billing: optIn({ primary: 100 }) }));
    assert.equal(r.shipped, false);
    assert.deepEqual([r.error.stage, r.error.message], ["work", "All configured credential pools unavailable"]);
    assert.equal(runJson(r).turns.filter(t => t.purpose === "work").length, 0);
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer"), [], "no lane stood in for the refused API");
    assert.deepEqual(calls.filter(c => WORK.test(c.prompt)).map(c => c.model), ["gemini-4-carbon"], "the one request that was refused; nothing else was asked to write");
  });
  // An operator's explicit lane seat still runs on its lane, as its chair's only occupant.
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("fitExplicitLane", { difficulty: "medium" }), opts({ profile: "fit", billing: optIn({ primary: 100 }), seatOverrides: { implementer: seat("agy_google", "gemini-4-hydrogen-high") } }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const work = runJson(r).turns.find(t => t.purpose === "work");
    assert.deepEqual([work.model, work.transport, work.selection.source], ["gemini-4-hydrogen-high", "agy-cli", "operator-override"]);
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer").map(a => a.model), ["gemini-4-hydrogen-high"]);
    assert.ok(!calls.some(c => c.vendor === "agy_google"));
  });
});

test("fit through the real dispatcher: a seat that names the SDK transport was seated by hand and is refused before any call; no lane and no API turn stands in for it", async () => {
  // The selector never hands this board an SDK seat (it gives the matrix's model as one Gemini API turn, above). A seat
  // that still names the transport came from a caller. Running it down the lane path would start the agy CLI under the
  // name of the SDK transport, the very substitution the migration forbids.
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("fitSdkByHand", { difficulty: "hard" }), opts({ profile: "fit", billing: optIn({ primary: 100 }),
      seatOverrides: { implementer: seat("agy_google", "gemini-4-carbon", { transport: "antigravity-sdk" }) } }));
    assert.equal(r.shipped, false);
    assert.equal(r.error.stage, "work");
    assert.match(r.error.message, /seat of the Antigravity SDK transport.*the per-file board does not run it\. Nothing is run in its place/);
    assert.equal(runJson(r).turns.filter(t => t.purpose === "work").length, 0, "no work turn is on the record");
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer"), [], "no agy CLI lane was started under the SDK transport's name");
    assert.deepEqual(calls.filter(c => WORK.test(c.prompt)), [], "and no API turn wrote the work in its place");
  });
});

// ---- A LANE-PINNED TICKET UNDER FIT (owner decision 2026-11-20, register L-721) ----------------------------------------
// The default fit implementer is a primary Gemini API seat (the tests above). A ticket that explicitly pins its
// implementer to an Antigravity lane asked for the subscription lane: an exhausted lane does not move it to the primary
// seat. It keeps the lane's own authorized fallback, or is refused on the record.
const PINNED = { slot: undefined, path: undefined, slots: [{ slot: "code", path: "code.mjs", goal: "g", model: "gemini-4-carbon-high" }], difficulty: "hard" };
const workOf = r => runJson(r).turns.filter(t => t.purpose === "work").map(t => [t.model, t.transport]);
const triedLanes = agy => agy().filter(a => a.agent === "pantheon-implementer").map(a => a.model);
const googleApi = calls => calls.filter(c => c.vendor === "agy_google" && WORK.test(c.prompt)).map(c => c.model);

test("fit, a ticket pinned to an Antigravity lane: the lane answers and nothing is billed; refused for quota with NOTHING declared it moves to the next subscription lane and ships, still with nothing billed and no primary API turn", async () => {
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("pinLane", PINNED), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    assert.deepEqual([workOf(r), triedLanes(agy), googleApi(calls)], [[["gemini-4-carbon-high", "agy-cli"]], ["gemini-4-carbon-high"], []]);
    assert.equal(runJson(r).turns.find(t => t.purpose === "work").selection.source, "ticket-pin");
  });
  await withDispatch(async ({ spec, opts, calls, agy, agyQuota }) => {
    agyQuota(["gemini-4-carbon-high"]);
    const billing = optIn({});
    const r = await runOpenItem(spec("pinLaneQuota", PINNED), opts({ profile: "fit", billing }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    assert.deepEqual([workOf(r), triedLanes(agy), googleApi(calls)], [[["gemini-4-hydrogen-xhigh", "agy-cli"]], ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh"], []],
      "the next lane of the lane ladder wrote the work; the Gemini API was not asked");
    assert.deepEqual(billing.rows, [], "nothing was billed");
    const work = runJson(r).turns.find(t => t.purpose === "work");
    assert.deepEqual([work.selection.source, work.selection.lane_pin.pin], ["policy", "gemini-4-carbon-high"]);
    assert.match(work.selection.reason, /lane fallback of the ticket's pin gemini-4-carbon-high/);
    // The pinned lane's metered failover was on the walk and was not taken: the failover setting is off.
    const attempts = runJson(r).attempts.filter(a => a.purpose === "work").map(a => [a.model, a.transport, a.outcome]);
    assert.deepEqual(attempts.filter(a => a[1] === "agy-cli"), [["gemini-4-carbon-high", "agy-cli", "quota"], ["gemini-4-hydrogen-xhigh", "agy-cli", "ok"]]);
  });
});

test("fit, a ticket pinned to an Antigravity lane: with the FAILOVER declared the pinned lane's own metered API id answers as a failover; declaring PRIMARY execution does not move it to the primary seat; with every lane refused the work is refused on the record", async () => {
  // The lane's own failover, explicitly authorized: billed as kind failover, recorded as the lane's failover.
  await withDispatch(async ({ spec, opts, calls, agy, agyQuota }) => {
    agyQuota(["gemini-4-carbon-high"]);
    const billing = optIn({ failover: 10 });
    const r = await runOpenItem(spec("pinFailover", PINNED), opts({ profile: "fit", billing }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    assert.deepEqual([workOf(r), triedLanes(agy), googleApi(calls), billing.rows.map(x => x.kind)], [[["gemini-4-carbon", "api"]], ["gemini-4-carbon-high"], ["gemini-4-carbon"], ["failover"]]);
    assert.equal(runJson(r).turns.find(t => t.purpose === "work").quota_failover.used, true);
  });
  // PRIMARY declared, failover not: the authorization of the matrix's own seat is not an authorization to leave the lane.
  await withDispatch(async ({ spec, opts, calls, agy, agyQuota }) => {
    agyQuota(["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"]);
    const billing = optIn({ primary: 100 });
    const r = await runOpenItem(spec("pinPrimaryDeclared", PINNED), opts({ profile: "fit", billing }));
    assert.equal(r.shipped, false);
    assert.deepEqual([workOf(r), triedLanes(agy), googleApi(calls), billing.rows], [[], ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"], [], []],
      "every lane of the ladder was asked, none answered, and the primary Gemini API seat was not asked in their place");
    assert.equal(r.error.stage, "work");
    const attempts = runJson(r).attempts.filter(a => a.purpose === "work");
    assert.deepEqual(attempts.filter(a => a.transport === "agy-cli").map(a => [a.model, a.outcome]), [["gemini-4-carbon-high", "quota"], ["gemini-4-hydrogen-xhigh", "quota"], ["gemini-4-argon-high", "quota"]], "each refusal is on the run's record");
    assert.ok(attempts.every(a => a.transport === "agy-cli" || a.quota_failover || a.outcome !== "ok"), JSON.stringify(attempts.map(a => [a.model, a.transport, a.outcome])));
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
  const q = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-hydrogen-xhigh", prompt: "p", billing: optIn({ failover: 100 }) }, { lane: laneQuota, api });
  assert.deepEqual(asked, ["lane:gemini-4-hydrogen-xhigh", "api:agy_google/gemini-4-hydrogen"]);
  assert.deepEqual([q.text, q.transport, q.quota_failover.used, q.quota_failover.lanes, q.quota_failover.after[0].outcome], ["from api", "api", true, ["gemini-4-hydrogen-xhigh"], "quota"]);
  // Any other lane failure is thrown; the API is not asked.
  asked.length = 0;
  await assert.rejects(laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "p" }, { lane: async () => { throw new Error("agy CLI timed out after 900s"); }, api }), /timed out/);
  assert.deepEqual(asked, []);
  // The failover not declared (both billing kinds off by default, L-136): the quota refusal is thrown, marked; the API is not asked.
  asked.length = 0;
  await assert.rejects(laneFirstTurn({ vendor: "agy_google", model: "gemini-4-hydrogen-xhigh", prompt: "p" }, { lane: laneQuota, api }),
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
    const f = await laneFirstTurn({ vendor: "agy_google", model: "gemini-4-carbon", prompt: "review this", seat: { role: "cycle-reviewer" }, billing: optIn({ failover: 100 }) }, { lane: agySingleTurn, api });
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
