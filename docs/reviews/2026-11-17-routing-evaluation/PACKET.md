# Review packet: routing profiles and their continuous evaluation

Commit 41e6262 of github.com/dsmcewan/OPHANIM (branch ccr-aa24f0d5-336szn).

## File: docs/reviews/2026-11-17-routing-evaluation/DESIGN.md
````
# Continuous evaluation of routing profiles (proposed, not built)

Owner direction 2026-11-17: evaluate routing going forward, continuously, from current state, or build an effective test and metrics. Builds on: `fit` (task-profile routing, non-default), audit M5 (per-attempt usage, attempts, unknown cost stays unknown), audit C3 (every cycle close requires a practice assessment/disposition; a lab cannot promote its own proposal; dispatch records the admitted decision it loaded).

1. **Shadow selection, every dispatch (no spend).** Each run records, beside the seat it used, the seat the other profile would have chosen. Accumulates a disagreement map; says nothing about quality.
2. **Interleaved assignment on work that runs anyway.** Each eligible ticket gets an arm (`fit` or `argo`) by a deterministic hash of its id, recorded. Only low/normal stakes tickets are eligible until `fit` is qualified for a stratum; high/critical stay on `argo`. Same acceptance and review gates for both arms. No added provider spend beyond the work itself.
3. **Metrics per run** (from run.json attempts/resources/usage and the review cycle), compared per arm within stakes strata: accepted (shipped and review gate passed), first-pass (accepted with zero revisions), revisions to accept, review rejections, provider calls and tokens per accepted ticket (tokens only over usage-complete runs), USD only if every attempt states a cost (else unknown), elapsed, escalations by action, fallbacks, coordination overhead (non-work calls / total). Rates carry Wilson 95% intervals.
4. **Decision rule at every cycle close** fills C3's required assessment: `insufficient_evidence` until n >= 20 per arm per stratum; then `propose_policy` for that stratum only if `fit` is non-inferior on accepted and first-pass (lower 95% bound of the difference >= -5 points) AND lower on calls/tokens/elapsed per accept. Promotion still requires an independent other-lab reviewer and live (non-synthetic) evidence.
5. **Stop rule.** Interleaving stops for a stratum, recorded, if `fit`'s accepted rate is >= 10 points below `argo` at the upper 95% bound after n >= 10.
Thresholds (20, 5, 10) are provisional named constants.
````

## File: docs/routing-task-profile.md
````
# Routing candidate `fit`: a task profile with independent dimensions

