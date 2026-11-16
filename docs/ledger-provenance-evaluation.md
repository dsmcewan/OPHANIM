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
| K1 chain core | Resolved | `ophanim/ledger/chain.mjs`. See "K1 implemented" below. |
| K2 genesis and anchoring | Resolved | `chain.mjs` (genesis, authority) and `ophanim/ledger/anchors.mjs`. See "K2 implemented" below. |
| K3 first kinds (facts, seating, escalation, contribution) and the run path | Resolved | `ophanim/ledger/kinds.mjs`; `runOpenItem({ledger})`. See "K3 implemented" below. |
| K3 `gate` kind (ship gate verdicts) | Resolved | Ship's gates now evaluate against named heads (`gatesAt`, `pinnedRefs` in `integrate.mjs`); `ophanim/ledger/gate-kind.mjs` records and re-derives the verdict. See "Gate kind implemented" below. |
| K4 turns, served-model lineage, cold review, per-seat keys | Resolved | `ophanim/ledger/lineage-kinds.mjs`; served model captured in `sendTurn`; turns and reviews recorded on the run path. See "K4 implemented" below. |
| K5 | In progress | Independent of K4, so it runs in parallel rather than after it. |
| K6 TELOS reviewers bound to real seats, and pinned-verifier admission | On Hold | Governance decision on the pinned TELOS verifier and on who is trusted. |
| Earlier L1–L8 | Superseded | Re-aimed as K1–K6. The ledger is the improved chain anchored to TELOS, not the board DAG alone. |

## K1 implemented (2026-11-16)

`ophanim/ledger/chain.mjs`: one append-only chain (`chain.jsonl`) plus content-addressed payload objects.

| Property | How |
|---|---|
| One chain, many kinds | `defineKinds` builds a closed registry. Each kind declares `authors()`, `validate()` and `rederive(entry, view)`. An unknown kind is refused. `checkpoint` is reserved for the orderer. |
| Per-author signatures | Each entry's body is signed by its own author's Ed25519 key. The orderer co-signs only its position (seq, parent, body hash). A key cannot write as another seat, and a key outside the keyring is refused. |
| Re-derivation before append | `append` verifies the chain, then checks the new entry, including `rederive`, before writing. A refused entry leaves the ledger unchanged. An append onto a ledger that no longer verifies is refused. |
| Citations | `derived_from` may cite only earlier entries. A kind's re-deriver reads them through `view`. |
| Strict reading | A torn or unparseable line is an error. An altered payload object is refused, never repaired. |
| Checkpoints | Every N entries, the orderer writes a checkpoint committing to the hash of every earlier entry. `verify({mode: "frontier"})` re-hashes the whole prefix, so an edit anywhere is caught, but re-checks signatures and re-derives only after the last checkpoint. |

One trust assumption is stated rather than hidden: in frontier mode, entries before a checkpoint are trusted to have been verified when the orderer signed it. `verify({mode: "full"})` re-derives everything.

*Check.* `ophanim/ledger/chain.test.mjs` (8 tests, in `npm run test:proof`) covers:
- multi-author chains re-deriving;
- refusal before writing;
- the closed registry and per-kind authorship;
- per-author signing and foreign keys;
- forward citations;
- edits, reorders, deletions, truncation and payload tampering caught;
- frontier verification after checkpoints, with a pre-checkpoint edit still caught;
- an append refusing to extend a broken ledger.

## K2 implemented (2026-11-16)

**Genesis (fixes G8 for every reader of the chain).**
- The first entry is a `genesis`. Its payload is `{keyring, orderer, operators, pins}`. One of its operators signs it, and its orderer co-signs it.
- `openLedger` requires `anchor`, the genesis hash the reader pins. A ledger whose genesis is not that hash is refused: "a ledger may not name its own authority".
- `createLedger` writes the genesis and returns the hash to pin.

**Authority changes are entries.**
- An `authority` entry signed by a current operator adds or revokes keys, or changes the orderer or operators, from that point on.
- Earlier entries keep verifying under the authority they were signed under.
- A revoked key signs nothing after the revocation.
- A change that would leave no valid orderer or operator is refused.

**Anchors** (`ophanim/ledger/anchors.mjs`). The pinned TELOS chains and the board DAG are not changed. They are anchored.

