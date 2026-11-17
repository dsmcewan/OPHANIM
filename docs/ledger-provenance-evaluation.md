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
| K1 chain core | Resolved | `packages/ledger/chain.mjs`. See "K1 implemented" below. |
| K2 genesis and anchoring | Resolved | `chain.mjs` (genesis, authority), `ophanim/ledger/anchors.mjs` (TELOS) and `pantheon/src/ledger/anchors.mjs` (board). See "K2 implemented" below. |
| K3 first kinds (facts, seating, escalation, contribution) and the run path | Resolved | `pantheon/src/ledger/kinds.mjs`; `runOpenItem({ledger})`. See "K3 implemented" below. |
| K3 `gate` kind (ship gate verdicts) | Resolved | Ship's gates now evaluate against named heads (`gatesAt`, `pinnedRefs` in `integrate.mjs`); `pantheon/src/ledger/gate-kind.mjs` records and re-derives the verdict. See "Gate kind implemented" below. |
| K4 turns, served-model lineage, cold review, per-seat keys | Resolved | `pantheon/src/ledger/lineage-kinds.mjs`; served model captured in `sendTurn`; turns and reviews recorded on the run path. See "K4 implemented" below. |
| K5 efficiency events as entries, and the debit loophole | Resolved | `ophanim/ledger/efficiency-kinds.mjs`; `assessConvergence({ledger})`, `chooseEfficiencySlots({ledger})`. See "K5 implemented" below. |
| K5 `assessed` and `retained` kinds | Resolved | `efficiency.trace`, `efficiency.assessed`, `efficiency.retained` in `ophanim/ledger/efficiency-kinds.mjs`, re-derived by the same computations the file verifiers run; a fresh assessment is verified before `cli.mjs` uses it. See "K5b implemented" below. |
| Lease rows, budget limits, ref moves and seat files on the ledger | Resolved | `pantheon/src/ledger/board-kinds.mjs`; seat files checked in `sdkTurn`. See "Remaining records on the ledger" below. |
| K6 TELOS reviewers bound to real seats, and pinned-verifier admission | On Hold | Governance decision on the pinned TELOS verifier and on who is trusted. |
| Earlier L1–L8 | Superseded | Re-aimed as K1–K6. The ledger is the improved chain anchored to TELOS, not the board DAG alone. |

## K1 implemented (2026-11-16)

`packages/ledger/chain.mjs`: one append-only chain (`chain.jsonl`) plus content-addressed payload objects.

| Property | How |
|---|---|
| One chain, many kinds | `defineKinds` builds a closed registry. Each kind declares `authors()`, `validate()` and `rederive(entry, view)`. An unknown kind is refused. `checkpoint` is reserved for the orderer. |
| Per-author signatures | Each entry's body is signed by its own author's Ed25519 key. The orderer co-signs only its position (seq, parent, body hash). A key cannot write as another seat, and a key outside the keyring is refused. |
| Re-derivation before append | `append` verifies the chain, then checks the new entry, including `rederive`, before writing. A refused entry leaves the ledger unchanged. An append onto a ledger that no longer verifies is refused. |
| Citations | `derived_from` may cite only earlier entries. A kind's re-deriver reads them through `view`. |
| Strict reading | A torn or unparseable line is an error. An altered payload object is refused, never repaired. |
| Checkpoints | Every N entries, the orderer writes a checkpoint committing to the hash of every earlier entry. `verify({mode: "frontier"})` re-hashes the whole prefix, so an edit anywhere is caught, but re-checks signatures and re-derives only after the last checkpoint. |

One trust assumption is stated rather than hidden: in frontier mode, entries before a checkpoint are trusted to have been verified when the orderer signed it. `verify({mode: "full"})` re-derives everything.

*Check.* `packages/ledger/tests/chain.test.mjs` (8 tests then; it ran in `npm run test:proof` until the move to `packages/ledger`, see "Layering") covers:
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

**Anchors** (`ophanim/ledger/anchors.mjs` for TELOS, `pantheon/src/ledger/anchors.mjs` for the board). The pinned TELOS chains and the board DAG are not changed. They are anchored.

| Kind | Payload | Re-derives by |
|---|---|---|
| `telos.anchor` | `{proposal_id, events, head}` | Reading the proposal chain with TELOS's own `proposal-ledger.mjs`, loaded only after its hash matches the pin for `0c9b539`. TELOS must verify the chain, and its event at the anchored position must be the anchored head. A chain that later grows still holds. A truncated or reordered one does not. |
| `board.anchor` | `{ref, commit}` | Walking the ref's history: the commit must still be in it. The board moving on is fine; a rewrite is not. |

