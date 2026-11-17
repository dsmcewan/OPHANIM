// Routing and escalation protocol: the next step for a seat is a function of a RECORDED outcome and
// the CITED capability facts, and every step is a record that can be re-derived.
//
// The pieces existed and were not on the path: seating.mjs's selectFor/escalate/raiseEffort had no
// callers, so a revision after a failed acceptance re-ran the same model at the same effort. This
// module is the loop applied to the seat itself:
//
//   stabilize  the seat as it ran: role, vendor, model, effort, output budget
//   identify   the outcome's cause, from the record (terminal state, transport error, executed acceptance, verdict)
//   propose    the cheapest change that addresses that cause, inside documented values only
//   record     a decision {from, to, action, cause, basis}; `verifyEscalation` re-derives it
//
// Cheapest first, because each step keeps more of what was already paid for:
//   raise_output  same model, same reasoning; only a truncated reply is fixed by a larger budget
//   raise_effort  same model, lab and conversation; the dial is cheaper than the occupant
//   step_rung     same role's next banded rung (seating.mjs bands)
//   reseat        another quota pool, same chair -- for a pool that is shut, never for a hard task
// and some causes are not escalated at all: a rate limit with an interval WAITS, a malformed request
// STOPS (a stronger model does not fix a wrong request), and the step budget is bounded.
import { createHash } from "node:crypto";
import { FACTS } from "../config/facts.mjs";
import { LANES } from "../config/models.mjs";
import { candidatesFor, selectFor, shouldFallThrough, SEATING, DIFFICULTY } from "../role/seating.mjs";
import { isFrontier } from "../../../packages/model-client/index.mjs";

export const PROTOCOL = "pantheon.escalation/v1";
export const MAX_STEPS = 4;
const TRUNCATED = new Set(["max_tokens", "MAX_TOKENS", "incomplete", "max_output_tokens"]);
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
const digest = v => createHash("sha256").update(stable(v)).digest("hex");
const cited = (field) => field && typeof field === "object" && "value" in field ? field.value : null;

/** The documented effort ladder for a model, in the vendor's order. Empty when not documented. */
export function documentedEfforts(model, facts = FACTS) {
  return facts.models[model]?.efforts?.values ?? [];
}

/** The model's documented default effort, or null. */
export function documentedDefaultEffort(model, facts = FACTS) {
  return facts.models[model]?.efforts?.default ?? null;
}

/** The documented synchronous output ceiling, or null when unrecorded. */
export function documentedOutput(model, facts = FACTS) {
  return cited(facts.models[model]?.output);
}

/**
 * Whether the seat's transport can carry a reasoning-effort setting. The agy seats cannot: the CLI
 * lane (lanes.json, transport agy-cli) and agy-seat.py both take a model and a role card, nothing
 * else, and run-item.mjs sends every non-frontier agy_google seat through them. A raised effort there
 * would be dropped and the revision would re-run the same seat unchanged, so the protocol does not
 * offer one: the next step is the role's next harder rung.
 */
export function carriesEffort(seat) {
  // Decided by the seat's vendor and path, which is what run-item routes on; every lane model is
  // seated under agy_google and is not a frontier model, so it is covered by the same rule.
  return !(seat.vendor === "agy_google" && !isFrontier(seat.model));
}

/** What a recorded outcome means for the seat. Pure over the record. */
export function classifyOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return { cause: "unknown", why: "no recorded outcome" };
  if (outcome.kind === "turn-error") {
    const f = shouldFallThrough(outcome.error);
    if (!f.ok) return { cause: "request-invalid", why: f.why };
    if (f.retry_after_s !== null && f.same_vendor_viable) return { cause: "rate-limited", retry_after_s: f.retry_after_s, why: f.why };
    return { cause: "pool-shut", why: f.why };
  }
  if (outcome.kind === "turn") {
    if (outcome.complete) return { cause: "ok", why: "turn completed" };
    return TRUNCATED.has(outcome.terminal_state) ? { cause: "truncated", why: `provider stopped with ${outcome.terminal_state}` }
      : { cause: "incomplete", why: outcome.why ?? "turn incomplete without a truncation reason" };
  }
  if (outcome.kind === "acceptance") return outcome.exit === 0 ? { cause: "ok", why: "acceptance exited 0" }
    : { cause: "work-rejected", why: `executed acceptance exited ${outcome.exit}` };
  if (outcome.kind === "critique") return outcome.verdict === "approve" ? { cause: "ok", why: "approved" }
    : { cause: "work-rejected", why: "the cross-lab checker requested changes" };
  return { cause: "unknown", why: `unknown outcome kind "${outcome.kind}"` };
}

