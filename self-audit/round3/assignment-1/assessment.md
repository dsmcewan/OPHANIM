# Self-audit, assignment 1: Lifecycle and evidence

**Self-audit by the coordinating lab (Anthropic), not independent; commit af0dc30; written before round 3 findings.**

- Commit: `af0dc3012688703ccac0f6de31836822a3279eae`, checked out detached in an isolated worktree. No tracked file was modified.
- Runtime: Node 24.22.1, `npm ci --ignore-scripts`.
- Baseline: the existing A1 suites (`stages`, `scheduler`, `context`, `context-bounds`, `evidence-recovery`, `revision-reassessment`, `planner-tier`, `fit-lifecycle`, `lifecycle-evidence-review`, `lifecycle-evidence-r2`, `plan-lineage`, `service`) gave 78 pass, 0 fail, 0 cancelled and 0 skipped.
- Inputs read: the earlier findings (`findings-1-google-09d490f` and `findings-1-openai-77480d6`) and the retrospective's eight failure modes. The retrospective was read from the main checkout, because it is not in the tree at af0dc30.
- Round-3 findings: none were looked for, and none were read.
- Reproductions: copies are in `repro-1/` beside this file. Each test **passes when the defect is present**. To run them, copy them into `<checkout>/.review-tests/` and run `node --test .review-tests/<file>`. They use only scripted seats (`test-fixtures.mjs`) and `withDispatch`, with no provider calls. All 12 pass at af0dc30.

## Summary

| Q | Verdict | Reproduction (repro-1/) |
|---|---|---|
| 1 Earliest gate | **does not hold** | `sa1-stale-plan-never-replanned`, `sa1-own-ticket-stales-plan`, `sa1-capacity-pending-wedge`, `sa1-outcome-status-moved-wedge` |
| 2 Handoffs | holds for every runtime path; the doc overclaims | `sa1-handoff-ticket-identity` (overclaim) |
| 3 Plan | **does not hold** (a resumed cycle bypasses the `work_units` check; findings, revision and finder lineage hold) | `sa1-fit-resume-no-units` |
| 4 Planner seat | **does not hold** after the ticket is re-derived (no-ticket → medium holds) | `sa1-ticket-stakes-erased` |
| 5 Evidence freshness | **does not hold** | `sa1-stale-plan-never-replanned`, `sa1-own-ticket-stales-plan`, `sa1-stable-leaks-work-ledger`, `sa1-validator-evidence-unbound` |
| 6 Evidence bounds | **does not hold** (cut derived views cannot be continued by any seat) | `sa1-dossier-continuation-unreachable` |
| 7 Scheduling | holds (`--item`, intake once per source); caveats below | none |
| 8 Recovery | holds | none |
| 9 Reassessment | holds | none |
| 10 Outcome | holds; caveats (a stale reuse; the outcome wedge is under Q1) | none |

The dominant defect is a **class**: the scheduler's attempt identity (`inputs` = {upstream, requirement, returned_by, rereview}, scheduler.mjs:183-189, and the claim key `workKey`, work-ledger.mjs:89) contains none of the things that make a gate re-route work. Those are evidence bytes, ticket bytes, dependency entries, the status entry, review capacity and the dossier. So when the gate correctly says "do this stage again", the work ledger refuses it as "already completed for these exact inputs" (work-ledger.mjs:185), or the stage-attempt bound blocks it for good. The gate tests stop at `reconcile(...).gate === 'plan'`, a module-level check (failure mode 4). No existing test ticks again after a plan goes stale.

---

## Q1. Earliest gate — **does not hold**

**What holds**
- Routing on first sight:
  - no ticket → `plan`, mode `author`;
  - a valid ticket → `plan`, mode `revalidate`;
  - an invalid ticket → `author` (`gates.mjs:165`, `:197-201`);
  - Resolved with completion evidence → `complete`;
  - Resolved without it → `evidence-gap`, with recovery (`gates.mjs:119-152`);
  - On Hold, or open dependencies → `blocked` (`:153-163`).