*Check.*
- `packages/ledger/tests/chain.test.mjs` (10 tests) adds two genesis cases:
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
- `pantheon/tests/ledger-kinds.test.mjs` (5 tests) covers uncited facts, seating citations, escalations re-deriving against cited facts, step continuity by citation, and contributions after the board moves on.
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

**Kinds** (`pantheon/src/ledger/lineage-kinds.mjs`).

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
- `pantheon/tests/ledger-lineage-kinds.test.mjs` (4 tests) covers:
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

**The kind** (`pantheon/src/ledger/gate-kind.mjs`; `kinds.mjs` is unchanged):

| Kind | Payload | Re-derives by |
|---|---|---|
| `gate` | `{ref, from, heads, actor, now, leases, graft?, claim}` | Every head must be a commit in this board's store, and the board head must still be in the ref's history. Then `gatesAt` recomputes the claim, compared with `canonical`. |

- `gateKinds({authors, board: {store, refs}})`: authors is the controller.
- `gateRecord(...)` builds the payload from the live board. It reads the heads and leases once, computes the claim from that record, and refuses if a live `shipClaim` at the same moment disagrees.

*Check.* `pantheon/tests/ledger-gate-kind.test.mjs` (4 tests, on a real Pantheon board) covers:
- a held-lease refusal and a green verdict recorded, the ship landing, the branch moving on, and both entries still re-deriving;
- forgeries refused: `tests_passed` flipped, LEASE quietly green, lease rows dropped, a later `now`, a non-controller author;
- heads refused when they are not on this board (a commit from another board, a made-up cid) or not in the ref's history;
- `gatesAt` equal to the live `shipClaim`, for the controller and for a chair.

Suites:
- `npm run test:proof`: 150 of 150, with TELOS at the pin;
- Pantheon: 811 pass, plus the 1 known environment failure.


## K5 implemented (2026-11-16)

**Interim hardening (file path, no ledger).** Both holes are closed in `ophanim/efficiency/assessment.mjs` on their own.

| Hole | Was | Now |
|---|---|---|
| Legacy aggregate in `assessment-costs/` | Summed with `?? 0`, no sign or shape check. A file with `-100000` raised the measured saving. | Read only in the shape the earlier writer produced: `additionalAssessmentCostMs` and `unmeasuredAssessments` as non-negative safe integers, plus its optional bookkeeping hashes. Anything else is refused. Write-once debits get the same check. |
| `.result.json` | Every file in `uses/` counted as a qualified convergence. | Counted only when bound (`resultBindsToUse`): its use intent exists under the same name, names the promotion's scope and the state directory the name is derived from, and that directory holds an accepted 3-slot trace with the result's `traceSha` and duration. The saving must re-derive from the promotion's figures. Unbound files are reported as `unboundResults`, never counted. |

**Ledger kinds** (`ophanim/ledger/efficiency-kinds.mjs`).

| Kind | Cites | Re-derives by |
|---|---|---|
| `efficiency.promotion` | nothing (its authority is the signed decision it names) | 1 → 3 slots only, `maxUses` = 20, non-negative integer figures, `conservativeSavedMs` = baseline − candidate. |
| `efficiency.use` | exactly one promotion | `useId` = digest of the state directory. Scope and decision match the promotion. One use per state directory, and **at most 20 per promotion, counted from the earlier `efficiency.use` entries on the chain**. |
| `efficiency.result` | exactly one use | `observedSavingMs` = the cited promotion's `baselineConservativeMs` − `executionMs` − `assessmentCostMs`. One result per use. |
| `efficiency.debit` | exactly one use | Non-negative integer cost. One debit per trace per use. `charged` is false exactly when a result for the same trace is already on the chain, so a cost is never charged twice and never skipped. |

- `chain.mjs` gains one accessor: `view.entries()` returns the hashes of every earlier entry, in chain order. The cap and the double-charge rule count through it.
- `efficiencyTotals` (qualified convergences, debits, unmeasured assessments, measured net) is computed only from a ledger that verifies.

**On the path.** `assessConvergence({ledger})` and `chooseEfficiencySlots({ledger})` take an `efficiencyRecorder`, as `runOpenItem` takes its `opts.ledger`. `executeRequest(request, {ledger})` passes it through; it holds signing keys, so it never comes from a request file.
- The ledger is verified before anything is relied on. A ledger that does not verify stops the assessment.
- A promotion is recorded on the ledger before `promotion.json` is written.
- A use is granted only by the ledger's cap.
- The result and the debit are recorded as entries citing the use, and `measuredValue` comes from the ledger totals, with the entry hashes beside it.
- Without a ledger, the hardened file path is unchanged in shape.

