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

**Unresolved names are never guessed.** A name the rules do not declare has no identity and no lab; its lab is not inferred from the route. A direct vendor can only serve its own lab's models, so any other pairing is unresolved too. (Under the lab rule this held only for v3 until wave 2: a lab-rule cycle took `labOf(vendor, served ?? model)`, so an undeclared name got its vendor's lab and any name on `agy_google` the Google lab. A lab-rule cycle the lifecycle or the board's coordinated review opens now pins the policy as `lab_identity` and resolves every lab under it; cycles recorded without it are checked as recorded. Self-audit round 3, assignment 2, L-1/L-204.)

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

The contribution history is carried through revisions unchanged: the plan, the work, every critique whose findings reached a revision, and the contributions of any plan a revision revises. Since wave 2 (self-audit round 3, assignment 2, sealed `449ca42`; owner decision L-001, 2026-11-19) it also holds every model that served one of the planner's retrieval rounds (not only its final answer), and the dispatcher whose structured return of a unit reached a plan revision (`purpose: 'dispatcher-return'`).

## The ledger

- **`pantheon.cycle/v3`** is v2 plus model-level independence. A v3 cycle records `independence: "model"`, `author_models` (identities), `excluded_labs`, `author_labs` (every contributing lab, for the shared-lab record), `contributors`, the identity policy with its digest, and `required_reviewers` (never below 3).
- **Enforced by the ledger itself**, not only by the selector: a review or an attempt by a contributing model is refused under any of its names; two reviews from one lab are refused; a close needs three distinct labs.
- **Cold review** is versioned the same way. Under v1 and v2 no reviewer's lab may be in the lineage of what it reviews. Under v3 no reviewer may be one of the models in that lineage.
- **History.** A cycle is verified under the contract it was opened under. v1 and v2 cycles validate, close and hash exactly as before; the existing Pantheon suite passes unchanged. A v2 cycle cannot carry v3's fields.
- **The status ledger is untouched.** A Resolved status still needs a verified close by three distinct labs.

## Activation

*Superseded on 2026-11-18 for `fit` (see "Activation for `fit`" below): the lifecycle's default profile, `fit`, runs under the model rule; the text below still describes the other profiles.*

Outside `fit`, nothing opens a v3 cycle unless a caller asks:

- `ophanim/operate/stages.mjs` exports `REVIEW_INDEPENDENCE = 'lab'`. The lifecycle uses the model rule only when that constant, or `makeExecutors({independence: 'model'})`, says so.
- The execution service and the CLI take no option for it; a config key for it is refused as unknown.
- Pantheon's board runs (`pantheon-board run`) still use the lab rule.

For the other profiles, activating it is still the owner's one-line change of `REVIEW_INDEPENDENCE` to `'model'`.

## What the tests show

All reviewers, validators and workers are scripted. No provider was called. These tests show identity resolution and enforcement; they do not evaluate any model, and nothing here shows that a same-lab reviewer judges independently in practice.

The inventory is the real one: the seating tables offer 3 Anthropic (`claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5`), 3 OpenAI (`gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`), 3 Google (`gemini-4-carbon`, `gemini-4-argon`, `gemini-3.8-flash`) and 2 xAI (`grok-4.7`, `grok-4.6`) reviewable identities (recomputed 2026-11-19 by resolving every seated name; `gpt-6.1-sol` and `gemini-4-hydrogen` are seated for work only). No synthetic lab is used and no panel is smaller than three.

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

*Corrected 2026-11-19 (owner decision L-002; self-audit round 3, assignment 2, D-A). This section used to say the validator excluded "the change reviewers" and rested its capacity argument on that. The code did not: with equal exclusions the one-seat selector returned the change panel's first seat, so on the default tables the validator WAS one of the three approving reviewers (78 of 78 computed combinations on the routing tables of the brief's base `5a40b3c`; 84 of 84 on `main`'s tables, re-checked 2026-11-21 on `main` (`ba3f038`)), recorded `independent: true` and was told "You did not plan, write or review it". What follows is what the code now does.*

