// The dispatcher's role selection, retries and terminal stops, observed at the REQUEST: what model,
// transport and pool each provider call actually carried, through runOpenItem itself (not the selector
// alone). Owner audit 2026-11-16 (docs/reviews/2026-11-16-routing-coordination): M1 initial dispatch
// bypassed task-fit selection; M2 a recorded `stop` did not stop repairs; M3 per-slot model and pool
// overrides did not reach the request; M6 the default legacy implementer (an agy lane seat) was refused
// as an API pin. Every provider here is a fake and the agy lane is a fake CLI script (fixtures/dispatch.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openBoard } from "../src/board/index.mjs";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { withDispatch, seat, WORK } from "./fixtures/dispatch.mjs";

const runJson = result => JSON.parse(readFileSync(join(result.board, "run.json"), "utf8"));
const turnsOf = (run, purpose) => run.turns.filter(t => t.purpose === purpose);
const workCalls = calls => calls.filter(c => WORK.test(c.prompt));
const POOLS = [
  { id: "openai_first", vendor: "openai", auth: "key", credential_env: "FIXTURE_OPENAI_FIRST" },
  { id: "openai_second", vendor: "openai", auth: "key", credential_env: "FIXTURE_OPENAI_SECOND" },
];
// Planner and reviewer kept on scripted API seats where a test is only about the implementer.
const SIDE = { planner: seat("anthropic", "claude-fable-5-2"), reviewer: seat("xai", "grok-4.6") };

test("M1: easy and hard tickets through the real dispatcher (banded profile) request the models their bands name", async () => {
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const easy = await runOpenItem(spec("bandEasy", { difficulty: "easy" }), opts({ profile: "legacy" }));
    assert.equal(easy.shipped, true, JSON.stringify(easy.error));
    const easyAgy = agy().length, easyCalls = calls.length;
    const hard = await runOpenItem(spec("bandHard", { difficulty: "hard" }), opts({ profile: "legacy" }));
    assert.equal(hard.shipped, true, JSON.stringify(hard.error));
    // What the providers were actually asked for.
    assert.deepEqual(agy().slice(0, easyAgy), [{ agent: "pantheon-planner", model: "claude-sonnet-4-6" }], "easy: Sonnet plans (easy band)");
    assert.deepEqual(workCalls(calls.slice(0, easyCalls)).map(c => `${c.vendor}/${c.model}`), ["openai/gpt-6-luna"], "easy: Luna implements (easy band)");
    assert.deepEqual(agy().slice(easyAgy), [{ agent: "pantheon-planner", model: "claude-opus-4-6-thinking" },
      { agent: "pantheon-implementer", model: "claude-sonnet-4-6" }], "hard: Opus plans, the Sonnet lane implements (hard bands)");
    assert.equal(workCalls(calls.slice(easyCalls)).length, 0, "hard: no API implementer call");
    // And why, on every turn: the band, the policy and its hash.
    for (const [result, band] of [[easy, "easy"], [hard, "hard"]]) {
      const run = runJson(result);
      for (const t of run.turns) {
        assert.equal(t.selection?.policy, "pantheon.selection/v1", `${t.purpose} turn records its selection policy`);
        assert.match(t.selection.policy_hash, /^sha256:[0-9a-f]{64}$/);
        assert.equal(typeof t.selection.reason, "string");
      }
      for (const purpose of ["plan", "work"]) {
        const [t] = turnsOf(run, purpose);
        assert.equal(t.selection.source, "policy");
        assert.equal(t.selection.difficulty, band);
        assert.equal(t.selection.band, band, `${purpose} on a ${band} ticket is the ${band} rung`);
      }
    }
    assert.equal(runJson(easy).turns[0].selection.policy_hash, runJson(hard).turns[0].selection.policy_hash, "one policy, two tickets");
  });
});

