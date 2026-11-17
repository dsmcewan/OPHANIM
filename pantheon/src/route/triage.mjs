// SEAT TRIAGE (experimental; owner request 2026-11-17, not on any default path): ask a lab's cheap default model
// which model of that lab should occupy a seat for this task, instead of always seating the top model.
//
//   triageSeat({role, task, turn, asker?}) -> {seat, record}
//
// The asker answers one question in one call. It may only choose from the lab's own registry models, listed with
// their declared class. Its answer is a routing input, never trusted further than that:
//   - an answer that is not one of the listed models, or is not parseable, is not followed: the seat STARTS LOW (the
//     lowest-class option) and the record says why. Escalation after a rejection is unchanged and can still climb;
//   - the record keeps who was asked, the options, the answer's digest, the choice and whether it was a fallback.
// Nothing here calls a provider except through `turn`. Scripted tests show the plumbing; they say nothing about how
// well a live model triages.
import { createHash } from "node:crypto";
import { MODELS, modelId } from "../config/models.mjs";
import { CLASSES } from "./frontier.mjs";

export const TRIAGE = "pantheon.seat-triage/v1";
/** Who is asked for each role: the lab the role's ladder sits on, and that lab's cheap default. */
export const TRIAGE_ASKERS = Object.freeze({
  planner: { vendor: "anthropic", model: modelId("anthropic", "sonnet") },
  implementer: { vendor: "openai", model: modelId("openai", "luna") },
});
const sha = s => "sha256:" + createHash("sha256").update(String(s)).digest("hex");
const rank = model => CLASSES.order.indexOf(CLASSES.models[model]?.class);

/** The models of `vendor`'s registry that have a declared class, lowest class first (registry order within a class). */
export function triageOptions(vendor) {
  return Object.values(MODELS[vendor] ?? {}).filter(m => rank(m) >= 0).map((model, i) => ({ model, class: CLASSES.models[model].class, i }))
    .sort((a, b) => rank(a.model) - rank(b.model) || a.i - b.i).map(({ model, class: c }) => ({ model, class: c }));
}
export function triagePrompt({ role, task, options }) {
  return [`You are choosing which model should occupy the ${role} seat for one task. Not every task needs the strongest model.`,
    `TASK:\n${String(task).slice(0, 4000)}`,
    `OPTIONS (weakest and cheapest first):\n${options.map(o => `- ${o.model} (${o.class})`).join("\n")}`,
    `Choose the cheapest option you expect to do this task correctly. Reply with JSON only: {"model": "<one option, exactly as written>", "reason": "<one sentence>"}`].join("\n\n");
}
export async function triageSeat({ role, task, turn, asker = TRIAGE_ASKERS[role] }) {
  if (!asker) throw new Error(`triageSeat: no asker is configured for role "${role}"`);
  const options = triageOptions(asker.vendor);
  if (!options.length) throw new Error(`triageSeat: ${asker.vendor} has no classed registry model`);
  const prompt = triagePrompt({ role, task, options });
  let text = "", error = null;
  try { text = (await turn({ vendor: asker.vendor, model: asker.model, prompt, seat: { ...asker, role: "triage" } }))?.text ?? ""; }
  catch (e) { error = String(e?.message ?? e).slice(0, 200); }
  let named = null, reason = null;
  try { const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); named = typeof j.model === "string" ? j.model.trim() : null; reason = typeof j.reason === "string" ? j.reason.slice(0, 300) : null; } catch { /* not JSON */ }
  const chosen = options.find(o => o.model === named) ?? null;
  const fallback = chosen ? null : error ? `the asker failed (${error})` : named ? `"${named}" is not one of the options` : "the answer names no option";
  const pick = chosen ?? options[0];
  const record = { schema: TRIAGE, role, asker, options, prompt_sha: sha(prompt), answer_sha: sha(text), named, reason,
    chosen: pick.model, class: pick.class, fallback: fallback ? `started low: ${fallback}` : null };
  return { seat: { vendor: asker.vendor, model: pick.model }, record };
}
