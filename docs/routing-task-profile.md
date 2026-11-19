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
| implementer | `gemini-4-hydrogen-medium` | `gemini-4-hydrogen-high` | `gemini-4-carbon-high` |
| subagent | `grok-4.6` | `grok-4.6` | `grok-4.7` |
| reviewer | the dispatcher's exact model for that unit, pinned | | |

- **Column.** The ticket's difficulty, raised by the profile's class floor when that floor is higher (stakes; ambiguity for the planner). `fast`, `standard` and `frontier` are the easy, medium and hard columns. A floor never lowers a pick. `easy` now carries low stakes by default, so an easy ticket reaches the easy column.
- **OpenAI order.** `classes.json` now places `gpt-6-luna` < `gpt-6-sol` (and `gpt-6.1-sol`) < `gpt-6-astra`. The medium dispatcher is `gpt-6.1-sol`; other OpenAI medium seats stay `gpt-6-sol`.
- **Reviewer.** Pinned to the dispatcher's model. It escalates only inside OpenAI: `gpt-6-luna` -> `gpt-6.1-sol` -> `gpt-6-astra` (`pinnedReviewer`, `reviewerEscalation`). Where a review needs more labs, or OpenAI is excluded for independence, the rest of the order is the class order described above.
- **Implementer ladders** (Antigravity lanes, in order). easy: `gemini-4-hydrogen-medium` -> `gemini-3.8-flash-high`. medium: `gemini-4-hydrogen-high` -> `gemini-4-argon-high`. hard: `gemini-4-carbon-high` -> `gemini-4-hydrogen-xhigh` -> `gemini-4-argon-high`.
- **Rejection.** The lane's thinking level rises first (`hydrogen-medium` -> `-high` -> `-xhigh`; `carbon-high` has none above it), then the next rung of the ladder. The decision is an escalation record (`raise_thinking` or `step_rung`) that carries its ladder and re-derives from it.

Gemini goes through Antigravity first under both `argo` and `fit`:

- A policy seat naming a metered Gemini API id is served by that model's Antigravity lane first (`-high` unless the seat carries an effort).
- The API id stays in the order only as the lane's quota failover. The dispatcher reaches it only after a lane of the same base model was refused for quota: HTTP 429 or a quota-exhausted code, as `packages/model-client` `classifyFailure` classifies it (`pantheon/src/route/quota-failover.mjs`). Any other lane failure does not reach it.
- When the API answers this way, the turn, its attempts and its `selection` carry `quota_failover` with the lane refusal it followed. An unused failover is a `quota_failover.skipped` progress event.
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
3. **Implement** (Gemini through an Antigravity lane). One worker owns the whole unit in the unit's own git worktree and writes the files itself.
4. **Subagents** (Grok). The implementer may ask one stateless question at a time over a local A2A endpoint. A subagent has no tools and no files.
5. **Review** (OpenAI, read-only). The dispatcher's exact model, pinned. It judges the diff and the output of the unit's `verify_cmd`, both read from disk by the controller.

After the pipeline: the same coordinated three-lab change review, the validator and the outcome as before. Stage 5 is the in-run reviewer. It replaces none of them.

**Matrix** (`pantheon/src/route/fit-matrix.mjs`)

| role | easy | medium | hard |
|---|---|---|---|
| planner | claude-sonnet-5 | claude-opus-5-5 | claude-fable-5-2 |
| dispatcher | gpt-6-luna | gpt-6.1-sol | gpt-6-astra |
| implementer | gemini-4-hydrogen-medium | gemini-4-hydrogen-high | gemini-4-carbon-high |
| subagent | grok-4.6 | grok-4.6 | grok-4.7 |
| reviewer | the unit's dispatcher model | same | same |

- The dispatcher, implementer, subagent and reviewer are seated per unit, by the unit's difficulty. A difficulty the dispatcher raises moves the implementer and the subagent with it.
- The plan-stage planner is seated before any unit exists, so it is the medium seat.

**Ladders**

- Implementer, on a rejection: the lane's thinking level first, then the next rung. Easy: `hydrogen-medium -> hydrogen-high -> hydrogen-xhigh -> 3.8-flash-high`. Medium: `hydrogen-high -> hydrogen-xhigh -> argon-high`. Hard: `carbon-high -> hydrogen-xhigh -> argon-high`.
- Reviewer: raised one rung only after two consecutive rejections by the same reviewer, and only inside OpenAI: `gpt-6-luna -> gpt-6.1-sol -> gpt-6-astra`.
- Revisions per unit are bounded (default 3). When they run out the unit is blocked with every finding kept.
- Quota: the metered Gemini API of the lane's base model is used only after the lane was refused for quota (429). It cannot write files, so its whole reply must be `{"files": [{"path", "content"}]}`; the adapter writes those files and the write jail then checks them. Any other reply is a failed attempt.

**Work unit** (`work-units.mjs`; unknown keys are refused)

