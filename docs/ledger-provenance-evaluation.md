# Ledger provenance: one layer, hardened by repetition (2026-11-16)

**Principle (Research Director).**
- Review, supervision, audit and watchdog are not extra layers on top of the loop. They are the same loop applied to its own records.
- That loop hardens through provenance, and it runs on a ledger.
- So every record OPHANIM and Pantheon rely on must:
  - be a ledger entry, or a pure function of ledger entries;
  - name its author and the evidence it rests on;
  - be re-derived by a verifier on the path, before anything relies on it.
- Applied the same way to a model turn, an escalation, a review finding, a ship and an OPHANIM delta, the one rule scales. No new kind of layer is needed.

**The ledger.** It is the content-addressed board DAG (`pantheon/src/board`, re-hashed on every read), reached from refs, plus OPHANIM's controller delta chain committed on it (`ophanim/board.mjs`).

**Method.**
- Two independent inventories, one of `ophanim/` and one of `pantheon/src` with `packages/model-client`, each listed every record type against six questions: author, integrity, re-derivation, on-path enforcement, evidence, on-ledger.
- The decisive claims were then checked in the code:
  - `verifyEscalation`, `capabilityDrift` and `verifyChairContributions` have no caller outside tests.
  - No `decision` entry is published.
  - `promotion.json` names its own `authorityRoot` (`efficiency/assessment.mjs:84`).
  - Legacy debit aggregates are summed unchecked (`assessment.mjs:152`).
  - The worker seat vendor is hard-coded to `openai` (`board.mjs:155`).
  - The transition chain is verified only in frontier mode (`runtime.mjs:162`).

## 1. What already holds

- **Board entries, blobs, trees and commits** are content-addressed and re-hashed on every read. Links must already exist when written.
- **Seat-authored entries** carry vendor, seat_id, mode, occupancy generation and model.
- **The ship gates** (tests, review, bound review) re-read ledger entries on the path. `shipClaim` recomputes them from the commit.
- **OPHANIM's controller deltas** are digest-chained to full checkpoints. `applyDelta` checks every load.
- **Release decisions** are signed and rebuilt (`verifyActivationDecision`) on the path.
- **The contribution projection** is a pure function of the ledger, so replay re-derives it.

## 2. Gaps

| # | Gap | Where | What gets through |
|---|---|---|---|
| G1 | Verifiers exist but nothing on the path calls them | `verifyEscalation` (protocol.mjs), `capabilityDrift` (facts.mjs), `verifyChairContributions` and `occupancyTrail` (contributions.mjs, occupancy.mjs), `verifyRuntimeChain` outside frontier mode (runtime.mjs:162), a fresh efficiency assessment (cli.mjs:159) | An escalation nobody re-derived is acted on. Edited facts change routing silently. A rewritten but digest-consistent delta history runs in wave/full mode. A wrong assessment is used until a later reuse. |
| G2 | Decisions are held off the ledger | Escalations in `run.json` and swarm return values. Gate verdicts and the certificate in `run.json`. Stage-gate passes and refusals not stored at all. No `decision` entry ever written. | Replaying the ledger cannot say why a seat was reseated, which gates passed, or which rule settled a question. |
| G3 | Inputs to decisions are not on the ledger | `capability-facts.json` (no digest), seating tables, budget limits (`budget.json`, mutable `declared_at`) | A decision cannot name the facts or limits it was made under. Raising a cap leaves no trace. |
| G4 | Model turns are off the ledger and self-attesting | `run.json` turns. `seats/*.json` exchange chains, checked against the same file they came from. The chain omits model and response_id (chain.mjs:6). | A replaced reply or a mid-conversation model change does not change the chain head. The ledger has no record of which model answered. |
| G5 | Authorship is asserted, not observed | `author.model` is optional and seat-asserted (schema.mjs:287). The wire result has no served-model field. The worker seat is always `openai` (board.mjs:155). The advisor records no vendor or model (advisor.mjs:118). Controller entries are a bare `{vendor:"controller"}`. | Attribution, and so chair measurement and lab isolation, rests on what a caller wrote. |
| G6 | Duplicate provenance with no cross-check | Model identity appears in the entry author, `run.turns`, the seat file and escalation `seat`. Ship outcome appears in `run.gates`, `shipClaim` and the merge commit. Occupancy appears in `author.occupancy_gen` and `runtime.setOccupancy`. | The copies can disagree with nothing to notice. |
| G7 | OPHANIM's efficiency ledger is side files | Debits, `.result.json`, `uses/`, `promotion.json`, investigation receipts, watchdog report, replay manifest | Legacy aggregates are summed with no sign or schema check, so a negative file inflates measured savings. An extra `.result.json` inflates qualified convergences. None of these replay from the board. |
| G8 | No fixed trust anchor for the governance authority | `promotion.json.authorityRoot` is trusted as given (assessment.mjs:84). `fixture-authority.json` is generated per directory (governance.mjs:94). | A promotion pointing at a root holding the forger's own keys verifies, and switches slots 1→3. |
| G9 | Repro (executed acceptance) evidence is thin | Repro entries record cmd, exit and an output tail, but no worktree head or sandbox digest. `acceptanceStatus` re-reads and never re-runs. | "Executed" rests on trusting the controller. |
| G10 | The ticket cid is not the ticket entry | `ticket_cid` (run-item.mjs:209) is computed and never stored, and differs from the published ticket entry. | A reader cannot connect the run to its ticket on the ledger. |

