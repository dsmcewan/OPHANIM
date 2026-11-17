// Interleaved assignment of routing arms on work that runs anyway (docs/reviews/2026-11-17-routing-evaluation/
// DESIGN.md step 2; docs/routing-task-profile.md, "Continuous evaluation"). Pure: no I/O, no provider call.
//
//   assignArm({ticketKey, stakes, policy}) -> {schema, arm: 'argo'|'fit', basis, stakes, randomized, bucket}
//
// The arm is a deterministic hash of the ticket key (50/50), so the same ticket always gets the same arm and
// nobody chooses which tickets a profile sees. Only strata the policy marks eligible are interleaved
// (default: low and normal stakes); a high or critical ticket, a ticket whose stakes are unknown, and a
// stratum the stop rule has halted (evaluate.mjs) all stay on the baseline, with the basis saying why. Only
// a `randomized` assignment is evidence for the comparison: the evaluator ignores every other run, because
// an arm somebody chose (an explicit --profile, an ineligible stratum) is not a randomized arm.
import { createHash } from "node:crypto";

export const ASSIGN_SCHEMA = "pantheon.assign/v1";
export const BASELINE_ARM = "argo";
export const CANDIDATE_ARM = "fit";
/** PROVISIONAL: the strata interleaved until `fit` is qualified for a stratum. */
export const DEFAULT_ELIGIBLE_STRATA = Object.freeze(["low", "normal"]);
export const DEFAULT_ASSIGNMENT_POLICY = Object.freeze({ eligible: DEFAULT_ELIGIBLE_STRATA, halted: Object.freeze([]) });
export const BASIS = Object.freeze({
  hash: "interleave: sha256 of the ticket key",
  ineligible: "stratum not eligible",
  halted: "stratum halted by the stop rule",
  unknown: "stakes unknown: stratum not eligible",
  explicit: "explicit profile",
});

/** The hash bucket of a ticket key: 0 (baseline) or 1 (candidate). */
export function bucketOf(ticketKey) {
  if (typeof ticketKey !== "string" || ticketKey === "") throw new Error("assignArm: a ticket key is a non-empty string");
  const h = createHash("sha256").update(`${ASSIGN_SCHEMA}\0${ticketKey}`).digest();
  return h[0] & 1;
}

const haltedSet = halted => new Set(Array.isArray(halted) ? halted : halted && typeof halted === "object" ? Object.keys(halted).filter(k => halted[k]) : []);

export function assignArm({ ticketKey, stakes, policy = DEFAULT_ASSIGNMENT_POLICY } = {}) {
  const bucket = bucketOf(ticketKey);
  const eligible = new Set(policy?.eligible ?? DEFAULT_ELIGIBLE_STRATA);
  const halted = haltedSet(policy?.halted);
  const base = { schema: ASSIGN_SCHEMA, stakes: stakes ?? null, bucket };
  if (typeof stakes !== "string" || stakes === "") return { ...base, arm: BASELINE_ARM, basis: BASIS.unknown, randomized: false };
  if (!eligible.has(stakes)) return { ...base, arm: BASELINE_ARM, basis: BASIS.ineligible, randomized: false };
  if (halted.has(stakes)) return { ...base, arm: BASELINE_ARM, basis: BASIS.halted, randomized: false };
  return { ...base, arm: bucket ? CANDIDATE_ARM : BASELINE_ARM, basis: BASIS.hash, randomized: true };
}

/** The assignment a run records when its profile was named explicitly: it wins, and it is not randomized. */
export const explicitAssignment = ({ profile, stakes = null, interleave = false }) =>
  ({ schema: ASSIGN_SCHEMA, arm: profile, basis: BASIS.explicit, stakes, randomized: false, interleave_requested: Boolean(interleave) });
