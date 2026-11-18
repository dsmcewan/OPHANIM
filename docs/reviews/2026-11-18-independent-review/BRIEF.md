# Independent review brief: PR #67, before a live `fit` item

**For:** a reviewer from a lab other than Anthropic, which wrote this PR. Self-review confers no approval, so nothing in this PR has been independently reviewed yet.

**Candidate:** PR #67, branch `ccr-aa24f0d5-336szn`. Pin the exact commit you review in your findings. The PR is a draft and is not merged.

**What the owner needs from you:** a finding on each question below, each one `holds`, `does not hold` or `cannot tell`, with the file and line, and a reproduction for any defect. A short list of defects you would block a live run on is the most useful output.

**Ground rules (owner direction):**
- Do not weaken independence, narrow scope, reduce the three-lab panel, or count synthetic labs as capacity.
- The owner's routing decisions are given. Judge whether the code does what they say and whether they are safe, not whether you would have chosen them.
- Treat the implementing agent's tests as supporting evidence, not proof.

## What is in scope

### A. Model-level review independence, now on for `fit`

The rule: exclude the models that contributed to a change, whatever their lab, and keep three distinct labs on every panel. Contract `pantheon.cycle/v3`; the owner activated it for `fit` workflows (2026-11-18).

Where to look:
- `pantheon/src/review/identity.mjs`: resolution; the identity policy and its resolvers 1, 2 and 3; selection versus admission.
- `pantheon/src/ledger/cycle-kinds.mjs`, `lineage-kinds.mjs`, `review-cycle.mjs`: what the ledger itself enforces.
- `ophanim/operate/stages.mjs`: `independenceFor`, the validator, reassessment gating.
- `docs/review-independence.md`.

Questions:
1. Can a contributing model review the work under another name? Try effort suffixes, lane names, snapshots, a route versus the direct API, and served versus requested names.
2. Is an answer that names no serving model ever admitted under resolver 2 or 3?
3. Do historical cycles recorded under resolver 1 or 2 still verify under the rules they recorded?
4. Under the lab rule, could the `fit` pipeline's four labs ever pass the three-lab panel? Under the model rule, can the panel ever fall below three labs?

### B. The dispatcher as a non-authoring arbiter (owner decision)

The Stage 2 OpenAI dispatcher shapes each unit's rubric but writes none of the work. It is recorded as an arbiter, not a contributor, so the same model may be pinned as the Stage 5 reviewer.

Where to look: `pantheon/src/pipeline/record.mjs` and `dispatch.mjs`; `implementUnits` in `ophanim/operate/stages.mjs`; Decision 5 in `docs/review-independence.md`.

Questions:
5. Can the dispatcher influence the work beyond the frozen rubric? Look at the prompt contents, `specialist_role` and raised difficulty.
6. A Stage 5 reviewer whose finding fed a revision becomes a `critique` contributor for later panels, but stays pinned for its own unit. Is that recorded and enforced as stated?
7. Is the arbiter exception confined to Stage 5 of the same unit, so it can't leak into the three-lab panel or the validator?

### C. In-run revision under a pinned reviewer

The same pinned OpenAI model re-reviews a revision. The earlier in-run rule required a different lab.

Question:
8. Is this an acceptable reduction for the in-run check, given that the post-pipeline three-lab review and the validator are unchanged? Does any path skip those later stages?

### D. The Antigravity output carrying the input model (owner decision)

Antigravity reports no serving model. Its turns record the requested model, marked `served_model_source: "input"`. Gemini models only.

Where to look: `pantheon/src/sdk/agy-turn.mjs`; the Antigravity path in `pantheon/src/board/run-item.mjs`; `pantheon/src/pipeline/turns.mjs`; `route_labs` in the identity policy.

Questions:
9. Is the marker always present when the name was substituted? Can a substituted name ever be read as a provider's statement?
10. Can a non-Google model reach the Antigravity transport by any route: a pin, an override, a fallback or an escalation?

### E. The pipeline controller

Where to look: `pantheon/src/pipeline/` (`index`, `dispatch`, `paths`, `implement`, `review`, `checkpoint`, `git`).

Questions:
11. Owned-path locking: can two units in one wave write overlapping paths, given the glob grammar and its reserved paths?
12. The post-turn write jail: is there any write it does not detect? Consider ignored files, symlinks, file modes, deletions and `.git`.
13. Checkpoint resume: can a tampered or stale checkpoint be accepted? Is `unit_key` complete?
14. The verify ground truth: can an approval stand when `verify_cmd` failed?
15. Budgets: is every provider call charged, including lane retries, quota failover and resumed units?

### F. The jailed Antigravity worker

Where to look: `pantheon/src/agy/` (`sandbox`, `jail-hook`, `workspace`, `quota`); the worker launch in `pantheon/src/board/agy-cli.mjs`; `pantheon/scripts/agy-worker-probe.mjs`. Live evidence from agy 1.5.10 is in the routing doc's "First passing live worker turn" section and `pantheon/tests/fixtures/agy-1.5.10-*.json`.

Questions:
16. Can the hook fail open? Consider a crash, empty output, a timeout, a malformed payload, or an unknown tool or MCP spelling.
17. Write tools: are all path arguments checked (`Path`, `TargetFile` and the others), including traversal and symlink escapes?
18. Can anything other than the exact verify command be approved for `run_command`?
19. `bwrap`: which host paths are writable inside the jail? Is that list exactly the worktree, the run directory, the per-run scratch copies and nothing under the real home?
20. Is history withheld from the state copy? Does the copied OAuth token leave the scratch, or survive a run without `--keep`?
21. The network is not cut, because the CLI must reach Google. What can the worker reach that matters?

### G. Routing

Where to look: `pantheon/src/route/fit-matrix.mjs`; `frontier.mjs`; `task-profile.mjs`; `pantheon/src/route/quota-failover.mjs`.

Questions:
22. Does each role and difficulty route to the matrix's model? Can a stakes or ambiguity floor lower a pick?
23. Is the metered Gemini API reached only after a confirmed quota refusal on the lane's own group?

## Out of scope

- The owner's choice of models and labs.
- Whether model-level independence is the right policy. That is the owner's call; judge whether it is implemented as stated.
- Live model quality.

## How to run

From the repository root:

- `OPHANIM_TELOS_ROOT=<telos checkout> npm run test:proof` and `npm test`. Both should report 0 failures.
- `node pantheon/scripts/agy-worker-probe.mjs`, only where `agy` is installed. It spends at most one cheap Antigravity turn.

## Return

Your findings as a file in this directory, or as a PR comment, naming your lab and model and the commit reviewed. The owner decides what follows.
