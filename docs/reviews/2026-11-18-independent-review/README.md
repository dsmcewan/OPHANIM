# Independent review of PR #67, split into four assignments

**For:** reviewers from labs other than Anthropic, which wrote this PR. Self-review confers no approval, so nothing in this PR has been independently reviewed yet. The owner assigns each assignment to a lab (table below).

**Candidate:** PR #67, branch `ccr-aa24f0d5-336szn`. Pin the exact commit you review in your findings. The PR is a draft and is not merged.

| # | Assignment | Reviewer lab (owner, 2026-11-18) | Scope | Testing |
|---|---|---|---|---|
| 1 | [Lifecycle and evidence](1-lifecycle-evidence.md) | Google (Gemini) | Planning, handoffs, evidence freshness, scheduling, recovery | Local deterministic fixtures |
| 2 | [Review independence](2-review-independence.md) | OpenAI (GPT) | Model identity, contribution lineage, review quorum, validation | Synthetic identity and ledger tests |
| 3 | [Execution reliability](3-execution-reliability.md) | xAI (Grok) | Provider-call limits, concurrency, leases, retries, checkpoints | Mock providers and isolated processes |
| 4 | [Sandbox security](4-sandbox-security.md) | not yet assigned | Antigravity jail, filesystem permissions, credential isolation, network boundaries | Source inspection and existing authorized tests only |

The owner chooses the specific model for each assignment; record it in your findings.

## Ground rules (all assignments)

- **No live calls.** No provider calls, no `agy` model turns, no `scripts/agy-worker-probe.mjs`, no `ophanim/operate/live-run.mjs --confirm-spend`. No credentials are needed or should be loaded.
- **Leave the owner's records alone.** Do not write to the canonical status ledger, any controller or status key, or anything outside a temporary directory you create.
- **No weakening.** Do not weaken independence, narrow scope, reduce the three-lab panel, or count synthetic labs as production capacity.
- **The owner's decisions are given.** These include the model-level rule for `fit`, the routing matrix, the dispatcher-as-arbiter rule and the Antigravity input-model marker. Judge whether the code does what they say and whether it is safe, not whether you would have chosen them.
- **The implementing agent's tests are supporting evidence, not proof.** Write your own fixtures where an assignment allows it.
- **Overlaps are fine.** Where one area touches another (a checkpoint touches both reliability and review lineage), report it under your assignment and name the other one.

## What to return

For each question in your assignment, give a finding: `holds`, `does not hold` or `cannot tell`. Cite the file and line. For any defect, include a reproduction: a test or a command sequence that runs within your assignment's testing limit.

End with a short list of the defects you would block a live run on.

Name your lab and model and the commit you reviewed. Return the findings as `findings-<n>-<lab>.md` in this directory, or as a PR comment.

## Running the existing suites

From the repository root:

- `OPHANIM_TELOS_ROOT=<telos checkout> npm run test:proof` (the lifecycle suite);
- `npm test` (Pantheon, the ledger and the model client).

Both should report 0 failures. Assignment 4 may run only the existing tests its file lists.

## Out of scope for every assignment

- The owner's choice of models and labs.
- Live model quality.
- Production operation.