Status: **candidate, unmeasured, not the default.** `argo` remains the owner-approved default routing profile. `fit` is selectable for one run (`runOpenItem(spec, { profile: "fit" })`, `pantheon-board run <item> --profile fit`). Nothing below claims that `fit` routes better. Its tables are routing judgments. Until the comparison in [Adoption path](#adoption-path) is done, it stays provisional (CYCLE_CONTRACT steps 4, 6 and 7).

## The problem

The owner put it this way: "Easy and Hard is not an effective scale and does not utilize the breadth of alternatives." Before `fit`, one `difficulty` label (easy|medium|hard) moved two unrelated dials together. Under `legacy` it picked one hand-chosen model per band, and it also picked the output tier. It drove nothing else:

- Effort was never chosen up front. A model ran at its documented default, and effort rose only when an escalation followed a failure.
- Each role could reach 3 to 5 hand-picked models. The registry holds 21 (18 API models in `models.json` and 3 lane models in `lanes.json`) from four labs. Counting each documented effort level as a separate setting gives 77 (model, effort) operating points. 74 of them can be reached on a transport that carries effort.
- Stakes had no effect on how many independent labs review the work.

## Dimensions and the dial each one drives

Code: `pantheon/src/route/task-profile.mjs` and the `fit` path in `pantheon/src/route/frontier.mjs`. Each dimension is a `{value, basis}` pair. The basis is `ticket` (an explicit ticket field), `derived:<signal>`, or `legacy-difficulty`.

| Dimension | Values | Dial it drives | Default source |
|---|---|---|---|
| `depth` | none, light, standard, deep, max | Effort rung. Depth index *d* (0 to 4) maps to rung `round(d·(n−1)/4)` of the chosen model's own documented ladder (`capability-facts.json` `efforts.values`). A model with no documented ladder, or a seat on a transport that carries no effort (agy), gets no effort, and the record says which case applied. | legacy |
| `output` | xs, s, m, l, xl = 1024, 4096, 16384, 32768, 65536 | Output tier (`OUTPUT_TIERS` in `config/tiers.mjs`), still capped at the documented ceiling. easy, medium and hard alias s, m and l with unchanged budgets. | legacy |
| `context` | measured estimate only (prompt chars / 4) | Admission under M7: a documented window smaller than the estimate, or an unrecorded window, excludes the model and records the reason. A ticket `context` field is refused. | derived:prompt-chars |
| `stakes` | low, normal, high, critical | Minimum model class (fast, standard, frontier, frontier). Also the number of independent review labs (1, 1, 2, 3), returned as `requirements.review_labs` and not yet consumed by the review cycle. | ticket > derived:paths > legacy |
| `ambiguity` | settled, open, contested | The planner's class floor (fast, standard, frontier). Also an explorer width (0, 1, 3 distinct labs), returned as `requirements.explorer_width` and not consumed yet. | legacy |
| `latency` | interactive, batch | Tie-break toward the faster class. Fallbacks may climb at most 1 class above the floor for `interactive` and 2 for `batch`. | derived:dispatch-mode (`batch` for the board dispatcher) |
| `kind` | code, analysis, prose, review | Capability filter where facts support one. None do today: no cited fact separates these abilities, so every selection records `filter: "unfiltered"` with that reason. | derived:paths (docs-only gives prose, otherwise code) |

How stakes are derived from the touched paths:

- A path segment naming ledger, governance, authority, key, security, secret or signing gives `critical`.
- A change that touches only tests or docs gives `low`.
- Anything else keeps the legacy default.
- A `stakes` field on the ticket overrides the derived value.

Old tickets still run. Their difficulty maps to a default profile, and any dimension field on the ticket overrides the mapped value:

| difficulty | depth | output | stakes | ambiguity |
|---|---|---|---|---|
| easy | light | s | normal | settled |
| medium | standard | m | normal | open |
| hard | deep | l | high | open |

## How `fit` selects

1. **Candidates.** Every registered model that the role may use, marked in one of two ways:
   - `role-table`: the model appears in one of the role's tables (ARGO `seats`, `SEATING`, `INTAKE`).
   - `lab-allowed:<lab>`: any registry model from a lab that those tables already allow.
2. **Admission.** Context (M7), avoided vendors and avoided labs (independence), and pools, as in the other profiles.
3. **Class.** The lowest admitted class at or above the floor set by stakes (for the planner, by ambiguity as well). Classes come from `pantheon/src/config/classes.json`.
4. **Breadth.** Within a class, one model from each lab before a second from any lab. Labs follow the role's declared order: first appearance across its tables, with ARGO's table first.
5. **Fallbacks.** Across labs at the same class before stepping up a class. Never below the floor.
6. **Effort.** Taken from depth, on each candidate's own ladder. The request carries it.

Every candidate's `selection` records:

- the profile dimensions with their bases
- the class floor and the reason for it
- the class with its basis and status
- the eligibility marking
- the effort and how it was mapped
- the output tier
- `review_labs` and `explorer_width`
- the latency climb
- the excluded models with their reasons

`selectionPolicy("fit")` hashes the class table, the dimension mapping, the registry, and each role's allowed labs. The `argo` and `legacy` hashes are unchanged and pinned by a test.

Operating points reached as first seats, over a fixed set of 180 tickets × 4 roles (`tests/route-task-profile.test.mjs`):

| Profile | Distinct (model, effort) points |
|---|---|
| `argo` | 4 |
| `legacy` | 8 |
| `fit` | 42 |

These counts measure reach. They say nothing about quality.

## What is provisional

All of it. That includes:

- the class of every model: 19 are `TASTE`. Two are `VENDOR`, with the vendor's positioning quote as cited in `seating.mjs`, and the kb file that quote comes from is not in this checkout.
- the stakes-to-class and ambiguity-to-class floors
- the review-lab and explorer-width counts
- the proportional depth-to-effort mapping
- the latency climb limits
- the path patterns used to derive stakes
- the declared lab order

None of these has been measured. A class is a routing label, not a quality claim.

## Adoption path

`fit` can become the default only after a recorded practice disposition, per CYCLE_CONTRACT step 6:

1. **Matched comparison.** Run `fit` and `argo` on the same tickets, with the same acceptance and quality requirements and the same declared resource bounds. Record for each:
   - accepted-result quality
   - total provider usage and cost where known (unknown stays unknown)
   - elapsed time
   - rework (revisions)
   - retry and fallback calls
   - coordination overhead

   Include failed and inconclusive runs.
2. **Independent review.** An eligible reviewer from a different lab checks the scope, the raw results and the interpretation.
3. **Disposition.** Record `promote`, `retain` or `reject`, with applicability, provenance, the `fit` policy hash, a rollback condition and a re-evaluation condition.

Until all three are done, `argo` stays the default, and any `fit` run is labelled as running a provisional candidate.

Not done in this change:

- `review_labs` and `explorer_width` are not wired into the review cycle or into intake fan-out.
- The intake scouts under `fit` use the legacy INTAKE seats.
- The printed seating report for a `fit` run shows the legacy table.
- When a fallback model rather than the primary answers, a later effort escalation starts from the primary's mapped effort.
````

## File: pantheon/src/route/task-profile.mjs
````
// A task profile: independent dimensions of a ticket, each driving its OWN dial (the `fit` routing
// candidate, docs/routing-task-profile.md). It replaces nothing: `argo` stays the approved default, and a
// ticket that names only `difficulty` still runs -- the legacy label maps to a default profile here.
//
//   depth      none|light|standard|deep|max  -> the effort rung, mapped proportionally onto the chosen
//                                               model's OWN documented ladder (capability-facts.json)
//   output     xs|s|m|l|xl                   -> output tier (config/tiers.mjs), capped at the documented ceiling
//   context    measured estimate only        -> admission (M7: an unrecorded window is excluded with its reason)
//   stakes     low|normal|high|critical      -> minimum model class AND the number of independent review labs
//   ambiguity  settled|open|contested        -> planner class floor and an explorer width (distinct labs)
//   latency    interactive|batch             -> tie-break toward the faster class (how far fallbacks may climb)
//   kind       code|analysis|prose|review    -> capability filter where facts support it, else recorded unfiltered
//
// Every dimension is {value, basis}; basis is `ticket` (the ticket's own field), `derived:<signal>`, or
// `legacy-difficulty`. Every mapping below is PROVISIONAL: a routing judgment, not a measurement.
import { documentedEfforts, carriesEffort } from "./protocol.mjs";

export const TASK_PROFILE = "pantheon.task-profile/v1";
export const DIMENSIONS = Object.freeze({
  depth: Object.freeze(["none", "light", "standard", "deep", "max"]),
  output: Object.freeze(["xs", "s", "m", "l", "xl"]),
  stakes: Object.freeze(["low", "normal", "high", "critical"]),
  ambiguity: Object.freeze(["settled", "open", "contested"]),
  latency: Object.freeze(["interactive", "batch"]),
  kind: Object.freeze(["code", "analysis", "prose", "review"]),
});
const DECLARED = ["depth", "output", "stakes", "ambiguity", "latency", "kind"];

/** The default profile for an old ticket's single label. Explicit dimension fields win over it. */
export const LEGACY_PROFILE = Object.freeze({
  easy: Object.freeze({ depth: "light", output: "s", stakes: "normal", ambiguity: "settled" }),
  medium: Object.freeze({ depth: "standard", output: "m", stakes: "normal", ambiguity: "open" }),
  hard: Object.freeze({ depth: "deep", output: "l", stakes: "high", ambiguity: "open" }),
});

// Dimension -> requirement tables. PROVISIONAL (2026-11-17), unmeasured.
export const STAKES_FLOOR = Object.freeze({ low: "fast", normal: "standard", high: "frontier", critical: "frontier" });
export const REVIEW_LABS = Object.freeze({ low: 1, normal: 1, high: 2, critical: 3 });
export const AMBIGUITY_FLOOR = Object.freeze({ settled: "fast", open: "standard", contested: "frontier" });
export const EXPLORER_WIDTH = Object.freeze({ settled: 0, open: 1, contested: 3 });
// Roles whose class floor the ambiguity dimension also sets (the planner owns resolving it).
export const AMBIGUITY_ROLES = Object.freeze(["planner"]);
// How many classes above the floor fallbacks may climb: interactive work prefers the faster class.
export const LATENCY_CLIMB = Object.freeze({ interactive: 1, batch: 2 });

// Paths: a touched path naming ledger/governance/authority/key/security material is critical; a change
// that touches only tests or docs is low. Matched on path segments, so "monkey.mjs" is not a key.
const CRITICAL = /(^|[/._-])(ledgers?|governance|authority|authorities|keys?|security|secrets?|signing)([/._-]|$)/i;
const LOW = p => /(^|\/)(tests?|docs?)\//i.test(p) || /\.test\.[cm]?[jt]s$/i.test(p) || /\.md$/i.test(p);

export function stakesFromPaths(paths = []) {
  const list = paths.filter(p => typeof p === "string" && p);
  if (!list.length) return null;
  const hit = list.find(p => CRITICAL.test(p));
  if (hit) return { value: "critical", why: `${hit} names ledger/governance/authority/key/security material` };
  if (list.every(LOW)) return { value: "low", why: "every touched path is tests or docs" };
  return null;
}

/** The mapping the profile applies, as data: what selectionPolicy('fit') hashes. */
export const PROFILE_MAPPING = Object.freeze({ schema: TASK_PROFILE, dimensions: DIMENSIONS, legacy: LEGACY_PROFILE,
  stakes_floor: STAKES_FLOOR, review_labs: REVIEW_LABS, ambiguity_floor: AMBIGUITY_FLOOR, ambiguity_roles: AMBIGUITY_ROLES,
  explorer_width: EXPLORER_WIDTH, latency_climb: LATENCY_CLIMB, depth_to_effort: "round(depth_index * (ladder_length - 1) / 4)",
  stakes_paths: { critical: CRITICAL.source, low: "tests/ or docs/ segment, *.test.*, *.md" } });

/**
 * The profile for a ticket. `signals`: {paths} (the files the ticket touches), {context_tokens} (a measured
 * estimate, when one exists at this point), {mode} (`batch` for the board dispatcher). Throws on a value
 * outside a dimension's set, and on a declared `context`: context is measured, never declared.
 */
export function taskProfile(spec = {}, signals = {}) {
  if (spec.context !== undefined) throw new Error("ticket field \"context\" is not accepted: context is measured (an estimate from the prompt), never declared");
  const difficulty = spec.difficulty ?? "medium";
  const legacy = LEGACY_PROFILE[difficulty];
  if (!legacy) throw new Error(`unknown ticket difficulty "${difficulty}" (known: ${Object.keys(LEGACY_PROFILE).join(", ")})`);
  for (const k of DECLARED) if (spec[k] !== undefined && !DIMENSIONS[k].includes(spec[k])) {
    throw new Error(`unknown ${k} "${spec[k]}" (known: ${DIMENSIONS[k].join(", ")})`);
  }
  const ticket = k => spec[k] !== undefined ? { value: spec[k], basis: "ticket" } : null;
  const fromLegacy = k => ({ value: legacy[k], basis: "legacy-difficulty" });
  const paths = stakesFromPaths(signals.paths);
  const docsOnly = paths?.value === "low";
  return {
    schema: TASK_PROFILE,
    difficulty: { value: difficulty, basis: spec.difficulty === undefined ? "legacy-difficulty" : "ticket" },
    depth: ticket("depth") ?? fromLegacy("depth"),
    output: ticket("output") ?? fromLegacy("output"),
    context: Number.isFinite(signals.context_tokens) ? { value: signals.context_tokens, basis: "derived:prompt-chars" } : { value: null, basis: "derived:prompt-chars" },
    stakes: ticket("stakes") ?? (paths ? { value: paths.value, basis: "derived:paths" } : (signals.paths?.length
      ? (legacy.stakes === "normal" ? { value: "normal", basis: "derived:paths" } : fromLegacy("stakes")) : fromLegacy("stakes"))),
    ambiguity: ticket("ambiguity") ?? fromLegacy("ambiguity"),
    latency: ticket("latency") ?? { value: signals.mode === "interactive" ? "interactive" : "batch", basis: "derived:dispatch-mode" },
    kind: ticket("kind") ?? { value: docsOnly ? "prose" : "code", basis: "derived:paths" },
  };
}

/** The minimum model class for a role under a profile, and why. */
export function classFloor(task, role, order = ["fast", "standard", "frontier"]) {
  const why = [`stakes ${task.stakes.value} (${task.stakes.basis}) -> ${STAKES_FLOOR[task.stakes.value]}`];
  let floor = STAKES_FLOOR[task.stakes.value];
  if (AMBIGUITY_ROLES.includes(role)) {
    const a = AMBIGUITY_FLOOR[task.ambiguity.value];
    why.push(`ambiguity ${task.ambiguity.value} (${task.ambiguity.basis}) -> ${a} for the ${role}`);
    if (order.indexOf(a) > order.indexOf(floor)) floor = a;
  }
  return { value: floor, why: why.join("; ") };
}

/** Requirements the profile states for later stages to consume (not wired into the review cycle here). */
export function requirementsOf(task) {
  return {
    review_labs: { value: REVIEW_LABS[task.stakes.value], basis: `stakes ${task.stakes.value} (${task.stakes.basis})` },
    explorer_width: { value: EXPLORER_WIDTH[task.ambiguity.value], basis: `ambiguity ${task.ambiguity.value} (${task.ambiguity.basis})`, unit: "distinct labs" },
  };
}

/**
 * The effort for a depth on a model's OWN documented ladder, proportionally: depth index d of 0..4 maps to
 * rung round(d * (n - 1) / 4) of the model's n documented values. No documented ladder, or a transport that
 * does not carry effort, gives none -- and says which.
 */
export function effortForDepth(depth, { vendor, model }) {
  const d = DIMENSIONS.depth.indexOf(depth);
  if (d === -1) throw new Error(`unknown depth "${depth}"`);
  if (!carriesEffort({ vendor, model })) return { value: null, depth, ladder: [], mapped: `none: effort is not carried by the agy transport for ${model}` };
  const ladder = documentedEfforts(model);
  if (!ladder.length) return { value: null, depth, ladder: [], mapped: `none: ${model} has no documented effort ladder (capability-facts.json)` };
  const i = Math.round(d * (ladder.length - 1) / (DIMENSIONS.depth.length - 1));
  return { value: ladder[i], depth, ladder: [...ladder], index: i,
    mapped: `depth ${depth} (${d}/${DIMENSIONS.depth.length - 1}) -> rung ${i}/${ladder.length - 1} "${ladder[i]}" of ${model}'s documented ladder [${ladder}]` };
}
````

## File: pantheon/src/config/classes.json
````
{
 "schema": "pantheon.model-classes/v1",
 "set": "2026-11-17",
 "status": "provisional",
 "rule": "A class is a declared ROUTING LABEL, not a quality claim and not a measurement. fast < standard < frontier. Every entry names its basis: VENDOR only where the vendor's own positioning text is quoted, otherwise TASTE (an operator-style judgment). Nothing in this table has been measured by this project; every entry stays provisional until a matched comparison (docs/routing-task-profile.md) says otherwise.",
 "order": ["fast", "standard", "frontier"],
 "lab_order": ["anthropic", "openai", "google", "xai"],
 "models": {
  "claude-haiku-4-5-20251001": { "class": "fast", "basis": "TASTE", "status": "provisional",
   "note": "the smallest current Anthropic registry model; the adapter already uses it as the cheap unspecified-call default (tests/adapter-cheap-default.test.mjs). No vendor positioning quote is recorded in capability-facts.json." },
  "claude-sonnet-5": { "class": "standard", "basis": "TASTE", "status": "provisional",
   "note": "the middle of the Anthropic registry ladder. No vendor positioning quote recorded." },
  "claude-opus-5": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "legacy Opus; capability-facts.json records status \"Active (legacy)\". No positioning quote recorded." },
  "claude-opus-5-5": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "current Opus. No positioning quote recorded." },
  "claude-fable-5-2": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "the ARGO planner's first seat. No positioning quote recorded." },
  "gpt-6-luna": { "class": "fast", "basis": "VENDOR", "status": "provisional",
   "source": "kb/openai-agent-docs/codex/agent-configuration-subagents.md:165-181, as quoted in pantheon/src/role/seating.mjs",
   "quote": "Use for fast, narrowly scoped agents handling clear, repeatable, or high-volume work.",
   "note": "the quoted kb file is not in this checkout, so the citation is carried, not re-verified here." },
  "gpt-6-astra": { "class": "standard", "basis": "TASTE", "status": "provisional",
   "note": "the ARGO implementer's first seat. The same vendor page (as quoted in seating.mjs) says to start Astra at `low` effort; that is not a class statement, so the class is TASTE." },
  "gpt-6-sol": { "class": "frontier", "basis": "VENDOR", "status": "provisional",
   "source": "kb/openai-agent-docs/codex/agent-configuration-subagents.md:165-181, as quoted in pantheon/src/role/seating.mjs",
   "quote": "Start here for demanding agents. It's strongest for ambiguous, multi-step work that needs planning, tool use, validation, and follow-through across a larger context.",
   "note": "the quoted kb file is not in this checkout, so the citation is carried, not re-verified here." },
  "gpt-6.1-sol": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "capability-facts.json records that the GPT-6 Sol page points to GPT-6.1 Sol as the newer Sol model; the class follows Sol by judgment." },
  "grok-4.3": { "class": "fast", "basis": "TASTE", "status": "provisional",
   "note": "the ARGO scout; documented default effort `low`. No positioning quote recorded." },
  "grok-4.5": { "class": "standard", "basis": "TASTE", "status": "provisional", "note": "No positioning quote recorded." },
  "grok-4.6": { "class": "standard", "basis": "TASTE", "status": "provisional",
   "note": "the legacy medium-band reviewer. No positioning quote recorded." },
  "grok-4.7": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "the ARGO reviewer's first seat. No positioning quote recorded." },
  "grok-4.20-multi-agent": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "an internal multi-agent team; capability-facts.json records no max_tokens and no client-side tools on this variant." },
  "grok-build-0.1": { "class": "fast", "basis": "TASTE", "status": "provisional",
   "note": "capability-facts.json records it aliases grok-code-fast-1; an alias name is not a positioning quote." },
  "gemini-3.6-flash": { "class": "fast", "basis": "TASTE", "status": "provisional", "note": "a Flash model. No positioning quote recorded." },
  "gemini-4-argon": { "class": "fast", "basis": "TASTE", "status": "provisional",
   "note": "ARGO seats it in the fast_loop chair. No positioning quote recorded." },
  "gemini-4-carbon": { "class": "frontier", "basis": "TASTE", "status": "provisional",
   "note": "ARGO's planner/implementer/reviewer fallback and synthesis seat. No positioning quote recorded." },
  "claude-sonnet-4-6": { "class": "standard", "basis": "TASTE", "status": "provisional", "note": "agy CLI lane model (lanes.json)." },
  "claude-opus-4-6-thinking": { "class": "frontier", "basis": "TASTE", "status": "provisional", "note": "agy CLI lane model (lanes.json)." },
  "gemini-3.8-flash-high": { "class": "fast", "basis": "TASTE", "status": "provisional", "note": "agy CLI lane model (lanes.json)." }
 }
}
````

