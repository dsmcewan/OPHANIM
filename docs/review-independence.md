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
- **A contribution that names a lab and no model** excludes that lab, as an explicit statement.

## The identity policy is pinned to each cycle

Everything that decides "which model is this, and which lab made it" is one value: the same-model map, the lab of every declared model, the lab of each direct vendor, the list of route vendors, and the snapshot rule.

- A v3 cycle **records the whole policy and its digest** (`identity_policy: {digest, rules}`), plus the raw contributor names it was opened with (`contributors`).
- **Every check of that cycle uses the recorded rules**: who may review, which lab a review counts for, the seat's lab, cold review, the close. The configuration files are not read.
- So **editing the rules later cannot change a recorded ledger's validity.** The test replays a recorded ledger in a fresh process over changed alias rules, and it verifies as before.
- **A later correction is new evidence.** `reassess` reports which recorded reviews would not qualify under another policy. `work.recordReassessment` records that on the work ledger, naming the cycle, the policy it recorded and the policy it was reassessed under. Nothing in the cycle's own ledger or the item's status changes; what follows is the owner's decision.

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

## Corrections after the review of `b9fa745`

Each was reproduced on a checkout of `b9fa745` before it was fixed.

| Defect | On `b9fa745` | Now |
|---|---|---|
| 1. Identity policy not pinned | After an alias rule changed, a fresh process refused to open the recorded ledger: a recorded review re-derived as a contributor. | The cycle carries its policy; replay uses it. A correction is a recorded reassessment. |
| 2. Unknown reviewer qualified | A review served by `grok-9-unreleased` was accepted and the cycle closed verified. | Refused; the response is kept and the gap recorded. |
| 3. Lab taken from the route | `claude-opus-4-6-20261117` through the Google route resolved to `google/claude-opus-4-6`. A cycle with that response, by the model that wrote the plan, closed verified on "google, openai, xai". | Resolved to `anthropic/claude-opus-4-6` on every route. That review is refused. |
| 4. Validator not rechecked | An `accept` served by a contributing or unknown model passed validation with `independent: true`. | The answering model is checked before the judgment is read. The accepted record names both models. |

## The in-run checker, and what activation covers

Inside a Pantheon run, each file is reviewed by Pantheon's own checker before the change exists. **That checker still uses the lab rule**, and its reviews are recorded on the run ledger under the lab-based cold-review rule. Activating the model rule would cover the plan review, the change review and the validator; it would not change the in-run checker.

How the two meet, as tested:

- **A finding that reaches a revision is a contribution.** When the in-run reviewer requests changes of passing work, Pantheon ends that run with the finding pending. The lifecycle's next implement attempt now **resumes that run** instead of starting a new one (it used to restart, which repeated the work and dropped the finding). The worker revises with the finding in its prompt, and the reviewer's model becomes a contributor to the change. The change review then excludes that model.
- **Inside the run, the lab rule applies to the revised file**: it is reviewed by a lab that is neither the worker's nor the critic's. With four labs this leaves room for two rounds of in-run findings on a single-lab worker.

Where the boundary still blocks, and what would be needed:

1. **Default routing gives no in-run revision.** Under the default (`argo`) routing the implementer is already the top model at top effort, so Pantheon's escalation rule answers an in-run rejection with "stop". No revision is pending, the stage fails, and a retry starts a fresh run without the finding. The tested revision path uses the `fit` routing profile, where the worker has headroom. To close this, the in-run findings would have to be carried to the next implement attempt as findings to answer, **and** the run would need a way to be told which reviewers already contributed, so its checker does not seat them again. The second part is a change to the run's own review scope, and should be a versioned one. Not built.
2. **The lab rule inside the run is stricter than the model rule outside it.** A worker fallback to a second lab plus one in-run finding leaves one lab for the in-run review. Aligning the in-run checker with the model rule needs a versioned rule for reviews on the run ledger, as was done for cycles. Not built.

Neither is needed for the first cycle of an item under the model rule: the lifecycle tests reach an outcome on four labs.

## For the independent review

Points worth another lab's attention:

1. **Shared failure patterns.** Two models of one lab may miss the same things. The rule records the relationship and limits nothing. Is a recorded shared-lab seat acceptable on its own, or should a panel need some seats from labs that did not contribute when they exist? Today those labs are preferred, not required.
2. **Undeclared aliases.** Two declared names that are one model, and are not in the rules, would count as two reviewers. The inventory was read for this; the two lane variants found are declared. A reassessment is how a later correction is recorded.
3. **Each cycle carries a full copy of the policy** (about 1 KB). That makes replay self-contained at the cost of repetition.
4. **Capacity is finite.** xAI and Google have two models each in the tables. After both models of a lab have contributed, that lab is out; after that happens to two labs, the review is pending.
5. **Inside a Pantheon run**, the in-run checker still uses the lab rule, and default routing yields no in-run revision (see above).
6. **What happens after a reassessment** with findings is left to the owner; nothing re-reviews automatically.
