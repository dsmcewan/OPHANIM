// THE FIT ROUTING MATRIX (owner direction 2026-11-17; src/route/fit-matrix.mjs). Each assertion names the defect it
// would catch: a wrong pick in a cell, a ladder out of order, a reviewer that leaves the dispatcher's model or OpenAI,
// a floor that lowers a pick, a lane and its API id counted as two models, a catalog figure that drifted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIT_MATRIX, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION, fitMatrix, fitLadder, pinnedReviewer, reviewerEscalation,
  implementerEscalation, laneFor, laneParts, quotaFailoverFor } from "../src/route/fit-matrix.mjs";
import * as frontier from "../src/route/frontier.mjs";
import { selectSeat, selectionPolicy, resolvePinned, registryModels, fitLevel, seatTransport, CLASSES } from "../src/route/frontier.mjs";
import { taskProfile } from "../src/route/task-profile.mjs";
import { nextStep, escalationRecord, verifyEscalation, documentedWindow, documentedEfforts, documentedOutput, PROTOCOL_V2 } from "../src/route/protocol.mjs";
import { resolveModel, contributorKeys, candidateRefusal } from "../src/review/identity.mjs";
import { LANES, MODELS } from "../src/config/models.mjs";
import { SEAT_FACTS } from "../src/route/router.mjs";
import { prepareRequest, CAPABILITIES } from "../../packages/model-client/index.mjs";
import { withEffort } from "../src/sdk/adapter.mjs";

const D = ["easy", "medium", "hard"];
const row = role => D.map(d => fitMatrix(role, d).model);
const first = (role, o) => selectSeat(role, { profile: "fit", ...o }).seat;

