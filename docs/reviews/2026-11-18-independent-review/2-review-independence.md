# Assignment 2: Review independence

**Scope:** model identity, contribution lineage, review quorum, validation.
**Testing:** synthetic identity and ledger tests. You may build cycles and ledgers in a temporary directory with scripted answers and synthetic served-model names. Synthetic labs may be used to probe the rules, but never count them as production capacity.

## Background (owner decisions, given)

- **Contract `pantheon.cycle/v3`:** exclude the models that contributed, whatever their lab, and keep three distinct labs on every panel.
- **On by default for `fit` workflows** (2026-11-18). Other profiles keep the lab rule.
- **The Stage 2 dispatcher is a non-authoring arbiter.** It is not a contributor, so the same model may be pinned as the Stage 5 reviewer of that unit.
- **A Stage 5 reviewer whose finding fed a revision** becomes a `critique` contributor for later panels.
- **An in-run revision is re-reviewed by the same pinned model,** which differs from the earlier in-run rule (a different lab). The post-pipeline three-lab review and the validator are unchanged.
- **Antigravity turns record the requested model,** marked `served_model_source: "input"`, for Gemini models only.

## Where to look

- `pantheon/src/review/identity.mjs`: resolution; identity policy resolvers 1, 2 and 3; candidate selection versus answer admission; `route_labs`.
- `pantheon/src/ledger/{cycle-kinds,lineage-kinds,review-cycle,kinds}.mjs`: what the ledger enforces.
- `pantheon/src/pipeline/record.mjs`, `dispatch.mjs` and `review.mjs`: arbiters, contributions and the pinned reviewer.
- In `ophanim/operate/stages.mjs`: `independenceFor`, `implementUnits`, the validator.
- `docs/review-independence.md`, including Decisions 1 to 5 and the corrections after the reviews of `b9fa745` and `10cbd52`.
- Existing tests: `pantheon/tests/review-*.test.mjs`, `ledger-review-cycle.test.mjs`, `pipeline-review.test.mjs`, `pipeline-run.test.mjs`; `ophanim/operate/{independence,validator-identity,revision-reassessment,fit-lifecycle}.test.mjs`.

## Questions

1. **Same model, other name.** Can a contributing model review the work under another name? Try effort suffixes, Antigravity lane names, dated snapshots, a route versus the direct API, and served versus requested names.
2. **Unresolved names.** Is an unresolved name ever given a lab or an identity? Is an unresolved contributor ever able to leave a qualifying panel?
3. **Answer admission.** Is an answer that names no serving model ever admitted under resolver 2 or 3, by the validator, the cycle ledger or the in-run checker?
4. **History.** Do cycles recorded under resolvers 1 and 2, and under contracts v1 and v2, still verify exactly under the rules they recorded?
5. **Quorum.** Can any path close a review with fewer than three distinct labs, or with a contributor on the panel? Can the validator fall back to a contributor when capacity runs out?
6. **Lineage completeness.** Is every contribution carried through revisions, retries, resume and process restart? That covers the plan, the work, subtasks, and critiques whose findings reached a revision.
7. **Arbiter confinement.** Is the dispatcher exception confined to Stage 5 of the same unit? Can it leak into the three-lab panel or the validator? Can the dispatcher influence the work beyond the frozen rubric, through its prompt, `specialist_role` or a raised difficulty?
8. **Critique contributors.** Is a reviewer whose finding fed a revision recorded as a contributor and excluded from later panels? Is a reviewer that only approved left eligible?
9. **The input-model marker.** Is it always present when a name was substituted? Can a substituted name be read as a provider's statement? Can a non-Google model reach the Antigravity route by a pin, an override, a fallback or an escalation?
10. **Reassessment.** Does a later identity correction disqualify affected reviews as new evidence, without rewriting any recorded ledger?

## Out of scope here

Whether model-level independence is the right policy. That is the owner's decision; judge whether it is implemented as stated.
