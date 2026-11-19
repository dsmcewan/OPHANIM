# Review independence: three labs, and which contributors are excluded

Owner direction, 2026-11-17. **Status, 2026-11-18: ON by default for `fit` workflows, by the owner's decision; other profiles keep the lab rule.** The independent review requested earlier has not happened yet. Earlier status: implemented and tested with scripted reviewers; not active. The lab rule is still in force everywhere. The new rule is switched on only by the owner, after another lab has reviewed this change.

## Two rules that were one

| Rule | Before | Now (contract `pantheon.cycle/v3`, when asked for) |
|---|---|---|
| The panel | Three distinct labs | Three distinct labs. Unchanged, on every contract. |
| Who is excluded | Every model of any lab that contributed | The models that contributed. A lab is excluded outright only when a contribution from it names no model the configuration can identify. |

With four labs, the old pairing left room for one contributing lab at most. A model plan and an implementation from two labs left two reviewer labs, so no item could finish.

## What counts as the same model

`pantheon/src/review/identity.mjs`; the rules are built from `config/model-identity.json`, `config/models.json` and `config/lanes.json`. A contributor is a model, and it stays that model whatever reaches it:

- **Effort and thinking variants.** `claude-opus-4-6-thinking` is `claude-opus-4-6`; `gemini-3.8-flash-high` is `gemini-3.8-flash`.
- **Aliases and lane names**, as declared in the rules.
- **Dated snapshots.** A trailing `-YYYYMMDD` is dropped.
- **Routes.** A model's lab is the lab that made it, never the vendor that served it. `claude-opus-4-6-20261117` answered through the Google route is `anthropic/claude-opus-4-6`, the same identity as through Anthropic.
- **Sessions and retries.** Identity has no session in it.
- **Requested and served.** A turn excludes the model it asked for and the model that answered.

**Unresolved names are never guessed.** A name the rules do not declare has no identity and no lab; its lab is not inferred from the route. A direct vendor can only serve its own lab's models, so any other pairing is unresolved too.

- **An unresolved contributor** means nobody can be shown not to be it. No panel qualifies and the review is pending until the name is declared.
- **An unresolved reviewer** does not qualify. This applies to the model asked for and to the model that answered, and the two must be of the same lab. The response is kept on the ledger and the attempt is recorded as failed with the reason; it is not counted as a review.
- **An answer that does not name the model that served it** does not qualify (resolver 2, below). The name asked for is never used in its place.
- **A contribution that names a lab and no model** excludes that lab, as an explicit statement.

## The identity policy is pinned to each cycle

Everything that decides "which model is this, and which lab made it" is one value: the same-model map, the lab of every declared model, the lab of each direct vendor, the list of route vendors, and the snapshot rule.

- A v3 cycle **records the whole policy and its digest** (`identity_policy: {digest, rules}`), plus the raw contributor names it was opened with (`contributors`).
- **Every check of that cycle uses the recorded rules**: who may review, which lab a review counts for, the seat's lab, cold review, the close. The configuration files are not read.
- So **editing the rules later cannot change a recorded ledger's validity.** The test replays a recorded ledger in a fresh process over changed alias rules, and it verifies as before.
- **A later correction is new evidence.** `reassess` reports which recorded reviews would not qualify under another policy. `work.recordReassessment` records that on the work ledger, naming the cycle, the policy it recorded and the policy it was reassessed under. Nothing in the cycle's own ledger or the item's status changes. What the lifecycle then does is in "After a reassessment" below.

## How a panel is chosen

`reviewSeatsByModel` in `pantheon/src/ledger/review-cycle.mjs`:

1. One seat per lab, three labs.
2. Labs that contributed nothing are seated first.
3. Remaining seats come from labs that did contribute, each with its first model that did not. There is no fixed limit on such seats.
4. A seat that shares a lab with a contributor is marked `shared_lab`, with the contributing models of that lab. The cycle's close lists the shared labs (`shared_labs`), and the stage record carries them.
5. Fewer than three labs with an eligible model: no panel. The review is `REVIEW_CAPACITY_PENDING` and the work is kept, as before.

The contribution history is carried through revisions unchanged: the plan, the work, every critique whose findings reached a revision, and the contributions of any plan a revision revises.

## The ledger