test("the matrix: every role's pick per difficulty, by exact catalog id", () => {
  assert.deepEqual(row("planner"), ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-2"]);
  // The MEDIUM dispatcher is gpt-6.1-sol (owner correction, same day), not gpt-6-sol.
  assert.deepEqual(row("dispatcher"), ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
  assert.deepEqual(row("implementer"), ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-carbon-high"]);
  assert.deepEqual(row("subagent"), ["grok-4.6", "grok-4.6", "grok-4.7"]);
  assert.deepEqual(row("reviewer"), row("dispatcher"), "the reviewer is the dispatcher's exact model");
  assert.deepEqual(D.map(d => fitMatrix("dispatcher", d).vendor), ["openai", "openai", "openai"]);
  assert.deepEqual(D.map(d => fitMatrix("implementer", d).vendor), ["agy_google", "agy_google", "agy_google"]);
  for (const d of D) assert.equal(seatTransport("agy_google", fitMatrix("implementer", d).model), "agy-cli", "the implementer is an Antigravity lane, not an API id");
  assert.throws(() => fitMatrix("planner", "trivial"), /unknown difficulty/);
  assert.throws(() => fitMatrix("controller", "easy"), /no row for role/);
  assert.equal(Object.isFrozen(FIT_MATRIX) && Object.isFrozen(FIT_MATRIX.planner), true);
});

test("the selector's first seat follows the matrix for every role and difficulty (profile fit)", () => {
  for (const role of ["planner", "dispatcher", "implementer", "subagent", "reviewer"]) for (const d of D) {
    const s = selectSeat(role, { profile: "fit", difficulty: d, needsContext: 1000 });
    assert.equal(s.seat.model, fitMatrix(role, d).model, `${role}/${d}`);
    assert.equal(s.selection.eligibility, "fit-matrix");
    assert.deepEqual([s.selection.matrix.role, s.selection.matrix.difficulty, s.selection.matrix.pick], [role, d, fitMatrix(role, d).model]);
  }
  assert.equal(selectSeat("reviewer", { profile: "fit", difficulty: "medium" }).selection.matrix.pinned_to, "dispatcher");
  // The roles the matrix adds exist under fit only.
  assert.throws(() => selectSeat("dispatcher", { profile: "argo" }), /no admitted candidate/);
});

test("the implementer's failover ladders: Antigravity lanes in the stated order, then the metered API of the pick's base model as quota failover", () => {
  assert.deepEqual(Object.fromEntries(D.map(d => [d, IMPLEMENTER_LADDERS[d].map(s => s.model)])), {
    easy: ["gemini-4-hydrogen-medium", "gemini-3.8-flash-high"],
    medium: ["gemini-4-hydrogen-high", "gemini-4-argon-high"],
    hard: ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"] });
  assert.deepEqual(fitLadder("planner", "hard").map(s => s.model), ["claude-fable-5-2"]);
  const want = { easy: "gemini-4-hydrogen", medium: "gemini-4-hydrogen", hard: "gemini-4-carbon" };
  for (const d of D) {
    const { candidates } = selectSeat("implementer", { profile: "fit", difficulty: d, needsContext: 1000 });
    const lanes = candidates.filter(c => !c.quota_failover), spare = candidates.filter(c => c.quota_failover);
    assert.deepEqual(lanes.map(c => c.model), IMPLEMENTER_LADDERS[d].map(s => s.model), `${d}: the lane ladder, in order, first`);
    assert.ok(lanes.every(c => c.transport === "agy-cli"));
    assert.deepEqual(spare.map(c => [c.model, c.transport, c.rank]), [[want[d], "api", lanes.length]], `${d}: one API seat, last`);
    assert.deepEqual(spare[0].quota_failover, { base: want[d], lanes: [IMPLEMENTER_LADDERS[d][0].model] });
    assert.equal(spare[0].selection.quota_failover.used, false);
    assert.match(spare[0].selection.quota_failover.rule, /only after an Antigravity lane .* refused for quota/);
    assert.equal(spare[0].effort, laneParts(IMPLEMENTER_LADDERS[d][0].model).thinking, "the failover runs at the lane's thinking level");
  }
});

test("the reviewer is pinned to the dispatcher's exact model and escalates only inside OpenAI: luna -> 6.1-sol -> astra", () => {
  assert.deepEqual(REVIEWER_ESCALATION.map(s => `${s.vendor}/${s.model}`), ["openai/gpt-6-luna", "openai/gpt-6.1-sol", "openai/gpt-6-astra"]);
  for (const d of D) {
    const dispatcher = first("dispatcher", { difficulty: d });
    assert.deepEqual(pinnedReviewer(dispatcher), { vendor: "openai", model: dispatcher.model, pinned: true, pinned_to: "dispatcher" });
  }
  assert.equal(reviewerEscalation({ vendor: "openai", model: "gpt-6-luna" }).model, "gpt-6.1-sol");
  assert.equal(reviewerEscalation({ vendor: "openai", model: "gpt-6.1-sol" }).model, "gpt-6-astra");
  assert.equal(reviewerEscalation({ vendor: "openai", model: "gpt-6-astra" }), null, "nothing above astra: the reviewer never leaves OpenAI");
  // gpt-6-sol is the general OpenAI medium seat, but it is not the dispatcher's model: it cannot be pinned or escalated from.
  assert.throws(() => pinnedReviewer({ vendor: "openai", model: "gpt-6-sol" }), /not a dispatcher seat/);
  assert.throws(() => reviewerEscalation({ vendor: "xai", model: "grok-4.7" }), /not on the reviewer's OpenAI escalation path/);
  assert.throws(() => pinnedReviewer({ vendor: "agy_google", model: "gpt-6-luna" }), /not a dispatcher seat/, "the vendor is part of the pin");
});

test("OpenAI tier order under fit: easy luna, medium sol, hard astra; the dispatcher's medium is 6.1-sol; the classes keep that order", () => {
  const cls = m => CLASSES.order.indexOf(CLASSES.models[m].class);
  assert.deepEqual(["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"].map(m => CLASSES.models[m].class), ["fast", "standard", "standard", "frontier"]);
  assert.ok(cls("gpt-6-luna") < cls("gpt-6.1-sol") && cls("gpt-6.1-sol") < cls("gpt-6-astra"), "luna < 6.1-sol < astra for the dispatcher");
  assert.ok(cls("gpt-6-luna") < cls("gpt-6-sol") && cls("gpt-6-sol") < cls("gpt-6-astra"), "the order was inverted before (astra standard, sol frontier)");
  // An OpenAI seat outside the matrix's own rows: the planner with the other labs excluded.
  const only = { avoid: ["anthropic", "agy_google"], avoidLabs: ["anthropic", "google"] };
  assert.deepEqual(D.map(d => first("planner", { difficulty: d, ...only }).model), ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);
  assert.deepEqual(D.map(d => first("dispatcher", { difficulty: d }).model), ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
});

test("floors RAISE a pick and never lower it: stakes, ambiguity (planner) and difficulty", () => {
  const pick = (role, spec) => first(role, { difficulty: spec.difficulty, task: taskProfile(spec) }).model;
  assert.equal(pick("dispatcher", { difficulty: "easy" }), "gpt-6-luna");
  assert.equal(pick("dispatcher", { difficulty: "easy", stakes: "normal" }), "gpt-6.1-sol", "normal stakes -> standard floor -> the medium column");
  assert.equal(pick("dispatcher", { difficulty: "easy", stakes: "critical" }), "gpt-6-astra", "easy + critical goes up");
  assert.equal(pick("implementer", { difficulty: "easy", stakes: "critical" }), "gemini-4-carbon-high");
  assert.equal(pick("planner", { difficulty: "easy", ambiguity: "contested" }), "claude-fable-5-2", "contested ambiguity raises the planner");
  assert.equal(pick("implementer", { difficulty: "easy", ambiguity: "contested" }), "gemini-4-hydrogen-medium", "and only the planner");
  assert.equal(pick("dispatcher", { difficulty: "hard", stakes: "low" }), "gpt-6-astra", "low stakes do not lower a hard ticket");
  assert.equal(pick("planner", { difficulty: "medium", stakes: "low", ambiguity: "settled" }), "claude-opus-5-5", "nor a medium one");
  const raised = fitLevel(taskProfile({ difficulty: "easy", stakes: "high" }), "subagent");
  assert.deepEqual([raised.value, raised.ticket, raised.raised], ["hard", "easy", true]);
  assert.match(raised.why, /raised from easy by the class floor frontier/);
  // Depth still sets effort on the pick's own ladder (API seats).
  assert.equal(first("dispatcher", { difficulty: "easy", task: taskProfile({ difficulty: "easy", depth: "max" }) }).effort, "max");
});

test("a rejection raises the lane's thinking level first, then the next ladder rung", () => {
  const ladder = d => IMPLEMENTER_LADDERS[d].map(s => s.model);
  const walk = d => { const seen = []; for (let s = { model: ladder(d)[0] }; s; s = implementerEscalation(s, ladder(d))) seen.push(`${s.action ?? "start"}:${s.model}`); return seen; };
  assert.deepEqual(walk("easy"), ["start:gemini-4-hydrogen-medium", "raise_thinking:gemini-4-hydrogen-high", "raise_thinking:gemini-4-hydrogen-xhigh", "step_rung:gemini-3.8-flash-high"]);
  assert.deepEqual(walk("medium"), ["start:gemini-4-hydrogen-high", "raise_thinking:gemini-4-hydrogen-xhigh", "step_rung:gemini-4-argon-high"]);
  // carbon has no level above high: straight to the next rung.
  assert.deepEqual(walk("hard"), ["start:gemini-4-carbon-high", "step_rung:gemini-4-hydrogen-xhigh", "step_rung:gemini-4-argon-high"]);
  assert.equal(implementerEscalation({ model: "gpt-6-astra" }, ladder("hard")), null, "not a lane");
  // As a protocol decision: recorded with its ladder, and re-derived from the record alone.
  const seat = { vendor: "agy_google", model: "gemini-4-hydrogen-medium", effort: null, output: null, lane_ladder: ladder("easy") };
  const rejected = { kind: "critique", verdict: "request_changes" };
  const r1 = escalationRecord({ role: "implementer", seat, outcome: rejected, steps: 0, protocol: PROTOCOL_V2 });
  assert.deepEqual([r1.decision.action, r1.decision.to.model], ["raise_thinking", "gemini-4-hydrogen-high"]);
  const r2 = escalationRecord({ role: "implementer", seat: { ...seat, model: "gemini-4-hydrogen-high" }, outcome: rejected, steps: 1, protocol: PROTOCOL_V2 });
  const r3 = escalationRecord({ role: "implementer", seat: { ...seat, model: "gemini-4-hydrogen-xhigh" }, outcome: rejected, steps: 2, protocol: PROTOCOL_V2 });
  assert.deepEqual([r2.decision.action, r2.decision.to.model, r3.decision.action, r3.decision.to.model], ["raise_thinking", "gemini-4-hydrogen-xhigh", "step_rung", "gemini-3.8-flash-high"]);
  assert.equal(verifyEscalation([r1, r2, r3]).ok, true);
  assert.throws(() => verifyEscalation([{ ...r1, decision: { ...r1.decision, to: { ...r1.decision.to, model: "gemini-4-carbon-high" } } }]), /not intact/);
  // The ladder spent: the same seat revises with the findings under v2; a failed acceptance stops.
  const last = { ...seat, model: "gemini-3.8-flash-high" };
  assert.equal(nextStep({ role: "implementer", seat: last, outcome: rejected, steps: 3, protocol: PROTOCOL_V2 }).action, "revise");
  assert.equal(nextStep({ role: "implementer", seat: last, outcome: { kind: "acceptance", exit: 1 }, steps: 3 }).action, "stop");
  // A seat with no ladder is decided exactly as before (argo and legacy records are unchanged).
  assert.equal(nextStep({ role: "implementer", seat: { vendor: "agy_google", model: "gemini-4-carbon-high" }, outcome: rejected, steps: 0 }).from.lane_ladder, undefined);
});

test("effort -> Antigravity lane: the level asked for, else the highest offered at or below it; -high when none is carried", () => {
  assert.equal(laneFor("gemini-4-carbon").model, "gemini-4-carbon-high");
  assert.equal(laneFor("gemini-4-argon", "low").model, "gemini-4-argon-low");
  assert.equal(laneFor("gemini-4-carbon", "xhigh").model, "gemini-4-carbon-high", "carbon offers no xhigh: the highest at or below it");
  assert.equal(laneFor("gemini-4-carbon", "max").model, "gemini-4-carbon-high", "an effort Antigravity does not name maps to high");
  assert.equal(laneFor("gemini-4-hydrogen", "xhigh").model, "gemini-4-hydrogen-xhigh");
  assert.equal(laneFor("gemini-3.6-flash"), null, "a model with no lane has none");
  assert.deepEqual(quotaFailoverFor("gemini-4-hydrogen-xhigh"), { vendor: "agy_google", model: "gemini-4-hydrogen", effort: "xhigh" });
  assert.equal(quotaFailoverFor("gemini-3.8-flash-high"), null, "gemini-3.8-flash has no API id in the registry, so no failover");
});

test("identity: an Antigravity lane and its metered API failover are one model", () => {
  for (const [lane, api] of [["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen"], ["gemini-4-carbon-high", "gemini-4-carbon"], ["gemini-4-hydrogen-medium", "gemini-4-hydrogen"], ["gemini-4-argon-high", "gemini-4-argon"]]) {
    const a = resolveModel("agy_google", lane), b = resolveModel("agy_google", api);
    assert.ok(a.known && b.known, `${lane} and ${api} both resolve`);
    assert.equal(a.id, b.id, `${lane} and ${api} are the same identity`);
    assert.equal(a.id, `google/${api}`);
    // A contribution under one name excludes the other from reviewing.
    const keys = contributorKeys([{ vendor: "agy_google", model: lane }]);
    assert.match(candidateRefusal({ vendor: "agy_google", model: api }, keys), /contributed to the change under review/);
  }
  // Every lane in a ladder has an API failover of the same identity, where the registry has an id for its base; where it
  // has none, none. Which case a lane is in is read from the registry, so a lane that loses (or wrongly gains) its
  // failover fails here instead of being skipped.
  const withFailover = [];
  for (const d of D) for (const s of IMPLEMENTER_LADDERS[d]) {
    const base = resolveModel(s.vendor, s.model).id.split("/")[1];
    const apiId = registryModels().some(r => r.vendor === s.vendor && r.model === base);
    const spare = quotaFailoverFor(s.model);
    if (apiId) {
      assert.ok(spare, `${s.model}: the registry has an API id for ${base}, so the lane has a quota failover`);
      assert.equal(resolveModel(spare.vendor, spare.model).id, resolveModel(s.vendor, s.model).id);
      withFailover.push(s.model);
    } else assert.equal(spare, null, `${s.model}: the registry has no API id for ${base}, so no failover`);
  }
  assert.ok(withFailover.length > 0, "the ladders hold lanes with a failover: the identity check above ran");
});

test("gemini-4-hydrogen is seated; both Orchestrator ids stay undeclared", () => {
  assert.equal(MODELS.google.hydrogen, "gemini-4-hydrogen");
  assert.deepEqual([documentedWindow("gemini-4-hydrogen"), documentedOutput("gemini-4-hydrogen"), documentedEfforts("gemini-4-hydrogen")], [1048576, 65536, ["low", "medium", "high", "xhigh"]]);
  assert.deepEqual([CAPABILITIES["gemini-4-hydrogen"].window, CAPABILITIES["gemini-4-hydrogen"].output, CAPABILITIES["gemini-4-hydrogen"].efforts], [1048576, 65536, ["low", "medium", "high", "xhigh"]]);
  assert.equal(seatTransport("agy_google", "gemini-4-hydrogen"), "api");
  for (const orchestrator of ["gemini-pro-orchestrator", "gemini-pro-orchestrator-argon"]) {
    assert.equal(resolveModel("agy_google", orchestrator).known, false, `${orchestrator}: one turn is two models`);
    assert.ok(!registryModels().some(r => r.model === orchestrator));
    assert.equal(LANES.agy_cli[orchestrator], undefined);
    assert.throws(() => resolvePinned(orchestrator), /neither the model registry nor a declared lane/);
    assert.ok(!JSON.stringify([FIT_MATRIX, IMPLEMENTER_LADDERS]).includes(orchestrator));
  }
});

test("the request builder never sends `minimal` or a thinking budget for gemini-4-hydrogen", () => {
  const build = extra => prepareRequest({ vendor: "agy_google", model: "gemini-4-hydrogen", prompt: "q", ...extra }).request;
  for (const effort of ["low", "medium", "high", "xhigh"]) assert.equal(build({ effort }).config.thinkingConfig.thinkingLevel, effort.toUpperCase());
  const folded = build({ effort: "minimal" });
  assert.equal(folded.config.thinkingConfig.thinkingLevel, "LOW", "minimal is folded to low, never sent");
  const budgeted = build({ extra: { config: { thinkingConfig: { thinkingBudget: 4096, thinkingLevel: "MINIMAL" } } } });
  assert.equal(budgeted.config.thinkingConfig.thinkingLevel, "LOW");
  for (const req of [folded, budgeted, build({}), build({ effort: "xhigh" })]) {
    const sent = JSON.stringify(req);
    assert.doesNotMatch(sent, /minimal/i, "no `minimal` anywhere in the serialized request");
    assert.doesNotMatch(sent, /thinking_?budget/i, "no thinking budget anywhere in the serialized request");
  }
  assert.throws(() => build({ effort: "max" }), /Unsupported effort/);
  // Pantheon's adapter refuses an undocumented effort before the request is built.
  assert.throws(() => withEffort("genai", "gemini-4-hydrogen", "minimal", {}), /not documented for gemini-4-hydrogen/);
  assert.deepEqual(withEffort("genai", "gemini-4-hydrogen", "xhigh", {}).config.thinkingConfig, { thinkingLevel: "XHIGH" });
});

test("every live Antigravity lane carries a cited window, so the documented-window rule (M7) admits it", () => {
  const live = Object.entries(LANES.agy_cli).filter(([, l]) => !l.retired);
  assert.equal(live.length, 13);
  for (const [name, l] of live) {
    assert.equal(l.window.value, 1048576, name);
    assert.ok(l.window.source && l.window.quote, `${name}: the window is cited`);
    assert.equal(documentedWindow(name), 1048576);
    if (l.base === "gemini-4-hydrogen") assert.equal(l.window.source, "owner statement 2026-11-17");
    else assert.match(l.window.source, /^owner direction 2026-11-17: Antigravity lanes are primary; figure is the base model's documented Gemini API window \(https:\/\/aistudio\.google\.com\/.*\); Antigravity itself documents no window$/, name);
    assert.equal(resolveModel("agy_google", name).base, l.base, `${name}: lanes.json and the identity policy agree on the base model`);
  }
  for (const [name, l] of Object.entries(LANES.agy_cli).filter(([, l]) => l.retired)) assert.equal(l.window, undefined, `${name}: a retired lane gains nothing`);
  for (const d of D) for (const s of IMPLEMENTER_LADDERS[d]) assert.equal(SEAT_FACTS.agy_google.windows[s.model], 1048576, `${s.model}: the router's window for a seated lane`);
  assert.equal(SEAT_FACTS.agy_google.windows["gemini-4-hydrogen"], 1048576);
});

test("the fit policy hash covers the matrix; the names PART 2 imports are exported from frontier.mjs too", () => {
  const body = JSON.parse(readFileSync(new URL("../src/config/classes.json", import.meta.url), "utf8"));
  assert.equal(body.models["gpt-6.1-sol"].class, "standard");
  assert.match(selectionPolicy("fit").hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(selectionPolicy("fit").hash, "sha256:ddc5cdaa4715b8c67fc926113d50130f62dd04a15acba2cd6b1418dd606ae08d", "the fit policy from before the matrix is a different policy");
  for (const name of ["fitMatrix", "fitLadder", "pinnedReviewer", "reviewerEscalation", "implementerEscalation", "IMPLEMENTER_LADDERS", "REVIEWER_ESCALATION", "FIT_MATRIX", "laneFor", "quotaFailoverFor"]) {
    assert.ok(frontier[name] !== undefined, `frontier.mjs exports ${name}`);
  }
});
