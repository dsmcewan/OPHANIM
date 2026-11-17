# Review packet: routing profiles and their continuous evaluation

Commit f96531a of github.com/dsmcewan/OPHANIM (branch ccr-aa24f0d5-336szn). run-item.mjs is large; the review panel, intake width and producer lab reservation are excerpted from it below.

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
| `stakes` | low, normal, high, critical | Minimum model class (fast, standard, frontier, frontier). Also the number of independent review labs (1, 1, 2, 3), `requirements.review_labs`, consumed by the review stage (see below). | ticket > derived:paths > legacy |
| `ambiguity` | settled, open, contested | The planner's class floor (fast, standard, frontier). Also an explorer width (0, 1, 3 distinct labs), `requirements.explorer_width`, consumed by intake (see below). | legacy |
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

## What `fit` runs at intake and review

These apply under `fit` only. `argo` and `legacy` keep one configured scout vendor and one reviewer.

- **Intake.** The run fields `explorer_width` scouts. The `fit` selector chooses each one for the scout role, one at a time, and each avoids every vendor and lab that already answered. So no two scouts share a lab, even after a fallback.
  - Width 0 runs no explorer stage, and the ticket cites no scouts.
  - The configured scout vendors and the legacy INTAKE seats are not used.
  - The scout role's tables name only two labs (xai, openai). The third lab comes from the roster's scout/explorer chair, `scout@opt` in `team/roster.mjs` (agy_google, xai, openai), which is the declared bench for that chair.
  - `run.json` `intake` records the width and each scout's selection.
  - If too few labs are eligible, the run refuses with `EXPLORER_LABS_UNAVAILABLE` before any scout is called.
- **Review.** The run fields `review_labs` reviewers per artifact, chosen one at a time. Each avoids the maker's lab, the planner's lab (law 3, `assertReviewCutsAcross`), and every vendor and lab already on the panel.
  - If fewer labs are eligible than required, the run refuses with `REVIEW_LABS_UNAVAILABLE` before any reviewer is called. It never runs fewer.
  - Every member's critique lands on the board, so the existing REVIEW gate refuses any rejection. The run also refuses to ship (`REVIEW_PANEL`) unless every member approved.
  - `run.json` `review.panels` records each member's lab, verdict and selection.
  - Only four labs exist, and the reviewer role allows three of them (xai, google, anthropic). Law 3 bars a reviewer from both the maker's and the planner's labs. So the producers are seated to keep the panel possible: when `review_labs` is 2 or more, a lab is reserved, and not offered to the planner or the maker, if a producer there would leave fewer eligible reviewer labs than required. Each turn's selection records the exclusion (`reserved for review`) and `reserved_review_labs`. For critical stakes this puts both planner and maker on openai, the one lab outside the reviewer set. That trades plan-versus-build lab independence for three independent reviews.
  - An explicit seat (operator override, pin, escalation) is never moved by the reservation. If the explicit seats already leave no producer lab that keeps the panel possible, the run is refused with `REVIEW_LABS_UNAVAILABLE` before any work or review call is made.
- **Escalation.** The slot's effort is the one the answering seat ran with. When a fallback answers, a later raise starts from the fallback's own mapped effort.

## What is provisional

All of it. That includes:

