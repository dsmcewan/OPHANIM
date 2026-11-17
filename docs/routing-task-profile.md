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

## Continuous evaluation

The owner asked for routing to be evaluated continuously, from the current state, on the work that runs anyway (design: `docs/reviews/2026-11-17-routing-evaluation/DESIGN.md`). It adds no provider spend beyond the work itself. Nothing below runs an extra provider call: the shadow is a second pure selection, the assignment is a hash, and the evaluator reads files.

Code: `pantheon/src/practice/shadow.mjs`, `assign.mjs` and `evaluate.mjs`. The wiring is in `pantheon/src/board/run-item.mjs` (dispatch) and `pantheon/src/board/operate.mjs` (board runs and cycle close). Tests: `pantheon/tests/practice-continuous.test.mjs`.

### What is recorded

- **Shadow selection, on every dispatch.** For every role choice, the dispatcher also computes what the other profile would choose from the same inputs: `argo` and `fit` shadow each other, and `legacy` is shadowed by `fit`. Each turn's selection records it as `shadow: {profile, vendor, model, effort, class?, policy_hash}` and `agrees` (same vendor and model as the seat that answered). If the other profile admits no seat, `shadow` carries an `error` and `agrees` is null. The shadow is never sent to a provider. The primary choice is unchanged: the same candidates, the same order and the same policy hash, and the `argo` and `legacy` hashes stay pinned.
- **Interleaved assignment (opt-in).** `runOpenItem(spec, {interleave: true})` or `pantheon-board run <item> --interleave` hashes the ticket key (sha256, 50/50) to choose an arm:
  - Only eligible stakes strata are interleaved: `low` and `normal` (`DEFAULT_ELIGIBLE_STRATA`).
  - `high`, `critical` and unknown stakes stay on `argo`, with basis `stratum not eligible`.
  - A stratum the stop rule has halted stays on `argo`, with basis `stratum halted by the stop rule`. A board run reads the halted strata from the evidence store before it dispatches.
  - An explicit `--profile` wins. It is recorded with basis `explicit profile` and `randomized: false`.

  `run.json` records `assignment: {arm, basis, stakes, randomized, ...}` and the `profile` it ran. Every turn's selection records `assignment: {arm, basis, randomized}`.
- **What answered.** `run.json` records `providers: {kind}`. `live` comes from the CLI's SDK clients. `fake` comes from the test fixtures. A caller can declare it with the `providers` option or on `makeClientFor.providers`. A run that declares nothing is `undeclared`, and the evaluator counts it as synthetic.
- **The evidence store.** `pantheon-board run` copies every run's `run.json` (shipped or not) to `<store>/<board>/run.json`. The store is `--evidence-store DIR`, else `PANTHEON_EVIDENCE_STORE`, else `<OPHANIM_LEDGER>/../runs`. With no shared ledger, it is `<board>/runs`, which holds only that board's run. To accumulate evidence across runs, set `OPHANIM_LEDGER` or the store.

### The rules

`evaluate({runs})` reads a store directory, a run.json path, a run object, or a list of these. Only runs with a randomized assignment are evidence. Every other run is listed under `excluded` with the reason: an arm somebody chose is not a randomized arm. Each included run becomes one `runMetrics` row (`metrics.mjs`, the same definitions as the matched comparison). The rows are aggregated per arm and per stakes stratum, taken from the assignment.

For each stratum, with differences taken as fit minus argo:

1. **Stop rule.** After at least `STOP_MIN_N` = 10 decided runs per arm, if the upper bound of the accepted difference is at or below `-STOP_MARGIN` (-0.10), the stratum is halted. Its outcome is `retain`, and assignment stops interleaving it.
2. **`insufficient_evidence`** until there are `MIN_N` = 20 (`MIN_N_PER_STRATUM`) decided runs per arm.
3. **`propose_policy`** only if all of the following hold:
   - `fit` is non-inferior on accepted and on first-pass: the lower bound of each difference is at or above `-NONINFERIORITY_MARGIN` (-0.05).
   - Its median calls, tokens or elapsed time per accepted run is lower on at least one of the three.
   - It is worse on none of them by more than `COST_WORSE_MARGIN` (calls 10%, tokens 10%, elapsed 25%, relative to argo).

   A median counts only when every accepted run of both arms has the value. Tokens without complete usage are therefore `unknown`, which is never cheaper and never worse. Unknown usage cannot make an arm look cheaper.
4. **`retain`** otherwise.

The intervals are Newcombe's hybrid score interval for a difference of proportions, built from Wilson bounds.

**Repeated looks.** The rule runs at every cycle close, on a growing sample. At 95%, repeated looks would find a difference by chance well over 5% of the time. So both decisions that change something, the stop rule and a proposal, use 99% intervals (`STOP_CONFIDENCE`, `PROMOTION_CONFIDENCE`). This is a simple conservative alpha for each look, not a formal alpha-spending boundary. The cost is stated plainly: at 99%, even when both arms accept every ticket, non-inferiority within 5 points needs about 126 decided runs per arm. `MIN_N` is a floor below which nothing is claimed. It is not the sample size that decides.

The thresholds are named, exported and provisional: `MIN_N`, `NONINFERIORITY_MARGIN`, `STOP_MARGIN`, `STOP_MIN_N`, `PROMOTION_CONFIDENCE`, `STOP_CONFIDENCE`, `COST_WORSE_MARGIN` and `DEFAULT_ELIGIBLE_STRATA`.

The overall outcome follows from the strata. It is `propose_policy` if any stratum proposes. Otherwise it is `retain` if any stratum retains, halts included. Otherwise it is `insufficient_evidence`. A record is `synthetic` if any included run did not declare live providers. The shadow selections of every run, excluded runs included, are summarised as a disagreement map. That map says nothing about quality.

### Every cycle close gets an assessment

A cycle opened under `pantheon.cycle/v2` cannot close without a practice assessment (C3). When such a cycle is waiting on nothing but its assessment, and none was stated (`--practice-outcome`), the controller records one from `evaluate` over the evidence store:

- The evaluation record goes to `<store>/evaluations/<digest>.json`. It is cited as `{kind: digest, schema: pantheon.evaluation/v1, sha, synthetic}`, and the ledger now requires that flag on such a digest.
- The disposition is `measured: true` only when the deciding strata have n at or above `MIN_N`. Otherwise it is `provisional`.
- Halts are part of the record and the question, and they are recorded as `retain`.
- A stated assessment always wins.
- A cycle that cannot close for another reason, such as a missing review or an open finding, gets nothing yet.

The automatic assessment never records `promote`. A promote is a candidate disposition by an independent seat of another lab than the proposer's. The ledger also refuses a promote that rests on synthetic evidence. So the strongest automatic outcome is `propose_policy`. It names `fit` as the candidate and `FIT_PROPOSER` (the anthropic seat that authored `fit`, configurable) as the proposer, so an anthropic seat can never promote it.

On a cycle whose policy in effect is `fit` itself (a fit-arm run), neither `propose_policy` nor `retain` can say what was found. So the assessment is recorded as `propose_measurement`, with the evaluation's own outcome in the question and in the cited record.

### Reading it

```sh
node pantheon/bin/pantheon-board.mjs evaluate [--runs DIR] [--json]
```

This prints each stratum's outcome, n per arm, accepted and first-pass rates, the difference interval, costs per accepted run, the halted strata and the shadow summary. It reads files only.

Not done:

- No live run has accumulated in a store from this checkout. Every record made here is synthetic.
- Only `argo` and `fit` are interleaved. `legacy` is shadowed, never assigned.