/**
 * The next step for a seat. `seat` is {vendor, model, effort?, output?}; `steps` is how many
 * escalation steps this item has already taken. Returns a decision; it never performs one.
 */
export function nextStep({ role, seat, outcome, steps = 0, maxSteps = MAX_STEPS, facts = FACTS, seating = SEATING }) {
  const { cause, why, retry_after_s } = classifyOutcome(outcome);
  const from = { vendor: seat.vendor, model: seat.model, effort: seat.effort ?? null, output: seat.output ?? null };
  const decide = (action, to, reason, basis = null) => ({ action, cause, from, to, why: `${why}; ${reason}`, basis });
  if (cause === "ok") return decide("hold", from, "nothing changed, so nothing moves");
  if (cause === "rate-limited") return decide("wait", from, `same seat after ${retry_after_s}s; a rate limit is not a reason to prefer another model`);
  if (cause === "request-invalid" || cause === "unknown" || cause === "incomplete") return decide("stop", null, "not a cause a different seat addresses");
  if (cause === "pool-shut") return decide("reseat", null, "the pool has no interval to wait for; another pool may answer (routeCall walks them)");
  if (steps >= maxSteps) return decide("stop", null, `escalation budget of ${maxSteps} steps is spent`);

  if (cause === "truncated") {
    const ceiling = documentedOutput(seat.model, facts);
    const current = seat.output ?? null;
    if (ceiling && current !== null && current < ceiling) {
      return decide("raise_output", { ...from, output: Math.min(ceiling, current * 2) },
        `the reply was cut off; doubling the output budget within the documented ${ceiling}`, facts.models[seat.model].output.source);
    }
    return decide("stop", null, ceiling ? `already at the documented output ceiling ${ceiling}` : "the model's output ceiling is not documented");
  }

  // work-rejected: effort first (where the transport carries it), then the role's next banded rung.
  const carried = carriesEffort(seat);
  const ladder = carried ? documentedEfforts(seat.model, facts) : [];
  const dial = !carried ? "not carried by the agy transport" : ladder.length ? "at its top" : "not documented";
  const start = seat.effort ?? documentedDefaultEffort(seat.model, facts);
  const i = start === null ? -1 : ladder.indexOf(start);
  if (i !== -1 && i + 1 < ladder.length) {
    return decide("raise_effort", { ...from, effort: ladder[i + 1] },
      `effort ${start} -> ${ladder[i + 1]} on ${seat.model}: the dial is cheaper than the occupant`, facts.models[seat.model].efforts.source);
  }
  // "Up" is the nearest HARDER band, not an earlier position: tables are not ordered by difficulty.
  const cands = candidatesFor(role, { seating });
  const level = c => DIFFICULTY.indexOf(c?.band);
  const here = level(cands.find(c => c.model === seat.model));
  const next = here === -1 ? null : cands.filter(c => level(c) > here).sort((a, b) => level(a) - level(b))[0] ?? null;
  if (next) {
    return decide("step_rung", { vendor: next.vendor, model: next.model, effort: null, output: from.output },
      `${seat.model}'s effort dial is ${dial}; up a rung to ${next.model}`);
  }
  return decide("stop", null, `${seat.model}'s effort dial is ${dial} and there is no higher banded rung for ${role}`);
}