- the class of every model: 19 are `TASTE`. Two are `VENDOR`, with the vendor's positioning quote as cited in `seating.mjs`, and the kb file that quote comes from is not in this checkout.
- the stakes-to-class and ambiguity-to-class floors
- the review-lab and explorer-width counts
- the explorer bench (the labs of the roster's `scout@opt` chair), which is what lets explorer width reach 3
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

- The printed seating report for a `fit` run shows the legacy table.

## Running the comparison

`pantheon/bin/pantheon-compare.mjs` runs step 1 of the adoption path. Code: `pantheon/src/practice/compare.mjs`. The metric definitions are in `pantheon/src/practice/metrics.mjs` and are shared with any continuous evaluation over real runs.

Each ticket runs through `runOpenItem` under `argo` and then under `fit`, with the same declared bounds: `--max-provider-calls` per run (required) and `--revisions`. Every run is reported, including failed and inconclusive ones. Each run reports:

- whether it was accepted: shipped through every ship gate, `REVIEW` included
- whether it passed first time, and how many revisions acceptance took
- review rejections
- provider calls by outcome
- tokens, which are null unless every attempt reported usage
- USD, which is null unless every attempt states a cost
- elapsed time
- escalations by action
- fallbacks and retries
- coordination overhead
- the operating point of each turn: model, effort, and class under `fit`

Rates are stratified by stakes and carry Wilson 95% intervals. A stratum with fewer than 20 runs per arm (`MIN_N_PER_STRATUM`) is marked `insufficient`. Review verdicts, including the approvals of an optional cycle review (`--turn`), count as agreement, not correctness. The record draws no conclusion: `interpretation.verdict` is null.

The command writes the record to `--out`. It also prints the citation a practice disposition carries, `{kind: digest, schema: pantheon.compare/v1, sha, synthetic}`. A record is `synthetic: true` unless the providers are live. The ledger refuses a `promote` whose comparison evidence is synthetic only, so a synthetic record can support `propose_measurement` and nothing more.

**Synthetic, in this checkout.** This needs no keys and makes no network calls. The fakes are the test fixtures. Write `clients.fixture.mjs` as `import { scriptedClients } from "<abs path>/pantheon/tests/fixtures/dispatch.mjs"; export default scriptedClients();`. A reviewer turn module is like the one in `pantheon/tests/practice-compare.test.mjs`. Run with the fixture environment of `withDispatch`: `PANTHEON_AGY_CLI` points at a fake, and no Google key is set. The CLI test does exactly this:

```sh
cd pantheon && node --test tests/practice-compare.test.mjs
# or, with your own fake modules and tickets/<item>.json in REPO:
node pantheon/bin/pantheon-compare.mjs --repo REPO --item easy-ticket --item hard-ticket \
  --clients clients.fixture.mjs --turn turn.fixture.mjs --max-provider-calls 20 --revisions 2 \
  --question "synthetic: fit against argo" --out comparison.json
```

**Live, on the owner's machine.** The owner runs this with real keys. Nobody has run it from this checkout. It uses the provider keys Pantheon already reads: `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and an agy login. `--live` is never the default. At most it spends 2 × tickets × `--max-provider-calls` dispatcher calls, plus 3 cycle-review calls per shipped run:

```sh
node pantheon/bin/pantheon-compare.mjs --live --item <item-a> --item <item-b> \
  --max-provider-calls 12 --revisions 3 \
  --question "Does fit change accepted results, provider usage or elapsed time against argo on <scope>?" \
  --out outputs/compare/fit-vs-argo-$(date +%Y%m%d).json
```

The live record comes out `synthetic: false`, and it is scoped to the tickets and bounds it names. Its USD stays null until a versioned price source is attached. With fewer than 20 runs per arm per stakes stratum, every rate is `insufficient`. Steps 2 and 3 of the adoption path still apply: an independent review, then a recorded disposition.
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

/** Requirements the profile states for later stages: run-item.mjs consumes both under `fit` (review panel, intake width). */
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

## File: pantheon/src/practice/metrics.mjs
````
// Per-run practice metrics and their aggregate: ONE definition, shared by the matched comparison
// (compare.mjs) and by any continuous evaluation over real runs. Pure: reads a run.json object (and an
// optional independent cycle-review summary), writes nothing, calls nothing.
//
// Rules every value follows:
//   - not observable is null, never 0. A count that was observed to be zero is 0.
//   - every measured value carries what it rests on: {value, n} (n = the observations it is computed
//     from), with `missing` where some observations lacked it. Booleans are null when undecided.
//   - agreement is not correctness: `accepted` is the controller's ship decision through its gates (the
//     in-run cross-lab REVIEW gate included); a review verdict is reported as a verdict.
//
// runMetrics(runJson, {review, ticket}) -> one row
//   accepted              shipped AND the REVIEW ship gate passed (null when the run did not decide:
//                         no run, or the declared provider-call bound refused a call before shipping)
//   first_pass            accepted with exactly one revision (no rework)
//   revisions_to_accept   revisions when accepted, else null
//   review_rejections     non-approve verdicts: the in-run critiques (from the escalation records, and
//                         the final verdict) plus the cycle review's, when `review` is given
//   provider_calls, by_outcome   from run.attempts (every provider call, failed ones included)
//   tokens_in/out         sums only when every attempt reported usage; else null, with `missing`
//   usd                   null unless every attempt states its cost
//   elapsed_ms            run.started_at -> run.finished_at
//   escalations           by decision action (raise_effort, raise_output, step_rung, stop, ...)
//   fallbacks             turns answered by a candidate of rank > 0 (selection.rank)
//   retries               failed attempts followed by an attempt of the same purpose on the same seat
//   coordination_overhead non-work provider calls (plan, critique, scout) / all calls
//   profile, policy_hash, practice    from the turns' selection records
//   operating_points      per turn: purpose, vendor, model, effort (as sent), class (fit), rank
//   stakes                the selection's task profile stakes; for a profile that records none (argo,
//                         legacy), derived with taskProfile on the ticket (or the run's files)
//   calls_per_accept, tokens_per_accept   per accepted run (tokens only when usage is complete)
//
// aggregate(rows) -> per profile, per stakes stratum (and `all`): counts, accepted and first_pass rates
// with Wilson 95% intervals, medians of calls/tokens/elapsed per accept, and `insufficient` with the
// minimum n not yet met (MIN_N_PER_STRATUM per arm per stratum).
import { taskProfile } from "../route/task-profile.mjs";

export const METRICS_SCHEMA = "pantheon.practice-metrics/v1";
/** The minimum number of runs per arm per stakes stratum before a rate is treated as more than anecdote. */
export const MIN_N_PER_STRATUM = 20;
export const ESCALATION_ACTIONS = Object.freeze(["raise_effort", "raise_output", "step_rung", "stop"]);
const WORK_PURPOSES = new Set(["work"]);
const COORDINATION_PURPOSES = new Set(["plan", "critique", "scout"]);
const Z95 = 1.959963984540054;

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const v = (value, n, extra = {}) => ({ value, n, ...extra });
const costOf = a => num(a?.usd) ?? num(a?.cost_usd) ?? num(a?.cost?.usd);

/** The stakes stratum of a run: the selection's recorded task profile, else derived from the ticket. */
export function stakesOf(run, ticket = null) {
  const rec = (run?.turns ?? []).map(t => t.selection?.task?.stakes).find(s => s?.value);
  if (rec) return { value: rec.value, basis: rec.basis ?? "selection" };
  const paths = ticket ? [ticket.path, ...(ticket.slots ?? []).map(s => s.path)].filter(Boolean) : (run?.files ?? []).map(f => f.path).filter(Boolean);
  try {
    const p = taskProfile(ticket ?? {}, { paths });
    return { value: p.stakes.value, basis: `taskProfile:${p.stakes.basis}` };
  } catch { return { value: null, basis: "unobservable" }; }
}

/** A row for a run that produced no record (the runner failed): everything unobserved. */
export function unobservedRun({ profile = null, why = "no run record", review = null, stakes = { value: null, basis: "unobservable" } } = {}) {
  return { schema: METRICS_SCHEMA, profile, status: "inconclusive", why: String(why).slice(0, 300), policy_hash: null, practice: null, stakes,
    accepted: null, shipped: null, gates: null, first_pass: null, revisions: v(null, 0), revisions_to_accept: null,
    review_rejections: v(null, 0), provider_calls: v(null, 0), provider_call_limit: null, bound_hit: null, by_outcome: {}, failed_attempts: v(null, 0),
    retries: v(null, 0), fallbacks: v(null, 0), escalations: v(null, 0, { by_action: {} }),
    tokens_in: v(null, 0, { missing: null }), tokens_out: v(null, 0, { missing: null }), usage_complete: false,
    usd: v(null, 0, { missing: null, basis: "unknown: no run record" }), elapsed_ms: v(null, 0), coordination_overhead: v(null, 0, { calls: null }),
    coordination: { scout_turns: null, review_turns: null, cycle_review: review }, operating_points: [], calls_per_accept: null, tokens_per_accept: null };
}

function recoveries(attempts) {
  let retries = 0;
  attempts.forEach((a, i) => {
    if (a.outcome === "ok") return;
    const next = attempts.slice(i + 1).find(b => b.purpose === a.purpose);
    if (next && next.vendor === a.vendor && next.model === a.model && (next.pool ?? next.vendor) === (a.pool ?? a.vendor)) retries++;
  });
  return retries;
}

/** One run's metrics. `review`: an independent cycle review's summary ({verdicts: [...]} or {reviews, approvals}). */
export function runMetrics(run, { review = null, ticket = null, result = null, profile = null } = {}) {
  if (!run || typeof run !== "object") return unobservedRun({ profile, review, why: result?.error?.message ?? "no run record", stakes: stakesOf(null, ticket) });
  const attempts = run.attempts ?? [], turns = run.turns ?? [];
  const sel = turns.map(t => t.selection).find(s => s?.profile) ?? null;
  const by_outcome = {};
  for (const a of attempts) by_outcome[a.outcome] = (by_outcome[a.outcome] ?? 0) + 1;
  const missingUsage = attempts.filter(a => num(a.usage?.input_tokens) === null || num(a.usage?.output_tokens) === null).length;
  const usage_complete = attempts.length > 0 && missingUsage === 0;
  const sum = k => attempts.reduce((n, a) => n + num(a.usage[k]), 0);
  const missingCost = attempts.filter(a => costOf(a) === null).length;
  const usd = attempts.length > 0 && missingCost === 0 ? attempts.reduce((n, a) => n + costOf(a), 0) : null;
  const gates = Array.isArray(run.gates) ? Object.fromEntries(run.gates.map(g => [g.gate, g.ok === true])) : null;
  const bound_hit = Boolean(run.provider_calls?.refused);
  const shipped = run.shipped === true && result?.shipped !== false;
  const decided = shipped || !bound_hit;
  const accepted = decided ? shipped && gates?.REVIEW === true : null;
  const revisions = Array.isArray(run.revisions) ? run.revisions.length : num(run.acceptance?.revisions);
  const status = accepted === true ? "accepted" : accepted === null ? "inconclusive"
    : result?.error && result.error.stage !== "ship" ? "failed" : "not_accepted";
  const why = accepted === true ? null : bound_hit ? `the declared provider-call bound refused a call (${run.provider_calls.refused.code ?? "PROVIDER_CALL_LIMIT"})`
    : result?.error ? `${result.error.stage}: ${String(result.error.message ?? "").slice(0, 300)}` : run.ship_why ?? (run.shipped ? null : "not shipped");
  // In-run critique rejections: each non-approve critique the protocol recorded, and the final verdict when none was.
  const critiques = (run.escalations ?? []).filter(e => e.outcome?.kind === "critique");
  const inRun = critiques.filter(e => e.outcome.verdict !== "approve").length
    || (run.review?.verdict && run.review.verdict !== "approve" ? 1 : 0);
  const reviewSeen = critiques.length + (run.review?.verdict ? 1 : 0) > 0;
  const cycleVerdicts = review ? (review.verdicts ?? (review.reviews != null && review.approvals != null ? null : [])) : null;
  const cycleRejections = !review ? 0 : cycleVerdicts ? cycleVerdicts.filter(x => x !== "approve").length : (review.reviews - review.approvals);
  const by_action = {};
  for (const e of run.escalations ?? []) { const a = e.decision?.action; if (a) by_action[a] = (by_action[a] ?? 0) + 1; }
  for (const a of ESCALATION_ACTIONS) by_action[a] ??= 0;
  const answered = turns.filter(t => Number.isInteger(t.selection?.rank));
  const coordinationCalls = attempts.filter(a => COORDINATION_PURPOSES.has(a.purpose)).length;
  const started = Date.parse(run.started_at ?? ""), finished = Date.parse(run.finished_at ?? "");
  const elapsed = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
  const tokens = usage_complete ? sum("input_tokens") + sum("output_tokens") : null;
  return {
    schema: METRICS_SCHEMA, profile: profile ?? sel?.profile ?? null, recorded_profile: sel?.profile ?? null, status, why, policy_hash: sel?.policy_hash ?? null,
    practice: sel?.practice ? { disposition: sel.practice.disposition ?? null, outcome: sel.practice.outcome ?? null, policy_hash: sel.practice.policy?.hash ?? null,
      provisional: sel.practice.provisional ?? null, applies: sel.practice.applies ?? null } : null,
    stakes: stakesOf(run, ticket),
    accepted, shipped, gates, first_pass: accepted === null ? null : accepted && revisions === 1,
    revisions: v(revisions, revisions === null ? 0 : 1), revisions_to_accept: accepted ? revisions : null,
    review_rejections: v(reviewSeen || review ? inRun + cycleRejections : null, critiques.length + (review ? (cycleVerdicts?.length ?? review.reviews ?? 0) : 0),
      { in_run: reviewSeen ? inRun : null, cycle: review ? cycleRejections : null }),
    provider_calls: v(attempts.length, attempts.length), provider_call_limit: run.provider_calls?.limit ?? null, bound_hit, by_outcome,
    failed_attempts: v(attempts.filter(a => a.outcome !== "ok").length, attempts.length),
    retries: v(recoveries(attempts), attempts.length),
    fallbacks: v(answered.length ? answered.filter(t => t.selection.rank > 0).length : null, answered.length),
    escalations: v((run.escalations ?? []).length, (run.escalations ?? []).length, { by_action }),
    tokens_in: v(usage_complete ? sum("input_tokens") : null, attempts.length - missingUsage, { missing: missingUsage }),
    tokens_out: v(usage_complete ? sum("output_tokens") : null, attempts.length - missingUsage, { missing: missingUsage }),
    usage_complete,
    usd: v(usd, attempts.length - missingCost, { missing: missingCost,
      basis: usd === null ? (run.resources?.usd_basis ?? "unknown: not every attempt states its cost") : "every attempt states its cost" }),
    elapsed_ms: v(elapsed, elapsed === null ? 0 : 1),
    coordination_overhead: v(attempts.length ? coordinationCalls / attempts.length : null, attempts.length, { calls: coordinationCalls }),
    coordination: { scout_turns: turns.filter(t => t.purpose === "scout").length, review_turns: turns.filter(t => t.purpose === "critique").length, cycle_review: review },
    operating_points: turns.map(t => ({ purpose: t.purpose ?? null, vendor: t.vendor ?? null, model: t.settings?.model ?? t.model ?? null,
      effort: t.settings ? t.settings.effort ?? null : t.selection?.effort?.value ?? null, effort_basis: t.settings?.basis ?? (t.selection?.effort ? "selected" : null),
      class: t.selection?.class?.value ?? null, rank: Number.isInteger(t.selection?.rank) ? t.selection.rank : null })),
    calls_per_accept: accepted ? attempts.length : null,
    tokens_per_accept: accepted ? tokens : null,
  };
}

/** Wilson score interval (95%) for k successes in n trials; null when n is 0. */
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function median(xs) {
  const s = xs.filter(x => num(x) !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const rate = (rows, key) => {
  const decided = rows.filter(r => r[key] !== null && r[key] !== undefined);
  const k = decided.filter(r => r[key] === true).length;
  return { count: k, n: decided.length, rate: decided.length ? k / decided.length : null, wilson95: wilson(k, decided.length) };
};
const med = xs => { const vals = xs.filter(x => num(x) !== null); return { value: median(vals), n: vals.length }; };

function stratum(rows, minN) {
  const accepted = rows.filter(r => r.accepted === true);
  const sumKnown = k => rows.reduce((n, r) => n + (num(r[k]?.value) ?? 0), 0);
  const by_outcome = {}, by_action = {};
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.by_outcome ?? {})) by_outcome[k] = (by_outcome[k] ?? 0) + n;
    for (const [k, n] of Object.entries(r.escalations?.by_action ?? {})) by_action[k] = (by_action[k] ?? 0) + n;
  }
  const n = rows.length;
  return {
    n,
    status: Object.fromEntries(["accepted", "not_accepted", "failed", "inconclusive"].map(s => [s, rows.filter(r => r.status === s).length])),
    accepted: rate(rows, "accepted"),
    first_pass: rate(rows, "first_pass"),
    provider_calls: { value: sumKnown("provider_calls"), n: rows.filter(r => r.provider_calls?.value !== null).length },
    by_outcome, escalations: by_action,
    fallbacks: { value: sumKnown("fallbacks"), n: rows.filter(r => r.fallbacks?.value !== null).length },
    retries: { value: sumKnown("retries"), n: rows.filter(r => r.retries?.value !== null).length },
    review_rejections: { value: sumKnown("review_rejections"), n: rows.filter(r => r.review_rejections?.value !== null).length },
    usage_complete: rows.every(r => r.usage_complete === true),
    tokens_in: rows.every(r => r.tokens_in?.value !== null) ? { value: sumKnown("tokens_in"), n } : { value: null, n: rows.filter(r => r.tokens_in?.value !== null).length, missing: rows.filter(r => r.tokens_in?.value === null).length },
    tokens_out: rows.every(r => r.tokens_out?.value !== null) ? { value: sumKnown("tokens_out"), n } : { value: null, n: rows.filter(r => r.tokens_out?.value !== null).length, missing: rows.filter(r => r.tokens_out?.value === null).length },
    usd: rows.length && rows.every(r => r.usd?.value !== null) ? { value: sumKnown("usd"), n } : { value: null, n: rows.filter(r => r.usd?.value !== null).length, missing: rows.filter(r => r.usd?.value === null).length },
    median_calls_per_accept: med(accepted.map(r => r.calls_per_accept)),
    median_tokens_per_accept: med(accepted.map(r => r.tokens_per_accept)),
    median_elapsed_ms_per_accept: med(accepted.map(r => r.elapsed_ms?.value)),
    median_coordination_overhead: med(rows.map(r => r.coordination_overhead?.value)),
    insufficient: n < minN, min_n: minN, needed: Math.max(0, minN - n),
  };
}