## File: pantheon/src/ledger/practice-kinds.mjs
````
// The practice assessment and disposition of a review cycle, on the ledger (independent review
// 2026-11-16, C3; docs/reviews/2026-11-16-routing-coordination/CYCLE_CONTRACT.md steps 1, 3, 7 and 8).
// Two complete cycles closed `verified` with no routing/coordination assessment and no decision a later
// dispatch consumed. This kind is that record, and the cycle contract that requires it:
//
//   practice.disposition  {schema: pantheon.practice/v1, scope, stage, policy, question, outcome, measured,
//                          provisional, evidence, provenance, candidate, proposer, by, conditions, at}
//     stage `assessment`  the cycle's bounded next step (step 3): `retain`, `insufficient_evidence`,
//                         `propose_measurement`, or `propose_policy` (which names its candidate policy and
//                         the seat that proposed it)
//     stage `candidate`   the disposition of a qualified candidate (step 7): `promote`, `retain` or
//                         `reject`, citing the `propose_policy` entry it decides. It is decided BY a seat
//                         ({vendor, model, lab}, the lab re-derived with labOf), and a promote by a seat of
//                         the proposer's lab is refused: a learning component, or the author of a candidate,
//                         cannot record its own promotion. A promote is measured, cites ledger evidence, and
//                         states its applicability, rollback and re-evaluation conditions.
//   Every disposition names the selection policy in effect (`pantheon.selection/v1` and the hash
//   selectionPolicy(profile, {pools}) gives, route/frontier.mjs): the cycle's own. Unmeasured judgment is
//   labelled provisional. Evidence is {kind: ledger, hash} (an earlier entry, also cited), {kind: digest,
//   schema, sha} or {kind: document, path, sha}: a document is evidence at most, never a decision.
//
// The cycle contract (cycle-kinds.mjs): a cycle records the contract it opened under. `pantheon.cycle/v2`
// (the default for a new cycle) names the policy in effect, the practice scope and the admitted decision
// it loaded at open (`prior`, cited), and cannot close without at least one assessment-stage disposition;
// its close lists the cycle's dispositions. A cycle with no `contract` field opened under the old contract
// and keeps its meaning: it closes, and its historical hashes verify, exactly as before. A scope that has
// opened a v2 cycle does not return to the old contract.
//
// What a later dispatch loads (admittedPractice, loadPractice): the latest `promote` or `retain` for the
// scope and profile among the dispositions a CLOSED cycle's close lists (a disposition its cycle's review
// gates have not carried is not admitted), else the named provisional default, the current selection
// policy. The dispatcher records the entry hash it loaded on every turn's selection (run-item.mjs); only
// a ledger entry changes it.
//
// What this does NOT do: run a comparison, read provider usage, or make the dispatcher execute a promoted
// candidate's tables. A promoted policy whose hash is not the one this dispatcher implements is loaded and
// recorded with `applies: false` and the reason; nothing pretends it ran.
import {canonical} from '../../../packages/ledger/canonical.mjs';
import {labOf} from '../config/models.mjs';
import {selectionPolicy} from '../route/frontier.mjs';