*Check.*
- `ophanim/efficiency/measured-value.test.mjs` (2 tests): a negative or invented legacy aggregate and a negative debit are refused; forged result files (no use; a use whose state directory holds no such trace) are not counted. Both tests fail against the pre-change `assessment.mjs` (the `-100000` aggregate is accepted; 3 convergences counted instead of 1) and pass after.
- `ophanim/ledger/efficiency-kinds.test.mjs` (5 tests): promotion figures, the 20-use cap counted on the chain, savings re-derived from the cited promotion, debits non-negative and never double-charged, totals refused on an edited ledger, and an assessment recording on the ledger and refusing an altered one.
- `packages/ledger/tests/chain.test.mjs` (11 tests) adds `view.entries()`: an entry sees only what came before it, on append and on replay.
- Suites:
  - `npm run test:proof`: 154 of 154, with TELOS at the pin;
  - Pantheon: 811 pass, plus the 1 known environment failure.

*Not done here.*
- A fresh assessment is still not passed through `verifyEfficiencyRecord` before `cli.mjs` uses it. As written, that verifier refuses held investigation receipts, which a normal run can produce. (Resolved in K5b.)
- The promotion entry does not re-verify the signed decision. That check is async and governance-held (`verifyEfficiencyDecision`); the controller records the entry only after it passes.
- `cli.mjs` creates no ledger of its own. Key custody stays with the caller, as for `runOpenItem`.

## K5b implemented (2026-11-17)

**Why a fresh assessment was not verified (root cause, at `99a23d7`).**

| Where | What |
|---|---|
| `ophanim/efficiency/assessment.mjs:315-322` | When `recordInvestigation` throws, the assessment records a held receipt (`ophanim.investigation-blocked/v1`) and carries on. |
| `ophanim/efficiency/investigation/controller.mjs:31`, `:234`, `:203` | Normal runs make it throw: an operator forecast kept from another scope ("Exact scoped investigation forecast required"), a retired source state directory behind a retained packet (`lstatSync`), or the investigation lock timing out. |
| `ophanim/efficiency/assessment.mjs:449-450` | `verifyEfficiencyRecord` threw on **every** held receipt ("Held investigation evidence does not qualify for independent verification"). |
| `ophanim/cli.mjs:161-163` | So `cli.mjs` could not verify a fresh assessment without failing those runs, and used it unverified. |

**The verifier fix.** A held receipt is accepted only when it is:
- bound to its trace in the exact shape the catch writes (`scopeSha`, `traceSha`, `boardCommit`, the fixed reason, a detail string of at most 256 characters, nothing else);
- for a decision that depends on retained evidence. Where the decision needs none (an untrusted or non-accepted trace), it is a pure function of the trace (`investigationWithoutEvidence` in `controller.mjs`), so a held receipt in its place is a substitution and is refused.

`cli.mjs` now runs `verifyEfficiencyRecord` on the fresh record before it is put on the output or written to `result.json`.

**Kinds** (`ophanim/ledger/efficiency-kinds.mjs`).

| Kind | Payload | Cites | Re-derives by |
|---|---|---|---|
| `efficiency.trace` | `{stateDir, traceSha, trace}`, the trace whole | nothing; it names its board commit | `traceSha` is the trace's digest. `traceBinding`: the board commit's state digest, acceptance evidence and scope fingerprint match, and the analysis re-runs. One entry per trace. |
| `efficiency.assessed` | `{traceSha, report}` | its trace first; then the `efficiency.retained` its admission read, and the `efficiency.debit` its measured value ends on, when there are | `rederiveAssessment` on the cited trace: the computation `verifyEfficiencyRecord` now delegates to. The measured value is either the unrecovered assessment cost (no use) or the promotion's totals over the chain up to the head it names. One entry per trace. |
| `efficiency.retained` | `{marker}` | exactly one `efficiency.assessed` (the run that wrote the marker) | `retainedExperimentFrom`, the computation `readRetainedExperiment` now delegates to, given the cited report and trace instead of their files. One entry per experiment. |

- The replay manifest, trial verifications and investigation packets stay content-addressed files. The board stays the board. Both are read by hash, as the `gate` kind reads its heads.
- `efficiencyKinds({snapshot})` and `efficiencyRecorder({snapshot})` take the board reader; the default is `readRuntimeSnapshot`.

