# Coordinated review capacity under the existing independence requirement

Owner direction, 2026-11-17: enforce the existing independence requirement for coordinated reviews; do not drop the planner's contribution, weaken the review scope, or force planner and implementer onto one lab to manufacture reviewer availability; keep produced work and evidence as pending; check reviewer capacity before launching work that needs three-lab review; keep ordinary worker execution and escalation separate from orchestration constraints; then find, test and recommend a viable configuration.

## The requirement, as enforced

A coordinated (cycle) review needs **3 reviewers from 3 labs, none of them a lab that contributed to the reviewed change** (`pantheon/src/board/operate.mjs` `cycleReviewers`; scope from `pantheon/src/review/scope.mjs`). A contribution is anything that reached the reviewed bytes: every model that wrote a revision, and a model-written plan title (the worker reads it as its work item).

- **Never narrowed.** The earlier fallback, which dropped the planner's contribution so its lab could review, is gone. A short pool returns `REVIEW_CAPACITY_PENDING` with no seats.
- **Produced work is kept.** A run that has already produced its change commits it and records `bundle.review.status: "pending"` with the reason; no proposal is made.
- **Capacity before work.** `runBoardItem` predicts the contributors with `seatTeam` (the same selection the dispatch makes; tested equal to the run's turns) and refuses before any provider call when the cycle pool would be short.
- **Workers are not constrained.** The check only gates the launch. It never changes which workers are seated, and it does not stop a worker's fallback or escalation; if a worker escalates into another lab, its work ships in-run and the cycle review is pending.

Tests: `pantheon/tests/review-capacity.test.mjs` (strict pending; refusal before work with zero provider calls; escalation into a second lab kept and pending), `pantheon/tests/board-dispatch.test.mjs`, `pantheon/tests/review-scope.test.mjs`.

## Why the default configuration could not meet it

The configured labs are anthropic, google, openai and xai. ARGO seats a planner from anthropic and an implementer from openai. Excluding both leaves google and xai: two labs, one short. The fallback had hidden this; enforced, every default board run would be pending.

## Alternatives

| | Alternative | Meets the requirement? | Capacity: contributing labs the pool tolerates | Operational cost | Tested |
|---|---|---|---|---|---|
| A | Model-written title (current default) | Only by refusing: pending before work | 1 (it uses 2) | baseline: scout, plan, work, in-run review, 3 cycle reviews | refused before work, no provider call |
| **B** | **The ticket's own title; no planner model** | **Yes** | 1 contributing lab (the worker's); 3 reviewer labs remain | **one frontier-model call fewer per run**; no new credential | ships, cycle closes verified with 3 labs outside the worker's; a cross-lab worker escalation is kept and pending |
| C | Separate panels for the title and for the implementation | Yes, but gains nothing | same as A | one more panel | the implementation's scope still includes the title (the worker read it), so it must still exclude both labs |
| D | A fifth, qualified reviewer lab | Yes | 2 contributing labs | new provider credential, network allowance, qualification runs, that provider's per-review cost | capacity mechanics only (a test-only fifth lab restores 3 labs for A); no real lab is qualified |
| E | Seat planner and implementer in one lab | Excluded by the owner's direction | | | |
| F | Fewer than 3 reviewers, or a reviewer from a contributing lab | Changes the authorized requirement: excluded | | | |

Why B is valid and not a way around the requirement: the scope is unchanged (the whole change), nothing is dropped from it, and no seat is moved. B removes a contribution rather than hiding one. In this pipeline the planner model's only output is one line (at most 120 characters) restating the ticket's goal; the worker already receives the goal itself. With B the work item's title is the ticket's own title, the human's text, published with the human's ticket (the board lets a seat or a human write a plan, never the controller).

## Recommendation

**Adopted, provisionally: B for board runs.** It is the only tested configuration that meets the requirement today without a new credential, it costs less (one frontier call fewer per run), and it keeps the full scope. `runBoardItem` and `next` default to `planTitle: "ticket"`. Rollback: `--plan-title model`, which the capacity check then admits only when the pool can review it (today it refuses before work). Standalone `runOpenItem`, which has no coordinated review, keeps the model-written title.

What B does not establish, and the measurement that would: whether a model-written title improves the worker's results. The measurement is declared in `MEASUREMENT.md` (question, population, metrics, rule, conduct, spend) and runs with `compareArms` (`pantheon/src/practice/compare.mjs`): both arms on the same tickets and profile, one per-run bound, a required total boundary, the first arm alternating per ticket, failed and unrun arms kept, the plan pinned by its sha256 in the record, and a paired summary (Newcombe method 10; Wilcoxon for costs). Synthetic runs qualify the mechanics (`pantheon/tests/practice-measure-plan-title.test.mjs`). The live measurement, on the owner's machine, with the owner's tickets:

```sh
node pantheon/bin/pantheon-compare.mjs --measure plan-title --live \
  --item <ticket> [--item <ticket> ...] --max-provider-calls 12 --total-provider-calls 360 \
  --out outputs/compare/plan-title-$(date +%Y%m%d).json
```

Until then B is retained provisionally. Revisit B if that comparison shows the model title raises acceptance, or if a ticket's own title is routinely missing or uninformative.

**Owner decision, 2026-11-17: no fifth lab is being set up.** Whether four labs are enough is now measured instead (`FOUR_LABS.md`), from the board runs that happen anyway; D below is kept as analysis only.

**D, for robustness (not being pursued).** B leaves one pending case by design: a worker that escalates into a second lab. A fifth qualified reviewer lab removes it (the pool then tolerates two contributing labs). This is a qualification task, not a change to the review requirement. It needs a provider credential and network allowance, recorded capability facts from the provider's own documentation, and a qualification of the lab's reviews (for example, recall on a set of diffs with known defects, compared with the current reviewers) before it is admitted to the pool. Candidates found 2026-11-17, unconfirmed against primary documentation: Mistral (an OpenAI-compatible chat endpoint at api.mistral.ai; the newest flagship's context window is reported only by a single blog post) and DeepSeek (OpenAI-format API at api.deepseek.com; prices conflict across aggregators; sending code to it is also a data-governance decision). No lab is added by this change.

The review requirement itself does not need to change.