- **`pantheon.cycle/v3`** is v2 plus model-level independence. A v3 cycle records `independence: "model"`, `author_models` (identities), `excluded_labs`, `author_labs` (every contributing lab, for the shared-lab record), `contributors`, the identity policy with its digest, and `required_reviewers` (never below 3).
- **Enforced by the ledger itself**, not only by the selector: a review or an attempt by a contributing model is refused under any of its names; two reviews from one lab are refused; a close needs three distinct labs.
- **Cold review** is versioned the same way. Under v1 and v2 no reviewer's lab may be in the lineage of what it reviews. Under v3 no reviewer may be one of the models in that lineage.
- **History.** A cycle is verified under the contract it was opened under. v1 and v2 cycles validate, close and hash exactly as before; the existing Pantheon suite passes unchanged. A v2 cycle cannot carry v3's fields.
- **The status ledger is untouched.** A Resolved status still needs a verified close by three distinct labs.

## Activation

Nothing opens a v3 cycle unless a caller asks:

- `ophanim/operate/stages.mjs` exports `REVIEW_INDEPENDENCE = 'lab'`. The lifecycle uses the model rule only when that constant, or `makeExecutors({independence: 'model'})`, says so.
- The execution service and the CLI take no option for it; a config key for it is refused as unknown.
- Pantheon's board runs (`pantheon-board run`) still use the lab rule.

To activate after review: set `REVIEW_INDEPENDENCE` to `'model'`. That is a one-line, owner-made change.

## What the tests show

All reviewers, validators and workers are scripted. No provider was called. These tests show identity resolution and enforcement; they do not evaluate any model, and nothing here shows that a same-lab reviewer judges independently in practice.

The inventory is the real one: 5 Anthropic, 3 OpenAI, 2 xAI and 2 Google models in the seating tables. No synthetic lab is used and no panel is smaller than three.

`pantheon/tests/review-model-independence.test.mjs`:

- an Anthropic plan and OpenAI code leave a three-lab panel: xAI and Google first, then one sibling seat, recorded as shared;
- repeated revisions: contributions come to span all four labs and a three-lab panel still forms, every seat shared; the sequence ends **pending** once fewer than three labs have a model left;
- the ledger refuses a contributor named directly, through an effort lane, or as the model that served another request; refuses two seats of one lab; refuses a requirement below three;
- a v2 cycle on the same ledger still refuses the contributing lab, and both verify.

`pantheon/tests/review-identity-policy.test.mjs` (the corrections after the review of `b9fa745`):

- the resolver gives one identity and one lab through every route, alias and snapshot, and no lab to an unresolved name;
- a contributor answering through another route under a snapshot name is refused, and the cycle does not close;
- an unresolved answering model is refused, with the response kept and the failed attempt recorded;
- a recorded ledger replayed in a fresh process over changed alias rules verifies as before, and the correction is reported as new evidence.

`ophanim/operate/independence.test.mjs` and `validator-identity.test.mjs`, the lifecycle on the four real labs:

- an item without a ticket and one with an existing ticket go from plan to an outcome the owner can apply; under the lab rule the same items wait at implementation;
- two revision cycles: by the second, contributions come from all four labs and each later panel is three labs of models that never contributed;
- a later alias correction is recorded as a reassessment while the closed cycle still verifies;
- a validator answer served by a contributor, or by an unresolved model, is not accepted: it is kept with the requested and served names and the reason, and the next eligible seat is asked. When no acceptable answer is found the item does not reach an outcome;
- an in-run code-review finding followed by a code revision (below).

`pantheon/tests/review-admission.test.mjs` and `ophanim/operate/revision-reassessment.test.mjs` (the corrections after the review of `10cbd52`). The second file labels each test LIFECYCLE or BOUNDARY:

- LIFECYCLE, default routing: finding, revision by the same worker model, restart of the process, outcome; with and without a ticket;
- LIFECYCLE, default routing: repeated findings end `blocked` with every finding kept;
- LIFECYCLE: validator answers with a missing, empty or blank served model are kept and never accepted;
- BOUNDARY (injected stage records): exhausted validator capacity is `pending`;
- LIFECYCLE: reassessment, re-review of active work with and without a ticket, and a Resolved item left alone.

These tests use APIs added by the corrections, so they do not load on `10cbd52`. The defects were shown on `10cbd52` by the appendix's probes; the same probes, with their defect-asserting checks made non-fatal, now report the corrected behaviour.

## Corrections after the review of `b9fa745`

Each was reproduced on a checkout of `b9fa745` before it was fixed.