| Kind | Payload | Re-derives by |
|---|---|---|
| `telos.anchor` | `{proposal_id, events, head}` | Reading the proposal chain with TELOS's own `proposal-ledger.mjs`, loaded only after its hash matches the pin for `0c9b539`. TELOS must verify the chain, and its event at the anchored position must be the anchored head. A chain that later grows still holds. A truncated or reordered one does not. |
| `board.anchor` | `{ref, commit}` | Walking the ref's history: the commit must still be in it. The board moving on is fine; a rewrite is not. |

*Check.*
- `ophanim/ledger/chain.test.mjs` (10 tests) adds two genesis cases:
  - a forged ledger under another authority verifies only against its own anchor, never the pinned one;
  - only an operator changes the authority, and revocation takes effect from that entry.
- `ophanim/ledger/anchors.test.mjs` (3 tests) covers:
  - board anchoring through a real Pantheon board;
  - TELOS anchoring with the real pinned TELOS (proposals created, grown, truncated and reordered);
  - refusal of an unpinned TELOS source.

With TELOS checked out at the pin (`OPHANIM_TELOS_ROOT`), `npm run test:proof` passes 141 of 141 here, including the 21 cases that previously could not run in this container.

## K3 implemented (2026-11-16)

Each kind is re-derived by a verifier that already existed but had no caller on the path.