/** Per profile, per stakes stratum and `all`. */
export function aggregate(rows, { minN = MIN_N_PER_STRATUM } = {}) {
  const out = {};
  for (const profile of [...new Set(rows.map(r => r.profile ?? "unknown"))]) {
    const mine = rows.filter(r => (r.profile ?? "unknown") === profile);
    const strata = {};
    for (const s of [...new Set(mine.map(r => r.stakes?.value ?? "unknown"))]) strata[s] = stratum(mine.filter(r => (r.stakes?.value ?? "unknown") === s), minN);
    out[profile] = { all: stratum(mine, minN), strata };
  }
  return out;
}
````

## File: pantheon/src/practice/compare.mjs
````
// The mechanics of a matched practice comparison (docs/reviews/2026-11-16-routing-coordination/CYCLE_CONTRACT.md
// step 6; docs/routing-task-profile.md, "Adoption path"): the same tickets run under a baseline routing
// profile and a candidate profile, with the same declared resource bounds, and everything each run
// actually recorded (run.json `attempts`, `resources`, turn `usage` and `settings`; audit M5) reduced to
// one comparison record.
//
//   compareProfiles({tickets, baseline: 'argo', candidate: 'fit', bounds, runner, providers, question})
//     -> {schema: pantheon.compare/v1, synthetic, providers, question, profiles, bounds, tickets, results,
//         aggregate, interpretation, at, digest}
//
// Per ticket and per profile, one runMetrics row (metrics.mjs, the definitions shared with continuous
// evaluation): accepted (shipped through the controller's gates, the REVIEW gate included), first pass,
// revisions, review rejections, provider calls by outcome, tokens (null unless usage is complete), USD
// (null unless every attempt states a cost, never 0), elapsed time, escalations, retries and fallbacks,
// coordination overhead and per-turn operating points; the aggregate is metrics.aggregate (per stakes
// stratum, Wilson intervals, `insufficient` below MIN_N_PER_STRATUM). A
// failed or inconclusive ticket is a row like any other; nothing is dropped. Reviewer agreement is
// reported as agreement: nothing here is called correct.
//
// The record is evidence a practice disposition cites ({kind: digest, schema, sha, synthetic};
// comparisonEvidence). `synthetic` is true unless the providers were declared `kind: live`, so a run on
// fake providers can never be read as a live measurement, and the ledger refuses a promote resting on
// synthetic evidence alone (practice-kinds.mjs evidenceBasis). This module draws no conclusion
// (`interpretation.verdict` is null): an independent reviewer interprets the record (step 7).
//
// It runs nothing on its own: `runner` does (dispatchRunner wraps runOpenItem), with the providers the
// caller supplies. It never reads a key and never spends beyond the runner's declared bounds.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../../../packages/ledger/canonical.mjs";
import { COMPARE_SCHEMA, currentPolicy } from "../ledger/practice-kinds.mjs";
import { runOpenItem } from "../board/run-item.mjs";
import { certifiedArtifacts } from "../board/artifacts.mjs";
import { cycleReviewers } from "../board/operate.mjs";
import { openPantheonLedger } from "../ledger/system.mjs";
import { reviewCycle } from "../ledger/review-cycle.mjs";
import { labOf } from "../config/models.mjs";
import { runMetrics, unobservedRun, aggregate, stakesOf, MIN_N_PER_STRATUM } from "./metrics.mjs";