- **Model rule (`fit`).** The validator excludes the full contribution history (the plan and every model that served one of the planner's turns, the work, every critique whose finding reached a revision, the Decision 6 arbiters, the dispatcher of any advisory return) AND every requested and served model of the reviewers of the PASSING change-review cycle. Those identities are read from that cycle's own reviews on its ledger, not from cycle membership elsewhere; reviewers of earlier cycles are excluded only when a finding of theirs reached a revision. They are excluded at seat selection and again at admission of the answer and of each of its retrieval rounds. Among the eligible models a lab outside the review panel is preferred (`reviewSeatsByModel({last})`); a same-lab sibling is used only when no fourth-lab model is eligible, and the record says so.
- **What is recorded.** `outputs.validator.independence`: the rule, the validator's identities and lab, the passing cycle's reviewers (requested, served, lab, verdict) and where they were read from, the panel's labs, `also_change_reviewer`, `contributor`, `fourth_lab`, `shared_lab_with_reviewers`, `shared_lab_with_contributors`, and the scope in words. `independent` is computed (`!contributor && !also_change_reviewer`); it is no longer the constant `true`. The validator prompt's first line is true of the seat asked: "You did not plan, write or review it" only for a seat that did not review the change.
- **Capacity.** When no eligible validator is left the stage is `REVIEW_CAPACITY_PENDING`: the commit, its tests and every answer are kept, the exclusions are recorded, and no excluded reviewer is asked instead. On the default tables of the brief's base `5a40b3c` (78 clean-path combinations, recomputed against this selector) none goes pending and the validator comes from the fourth lab in 60; the 18 others take a same-lab sibling. Pending becomes reachable once earlier finders have used models up (4 of 78 with finders `grok-4.7` and `claude-sonnet-5`). Those figures predate #68, which changed the routing tables (subagents are now `gemini-4-hydrogen`, so `grok-4.7` sits on every panel). Re-checked 2026-11-21 on `main` (`ba3f038`): all 84 combinations form a change panel, none goes pending, the validator comes from the fourth lab in 72 and takes a same-lab sibling in the other 12, and with those finders 8 of 84 go pending (`docs/execution/wave-2a-report.md`, "Re-check on main"). This is a computed enumeration over a constructed grid, not a proof over every sequence of revisions; the pending path is tested at the boundary and through the lifecycle with a reviewer pool of exactly the three panel models.
- **Lab rule (every other profile).** Only the corrections apply: the panel's three labs are exactly the labs that did not contribute, so a validator from a lab outside the panel never exists, and excluding the reviewers' labs would leave none. The validator may be, and on default tables is, one of the approving reviewers; the record says `also_change_reviewer: true`, `independent: false`, and the prompt tells it that it reviewed the change. Validation there is the controller's clean-checkout tests plus one approving reviewer's re-judgment against the requirement, not a fourth independent judgment.

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
- The marker matters. It says the name is the pinned input, not a statement by the provider about that answer. A turn without the marker was named by its provider. Since wave 2 the ledger enforces the vocabulary (self-audit round 3, assignment 2, L-3/L-204): a turn's `served_model_source` is `provider`, `input` (and then the served name IS the requested name), `unnamed` (no served name) or `unknown`; every producer in this repository writes one of these, so recorded ledgers verify as before. The validator's record, its rejected answers and its findings now keep the marker (D-E/L-203).
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

**Scope.** *Superseded by decision 4 (below).* The single-turn seats (planner, plan reviewers, change reviewers, validator) on a Google seat run through Antigravity first (`laneFirstTurn`, `pantheon/src/sdk/agy-turn.mjs`), with the Gemini API only as the lane's quota failover, and decision 2's marker applies to them.

**For the independent review.** Decision 2 relaxes "never substitute the requested identity" for one route, by the owner's decision. The reviewer should judge whether pinning plus a start-up check is enough for a reviewing seat, and whether the SDK lane, which has no start-up check in Pantheon, should be treated the same as the CLI lane.

### After a reassessment

`node ophanim/operate/cli.mjs reassess --item ID` (`ophanim/operate/reassess.mjs`) checks each recorded cycle of the item against the current policy and records what no longer qualifies.

- **Active work.** A disqualified review is not reused, nor are the validation and outcome records after it. The gate returns to that stage in `rereview` mode. The re-review runs once per reassessment, on its own ledger, with a panel chosen under the corrected policy. A disqualified plan review is handled the same way.
- **History.** The earlier cycle is not changed and still verifies under the policy it recorded. Work-ledger entries are not rewritten.
- **A Resolved item.** The gate is `reverification-needed`, a blocker addressed to the decision authority. No status is recorded, nothing is dispatched, and the item is not reopened.

## Activation and the in-run checker

`REVIEW_INDEPENDENCE` is still `'lab'`, but since 2026-11-18 it governs only the profiles other than `fit` (`independenceFor`; "Activation for `fit`" below). Under the lab rule the run uses the lab rule as before; the changes that apply there are protocol v2 for lifecycle runs, the requirement that a validator answer names its model, and since wave 2 a lab identity pinned on every lab-rule cycle the lifecycle opens (below).

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
- The validator is still independent of every contribution, and its answer is admitted by the model that answered. Under the model rule it is also not one of the passing change review's reviewers (owner decision L-002; "2. Validator capacity" above).
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

- **Inside the pipeline**, the exception is the unit's own. A unit's Stage 5 reviewer, whether the pinned rung or any escalation rung, may not be another unit's dispatcher in the same run (the seat that unit is dispatched to, and the model that answered it), nor an authoring contributor of the unit (an implementer whose writes reached its worktree, a subagent whose answer was returned). Only the unit's own dispatcher identity is exempt (`pantheon/src/pipeline/index.mjs` `stage5Keys`). An excluded rung is skipped when the reviewer is chosen (`reviewer_exclusions`, escalation kind `reviewer_excluded`); an answer served by an excluded identity is not admitted (`STAGE5_EXCLUDED`); a checkpoint whose reviewer is now excluded is not resumed. A ladder exhausted by exclusions blocks the unit with `STAGE5_CAPACITY` and the work kept; nothing falls back.
- A Stage 5 reviewer whose finding fed a revision of its own unit stays that unit's reviewer for the revised work (Decision 5): the revision sequence is inside the exception. It is a critique contributor for every later judgment.

**Not changed**

- The Stage 5 exception does not extend to another unit, to the coordinated review, or to validation.
- `reviewerLadderRefusal` (rung 0 is the dispatcher, every rung on its vendor) and the frozen rubric hash are unchanged.

**Shown by tests**

- `ophanim/operate/fit-lifecycle.test.mjs`: the pinned Stage 5 review approves each unit; the three dispatchers are excluded from the panel and the validator although each only approved; the three-lab panel still qualifies and the item reaches an outcome. Since wave 2 the test runs on a reviewer pool in which, without the arbiter rows, `gpt-6-astra` (a dispatcher) WOULD be seated, and asserts that counterfactual: on the configured pool alone the check passed with Decision 6 removed (self-audit round 3, assignment 2, section 7).
- `pantheon/tests/pipeline-stage5-wave2.test.mjs`: the rule "does not depend on which unit ran first" — unit b's ladder skips unit a's dispatcher seat although a is dispatched only after b ends (M5).

### Decision 6 extended: the returning dispatcher (owner decision L-001, 2026-11-19)

> "L-001: A + B. Preserve requested and served model identities, and complete contribution lineage. The returning dispatcher is recorded as a contributor to the revised plan. Treat structured dispatcher feedback as untrusted advisory data. Validate its schema and allowed operations, and require the planner to independently justify any revision. Do not weaken the three-lab floor or the independence requirements to avoid capacity-pending results. Record shared-lab participation explicitly. Follow-up: a returning dispatcher that also dispatches the revised unit keeps Decision 6's pinned Stage 5 review of its own unit only."

- **Structured, untrusted.** A dispatcher that judges a unit not cohesive answers `return: {reason, moves}` (`pantheon.pipeline.dispatch/v2`): a reason code (`COUPLED_FILE_ELSEWHERE`, `SEVERAL_CHANGES`, `VERIFY_NEEDS_OTHER_UNIT`, `UNSPECIFIED`) and at most 16 moves, each a path one of the plan's units owns moved to another unit of the plan or to `new`. Anything else is refused at admission. Free `notes` is still accepted (a v1-shaped answer is not refused), but its text is never recorded or passed on: the record keeps its length and digest. The unit's reason, the returned finding's text and the line the planner reads are composed by the controller from the validated fields only, under the marker `ADVISORY (untrusted dispatcher data, validated fields only)`.
- **Every judge's evidence.** The same holds for the work-ledger views every judging seat is given (the dossier's work view, `{"op":"work"}` and `{"op":"record"}`): a v1 record's dispatcher text is shown withheld, with its length and digest (`context.mjs withheld`).
- **The planner justifies.** A revision must answer each advisory finding with `justification: {why, sources}`, its own reason resting on evidence it was given (`planRefusal`).
- **Lineage.** The finding carries the dispatcher's requested and served model, marker and lab, so the revised plan records it as a contributor (`purpose: 'dispatcher-return'`); through the plan's contributions it is excluded from the revised plan's panel, the change panel and the validator, at selection and at admission. The plan record lists it in `advisory_returns`, with whether the panel shares its lab; the panel's shared labs are in `plan_review.shared_labs`.
- **Stage 5.** The run that carries out the revised plan receives the returning dispatcher as `stage5_excluded`: every unit's Stage 5 rung excludes it except the unit it dispatches itself, whose pinned review it keeps (Decision 6).
- **Capacity.** On default tables the revised plan's panel moves from `grok-4.7, gemini-3.8-flash, gpt-6-sol` to `grok-4.7, gemini-3.8-flash, <an Anthropic sibling of the planner>` when the dispatcher's lab, OpenAI, becomes a contributing lab: still three labs, one of them shared. The brief's 30 of 324 change-panel combinations that seated the old dispatcher now go to another model; 24 of them are `REVIEW_CAPACITY_PENDING` (each already needed `gpt-6-sol` as an earlier finder). Nothing falls back. That is on the brief's base `5a40b3c`; on `main`'s tables (re-checked 2026-11-21 on `main` (`ba3f038`)) the old dispatcher is never seated on the change panel, so 0 of 324 change and none go pending, while the revised plan's panel still moves as described.
- `ophanim/operate/independence-r2-a2.test.mjs`: requested and served identities excluded; a different OpenAI model seated; a resumed unit keeps its arbiter; no fallback when capacity is gone; a v3 cycle records the dispatcher and refuses an answer it served.
- `pantheon/tests/pipeline-stage5-confined.test.mjs`: each unit's own dispatcher is pinned and approves it; unit b's ladder skips unit a's dispatcher model; a ladder exhausted by exclusions blocks on capacity; an answer served by another unit's dispatcher is not admitted.