- A plan whose requirement, dependencies, ticket or cited bytes changed is marked stale by the gate (`planValidity`, `gates.mjs:51-72`).
- The chain is followed by explicit handoffs, through the decisive attempt only (`:80-94`).
- Existing tests:
  - `stages.test.mjs` (the revalidate test at line 105);
  - `lifecycle-evidence-review.test.mjs:55`, `:86` and `:160`;
  - `lifecycle-evidence-r2.test.mjs`;
  - `evidence-recovery.test.mjs`.

**What does not hold**

1. **A stale plan is never re-planned. The item is wedged, and silently.**
   - The gate routes the item to `plan`.
   - The scheduler builds `inputs = {upstream: null, requirement}`, identical to the passed plan's (`scheduler.mjs:183-189`).
   - `work.claim` re-derives the same key and refuses it: `"plan already completed for these exact inputs"` (`work-ledger.mjs:185`).
   - `tick` files this under `skipped`, not `blocked` (`scheduler.mjs:214`). The routing signature does not change, so `watch`/`serve` stop ticking for it.
   - This applies to every reason `planValidity` gives: a changed evidence file, the ticket edited, a dependency's entry changed or added, a cited non-file view changed, or a view that "cannot be re-read here".
   - The round-2 fixes (issue versions, dossier views re-derived, undefined → stale) therefore turn more cases into wedges, not into re-plans (failure mode 8).
   - The same root cause appears downstream. An approved plan that goes stale after implementation also wedges the item, because the gate routes back to `plan`.
   - Repro: `sa1-stale-plan-never-replanned.test.mjs`. It has two cases, a cited file changed and the ticket edited.

2. **A plan can make itself stale.**
   - `reconcile.mjs:87-101` re-derives a cited dossier view by rebuilding the dossier. It cuts the work ledger back to the records before the plan ("the plan's own consequences … are not new evidence"). It does not do the same for the plan's other consequence, `tickets/<item>.json`, which the plan stage writes uncommitted (`stages.mjs:784`).
   - The rebuilt dossier reads the new ticket (`context.mjs:338-343`). The ticket's `path`/`copy` become "named" files, which changes `consumers:<item>`, removes `guess:<item>`, and changes `index:<head>`, whose count includes untracked files (`context.mjs:355`, `:383`, `:400`).
   - A planner that cites the consumers view, a natural source for `operational_position`, has its plan stale at once. Combined with defect 1, the item is wedged after one plan.
   - Repro: `sa1-own-ticket-stales-plan.test.mjs`.

3. **A structural `pending` or `blocked` attempt is never re-evaluated.**
   - `gates.mjs:170-187` (plan) and `:231-234` (later stages) route such an attempt to `blocked` unless:
     - the requirement digest changed; or
     - it is transient and due; or
     - it is EVIDENCE_INSUFFICIENT with changed evidence.
   - Capacity pending has `resume_when: "a reviewer lab outside the contributors becomes available"`. Nothing the gate reads can observe that.
   - When the owner re-records the item Ready with the same title and basis, the requirement digest is the same, so that does not resume it either.
   - `scheduler.test.mjs` ("a structural block is not re-dispatched") encodes this as intended. The stated resume condition is unreachable all the same.
   - Repro: `sa1-capacity-pending-wedge.test.mjs`.

4. **An outcome is wedged once the status moves.**
   - When the owner records any new status entry between implementation and outcome, `proposeFromBundle` refuses ("re-dispatch it", `pantheon/src/board/operate.mjs:812-816`). The outcome is recorded `blocked` (`stages.mjs:1550-1552`).
   - Defect 3 then means it is never re-dispatched.
   - Repro: `sa1-outcome-status-moved-wedge.test.mjs`.

