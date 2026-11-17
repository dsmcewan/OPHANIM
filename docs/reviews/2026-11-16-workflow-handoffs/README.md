# OPHANIM workflow and handoff audit

Reviewed November 16, 2026 (America/New_York), against PR #6 head `beb577fe66eba04e3a4d4e78fa53e3aefd08b38e`. The board-driven workflow was added after the prior routing review, so this pass exercised that newer implementation.

**Follow-up validation:** upstream advanced during the audit to `ebdc69a5a0b37a797671a7bf979a1c545362004c`. W1/W2/W3/W4/W6/W7/W8 reproduced on that revision too. A new explicit reviewer-resume path passed seven targeted guarded tests, partially addressing W5; the documented/default fresh-run path still repeated four fake work calls before refusing. The specialist registry/routing files for W10 were unchanged. These results are retained separately from the initial snapshot evidence.

**Verdict:** the new implementation connects the authoritative status board to a supervised, single-item build/review/proposal flow. It is not yet a reliably scalable, self-evaluating improvement cycle. Two reproduced P1 completion defects let the checker approve the wrong task or the wrong revision. Claims, atomic status application, recovery, dependency provenance and independent verification also need repair before automatic completion can be trusted.

This audit adds findings and enforceable acceptance criteria, not a claim that the product has been fixed. The companion control matrix specifies the required controls and continuing audit cycle. Earlier routing/coordination findings remain open unless separately repaired.

## Reproduced findings

### W1 — P1: authentic evidence can resolve an unrelated task

A real disposable run for `actual-item` produced a shipped commit, a complete 41-entry run ledger, passing acceptance and a three-lab verified cycle. Its original proposal passed `checkProposal`.

Changing the proposal's target item and predecessor to `unrelated-item`, while retaining the authentic evidence for `actual-item`, still passed the full checker. Applying it with disposable fixture owner keys signed the unrelated item **Resolved**. A separate modification invented `tests.cmd = COMMAND_THAT_WAS_NEVER_EXECUTED` with exit 0 and removed the gate reference; the full checker still returned `ok: true`.

The proposal checker validates individual hashes and the reviewed commit, but does not bind the complete item/ticket/tests/gate/run relationship. Signature validity does not supply that relationship.

**Required control:** one canonical, versioned completion envelope binding task ID, ticket digest, expected item entry, dependency/input versions, run identity, exact artifact/commit, executed test contract and receipt, passing ship gate, and review of the final candidate. Re-derive every relationship from qualified evidence before signing a status transition; reject missing or substituted fields.

