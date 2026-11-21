# The self-repair lane (the inner wheel)

`ophanim/operate/self-repair.mjs`, wired into `scheduler.mjs`, `reconcile.mjs`, `stages.mjs`, `work-ledger.mjs` and the
CLI (`cli.mjs self-repair`). While the owner's switch is on, every scheduler tick opens one round whose work is to
**Detect -> Diagnose -> Repair -> Verify** a defect in OPHANIM itself. Rounds run continuously and unattended. What makes
that safe is that everything a round lands can be rolled back.

## The wheels

The owner's words (2026-11-20): "The recursion loops are outside of the self repair loops ... wheels on wheels."

- **The inner wheel** is this lane: Detect, select, the existing stages under the round's own work identity, landing,
  and rollback.
- **The outer wheels** govern the lane and are out of its reach:
  - review independence and the three-lab floor (`stages.mjs`, unchanged);
  - authorization and keys (the status ledger: the lane never writes it and never holds a key);
  - the global billing policy (unchanged; the lane adds no cap of its own);
  - the jails, the gates and mutation runners, the pentest;
  - the lessons registry, the register, and the lane itself.

The outer wheels are the **protected surfaces**. They are enforced twice: Detect never selects a defect located on one,
and validate refuses any diff that touches one.

## The owner's amendment (2026-11-20)

"Quit binding shit, on something that keeps going." The amendment replaces the brief's decisions where they conflict:

| Brief | As implemented |
|---|---|
| A config digest bound to the owner-signed entry; a STOP if no field can carry it | **Removed.** The owner-signed `self-repair` item in state `In progress` is only the ON switch (`laneSwitch`). Nothing is bound to it, so the STOP no longer applies. |
| `max_open` rounds | **Removed.** One new round opens per tick, and any number may be open (`createLane().begin`). |
| Backoff K and M; routing to the owner after M attempts | **Removed.** **Rotation** replaces them: a defect whose round ended blocked or failed goes to the back of the queue, the longest-waiting first (`select`). |
| Per-round budget caps | **Removed.** Rounds run under the tick's own limits and the global billing policy, unchanged. |
| (added) Rounds run in parallel | Two rounds never edit overlapping paths at once. A round's open event and every claim of a round carry its paths, and the work ledger refuses an overlap under its append lock (`work.repair` open; `work.claim` `paths`). Detect waits a defect whose site overlaps an open round. |
| (added) A base moved because another round landed first | The reviewed patch is re-applied on the new line head, re-validated there (`verifyRepair`), and only then landed (`land`). The work ledger refuses a landing on a moved base unless a passing re-validation of exactly that commit on exactly that parent was recorded first. |

The amendment keeps these unchanged:

- the protected surfaces;
- the anti-cheating checks;
- landing only on the line, with the revert recorded, and the rollback round;
- Detect reading only OPHANIM's own records;
- review independence and the three-lab floor;
- the outcome's unsigned proposal;
- no status-ledger writes.

## Each decision as implemented