| Defect | On `b9fa745` | Now |
|---|---|---|
| 1. Identity policy not pinned | After an alias rule changed, a fresh process refused to open the recorded ledger: a recorded review re-derived as a contributor. | The cycle carries its policy; replay uses it. A correction is a recorded reassessment. |
| 2. Unknown reviewer qualified | A review served by `grok-9-unreleased` was accepted and the cycle closed verified. | Refused; the response is kept and the gap recorded. |
| 3. Lab taken from the route | `claude-opus-4-6-20261117` through the Google route resolved to `google/claude-opus-4-6`. A cycle with that response, by the model that wrote the plan, closed verified on "google, openai, xai". | Resolved to `anthropic/claude-opus-4-6` on every route. That review is refused. |
| 4. Validator not rechecked | An `accept` served by a contributing or unknown model passed validation with `independent: true`. | The answering model is checked before the judgment is read. The accepted record names both models. |

## Corrections after the review of `10cbd52`

Starting commit `10cbd52` (the reviewed commit; the branch had not moved). Each finding of the reproduction appendix was reproduced there first, with the appendix's own probes, which ran to completion in this environment.

| Finding | On `10cbd52` | Now |
|---|---|---|
| 1. Unnamed answering model | A validator answer with no served model passed with `independent: true` and the item reached `outcome`. A cycle whose three reviews had `served_model: null` closed `verified`. | Not admitted, by the validator and by the ledger. Each response is kept with the reason. The next eligible seat is asked within the stage budget; otherwise the cycle stays open or the stage fails without an outcome. |
| 2. Weaker fallback at exhausted capacity | With every declared model a contributor, validation passed with `independent: false`, judged by contributing `grok-4.7`. | The fallback is removed. The stage is `pending` with `REVIEW_CAPACITY_PENDING`; no contributor is asked; the commit and test results are kept. |
| 3. No revision under default routing | At the top model and top effort, a rejection was a terminal `stop`. The next attempt started a fresh run without the finding. | Escalation protocol v2 answers with `revise` by the same seat, bounded. The run is resumed with the finding, across a restart of the process. |
| 4. Reassessment had no effect | The gate stayed at `validate` and the disqualified review was reused. | The review, and the validation and outcome resting on it, are not reused. Active work is re-reviewed once. A Resolved item is marked `reverification-needed` and left alone. |

### 1. Selection and admission are separate checks

- **Before a call** (`candidateIdentity`, `candidateRefusal`): is the model about to be asked resolvable, and is it a contributor? Only the requested name exists, so only it is checked.
- **After a call** (`reviewerIdentity`, `reviewerRefusal`): which model answered? The answer must name it. A missing, empty or blank `served_model` is refused with `NO_SERVED_IDENTITY`.
- **Versioned.** The rule is resolver 2 of the identity policy, and the resolver number is part of the policy each cycle records. A cycle recorded under resolver 1 is still checked under resolver 1, where an unnamed answer counted as the model asked for. Such a cycle on a ledger verifies as before (tested).
- **The validator** applies the same check under both independence rules.

### 2. Validator capacity

The validator excludes the full contribution history: the plan, the work, every critique whose finding reached a revision, and the change reviewers. If no seat is left it waits.

**Reachability.** The exhausted state was reached only by the appendix's injected fixture, which supplies a contributor list naming every declared model. In a complete lifecycle I did not find a path to it: validation runs only after a passed change review, and a passed review means three labs each still had a non-contributing model at that point. The three reviewers then become contributors, and the cases I enumerated on the real inventory still leave at least one eligible validator model. This is an argument from the inventory and the stage order, backed by the lifecycle tests. It is not a proof over every sequence of revisions, so the capacity block is kept and tested at the boundary.

### 3. Revision at the top of the dial

- **Two separate questions.** "May this work be revised again?" is a count of steps (`MAX_STEPS`, 4 per slot). "Is there a stronger model or a higher effort?" is the dial. Protocol v1 asked only the second; with nothing higher it stopped.
- **Protocol v2** (`pantheon.escalation/v2`): a rejected critique with nothing higher is `revise` by the same seat. The same model revising is the same identity; no new contributor is created. Past the step bound it is `stop`.
- **Versioned.** Each escalation record names its protocol and is re-derived under it. v1 records verify as before. The lifecycle asks for v2; `pantheon-board run` is unchanged.
- **Only critiques.** An acceptance failure at the top of the dial still stops under v2. Repeating the same model at the same effort against a failing test has no new input.
- **Resumed, not restarted.** The stopped run, its rejected file, the finding and the reviewer are on the board and the stage record. The next implement attempt resumes that board. A test runs the resuming tick in a separate process.
- **Accounting.** Each attempt is charged its own calls. The sum over attempts equals the calls made, across the restart.

### The in-run checker under the model rule

When the lifecycle runs under the model rule it now asks the run for the same rule (`runOpenItem({independence: 'model'})`):

