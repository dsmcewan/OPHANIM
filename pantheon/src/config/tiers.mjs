// Output-token tiers by difficulty band. PROVISIONAL, set 2026-11-16 to replace the direct Messages
// path's flat 1,024-token default, which cut long replies off. They are a starting policy, not a
// measurement: every tier is capped at the model's documented output ceiling (capability-facts.json),
// a truncation is still escalated by the protocol (raise_output within that ceiling), and the run's
// recorded truncations are the evidence for moving a tier (`truncationEvidence`).
import { readFileSync } from "node:fs";
import { isFrontier, CAPABILITIES } from "../../../packages/model-client/index.mjs";

const FACTS = JSON.parse(readFileSync(new URL("./capability-facts.json", import.meta.url), "utf8"));
export const TOKEN_TIERS = Object.freeze({ easy: 4096, medium: 16384, hard: 32768 });
export const TIERS_STATUS = "provisional (2026-11-16); adjust from recorded truncations";
// What the frontier client applies when no budget is named (model-client prepareRequest, long_decode).
export const FRONTIER_DEFAULT_OUTPUT = 65536;

const ceilingOf = model => {
  const f = FACTS.models[model]?.output;
  return f && typeof f === "object" && Number.isInteger(f.value) ? f.value : null;
};

/** The tier's budget for a model, capped at its documented ceiling. */
export function outputBudgetFor(model, tier = "medium") {
  const wanted = TOKEN_TIERS[tier];
  if (!wanted) throw new Error(`unknown token tier "${tier}" (known: ${Object.keys(TOKEN_TIERS).join(", ")})`);
  const ceiling = ceilingOf(model);
  const tokens = ceiling === null ? wanted : Math.min(wanted, ceiling);
  return { tokens, tier, ceiling, capped: ceiling !== null && ceiling < wanted, status: TIERS_STATUS };
}

/**
 * The output budget a turn runs with when the caller names none, or null where the provider's own
 * default applies. Only paths that impose a default of their own are given one.
 */
export function defaultOutputFor(vendor, model, tier = "medium") {
  const cap = isFrontier(model) ? CAPABILITIES[model] : null;
  // A frontier model with its own long-decode policy keeps it; a model moved onto the frontier client
  // with providerDefaults is treated as it was on the direct path (see model-client registry.mjs).
  if (cap && !cap.providerDefaults) return FRONTIER_DEFAULT_OUTPUT;
  if (vendor === "anthropic") return outputBudgetFor(model, tier).tokens;   // Messages requires max_tokens
  if (cap?.surface === "genai") return cap.output;   // the client's long-decode bound, which is the documented ceiling
  return null;
}

/** Recorded truncations, grouped by model and starting budget: the evidence for moving a tier. */
export function truncationEvidence(escalations = []) {
  const rows = new Map();
  for (const e of escalations) {
    if (e?.decision?.cause !== "truncated") continue;
    const k = `${e.seat.model}@${e.tier ?? "?"}`;
    const row = rows.get(k) ?? { model: e.seat.model, tier: e.tier ?? null, truncations: 0, raisedTo: [], stopped: 0 };
    row.truncations++;
    if (e.decision.action === "raise_output") row.raisedTo.push(e.decision.to.output); else row.stopped++;
    rows.set(k, row);
  }
  return [...rows.values()].sort((a, b) => a.model.localeCompare(b.model) || String(a.tier).localeCompare(String(b.tier)));
}
