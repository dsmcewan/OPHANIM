// Shadow selection (docs/reviews/2026-11-17-routing-evaluation/DESIGN.md step 1): beside every role choice the
// dispatcher makes, the seat the OTHER profile would have chosen with the same inputs (argo <-> fit; legacy is
// shadowed by fit, the candidate). Pure: it is a second selectSeat over the same arguments, recorded on the
// selection and never sent to a provider. The primary choice is returned unchanged except for the added
// `shadow`, `agrees` (and `assignment`, when the run has one) on each selection: same seat, same candidates
// in the same order, same policy hash.
import { selectSeat } from "../route/frontier.mjs";

export const SHADOW_OF = Object.freeze({ argo: "fit", fit: "argo", legacy: "fit" });

/**
 * The other profile's choice for `role` over `args` (selectSeat's options without `profile`), as a selection
 * records it: {profile, vendor, model, effort, class?, policy_hash}, or {profile, error} when it admits nothing.
 * `task` is the task profile fit would use (fit needs one; argo and legacy ignore it).
 */
export function shadowSeat(role, { profile, args, task = null }) {
  const other = SHADOW_OF[profile];
  if (!other) return null;
  try {
    const s = selectSeat(role, { ...args, profile: other, task: other === "fit" ? task : null });
    const cls = s.selection?.class?.value;
    return { profile: other, vendor: s.seat.vendor, model: s.seat.model, effort: s.seat.effort ?? null, ...(cls ? { class: cls } : {}), policy_hash: s.selection.policy_hash };
  } catch (e) {
    return { profile: other, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** A choice (selectSeat/withPractice result) with the shadow, agreement and assignment on every selection. */
export function withShadow(choice, shadow, assignment = null) {
  if (!choice || !shadow) return choice;
  const agrees = c => (shadow.error ? null : c.vendor === shadow.vendor && c.model === shadow.model);
  const extra = assignment ? { assignment: { arm: assignment.arm, basis: assignment.basis, randomized: assignment.randomized } } : {};
  const tag = c => ({ ...c, selection: { ...c.selection, shadow, agrees: agrees(c), ...extra } });
  const candidates = (choice.candidates ?? []).map(tag);
  const seat = choice.seat && (choice.seat === choice.candidates?.[0] ? candidates[0] : tag(choice.seat));
  return { ...choice, selection: seat ? seat.selection : { ...choice.selection, shadow, ...extra }, seat, candidates };
}
