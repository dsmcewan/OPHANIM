// The REVIEWED CONTRIBUTION SCOPE (owner audit RS2, docs/reviews/2026-11-16-workflow-handoffs/CURRENT_STATE.md;
// control contract "Functional roles and valid worker escalation" and "Mandatory cross-model accountability").
//
// Review independence follows the contributions that reached what is judged -- not role labels. A seat called
// `planner` is excluded from reviewing because its output reached the reviewed bytes, not because it "assigned" the
// work (assignment, scheduling and shipping are deterministic code). A contribution in one scope does not make a
// model's lab a permanent reviewer prohibition elsewhere.
//
// Scopes:
//   artifact  one slot's bytes, as the in-run checker judges them (run-item.mjs)
//   change    the committed change base..head, as the review cycle judges it (operate.mjs)
// Both include every contribution that reached the bytes. In this pipeline that is:
//   work   the worker's reply IS the artifact bytes
//   plan   the planner's TITLE becomes the work_item every worker reads (board/project.mjs PROJECTIONS.worker kinds
//          include work_item), and every work turn cites the plan turn on the ledger (run-item recordTurn)
//   critique  (86ce18a review, defect 3) a reviewer whose findings were put in a revision prompt ("the reviewer
//          REQUESTED CHANGES (address them)") shaped the revised bytes. Such a turn is marked `revision_input: true`
//          (run-item.mjs records it on the slot's contributors when the findings reach the worker); a critique whose
//          text reached no prompt is not a contribution, and is excluded with that reason.
// Not a contribution, with the reason recorded:
//   scout  its evidence is linked from the ticket entry, but the planner's prompt is the ticket goal only and the
//          worker's projection admits no scout/hypothesis kinds, so no scout output reaches the bytes
//
// Inputs: turns ({purpose, vendor, model, served_model?, slot?, turn?}). Outputs: a scope record naming its kind,
// contributions (each with the path by which it reached the bytes), the excluded turns with reasons, and the
// author labs. Must never: drop a contribution to make a reviewer panel possible (a shortage is pending, not a
// smaller scope), or exclude a lab for a role it held in another scope.
import { labOf } from "../config/models.mjs";
import { PROJECTIONS } from "../board/project.mjs";

export const SCOPE_SCHEMA = "pantheon.review-scope/v1";
export const SCOPES = Object.freeze({
  artifact: "one slot's bytes as the in-run checker judges them, with every contribution that reached them",
  change: "the committed change (base..head) as the review cycle judges it, with every contribution that reached it",
});

// How each kind of turn reaches the reviewed bytes, derived from the projections the pipeline actually enforces.
export function contributionPaths(projections = PROJECTIONS) {
  const workerReads = projections.worker?.kinds ?? [];
  return {
    work: { contributes: true, via: "the worker's reply is the artifact bytes" },
    plan: workerReads.includes("work_item")
      ? { contributes: true, via: "the planner's title becomes the work_item the worker reads (PROJECTIONS.worker), and the work turn cites the plan turn" }
      : { contributes: false, via: "the worker's projection does not admit the work_item, so no plan output reaches the bytes" },
    scout: { contributes: false, via: "scout evidence reaches neither the planner prompt (the ticket goal only) nor the worker's projection" },
    critique: { contributes: true, via: CRITIQUE_VIA },
  };
}
/** How a critique reached the bytes, when it did (run-item.mjs records it with this path). */
export const CRITIQUE_VIA = "the reviewer's findings were given to the worker as revision input";
const CRITIQUE_INERT = "a critique whose text reached no revision prompt does not reach the bytes";

/**
 * The scope record for `kind` over `turns`. For `artifact`, `slot` limits work turns to that slot (a plan turn is
 * shared by every slot). Every turn is either a contribution or an exclusion with its reason.
 */
export function reviewScope({ kind, turns, slot = null, projections = PROJECTIONS }) {
  if (!Object.hasOwn(SCOPES, kind)) throw new Error(`unknown review scope "${kind}" (known: ${Object.keys(SCOPES).join(", ")})`);
  const paths = contributionPaths(projections);
  const contributions = [], excluded = [];
  for (const t of turns) {
    const path = t.purpose === "critique" && t.revision_input !== true ? { contributes: false, via: CRITIQUE_INERT } : paths[t.purpose];
    const row = { purpose: t.purpose, vendor: t.vendor, model: t.served_model ?? t.model ?? null, lab: labOf(t.vendor, t.served_model ?? t.model ?? null),
      ...(t.slot ? { slot: t.slot } : {}), ...(t.turn ? { turn: t.turn } : {}) };
    if (!path) { excluded.push({ ...row, why: `a ${t.purpose} turn has no path to the reviewed bytes` }); continue; }
    if (kind === "artifact" && t.purpose === "work" && slot !== null && t.slot !== undefined && t.slot !== slot) {
      excluded.push({ ...row, why: `another slot's bytes (${t.slot}), outside this artifact` }); continue;
    }
    (path.contributes ? contributions : excluded).push({ ...row, [path.contributes ? "via" : "why"]: path.via });
  }
  const author_labs = [...new Set(contributions.map(c => c.lab).filter(Boolean))].sort();
  return { schema: SCOPE_SCHEMA, kind, ...(slot !== null ? { slot } : {}), what: SCOPES[kind], contributions, excluded, author_labs };
}
