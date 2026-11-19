// THE FIVE-STAGE SPECIALIST PIPELINE over a multi-file work-unit DAG: the orchestrator.
//
//   Stage 1  plan          work_units (work-units.mjs) — validated here, authored upstream by the planner
//   Stage 2  dispatch      dispatcher specialist + frozen rubric; controller locks, waves, worktrees (dispatch.mjs)
//   Stage 3  implement     one specialist per unit in its own worktree, behind the write jail (implement.mjs)
//   Stage 4  subagents     an ANTIGRAVITY SDK implementer's subagents are the SDK's own: gemini-4-hydrogen specialists
//                          the controller admits within the implementer model's ceiling (antigravity/subagents.mjs),
//                          recorded on the attempt (attempts[].session.subagents). No shim is opened for such a unit.
//                          A unit whose implementer ladder holds a LANE (the earlier agy CLI transport) gets the per-unit
//                          A2A leaf shim on a Unix socket (a2a-shim.mjs), reached by the agent through the stdio MCP
//                          relay a2a-mcp-server.mjs
//   Stage 5  review        pinned to the Stage 2 model; ground truth from verify_cmd; the ladder (review.mjs)
//
// Inputs: runPipeline({repo, base, plan, seats, turns, limits, dir, signal, planner?, run_id?, sameModel?, checkpoints?, onCharge?}).
// Seats and turns are INJECTED: this module imports no routing table, no vendor SDK and calls no provider.
// Outputs: the run record (schema pantheon.pipeline/v1), returned and written INCREMENTALLY to <dir>/pipeline.json
// after every step, so a crash leaves a truthful record of what had happened. A write that fails is NOT swallowed: the
// next awaited write throws it (code RECORD_WRITE), so the run fails rather than carrying on without its record.
//
// THE CALL BUDGET, PER REQUEST (L-301, self-audit round 3, assignment 3 (sealed bb1287a); the second charge contract of
// sdk/live.mjs). Every injected turn passes through `counted`, which refuses it up front (an aborted run, or a bound
// with no call left, opens no seat) and then charges NOTHING before it: the turn is handed `admitRequest({kind})`, which
// it calls before EVERY provider call at its point of spend -- a lane's worker session between its jail build and its
// spawn, each API request, a metered failover (by_role.metered_failover), a further billed request
// (by_role.continuation), and every request of an SDK implementer's native Hydrogen subagent
// (by_role.native_subagent; the SDK transport's gateway admits each one before it is forwarded). Each admission is bounded by max_provider_calls, charged by `onCharge()` (the caller's ledger
// charge; a throw refuses the call) and on disk before the call. A lane turn that fails before its spawn costs nothing.
// The up-front check RESERVES one call for the turn until its first admission (so concurrent turns cannot all pass it
// and overrun the bound). A turn that does not take the contract (a scripted seat, an older adapter) and returns a
// reply having admitted nothing is charged that one call on return (by_role as its role; one whose late charge the
// caller refused is still counted, and named in provider_calls.late_uncharged), never dropped; the older `charge(what)`
// is still passed and admits a further call the same way.
//
// The controller here is code ({vendor: "controller"}): it decides what is dispatched, kept, merged and skipped.
//
// PER-UNIT CONTROL DIRECTORY. <dir>/control/<unit_id>/ (mode 0700) is created by the controller for every active
// unit, OUTSIDE its worktree, and handed to the implementer turn as `control_dir`. The unit's A2A shim listens on
// <control_dir>/a2a.sock; when that path is over the Unix socket-path bound (SOCKET_PATH_MAX), on a short path in a
// fresh controller-owned directory under os.tmpdir() instead. The path used is recorded (units[id].a2a.socket) and
// the socket file (and a fallback directory) removed when the unit ends.
//
// THE IMPLEMENTER LANE FAILOVER LADDER. A turn that throws code "lane_failure" (kind timeout | exit | stream | spawn)
// is retried on THE SAME lane at most once, then the unit steps down to the next rung of its implementer ladder
// (seats.implementer(unit).ladder); a turn that throws code "quota_exhausted" (the transport's own quota failover
// already failed) steps down at once. Lane failures spend no revision (max_revisions counts Stage 5 rejections and
// refused attempts only) but every call is charged to max_provider_calls. Each failover is an `escalations[]` entry
// of kind "lane_failover"; each failed call is in attempts[].lane_failures [{vendor, model, level, kind, cause, why,
// retry (true: this call was the same-lane retry), next}]. With no rung left the unit ends blocked, code
// LANE_LADDER_EXHAUSTED. A later rejection escalates the thinking level from the rung failover left it on.
// A RUNG is a seat on a transport at a thinking level (implement.mjs sameRung): two levels of one SDK model are two
// rungs, so a rejection raises the level first. A quota refusal, and a model the provider does NOT SERVE (code
// "model_unavailable"; cause "model_unavailable" on the escalation and on lane_failures[]), take the model's other
// levels with them: the unit steps at once to the next rung of ANOTHER model, and the skipped rungs are recorded
// (skipped_same_base). A model is never replaced without that record. A fault of the SDK transport that no rung can
// cure (implement.mjs TRANSPORT_BLOCKERS: the provider refused the key, no key, no jail, no SDK) blocks the unit at once
// with that code: the ladder is not walked.
//
// CHECKPOINTS (checkpoint.mjs). With `checkpoints: {dir}` (a directory that persists across runs of one item),
// every unit approved by Stage 5 is written there; a later run re-verifies a unit's checkpoint (digest, upstream
// trees, and the patch applied on the freshly bound base yielding the recorded tree) and, if it holds, takes the
// unit as approved with `resumed: true` and no provider call. GROUND TRUTH WINS on resume too: the unit's verify_cmd is
// RE-RUN in the rebuilt worktree after the patch is applied, and a checkpoint whose verify fails is rejected even when
// its patch, digest and tree were rewritten to agree with each other (independent review, assignment 3, question 7).
// The checkpoint binds the approval: the rubric hash and the digest of the Stage 5 review record are part of it, and a
// checkpoint without them, or whose verify command is not the unit's, is rejected. A checkpoint that does not hold is
// recorded as `checkpoint_rejected` and the unit runs normally. THE APPROVAL IS AUTHENTICATED (checkpoint.mjs v3): a
// checkpoint is sealed under the controller's checkpoint key (`checkpoints: {dir, key?, keyFile?}`), carries the
// approving review and the dispatch whole, and is resumed only when the seal verifies, the review re-hashes to
// review_digest and reviewed exactly this patch, the rubric hash recomputes from the CURRENT unit, and the recorded
// dispatcher and reviewer are the seats this run would use (independent review, assignment 3 (OpenAI gpt-6-astra
// extra review, 09d490f), question 7).
//
// THE RUN DIRECTORY (<dir>/owner.json) is held by one live run; a run that finds the directory held by a dead one
// removes the worktrees and control directories that run left before it binds its own, and every provider call is on
// <dir>/pipeline.json before it is made (the record is written synchronously).
//
// Must never: merge a unit that was not approved against a passing verify_cmd; run a unit whose upstream did not
// merge; exceed an injected limit; let an injected function mutate the frozen unit; block the event loop on git.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { hostname, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { CAPABILITIES, PIPELINE_SCHEMA, clone, digestOf, now, sameModelName, sameSeat, seatRefusal, sha256 } from "./util.mjs";
import { validateWorkUnits } from "./work-units.mjs";
import { bindWorktree, lockConflicts, releaseWorktree, rubricHash, runDispatcher, upstreamOf, waves, CONTROLLER } from "./dispatch.mjs";
import { runImplementer, sameRung, MCP_SERVER_PATH } from "./implement.mjs";
import { isSdkSeat } from "../antigravity/config.mjs";
import { approvalRefusal, checkpointFile, checkpointKey, checkpointRefusal, readCheckpoint, unitKey, writeCheckpoint } from "./checkpoint.mjs";
import { startA2AShim } from "./a2a-shim.mjs";
import { escalate, reviewerLadderRefusal, runReviewer, runVerify } from "./review.mjs";
import { arbitersOf, contributionsOf } from "./record.mjs";
import { candidateRefusal, contributorKeys, resolveModel, reviewerRefusal } from "../review/identity.mjs";
import { git, repoMutex } from "./git.mjs";
import { laneParts } from "../route/fit-matrix.mjs";

