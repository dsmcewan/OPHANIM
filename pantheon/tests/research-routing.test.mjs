// THE RESEARCH ROLES' ROUTING (owner direction 2026-11-20: the Carbon 4 research and exploration team).
// Scout, explorer and researcher are seated on gemini-4-carbon through the Antigravity SDK transport, from a candidate
// list in config/antigravity-sdk.json; the choice and what it was chosen from are on the routing record. The
// implementer's rows and the fit selection policy are not touched. Pure data and functions: nothing here calls a provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SDK_CONFIG, SDK_TRANSPORT, SDK_VENDOR, RESEARCH_ROLES, RESEARCH_MAX_DEPTH, RESEARCH_DEPTH_LIMIT, researchConfigRefusal } from "../src/antigravity/config.mjs";
import { FIT_MATRIX, FIT_ROLES, researchSeat, researchSubordinate, researchLimits, RESEARCH_ROUTING_SCHEMA } from "../src/route/fit-matrix.mjs";
import { selectionPolicy } from "../src/route/frontier.mjs";
import { SUBAGENT_MODEL, ceilingFor } from "../src/antigravity/subagents.mjs";

const clone = o => JSON.parse(JSON.stringify(o));

test("scout, explorer and researcher each select gemini-4-carbon on the SDK transport, and the selection is on the routing record", () => {
  assert.deepEqual([...RESEARCH_ROLES], ["scout", "explorer", "researcher"]);
  for (const role of RESEARCH_ROLES) {
    const { seat, selection } = researchSeat(role);
    assert.deepEqual(seat, { vendor: SDK_VENDOR, model: "gemini-4-carbon", transport: SDK_TRANSPORT, effort: "high" }, role);
    assert.deepEqual([selection.schema, selection.role, selection.chosen, selection.rejected], [RESEARCH_ROUTING_SCHEMA, role, { model: "gemini-4-carbon", effort: "high" }, []]);
    assert.deepEqual(selection.candidates, [{ model: "gemini-4-carbon", effort: "high" }], "what it was chosen from");
    assert.match(selection.policy, /^sha256:[0-9a-f]{64}$/, "the configuration the choice was made under");
    assert.match(selection.basis, /owner direction 2026-11-20/);
  }
  assert.throws(() => researchSeat("implementer"), /not a research role \(scout, explorer, researcher\)/);
});

test("the assignment is configuration: the first QUALIFIED candidate is chosen and each one passed over is recorded with its reason; with none qualified nothing is substituted", () => {
  const cfg = clone(SDK_CONFIG);
  cfg.research.roles.scout.candidates = [{ model: "gemini-4-carbon", effort: "high" }, { model: "gemini-4-neon", effort: null }];
  // A capability-based selector passes its own test of a model; here Carbon does not qualify.
  const qualified = model => (model === "gemini-4-carbon" ? "the provider does not serve it to this key" : null);
  const { seat, selection } = researchSeat("scout", { config: cfg, qualified });
  assert.deepEqual([seat.model, seat.effort, seat.transport], ["gemini-4-neon", null, SDK_TRANSPORT]);
  assert.deepEqual(selection.rejected, [{ model: "gemini-4-carbon", why: "the provider does not serve it to this key" }]);
  assert.deepEqual(selection.chosen, { model: "gemini-4-neon", effort: null });
  assert.notEqual(selection.policy, researchSeat("scout").selection.policy, "another candidate list is another policy");
  assert.throws(() => researchSeat("scout", { config: cfg, qualified: () => "unavailable" }),
    e => e.code === "RESEARCH_NO_QUALIFIED_MODEL" && /scout.*gemini-4-carbon: unavailable.*gemini-4-neon: unavailable.*nothing is substituted/s.test(e.message));
});

test("subordinates are gemini-4-hydrogen, the depth limit is 10, and the team's ceiling is the coordinator model's existing subagent ceiling", () => {
  assert.deepEqual(researchSubordinate(), { vendor: SDK_VENDOR, model: SUBAGENT_MODEL, transport: SDK_TRANSPORT, effort: "medium" });
  assert.equal(SUBAGENT_MODEL, "gemini-4-hydrogen");
  assert.deepEqual([RESEARCH_DEPTH_LIMIT, RESEARCH_MAX_DEPTH], [10, 10]);
  const carbon = researchLimits("gemini-4-carbon");
  assert.deepEqual([carbon.max_depth, carbon.max_active, ceilingFor("gemini-4-carbon")], [10, 8, 8]);
  assert.equal(researchLimits("gemini-4-neon").max_active, 4, "a Neon coordinator keeps Neon's ceiling");
  assert.equal(researchLimits("gemini-4-hydrogen").max_active, 0, "a Hydrogen coordinator delegates to none: the restriction is not relaxed for research");
});

test("the research configuration is checked when it is read: a depth over 10, an undeclared model, an unrecorded thinking level, another subordinate model, a tool that is not a read tool", () => {
  assert.equal(researchConfigRefusal(SDK_CONFIG), null);
  const bad = (edit, re) => { const c = clone(SDK_CONFIG); edit(c.research); assert.match(researchConfigRefusal(c) ?? "(accepted)", re); };
  bad(r => { r.max_depth = 11; }, /max_depth is a whole number from 1 to 10/);
  bad(r => { r.max_depth = 0; }, /max_depth is a whole number from 1 to 10/);
  bad(r => { r.roles.explorer.candidates = []; }, /explorer names no candidate/);
  bad(r => { r.roles.scout.candidates[0].model = "gemini-9-unobtainium"; }, /scout: "gemini-9-unobtainium" is not a model this transport declares/);
  bad(r => { r.roles.researcher.candidates[0].effort = "xhigh"; }, /researcher: "xhigh" is not a thinking level recorded for gemini-4-carbon/);
  bad(r => { delete r.roles.researcher; }, /the research roles are exactly scout, explorer, researcher/);
  bad(r => { r.subordinate.model = "gemini-4-carbon"; }, /the subordinate model is the subagent model \(gemini-4-hydrogen\)/);
  bad(r => { r.tools.push("create_file"); }, /"create_file" is not a read tool/);
  bad(r => { r.bounds.coordinator_rounds = 3; }, /coordinator_rounds must allow the depth limit/);
});

test("the implementer's rows and the fit selection policy are not changed by the research roles", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(FIT_MATRIX.implementer).map(([d, s]) => [d, s.model])), { easy: "gemini-4-hydrogen", medium: "gemini-4-neon", hard: "gemini-4-carbon" });
  assert.deepEqual(RESEARCH_ROLES.filter(r => FIT_ROLES.includes(r)), [], "no research role is a row of the fit matrix");
  // The fit policy's hash as it was before the research roles existed (pull request 68, L-712).
  assert.equal(selectionPolicy("fit").hash, "sha256:b3f314ff933e86575f02fd80ace8aefdc4e1674bdf671330e96a8467990fd0da");
});