test("M1: the ARGO profile stays the approved static policy, recorded on every turn as a profile override with its reason", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const results = [];
    for (const difficulty of ["easy", "hard"]) {
      const before = calls.length;
      const r = await runOpenItem(spec(`argo-${difficulty}`, { difficulty }), opts());
      assert.equal(r.shipped, true, JSON.stringify(r.error));
      results.push({ r, calls: calls.slice(before) });
    }
    const asked = ({ calls }) => calls.filter(c => !/RAN: nothing/.test(c.prompt)).map(c => `${c.vendor}/${c.model}`);
    assert.deepEqual(asked(results[0]), asked(results[1]), "ARGO does not choose by difficulty, and says so");
    assert.deepEqual(asked(results[0]), ["anthropic/claude-fable-5-2", "openai/gpt-6-astra", "xai/grok-4.7"]);
    for (const [i, difficulty] of ["easy", "hard"].entries()) {
      const run = runJson(results[i].r);
      for (const t of run.turns) {
        assert.equal(t.selection.source, "profile", `${t.purpose}: the ARGO choice is a recorded override, not a ranking`);
        assert.equal(t.selection.profile, "argo");
        assert.equal(t.selection.difficulty, difficulty);
        assert.match(t.selection.reason, /ARGO November model policy/);
        assert.match(t.selection.reason, new RegExp(`difficulty "${difficulty}"`));
      }
    }
    // On the ledger turn entry too (additive), and the ledger still verifies.
    const sys = openPantheonLedger({ root: join(results[0].r.board, "ledger"), board: openBoard(results[0].r.board) });
    assert.equal(sys.recorder().verify().ok, true);
    const turns = sys.ledger.read().filter(e => e.kind === "turn").map(e => sys.ledger.payloadOf(e));
    assert.ok(turns.length >= 3);
    for (const p of turns) assert.equal(p.selection?.policy_hash, runJson(results[0].r).turns[0].selection.policy_hash);
  });
});

test("M2: a recorded stop ends that slot's repairs -- zero further generation for the default Astra implementer", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("stopAstra", { acceptance_cmd: "false" }), opts({ revisions: 8 }));
    assert.equal(r.shipped, false);
    const run = runJson(r);
    const slotStops = (run.escalations ?? []).filter(e => e.slot);
    assert.equal(workCalls(calls).length, 1, `one generation, then the recorded stop is terminal (got ${workCalls(calls).length})`);
    assert.ok(slotStops.length >= 1 && slotStops.every(e => e.decision.action === "stop"), JSON.stringify(slotStops.map(e => e.decision.action)));
    assert.equal(run.revisions.length, 1, "the combined loop ended when no slot could proceed");
    assert.ok(run.files[0].escalation.stopped, "the stop is retained for resume");
  });
});

test("M2: per slot -- a stopped slot makes no further calls while another slot proceeds; the loop ends when none can", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const slots = [{ slot: "alpha", path: "alpha.mjs", goal: "a", model: "gpt-6-astra" }, { slot: "beta", path: "beta.mjs", goal: "b", model: "gpt-6-luna" }];
    const r = await runOpenItem(spec("stopPerSlot", { slot: undefined, path: undefined, slots, acceptance_cmd: "false" }), opts({ revisions: 20 }));
    assert.equal(r.shipped, false);
    const by = file => workCalls(calls).filter(c => c.prompt.includes(`new contents of ${file}`)).map(c => `${c.model}@${c.effort ?? "default"}`);
    assert.deepEqual(by("alpha.mjs"), ["gpt-6-astra@default"], "astra stopped after its first rejection");
    // luna: effort up its documented ladder, then a rung to sol, then the step budget is spent.
    assert.deepEqual(by("beta.mjs"), ["gpt-6-luna@default", "gpt-6-luna@high", "gpt-6-luna@xhigh", "gpt-6-luna@max", "gpt-6-sol@default"]);
    const run = runJson(r);
    assert.equal(run.revisions.length, 5, "the loop ended when no slot could proceed, well inside 20 revisions");
    assert.ok(run.files.every(f => f.escalation.stopped));
  });
});

