# Review independence: three labs, and which contributors are excluded

Owner direction, 2026-11-17. **Status: implemented and tested with scripted reviewers; not active.** The lab rule is still in force everywhere. The new rule is switched on only by the owner, after another lab has reviewed this change.

## Two rules that were one

| Rule | Before | Now (contract `pantheon.cycle/v3`, when asked for) |
|---|---|---|
| The panel | Three distinct labs | Three distinct labs. Unchanged, on every contract. |
| Who is excluded | Every model of any lab that contributed | The models that contributed. A lab is excluded outright only when a contribution from it names no model the configuration can identify. |

With four labs, the old pairing left room for one contributing lab at most. A model plan and an implementation from two labs left two reviewer labs, so no item could finish.

## What counts as the same model

`pantheon/src/review/identity.mjs`, rules in `pantheon/src/config/model-identity.json`. A contributor is a model, and it stays that model whatever reaches it:

- **Effort and thinking variants.** `claude-opus-4-6-thinking` is `claude-opus-4-6`; `gemini-3.8-flash-high` is `gemini-3.8-flash`.
- **Aliases and lane names**, as declared in the rules file.
- **Dated snapshots.** A trailing `-YYYYMMDD` is dropped.
- **Routes.** The identity is `<lab>/<model>`, so the same model through another vendor's lane is the same identity.
- **Sessions and retries.** Identity has no session in it.
- **Requested and served.** A turn excludes the model it asked for and the model that answered.

A model name the configuration does not declare cannot be told apart from its siblings. Such a contribution excludes its whole lab, which is the old rule kept as the safe fallback. The same holds for a contribution that names no model.

## How a panel is chosen

`reviewSeatsByModel` in `pantheon/src/ledger/review-cycle.mjs`:

1. One seat per lab, three labs.
2. Labs that contributed nothing are seated first.
3. Remaining seats come from labs that did contribute, each with its first model that did not. There is no fixed limit on such seats.
4. A seat that shares a lab with a contributor is marked `shared_lab`, with the contributing models of that lab. The cycle's close lists the shared labs (`shared_labs`), and the stage record carries them.
5. Fewer than three labs with an eligible model: no panel. The review is `REVIEW_CAPACITY_PENDING` and the work is kept, as before.

The contribution history is carried through revisions unchanged: the plan, the work, every critique whose findings reached a revision, and the contributions of any plan a revision revises.

## The ledger

- **`pantheon.cycle/v3`** is v2 plus model-level independence. A v3 cycle records `independence: "model"`, `author_models` (identities), `excluded_labs`, `author_labs` (every contributing lab, for the shared-lab record), the digest of the identity rules, and `required_reviewers` (never below 3).
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

All reviewers are scripted. No provider was called, so nothing here shows that a same-lab reviewer judges independently in practice.

`pantheon/tests/review-model-independence.test.mjs`, on the real configured inventory (5 Anthropic, 3 OpenAI, 2 xAI and 2 Google models in the seating tables):

- identity across effort, lane, snapshot and route; an unknown name falls back to excluding the lab;
- an Anthropic plan and OpenAI code leave a three-lab panel: xAI and Google first, then one sibling seat, recorded as shared;
- repeated revisions: contributions come to span all four labs and a three-lab panel still forms, every seat shared; the sequence ends **pending**, not on a smaller panel, once fewer than three labs have a model left;
- the ledger refuses a contributor named directly, through an effort lane, or as the model that served another request; refuses two seats of one lab; refuses a requirement below three;
- a v2 cycle on the same ledger still refuses the contributing lab, and both verify.

`ophanim/operate/independence.test.mjs`, the lifecycle on the four real labs with no synthetic lab:

- an item without a ticket and one with an existing ticket go from plan to an outcome the owner can apply; under the lab rule the same items wait at implementation;
- two revision cycles: by the second, the planner, a plan-review finder, the implementer and a validator have contributed from all four labs, and each later panel is three labs of models that never contributed.

## For the independent review

Points worth another lab's attention:

1. **Shared failure patterns.** Two models of one lab may miss the same things. The rule records the relationship and limits nothing. Is a recorded shared-lab seat acceptable on its own, or should a panel need some seats from labs that did not contribute when they exist? Today those labs are preferred, not required.
2. **The identity rules are a file.** Verification of a v3 cycle uses the rules as they are when it runs; the cycle records only their digest. Adding an alias later can only exclude more reviewers, but it could make an already recorded v3 review re-derive as a contributor. Should a cycle pin the rules it was opened under?
3. **Undeclared aliases.** Two declared names that are one model, and are not in the rules file, would count as two reviewers. The inventory was read for this; the two lane variants found are declared.
4. **Capacity is finite.** xAI and Google have two models each in the tables. After both models of a lab have contributed, that lab is out; after that happens to two labs, the review is pending.
5. **Inside a Pantheon run**, the in-run checker of a single file still uses the lab rule.