export const PRACTICE = 'practice.disposition';
export const PRACTICE_SCHEMA = 'pantheon.practice/v1';
export const CYCLE_CONTRACT = 'pantheon.cycle/v2';
/** The contract a cycle without a `contract` field opened under. Never written: an old cycle's payload is unchanged. */
export const CYCLE_CONTRACT_V1 = 'pantheon.cycle/v1';
export const DEFAULT_PRACTICE_SCOPE = 'routing-coordination';
export const ASSESSMENT_OUTCOMES = Object.freeze(['retain', 'insufficient_evidence', 'propose_measurement', 'propose_policy']);
export const CANDIDATE_OUTCOMES = Object.freeze(['promote', 'retain', 'reject']);
const ADMITTING = ['promote', 'retain'];
const CYCLE = 'cycle', CLOSE = 'cycle.close';
const ENTRY = /^sha256:[0-9a-f]{64}$/;
const SHA = /^(sha256:)?[0-9a-f]{64}$/;
const str = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A selection policy identity: {version, hash, profile}. */
export const validPolicy = p => plain(p) && str(p.version, 200) && ENTRY.test(p.hash ?? '') && str(p.profile, 64);
/** The policy this code implements for `profile`, as a disposition names it. */
export function currentPolicy(profile = 'argo', {pools = []} = {}) {
  const id = selectionPolicy(profile, {pools});
  return {version: id.policy, hash: id.hash, profile};
}
const validSeat = s => plain(s) && str(s.vendor, 64) && str(s.model, 200) && str(s.lab, 64);
const seatLab = s => (labOf(s.vendor, s.model) === s.lab ? null : `the ${s.vendor}/${s.model} seat's lab is ${labOf(s.vendor, s.model)}, not ${s.lab}`);
const validEvidence = e => plain(e) && (e.kind === 'ledger' ? ENTRY.test(e.hash ?? '')
  : e.kind === 'digest' ? str(e.schema, 200) && SHA.test(e.sha ?? '')
  : e.kind === 'document' ? str(e.path, 500) && SHA.test(e.sha ?? '') : false);