export { COMPARE_SCHEMA };
export const PROFILES = Object.freeze(["argo", "legacy", "fit"]);

const sha = v => "sha256:" + createHash("sha256").update(v).digest("hex");
const AGREEMENT = "reviewer agreement, not correctness";

const INTERPRETATION = synthetic => ({
  accepted: "accepted = shipped by the controller through every ship gate, the executed acceptance (TESTS) and the in-run cross-lab review (REVIEW) included. " +
    `A review verdict, and a cycle review's approvals, are ${AGREEMENT}.`,
  first_pass: "first_pass = accepted on the first revision (no rework); revisions_to_accept is reported only for accepted runs.",
  usage: "tokens are summed only when every attempt reported usage; otherwise they are null and `missing` counts the attempts without it.",
  usd: "usd is null unless every attempt states its cost: no versioned price source is attached. Unknown is never 0, and a provider-call allowance is not a bill.",
  elapsed: "elapsed_ms is the run's own started_at -> finished_at, on this machine and these providers.",
  fallbacks: "a fallback is a turn answered by a candidate of rank > 0; a retry is a failed attempt followed by the same seat.",
  coordination: "coordination_overhead is the share of provider calls that are not implementation (plan, critique, scout); cycle-review turns are reported beside it.",
  strata: `rates carry Wilson 95% intervals and are stratified by stakes; a stratum with fewer than ${MIN_N_PER_STRATUM} runs per arm is marked insufficient.`,
  synthetic: synthetic
    ? "SYNTHETIC: the providers are fakes. This record verifies the comparison mechanics only; it measures no provider cost or quality, and a promote may not rest on it."
    : "LIVE: declared live providers. A scoped measurement for the tickets and bounds named here only; an independent reviewer interprets it before any disposition.",
  verdict: null,
});