| Kind | Payload | Re-derives by |
|---|---|---|
| `facts` | the cited capability facts | Every recorded figure carries the `source` and `quote` it was read from, or is `UNRECORDED`. The evidence travels with the value. |
| `seating` | the seating table, per role | It cites exactly one `facts` entry, and every seated model is a cited fact or a declared lane model. |
| `escalation` | a protocol record (the run's notes kept outside) | `verifyEscalation` re-derives it from the `facts` and `seating` entries it **cites**, not from the code of the day. Decisions for the same work are chained by citation, so the step count must continue. |
| `contribution` | `{heads, projection}` | `chairContributions` recomputed from the named board heads. They are content-addressed, so the entry still re-derives after the board moves on. |

Inputs are entries, never edits. A changed fact is a new `facts` entry, and a decision cites the one it used. The test shows the consequence: under facts that listed `gpt-6-sol`'s efforts only up to `high`, a rejection at `high` correctly steps a rung. That entry still re-derives even though today's code would raise effort instead. The same decision citing nothing, or not following from what it cites, is refused.

**On the run path.** `runOpenItem(spec, {ledger})` takes a recorder (`escalationRecorder` in `kinds.mjs`):
- the run verifies the ledger before relying on anything, and refuses to run if it does not verify;
- every escalation it makes (truncation, acceptance, review) is recorded as an entry citing the facts and seating it was decided under;
- `run.json` keeps its copy for display; the ledger entry is the one that re-derives.

*Check.*
- `ophanim/ledger/kinds.test.mjs` (5 tests) covers uncited facts, seating citations, escalations re-deriving against cited facts, step continuity by citation, and contributions after the board moves on.
- `pantheon/tests/route-protocol.test.mjs` adds an end-to-end run. A truncation is recorded on the ledger, citing its inputs, and verifies on replay. A ledger altered afterwards stops the next run before it starts.
- Suites:
  - `npm run test:proof`: 146 of 146, with TELOS at the pin;
  - Pantheon: 811 pass, plus the 1 known environment failure;
  - model client: 48 pass.

## K4 implemented (2026-11-16)

**Ordering.** K4, K5 and the K3 `gate` kind depend on nothing between them, so they run in parallel. Numbering them implied a sequence that did not exist.

**The served model** (`pantheon/src/sdk/adapter.mjs`).
- `sendTurn` observes the client at one point and returns `served_model`: what the provider reported answering, read from Responses `model`, Messages `model` (on `message_start` when streamed) and Gemini `modelVersion`.
- It covers both the frontier and the direct path, unary and streamed.
- A provider that reports nothing yields `null`, never a guess.
- `run.json` turns carry it too.

**Kinds** (`ophanim/ledger/lineage-kinds.mjs`).

| Kind | Re-derives by |
|---|---|
| `turn` | <ul><li>Signed by the key of the seat occupancy that answered (`seat:<seat_id>#<occupancy_gen>`).</li><li>The reply matches its digest.</li><li>A response id may not be a placeholder (TELOS's own rule).</li><li>The same occupancy may not change model: a reseat is a new occupancy, with a new key.</li><li>A seat's turns chain by citation.</li></ul> |
| `review` | <ul><li>Signed by the reviewing seat's key.</li><li>It cites the turns it reviews.</li><li>**Cold review:** no seat, lab or response anywhere in the cited lineage may have made the review.</li><li>A lane model names its lab, so a Claude model served through an agy seat counts as Anthropic.</li></ul> |

**Per-seat keys.** The recorder generates a key per seat occupancy on first use and admits it with an operator `authority` entry before that seat's first entry. A forged turn or review then needs that seat's private key. Another admitted key cannot sign as it, unlike TELOS's shared HMAC secrets.

**On the run path.**
- `runOpenItem({ledger})` records every model turn (plan, work, critique; agy turns with `served_model: null`).
- Work turns cite the plan turn they followed.
- The critique is recorded as a `review` citing the work turn, so cold review covers the planner's lab as well. That is the same rule `assertReviewCutsAcross` enforces live, now re-derivable from the ledger.

*Check.*
- `ophanim/ledger/lineage-kinds.test.mjs` (4 tests) covers:
  - per-seat signing and refusal of another key;
  - reply, placeholder and model-change refusals;
  - cold review across direct, transitive and lane-model lineage, and self-review;
  - the served model on all three surfaces, unary and streamed.
- `pantheon/tests/route-protocol.test.mjs`: the ledger run records turns from at least three seats, and a review citing the work, which cites the plan.
- Suites:
  - `npm run test:proof`: 150 of 150, with TELOS at the pin;
  - Pantheon: 811 pass, plus the 1 known environment failure;
  - model client: 48 pass.

## Gate kind implemented (2026-11-16)

**What a ship's gates read** (`ship({dryRun})` and `shipClaim`), and how each is pinned:

| Read | Gate(s) | Pinned by |
|---|---|---|
| `refs.resolve(ref)`, `refs.resolve(from)` | TICKET, GRAFT, LEASE, REVIEW, TESTS, MERGE | `heads`: the `{name, cid}` of both, recorded. `pinnedRefs(heads)` resolves from the record only. |
| `refs.list()`, `refs.resolve(offer_ref)` (in `boardState`) | none | Answered from the record; no gate consumes them. |
| Content-addressed store | all but ACTOR, TARGET | Nothing to pin: the cids mean the same thing after the refs move. |
| `runtime.leases()`, judged at `now` | LEASE | `leases` (the active rows, the fields LEASE reads) and `now`, recorded. The lease file is not content-addressed, so these are a signed input, like `facts`. |
| `runtime.occupancy()`, `runtime.budget()` | none | Neutral values; no gate consumes them. |

**Change to `integrate.mjs` (behaviour-preserving).**
- Ship's gate code moved into a synchronous `evaluateGates`; `ship` calls it, then writes its one commit exactly as before. Refusals and dry runs return the same objects.
- `gatesAt({store, heads, ref, from, actor, graft, leases, now})` runs the same evaluator through `pinnedRefs(heads)` and returns the `shipClaim`. It is a second caller of the evaluator, not a copy. It is synchronous, as a re-deriver must be.

**The kind** (`ophanim/ledger/gate-kind.mjs`; `kinds.mjs` is unchanged):

| Kind | Payload | Re-derives by |
|---|---|---|
| `gate` | `{ref, from, heads, actor, now, leases, graft?, claim}` | Every head must be a commit in this board's store, and the board head must still be in the ref's history. Then `gatesAt` recomputes the claim, compared with `canonical`. |

- `gateKinds({authors, board: {store, refs}})`: authors is the controller.
- `gateRecord(...)` builds the payload from the live board. It reads the heads and leases once, computes the claim from that record, and refuses if a live `shipClaim` at the same moment disagrees.

*Check.* `ophanim/ledger/gate-kind.test.mjs` (4 tests, on a real Pantheon board) covers:
- a held-lease refusal and a green verdict recorded, the ship landing, the branch moving on, and both entries still re-deriving;
- forgeries refused: `tests_passed` flipped, LEASE quietly green, lease rows dropped, a later `now`, a non-controller author;
- heads refused when they are not on this board (a commit from another board, a made-up cid) or not in the ref's history;
- `gatesAt` equal to the live `shipClaim`, for the controller and for a chair.

Suites:
- `npm run test:proof`: 150 of 150, with TELOS at the pin;
- Pantheon: 811 pass, plus the 1 known environment failure.