**On the path** (`assessConvergence({ledger})`, through the existing `efficiencyRecorder`):
- the trace is recorded as soon as `trace.json` is written;
- the report is recorded after `assessment.json`, citing the trace, the debit and any retained experiment; a report that does not re-derive is refused there and the assessment fails;
- with a ledger, a prior experiment is read from its `efficiency.retained` entry, not the marker's files. A marker with no retained entry holds the admission (`retained-experiment-held`), as an unreadable marker does on the file path;
- the run that writes a marker records `efficiency.retained` only when its experiment completed as prior evidence;
- the record carries `ledger: {trace, assessed, retained?}`.

Without a ledger the file path is unchanged.

*Check.*
- `ophanim/efficiency/fresh-verification.test.mjs` (2 tests):
  - a normal run with a stale forecast records a held receipt, is verified, and writes its result. It fails at `99a23d7` with the error above.
  - a forged fresh assessment is refused: a held receipt rebound, re-reasoned, or given a decision; a held receipt substituted where the decision needs no evidence (a release activation); an admitted decision, an altered analysis, a changed outcome.
- `ophanim/ledger/efficiency-kinds.test.mjs` (6 tests) adds a real run recording `efficiency.trace` and `efficiency.assessed`:
  - the ledger still verifies after `trace.json` and `assessment.json` are deleted;
  - forged traces (other state, other directory, wrong digest) and assessments (admitted, promoted, rebound receipt, invented measured value, uncited prior, other trace, wrong author, duplicate) are refused;
  - a marker whose experiment never completed is refused as `efficiency.retained` and declined by the recorder.
- The existing assessment-on-ledger test now also checks the report entry citing the trace and the debit.
- Suites:
  - `npm run test:proof`: 165 of 165, with TELOS at the pin;
  - Pantheon: 811 pass, plus the 1 known environment failure.

*Not done here.*
- A **completed** experiment recorded as `efficiency.retained` is not exercised end to end. That needs a full 1 → 3 replay with independent qualification, which no test in the suite runs. The refusal paths are tested; the positive path shares `retainedExperimentFrom` with `readRetainedExperiment`.
- In the evidence-dependent case, a held receipt cannot show which failure produced it (forecast, retired source, lock). It is bound to the trace and carries no authority, but substituting it for a real receipt there is not detectable.
- `cli.mjs` still creates no ledger of its own (unchanged from K5).

## The ledger by default (cycle 8, 2026-11-17)

The cycle review named "the ledger is opt-in" as the largest remaining gap. It is now on by default.

| Piece | How |
|---|---|
| Ledger home | `ophanim/ledger/system.mjs`, `openSystemLedger({root, board, anchor})` (since the layering move: the home itself is `packages/ledger/home.mjs`, and a Pantheon run opens `openPantheonLedger` in `pantheon/src/ledger/system.mjs`). It opens, or on first use creates, a ledger with every kind registered: facts, seating, escalation, contribution, turn, review, the efficiency kinds, and, when a board is given, gate and board anchors. |
| Trust | First use writes the genesis and pins its hash in `ANCHOR`. An expected anchor (argument or `OPHANIM_LEDGER_ANCHOR`) must match. A chain without its anchor is refused, never trusted on its own word. |
| Key custody | `keys/` (0700) holds one owner-only file (0600) per private key: operator, controller, and each seat occupancy. Keys never enter the chain. A key readable by others, or one that does not match the authority's public key, is refused. |
| Seat keys across runs | A seat occupancy keeps its key and is admitted once. `rotateSeatKey` revokes and re-admits, and earlier entries still verify. |
| Inputs once | Identical facts and seating entries already on the chain are reused, so a shared ledger grows by what changed. |
| Default on | `runOpenItem` records at `OPHANIM_LEDGER` or `<board root>/ledger`. `executeRequest` records at `OPHANIM_LEDGER` or `<stateDir>/ledger`. `ledger: false` opts out, and replays get none. |

**Found by turning it on.** Multi-slot runs give each slot its own implementer (one slot on gpt-6-astra, another on gpt-6-sol). The ledger had recorded both under one seat and correctly refused the second turn as a model change without a reseat. The seat is now identified the way the conversation layer keys it (vendor, purpose and model), so they are two seats. An equilibrium reuse now names the same ledger entries as the fresh assessment instead of none.

