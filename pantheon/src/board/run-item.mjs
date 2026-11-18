// Run Pantheon's own real pipeline on a ticket spec -- intake, promote, plan, work, check, ship --
// as an importable, non-exiting function. Extracted from scripts/open-items-run.mjs (now a thin
// CLI wrapper around this) so the CLI and a new HTTP build API (src/view/build-server.mjs) run the
// EXACT SAME logic instead of two copies drifting apart.
//
// Every vendor SDK is injected at the edge: this module imports no vendor package, matching
// src/view/server.mjs's own convention. `makeClientFor(vendor)` is required.
//
// NEVER calls process.exit(). A caller reachable from an HTTP request handler that called
// process.exit() would kill the whole server process on one failed build, not just that request --
// every exit path in the original script becomes either a thrown Error (a caller-error: a bad
// ticket or missing makeClientFor, checked before any work starts) or a value in the returned
// result object (a run-error: something failed after work started).
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { sdkTurn } from "../sdk/seat-sdk.mjs";
import { openBoard } from "./index.mjs";
import { publish, treeSlots } from "./dag.mjs";
import { merge } from "./merge.mjs";
import { ship, shipClaim } from "./integrate.mjs";
import { assertStage, stageCheck, assertLaw } from "./stage-gate.mjs";
import { boardState, boardStatus, schedule, testsBrief, acceptanceStatus } from "./controller.mjs";
import { project, PROJECTION_FOR_ROLE } from "./project.mjs";
import { seatingPlan, seatingReport, assertReviewCutsAcross, assertFanOutIsOutside, INTAKE,
  shouldFallThrough, cooldownPoolFor } from "../role/seating.mjs";
import { shutPools, recordRefusal, recordSuccess } from "../route/cooldown.mjs";
import { promptFor } from "../role/roles.mjs";
import { shortCid, cidOf } from "./canon.mjs";
import { runAcceptance as isolatedAcceptance, ACCEPTANCE_ISOLATION } from "./acceptance.mjs";
import { artifactPath, readArtifact, writeArtifact } from "./artifact-files.mjs";
import { certifiedArtifacts } from "./artifacts.mjs";
import { resolveRepoRoot } from "../../scripts/lib/repo-root.mjs";
import { modelId, labOf, vendorsOfLab } from "../config/models.mjs";
import { tokenCapFor } from "../agents/store.mjs";
import { ticketContainmentRefusal, ticketRuntimeRefusal, normalizeSlots, isUnder } from "./ticket-safety.mjs";
import { spawnPromise } from "./spawn.mjs";
import { runAgyCliTurn } from "./agy-cli.mjs";
import { nextOccupancy } from "./occupancy.mjs";
import { escalationRecord, PROTOCOLS } from "../route/protocol.mjs";
import { routeSeats } from "../route/quota-failover.mjs";
import { laneParts } from "../route/fit-matrix.mjs";
import { currentPolicy as currentIdentityPolicy, policyDigest as identityPolicyDigest, contributorKeys, candidateRefusal, reviewerRefusal, resolveModel } from "../review/identity.mjs";
import { defaultOutputFor, outputBudgetFor, TOKEN_TIERS } from "../config/tiers.mjs";
import { frontierCandidates, readPools, selectSeat, selectionPolicy } from "../route/frontier.mjs";
import { loadPractice, withPractice } from "../ledger/practice-kinds.mjs";
import { reviewScope, CRITIQUE_VIA } from "../review/scope.mjs";
import { taskProfile, requirementsOf } from "../route/task-profile.mjs";
import { shadowSeat, withShadow } from "../practice/shadow.mjs";
import { assignArm, explicitAssignment, DEFAULT_ASSIGNMENT_POLICY } from "../practice/assign.mjs";
import { routeCall, openCooldownStore, isFrontier, classifyFailure } from "../../../packages/model-client/index.mjs";

// This repo's own root (for Antigravity role-card discovery and PANTHEON_HEAD provenance) -- NOT the ticket's
// target repo. src/board/run-item.mjs -> src/board -> src -> repo root, so two levels up.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CRITIQUE_SCHEMA = { type: "object", properties: {
  verdict: { type: "string", enum: ["approve", "request_changes"] },
  narrative: { type: "string", description: "what you ran and read, with commands, exit codes and path:line quotes" },
  findings: { type: "array", items: { type: "object", properties: { severity: { type: "string", enum: ["block", "should", "nit"] }, note: { type: "string" } }, required: ["severity", "note"] } },
}, required: ["verdict", "findings"] };

// NO TOOLS, SAID PLAINLY. The role charters ("report what you ran") were written for seats that can
// run things. An SDK seat cannot, and two xai models answered by narrating tool calls instead of
// answering (an 82k-char scout loop; a reviewer that ended with "let me read the implementation"
// and no verdict).
const NO_TOOLS = "You have NO tools in this seat: nothing you write executes and you cannot read files. " +
  "Everything you may rely on is in this message. Do not announce, narrate or simulate commands. ";

const strip = t => t.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
const isTimeout = e => e?.name === "APIConnectionTimeoutError" || /timed out|UND_ERR_HEADERS_TIMEOUT|ETIMEDOUT/i.test(String(e?.message ?? e));

// Sparse copies must keep the source's actual package scopes. Without these bytes Node may
// parse an unchanged TypeScript module as CommonJS. Absence matters too: a new nearer manifest
// must not silently change what acceptance or a resumed run tests. These are input context,
// never additional owned outputs; an explicitly owned manifest remains an ordinary artifact.
function packageContext(repoRoot, copied, slots) {
  const paths = new Set();
  const owned = new Set(slots.map(sl => relative(repoRoot, artifactPath(repoRoot, sl.path))));
  const ancestors = dir => {
    for (;;) {
      paths.add(join(dir, "package.json"));
      if (dir === ".") break;
      dir = dirname(dir);
    }
  };
  const visit = path => {
    // No source or manifest symlink may alias a scope or lead discovery outside repoRoot.
    const source = artifactPath(repoRoot, path);
    const canonical = relative(repoRoot, source);
    if (statSync(source).isDirectory()) {
      ancestors(canonical);
      for (const entry of readdirSync(source)) visit(join(canonical, entry));
    } else ancestors(dirname(canonical));
  };
  for (const path of copied) visit(path);
  for (const sl of slots) ancestors(dirname(relative(repoRoot, artifactPath(repoRoot, sl.path))));
  return [...paths].filter(path => !owned.has(path)).sort().map(path => {
    const contents = readArtifact(repoRoot, path);
    return { path, bytes: contents === null ? null : cidOf("blob", contents), contents };
  });
}

/** An output cap in the vendor's own request shape; `extra` is { tokens } or undefined. */
const ROLE_OF_PURPOSE = { plan: "planner", work: "implementer", critique: "reviewer", scout: "scout" };

// What a resumed run needs to continue a slot's escalation trail. `stopped` is a recorded terminal decision:
// the slot makes no further generation, in this run or a resumed one (audit M2).
const escalationState = c => ({ effort: c.effort ?? null, forced: c.forced ?? null, steps: c.escalationSteps ?? 0,
  model: c.ranModel ?? null, pending: c.pendingRevision ?? null, stopped: c.stopped ?? null });
// A seat as run.json keeps it for resume: the whole selected seat (vendor, model, transport, pool and pool
// configuration -- the pool's id and credential variable NAME, never a credential) and why it was chosen.
const savedChoice = ch => ch && { seat: ch.seat, candidates: ch.candidates, selection: ch.selection };
// The context a selection must admit, estimated from the characters the seat will be sent.
const contextEstimate = chars => Math.ceil(chars / 4);

