// THE FIVE-STAGE SPECIALIST PIPELINE over a multi-file work-unit DAG: the orchestrator.
//
//   Stage 1  plan          work_units (work-units.mjs) — validated here, authored upstream by the planner
//   Stage 2  dispatch      dispatcher specialist + frozen rubric; controller locks, waves, worktrees (dispatch.mjs)
//   Stage 3  implement     one specialist per unit in its own worktree, behind the write jail (implement.mjs)
//   Stage 4  subagents     the per-unit A2A leaf shim (a2a-shim.mjs)
//   Stage 5  review        pinned to the Stage 2 model; ground truth from verify_cmd; the ladder (review.mjs)
//
// Inputs: runPipeline({repo, base, plan, seats, turns, limits, dir, signal, planner?, run_id?, sameModel?}).
// Seats and turns are INJECTED: this module imports no routing table, no vendor SDK and calls no provider.
// Outputs: the run record (schema pantheon.pipeline/v1), returned and written INCREMENTALLY to <dir>/pipeline.json
// after every step, so a crash leaves a truthful record of what had happened.
//
// The controller here is code ({vendor: "controller"}): it decides what is dispatched, kept, merged and skipped.
//
// Must never: merge a unit that was not approved against a passing verify_cmd; run a unit whose upstream did not
// merge; exceed an injected limit; let an injected function mutate the frozen unit; block the event loop on git.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CAPABILITIES, PIPELINE_SCHEMA, clone, now, sameSeat, seatRefusal, sha256 } from "./util.mjs";
import { validateWorkUnits } from "./work-units.mjs";
import { bindWorktree, lockConflicts, releaseWorktree, runDispatcher, upstreamOf, waves, CONTROLLER } from "./dispatch.mjs";
import { runImplementer } from "./implement.mjs";
import { startA2AShim } from "./a2a-shim.mjs";
import { escalate, reviewerLadderRefusal, runReviewer } from "./review.mjs";
import { arbitersOf, contributionsOf } from "./record.mjs";
import { git, mutex } from "./git.mjs";

export { contributionsOf, arbitersOf } from "./record.mjs";
export { PIPELINE_SCHEMA, CAPABILITIES } from "./util.mjs";
export { validateWorkUnits, parseWorkUnits, PLANNER_PROMPT, WORK_UNITS_SCHEMA } from "./work-units.mjs";
export { pathsOverlap, lockConflicts, waves, rubricHash } from "./dispatch.mjs";
export { escalate } from "./review.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  max_provider_calls: 200,          // every injected turn, of every role, in the whole run
  max_concurrent_units: 4,          // units active at once inside a wave
  max_revisions: 3,                 // per unit: implementer attempts after the first
  reviewer_escalation_after: 2,     // consecutive rejections by one reviewer before the reviewer is raised
  verify_timeout_ms: 120000,
  verify_output_bytes: 65536,
  max_diff_bytes: 400000,
  a2a_max_calls: 8,                 // per unit
  a2a_max_bytes: 262144,            // per unit, questions + answers
  judge_vendor: "openai",           // the vendor of the dispatcher and of every reviewer rung
  scratch_paths: [],                // tool droppings the write jail deletes (and lists) instead of counting
});
const FINAL = new Set(["approved", "returned", "blocked", "refused", "failed", "skipped"]);

/**
 * Run a plan through the pipeline.
 *
 *   repo     path of the git repository
 *   base     the commit-ish every unit starts from
 *   plan     {work_units: [...]} (Stage 1 output)
 *   planner  {vendor, model, served_model?} of the model that wrote the plan (the `plan` contribution); optional,
 *            and recorded as unnamed when absent
 *   seats    {dispatcher(unit) -> seat, implementer(unit) -> {seat, ladder}, subagent(unit, role) -> seat,
 *             reviewerLadder(dispatcherSeat) -> [seat, ...]}; a seat is {vendor, model, ...}
 *   turns    {dispatcher, implementer, subagent, reviewer}: async (args) -> {text, served_model, served_model_source?}
 *   limits   overrides of DEFAULT_LIMITS
 *   dir      where pipeline.json, the unit patches and the worktrees go
 *
 * Returns the run record. status: "completed" (every unit approved and merged), "incomplete" (some unit was not),
 * "refused" (the plan or the run's inputs were refused; nothing ran) or "failed".
 */
