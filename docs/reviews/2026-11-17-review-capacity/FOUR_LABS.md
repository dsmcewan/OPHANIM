# Is four labs enough for coordinated review?

Owner, 2026-11-17: no fifth lab is being set up; evaluate whether four is enough. Declared before any result.

## What the configuration allows (static, from the selector)

The configured labs are anthropic, google, openai and xai. A coordinated (cycle) review needs three labs outside every lab that contributed to the change (`ANALYSIS.md`). With the board default (the work item's title from the ticket, no planner model), the contributors are the labs that wrote the code.

Checked against the selector for argo, legacy (easy, hard) and fit (every stakes level, light and deep work): the first implementer seat is openai in every case. The transport-failover chain continues into anthropic and google (argo and fit); legacy stays on openai.

So:

- **Normal case: one contributing lab (openai); the reviewer labs are anthropic, google and xai.** Three needed, three available: enough, with no slack.
- **Pending case 1, mixed-lab work.** One slot's code is written by two labs: openai writes a revision, then fails at the provider (quota, outage), and a fallback in another lab writes the next one. Two slots built by different labs (for example operator pins) count the same way. Two contributing labs leave two reviewer labs. The work ships in-run and the review is pending; worker failover is never restricted to prevent it.
- **Pending case 2, a reviewer lab unavailable.** With exactly three eligible labs there is no spare: if one reviewer lab refuses or is down, the review waits for a bounded resume.
- **A model-written title** (`--plan-title model`) adds the planner's lab and is refused before work (`ANALYSIS.md`).

## What history suggests

There are no retained run records in this repository to count from. `pantheon/STATE.md` records repeated provider refusals in real runs (for example anthropic 429s "subscription-side, no interval", and launches stopped by provider faults), and says quota exhaustion is the normal steady-state failure on subscriptions. So neither pending case can be assumed rare. That is a reason to measure, not a measurement.

## The measurement (no new spend; it reads the board runs that happen anyway)

- Every board run's coordinated review is classified from its evidence bundle (`<board>/operating/evidence.json`), and every refusal before work is kept in the evidence store (`review-pending/`): completed (after any bounded resume), reviewer unavailable, pending on mixed-lab work, pending on a plan contribution, pool short for another reason, refused before work, or not shipped (no review needed). Classifier and report: `pantheon/src/practice/review-capacity.mjs`.
- Report: `node pantheon/bin/pantheon-board.mjs capacity [--bundles ~/.pantheon/boards] [--evidence-store DIR] [--json]`.

## Rule (PROVISIONAL constants `MIN_RUNS`, `ENOUGH_RATE`)

- Fewer than 20 board runs that needed a coordinated review: `insufficient_evidence`.
- At 20 or more: **enough** if at least 95% completed their coordinated review (a completion after a bounded resume counts); **not enough** otherwise, with the counts by cause.
- A run that did not ship needed no review and is not counted. A pending review never counts as a completion.

## If the report says not enough

The causes decide what follows, and none of them is solved by lowering the requirement:

- Mostly reviewer unavailability: lengthen or schedule the bounded resume (the review waits; nothing is weakened).
- Mostly mixed-lab work: the measured cost of keeping those reviews pending, against the cost of a fifth lab or of re-running the slot's work in one lab when its review is pending. Each would be a decision with evidence, not a default.