// RESOURCE EVIDENCE (audit M5). A provider's usage report, kept verbatim (`reported`) beside the two
// counts every surface states in its own words. A count the provider did not report is null, never 0;
// no report at all is null.
const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;
function usageOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.input_tokens) ?? num(raw.prompt_tokens) ?? num(raw.promptTokenCount);
  // Google reports thinking tokens apart from candidates; both are generated output.
  const google = num(raw.candidatesTokenCount) === null && num(raw.thoughtsTokenCount) === null ? null
    : (num(raw.candidatesTokenCount) ?? 0) + (num(raw.thoughtsTokenCount) ?? 0);
  const output = num(raw.output_tokens) ?? num(raw.completion_tokens) ?? google;
  return { input_tokens: input, output_tokens: output, reported: structuredClone(raw) };
}
// What an attempt that ended in an error was: the router's own classification, so a quota refusal recorded
// here is the same quota refusal the fallback acted on.
function failureOutcome(e) {
  if (/^CONTEXT_|^INPUT_CEILING$/.test(String(e?.code ?? ""))) return "refused_preflight";
  const f = classifyFailure(e);
  return f.quota ? "quota" : f.retryable ? "transient" : "error";
}
// The run's resource summary, derived from its attempts. Cost is not estimated: no versioned price source
// is attached, so USD is unknown (null) and says why.
// The provider calls an attempt list made: every attempt but one the seat layer refused before sending any
// request (`provider_requests: 0`), which reached no provider. Unknown (null) counts as a call.
export function providerCallsOf(attempts = []) {
  return attempts.filter(a => a?.provider_requests !== 0).length;
}
// THE SEATING REPORT: what the selector actually chose, per role, read from the turns the run made (each carries
// its selection), not the legacy SEATING table. One row per role and seat that answered, in the order seated:
// vendor/model, lab, the selection's source (profile, policy, operator-override, ticket-pin, ...), and under
// `fit` the class and the effort the profile mapped onto that model's ladder.
const ROLE_OF_TURN = { scout: "scout", plan: "planner", work: "implementer", critique: "reviewer" };
export function seatingOf(run) {
  const rows = [], seen = new Set();
  for (const t of run?.turns ?? []) {
    const role = ROLE_OF_TURN[t.purpose] ?? t.purpose, key = `${role}|${t.vendor}|${t.model}|${t.pool ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sel = t.selection ?? null, fit = sel?.profile === "fit";
    const row = { role, vendor: t.vendor, model: t.model, lab: labOf(t.vendor, t.model), pool: t.pool ?? t.vendor, transport: t.transport ?? null,
      profile: sel?.profile ?? null, source: sel?.source ?? null, fallback: sel?.fallback === true,
      ...(fit ? { class: sel.class?.value ?? null, effort: sel.effort?.value ?? null } : {}) };
    row.line = `${role.padEnd(11)} ${t.vendor}/${t.model} (${row.lab})  source=${row.source ?? "unrecorded"}${row.fallback ? " fallback" : ""}` +
      (fit ? `  class=${row.class ?? "-"} effort=${row.effort ?? "-"}` : "");
    rows.push(row);
  }
  return rows;
}
function resourcesOf(attempts) {
  const by_outcome = {};
  for (const a of attempts) by_outcome[a.outcome] = (by_outcome[a.outcome] ?? 0) + 1;
  const sum = key => attempts.reduce((n, a) => n + (num(a.usage?.[key]) ?? 0), 0);
  const attempts_without_usage = attempts.filter(a => a.usage?.input_tokens == null || a.usage?.output_tokens == null).length;
  return { provider_calls: providerCallsOf(attempts), by_outcome,
    reported_input_tokens: sum("input_tokens"), reported_output_tokens: sum("output_tokens"),
    attempts_without_usage, usage_complete: attempts_without_usage === 0,
    usd: null, usd_basis: "unknown: no versioned price source is attached, so cost is not estimated" };
}

const capFor = (vendor, extra) => extra?.tokens == null ? undefined
  : vendor === "agy_google" ? { config: { maxOutputTokens: extra.tokens } }
  : vendor === "anthropic" ? { max_tokens: extra.tokens }
  : { max_output_tokens: extra.tokens };

/**
 * Run one ticket through Pantheon's real pipeline. Returns a result object; never calls
 * process.exit(); never prints to the console (that is the CLI wrapper's job -- pass `progress` to
 * receive the same structured events the wrapper prints from).
 *
 * @param {object} spec - a ticket, same shape as scripts/tickets/*.json.
 * @param {object} opts
 * @param {string|null} [opts.dir] - board root to use (defaults to a fresh timestamped dir under ~/.pantheon/boards).
 * @param {string|null} [opts.resume] - a board root to resume from (skips intake/plan/work, reads their results from the board's refs).
 * @param {number} [opts.revisions=3] - max implementer revisions before the work stage stops and hands whatever it has to review.
 * @param {object} [opts.seatOverrides={}] - `{ [role]: { vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why } }`, a pre-built override map (the CLI wrapper builds this from `--seat role=vendor/model` flags; an HTTP caller builds it directly).
 * @param {(vendor: string) => object} opts.makeClientFor - required. Returns an SDK client for a vendor; this module never imports a vendor SDK itself.
 * @param {string[]} [opts.scouts] - the vendors that scout at intake (default xai only -- agy_google
 *   was dropped from the default 2026-09-29, see the SCOUT_VENDORS comment below). The only legal
 *   fan-out in the pipeline: depth 0, before commitment, across independent pools.
 * @param {(ev: object) => void} [opts.progress] - called with the same structured events written to progress.jsonl. Optional; omitted, events are simply not emitted anywhere but disk.
 * @returns {Promise<{ok: boolean, shipped: boolean, key: string, board: string, outDir: string, error: {stage: string, message: string}|null, salvaged: string|null}>}
 */
export async function runOpenItem(spec, opts = {}) {
  const { dir = null, resume = null, revisions = 3, seatOverrides = {}, makeClientFor, progress: emit = () => {},
          // agy_google commented out 2026-09-29 (operator: "Comment out agy_google"); same reason as the INTAKE
          // entry in src/role/seating.mjs -- a scout failure kills the ticket at intake. Restore
          // ["agy_google", "xai"] once the operator confirms the Gemini account is stable.
          scouts: SCOUT_VENDORS = ["xai"] /* ["agy_google", "xai"] */ } = opts;
  if (typeof makeClientFor !== "function") {
    throw new Error("runOpenItem: pass makeClientFor(vendor) -- this module never imports a vendor SDK");
  }
  for (const k of ["key", "title", "goal", "copy", "acceptance_cmd", "question"]) {
    if (spec[k] === undefined) throw new Error(`ticket spec is missing "${k}"`);
  }
  // A ticket names its file either singularly (`slot`, as every ticket written before this did) or
  // as a `slots` array, one entry per implementer. normalizeSlots below is what decides which.
  if (spec.slot === undefined && !Array.isArray(spec.slots)) throw new Error('ticket spec is missing "slot"');
  const runtimeRefusal=ticketRuntimeRefusal(spec);
  if(runtimeRefusal)throw new Error(runtimeRefusal);
  // Every path-shaped field is untrusted input here, not just at the HTTP door: this function is
  // an importable surface with three callers (the CLI, the build API, anything else that imports
  // it), and a ticket may have been drafted by a model rather than written by the operator. See
  // ticket-safety.mjs for the escapes this closes -- all of them were demonstrated by execution.
  const unsafe = ticketContainmentRefusal(spec);
  if (unsafe) throw new Error(`refusing this ticket: ${unsafe}`);
  // The files this ticket asks for, one per implementer. A singular slot/path ticket yields one
  // entry and behaves exactly as it always did; several entries mean several implementers, each
  // owning a DIFFERENT file, so none of them is grading or competing with another.
  const SLOTS = normalizeSlots(spec);
  const destinations = SLOTS.map(sl => resolve(sl.path));
  if (new Set(destinations).size !== destinations.length) throw new Error("duplicate artifact destination aliases");

  const REPO_ROOT = resolveRepoRoot(REPO, spec.repo_root);
  const packageInputs = packageContext(REPO_ROOT, spec.copy, SLOTS);
  const packageBinding = packageInputs.map(({ path, bytes }) => ({ path, bytes }));
  // INTERLEAVED ASSIGNMENT (opt-in, `interleave: true`; src/practice/assign.mjs): an eligible ticket's arm is a
  // deterministic hash of its key; `assignmentPolicy` ({eligible, halted}) names the eligible and halted strata.
  // An explicit `profile` wins and is recorded as such, never as randomized.
  const INTERLEAVE = opts.interleave === true;
  const stakesOfTicket = () => { try { return taskProfile(spec, { paths: SLOTS.map(sl => sl.path), mode: "batch" }).stakes.value; } catch { return null; } };
  const ASSIGNMENT_POLICY = { eligible: [...(opts.assignmentPolicy?.eligible ?? DEFAULT_ASSIGNMENT_POLICY.eligible)], halted: [...(opts.assignmentPolicy?.halted ?? [])] };
  const ASSIGNMENT = !INTERLEAVE ? null
    : opts.profile !== undefined && opts.profile !== null ? explicitAssignment({ profile: opts.profile, stakes: stakesOfTicket(), interleave: true })
    : { ...assignArm({ ticketKey: spec.key, stakes: stakesOfTicket(), policy: ASSIGNMENT_POLICY }), policy: ASSIGNMENT_POLICY };
  const profile = opts.profile ?? ASSIGNMENT?.arm ?? "argo";
  // A run called without a profile runs under argo. The lifecycle names `fit` (ophanim/operate/stages.mjs, its default
  // since 2026-11-17); `fit` is selected, never assumed, here.
  if (!["argo", "legacy", "fit"].includes(profile)) throw new Error("unknown routing profile");
  const pools = opts.pools ?? readPools();
  const cooldown = opts.cooldown ?? openCooldownStore(join(process.env.PANTHEON_COOLDOWN_DIR ?? join(homedir(), ".cache", "pantheon"), "v2"));
  const forRole = (role, options = {}) => frontierCandidates(role, { pools, ...options });
  const OVERRIDES = seatOverrides;
  // The one effective role-selection policy (src/route/frontier.mjs selectSeat): admission, then the
  // profile's choice, with explicit seats outranking it in a stated precedence. Every turn records it.
  // Each selection also names the admitted practice decision this dispatch loaded from the ledger (audit C3,
  // practice-kinds.mjs loadPractice): its entry hash, or null with the reason. Loaded once, on first use.
  // Under `fit` the ticket's task profile (its dimensions, the touched paths as the stakes signal) travels with
  // every selection; the legacy label is still what argo and legacy choose by.
  // SHADOW SELECTION (src/practice/shadow.mjs): beside each choice, the other profile's choice over the same
  // inputs (argo <-> fit; legacy is shadowed by fit) is recorded on every selection as `shadow` and `agrees`.
  // It is never dispatched: the caller gets the primary choice's candidates, which are exactly what they were.
  let PRACTICE = null, SHADOW_TASK;
  const shadowTask = () => {
    if (TASK) return TASK;
    if (SHADOW_TASK === undefined) { try { SHADOW_TASK = taskProfile(spec, { paths: SLOTS.map(sl => sl.path), mode: "batch" }); } catch { SHADOW_TASK = null; } }
    return SHADOW_TASK;
  };
  // A loaded decision that does not apply (its policy is not the one this dispatcher implements) is recorded
  // `applies: false` on every selection and the dispatch continues under the policy it does implement; it is
  // also surfaced: a `practice.warning` event and `practice_warning` at the top of run.json, naming the loaded
  // disposition and why it does not apply.
  const practiceNow = () => {
    if (PRACTICE) return PRACTICE;
    PRACTICE = loadPractice({ ledger: LEDGER?.ledger ?? null, scope: opts.practiceScope, profile, pools });
    if (PRACTICE.applies === false) {
      run.practice_warning = { code: "PRACTICE_NOT_APPLIED", disposition: PRACTICE.disposition, outcome: PRACTICE.outcome, scope: PRACTICE.scope,
        loaded_policy: PRACTICE.policy, ran_policy: (id => ({ version: id.policy, hash: id.hash, profile }))(selectionPolicy(profile, { pools })), reason: PRACTICE.reason };
      progress({ event: "practice.warning", detail: `loaded practice disposition ${PRACTICE.disposition} does not apply: ${PRACTICE.reason}` });
      record();
    }
    return PRACTICE;
  };
  const choose = (role, { chars = null, ...rest } = {}) => {
    const args = { difficulty: DIFFICULTY_OF_TICKET, pools, needsContext: chars === null ? null : contextEstimate(chars), roleOverride: OVERRIDES[role] ?? null };
    const primary = withPractice(selectSeat(role, { profile, ...args, ...(TASK ? { task: TASK } : {}), ...rest }), practiceNow());
    const task = profile === "fit" ? null : shadowTask();
    const shadow = profile !== "fit" && !task ? { profile: "fit", error: "the ticket has no valid task profile for fit" }
      : shadowSeat(role, { profile, args: { ...args, ...rest }, task });
    return withShadow(primary, shadow, ASSIGNMENT);
  };
  // WAS a synchronous refusal here for planner/implementer + agy_google unless
  // PANTHEON_AGY_TRANSPORT=cli was already set (scripts/agy-seat.py's --role choices are literally
  // ["reviewer", "scout", "fact-checker"] -- no "planner", no "implementer" -- so the SDK lane
  // genuinely cannot serve either role). REMOVED 2026-09-29, same day it was added: agyTurn below
  // now forces transport="cli" unconditionally for these two roles specifically, so the failure
  // mode this guard caught can no longer happen at all, on any input -- the fix moved from "refuse
  // the bad combination early" to "the bad combination is no longer constructible." A guard that
  // can never fire is not caution, it is a landmine for a future SEATING change that adds a role
  // this reasoning does not cover; removing it here rather than leaving it dark is the honest move.
  const RESUME = resume;
  // `retryStopped: "<reason>"` (resume only): the explicit action that lifts recorded escalation stops.
  // The escalation protocol the run decides a checker's rejection under (route/protocol.mjs). Default v1, as always;
  // "pantheon.escalation/v2" lets the same seat revise when no stronger one exists (the lifecycle asks for it).
  const ESCALATION = opts.escalation ?? null;
  if (ESCALATION !== null && !PROTOCOLS.includes(ESCALATION)) throw new Error(`unknown escalation protocol "${ESCALATION}"`);
  // IN-RUN REVIEW INDEPENDENCE. Default: the lab rule, as always (a reviewer shares no lab with a contribution to the
  // bytes it judges). `independence: "model"` (the lifecycle passes it only when the model rule is in force) seats the
  // in-run checker by MODEL identity instead, under a pinned identity policy: no reviewer that is a contributing model
  // -- the worker's, or a reviewer's whose findings reached a revision -- labs that did not contribute first, then a
  // non-contributing model of a contributing lab. Its reviews are recorded with that policy, and the ledger checks
  // them under it (lineage-kinds.mjs). The run records which rule it ran under.
  const IN_RUN_MODEL = opts.independence === "model";
  if (opts.independence !== undefined && !["lab", "model"].includes(opts.independence)) throw new Error(`unknown in-run independence "${opts.independence}"`);
  const ID_POLICY = IN_RUN_MODEL ? opts.identityPolicy ?? currentIdentityPolicy() : null;
  const RETRY_STOPPED = typeof opts.retryStopped === "string" && opts.retryStopped.trim() ? opts.retryStopped.trim() : null;
  if (opts.retryStopped !== undefined && (!RETRY_STOPPED || !RESUME)) throw new Error("retryStopped is a stated reason, and applies only to a resume");
  // `maxProviderCalls`: a bound on the provider calls this invocation may make, checked at the generation
  // boundary before EVERY call -- retries, fallbacks and truncation re-asks included -- rather than inferred
  // from commit bookkeeping (audit M5). It authorises nothing; omitted, no bound is imposed.
  // On a RESUME the bound is the run's, not a fresh one: omitted, the limit recorded in run.json is inherited and
  // the provider calls its attempts already made count against it (basis "inherited"); passed, it is the
  // operator's explicit new bound for this invocation's calls (basis "operator"). Which applied is recorded.
  const BOUND_GIVEN = opts.maxProviderCalls !== undefined && opts.maxProviderCalls !== null;
  let MAX_PROVIDER_CALLS = opts.maxProviderCalls ?? null;
  if (MAX_PROVIDER_CALLS !== null && !(Number.isSafeInteger(MAX_PROVIDER_CALLS) && MAX_PROVIDER_CALLS > 0))
    throw new Error("maxProviderCalls is a positive integer");
  let providerCalls = 0;
  // The ledger (pantheon/src/ledger, on packages/ledger) is ON BY DEFAULT: a run records on the ledger
  // at OPHANIM_LEDGER (one ledger shared by every run) or, unset, at <board root>/ledger, opened with
  // Pantheon's kinds. `ledger: false` turns it off; a recorder passed in is used as is (OPHANIM passes
  // its full composition's recorder for a ledger that also holds efficiency records). The run verifies it before relying on anything, and every turn,
  // review and escalation is an entry that re-derives. run.json keeps its copy for display only.
  let LEDGER = opts.ledger === false ? null : (opts.ledger ?? null);
  let escalationWork = 0;
  // Turn entries by prompt, so a critique can cite the work it reviews; work cites the plan it followed.
  const ledgerTurns = new Map();
  let planTurn = null;
  const recordTurn = t => {
    if (!LEDGER?.recordTurn) return;
    const hash = LEDGER.recordTurn({ ...t, cites: t.purpose === "work" && planTurn ? [planTurn] : [] });
    ledgerTurns.set(t.prompt, { hash, served_model: t.served_model, response_id: t.response_id });
    if (t.purpose === "plan") planTurn = hash;
  };
  const escalated = (work, rec) => { (run.escalations ??= []).push(rec); LEDGER?.record(work, rec); };
  // A slot's recorded decision, applied. Each action is its own bounded effect: effort, rung, and a TERMINAL
  // stop -- which ends that slot's generation (audit M2) instead of re-running it unchanged.
  const applyDecision = (c, rec, rev) => {
    const { action, to, cause, why } = rec.decision;
    if (action === "raise_effort") c.effort = to.effort;
    // raise_thinking (fit, Antigravity lanes): the same base model's next thinking level is another lane name, so it
    // is applied as a seat, like a rung.
    if (action === "step_rung" || action === "raise_thinking") { c.forced = { vendor: to.vendor, model: to.model, ...(action === "raise_thinking" ? { why: "thinking level raised" } : {}) }; c.effort = null; }
    if (action === "stop") c.stopped = { action, rev, cause, why };
    if (!["hold", "wait", "stop"].includes(action)) c.escalationSteps = (c.escalationSteps ?? 0) + 1;
  };
  // Under `fit`, an implementer on an Antigravity lane escalates on its matrix ladder (route/fit-matrix.mjs): the
  // ladder travels on the decision's seat, so the record re-derives from its own inputs (protocol.mjs nextStep).
  // Only a seat that RAN on a lane has one: the metered API answering as a quota failover carries effort and climbs
  // its own documented ladder, as any API seat does.
  const laneLadderOf = c => {
    const ladder = profile === "fit" ? c.choice?.seat?.selection?.matrix?.ladder : null;
    return Array.isArray(ladder) && laneParts(c.ranModel ?? c.choice.seat.model) ? { lane_ladder: ladder } : {};
  };
  // The output-token tier for this ticket's turns (config/tiers.mjs): the ticket's difficulty, else medium.
  // Under `fit` the tier is the profile's own `output` dimension (xs..xl, or the legacy label's default).
  const DIFFICULTY_OF_TICKET = spec.difficulty ?? "medium";
  if (typeof DIFFICULTY_OF_TICKET !== "string" || !Object.hasOwn(TOKEN_TIERS, DIFFICULTY_OF_TICKET)) throw new Error(`unknown ticket difficulty "${DIFFICULTY_OF_TICKET}" (known: ${Object.keys(TOKEN_TIERS).join(", ")})`);
  const TASK = profile === "fit" ? taskProfile(spec, { paths: SLOTS.map(sl => sl.path), mode: "batch" }) : null;
  const TIER = TASK ? TASK.output.value : DIFFICULTY_OF_TICKET;
  // Where the work item's title comes from (docs/reviews/2026-11-17-review-capacity): `model`, a planner model writes
  // one line restating the goal (and so contributes to the reviewed change); `ticket`, deterministic code uses the
  // ticket's own title and no model contributes a plan. The worker reads the ticket's goal either way.
  const PLAN_TITLE = opts.planTitle ?? "model";
  if (!["model", "ticket"].includes(PLAN_TITLE)) throw new Error(`unknown planTitle "${PLAN_TITLE}" (known: model, ticket)`);
  const root = RESUME ?? dir ?? join(homedir(), ".pantheon", "boards", `open-${spec.key}-${Date.now()}`);
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  const home = join(root, "seats");                 // isolated: never the operator's real seat store
  const outDir = join(REPO_ROOT, "outputs", "open-items", spec.key);
  mkdirSync(outDir, { recursive: true });

  const board = openBoard(root);
  if (opts.ledger === undefined) {
    const { openPantheonLedger } = await import("../ledger/system.mjs");
    // `ledgerRoot` names the ledger outright, ahead of OPHANIM_LEDGER: a paired run's dry counterpart
    // (board/operate.mjs) records on a ledger of its own, never on the shared one.
    LEDGER = openPantheonLedger({ root: opts.ledgerRoot ?? process.env.OPHANIM_LEDGER ?? join(root, "ledger"), board }).recorder();
  }
  // The board's recorder on the ledger; at ship it also records the gate verdict.
  let BOARD_LEDGER = null;
  // What the verify accepted without re-deriving it: entries of a domain this registry does not supply
  // (`foreign`), and parts of entries whose board is gone (`partial`). Reported in run.json, never hidden.
  let LEDGER_UNDERIVED = null;
  if (LEDGER) {
    const v = LEDGER.verify();
    if (!v.ok) throw new Error(`ledger does not verify, refusing to run: ${v.why}`);
    if (v.complete === false) LEDGER_UNDERIVED = { foreign: v.foreign, partial: v.partial.length };
    // The board's own records on the same ledger: lease changes, budget limits and ref moves are entries
    // first (pantheon/src/ledger/board-kinds.mjs), and a change the ledger refuses does not happen.
    if (typeof LEDGER.board === "function") { BOARD_LEDGER = LEDGER.board(root); board.useLedger(BOARD_LEDGER); }
  }
  const HUMAN = { vendor: "human" };
  const CONTROLLER = { vendor: "controller" };
  const REF = `refs/board/${spec.key}`;
  // The legacy singular names, derived from the normalized plan rather than the raw ticket, so a
  // `slots`-only ticket still has them. They mean "the first slot" and are what the resume branch
  // and the crash-salvage path use; multi-slot code paths use SLOTS/BUILT instead.
  const SLOT = SLOTS[0].slot;
  const PATH = SLOTS[0].path;
  const ITEM = spec.key;
  const FILE = join(worktree, PATH);
  const CMD = spec.acceptance_cmd;
  const CARRY = ["plan", "item:", "critique:"];    // a carry never ships code

  // Printing is a CLI concern; this function is silent on the console by design. `check`'s
  // failures-count IS real run state (it gates the final `ok`), so that stays -- only the console
  // line becomes a structured `check` event instead.
  let failures = 0;
  const bar = () => {};
  const say = () => {};
  const check = (ok, line) => { if (!ok) failures++; progress({ event: "check", ok, detail: line }); };
  const clients = {};
  const clientFor = (v, pool, poolConfig) => (clients[`${v}:${pool ?? v}`] ??= makeClientFor(v, { pool, poolConfig }));
  const ticketCid = cidOf("entry", JSON.parse(JSON.stringify({ ...spec, repo_root: REPO_ROOT, slots: SLOTS, package_context: packageBinding })));
  const statePath = join(root, "run.json");
  let recordAllowed = false;
  const run = { format: 2, isolation: ACCEPTANCE_ISOLATION, ticket_cid: ticketCid, repo_root: REPO_ROOT,
    key: spec.key, started_at: new Date().toISOString(), board: root, reseats: OVERRIDES,
    package_context: packageBinding, turns: [], gates: null, shipped: false, artifacts: [], files: [],
    // Every provider call this run made, successful or not, in order (audit M5); `resources` is derived from it.
    attempts: [], resources: resourcesOf([]), provider_calls: { limit: MAX_PROVIDER_CALLS, made: 0, refused: null },
    // What answered (continuous evaluation, src/practice/evaluate.mjs): only `kind: "live"` is live evidence, and
    // a run that declares nothing counts as synthetic. Declared by the caller (`providers`) or on makeClientFor.
    providers: { kind: String((opts.providers ?? makeClientFor.providers ?? null)?.kind ?? "undeclared") },
    profile, ...(ASSIGNMENT ? { assignment: ASSIGNMENT } : {}) };
  // Admitted at the generation boundary, before the call: past the bound, nothing is sent and the refusal
  // is named (PROVIDER_CALL_LIMIT). The routers treat it as non-retryable, so it ends the role's routing.
  function admitProviderCall({ vendor, model, pool, transport, purpose }) {
    if (MAX_PROVIDER_CALLS !== null && providerCalls >= MAX_PROVIDER_CALLS) {
      const why = `PROVIDER_CALL_LIMIT: this run has made ${providerCalls} of its ${MAX_PROVIDER_CALLS} permitted provider call(s); ` +
        `${vendor}/${model} (${purpose}) was not called`;
      run.provider_calls = { ...run.provider_calls, limit: MAX_PROVIDER_CALLS, made: providerCalls,
        refused: { code: "PROVIDER_CALL_LIMIT", at: new Date().toISOString(), vendor, model, pool: pool ?? vendor, transport, purpose, why } };
      progress({ event: "turn.refused", seat: vendor, model, detail: why });
      record();
      throw Object.assign(new Error(why), { code: "PROVIDER_CALL_LIMIT" });
    }
    providerCalls++;
    run.provider_calls = { ...run.provider_calls, limit: MAX_PROVIDER_CALLS, made: providerCalls, refused: null };
  }
  function recordAttempt(a) {
    const attempts = (run.attempts ??= []);
    attempts.push({ n: attempts.length + 1, at: new Date().toISOString(), ...a });
    run.resources = resourcesOf(attempts);
    // Admitted before the call, but the seat layer refused it before any request was sent: no provider was
    // called, so it does not count against the bound.
    if (a.provider_requests === 0 && providerCalls > 0) {
      providerCalls--;
      run.provider_calls = { ...run.provider_calls, made: providerCalls };
    }
  }
  let seatingShown = 0;
  const record = () => {
    if (!recordAllowed) return;
    // The seating report, as the selector chose it (seatingOf): kept on the run and streamed as each seat answers.
    run.seating = seatingOf(run);
    for (const row of run.seating.slice(seatingShown)) progress({ event: "seating", role: row.role, seat: row.vendor, model: row.model, detail: row.line });
    seatingShown = run.seating.length;
    const text = JSON.stringify(run, null, 2);
    // The board owns recovery. The output copy is only a convenience index shared by a ticket key.
    writeArtifact(root, "run.json", text);
    writeArtifact(REPO_ROOT, relative(REPO_ROOT, join(outDir, "run.json")), text);
  };
  function exportShipped() {
    run.artifacts = run.files.map(c => ({ slot: c.slot, path: c.path, cid: c.artifactCid, bytes: c.bytes,
      copied_to: artifactPath(REPO_ROOT, relative(REPO_ROOT, join(outDir, "artifact", c.path))) }));
    for (const art of certifiedArtifacts(run, { repoRoot: REPO_ROOT, outDir })) {
      writeArtifact(REPO_ROOT, relative(REPO_ROOT, art.copied_to), art.contents);
    }
    run.artifact = run.artifacts[0]; // compatibility for single-file consumers; the manifest is authoritative.
  }

  // PROGRESS IS A STREAM, NOT A REPORT. Every stage, every seat call, every executed result is
  // appended to progress.jsonl AND handed to the caller's `emit` (an HTTP caller publishes it on a
  // live bus; the CLI wrapper prints from it; neither is required -- an omitted `emit` just means
  // the disk trail is the only record).
  const T0 = Date.now();
  let stage = "start";
  function progress(ev) {
    const row = { at: new Date().toISOString(), elapsed_s: Math.round((Date.now() - T0) / 10) / 100, stage, ...ev };
    const line = JSON.stringify(row) + "\n";
    for (const f of [join(outDir, "progress.jsonl"), join(root, "progress.jsonl")]) { try { appendFileSync(f, line); } catch { /* emit below still carries it */ } }
    try { emit(row); } catch { /* one broken subscriber must not break the run */ }
  }
  const enter = (name, detail = "") => { stage = name; progress({ event: "stage.start", detail }); };

  // THE ANTIGRAVITY SEAT. The CLI's --agent lane consumes cached OAuth and emits NDJSON events.
  // Keep the SDK as default until a live OAuth turn produces an observed answer: the CLI can exit
  // zero with SUCCESS, zero turns and empty response on print timeout. Renaming an OAuth token
  // GEMINI_API_KEY cannot authenticate the SDK. PANTHEON_AGY_TRANSPORT=cli opts into the new lane.
  let agyN = 0;
  async function agyTurn({ purpose, model, prompt, declared = null, timeoutS = Number(process.env.PANTHEON_AGY_TIMEOUT ?? 900) }) {
    const role = purpose === "critique" ? "reviewer" : purpose === "scout" ? "scout" : purpose === "plan" ? "planner"
      : purpose === "work" ? "implementer" : null;
    if (!role) throw new Error(`agy seat: no Antigravity agent is defined for purpose "${purpose}"`);
    // planner/implementer are CLI-ONLY, not merely CLI-preferred: agy-seat.py's own --role choices
    // are ["reviewer", "scout", "fact-checker"] -- there is no SDK-lane code path for either role,
    // ever, on any input. Discovered 2026-09-29 the hard way: SEATING.planner/implementer's new
    // agy_google top rungs are the DEFAULT table now, not an operator override, so the synchronous
    // OVERRIDES-only guards above never fire for them -- a real ticket with no special setup would
    // otherwise silently default to the SDK lane and die on a missing --role or a missing
    // GEMINI_API_KEY, exactly backwards from what today's seating change was for. Forcing CLI here,
    // unconditionally, for these two roles specifically, is the actual fix; PANTHEON_AGY_TRANSPORT
    // still governs scout/reviewer, which genuinely support both lanes.
    // A declared lane (lanes.json: transport agy-cli) is served by that transport for every role (audit M6).
    const transport = (role === "planner" || role === "implementer" || declared === "agy-cli") ? "cli" : (process.env.PANTHEON_AGY_TRANSPORT ?? "sdk");
    const dir = join(outDir, "agy_google", `${purpose}-${++agyN}`); mkdirSync(dir, { recursive: true });
    // The implementer keeps its real NO_TOOLS prompt untouched: it is genuinely tool-less on every
    // transport (run-item.mjs applies its text reply to disk itself -- see the WORK stage above),
    // so appending a "you have tools" line here, true for the other three roles, would be a false
    // claim and would break the one property every vendor's implementer shares: reply is text, not
    // a tool call. pantheon-implementer/agent.md's own tools: [] enforces the same thing card-side.
    const brief = role === "implementer" ? prompt : prompt.split(NO_TOOLS).join("") +
      (role === "planner"
        ? `\n\nYou have tools in this seat. The workspace ${worktree} is the ticket's project tree, read-only at this stage -- no artifact exists yet. Answer exactly in the format your brief above asked for.`
        : role === "scout"
          ? `\n\nYou have read tools in this seat. The workspace ${worktree} is the ticket's project tree before implementation. Inspect the files you cite; no artifact exists yet.`
          : `\n\nYou have tools in this seat. The workspace ${worktree} is the tree under review, with the artifact already written into it. ` +
            "Run the acceptance command yourself and quote what it printed; open the files you cite. Hand the fact-checker subagent one direct check at a time.");
    writeFileSync(join(dir, "brief.txt"), brief);
    let schemaPath = null;
    if (role === "reviewer") {
      schemaPath = join(dir, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(CRITIQUE_SCHEMA));
    }
    let res;
    if (transport === "cli") {
      const cli = process.env.PANTHEON_AGY_CLI ?? join(homedir(), ".local", "bin", "agy");
      if (cli.includes("/") && !existsSync(cli)) throw new Error(`agy seat: CLI absent at ${cli} (set PANTHEON_AGY_CLI)`);
      res = await runAgyCliTurn({ cli, repo: REPO, worktree, role, model, prompt: brief,
        timeoutS, schemaPath, onEvent: ev => progress({ seat: "agy_google", model, ...ev }) });
    } else if (transport === "sdk") {
      const python = process.env.PANTHEON_AGY_PYTHON ?? join(homedir(), "Projects", "agentic-pipeline", "sdk", ".venv-antigravity", "bin", "python");
      if (!existsSync(python)) throw new Error(`agy seat: venv python absent at ${python} (set PANTHEON_AGY_PYTHON)`);
      if (!process.env.GEMINI_API_KEY && !process.env.PANTHEON_AGY_VERTEX_PROJECT) throw new Error("agy seat: GEMINI_API_KEY is not in the environment (or set PANTHEON_AGY_VERTEX_PROJECT for Vertex ADC)");
      const args = [join(REPO, "scripts", "agy-seat.py"), "--role", role, "--workspace", worktree, "--repo", REPO,
        "--model", model, "--brief", join(dir, "brief.txt"), "--out", dir,
        "--progress", join(outDir, "progress.jsonl"),
        "--stage", purpose === "critique" ? "check" : purpose === "plan" ? "plan" : "intake",
        "--timeout", String(timeoutS)];
      if (schemaPath) args.push("--schema", schemaPath);
      const run = await spawnPromise(python, args, { env: process.env, timeout: (timeoutS + 60) * 1000 });
      const last = (run.stdout ?? "").trim().split("\n").filter(Boolean).pop();
      let out = null;
      try { out = last ? JSON.parse(last) : null; } catch { /* malformed vendor envelope */ }
      if (run.status !== 0 || !out?.ok) {
        const tail = (run.stderr ?? "").split("\n").filter(l => l && !l.startsWith("{")).slice(-3).join(" | ");
        throw new Error(`agy SDK seat exited ${run.status ?? run.signal}: ${out?.error ?? tail}`);
      }
      res = { text: existsSync(join(dir, "response.md")) ? readFileSync(join(dir, "response.md"), "utf8") : "",
        structured_output: out.structured_output ?? null, response_id: out.conversation_id ?? null,
        usage: out.usage ?? null, tool_calls: out.tool_calls ?? 0, subagent_calls: out.subagent_calls ?? 0 };
    } else {
      throw new Error(`agy seat: unknown PANTHEON_AGY_TRANSPORT "${transport}" (expected sdk or cli)`);
    }
    let text = res.text;
    const so = res.structured_output;
    if (so && typeof so === "object" && so.verdict) {
      const lines = (so.findings ?? []).map(f => `${f.severity}: ${f.note}`);
      text = [so.narrative ?? "", ...lines, text.trim(), `VERDICT: ${so.verdict}`].filter(Boolean).join("\n\n");
    }
    if (transport === "cli") {
      writeFileSync(join(dir, "response.md"), text);
      writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: true, role, model,
        conversation_id: res.response_id, usage: res.usage, tool_calls: res.tool_calls,
        subagent_calls: res.subagent_calls }, null, 2));
    }
    return { text, response_id: res.response_id, usage: res.usage, tool_calls: res.tool_calls, subagent_calls: res.subagent_calls };
  }

  // A quota failover that was NOT used is on the progress trail with its reason, so "the metered API was not called"
  // is a recorded fact rather than an absence.
  function skippedFailover({ seat, why }) { progress({ event: "quota_failover.skipped", seat: seat.vendor, model: seat.model, detail: why }); }

  async function turn({ vendor, purpose, model, prompt, extra = undefined, pool, poolConfig, signal, effort = null, transport = null, selection = null, quota_failover = null }) {
    const t0 = Date.now();
    // The metered Gemini API answering as the QUOTA FAILOVER of an Antigravity lane (route/quota-failover.mjs): the
    // lane refusal it followed is recorded on every attempt and on the turn, beside the selection that carries it too.
    const failover = quota_failover?.used ? { quota_failover } : {};
    if (failover.quota_failover) progress({ event: "quota_failover", seat: vendor, model, detail: `metered API used as quota failover of ${quota_failover.lanes.join(", ")}: ${quota_failover.after.map(a => `${a.lane} ${a.outcome} (${a.source})`).join("; ")}` });
    progress({ event: "turn.start", seat: vendor, model, detail: `${purpose}, ${prompt.length} chars of prompt` });
    // The seat's own transport decides the path; a seat built before transports were recorded falls back
    // to the rule the transports encode (a non-frontier agy_google model is not an API id).
    const lane = transport ? transport !== "api" : vendor === "agy_google" && !isFrontier(model);
    const chosen = selection ? { selection } : {};
    if (lane) {
      // The lane takes no effort or output cap: none is sent, so none is recorded as sent.
      const settings = { model, pool: pool ?? vendor, transport: transport ?? "agy", effort: null, max_output_tokens: null, output_budget_policy: null };
      // Antigravity serves Gemini models only (owner direction 2026-11-17). Refused before any call or charge.
      const made = resolveModel(vendor, model);
      if (made?.known && made.lab !== "google") throw Object.assign(new Error(`the Antigravity transport serves Gemini models only: ${model} is a ${made.lab} model`), { code: "AGY_GEMINI_ONLY" });
      admitProviderCall({ vendor, model, pool, transport: settings.transport, purpose });
      let r;
      const a0 = Date.now();
      try { r = await agyTurn({ purpose, model, prompt, declared: transport }); }
      catch (e) {
        recordAttempt({ vendor, model, pool: pool ?? vendor, transport: settings.transport, purpose, outcome: failureOutcome(e),
          status: e?.status ?? null, code: e?.code ?? null, why: String(e?.message ?? e).slice(0, 200), usage: null, settings, ms: Date.now() - a0 });
        progress({ event: "turn.error", seat: vendor, model, detail: String(e?.message ?? e).slice(0, 200) }); throw e;
      }
      const ms = Date.now() - t0;
      const usage = usageOf(r.usage);
      recordAttempt({ vendor, model, pool: pool ?? vendor, transport: settings.transport, purpose, outcome: "ok", status: null, code: null, why: null, usage, settings, ms: Date.now() - a0 });
      // The agy transports take no effort. The protocol never decides one for these seats; if one
      // arrives anyway it is recorded as not carried rather than silently dropped.
      run.turns.push({ vendor, model, pool: pool ?? vendor, transport: transport ?? "agy", purpose, ms, chars: r.text.length, prompt_chars: prompt.length, response_id: r.response_id, streamed: true,
        tool_calls: r.tool_calls, subagent_calls: r.subagent_calls, usage, settings, attempts: 1, ...(effort ? { effort_not_carried: effort } : {}),
        served_model: model, served_model_source: "input", ...chosen });
      // FORMAT REQUIREMENT (owner direction 2026-11-17). The Antigravity transports return no serving model. The model
      // is a REQUIRED INPUT of the call (the CLI lane also checks it against the model the CLI reports at start, and
      // fails on a mismatch or an unknown model), so the output carries that input as its model, marked
      // served_model_source "input": it is the pinned model, not a statement by the provider about this answer.
      recordTurn({ seat: { seat_id: `${vendor}-${purpose}@${model}`, vendor, mode: purpose, occupancy_gen: 1 },
        requested_model: model, served_model: model, served_model_source: "input", response_id: r.response_id ?? null, reply: r.text, purpose, prompt, ...chosen });
      progress({ event: "turn.done", seat: vendor, model, ms, detail: `${r.text.length} chars, ${r.tool_calls} tool call(s), ${r.subagent_calls} subagent(s)` });
      return r.text;
    }
    // STREAMED. A non-streaming call on a long prompt sat past the fetch headers timeout while
    // grok-4.7 was still thinking; with a stream the headers arrive immediately and the deltas let
    // an overseer say "still writing: N chars" instead of nothing.
    let chars = 0, lastNote = Date.now();
    const onEvent = e => {
      if (e.type === "delta" && e.text) { chars += e.text.length; if (Date.now() - lastNote > 10_000) { lastNote = Date.now(); progress({ event: "turn.progress", seat: vendor, model, detail: `${chars} chars so far` }); } }
      else if (e.type === "error") progress({ event: "turn.error", seat: vendor, model, detail: e.text ?? "stream error" });
    };
    // The ticket's difficulty picks the output tier; the budget is sent explicitly, so what is recorded
    // is what was asked for. A caller's own budget (e.g. the reviewer's 4000) still wins.
    let r, steps = 0, budget = extra;
    const work = `turn:${purpose}:${++escalationWork}`;   // one truncation trail per turn
    // Under `fit` the ticket's declared output size IS the cap, sent explicitly on every API seat (capped at the
    // model's documented ceiling): the dimension must reach the serialized request, not only the selection record
    // (owner audit CS3). Elsewhere, only Anthropic's Messages path needs a cap of its own; other frontier seats keep
    // the client's long-decode default, and the argo selection reason says so.
    if (budget === undefined && TASK) budget = capFor(vendor, { tokens: outputBudgetFor(model, TIER).tokens });
    else if (budget === undefined && vendor === "anthropic") budget = capFor(vendor, { tokens: defaultOutputFor(vendor, model, TIER) });
    // The settings an attempt ran with: as SENT where the adapter observed the request (after every default
    // and policy applied), otherwise as requested -- and `basis` says which (audit M5).
    const settingsOf = (res, asked) => {
      const sent = res?.sent ?? null;
      return { model: sent?.model ?? model, pool: pool ?? vendor, transport: transport ?? "api",
        effort: sent ? sent.effort : (effort ?? null),
        max_output_tokens: sent ? sent.max_output_tokens : (asked?.max_tokens ?? asked?.max_output_tokens ?? asked?.config?.maxOutputTokens ?? null),
        output_budget_policy: res?.output_budget_policy ?? null, basis: sent ? "sent" : "requested" };
    };
    const attemptOf = (extraFields, a0) => ({ vendor, model, pool: pool ?? vendor, transport: transport ?? "api", purpose, ms: Date.now() - a0, ...failover, ...extraFields });
    let turnAttempts = 0, settings = null;
    for (;;) {
      // With a ledger, the seat's stored conversation is checked against the ledger's turn entries for
      // the same seat before it is continued (seat-sdk: LEDGER_MISMATCH), not only against itself.
      const seatLedger = typeof LEDGER?.exchanges === "function" ? { exchanges: () => LEDGER.exchanges(`${vendor}-${purpose}@${model}`) } : null;
      admitProviderCall({ vendor, model, pool, transport: transport ?? "api", purpose });
      turnAttempts++;
      const a0 = Date.now(), asked = budget;
      try { r = await (opts.runSeatTurn ?? sdkTurn)({ vendor, purpose: `${purpose}@${pool ?? vendor}@${model}`, cwd: worktree, prompt, model, client: clientFor(vendor, pool, poolConfig), home, onEvent, signal,
        ...(seatLedger ? { ledger: seatLedger } : {}),
        architecture: opts.architecture === true, contractHeader: opts.contractHeader, label: `${vendor}-${purpose}`, ...(budget ? { extra: budget } : {}),
        ...(effort ? { effort } : {}) }); }
      catch (e) {
        // A failed request is evidence too: its outcome as the router classifies it, and what it carried.
        recordAttempt(attemptOf({ outcome: failureOutcome(e), status: e?.status ?? null, code: e?.code ?? null,
          why: String(e?.message ?? e).slice(0, 200), usage: null, settings: settingsOf(e, asked), provider_requests: e?.provider_requests ?? null }, a0));
        progress({ event: "turn.error", seat: vendor, model, detail: String(e?.message ?? e).slice(0, 200) }); throw e;
      }
      settings = settingsOf(r.result, asked);
      // ok: a usable reply. incomplete: the provider answered but the reply is not usable (truncated,
      // refused by its terminal state) -- its usage is still what it consumed. refused_seat: the seat layer
      // refused before any request (a held conversation, an unresolved turn), so nothing was sent.
      recordAttempt(attemptOf({ outcome: r.ok ? "ok" : r.result ? "incomplete" : "refused_seat", status: null, code: r.code ?? null,
        why: r.ok ? null : r.why ?? null, terminal_state: r.result?.terminal_state ?? null, usage: usageOf(r.result?.usage),
        settings, provider_requests: r.result ? r.result.provider_requests ?? null : 0 }, a0));
      if (r.ok || !r.result) break;
      // A reply cut off by its output budget is an outcome for the protocol: the only change it makes is
      // a larger budget within the model's documented ceiling. The refused turn was not persisted, so
      // the retry starts from the same conversation. Every decision is recorded on the run.
      const output = budget?.max_tokens ?? budget?.max_output_tokens ?? budget?.config?.maxOutputTokens
        ?? defaultOutputFor(vendor, model, TIER);
      const rec = escalationRecord({ role: ROLE_OF_PURPOSE[purpose] ?? purpose, steps,
        outcome: { kind: "turn", complete: false, terminal_state: r.result.terminal_state ?? null, why: r.why },
        seat: { vendor, model, effort: effort ?? null, output } });
      escalated(work, { purpose, tier: TIER, ...rec });
      progress({ event: "escalate", seat: vendor, model, detail: `${rec.decision.action}: ${rec.decision.why}`.slice(0, 300) });
      if (rec.decision.action !== "raise_output") break;
      const raised = capFor(vendor, { tokens: rec.decision.to.output });
      budget = { ...budget, ...raised, ...(raised.config ? { config: { ...budget?.config, ...raised.config } } : {}) };
      steps++;
    }
    if (!r.ok) { progress({ event: "turn.error", seat: vendor, model, detail: r.why }); throw new Error(`${vendor}/${purpose}: ${r.why}`); }
    const text = r.result.text ?? "";
    const ms = Date.now() - t0;
    // The successful request's usage and settings; every request the turn took is in run.attempts.
    run.turns.push({ vendor, model, pool: pool ?? vendor, transport: transport ?? "api", purpose, ms, chars: text.length, prompt_chars: prompt.length, response_id: r.result.response_id ?? null, streamed: r.result.streamed ?? false,
      served_model: r.result.served_model ?? null, usage: usageOf(r.result.usage), settings, attempts: turnAttempts, ...failover, ...chosen });
    // On the ledger: signed by this seat occupancy, with the served model the provider reported beside
    // the requested one. The seat is identified as the conversation layer keys it (vendor, purpose and
    // model: sdkTurn's seat is `${purpose}@${pool}@${model}`), so two slots running different models are
    // two seats, never one seat that "changed model".
    recordTurn({ seat: { seat_id: `${vendor}-${purpose}@${model}`, vendor, mode: purpose, occupancy_gen: r.seat?.model_gen ?? 1 },
      requested_model: model, served_model: r.result.served_model ?? null, response_id: r.result.response_id ?? null, reply: text, purpose, prompt,
      tools: r.result.tools ?? [], ...chosen });
    progress({ event: "turn.done", seat: vendor, model, ms, detail: `${text.length} chars` });
    return text;
  }

  /** Walk the seating table's fallbacks on a TRANSPORT failure only. */
  // `choice` is a selection already made (selectSeat): the implementer's slot seat, an escalation's rung, a
  // reviewer paired in advance. It is used as selected -- model, transport, pool and pool configuration --
  // and never re-resolved from a model pin through the first registry pool (audit M3, M6).
  async function roleTurn({ role, purpose, prompt, avoid = [], avoidLabs = [], extra = undefined, effort = null, choice = null }) {
    choice ??= choose(role, { avoid, avoidLabs, chars: prompt.length });
    const candidates = choice.candidates;
    if (!candidates?.length || candidates.some(c => !c)) throw new Error(`no seated candidate for "${role}"`);
    // An escalated effort belongs to the model it was decided for; a fallback model gets its own default.
    // A `fit` candidate carries the effort its profile mapped onto its own ladder; others carry none.
    const effortFor = candidate => effort && candidate.model === effort.model ? effort.value : candidate.effort ?? null;
    const routed = await routeSeats({ onSkip: skippedFailover, candidates, cooldown, signal: opts.signal,
      deadline: Date.now() + (opts.turnTimeoutMs ?? 900_000),
      invoke: (candidate, { signal }) => turn({ ...candidate, purpose, prompt, signal, extra: capFor(candidate.vendor, extra),
        effort: effortFor(candidate) }) });
    // `effort` is what the seat that ANSWERED was sent, so a later escalation can start from it.
    return { text: routed.value, seat: routed.seat, effort: effortFor(routed.seat) };
  }

  function repoHead() {
    try {
      const h = readFileSync(join(REPO, ".git", "HEAD"), "utf8").trim();
      return h.startsWith("ref: ") ? readFileSync(join(REPO, ".git", h.slice(5)), "utf8").trim() : h;
    } catch { return ""; }
  }

  /** Execute the combined change in the mandatory boundary, then check the bytes it judged. */
  function assertPackageContext() {
    for (const { path, bytes } of packageBinding) {
      const actual = readArtifact(worktree, path);
      if ((actual === null ? null : cidOf("blob", actual)) !== bytes) {
        throw new Error(`Package context changed: ${path}; the bound source scope was not tested unchanged`);
      }
    }
  }
  async function runAcceptance(crew) {
    assertPackageContext();
    const result = await isolatedAcceptance({ worktree, cmd: CMD, head: repoHead() });
    try { assertPackageContext(); } catch (error) {
      result.exit = 1;
      result.out += `\n${error.message}\n`;
    }
    for (const c of crew) {
      const actual = readArtifact(worktree, c.sl.path);
      if (actual === null || cidOf("blob", actual) !== c.bytes) {
        result.exit = 1;
        result.out += `\nArtifact changed during acceptance: ${c.sl.path}; the recorded CAS bytes were not tested unchanged.\n`;
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- the `fit` explorer stage
  // Under `fit`, intake breadth is the profile's `explorer_width` (ambiguity settled|open|contested -> 0|1|3
  // DISTINCT labs), each scout chosen by the fit selector (selectSeat), never the legacy INTAKE table or the
  // configured scout vendors. Width 0 is no explorer stage at all. Scouts are chosen one at a time, each
  // avoiding the vendors and labs that already ANSWERED, so a fallback cannot put two scouts in one lab; too
  // few eligible labs is a named refusal, not a narrower fan-out. Each scout's selection is recorded.
  async function fitIntake() {
    const width = requirementsOf(TASK).explorer_width;
    run.intake = { profile, explorer_width: width, scouts: [] };
    if (width.value === 0) {
      run.intake.skipped = `explorer width 0 (${width.basis}): no explorer stage`;
      progress({ event: "intake.skip", detail: run.intake.skipped });
      record();
      return [];
    }
    assertFanOutIsOutside({ stage: "intake", depth: 0, width: width.value });
    enter("intake", `${width.value} distinct-lab scout(s): fit explorer width (${width.basis})`);
    const p = promptFor("scout", { question: spec.question },
      NO_TOOLS + "Answer from what you already know in at most four sentences, name the concrete failure rather than a " +
      "category, and end with one line: `RAN: nothing`.");
    const refuse = why => Object.assign(new Error(`EXPLORER_LABS_UNAVAILABLE: explorer width ${width.value} (${width.basis}) needs ` +
      `${width.value} distinct-lab scouts; ${why}`), { code: "EXPLORER_LABS_UNAVAILABLE" });
    // Refused before any scout is called when the selector cannot reach enough labs.
    const reachable = labsReachable("scout", { chars: p.prompt.length });
    if (reachable.length < width.value) throw refuse(`only ${reachable.length} lab(s) are eligible (${reachable.join(", ") || "none"})`);
    const found = [], avoid = [], avoidLabs = [];
    for (let k = 0; k < width.value; k++) {
      // The operator's scout seat, if any, is the first scout; the others are the selector's, across labs.
      let choice;
      try { choice = choose("scout", { avoid, avoidLabs, chars: p.prompt.length, ...(k ? { roleOverride: null } : {}) }); }
      catch (e) { throw refuse(`scout ${k + 1} has no candidate after avoiding labs ${avoidLabs.join(", ")}: ${e.message}`); }
      const routed = await routeSeats({ onSkip: skippedFailover, candidates: choice.candidates, cooldown, signal: opts.signal,
        invoke: (candidate, { signal }) => {
          const cap = tokenCapFor("scout", candidate.model);
          return turn({ ...candidate, purpose: "scout", prompt: p.prompt, signal,
            extra: cap == null ? undefined : capFor(candidate.vendor, { tokens: cap }) });
        } });
      const vendor = routed.seat.vendor, lab = labOf(vendor, routed.seat.model);
      if (avoidLabs.includes(lab) || avoid.includes(vendor)) throw refuse(`scout ${k + 1} answered from ${vendor}/${routed.seat.model}, a lab already used`);
      // The author names the occupant that answered.
      const scoutSeat = nextOccupancy(null, routed.seat, { seat_id: `${vendor}-scout`, mode: "explore" });
      const r = await publish({ ...board, ref: `refs/iso/${vendor}/scout`, author: scoutSeat, msg: `scout ${vendor}`,
        entries: [{ kind: "search", payload: { query: spec.question, urls: [] }, blob: routed.value }] });
      if (!r.ok) throw new Error(`scout ${vendor} publish: ${r.why}`);
      found.push({ vendor, ref: `refs/iso/${vendor}/scout`, commit: r.commit, evidence: r.written[0].cid, text: routed.value });
      run.intake.scouts.push({ vendor, model: routed.seat.model, lab, pool: routed.seat.pool, selection: routed.seat.selection });
      avoid.push(vendor); avoidLabs.push(lab);
      record();
    }
    return found;
  }

  // The distinct labs a role's selector can reach under the given exclusions: its admitted policy candidates,
  // plus the operator's role-wide seat when that seat's lab is not excluded. Used to refuse a `fit` fan-out
  // that cannot be as wide as its profile requires before any seat in it is called.
  // Under `fit`, before any work call: can the review panel the stakes require be formed from the CONFIGURED
  // in-run reviewer pool, given this slot's actual producers? Law 3 excludes the maker's and the planner's labs.
  // Producers are chosen on their own merits and are never moved to make a panel possible (owner control
  // contract, "Functional roles and valid worker escalation": do not force title/file workers onto one vendor to
  // manufacture a numeric panel). A shortage is a named pending state that names the configured pool, not a claim
  // about how many labs exist; the operator may reseat explicitly or qualify another reviewer pool. The plan stays
  // on the board; no work generation is spent on a change that cannot be reviewed as required.
  function reviewCapacity(slots, planLab) {
    const need = TASK ? requirementsOf(TASK).review_labs.value : 1;
    if (need < 2) return;
    for (const c of slots) {
      const makerLab = labOf(c.seat.vendor, c.model ?? null);
      const used = [...new Set([planLab, makerLab].filter(Boolean))];
      const labs = labsReachable("reviewer", { avoid: used.flatMap(l => vendorsOfLab(l)), avoidLabs: used, chars: null });
      if (labs.length < need) throw Object.assign(new Error(`REVIEW_CAPACITY_PENDING: ${c.sl.slot} needs ${need} independent review labs ` +
        `(stakes ${TASK.stakes.value}); the configured in-run reviewer pool, excluding the producers' labs (${used.join(", ")}), ` +
        `offers ${labs.length} (${labs.join(", ") || "none"}). This is a shortage of the configured pool, not of possible reviewers: ` +
        `reseat a producer explicitly or qualify another reviewer pool. Refused before any work call; the plan is kept.`),
        { code: "REVIEW_CAPACITY_PENDING", pending: { slot: c.sl.slot, need, offered: labs, producer_labs: used } });
    }
  }
  function labsReachable(role, { avoid = [], avoidLabs = [], chars = null } = {}) {
    let policy = [];
    try { policy = choose(role, { avoid, avoidLabs, chars, roleOverride: null }).candidates; } catch { /* nothing admitted */ }
    const labs = policy.map(c => labOf(c.vendor, c.model));
    const o = OVERRIDES[role];
    if (o && !avoid.includes(o.vendor) && !avoidLabs.includes(labOf(o.vendor, o.model ?? null))) labs.unshift(labOf(o.vendor, o.model ?? null));
    return [...new Set(labs)];
  }

  // A CRASH IS RECORDED, NOT JUST THROWN. Whatever stage dies inside this run, the run record says
  // where and why, the latest artifact (if any) is copied out, and the caller's `progress` gets a
  // terminal line -- but nothing here ever calls process.exit(); a caller reachable from an HTTP
  // handler would take the whole server down on one failed build, not just this request.
  try {
    let previous = null;
    if (RESUME) {
      previous = JSON.parse(readFileSync(statePath, "utf8"));
      if (previous.format !== 2 || previous.isolation !== ACCEPTANCE_ISOLATION ||
          previous.ticket_cid !== ticketCid || resolve(previous.board) !== resolve(root) ||
          JSON.stringify(previous.package_context) !== JSON.stringify(packageBinding)) {
        throw new Error("resume: ticket/spec differs or this is a legacy run without isolated recovery state");
      }
      // Earlier attempts stay on the record. The provider-call bound is the run's: inherited with the calls
      // already made counted against it, unless the operator passed a new one for this invocation.
      // `counted_from` is the attempt index the bound in force counts from: 0 for the run's own bound, the attempts
      // already recorded when an operator's new bound took effect (so a later inheriting resume counts from there).
      const earlier = previous.attempts ?? [];
      const basis = BOUND_GIVEN ? "operator" : "inherited";
      const counted_from = BOUND_GIVEN ? earlier.length : (previous.provider_calls?.counted_from ?? 0);
      const prior = providerCallsOf(earlier.slice(counted_from));
      if (!BOUND_GIVEN) { MAX_PROVIDER_CALLS = previous.provider_calls?.limit ?? null; providerCalls = prior; }
      Object.assign(run, previous, { error: null, salvaged: null, resumed_from: { board: root, previous_error: previous.error ?? null },
        attempts: earlier, provider_calls: { limit: MAX_PROVIDER_CALLS, made: providerCalls, refused: null, basis, counted_from,
          prior: providerCallsOf(earlier), previous_limit: previous.provider_calls?.limit ?? null } });
      run.resources = resourcesOf(run.attempts);
    } else if (existsSync(statePath)) {
      throw new Error("board already has a run; use resume instead of overwriting recovery state");
    }
    if (!RESUME) {
      for (const rel of spec.copy) cpSync(join(REPO_ROOT, rel), artifactPath(worktree, rel), {
        recursive: true, dereference: true,
        filter: (src, dest) => {
          if (!isUnder(REPO_ROOT, src)) throw new Error("copy contains a symlink outside the target repository");
          artifactPath(worktree, relative(worktree, dest));
          return true;
        },
      });
      for (const { path, bytes, contents } of packageInputs) if (bytes !== null) {
        if (board.store.put("blob", contents) !== bytes) throw new Error("package context CAS mismatch");
        writeArtifact(worktree, path, contents);
      }
    }
    assertPackageContext();
    recordAllowed = true;
    enter("isolation", "checking mandatory acceptance confinement before any vendor call");
    const probe = await isolatedAcceptance({ worktree, cmd: "true", head: repoHead(), timeout: 10_000 });
    if (probe.exit !== 0) throw new Error(`acceptance isolation preflight refused: ${probe.out}`);
    if (RESUME && run.shipped) {
      // Idempotent completion also repairs missing exports from the certified store, without seats.
      exportShipped(); record();
      progress({ event: "run.end", detail: "already shipped; certified exports restored" });
      return { ok: true, shipped: true, key: spec.key, board: root, outDir, error: null, salvaged: null };
    }
    if (!RESUME) run.files = SLOTS.map(sl => {
      const baseline = readArtifact(REPO_ROOT, sl.path);
      return { slot: sl.slot, path: sl.path, baseline: { exists: baseline !== null,
        bytes: board.store.put("blob", baseline ?? Buffer.alloc(0)) } };
    });
    // ---------------------------------------------------------------- seating
    const chain = profile === "argo"
      ? { ok: true, assigned: Object.fromEntries(["planner", "implementer", "reviewer"].map(role => [role, forRole(role)[0]])) }
      : seatingPlan({ roles: ["planner", "implementer", "reviewer"] });
    if (!chain.ok) throw new Error(chain.why);
    const intake = profile === "argo" ? { ok: true, assigned: { scout: forRole("scout")[0] } } : seatingPlan({ roles: ["scout"], seating: INTAKE });
    bar(`open item ${spec.key} — ${spec.title}`);
    progress({ event: "run.start", detail: `${spec.key}: ${spec.title} → ${SLOT}; acceptance: ${CMD}` });
    // The legacy table's report is not what a `fit` run seats; the run's report is `run.seating` (seatingOf).
    if (profile !== "fit") for (const r of seatingReport(chain)) say(r.line);

    let scouts = [], TICKET = null, plannerVendor = null, plannerModel = null, maker = null, wip = null;
    // One work item per slot. A single-slot ticket keeps the bare key it always had, so its board
    // refs, its run record and every existing test are untouched.
    const itemKeyFor = sl => (SLOTS.length === 1 ? ITEM : `${ITEM}-${sl.slot}`);
    let BUILT = null;
    let artifactCid = null, bytes = null, code = null, recordedExit = null, reproOut = "", rev = 0;
    run.revisions ??= [];
    let crew = null;
    // Reference material for the seats. `attach` is the explicit list. A markdown or text document
    // in `copy` is the same thing by another name: the ticket author put it there FOR the
    // implementer, and the implementer has no tools, so a document that is only in the worktree
    // was never read by anyone. (The round-1 membrane ticket carried its motion spec and its full
    // specification in `copy`; the seat saw neither.) Directories and code in `copy` stay where
    // they are -- they exist for the acceptance command, not the prompt. Bounded per file so a
    // stray large document cannot swallow the context.
    const slotOverrideFor = (sl, i) => OVERRIDES[`implementer.${i}`] ?? OVERRIDES[`implementer.${sl.slot}`] ?? null;
    // What an implementer turn carries: the goal, the attached references and the current file.
    const implementerChars = sl => (sl.goal ?? spec.goal).length + attached.length +
      ((sl.source ?? sl.path) ? (readArtifact(REPO_ROOT, sl.source ?? sl.path)?.length ?? 0) : 0);
    const ATTACH_MAX_BYTES = 200_000;
    const attachable = [...new Set([...(spec.attach ?? []), ...(spec.copy ?? []).filter(rel => /\.(md|txt)$/i.test(rel))])]
      .filter(rel => existsSync(join(REPO_ROOT, rel)) && statSync(join(REPO_ROOT, rel)).isFile());
    const attached = attachable.map(rel => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf8");
      return `\n\n--- reference (read-only; do NOT output this file): ${rel} ---\n` +
        (body.length > ATTACH_MAX_BYTES ? `[${body.length} bytes: too large to attach; first ${ATTACH_MAX_BYTES} shown]\n${body.slice(0, ATTACH_MAX_BYTES)}` : body);
    }).join("");

    if (!RESUME) {
      // ---------------------------------------------------------------- INTAKE (outside the chain)
      // Breadth at intake, across vendors that spend from independent pools. Configurable because
      // this is the ONE place a fan-out is legal (depth 0, before commitment), so widening it is a
      // real option rather than a law to amend -- and because a run with no Antigravity venv needs
      // to be able to say so.
      const SCOUTS = SCOUT_VENDORS;
      scouts = [];
      if (profile === "fit") scouts = await fitIntake();
      else {
      assertFanOutIsOutside({ stage: "intake", depth: 0, width: SCOUTS.length });
      enter("intake", `${SCOUTS.length} scouts, independent pools`);
      for (const vendor of SCOUTS) {
        const seat = { vendor, seat_id: `${vendor}-scout`, mode: "explore", occupancy_gen: 1 };
        const p = promptFor("scout", { question: spec.question },
          NO_TOOLS + "Answer from what you already know in at most four sentences, name the concrete failure rather than a " +
          "category, and end with one line: `RAN: nothing`.");
        const model = intake.assigned.scout.vendor === vendor ? intake.assigned.scout.model : (vendor === "xai" ? modelId("xai", "grok-4.3") : modelId("google", "argon"));
        // The 700-token cap exists because grok-4.6 once answered this prompt with 82k characters.
        // It is WRONG for the multi-agent model and is skipped there, for two reasons that agree:
        // docs.x.ai says "The max_tokens parameter is not currently supported by the multi-agent
        // model variant", so the cap would be ignored or rejected rather than honoured; and the
        // model runs sixteen subagents whose whole output is a synthesis, so truncating it at 700
        // would pay for a research team and read four sentences of it.
        const cap = tokenCapFor("scout", model);
        // Intake is outside the chain: the scout vendors are the run's configured fan-out, recorded as such.
        const scoutChoice = profile === "argo" ? choose("scout", { chars: p.prompt.length })
          : choose("scout", { explicit: { seat: { vendor, model, basis: "QUOTA" }, source: "intake",
            reason: `intake fan-out vendor ${vendor}: the INTAKE table's ${vendor} seat` } });
        const routed = await routeSeats({ onSkip: skippedFailover, candidates: profile === "argo" ? scoutChoice.candidates.filter(c => c.vendor === vendor) : scoutChoice.candidates,
          cooldown, signal: opts.signal, invoke: (candidate, { signal }) => turn({ ...candidate, purpose: "scout", prompt: p.prompt, signal,
            extra: cap == null ? undefined : capFor(vendor, { tokens: cap }) }) });
        const text = routed.value;
        // The author names the occupant that answered, not the one the table offered first.
        const scoutSeat = nextOccupancy(null, routed.seat, { seat_id: seat.seat_id, mode: seat.mode });
        const r = await publish({ ...board, ref: `refs/iso/${vendor}/scout`, author: scoutSeat, msg: `scout ${vendor}`,
          entries: [{ kind: "search", payload: { query: spec.question, urls: [] }, blob: text }] });
        if (!r.ok) throw new Error(`scout ${vendor} publish: ${r.why}`);
        scouts.push({ vendor, ref: `refs/iso/${vendor}/scout`, commit: r.commit, evidence: r.written[0].cid, text });
      }
      }
      writeFileSync(join(outDir, "scouts.md"), scouts.map(s => `## ${s.vendor}\n\n${s.text}\n`).join("\n"));
      check(board.refs.resolve(REF) === null, "intake really precedes the board");

      // ---------------------------------------------------------------- promote
      enter("promote", "the human's ticket, citing the scouts");
      TICKET = {
        title: spec.title, goal: spec.goal, repo: "pantheon",
        constraints: spec.constraints ?? [], forbidden: spec.forbidden ?? ["do not elect a vendor as judge"],
        acceptance: [{ type: "tests", cmd: CMD, expect: "exit0" }],
        package_context: packageBinding,
      };
      // With planTitle `ticket`, the plan is the ticket's own title (the human's text, spec.title), published in the
      // same human-authored entry set: the board lets a seat or a human write a plan, never the controller.
      const ticketTitle = String(spec.title ?? "").trim().slice(0, 120);
      if (PLAN_TITLE === "ticket" && !ticketTitle) throw new Error("planTitle ticket needs the ticket's title");
      if (PLAN_TITLE === "ticket") run.plan_source = { kind: "ticket", why: "the work item's title is the ticket's own title (the human's text); no planner model ran" };
      const planFromTicket = PLAN_TITLE !== "ticket" ? [] : [
        { kind: "plan", payload: { steps: SLOTS.map(sl => ({ item: itemKeyFor(sl), title: ticketTitle })) } },
        ...SLOTS.map(sl => ({ kind: "work_item",
          payload: { key: itemKeyFor(sl), title: SLOTS.length === 1 ? ticketTitle : `${ticketTitle} — ${sl.slot}`,
            state: "ready", artifact_slots: [`artifact:${sl.slot}`], preferred_mode: "work" } }))];
      const t = await publish({ ...board, ref: REF, author: HUMAN, msg: PLAN_TITLE === "ticket" ? "the ticket, with its own title as the plan" : "the ticket",
        entries: [{ kind: "ticket", links: { derived_from: scouts.map(s => s.evidence) }, payload: TICKET }, ...planFromTicket] });
      if (!t.ok) throw new Error(t.why);

      // ---------------------------------------------------------------- plan
      enter("plan");
      if (PLAN_TITLE === "ticket") {
        // The plan was published with the human's ticket (promote, above): its title is the human's own. No planner
        // model runs, so no model contributes a plan to the reviewed change (review/scope.mjs finds no plan turn).
        check(Boolean(treeSlots(board.store, board.refs.resolve(REF)).plan), "the plan is the ticket's own title, published with the ticket");
      } else {
        run.plan_source = { kind: "model" };
        const { slice } = project(board.store, board.refs.resolve(REF), PROJECTION_FOR_ROLE.planner);
        const p = promptFor("planner", { ticket: slice.slots.ticket.payload.goal },
          NO_TOOLS + "Reply with exactly one line and nothing else: TITLE: <a one-line work item title for the single change this ticket asks for>");
        const planChoice = choose("planner", { chars: p.prompt.length });
        const pl = planChoice.seat;
        plannerVendor = pl.vendor;
        let seat = { vendor: pl.vendor, seat_id: `${pl.vendor}-plan`, mode: "plan", occupancy_gen: 1 };
        let planWip = `refs/seat/${seat.seat_id}/wip`;
        await board.refs.branch({ name: planWip, from: REF, author: seat });
        assertStage({ ...board, ref: REF, stage: "plan" });
        const { text, seat: ran } = await roleTurn({ role: "planner", purpose: "plan", prompt: p.prompt, choice: planChoice });
        plannerVendor = ran.vendor;
        plannerModel = ran.model ?? null;
        const vendorChanged = ran.vendor !== seat.vendor;
        seat = nextOccupancy(null, ran, { seat_id: `${ran.vendor}-plan`, mode: "plan" });
        if (vendorChanged) {
          planWip = `refs/seat/${seat.seat_id}/wip`;
          await board.refs.branch({ name: planWip, from: REF, author: seat });
        }
        const m = text.match(/^\s*TITLE:\s*(.+)$/mi);
        if (!m) throw new Error(`planner did not answer in the required form; got: ${text.slice(0, 200)}`);
        const title = m[1].trim().slice(0, 120);
        const r = await publish({ ...board, ref: planWip, author: seat, msg: "plan",
          entries: [
            { kind: "plan", payload: { steps: SLOTS.map(sl => ({ item: itemKeyFor(sl), title })) } },
            // One work_item per slot. Each carries its own lease resource, so each implementer
            // publishes under its OWN identity -- which is what lets reviewAck check cross-lab
            // review per file rather than per ticket.
            ...SLOTS.map(sl => ({ kind: "work_item",
              payload: { key: itemKeyFor(sl), title: SLOTS.length === 1 ? title : `${title} — ${sl.slot}`,
                state: "ready", artifact_slots: [`artifact:${sl.slot}`], preferred_mode: "work" } })),
          ] });
        if (!r.ok) throw new Error(`plan publish: ${r.why}`);
        const mg = await merge({ ...board, into: REF, from: planWip, author: CONTROLLER, only: CARRY, msg: "adopt the plan" });
        if (!mg.ok) throw new Error(`adopt: ${mg.why}`);
      }
      // Every slot's item must be scheduled as work, through impl@build, before any lease is taken.
      const workGate = assertStage({ ...board, ref: REF, stage: "work" });
      for (const sl of SLOTS) assertStage({ ...board, ref: REF, stage: "work", match: r => r.item === itemKeyFor(sl) });
      check(workGate.ok, "the controller scheduled work from board state");

      // ---------------------------------------------------------------- work
      enter("work", `up to ${revisions} revisions`);
      // ONE IMPLEMENTER PER SLOT, in parallel. They are not competing: each owns a different file,
      // holds its own lease, and publishes under its own seat identity. Which rung builds each slot
      // is decided per slot (the ticket's `model`, or a per-index --seat override, or the ladder),
      // so choosing between gpt-6-astra / gpt-6-sol / gpt-6-luna is a ticket-time decision rather
      // than a seating-table edit.
      // The COMPLETE seat is selected once per slot (precedence in src/route/frontier.mjs: per-slot override,
      // the ticket's pin, the role-wide override, the policy) and that seat -- vendor, model, transport, pool,
      // pool configuration -- is what every revision of the slot is sent to until a recorded decision changes it.
      crew = SLOTS.map((sl, i) => {
        const choice = choose("implementer", { pin: sl.model ?? null, slotOverride: slotOverrideFor(sl, i), chars: implementerChars(sl) });
        const im = choice.seat;
        const seat = { vendor: im.vendor, seat_id: SLOTS.length === 1 ? `${im.vendor}-work` : `${im.vendor}-work-${sl.slot}`,
                       mode: "work", occupancy_gen: 1 };
        return { sl, seat, itemKey: itemKeyFor(sl), wip: `refs/seat/${seat.seat_id}/wip`, choice,
                 model: im.model, file: join(worktree, sl.path),
                 artifactCid: null, bytes: null, code: null, lease: null,
                 baseline: run.files.find(f => f.slot === sl.slot).baseline,
                 // A `fit` seat starts at its profile's mapped effort, so a recorded raise_effort climbs from
                 // there rather than from the documented default (which could be below it).
                 ...(im.effort ? { effort: im.effort, ranModel: im.model } : {}) };
      });
      // The old single-slot names still point at the first member, so the resume branch, the run
      // record and the check stage keep working unchanged for a one-file ticket.
      maker = crew[0].seat;
      wip = crew[0].wip;
      progress({ event: "crew", detail: crew.map(c => `${c.sl.slot}:${c.seat.vendor}/${c.model}`).join(", ") });
      reviewCapacity(crew, plannerVendor ? labOf(plannerVendor, plannerModel) : null);
    } else {
      enter("resume", `from ${root}`);
      plannerVendor = run.planner_vendor;
      plannerModel = run.planner_model ?? null;
      if ((!plannerVendor && run.plan_source?.kind !== "ticket") || run.files.length !== SLOTS.length) throw new Error("resume: incomplete per-slot recovery state");
      TICKET = board.store.get(treeSlots(board.store, board.refs.resolve(REF)).ticket)?.payload;
      if (!TICKET) throw new Error("resume: no board ticket");
      crew = SLOTS.map((sl, i) => {
        const saved = run.files.find(f => f.slot === sl.slot && f.path === sl.path);
        if (!saved?.artifactCid || !saved.seat || !saved.wip) throw new Error(`resume: incomplete artifact for ${sl.slot}`);
        const art = board.store.get(saved.artifactCid);
        if (treeSlots(board.store, board.refs.resolve(saved.wip))[`artifact:${sl.slot}`] !== saved.artifactCid ||
            art.links.bytes !== saved.bytes) throw new Error(`resume: artifact branch changed for ${sl.slot}`);
        const contents = board.store.get(saved.bytes);
        writeArtifact(worktree, sl.path, contents);
        // RESUME CONTINUES THE RECORDED SEAT (audit M3): the selected seat as run.json saved it, not a
        // re-resolution from the ticket or today's overrides. A per-slot override given at resume is an
        // explicit new decision, recorded as such; it replaces the seat and lifts a recorded stop. The same
        // override repeated (the seat already recorded) is not a new decision and changes nothing.
        const given = slotOverrideFor(sl, i), was = saved.selected?.seat;
        const poolOf = s => (s.pool && s.pool !== s.vendor ? s.pool : null);
        const override = given && !(was && given.vendor === was.vendor && given.model === was.model &&
          (poolOf(given) === null || poolOf(given) === was.pool)) ? given : null;
        const choice = override ? choose("implementer", { slotOverride: override, chars: implementerChars(sl) })
          : saved.selected?.seat ? { ...saved.selected, selection: { ...saved.selected.selection, resumed: true },
              candidates: saved.selected.candidates.map(c => ({ ...c, selection: { ...c.selection, resumed: true } })) }
          : choose("implementer", { pin: sl.model ?? null, chars: implementerChars(sl) });
        const stopped = saved.escalation?.stopped ?? null;
        // Lifting a recorded stop is its own explicit, recorded action: a per-slot reseat at resume, or the
        // caller's `retryStopped` reason (same-seat repair, bounded by this resume's revision limit and the
        // escalation step budget, which continues). A plain resume never regenerates a stopped slot.
        if (stopped && (override || RETRY_STOPPED)) (run.retries ??= []).push({ at: new Date().toISOString(), slot: sl.slot,
          action: override ? "reseat" : "retry_stopped", lifted: stopped,
          reason: override ? `per-slot override at resume: ${override.vendor}/${override.model}` : RETRY_STOPPED });
        return { sl, seat: saved.seat, itemKey: itemKeyFor(sl), wip: saved.wip, choice,
          model: choice.seat.model,
          file: join(worktree, sl.path), artifactCid: saved.artifactCid, bytes: saved.bytes,
          baseline: saved.baseline, code: contents.toString("utf8"), lease: null,
          // The slot's escalation state, as recorded: the next revision continues the trail, not a fresh one.
          effort: override ? null : saved.escalation?.effort ?? null, forced: override ? null : saved.escalation?.forced ?? null,
          escalationSteps: saved.escalation?.steps ?? 0, ranModel: override ? null : saved.escalation?.model ?? null,
          pendingRevision: saved.escalation?.pending ?? null, stopped: override || RETRY_STOPPED ? null : stopped,
          // A run recorded before contributors were kept names its last seat only; that is what it can attest.
          contributors: saved.contributors ?? [{ purpose: "work", vendor: saved.seat.vendor, model: saved.escalation?.model ?? choice.seat.model, slot: sl.slot }] };
      });
      if (crew.every(c => c.stopped)) {
        throw new Error(`resume: every slot recorded a terminal escalation stop (${crew.map(c => `${c.sl.slot}: ${c.stopped.why}`).join("; ")}); ` +
          "reseat a slot with a per-slot override, or pass retryStopped with a reason");
      }
      rev = Math.max(...run.files.map(f => f.rev));
      const exits = crew.map(c => {
        const status = acceptanceStatus({ store: board.store, state: boardState({ ...board, ref: REF }),
          artifact: { cid: c.artifactCid }, from: board.refs.resolve(c.wip) });
        const rows = status.rows.flatMap(r => r.runs ?? []);
        return rows.at(-1)?.exit ?? null;
      });
      recordedExit = exits.every(exit => exit === 0) ? 0 : 1;
      maker = crew[0].seat; wip = crew[0].wip;
      artifactCid = crew[0].artifactCid; bytes = crew[0].bytes; code = crew[0].code;
    }
    run.planner_vendor = plannerVendor;
    run.planner_model = plannerModel;
    record();
    // A failed acceptance resumes at revision, retaining every slot and its original baseline.
    // A late review/ship failure can reuse its byte-bound passing controller result.
    // A resume whose every slot recorded a terminal stop has no revision to run (audit M2).
    if (!RESUME || ((recordedExit !== 0 || crew.some(c => c.pendingRevision)) && crew.some(c => !c.stopped))) {
    {
        for (const c of crew) {
          if (!board.refs.resolve(c.wip)) await board.refs.branch({ name: c.wip, from: REF, author: c.seat });
          const held = await board.runtime.acquire({ resource: `item:${c.itemKey}`, holder: c.seat, ttlMs: 1_800_000 });
          if (!held.ok) throw new Error("could not acquire implementer lease");
          c.lease = { resource: `item:${c.itemKey}`, gen: held.lease.gen };
          board.runtime.setOccupancy(c.seat.seat_id, { status: "running", mode: "work", ref: c.wip });
        }

        const oracle = spec.tests_file ? readFileSync(join(REPO_ROOT, spec.tests_file), "utf8") : "";

        for (let attempt = 0; attempt < revisions; attempt++) {
          // A RECORDED STOP IS TERMINAL (audit M2). A slot whose escalation decided `stop` makes no
          // further generation; its last bytes stay in the combined change. The loop ends when no slot
          // can proceed -- the revision limit is a bound, not a reason to repeat a terminal decision.
          const active = crew.filter(c => !c.stopped);
          if (!active.length) {
            progress({ event: "revise.stop", rev, detail: `no slot can proceed: ${crew.map(c => `${c.sl.slot} stopped (${c.stopped.why})`).join("; ")}`.slice(0, 300) });
            break;
          }
          rev++;
          // FAN OUT THE WRITES. Every slot's implementer runs at the same time; none of them can
          // see another's output, which is the point -- they are building different files against
          // the same ticket, not reviewing each other.
          await Promise.all(active.map(async c => {
            const { slice } = project(board.store, board.refs.resolve(REF), PROJECTION_FOR_ROLE.implementer, { reader: c.seat, item: c.itemKey });
            const implTests = testsBrief({ store: board.store, state: boardState({ ...board, ref: REF }), from: board.refs.resolve(c.wip),
              ...(c.artifactCid ? { artifact: { cid: c.artifactCid } } : {}), maxOutput: 8000 });
            // A ticket whose `path` already exists is an EDIT, and the implementer has no tools:
            // if the file is not in this prompt, it does not exist for the seat. This used to read
            // only `source`, a field LEXI's drafter never emits (its strict schema forbids extra
            // keys), so two rounds of a real ticket asked for an edit of an 86 KB shader and put a
            // heading with nothing under it in front of the seat -- which rewrote the file from a
            // summary (2 of 8 programs survived), then refused in 225 bytes. `source` still wins
            // when set; `path` is the default it should always have had.
            const currentPath = c.sl.source ?? c.sl.path;
            const current = currentPath ? (readArtifact(REPO_ROOT, currentPath)?.toString("utf8") ?? "") : "";
            const others = crew.length === 1 ? "" :
              `\n\nThis ticket is being built by ${crew.length} implementers at once, each owning ONE file. ` +
              `Yours is ${c.sl.path}. The others are writing: ${crew.filter(o => o !== c).map(o => o.sl.path).join(", ")}. ` +
              `Do not write their files and do not restate their work; the acceptance command runs once over all of them together.`;
            const p = promptFor("implementer",
              { ticket: c.sl.goal ?? slice.slots.ticket.payload.goal,
                work_item: `${c.itemKey}: ${slice.slots[`item:${c.itemKey}`]?.payload?.title ?? spec.title}`,
                artifact: rev === 1
                  ? `Current contents of ${c.sl.path}:\n\n${current}${attached}`
                  : c.pendingRevision?.reason === "review"
                    ? `Your revision ${rev - 1} of ${c.sl.path}, which passed the executed acceptance but the cross-lab reviewer REQUESTED CHANGES (address them; do not start over):\n\n${c.pendingRevision.findings}\n\n${c.code}${attached}`
                    : `Your revision ${rev - 1} of ${c.sl.path}, which FAILED the executed acceptance shown under tests (fix it; do not start over):\n\n${c.code}${attached}`,
                tests: `${implTests.text}\n\n${oracle ? `The acceptance test file ${spec.tests_file}, verbatim (it runs as part of the command above):\n\n${oracle}` : ""}` },
              NO_TOOLS + `Output ONLY the complete new contents of ${c.sl.path}. No prose before or after, no markdown fence. ` +
              `You own the complete assigned file, including adjacent defects that prevent the ticket from working. Fix those defects within this file and preserve unrelated behavior; the acceptance command must exit 0.` + others);
            writeFileSync(join(outDir, `implementer-prompt-${c.sl.slot}-rev${rev}.txt`), p.prompt);
            c.workPrompt = p.prompt;
            // A REVIEWER'S FINDINGS IN THIS PROMPT ARE A CONTRIBUTION (86ce18a review, defect 3): the revised bytes are
            // shaped by them, so the reviewer's lab joins the slot's contributors (purpose `critique`) and neither the
            // slot's next in-run review nor the cycle's change scope may seat it. Kept in run.files, so a resume keeps it.
            if (rev > 1 && c.pendingRevision?.reason === "review") {
              for (const r of c.pendingRevision.reviewers ?? []) {
                if (!(c.contributors ??= []).some(x => x.purpose === "critique" && x.vendor === r.vendor && x.model === r.model)) {
                  c.contributors.push({ purpose: "critique", vendor: r.vendor, model: r.model, slot: c.sl.slot, revision_input: true, via: CRITIQUE_VIA });
                }
              }
            }
            // The slot's selected seat, or the rung a recorded escalation stepped to, resolved through its
            // own transport (a lane rung is never an API pin). A rung on the same vendor keeps the pool the
            // operator named for this slot; the decision changed the model, not the credential.
            const keepPool = c.forced && c.forced.vendor === c.choice.seat.vendor && c.choice.seat.poolNamed ? { pool: c.choice.seat.pool } : {};
            const made = await roleTurn({ role: "implementer", purpose: "work", prompt: p.prompt,
              choice: c.forced ? choose("implementer", { explicit: { seat: { vendor: c.forced.vendor, model: c.forced.model, ...keepPool }, source: "escalation",
                reason: `recorded escalation ${c.forced.why === "thinking level raised" ? "raise_thinking" : "step_rung"} to ${c.forced.model}${c.forced.why ? `: ${c.forced.why}` : ""}` } }) : c.choice,
              effort: c.effort ? { model: c.ranModel, value: c.effort } : null });
            c.code = strip(made.text);
            c.ranModel = made.seat.model;
            // Every model that wrote a revision contributed to the final bytes: the next revision's prompt carries the
            // previous file ("fix it; do not start over"). Kept for the reviewed scope (review/scope.mjs, owner audit RS2).
            if (!(c.contributors ??= []).some(x => (x.purpose ?? "work") === "work" && x.vendor === made.seat.vendor && x.model === made.seat.model)) {
              c.contributors.push({ purpose: "work", vendor: made.seat.vendor, model: made.seat.model, slot: c.sl.slot });
            }
            // Under `fit`, the slot's effort is the one the answering seat ran with: when a fallback answered,
            // the next escalation starts from the fallback's own mapped effort, not the primary's.
            if (profile === "fit") c.effort = made.effort ?? null;
            c.pendingRevision = null;
            // A different vendor or model answering this chair is a reseat: the generation advances.
            const next = nextOccupancy(c.seat, made.seat, { seat_id: made.seat.vendor !== c.seat.vendor
              ? `${made.seat.vendor}-work-${c.sl.slot}` : c.seat.seat_id, mode: "work" });
            if (made.seat.vendor !== c.seat.vendor) {
              await board.runtime.release({ resource: c.lease.resource, holder: c.seat, gen: c.lease.gen });
              const priorWip = c.wip;
              c.seat = next;
              c.wip = `refs/seat/${c.seat.seat_id}/wip`;
              if (!board.refs.resolve(c.wip)) await board.refs.branch({ name: c.wip, from: priorWip, author: c.seat });
              const held = await board.runtime.acquire({ resource: `item:${c.itemKey}`, holder: c.seat, ttlMs: 1_800_000 });
              if (!held.ok) throw new Error("could not acquire the reseated implementer's lease");
              c.lease = { resource: `item:${c.itemKey}`, gen: held.lease.gen };
              if (c === crew[0]) { maker = c.seat; wip = c.wip; }
            } else {
              c.seat = next;
              if (c === crew[0]) maker = c.seat;
            }
            writeArtifact(worktree, c.sl.path, c.code.endsWith("\n") ? c.code : c.code + "\n");
            progress({ event: "wrote", rev, slot: c.sl.slot, detail: `${c.sl.path} (${c.code.length} chars)` });

            const a = await publish({ ...board, ref: c.wip, author: c.seat, lease: c.lease,
              msg: `MAKER DEFENSE rev ${rev}: this is correct, I checked it carefully`,
              entries: [{ kind: "artifact", payload: { slot: c.sl.slot, path: c.sl.path, rev, summary: spec.title, baseline: c.baseline }, blob: readArtifact(worktree, c.sl.path) }] });
            if (!a.ok) throw new Error(`artifact publish (${c.sl.slot} rev ${rev}): ${a.why}`);
            c.artifactCid = treeSlots(board.store, a.commit)[`artifact:${c.sl.slot}`];
            c.bytes = board.store.get(c.artifactCid).links.bytes;
            run.files = crew.map(member => ({ slot: member.sl.slot, path: member.sl.path,
              baseline: member.baseline, seat: member.seat, wip: member.wip,
              artifactCid: member.artifactCid, bytes: member.bytes, rev, escalation: escalationState(member),
              selected: savedChoice(member.choice), contributors: member.contributors ?? [] }));
            record();
            check(true, `rev ${rev}: ${c.sl.slot} written by ${c.seat.vendor} (${shortCid(c.artifactCid)})`);
          }));

          // ACCEPTANCE RUNS ONCE, OVER THE WHOLE CHANGE. Running it per slot would have each
          // implementer graded against a tree the others were still writing into -- and a
          // multi-file change is only correct together.
          artifactCid = crew[0].artifactCid; bytes = crew[0].bytes; code = crew[0].code;
          progress({ event: "acceptance.start", rev, detail: CMD });
          const acc = await runAcceptance(crew);
          recordedExit = acc.exit; reproOut = acc.out;
          progress({ event: "acceptance.done", rev, exit: acc.exit, detail: (acc.out.match(/ℹ (?:pass|fail) \d+/g) ?? []).join(", ") });
          writeFileSync(join(outDir, `repro-rev${rev}.txt`), `$ ${CMD}\n(exit ${acc.exit})\n\n${acc.out}`);
          // The repro binds to EVERY artifact it judged: the TESTS gate checks each slot, and a
          // run that cited only one file would leave the others with no executed result.
          for (const c of crew) {
            const rp = await publish({ ...board, ref: c.wip, author: CONTROLLER, msg: `the suite on rev ${rev}`,
              entries: [{ kind: "repro", payload: { cmd: CMD, exit: acc.exit, isolation: acc.isolation, package_context: packageBinding }, blob: acc.out.slice(-20_000) || "(no output)", links: { derived_from: [c.artifactCid] } }] });
            if (!rp.ok) throw new Error(`repro publish (${c.sl.slot} rev ${rev}): ${rp.why}`);
          }
          run.revisions.push({ rev, exit: acc.exit, slots: crew.map(c => ({ slot: c.sl.slot, chars: c.code.length, artifact: c.artifactCid, bytes: c.bytes })) });
          record();
          if (acc.exit === 0) break;
          if (attempt + 1 < revisions) {
            // ESCALATION, from the executed result: each slot's next revision is the protocol's decision
            // (src/route/protocol.mjs) -- documented effort first, then the next harder rung -- and the
            // decision is recorded with its inputs so it can be re-derived from the run.
            // A slot already stopped takes no new decision: its stop is the record.
            for (const c of active) {
              const rec = escalationRecord({ role: "implementer", outcome: { kind: "acceptance", exit: acc.exit }, steps: c.escalationSteps ?? 0,
                seat: { vendor: c.seat.vendor, model: c.ranModel, effort: c.effort ?? null, output: null, ...laneLadderOf(c) } });
              applyDecision(c, rec, rev);
              escalated(`slot:${c.sl.slot}`, { slot: c.sl.slot, rev, ...rec });
              progress({ event: "escalate", rev, slot: c.sl.slot, detail: `${rec.decision.action}: ${rec.decision.why}`.slice(0, 300) });
            }
            for (const f of run.files) {
              const member = crew.find(c => c.sl.slot === f.slot);
              if (member) f.escalation = escalationState(member);
            }
            record();
            if (crew.some(c => !c.stopped)) progress({ event: "revise", rev: rev + 1 });
          }
        }

        for (const c of crew) {
          const o = await publish({ ...board, ref: c.wip, author: c.seat, lease: c.lease, msg: "offer it for review",
            entries: [{ kind: "work_item", links: { offer: [c.artifactCid] },
              payload: { key: c.itemKey, title: TICKET.title, state: "offered_review", offer_ref: c.wip, artifact_slots: [`artifact:${c.sl.slot}`] } }] });
          if (!o.ok) throw new Error(`offer publish (${c.sl.slot}): ${o.why}`);
          await merge({ ...board, into: REF, from: c.wip, author: CONTROLLER, only: CARRY, msg: "carry the offer" });
          await board.runtime.release({ resource: `item:${c.itemKey}`, holder: c.seat, gen: c.lease.gen });
          board.runtime.setOccupancy(c.seat.seat_id, { status: "done", mode: "work", ref: c.wip });
          check(treeSlots(board.store, board.refs.resolve(REF))[`artifact:${c.sl.slot}`] === undefined,
            `bound-review holds ${c.sl.slot} OFF the shipping ref until it is acked`);
        }
        BUILT = crew;
      }
    } else {
      BUILT = crew;
    }
    run.acceptance = { cmd: CMD, exit: recordedExit, revisions: rev, isolation: ACCEPTANCE_ISOLATION };
    record();

    // ---------------------------------------------------------------- check (other lab, on the bytes)
    enter("check", "another lab acks the bytes");
    let verdict = null, reviewText = "";
    // `fit` only: each slot's review panel (its required lab count and every member's verdict and selection).
    let reviewPanels = null;
    {
      // EVERY artifact needs its own cross-lab ack: ship's REVIEW gate is reviews.every(r => r.ok)
      // over the moving artifact slots (src/board/integrate.mjs), so a multi-slot change with one
      // critique would be refused -- correctly. The pairing is computed per file, against THAT
      // file's maker, because "a different lab than the one that wrote it" is a per-file property.
      const toReview = BUILT ?? [{ sl: { slot: SLOT, path: PATH }, seat: maker, wip, artifactCid, bytes, code }];
      // THE REVIEWED SCOPE (review/scope.mjs, owner audit RS2): each slot's checker judges that slot's bytes, so it may
      // share a vendor or lab with no contribution that reached them -- every model that wrote a revision, and the
      // planner, whose title is the work item the worker read. Derived from those contributions, not from a role
      // label; recorded in run.json review_scopes. (A Claude lane model served by agy is Anthropic's work, RU1.)
      const scopeOf = built => reviewScope({ kind: "artifact", slot: built.sl.slot, turns: [
        ...(plannerVendor ? [{ purpose: "plan", vendor: plannerVendor, model: plannerModel }] : []),
        ...(built.contributors?.length ? built.contributors
          : [{ purpose: "work", vendor: built.seat.vendor, model: built.ranModel ?? built.seat.model ?? built.model ?? null, slot: built.sl.slot }])] });
      const reviewerAvoid = scope => [...new Set(scope.contributions.flatMap(c => [c.vendor, ...vendorsOfLab(c.lab)]).filter(Boolean))];
      // Under `fit`, stakes state how many INDEPENDENT labs review each artifact (requirements.review_labs:
      // low 1, normal 1, high 2, critical 3). The panel is chosen one reviewer at a time, each avoiding the maker's
      // and the planner's labs (law 3) and every vendor and lab that already ANSWERED, so a fallback cannot seat two
      // reviewers in one lab. Too few eligible labs is a named refusal before any reviewer is called; it never runs
      // fewer. argo and legacy run one reviewer, as before.
      const REVIEW_LABS = TASK ? requirementsOf(TASK).review_labs : null;
      const panelRefusal = (built, why) => Object.assign(new Error(`REVIEW_LABS_UNAVAILABLE: ${built.sl.slot} needs ${REVIEW_LABS.value} ` +
        `independent review labs (${REVIEW_LABS.basis}), none the maker's or the planner's; ${why}; refusing rather than running fewer`),
        { code: "REVIEW_LABS_UNAVAILABLE" });
      for (const built of toReview) {
      // WAS reviewPlan({producers, assigner})[0] here. Found 2026-09-29: reviewPlan picks from
      // Object.keys(SEAT_FACTS) -- every vendor that exists, not SEATING.reviewer's actual curated
      // table -- so it can name a vendor roleTurn below would never pick (roleTurn walks
      // candidatesFor("reviewer", {avoid}), a different, narrower list). The two independently
      // computed answers had no reason to agree, and didn't: this is what "the review fell through
      // to X but the critique seat is Y" was, every time it fired, including with no operator
      // override at all once agy_google became the default maker for both planner and implementer.
      // Fix: compute the pairing from the SAME lookup roleTurn actually uses, so they cannot diverge.
      // Now: the pairing IS the selection roleTurn runs (selectSeat), admitted by lab independence as well.
      const scope = scopeOf(built);
      (run.review_scopes ??= {})[built.sl.slot] = scope;
      const avoid = reviewerAvoid(scope);
      const avoidLabs = scope.author_labs;
      const reviewChars = (built.code ?? "").length + attached.length;
      const need = REVIEW_LABS?.value ?? 1;
      if (REVIEW_LABS) {
        const reachable = labsReachable("reviewer", { avoid, avoidLabs, chars: reviewChars });
        if (reachable.length < need) throw panelRefusal(built, `only ${reachable.length} lab(s) are eligible after avoiding ` +
          `${avoidLabs.join(", ")} (${reachable.join(", ") || "none"})`);
      }
      // Each panel member's verdict, published on its own critique branch; collected once every member has judged.
      const panel = [], usedVendors = [], usedLabs = [];
      for (let k = 0; k < need; k++) {
      let reviewChoice;
      // The operator's reviewer seat, if any, is the first member; the others are the selector's, across labs.
      try {
        if (IN_RUN_MODEL) {
          // By model: every candidate of the role, minus contributing models (and unresolved ones); untouched labs first.
          const keys = contributorKeys(scope.contributions, ID_POLICY);
          const all = choose("reviewer", { avoid: usedVendors, avoidLabs: usedLabs, chars: reviewChars, ...(k ? { roleOverride: null } : {}) });
          const ok = all.candidates.filter(c => c && !candidateRefusal({ vendor: c.vendor, model: c.model }, keys, ID_POLICY));
          const touched = c => keys.contributing_labs.includes(resolveModel(c.vendor, c.model, ID_POLICY).lab);
          const ordered = [...ok.filter(c => !touched(c)), ...ok.filter(touched)];
          if (!ordered.length) throw new Error(`no reviewer model is left that did not contribute to these bytes (contributors: ${keys.models.join(", ") || "none"}` +
            `${keys.unresolved.length ? `; unresolved: ${keys.unresolved.map(u => u.model).join(", ")}` : ""})`);
          reviewChoice = { ...all, seat: ordered[0], candidates: ordered, selection: ordered[0].selection };
        } else reviewChoice = choose("reviewer", { avoid: [...avoid, ...usedVendors], avoidLabs: [...avoidLabs, ...usedLabs], chars: reviewChars,
          ...(k ? { roleOverride: null } : {}) });
      }
      catch (e) {
        if (k) throw panelRefusal(built, `reviewer ${k + 1} has no candidate after avoiding labs ${[...avoidLabs, ...usedLabs].join(", ")}: ${e.message}`);
        throw new Error(`no clean reviewer: no reviewer candidate left after avoiding ${avoid.join(", ")} (labs ${avoidLabs.join(", ")}): ${e.message}`);
      }
      const pairing = { reviewer: reviewChoice.seat.vendor, why: reviewChoice.selection.reason };
      if (!IN_RUN_MODEL) assertReviewCutsAcross({ contributors: scope.contributions, producer: { vendor: built.seat.vendor }, reviewer: { vendor: pairing.reviewer } });
      let seat = { vendor: pairing.reviewer, seat_id: toReview.length === 1 ? `${pairing.reviewer}-critique` : `${pairing.reviewer}-critique-${built.sl.slot}`, mode: "critique", occupancy_gen: 1 };
      let rref = `refs/seat/${seat.seat_id}/wip`;
      await board.refs.branch({ name: rref, from: built.wip, author: seat });
      const { slice, withheld } = project(board.store, board.refs.resolve(built.wip), PROJECTION_FOR_ROLE.reviewer, { reader: seat });
      check(withheld.some(w => w.slot === "(commit message)"), "the checker cannot read the maker's defense");
      const reviewTests = testsBrief({ store: board.store, state: boardState({ ...board, ref: REF }), artifact: { cid: built.artifactCid }, from: board.refs.resolve(built.wip) });
      check(new RegExp(`exited ${recordedExit}\\b`).test(reviewTests.text), `the reviewer's tests brief says "exited ${recordedExit}", as the repro recorded`);
      const p = promptFor("reviewer",
        { ticket: slice.slots.ticket.payload.goal, artifact: `New contents of ${built.sl.path} (revision ${rev}):\n\n${built.code}${attached}`, tests: reviewTests.text },
        NO_TOOLS + "The complete new file and the executed test result are above; judge from them. " +
        "Attack this change. Name the strongest specific flaw: a behaviour the ticket asked for that is missing, an existing " +
        "behaviour it broke, or a case the acceptance test does not cover that would fail. If the executed acceptance failed, " +
        "you must request changes. End your reply with a line reading exactly `VERDICT: approve` or `VERDICT: request_changes`.");
      assertStage({ ...board, ref: REF, stage: "critique", match: r => r.item === (built.itemKey ?? r.item) && r.target === built.bytes });
      let reviewed;
      if (IN_RUN_MODEL) {
        // ADMISSION OF THE ANSWER, by the model that answered. An answer whose serving model is unnamed or unresolved, or
        // is a contributor, is not a review: it is kept (the turn is on the ledger, and run.review_rejections names the
        // seat, the serving model and the reason), and the next eligible candidate is asked.
        const keys = contributorKeys(scope.contributions, ID_POLICY);
        for (const cand of reviewChoice.candidates) {
          const got = await roleTurn({ role: "reviewer", purpose: "critique", prompt: p.prompt, choice: { ...reviewChoice, seat: cand, candidates: [cand], selection: cand.selection }, extra: { tokens: 4000 } });
          const servedBy = ledgerTurns.get(p.prompt)?.served_model ?? run.turns.findLast(t => t.purpose === "critique" && t.vendor === got.seat.vendor && t.model === got.seat.model)?.served_model ?? null;
          const why = reviewerRefusal({ vendor: got.seat.vendor, model: got.seat.model, served_model: servedBy }, keys, ID_POLICY);
          if (!why) { reviewed = got; break; }
          (run.review_rejections ??= []).push({ slot: built.sl.slot, rev, vendor: got.seat.vendor, model: got.seat.model, served_model: servedBy, why });
          progress({ event: "review.rejected", seat: got.seat.vendor, slot: built.sl.slot, detail: why.slice(0, 200) });
          record();
        }
        if (!reviewed) throw Object.assign(new Error(`no reviewer model is left whose answer could be admitted for ${built.sl.slot} ` +
          `(${(run.review_rejections ?? []).filter(x => x.slot === built.sl.slot && x.rev === rev).map(x => `${x.vendor}/${x.model}: ${x.why}`).join("; ").slice(0, 400)})`), { code: "REVIEW_NOT_ADMITTED" });
      } else {
        reviewed = await roleTurn({ role: "reviewer", purpose: "critique", prompt: p.prompt, choice: reviewChoice, extra: { tokens: 4000 } });
        // Law 3 on the reviewer that actually answered, not the one paired in advance.
        assertLaw({ kind: "review", producer: built.seat, checker: reviewed.seat, contributors: scope.contributions });
      }
      const reviewedLab = labOf(reviewed.seat.vendor, reviewed.seat.model ?? null);
      if (usedLabs.includes(reviewedLab) || usedVendors.includes(reviewed.seat.vendor)) {
        throw panelRefusal(built, `reviewer ${k + 1} answered from ${reviewed.seat.vendor}/${reviewed.seat.model}, a lab already on the panel`);
      }
      if (reviewed.seat.vendor !== seat.vendor) {
        if (!IN_RUN_MODEL) assertReviewCutsAcross({ contributors: scope.contributions, producer: built.seat, reviewer: reviewed.seat });
        seat = { ...seat, vendor: reviewed.seat.vendor, seat_id: `${reviewed.seat.vendor}-critique-${built.sl.slot}` };
        rref = `refs/seat/${seat.seat_id}/wip`;
        await board.refs.branch({ name: rref, from: built.wip, author: seat });
      }
      // The critique is authored by the reviewer that actually answered, model included.
      seat = nextOccupancy(null, reviewed.seat, { seat_id: seat.seat_id, mode: "critique" });
      reviewText = reviewed.text;
      const reviewFile = (toReview.length === 1 ? "review" : `review-${built.sl.slot}`) + (need > 1 ? `-${reviewed.seat.vendor}` : "");
      writeFileSync(join(outDir, `${reviewFile}.md`), `# ${reviewed.seat.vendor} · ${reviewed.seat.model} reviewing ${built.seat.vendor} on ${built.sl.slot} (rev ${rev})\n\n${reviewText}\n`);
      let m = reviewText.match(/^\s*VERDICT:\s*(approve|request_changes)\s*$/mi);
      if (!m) {
        progress({ event: "reask", seat: seat.vendor, detail: "no VERDICT line; asking once more" });
        const again = await turn({ ...reviewed.seat, purpose: "critique", extra: capFor(reviewed.seat.vendor, { tokens: 800 }),
          prompt: NO_TOOLS + "Your previous reply ended without the required verdict. You cannot read anything further; the file and the " +
            "executed result were in the message before. Reply with ONE line, exactly `VERDICT: approve` or `VERDICT: request_changes`, " +
            "then at most three sentences naming the strongest specific flaw if you requested changes." });
        reviewText += `\n\n[re-asked]\n${again}`;
        m = again.match(/^\s*VERDICT:\s*(approve|request_changes)\s*$/mi);
      }
      const memberVerdict = m ? m[1].toLowerCase() : "request_changes";
      if (!m) progress({ event: "verdict", seat: seat.vendor, detail: "unparseable → request_changes" });
      progress({ event: "verdict", seat: seat.vendor, slot: built.sl.slot, detail: memberVerdict });
      const memberFindings = memberVerdict === "approve" ? [] : [{ severity: "block", note: (m ? reviewText : `no parseable verdict after a re-ask; failing closed. Reviewer text: ${reviewText}`).slice(0, 400) }];
      // On the ledger, the review cites the work turn it judged (which cites the plan). Cold review is then
      // re-derivable: no lab, seat or response in that lineage may have made the review.
      const workTurn = built.workPrompt && ledgerTurns.get(built.workPrompt);
      const critiqueTurn = ledgerTurns.get(p.prompt);
      if (LEDGER?.recordReview && workTurn && critiqueTurn) {
        LEDGER.recordReview({ seat: { seat_id: `${reviewed.seat.vendor}-critique@${reviewed.seat.model}`, vendor: reviewed.seat.vendor, mode: "critique", occupancy_gen: 1 },
          model: reviewed.seat.model, served_model: critiqueTurn.served_model, response_id: critiqueTurn.response_id,
          verdict: memberVerdict, findings: memberFindings.map(f => f.note).join("\n"), targets: [workTurn.hash],
          ...(IN_RUN_MODEL ? { identity_policy: ID_POLICY } : {}) });
      }
      const c = await publish({ ...board, ref: rref, author: seat, msg: "review",
        entries: [{ kind: "critique", links: { target: built.bytes }, payload: { target: { slot: built.sl.slot, rev }, verdict: memberVerdict, findings: memberFindings } }] });
      if (!c.ok) throw new Error(`critique publish: ${c.why}`);
      panel.push({ rref, seat: reviewed.seat, lab: reviewedLab, verdict: memberVerdict, findings: memberFindings });
      usedVendors.push(reviewed.seat.vendor); usedLabs.push(reviewedLab);
      }
      for (const member of panel) {
        const back = await merge({ ...board, into: built.wip, from: member.rref, author: CONTROLLER, only: ["critique:"], msg: "collect the verdict" });
        if (!back.ok) throw new Error(`collect: ${back.why}`);
        await merge({ ...board, into: REF, from: built.wip, author: CONTROLLER, only: CARRY, msg: "carry the verdict" });
      }
      // The slot's verdict: approve only when EVERY panel member approved.
      verdict = panel.every(x => x.verdict === "approve") ? "approve" : "request_changes";
      const findings = panel.flatMap(x => x.findings);
      if (REVIEW_LABS) (reviewPanels ??= []).push({ slot: built.sl.slot, rev, required: need, basis: REVIEW_LABS.basis, verdict,
        reviewers: panel.map(x => ({ vendor: x.seat.vendor, model: x.seat.model, lab: x.lab, pool: x.seat.pool, verdict: x.verdict, selection: x.seat.selection })) });
      if (verdict === "request_changes" && built.stopped) {
        progress({ event: "escalate", rev, slot: built.sl.slot, detail: `already stopped (${built.stopped.why}); no further revision`.slice(0, 300) });
      } else if (verdict === "request_changes") {
        // The verdict is an outcome for the MAKER's seat: the protocol decides its next revision, which a
        // resume then runs (a passing acceptance alone would otherwise just re-review the same bytes).
        const rec = escalationRecord({ role: "implementer", outcome: { kind: "critique", verdict }, steps: built.escalationSteps ?? 0, ...(ESCALATION ? { protocol: ESCALATION } : {}),
          seat: { vendor: built.seat.vendor, model: built.ranModel ?? built.seat.model ?? null, effort: built.effort ?? null, output: null, ...laneLadderOf(built) } });
        const { action } = rec.decision;
        applyDecision(built, rec, rev);
        // A failed acceptance already sends the slot back to revision; only a rejection of PASSING work
        // needs its own pending revision, with the findings the implementer must address.
        // The reviewers whose findings these are (members that requested changes): if the findings reach a revision
        // prompt, those reviewers become contributors of the slot (above, where the prompt is built).
        if (action !== "stop" && recordedExit === 0) built.pendingRevision = { reason: "review", findings: findings.map(f => f.note).join("\n").slice(0, 2000),
          reviewers: panel.filter(x => x.findings.length).map(x => ({ vendor: x.seat.vendor, model: x.seat.model })) };
        escalated(`slot:${built.sl.slot}`, { slot: built.sl.slot, rev, ...rec });
        const file = run.files.find(f => f.slot === built.sl.slot);
        if (file) file.escalation = escalationState(built);
        progress({ event: "escalate", rev, slot: built.sl.slot, detail: `${action}: ${rec.decision.why}`.slice(0, 300) });
        record();
      }
      }
    }
    run.review = { verdict, ...(reviewPanels ? { panels: reviewPanels } : {}) };
    record();

    // ---------------------------------------------------------------- ship (controller only)
    enter("ship", "the controller's transaction through every gate");
    assertPackageContext();
    const headBefore = board.refs.resolve(REF);
    // ship() is ONE transaction over the whole change, and its artifacts come from ONE ref. With
    // several slots the artifacts sit on several seat wips (CARRY never moves code, by design), so
    // the controller stages them onto a single ref first. Shipping per-wip instead would ship a
    // partial change -- some files gated, others not yet written -- which is exactly what a
    // transaction is supposed to prevent. A single-slot run ships straight from its own wip, as
    // it always has.
    let shipFrom = wip;
    if (BUILT && BUILT.length > 1) {
      shipFrom = "refs/seat/controller-stage/wip";
      await board.refs.branch({ name: shipFrom, from: REF, author: CONTROLLER });
      for (const c of BUILT) {
        const st = await merge({ ...board, into: shipFrom, from: c.wip, author: CONTROLLER,
          only: ["artifact:", "critique:", "item:", "plan"], msg: `stage ${c.sl.slot} for the ship transaction` });
        if (!st.ok) throw new Error(`stage ${c.sl.slot}: ${st.why}`);
      }
      progress({ event: "staged", detail: `${BUILT.length} slots staged onto ${shipFrom} for one ship transaction` });
    }
    // The controller must schedule integrate for every built item, and law 7 must hold on facts the
    // ship gates derive. A ship the controller would not schedule is refused here with its reason,
    // through the same record a gate refusal takes; nothing moves.
    const integrate = stageCheck({ ...board, ref: REF, stage: "ship" });
    const unscheduled = (BUILT ?? []).filter(c => !integrate.candidates.some(r => r.item === c.itemKey));
    // The gates are judged once, at `shipNow`, and that verdict goes on the ledger before the ship acts
    // on it: a `gate` entry naming this board, the heads it read and the lease entries it cites
    // (pantheon/src/ledger/gate-kind.mjs). It re-derives after the board moves on, a refusal included.
    const shipNow = Date.now();
    let gateVerdict = null;
    if (BOARD_LEDGER?.recordGate) {
      const { gateRecord } = await import("../ledger/gate-kind.mjs");
      const payload = await gateRecord({ ...board, ref: REF, from: shipFrom, actor: CONTROLLER, now: shipNow, leaseLedger: BOARD_LEDGER });
      gateVerdict = { hash: BOARD_LEDGER.recordGate(payload), claim: payload.claim };
      run.ledger = { gate: gateVerdict.hash, ...(LEDGER_UNDERIVED ? { underived: LEDGER_UNDERIVED } : {}) };
    }
    // Under `fit`, every slot ships only with its whole panel approving: the REVIEW gate already refuses a
    // blocking finding, and this refuses a panel that is short of its required approvals for any other reason.
    const shortPanels = (reviewPanels ?? []).filter(pn => pn.reviewers.filter(x => x.verdict === "approve").length < pn.required);
    let r;
    if (unscheduled.length) {
      const dry = await ship({ ...board, ref: REF, from: shipFrom, actor: CONTROLLER, dryRun: true, now: shipNow });
      r = { ok: false, gates: dry.gates, why: `the controller did not schedule integrate for ${unscheduled.map(c => c.itemKey).join(", ")}` +
        ` (${integrate.dropped.join("; ") || integrate.why})${dry.ok ? "; the ship gates alone would have passed" : `; ship gates: ${dry.why}`}` };
    } else if (shortPanels.length) {
      const dry = await ship({ ...board, ref: REF, from: shipFrom, actor: CONTROLLER, dryRun: true, now: shipNow });
      r = { ok: false, gates: dry.gates, why: `REVIEW_PANEL: ${shortPanels.map(pn => `${pn.slot} has ${pn.reviewers.filter(x => x.verdict === "approve").length} ` +
        `of ${pn.required} required approvals (${pn.reviewers.map(x => `${x.lab}: ${x.verdict}`).join(", ")})`).join("; ")}` +
        `${dry.ok ? "" : `; ship gates: ${dry.why}`}` };
    } else {
      assertLaw(await shipClaim({ ...board, ref: REF, from: shipFrom, actor: CONTROLLER, now: shipNow }));
      r = await ship({ ...board, ref: REF, from: shipFrom, actor: CONTROLLER, now: shipNow });
    }
    if (gateVerdict) {
      check(gateVerdict.claim.gates.every(g => r.gates.find(x => x.gate === g.gate)?.ok === g.ok),
        `the recorded gate verdict is the one the ship ran (${gateVerdict.hash.slice(0, 19)})`);
    }
    for (const g of r.gates) progress({ event: "gate", stage: g.gate, detail: g.ok ? "pass" : `REFUSE — ${g.why}` });
    progress({ event: "ship", detail: r.ok ? `shipped ${r.shipped.join(", ")} as ${shortCid(r.commit)}` : `refused: ${r.why}` });
    run.gates = r.gates; run.shipped = r.ok; run.ship_why = r.ok ? null : r.why;
    if (r.ok) run.certificate = { ref: REF, commit: r.commit };
    record(); // shipping is durable even if the following export fails; resume must not re-spend seats.
    if (r.ok) check(board.refs.resolve(REF) !== headBefore, `shipped ${r.shipped.join(", ")} as ${shortCid(r.commit)}`);
    else check(false, `ship refused: ${r.why}`);

    if (r.ok) exportShipped();
    else {
      run.artifacts = []; run.artifact = null;
      for (const c of crew) writeArtifact(REPO_ROOT,
        relative(REPO_ROOT, join(outDir, "artifact-latest", c.sl.path)), board.store.get(c.bytes));
    }
    const artifactOut = r.ok ? join(outDir, "artifact") : join(outDir, "artifact-latest");
    run.finished_at = new Date().toISOString();
    record();

    progress({ event: "run.end", detail: `acceptance exit ${recordedExit} after ${rev} revision(s); review ${verdict}; shipped=${r.ok}; ${failures} check(s) failed; artifact at ${artifactOut}` });

    const shipRefusalError = (!run.shipped && run.ship_why) ? { stage: "ship", message: run.ship_why } : null;
    return { ok: failures === 0, shipped: run.shipped === true, key: spec.key, board: root, outDir, error: run.error ?? shipRefusalError, salvaged: run.salvaged ?? null };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 400);
    try { progress({ event: "run.error", detail: msg }); } catch { /* nothing left to write with */ }
    try {
      run.error = { stage, message: msg, at: new Date().toISOString() };
      if (recordAllowed) for (const file of run.files ?? []) {
        if (!file.bytes) continue;
        const out = join(outDir, "artifact-latest", file.path);
        writeArtifact(REPO_ROOT, relative(REPO_ROOT, out), board.store.get(file.bytes));
        run.salvaged ??= out;
      }
      record();
    } catch { /* best effort */ }
    return { ok: false, shipped: run.shipped === true, key: spec.key, board: root, outDir, error: run.error ?? { stage, message: msg }, salvaged: run.salvaged ?? null };
  }
}