| Decision | Where | Pinned by | Mutation |
|---|---|---|---|
| 1 Authority (amended: the switch only) | `laneSwitch`. The `self-repair` item's gate is `lane`, never dispatched (`reconcile.mjs`). Rounds are reconciled only while the switch is on. | `SR-D1`, `G1` | SR1 |
| 2 Rounds (amended: no max_open) | `createLane().begin` opens one per tick. A round is reconciled as `self-repair.r<N>`: the work ledger's item grammar has no `/`, so the brief's `self-repair/r<N>` is spelled with a dot. | `SR-D2` | SR17, SR19 |
| 3 Detect | `detect` reads the latest gate record (used only when it names the commit under repair), stress records, the register's open entries through `recordsFacts`, and the pentest report. It takes no issue argument. The ranking is regression, then flake, then register. `select` dedupes, routes and rotates. | `SR-D3` (three tests), `G3` | SR2, SR18, SR20, SR21 |
| 4 Diagnose | The lane's plan wrapper runs `reproductionRefusal`. The plan's `repair.reproduction` must FAIL on the round's base (a test), or cite a stress record that shows failures (a flake). `planRefusal` checks the shape in the real plan stage. | `SR-D4`, `SR-V4` (two tests) | SR22 |
| 5 Verify | The lane's validate wrapper runs `verifyRepair` before the validator is asked, in a clean checkout and through the verify jail. It requires: the reproduction passes (a flake: R stress rounds with no failure); every T1-reached test passes; every T2-listed runner passes in full; the pentest shows no new hole; `npm run test:lint -- --enforce` passes. A refusal returns the work to implement. Review is unchanged. | `SR-V`, `SR-V5`, `SR-D5 SR-D6` | SR23 |
| 6 Anti-cheating | `cheatRefusals` and `verifyRepair` refuse: `ASSERTION_REMOVED` (an assertion removed or changed), `SKIP_ADDED`, `TEST_COUNT_LOWERED` (a file's test count, or the file itself), `KILL_COUNT_LOWERED` (a runner kills fewer mutations than at the base), and `PROTECTED_PATH`. | `SR-V6` (four tests), `G5` | SR4 to SR7 |
| 7 Landing | `landOn` and `landingRefusal`. The landing is one commit on the line, as a compare-and-swap `update-ref`. The work ledger refuses a landing that is no fast-forward of the line, a landing on another ref, and a second landing of a round. The record holds the commit, its parent and `git revert --no-edit <commit>`. The outcome writes the round's unsigned lane proposal. | `SR-D7`, `G6` | SR8, SR9 |
| 8 Rollback | `bisectLanded`, bounded to the landings on the line, finds the earliest landing that fails where its parent passes. The rollback round reverts it on the line, verifies the revert with the same `verifyRepair`, lands it, and routes the reverted defect to the owner. In that verification, a failure the revert merely restores is tolerated (`tolerate`). | `SR-D8`, `SR-DEMO` | SR10, SR11 |
| 9 Protected surfaces | `PROTECTED_DEFAULTS` holds the brief's list plus `ophanim/operate/scheduler.mjs` and `work-ledger.mjs`, which carry the lane's own wiring. `laneConfig` may only add to it (`protected_extra`). It is enforced in `select` and in `verifyRepair`. | `SR-D3 and SR-D9`, `SR-V9`, `SR-D9`, `G4` | SR2, SR3 |
| 10 Budget (amended: none of the lane's own) | Rounds use the tick's limits and billing policy. | `SR-D2` (claim budgets) | (none: there is no check left to remove) |
| 11 Audit | `work.repair` events record each round: `open` (the defect, its Detect evidence, the queue, and the routing of every skipped defect), `revalidate`, `land`, `close` and `route`. | `SR-D2`, `SR-DEMO` | (pinned by SR11 and SR19) |
| Amendment: overlapping paths | The `work.repair` open rule and the `work.claim` path fence (`PATHS_CLAIMED`). Detect waits a defect whose site overlaps an open round. | `SR-AM two rounds`, `G7` | SR14, SR15, SR16 |
| Amendment: moved base | In `land`: rebase, then `revalidate`, then land. In the ledger: `REVALIDATE_REQUIRED`. | `SR-AM a round whose base moved`, `G2` | SR12, SR13 |
| Amendment: rotation | `select` puts never-attempted defects first, then attempted ones oldest-first. | `SR-D3 dedupe and ROTATION` | SR18 |

### Where a defect is located

A test failure (gate or stress record) is located at its test file. A register entry is located at the tree paths it
names, in the order its item text names them. Its **subject**, the first of those paths, decides protection (register
rule 2: an entry names the item first). For example, KG-19 names
`ophanim/operate/reliability-r2-a3.test.mjs` first and `scripts/test-gates/stress.mjs`, its measuring tool, second, so it
is located on an unprotected surface.

Three kinds of entry are skipped and not routed:

- an entry that names no path of the tree is **unlocated**;
- a `pending owner` entry is left to the owner;
- a defect that an open round, an owner-signed item, or a landed repair already covers is deduplicated.

## Pentest group G

| Attack | Verdict | Defence |
|---|---|---|
| G1-no-switch | REFUSED | No switch: nothing is opened, dispatched or landed. |
| G1-forged-round | REFUSED | A round recorded with the controller key but no switch is never reconciled or dispatched. |
| G1-forge-switch | REFUSED | A non-owner key cannot record the switch (the status ledger's signature check). |
| G2-stale-parent | REFUSED | `LANDING_NOT_FAST_FORWARD`. |
| G2-no-revalidation | REFUSED | `REVALIDATE_REQUIRED`. |
| G2-failed-revalidation | REFUSED | `REVALIDATE_REQUIRED`: only a passing re-validation of exactly that commit counts. |
| G3-issue-steers-detect | REFUSED | Detect has no issue input: an issue naming a failing test and a round marker opens nothing. |
| G4-protected-path | REFUSED | `PROTECTED_PATH`, nothing run. |
| G4-protected-landing | REFUSED | The refused repair never lands. |
| G5-removed-assertion | REFUSED | `ASSERTION_REMOVED`. |
| G5-added-skip | REFUSED | `SKIP_ADDED`. |
| G5-lower-kill-count | REFUSED | `KILL_COUNT_LOWERED`. |
| G6-land-on-main | REFUSED | `LANDING_REF`. |
| G6-only-the-line | REFUSED | The owner's branch is untouched; the line is the only landing. |
| G7-overlapping-open | REFUSED | `PATHS_CLAIMED`. |
| G7-overlapping-claim | REFUSED | `PATHS_CLAIMED`. |

`scripts/pentest/run.mjs` runs this file, since it reads `ophanim/operate/pentest/`, and counts its attacks. Its `GROUPS`
table has no `G`, though, so these rows are left out of the per-group listing. Adding
`G: 'Self-repair'` to `GROUPS` is a one-line coordinator change: `scripts/pentest/**` is coordinator-only and protected.

## The real-repository dry run

`node ophanim/operate/cli.mjs self-repair` runs Detect and the selection only. It makes no provider call and writes
nothing: no ledger entry, no candidate, no ref.

### Dry run on this repository

Run on `kg/self-repair` (27a9992) on 2026-11-20, from the branch's own checkout:

- **The lane is DORMANT.** The committed status board has no `self-repair` item. The line
  `refs/heads/ophanim/self-repair` does not exist yet; it would start from `HEAD` when the first round opens.
- **The commit under repair is 27a9992** (the base ref, since there is no line yet).
- **Records.** None of OPHANIM's own records is in the lane's records directory: no gate record (the gates were not run
  here, and `check.mjs --json` names no commit until the lane wraps it), and no stress record. KG-19's measurement is in
  the register's text, not in a stress record.
- **A second dry run** wrapped this run's `scripts/pentest/run.mjs` report as a pentest record, in a scratch records
  directory outside the repository. It added no defect: 58 attacks, 48 refused, 10 holes, every one registered (KG-8,
  KG-10, KG-11, L-117, L-128, L-135, L-140, L-147), no new hole, no failing file. So Detect saw the register's 67 open
  entries only.

**Round 1 would select `register:L-133`.** Its subject is `ophanim/operate/reliability-wave2b.test.mjs`: the test's own
unlocked `git branch --list`, racing a pipeline child's `worktree add`. The rule that picks it is the ranking: register
entries come after regressions and flakes, and within the register the register's own order applies. Seven entries are
queued behind it, in that order: L-135, L-145, L-161, KG-11, KG-13, KG-17, KG-19. KG-19, the natural first round the brief
names, is eighth. It is reachable, but it ranks first only once a stress record of `reliability-r2-a3.test.mjs`, a
measured flake, is recorded: flakes rank above register entries.

**Routed to the owner** as unsigned candidates, never selected, because their subjects are protected surfaces:

| Entry | Subject |
|---|---|
| L-160 | `scripts/test-gates/lint-tests.mjs` |
| KG-14 | `packages/graph/federation.mjs` |
| KG-15 | `pantheon/src/capability/eligibility.mjs` |
| KG-16 | `pantheon/src/route/gemini-billing.mjs` |
| KG-18 | `pantheon/src/agy/sandbox.mjs` |

**The rest are skipped:**

- **Pending the owner's decision** (the register says so): L-003, KG-4.
- **Unlocated**: 52 open entries name no path of the tree, so the lane cannot place them on an unprotected surface.
  Most are self-audit entries that name modules without their directory.

Nothing was written: no work ledger was created, and no candidate, record or ref.

## Caveats

- **What a synthetic demonstration cannot prove.** The stages are scripted: no real planner, implementer, reviewer or
  validator answered. The lane's own checks are real: the reproduction run, `verifyRepair` with T1, T2 and the jail,
  landing, the bisect, and the rollback. The wiring of the real stages is in place but has not run with live providers:
  - the planner prompt and the `repair` shape;
  - implement on the round's base;
  - the round's unsigned lane proposal from `proposeFromBundle`'s closed cycle.
- **The owner's signature.** The status ledger in every test is a fixture's, with fresh synthetic keys. No real owner
  signature switched the lane on.
- **A long run of rounds.** The tests run at most four ticks. Rotation, the claim fence and re-validation are pinned by
  their own tests, not by days of operation. Under real load, two rounds whose sites are disjoint can still interact
  through code that imports both. Re-validation on the moved head is what catches that.
- **The line drifts from the owner's branch.** The line starts once from its base ref (default `HEAD` when the first round
  opens) and from then on only moves forward by its own landings. It never takes in the owner's later work. The longer it
  runs unmerged, the more a repair verified on the line can differ from what it would be on the owner's branch, and the
  more merge conflicts the owner meets. Merging the line, or starting a new one, is the owner's act, outside the lane.
- **Detect's locator is textual for register entries.** A register entry whose subject is unprotected may still need a
  protected file to repair. Validate then refuses the diff and the defect rotates: no code reaches the line, but provider
  calls are spent each time it comes round.
- **Runs.** Verification runs commands written by the worker inside the verify jail, as the validate stage's own commands
  run. A real-bwrap suite or a runner that needs a nested jail may not run inside it. It then fails closed and refuses the
  repair.
- **Gate records** do not name a commit themselves (`check.mjs --json`). The lane wraps one with the commit it ran on:
  `self-repair record --kind gate --commit SHA --file FILE`. Nothing else feeds Detect.