*Check.*
- `ophanim/ledger/system.test.mjs` (4 tests) covers:
  - creation, pinning and permissions;
  - refusal of a wrong anchor, a lost anchor, an exposed key and a swapped key;
  - inputs and seat keys reused across runs, and rotation;
  - the key store refusing overwrites.
- `ophanim/ledger/cli-default.test.mjs` covers the CLI on by default and opted out.
- `pantheon/tests/route-protocol.test.mjs` covers a run on by default: genesis, facts, seating, turns, review and escalation recorded and verifying. It also covers `ledger: false` writing nothing.
- Suites:
  - `npm run test:proof`: 170 of 170, with TELOS at the pin;
  - Pantheon: 812 pass, plus the 1 known environment failure;
  - model client: 48 pass.

**Still to do.**
- **Layering:** Pantheon reaches the ledger through a dynamic import of `ophanim/ledger`. The ledger belongs in a shared package (`packages/ledger`). Done: see "Layering" below.
- **Shared ledger:** gate and contribution kinds re-derive against the board the ledger was opened with, so one shared ledger across boards needs a board resolver per entry. Done: see "Shared ledgers and the run-path gate" below.
- **Key custody:** it is a local key store; a hardware or remote signer would replace `keyStore`.


## Remaining records on the ledger (2026-11-17)

The cycle review (item 5) named the records still off the ledger or only signed inputs. Four are now entries or checked against them. The `run.json` display copies stay display copies.

| Record | Was | Now |
|---|---|---|
| Lease rows (`runtime/leases.json`) | Mutable table; a signed input to the LEASE gate | A `lease` entry per grant, renewal, release, expiry and fence |
| Budget limits (`runtime/budget.json`) | Overwritten, `declared_at` mutable | A `budget` entry per declared cap, citing the one it replaces |
| Ref moves (`refs/`, reflog) | Ref files plus a display reflog | A `ref.move` entry per successful swap, citing the previous move of that ref |
| Seat conversation files | Self-attesting: the chain is recomputed from the file | Checked against the ledger's `turn` entries for the seat at handoff |

**Kinds** (`pantheon/src/ledger/board-kinds.mjs`, registered in `systemKinds`, authored by the controller). Each entry names its board (`scope`, the board root) and cites exactly the latest entry for the same lease, budget or ref; a skipped, stale or forked citation is refused.

| Kind | Payload | Re-derives by |
|---|---|---|
| `lease` | `{scope, resource, event, gen, holder, when, expires_at?, reason?}` | <ul><li>`granted` follows an inactive entry at gen + 1; `fenced` is gen + 1 with a reason.</li><li>`renewed`, `released`, `expired` keep the active gen and holder; `expired` only at or after `expires_at`.</li><li>Time does not run backwards; an active lease expires after it was granted.</li><li>`observed` records a lease the ledger had not seen (a board older than its ledger), only as the first entry for it.</li></ul> |
| `budget` | `{scope, limits, declared_at}` | Non-negative `max_turns` / `max_usd`; declared no earlier than the cap it replaces. |
| `ref.move` | `{scope, name, from, to, msg, by, reset}` | <ul><li>`from` is where the previous move left the ref.</li><li>`to` is a commit in the board's store whose history contains `from`, unless `reset` is true.</li></ul> |
| `turn` (extended) | adds `prompt_sha` and `tools` | The reply's exchange digest is recomputed from the reply and tools; the prompt digest is carried (prompts are not kept). |
| `gate` (extended) | adds `lease_scope` | With it, the lease rows must be exactly those the board's latest active `lease` entries derive, and the verdict cites exactly those entries. |

**On the path.**
- `openBoard(root, {ledger})` and `board.useLedger(rec)` take a board recorder (`recorder().board(root)`). Pantheon never imports the ledger for this; `runOpenItem` attaches the default ledger's recorder.
- Runtime and refs record **before** the file changes. A record the ledger refuses:
  - a lease change throws, and the table is not written;
  - a swap returns `LEDGER_REFUSED`, and the ref does not move;
  - `refs.swap({reset: true})` is the only way to move a ref to a non-descendant, and it is recorded as a reset.
- `runtime.budget()` reads the declared limits from the ledger. It reports `declared_binding` and `declared_file_mismatch`; an edited `budget.json` does not raise the cap. Spend stays bound to commits.
- `sdkTurn({ledger: {exchanges()}})`: at handoff, every stored exchange must match the ledger's turn entries for the seat, in order (`unmatchedExchange`), or the turn is refused as `LEDGER_MISMATCH`. `runOpenItem` passes the seat's entries, and records `prompt_sha` and `tools` with each turn.
- `gateRecord({leaseLedger})` refuses a runtime table that differs from the ledger's; `gateLeaseCitations` gives the entries to cite.
- `ledger: false`, or no recorder: every file path is unchanged.

