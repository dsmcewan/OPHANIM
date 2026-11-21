# Independent review of pull request 68: the research team and the owner's five decisions

**For:** reviewers from labs other than Anthropic, which wrote this change. Self-review confers no approval.

**Candidate:** pull request 68, branch `feature/antigravity-sdk-intake`, the work after `ea858a6`: the Carbon research team (owner specification of 2026-11-20) and the owner's five decisions for the pull request. Pin the exact commit you review in your findings. Review the head that contains this directory, or a later one: it includes the repairs made after the same-lab reading below.

| # | Assignment | Reviewer lab | Scope | Testing |
|---|---|---|---|---|
| 1 | [The research team's controller and session](1-research-controller.md) | xAI (proposed; the owner assigns) | Bounds (depth, active members, request budget), read-only enforcement and scope, evidence-bound reports, stop conditions, resume | Scripted sessions and isolated processes |
| 2 | [Research in the lifecycle](2-research-lifecycle.md) | Google (proposed; the owner assigns) | The `work.research` ledger records, the runner, billing of each request, the dossier view, plan staleness, review eligibility, activation | Local deterministic fixtures: the helpers in `ophanim/operate/test-fixtures |
| 3 | [One gateway: the model gateway and the python SDK seat](3-gateway-and-seat.md) | OpenAI (proposed; the owner assigns) | The model gateway, the seat session, the board's python SDK seat, the one billing path, credential isolation | Source inspection and local fakes only (a loopback upstream |
| 4 | [Partial checkpoints, lane pins and the lessons registry](4-checkpoints-pins-lessons.md) | OpenAI (proposed; the owner assigns) | A budget-stopped SDK session's kept work and its restore; a lane-pinned implementer under `fit`; the lessons report's success rule | Scripted sessions in temporary repositories (the helpers at the top of `pantheon/tests/pipeline-antigravity-sdk |

The lab column is a proposal that follows the split of the review of pull request 67 (lifecycle to Google, reliability to xAI, security and independence to OpenAI). The owner assigns each assignment to a lab and chooses the model. Record the model that actually served your review.

## State on 2026-11-20

| | State |
|---|---|
| Same-lab reading (Anthropic) | done on `af23623`, all four assignments. Records: `findings-<n>-anthropic-af23623/`. It found defects in every assignment; the repairs and what stays open are register entries L-737 to L-748 |
| OpenAI | **not run** |
| xAI | **not run** |
| Google | **not run** |

**Why the three labs were not run from the session that prepared this.** That session's environment holds one saved credential per provider, and each was refused by its provider on a request that generates nothing (2026-11-20): OpenAI `invalid_api_key` (HTTP 401), xAI "incorrect API key" (HTTP 400), Google "pass a valid API key" (HTTP 400). No review request was sent and nothing was billed. The status item `cross-lab-review` is On Hold on the same cause.

## Running a review

Two ways, both used for pull request 67 (`docs/reviews/2026-11-18-independent-review/`):

- **By hand, outside the runner.** Give the reviewer a copy of the commit with every `docs/reviews/*/findings-*` folder left out, this README and its assignment file. Record what `findings-3-google-manual-77480d6/README.md` records there: the commit, the model and how it was served, the prompt and its digest, what the reviewer changed, and the digests of what came back.
- **With the review runner** (`pantheon/scripts/run-review.mjs`). It reads `docs/reviews/2026-11-18-independent-review` only (`pantheon/src/review-runner/brief.mjs` `REVIEW_DIR`). It cannot run these assignments until it is given this directory. That change was not made here.

Put each lab's findings in `findings-<assignment>-<lab>-<commit>/`.

## Ground rules (all assignments)

- **No live calls.** No provider calls and no credentials. Everything runs against scripted or loopback providers.
- **Leave the owner's records alone.** Do not write to the status ledger, any key, or anything outside a temporary directory you create.
- **Do not read the other findings first.** Not the `findings-*` folders here, not `docs/execution/research-team-report.md`, not the pull request text, and not `docs/OPEN-LIMITATIONS.md` entries L-725 to L-748, until your own findings are formed. Then use the register only to say which of your findings are already recorded.
- **The owner's decisions are given.** Judge whether the code does what they say and whether it is safe. They are quoted in `findings-<n>-anthropic-af23623/PROMPT.md`.
- **The implementing agent's tests are supporting evidence, not proof.** To check whether a test decides a property, remove the property in your copy and run the test.

## What to return

For each question in your assignment: `holds`, `does not hold` or `cannot tell`, with the file and line, and for any defect a reproduction that runs within your assignment's testing limit. Then what you checked and found sound, and what you could not check. End with the defects you would block a live run on, and the name of the model you are.