function normalizeBounds(bounds) {
  const b = bounds ?? {};
  if (!(Number.isSafeInteger(b.maxProviderCalls) && b.maxProviderCalls > 0)) throw new Error("compareProfiles: bounds.maxProviderCalls is a declared positive integer, the same for both profiles");
  const revisions = b.revisions ?? 3;
  if (!(Number.isSafeInteger(revisions) && revisions > 0)) throw new Error("compareProfiles: bounds.revisions is a positive integer");
  const out = { maxProviderCalls: b.maxProviderCalls, revisions };
  if (b.cycle_review) out.cycle_review = { n: b.cycle_review.n, max_attempts: b.cycle_review.max_attempts };
  return out;
}

/** The record's digest: sha256 over its canonical form without the `digest` field. */
export const comparisonDigest = record => { const { digest: _, ...rest } = record; return sha(canonical(rest)); };
/** Does the record's digest re-derive, and is it a comparison record? */
export function verifyComparison(record) {
  if (record?.schema !== COMPARE_SCHEMA) return { ok: false, why: `not a ${COMPARE_SCHEMA} record` };
  if (typeof record.synthetic !== "boolean") return { ok: false, why: "the record does not say whether it is synthetic" };
  if (record.synthetic !== (record.providers?.kind !== "live")) return { ok: false, why: "synthetic is true unless the providers are declared live" };
  const d = comparisonDigest(record);
  return d === record.digest ? { ok: true, digest: d } : { ok: false, why: `the digest does not re-derive (${d.slice(0, 19)} vs ${String(record.digest).slice(0, 19)})` };
}
/** The citation a practice disposition carries for this record. */
export const comparisonEvidence = record => ({ kind: "digest", schema: COMPARE_SCHEMA, sha: record.digest, synthetic: record.synthetic });

/**
 * Run every ticket under `baseline` then `candidate` (interleaved, per ticket), with the same `bounds`,
 * through `runner({spec, profile, bounds, arm})` -> {run, result, cycle_review?}. `providers` declares
 * what answered: {kind: 'fake'|'live'|..., ...identity}; only `kind: 'live'` makes the record non-synthetic.
 */