*Check.*
- `pantheon/tests/ledger-board-kinds.test.mjs` (6 tests), on a real Pantheon board recording on the system ledger:
  - lease events and generations recorded; forged grants, fences, renewals, uncited and early-expiry records refused;
  - a lease row edited in the file is refused at its next change, and the file is left unchanged;
  - the gate citing its lease entries; a dropped row, missing citation or missing scope refused;
  - an edited `budget.json` not raising the cap; caps uncited, out of order or negative refused;
  - a ref moved by hand and a history rewrite refused as `LEDGER_REFUSED`; a recorded reset accepted; forged moves refused;
  - without a ledger, the earlier behaviour.
- `pantheon/tests/ledger-seat.test.mjs` (5 tests): an honest seat continues; an edited reply or prompt, reordered or injected exchanges, and an exchange persisted but never recorded are refused as `LEDGER_MISMATCH`; without a ledger, only the file check applies.
- Against the pre-change Pantheon files, all 6 board tests and the 3 seat-refusal tests fail.
- `pantheon/tests/route-protocol.test.mjs`: the default-ledger run also records `lease` and `ref.move`, every ref is where its last recorded move left it, and every turn carries `prompt_sha`.
- Suites:
  - `npm run test:proof`: 181 of 181, with TELOS at the pin;
  - Pantheon: 812 pass, plus the 1 known environment failure;
  - model client: 48 pass.

**Limits.**
- `observed` is a signed input, like the gate's lease rows were: a lease the ledger never saw is taken as it stands, once.
- A ref move is checked against its board's store only while that board exists (the opened board, or another board at its `scope`). For a removed board, only its move chain is checked.
- Prompts are not on the ledger, only their digests. A turn recorded before `prompt_sha` existed matches any prompt.
- A seat file from a run whose turns were not recorded (a board resumed from before the ledger) is refused, not adopted.
- The gate's lease citations are available to callers; no gate entry is recorded on the run path yet, as before. Done: see "Shared ledgers and the run-path gate" below.

## Layering (2026-11-17)