**Second half of Q1 (a stage run on inputs changed upstream).**
- Mostly guarded:
  - implement re-checks the ticket digest (`stages.mjs:830-833`);
  - review re-checks `run.json` (`:1257`);
  - outcome re-checks the commits and the ticket (`:1535-1537`).
- Validate does not re-check `run.json` or the plan's validity. A change between review and validate is caught only at outcome (`checkEvidenceLedgers`).
- There is a time-of-check-to-time-of-use window between the gate and the executor. It is minor.

## Q2. Handoffs — **holds** (with a doc overclaim)

- `verifyHandoff` and `handoffRefusal` re-derive the whole chain before dispatch (`scheduler.mjs:76-80`, `work-ledger.mjs:285-313`). They check:
  - that each record belongs to the item and passed;
  - the stage order;
  - the requirement, against the gate's;
  - that each `inputs.upstream` equals the previous outputs.
- Every non-plan executor re-checks this with `checkUpstream` (`stages.mjs:522-528`).
- The ledger re-derives each append: the lineage rule, no skipped stage, and the inputs digest (`work-ledger.mjs:225-279`).
- Another item's record is refused. Tests:
  - `lifecycle-evidence-review.test.mjs:106`;
  - `scheduler.test.mjs` ("a handoff that does not re-derive is refused").
- **The doc claims more than the code enforces.**
  - The `work-ledger.mjs:35-36` header says that on append "the identity (item, **ticket**, requirement) matches the previous stage's". The re-derivation (`:264-266`) and `handoffRefusal` compare only the item and the requirement.
  - Today the only stage that sets `identity.ticket` is the plan, so the runtime is consistent. The ledger does not enforce it.
  - Repro: `sa1-handoff-ticket-identity.test.mjs`.
- **The plan stage picks its own upstream.**
  - In `revise` mode, the plan stage takes the latest passed plan (`prevRec`, `stages.mjs:539`), not the plan the returning chain rests on. If an older plan is re-selected because a newer one went stale, the revision is made of the wrong plan.
  - No reproduction was written. In practice this case also falls into the Q1 wedge, because `returned_by` is reused.

## Q3. Plan — **does not hold** (one bypass); the review and revision loop holds

- **What holds**
  - Under `fit`, a planner answer without valid `work_units` is refused (`planRefusal`, `stages.mjs:201-212`; `workUnits: 'required'` at `:686`).
  - Blocking findings, or `request_changes`, lead to:
    - the cycle closing;
    - each finder being pushed as a `plan-review` contributor (`:807`);
    - a capacity check of the new panel before the revision is paid for (`:813-820`);
    - a new version in its own cycle (`:654-810`).
  - Tests: `stages.test.mjs:131` (two versions and cycles; the finder is a contributor and does not review the revision); `fit-lifecycle.test.mjs`.
- **The bypass**
  - A resumed open cycle takes `doc` from the cycle head (`stages.mjs:615`, `:656`) and never runs `planRefusal` on it.
  - A version opened under another profile (or before units were required), when finished by a `fit` executor, is recorded passed with no `work_units`.
  - The implement stage then silently takes the per-file `runOpenItem` path (`stages.mjs:838`, documented for reused records in the comment at `:836-837`).
  - Repro: `sa1-fit-resume-no-units.test.mjs`.
  - Severity is low, because it needs a profile change while a cycle is open. The documented exception (a reused `argo` plan under `fit` uses the per-file path) is also not refused. That is by design, but the question's "refused under fit" is not true for reused records.

## Q4. Planner seat — **does not hold** after re-derivation

- **What holds**
  - The first plan is seated from the ticket's `difficulty`, `stakes`, `ambiguity` and `depth` through `taskProfile` (`stages.mjs:550-555`).
  - An item without a ticket records `{declared: {}, source: 'no ticket: medium'}` (`:554`).
  - Tests: `planner-tier.test.mjs:20` (now unconditional) and `lifecycle-evidence-review.test.mjs:145`.
