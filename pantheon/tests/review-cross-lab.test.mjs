// Independent review 2026-11-16, RU1: the cross-lab review rule compared vendor strings, so a Claude lane
// model served by an agy seat (vendor agy_google, lab anthropic) could be reviewed by an Anthropic seat and
// pass both law 3 and assertReviewCutsAcross. The rule is about the LAB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReviewCutsAcross } from "../src/role/seating.mjs";
import { enforce } from "../src/team/law.mjs";
import { labOf, vendorsOfLab } from "../src/config/models.mjs";

const maker = { vendor: "agy_google", model: "claude-opus-4-6-thinking" };
const anthropic = { vendor: "anthropic", model: "claude-opus-5-5" };
const xai = { vendor: "xai", model: "grok-4.6" };

test("a lane model names its lab; the review rules compare labs as well as vendors", () => {
  assert.equal(labOf("agy_google", "claude-opus-4-6-thinking"), "anthropic");
  assert.equal(labOf("agy_google", "gemini-3.6-flash"), "google");
  assert.deepEqual(vendorsOfLab("anthropic"), ["anthropic"]);
  assert.throws(() => assertReviewCutsAcross({ assigner: { vendor: "agy_google" }, producer: maker, reviewer: anthropic }), /vendor or lab \(anthropic\)/);
  const v = enforce({ kind: "review", producer: maker, checker: anthropic, assigner: { vendor: "agy_google" } }, {});
  assert.equal(v.ok, false);
  assert.match(v.violations.map(x => x.why ?? x).join(" "), /same lab \(anthropic\)/);
  // A different lab passes both.
  assert.equal(assertReviewCutsAcross({ assigner: { vendor: "agy_google" }, producer: maker, reviewer: xai }), true);
  assert.equal(enforce({ kind: "review", producer: maker, checker: xai, assigner: { vendor: "agy_google" } }, {}).ok, true);
  // The assigner side too: a planner running a Claude lane model rules out an Anthropic reviewer.
  assert.throws(() => assertReviewCutsAcross({ assigner: { vendor: "agy_google", model: "claude-sonnet-4-6" },
    producer: { vendor: "openai", model: "gpt-6-sol" }, reviewer: anthropic }), /shares a vendor or lab/);
});