export async function compareProfiles({ tickets, baseline = "argo", candidate = "fit", bounds, runner, providers, question = null,
  clock = () => Date.now(), at = new Date().toISOString(), pools = [] } = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) throw new Error("compareProfiles: pass the tickets to compare");
  if (typeof runner !== "function") throw new Error("compareProfiles: pass runner({spec, profile, bounds}) -> {run, result}");
  if (!providers || typeof providers.kind !== "string") throw new Error("compareProfiles: declare the providers ({kind: 'fake'|'live', ...identity}); a record names what answered");
  for (const p of [baseline, candidate]) if (!PROFILES.includes(p)) throw new Error(`compareProfiles: profile is one of ${PROFILES.join(", ")}`);
  if (baseline === candidate) throw new Error("compareProfiles: the baseline and candidate profiles must differ");
  const B = normalizeBounds(bounds);
  const synthetic = providers.kind !== "live";
  const specs = tickets.map(t => {
    const spec = t.spec ?? t;
    if (!spec || typeof spec.key !== "string") throw new Error("compareProfiles: every ticket has a key");
    return { spec, digest: t.digest ?? sha(canonical(spec)) };
  });
  if (new Set(specs.map(s => s.spec.key)).size !== specs.length) throw new Error("compareProfiles: ticket keys are distinct");
  const results = [];
  for (const { spec } of specs) {
    const row = { ticket: spec.key };
    for (const [arm, profile] of [["baseline", baseline], ["candidate", candidate]]) {
      const t0 = clock();
      let out = null, error = null;
      try { out = await runner({ spec, profile, bounds: structuredClone(B), arm }); } catch (e) { error = e; }
      const wall_ms = Math.max(0, clock() - t0);
      row[arm] = error || !out?.run
        ? { ...unobservedRun({ profile, why: error?.message ?? out?.result?.error?.message ?? "the runner returned no run record", review: out?.cycle_review ?? null,
          stakes: stakesOf(null, spec) }), wall_ms }
        : { ...runMetrics(out.run, { review: out.cycle_review ?? null, ticket: spec, result: out.result ?? null, profile }), wall_ms };
    }
    results.push(row);
  }
  const record = {
    schema: COMPARE_SCHEMA, synthetic, providers, question,
    profiles: { baseline: { profile: baseline, policy: currentPolicy(baseline, { pools }) }, candidate: { profile: candidate, policy: currentPolicy(candidate, { pools }) } },
    bounds: B, order: "per ticket, baseline then candidate",
    tickets: specs.map(s => ({ key: s.spec.key, digest: s.digest })),
    results,
    aggregate: (g => ({ baseline: g[baseline], candidate: g[candidate] }))(aggregate(results.flatMap(r => [r.baseline, r.candidate]))),
    interpretation: INTERPRETATION(synthetic),
    at,
  };
  return { ...record, digest: comparisonDigest(record) };
}

// ---------------------------------------------------------------- the dispatcher runner

const labsOf = turns => [...new Set(turns.map(t => labOf(t.vendor, t.served_model ?? t.model)).filter(Boolean))];
const hex40 = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 40);

