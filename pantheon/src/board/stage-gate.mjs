// Q3 + Q4: a stage of a run may start only when the board agrees it should.
//
// runOpenItem drives intake -> plan -> work -> review -> ship in order. That order is a script, not
// the loop: nothing made a stage wait for the controller to schedule it, and the chair contracts in
// team/ (patterns, laws) were checked only by their own tests. This module puts both on the path that
// produces evidence, as checks: the stage order is unchanged, and a stage the board would not run
// fails closed with the board's own reason.
//
//   chair    patternFor(boardStatus) must include the chair this stage occupies   (team/modes.mjs)
//   trigger  schedule() must hold this stage's knowledge source as ready         (board/controller.mjs)
//   law      the action must pass the law table, and at least one law must apply (team/law.mjs)
import { boardState, boardStatus, schedule } from "./controller.mjs";
import { patternFor } from "../team/modes.mjs";
import { enforce } from "../team/law.mjs";

export const STAGES = Object.freeze({
  plan:     { chair: "lead@orch",    ks: "plan" },
  work:     { chair: "impl@build",   ks: "work" },
  critique: { chair: "check@review", ks: "critique" },
  ship:     { chair: null,           ks: "integrate" },   // the controller's transaction, not a chair's
  // The swarm layers, on the board: on-request chairs, opened by the lead and capped (team/roster.mjs).
  explore:    { chair: "scout@opt",     ks: "explore" },
  refute:     { chair: "scout@opt",     ks: "refute" },
  synthesize: { chair: "arbiter@judge", ks: "synthesize" },
});

export class StageRefused extends Error {
  constructor(stage, why, detail = {}) { super(`${stage}: ${why}`); this.stage = stage; this.detail = detail; }
}

/**
 * What the board says about starting `stage` now. `match` narrows the trigger to the candidate
 * this stage is about to serve (an item key, an offered slot). Pure over the board; never throws.
 */
export function stageCheck({ store, refs, runtime = null, ref, stage, match = () => true }) {
  const spec = STAGES[stage];
  if (!spec) return { ok: false, stage, why: `unknown stage "${stage}"` };
  const state = boardState({ store, refs, runtime, ref });
  const status = boardStatus({ store, state });
  const pattern = spec.chair ? patternFor(status) : null;
  const sched = schedule({ store, refs, runtime, ref });
  // A candidate the scheduler deferred only because another candidate of the same stage holds the
  // shared resource is still eligible: ship() integrates every slot in ONE transaction on "tree".
  const deferred = sched.dropped.filter(d => d.ks === spec.ks && d.item && /already claims/.test(d.why));
  const ready = [...sched.ready, ...deferred].filter(r => r.ks === spec.ks && match(r));
  const dropped = sched.dropped.filter(d => d.ks === spec.ks && !deferred.includes(d)).map(d => d.why);
  const why = [];
  if (spec.chair && !pattern.ok) why.push(pattern.why);
  else if (spec.chair && !pattern.chairs.includes(spec.chair)) {
    why.push(`board status "${status.status}" runs the ${pattern.pattern} pattern through ${pattern.chairs.join(", ")}, not ${spec.chair}`);
  }
  if (!ready.length) why.push(`the controller does not schedule ${spec.ks}: ${dropped.join("; ") || "no matching candidate"}`);
  return { ok: why.length === 0, stage, chair: spec.chair, status: status.status, pattern: pattern?.pattern ?? null,
    scheduled: ready.map(r => r.why), candidates: ready, dropped, why: why.join(" | ") || null };
}

/** Throwing form, recorded by the caller as the stage's error. */
export function assertStage(args) {
  const r = stageCheck(args);
  if (!r.ok) throw new StageRefused(args.stage, r.why, r);
  return r;
}

/** A law check that refuses a violation AND a vacuous pass, where no law applied at all. */
export function assertLaw(action, state = {}) {
  const r = enforce(action, state);
  if (!r.ok || r.vacuous) throw new StageRefused(action.kind, r.why ?? "no law applied; that is not a pass", r);
  return r;
}