Sources: [proposal checker](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L372-L409), [structural evidence checks and apply](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/packages/ledger/status.mjs#L307-L350).

### W2 — P1: a recorded fix completes the original defective revision

The first candidate H passed its initial acceptance but received a blocking, reproducible cycle-review finding. A later real Git commit F fixed the defect. The probe executed the finding's reproduction: exit 1 on H, exit 0 on F. Recording F with `fixFinding` allowed `proposeFromBundle` to close the cycle **verified** and propose **Resolved**.

However, the proposal still named H. H retained the defect; F contained the correction. `checkProposal` returned true for H because it was the original cycle head. The final handoff never incorporated, accepted or independently reviewed the fixed candidate.

**Required control:** a resolution receipt cannot substitute for the final candidate. Incorporate every fix into a new exact candidate, rerun relevant acceptance and independent review on those bytes, then bind completion to that candidate. Keep the original review/fix history; do not silently relabel the original head as corrected.

Sources: [resolution collection versus unchanged completion commit](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L333-L350), [checker requires the original reviewed head](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L395-L402).

### W3 — P2: stale approval is silently rebased over a newer hold

The initial proposal freshness check occurs before evidence I/O. A deterministic interleaving inserted a legitimate **On Hold** update during that I/O. The final `set` recalculated the newest predecessor and signed the old Ready-to-Resolved proposal over the newer hold. The chain fully verified afterward.

This is a concurrency failure in the approval transaction, not a signature forgery. The proposal's expected predecessor was not enforced under the append lock.

**Required control:** compare-and-append the expected item predecessor atomically with the signed status write. Refuse after any conflicting item change; retry by making a fresh proposal, not by silently changing its parent.

Sources: [freshness check outside the final append](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/packages/ledger/status.mjs#L335-L350), [set recalculates the predecessor](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/packages/ledger/status.mjs#L125-L131).

### W4 — P2: a pending run does not claim its task before another run spends work

A successful run left an unsigned proposal pending owner application. The status remained Ready and `next` still listed the item. A second invocation on a fresh board made **four additional fake model calls** before refusing the already-existing `pantheon/<item>` branch.

The branch compare-and-swap is useful, but it happens after additional seat calls have already run; a live rerun can consume provider quota and money. Per-run board leases do not establish a common admission claim across separate board directories.

**Required control:** shared admission keyed by item, ticket digest and source base, with a fenced attempt/lease generation, durable pending-run/proposal lookup and idempotent request ID. Preflight existing branches/runs before model calls. Recover or explicitly supersede the existing attempt instead of rebuilding blindly.

Sources: [admission and fresh per-run board](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L224-L247), [already-applied check](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L140-L150), [late branch conflict](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L184-L189).

### W5 — P2: documented failed-review retry does not recover a shared ledger cycle

One scripted reviewer refusal left two of three reviews and an open cycle. With the supported shared `OPHANIM_LEDGER`, a fresh-board retry and a different output branch made **four more fake work calls**, produced another commit, then refused before calling any reviewer: the previous cycle of the same scope was not closed.

The documentation recommends rerunning on a fresh board, but the scope still contains the same item/base. Hiding the old open cycle or weakening its close rule would lose review continuity.

**Required control:** resume the existing attempt and retry only missing reviewers under the immutable candidate/prompt and bounded attempt budget. Preserve successful reviews and lab exclusions. Support explicit failed/cancelled terminal states and compensation where appropriate; retain continuity rather than manufacturing a fresh history.

**Follow-up:** `ebdc69a` includes an explicit `pantheon-board resume` path, including missing-review-only retries, attempt limits and forged-resume refusals; seven targeted tests passed. Use that path and update the operating instructions/wrapper. The old fresh-board retry still performed duplicate work before refusing in the follow-up probe. The audit therefore does not claim that supported resume remains wholly absent.

Sources: [fresh-board recovery instruction](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/docs/operating-workflow.md#L49-L55), [scope and new review cycle](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L291-L302), [prior-cycle close requirement](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/ledger/cycle-kinds.mjs#L172-L176).

### W6 — P2: official verification of a public evidence copy requires worker private keys

The probe copied the authentic public chain, all objects and anchor, with run JSON and original board data still available. Low-level verification with the correct Pantheon kinds returned `ok: true, complete: true` for all 41 entries, without signing keys.

The official `checkProposal` instead created an empty `keys/` directory and refused: **“the operator and controller keys are not held here.”** It opens a writable ledger home rather than a read-only verifier. This blocks the intended handoff to a verifier who receives public evidence only.

**Required control:** a non-mutating reader that requires no signer, creates no ledger/key files, and verifies the full public proof pack against an independently supplied anchor. Keep append authority in a separate writer API. Do not solve verification by exporting worker private keys.

Sources: [checker opens a writable home](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L375-L378), [home creates key store and requires private signers](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/packages/ledger/home.mjs#L79-L80), [private-key requirement](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/packages/ledger/home.mjs#L109-L113).

### W7 — P2: the “full” checker returns success for an incomplete semantic verification

A separate control retained only disposable fixture signing keys and copied run data, but moved the referenced board away from the exact path named by its entries. The checker reported **`complete: false`** in its findings and still returned **`ok: true`**. The result is visible in text, but it does not prevent the completion path from treating the check as success.

**Required control:** require complete re-derivation of the required evidence scope for automatic completion. Export board/CAS/dependency data needed for public verification, with explicit scope resolution. Partial/foreign/unavailable evidence must have a separate outcome; an owner exception, if permitted, must be explicit and cannot count as a fully verified policy promotion.

Source: [verify result is checked only for ok](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L377-L383).

### W8 — P2: dependency versions are not reconciled at completion

A dependency was Resolved at admission and changed to On Hold in `run.start`, before pipeline execution. The target item's entry stayed unchanged. The runner still produced a Resolved proposal, and `checkProposal` accepted it. The proposal recorded no consumed dependency status versions.

This does not show that every dependency status change invalidates already-qualified bytes. It shows that the handoff lacks the provenance and invalidation rule needed to make that distinction.

**Required control:** bind consumed dependency entries and qualified output versions to the attempt. Define which changes invalidate the result, recheck them at handoff/application and refuse or explicitly revalidate stale inputs.

Sources: [admission-only dependency check](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L140-L146), [proposal rechecks only the target item](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L338-L355).

### W9 — The requested self-evaluation priority still has no operating-cycle enforcement

On this newer snapshot, two complete fake-review cycles again closed verified with zero practice-assessment or policy-disposition records. The newly added operating runner does not connect practice assessment to cycle close or next dispatch.

The committed `next` result listed only `co1-readability`. It skipped `routing-coordination-practices` and `me3-canonical` because neither had a ticket. The owner's priority is durably recorded, but the dispatcher cannot execute it yet. Ordering is dependency traversal with lexical tie-breaking, not an owner-priority queue. The shell wrapper runs one named item and exits; it is not a continuing queue supervisor.

**Required control:** create validated bounded tickets for the priority work, enforce a recorded per-cycle assessment/disposition, and require the next dispatcher to consume the retained/admitted policy. Add explicit queue priority, starvation protection, finite resource admission, supervision and recovery. Scale claims need contention, crash/restart, retained-data growth and budget tests—not just more concurrent seats.

Sources: [dispatchability requires a ticket](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/board/operate.mjs#L124-L168), [current cycle close requirements](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/ledger/cycle-kinds.mjs#L129-L148), [one-item wrapper](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/scripts/operate-cycle.sh).

### W10 — P2: reusable agent definitions drift from live routing

The existing agent store, MCP list/get/render/install tools and AGY role-card consumer are real reusable infrastructure. However, the store enumerates legacy seating while the active build profile uses the frontier table. A guarded comparison found six active role/model candidates absent from `listAgents` and rejected by `getAgent` as “not a seat this project routes to”: planner Carbon/Astra, implementer Fable/Carbon, reviewer Carbon and scout Grok 4.3.

The user also requires deeper specialization and reuse. The operating ticket has no specialist-definition field; build dispatch creates generic role prompts rather than selecting a qualified, versioned specialist definition. Existing definitions have no explicit qualification/version receipt, and warning about a lossy render does not establish qualification of the consumed definition.

**Required control:** connect the existing reusable registry to the actual candidate set and dispatch. Version the specialist's identity, input/output contract, tools/write scope, model/runtime eligibility and qualification evidence; record the consumed definition on every handoff. Preserve scoped continuity without reusing an author's state as independent review. See the companion contract's specialist section.

Sources: [legacy registry enumeration and rejection](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/agents/store.mjs#L93-L124), [definition fields](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/agents/store.mjs#L137-L153), [active candidate table](https://github.com/dsmcewan/OPHANIM/blob/beb577fe66eba04e3a4d4e78fa53e3aefd08b38e/pantheon/src/route/frontier.mjs#L5-L11).

## Controls already present and worth retaining

- The dispatcher reads the verified status ledger; GitHub remains a published projection.
- Tasks require a ticket and resolved dependencies at admission. Path containment, unique file slots and certified artifact baselines are checked.
- Acceptance uses mandatory Bubblewrap isolation, scrubbed environment, a network namespace and actual controller-executed commands.
- Existing lower-level handoffs enforce leases/fencing, byte-bound reviews/acceptance, controller-only shipping, destination baselines and atomic Git branch creation.
- Status keys remain separate from run execution. Owner application is an explicit boundary.
- Qualification CI and public-record publication are separate. The publisher is serialized and has minimal issue-writing permissions.
- The operating documentation distinguishes synthetic rehearsal from live operational qualification.

The defects are primarily in how these controls are connected across workflow boundaries. Passing component checks does not establish an atomic, correctly scoped completion transaction.

## Verification and limits

- 12 existing proposal/dispatch/operating-cycle tests passed with the offline guard.
- 36 existing fencing/integration/lease/artifact-application cases are accounted for passing. One initially failed because the audit guard did not preserve `execFile`'s custom promisify return shape. The guard was corrected and independently sanity-tested; the affected case passed on its targeted rerun. It was not a product finding.
- New reproductions use disposable repositories, fixture keys and scripted provider responses. This review made no live provider or model CLI calls and used no owner's signing keys in the probes.
- The test guard rejects external HTTP/sockets and model CLI launches in the reviewed Node paths; child Node processes inherit it. It preserves normal async subprocess semantics. It is not an OS sandbox for arbitrary unreviewed subprocess code. Acceptance itself remains in the product's separate Bubblewrap sandbox.
- No live operational cycle, throughput benchmark, real provider cost/quality improvement or broad adversarial security guarantee was established. Protected authority/TELOS decisions remain separate.
- The earlier routing audit's exploratory-CLI uncertainty is recorded in that earlier report. This pass used the verified guard before executing probes.

**Implementation priority:** repair W1/W2 completion binding first, then atomic freshness, shared claims and recovery. Make public complete verification and dependency provenance part of the same handoff contract. Connect the standing self-evaluation controls only through those corrected boundaries, preserving independent review and rollback.

## Additional owner direction and implementation boundary

The owner requires cross-model accountability without availability/quorum/deferral bypasses, plus specialized reusable agents and continuing capability-based evaluation across alternatives. `Easy` / `hard` alone is expressly insufficient. The control contract now records the required multi-dimensional task profile, alternative-set generation, context/tool/transport/team choices, qualified evidence, parent-ticket coverage and per-cycle bounded research/comparisons.

Additional guarded probes at `ebdc69a` confirmed that operating reviewer selection can admit the planner's lab while dropping author-turn lineage, a caller can request one reviewer, and a reproducible blocking rejection can be deferred into a `verified` close. Historical closes remain records of their original semantics; they are not sufficient evidence for the new automatic completion gate.

Focused candidate repairs are being prepared in isolated checkouts for W1/W2/W3/W6/W7 and the review bypasses. They must be regression-tested and independently reviewed by another model family before promotion. Internal Codex subagents are not claimed as cross-model review. Other workflow controls, the reusable-specialist dispatch bridge and the broader routing/coordination evaluation remain open; this audit and a first repair slice do not resolve them.

The owner further rejects opinion-based policy promotion: hypotheses must be tested, measurements validated, proposals independently critiqued, and implementations validated against the qualified candidate. The contract explicitly distinguishes authorized constraints from empirical results, preserves insufficient-evidence outcomes and requires the full chain before adopting a new policy. Existing subjective `TASTE`/difficulty choices in seating are not empirically qualified by these workflow repairs and remain within the broader routing work.

## Current-state audit completed after the owner's correction

The follow-up audit pins public source `e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6`. Its current selector is connected; earlier disconnected-selector findings are not repeated as current. Three present P2 gaps remain: eligibility tags carry unqualified ranking claims (CS1); effort-first escalation cites parameter documentation for an unmeasured cost comparison (CS2); and ARGO planning/implementation compile the same 65,536 output cap across difficulties despite the declared output-tier rationale (CS3). The reviewer has a separately verified 4,000 cap and is excluded from CS3.

Eighteen guarded role/profile/difficulty selections passed sixteen assertions. Separate current-source and retained-evidence inspection fully verified the public 81-entry status chain and freshly reproduced the 32-sample/four-block synthetic calibration. Retained scheduler measurements reject adoption, and no qualified live routing promotion was established in the examined evidence. Existing historical authority receipts were content-pinned, with their signature recheck explicitly limited; they were not relabeled as independent model reviews.

See `CURRENT_STATE.md` and `CURRENT_STATE.json` in this review directory (standalone output: `OPHANIM-current-state-evidence-audit`). The live-policy qualification, specialist bridge and continuous cycle requirements remain open. Candidate bypass repairs are a separate review target and do not resolve CS1–CS3 or certify the current routing choices.

The branch subsequently advanced to `41e6262`, adding opt-in task-profile routing, usage evidence and v2 practice records. The current-state delta audit credits those controls and does not claim that cycle assessment is still wholly absent. It reproduced a further false-qualification path: a controller could assert measured comparison and a named but uninvoked decider. The isolated repair candidate refuses unsupported promotion while preserving historical records. The fit output-tier mismatch is also reproduced through actual fake-provider request serialization and has a separate candidate fix. These candidate repairs do not establish live quality, cost or optimal reviewer counts.

## Functional-role follow-up at 048b3ba

The owner's role concern is confirmed: the current model named `planner` emits a title; deterministic code holds orchestration authority. The title contributes to worker context/lineage, so the correction must preserve its evidence without treating the worker as the controller. Review reservation forces default critical producers onto OpenAI under the configured fit reviewer pool; the three-lab fit pool and broader cycle-review pool differ. This is an unmeasured policy choice, not a universal architectural constraint. Worker planning and escalation remain valid under the worker's scope. The current remote cycle fallback still contains the previously reported planner-lineage downgrade; the isolated repair candidate remains separate from that branch.

The retained role probe passed sixteen assertions across two fake dispatcher runs and the existing fallback-effort case passed. No quorum change, forced co-seating policy or performance improvement was independently qualified by these checks. See CURRENT_STATE for exact sources and evidence limits.