- The in-run reviewer is chosen from candidates that are not contributors, labs that have not contributed first.
- **A reviewer whose finding reached a revision does not review the revised file.** It also joins the contributors of the change, so the change review and the validator exclude it.
- The in-run answer must name its serving model. A rejected answer is kept in `run.review_rejections`, and the next candidate is asked.
- The review on the run ledger records `independence: "model"` and its identity policy. Cold review of that entry is re-derived by model. Entries without it use the lab rule as before.

**When the limits run out.** The stage ends `blocked` with `IN_RUN_REVIEW_UNRESOLVED`. The record keeps every finding with the reviewer that made it, and the run with its rejected work. It is not dispatched again on the same inputs.

**Limits found, not worked around:**

1. **Default routing has two in-run reviewer candidates** (`xai/grok-4.7`, `agy_google/gemini-4-carbon`). So at most two rounds of in-run findings fit; the third is the blocker above. More rounds need more configured reviewer candidates, which is a routing decision.
2. **Antigravity returns no model name.** See "Antigravity" below for what was decided.

### Antigravity: Gemini only, and the output carries the input model

Owner direction, 2026-11-17, after the documentation and the owner's `agy models` output were checked.

**Background.** The vendor name `agy_google` covers two paths:

- **The Gemini API**, for frontier Google models (`gemini-4-carbon`). Each response names its model (`modelVersion`). Nothing changes here.
- **Antigravity** (the `agy` CLI and the `google-antigravity` SDK agent), for every other `agy_google` model. It is an agent harness: a turn is several model calls and tool calls, and what comes back is text, usage and a stop reason. Google's documentation shows no field naming the model that answered. The CLI's `init.model` is the `--model` override echoed back.

**Decision 1: Antigravity serves Gemini models only.**

- The identity policy (resolver 3) records `route_labs: {agy_google: ["google"]}`. A seat on that route for a model of another lab is not asked, and an answer from one is not admitted.
- The Antigravity transport refuses a non-Google model before any call (`AGY_GEMINI_ONLY`).
- The three seating rows that ran Claude through Antigravity are removed (planner `claude-sonnet-4-6` and `claude-opus-4-6-thinking`, implementer `claude-sonnet-4-6`). Those ids are also no longer offered: the owner's `agy models` lists Claude 5.5 only.
- The two lane declarations stay in `lanes.json`, marked `retired`, so recorded ledgers still resolve those names to the Anthropic lab. A retired lane cannot be pinned or dispatched.
- Contributors are still resolved by model. A recorded Claude contribution that came through Antigravity still excludes that model.

**Decision 2: the Antigravity output carries the required input model.**

- The model is a required input of every Antigravity call. The transport now records it as the output's model: `served_model: <input model>`, with `served_model_source: "input"` on the run's turn and on the ledger turn.
- The marker matters. It says the name is the pinned input, not a statement by the provider about that answer. A turn without the marker was named by its provider.
- What supports it: the CLI lane compares the model the CLI reports at start-up with the one requested and fails on a mismatch, and headless mode fails on an unknown model instead of falling back. What it does not cover: subagents inside the turn.
- The identity policy itself never fills in a model. An answer that reaches admission with no served model is still refused on every route.

**Decision 3: the Gemini ids are seated through Antigravity.** From the owner's `agy models` output:

- **Declared as lanes** (`lanes.json`, CLI transport, lab google): `gemini-4-carbon-{low,medium,high}`, `gemini-4-argon-{low,medium,high}`, `gemini-4-hydrogen-{low,medium,high,xhigh}`, `gemini-3.8-flash-{low,medium,high}`.
- **Identity.** Each lane name is its base model at a thinking level. `gemini-4-carbon-high` through Antigravity is `google/gemini-4-carbon`, the same identity as Carbon through the Gemini API. A contributor under one name is excluded under the other.
- **Seated** as appended, unbanded fallbacks, so no existing pick changes: planner `gemini-4-carbon-high`; implementer `gemini-4-carbon-high`, then `gemini-4-argon-high`. The other ids are reachable by a ticket pin and by the `fit` profile.
- **Single-turn seats** (planner, reviewers, validator) on a lane now run through the `agy` CLI (`pantheon/src/sdk/agy-turn.mjs`). Before this, a lane name chosen for such a seat would have been sent to the Gemini API, which does not know it.
- **Not seated: the two Orchestrator ids.** The documentation describes each as two models working in one conversation (a planner model plus Gemini 4 Hydrogen). One answer has no single identity, so they are left undeclared and cannot be seated.
- **Not seated: Hydrogen.** It is declared, but the project requires a recorded context window for every seated model, and no figure exists for it, even by inference from the Gemini API.
- **Context windows.** Antigravity's documentation states no context window for any model. Under the documented-window rule, a lane without a cited window is excluded whenever the work has a context estimate. In practice these seats are admitted only when no estimate is supplied, until a window is cited for the lane.
- **Default (`argo`) routing is unchanged.** Carbon there still goes to the Gemini API.