/** An independent review cycle over a shipped run's certified artifacts, on a ledger of its own. */
async function cycleReviewOf({ run, result, spec, profile, turn, n, root }) {
  let files;
  try { files = certifiedArtifacts(run, { repoRoot: spec.repo_root, outDir: result.outDir }); }
  catch (e) { return { ran: false, why: `no certified artifacts to review: ${e.message}`, turns: 0, note: AGREEMENT }; }
  const diff = files.map(f => {
    const text = f.exported === null || f.exported === undefined ? "" : String(f.exported);
    return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ shipped contents @@\n` + text.split("\n").map(l => `+${l}`).join("\n") + "\n";
  }).join("");
  const turns = run.turns ?? [];
  const chosen = cycleReviewers({ planLabs: labsOf(turns.filter(t => t.purpose === "plan")), workLabs: labsOf(turns.filter(t => t.purpose === "work")), n });
  mkdirSync(root, { recursive: true });
  const rec = openPantheonLedger({ root }).recorder();
  const r = await reviewCycle({ ledger: rec, change: { scope: `compare/${spec.key}/${profile}`, base: hex40(canonical(run.files?.map(f => f.baseline) ?? [])),
    head: hex40(run.certificate?.commit ?? ""), diff, files: files.map(f => f.path), author_labs: chosen.author_labs },
  seats: chosen.seats, turn, n, max_attempts: 1, policy: currentPolicy(profile) });
  return { ran: true, cycle: r.cycle, ledger: root, labs: r.reviews.map(x => x.lab), verdicts: r.reviews.map(x => x.verdict), reviews: r.reviews.length, failed: r.failed.length,
    approvals: r.reviews.filter(x => x.verdict === "approve").length, findings: r.reviews.reduce((k, x) => k + x.findings.length, 0),
    turns: r.reviews.length + r.failed.length, note: AGREEMENT };
}

/**
 * A runner over the real dispatcher: runOpenItem(spec, {profile, maxProviderCalls, revisions, makeClientFor})
 * on a board of its own under `dir`, then run.json read back. With `cycleTurn`, a shipped run also gets an
 * independent review cycle (n labs, none of the authors', one attempt each) whose turns count as
 * coordination overhead; its approvals are agreement, not correctness. The run key is suffixed with the
 * profile so the two runs of one ticket never share an output directory; the ticket is otherwise the same.
 */
export function dispatchRunner({ makeClientFor, dir, runOpts = {}, cycleTurn = null, n = 3 }) {
  if (typeof makeClientFor !== "function") throw new Error("dispatchRunner: pass makeClientFor(vendor)");
  if (!dir) throw new Error("dispatchRunner: pass a working directory");
  return async ({ spec, profile, bounds }) => {
    const key = `${spec.key}.${profile}`;
    const board = join(dir, key);
    const result = await runOpenItem({ ...spec, key }, { ...runOpts, dir: board, makeClientFor, profile,
      maxProviderCalls: bounds.maxProviderCalls, revisions: bounds.revisions });
    const file = join(board, "run.json");
    const run = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const cycle_review = cycleTurn && run && result.shipped
      ? await cycleReviewOf({ run, result, spec: { ...spec, key }, profile, turn: cycleTurn, n, root: join(board, "compare-cycle-ledger") })
      : cycleTurn ? { ran: false, why: "not shipped: nothing to review", turns: 0, note: AGREEMENT } : null;
    return { run, result, cycle_review };
  };
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
// SYNTHETIC EVIDENCE (CYCLE_CONTRACT acceptance: "A synthetic matched comparison verifies the mechanics; a
// scoped live comparison is needed before claiming measured provider cost/quality improvement"). A matched
// comparison record (pantheon/src/practice/compare.mjs, schema COMPARE_SCHEMA) is cited as {kind: digest,
// schema: COMPARE_SCHEMA, sha, synthetic}, and such a digest must say whether it is synthetic. A
// disposition whose comparison evidence is only synthetic (a synthetic digest, or a disposition resting on
// one) may propose a measurement, but a promote resting on it is refused: a promote that cites synthetic
// evidence also cites a live (synthetic: false) comparison. Additive: an entry with no comparison digest,
// as every entry written before this rule, re-derives exactly as it did. The flag is what the record
// declares; whether a live record really was live is for the independent reviewer of the evidence.
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
/** A matched-comparison record's schema (pantheon/src/practice/compare.mjs), as a digest citation names it. */
export const COMPARE_SCHEMA = 'pantheon.compare/v1';
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
    && (e.schema !== COMPARE_SCHEMA || typeof e.synthetic === 'boolean')
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
  if (!Array.isArray(p.evidence) || p.evidence.length > 32 || !p.evidence.every(validEvidence)) return `evidence is a list of {kind: ledger, hash} | {kind: digest, schema, sha} | {kind: document, path, sha}; a ${COMPARE_SCHEMA} digest says whether it is synthetic (synthetic: true|false)`;
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
  if (p.outcome === 'promote' && evidenceBasis(view, p.evidence) === 'synthetic') {
    return 'a promote may not rest on synthetic evidence: a synthetic comparison verifies the mechanics only; cite a live (synthetic: false) comparison';
  }
  const ledgerRefs = p.evidence.filter(x => x.kind === 'ledger').map(x => x.hash);
  if (new Set(ledgerRefs).size !== ledgerRefs.length || canonical(cited) !== canonical(ledgerRefs)) {
    return 'a practice disposition cites its cycle, the proposal it decides, and exactly its ledger evidence, in that order';
  }
  return null;
}

/**
 * What a disposition's evidence rests on, as far as comparisons go: `synthetic` when it cites synthetic
 * comparison evidence and no live comparison, `live` when it cites a live comparison, `none` otherwise.
 * A digest declares its own flag; a cited practice disposition contributes what its own evidence rests on;
 * any other entry or document is neither. Pure over the view.
 */
export function evidenceBasis(view, evidence, seen = new Set()) {
  let synthetic = false, live = false;
  for (const e of evidence ?? []) {
    if (e?.kind === 'digest' && typeof e.synthetic === 'boolean') { if (e.synthetic) synthetic = true; else live = true; }
    else if (e?.kind === 'ledger' && !seen.has(e.hash) && view.entry(e.hash)?.kind === PRACTICE) {
      seen.add(e.hash);
      const b = evidenceBasis(view, view.payload(e.hash)?.evidence, seen);
      if (b === 'synthetic') synthetic = true; else if (b === 'live') live = true;
    }
  }
  return live ? 'live' : synthetic ? 'synthetic' : 'none';
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

## Excerpt: pantheon/src/route/frontier.mjs (fit selection)
````
export function registryModels(){
  const api=Object.entries(models).flatMap(([vendor,names])=>Object.values(names).map(model=>({vendor:VENDOR_OF_REGISTRY(vendor),model,source:'registry'})));
  const lanes=Object.entries(LANES).flatMap(([lane,names])=>Object.entries(names).map(([model,l])=>({vendor:l.vendor,model,source:`lane:${lane}`})));
  return [...api,...lanes];
}
function roleTables(){
  const t={};
  const add=(role,vendor,model)=>{(t[role]??=[]).push({vendor,model});};
  for(const [role,rows] of Object.entries(seats))for(const [v,n] of rows)add(role,VENDOR_OF_REGISTRY(v),modelId(v,n));
  for(const [role,rows] of Object.entries({...SEATING,...INTAKE}))for(const c of rows)add(role,c.vendor,modelOf(c));
  return t;
}
const EXPLORER_BENCH=Object.freeze({scout:'scout@opt'});
/** The labs a role's tables allow, in declared order (first appearance across its tables, ARGO first). */
export function roleLabs(role){
export function roleLabs(role){
  const bench=EXPLORER_BENCH[role]?ROSTER[EXPLORER_BENCH[role]].candidates.map(v=>labOf(v)):[];
  return [...new Set([...(roleTables()[role]??[]).map(c=>labOf(c.vendor,c.model)),...bench])];
}
function fitCandidates(role,{needsContext,avoid,avoidLabs,base,reserve=null}){
  const task=base.task;
  const labs=roleLabs(role);
  const tableOrder=[...new Set((roleTables()[role]??[]).map(c=>c.model))];
  const excluded=[];
  const floor=classFloor(task,role,CLASSES.order);
  const floorRank=CLASSES.order.indexOf(floor.value);
  const climb=LATENCY_CLIMB[task.latency.value];
  const pool=registryModels().filter(c=>labs.includes(labOf(c.vendor,c.model))).map(c=>({...c,lab:labOf(c.vendor,c.model),
    eligibility:tableOrder.includes(c.model)?'role-table':`lab-allowed:${labOf(c.vendor,c.model)}`}));
  const admitted=pool.filter(c=>{
    const cls=CLASSES.models[c.model]?.class;
    if(classRank(c.model)===-1){excluded.push({model:c.model,why:'no class in classes.json'});return false;}
    if(avoid.includes(c.vendor)){excluded.push({model:c.model,why:`vendor ${c.vendor} is avoided`});return false;}
    if(avoidLabs.includes(c.lab)){excluded.push({model:c.model,why:`the ${c.lab} lab is avoided (independence)`});return false;}
    if(reserve?.labs?.includes(c.lab)){excluded.push({model:c.model,why:`the ${c.lab} lab is reserved for review: ${reserve.review_labs} independent review labs are required and a producer there would leave too few`});return false;}
    const w=windowOf(c.model);
    if(needsContext!==null&&w===null){excluded.push({model:c.model,why:`window unrecorded; cannot admit an estimated ${needsContext}`});return false;}
    if(needsContext!==null&&w<needsContext){excluded.push({model:c.model,why:`documented window ${w} < estimated ${needsContext}`});return false;}
    if(classRank(c.model)<floorRank){excluded.push({model:c.model,why:`class ${cls} is below the floor ${floor.value}`});return false;}
    if(classRank(c.model)>floorRank+climb){excluded.push({model:c.model,why:`class ${cls} is more than ${climb} above the floor ${floor.value} (latency ${task.latency.value})`});return false;}
    return true;
  });
  // Class ascending from the floor; inside a class, round-robin over the labs in declared order, each lab's
  // role-table models first (in table order), then its other registry models (in registry order).
  const within=(a,b)=>{
    const ia=tableOrder.indexOf(a.model),ib=tableOrder.indexOf(b.model);
    return (ia===-1?1:0)-(ib===-1?1:0)||(ia!==-1&&ib!==-1?ia-ib:0);
  };
  const ordered=[];
  for(const rank of [...new Set(admitted.map(c=>classRank(c.model)))].sort((a,b)=>a-b)){
    const byLab=labs.map(lab=>admitted.filter(c=>c.lab===lab&&classRank(c.model)===rank).sort(within));
    for(let i=0;byLab.some(l=>l[i]);i++)for(const l of byLab)if(l[i])ordered.push(l[i]);
  }
  const requirements=requirementsOf(task);
  const kind={value:task.kind.value,basis:task.kind.basis,filter:'unfiltered',
    why:'no cited capability fact separates code/analysis/prose/review ability among these models (capability-facts.json)'};
  const output={value:task.output.value,basis:task.output.basis};
  return ordered.map((c,i)=>{
    const effort=effortForDepth(task.depth.value,c);
    const cls=CLASSES.models[c.model];
    return [{vendor:c.vendor,model:c.model,basis:cls.basis,band:null,effort:effort.value,why:`fit: ${cls.class} class (${cls.basis}, ${cls.status})`},
      {...base,source:'policy',band:null,excluded,class_floor:floor,class:{value:cls.class,model:c.model,basis:cls.basis,status:cls.status},
        eligibility:c.eligibility,effort,output,requirements,kind,...(reserve?{reserved_review_labs:reserve.review_labs,reserved_labs:reserve.labs}:{}),latency:{value:task.latency.value,basis:task.latency.basis,climb},lab_order:labs,
        reason:(i?`admitted fallback ${i}: `:'')+`fit profile (provisional, unmeasured): lowest admitted class >= floor ${floor.value} (${floor.why}); `+
          `${c.model} is ${cls.class} (${cls.basis}) from the ${c.lab} lab (${c.eligibility}); effort ${effort.mapped}`}];
  });
}
````

## Excerpt: pantheon/src/board/run-item.mjs (intake width, producer reservation, review panel)
````
  function reviewReserve(producerLabs = []) {
    const need = TASK ? requirementsOf(TASK).review_labs.value : 1;
    if (need < 2) return null;
    const labsOf = ls => [...new Set(ls.filter(Boolean))];
    const universe = labsOf(registryModels().map(c => labOf(c.vendor, c.model)));
    const left = used => labsReachable("reviewer", { avoid: used.flatMap(l => vendorsOfLab(l)), avoidLabs: used }).length;
    const labs = universe.filter(l => left(labsOf([...producerLabs, l])) < need);
    // Every lab reserved: the producers already seated (an operator's explicit seat is never moved) leave no seat
    // for this producer that keeps the panel possible. Refuse now, by name, before any generation is spent.
    if (labs.length === universe.length) throw Object.assign(new Error(`REVIEW_LABS_UNAVAILABLE: ${need} independent review labs ` +
      `(stakes ${TASK.stakes.value}) are required, and with ${labsOf(producerLabs).join(", ") || "no lab"} already producing, no producer ` +
      `lab leaves that many reviewer labs eligible (law 3 avoids every producer's lab); refusing rather than running fewer`),
      { code: "REVIEW_LABS_UNAVAILABLE" });
    return labs.length ? { labs, review_labs: need } : null;
  }
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
      const avoid = reviewerAvoid(built.seat);
      const avoidLabs = [...new Set([labOf(built.seat.vendor, built.ranModel ?? built.seat.model ?? built.model ?? null), labOf(plannerVendor, plannerModel)])];
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
      try { reviewChoice = choose("reviewer", { avoid: [...avoid, ...usedVendors], avoidLabs: [...avoidLabs, ...usedLabs], chars: reviewChars,
        ...(k ? { roleOverride: null } : {}) }); }
      catch (e) {
        if (k) throw panelRefusal(built, `reviewer ${k + 1} has no candidate after avoiding labs ${[...avoidLabs, ...usedLabs].join(", ")}: ${e.message}`);
        throw new Error(`no clean reviewer: no reviewer candidate left after avoiding ${avoid.join(", ")} (labs ${avoidLabs.join(", ")}): ${e.message}`);
      }
      const pairing = { reviewer: reviewChoice.seat.vendor, why: reviewChoice.selection.reason };
      assertReviewCutsAcross({ assigner: { vendor: plannerVendor, model: plannerModel }, producer: { vendor: built.seat.vendor }, reviewer: { vendor: pairing.reviewer } });
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
      const reviewed = await roleTurn({ role: "reviewer", purpose: "critique", prompt: p.prompt, choice: reviewChoice, extra: { tokens: 4000 } });
      // Law 3 on the reviewer that actually answered, not the one paired in advance.
      assertLaw({ kind: "review", producer: built.seat, checker: reviewed.seat, assigner: { vendor: plannerVendor, model: plannerModel } });
      const reviewedLab = labOf(reviewed.seat.vendor, reviewed.seat.model ?? null);
      if (usedLabs.includes(reviewedLab) || usedVendors.includes(reviewed.seat.vendor)) {
        throw panelRefusal(built, `reviewer ${k + 1} answered from ${reviewed.seat.vendor}/${reviewed.seat.model}, a lab already on the panel`);
      }
      if (reviewed.seat.vendor !== seat.vendor) {
        assertReviewCutsAcross({ assigner: { vendor: plannerVendor, model: plannerModel }, producer: built.seat, reviewer: reviewed.seat });
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
          verdict: memberVerdict, findings: memberFindings.map(f => f.note).join("\n"), targets: [workTurn.hash] });
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
        const rec = escalationRecord({ role: "implementer", outcome: { kind: "critique", verdict }, steps: built.escalationSteps ?? 0,
          seat: { vendor: built.seat.vendor, model: built.ranModel ?? built.seat.model ?? null, effort: built.effort ?? null, output: null } });
        const { action } = rec.decision;
````