test("M3: a per-slot override's model AND pool reach the request, over the ticket's pin and the first registry pool", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("slotOverride", { slots: [{ slot: "code", path: "code.mjs", goal: "g", model: "gpt-6-luna" }], slot: undefined, path: undefined }),
      opts({ pools: POOLS, seatOverrides: { ...SIDE, "implementer.0": seat("openai", "gpt-6-sol", { pool: "openai_second", why: "slot override" }) } }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const [work] = workCalls(calls);
    assert.equal(work.model, "gpt-6-sol", "the per-slot override outranks the ticket's pin");
    assert.equal(work.pool, "openai_second");
    assert.equal(work.poolConfig?.id, "openai_second", "the pool's configuration travels with it");
    const [t] = turnsOf(runJson(r), "work");
    assert.equal(t.pool, "openai_second");
    assert.equal(t.selection.source, "slot-override");
  });
});

test("M3: precedence -- the ticket's slot pin outranks a role-wide override; a role-wide override's pool is kept exactly", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const pinned = await runOpenItem(spec("pinOverRole", { slots: [{ slot: "code", path: "code.mjs", goal: "g", model: "gpt-6-luna" }], slot: undefined, path: undefined }),
      opts({ pools: POOLS, seatOverrides: { ...SIDE, implementer: seat("openai", "gpt-6-astra", { pool: "openai_second" }) } }));
    assert.equal(pinned.shipped, true, JSON.stringify(pinned.error));
    assert.equal(workCalls(calls)[0].model, "gpt-6-luna");
    assert.equal(turnsOf(runJson(pinned), "work")[0].selection.source, "ticket-pin");
    const before = calls.length;
    const role = await runOpenItem(spec("roleOverride"), opts({ pools: POOLS, seatOverrides: { ...SIDE, implementer: seat("openai", "gpt-6-sol", { pool: "openai_second" }) } }));
    assert.equal(role.shipped, true, JSON.stringify(role.error));
    const [work] = workCalls(calls.slice(before));
    assert.deepEqual([work.model, work.pool, work.poolConfig?.id], ["gpt-6-sol", "openai_second", "openai_second"]);
    assert.equal(turnsOf(runJson(role), "work")[0].selection.source, "operator-override");
  });
});

test("M3: an explicit pool is never re-resolved -- a refused explicit pool does not fall over to the first registry pool", async () => {
  await withDispatch(async ({ spec, opts, calls, makeClientFor }) => {
    const pools = [];
    const r = await runOpenItem(spec("explicitPool"), opts({ pools: POOLS, seatOverrides: { ...SIDE, implementer: seat("openai", "gpt-6-sol", { pool: "openai_second" }) },
      makeClientFor: (vendor, o = {}) => {
        if (vendor !== "openai") return makeClientFor(vendor, o);
        pools.push(o.pool);
        return { responses: { inputTokens: { count: async () => ({ input_tokens: 10 }) }, create: async () => { throw Object.assign(new Error("quota"), { status: 429 }); } } };
      } }));
    assert.equal(r.shipped, false);
    assert.deepEqual([...new Set(pools)], ["openai_second"], "only the named pool was ever asked");
    assert.equal(calls.filter(c => c.vendor === "openai").length, 0);
  });
});

test("M3: effort repairs and a same-vendor rung step keep the pool the operator named for the slot", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("poolThroughRetries", { acceptance_cmd: "false" }),
      opts({ pools: POOLS, revisions: 8, seatOverrides: { ...SIDE, "implementer.0": seat("openai", "gpt-6-luna", { pool: "openai_second" }) } }));
    assert.equal(r.shipped, false);
    assert.deepEqual(workCalls(calls).map(c => `${c.model}@${c.effort ?? "default"}@${c.pool}`), ["gpt-6-luna@default@openai_second",
      "gpt-6-luna@high@openai_second", "gpt-6-luna@xhigh@openai_second", "gpt-6-luna@max@openai_second", "gpt-6-sol@default@openai_second"]);
    assert.equal(turnsOf(runJson(r), "work").at(-1).selection.source, "escalation");
  });
});

