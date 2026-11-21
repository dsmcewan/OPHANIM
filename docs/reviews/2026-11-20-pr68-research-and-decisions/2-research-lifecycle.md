# Assignment 2: Research in the lifecycle

**Scope:** the `work.research` ledger records, the runner, billing of each request, the dossier view, plan staleness, review eligibility, activation.
**Testing:** local deterministic fixtures: the helpers in `ophanim/operate/test-fixtures.mjs` and `pantheon/tests/fixtures/` (real ledgers, scripted providers). No live provider.

## Where to look

- `ophanim/operate/research.mjs`, `research-view.mjs`
- `ophanim/operate/work-ledger.mjs` (the `work.research` kind)
- `ophanim/operate/stages.mjs` (search `research`), `gates.mjs`, `context.mjs`, `cli.mjs` (verb `research`)
- tests: `ophanim/operate/research.test.mjs`, `research-lifecycle.test.mjs`

## Questions

1. **The ledger.** Can a research record be written out of order, for the wrong item or team, under an expired claim, or twice? Does every record re-derive?
2. **Billing.** Is each research request admitted by the Gemini billing policy and charged to the stage before it is sent? With nothing declared, does anything run?
3. **Recovery.** Does a cancelled, failed or charge-refused team leave no conclusion and its request open? Does a resumed team pay only for members that did not finish, and does the team's request bound hold across resumes? What happens when a member's stored record was altered?
4. **Plan validity.** Does an open request, or a material conclusion a plan was not given, make the plan stale? Can a plan record a conclusion as given that its planner was never shown? Can research re-activate without bound?
5. **Review eligibility.** Can a model or lab that contributed research review the plan built on it, under `model` and under `lab` independence?
6. **Secrets.** What inside the repository can a research session read that it should not?
