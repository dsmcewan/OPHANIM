// Stage 1: the work_units validator. Each rule is one named refusal; a good plan is accepted unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWorkUnits, parseWorkUnits, PLANNER_PROMPT, WORK_UNITS_SCHEMA, UNIT_KEYS } from "../src/pipeline/work-units.mjs";
import { unit } from "./fixtures/pipeline-stages.mjs";

const codes = plan => { const r = validateWorkUnits(plan); return r.ok ? [] : r.refusals.map(x => x.code); };
const one = over => ({ work_units: [unit("a", over)] });

test("a good multi-unit plan is accepted, units in unit_id order", () => {
  const r = validateWorkUnits({ work_units: [unit("b", { depends_on: ["a"] }), unit("a", { allowed_subagents: ["api-historian"] })] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.units.map(u => u.unit_id), ["a", "b"]);
});

test("each rule is a named refusal with a message", () => {
  const cases = [
    ["PLAN_SHAPE", { units: [] }],
    ["PLAN_SHAPE", { work_units: [unit("a")], extra: 1 }],
    ["PLAN_EMPTY", { work_units: [] }],
    ["UNIT_ID", one({ unit_id: "" })],
    ["UNIT_ID", one({ unit_id: "../x" })],
    ["DUPLICATE_UNIT_ID", { work_units: [unit("a"), unit("a")] }],
    ["UNKNOWN_DEPENDENCY", one({ depends_on: ["ghost"] })],
    ["DEPENDENCY_CYCLE", one({ depends_on: ["a"] })],
    ["DEPENDENCY_CYCLE", { work_units: [unit("a", { depends_on: ["c"] }), unit("b", { depends_on: ["a"] }), unit("c", { depends_on: ["b"] })] }],
    ["OWNED_PATHS_EMPTY", one({ owned_paths: [] })],
    ["OWNED_PATH", one({ owned_paths: ["../outside/**"] })],
    ["OWNED_PATH", one({ owned_paths: ["src/../../etc"] })],
    ["OWNED_PATH", one({ owned_paths: ["/etc/passwd"] })],
    ["OWNED_PATH", one({ owned_paths: ["C:/x"] })],
    ["OWNED_PATH", one({ owned_paths: [""] })],
    ["OWNED_PATH", one({ owned_paths: [".git/hooks/**"] })],
    ["OWNED_PATH", one({ owned_paths: ["src/[ab]/**"] })],
    ["DIFFICULTY", one({ difficulty: "trivial" })],
    ["SPECIALIST_ROLE", one({ specialist_role: " " })],
    ["VERIFY_CMD", one({ verify_cmd: "" })],
    ["INVARIANTS", one({ invariants: [] })],
    ["INVARIANTS", one({ invariants: "it works" })],
    ["INVARIANTS", one({ invariants: [1] })],
    ["ALLOWED_SUBAGENTS", one({ allowed_subagents: "grok" })],
    ["ALLOWED_SUBAGENTS", one({ allowed_subagents: [""] })],
    ["DEPENDS_ON", one({ depends_on: "a" })],
    ["UNKNOWN_KEY", one({ priority: 1 })],
  ];
  for (const [code, plan] of cases) {
    const r = validateWorkUnits(plan);
    assert.equal(r.ok, false, `${code} was accepted: ${JSON.stringify(plan)}`);
    assert.ok(r.refusals.some(x => x.code === code && typeof x.message === "string" && x.message.length > 10), `${code} not among ${JSON.stringify(r.refusals)}`);
  }
});

test("a missing key is refused, never defaulted", () => {
  for (const k of UNIT_KEYS) {
    const u = unit("a"); delete u[k];
    assert.ok(codes({ work_units: [u] }).includes("MISSING_KEY"), `a unit without ${k} was accepted`);
  }
});

test("allowed_subagents may be empty; every refusal of a plan is reported, not just the first", () => {
  assert.equal(validateWorkUnits(one({ allowed_subagents: [] })).ok, true);
  const got = codes({ work_units: [unit("a", { difficulty: "x", verify_cmd: "" }), unit("b", { depends_on: ["zz"] })] });
  assert.deepEqual([...got].sort(), ["DIFFICULTY", "UNKNOWN_DEPENDENCY", "VERIFY_CMD"]);
});

test("the planner's answer is the whole plan object or it is refused (no fence stripping, no prose)", () => {
  const good = JSON.stringify({ work_units: [unit("a")] });
  assert.equal(parseWorkUnits(good).ok, true);
  assert.equal(parseWorkUnits("```json\n" + good + "\n```").refusals[0].code, "NOT_JSON");
  assert.equal(parseWorkUnits("Here is the plan: " + good).refusals[0].code, "NOT_JSON");
});

test("the planner prompt is a read-only specialist prompt that keeps coupled files in ONE unit; the schema is strict", () => {
  const p = PLANNER_PROMPT({ task: "add a parser", subagents: ["api-historian"] });
  assert.match(p, /READ-ONLY specialist/);
  assert.match(p, /types, the implementation that uses them and the tests that prove them stay together/);
  assert.match(p, /api-historian/);
  assert.doesNotMatch(p, /helpful assistant/i);
  assert.equal(WORK_UNITS_SCHEMA.additionalProperties, false);
  assert.equal(WORK_UNITS_SCHEMA.properties.work_units.items.additionalProperties, false);
  assert.deepEqual(WORK_UNITS_SCHEMA.properties.work_units.items.required, [...UNIT_KEYS]);
});
