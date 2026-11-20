# Routing candidate `fit`: a task profile with independent dimensions

Status: **unmeasured.** Since 2026-11-17 `fit` is the lifecycle's default routing profile on the owner's direction (see [The fit matrix](#the-fit-matrix-and-antigravity-first-gemini-owner-direction-2026-11-17)); `argo` is still the default of `selectSeat` and `runOpenItem` called on their own. `fit` is selectable for one run (`runOpenItem(spec, { profile: "fit" })`, `pantheon-board run <item> --profile fit`). Nothing below claims that `fit` routes better. Its tables are routing judgments. Until the comparison in [Adoption path](#adoption-path) is done, it stays provisional (CYCLE_CONTRACT steps 4, 6 and 7).

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
  - Producers are chosen on their own merits and are never moved to make a panel possible (owner control contract, "Functional roles and valid worker escalation"). Law 3 bars a reviewer from the maker's and the planner's labs, and the configured in-run reviewer role allows xai, google and anthropic. That is this configuration's pool, not a count of possible reviewers. Once the crew is seated and before any work call, the run checks whether that pool can still supply `review_labs` independent labs for each slot. If it cannot, the run stops with `REVIEW_CAPACITY_PENDING`, naming the slot, the producers' labs and what the pool offered; the plan is kept and no work generation is spent. The operator may reseat a producer explicitly or qualify another reviewer pool through the usual evidence process.
  - With fit's default seats (planner anthropic, maker openai) a critical ticket is therefore pending today. A replaced earlier rule (f96531a) moved both producers onto openai to keep three reviewers; the owner's audit (docs/reviews/2026-11-16-workflow-handoffs/CURRENT_STATE.md, RS1-RS3) and control contract reject that.
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

The owner asked for routing to be evaluated continuously, from the current state, on the work that runs anyway (design: `docs/reviews/2026-11-17-routing-evaluation/DESIGN.md`). With pairing off (the default), it adds no provider spend beyond the work itself: the shadow is a second pure selection, the assignment is a hash, and the evaluator reads files. Paired runs (below, owner decision 2026-11-17) are the one exception, and only when the owner sets a pair rate: their extra provider calls are bounded by the total `pairBudgetCalls` the owner sets, and each counterpart by `pairMaxProviderCalls`. A sampling rate is not a spending cap.

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

**Repeated looks.** The rule runs at every cycle close, on a growing sample. The owner set the level to 95% (2026-11-17) for the stop rule, a proposal and the paired cost test (`STOP_CONFIDENCE`, `PROMOTION_CONFIDENCE`, `PAIRED_COST_ALPHA`). It is a per-look level, not a formal alpha-spending boundary: repeated looks find a difference by chance more often than 5% overall, which is one reason a proposal is never an adoption. Even when both arms accept every ticket, non-inferiority within 5 points needs about 73 decided runs per arm. `MIN_N` is a floor below which nothing is claimed. It is not the sample size that decides.

The thresholds are named, exported and provisional: `MIN_N`, `NONINFERIORITY_MARGIN`, `STOP_MARGIN`, `STOP_MIN_N`, `PROMOTION_CONFIDENCE`, `STOP_CONFIDENCE`, `COST_WORSE_MARGIN` and `DEFAULT_ELIGIBLE_STRATA`.

The overall outcome follows from the strata. It is `propose_policy` if any stratum proposes. Otherwise it is `retain` if any stratum retains, halts included. Otherwise it is `insufficient_evidence`. A record is `synthetic` if any included run did not declare live providers. The shadow selections of every run, excluded runs included, are summarised as a disagreement map. That map says nothing about quality.

### Paired runs

The owner chose paired runs on 2026-11-17. The reason is the sample size above. Unpaired interleaving needed about 126 decided runs per arm per stratum at the original 99% level (about 73 at 95%) to show non-inferiority within 5 points. Most of that variance is between tickets: some tickets are easy for both profiles and some are hard for both. A pair runs the same ticket under both profiles, so that variance drops out. What remains is the discordant pairs, the tickets one profile accepted and the other did not.

Code: `pairFor` in `pantheon/src/practice/assign.mjs`, `runCounterpart` in `pantheon/src/board/operate.mjs`, and the paired evaluation in `pantheon/src/practice/evaluate.mjs`. Tests: `pantheon/tests/practice-paired.test.mjs`.

**Sampling.** `pairFor({ticketKey, stakes, policy: {pairRate}})` takes 48 bits of a sha256 of the ticket key, under its own salt, as a uniform number `u` in [0, 1). The ticket is paired iff `u < pairRate`.
- The sample is deterministic: the same ticket is always paired, or not, at a given rate. Raising the rate only adds tickets.
- It is independent of the interleaving hash, so paired tickets fall on both arms.
- `pairRate` defaults to 0, which is off. The owner sets it.
- Every stakes stratum is paired, including `high`, `critical` and unknown, because the counterpart never ships. The only exception is a stratum the stop rule has halted, which is not paired.
- The decision and its basis are recorded in the pair record and in the bundle (`bundle.pair`).

**The counterpart.** When a ticket is sampled, `runBoardItem` runs it again after the primary run, under the other profile: `argo` gets `fit`, and `fit` gets `argo`. This happens before anything of the primary is committed or reviewed. It uses `runOpenItem` with:
- a separate dry board (`<board>/pair-<profile>`, or `pairDir`);
- a snapshot of the ticket's paths at the base commit, which `git archive` extracts into the dry directory, so the target repository is only read;
- a run ledger of its own (`<dry>/ledger`, through runOpenItem's `ledgerRoot`), never the shared `OPHANIM_LEDGER`;
- the primary's `revisions`;
- `maxProviderCalls = pairMaxProviderCalls`.

As a result, the counterpart:
- never ships to the real shipping ref (it ships, if at all, to its own board's ref);
- never commits or merges into the target repository, and never writes its working tree (its outputs go to the snapshot);
- never writes a status entry or a public record;
- never opens or closes the real review cycle.

A test proves this. Every byte of the target repository (`.git` included) and of its status ledger is hashed before and after the counterpart, and the two are identical. The counterpart shares two things with the primary: the provider cooldown store, which is the providers' real state, and `makeClientFor`. An operator reseat (`--seat`) is not passed on, because it would seat both arms alike.

**Refusals.** A sampled ticket is never paired without an explicit `pairMaxProviderCalls` (a positive integer). The refusal is `PAIR_UNBOUNDED`: it is recorded in the store, no counterpart runs, and the primary is unaffected. `PAIR_PROFILE` (a `legacy` primary) and `PAIR_NO_PRIMARY` (no run record) are refused the same way. The CLI refuses `--pair-rate` without `--pair-max-provider-calls` before any work.

Owner condition 3 (2026-11-17): live paired tests need explicit resource limits, a total spending boundary and comparable starting conditions; a sampling rate is not a spending cap. So:
- `PAIR_NO_TOTAL`: no counterpart runs without a total boundary, `pairBudgetCalls` (`--pair-budget-calls N`): the provider calls all counterparts in the evidence store may make together.
- `PAIR_BUDGET_EXHAUSTED`: the calls the store's completed counterparts actually recorded (`pairSpend`; a counterpart with no readable record counts at its bound, never as zero), plus this counterpart's bound, would exceed the total. The boundary is in provider calls because cost in USD is unknown without a price source; a USD boundary cannot be enforced and is not claimed.
- `PAIR_NOT_COMPARABLE`: a sampled ticket's primary runs under the counterpart's bound, so both arms start from the same limit. An explicit, different primary bound is kept and the pair is refused.
- Each pair record carries `starting`: base commit, ticket digest, revisions, both bounds, the order (`primary-first`), a digest of the provider cooldown state the counterpart met, and the spend recorded before it. The order is fixed, so an order effect is not removed, only recorded.

**The pair record.** It goes to `<store>/pairs/<pair_id>/pair.json`, next to `primary.run.json` and `counterpart.run.json`. Each run file is checked against the digest the record names:

```
{schema: pantheon.pair/v1, pair_id, status: completed|refused, ticket: {key, item, path, digest}, stakes,
 sampling: {basis, rate, u}, primary: {profile, run_digest, board},
 counterpart: {profile, dry: true, board, snapshot, run_digest, outcome: {accepted, first_pass, shipped, status, why}, providers, error?},
 bounds: {max_provider_calls, revisions}, refusal?}
```

A counterpart that fails, hits its bound or throws is kept as an outcome, and it is not accepted. A refused pair is listed under `paired.refused`. It is an outcome of neither arm, because nothing ran.

**Spend.** Pairing costs at most `pairBudgetCalls` extra provider calls in total, whatever the rate. Each counterpart is refused at the generation boundary once it reaches its bound (`PROVIDER_CALL_LIMIT`).

**The paired rule.** The rule applies per stratum, over completed pairs. A side is accepted iff its run was accepted (`metrics.mjs`). Differences are fit minus argo.
- **Tables.** `accepted` and `first_pass` each get a 2×2 table: e (both), f (fit only), g (argo only), h (neither). The discordant counts are f and g. The difference is (f − g)/n, with Newcombe's paired score interval, method 10 (R. G. Newcombe, *Statistics in Medicine* 1998;17:2635–2650). The implementation reproduces the paper's Table III and StatsDirect's worked example.
- **Cost.** Cost is compared only on pairs that both arms accepted, which compares the cost of the same accepted outcome on the same ticket. For calls, tokens and elapsed time, the per-pair differences are taken only over pairs where both sides have the value. They are tested with a Wilcoxon signed-rank test, which is exact up to 50 non-zero differences (mid-ranks for ties) and uses the normal approximation above that.
  - A measure is `lower` only if it is significantly lower at `PAIRED_COST_ALPHA` = 0.01 (two-sided) and no pair lacks fit's value where argo's is known. Unknown never counts as cheaper.
  - It is `worse` if it is significantly higher.
  - It is `unknown` if no pair has both values.

The decision steps are:

1. **Stop rule.** After `PAIR_STOP_MIN_N` = 10 pairs, if the upper 95% bound of the accepted difference is at or below −0.10, the stratum is halted. Its outcome is `retain`, its interleaving and pairing stop, and `fit` is flagged in the record's `flags`.
2. **`insufficient_evidence`** until there are `MIN_PAIRS` = 15 pairs.
3. **`propose_policy`** only if both of these hold:
   - The lower 95% bounds of the accepted and first-pass differences are both at or above −0.05.
   - `fit` is significantly lower on at least one cost and significantly worse on none.
4. **`retain`** otherwise.

**Precedence.** When a stratum has completed pairs, the paired decision is the stratum's decision (`basis: paired`). The unpaired decision is still computed and reported under `unpaired`. A halt from either comparison halts the stratum, which is the conservative direction.

The overall outcome, the `synthetic` flag and `measured` follow as before. A pair is synthetic if either of its sides did not declare live providers. The automatic cycle assessment cites the same record, and its question names the paired strata with their pairs and discordant counts. It is still never `promote`.

**Power note.** Each paired stratum reports `power` for accepted and first-pass:
- `pairs_needed_at_observed`: the number of pairs at which the 95% interval on the expected table (the observed cell proportions) would clear −0.05. That is about an even chance.
- `pairs_needed_80`: a Wald approximation for 80% power, (z₀.₉₉₅ + z₀.₈)² (p_disc − d²) / (d + 0.05)². It is null when no discordance was observed.

For scale at 95% (`pairsNeeded`): with 12.5% discordance and an observed difference of +0.025, about 95 pairs reach the margin at an even chance and about 174 at 80% power. With no discordance and 80% accepted by both, about 58 pairs clear it. When both arms accept every ticket, method 10 still needs about 73 pairs, because its Wilson bound at p = 1 does not narrow faster. Pairing helps exactly when the tickets differ in difficulty.

The constants are named, exported and provisional: `MIN_PAIRS`, `PAIR_STOP_MIN_N`, `PAIRED_COST_ALPHA`, `WILCOXON_EXACT_MAX` and `DEFAULT_PAIR_POLICY.pairRate` (0).

```sh
node pantheon/bin/pantheon-board.mjs run <item> --pair-rate 0.2 --pair-max-provider-calls 60 --pair-budget-calls 600 [...]
node pantheon/bin/pantheon-board.mjs evaluate [--runs DIR]   # prints the paired section after the strata
```

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
- No paired run has been made against live providers. The pair rate is 0 until the owner sets it.

## The fit matrix and Antigravity-first Gemini (owner direction 2026-11-17)

`fit` now starts every matrix role on a fixed pick per difficulty (`pantheon/src/route/fit-matrix.mjs`). It is the default routing profile of the lifecycle (`ophanim/operate/stages.mjs` `makeExecutors`); `selectSeat` and `runOpenItem` called on their own still default to `argo`. The orderings are the owner's direction. None is measured.

| Role | easy | medium | hard |
|---|---|---|---|
| planner | `claude-sonnet-5` | `claude-opus-5-5` | `claude-fable-5-2` |
| dispatcher | `gpt-6-luna` | `gpt-6.1-sol` | `gpt-6-astra` |
| implementer | `gemini-4-hydrogen` (thinking `medium`) | `gemini-4-neon` | `gemini-4-carbon` (thinking `high`) |
| subagent | `gemini-4-hydrogen`, native to the implementer's session | same | same |
| reviewer | the dispatcher's exact model for that unit, pinned | | |

The implementer and subagent rows are the owner's direction of 2026-11-19: see [The Google implementer on the Antigravity SDK transport](#the-google-implementer-on-the-antigravity-sdk-transport-owner-direction-2026-11-19). The rows of 2026-11-17 were Antigravity CLI lanes (`gemini-4-hydrogen-medium`, `gemini-4-hydrogen-high`, `gemini-4-carbon-high`) and Grok subagents (`grok-4.6`, `grok-4.6`, `grok-4.7`). Every other row is unchanged.

- **Column.** The ticket's difficulty, raised by the profile's class floor when that floor is higher (stakes; ambiguity for the planner). `fast`, `standard` and `frontier` are the easy, medium and hard columns. A floor never lowers a pick. `easy` now carries low stakes by default, so an easy ticket reaches the easy column.
- **OpenAI order.** `classes.json` now places `gpt-6-luna` < `gpt-6-sol` (and `gpt-6.1-sol`) < `gpt-6-astra`. The medium dispatcher is `gpt-6.1-sol`; other OpenAI medium seats stay `gpt-6-sol`.
- **Reviewer.** Pinned to the dispatcher's model. It escalates only inside OpenAI: `gpt-6-luna` -> `gpt-6.1-sol` -> `gpt-6-astra` (`pinnedReviewer`, `reviewerEscalation`). Where a review needs more labs, or OpenAI is excluded for independence, the rest of the order is the class order described above.
- **Implementer ladders** (Gemini API models at a thinking level, in order; since 2026-11-19). easy: `gemini-4-hydrogen@medium` -> `gemini-3.8-flash@high`. medium: `gemini-4-neon` -> `gemini-4-argon@high`. hard: `gemini-4-carbon@high` -> `gemini-4-hydrogen@xhigh` -> `gemini-4-argon@high`. The head of each is the owner's pick; the rungs after it are the base models of the 2026-11-17 ladders.
- **Rejection.** The same model's thinking level rises first where a higher one is recorded (`hydrogen@medium` -> `@high` -> `@xhigh`; `carbon@high` has none above it, and no level of `gemini-4-neon` is recorded), then the next rung of the ladder. The decision is an escalation record (`raise_thinking` or `step_rung`) that carries its ladder and re-derives from it.

Gemini goes through Antigravity first under both `argo` and `fit`. Since 2026-11-19 this holds for every role **except the `fit` implementer**, which is the Gemini API itself (the SDK transport), with no lane in front of it and no metered failover behind it:

- A policy seat naming a metered Gemini API id is served by that model's Antigravity lane first (`-high` unless the seat carries an effort).
- The API id stays in the order only as the lane's quota failover. The dispatcher reaches it only after a lane of the same base model was refused for quota: HTTP 429 or a quota-exhausted code, as `packages/model-client` `classifyFailure` classifies it (`pantheon/src/route/quota-failover.mjs`). Any other lane failure does not reach it.
- When the API answers this way, the turn, its attempts and its `selection` carry `quota_failover` with the lane refusal it followed. An unused failover is a `quota_failover.skipped` progress event.
- **The failover is billed and off by default** (register L-136, [docs/billing-policy.md](billing-policy.md)). It is sent only when the invocation enabled `metered_gemini_failover` with a budget (`--metered-gemini-failover N`, or the service config's `billing`); otherwise the quota refusal is recorded with `METERED_GEMINI_DISABLED` and the turn steps down or fails as it would without a spare. A Gemini API seat with no lane in front of it (a ticket's pin, the python SDK seat, the Google reviewer of `pantheon-review-cycle` and `run-review --via api`) is a primary request and needs `gemini_api_primary` instead: one setting never authorizes the other's kind. A key in the environment authorizes neither.
- A lane and its API id resolve to one model identity, so review independence treats them as the same contributor.
- Single-turn seats (`liveTurn`) follow the same rule (`laneFirstTurn`).
- Explicit operator seats and ticket pins are used as named.
- `gemini-4-hydrogen` is in the catalog on the owner's statement (window 1048576, output 65536, thinking low/medium/high/xhigh). Both Orchestrator ids stay undeclared.
- Antigravity reports a spent quota in words this repository has no documentation for. The CLI transport recognises `429`, `RESOURCE_EXHAUSTED` and quota or rate-limit wording in the CLI's result and stderr; anything else is an ordinary failure.

## Five-stage specialist pipeline

Under `fit`, the lifecycle's implement stage runs the plan's work units through a supervised pipeline (`pantheon/src/pipeline`, wired in `ophanim/operate/stages.mjs`). `argo` and `legacy` keep the per-file `runOpenItem` path, unchanged.

**Stages**

1. **Plan** (Claude, read-only). The plan stage's planner writes `work_units` with the plan. The three-lab plan review sees them. A `fit` plan without valid `work_units` is refused like any other malformed plan.
2. **Dispatch** (OpenAI, read-only). One turn per unit: is the unit cohesive, what role, what difficulty (it may raise it, never lower it), and the acceptance rubric. The controller freezes and hashes the rubric.
3. **Implement** (Gemini, an Antigravity SDK session on the Gemini API). One implementer owns the whole unit in the unit's own git worktree and writes the files itself.
4. **Subagents** (Gemini 4 Hydrogen, native to the implementer's session). A Carbon or Neon implementer may delegate specific assignments to specialist subagents, within a ceiling the controller enforces. They are implementation contributors, never reviewers.
5. **Review** (OpenAI, read-only). The dispatcher's exact model, pinned. It judges the diff and the output of the unit's `verify_cmd`, both read from disk by the controller.

After the pipeline: the same coordinated three-lab change review, the validator and the outcome as before. Stage 5 is the in-run reviewer. It replaces none of them.

**Matrix** (`pantheon/src/route/fit-matrix.mjs`)

| role | easy | medium | hard |
|---|---|---|---|
| planner | claude-sonnet-5 | claude-opus-5-5 | claude-fable-5-2 |
| dispatcher | gpt-6-luna | gpt-6.1-sol | gpt-6-astra |
| implementer | gemini-4-hydrogen (medium) | gemini-4-neon | gemini-4-carbon (high) |
| subagent | gemini-4-hydrogen (native) | same | same |
| reviewer | the unit's dispatcher model | same | same |

- The dispatcher, implementer and reviewer are seated per unit, by the unit's difficulty. A difficulty the dispatcher raises moves the implementer with it, and with the implementer its subagent ceiling (Carbon 8, Neon 4, Hydrogen none).
- The plan-stage planner is seated before any unit exists, so it is the medium seat.

**Ladders**

- Implementer, on a rejection: the same model's thinking level first, then the next rung (`implementerPath`). Easy: `hydrogen@medium -> hydrogen@high -> hydrogen@xhigh -> 3.8-flash@high`. Medium: `neon -> argon@high`. Hard: `carbon@high -> hydrogen@xhigh -> argon@high`.
- Reviewer: raised one rung only after two consecutive rejections by the same reviewer, and only inside OpenAI: `gpt-6-luna -> gpt-6.1-sol -> gpt-6-astra`.
- Revisions per unit are bounded (default 3). When they run out the unit is blocked with every finding kept.
- Quota, on the SDK transport: a quota refusal (or the provider reporting the model unavailable) skips that model's other thinking levels and steps to the next rung, recorded on the unit (`lane_failures[]`, `escalations[]`). There is no second, metered seat behind an SDK seat: it already is the Gemini API.
- Quota, on an explicit lane seat (kept for the lane path only): the metered Gemini API of the lane's base model is used only after the lane was refused for quota (429). It cannot write files, so its whole reply must be `{"files": [{"path", "content"}]}`; the adapter writes those files and the write jail then checks them. Any other reply is a failed attempt.

**Work unit** (`work-units.mjs`; unknown keys are refused)

```json
{"unit_id": "codec", "depends_on": [], "owned_paths": ["src/codec/**"], "difficulty": "medium",
 "specialist_role": "node-esm-library-engineer", "allowed_subagents": ["code-explorer"], "verify_cmd": "node src/codec/codec.test.mjs",
 "invariants": ["encode and decode round-trip"]}
```

- A unit is one cohesive multi-file change. Coupled types, implementation and tests stay in one unit.
- `allowed_subagents` names the specialist types the unit's implementer may delegate to: `code-explorer`, `dependency-analyst`, `context-retriever` (read only), `test-constructor`, `bounded-implementer` (write, inside the unit's owned paths). `[]` allows none. A name that is not one of these types is not offered to the implementer and is recorded on the session (`subagents.ignored_types`).
- Under `fit`, every slice path of the plan must be owned by a unit.
- The plan's exclusions, and the findings a revision must answer, are appended to every unit's invariants for the run.

**Controller rules** (code, not a model)

- Units whose owned paths overlap must have a dependency order. Without one the plan is refused and the item returns to planning.
- Units run in waves: a unit starts only after every unit it depends on was approved and merged. Units in one wave run at the same time, each in its own worktree.
- Write jail: after each implementer turn the controller reads the worktree from disk. Any change outside the unit's owned paths discards the whole attempt.
- Ground truth: the controller runs `verify_cmd`. An approval while it fails is void.
- A reviewer answer is admitted only if it names the model that answered and that is the model asked for.
- Approved units are merged on `pantheon/pipeline/<run_id>`. The lifecycle commits that tree once on `pantheon/<item>` (parent: the base) and deletes the integration branch.
- The stage's provider-call budget bounds every turn of the run.

**How results map to the lifecycle**

- Completed: the commit goes to the three-lab review.
- A plan error (overlap without order, or a unit the dispatcher calls not cohesive): returned to plan, with the reason as a finding.
- A unit that ends blocked or refused: the stage is blocked; the run record and findings are kept.
- Budget used up: the stage fails as "did not ship", naming the bound.

**What is scripted only, and known gaps**

This list was first written on 2026-11-17. Three of its entries were overtaken by later work and are corrected here (self-audit round 3, assignment 3, L-308):

- Most tests use scripted model turns and a fake `agy` CLI. The first live worker turn is described under [Live-run hardening](#live-run-hardening-2026-11-18).
- **Superseded for the `fit` implementer (2026-11-19).** The next two entries, the worker card and the socket relay, describe the agy CLI worker. A `fit` implementer is now an Antigravity SDK session with native subagents (see [the SDK transport](#the-google-implementer-on-the-antigravity-sdk-transport-owner-direction-2026-11-19)); the CLI worker runs only for a seat that names an Antigravity lane explicitly.
- The worker is the `pantheon-unit-worker` card, which edits files itself. The `pantheon-implementer` card (reply with file text) stays for the `argo`/`legacy` per-file path.
- **Corrected.** The implementer is sandboxed at OS level: it runs in `bwrap`, and its one command runs in the verify jail. See [Live-run hardening](#live-run-hardening-2026-11-18) and [Credential isolation](#credential-isolation-2026-11-19). The write jail after the turn stays as a third layer.
- The worker reaches its subagents over a Unix socket and a stdio MCP relay, not TCP.
- `liveTurn` does not forward `extra` (`reasoning.context`) to the provider yet; the adapter passes it and tests check that.
- **Corrected.** A lane failure that is not a quota refusal is retried once on the same lane, then the unit steps down its Antigravity ladder. A quota refusal goes to the metered failover when that is allowed and the refusal is proven (see below); otherwise it steps down at once. An exhausted ladder blocks the unit.
- **Corrected.** A retried implement stage resumes from its checkpoints: each approved unit is re-verified and skipped with no provider call. Units without a valid checkpoint run again.
- The run's ledger holds the review cycle only. The pipeline's own record is `pipeline.json`, bound by digest in `run.json`.

### What one provider call is

A **provider call** is one billed request to a model provider. Every bound counts this unit: `maxProviderCalls`, the stage budget, `total_provider_calls`, the pipeline's `max_provider_calls`. Each call is charged before it is sent, and a refused charge means the call is not made (self-audit round 3, assignment 3, L-301).

| Transport | One provider call is | Where it is charged |
|---|---|---|
| Direct API, streamed or unary (`sendTurn`) | Each generation request: the turn's request, each Google continuation hop (up to 16, each billed) and an Anthropic compaction | `onRequest`, before each request is sent. By default the caller charges the first request and `onRequest` the rest. With `chargeFirstRequest` it charges every one, so a turn the seat layer refuses before any request costs nothing. |
| Model client (`sendModelTurn`, `packages/model-client`) | The same: compaction, the request, each continuation hop | `onRequest`, before every one, the first included |
| Board SDK seat (`sdkTurn`, used by `runOpenItem`) | The same | `runOpenItem` passes `onRequest` with `chargeFirstRequest`. Each request is admitted against the run's bound and the caller's `onCharge` (the work ledger) before it is sent. |
| Antigravity CLI, single turn (`runAgyCliTurn`: planner, reviewers, validator, subagents, the board's agy seat) | One CLI session. Antigravity bills its subscription per session, not per request. | `charge`, after the jail is built and before the CLI is spawned. A turn that fails before the spawn costs nothing. |
| Antigravity CLI, unit worker (`runAgyWorkerTurn`) | One worker session, however many turns it takes inside | `charge`, after the jail is built and before the spawn |
| Python agy SDK seat (`PANTHEON_AGY_TRANSPORT=sdk`; the board's reviewer and scout default to the CLI lane) | One seat process, a billed Gemini API primary request (`gemini_api_primary`) | Right before the spawn, after the Gemini billing policy admitted it and its usage row was persisted |
| Metered Gemini failover of a lane | A provider call of its own, plus each further request of the API turn | Before the API is asked (`charge`, or `admitRequest` with kind `failover`), after the Gemini billing policy admitted it (`metered_gemini_failover`) and its usage row was persisted |
| Antigravity SDK session (`runAntigravitySdkTurn`: the `fit` implementer) | Each generation request the session's runtime sends (`generateContent`, `streamGenerateContent`): the implementer's own, and each native subagent's | The model gateway's `admit`, before the request is forwarded to the Gemini API: kind `session` (the implementer's first), `continuation` (its later ones), `subagent` (a subagent's). A refused admission is answered to the runtime as a refusal and nothing is forwarded. Buckets in `provider_calls.by_role`: `implementer`, `continuation`, `native_subagent`.. Before each one the Gemini billing policy admits it (`gemini_api_primary`) and its usage row is persisted; the policy is also asked before the session is started |

**Two contracts for a single-turn `turn`** (`pantheon/src/sdk/live.mjs`):

- `charge`: the caller charged the turn's first call before calling `turn`. `charge` admits every further call: a hop, a compaction, a failover. The stage meter (`ophanim/operate/stages.mjs`) and the pipeline (`pipeline/index.mjs`) use this one.
- `admitRequest`: the caller charges nothing up front, and every call is admitted at its point of spend. Kinds: `request` and `continuation` (API), `lane` (between the jail and the spawn), `failover`. `pipelineTurns` passes it to its seats, its implementer and its failover. Moving the stage meter and the pipeline to it is subwave 2b's work.

**Not provider calls:** token counts (`countTokens`, `inputTokens.count`), because providers do not bill them (L-604; if one does, the budget undercounts), and the zero-spend Antigravity `/usage` probe (`num_turns` 0).

**How a budget stop is recorded** (L-308). The run record classifies stops by code, never by the words of a reason. Each entry of `budget_stops` in `run.json` names its `kind` (`provider_calls`, `elapsed` or `iterations`) and its `code`:

- a tick's structured stop (`stop.code`: `PROVIDER_CALL_BUDGET`, `ELAPSED_LIMIT`, `STAGE_ELAPSED`, `ITERATIONS_LIMIT`);
- a stage blocker `STAGE_PROVIDER_CALLS` or `STAGE_ELAPSED`;
- `STAGE_BUDGET_EXCEEDED`, a pipeline's own bound (`PIPELINE_PROVIDER_CALLS`), or pipeline turns refused at the limit;
- a stage the scheduler charged its whole budget that did not pass (`usage.budget_exhausted`).

An elapsed stop is never listed as a provider-call stop.

## Live-run hardening (2026-11-18)

**Stage 1 seat.** The planner is seated from the item's own declared difficulty and stakes: an existing ticket's `difficulty`, `stakes`, `ambiguity`. Easy → `claude-sonnet-5`, medium → `claude-opus-5-5`, hard or critical → `claude-fable-5-2`. An item without a ticket declares none and plans at medium; the plan record says which (`selection.tier`).

**The worker.** A new card, `pantheon/.agents/agents/pantheon-unit-worker/agent.md`, edits files directly in the unit's owned paths, calls `ask_subagent` for its allowed subagent roles, and runs `verify_cmd` before finishing. The old `pantheon-implementer` card stays for the `argo`/`legacy` per-file path, which still needs its reply-with-text contract.

- Launch: `agy --agent pantheon-unit-worker --model <lane> --mode=accept-edits --add-dir <worktree> --output-format stream-json --print-timeout <n>s --print <prompt>`, async `spawn`, no `--dangerously-skip-permissions`.
- Environment: `ANTIGRAVITY_AGY_CLEANUP=all` is set as the owner asked. It is not in Google's documentation; every turn record says so. Google API keys are removed.
- The process runs in a per-unit control directory outside the worktree. That directory holds the card, `.agents/hooks.json`, `.agents/mcp_config.json` and the jail policy.

**Containment, three layers.**

1. **Before a write:** a `PreToolUse` hook (`pantheon/src/agy/jail-hook.mjs`) denies any write outside the unit's owned paths, into `.git` or `.agents`, or through a symlink that leaves the worktree. It approves `run_command` only for the unit's verify launcher (which runs `verify_cmd` in the verify jail; see [Credential isolation](#credential-isolation-2026-11-19)), and MCP only for `ask_subagent`.
2. **The process:** `bwrap` mounts the filesystem read-only, except the worktree, the CLI's state directory and the control directory's `run/`. The main repository's `.git` is read-only, so the worker cannot commit or move refs. The network is not cut, since the CLI must reach Google. Without a working `bwrap` the turn refuses to run unless explicitly allowed.
3. **After the turn:** the existing git-based jail, unchanged.

**Subagents under the sandbox.** The A2A shim listens on a Unix socket in the controller's per-unit directory. A stdio MCP server (`pantheon/src/pipeline/a2a-mcp-server.mjs`), launched by the CLI from `.agents/mcp_config.json`, relays `ask_subagent` to it. No TCP loopback is used.

**Quota and lane failover.**

- A lane failure that looks like quota triggers one `agy -p /quota` probe (`pantheon/src/agy/quota.mjs`). The metered Gemini API is used only if the failure was an explicit 429 or `RESOURCE_EXHAUSTED`, or the probe reads the quota as exhausted, and only when the invocation enabled `metered_gemini_failover` with a budget that is not used up ([docs/billing-policy.md](billing-policy.md)). An unreadable report counts as unknown, never as exhausted.
- Any other lane failure (timeout, non-zero exit, stream drop, spawn) is retried once on the same lane, then the unit steps down its Antigravity ladder. Lane failures spend no review revision. An exhausted ladder blocks the unit with every failure recorded.

**Resume.** Each approved unit is checkpointed: its key, the Stage 5 verdict, the rubric hash, the commit and the tree. A retried implement stage re-verifies each checkpoint by patch digest and resulting tree, skips units that pass with no provider calls, and runs the rest. A tampered or stale checkpoint is rejected and the unit re-runs.

**Observed on the owner's machine (agy 1.5.10, 2026-11-18).**

- The help lists every flag the worker uses (`--mode`, `--add-dir`, `--agent`, `--output-format`, `--print-timeout`), plus `--disable-slash-commands`, `--settings`, `--effort` and `--sandbox`.
- `agy --print /usage --output-format json` spends nothing: `num_turns` 0 and every token counter 0. It returns the quota as `command.data.groups[]`. Each group lists its models and carries two buckets (`window` `weekly` and `5h`), each with `remaining_fraction` and `reset_time`. Gemini models share one group; Claude, Sonnet and GPT-OSS share the other. No separate Argon bucket was reported.
- The probe now uses that JSON form and decides on the lane's own group only: a spent Claude/GPT bucket does not move a Gemini lane to the metered API. The text form is the fallback. Both observed outputs are test fixtures (`pantheon/tests/agy-quota-observed.test.mjs`).
- Workers now also pass `--disable-slash-commands`, so prompt text can't expand into a slash command or skill, and set `AGY_CLI_DISABLE_AUTO_UPDATE=true`.

**First passing live worker turn (agy 1.5.10, owner's machine, commit `7ca325c`, 2026-11-18).** `scripts/agy-worker-probe.mjs` exited 0: one `gemini-3.8-flash-low` turn, inside the real `bwrap` jail, with a mock subagent and no API client.

- The `--print` session loaded the workspace hook ("loaded 1 named hooks from 1 hooks.json file(s)"). Its workspace was the control directory plus the worktree (`--add-dir`), and each hook ran with cwd `<control dir>/.agents`.
- A write outside the owned paths was denied by the owned-path check before it happened. The owned write was approved and landed.
- The subagent tool is named `mcp_pantheon-subagents_ask_subagent`. It reached the mock over the Unix socket inside the jail.
- The exact `cd '<worktree>' && <verify_cmd>` ran and reported exit code 0. (Since 2026-11-19 that command is denied: the worker runs the unit's verify launcher instead, see [Credential isolation](#credential-isolation-2026-11-19).)
- No host path the jail could write changed. Two SQLite sidecars of the host's own `conversation_summaries.db` appeared in a directory the jail could not see; a long-running host `agy` process was present, but the writer was not established.
- Contracts learned on the way, each now a regression fixture:
  - the CLI's state lives in `~/.gemini/antigravity-cli`;
  - the write tool is `write_file {Path, Content}`;
  - `run_command` takes no `Cwd` and needs a writable `bin/`;
  - the subcommands reject `--log-file` and `--add-dir`;
  - their "not logged in" lines are routine output.

Not yet exercised:

- the CLI's own command sandbox inside `bwrap` (the card uses `commandExecutionPolicy: auto`);
- the lazy `call_mcp_tool` path (the CLI called the tool directly);
- a real Grok subagent;
- a full lifecycle item through the pipeline.

## Credential isolation (2026-11-19)

Owner direction: worker-controlled code must not be able to obtain or disclose a credential, nor reach unrelated host resources. Per-unit scoping and the subagent call bound are safeguards, not isolation. The enforcing module is `pantheon/src/agy/verify-jail.mjs`; its header states the same invariant.

**Who holds credentials, and who does not.**

- *Credential-bearing (trusted):* the controller (provider keys, the checkpoint seal key, every unit's A2A token), the A2A shim inside it, the agy CLI (the Antigravity OAuth state: the per-run scratch copy of `~/.gemini/antigravity-cli`, token included), and the stdio MCP relay `a2a-mcp-server.mjs` (it reads the unit's A2A token).
- *Untrusted:* every process started from worker-controlled content, that is the unit's `verify_cmd` and anything it runs (scripts, tests, package hooks, children, daemons). This holds whether the worker's `run_command` started it or the controller's `runVerify` did. Worker-controlled code must not read the OAuth token either.

**The invariant.** Untrusted code runs only through a verify launcher, in a fresh bwrap jail. From inside it, it cannot reach any credential, any host file outside a small allowlist, or any network:

| Channel | What the verify jail does |
|---|---|
| Environment | A clean allowlist (`verifyEnvOf`): `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TERM` and `TZ`, plus what `PANTHEON_VERIFY_ENV_PASS` names, with no exceptions for secrets: no secret-named variable, and no `PANTHEON_`, `AGY_`, `ANTIGRAVITY_`, `GEMINI_`, `GOOGLE_`, `OPENAI_`, `ANTHROPIC_`, `XAI_` or `FAKE_AGY_` variable. There is no network, so no proxy variable passes, and neither does any value carrying a `user:password`. `PATH` is the jail's own (the node toolchain plus the system dirs). `HOME=/tmp/home`, `TMPDIR=/tmp`, `GIT_CONFIG_NOSYSTEM=1`. |
| Filesystem | An allowlist base like `board/acceptance.mjs`. The jail starts from an empty root and gets: `/usr` and the `/bin`, `/sbin`, `/lib*` dirs or links; from `/etc` only the certificate stores (never `/etc/ssl/private`), the loader cache and config, `alternatives`, timezone, `nsswitch.conf`, `shells`, `protocols`, `services` and `os-release`, plus a generated minimal `passwd`, `group` and `hosts`; the node toolchain's prefix; its own `/proc`, `/dev` and `/tmp`; the unit's worktree (read-write); and the worktree's git dirs (read-only). Git keeps working. Every git config in those dirs is replaced by a generated one (`sanitizedGitConfig`) that keeps only plain `core` and `extensions` keys: no remote, credential helper, include, url rewrite, `hooksPath`, `fsmonitor` or `sshCommand`. `FETCH_HEAD`, `logs/`, `remotes/`, `branches/` and `modules/` are hidden too, because a remote URL with a token can sit in any of them. Nothing else of the host exists in the jail: no home (`~/.gemini` and the OAuth token, `~/.ssh`, …), no `/opt` beyond the node prefix, no `/var`, `/srv`, `/mnt` or `/run`. The unit's control dir (`mcp_config.json`, the token file `a2a.token`, the A2A socket, `run/` with the OAuth scratch copy), its sibling control dirs, the socket dir, the agy state dirs, the Gemini layout and the caller's list (the pipeline names its run dir, the checkpoints and their seal key) are hidden again if a bound path contains them. A bind inside one of them, or inside a home's secret dirs, is refused. |
| Inherited descriptors | Only 0, 1 and 2 reach the script. bwrap passes inherited fds through (observed with bubblewrap 0.9.0). The launcher is a node process, which marks inherited fds close-on-exec at startup (observed on node 24.22), and `closeInheritedFds` closes any left open. |
| `/proc` of credential-bearing processes | `--unshare-pid` with a fresh `/proc`: agy, the relay and the controller are not visible, so their `environ`, `cmdline`, `fd`, `mem` and `root` cannot be opened, and they cannot be signalled or traced. Also `--unshare-ipc`, `--unshare-uts`, `--cap-drop ALL` and `--new-session`. |
| Network and sockets | There is no network: `--unshare-net` leaves only the jail's own loopback. The host's loopback services, the LAN, the metadata address 169.254.169.254 and the host's abstract Unix sockets (they belong to the host's network namespace) are unreachable. No path socket exists in the jail outside the worktree. A policy that asks for network (`network: true`) is refused with `BAD_POLICY`, never granted. In this container `/run/sandbox-telemetry/ingest.sock` was reachable before the allowlist base. |

The verify run is bounded and can be cancelled (round 2, assignment 3, finding 9). `runVerify` takes the stage's `signal` and its `deadline`, the stage's hard end, which `runPipeline({deadline})` passes on and `ophanim/operate/stages.mjs` sets from the stage's elapsed budget.

- Abort or timeout kills the launcher's process group, and the jail dies with it, background children included.
- An exec failsafe resolves the run even when a stray process holds the pipes.
- A run stopped this way FAILED and records `aborted` or `timed_out`.
- A run whose deadline has already passed is not started.
- The worker's `--print-timeout` is the caller's timeout, capped at the time left before the deadline minus the kill grace (`printTimeoutOf`). If no time is left, the turn is not started (`DEADLINE`).

The launcher fails closed. If bwrap cannot start the jail, it exits 125 and the script never runs. The only exception is a policy with `allow_unjailed: true`, which still gets the clean environment and closed descriptors and is recorded as such.

**The design.**

- **The worker's one command is the launcher.** `prepareWorkerWorkspace` writes `<control dir>/verify.json` (the policy) and `<control dir>/pantheon-verify`, a wrapper that takes no arguments and runs `node verify-jail.mjs verify.json`. `jail.json`'s `worker_verify_cmd` is that path. The hook approves `run_command` only for a verify launcher in the unit's own control dir (`isVerifyLauncher`). The earlier `cd '<worktree>' && <verify_cmd>` is denied, because it ran as agy's child with agy's environment, descriptors, `/proc` and view of the OAuth state and MCP config. `prepareWorkerJail` adds the Gemini layout, the state dirs and the socket directory to `verify.json` before the CLI starts. The control dir is read-only to the worker.
- **The controller's `runVerify` uses the same launcher** (`node verify-jail.mjs --inline <policy>`), in its own process group and with a clean environment. The pipeline hides its run dir (every unit's control dir and the other worktrees), the checkpoints and the seal key. It binds back only the unit's worktree.
- **The review runner's agy reviewer uses the same launchers** (`src/review-runner/agy.mjs`, `cli-common.mjs` `allowedCommands({launcherDir})`). Its allowed commands are `<control dir>/pantheon-test <files>`, which runs `node --test <files>` with the files checked again by the launcher, and `<control dir>/pantheon-suite-<proof|pantheon|all>`, each with its own policy (`verify-test.json`, `verify-suite-<name>.json`). The harness lists them. The hook (`decideReviewCommand`) approves only launchers in the review's own control dir, and the earlier `cd '<worktree>' && node --test …` and `cd … && npm test` forms are denied. Code under review therefore cannot reach the reviewer agy's OAuth copy. Inside that jail, a repository test that needs `/var/tmp`, the network or its own bwrap may skip; the harness's sandbox note tells the reviewer to report that as `cannot tell`.
- **The A2A token is in no environment and no config.** `prepareWorkerWorkspace` writes it to `<control dir>/a2a.token` (mode 0600). `mcp_config.json` names `PANTHEON_A2A_TOKEN_FILE`; agy 1.5.10's `mcp list` was observed to print a server's configured credential. `workerEnvOf` drops every secret-named extra, the token included, and the turn adapter no longer passes it. The relay reads the file once at start and authenticates every call with it. The shim still requires the bearer token and still enforces the unit's role allowlist and call and byte bounds.
- **Is the token still needed?** Only the relay and agy, both credential-bearing, can reach the socket, so the token is now defence in depth. It covers any agy tool path the hook does not know and a run with `allowUnsandboxed`. It is kept.

**Evidence** (`pantheon/tests/verify-jail-credential-isolation.test.mjs`, real bwrap, synthetic credentials, fixture under `/var/tmp` so that no jail's `/tmp` tmpfs hides it by accident):

- A probe in the worktree looks for the dummy A2A token, OAuth token, `OPENAI_API_KEY`, SSH key, gh token, a sibling unit's token and the seal key, plus two new plants: a token in the repository's remote URL (`.git/config`, `FETCH_HEAD`) and a dummy secret in a host file under `/etc`, `/opt` and `/srv`.
- The probe checks its env; every readable file under the homes, `/tmp`, `/var/tmp`, `/var`, `/run`, `/dev/shm`, `/mnt`, `/srv`, `/etc` and `/opt`; its descriptors; `/proc/<pid>/{environ,cmdline,fd,root}` of every visible process; and every socket it finds.
- It also tries a TCP listener on the host's loopback, an abstract Unix socket bound on the host, and 169.254.169.254:80.
- It finds nothing when run through agy's `run_command`. In that run the fake agy holds fd 9 on the token file and runs a long-lived process with the token in its env and argv.
- It finds nothing through the controller's `runVerify`. The controller there has the key in its env and fd 3 open on the token file, while a relay-like process and the live shim socket are present.
- It finds nothing when the launcher is started from a shell that holds fd 9 and has the keys in its env.
- Run unjailed, the same probe finds every credential, by env, file, fd, `/proc` and socket. That includes the remote-URL token in `.git/config` and the `/etc|/opt|/srv` plants, and it connects to the host loopback listener and the abstract socket.
- Inside the jail, git status, log and diff still work on the worktree; `git remote` is empty and no config beyond `core`/`extensions` is listed.
- In the same worker turn, `ask_subagent` answers twice through the relay. The third call is refused at the unit's bound (`CALLS_EXHAUSTED`), and a forbidden role is denied by the hook. The relay with a wrong token file gets 401, a missing file gets "not configured", and neither reaches a subagent turn.
- Mutations fail these tests: no PID namespace, the control dir not hidden, the launcher passing its own env through, no `--unshare-net`, a `--ro-bind / /` base, and the repository's git config not replaced.
- The review runner's launcher (`pantheon/tests/review-runner-cli-units.test.mjs`, real bwrap) runs a test file under review. That file cannot read the reviewer's OAuth copy, the control dir or the metadata address. The launcher refuses a `..` file argument by itself (exit 125).
- In the subscription runner's agy test, the fake agy's `run_command` of `<ctl>/pantheon-test …` completes through the hook and the nested jail.

**Every agy launch, not only the worker's (self-audit round 3, assignment 4 (sealed `fe2a612`), L-401; owner plan step 3).** The invariant above covered worker-controlled *code*. The self-audit found a second channel: the single-turn seats served through Antigravity (the planner, the plan and change reviewers, the validator and the A2A subagents through `sdk/agy-turn.mjs`, and the board's agy seat through `board/run-item.mjs`, all calling `board/agy-cli.mjs` `runAgyCliTurn`) ran the real CLI **unjailed**, with the controller's whole environment minus only the two Google keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` and every token reached it) and with `--sandbox`, on text that is partly worker-controlled (an A2A subagent's question is the implementer's text). Worse than the self-audit stated: a subagent seat runs the `pantheon-reviewer` card, which lists `run_command`. So the invariant is now stated for the CLI too: **every agy launch uses the worker's environment allowlist (`workerEnvOf`), the worker's bwrap jail (`prepareWorkerJail`), the worker's argv checks (`workerArgv` + `assertWorkerArgv`: no `--sandbox`, no `--dangerously-skip-permissions`) and the worker's PreToolUse hook.**

- `runAgyCliTurn` builds a fresh control dir per turn (`agy/workspace.mjs` `prepareSingleTurnWorkspace`): the role card copied from `pantheon/.agents/agents/`, no MCP server, the hook with a READ-ONLY policy (reads inside the seat's worktree only; every write, command, MCP call and native subagent denied). The CLI's cwd is that dir; a `--json-schema` is copied into it. Without bwrap it refuses (`SANDBOX_UNAVAILABLE`), never a silent unjailed run. The control dir and the Gemini scratch are removed on every path. The call signatures of `runAgyCliTurn` and `agySingleTurn` are unchanged; the result adds `jail_log`, `tool_steps`, `tool_drift`, `launch` and `sandbox`.
- Consequence for the board's agy seat: the reviewer and scout cards list `run_command`, and the board's reviewer brief says "run the acceptance command yourself". In the jail every command is denied (a single-turn seat has no verify launcher). Running the acceptance there needs a verify launcher passed by the caller, a change in `board/run-item.mjs` (not made here; reported).
- The quota probe (`agy/quota.mjs` `probeQuota`, fixed argv `--print /usage --output-format json`, no worker text) runs in the same jail and allowlist (over the minimal env); without bwrap it reports `unknown`, never `exhausted`.
- Evidence: `pantheon/tests/agy-single-turn-jail.test.mjs` (real bwrap, ten synthetic credentials in the controller's env). A probe CLI, launched as an A2A subagent seat, a planner seat and the board's seat, records from inside: no synthetic value in its env or in any `/proc/<pid>/environ` or `cmdline` it can read, PID 1 is `bwrap`, the host `/tmp` is invisible, a host write is refused, the argv carries neither forbidden flag, and the hook denies `run_command`, a write, a read outside the worktree, `invoke_subagent`, MCP and `search_web` while approving a read inside. At 08ee51a every one of those assertions fails.

**The review runner: the code under review only in a verify jail (L-404), and a coverage gate (L-501).**

- API runner: `run_tests` and `run_suite` (`review-runner/tools.mjs`) ran `node --test` / `npm` as the runner's own children; the runner holds the provider key, and a same-uid child reads `/proc/<runner>/environ`. They now run through `verify-jail.mjs --inline`. Evidence: `pantheon/tests/review-runner-coverage.test.mjs` (a runner process with a synthetic key in its initial env; the test under review finds no key, no home file, no host loopback).
- Grok: its test commands are the review's launchers (`allowedCommands({launcherDir})`), allowed per invocation with `--allow 'Bash(<ctl>/pantheon-test *)'` and one rule per suite launcher; a `config.toml` allow rule that could run the code another way (`node`, `npm`, any `Bash` rule beyond the read-only commands) refuses the preflight. The launcher starts the verify jail nested in grok's jail (observed with the fake grok under real bwrap).
- Codex: its sandbox cannot start the verify jail (nested namespaces are refused there), so it **runs no test**: no command is listed, the harness says why, the profile denies the node and npm binaries and no longer reads the node install.
- The coverage gate (`review-runner/coverage.mjs`): a run is `incomplete` when no source file was read, when any read was denied by the hook or the sandbox, or when no test ran where the testing limit allows tests; for agy also when a tool step finished that the hook never approved, or a tool the hook does not classify was advertised. `coverage {source_reads, denied_reads, tests_run, files_read_sample, ...}` is in every transcript and findings header. Consequence: every Codex review of an assignment that allows tests is `incomplete`.
- Tool drift (L-502): the agy preflight's blocking check `tool_drift` compares the tools the CLI advertises (the card's `tools:` line, a tool list in `agy agents`, the CLI's registry lines; at run time the stream's `init.tools` and every `step_update` tool name) with the hook's classification (`jail-hook.mjs` `classifyTool`) and fails on any read-, write-, exec- or network-like name the hook does not classify, naming it and the discovery method.

**Remaining exposure.** Closed since the first version: the shared network (now `--unshare-net`), host files outside the hidden roots (now an allowlist base with a sanitized git config), the review runner's agy reviewer (now the launchers), the single-turn agy path (L-401: now the worker's jail, allowlist, argv checks and hook), and the review runner's API and grok tests (L-404: now the verify jail).

1. **The trusted CLI's own jail: its egress and its read-only view of the whole host (L-004, owner constraint: EXPLICITLY UNRESOLVED).** The agy process, worker and single-turn alike, shares the host network (it must reach Google; bwrap has no egress filter) and sees the whole host read-only, so same-uid credential files (`~/.codex/auth.json`, `~/.ssh`, …) are readable to it, and a prompt injection into agy itself, not its tool-mediated code, could read one and send it. The owner's constraint is to keep the current restrictions and not broaden its access; nothing here narrows or claims to close it. The L-401 probe records what the jailed CLI could read as a diagnostic, not a pass.
2. **agy's own tool processes other than `run_command`.** The CLI may run helpers of its own (the MCP servers it launches, its `bin/agentapi` shell injection); they run with agy's view. Now detected rather than assumed: an advertised tool the hook does not classify fails the preflight (`tool_drift`), and a tool step that finished more often than the hook approved it is recorded on every turn (`tool_drift.unhooked`) and makes a review incomplete. Not detected: a helper that leaves no tool step. *Bounded plan:* list `/proc` of the jail from a sidecar during the live probe.
3. **A CLI that closes the hook wrapper's stdout.** The wrapper always prints one decision, but if the CLI itself closes the pipe, the wrapper's write fails (exit 3) and, by the owner-stated semantics, an empty hook stdout ALLOWS the tool. This is inherent to a stdout-as-decision protocol and outside what the hook can prevent; the 10 s / 20 s / 30 s timeout stack means the CLI would have to discard the pipe actively. Not testable from the module.
4. **The grok transport's read-only rules.** How grok matches `*` in a `Bash` rule is undocumented: `Bash(find *)` or `Bash(sed -n *)` may admit `find -exec …` or GNU sed's `e` command, which would run a program in grok's jail (its login, the network). That is not a test path; the reviewer model would have to compose it. The per-invocation `--allow` flag is documented by xAI but not yet observed on a real grok.
5. **Codex runs no test.** Until a jailed test route exists for codex (for example a runner-served MCP tool that runs the verify launcher outside codex's sandbox), every codex review of an assignment that allows tests is `incomplete` by the coverage gate.
6. **What the allowlist itself exposes.** `/usr` whole (no secrets by convention, but a site might put one under `/usr/local/etc`), the certificate stores, the main repository's objects and refs, and `extra_ro` (the review runner's TELOS root for `test:proof`). *Bounded plan:* if a site keeps secrets under `/usr/local`, list `/usr/local/etc` as a hidden path in the policies.
7. **No network means no package install inside a verify run.** Deliberate: the policy refuses `network` instead of granting it.
8. **Same-uid processes outside every jail.** Verify code cannot see them (PID namespace). A controller crash leaves the token file in a 0600 file under the run dir, which the next run removes.
9. **The SDK bridge's jail (since 2026-11-19; register L-704).** Like the trusted CLI's jail, it shares the host network (it must reach the controller's loopback gateway; bwrap has no egress filter) and sees the host read-only, minus the home's credential-bearing directories, the controller's other control dirs and the host's `/tmp`. It holds no provider key and no login. What it could still do if the SDK runtime itself were subverted: read a same-uid file outside those directories and send it, or the unit's source, to any reachable host.

**Spawn sites** (every `spawn`, `exec`, `execFile` or `spawnSync` in `pantheon/src` and `ophanim/operate`).

- Through a verify launcher, all worker- or review-controlled code: the worker's `run_command` (hook: the launcher only); `pipeline/review.mjs` `runVerify`; `ophanim/operate/stages.mjs` validate (acceptance and regression commands); the review runner's agy and grok reviewers (`pantheon-test`, `pantheon-suite-*`); the API runner's `run_tests` and `run_suite` (`--inline`).
- The agy CLI itself (credential-bearing), every launch in the worker's jail, allowlist and argv checks: `board/agy-cli.mjs` `runAgyWorkerTurn` (the worker, the agy reviewer), `runAgyPreflight` (its subcommands; also `ophanim/operate/live-run.mjs`), `runAgyCliTurn` (the single-turn seats: `sdk/agy-turn.mjs`, `board/run-item.mjs`), and `agy/quota.mjs` `probeQuota`. Outside `pantheon/src`: `scripts/agy-worker-probe.mjs` and `scripts/agy-smoke.mjs` run `agy --version` with the minimal env, unjailed (fixed argv, no model, no worker text); `scripts/agy-layout-bisect.mjs` runs its own diagnostic layouts on the owner's request.
- The Antigravity SDK bridge (holds no credential; since 2026-11-19): `antigravity/turn.mjs` spawns `python antigravity-bridge.py` in the worker's bwrap profile with the home's credential dirs covered and an allow-listed environment; the launcher's dry run also runs `python antigravity-bridge.py --identity --hash` unjailed (fixed argv, no model, no worker text).
- Already isolated by its own allowlist jail: `board/acceptance.mjs` (`--unshare-all`, `/usr` only, `--clearenv`).
- Trusted programs on trusted input, not worker code: `git.mjs` `git`, `board/operate.mjs`, `operate/context.mjs`, `evidence-recovery.mjs`, `live-run.mjs` (git, the child entry), `board/run-item.mjs` (the python SDK seat, `process.env` whole: a separate, opt-in transport, `PANTHEON_AGY_TRANSPORT=sdk`, recorded here as not jailed), `seat/conformance.mjs` (`--help`), the `sandbox.mjs` probe, `review-runner/index.mjs` git.
- A reviewer CLI with its own sandbox and no test: the review runner's codex transport (codex's bwrap under the runner's permission profile; node denied).

## The Google implementer on the Antigravity SDK transport (owner direction 2026-11-19)

Owner direction: the Google **implementation** transport is the official `google-antigravity` Python SDK on the Gemini API with `GEMINI_API_KEY`. No subscription OAuth, no `agy` CLI, no ACP or CLI wrapper. The assignments apply to Google implementation routing only; planning, investigation, dispatch and review seats are unchanged.

**Routing** (`pantheon/src/config/antigravity-sdk.json`, read by `pantheon/src/route/fit-matrix.mjs`; no call site types a model id).

| Difficulty | Implementer | Thinking level sent | Hydrogen subagents live at once, at most |
|---|---|---|---|
| hard | `gemini-4-carbon` | `high` | 8 |
| medium | `gemini-4-neon` | none (no level of it is recorded here, so the provider's default applies) | 4 |
| easy | `gemini-4-hydrogen` | `medium` | 0 (no delegation) |

- A seat is `{vendor: "agy_google", model, transport: "antigravity-sdk", effort}`. `isSdkSeat` (`antigravity/config.mjs`) is the one test of it. `pipelineTurns` sends such a seat to the SDK transport and every other implementer seat down the lane path; an SDK seat asked as a single turn is refused (`SDK_SEAT_NOT_SINGLE_TURN`).
- **Selection stays capability-based.** The selector's admission (a documented context window against the estimate), the class floors, a ticket's pin and an operator's override all still apply. `gemini-4-neon` has no recorded window, so the selector excludes it whenever a context estimate is given and says why; the pipeline, which seats a unit by difficulty, asks the provider instead (next point).
- **Availability is asked, not assumed.** Before a session's first request the gateway asks the Gemini API for the model (`GET /v1beta/models/<model>`), and for the subagent model when the unit may delegate. What it answers is on the session record (`availability`).
- **No silent substitution.** A model the provider does not serve fails the attempt as `MODEL_UNAVAILABLE`. The unit then steps to the next rung of its ladder, skipping the same model's other thinking levels (`skipped_same_base`), and that step is an `escalations[]` record with cause `model_unavailable` beside the `lane_failures[]` entry. A quota refusal (HTTP 429) steps the same way with cause `quota`. An exhausted ladder blocks the unit (`LANE_LADDER_EXHAUSTED`); nothing else answers in its place.
- **Who answered: the model guard** (register L-504 invariant 3, the rule `board/agy-cli.mjs` states for the CLI, at this transport's entry point). The gateway reads the provider's `modelVersion` on every response. Before any result of the session is acted on, its answer, its failure classification or its quota refusal, every answered request is checked: the name must resolve, under the identity policy, to the model that request asked for. An answer under another declared model, under a name the policy does not declare, or under no name at all refuses the session with `AGY_MODEL_MISMATCH` and both identities. That is not a lane failure: the attempt is not retried, no rung is stepped, and the unit blocks with the session's record kept. The model asked is never recorded in the place of a name the provider did not give; a kept attempt's `served_model` is always the provider's own name (`served_model_source: "provider"`).
- **An SDK session is a primary seat of the Gemini billing policy** (owner decision 2026-11-19, register L-136; [docs/billing-policy.md](billing-policy.md)). `gemini_api_primary` is off unless the launcher declares it with a budget of billed requests (`--gemini-api-primary N` on `operate tick`, `watch` and `serve`; `billing.gemini_api_primary` with `billing.gemini_primary_budget` in the live-run manifest). The policy is asked before the transport is entered: off, or the budget spent, and there is no gateway, bridge, admission or charge (`GEMINI_PRIMARY_DISABLED`, `METERED_GEMINI_BUDGET_EXHAUSTED`). Declared, every billed request of the session, a native subagent's included, is admitted by the policy and recorded on the billing ledger before the gateway forwards it; a budget that runs out inside a session refuses that request and ends the session. The failover setting neither enables nor disables the seat, and the presence of `GEMINI_API_KEY` never stands for either.
- **A fault no rung can cure blocks the unit at once**: `CREDENTIAL_REFUSED` (the provider rejected the key), `NO_API_KEY`, `SANDBOX_UNAVAILABLE`, `SDK_UNAVAILABLE`, `SDK_VERSION`, and the billing policy's two refusals of the seat. The lifecycle reports it by name (blocker `IMPLEMENTER_TRANSPORT`) instead of walking the ladder; for a refusal of the billing policy the scheduler then holds the stage pending on that refusal and wakes it when the launcher's policy changes.

**The transport** (`pantheon/src/antigravity/`; no pipeline module imports the SDK).

- **The bridge** (`pantheon/scripts/antigravity-bridge.py`) runs the SDK's agent and decides nothing. It runs in the worker's bwrap profile: the host read-only, the unit's worktree and the control dir's `run/` writable, a PID namespace of its own, other units' control dirs hidden. The home's credential-bearing directories (`.ssh`, `.gemini`, `.codex`, `.config`, `.local/share`, …) are empty to it; the SDK's own venv is bound back read-only. Its environment is an allow-list with no key and no proxy. Without a usable bwrap the session does not start (`SANDBOX_UNAVAILABLE`) unless the caller allowed an unjailed one, which is recorded.
- **The model gateway** (`gateway.mjs`) is a loopback HTTP server inside the controller. It alone holds `GEMINI_API_KEY`. The bridge is given the gateway's address and a per-session token; the gateway checks the token, admits each generation request against the run's provider-call bound before forwarding it, puts the real key on the forwarded request (`x-goog-api-key`), and refuses any model that is not the implementer's or the pinned subagent model.
- **Tool decisions** (`turn.mjs` `toolDecision`, fail closed). A call is decided only on exactly the argument names its tool declares: the runtime also reads other spellings of a declared name (`commandline` as `CommandLine`, `subagents` as `Subagents`), so any other key refuses the whole call (`ARGS_UNDECLARED`). The table of declared names is in the transport's config, and the contract suite compares it with the installed runtime. Reads resolve inside the unit's worktree. Writes are checked against the unit's owned paths before they happen. The implementer's one command is the unit's verify launcher, which runs `verify_cmd` in the verify jail (no credential, no host file, no network), once: a persistent terminal, or the terminal of an earlier command, is refused. A subagent runs no command; a read-only specialist, and a child the controller cannot attribute to an admitted subagent, write nothing. A tool the table does not name is denied. Every decision is on the session's tool log (`<control dir>/sessions/<n>.tools.json`, bound by digest in the attempt record). The pipeline's post-turn write jail still judges the worktree from disk.
- **Cancellation.** The caller's signal stops the bridge's process group and aborts the gateway: a request in flight is cut and nothing is forwarded afterwards.
- **Structured output.** A schema becomes the runtime's `finish` tool; its arguments come back as `structured_output`.
- **Version.** The SDK is pinned with hashes (`pantheon/scripts/antigravity-requirements.txt`, `google-antigravity==0.1.24`). Another installed version is refused at launch (`SDK_VERSION`) until the contract suite has passed on it.

**Native subagents** (`subagents.mjs`, the governor; the types are in the config).

| Type | May write | Tools |
|---|---|---|
| `code-explorer`, `dependency-analyst`, `context-retriever` | no | `view_file`, `list_directory`, `search_directory`, `find_file` |
| `test-constructor`, `bounded-implementer` | the unit's owned paths only | the read tools, `create_file`, `edit_file` |

- Every type is configured with the model `gemini-4-hydrogen`. A subagent is created when the implementer invokes one with a role and a specific assignment; the ceilings are limits, not team sizes, and the implementer prompt says so.
- **The limits are enforced by the controller, at two independent layers.** (1) The SDK's pre-tool hook for `invoke_subagent` is decided by the governor: a type the controller did not pin (`SUBAGENT_TYPE_NOT_PINNED`), a type the unit does not allow (`SUBAGENT_TYPE_NOT_ALLOWED`), a model or tier named on the invocation (`SUBAGENT_MODEL_OVERRIDE`), a workspace of its own (`SUBAGENT_WORKSPACE`), a call from a child (`SUBAGENT_RECURSION`), an assignment that is not specific (`SUBAGENT_ASSIGNMENT`), any call by a Hydrogen implementer (`SUBAGENT_NOT_ALLOWED`) and a call that would pass the ceiling (`SUBAGENT_LIMIT`) are refused whole and recorded. (2) The gateway refuses, on the wire, a subagent request for any model but Hydrogen and any child session past the ceiling, whatever the hook admitted.
- **What is counted.** Every subagent admitted in an implementer session holds its slot until that session ends. The runtime lets a parent wake an idle child with no hook and no policy firing, and reports no event when a child is ended, so no state the controller observes proves a child cannot run again. The bound enforced is therefore "admitted in this session ≤ ceiling", which is stricter than "concurrently active ≤ ceiling" and implies it. An implementer gives an idle subagent its next task rather than replacing it.
- **The record**, per subagent: id, type, role, scope, tool permissions, model, the invoking call, admission time, the assignment's digest and size, its trajectory, every state it went through, its usage, its output's digest and size, and any error. Rejections are kept with their code, the count live and the ceiling. A child trajectory the controller cannot attribute is listed, never dropped. Assignment and answer text are not kept.
- **Contribution lineage.** A written attempt's subagents are `subtask` contributions of the run (`pipeline/record.mjs`): one row per unit and per name the provider answered a subagent request under, so the pinned model and every served name are excluded from every later review of the work. A subagent that was admitted and never answered is one row with no served name, marked `unnamed`. The gateway also records the names by specialist type (`served_by_type`), which is what a required-subagent receipt counts. An approved unit's checkpoint keeps its subagent receipts (`native_subagents`); a resumed run restores them marked `from_checkpoint`.
- Grok is no longer spent on Google implementation delegation: the `fit` subagent row is native Hydrogen, and the A2A relay is opened only for a unit that still has a lane rung.

**What is shown, and against what.**

- `pantheon/tests/antigravity-sdk-contract.test.mjs` runs the real bridge, the installed SDK 0.1.24 with its bundled runtime, the real controller and the real jails against a **scripted provider** on loopback. It shows: the runtime's requests carry the controller's key and never its own token; a Carbon implementer's subagents send their requests to `gemini-4-hydrogen`, each in its own session; the pin holds against a model or tier named on the invocation; `define_subagent` is not offered and an unpinned type cannot be invoked; nine subagents in one call are refused whole and eight run; a Neon implementer's fifth is refused; writes and the one command go through the controller; a second spelling of `CommandLine` or of `Subagents` does not run what the controller never judged; the declared-names table matches the runtime's; a stop cuts a session with subagents in flight; 429 and 404 end the turn by status; structured output; the session budget; and that nothing the runtime wrote holds the key or the token. Without the SDK or bwrap each of these tests is skipped as UNVERIFIED, never passed.
- `pantheon/tests/pipeline-antigravity-sdk.test.mjs`, `antigravity-turn.test.mjs`, `antigravity-gateway.test.mjs`, `antigravity-subagents.test.mjs` and `fit-sdk-routing.test.mjs` pin the controller's side, the model guard and the primary-execution setting included; `ophanim/operate/sdk-intake.mutate.mjs` mutates it (ceilings, pins, the key path, charging, the ladder, the jail, the guard, the setting, the prompt intake) and fails on any mutation the suites let through.
- **Not shown: anything about the live Gemini API.** No request of this transport has reached Google from this repository's sessions: authentication with a real key, whether the three models and `gemini-3.8-flash`/`gemini-4-argon` are served to that key, the name the provider reports for each, the wording of a quota refusal, and the model a child is actually served by are UNVERIFIED (register L-701). `ophanim/operate/live-run.mjs` asks exactly these questions in its dry run (`sdkPreflight`) and records the answers.

**What still uses the `agy` CLI.** Only seats outside Google implementation routing, and an explicit lane seat: the single-turn Gemini seats of other roles (planner, reviewers, validator through `laneFirstTurn`), the `argo`/`legacy` per-file board's Antigravity seats, the review runner's agy reviewer, and an implementer seat that names an Antigravity lane by hand. The CLI worker path is kept for those and is not retired by this change (register L-703).

**The per-file board under `fit`.** `runOpenItem` runs one tool-less turn per file, not a session, so it cannot run an SDK seat. The selector gives it the matrix's model as one Gemini API turn (`boardSeat` in `route/frontier.mjs`: `transport: "api"`, no lane in front, no metered failover behind), and a seat that still names the SDK transport is refused there before any call (`SDK_SEAT_NEEDS_PIPELINE`). On that path there are no native subagents and no ceilings to enforce.