The dependency ran both ways: Pantheon dynamic-imported `ophanim/ledger/system.mjs`, and `ophanim/ledger/*` imported OPHANIM (`board.mjs`'s canonical form, `efficiency/*`) and Pantheon (route protocol, contributions, seating, config, integrate, dag). It now runs one way: OPHANIM -> Pantheon -> `packages/ledger`.

| Layer | Holds | Imports |
|---|---|---|
| `packages/ledger` (`@argo/ledger`) | `canonical.mjs` (canonical JSON and digest, the same bytes as `ophanim/board.mjs`); `chain.mjs` (chain, genesis, authority, checkpoints, `defineKinds`); `home.mjs` (`keyStore`, `openLedgerHome`: ANCHOR pinning, create/open, key checks, `rotateKey`); `status.mjs` (the status board and its CLI) | nothing outside itself |
| `pantheon/src/ledger` | Pantheon's kinds: `kinds.mjs` (facts, seating, escalation, contribution), `lineage-kinds.mjs` (turn, review), `gate-kind.mjs` (gate), `board-kinds.mjs` (lease, budget, ref.move), `anchors.mjs` (board.anchor, `boardResolver`); `system.mjs`: `pantheonLedgerKinds`, `openPantheonLedger`, the default for `runOpenItem` | `packages/ledger`, Pantheon |
| `ophanim/ledger` | OPHANIM's kinds: `efficiency-kinds.mjs`, `anchors.mjs` (telos.anchor, `telosResolver`, composed with the board anchor); `system.mjs`: `systemKinds`, `openSystemLedger`, the full composition the OPHANIM CLI opens | `packages/ledger`, `pantheon/src/ledger`, OPHANIM |

**A move, not a redesign.** No kind's name, authors, rules or payload shape changed, and `LEDGER_SCHEMA` is still `ophanim.ledger/v1`. `systemKinds` is `pantheonLedgerKinds` plus the efficiency kinds, so an entry a Pantheon run records re-derives the same way under OPHANIM's composition. No shims were left at the old `ophanim/ledger` paths; every import was updated. The status CLI is now `node packages/ledger/status.mjs verify|render|set`, and `docs/STATUS.md` was regenerated with `render` so its instructions name that path.

**One consequence of the closed registry.** A ledger that already holds efficiency entries (an `OPHANIM_LEDGER` shared with the OPHANIM CLI) is refused by Pantheon's composition (`kind "efficiency.trace" is not in the registry`), where before the move Pantheon opened OPHANIM's. Such a run takes OPHANIM's recorder (`runOpenItem(spec, {ledger: openSystemLedger(...).recorder()})`). The other direction always works. Resolved for ledgers that declare their domains: see "Shared ledgers and the run-path gate" below.

*Check.*
- `ophanim/ledger/layering.test.mjs` (4 tests, in `npm run test:proof`):
  - no file in `packages/ledger` imports outside it, and no file in `pantheon/` imports `ophanim/`;
  - the core's canonical form and digest equal `ophanim/board.mjs`'s on edge values, with the same refusals;
  - every Pantheon kind is in `systemKinds` under the same name and the same rule functions, and OPHANIM adds only `efficiency.*`;
  - a ledger written with `openPantheonLedger` (facts, seating, turn, review, budget, ref.move, board.anchor) verifies and keeps growing under `openSystemLedger`, and Pantheon still reads what OPHANIM appended with Pantheon's kinds.
- `packages/ledger/tests` (`npm test` in that package, and in the root `npm test`): chain (11), status (3), home (4), canonical (3). The canonical tests pin digests recorded from `ophanim/board.mjs` before the move and verify the committed `status/ledger` against its anchor.
- Ledgers written by the pre-move code (a Pantheon run alone; a Pantheon run and an OPHANIM CLI run on one ledger) verify under the new compositions, and a new Pantheon run appends to the pre-move one and still verifies under `openSystemLedger`.
- The chair-ranking checks that made Pantheon's tests import `ophanim/efficiency/investigation/chairs.mjs` moved to `ophanim/efficiency/investigation/chairs-board.test.mjs`.
- Suites (before -> after; tests moved, none dropped):
  - `npm run test:proof`: 184 -> 152 of 152, with TELOS at the pin (38 moved out: 14 to `packages/ledger`, 24 to Pantheon; 6 added);
  - Pantheon: 812 -> 836 pass (24 moved in), plus the 1 known environment failure;
  - `packages/ledger`: 21 pass (14 moved in, 7 added);
  - model client: 48 pass.

## Shared ledgers and the run-path gate (2026-11-17)

Two gaps left open above: a ledger shared by several boards could not verify (`board-resolver`), and a ship recorded no gate entry (`gate-on-run-path`).

**One ledger, several boards.** `contribution` and `gate` entries now name their board, as the board kinds already did. Each entry is re-derived against the board it names, through one resolver (`pantheon/src/ledger/scopes.mjs`, `boardScopes`), which `ref.move` now uses too.

| Entry names | Re-derived against |
|---|---|
| the opened board's root | the opened board |
| another root, with a board there | that board, opened read-only |
| a root with no board there | nothing that needs a store. The ledger-side checks still run (shape, the gate's lease rows and citations). The verify result lists the entry in `partial` |
| no scope (recorded before this change) | the opened board, as before; refused when no board was opened |

- Kind names are unchanged. `scope` is an optional, absolute payload field. A gate's `lease_scope` must equal its `scope`.
- `gateRecord` fills `scope` from the board recorder, or else from the board's `root`.
- `gate` and `contribution` are registered with or without an opened board.
- Core: `view.note(why)` lets a kind report the part it could not re-derive. `verify()` returns `partial` ([{seq, kind, why}]), `foreign` and `complete`.

**Another domain on the same ledger.** Before this change, a Pantheon run on a ledger that also held OPHANIM's efficiency entries was refused (`kind "efficiency.trace" is not in the registry`).

| Option | Verdict |
|---|---|
| Kind sets pinned in genesis; a composition must supply all of them | Rejected. It only words the refusal better: the Pantheon run is still refused. It also blocks the order that works today, where a Pantheon-created ledger later receives OPHANIM records, unless the declaration can grow. |
| **Declared domains; a reader checks a domain it does not supply structurally** | **Chosen.** It is the first option with growable declarations, plus a reader that passes over a domain without re-deriving it. |

How the chosen option works:
- **Declaration.** The authority declares each domain and its kinds: `domains: {name: [kind]}` in genesis, or in a later authority entry signed by an operator. Declarations only grow, and a kind belongs to one domain only.
- **Who declares.** `openLedgerHome({domains})` writes them into a new genesis. On an existing ledger, it declares a missing domain just before that domain's first entry; opening never writes.
- **Compositions.** Pantheon supplies `pantheon`. OPHANIM supplies `pantheon` and `ophanim` (the `efficiency.*` kinds).
- **What a reader does with an entry outside its registry:**

| The entry's kind is | The reader |
|---|---|
| in a declared domain the reader does not supply | Checks linkage, order and author signatures, a keyring author and an intact payload. Never re-derives or appends the entry. Counts it in `verify().foreign` |
| in a domain the reader supplies, missing from its registry | Refuses it: the composition is incomplete |
| in no domain declared before it | Refuses it, as before |

- **Why this is sound for Pantheon.** No Pantheon kind reads a foreign entry, and the chain binds every entry, so a foreign entry cannot change what a Pantheon entry re-derives. What the reader does not check (the foreign entry's meaning) is reported, not implied: `complete` is false.
- **Why the registry stays closed.** A reader passes over exactly the kinds an operator-signed authority named, and nothing else.
- **On the run path.** `runOpenItem` records what the verify passed over in `run.json` (`ledger.underived`).

**The ship's verdict on the ledger.** At ship, `runOpenItem` judges the gates once, at `shipNow`. It records that verdict as a `gate` entry, then ships at the same `now`:
- the entry is built with `gateRecord({..., leaseLedger})` and appended with the board recorder's new `recordGate`;
- it names the board and the heads it read, and cites the lease entries;
- a refusal is recorded the same way, including the case where the controller did not schedule integrate (the entry holds the gate verdict);
- a check confirms the recorded gates match the ones the ship ran;
- `run.json` names the entry (`ledger.gate`).

*Check.*
- `packages/ledger/tests/domains.test.mjs` (5 tests):
  - a foreign domain is checked structurally and reported, and the reader refuses to append it;
  - foreign entries that were forged (an altered payload, a swapped payload with a stale signature, an unknown author) are refused;
  - an undeclared kind, an incomplete composition, a kind in two domains and a non-operator declaration are refused;
  - a declaration applies from its entry on, and `note` reaches `partial`;
  - the home declares domains in genesis, and lazily before a domain's first entry.
- `pantheon/tests/ledger-shared.test.mjs` (4 tests):
  - two boards share one ledger, and each gate and contribution re-derives against its own board, with the ledger opened with either board. The same verdict without a scope is refused (the behaviour before this change);
  - for the other board, a flipped claim, a verdict re-scoped onto the wrong board and a forged projection are refused;
  - with a board removed, its gate, contribution and ref moves are listed in `partial`, and forged lease rows are still refused;
  - an unscoped entry is checked against the opened board, and refused with none;
  - another domain is checked structurally, its forged entries are refused, and an undeclared kind is still refused.
- `pantheon/tests/route-protocol.test.mjs`:
  - **default-ledger run:** one `gate` entry, scoped and citing its lease scope. It re-derives after the board moved on. A flipped claim and made-up heads are refused, and the entry edited on disk fails verification;
  - **rejected review:** the refusal is recorded with REVIEW red, and after resume both verdicts re-derive;
  - **two runs on two boards, one `OPHANIM_LEDGER` holding another domain's entry:** both ship, and both verdicts re-derive against their own boards. With the first board removed, its entries are listed in `partial`.
- `ophanim/ledger/layering.test.mjs` adds a ledger holding a real `efficiency.promotion`. Pantheon opens it and reports `foreign: {ophanim: 1}`, refuses to append the efficiency kind, and refuses a forged one. OPHANIM still re-derives everything.
- **Against the code before this change:**
  - the new route-protocol checks fail (no gate entry; the shared run is refused);
  - `ledger-shared` and `domains` fail to load.
- Suites:
  - `npm run test:proof`: 153 of 153, with TELOS at the pin;
  - Pantheon: 842 pass, plus the 1 known environment failure;
  - `packages/ledger`: 26 pass;
  - model client: 48 pass.

**Limits.**
- **Ledgers without declarations.** On ledgers written before this change, nothing is declared, so their OPHANIM entries still stop a Pantheon reader. A declaration applies from its entry on, as keys do. Such a ledger is opened with OPHANIM's composition, as before.
- **A scope with no board.** A verdict whose scope names a root with no board re-derives only its ledger side. The controller signs `scope`, and the result reports the entry rather than hiding it. Nothing refuses it.
- **Frontier counts.** `foreign` and `partial` cover the entries a verify checked, so `mode: 'frontier'` counts only those after the last checkpoint.
- **`board.anchor`** still re-derives against the opened board only.
