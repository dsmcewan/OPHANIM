# Paired measurement: the work item's title from a model or from the ticket

Declared 2026-11-17, before any result. The comparison record cites this file by its sha256 (`plan`), so the question, metrics and rule below cannot be changed after the results are in without the change showing.

## Question

Board runs take the work item's title from the ticket (`planTitle: "ticket"`, adopted provisionally in `ANALYSIS.md`) instead of a one-line title written by a planner model (`planTitle: "model"`). Does that change the in-run results of the work, at what cost?

- Baseline: `planTitle: "model"`. Candidate: `planTitle: "ticket"`.
- Hypothesis H0: the ticket's title is no worse. H1: a model-written title raises accepted or first-pass results.
- Everything else identical: the same ticket, profile (`argo` unless stated), revisions, per-run provider-call bound and providers.

The in-run reviewer is the same in both arms with the current seats (argo's reviewer order puts xai first, outside both anthropic and openai), so the arms are not separated by who reviews. The cycle review is not part of this measurement; the model-title arm could not complete one under the enforced requirement.

## Population

Tickets the owner dispatches, which must have: an executable acceptance command, a ticket title, and a single owner-approved slice. A ticket that cannot be run in both arms is listed as not run, with its reason. A fixed set chosen to favour either arm is not a valid population.

## Metrics, per pair (shared definitions: `pantheon/src/practice/metrics.mjs`)

- Primary: accepted (shipped through every in-run gate, the in-run review included).
- Secondary: first pass; revisions to accept; provider calls per accepted run; tokens per accepted run (only where every attempt reported usage); elapsed time. Cost in USD stays unknown without a price source.
- Unknown values stay unknown and never count as cheaper.

## Rule (applied to completed pairs; constants from `pantheon/src/practice/evaluate.mjs`)

- Fewer than 15 completed pairs (`MIN_PAIRS`): `insufficient_evidence`.
- Stop: after 10 pairs, if the upper 95% bound of (ticket − model) accepted is at or below −0.10, the candidate is clearly worse: recommend reverting board runs to the model title, which then needs review capacity (it is refused before work today).
- Retain the ticket title: at 15 or more pairs, the lower 95% bounds of (ticket − model) accepted and first pass are both at or above −0.05 (Newcombe's paired method 10).
- Otherwise: `insufficient_evidence`, with the pairs needed at the observed discordance reported.
- Cost differences are reported with a paired Wilcoxon signed-rank test at 5%. The candidate makes one fewer call per run by construction; the measurement shows whether that holds and what else moves.

## Conduct

- Every run under an explicit per-run bound (`--max-provider-calls`) and a TOTAL bound for the whole measurement (`--total-provider-calls`). A sampling rate or ticket count is not a cap. A run that could overrun the total is not started and is recorded as not run.
- Order alternates per ticket (baseline first on even tickets, candidate first on odd), recorded per pair.
- Failed, refused and inconclusive runs are kept in the record.
- Synthetic runs (fake providers) qualify the mechanics only. A live run on the owner's machine is the measurement.
- The record draws no conclusion. An independent reviewer from a lab that contributed neither arm's work checks the method and the raw results, and a practice disposition cites the record before anything is adopted or reverted.

## Spend

At most `--total-provider-calls`. To reach 15 pairs with a per-run bound of 12: at most 2 × 15 × 12 = 360 calls. Most runs use far fewer, and the total stops the measurement at the boundary either way.