**Governance, flagged and not proposed.** These are in or behind the pinned TELOS verifier (`check-efficiency.mjs` and its pins):
- it reads only the trial head's full checkpoint and does not verify the chain;
- it trusts self-reported watchdog timings;
- `governanceContractSha` omits `EFFICIENCY_PINS`;
- `retainedEfficiencyProof` does not re-run `evaluateEfficiency`;
- the TELOS reviewer packets are produced by the same process that verifies them.

## 3. Proposals

Each proposal is the same move at a different layer: put the record on the ledger with its author and evidence links, and put its verifier on the path.

| # | Proposal | Fixes | Size |
|---|---|---|---|
| L1 | **Verifiers on the path.** `capabilityDrift` must be empty before routing. `verifyEscalation` runs before a resumed run acts on stored escalations, and before ship. `verifyRuntimeChain` runs on every controller load in every mode. A fresh efficiency assessment goes through `verifyEfficiencyRecord` before use. OPHANIM's chair ranking runs `verifyChairContributions`. | G1 | small |
| L2 | **Decisions as ledger entries.** Each escalation is published as a `decision` entry: payload is the record, `links.derived_from` is the repro, critique or turn entry that was its outcome, author is the controller with the run's id. Stage passes and refusals and the ship's gate verdicts are recorded the same way. `verifyEscalation` then replays the ledger, not `run.json`. | G2, part of G6 | medium |
| L3 | **Inputs as ledger blobs.** Facts, seating and budget limits are put as blobs. Each decision cites the cid it was made under. A changed fact is a new blob, never an edit. | G3 | small |
| L4 | **Authorship observed, not asserted.** The wire result reports the served model (from the provider response). The entry author records it beside the requested model. The worker seat carries its real vendor. The advisor records its route. Controller entries carry the run id. | G5 | small–medium |
| L5 | **OPHANIM efficiency events on the controller ref.** `efficiency.assessed` (trace, report and debit digests), `efficiency.promoted` (the signed decision) and `investigation.retained` (packet ids) are committed on the controller ref. Until then, legacy aggregates are refused unless non-negative and schema-valid, and `.result.json` files must match a recorded use. | G7 | medium |
| L6 | **Turns on the ledger.** Each model turn is an entry carrying vendor, requested and served model, response_id, usage, and prompt and reply digests, derived from the previous turn. The seat chain becomes a projection of those entries, so the handoff check no longer reads its own file. | G4, G6 | large |
| L7 | **Repro evidence.** A repro records the worktree tree cid and the sandbox and command digests. A later verifier can re-run it in the same boundary. | G9, G10 | small |
| L8 | **Authority anchor.** Pin the governance `authoritySha` in a genesis entry and refuse any authority root whose digest differs. Changing which authority is trusted is the operator's decision, not mine, so this waits for approval. | G8 | small, needs a decision |

**Suggested order.**
1. L1: verifiers that already exist, put on the path. Cheapest, and it makes every later step enforceable.
2. L3, then L2: inputs, then the decisions that cite them.
3. L5's interim debit checks: a small fix for a security gap.
4. L4, then L7.
5. L6, the largest, last.
6. L8 on approval.

**After each step**, the check is the same: replay the ledger and re-derive every record of that kind; a record that does not re-derive is refused.

## 4. Status (standing rule: On Hold or Resolved)

| Item | Status | Basis |
|---|---|---|
| L1–L7 | On Hold | Proposed here; awaiting the order to implement. |
| L8 authority anchor | On Hold | Changes which authority is trusted: an operator decision. |
| Pinned-verifier items (section 2, governance) | On Hold | Governance decision on the pinned TELOS verifier. Unchanged. |
