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
// OWNER DECISION 2026-11-19 (Decision 6, docs/review-independence.md): the exception is SCOPED to the pinned Stage 5
// review of the dispatcher's own unit (and that unit's bounded revision sequence). The dispatcher stays a non-authoring
// arbiter -- it is still absent from contributionsOf -- but its requested and serving identities, as arbitersOf lists
// them, are EXCLUDED from the later three-lab change review and from the validator of any change its rubric governed
// (ophanim/operate/stages.mjs adds them as `purpose: 'arbiter'` rows). "Permission to judge whether one's own rubric
// was followed does not grant independence to judge whether that rubric was sufficient."
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

// The key is every identity field a row carries: two calls of one model served under two markers stay two rows, so no
// served_model_source is dropped by de-duplication (wave 3, L-504 invariant 2). `model` is the name asked (the seat).
const key = c => [c.kind, c.unit_id ?? "", c.vendor ?? "", c.model ?? "", c.served_model ?? "", c.served_model_source ?? ""].join("\u0000");
const sorted = list => [...new Map(list.map(c => [key(c), c])).values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const units = run => Object.values(run?.units ?? {});

/**
 * The AUTHORING contributions of a run, and nothing else:
 *   plan      the planner that wrote the work units (a planner the run does not name is listed with null vendor and
 *             model: review/identity.mjs then reports it unresolved and no reviewer qualifies, which is the truth);
 *   work      every implementer attempt whose writes passed the jail and reached the unit's worktree;
 *   subtask   every subagent call whose answer was returned to the implementer;
 *   critique  every reviewer whose finding was fed to an implementer revision.
 * A unit RESUMED from a checkpoint made none of these calls in this run: its lineage is the one the checkpoint recorded
 * when the unit was approved (checkpoint.mjs), restored here, so reusing approved work never drops its authors
 * (independent review, assignment 2, questions 6 and 8). A row carries `served_model_source` when the transport marked
 * the served name ("input": the pinned model, not a provider's statement about the answer).
 */
export function contributionsOf(run) {
  const out = [];
  const p = run?.planner ?? null;
  const src = x => (x?.served_model_source ? { served_model_source: x.served_model_source } : {});
  out.push({ kind: "plan", unit_id: null, role: "planner", vendor: p?.vendor ?? null, model: p?.model ?? null, served_model: p?.served_model ?? null, ...src(p) });
  for (const u of units(run)) {
    for (const a of u.attempts ?? []) if (a.status === "written") out.push({ kind: "work", unit_id: u.unit_id, role: "implementer", vendor: a.vendor, model: a.model, served_model: a.served_model ?? null, ...src(a) });
    for (const c of u.a2a?.calls ?? []) if (c.status === "answered") out.push({ kind: "subtask", unit_id: u.unit_id, role: `subagent:${c.role}`, vendor: c.vendor, model: c.model, served_model: c.served_model ?? null, ...src(c) });
    for (const r of u.reviews ?? []) if (r.fed_revision) out.push({ kind: "critique", unit_id: u.unit_id, role: "reviewer", vendor: r.vendor, model: r.model, served_model: r.served_model ?? null, ...src(r) });
    if (u.resumed) for (const c of u.checkpoint?.contributions ?? []) {
      out.push({ kind: c.kind, unit_id: u.unit_id, role: c.role, vendor: c.vendor, model: c.model, served_model: c.served_model ?? null, ...src(c), from_checkpoint: true });
    }
  }
  return sorted(out);
}

/**
 * The NON-AUTHORING arbiters of a run: each unit's admitted Stage 2 dispatcher turn, with the rubric it froze. A unit
 * RESUMED from a checkpoint made no dispatcher call in this run: its arbiter is the dispatch the sealed checkpoint
 * recorded (the rubric that governed the reused patch), marked `from_checkpoint` (owner decision 2026-11-19).
 */
export function arbitersOf(run) {
  const out = [];
  const src = x => (x?.served_model_source ? { served_model_source: x.served_model_source } : {});
  for (const u of units(run)) {
    const d = u.dispatch;
    if (d && d.served_model) {   // a dispatcher turn that was never admitted arbitrated nothing
      out.push({ kind: "arbiter", unit_id: u.unit_id, role: "dispatcher", standing: "arbiter", authored: false, vendor: d.vendor, model: d.model, served_model: d.served_model, ...src(d), rubric_hash: d.rubric_hash });
    }
    const c = u.resumed ? u.checkpoint?.dispatch : null;
    if (c && (c.vendor || c.model)) {
      out.push({ kind: "arbiter", unit_id: u.unit_id, role: "dispatcher", standing: "arbiter", authored: false, vendor: c.vendor ?? null, model: c.model ?? null,
        served_model: c.served_model ?? null, ...src(c), rubric_hash: c.rubric_hash ?? null, from_checkpoint: true });
    }
  }
  return sorted(out);
}