const validCandidate = c => plain(c) && str(c.id, 120) && validPolicy(c.policy) && str(c.change);
const validConditions = c => plain(c) && ['applicability', 'rollback', 'reevaluate'].every(k => str(c[k]));

function validate(p) {
  if (!plain(p) || p.schema !== PRACTICE_SCHEMA) return `a practice disposition is ${PRACTICE_SCHEMA}`;
  if (!str(p.scope, 120)) return 'a practice disposition names its practice scope';
  if (!['assessment', 'candidate'].includes(p.stage)) return 'a practice disposition is an assessment or a candidate disposition';
  const outcomes = p.stage === 'assessment' ? ASSESSMENT_OUTCOMES : CANDIDATE_OUTCOMES;
  if (!outcomes.includes(p.outcome)) return `an ${p.stage === 'assessment' ? 'assessment outcome' : 'candidate outcome'} is one of ${outcomes.join(', ')}`;
  if (!validPolicy(p.policy)) return 'a practice disposition names the policy in effect {version, hash, profile}';
  if (!str(p.question)) return 'a practice disposition names the question it assessed';
  if (typeof p.measured !== 'boolean' || typeof p.provisional !== 'boolean') return 'a practice disposition says whether it was measured and whether it is provisional';
  if (!p.measured && !p.provisional) return 'unmeasured judgment is labelled provisional';
  if (!Array.isArray(p.evidence) || p.evidence.length > 32 || !p.evidence.every(validEvidence)) return 'evidence is a list of {kind: ledger, hash} | {kind: digest, schema, sha} | {kind: document, path, sha}';
  if (!plain(p.provenance) || !plain(p.provenance.by) || !str(p.provenance.by.role ?? p.provenance.by.vendor, 120) || !str(p.provenance.method)) {
    return 'provenance names who assessed (by) and how (method)';
  }
  if (!ISO(p.at)) return 'a practice disposition names when it was recorded';
  const proposing = p.stage === 'candidate' || p.outcome === 'propose_policy';
  if (proposing ? !validCandidate(p.candidate) || !validSeat(p.proposer) : p.candidate !== null || p.proposer !== null) {
    return proposing ? 'a policy proposal and its disposition name the candidate {id, policy, change} and its proposer {vendor, model, lab}'
      : 'only a policy proposal or its disposition names a candidate';
  }
  if (proposing && p.candidate.policy.hash === p.policy.hash) return 'a candidate is a policy other than the one in effect';
  if (p.stage === 'candidate' ? !validSeat(p.by) : p.by !== null) return 'a candidate disposition is decided by a seat {vendor, model, lab}; an assessment names none';
  if (p.outcome === 'promote') {
    if (!p.measured) return 'a promote rests on measured evidence';
    if (!p.evidence.some(e => e.kind === 'ledger')) return 'a promote cites the retained comparison on the ledger';
    if (!validConditions(p.conditions)) return 'a promote states its applicability, rollback and re-evaluation (reevaluate) conditions';
  } else if (p.conditions !== null && !validConditions(p.conditions)) return 'conditions are {applicability, rollback, reevaluate}';
  return null;
}