**Decision 4 (owner direction, later on 2026-11-17): Gemini goes through Antigravity first; the Gemini API is a quota failover.** This supersedes the last three points of decision 3 and the scope note below where they differ.

- **Lanes first, under `argo` and `fit`.** A policy seat for a Google model starts on its Antigravity lane (`-high` unless the seat carries an effort). The metered Gemini API id of the same model stays in the order only as that lane's quota failover: it is reached only after the lane was refused for quota (HTTP 429 or a quota-exhausted code, as `packages/model-client` `classifyFailure` classifies it). Any other lane failure does not reach it. See `docs/routing-task-profile.md`.
- **Recorded.** A turn the API answered as quota failover carries `quota_failover` (the lanes, the refusal it followed) on the turn, its attempts and its `selection`.
- **Hydrogen is seated.** `gemini-4-hydrogen` is in the catalog on the owner's statement: window 1048576, max output 65536, thinking low, medium, high, xhigh. The source recorded is the owner's statement; no vendor page was read.
- **Lane windows.** Every live lane now carries a cited `window`. Hydrogen's is the owner-stated figure. For Carbon, Argon and 3.8 Flash it is the base model's documented Gemini API window, recorded as such, because Antigravity documents none.
- **Single-turn seats** follow the same rule (`laneFirstTurn` in `pantheon/src/sdk/agy-turn.mjs`).
- **Identity is unchanged.** A lane and its API id resolve to one model, so a contributor under one name is excluded under the other. No independence rule is relaxed. The Orchestrator ids stay undeclared.
- **Not verified here.** No live Antigravity turn was made. How the CLI words a spent quota is not documented in this repository; the transport recognises `429`, `RESOURCE_EXHAUSTED` and quota or rate-limit wording, and treats anything else as an ordinary failure.

**Versioning.** Cycles recorded under resolver 1 or 2 carry no `route_labs` and are checked without it. The `served_model_source` field is additive: turns recorded without it hash and verify as before. Escalation records cite the seating they were decided under, so removing seats does not change how recorded escalations verify.

**Scope.** Only in-run turns use Antigravity. The single-turn seats (planner, plan reviewers, change reviewers, validator) call the provider APIs directly, including the Gemini API for `agy_google`, and are not affected by decision 2.

**For the independent review.** Decision 2 relaxes "never substitute the requested identity" for one route, by the owner's decision. The reviewer should judge whether pinning plus a start-up check is enough for a reviewing seat, and whether the SDK lane, which has no start-up check in Pantheon, should be treated the same as the CLI lane.

### After a reassessment

`node ophanim/operate/cli.mjs reassess --item ID` (`ophanim/operate/reassess.mjs`) checks each recorded cycle of the item against the current policy and records what no longer qualifies.

- **Active work.** A disqualified review is not reused, nor are the validation and outcome records after it. The gate returns to that stage in `rereview` mode. The re-review runs once per reassessment, on its own ledger, with a panel chosen under the corrected policy. A disqualified plan review is handled the same way.
- **History.** The earlier cycle is not changed and still verifies under the policy it recorded. Work-ledger entries are not rewritten.
- **A Resolved item.** The gate is `reverification-needed`, a blocker addressed to the decision authority. No status is recorded, nothing is dispatched, and the item is not reopened.

## Activation and the in-run checker

`REVIEW_INDEPENDENCE` is still `'lab'`. Under the lab rule the run uses the lab rule as before. The only change that applies with the policy off is protocol v2 for lifecycle runs, and the requirement that a validator answer names its model.

## Decision 5: the dispatcher is a non-authoring arbiter

Owner governance decision, 2026-11-17. Flagged for independent review. It applies to the five-stage pipeline that `fit` runs (`docs/routing-task-profile.md`, "Five-stage specialist pipeline").

**The rule**

- The Stage 2 dispatcher writes a unit's acceptance rubric and none of the work. It is recorded as an arbiter (`outputs.arbiters`, and `team` with `authored: false`). It is not in `contributions`.
- So, under the model rule, the dispatcher's model is not excluded from reviewing its own unit at Stage 5, which is pinned to that exact model. Since Decision 6 (owner, 2026-11-19) that is the whole exception: the dispatcher is excluded from the later three-lab review and the validator.