/** The decision as a record: inputs, decision, and a digest a later step checks against the trail. */
export function escalationRecord(input) {
  const decision = nextStep(input);
  const body = { schema: PROTOCOL, role: input.role, seat: input.seat, outcome: input.outcome, steps: input.steps ?? 0, decision };
  return { ...body, digest: digest(body) };
}

// Keys the run adds when it stores a record (where it was, which tier it started from). They are notes
// about the record, not part of it, so the digest is checked over the record alone.
export const RECORD_NOTES = Object.freeze(["purpose", "tier", "slot", "rev"]);
// What a decision IS. Its `why` is the explanation, which may be reworded between versions; the digest
// still binds the text as written, so a rewording never lets a record's substance change unnoticed.
const substance = ({ action, cause, from, to, basis }) => ({ action, cause, from, to, basis });

/** Re-derive every recorded decision from its own inputs. A record that does not follow is refused. */
export function verifyEscalation(records, { facts = FACTS, seating = SEATING } = {}) {
  for (const [i, stored] of records.entries()) {
    const r = Object.fromEntries(Object.entries(stored).filter(([k]) => !RECORD_NOTES.includes(k)));
    const { digest: d, ...body } = r;
    if (r.schema !== PROTOCOL || digest(body) !== d) throw new Error(`escalation record ${i} is not intact`);
    const again = nextStep({ role: r.role, seat: r.seat, outcome: r.outcome, steps: r.steps, facts, seating });
    if (stable(substance(again)) !== stable(substance(r.decision))) throw new Error(`escalation record ${i} does not follow from its inputs`);
    if (i > 0 && r.steps !== records[i - 1].steps + (["hold", "wait", "stop"].includes(records[i - 1].decision.action) ? 0 : 1)) {
      throw new Error(`escalation record ${i} step count does not continue the trail`);
    }
  }
  return { ok: true, records: records.length };
}

/**
 * Routing: the seating choice for a difficulty, gated by the cited facts. A candidate that is neither
 * a documented API id nor a declared lane model is skipped; a deprecated one is used only when
 * nothing else in the role is; a model whose documented window is smaller than the context the work
 * needs is skipped. The reason travels with the pick.
 */
export function routeFor(role, { difficulty = "medium", needsContext = null, avoid = [], facts = FACTS, seating = SEATING } = {}) {
  const isLane = model => Object.values(LANES).some(lane => lane[model]);
  const skipped = [];
  const usable = c => {
    const f = facts.models[c.model];
    if (!f && !isLane(c.model)) { skipped.push({ model: c.model, why: "no capability record and not a declared lane model" }); return false; }
    if (f?.api_id === false && !isLane(c.model)) { skipped.push({ model: c.model, why: "not an API id" }); return false; }
    const window = cited(f?.window);
    // A stated context requirement is admitted only against a documented window: an unknown window is
    // not evidence the work fits, so it is skipped with its reason rather than treated as unlimited.
    if (needsContext && window === null) { skipped.push({ model: c.model, why: `window unrecorded; cannot admit a stated need of ${needsContext}` }); return false; }
    if (needsContext && window < needsContext) { skipped.push({ model: c.model, why: `documented window ${window} < ${needsContext}` }); return false; }
    return true;
  };
  const deprecated = c => typeof facts.models[c.model]?.api_id === "string" && facts.models[c.model].api_id.startsWith("deprecated");
  const table = { ...seating, [role]: (seating[role] ?? []).filter(c => usable({ ...c, model: c.model ?? candidatesFor(role, { seating }).find(x => x.vendor === c.vendor)?.model })) };
  const current = table[role].filter(c => !deprecated(c));
  const pick = selectFor(role, { difficulty, seating: { ...table, [role]: current.length ? current : table[role] }, avoid });
  if (!pick.ok) return { ...pick, skipped };
  return { ...pick, effort: carriesEffort(pick) ? (pick.effort ?? documentedDefaultEffort(pick.model, facts)) : null, skipped,
    deprecated: deprecated(pick), basis: facts.models[pick.model]?.window?.source ?? (isLane(pick.model) ? "lanes.json" : null) };
}
