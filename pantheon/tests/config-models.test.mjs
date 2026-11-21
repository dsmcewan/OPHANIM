// Human-authored oracle, written BEFORE the loader and baselined failing.
//
// WHY THIS EXISTS. Model-ID strings were hardcoded in three places (src/sdk/adapter.mjs's
// default_model per vendor, src/role/seating.mjs's SEATING ladder, src/route/router.mjs's
// SEAT_FACTS.models) -- the exact spelling drifting between them is how the multi-agent grok id
// went wrong once already. NOTE, 2026-09-28: this comment previously named "-0309" as the correct
// form and the bare name as the error. It is the reverse (docs.x.ai names "grok-4.20-multi-agent"),
// and tests/sdk-transport.test.mjs had been using the bare name all along -- the config and a test
// disagreed for weeks and nothing caught it. This loader makes src/config/models.json the single source those
// three files read from, so a correction happens in one place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, modelId } from "../src/config/models.mjs";

test("loads all four vendors from models.json", () => {
  assert.deepEqual(Object.keys(MODELS).sort(), ["anthropic", "google", "openai", "xai"]);
});

test("modelId resolves a known vendor/name pair to its model string", () => {
  assert.equal(modelId("anthropic", "fable"), "claude-fable-5-2");
  assert.equal(modelId("anthropic", "sonnet"), "claude-sonnet-5");
  assert.equal(modelId("anthropic", "opus"), "claude-opus-5");
  assert.equal(modelId("anthropic", "haiku"), "claude-haiku-4-5-20251001");
  assert.equal(modelId("openai", "astra"), "gpt-6-astra");
  assert.equal(modelId("openai", "sol"), "gpt-6-sol");
  assert.equal(modelId("openai", "luna"), "gpt-6-luna");
  assert.equal(modelId("xai", "grok-4.7"), "grok-4.7");
  assert.equal(modelId("xai", "grok-4.20-multi-agent"), "grok-4.20-multi-agent");
  assert.equal(modelId("google", "gemini-3.6-flash"), "gemini-3.6-flash");
});

test("modelId throws by naming the unknown vendor, never silently returns undefined", () => {
  assert.throws(() => modelId("bogus-vendor", "sonnet"), /unknown vendor "bogus-vendor"/);
});

test("modelId throws by naming the unknown model key for a real vendor", () => {
  assert.throws(() => modelId("anthropic", "bogus-model"), /unknown model "bogus-model" for vendor "anthropic"/);
});

// Q5: every model the seating tables can choose is declared somewhere a model walk can find it.
import { resolveSeatModel, LANES } from "../src/config/models.mjs";
import { SEATING, INTAKE, modelOf } from "../src/role/seating.mjs";

test("every seated model resolves to the registry or a declared, non-retired lane; a live lane may be declared and unseated", () => {
  const seated = [...Object.values(SEATING), ...Object.values(INTAKE)].flat().map(c => modelOf(c));
  assert.ok(seated.length > 0);
  const lanes = [];
  for (const model of new Set(seated)) {
    const r = resolveSeatModel(model);
    if (r.source === "lane") lanes.push(model);
  }
  // A retired lane (2026-11-17: Antigravity serves Gemini models only) stays declared so recorded ledgers
  // still resolve its name to a lab, and is never seated.
  const live = Object.entries(LANES.agy_cli).filter(([, l]) => !l.retired).map(([m]) => m);
  const retired = Object.entries(LANES.agy_cli).filter(([, l]) => l.retired).map(([m]) => m);
  // 2026-11-17 (owner direction: "seat Carbon and the other Gemini ids through Antigravity"): twelve more live
  // Gemini lanes were declared, and only two of them were seated. A live lane may be declared without a seat --
  // it is still reachable by a pin and by the fit profile -- so the seated lanes are a SUBSET of the live ones,
  // pinned here by name.
  for (const model of lanes) assert.ok(live.includes(model), `seated lane ${model} is a declared, non-retired lane`);
  assert.deepEqual(lanes.sort(), ["gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-carbon-high"],
    "the seated models outside the registry are exactly these three live agy CLI lanes");
  assert.deepEqual(live.sort(), [
    "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium",
    "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium",
    "gemini-4-carbon-high", "gemini-4-carbon-low", "gemini-4-carbon-medium",
    "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh",
  ], "the live lanes are the thirteen Gemini ones");
  for (const model of live) assert.equal(LANES.agy_cli[model].lab, "google", `live lane ${model} is a Gemini model`);
  assert.deepEqual(retired.sort(), ["claude-opus-4-6-thinking", "claude-sonnet-4-6"]);
  for (const model of retired) {
    assert.ok(!seated.includes(model), `retired lane ${model} must not be seated anywhere`);
    assert.notEqual(LANES.agy_cli[model].lab, "google", `${model} is retired because it is not a Gemini model`);
  }
});

test("a model neither the registry nor a lane declares is refused by name", () => {
  assert.equal(resolveSeatModel("gpt-6-sol").source, "registry");
  assert.equal(resolveSeatModel("claude-sonnet-4-6").transport, "agy-cli");
  assert.throws(() => resolveSeatModel("claude-imaginary-9"), /claude-imaginary-9.*neither models.json nor lanes.json/);
});
