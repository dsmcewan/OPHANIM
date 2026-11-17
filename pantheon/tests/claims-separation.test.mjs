// Owner audit CS1 and CS2 (docs/reviews/2026-11-16-workflow-handoffs/CURRENT_STATE.md). A recorded decision must
// keep an eligibility constraint apart from a preference, and a capability citation apart from a cost/utility claim.
// SURFACE/ISOLATION alone never qualify an ordering; a capability page never classifies a recovery strategy as
// measured. Picks, policy hashes and historical escalation records are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalCodeUnit } from "../../packages/ledger/canonical.mjs";
import { selectSeat, CONSTRAINT_TAGS } from "../src/route/frontier.mjs";
import { nextStep, escalationRecord, verifyEscalation } from "../src/route/protocol.mjs";

test("CS1: every selection separates constraints from an unqualified preference; a constraint tag never orders", () => {
  let n = 0;
  for (const profile of ["argo", "legacy", "fit"]) for (const role of ["planner", "implementer", "reviewer", "scout"]) for (const difficulty of ["easy", "medium", "hard"]) {
    let s; try { s = selectSeat(role, { profile, difficulty, needsContext: 100 }); } catch { continue; }
    for (const c of s.candidates) {
      const { constraints, preference } = c.selection.claims;
      assert.ok(constraints.some(k => k.check === "role"));
      assert.equal(preference.status, "unqualified", `${profile}/${role}/${difficulty} ${c.model}`);
      assert.equal(preference.evidence, null);
      assert.ok(!CONSTRAINT_TAGS.includes(preference.basis), `${c.model}: ${preference.basis} is a constraint, not a preference basis`);
      n++;
    }
  }
  assert.ok(n > 50, `${n} selections checked`);
});

test("CS1: the audit's two cases -- Astra/SURFACE and Grok 4.6/ISOLATION -- carry their tags as constraints only", () => {
  const astra = selectSeat("implementer", { profile: "legacy", difficulty: "hard", avoid: ["agy_google"], needsContext: 100 });
  assert.equal(astra.seat.model, "gpt-6-astra");
  const a = astra.selection.claims;
  assert.ok(a.constraints.some(k => k.tag === "SURFACE"));
  assert.match(a.preference.note, /eligibility only/);
  const grok = selectSeat("reviewer", { profile: "legacy", difficulty: "medium", needsContext: 100 });
  assert.equal(grok.seat.model, "grok-4.6");
  assert.ok(grok.selection.claims.constraints.some(k => k.tag === "ISOLATION"));
  assert.equal(grok.selection.claims.preference.status, "unqualified");
});

const fable = { vendor: "anthropic", model: "claude-fable-5-2", effort: "high", output: 65536 };
const rejected = { kind: "acceptance", exit: 1 };

test("CS2: raise_effort cites the capability page for the permitted values only; the cost claim is an unqualified hypothesis", () => {
  const d = nextStep({ role: "implementer", seat: fable, outcome: rejected });
  assert.equal(d.action, "raise_effort");
  assert.equal(d.to.effort, "xhigh");
  assert.equal(d.basis_supports, "the permitted effort values for this model");
  assert.deepEqual([d.hypothesis.status, d.hypothesis.evidence], ["unqualified", null]);
  assert.doesNotMatch(d.why, /cheaper than the occupant/);
});

test("CS2: an escalation record written before this change (old wording, no hypothesis) still re-derives", () => {
  const rec = escalationRecord({ role: "implementer", seat: fable, outcome: rejected, steps: 0 });
  assert.equal(rec.decision.action, "raise_effort", "the compatibility case is a real raise_effort record");
  const { hypothesis, basis_supports, ...oldDecision } = rec.decision;
  oldDecision.why = oldDecision.why.replace(/provisional effort-first recovery.*$/, "the dial is cheaper than the occupant");
  assert.match(oldDecision.why, /the dial is cheaper than the occupant$/);
  const { digest: _, ...body } = { ...rec, decision: oldDecision };
  const old = { ...body, digest: createHash("sha256").update(canonicalCodeUnit(body)).digest("hex") };
  assert.deepEqual(verifyEscalation([old]), { ok: true, records: 1 });
});