test("M3: resume continues the recorded seat -- model, pool and escalated effort -- rather than re-resolving it", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const ticket = spec("resumeSeat", { slots: [{ slot: "code", path: "code.mjs", goal: "g", model: "gpt-6-luna" }], slot: undefined, path: undefined, acceptance_cmd: "false" });
    const o = opts({ pools: POOLS, revisions: 1, seatOverrides: { ...SIDE, "implementer.0": seat("openai", "gpt-6-sol", { pool: "openai_second" }) } });
    const first = await runOpenItem(ticket, o);
    assert.equal(first.shipped, false);
    assert.deepEqual(workCalls(calls).map(c => `${c.model}@${c.pool}`), ["gpt-6-sol@openai_second"]);
    const before = calls.length;
    // The resumed run is given no seat overrides at all: the recorded seat is what continues.
    const again = await runOpenItem(ticket, { ...o, resume: first.board, seatOverrides: SIDE });
    assert.equal(again.shipped, false);
    const resumed = workCalls(calls.slice(before));
    assert.deepEqual(resumed.map(c => [c.model, c.pool, c.poolConfig?.id, c.effort]), [["gpt-6-sol", "openai_second", "openai_second", "high"]],
      "resume ran the recorded slot seat at the effort the review's escalation decided");
  });
});

test("M6: the unmodified legacy implementer (agy lane Sonnet) is dispatched through its lane transport, not an API pin", async () => {
  await withDispatch(async ({ spec, opts, agy, calls }) => {
    const r = await runOpenItem(spec("legacyLane", { difficulty: "hard" }), opts({ profile: "legacy" }));
    assert.equal(r.error, null, JSON.stringify(r.error));
    assert.equal(r.shipped, true);
    assert.ok(agy().some(a => a.agent === "pantheon-implementer" && a.model === "claude-sonnet-4-6"), JSON.stringify(agy()));
    assert.equal(workCalls(calls).length, 0, "no API request for a lane seat");
    const [t] = turnsOf(runJson(r), "work");
    assert.deepEqual([t.vendor, t.model, t.transport], ["agy_google", "claude-sonnet-4-6", "agy-cli"]);
  });
});

test("M2: a plain resume never regenerates a stopped slot; lifting the stop is its own recorded action", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const ticket = spec("stopResume", { acceptance_cmd: "false" });
    const o = opts({ revisions: 1 });
    const first = await runOpenItem(ticket, o);
    assert.equal(first.shipped, false);
    assert.equal(runJson(first).files[0].escalation.stopped?.action, "stop", "the review recorded stop for Astra");
    let before = calls.length;
    const plain = await runOpenItem(ticket, { ...o, resume: first.board });
    assert.equal(plain.shipped, false);
    assert.match(plain.error.message, /every slot recorded a terminal escalation stop/);
    assert.equal(calls.length, before, "zero further generation: no provider call at all");
    before = calls.length;
    const retried = await runOpenItem(ticket, { ...o, resume: first.board, retryStopped: "operator: one same-seat repair" });
    assert.equal(retried.shipped, false);
    assert.equal(workCalls(calls.slice(before)).length, 1, "the explicit retry is bounded by the resume's revision limit");
    assert.deepEqual(runJson(retried).retries.map(r => [r.slot, r.action, r.reason]), [["code", "retry_stopped", "operator: one same-seat repair"]]);
    await assert.rejects(() => runOpenItem(ticket, { ...o, retryStopped: "x" }), /applies only to a resume/);
  });
});
