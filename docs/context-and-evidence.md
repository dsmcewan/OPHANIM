# Evidence before judgment

Owner direction, 2026-11-17: give the models evidence before asking them to diagnose or plan; let them decide what is relevant, look into gaps and contradictions, and keep that ability through review and validation.

This document records what the lifecycle delivered to each model before the change, what it delivers now, and what is still open. Code: `ophanim/operate/context.mjs`, `ophanim/operate/stages.mjs`. Tests: `ophanim/operate/context.test.mjs`.

## What was examined

- **Commits:** `main` at `86ce18a`; the orchestration branch at `1fbe96c` (PR #67), which is where the lifecycle lives.
- **Read:** the stage executors and their prompts (`ophanim/operate/stages.mjs`), the worker's prompt (`pantheon/src/board/run-item.mjs`), the review-cycle prompt and ledger rules (`pantheon/src/ledger/cycle-kinds.mjs`, `review-cycle.mjs`), the status and work ledgers, the one ticket (`tickets/co1-readability.json`), and the backlog reconciliation.
- **Not available here:** the owner's retained board runs and any live-provider transcript. So every finding below is about what the code delivers, shown by reading it or by running it with scripted seats. None is an observation of a live model failing.

## Findings: stored is not delivered (at `1fbe96c`)

Each line is "what the seat was given", with the code that shows it.

| # | Seat | What it received | What was missing or lost | Where |
|---|---|---|---|---|
| 1 | Planner | The first tracked files in alphabetical order that fit in 48 KB, each under 12 KB, from the first 400 paths. On this repository that is 15 files (workflow files, `.gitignore`, `README.md`, …), one of them under `ophanim/` or `pantheon/src/`; 127 files were skipped as too big and the listing stopped at 400 of 630, all silently. | Selection unrelated to the item. No status history, no earlier attempts or findings, no dependents, no issue text, no file history, no retained runs. No way to ask for anything else: a plan could cite only what it had been shown. | `repoContext`, `plannerPrompt` |
| 2 | Plan reviewers | The review brief and the diff of the plan document. | None of the evidence the plan cites: the reviewers could judge only the planner's account of it. | `PLAN_BRIEF`, `reviewPrompt` |
| 3 | Implementer | The ticket's goal (the plan's one-sentence problem statement), the `copy` files and the current file. | The plan's justification, exclusions, consequences and uncertainty. **Ticket `constraints` are stored on the board and never put in the worker's prompt**, so review findings "fed to a revision" as constraints did not reach the worker, although the record said they had. | `ticketOf`; `run-item.mjs` `promptFor("implementer", {ticket: goal})` |
| 4 | Change reviewers | The generic review brief and the diff. | The requirement, the approved plan and its criteria, and every other file. | `REVIEW_BRIEF`, `reviewPrompt` |
| 5 | Validator | The requirement, criteria, scope, the diff, and the last 400 characters of each test output, not marked as cut. | The files the change touches and their consumers, earlier findings, history. No retrieval. | validator prompt in `stages.mjs` |
| 6 | Revised plan | The findings to answer. | The lineage of the plan it revises: its contribution list restarted, and a reviewer whose finding had been folded into the revision reviewed that revision. | `plan()` in `stages.mjs` |
| 7 | Validation verdicts | `implementation_defect` or `plan_defect`. | No way to say "the diagnosis is wrong" or "I cannot judge: evidence is missing"; a validator that gave no judgment looked like any other failure. | `VERDICTS` |

Finding 3 was found by a test, not by reading: the scripted implementer never saw the carried text.

## What changed

**An evidence dossier for every judging seat** (`buildDossier`). Before the planner, each plan reviewer, each change reviewer and the validator is asked anything, it is given an initial view built from the existing stores:

- the requirement (marked authoritative) and the item's full status history;
- the work ledger's record of earlier attempts, findings and blockers;
- dependencies and dependents;
- the ticket and the published issue (marked as data, never authority);
- the files the requirement or ticket names, the files that mention them, and their commit history;
- retained runs, and an index of the repository (marked as a count, not contents).

Every entry states its kind (authoritative requirement, observation, derived, hypothesis), source, version, date and coverage. An excerpt says how much of how much. What is not in the view is listed. When no file is named anywhere, the selection is a word-match guess and is labelled a hypothesis.

**Retrieval the model drives** (`makeRetriever`, `investigate`). A seat may answer with requests instead of a judgment: read a file or a line range, list, search, read history or a commit, read any item's status history or work record, an earlier stage record, an issue, or a full test output.

