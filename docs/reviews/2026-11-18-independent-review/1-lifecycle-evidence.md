# Assignment 1: Lifecycle and evidence

**Scope:** planning, handoffs, evidence freshness, scheduling, recovery.
**Testing:** local deterministic fixtures only. You may write new fixture tests in a temporary directory, modelled on `ophanim/operate/test-fixtures.mjs`, with scripted seats. No live provider and no `agy`.

## Where to look

- `ophanim/operate/stages.mjs`: the plan, implement, review, validate and outcome executors.
- `gates.mjs`, `reconcile.mjs`, `work-ledger.mjs`, `scheduler.mjs`, `context.mjs`, `evidence-recovery.mjs`, `reassess.mjs`, all in `ophanim/operate/`.
- `docs/context-and-evidence.md`, `docs/operate-service.md`, and the ASSESSMENT in `docs/reviews/2026-11-17-orchestration/`.
- Existing tests: `ophanim/operate/{stages,scheduler,context,context-bounds,evidence-recovery,revision-reassessment,planner-tier,fit-lifecycle}.test.mjs`.

## Questions

1. **Earliest gate.** Does every item route to its earliest unmet stage, for items without a ticket, with an existing ticket, and Resolved without evidence? Can a stage run on inputs whose upstream changed after it was recorded?
2. **Handoffs.** Is each stage's handoff (`from`, inputs digest) verified before use? Can a stage consume an upstream record of another item, or one that does not verify?
3. **Plan.** Is a plan without valid `work_units` refused under `fit`? Do plan review findings lead to a revision and a re-review of the new version, with the finder counted as a contributor?
4. **Planner seat.** Is the planner seated from the ticket's declared difficulty and stakes? Is an item without a ticket recorded as planning at medium?
5. **Evidence freshness.** Is evidence bound by digest to the bytes a seat was shown? When cited bytes change, is the evidence treated as stale and searched again, never reused?
6. **Evidence bounds.** Are retrieval bounds (views, byte ranges, continuation, containment, budgets) enforced? Is a partly delivered view recorded as partial?
7. **Scheduling.** With `--item`, is only that item dispatched, and every other runnable item recorded as skipped? Is intake recorded once per source?
8. **Recovery.** Does evidence recovery for Resolved items produce unsigned proposals only, never touch the status ledger, and never search the same sources twice?
9. **Reassessment.** Does a recorded reassessment stop the disqualified review, and the validation and outcome resting on it, from being reused? Is a Resolved item marked for re-verification and left alone?
10. **Outcome.** Can an outcome proposal be produced whose evidence does not structurally check against the status ledger's `apply`?

## Out of scope here

Review independence rules (assignment 2), budget and lease mechanics (assignment 3) and the jail (assignment 4). Name them if you meet them, and move on.