- **What does not hold**
  - When a plan rewrites the ticket (revalidate with `still_valid: false`, or any author or revise plan with a prior ticket), the ticket is rewritten from `ticketOf()` (`stages.mjs:231-237`, written at `:784`).
  - `ticketOf()` carries only `difficulty`, and that is the **planner's own** choice. It drops `stakes`, `ambiguity` and `depth`.
  - The owner's declared `stakes: critical` disappears. The next planner is seated at the plan's self-declared difficulty: in the repro, Sonnet (easy) instead of Fable (critical → hard).
  - The same ticket drives the implement stage's `taskProfile`, and through `seatTeam` the number of review labs that stakes require (`pantheon/src/board/operate.mjs:158-170`). This crosses into assignment 2: the review-lab count can drop.
  - An invalid declared value falls back to `taskProfile({})`, while the record still says `source: 'ticket'` (`:551-554`). This is minor.
  - Repro: `sa1-ticket-stakes-erased.test.mjs`.

## Q5. Evidence freshness — **does not hold**

- **What holds**
  - Plan citations (evidence, investigation sources, relevance used, copy) are bound to the delivered view's version, not to the disk after the turn (`stages.mjs:707-735`).
  - Issue versions cover the delivered bytes (`context.mjs:193-196`).
  - Derived views are re-derived (`reconcile.mjs:87-108`).
  - A view whose version is undefined makes the plan stale (`gates.mjs:61-69`).
  - Tests:
    - `lifecycle-evidence-review.test.mjs:160`, `:202`, `:363`;
    - `lifecycle-evidence-r2.test.mjs` (the issue, relations and watch tests).
- **What does not hold**
  1. "Searched again" never happens for a passed plan (Q1, defect 1). The existing tests assert only the gate. Repro: `sa1-stale-plan-never-replanned`.
  2. The plan's own ticket changes the re-derived views (Q1, defect 2). Repro: `sa1-own-ticket-stales-plan`.
  3. **`stable` leaks the work ledger.**
     - The `stable` digest (`context.mjs:403-406`) drops the `work:` entry. But that entry spent the shared `dossier_bytes` budget (`:296`, `:331`), so later entries are cut or omitted differently once an attempt is recorded.
     - With a near-budget dossier (a long requirement, which is never cut), an EVIDENCE_INSUFFICIENT plan is re-planned on unchanged evidence in the same tick. It pays a second planner call and uses one of the three lifetime attempts on these inputs.
     - Repro: `sa1-stable-leaks-work-ledger.test.mjs`, with a control.
     - Related: the EVIDENCE_INSUFFICIENT re-plan is bounded by `stage_attempts` over the item's whole lifetime, because the inputs exclude evidence (`scheduler.mjs:187-193`). After three evidence changes, new evidence never wakes the item. That is the round-2 watch fix's ceiling.
  4. **Review and validate evidence are not bound.**
     - Only plan citations are version-bound and re-checked.
     - The validator's cited `sources` are recorded as `{ref, delivered, complete}` with no version (`stages.mjs:1495`).
     - The change reviewers' `[source: …]` citations are not bound either. Nothing re-checks them on reuse.
     - When a file the validator retrieved and relied on (a consumer contract) changes, the validation is still reused, and the gate goes to `outcome` with `stale: []`.
     - Repro: `sa1-validator-evidence-unbound.test.mjs`.

## Q6. Evidence bounds — **does not hold**

- **What holds**
  - Containment on the real target, including links, `.git` and `.gitignore` (`context.mjs:52-60`, `:104-118`).
  - Literal pathspecs (`:45`, `:92-97`).
  - Byte windows that never split a character, and refusal past the end (`:67-74`, `:218-247`).
  - Per-result, per-round, round-count and total budgets enforced before delivery (`:486-529`).
  - Delivery computed per view and version from byte ranges, and partial while incomplete (`:440-471`).
  - The whole dossier bound to `dossier_bytes` (`:292-323`).
  - Tests: `context-bounds.test.mjs` (all), `lifecycle-evidence-review.test.mjs:395-480`.