**Why the owner chose it**

- The owner wants Stage 5 to be the same OpenAI model as Stage 2: the model that wrote the criteria checks them.
- Under the model rule a contributor may not review. If the dispatcher counted as a contributor, its pinned reviewer would be barred from the unit it must review.
- This is a decision, not something the code proves. Someone who holds that writing the criteria is a contribution will disagree. `[...contributions, ...outputs.arbiters]` is the stricter list to test that view against a recorded run.

**What still becomes a contributor**

- A Stage 5 reviewer whose finding was fed to an implementer revision. It is a `critique` contributor and is excluded from the later three-lab review and from validating.
- A Stage 5 reviewer that only approved is not a contributor.
- The planner, every implementer attempt that reached a worktree (by base model), and every subagent whose answer was returned to an implementer.

**What changes inside the run**

- A Stage 5 reviewer whose finding fed a revision stays that unit's reviewer for the revised work. On the per-file path (`argo`) such a reviewer does not review the revised bytes. This follows from the pin and is part of what should be reviewed.
- The reviewer is raised only inside OpenAI, after repeated rejections. No other lab reviews inside the run.

**What is unchanged**

- The coordinated three-lab change review runs after the pipeline, on three distinct labs, with every contributing model excluded.
- The validator is still independent of every contribution, and its answer is admitted by the model that answered.
- `REVIEW_INDEPENDENCE` is still `'lab'`. Under the lab rule a contributing reviewer's lab (OpenAI) is excluded from the later review, as before.

**Shown by tests** (`ophanim/operate/fit-lifecycle.test.mjs`, scripted seats)

- With approve-only OpenAI seats, no OpenAI model authored anything. (Before Decision 6 an OpenAI model, possibly a dispatcher, could then sit on the three-lab panel; now every dispatcher is excluded and a different OpenAI model stays eligible.)
- After `gpt-6-luna` rejects twice, it is a contributor and is not on the panel; `gpt-6.1-sol`, which only approved, is not a contributor.

## Decision 6: the dispatcher exception is confined to its own unit's Stage 5 review

Owner decision, 2026-11-19, on independent review round 2, assignment 2 (xAI grok-4.7, `77480d6`), question 7. It narrows Decision 5. In force; there is no switch back to the wider exception.

> "Scope the dispatcher exception exclusively to the pinned Stage 5 review of its own work unit, including that unit's bounded revision sequence. The dispatcher remains a non-authoring arbiter. Do not reclassify its rubric as authored implementation. However, its requested and serving model identities must be included in the exclusion set for the subsequent three-lab change review and independent validator whenever its rubric governed any unit in that change. [...] The governing distinction: permission to judge whether one's own rubric was followed does not grant independence to judge whether that rubric was sufficient."

**The rule**