const closedAt = (view, cycle) => view.entries().find(h => view.entry(h)?.kind === CLOSE && view.entry(h).derived_from.includes(cycle)) ?? null;

function rederive(e, view) {
  const p = e.payload, [cycle, ...rest] = e.derived_from;
  if (view.entry(cycle)?.kind !== CYCLE) return 'a practice disposition cites its cycle first';
  const c = view.payload(cycle);
  if (c.contract !== CYCLE_CONTRACT) return `a practice disposition belongs to a cycle opened under ${CYCLE_CONTRACT}`;
  if (closedAt(view, cycle)) return 'the cycle is closed';
  if (p.scope !== c.practice_scope) return `the cycle's practice scope is ${c.practice_scope}, not ${p.scope}`;
  if (canonical(p.policy) !== canonical(c.policy)) return 'the policy in effect is the one the cycle opened under';
  let cited = rest;
  if (p.stage === 'candidate') {
    const [proposal, ...more] = rest;
    cited = more;
    const q = view.entry(proposal)?.kind === PRACTICE ? view.payload(proposal) : null;
    if (!q || q.stage !== 'assessment' || q.outcome !== 'propose_policy') return 'a candidate disposition cites the policy proposal it decides, after its cycle';
    if (q.scope !== p.scope) return 'the proposal is of another practice scope';
    if (canonical(q.candidate) !== canonical(p.candidate) || canonical(q.proposer) !== canonical(p.proposer)) return 'the candidate is not the one the proposal names';
    const why = seatLab(p.by);
    if (why) return why;
    if (p.outcome === 'promote' && p.by.lab === q.proposer.lab) {
      return `the ${p.by.lab} lab proposed this candidate and may not record its own promotion: a promote is decided by a seat of another lab than the proposer's lab`;
    }
  }
  if (p.proposer) { const why = seatLab(p.proposer); if (why) return why; }
  const ledgerRefs = p.evidence.filter(x => x.kind === 'ledger').map(x => x.hash);
  if (new Set(ledgerRefs).size !== ledgerRefs.length || canonical(cited) !== canonical(ledgerRefs)) {
    return 'a practice disposition cites its cycle, the proposal it decides, and exactly its ledger evidence, in that order';
  }
  return null;
}