```json
{"unit_id": "codec", "depends_on": [], "owned_paths": ["src/codec/**"], "difficulty": "medium",
 "specialist_role": "node-esm-library-engineer", "allowed_subagents": [], "verify_cmd": "node src/codec/codec.test.mjs",
 "invariants": ["encode and decode round-trip"]}
```

- A unit is one cohesive multi-file change. Coupled types, implementation and tests stay in one unit.
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

- Every test uses scripted model turns and a fake `agy` CLI. No live model, no live quota and no real `agy` binary has run this pipeline.
- The `pantheon-implementer` role card says the seat has no tools and replies with file text. The pipeline needs a worker that writes files. A tool-enabled card has not been written or tried against the real CLI.
- The implementer is not sandboxed at OS level. The write jail detects and discards out-of-scope writes inside the worktree after the turn. It cannot see or undo a write elsewhere on the machine. The real `agy` process also starts in Pantheon's directory (for its role cards) with the worktree as `--add-dir`.
- Whether the real `agy` sandbox lets the worker reach the A2A endpoint on `127.0.0.1` is not verified.
- `liveTurn` does not forward `extra` (`reasoning.context`) to the provider yet; the adapter passes it and tests check that.
- A lane failure that is not a rejection retries the same lane; the pipeline does not step to another lane on it.
- A pipeline run is not resumed. A stage that is retried starts a new run.
- The run's ledger holds the review cycle only. The pipeline's own record is `pipeline.json`, bound by digest in `run.json`.

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

- A lane failure that looks like quota triggers one `agy -p /quota` probe (`pantheon/src/agy/quota.mjs`). The metered Gemini API is used only if the failure was an explicit 429 or `RESOURCE_EXHAUSTED`, or the probe reads the quota as exhausted. An unreadable report counts as unknown, never as exhausted.
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

Owner direction: worker-controlled code must not be able to obtain or disclose a credential. Per-unit scoping and the subagent call bound are safeguards, not isolation. The enforcing module is `pantheon/src/agy/verify-jail.mjs`; its header states the same invariant.

**Who holds credentials, and who does not.**

- *Credential-bearing (trusted):* the controller (provider keys, the checkpoint seal key, every unit's A2A token), the A2A shim inside it, the agy CLI (the Antigravity OAuth state: the per-run scratch copy of `~/.gemini/antigravity-cli`, token included), and the stdio MCP relay `a2a-mcp-server.mjs` (it reads the unit's A2A token).
- *Untrusted:* every process started from worker-controlled content, that is the unit's `verify_cmd` and anything it runs (scripts, tests, package hooks, children, daemons). This holds whether the worker's `run_command` started it or the controller's `runVerify` did. Worker-controlled code must not read the OAuth token either.

**The invariant.** Untrusted code runs only through the verify launcher, in a fresh bwrap jail, and from inside it cannot reach any credential:

