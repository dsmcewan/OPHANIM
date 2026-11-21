// A single-turn seat on a declared Antigravity lane (owner direction 2026-11-17: Antigravity serves Gemini models
// only, and its output carries the required input model). The agy CLI is the fixture's fake script; nothing live runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { agySingleTurn } from "../src/sdk/agy-turn.mjs";
import { seatTransport } from "../src/route/frontier.mjs";
import { resolveModel, reviewerIdentity } from "../src/review/identity.mjs";

test("a single-turn seat on an Antigravity Gemini lane runs through the agy CLI and its answer carries the input model, marked as an input", async () => {
  await withDispatch(async ({ agy }) => {
    assert.equal(seatTransport("agy_google", "gemini-4-carbon-high"), "agy-cli");
    assert.equal(seatTransport("agy_google", "gemini-4-carbon"), "api", "the frontier API id is unchanged: it is not a lane");
    const r = await agySingleTurn({ vendor: "agy_google", model: "gemini-4-carbon-high", prompt: "review this", seat: { role: "cycle-reviewer" } });
    assert.deepEqual(agy(), [{ agent: "pantheon-reviewer", model: "gemini-4-carbon-high" }]);
    assert.deepEqual([r.text, r.served_model, r.served_model_source], ["VERDICT: approve", "gemini-4-carbon-high", "input"]);
    // The lane name is its base model for independence: the same identity as Carbon through the API.
    assert.equal(resolveModel("agy_google", "gemini-4-carbon-high").id, "google/gemini-4-carbon");
    assert.deepEqual(reviewerIdentity({ vendor: "agy_google", model: "gemini-4-carbon-high", served_model: r.served_model }), { lab: "google", ids: ["google/gemini-4-carbon"] });
    // A planner seat runs under the planner's card.
    await agySingleTurn({ vendor: "agy_google", model: "gemini-4-argon-high", prompt: "plan this", seat: { role: "planner" } });
    assert.deepEqual(agy().at(-1), { agent: "pantheon-planner", model: "gemini-4-argon-high" });
  });
});

test("a non-Gemini or undeclared model is refused before the agy CLI is launched; an Orchestrator id has no single identity", async () => {
  await withDispatch(async ({ agy }) => {
    await assert.rejects(agySingleTurn({ vendor: "agy_google", model: "claude-opus-4-6-thinking", prompt: "x" }), e => e.code === "AGY_GEMINI_ONLY" && /is a anthropic model/.test(e.message));
    await assert.rejects(agySingleTurn({ vendor: "agy_google", model: "claude-opus-5-5-high", prompt: "x" }), e => e.code === "AGY_GEMINI_ONLY" && /not a declared model/.test(e.message));
    await assert.rejects(agySingleTurn({ vendor: "agy_google", model: "gemini-pro-orchestrator", prompt: "x" }), e => e.code === "AGY_GEMINI_ONLY");
    assert.equal(resolveModel("agy_google", "gemini-pro-orchestrator").known, false, "two models answer in one Orchestrator turn");
    assert.deepEqual(agy(), [], "nothing was launched");
  });
});
