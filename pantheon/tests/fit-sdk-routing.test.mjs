// GOOGLE IMPLEMENTER ROUTING ON THE ANTIGRAVITY SDK TRANSPORT (owner direction 2026-11-19):
//   hard gemini-4-carbon, medium gemini-4-neon, easy gemini-4-hydrogen; an implementer's subagents are gemini-4-hydrogen.
// The assignments are Google IMPLEMENTATION routing only: every other role's seat is asserted unchanged, by exact id.
// Each assertion names the defect it would catch: a wrong model in a cell, an implementer left on an agy CLI lane, a
// Gemini id quietly re-routed to a lane ("Antigravity first") or given a metered-API failover, a model swapped without
// a record, a config model the identity policy or the class table does not know.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIT_MATRIX, FIT_MATRIX_BODY, IMPLEMENTER_LADDERS, fitMatrix, fitLadder, implementerPath, laneParts, quotaFailoverFor, sdkRoutingRefusal } from "../src/route/fit-matrix.mjs";
import { selectSeat, selectionPolicy, antigravityFirst, seatTransport, CLASSES } from "../src/route/frontier.mjs";
import { taskProfile } from "../src/route/task-profile.mjs";
import { resolveModel, candidateIdentity } from "../src/review/identity.mjs";
import { SDK_CONFIG, SDK_TRANSPORT, SDK_VENDOR, sdkModels, isSdkSeat, thinkingLevelsOf } from "../src/antigravity/config.mjs";
import { SUBAGENT_MODEL, SUBAGENT_CEILINGS, ceilingFor } from "../src/antigravity/subagents.mjs";
import { modelId } from "../src/config/models.mjs";

const D = ["easy", "medium", "hard"];
const rung = s => `${s.model}@${s.effort ?? "-"}`;

test("the routing config is checked before the matrix is built from it: an undeclared model, a thinking level the model has no record of, or a ladder that does not start on its own pick does not load", () => {
  assert.equal(sdkRoutingRefusal(SDK_CONFIG), null, "the config as shipped");
  const broken = edit => { const c = structuredClone(SDK_CONFIG); edit(c); return sdkRoutingRefusal(c); };
  assert.equal(broken(c => { c.implementer.hard.model = "gemini-9-ultra"; }), '"gemini-9-ultra" is not a model config/antigravity-sdk.json declares');
  assert.equal(broken(c => { c.ladders.easy[1].model = "gemini-9-ultra"; }), '"gemini-9-ultra" is not a model config/antigravity-sdk.json declares');
  assert.equal(broken(c => { c.implementer.easy.effort = "ludicrous"; }), '"ludicrous" is not a thinking level recorded for gemini-4-hydrogen');
  assert.equal(broken(c => { c.ladders.hard[1].effort = "ludicrous"; }), '"ludicrous" is not a thinking level recorded for gemini-4-hydrogen');
  // Neon has no recorded level: any level named for it is one nobody recorded.
  assert.equal(broken(c => { c.implementer.medium.effort = "high"; }), '"high" is not a thinking level recorded for gemini-4-neon');
  assert.equal(broken(c => { c.ladders.medium = [...c.ladders.medium].reverse(); }), "the medium ladder does not start on the medium implementer");
  assert.equal(broken(c => { c.ladders.easy[0].effort = "high"; }), "the easy ladder does not start on the easy implementer", "the same model at another level is another rung");
});

