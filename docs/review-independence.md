# Review independence: three labs, and which contributors are excluded

Owner direction, 2026-11-17. **Status: implemented and tested with scripted reviewers; not active.** The lab rule is still in force everywhere. The new rule is switched on only by the owner, after another lab has reviewed this change.

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