- **Views.** Each request names a view: a source (including any selection, such as a `match` on status history) and a version. A result is a byte range of that view's whole body, with the total.
- **Continuation.** A cut result or dossier entry carries `next`, the complete request that continues it. This holds for every source, including a long status history, a large stage record and a file that is one oversized line. `match` and `entry` select rows instead of paging through them.
- **Containment.** A path must be inside the repository as written and as resolved: a symlink, or a path through a symlinked directory, to a target outside is refused, in retrieval and in the dossier alike. The refusal is listed.
- **Budgets, in bytes.** The initial view is at most `dossier_bytes` (80 KB) of evidence text, one result at most `result_bytes` (16 KB), and one seat's investigation at most `total_bytes` (160 KB) of delivered record text, counted as UTF-8 bytes without splitting a character. Both are enforced before a result enters the prompt: a result is cut to what is left, and a request that does not fit is not run. Each cut and each request not run is recorded with what remains retrievable.
- **Rounds.** 3 rounds of at most 6 requests by default. Every round is a counted provider call. At the bound the seat is told nothing more was retrieved and must say what it could not see.

**The model decides whether it has enough.** A plan states `context` (sufficient, gaps, uncertainty) and answers the four questions (historical cause, operational position, change impact, adequacy of success). Each is either examined, with a finding and sources, or not examined, with the reason; none is forced. Consequential relevance decisions can be recorded (`used` or `dismissed`, with why). If the evidence does not support a plan, the planner answers `insufficient` instead: no plan is invented, no review is spent, the item waits with its gaps recorded, and it is planned again when the evidence changes.

**Supplied, retrieved, cited, checked are kept apart.** Each seat's delivery is recorded per view and version, as the byte ranges it was given (`deliveryOf`). A view is complete only when its ranges cover the whole; ranges of two versions are never added together; and one complete view says nothing about another view of the same ledger or file. The requirement and the status history, for example, are separate views (`status:<item>#requirement`, `status:<item>#history`).

- A plan may cite only what was delivered to the planner; a citation of anything else is refused. Each citation records how it arrived (supplied, retrieved), the byte ranges, and whether that is all of it.
- A view delivered only in part is recorded on the stage as an unresolved gap, with the request that continues it.
- A validator's list of sources it checked is marked per source with whether that source reached it, and whether in full.

**Carried through the loops.**

- *Plan review:* reviewers get the dossier and their own retrieval, and are told to challenge the diagnosis, the evidence selection, omissions and the completeness of the criteria.
- *Implementation:* the reviewed plan's rationale, exclusions, consequences, criteria, uncertainty and the findings of a revision are delivered in the run's goal, which is what the worker reads. The ticket file is unchanged.
- *Change review:* reviewers get the requirement, the approved plan, the dossier and retrieval.
- *Validation:* the validator gets the dossier, the plan's rationale, full test outputs on request, and retrieval.

**Failures are routed by cause.** Validation can return `implementation_defect` (to implement), `plan_defect` (inadequate plan, to planning), `diagnosis_defect` (incorrect diagnosis, to planning) or `missing_evidence` (to planning); no judgment at all is a validation defect and is retried at validation. Each plan-review finding is stamped with what the record shows about the author: the source it rests on never reached the author, reached it only as an excerpt, was dismissed by the author, or was delivered in full. In the last case the record cannot tell a misreading from an unsupported inference, and says so.

**Investigating a resolved item.** `node ophanim/operate/cli.mjs context --item ID` prints the dossier for any item, Resolved ones included, and can run one retrieval. It records nothing and reopens nothing. Status changes stay with the owner's signature.

## Requirements that pull against each other

- **Reviewer retrieval and the cycle ledger.** The ledger records each review as an answer to the cycle's bound prompt. A reviewer that retrieves answers after seeing more than that prompt. The ledger rule is unchanged: the first prompt each reviewer gets is the bound one, and the retrieval rounds are recorded on the work ledger's stage record, not on the cycle ledger.
- **Naming outside evidence in a finding.** The cycle ledger accepts a finding's `file` only if it is in the reviewed change. That rule is unchanged; a reviewer names other evidence inside the claim as `[source: …]`.
- **Independence and repeated cycles.** Fixing finding 6 means each cycle's findings use up reviewer labs. With the four configured labs, a plan revision that answers one reviewer's finding now waits on review capacity before the revision is paid for. The two-cycle test needs seven labs, three of them synthetic. This sharpens the open review-capacity decision (`docs/reviews/2026-11-17-orchestration/ASSESSMENT.md`); it does not change the rule.

## What is verified, and how

All of it is **scripted**: each scripted seat reads the prompt it is given and answers from what is in it, so a different answer shows the evidence did or did not arrive. This shows delivery, retrieval, recording and routing. It does not show that a model judges well.