test("the implementer row: hard carbon, medium neon, easy hydrogen, each an SDK seat and none an agy CLI lane", () => {
  assert.deepEqual(D.map(d => fitMatrix("implementer", d).model), ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"]);
  for (const d of D) {
    const s = fitMatrix("implementer", d);
    assert.deepEqual([s.vendor, s.transport], ["agy_google", "antigravity-sdk"], d);
    assert.equal(isSdkSeat(s), true);
    assert.equal(laneParts(s.model), null, `${d}: ${s.model} is a Gemini API model id, not an Antigravity lane name`);
    assert.equal(quotaFailoverFor(s.model), null, `${d}: the SDK transport IS the Gemini API: there is no second, metered seat behind it`);
  }
  // The thinking level each is seated at: the level the 2026-11-17 matrix seated the same model at; neon carries none.
  assert.deepEqual(D.map(d => fitMatrix("implementer", d).effort), ["medium", null, "high"]);
  assert.equal(Object.isFrozen(FIT_MATRIX.implementer.hard), true);
});

test("every other role's seat is unchanged: the assignments are Google implementation routing only", () => {
  assert.deepEqual(D.map(d => fitMatrix("planner", d)), [{ vendor: "anthropic", model: modelId("anthropic", "sonnet") }, { vendor: "anthropic", model: modelId("anthropic", "opus-5-5") }, { vendor: "anthropic", model: modelId("anthropic", "fable") }]);
  assert.deepEqual(D.map(d => fitMatrix("dispatcher", d)), [{ vendor: "openai", model: "gpt-6-luna" }, { vendor: "openai", model: "gpt-6.1-sol" }, { vendor: "openai", model: "gpt-6-astra" }]);
  for (const d of D) assert.deepEqual(fitMatrix("reviewer", d), { ...fitMatrix("dispatcher", d), pinned: true, pinned_to: "dispatcher" }, `${d}: the Stage 5 reviewer is still the dispatcher's exact OpenAI model`);
  assert.deepEqual(FIT_MATRIX_BODY.reviewer, { pinned_to: "dispatcher", escalation: ["openai/gpt-6-luna", "openai/gpt-6.1-sol", "openai/gpt-6-astra"] });
});

test("the subagent row: an implementer's subagents are gemini-4-hydrogen on the same transport; Grok is not spent on Google delegation", () => {
  for (const d of D) {
    const s = fitMatrix("subagent", d);
    assert.deepEqual([s.vendor, s.model, s.transport, s.native], ["agy_google", "gemini-4-hydrogen", "antigravity-sdk", true], d);
  }
  assert.ok(!JSON.stringify([FIT_MATRIX.subagent, FIT_MATRIX.implementer, IMPLEMENTER_LADDERS]).includes("grok"), "no xAI model is an implementation seat");
  assert.equal(SUBAGENT_MODEL, "gemini-4-hydrogen");
  // The ceilings are the implementer model's: Carbon 8, Neon 4, Hydrogen none; a model with no declared ceiling, none.
  assert.deepEqual(SUBAGENT_CEILINGS, { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 });
  assert.deepEqual(["gemini-4-carbon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash", "gpt-6-astra"].map(ceilingFor), [8, 4, 0, 0, 0, 0]);
  assert.deepEqual(D.map(d => ceilingFor(fitMatrix("implementer", d).model)), [0, 4, 8], "by difficulty: easy none, medium 4, hard 8");
});

test("the ladders: the owner's pick first, then the earlier ladder's base models, each at a recorded thinking level", () => {
  assert.deepEqual(Object.fromEntries(D.map(d => [d, IMPLEMENTER_LADDERS[d].map(rung)])), {
    easy: ["gemini-4-hydrogen@medium", "gemini-3.8-flash@high"],
    medium: ["gemini-4-neon@-", "gemini-4-argon@high"],
    hard: ["gemini-4-carbon@high", "gemini-4-hydrogen@xhigh", "gemini-4-argon@high"] });
  for (const d of D) {
    assert.deepEqual(IMPLEMENTER_LADDERS[d][0], fitMatrix("implementer", d), `${d}: the ladder starts on the matrix pick`);
    assert.deepEqual(fitLadder("implementer", d), IMPLEMENTER_LADDERS[d].map(s => ({ ...s })));
    for (const s of IMPLEMENTER_LADDERS[d]) {
      assert.equal(isSdkSeat(s), true, `${d}: ${s.model} is an SDK seat`);
      if (s.effort !== null) assert.ok(thinkingLevelsOf(s.model).includes(s.effort), `${s.model}: ${s.effort} is a recorded thinking level of it`);
      else assert.deepEqual(thinkingLevelsOf(s.model), [], `${s.model}: a rung that sends no thinking level is a model with none recorded, never one whose level was dropped`);
    }
  }
});

test("the path a unit walks: a rejection raises the thinking level on the same model before the next model", () => {
  assert.deepEqual(implementerPath("easy").map(rung), ["gemini-4-hydrogen@medium", "gemini-4-hydrogen@high", "gemini-4-hydrogen@xhigh", "gemini-3.8-flash@high"]);
  // Neon has no recorded thinking level: nothing to raise, so the next model.
  assert.deepEqual(implementerPath("medium").map(rung), ["gemini-4-neon@-", "gemini-4-argon@high"]);
  // Carbon is seated at its top level.
  assert.deepEqual(implementerPath("hard").map(rung), ["gemini-4-carbon@high", "gemini-4-hydrogen@xhigh", "gemini-4-argon@high"]);
  for (const d of D) {
    assert.ok(implementerPath(d).every(isSdkSeat));
    assert.deepEqual(implementerPath(d)[0], fitMatrix("implementer", d));
  }
  assert.throws(() => implementerPath("trivial"), /unknown difficulty/);
});

test("the selector seats the per-file board: the matrix's model through the Gemini API as one tool-less turn, with no lane in front and no metered failover behind", () => {
  // The pipeline runs these models as SDK sessions (it takes its seats from fit-matrix.mjs). This selector's caller is
  // the per-file board, whose implementer is one tool-less turn: the same model, at the same thinking level, through
  // the Gemini API client (GEMINI_API_KEY). No agy CLI lane is started for it on either surface.
  for (const d of D) {
    const { seat, candidates, selection } = selectSeat("implementer", { profile: "fit", difficulty: d });
    const want = fitMatrix("implementer", d);
    assert.deepEqual([seat.vendor, seat.model, seat.transport, seat.direct_api, seat.session_transport, seat.effort], [want.vendor, want.model, "api", true, "antigravity-sdk", want.effort], d);
    assert.deepEqual(candidates.map(c => `${c.model}@${c.effort ?? "-"}`), IMPLEMENTER_LADDERS[d].map(rung), `${d}: the ladder, in order, and nothing else`);
    assert.ok(candidates.every(c => c.transport === "api" && c.direct_api === true && !c.quota_failover && laneParts(c.model) === null), `${d}: no lane and no failover seat`);
    assert.deepEqual([selection.eligibility, selection.matrix.pick, selection.matrix.transport, selection.matrix.session_transport], ["fit-matrix", want.model, "api", "antigravity-sdk"]);
    assert.match(selection.matrix.surface, /^per-file board: one tool-less turn through the Gemini API client/);
    assert.deepEqual(selection.matrix.efforts, IMPLEMENTER_LADDERS[d].map(s => s.effort));
    // The thinking level is the matrix's, not the task depth's: a deeper task does not silently change the seat.
    assert.equal(selectSeat("implementer", { profile: "fit", difficulty: d, task: taskProfile({ difficulty: d, depth: "max" }) }).seat.effort, want.effort);
  }
  // A floor still raises the column: easy work at critical stakes is the hard pick.
  assert.equal(selectSeat("implementer", { profile: "fit", difficulty: "easy", task: taskProfile({ difficulty: "easy", stakes: "critical" }) }).seat.model, "gemini-4-carbon");
});

test("antigravityFirst leaves the Google implementer alone in both its forms, and still moves a bare Gemini API seat of another role behind its lane", () => {
  const sdk = fitMatrix("implementer", "hard");
  assert.deepEqual(antigravityFirst([{ ...sdk }]), [{ ...sdk }]);
  const board = { vendor: "agy_google", model: "gemini-4-carbon", transport: "api", direct_api: true };
  assert.deepEqual(antigravityFirst([{ ...board }]), [{ ...board }]);
  const [lane, spare] = antigravityFirst([{ vendor: "agy_google", model: "gemini-4-carbon" }]);
  assert.deepEqual([lane.model, lane.antigravity_first, spare.model, spare.quota_failover.lanes], ["gemini-4-carbon-high", "gemini-4-carbon", "gemini-4-carbon", ["gemini-4-carbon-high"]],
    "review and planning seats on Gemini keep the rule they had: only implementation routing changed");
  assert.equal(seatTransport("agy_google", "gemini-4-carbon"), "api");
});

test("a model whose context window is not recorded is not admitted against a context estimate: the next rung is chosen, and the exclusion says why", () => {
  // gemini-4-neon's facts are UNRECORDED in this repository (config/antigravity-sdk.json). The selector's rule is
  // unchanged: an estimate is admitted only against a known bound. Without an estimate the owner's pick stands.
  assert.equal(selectSeat("implementer", { profile: "fit", difficulty: "medium" }).seat.model, "gemini-4-neon");
  const s = selectSeat("implementer", { profile: "fit", difficulty: "medium", needsContext: 1000 });
  assert.equal(s.seat.model, "gemini-4-argon");
  assert.deepEqual(s.selection.excluded.filter(e => e.model === "gemini-4-neon").map(e => e.why), ["window unrecorded; cannot admit an estimated 1000"]);
  assert.equal(s.selection.matrix.pick, "gemini-4-neon", "the record still names the matrix pick it could not admit");
});

test("every model the SDK transport declares is a Google model the identity policy resolves and the class table knows", () => {
  assert.deepEqual(sdkModels().sort(), ["gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"]);
  for (const m of sdkModels()) {
    const r = resolveModel(SDK_VENDOR, m);
    assert.deepEqual([r.known, r.lab, r.id], [true, "google", `google/${m}`], `${m}: an unresolved implementer would leave no reviewer eligible`);
    assert.deepEqual(candidateIdentity({ vendor: SDK_VENDOR, model: m }), { lab: "google", id: `google/${m}` });
    assert.ok(CLASSES.models[m], `${m}: has a class in classes.json`);
    assert.ok(CLASSES.order.includes(CLASSES.models[m].class));
  }
  // The config's own cross-references: every rung, the subagent model and every ceiling name a declared model.
  const named = [...D.flatMap(d => [SDK_CONFIG.implementer[d].model, ...SDK_CONFIG.ladders[d].map(s => s.model)]), SDK_CONFIG.subagents.model, ...Object.keys(SDK_CONFIG.subagents.ceilings)];
  for (const m of named) assert.ok(sdkModels().includes(m), `${m} is declared under models in config/antigravity-sdk.json`);
  assert.deepEqual([CLASSES.models["gemini-4-neon"].class, CLASSES.models["gemini-4-neon"].basis, SDK_CONFIG.models["gemini-4-neon"].facts], ["standard", "TASTE", "UNRECORDED"]);
  assert.equal(SDK_TRANSPORT, "antigravity-sdk");
});

test("the fit policy's body states the transport, the thinking levels and the subagent ceilings: a change to any is a new policy", () => {
  assert.deepEqual(FIT_MATRIX_BODY.matrix.implementer, { easy: "agy_google/gemini-4-hydrogen", medium: "agy_google/gemini-4-neon", hard: "agy_google/gemini-4-carbon" });
  assert.deepEqual(FIT_MATRIX_BODY.matrix.subagent, { easy: "agy_google/gemini-4-hydrogen", medium: "agy_google/gemini-4-hydrogen", hard: "agy_google/gemini-4-hydrogen" });
  assert.deepEqual(FIT_MATRIX_BODY.implementer, { transport: "antigravity-sdk", sdk: { distribution: "google-antigravity", version: "0.1.24" }, effort: { easy: "medium", medium: null, hard: "high" } });
  assert.deepEqual(FIT_MATRIX_BODY.implementer_ladders, { easy: ["gemini-4-hydrogen@medium", "gemini-3.8-flash@high"], medium: ["gemini-4-neon", "gemini-4-argon@high"], hard: ["gemini-4-carbon@high", "gemini-4-hydrogen@xhigh", "gemini-4-argon@high"] });
  assert.deepEqual(FIT_MATRIX_BODY.subagents, { model: "gemini-4-hydrogen", ceilings: { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 }, default_ceiling: 0, max_depth: 1 });
  assert.match(FIT_MATRIX_BODY.google, /google-antigravity SDK on the Gemini API/);
  assert.doesNotMatch(FIT_MATRIX_BODY.google, /lane first/i);
  // The fit policy as it was on 2026-11-19 before this routing (lanes for the implementer, Grok subagents), computed then.
  assert.notEqual(selectionPolicy("fit").hash, "sha256:273e4568539dbd7c7b1d856be3b49d29e49933d5bbc475d6295636c7aee9952a", "the lane matrix was a different policy");
  assert.match(selectionPolicy("fit").hash, /^sha256:[0-9a-f]{64}$/);
  // The other profiles' tables did not change.
  assert.equal(selectionPolicy("argo").hash, "sha256:f698663054f75b33a39ba38f37ad13b5566ef899c585ab063cafff4df039d5e0");
  assert.equal(selectionPolicy("legacy").hash, "sha256:0000f574015cf50f5ebcd93e7284df2581412546035a516296a49c4a2724d7e3");
});
