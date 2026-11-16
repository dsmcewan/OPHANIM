# Ledger provenance: TELOS as the ledger (revised 2026-11-16)

**Principle (Research Director).**
- Review, supervision, audit and watchdog are not extra layers. They are the same loop applied to its own records, hardened through provenance.
- It runs on a ledger, and TELOS was the ledger. That is why the pieces interlock:
  - TELOS needs signed review packets from distinct models, and Pantheon's seats are those models.
  - OPHANIM's runtime trusts only rows TELOS accepted.
  - Every item held as "governance" waits on the same thing: what the ledger admits.
- **The question.** Can TELOS be the ledger as is? If not, apply its concept and improve on it.

**Read.** `dsmcewan/telos` at the pinned commit `0c9b539`, chiefly:
- `merkle-dag/proposal-ledger.mjs`, `crypto.mjs`, `ledger-gate.mjs`, `merkle.mjs`, `obligation.mjs`;
- `build-gate/proposal-gate.mjs`, `sign.mjs`, `seat-registry.mjs`, `seats.json`;
- `CURRENT-AUTHORITY.json`.

The OPHANIM and Pantheon record inventories that preceded this revision are summarized in section 3.

## 1. What TELOS is

TELOS has three ledger parts and an authority file.

| Part | What it does | Provenance strength |
|---|---|---|
| **Settlement ledger** (`ledger.jsonl`, `crypto.mjs`, `ledger-gate.mjs`) | One Ed25519-signed record per plan node: effective hash, artifact tree hash, files. | `verify()` **re-derives** each node:<ul><li>recomputes the Merkle lineage, so a spec change cascades as `STALE_LINEAGE`;</li><li>checks the signer is authorized by the plan, whose hash commits to the signer set;</li><li>re-hashes the files on disk;</li><li>**re-runs the node's test**;</li><li>sweeps verification obligations.</li></ul>This is re-derivation by execution, not hash comparison. |
| **Proposal ledger** (`.telos/proposal.jsonl`) | The lifecycle (draft → … → decision), one signed and hash-chained line. | Exactly one root and one head, and forks are refused. Every append re-reads and re-verifies the whole chain under a lock. The decision cites a policy certificate whose outcome is **derived** from a closed check registry (`POLICY_CONTRACT_V1`), never asserted. |
| **Review packets** (`proposal-gate.mjs`, `sign.mjs`) | Per-seat review, HMAC-signed per model. | Provider-scoped lineage (`provider:response_id`, plus `response_model`). Cold review requires reviewer lineage disjoint from authoring lineage, so a model cannot review its own draft. |
| **Authority** (`CURRENT-AUTHORITY.json`) | The single fail-closed answer to "what governs now": plan digest, authorization, required seats. | Recomputed from disk by the comprehension gate. |

## 2. Can it be the ledger as is? No, for six reasons

| # | Limit, as written | Effect |
|---|---|---|
| T1 | **Closed and narrow kinds.** Proposal events take only the seven lifecycle stages. The settlement ledger takes only plan-node transactions. | Turns, escalations, gate verdicts, stage checks, efficiency debits and promotions have no entry kind. They stay off-ledger, as they are today. |
| T2 | **Many small chains, no system chain.** One proposal chain per `telosDir`, with a uniform `proposal_id`. OPHANIM keeps one per request (`runs/<sha>/.telos`) and joins them through side files (`accepted/`, `refs/`). | Nothing orders or links the chains. Replaying "the ledger" means replaying side files. |
| T3 | **One signing key for the proposal chain.** Every event is signed by `proposal-controller`. Review packets use per-model HMAC secrets, and the code states the residual itself: "a determined single owner holding every TELOS_SECRET_* can still forge all packets". | The chain proves the controller wrote it, not that a given seat or model did. OPHANIM's fixture adds to this: the same process generates and verifies every reviewer secret. |
| T4 | **The settlement ledger is unchained.** It uses a tolerant reader that skips torn lines and "last wins" per task. `signed_at` is outside the signature. | Removing a later retry, or reordering, goes unnoticed as long as an older valid record remains. |
| T5 | **No genesis.** Keys come from the plan's signer set and from per-directory key files. `CURRENT-AUTHORITY.json` is a repository file, not a chained entry. | The same gap as G8: a root can name its own authority. |
| T6 | **Every append costs O(n).** The whole chain is re-read and re-verified on each append, behind a spin lock. | Fine for proposals. Quadratic for per-turn or per-escalation entries. |

**Verdict.** TELOS is the right ledger for what it was built to hold: authorization (the proposal lifecycle) and settlement (a node is done when its test re-runs). It cannot be the system's single ledger as is. Its pinned files are also out of bounds for this work, since changing them is the governance decision held throughout.

## 3. Applying the concept and improving on it

Two codebases already hold the parts. TELOS contributes the strongest concepts. OPHANIM's controller chain already solved T6: P2 transition-chain verification, P6 delta records with full checkpoints, and P8 frontier-only re-verification.

The improved ledger keeps TELOS's concepts and generalizes them. It sits **above** the pinned TELOS rather than inside it, so no pinned file changes.