## For the independent review

Points worth another lab's attention:

1. **Shared failure patterns.** Two models of one lab may miss the same things. The rule records the relationship and limits nothing. Is a recorded shared-lab seat acceptable on its own, or should a panel need some seats from labs that did not contribute when they exist? Today those labs are preferred, not required.
2. **Undeclared aliases.** Two declared names that are one model, and are not in the rules, would count as two reviewers. The inventory was read for this; the two lane variants found are declared. A reassessment is how a later correction is recorded.
3. **Each cycle carries a full copy of the policy** (about 1 KB). That makes replay self-contained at the cost of repetition.
4. **Capacity is finite.** xAI and Google have two models each in the tables. After both models of a lab have contributed, that lab is out; after that happens to two labs, the review is pending.
5. **Inside a Pantheon run** under default routing there are two in-run reviewer candidates.
5a. **Antigravity turns are admitted on the input model** (marked `served_model_source: "input"`), Gemini only. Is that enough for a reviewing seat, on both lanes?
6. **Protocol v2 lets one model revise up to four times** on critiques alone. Is that bound right, and should it apply outside the lifecycle?
7. **Validator capacity.** Since owner decision L-002 the validator excludes the approving change reviewers under the model rule; when that leaves no eligible model it waits (tested through the lifecycle). How often that happens is a computed enumeration over a constructed grid ("2. Validator capacity" above), not a proof.
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
| Q6. Board work row kept the asked seat | The slot's work contributor kept the implementer model asked; the model that served the turn stayed eligible for the slot's in-run review. | The row keeps `served_model` (and `served_model_source`) beside `model`. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q6. Unnamed subagent answer | An answered call with no serving model stored `served_model: null` with no marker. | Recorded as `served_model_source: "unnamed"`; the asked model is the contributor that is excluded. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q9. Board Antigravity guard | Refused a known non-Google model only; an undeclared name was stamped as served (`input`). | Refused, like `agySingleTurn`, unless the name is a declared Google model, before any lane starts. | `pantheon/tests/independence-r2-a2.test.mjs` (two board fixtures now name a declared Gemini model) |
| Q9. `"provider"` by default | `pipelineTurns` `single()` labelled any served name without a source `"provider"`. | The transport's own report is passed on; `liveTurn` marks a name read off the provider's response `"provider"`; a name with no source is `"unknown"`. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q3. Re-ask not admitted | The board in-run re-ask's verdict came from a second turn whose serving model was never checked, and the review cited the first turn. | The re-ask is admitted on its own serving model (`reviewerRefusal` under the model rule; same lab under the lab rule). A refused re-ask supplies no verdict and no text: the slot fails closed. An admitted re-ask that gives the verdict is the turn the review cites. | `pantheon/tests/independence-r2-a2.test.mjs` |
| Q5. Raw `openCycle` below the floor | A new v2 cycle opened with `reviewers: 1` and no `required_reviewers` closed `verified` on one lab. | `openCycle` records `required_reviewers: 3` on a new v2/v3 cycle and refuses a new v1 cycle of fewer than three reviewers. Cycles recorded without the field verify as recorded; a recorder made with `historical: true` (tests only; never the system's recorder) writes that shape. | `pantheon/tests/independence-r2-a2.test.mjs`, `pantheon/tests/cycle-review-labs.test.mjs` |
| Q7. Dispatcher exception width | The omission from `contributionsOf` was global: the dispatcher's model could sit on the three-lab panel or be the validator. | Decision 6 (owner, 2026-11-19), above. Under the lab rule the `fit` lifecycle tests now need a second synthetic lab (`SIX`), since the dispatcher's lab is excluded. | `ophanim/operate/independence-r2-a2.test.mjs`, `ophanim/operate/fit-lifecycle.test.mjs` |

## Corrections in wave 2 (self-audit round 3, assignment 2, sealed `449ca42`; owner decisions L-001 and L-002, 2026-11-19)

Each regression test below failed with the sources of `bce84eb` put back. The L-205 tests that only kill mutations (M1/M9 through a substituted subagent, M5, M9 through `reviewCycle`) pass on `bce84eb` by design: the code they protect was already right, and no test noticed when it was removed.

| Item | On `bce84eb` | Now | Test |
|---|---|---|---|
| L-201 (D-C). Retrieval rounds not admitted | `investigate()` admitted only the last answer; an earlier round answered by the planner or by an unnamed model put its request text into the prompt the admitted answer was given. | Every earlier round is admitted on the model that served it before its requests run: by the cycle's own rule for plan and change reviewers (`answerRefusal`, handed to the turn), by the validator's `servedRefusal` for the validator. A refused round fails the seat's attempt (cycle reviewers) or is a rejected answer (validator). Admitted rounds are recorded on the cycle ledger as `cycle-review-round` turns chained before the answer, and the ledger re-admits each (`roundRefusal`); every investigation log names the server of each call (`turns`). | `ophanim/operate/wave2-identity.test.mjs`, `pantheon/tests/ledger-wave2-identity.test.mjs` |
| L-202 (D-D). Planner rounds | A round served by another model was no contributor and could sit on the plan's or the change's panel. | Each round's server is a plan contributor; the accepted answer's rounds are author turns of the plan cycle (`plan-round`), so cold review sees them; the plan panel is chosen again on what the answer added. | `ophanim/operate/wave2-identity.test.mjs` |
| L-203 (D-E). Validator marker | The validator record, its rejected answers and findings dropped `served_model_source`. | Kept on all three, and on every finder row (`withServed`), the review team and the checkpoint's dispatch. | `ophanim/operate/wave2-identity.test.mjs` |
| L-204 (L-1, L-2, L-3). Ledger holes | Under the lab rule a lab came from the route or vendor; the three-lab floor was the recorder's only; any marker was accepted. | A lab-rule cycle the lifecycle or the board's coordinated review opens pins `lab_identity` (the identity policy, digest-bound): every lab is resolved under it and an unresolved or cross-lab answer counts for none; such a cycle must record `required_reviewers` (the kind refuses it otherwise), and a scope never returns to an unfloored or unpinned cycle. The turn kind enforces the marker vocabulary. Cycles recorded without the fields verify as before. Not covered: a caller that opens a lab-rule cycle without `lab_identity` (the review-cycle CLI, practice comparison) still writes the old shape. | `pantheon/tests/ledger-wave2-identity.test.mjs` |
| L-205. Surviving mutations | M1, M2, M5, M9, M10 survived: the fixture always answered as the model asked, unmarked. | `scriptedTurn(..., {serve})` (`SERVE.dated`, `SERVE.marked`, `SERVE.substitute`) drives served-not-requested names through the production paths; `ophanim/operate/wave2-identity.mutate.mjs` applies each of 22 mutations (the self-audit's M1-M10, re-targeted, and M11-M22 on this wave's code) to a disposable copy (exiting non-zero unless each applies exactly once and is killed). | the runner and the tests it lists |
| L-107. Unbound change-review citations | Change reviewers' `[source: ...]` citations were free text. | Plan and change review briefs ask for `"sources"` per finding; each cited source is bound to the view and version that reviewer was given (its own investigation log; marked "dossier only" when the review was recorded in an earlier attempt) on the finding rows and in `outputs.citations`. Re-checking them before a reused review is the gate's, not done here. | `ophanim/operate/wave2-identity.test.mjs` (finder rows) |
| L-001, L-002 | See "Decision 6 extended" and "2. Validator capacity" above. | | `ophanim/operate/wave2-identity.test.mjs`, `validator-identity.test.mjs`, `independence.test.mjs`, `stages.test.mjs`, `pantheon/tests/pipeline-dispatch.test.mjs`, `pipeline-stage5-wave2.test.mjs` |

## Wave 3: identity through every projection (L-504 invariant 2)

Each test below fails with the sources of `5f24c68` put back; projections the base already kept are proven by killed mutations (`ophanim/operate/wave3-identity.mutate.mjs`, `pantheon/tests/wave3-agy-spend.mutate.mjs`).

- **What every identity row carries.** The model asked (`requested_model`, or the row's `model`), the model that served it (`served_model`), the marker (`served_model_source`: `provider`, `input`, `unnamed`, `unknown`) and the lab. An unknown served model is carried as `served_model: null` with `unnamed`, never replaced by the model asked. `pantheon/src/review/identity.mjs` `identityOf` is the one documented reader of both row shapes.
- **v3 cycles.** Contributor rows now record which name was asked, which answered, and the marker; the kind refuses a contributor whose marker is outside the vocabulary or inconsistent with its names. Retained reviews keep the marker.
- **Proposals and the status ledger.** An outcome proposal's reviewers carry the marker; the status ledger accepts a marker from the vocabulary, consistent with the names, and checks it against the review's answering turn.
- **Pipeline.** Contribution dedupe keys include the marker; a Stage 5 finding keeps its served identity; the checkpoint's reviewer keeps its marker; a sealed dispatch with no served model is refused at approval. An implementer turn refused by the Antigravity model guard is recorded as `AGY_MODEL_MISMATCH` with both identities and blocks the unit (no revision on the same lane, no ladder step).
- **Lifecycle.** Authored rows, implement team rows, unit findings, findings carried from a killed attempt, `stage5_excluded`, the planner's served rows and a resumed plan cycle's lineage keep all four fields. Seat rows (the planner seat, team seats, predicted rows) deliberately name the seat asked; the answers' identities are on the contributions.
- **Board.** In-run critique and work contributor rows with no served name are recorded as unknown (`unnamed`).
- **Live run and public record.** `servedIdentities` and `subagentReceipt` keep the marker and vendor; provenance no longer counts an input-stamped name as reported by the provider; the public record's evidence and work sections show the model asked, the model served and the marker.
- **Tests.** `ophanim/operate/wave3-identity.test.mjs`, `pantheon/tests/wave3-identity.test.mjs`, `pantheon/tests/wave3-agy-guard.test.mjs`.
- **Open.** L-140 (the own-dispatcher exemption in `stage5Keys` also exempts an author that model served), L-141 (`subagentReceipt` resolves non-xAI subagents by string), L-142 (a fixture marker outside the vocabulary).

## Native Hydrogen subagents are implementation contributors (owner direction 2026-11-19)

> "Google's internal Hydrogen subagents are implementation contributors, not independent reviewers. Preserve: OpenAI dispatch and pinned in-run review according to existing contracts; Grok/xAI as an eligible independent adversarial review laboratory; the existing cross-lab review requirements; contributor exclusion and model identity verification; independent validation and deterministic acceptance gates. Do not spend Grok on routine Google implementation delegation when native Hydrogen specialists can perform that work."

The `fit` implementer is now an Antigravity SDK session on the Gemini API, and its subagents are its own, on `gemini-4-hydrogen` (`docs/routing-task-profile.md`, "The Google implementer on the Antigravity SDK transport"). Nothing in the identity policy, the panel rules or the ledger kinds changed. What changed is who contributes.

**What is recorded as a contributor** (`pantheon/src/pipeline/record.mjs` `contributionsOf`)

- `work`: each implementer attempt whose writes were kept, by the model asked and the name the provider answered under.
- `subtask`: the native subagents of such an attempt, on `agy_google/gemini-4-hydrogen`: one row per unit and per name the provider answered a subagent request under, with the specialist types that ran (`role: "subagent:code-explorer+test-constructor"`). A subagent that was admitted and never answered is one row with no served name, marked `unnamed`: its served model is unknown and is never recorded as the model asked (L-504 invariant 2). The subagents of an attempt that failed or was discarded are not contributors, as its implementer is not.
- A unit resumed from its checkpoint restores these rows (`from_checkpoint: true`) and its subagent receipts (`native_subagents`).
- Before any work, the capacity check predicts a native subagent contributor only for a unit whose starting implementer may delegate (a ceiling above none and an allowed specialist type; `ophanim/operate/stages.mjs` `mayDelegate`).

**What follows for each judgment**

- **Stage 5** is unchanged: the unit's dispatcher model, pinned, escalating only inside OpenAI. A unit's authoring contributors, native subagents included, are excluded from its Stage 5 ladder by identity (`stage5Keys`).
- **The three-lab change review and the validator** exclude every row above, by canonical identity, at selection and again at admission, as for any contributor. The three-lab floor is not lowered and nothing falls back.
- **The model guard decides what can be a contribution at all** (L-504 invariant 3, at the SDK transport's entry point). A session in which any answered request, the implementer's or a subagent's, was not named by the provider as the model it asked for is refused whole (`AGY_MODEL_MISMATCH`, both identities recorded): another declared model, a name the policy does not declare, or no name. Nothing of such a session is a contribution, and its unit blocks without a retry or a ladder step. So every `work` and `subtask` row of an SDK attempt carries the provider's own name for the model asked, or, for a subagent that was never answered, no name and the `unnamed` marker.
- **xAI is no longer a contributor of Google-implemented work.** The earlier `fit` subagent row spent `grok-4.6` or `grok-4.7` on delegation, which made that model a contributor whenever an answer was returned. Those seats are not asked now, so both Grok models stay eligible for the change panel and the validator. The cost moves to Google: when a Carbon or Neon implementer delegates, `gemini-4-hydrogen` contributes beside the implementer's model, so a Google seat on the panel must be a third Google model.
- **The dispatcher exception** (Decisions 5 and 6) is untouched.

**Shown by tests** (scripted seats and a scripted provider; nothing here is a live model's behaviour)

- `pantheon/tests/antigravity-turn.test.mjs`: the model guard, for the implementer and for a subagent, on another model, an undeclared name, no name, and ahead of a quota refusal or a failure. `pantheon/tests/pipeline-antigravity-sdk.test.mjs`: the guard's refusal blocks the unit with no retry, no ladder step and no contribution; two declared names of one model are two rows of one identity; an unanswered subagent is `unnamed`.
- `ophanim/operate/wave3-identity.test.mjs`: the base's projection tests, driven by the SDK implementer and its native subagents: asked name, served name and marker through the stage's rows, the change cycle, the validator's exclusions, the live record, the receipt and the public work view, and the `unnamed` subagent through the same projections.
- `ophanim/operate/fit-lifecycle.test.mjs`: a `fit` item whose hard unit delegates to a native `code-explorer`; `gemini-4-hydrogen` and the three implementer models are contributors, every contributor resolves, an xAI model sits on the change panel, and no Grok seat was asked during implementation.
- `ophanim/operate/wave2-identity.test.mjs` (L-205): a native subagent answered under a dated snapshot name; the asked and the served name are both excluded, and an xAI model reviews.
- `ophanim/operate/sdk-intake.mutate.mjs`: mutations that drop the native subagents from the contributors, drop a subagent answered under two names, drop the `unnamed` marker, or weaken the guard (the implementer's answers, the subagents', an undeclared name, an unnamed answer, the guard's precedence) are each killed.

**Not shown.** The name Google's API reports for these models has not been observed (register L-701). If it is not a declared name or a dated snapshot of one, the model guard will refuse every live implementer session with that name in the reason, until the identity policy declares it (register L-705).

**Where the A2A subagent and the unnamed implementer still exist.** Only on an explicit Antigravity lane seat, which the lifecycle no longer seats. Their projections are driven at the pipeline's own entry (`pantheon/tests/wave3-identity.test.mjs`), no longer through a lifecycle run (register L-714).
