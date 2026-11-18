// THE RUN RECORD's governance projections: who AUTHORED the change, and who only ARBITRATED it.
//
// OWNER GOVERNANCE DECISION (2026-11-17) — FOR INDEPENDENT REVIEW. The Stage 2 dispatcher is a NON-AUTHORING
// ARBITER: it shapes the acceptance rubric and writes none of the work. It is therefore absent from
// contributionsOf(run) and present in arbitersOf(run). The consequence, under model-level review independence
// (review/identity.mjs: a reviewer may not be a contributing MODEL), is that the exact Stage 2 OpenAI model is
// permitted — and pinned — to perform the Stage 5 review of the unit it dispatched. An independent review should
// examine exactly this: whether writing the rubric a change is judged by is, or is not, a contribution to it. The
// code takes the owner's answer (it is not) and keeps the two lists apart so either answer can be evaluated from a
// recorded run: contributionsOf(run) is the owner's rule; [...contributionsOf(run), ...arbitersOf(run)] the stricter one.
//
// THE NUANCE. A Stage 5 reviewer whose FINDING was fed to an implementer revision has shaped the work: it IS a
// `critique` contributor for any later, separate review (the existing rule of this repository). Inside the pipeline
// it nevertheless STAYS the pinned Stage 5 reviewer of that unit (the owner pins it); the unit record says so with
// `reviewer_fed_revision: true`.
//
// Inputs: a run record (pantheon.pipeline/v1, as written to pipeline.json). Outputs: sorted, de-duplicated lists of
// {kind, unit_id, role, vendor, model, served_model}, shaped for review/identity.mjs contributorKeys().
//
// Must never: list an arbiter as a contributor, or drop a reviewer whose finding reached a revision.

const key = c => [c.kind, c.unit_id ?? "", c.vendor ?? "", c.model ?? "", c.served_model ?? ""].join("\u0000");
const sorted = list => [...new Map(list.map(c => [key(c), c])).values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const units = run => Object.values(run?.units ?? {});

/**
 * The AUTHORING contributions of a run, and nothing else:
 *   plan      the planner that wrote the work units (a planner the run does not name is listed with null vendor and
 *             model: review/identity.mjs then reports it unresolved and no reviewer qualifies, which is the truth);
 *   work      every implementer attempt whose writes passed the jail and reached the unit's worktree;
 *   subtask   every subagent call whose answer was returned to the implementer;
 *   critique  every reviewer whose finding was fed to an implementer revision.
 */
export function contributionsOf(run) {
  const out = [];
  const p = run?.planner ?? null;
  out.push({ kind: "plan", unit_id: null, role: "planner", vendor: p?.vendor ?? null, model: p?.model ?? null, served_model: p?.served_model ?? null });
  for (const u of units(run)) {
    for (const a of u.attempts ?? []) if (a.status === "written") out.push({ kind: "work", unit_id: u.unit_id, role: "implementer", vendor: a.vendor, model: a.model, served_model: a.served_model ?? null });
    for (const c of u.a2a?.calls ?? []) if (c.status === "answered") out.push({ kind: "subtask", unit_id: u.unit_id, role: `subagent:${c.role}`, vendor: c.vendor, model: c.model, served_model: c.served_model ?? null });
    for (const r of u.reviews ?? []) if (r.fed_revision) out.push({ kind: "critique", unit_id: u.unit_id, role: "reviewer", vendor: r.vendor, model: r.model, served_model: r.served_model ?? null });
  }
  return sorted(out);
}

/** The NON-AUTHORING arbiters of a run: each unit's admitted Stage 2 dispatcher turn, with the rubric it froze. */
export function arbitersOf(run) {
  const out = [];
  for (const u of units(run)) {
    const d = u.dispatch;
    if (!d || !d.served_model) continue;   // a dispatcher turn that was never admitted arbitrated nothing
    out.push({ kind: "arbiter", unit_id: u.unit_id, role: "dispatcher", standing: "arbiter", authored: false, vendor: d.vendor, model: d.model, served_model: d.served_model, rubric_hash: d.rubric_hash });
  }
  return sorted(out);
}