- **What does not hold: cut derived views cannot be continued by any seat**
  - A cut derived view (relations, consumers, guess, runs, index) names its continuation as `{"op":"dossier","source":…,"offset":N}` (`context.mjs:306-313`).
  - The seats' retriever is built by `evidenceFor` without `dossierViews` (`stages.mjs:468-470`). So every seat's request fails NOT_FOUND (`context.mjs:207-211`), and the gap stays "unresolved" forever, pointing at a request nobody can run.
  - The existing test (`lifecycle-evidence-review.test.mjs:425`) builds its own retriever with `dossierViews: d.views`, which no stage does. That is a module-level test standing in for a lifecycle claim (failure mode 4).
  - The partial view is still recorded as partial, which is correct.
  - Repro: `sa1-dossier-continuation-unreachable.test.mjs`.

## Q7. Scheduling — **holds** (caveats)

- **What holds**
  - With `only` (CLI `--item`), only that item is dispatched. Every other runnable item is listed in `skipped` as "outside the --item scope" (`scheduler.mjs:304-310`). Intake, expired-claim release and recovery still run for every item, as documented. Test: `scheduler.test.mjs:211`.
  - Intake is once per source, enforced in the ledger under its append lock (`work-ledger.mjs` `work.intake` rederive, `once: 1`) and pre-filtered in `tick` (`scheduler.mjs:141-153`). Test: `lifecycle-evidence-review.test.mjs:484`.
- **Caveats**
  - The classification is frozen at first sight. `issue:N`, first seen without a marker, stays a `candidate` after a marker is added. `ticket:x`, first seen as an orphan, stays `item: null` after `x` joins the ledger. This is a record-only issue.
  - The wedged items of Q1 appear only in `skipped`, never in `blocked`. The watch signature does not change, so `watch`/`serve` stop looking at them. The operator sees "running".

## Q8. Recovery — **holds**

- `recoverEvidence` reads the status ledger only: `openStatusLedger({create: false})`, `propose` (pure), and `checkEvidenceLedgers` (opens cited ledgers read-only, `packages/ledger/status.mjs:318-325`). It writes one **unsigned** proposal file under `operate/recovery/` (`evidence-recovery.mjs:137-158`).
- `tick` records the attempt on the work ledger only (`scheduler.mjs:158-167`).
- A repeat search with the same status entry and the same sources digest is skipped in `tick` (`:161`) and refused by the ledger (`work.recovery` rederive).
- Tests: `evidence-recovery.test.mjs:21` (status entry count unchanged; nothing searched twice), `:75`; `lifecycle-evidence-review.test.mjs:329` and `:569`.
- Caveat: `sourcesDigest` is computed twice (by the scheduler, and inside `recoverEvidence`). A change between the two records a digest the skip did not test. This is a benign race.

## Q9. Reassessment — **holds**

- A disqualified plan review or change review is excluded from the chain (`chainFrom(..., s => !hit(s))`, `gates.mjs:203`; the voided branch at `:213-218`). Validation and outcome resting on it are not reused.
- The re-review carries its reassessment through a pending or blocked retry (`:110-117`, `:228`), and the attempt identity includes `rereview` (`scheduler.mjs:186`), so it does not collide with the Q1 idempotency wedge.
- A Resolved item whose evidence rests on a disqualified change review, or plan review, becomes `reverification-needed`. It is not dispatched (not in STAGES), it is not searched by recovery (not `evidence-gap`), and the status is not written (`gates.mjs:119-133`).
- Tests: `revision-reassessment.test.mjs:193`; `lifecycle-evidence-review.test.mjs:523`, `:552`.
- Note: a plan-review re-review re-plans (a new planner turn) and therefore re-implements. It is "bounded", but not "the same version reviewed again".