| Behaviour | Shown by |
|---|---|
| Older, contradictory evidence changes the diagnosis | An earlier reverted attempt on the status ledger reaches the planner; the plan's cause and exclusions differ from the same item without it. No ticket and existing ticket. |
| Irrelevant material is dismissed without redirecting the task | Issue text asking to rewrite a test and lower the review reaches the planner as data, is recorded as dismissed, and scope is unchanged. |
| A downstream dependency changes the solution | A consumer too long for the initial view is retrieved; its last line changes the plan's scope and travels to the implementer. No ticket and existing ticket. |
| Decisive history beyond the initial excerpt | A 61-entry status history is cut in the initial view. The planner follows the offered continuation once, finds the reverted attempt, and changes the diagnosis. It does not read the rest, so the history stays partial: in the citation, in the unresolved gaps, and in the cause recorded for a reviewer's finding about it (`evidence-partly-delivered`). No ticket and existing ticket. |
| Missing or cut evidence triggers retrieval or stated uncertainty | With retrieval: the cut file is fetched. With none allowed: the plan records the gap. A named source that does not exist: the planner declines, the item waits, is not re-run on the same evidence, and is planned once the file exists. |
| Incomplete criteria and later-cycle failures are detected | A plan reviewer, using its own retrieval, finds a consumer no criterion covers. A validator finds another and returns the work to planning. In the second cycle, a validator catches a defect the revision introduced while the tests stay green, with the first cycle's finding in its view. |
| A supported solution advances | The plain item plans and passes review; the lifecycle tests reach an outcome. |

**Model judgment: not demonstrated. Live operation: none.** No provider was called. Whether real models use the dossier well, ask for the right records, or dismiss the right material is unmeasured.

## Corrections after review of `22cbbb8`

The owner's review reproduced four defects at `22cbbb8`. Each has a regression test in `ophanim/operate/context-bounds.test.mjs` that fails on that commit.

1. **Symlinks.** File retrieval and the dossier followed a link out of the repository. Containment is now checked on the real target.
2. **Shared identity.** The requirement and its history were one source, so a complete requirement made a partial history count as fully delivered, and a finding about it was classified as "delivered in full". They are now separate views, and completeness is computed from byte ranges per view and version.
3. **No continuation.** A cut status history, stage record or one-line file could not be continued. Every cut now carries the request that continues it, and status and work views can be selected by `match`.
4. **Budgets.** `grep` could return several times `result_bytes`; an investigation could pass `total_bytes` before noticing; and bytes were counted as characters. All three are fixed as described above.

## Recheck of `c4c40c2`

The four defects were re-probed with fresh reproductions, not the regression tests, and each is corrected. This recheck was done by the implementer, so it is not an independent review. The probes found further gaps, fixed here with tests in `context-bounds.test.mjs` that fail on `c4c40c2`:

| Gap | Was it introduced by the fixes? | Now |
|---|---|---|
| `file` read ignored files inside the repository: `.env`, `.git/config`, and the ledgers' private signing keys | No, it predates them; the containment fix did not cover it | Git's own directory and anything `.gitignore` excludes are refused. Tracked files, and untracked files that are not ignored, are still readable. |
| `grep`, `list` and `log` used `HEAD` as their version, though `grep` reads the working tree; two different bodies could be added up as one complete delivery | Yes (the per-version ranges relied on it) | Their version is the digest of the body returned. |
| A window smaller than one character returned an empty result marked delivered, with a continuation that made no progress | Yes | Refused as `CAP_TOO_SMALL`; an investigation with fewer than 4 bytes left treats its budget as spent. |
| An `offset` given as a string was ignored (the same window came back); one past the end returned an empty result | Yes | A numeric string is honoured; anything else is `BAD_REQUEST`; past the end is `OUT_OF_RANGE` with the total. |
| The recorded continuation of a partly delivered view was the first cut's, even after more had been retrieved | Yes | It is computed from the delivered ranges: the first byte not delivered. |
| The initial view itself had no overall bound (165 KB with 30 linked issues and a long consumer list) | No | The whole view is bounded (`dossier_bytes`, 80 KB). At most three issues are shown; what does not fit is listed with its request. |
| A cut status history or work record kept its oldest rows, so the latest decisions and findings were the first to drop out | No | The excerpt keeps the most recent rows, starting on a whole row; the earlier ones are the gap, from byte 0. |

Not fixed, by nature:

- **Hard links.** A hard link inside the repository to a file elsewhere is an ordinary file to every check available; it is read.
- **Untracked secrets that are not ignored.** A secret file that `.gitignore` does not cover is readable. The keys and `.env` in this repository are ignored.
- **`match` selects on the stored row text**, so a pattern containing quotes or newlines has to be written as it appears in the JSON row.

## Open

- **Independent review of these rule changes.** The review briefs, the plan schema and the validation verdicts are evaluation rules, and they were changed here. They have not been reviewed by another lab; this session cannot do that. The PR stays a draft for that reason.
- **Inside a Pantheon run.** The scout, the worker and the in-run checker still read what Pantheon gives them. The worker now gets the carried plan in its goal, but has no retrieval.
- **The first guess for an item that names no file** is a word match. It is labelled a hypothesis and can be replaced by retrieval, but a better first selection would save rounds.
- **Cause analysis is limited to what a finding names.** A finding with no source is recorded as undetermined.
- **Dossier cost.** It is rebuilt for each stage, and for a plan waiting on evidence at each tick.
- **Budget accounting covers record text.** The framing around each result (the request, source and coverage line) is not counted against `total_bytes`.
- **Review capacity is a separate, unresolved decision** (`docs/reviews/2026-11-17-orchestration/ASSESSMENT.md`). The synthetic labs in the tests are test-only and are not production capacity.