| Channel | What the verify jail does |
|---|---|
| Environment | A clean allowlist (`verifyEnvOf`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `TZ`, CA file variables, and proxy variables without a `user:password`. No secret-named variable, and no `PANTHEON_`, `AGY_`, `ANTIGRAVITY_`, `GEMINI_`, `GOOGLE_`, `OPENAI_`, `ANTHROPIC_`, `XAI_` or `FAKE_AGY_` variable, whatever `PANTHEON_VERIFY_ENV_PASS` lists. `TMPDIR=/tmp`. |
| Filesystem | The outer view read-only, then hidden with an empty tmpfs (or `/dev/null` over a file): `/home`, `/root`, `/run`, `$HOME`, `os.homedir()` and `~/.gemini`. Also hidden: the unit's control dir, which holds `mcp_config.json`, the token file `a2a.token`, the A2A socket and `run/` with the OAuth scratch copy, together with its sibling control dirs (or their dedicated parent), the socket's directory, the agy state dirs, the Gemini layout's mount points, and whatever the caller names (the pipeline names its run dir, the checkpoints and their seal key). `/tmp` is a fresh tmpfs. Bound back: only the worktree (read-write), its git dirs (read-only), the toolchain dirs on `PATH`, the CA files and the resolver file. A bind-back never lies inside a hidden path or a home's secret dirs (`.ssh`, `.gnupg`, `.config`, `.aws`, `.gemini`, `.local/share`, `.netrc`, …), and such a secret dir inside a bound-back path is hidden again. |
| Inherited descriptors | Only 0, 1 and 2 reach the script. bwrap passes inherited fds through (observed with bubblewrap 0.9.0). The launcher is a node process, which marks inherited fds close-on-exec at startup (observed on node 24.22), and `closeInheritedFds` closes any left open. |
| `/proc` of credential-bearing processes | `--unshare-pid` with a fresh `/proc`: agy, the relay and the controller are not visible, so their `environ`, `cmdline`, `fd`, `mem` and `root` cannot be opened, and they cannot be signalled or traced. Also `--unshare-ipc` and `--new-session`. |
| Unix sockets | The A2A socket and its directory are hidden, and so is every path socket under the homes, `/run` and `/tmp`. In this container `/run/sandbox-telemetry/ingest.sock` was reachable until `/run` was hidden. |

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
- **The A2A token is in no environment and no config.** `prepareWorkerWorkspace` writes it to `<control dir>/a2a.token` (mode 0600). `mcp_config.json` names `PANTHEON_A2A_TOKEN_FILE`; agy 1.5.10's `mcp list` was observed to print a server's configured credential. `workerEnvOf` drops every secret-named extra, the token included, and the turn adapter no longer passes it. The relay reads the file once at start and authenticates every call with it. The shim still requires the bearer token and still enforces the unit's role allowlist and call and byte bounds.
- **Is the token still needed?** Only the relay and agy, both credential-bearing, can reach the socket, so the token is now defence in depth. It covers any agy tool path the hook does not know and a run with `allowUnsandboxed`. It is kept.

**Evidence** (`pantheon/tests/verify-jail-credential-isolation.test.mjs`, real bwrap, synthetic credentials, fixture under `/var/tmp` so that no jail's `/tmp` tmpfs hides it by accident):

- A probe in the worktree looks for the dummy A2A token, OAuth token, `OPENAI_API_KEY`, SSH key, gh token, a sibling unit's token and the seal key. It checks its env, every readable file under the homes, `/tmp`, `/var/tmp`, `/run`, `/dev/shm`, `/mnt` and `/srv`, its descriptors, `/proc/<pid>/{environ,cmdline,fd,root}` of every visible process, and every socket it finds.
- It finds nothing when run through agy's `run_command`. In that run the fake agy holds fd 9 on the token file and runs a long-lived process with the token in its env and argv.
- It finds nothing through the controller's `runVerify`. The controller there has the key in its env and fd 3 open on the token file, while a relay-like process and the live shim socket are present.
- It finds nothing when the launcher is started from a shell that holds fd 9 and has the keys in its env.
- Run unjailed, the same probe finds every credential, by env, file, fd, `/proc` and socket.
- In the same worker turn, `ask_subagent` answers twice through the relay. The third call is refused at the unit's bound (`CALLS_EXHAUSTED`), and a forbidden role is denied by the hook. The relay with a wrong token file gets 401, a missing file gets "not configured", and neither reaches a subagent turn.
- Mutations fail these tests: no PID namespace, the control dir not hidden, the launcher passing its own env through.

**Remaining exposure (not closed by this change).**

1. **The network is shared, by design.** The CLI must reach Google, so the verify jail is not `--unshare-net` either. Verify code can reach host loopback services, the LAN, a cloud metadata endpoint, abstract Unix sockets and any path socket outside the hidden roots. It can also send out whatever it can read, though it can read no credential. *Bounded plan:* run the verify jail with `--unshare-net` and a loopback-only namespace. A verify that needs the network (package install) gets an explicit per-unit `verify_network: "egress-proxy"` that routes through an allowlisting proxy. Assess first which planned `verify_cmd`s fetch anything; none in the current fixtures do.
2. **Host files outside the hidden roots stay readable** (read-only, same uid): `/etc`, `/opt`, `/srv`, `/var` (except what the caller names), and the main repository's `.git` (needed for git in the worktree), including a `.git/config` that might carry a remote URL with a token. *Bounded plan:* invert the base from `--ro-bind / /` to an allowlist: `/usr`, `/bin`, `/lib*`, `/etc` minus a denylist, the toolchain prefixes, the worktree, and a sanitized copy of the git config. Measure first which verify commands break.
3. **agy's own tool processes other than `run_command`.** The CLI may run helpers of its own (MCP servers it launches, its `bin/agentapi` shell injection). They run in agy's jail with agy's view, which is the credential-bearing domain. Only the relay is configured, and the hook denies every other tool. An undocumented tool that executes worker-chosen content without passing the hook would bypass the verify jail. *Bounded plan:* the live probe (`scripts/agy-worker-probe.mjs`) records every tool step. Add a check that no process in agy's jail other than agy, the relay and the launcher ran, by listing `/proc` of the jail from a sidecar during the turn.
4. **The review runner's agy reviewer** (`src/review-runner/agy.mjs`, `run_command_policy` kind `node-test`) still runs `cd '<worktree>' && node --test <files>` as agy's child. That code comes from the repository under review, and the reviewer's agy holds the OAuth scratch copy. No A2A token exists there. *Bounded plan:* the same launcher, with one policy per allowed suite command and the hook matching the launcher path plus the suite name. This is about 40 lines plus the replay of its tests.
5. **Same-uid processes outside both jails.** Verify code cannot see them (PID namespace), but a controller crash that leaves the token file behind leaves it in a 0600 file under the run dir, which the next run removes.