## Q10. Outcome — **holds** (caveats)

- The outcome executor runs the same `checkEvidenceLedgers` that `applyProposal` runs (`stages.mjs:1557` vs `packages/ledger/status.mjs:404`). On any shortfall it renames `proposal.json` to `proposal.refused.json` and records `blocked` with OUTCOME_EVIDENCE_REFUSED (`:1558-1564`, rename at `:1560`). So no outcome is *recorded as passed* with a proposal that apply's structural check would refuse at that moment.
- Recovery uses the same check (`evidence-recovery.mjs:122-126`).
- Test: `lifecycle-evidence-review.test.mjs:585`.
- **Caveats**
  - (a) The check is at production time only. The passed outcome is reused as `awaiting-owner` (`gates.mjs:235`) with no re-check. If `run.json` or a cited ledger changes afterwards, the gate still shows a proposal that apply would refuse. Only a ticket change is caught, through `planValidity`, and that then wedges (Q1).
  - (b) `proposal.json` is written before the check, so a crash between write and rename leaves an unchecked proposal on disk. Recovery would re-check it, so this is not a hole.
  - (c) The outcome wedge when the status moves is reported under Q1 (defect 4).

---

## Blockers for a live run

1. **A stale plan is never re-planned. Items wedge silently.** The attempt and claim identity excludes evidence, ticket, dependencies and status (`scheduler.mjs:183-189`, `work-ledger.mjs:89`, `:185`). Every staleness the gate detects becomes a permanent `skipped`, not a re-plan, and the watch signature does not change. Repro: `sa1-stale-plan-never-replanned`.
2. **A plan can stale itself** through its own ticket write (consumers, guess and index views). Combined with blocker 1, the item wedges after its first plan. Repro: `sa1-own-ticket-stales-plan`.
3. **The outcome wedges when the status moves** between implementation and outcome, and **capacity-pending stages are never retried**: structural blocks have no reachable resume. Repros: `sa1-outcome-status-moved-wedge`, `sa1-capacity-pending-wedge`.
4. **A re-derived ticket drops the declared stakes.** This lowers the planner and implementer tier and the stakes-driven review-lab count (it overlaps assignment 2). Repro: `sa1-ticket-stakes-erased`.
5. **Cut derived dossier views cannot be continued by any seat.** The recorded gaps can never be resolved. Repro: `sa1-dossier-continuation-unreachable`.

The following should be fixed or recorded as open, but do not block:
- the `stable` budget leak (`sa1-stable-leaks-work-ledger`);
- unbound validator and reviewer evidence (`sa1-validator-evidence-unbound`);
- the `fit` resume without units (`sa1-fit-resume-no-units`);
- the ticket-identity overclaim in the work-ledger header (`sa1-handoff-ticket-identity`);
- the frozen intake classification;
- no re-check of an `awaiting-owner` outcome on reuse.

## Audit lens: which retrospective failure modes recur here

- **Mode 1 (sibling paths).** Freshness was enforced for plan citations only, not for review and validate citations. The plan's own consequences were cut back for the work ledger only, not for its ticket. The continuation op was wired into `buildDossier`'s own retriever only, not the seats'. Every structural block has the same unreachable-resume shape: plan capacity, implement capacity, outcome status moved.
- **Mode 4 (tests that could not fail).**
  - The staleness tests assert `reconcile().gate === 'plan'` and never tick again.
  - The continuation test builds a retriever that no stage builds.
  - `scheduler.test.mjs` asserts the structural wedge as intended behaviour.
- **Mode 7 (premises not carried).** "A re-run on identical inputs is refused as already done" (`scheduler.mjs:180-181`) was designed before plans could go stale on evidence. The premise that inputs capture everything that matters was not re-derived when evidence freshness was added.
- **Mode 8 (a fix created the next defect).** The round-2 freshness fixes made the gate say `plan` in more cases. Each such case now wedges instead of re-planning.