- Stage 5 of a unit is still pinned to that unit's dispatcher model, and still escalates only inside OpenAI. That review, and the unit's revisions, are the whole exception.
- The dispatcher is still a non-authoring arbiter: `contributionsOf(run)` omits it, `arbitersOf(run)` lists it with `authored: false`. Its rubric is not authored work.
- Every dispatcher whose rubric governed a unit of the change is EXCLUDED from the coordinated three-lab change review and from the validator, by its requested model and by its serving model (`ophanim/operate/stages.mjs` `arbiterExclusions`: rows with `purpose: 'arbiter'`, the served model as `model`, the asked one as `requested_model` when they differ). This holds when its Stage 5 review only approved.
- The rows ride with the implement stage's contributions, so they reach the review scope, the v3 cycle's recorded `contributors` and `author_models` (the ledger re-derives the exclusion from them), and the validator's exclusion set. They are checked at seat selection (`candidateRefusal`) and again at answer admission (`reviewerRefusal`, the v3 close, the validator's `servedRefusal`), by canonical identity, never by name string.
- A different model of the dispatcher's lab stays eligible under model-level independence. Under the lab rule, as for any contributor, the dispatcher's lab is excluded.
- The capacity check before work predicts each unit's dispatcher as an arbiter. When no eligible capacity is left the stage is pending (`REVIEW_CAPACITY_PENDING`) with the blocker recorded and the work kept; nothing falls back to an excluded model and the three-lab floor is not lowered.
- The arbiter record is preserved: on the stage record (`outputs.arbiters`, `team`, and the `arbiter` rows), across a resume (a unit resumed from its sealed v3 checkpoint carries the checkpoint's `dispatch` as its arbiter, `from_checkpoint: true`), and on the cycle, which a reassessment reads.

**Not changed**

- The Stage 5 exception does not extend to another unit's later judgment, to the coordinated review, or to validation.
- The pipeline's in-run Stage 5 ladder (`reviewerLadderRefusal`) and the frozen rubric hash are unchanged.

**Shown by tests**

- `ophanim/operate/fit-lifecycle.test.mjs`: the pinned Stage 5 review approves each unit; the three dispatchers are excluded from the panel and the validator although each only approved; the three-lab panel still qualifies and the item reaches an outcome.
- `ophanim/operate/independence-r2-a2.test.mjs`: requested and served identities excluded; a different OpenAI model seated; a resumed unit keeps its arbiter; no fallback when capacity is gone; a v3 cycle records the dispatcher and refuses an answer it served.

## For the independent review

Points worth another lab's attention:

1. **Shared failure patterns.** Two models of one lab may miss the same things. The rule records the relationship and limits nothing. Is a recorded shared-lab seat acceptable on its own, or should a panel need some seats from labs that did not contribute when they exist? Today those labs are preferred, not required.
2. **Undeclared aliases.** Two declared names that are one model, and are not in the rules, would count as two reviewers. The inventory was read for this; the two lane variants found are declared. A reassessment is how a later correction is recorded.
3. **Each cycle carries a full copy of the policy** (about 1 KB). That makes replay self-contained at the cost of repetition.
4. **Capacity is finite.** xAI and Google have two models each in the tables. After both models of a lab have contributed, that lab is out; after that happens to two labs, the review is pending.
5. **Inside a Pantheon run** under default routing there are two in-run reviewer candidates.
5a. **Antigravity turns are admitted on the input model** (marked `served_model_source: "input"`), Gemini only. Is that enough for a reviewing seat, on both lanes?
6. **Protocol v2 lets one model revise up to four times** on critiques alone. Is that bound right, and should it apply outside the lifecycle?
7. **Validator capacity** was not shown reachable in a complete lifecycle; the argument is above and is not a proof.
8. **After a reassessment** the re-review is automatic for active work. A Resolved item waits for the owner.

## Activation for `fit` (owner direction 2026-11-18)

- `makeExecutors` picks the rule with `independenceFor(profile)`: `model` for `fit`, `REVIEW_INDEPENDENCE` (still `'lab'`) otherwise. A caller can still name either rule explicitly.
- The reason: the `fit` pipeline seats four labs (planner, dispatcher, implementer, subagents). Under the lab rule the post-pipeline three-lab panel would always be short.
- Unchanged: Stage 5, the coordinated three-lab change review and the validator. The dispatcher is still a non-authoring arbiter (Decision 5).
- Tests that assert the lab rule's capacity behaviour now name `independence: 'lab'` explicitly.
- Not yet done: the independent review of the model rule. It should still happen.

## Corrections after the review of `09d490f`

Independent review, assignment 2 (OpenAI `gpt-6-astra`), and assignment 1 question 3 (Google). Each regression test below failed on `604d297` (the reviewed code plus the recorded findings) before the fix.

| Finding | On `09d490f` | Now | Test |
|---|---|---|---|
| Q2, Q5. Exclusions not re-derived | A signed v3 cycle recorded contributor `gpt-6-astra` (or an unresolved name) with empty `author_models` and `excluded_labs`; `gpt-6-astra` reviewed it and it closed `verified`. | The ledger re-derives the exclusions from the recorded `contributors` under the recorded policy: an unresolved contributor, `author_models` that differ from what the contributors resolve to, a lab-only contribution missing from `excluded_labs`, or a contributing lab missing from `author_labs` is refused at open. Lab-only contributions are now recorded in `contributors` with their lab. v3 cycles recorded earlier (lab-only contributions absent from `contributors`, the lab in `excluded_labs`) still verify. | `pantheon/tests/review-model-independence.test.mjs` |
| Q5. One-lab cycle opened fresh | `reviewCycle({n: 1})` opened a new default-contract cycle and it closed `verified` on one lab. | A newly opened cycle needs three labs on every contract. The default contract records `required_reviewers`, so the ledger refuses a close on fewer; a new v1 cycle is refused before it opens. Recorded cycles of one reviewer still verify. | `pantheon/tests/cycle-review-labs.test.mjs` |
| Q6, Q8. Lineage lost on checkpoint reuse | A resumed unit had no attempts, subagent calls or reviews, so its implementer, subagent and `fed_revision` reviewer were not contributors. | Checkpoint schema `pantheon.unit-checkpoint/v2` records the unit's authoring lineage; a resumed unit restores it (`from_checkpoint: true`). A v1 checkpoint, or one without an implementer contribution, is not resumed. | `pantheon/tests/pipeline-resume.test.mjs` |
| Q6. Plan revision dropped the previous planner | Inheritance removed every `purpose: 'plan'` row; a changed planner left the old one eligible. | The previous plan's contributions are inherited whole. | `ophanim/operate/plan-lineage.test.mjs` |
| A1 Q3. Plan-review finders lost on resume | Resuming an open plan cycle restarted the contributions from the planner alone. | Restored from the stage record of the attempt that opened the cycle, and from the cycle's own recorded contributors. | `ophanim/operate/plan-lineage.test.mjs` |
| Q7. `specialist_role` unconstrained | Any non-empty string, interpolated into the implementer prompt and outside the rubric hash. | A role name (lower-case words joined by `-`, at most six words and 48 characters), for the planner's units and the dispatcher's answer; the role and the difficulty are inside the frozen `rubric_hash`, which Stage 5 re-hashes. Raising difficulty is still allowed. | `pantheon/tests/pipeline-dispatch.test.mjs`, `pipeline-work-units.test.mjs` |
| Q9. Input marker dropped | The planner's ledger turn kept the served name and dropped `served_model_source: "input"`. | The planner's turn, its served-model contribution, and the pipeline's contribution rows carry the marker. | `ophanim/operate/plan-lineage.test.mjs` |

## Corrections after the review of `77480d6`

Independent review round 2, assignment 2 (xAI grok-4.7). Each regression test below failed on `8e6d5e0` (the reviewed code plus the recorded findings) with the source reverted.

| Finding | On `77480d6` | Now | Test |
|---|---|---|---|
| Q6. Projection dropped a requested model | `dedupe` keyed `purpose\|vendor\|model\|lab`: a call asked as `grok-4.6` and served as `grok-4.7`, then a `grok-4.7` call, left only `grok-4.7`; `grok-4.6` was eligible for the panel and the validator. | The key includes `requested_model`: every identity `contributionsOf` kept stays excluded. | `ophanim/operate/independence-r2-a2.test.mjs` |
| Q6. Board critique row kept the asked seat | A reviewer whose finding reached a revision was recorded as the seat asked; the model that served it stayed eligible. | The pending revision names the served models of the turns whose text it carries, and the critique contributor rows keep `served_model` beside `model`. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q6. Unnamed subagent answer | An answered call with no serving model stored `served_model: null` with no marker. | Recorded as `served_model_source: "unnamed"`; the asked model is the contributor that is excluded. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q9. Board Antigravity guard | Refused a known non-Google model only; an undeclared name was stamped as served (`input`). | Refused, like `agySingleTurn`, unless the name is a declared Google model, before any lane starts. | `pantheon/tests/independence-r2-a2.test.mjs` (two board fixtures now name a declared Gemini model) |
| Q9. `"provider"` by default | `pipelineTurns` `single()` labelled any served name without a source `"provider"`. | The transport's own report is passed on; `liveTurn` marks a name read off the provider's response `"provider"`; a name with no source is `"unknown"`. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q3. Re-ask not admitted | The board in-run re-ask's verdict came from a second turn whose serving model was never checked, and the review cited the first turn. | The re-ask is admitted on its own serving model (`reviewerRefusal` under the model rule; same lab under the lab rule). A refused re-ask supplies no verdict and no text: the slot fails closed. An admitted re-ask that gives the verdict is the turn the review cites. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q5. Raw `openCycle` below the floor | A new v2 cycle opened with `reviewers: 1` and no `required_reviewers` closed `verified` on one lab. | `openCycle` records `required_reviewers: 3` on a new v2/v3 cycle and refuses a new v1 cycle of fewer than three reviewers. Cycles recorded without the field verify as recorded; a recorder made with `historical: true` (tests only; never the system's recorder) writes that shape. | `pantheon/tests/independence-r2-a2.test.mjs`, `pantheon/tests/cycle-review-labs.test.mjs` |
| Q7. Dispatcher exception width | The omission from `contributionsOf` was global: the dispatcher's model could sit on the three-lab panel or be the validator. | Decision 6 (owner, 2026-11-19), above. Under the lab rule the `fit` lifecycle tests now need a second synthetic lab (`SIX`), since the dispatcher's lab is excluded. | `ophanim/operate/independence-r2-a2.test.mjs`, `ophanim/operate/fit-lifecycle.test.mjs` |