/** Kind spec. `authors` decides who records dispositions (the controller, which signs what the seats decided). */
export function practiceKinds({authors = () => true} = {}) {
  return {[PRACTICE]: {authors, validate, rederive}};
}

/** The practice dispositions of one cycle, in chain order. */
export const dispositionsOf = (view, cycle) => view.entries().filter(h => view.entry(h)?.kind === PRACTICE && view.entry(h).derived_from[0] === cycle);

/**
 * The admitted practice decision for `scope` (and `profile`, when given) as of `view`, or null: the latest
 * `promote` or `retain` among the dispositions that a cycle's close lists. Pure over the view.
 * Returns {disposition, outcome, stage, policy, provisional, question, cycle}; a promote admits the
 * candidate's policy, a retain the policy it retained.
 */
export function admittedPractice(view, {scope = DEFAULT_PRACTICE_SCOPE, profile = null} = {}) {
  const hs = view.entries(), admitted = new Set();
  for (const h of hs) if (view.entry(h)?.kind === CLOSE) for (const d of view.payload(h)?.practice ?? []) admitted.add(d);
  for (let i = hs.length - 1; i >= 0; i--) {
    const h = hs[i];
    if (!admitted.has(h) || view.entry(h)?.kind !== PRACTICE) continue;
    const p = view.payload(h);
    if (p.scope !== scope || !ADMITTING.includes(p.outcome)) continue;
    const policy = p.outcome === 'promote' ? p.candidate.policy : p.policy;
    if (profile !== null && policy.profile !== profile) continue;
    return {disposition: h, outcome: p.outcome, stage: p.stage, policy, provisional: p.provisional, question: p.question, cycle: view.entry(h).derived_from[0]};
  }
  return null;
}