export async function runPipeline({ repo, base, plan, seats, turns, limits = {}, dir, signal = null, planner = null, run_id = null, sameModel = undefined }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  await mkdir(dir, { recursive: true });
  const run = {
    schema: PIPELINE_SCHEMA, run_id: run_id ?? randomBytes(6).toString("hex"), status: "running", reason: null, started_at: now(), ended_at: null,
    controller: { ...CONTROLLER }, repo, base: { ref: base, commit: null }, integration: null, planner: planner ? clone(planner) : null,
    plan: clone(plan ?? null), refusals: [], waves: [], limits: clone(lim), units: {},
    contributions: [], arbiters: [], provider_calls: { total: 0, refused_at_limit: 0, by_role: { dispatcher: 0, implementer: 0, subagent: 0, reviewer: 0 } },
  };

  // The record is written after every step. Writes are queued so they land in order; each is a whole-file replace.
  let writing = Promise.resolve();
  const file = join(dir, "pipeline.json");
  const save = () => {
    run.contributions = contributionsOf(run); run.arbiters = arbitersOf(run);
    const text = JSON.stringify(run, null, 2) + "\n";
    writing = writing.then(async () => { await writeFile(file + ".tmp", text); await rename(file + ".tmp", file); }).catch(() => {});
    return writing;
  };
  const end = async (status, reason = null) => { Object.assign(run, { status, reason, ended_at: now() }); await save(); return run; };
  const refuse = (refusals) => { run.refusals = refusals; return end("refused", refusals.map(r => r.message).join("; ")); };

  // ---- inputs
  for (const [k, list] of [["seats", ["dispatcher", "implementer", "subagent", "reviewerLadder"]], ["turns", ["dispatcher", "implementer", "subagent", "reviewer"]]]) {
    const have = k === "seats" ? seats : turns;
    const missing = list.filter(n => typeof have?.[n] !== "function");
    if (missing.length) return refuse([{ code: "INPUT", unit_id: null, message: `${k} must provide function(s): ${missing.join(", ")}` }]);
  }
  const v = validateWorkUnits(plan);
  if (!v.ok) return refuse(v.refusals);
  const units = v.units, byId = new Map(units.map(u => [u.unit_id, u]));
  const conflicts = lockConflicts(units);
  if (conflicts.length) return refuse(conflicts.map(c => ({ code: c.code, unit_id: c.a, message: c.message })));
  run.waves = waves(units);
  const up = upstreamOf(units);
  const waveOf = new Map(run.waves.flatMap((w, i) => w.map(id => [id, i])));
  for (const u of units) run.units[u.unit_id] = {
    unit_id: u.unit_id, status: "pending", reason: null, wave: waveOf.get(u.unit_id), depends_on: [...u.depends_on].sort(), owned_paths: [...u.owned_paths], planned: clone(u),
    started_at: null, ended_at: null, worktree: null, worktree_removed: null, base_commit: null, dispatch: null, implementer_ladder: null, reviewer_ladder: null,
    attempts: [], a2a: { calls: [], usage: null }, reviews: [], escalations: [], findings: [], reviewer_fed_revision: false, commit: null, patch_digest: null, merged: false,
  };
  const head = await git(repo, ["rev-parse", "--verify", `${base}^{commit}`], { allowFail: true });
  if (head.code !== 0) return refuse([{ code: "BASE", unit_id: null, message: `base "${base}" is not a commit of ${repo}` }]);
  run.base.commit = head.stdout.trim();

  // ---- provider-call budget: every injected turn passes through here
  const counted = role => async args => {
    if (signal?.aborted) throw Object.assign(new Error("the run was aborted"), { code: "ABORTED" });
    if (run.provider_calls.total >= lim.max_provider_calls) { run.provider_calls.refused_at_limit += 1; throw Object.assign(new Error(`the run's provider-call bound (${lim.max_provider_calls}) is exhausted`), { code: "PROVIDER_LIMIT" }); }
    run.provider_calls.total += 1; run.provider_calls.by_role[role] += 1;
    return turns[role](args);
  };
  const T = { dispatcher: counted("dispatcher"), implementer: counted("implementer"), subagent: counted("subagent"), reviewer: counted("reviewer") };

  const lock = mutex();
  const patches = new Map();   // unit_id -> the approved unit's patch against its own base
  const integrationPath = join(dir, "worktrees", "_integration"), branch = `pantheon/pipeline/${run.run_id}`;
  await mkdir(join(dir, "worktrees"), { recursive: true });
  await mkdir(join(dir, "units"), { recursive: true });
  try {
    await lock(() => git(repo, ["worktree", "add", "-q", "-b", branch, integrationPath, run.base.commit]));
    run.integration = { branch, head: run.base.commit, merged: [] };
    await save();

    for (const wave of run.waves) {
      // A unit runs only on top of upstream units that were approved AND merged.
      const runnable = [];
      for (const id of wave) {
        const bad = byId.get(id).depends_on.map(d => run.units[d]).find(d => !(d.status === "approved" && d.merged));
        if (signal?.aborted) finish(run.units[id], "skipped", "the run was aborted before this unit started");
        else if (bad) finish(run.units[id], "skipped", `upstream unit ${bad.unit_id} ended ${bad.status}${bad.reason ? `: ${bad.reason}` : ""}`);
        else runnable.push(id);
      }
      await save();
      await pool(runnable, lim.max_concurrent_units, id => runUnit(byId.get(id)).catch(e => { finish(run.units[id], "failed", String(e?.message ?? e)); }).then(save));

      // Merge the wave's approved units onto the integration branch, in unit_id order. Their owned paths are
      // disjoint, so every patch must apply cleanly; one that does not is refused, not resolved.
      for (const id of [...wave].sort()) {
        const u = run.units[id];
        if (u.status !== "approved") continue;
        const patch = patches.get(id);
        if (patch) {
          const check = await git(integrationPath, ["apply", "--index", "--check", "--whitespace=nowarn", "-"], { input: patch, allowFail: true });
          if (check.code !== 0) { patches.delete(id); finish(u, "refused", `merge conflict on the integration branch: ${check.stderr.trim().slice(0, 500)}`); u.code = "MERGE_CONFLICT"; await save(); continue; }
          await git(integrationPath, ["apply", "--index", "--whitespace=nowarn", "-"], { input: patch });
          await git(integrationPath, ["commit", "--no-verify", "-q", "-m", `pantheon pipeline ${run.run_id}: unit ${id}`]);
        }
        u.merged = true;
        run.integration.head = (await git(integrationPath, ["rev-parse", "HEAD"])).trim();
        run.integration.merged.push(id);
        await save();
      }
    }
  } catch (e) {
    for (const u of Object.values(run.units)) if (!FINAL.has(u.status)) finish(u, u.status === "pending" ? "skipped" : "failed", `the run failed: ${String(e?.message ?? e)}`);
    await releaseWorktree({ repo, path: integrationPath, lock }).catch(() => {});
    return end("failed", String(e?.message ?? e));
  }
  await releaseWorktree({ repo, path: integrationPath, lock }).catch(() => {});
  const all = Object.values(run.units);
  return end(all.every(u => u.status === "approved" && u.merged) ? "completed" : "incomplete", null);

  // ------------------------------------------------------------------------------------------------ helpers

  function finish(u, status, reason = null) { Object.assign(u, { status, reason, ended_at: now() }); }

  async function runUnit(planned) {
    const u = run.units[planned.unit_id];
    Object.assign(u, { status: "dispatching", started_at: now() });

    // ---- Stage 2: the dispatcher specialist, then the frozen rubric
    const dSeat = clone(seats.dispatcher(clone(planned)));
    const seatWhy = seatRefusal(dSeat) ?? (dSeat.vendor !== lim.judge_vendor ? `the dispatcher seat is on ${dSeat.vendor}; the dispatcher and its reviewers are ${lim.judge_vendor} seats` : null);
    if (seatWhy) return finish(u, "refused", seatWhy);
    u.dispatch = await runDispatcher({ unit: clone(planned), plan: clone(units), seat: dSeat, turn: T.dispatcher, signal, sameModel });
    await save();
    if (u.dispatch.status === "returned") return finish(u, "returned", u.dispatch.why);
    if (u.dispatch.status !== "dispatched") return finish(u, "blocked", u.dispatch.why);
    // The unit as dispatched. Frozen: injected functions get copies, and Stage 5 re-hashes it against rubric_hash.
    const unit = Object.freeze({ ...clone(planned), specialist_role: u.dispatch.specialist_role, difficulty: u.dispatch.difficulty });
    const frozen = () => ({ ...clone(unit), rubric: [...u.dispatch.rubric] });

    const impl = seats.implementer(frozen());
    const iWhy = seatRefusal(impl?.seat);
    if (iWhy) return finish(u, "refused", `implementer: ${iWhy}`);
    let iLadder = (impl.ladder?.length ? impl.ladder : [impl.seat]).map(clone);
    if (iLadder.some(s => seatRefusal(s))) return finish(u, "refused", "implementer ladder: every rung is a seat {vendor, model}");
    if (!iLadder.some(s => sameSeat(s, impl.seat))) iLadder = [clone(impl.seat), ...iLadder];
    const rLadder = (seats.reviewerLadder(clone(dSeat)) ?? []).map(clone);
    const rWhy = reviewerLadderRefusal(rLadder, dSeat);
    if (rWhy) return finish(u, "refused", rWhy);
    u.implementer_ladder = iLadder; u.reviewer_ladder = rLadder;

    // ---- the controller binds ONE worktree: base + the merged results of the unit's upstream, in wave order
    const upstream = [...up.get(unit.unit_id)].sort((a, b) => waveOf.get(a) - waveOf.get(b) || (a < b ? -1 : 1)).map(id => ({ unit_id: id, patch: patches.get(id) ?? "" }));
    const path = join(dir, "worktrees", unit.unit_id);
    let shim = null, bound = false;
    try {
      const wt = await bindWorktree({ repo, base: run.base.commit, path, upstream, lock });
      bound = true;
      Object.assign(u, { status: "active", worktree: path, base_commit: wt.base_commit });
      // ---- Stage 4: the unit's subagent leaf, up for exactly as long as the unit is active. It is never told `path`.
      shim = await startA2AShim({ unit_id: unit.unit_id, allowed_subagents: unit.allowed_subagents, seatFor: role => seats.subagent(frozen(), role), subagentTurn: T.subagent,
        limits: { max_calls: lim.a2a_max_calls, max_bytes: lim.a2a_max_bytes }, sandbox: CAPABILITIES.subagent, signal,
        onCall: rec => { u.a2a.calls.push(rec); u.a2a.usage = shim?.usage() ?? null; save(); } });
      await save();

      let state = { revisions: 0, implementer_level: iLadder.findIndex(s => sameSeat(s, impl.seat)), reviewer_level: 0, consecutive_rejections: 0 };
      const cfg = { max_revisions: lim.max_revisions, reviewer_escalation_after: lim.reviewer_escalation_after, implementer_rungs: iLadder.length, reviewer_rungs: rLadder.length };
      let checkpoint = wt.base_commit, findings = [];
      for (let n = 1; ; n++) {
        // ---- Stage 3
        const a = await runImplementer({ unit: frozen(), worktree: path, seat: iLadder[state.implementer_level], ladder: iLadder, turn: T.implementer, a2a: { url: shim.url, token: shim.token },
          attempt: n, findings: [...findings], rubric: [...u.dispatch.rubric], checkpoint, scratch_paths: lim.scratch_paths, signal });
        u.attempts.push(a);
        await save();
        let event, review = null;
        if (a.status !== "written") {
          if (a.code === "PROVIDER_LIMIT" || a.code === "TURN_FAILED" && signal?.aborted) return finish(u, "blocked", a.why);
          event = "attempt_refused"; findings = [a.why];
          u.findings.push({ attempt: n, source: "controller", code: a.code, findings: [a.why] });
        } else {
          checkpoint = a.checkpoint;
          // ---- Stage 5
          const level = state.reviewer_level;
          review = await runReviewer({ unit: clone(unit), worktree: path, base_commit: wt.base_commit, checkpoint, seat: rLadder[level], turn: T.reviewer,
            dispatch: { rubric: [...u.dispatch.rubric], rubric_hash: u.dispatch.rubric_hash }, limits: lim, pinned: level === 0, level, attempt: n, signal, sameModel });
          u.reviews.push(review);
          await save();
          if (review.status === "approved") break;
          if (review.status === "rubric_mismatch") return finish(u, "refused", review.why);
          if (review.status === "not_admitted" || review.status === "diff_too_large") {
            if (review.feedback.length) u.findings.push({ attempt: n, source: "controller", code: review.code, findings: review.feedback });
            return finish(u, "blocked", review.why);
          }
          event = "rejected"; findings = review.feedback;
          u.findings.push({ attempt: n, source: review.status === "request_changes" ? "reviewer" : "controller", code: review.status, vendor: review.vendor, model: review.model, findings: review.feedback });
        }
        const step = escalate(state, event, cfg);
        if (step.action === "blocked") return finish(u, "blocked", `${step.why}; ${u.findings.reduce((k, f) => k + f.findings.length, 0)} finding(s) retained`);
        // The findings now go to a revision. A REVIEWER whose finding does so becomes a `critique` contributor for
        // any later, separate review — and stays this unit's Stage 5 reviewer here (record.mjs).
        if (review?.status === "request_changes") { review.fed_revision = true; u.reviewer_fed_revision = true; }
        for (const e of step.escalations) {
          const ladder = e.kind === "implementer" ? iLadder : rLadder;
          u.escalations.push({ after_attempt: n, kind: e.kind, from: clone(ladder[e.from]), to: clone(ladder[e.to]) });
        }
        state = step.state;
        await save();
      }

      // ---- approved: the unit's result is its checkpoint commit; its patch is what merges
      const patch = await git(path, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", wt.base_commit, checkpoint]);
      patches.set(unit.unit_id, patch);
      await writeFile(join(dir, "units", `${unit.unit_id}.patch`), patch);
      Object.assign(u, { commit: checkpoint, patch_digest: sha256(patch) });
      finish(u, "approved");
    } finally {
      if (shim) { u.a2a.usage = shim.usage(); await shim.close(); }
      if (bound) u.worktree_removed = await releaseWorktree({ repo, path, lock }).catch(() => false);
    }
  }
}

/** Run `fn` over `items` with at most `width` in flight. */
async function pool(items, width, fn) {
  const queue = [...items];
  const worker = async () => { while (queue.length) await fn(queue.shift()); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
}
