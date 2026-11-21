# Assignment 4: Partial checkpoints, lane pins and the lessons registry

**Scope:** a budget-stopped SDK session's kept work and its restore; a lane-pinned implementer under `fit`; the lessons report's success rule.
**Testing:** scripted sessions in temporary repositories (the helpers at the top of `pantheon/tests/pipeline-antigravity-sdk.test.mjs`). No live provider.

## Where to look

- `pantheon/src/pipeline/checkpoint.mjs` (partial checkpoints), `implement.mjs` (`budgetStopOf`), `index.mjs` (`keepPartial`, `restorePartial`), `record.mjs`, `turns.mjs`
- `pantheon/src/route/fit-matrix.mjs` (`lanePinFallback`), `frontier.mjs` (`selectSeat`, the pin branch)
- `ophanim/lessons/corrections.mjs`, `corrections.json`
- tests: `pantheon/tests/pipeline-antigravity-sdk.test.mjs` (search PARTIAL), `ophanim/operate/fit-lifecycle.test.mjs` (search "runs out INSIDE"), `fit-sdk-routing.test.mjs`, `quota-failover.test.mjs`, `ophanim/lessons/corrections.test.mjs`

## Questions

1. **No approval from partial work.** Can unverified partial work end up approved, merged or resumed as an approved unit? Can a forged or stale partial checkpoint be restored?
2. **Lineage.** Is the model that wrote restored work always a contributor, so that it cannot review it?
3. **What is kept.** Is work kept only when a charge was refused, and discarded for any other failure? Are the point of refusal and the requests admitted before it recorded correctly? What is lost on a second stop?
4. **What is said.** When a partial checkpoint cannot be used (the base or the plan changed), does the record say so?
5. **Lane pins.** Is there any input for which a ticket pinned to an Antigravity lane ends on a primary API seat?
6. **The lessons rule.** Can the report count a success that the owner's decision forbids (a review's find, a class with no check, a detection before the owner raised it)?