const viewOf = ledger => {
  const byHash = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
  return {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? ledger.payloadOf(byHash.get(h)) : null), entries: () => [...byHash.keys()]};
};

/**
 * What a dispatch loads: the admitted practice decision on `ledger` (a chain: openPantheonLedger(...).ledger)
 * for `scope` and `profile`, else the named provisional default (this code's selection policy). Returns
 * the reference a turn's selection records: {schema, scope, disposition (entry hash or null), outcome,
 * policy, provisional, applies, reason}. `applies` says whether the loaded policy is the one this
 * dispatcher implements (selectionPolicy(profile, {pools})).
 */
export function loadPractice({ledger = null, scope = DEFAULT_PRACTICE_SCOPE, profile = 'argo', pools = []} = {}) {
  const current = currentPolicy(profile, {pools});
  const base = {schema: PRACTICE_SCHEMA, scope};
  const provisional = why => ({...base, disposition: null, outcome: null, policy: current, provisional: true, applies: true,
    reason: `${why}; the named provisional default ${current.version} (${current.profile}) applies`});
  if (!ledger || typeof ledger.read !== 'function') return provisional('no ledger is open for this dispatch');
  const a = admittedPractice(viewOf(ledger), {scope, profile});
  if (!a) return provisional(`no admitted practice disposition for ${scope} (${profile}) is on the ledger`);
  const applies = a.policy.hash === current.hash;
  return {...base, disposition: a.disposition, outcome: a.outcome, policy: a.policy, provisional: a.provisional, applies,
    reason: applies ? `loaded the admitted ${a.outcome} ${a.disposition.slice(0, 19)}; it is the policy this dispatcher runs`
      : `loaded the admitted ${a.outcome} ${a.disposition.slice(0, 19)}, whose policy ${a.policy.hash.slice(0, 19)} is not the one this dispatcher implements (${current.hash.slice(0, 19)}); the dispatch ran ${current.version} and records the difference`};
}

/** A selection (selectSeat's result) with the practice reference it was made under, on it and on every candidate. */
export function withPractice(choice, practice) {
  if (!choice || !practice) return choice;
  const tag = c => ({...c, selection: {...c.selection, practice}});
  const candidates = (choice.candidates ?? []).map(tag);
  // The seat stays the first candidate (the same object), as selectSeat returns it.
  const seat = choice.seat && (choice.seat === choice.candidates?.[0] ? candidates[0] : tag(choice.seat));
  return {...choice, selection: {...choice.selection, practice}, seat, candidates};
}

/** Records practice dispositions (the controller signs). Policy and scope are the cycle's own. */
export function practiceRecorder({ledger, controller, order}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  return {
    /**
     * Record a practice assessment (stage `assessment`) or a candidate's disposition (stage `candidate`,
     * citing `proposal`, decided `by` a seat). Refused by the ledger when it does not re-derive.
     */
    recordDisposition({cycle, stage = 'assessment', outcome, question, measured = false, provisional = !measured, evidence = [], provenance,
      candidate = null, proposer = null, proposal = null, by: seat = null, conditions = null, at = new Date().toISOString()}) {
      const view = viewOf(ledger), c = view.payload(cycle);
      if (!c) throw Object.assign(new Error(`recordDisposition: ${cycle} is not on the ledger`), {code: 'NO_CYCLE'});
      let cand = candidate, prop = proposer;
      if (stage === 'candidate' && proposal) { const q = view.payload(proposal); cand ??= q?.candidate ?? null; prop ??= q?.proposer ?? null; }
      const payload = {schema: PRACTICE_SCHEMA, scope: c.practice_scope ?? DEFAULT_PRACTICE_SCOPE, stage, policy: c.policy ?? null, question, outcome,
        measured, provisional, evidence, provenance, candidate: cand, proposer: prop, by: seat, conditions, at};
      const refs = evidence.filter(x => x?.kind === 'ledger').map(x => x.hash);
      return ledger.append({kind: PRACTICE, payload, derivedFrom: [cycle, ...(stage === 'candidate' && proposal ? [proposal] : []), ...refs], ...by}).hash;
    },
    /** The admitted practice decision on this ledger (admittedPractice). */
    admittedPractice: (opts = {}) => admittedPractice(viewOf(ledger), opts),
  };
}
````