export { contributionsOf, arbitersOf } from "./record.mjs";
export { PIPELINE_SCHEMA, CAPABILITIES } from "./util.mjs";
export { validateWorkUnits, parseWorkUnits, PLANNER_PROMPT, WORK_UNITS_SCHEMA } from "./work-units.mjs";
export { pathsOverlap, lockConflicts, waves, rubricHash } from "./dispatch.mjs";
export { escalate } from "./review.mjs";
export { unitKey, CHECKPOINT_SCHEMA } from "./checkpoint.mjs";
export { MCP_SERVER_PATH, LANE_FAILURE_KINDS, TRANSPORT_BLOCKERS, sameRung } from "./implement.mjs";

/** The longest Unix socket path this platform's sockaddr_un takes (sun_path less its NUL). */
export const SOCKET_PATH_MAX = process.platform === "linux" ? 107 : 103;

/**
 * Where a unit's shim socket goes: <control_dir>/a2a.sock, or — when that is over SOCKET_PATH_MAX bytes — a short
 * path in a fresh controller-owned directory under os.tmpdir(). Returns {file, fallback, dir, wanted}.
 */
export async function a2aSocketFor(control_dir) {
  const wanted = join(control_dir, "a2a.sock");
  if (Buffer.byteLength(wanted) <= SOCKET_PATH_MAX) return { file: wanted, fallback: false, dir: control_dir, wanted };
  const short = await mkdtemp(join(tmpdir(), "pa2a-"));
  const file = join(short, "a2a.sock");
  if (Buffer.byteLength(file) > SOCKET_PATH_MAX) { await rm(short, { recursive: true, force: true }); throw Object.assign(new Error(`no Unix socket path fits ${SOCKET_PATH_MAX} bytes (os.tmpdir() is ${tmpdir()})`), { code: "SOCKET_PATH" }); }
  return { file, fallback: true, dir: short, wanted };
}

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
 *   dir      where pipeline.json, the unit patches, the worktrees and the per-unit control directories go
 *   checkpoints  {dir}: where approved units' checkpoints persist across runs of the same item (optional)
 *   stage5_excluded  [{vendor, model, served_model?, requested_model?}] (optional): identities no unit's Stage 5 rung may be,
 *            except the unit whose own dispatcher it is -- a dispatcher whose advisory return reached the plan of this run
 *            keeps Decision 6's pinned review of its OWN unit only (owner decision L-001 follow-up, 2026-11-19)
 *   deadline the stage's hard end (epoch ms; optional): caps every verify_cmd run and every worker turn's --print-timeout
 *            at what is left of it (independent review round 2, assignment 3 (Google gemini-4-carbon, manual), finding 9)
 *
 * Returns the run record. status: "completed" (every unit approved and merged), "incomplete" (some unit was not),
 * "refused" (the plan or the run's inputs were refused; nothing ran) or "failed".
 */
export async function runPipeline({ repo, base, plan, seats, turns, limits = {}, dir, signal = null, planner = null, run_id = null, sameModel = undefined, checkpoints = null, onCharge = null, deadline = null, stage5_excluded = [] }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  await mkdir(dir, { recursive: true });
  const run = {
    schema: PIPELINE_SCHEMA, run_id: run_id ?? randomBytes(6).toString("hex"), status: "running", reason: null, started_at: now(), ended_at: null,
    controller: { ...CONTROLLER }, repo, base: { ref: base, commit: null }, integration: null, planner: planner ? clone(planner) : null,
    ...(stage5_excluded?.length ? { stage5_excluded: clone(stage5_excluded) } : {}),
    plan: clone(plan ?? null), refusals: [], waves: [], limits: clone(lim), units: {},
    checkpoints: checkpoints?.dir ? { dir: checkpoints.dir, resumed: [], rejected: [], written: [] } : null,
    contributions: [], arbiters: [], provider_calls: { total: 0, refused_at_limit: 0, by_role: { dispatcher: 0, implementer: 0, subagent: 0, reviewer: 0 } },
  };

  // The record is written after every step, SYNCHRONOUSLY (a whole-file replace: temp file, then rename), so the file
  // holds the latest state the moment save() returns -- in particular a provider call's charge is on disk BEFORE the
  // call is made (admit, below): a kill during the call leaves a record that counts it (independent review, assignment
  // 3 (OpenAI gpt-6-astra extra review, 09d490f), question 8). A failed write is kept (the first one) and thrown by
  // this and every later save: never swallowed.
  let writeError = null, owned = false;
  const file = join(dir, "pipeline.json");
  const recordError = () => Object.assign(new Error(`the run record ${file} could not be written: ${writeError.message}`), { code: "RECORD_WRITE", cause: writeError });
  const persist = () => {
    run.contributions = contributionsOf(run); run.arbiters = arbitersOf(run);
    try { writeFileSync(file + ".tmp", JSON.stringify(run, null, 2) + "\n"); renameSync(file + ".tmp", file); } catch (e) { writeError ??= e; }
    return !writeError;
  };
  const save = () => (persist() ? Promise.resolve() : Promise.reject(recordError()));
  const end = async (status, reason = null) => {
    Object.assign(run, { status, reason, ended_at: now() });
    if (owned) { ACTIVE_DIRS.delete(resolve(dir)); rmSync(join(dir, OWNER_FILE), { force: true }); }
    await save(); return run;
  };
  const refuse = (refusals) => { run.refusals = refusals; return end("refused", refusals.map(r => r.message).join("; ")); };

  // ---- inputs
  for (const [k, list] of [["seats", ["dispatcher", "implementer", "subagent", "reviewerLadder"]], ["turns", ["dispatcher", "implementer", "subagent", "reviewer"]]]) {
    const have = k === "seats" ? seats : turns;
    const missing = list.filter(n => typeof have?.[n] !== "function");
    if (missing.length) return refuse([{ code: "INPUT", unit_id: null, message: `${k} must provide function(s): ${missing.join(", ")}` }]);
  }
  // The checkpoint key (checkpoint.mjs): checkpoints are written sealed under it, and only a seal that verifies under
  // it is resumed.
  let ckKey = null;
  if (run.checkpoints) {
    try { ckKey = checkpointKey({ dir: checkpoints.dir, key: checkpoints.key ?? null, file: checkpoints.keyFile ?? null }); }
    catch (e) { return refuse([{ code: "INPUT", unit_id: null, message: `checkpoints: ${String(e?.message ?? e)}` }]); }
  }
  // The VERIFY JAIL of every verify_cmd the controller runs (review.mjs runVerify; src/agy/verify-jail.mjs) also hides
  // this run's dir (every unit's control dir: A2A token, MCP config, OAuth scratch copy; the other units' worktrees) and
  // the checkpoints with their seal key; the unit's own worktree is bound back.
  const verifyJail = { ...(lim.verify_jail ?? {}), hide: [...(lim.verify_jail?.hide ?? []), dir, ...(run.checkpoints ? [checkpoints.dir, checkpoints.keyFile ?? `${String(checkpoints.dir).replace(/[/\\]+$/, "")}.seal-key`] : [])].map(p => resolve(String(p))) };
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
    started_at: null, ended_at: null, worktree: null, worktree_removed: null, control_dir: null, base_commit: null, dispatch: null, implementer_ladder: null, reviewer_ladder: null,
    attempts: [], a2a: { calls: [], usage: null, socket: null }, reviews: [], escalations: [], findings: [], reviewer_fed_revision: false, commit: null, tree: null, patch_digest: null, merged: false,
    unit_key: null, resumed: false, checkpoint: null, checkpoint_rejected: null,
  };
  const head = await git(repo, ["rev-parse", "--verify", `${base}^{commit}`], { allowFail: true });
  if (head.code !== 0) return refuse([{ code: "BASE", unit_id: null, message: `base "${base}" is not a commit of ${repo}` }]);
  run.base.commit = head.stdout.trim();
  // Unit keys (checkpoint.mjs), in wave order so every upstream key exists before its dependants'.
  for (const id of run.waves.flat()) run.units[id].unit_key = unitKey({ unit: byId.get(id), base_commit: run.base.commit, upstream: [...up.get(id)].map(d => ({ unit_id: d, unit_key: run.units[d].unit_key })), plan: units });

  // ---- provider-call budget: every injected turn passes through here (THE CALL BUDGET, PER REQUEST, in the header)
  // `reserved`: the turns admitted up front that have not yet admitted their first call; total + reserved never exceeds
  // the bound.
  let reserved = 0;
  const closed = () => {
    if (signal?.aborted) throw Object.assign(new Error("the run was aborted"), { code: "ABORTED" });
    if (run.provider_calls.total + reserved >= lim.max_provider_calls) { run.provider_calls.refused_at_limit += 1; throw Object.assign(new Error(`the run's provider-call bound (${lim.max_provider_calls}) is exhausted`), { code: "PROVIDER_LIMIT" }); }
  };
  const admit = role => {
    closed();
    // The caller's charge (the work ledger's spend) is made before the call; a refused charge refuses the call.
    if (typeof onCharge === "function") {
      try { onCharge({ role }); }
      catch (e) { run.provider_calls.refused_at_limit += 1; throw Object.assign(new Error(`the call was not charged: ${String(e?.message ?? e)}`), { code: "PROVIDER_LIMIT", cause: e }); }
    }
    // by_role.metered_failover appears once a metered failover call is charged.
    run.provider_calls.total += 1; run.provider_calls.by_role[role] = (run.provider_calls.by_role[role] ?? 0) + 1;
    // ON DISK BEFORE THE CALL: a record that cannot be written refuses the call.
    if (!persist()) throw recordError();
  };
  // A reply from a turn that admitted no call: the call was made outside the contract, and is charged now (late).
  const late = role => {
    if (typeof onCharge === "function") {
      try { onCharge({ role, late: true }); } catch { run.provider_calls.late_uncharged = (run.provider_calls.late_uncharged ?? 0) + 1; }
    }
    run.provider_calls.total += 1; run.provider_calls.by_role[role] = (run.provider_calls.by_role[role] ?? 0) + 1;
    if (!persist()) throw recordError();
  };
  const counted = role => async args => {
    closed();                                   // the refusals, up front: an aborted run or a spent bound opens no seat
    reserved += 1;
    let held = true, admitted = 0;
    const release = () => { if (held) { held = false; reserved -= 1; } };
    const take = r => { release(); admit(r); admitted += 1; };
    // `admitRequest({kind})` before every provider call of this turn: its own call(s) (kind "lane", "request" or none),
    // a metered failover (EVERY role: a single-turn seat on a Gemini lane fails over too, sdk/agy-turn.mjs laneFirstTurn;
    // independent review, assignment 3 (OpenAI gpt-6-astra extra review, 09d490f), question 1) and a further billed
    // request of the same turn (a Google continuation hop, a compaction; independent review round 2, assignment 3 (Google
    // gemini-4-carbon, manual, 77480d6), finding 1.1).
    // A request of an SDK implementer's native subagent (kind "subagent") is its own bucket: Google's Hydrogen
    // specialists, not the A2A `subagent` seats.
    const admitRequest = ({ kind } = {}) => take(kind === "continuation" ? "continuation" : kind === "failover" ? "metered_failover" : kind === "subagent" ? "native_subagent" : role);
    // The older contract's `charge(what)` admits a FURTHER call; the turn's own first call, which that contract charged up
    // front, is admitted with it when nothing was admitted yet.
    const charge = what => { if (admitted === 0) take(role); take(what === "continuation" ? "continuation" : "metered_failover"); };
    let r;
    try { r = await turns[role]({ ...args, admitRequest, charge }); }
    finally { release(); }
    if (admitted === 0) late(role);
    return r;
  };
  const T = { dispatcher: counted("dispatcher"), implementer: counted("implementer"), subagent: counted("subagent"), reviewer: counted("reviewer") };

  const lock = repoMutex(repo);
  const patches = new Map();   // unit_id -> the approved unit's patch against its own base
  const integrationPath = join(dir, "worktrees", "_integration"), branch = `pantheon/pipeline/${run.run_id}`;
  // THE RUN DIRECTORY IS OWNED by one live run at a time (<dir>/owner.json). A run that died there (SIGKILL: its
  // `finally` never ran) left its worktrees registered under <dir>/worktrees; they are removed before this run binds
  // its own, so a restart into the same directory does not fail on them (independent review, assignment 3 (OpenAI
  // gpt-6-astra extra review, 09d490f), question 8; (xAI grok-4.7, 09d490f), question 8).
  const holder = liveOwner(dir);
  // Refused WITHOUT writing: <dir>/pipeline.json is the live run's record.
  if (holder) {
    const refusals = [{ code: "DIR_IN_USE", unit_id: null, message: `the run directory ${dir} is held by a live run (pid ${holder.pid}, run ${holder.run_id})` }];
    return Object.assign(run, { status: "refused", reason: refusals[0].message, refusals, ended_at: now() });
  }
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname(), run_id: run.run_id, at: now() }) + "\n");
  ACTIVE_DIRS.add(resolve(dir)); owned = true;
  run.recovered_worktrees = await recoverOrphanWorktrees({ repo, root: join(dir, "worktrees"), lock });
  // ...and the integration BRANCH a dead run of this run_id left: `worktree add -b` refuses a branch that exists, so a
  // restart with the same directory and run_id failed (independent review round 2, assignment 3 (Google gemini-4-carbon,
  // manual, 77480d6), finding 8.1). git itself refuses to delete a branch checked out in any live worktree, so a run of
  // the same id elsewhere keeps its branch; the stale one (its worktree was just removed) is deleted. Only a DEAD run's:
  // the record still in this directory is that run's (this run has not written yet), and it never ended; a finished
  // run's branch is its result and is kept (the restart is refused on it, as before).
  let prior = null;
  try { prior = JSON.parse(readFileSync(file, "utf8")); } catch { prior = null; }
  const deadRun = prior?.run_id === run.run_id && prior?.status === "running" && (prior?.integration?.branch ?? branch) === branch;
  if (deadRun && (await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code === 0) {
    const del = await lock(() => git(repo, ["branch", "-D", branch], { allowFail: true }));
    if (del.code === 0) run.recovered_branch = branch;
  }
  // The dead run's per-unit control directories (a stale a2a.sock there would refuse this run's shim).
  await rm(join(dir, "control"), { recursive: true, force: true });
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

  /**
   * DECISION 6 (owner, 2026-11-19): who may NOT judge unit `u` at Stage 5. The exception that lets a dispatcher review
   * is its OWN unit's: every OTHER unit's dispatcher of this run -- the seat it is dispatched to (known before it
   * answers, so the rule does not depend on which unit ran first) and the model that answered -- is excluded, and so is
   * every authoring contributor of `u` (an implementer whose writes reached the worktree, a subagent whose answer was
   * returned). `own` is u's dispatcher; its identities are not excluded. By canonical
   * identity (review/identity.mjs), as contributorKeys returns it; an unresolved name leaves no rung eligible.
   */
  function stage5Keys(u, own, contributions = null) {
    const rows = [];
    for (const p of units) {
      if (p.unit_id === u.unit_id) continue;
      const s = seats.dispatcher(clone(p));
      if (s?.vendor && s?.model) rows.push({ vendor: s.vendor, model: s.model });
      const o = run.units[p.unit_id];
      for (const d of [o?.dispatch, o?.resumed ? o.checkpoint?.dispatch : null]) {
        if (d && (d.model || d.served_model)) rows.push({ vendor: d.vendor ?? null, model: d.model ?? null, served_model: d.served_model ?? null });
      }
    }
    // The unit's own `critique` rows are its Stage 5 reviewers' (fed findings): such a reviewer stays the unit's
    // reviewer for the revised work (Decision 5; the revision sequence is inside the exception). It is excluded from
    // every LATER judgment (the change review, the validator) as a critique contributor, and from other units below.
    rows.push(...(contributions ?? contributionsOf({ units: { [u.unit_id]: u } })).filter(c => c.kind === "work" || c.kind === "subtask")
      .map(c => ({ vendor: c.vendor, model: c.model, served_model: c.served_model ?? null })));
    // A returning dispatcher of the plan this run carries out (L-001): excluded from every unit but its own.
    rows.push(...(stage5_excluded ?? []).map(c => ({ vendor: c.vendor ?? null, model: c.model ?? null, served_model: c.served_model ?? null, requested_model: c.requested_model ?? null })));
    const keys = contributorKeys(rows);
    const mine = new Set([own?.model, own?.served_model].filter(Boolean).map(m => resolveModel(own.vendor, m)).filter(r => r.known).map(r => r.id));
    return { ...keys, models: keys.models.filter(m => !mine.has(m)) };
  }

  async function runUnit(planned) {
    const u = run.units[planned.unit_id];
    Object.assign(u, { status: "dispatching", started_at: now() });
    const upIds = [...up.get(planned.unit_id)].sort((a, b) => waveOf.get(a) - waveOf.get(b) || (a < b ? -1 : 1));
    const upstream = upIds.map(id => ({ unit_id: id, patch: patches.get(id) ?? "" }));
    const upstreamTrees = () => upIds.map(id => ({ unit_id: id, unit_key: run.units[id].unit_key, tree: run.units[id].tree }));
    const path = join(dir, "worktrees", planned.unit_id);

    // ---- resume: a checkpoint that still holds makes the unit approved with no provider call
    if (run.checkpoints && await resume(u, upstream, upstreamTrees(), path)) return;

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
    if (!iLadder.some(s => sameRung(s, impl.seat))) iLadder = [clone(impl.seat), ...iLadder];
    const rLadder = (seats.reviewerLadder(clone(dSeat)) ?? []).map(clone);
    const rWhy = reviewerLadderRefusal(rLadder, dSeat);
    if (rWhy) return finish(u, "refused", rWhy);
    u.implementer_ladder = iLadder; u.reviewer_ladder = rLadder;

    // ---- the controller's per-unit control directory, outside the worktree
    const control = join(dir, "control", unit.unit_id);
    await mkdir(control, { recursive: true, mode: 0o700 });
    u.control_dir = control;

    // ---- the controller binds ONE worktree: base + the merged results of the unit's upstream, in wave order
    let shim = null, bound = false, sockAt = null;
    try {
      const wt = await bindWorktree({ repo, base: run.base.commit, path, upstream, lock });
      bound = true;
      Object.assign(u, { status: "active", worktree: path, base_commit: wt.base_commit });
      // ---- Stage 4: the unit's subagent leaf (the A2A shim), up for exactly as long as the unit is active. It is never
      // told `path`. A unit whose every implementer rung is an SDK seat has none: its subagents are the SDK's own
      // Hydrogen specialists, admitted and recorded by the transport, and no other subagent seat is asked for it.
      if (iLadder.some(s => !isSdkSeat(s))) {
        sockAt = await a2aSocketFor(control);
        u.a2a.socket = { file: sockAt.file, fallback: sockAt.fallback, ...(sockAt.fallback ? { wanted: sockAt.wanted } : {}) };
        shim = await startA2AShim({ unit_id: unit.unit_id, allowed_subagents: unit.allowed_subagents, socket: sockAt.file, seatFor: role => seats.subagent(frozen(), role), subagentTurn: T.subagent,
          limits: { max_calls: lim.a2a_max_calls, max_bytes: lim.a2a_max_bytes }, sandbox: CAPABILITIES.subagent, signal,
          // Not awaited here; a failed write is thrown by the next awaited save.
          onCall: rec => { u.a2a.calls.push(rec); u.a2a.usage = shim?.usage() ?? null; save().catch(() => {}); } });
      }
      await save();

      let state = { revisions: 0, implementer_level: iLadder.findIndex(s => sameRung(s, impl.seat)), reviewer_level: 0, consecutive_rejections: 0 };
      const cfg = { max_revisions: lim.max_revisions, reviewer_escalation_after: lim.reviewer_escalation_after, implementer_rungs: iLadder.length, reviewer_rungs: rLadder.length };
      let checkpoint = wt.base_commit, findings = [];
      for (let n = 1; ; n++) {
        // ---- Stage 3, behind the lane failover ladder: a lane failure is retried once on the same lane, then the
        // unit steps down a rung; a quota refusal steps down at once. No revision is spent on either.
        const lane_failures = [];
        let a, retried = false;
        for (;;) {
          const seat = iLadder[state.implementer_level];
          a = await runImplementer({ unit: frozen(), worktree: path, seat, ladder: iLadder, turn: T.implementer, a2a: shim ? { socket: shim.socket, token: shim.token, roles: [...shim.roles] } : null,
            attempt: n, findings: [...findings], rubric: [...u.dispatch.rubric], checkpoint, scratch_paths: lim.scratch_paths, signal, control_dir: control, mcp_server: MCP_SERVER_PATH, verify_jail: verifyJail, deadline });
          // The lane was refused for quota and its metered failover was USED but its answer refused (API_FILES_REFUSED:
          // prose, malformed JSON, a path outside the unit): that is still the quota-exhausted lane failing, not the
          // implementer's work being refused. It steps the ladder like a quota refusal and spends no review revision
          // (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.3).
          if (!a.lane_failure && a.status !== "written" && a.code === "TURN_FAILED" && a.quota_failover?.used === true && !signal?.aborted) {
            a.lane_failure = { kind: "exit", cause: "quota", why: a.why, status: 429, via: "metered_failover_refused" };
          }
          if (!a.lane_failure) break;
          // A QUOTA refusal steps to the next rung on ANOTHER base model: Antigravity's quota is the base model's, shared
          // by its thinking levels, so the same model's next level would be refused again (two doomed launches and two
          // probes) (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.1).
          // So does a model the provider DOES NOT SERVE (cause "model_unavailable"): its other levels are the same
          // absent model. Neither is retried on the same rung; the step and the rungs it skipped are recorded.
          const cause = a.lane_failure.cause === "quota" ? "quota" : a.lane_failure.cause === "model_unavailable" ? "model_unavailable" : "lane";
          const wholeModel = cause !== "lane", again = !wholeModel && !retried;
          const baseOf = s => laneParts(s?.model)?.base ?? s?.model;
          let nextLevel = state.implementer_level + 1;
          if (wholeModel) while (nextLevel < iLadder.length && baseOf(iLadder[nextLevel]) === baseOf(seat)) nextLevel++;
          const down = nextLevel < iLadder.length;
          lane_failures.push({ vendor: seat.vendor, model: seat.model, ...(seat.effort !== undefined ? { effort: seat.effort } : {}), level: state.implementer_level, kind: a.lane_failure.kind, cause: a.lane_failure.cause, why: a.why, retry: retried,
            next: signal?.aborted ? "aborted" : again ? "same_lane" : down ? "next_rung" : "exhausted" });
          if (signal?.aborted) break;
          if (again) { retried = true; continue; }
          if (!down) break;
          u.escalations.push({ after_attempt: n, kind: "lane_failover", cause, from: clone(seat), to: clone(iLadder[nextLevel]),
            ...(nextLevel > state.implementer_level + 1 ? { skipped_same_base: iLadder.slice(state.implementer_level + 1, nextLevel).map(clone) } : {}) });
          state = { ...state, implementer_level: nextLevel };
          retried = false;
          await save();
        }
        a.lane_failures = lane_failures;
        u.attempts.push(a);
        await save();
        if (a.lane_failure) {
          if (signal?.aborted) return finish(u, "blocked", a.why);
          u.code = "LANE_LADDER_EXHAUSTED";
          return finish(u, "blocked", `LANE_LADDER_EXHAUSTED: every rung of the implementer ladder failed (${lane_failures.map(f => `${f.model}: ${f.kind}`).join("; ")})`);
        }
        let event, review = null;
        if (a.status !== "written") {
          // A fault of the transport that no rung can cure (implement.mjs TRANSPORT_BLOCKERS): the unit blocks with
          // that code. No other rung is tried and no revision is spent on it.
          if (a.transport_blocker) { u.code = a.code; return finish(u, "blocked", a.why); }
          // A model-guard refusal (L-504 invariant 3) ends the unit: another attempt would spend a revision and a provider call
          // on a CLI that has just reported a model other than the one asked for.
          if (a.code === "PROVIDER_LIMIT" || a.code === "AGY_MODEL_MISMATCH" || a.code === "TURN_FAILED" && signal?.aborted) return finish(u, "blocked", a.why);
          event = "attempt_refused"; findings = [a.why];
          u.findings.push({ attempt: n, source: "controller", code: a.code, findings: [a.why] });
        } else {
          checkpoint = a.checkpoint;
          // ---- Stage 5
          // THE EXCEPTION IS THIS UNIT'S OWN (Decision 6, owner 2026-11-19): a rung that is another unit's dispatcher
          // (asked or served) or a contributor of this unit is skipped at SELECTION; with no rung left the unit blocks on
          // capacity, with the reason recorded, and nothing falls back to an excluded model.
          const k5 = stage5Keys(u, { vendor: dSeat.vendor, model: dSeat.model, served_model: u.dispatch.served_model ?? null });
          let level = state.reviewer_level;
          const skipped = [];
          while (level < rLadder.length) {
            const why = candidateRefusal(rLadder[level], k5);
            if (!why) break;
            skipped.push({ vendor: rLadder[level].vendor, model: rLadder[level].model, level, why });
            level++;
          }
          if (skipped.length) (u.reviewer_exclusions ??= []).push(...skipped.map(x => ({ after_attempt: n, ...x })));
          if (level >= rLadder.length) {
            u.code = "STAGE5_CAPACITY";
            await save();
            return finish(u, "blocked", `STAGE5_CAPACITY: no rung of the reviewer ladder may judge unit ${unit.unit_id} (${skipped.map(x => `${x.vendor}/${x.model}: ${x.why}`).join("; ").slice(0, 600)}); the work is kept and the review is pending capacity`);
          }
          if (level !== state.reviewer_level) {
            u.escalations.push({ after_attempt: n, kind: "reviewer_excluded", from: clone(rLadder[state.reviewer_level]), to: clone(rLadder[level]) });
            state = { ...state, reviewer_level: level };
          }
          review = await runReviewer({ unit: clone(unit), worktree: path, base_commit: wt.base_commit, checkpoint, seat: rLadder[level], turn: T.reviewer,
            dispatch: { rubric: [...u.dispatch.rubric], rubric_hash: u.dispatch.rubric_hash }, limits: lim, pinned: level === 0, level, attempt: n, signal, sameModel, verify_jail: verifyJail, deadline });
          // ADMISSION, by the model that answered: an answer served by an excluded identity is not a review.
          if (review.served_model && !["rubric_mismatch", "diff_too_large", "not_admitted"].includes(review.status)) {
            const why = reviewerRefusal({ vendor: review.vendor, model: review.model, served_model: review.served_model },
              stage5Keys(u, { vendor: dSeat.vendor, model: dSeat.model, served_model: u.dispatch.served_model ?? null }));
            if (why) { Object.assign(review, { status: "not_admitted", code: "STAGE5_EXCLUDED", why: `the Stage 5 answer is not admitted: ${why}`, feedback: [] }); u.code = "STAGE5_EXCLUDED"; }
          }
          u.reviews.push(review);
          // The review's findings are on the record IN THE SAME SAVE as the review: a kill between two saves cannot
          // leave a request_changes review whose feedback the next attempt never sees (independent review, assignment
          // 3 (xAI grok-4.7, 09d490f), question 8).
          const stops = review.status === "not_admitted" || review.status === "diff_too_large";
          if (stops && review.feedback.length) u.findings.push({ attempt: n, source: "controller", code: review.code, findings: review.feedback });
          if (!stops && review.status !== "approved" && review.status !== "rubric_mismatch") {
            // The reviewer by the model asked AND the model that answered, with the marker (wave 3, L-504 invariant 2: the
            // finding kept the asked seat only, so every projection of it lost the served identity).
            u.findings.push({ attempt: n, source: review.status === "request_changes" ? "reviewer" : "controller", code: review.status, vendor: review.vendor, model: review.model,
              requested_model: review.requested_model ?? review.model, served_model: review.served_model ?? null, ...(review.served_model_source ? { served_model_source: review.served_model_source } : {}), findings: review.feedback });
          }
          await save();
          if (review.status === "approved") break;
          if (review.status === "rubric_mismatch") return finish(u, "refused", review.why);
          if (stops) return finish(u, "blocked", review.why);
          event = "rejected"; findings = review.feedback;
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
      const tree = (await git(path, ["rev-parse", `${checkpoint}^{tree}`])).trim();
      Object.assign(u, { commit: checkpoint, tree, patch_digest: sha256(patch) });
      finish(u, "approved");
      if (run.checkpoints) await keep(u, { patch, unit_base_commit: wt.base_commit, upstream: upstreamTrees() });
    } finally {
      if (shim) { u.a2a.usage = shim.usage(); await shim.close(); }
      if (sockAt) { await rm(sockAt.file, { force: true }).catch(() => {}); if (sockAt.fallback) await rm(sockAt.dir, { recursive: true, force: true }).catch(() => {}); }
      if (bound) u.worktree_removed = await releaseWorktree({ repo, path, lock }).catch(() => false);
    }
  }

  /** Write an approved unit's checkpoint. A failure to write is recorded; it does not change the unit's verdict. */
  async function keep(u, { patch, unit_base_commit, upstream }) {
    const rv = u.reviews.at(-1);
    try {
      const d = u.dispatch;
      const rec = await writeCheckpoint({ dir: run.checkpoints.dir, patch, key: ckKey, record: {
        unit_key: u.unit_key, unit_id: u.unit_id, rubric_hash: u.dispatch.rubric_hash, base_commit: run.base.commit, unit_base_commit, upstream,
        commit: u.commit, tree: u.tree, reviewer: { vendor: rv.vendor, model: rv.model, served_model: rv.served_model, ...(rv.served_model_source ? { served_model_source: rv.served_model_source } : {}) },
        verify: { cmd: rv.verify.cmd, exit_code: rv.verify.exit_code, digest: rv.verify.digest }, review_digest: digestOf(clone(rv)),
        // The approval itself, to re-derive on resume (checkpoint.mjs approvalRefusal).
        review: clone(rv), dispatch: { vendor: d.vendor, model: d.model, served_model: d.served_model ?? null, ...(d.served_model_source ? { served_model_source: d.served_model_source } : {}),
          specialist_role: d.specialist_role, difficulty: d.difficulty, rubric: [...d.rubric], rubric_hash: d.rubric_hash },
        // The unit's authoring lineage: restored on resume so its contributors stay excluded downstream (checkpoint.mjs).
        contributions: contributionsOf({ units: { [u.unit_id]: u } }).filter(c => c.kind !== "plan").map(({ unit_id, ...c }) => c),
        // The unit's subagent call receipts, sealed with the approval: a resumed unit restores them, so a run that
        // requires a subagent consultation still finds it on the record (independent review round 2, assignment 3
        // (Google gemini-4-carbon, manual, 77480d6), finding 7.3).
        a2a_calls: clone(u.a2a.calls ?? []),
        // ...and an SDK implementer's NATIVE subagents, per attempt whose writes were kept: who the implementer was,
        // the governor's whole record (each specialist's identity, type, scope, tools, digests, states and usage, and
        // every rejection) and the names the provider answered under. A resumed unit restores them the same way.
        native_subagents: (u.attempts ?? []).filter(a => a.status === "written" && a.session?.subagents).map(a => ({ attempt: a.n, implementer: { vendor: a.vendor, model: a.model, effort: a.effort ?? null },
          served_models: clone(a.session.gateway?.served_models ?? {}), ...(a.session.gateway?.served_by_type ? { served_by_type: clone(a.session.gateway.served_by_type) } : {}), subagents: clone(a.session.subagents) })) } });
      u.checkpoint = { written: true, file: checkpointFile(run.checkpoints.dir, u.unit_key), recorded_at: rec.recorded_at };
      run.checkpoints.written.push(u.unit_id);
    } catch (e) { u.checkpoint = { written: false, why: String(e?.message ?? e) }; }
  }

  /**
   * Resume `u` from its checkpoint if it still holds (see checkpoint.mjs): true when the unit is now approved.
   * The patch is applied on the unit's freshly bound base (base + upstream patches) and must yield the recorded tree.
   */
  async function resume(u, upstream, upstreamNow, path) {
    const got = await readCheckpoint({ dir: run.checkpoints.dir, unit_key: u.unit_key });
    if (!got.found) return false;
    const reject = why => { u.checkpoint_rejected = { unit_key: u.unit_key, why, at: now() }; run.checkpoints.rejected.push(u.unit_id); return false; };
    if (got.why) return reject(got.why);
    const planned = byId.get(u.unit_id);
    const why = checkpointRefusal(got, { unit_key: u.unit_key, unit_id: u.unit_id, base_commit: run.base.commit, upstream: upstreamNow, verify_cmd: planned.verify_cmd });
    if (why) return reject(why);
    let bound = false, ok = false;
    try {
      const wt = await bindWorktree({ repo, base: run.base.commit, path, upstream, lock });
      bound = true;
      if (got.patch) {
        const r = await git(path, ["apply", "--index", "--whitespace=nowarn", "-"], { input: got.patch, allowFail: true });
        if (r.code !== 0) return reject(`the checkpoint's patch does not apply on the unit's base: ${r.stderr.trim().slice(0, 500)}`);
      }
      const tree = (await git(path, ["write-tree"])).trim();
      if (tree !== got.record.tree) return reject(`the checkpoint's patch applied on the unit's base yields tree ${tree}, not the recorded ${got.record.tree}`);
      // Ground truth, re-run: the unit's own verify_cmd on the rebuilt tree. A checkpoint is evidence to re-check.
      const verify = await runVerify({ worktree: path, verify_cmd: planned.verify_cmd, timeout_ms: lim.verify_timeout_ms, max_output_bytes: lim.verify_output_bytes, jail: verifyJail, signal, deadline });
      u.resume_verify = { cmd: verify.cmd, exit_code: verify.exit_code, timed_out: verify.timed_out, digest: verify.digest, duration_ms: verify.duration_ms };
      if (!verify.passed) return reject(`the unit's verify_cmd fails on the checkpoint's tree (exit ${verify.exit_code}${verify.timed_out ? ", timed out" : ""}): ground truth wins over the recorded approval`);
      // The approval, authenticated: the seal under this controller's key, the review re-hashed and bound to this patch,
      // the rubric hash recomputed from the CURRENT unit, and the dispatcher and reviewer the seats this run would use
      // (independent review, assignment 3 (OpenAI gpt-6-astra extra review, 09d490f), question 7).
      // This run's identity rule and diff bound are re-applied to the recorded judgments (finding 7.2).
      const approval = approvalRefusal(got, { key: ckKey, unit: planned, rubricHash, sameModel: sameModel ?? sameModelName, max_diff_bytes: lim.max_diff_bytes ?? 400000 });
      if (approval) return reject(approval);
      const dSeat = seats.dispatcher(clone(planned));
      if (!dSeat || !sameSeat(dSeat, got.record.dispatch)) return reject(`the checkpoint's dispatcher ${got.record.dispatch.vendor}/${got.record.dispatch.model} is not the seat this run dispatches the unit to`);
      const ladder = (seats.reviewerLadder(clone(dSeat)) ?? []);
      if (!ladder.some(s => sameSeat(s, got.record.review))) return reject(`the checkpoint's reviewer ${got.record.review.vendor}/${got.record.review.model} is not on the unit's reviewer ladder`);
      // The recorded reviewer must still be one that may judge this unit (Decision 6): not another unit's dispatcher of
      // this run and not a contributor of the unit, by the model asked and by the model that answered.
      const k5 = stage5Keys(u, got.record.dispatch, (got.record.contributions ?? []).map(c => ({ kind: c.kind, vendor: c.vendor, model: c.model, served_model: c.served_model ?? null, ...(c.served_model_source ? { served_model_source: c.served_model_source } : {}) })));
      const excluded = reviewerRefusal({ vendor: got.record.review.vendor, model: got.record.review.model, served_model: got.record.review.served_model ?? null }, k5);
      if (excluded) return reject(`the checkpoint's reviewer may not judge this unit: ${excluded}`);
      patches.set(u.unit_id, got.patch);
      await writeFile(join(dir, "units", `${u.unit_id}.patch`), got.patch);
      Object.assign(u, { resumed: true, base_commit: wt.base_commit, commit: got.record.commit, tree, patch_digest: got.record.patch_digest,
        checkpoint: { resumed_from: checkpointFile(run.checkpoints.dir, u.unit_key), recorded_at: got.record.recorded_at, rubric_hash: got.record.rubric_hash, review_digest: got.record.review_digest, reviewer: clone(got.record.reviewer ?? null), verify: clone(got.record.verify ?? null), reverified: clone(u.resume_verify),
          contributions: clone(got.record.contributions),
          // The sealed dispatch whose rubric governed the reused patch: its dispatcher stays an arbiter of this run
          // (record.mjs arbitersOf), excluded from later independent judgment (owner decision 2026-11-19).
          dispatch: { vendor: got.record.dispatch.vendor, model: got.record.dispatch.model, served_model: got.record.dispatch.served_model ?? null,
            ...(got.record.dispatch.served_model_source ? { served_model_source: got.record.dispatch.served_model_source } : {}), rubric_hash: got.record.dispatch.rubric_hash },
          // The sealed evidence of the approval, restored (finding 7.3): the Stage 5 review that approved the patch and
          // the subagent calls made for it, each marked as coming from the checkpoint. u.reviews and u.a2a.calls stay
          // this run's own calls (none), so nothing is counted twice as this run's provider calls or contributions.
          review: clone(got.record.review),
          a2a_calls: (got.record.a2a_calls ?? []).map(c => ({ ...clone(c), from_checkpoint: true })),
          native_subagents: (got.record.native_subagents ?? []).map(x => ({ ...clone(x), from_checkpoint: true })) } });
      run.checkpoints.resumed.push(u.unit_id);
      finish(u, "approved");
      ok = true;
      return true;
    } finally {
      if (bound) { const removed = await releaseWorktree({ repo, path, lock }).catch(() => false); if (ok) u.worktree_removed = removed; }
    }
  }
}

const OWNER_FILE = "owner.json";
const ACTIVE_DIRS = new Set();   // run directories a run in THIS process currently holds
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
/** The live run holding `dir` ({pid, host, run_id}), or null: none, a dead process on this host, or a finished run. */
export function liveOwner(dir) {
  let o;
  try { o = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")); } catch { return null; }
  if (!o || !Number.isInteger(o.pid)) return null;
  if (o.host !== hostname()) return o;                               // another host's run: not judged dead from here
  if (o.pid === process.pid) return ACTIVE_DIRS.has(resolve(dir)) ? o : null;
  return alive(o.pid) ? o : null;
}

// ONE LOCK PER REPOSITORY, for every operation on its shared worktree list and branches (worktree add/remove/prune,
// the integration branch): git.mjs repoMutex, which now spans PROCESSES (L-303), re-exported here for its callers.
export { repoMutex };

/**
 * THE INTEGRATION BRANCH OF A DEAD ATTEMPT (register L-304, self-audit round 3, assignment 3 (sealed bb1287a)). Each
 * lifecycle attempt runs in a NEW directory with a new run_id, so the same-directory restart cleanup in runPipeline
 * never sees a killed attempt's refs/heads/pantheon/pipeline/<run_id>, and those refs piled up. The implement stage's
 * recovery calls this for every earlier attempt's run directory `dir`; the branch is deleted ONLY when:
 *   - no live run holds `dir` (liveOwner: a pid on this host that is running, any other host's, or a run of this
 *     process): never a live run's;
 *   - the run never ended: its record (pipeline.json) is absent or still "running". A run that ended (completed,
 *     incomplete, failed, refused) keeps its branch: a completed run's is handed on by its stage and an unfinished
 *     one's is kept as its evidence ({integration: {kept: true}});
 *   - the name is exactly pantheon/pipeline/<run_id> of that run (from its record, else its owner.json), a run_id of
 *     plain characters (no "/"), so a record cannot name another ref to delete; and git deletes it only while no
 *     worktree has it checked out.
 * Under the repository lock. Returns {branch, deleted, why}.
 */
export async function recoverDeadRunBranch({ repo, dir, lock = repoMutex(repo) }) {
  const read = f => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } };
  const rec = read("pipeline.json"), owner = read(OWNER_FILE);
  if (rec && rec.status !== "running") return { branch: rec.integration?.branch ?? null, deleted: false, why: `the run ended ${rec.status}: its branch is kept` };
  const run_id = rec?.run_id ?? owner?.run_id ?? null;
  if (typeof run_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(run_id)) return { branch: null, deleted: false, why: "no run id is recorded" };
  const branch = `pantheon/pipeline/${run_id}`;
  return lock(async () => {
    // Judged under the repository lock, just before the deletion (a run of this directory that started meanwhile is seen).
    const holder = liveOwner(dir);
    if (holder) return { branch, deleted: false, why: `held by a live run (pid ${holder.pid} on ${holder.host})` };
    if ((await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code !== 0) return { branch, deleted: false, why: "no such branch" };
    const del = await git(repo, ["branch", "-D", branch], { allowFail: true });
    return { branch, deleted: del.code === 0, why: del.code === 0 ? "the run died before it ended" : del.stderr.trim().slice(0, 300) };
  });
}

/**
 * Remove the worktrees a dead run left under `root` (registered or not): `git worktree prune`, then every worktree of
 * `repo` whose path is inside `root` is removed (force), and whatever is left in `root` is deleted. Returns the paths
 * removed. The caller holds the run directory (liveOwner): nothing a live run uses is under `root`.
 */
export async function recoverOrphanWorktrees({ repo, root, lock = repoMutex(repo) }) {
  if (!existsSync(root)) return [];
  const roots = [resolve(root)];
  try { roots.push(realpathSync(root)); } catch { /* gone */ }
  const under = p => roots.some(r => p === r || p.startsWith(r + sep));
  return lock(async () => {
    await git(repo, ["worktree", "prune"], { allowFail: true });
    const listed = await git(repo, ["worktree", "list", "--porcelain"], { allowFail: true });
    const removed = [];
    for (const line of String(listed.stdout ?? "").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice("worktree ".length).trim();
      if (!under(p)) continue;
      const r = await git(repo, ["worktree", "remove", "--force", p], { allowFail: true });
      if (r.code !== 0) await rm(p, { recursive: true, force: true });
      removed.push(p);
    }
    for (const name of readdirSync(root)) { const p = join(root, name); if (!removed.includes(p)) removed.push(p); await rm(p, { recursive: true, force: true }); }
    await git(repo, ["worktree", "prune"], { allowFail: true });
    return removed;
  });
}

/** Run `fn` over `items` with at most `width` in flight. */
async function pool(items, width, fn) {
  const queue = [...items];
  const worker = async () => { while (queue.length) await fn(queue.shift()); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
}