| TELOS concept, kept | Improvement |
|---|---|
| Signed, hash-chained, single head; refuse forks; verify before appending | **One system chain with many kinds.** Each entry is `{kind, author, derived_from[], payload_ref, parent, sig}`. Payloads are content-addressed. Kinds form a **closed registry**, each with a re-deriver, the way `POLICY_CHECK_KEYS` closes the policy checks. |
| Re-derivation by execution (`verify()` re-runs the test) | Every kind's re-deriver recomputes the entry from the entries it cites. An escalation re-derives through `nextStep`. A gate verdict re-derives through `shipClaim`. A repro re-runs the command in its recorded sandbox. A settlement re-runs its test. |
| Merkle effective-hash cascade | Entries cite their inputs (facts blob, seating blob, prior turn), so a changed input makes dependent entries stale instead of silently different. |
| Provider-scoped lineage (`provider:response_id`, `response_model`) | Applied to **every** model-produced entry, not only review packets. The model recorded is the **served** model from the provider response, beside the requested one. |
| Cold-review disjointness | Applied to every review-like kind: critique, refute, synthesis, audit. A seat cannot attest to an entry whose lineage includes its own responses. Pantheon's cross-lab rule becomes a ledger check. |
| Closed policy certificate with a derived outcome | Each decision entry carries its checks; the outcome is re-derived on replay. |
| Fail-closed authority (`CURRENT-AUTHORITY.json`) | A **genesis entry** pins the authority: signer keys, TELOS pins, checker pins, facts. Every later entry chains to it. Changing authority is itself an entry the operator signs. |
| *(limit T3)* | **Per-author keys.** Each seat signs its own entries (Ed25519 per seat id and occupancy generation). The controller co-signs only the ordering. A forged reviewer then needs that seat's key, not a shared secret. |
| *(limit T4)* | Settlement records become chain entries: no tolerant reader, no last-wins. A retry is a new entry citing the previous one. |
| *(limits T2, T6)* | **Anchoring and checkpoints.** TELOS proposal heads and board commits are anchored into the chain by head hash, so the pinned TELOS chains and the board DAG stay as they are and become replayable from one place. Verification resumes from signed checkpoints and re-derives only the frontier, as OPHANIM's P6 and P8 already do. |

**How the layers become one.** A model turn, an escalation, a review finding, a ship and an OPHANIM delta are all entries of one shape, verified one way. A review of the ledger is a set of entries citing the entries it reviewed, under the same disjointness rule. That is "the same layer scaling by hardening through provenance": each level adds entries, never a new mechanism.

**What the earlier inventories found, re-aimed.**
- G1, verifiers not on the path: becomes "replay re-derives every entry before use".
- G2–G4, decisions, inputs and turns off-ledger: these become entry kinds.
- G5, asserted authorship: becomes the served-model lineage plus per-seat keys.
- G6, duplicate provenance: there is one entry per fact, and the other shapes are projections of it.
- G7, side-file efficiency records: these become entry kinds, which closes the debit loophole by construction.
- G8, no authority anchor: becomes genesis.
- G9, thin repro evidence: becomes repro entries with the sandbox and command digests.
- G10, the ticket cid: the ticket entry is cited by cid.

## 4. Proposals, in order

| # | Step | Touches pinned TELOS? |
|---|---|---|
| K1 | **The chain core:** entry shape, closed kind registry, per-author Ed25519 signing, verify-before-append, checkpoints with frontier re-verification. Built from OPHANIM's controller-chain code and TELOS's proposal-ledger discipline, and tested in isolation. | No |
| K2 | **Genesis and anchoring:** a genesis entry pinning the authority, TELOS pins and facts, plus anchor entries for TELOS proposal heads and board commits. Fixes G8 for every reader of the chain. | No. It reads the pins and does not change them. |
| K3 | **The first kinds, where verifiers already exist:** `escalation` (re-derived by `nextStep`), `facts` (re-derived by `capabilityDrift`), `gate` (re-derived by `shipClaim`), `contribution` (re-derived by `verifyChairContributions`). These replace `run.json` copies, and the run reads them back through replay. | No |
| K4 | **Model turns as entries:** served-model lineage, cold-review disjointness for review kinds, and per-seat keys for Pantheon seats. | No |
| K5 | **OPHANIM efficiency events as entries:** assessed, debit, promoted, use, retained. The debit loophole closes. | No |
| K6 | **TELOS reviewers bound to real seats:** TELOS's `claude`, `agy` and `codex` packets signed by the Pantheon seats that produced them, instead of fixture secrets, and the pinned verifier admitting the chain's entries (P8/P9, the Q7 adjustment, signed transitions). | **Yes.** This is the governance decision. Everything before it prepares the evidence it would rest on. |

**The check after each step** is to replay the chain from genesis (or from a checkpoint) and re-derive every entry of the new kind. A step is not done until an entry that does not re-derive is refused on the path.

## 5. Status (standing rule: On Hold or Resolved)

| Item | Status | Basis |
|---|---|---|
| TELOS as the single ledger as is | Resolved: no | Limits T1–T6 above, read from the pinned source. |
| K1–K5 | On Hold | Proposed; awaiting the order to implement. None changes the pinned TELOS. |
| K6 TELOS reviewers bound to real seats, and pinned-verifier admission | On Hold | Governance decision on the pinned TELOS verifier and on who is trusted. |
| Earlier L1–L8 | Superseded | Re-aimed as K1–K6. The ledger is the improved chain anchored to TELOS, not the board DAG alone. |
