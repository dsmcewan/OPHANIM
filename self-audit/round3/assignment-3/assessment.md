# Assignment 3 (Execution reliability): self-audit

**Self-audit by the coordinating lab (Anthropic), not independent; commit af0dc30; written before round 3 findings.**

- Commit audited: `af0dc3012688703ccac0f6de31836822a3279eae` (detached, isolated worktree). No tracked file was modified; scratch tests live in `.review-tests/` (untracked).
- Runtime: Node 24.22.1, real bwrap available. Baseline at this commit: `node --test ophanim/operate/*.test.mjs` 139/139 pass; `pantheon` `node --test --test-concurrency=4 tests/*.test.mjs` 1395/1395 pass; 0 cancelled, 0 skipped.
- Lens: the eight failure modes of `findings-retrospective/README.md`. The prior A3 findings (7997657, 09d490f, 77480d6 runner and manual) were read; fixes c64773c, e880a07, 4b1b62f, 5f26e17, 92cbdec, 71959f8 and b411b67 were checked for siblings they missed.
- Reproductions: `.review-tests/sa3-*.test.mjs` in the worktree, copied to `scratchpad/selfaudit/repro-3/`. **Each one passing means the defect is present.** Run them all with:
  `export PATH=/opt/node24/bin:$PATH; node --test .review-tests/sa3-*.test.mjs` (6/6 pass at af0dc30; about 30 s).

Summary of verdicts:

| # | Question | Verdict |
|---|---|---|
| 1 | Call budgets | **does not hold** |
| 2 | Budget stops | **does not hold** (minor) |
| 3 | Concurrency | **does not hold** (cross-process repository ops) |
| 4 | Leases | holds for ledger records; one exception through Q9 |
| 5 | Retries and the lane ladder | holds |
| 6 | Metered failover off | holds for the live run, with residuals |
| 7 | Checkpoints | holds |
| 8 | Process restart | **does not hold** |
| 9 | Timeouts | **does not hold** (argo/legacy lane turns) |
| 10 | Run record | **does not hold** |

---

## Entry points, transports and producers enumerated

Every member was enumerated before the questions were answered (failure mode 1).

- **Entry points:**
  - `tick` (scheduler.mjs:115);
  - `watch` (:329);
  - `runService` (service.mjs:103);
  - live-run `runConfirmed` (live-run.mjs:606);
  - `runPipeline` standalone (pipeline/index.mjs:137);
  - `runOpenItem` (board/run-item.mjs, through stages.mjs:873 for argo/legacy, or a fit plan without units: impossible under fit, since `workUnits: 'required'`, stages.mjs:686).
- **Transports:**
  - the agy CLI single-turn (`agySingleTurn`), the agy CLI unit worker (`runAgyWorkerTurn`) and the agy CLI in runOpenItem (`agyTurn` → `runAgyCliTurn`);
  - the agy SDK in runOpenItem (python, `GEMINI_API_KEY`);
  - the direct API, streamed and unary (`sendTurn` via `liveTurn`, pipeline `api`, and `sdkTurn` in runOpenItem);
  - frontier routing (`routeSeats`/`routeCall`);
  - the metered failover (`laneFirstTurn`, pipeline `admit("metered_failover")`, `routeSeats` `quota_failover`).
- **Charge sites:**
  - the scheduler's `charge` (scheduler.mjs:228);
  - the stage meter's `admit` (stages.mjs:121), which is also the `charge` for continuations and failover;
  - the pipeline's `admit` (index.mjs:207);
  - runOpenItem's `admitProviderCall` → `onCharge` (run-item.mjs:443-474).
- **Continuation hops:** charged via `onRequest` in `sendTurn` (adapter.mjs:246), wired only in `liveTurn` (live.mjs:34) and pipeline `api` (turns.mjs:201). **Not wired in `sdkTurn` (seat-sdk.mjs:80-83, 179), which is what runOpenItem uses (run-item.mjs:693).**
- **Stop signal on the lane:** the pipeline worker gets it (index.mjs:408), and so does `agySingleTurn` (agy-turn.mjs:37). **runOpenItem's `agyTurn` does not (run-item.mjs:634, :564-565).**

---

## 1. Call budgets: does not hold

Holds where checked:

- the stage meter (plan, review, validate), including continuation hops and the failover call;
- the pipeline `admit` (all four roles plus `continuation` and `metered_failover`);
- `routeCall` admits every attempt;
- a resumed `runOpenItem` is bounded by its stage budget (stages.mjs:873);
- subagent calls go through `T.subagent`;
- resumed checkpoint units make 0 calls;
- quota probes are `/usage` with `num_turns` 0 (docs/routing-task-profile.md:457, `agy-quota-observed.test.mjs`).

The ledger refuses a claim past the total atomically (work-ledger.mjs:186-189). Tests: `exec-reliability-a3.test.mjs` "a claim reserves its stage budget…", `exec-reliability.test.mjs` "a restart: calls charged before a kill stay counted…", `pantheon/tests/reliability-r2-a3.test.mjs` "finding 1.1…".

### Defect 1.A: runOpenItem undercounts multi-request turns

This is a sibling of finding 1.1 that was never fixed. `runOpenItem.turn()` calls `sdkTurn` without `onRequest` (run-item.mjs:693). `sdkTurn` has no such parameter (seat-sdk.mjs:80-83) and calls `sendTurn` without it (seat-sdk.mjs:179).

A Google long-decode turn (up to 16 billed hops, wire.mjs:96-123) or an Anthropic compaction is therefore:

- charged once on the work ledger (`onCharge`);
- counted once in the run's own bound (`providerCalls`);
- counted once in the stage usage (`providerCallsOf`, run-item.mjs:142).

That happens even though run.json records `provider_requests: 3` on the attempt. Real billed requests can exceed `stage_provider_calls` and `total_provider_calls`.

- Repro: `.review-tests/sa3-q1-runopenitem-hops.test.mjs`. Three generateContent requests in one implementer turn; `onCharge` is called once for it, and `run.provider_calls.made` counts it once.
- Command: `node --test .review-tests/sa3-q1-runopenitem-hops.test.mjs`.
- Scope: argo/legacy implement and the service's default profile. Not the fit live run (its implement is the pipeline).
- Retrospective modes 1 and 6: the unit of count is still defined per caller, not at the point of spend.

### Defect 1.B: a zero-call exception counts the whole stage budget

An executor that throws having charged 0 is recorded with `usage.provider_calls = e.provider_calls ?? (charged || null)`, which is `null` (scheduler.mjs:243). `spent()` counts null at the claim's full budget (scheduler.mjs:62).

The scheduler knows the exact charge, because every call is charged before it is made. Yet one zero-call throw (for example validate's `git archive` failure, stages.mjs:1364-1365, before the validator is asked) consumes `stage_provider_calls` of the total. A later attempt is then refused with a "provider-call budget" stop although nothing was spent.

- Repro: `.review-tests/sa3-q1-throw-counts-full-budget.test.mjs`. `spent.charged` is 0 while `spent.calls` is 10, and the retry is stopped with "provider-call budget: 5 left of 15". Finding 1.2 fixed this inside `implementUnits` only (stages.mjs:1086-1108), not in the scheduler's catch: mode 1 again.
- Severity: over-count. It is conservative, but it is not "charged exactly once", and it produces false budget stops in Q2/Q10.

### Defect 1.C: runOpenItem's seat-refusal refund diverges from the ledger (inspection, over-count)

A seat-layer refusal (`provider_requests: 0`) decrements runOpenItem's `providerCalls` (run-item.mjs:481-484) after `onCharge` has already written a cumulative `work.spend`. The two counters diverge.

- The ledger stays high, which is conservative.
- runOpenItem then admits a call that `ctx.charge` refuses ("the caller refused to charge"). The effective bound is lower than recorded.
- No repro is needed: the refusal is the conservative direction.

### Can a path exceed the bounds?

Yes: through 1.A. For the fit live run the bound holds as far as checked: pipeline, plan, review and validate all charge per billed request.

---

## 2. Budget stops: does not hold (minor)

Holds:

- the pipeline's own bound is a deterministic `budget_stop` that is not retried (stages.mjs:1172-1182; `reliability-r2-a3-rest.test.mjs` finding 2.2);
- a plan or review incomplete by the stage budget is `STAGE_PROVIDER_CALLS` pending (stages.mjs:329-341; finding 2.3 test);
- an elapsed stop of any status is recorded pending `STAGE_ELAPSED`, never a handoff (scheduler.mjs:262-273; `exec-reliability-a3` "an elapsed abort is not a handoff", `reliability-r2-a3` finding 2.1);
- over-budget usage is `STAGE_BUDGET_EXCEEDED` (scheduler.mjs:247-251).

No partial stage was found that looks complete.

Defects:

- **1.B's false stop.** A budget stop is recorded when 0 calls were made (repro above).
- **The validate sibling of finding 2.3 (inspection).** A validator that runs out of the stage budget ends `failed` with `cause: 'validation-defect'` (stages.mjs:1508), not as a transient `STAGE_PROVIDER_CALLS` stop like plan and review. The reason does reach `next.why` ("…the stage's provider-call budget", context.mjs:501), so `budgetStops`' loose `/budget/i` regex lists it (live-run.mjs:477). The same regex also lists every `STAGE_ELAPSED` stop ("elapsed budget") as a budget stop. The record names it, but the cause is mislabelled. No separate repro was written; the cited lines are the evidence.

---

## 3. Concurrency: does not hold (cross-process repository operations)

Holds:

- **One wave never contains overlapping owned paths.** `pathsOverlap` is conservative, case-folded and checks prefixes (paths.mjs:45-78). Tests: `reliability-r2-a3-rest.test.mjs` finding 3.1, `pipeline-run.test.mjs`.
- **Two processes cannot claim the same item and stage.** Claims re-derive under the ledger's append lock (chain.mjs:270-295, work-ledger.mjs:176-191): fenced, one live claim per item, a reservation against the total. Tests: `exec-reliability.test.mjs` "concurrency…", `exec-reliability-a3` "a claim reserves its stage budget against the total atomically…", `reliability-r2-a3-rest` finding 3.2b.
- **Two services on one work ledger** are refused (service.mjs:116; `reliability-r2-a3` finding 3.2a).
- **In-process `--concurrency > 1`:** items run in parallel, and `iterations` and `budgetLeft` have no await between check and claim (scheduler.mjs:175-216).

Defect 3.A: `repoMutex` is per process.

- **The lock.** `repoMutex` (pipeline/index.mjs:632-638) is a module-scope Map: an in-process lock only. Two processes on one repository each do `worktree add -b`, `worktree remove`, `worktree prune` and `branch -D` with no cross-process lock. Examples: the service plus `operate tick`, the service plus `live-run.mjs` on the same checkout, or two services on two work ledgers.
- **The failure.** A `prune` in one process races another's `worktree add`: `fatal: could not open '.git/worktrees/<wt>/gitdir' for writing`. The pipeline turns that into `GIT_FAILED`, which means a failed unit or run and a spent attempt.
- **Repro.** `.review-tests/sa3-q3-crossprocess-worktree-race.test.mjs`, which drives `sa3-q3-crossprocess-worktree-race.mjs`. It is probabilistic: it loops up to 10 rounds of 4 processes × 25 add/prune/remove/prune/delete cycles. A collision was observed in 1 of 3 standalone rounds, and in the first round of both test runs.
- **Scope.** The docs promise "one instance per work ledger", not per repository. Nothing documents or prevents two ledgers or processes driving one repository.

---

## 4. Leases: holds for ledger records, with one exception

Holds:

- **Expired claims.** Released as `expired` by `tick` (scheduler.mjs:133-136) and by `claim()` itself (work-ledger.mjs:369-373).
- **Resume.** The next tick resumes from the last valid stage.
- **Fence on records.** A stale holder's `recordStage` and `recordSpend` are refused at append and at re-derivation (`fenceRefusal`, work-ledger.mjs:72-77, 217-220, 251-257).
- **Fence on side effects.** Shared side effects are fenced: the ticket, the shared ledger close and the branch writes (stages.mjs:773, 803, 936, 1219, 1326).
- **Tests.** `exec-reliability.test.mjs` "the lease fence…" and "a second claim over an unreleased expired claim…", plus `reliability-r2-a3` finding 4.

Exception: the Q9 defect. A stopped runOpenItem's agy lane process keeps running after the stop. It may keep running after the lease has passed to a new holder. It writes only into the old attempt's board directory, which is not shared with the new holder, so no record is affected. It is still unfenced work by a stale holder.

---

## 5. Retries and the lane ladder: holds

Each rule and where it is enforced (pipeline/index.mjs):

- a non-quota lane failure is retried once on the same lane, then steps down: `again = !quota && !retried`, :420-433;
- a quota refusal steps down at once, skipping the same base model: :423;
- an exhausted ladder ends `blocked LANE_LADDER_EXHAUSTED` with `lane_failures` recorded: :436-443;
- lane failures spend no revision, because the ladder loop runs before `escalate`: :445-497;
- a refused metered-failover answer is a lane failure: :413-415.

Tests: `pipeline-ladder.test.mjs` (all six), `reliability-r2-a3.test.mjs` findings 5.1, 5.2 and 5.3.

Note (not a defect): `runOpenItem`'s walk (`routeSeats`/`routeCall`) has its own retry rules and no same-lane-once rule. The question is about the pipeline ladder.

---

## 6. Metered failover off: holds for the live run, with residuals

Holds:

- `laneFirstTurn` refuses a laneless Gemini seat (`AGY_NO_LANE`) and a quota refusal with `failover: false` (agy-turn.mjs:69-72, 85-87);
- the pipeline passes `meteredFailover` (stages.mjs:1091);
- `routeSeats` skips `quota_failover` candidates (quota-failover.mjs:33-36);
- the validator records `METERED_FAILOVER_DISABLED` pending (stages.mjs:1497-1504);
- live-run deletes `GEMINI_API_KEY`/`GOOGLE_API_KEY` with `not-used` (live-run.mjs:612);
- the unit block is recorded.

Tests: `live-run.test.mjs` "CONFIRMED with metered_gemini_failover: false…" (asserts `ctx.calls.length === 0`), and `reliability-r2-a3` finding 6 ×2.

Residuals (inspection; not reachable with the default seating):

- **No point-of-spend guard.** In runOpenItem, a non-lane, non-frontier `agy_google` scout or reviewer goes to the agy SDK transport, which bills `GEMINI_API_KEY` (run-item.mjs:540, 566-568), and no `meteredFailover` check applies there. Only the seating config test keeps every `agy_google` seat on a lane. This is retrospective mode 6.
- **No switch outside the live run.** The service and `operate tick` cannot turn the failover off: `makeExecutors` defaults to `meteredFailover = true` (stages.mjs:445), and neither `cli.mjs` nor `service.mjs` sets it.

---

## 7. Checkpoints: holds

What is checked, and where:

- **Atomic write.** Temp file and rename, patch first then record (checkpoint.mjs `atomicWrite`, `writeCheckpoint`).
- **Resume.** Requires all of these:
  - the HMAC seal under a key outside the checkpoint dir (stages.mjs:1094);
  - the review re-hashed;
  - the rubric hash recomputed from the current unit;
  - this run's `sameModel` and diff bound;
  - subagent receipts;
  - the upstream unit set, keys and trees;
  - the patch digest;
  - then apply on the freshly bound base, an exact tree, and `verify_cmd` re-run in the verify jail with the deadline.
- **Unit key v2.** Covers the validated unit, the base commit, transitive upstream keys and siblings. Carried invariants are folded into `unit.invariants` before keying (stages.mjs:1024).

Tests: `pipeline-resume.test.mjs` (5), `pipeline-exec-reliability` "a self-consistent forged checkpoint whose verify_cmd fails…", `reliability-r2-a3` finding 7.

Minor notes, not failures of the question:

- `rename` without `fsync` gives kill-atomicity, not power-loss durability. A torn file is refused and re-run, never accepted.
- `approvalRefusal` skips `sameModel` when the recorded `served_model` is empty (checkpoint.mjs, under "THIS RUN'S POLICY"). That is assignment 2 territory.

---

## 8. Process restart: does not hold

Crash-point sweep:

| Kill point | Result | Verdict |
|---|---|---|
| After `work.claim`, before any spend | Released `expired` after the lease; nothing counted | ok |
| After `recordSpend`, before the call | Counted, not made: an over-count | ok (conservative) |
| After the call, before the stage record | Charges stay counted (`spent()` takes the max of charged and usage). Unit checkpoints survive. Killed-run findings are carried (stages.mjs:1035-1078, finding 8.2 fix). The open review cycle is resumed. | ok |
| After `recordStage`, before release | The claim blocks the item (gate `claimed`, gates.mjs:118) until the lease expires; then it is released `expired`, although its stage passed | ok (cosmetic) |
| Mid-checkpoint write | Atomic rename; a mismatch is refused and the unit re-runs | ok |
| Mid-wave (pipeline) | The worktrees are removed by the next attempt (stages.mjs:1042). **The integration branch is left for good** | **defect 8.A** |
| Live run, mid-stage | The claim's lease is `elapsed_ms + grace` (live-run.mjs:619-620). A restarted launcher sees gate `claimed`, ticks nothing and exits 3 until the whole elapsed budget has passed. This is not documented in the launcher header, which says only "resume" | **defect 8.B** (operational) |
| Live run, between the two run.json writes | run.json claims acceptance before any verification | **defect 8.C** (see Q10) |

### Defect 8.A: a killed attempt's integration branch is never deleted

Finding 8.1 (c64773c) deletes a dead run's `pantheon/pipeline/<run_id>` only when the restart is into the same directory with the same run_id (index.mjs:248-259). The lifecycle never does that: every attempt gets `pipeline-<attempt>-<now>` (stages.mjs:1025) and a random run_id. Its recovery of the killed attempt (stages.mjs:1042) removes worktrees, not branches. The only branch deletion in stages.mjs happens on ship (:1221).

- The regression test for 8.1 (`reliability-r2-a3.test.mjs:69`) exercises an entry point the lifecycle does not use: retrospective mode 4, "wrong entry point".
- Repro: `.review-tests/sa3-q8-lifecycle-orphan-integration-branch.test.mjs`. It builds the exact on-disk state a SIGKILL leaves, then runs the lifecycle's recovery; the branch survives.
- Severity: the leaked ref holds worker-written merged units. It does not interfere with later runs, because names are unique.

### Defect 8.B: an interrupted live run cannot resume until its whole elapsed budget passes

See the table. No repro was written: the lease arithmetic at live-run.mjs:619-620 and the gate at gates.mjs:118 are deterministic. The record does name gate `claimed` in `acceptance.reasons`, but no blocker or budget stop says that a dead holder's lease is the cause.

No double charge or lost finding was found.

---

## 9. Timeouts: does not hold (argo/legacy lane turns)

Holds:

- **runVerify** (pipeline/review.mjs:65-85, git.mjs:18-55):
  - the stage `signal` and `deadline` cap it; a deadline already past starts nothing;
  - it runs in its own process group with a 2 s failsafe, and the jail dies with it (`--die-with-parent`, PID namespace).
- **Validate** commands are bounded by `leftMs()` and the signal (stages.mjs:1356-1360).
- **The worker's `--print-timeout`** is derived from the deadline (`printTimeoutOf`, 4b1b62f).
- **The stage's elapsed time** is the remainder of the tick's and of the lease less grace (scheduler.mjs:200-202).
- **The live run's lease** leaves the stage its whole remaining time (live-run.mjs:616-620).
- **The preflight and the verifier** are inside `elapsed_ms`; the verifier also gets a 5 s floor (live-run.mjs:592-593).

Tests: `verify-deadline-r2a3-f9.test.mjs` (4, real bwrap), `reliability-r2-a3-rest` finding 9, and the `reliability-r2-a3-stop-signal` tests (API path only).

On the docs' "`elapsed_ms` is checked between stages only": that is no longer the design. The tick checks between stages (scheduler.mjs:176), and each stage has its own cooperative signal at its share. The bound is cooperative: an executor that ignores the signal overruns it, as below.

### Defect 9.A: runOpenItem's lane turn ignores the stop

`runOpenItem.turn()` calls `agyTurn({purpose, model, prompt, declared})` with no signal (run-item.mjs:634). `agyTurn` calls `runAgyCliTurn` without a signal, with `timeoutS = PANTHEON_AGY_TIMEOUT ?? 900` and no deadline (run-item.mjs:526, 564-565). The SDK transport is the same (:576).

On abort, `routeCall` rejects promptly, so runOpenItem returns. **But the agy CLI process keeps running until its own timeout (up to 915 s).** That is after the stage was recorded as stopped, and possibly after the lease has passed on. Live, the Antigravity session keeps working and writing into the board directory.

- 5f26e17 claims "every turn … defaults to [ctx.signal]". `turn()`'s `signal = opts.signal` default is unused on the lane branch.
- Repro: `.review-tests/sa3-q9-runopenitem-lane-ignores-signal.test.mjs`. Abort at 500 ms; runOpenItem returns about 0.5 s later; `pgrep` still finds the lane's agy process 3 s later; it dies only at the CLI timeout of about 20 s.
- Scope: argo/legacy only. This is a mode 1 sibling: `agySingleTurn` and the pipeline worker got the signal; runOpenItem's lane did not.

---

## 10. Run record: does not hold

Holds:

- a child node process (`verify-run.mjs`) verifies the work, status and run ledgers with domain kinds;
- it verifies run.json's body by digest against the ledgers, and every `pipeline.json` against its stage's digest;
- `budget_stops` includes blocker-only stage stops;
- `blockers` includes the final gate (live-run.mjs:473-485, 660-682).

Tests: `live-run.test.mjs` "CONFIRMED: only the selected item runs…", `reliability-r2-a3-rest` finding 10.1, `reliability-r2-a3` finding 10.

### Defect 10.A: run.json asserts acceptance before verification

run.json is first written with `verification: null` and `acceptance: {met: true, reasons: []}`, computed before the fresh verification (live-run.mjs:663-676). It is rewritten only after the child returns, up to `verifyTimeout` (≤ 120 s, :677-682). A launcher killed in that window leaves a record on disk that says the run was accepted while nothing verified it.

- Repro: `.review-tests/sa3-q10-runjson-acceptance-before-verification.test.mjs`. It captures the first write with real bwrap and the fixture live run.
- Fix direction: write `acceptance` as pending (or `met: false`, "verification not yet run") in the interim record.

### Other gaps

- `budget_stops` matches `/budget/i` on `next.why` (live-run.mjs:477). It therefore lists every `STAGE_ELAPSED` stop and every 1.B false stop as a provider budget stop, so the list is not structurally derived (retrospective mode, round-2 A3-B7).
- A restart blocked by a live dead-holder claim (8.B) appears in no `blockers` or `budget_stops` entry.

---

## The verify jail (pantheon/src/agy/verify-jail.mjs) and stage leases

- **Deadlines.** `runVerify` caps its timeout at the time left before the deadline and refuses to start past it. Validate caps at `leftMs()`. Neither can outlive the stage's elapsed budget by more than the kill grace (2 s, or 250 ms for `spawnPromise`). The stage itself ends at least `min(60 s, lease/10)` before the lease, so a verify run cannot push a stage past its lease.
- **Abort.**
  - The launcher forwards SIGTERM, SIGINT and SIGHUP to bwrap (verify-jail.mjs:369-371).
  - A group SIGKILL kills the launcher. bwrap's `--die-with-parent` and the PID namespace then kill the jail.
  - The failsafe resolves even when a stray process holds the pipes. Tested.
- **Residuals.**
  - A SIGKILL'd launcher leaves its scratch dir (generated passwd, group and git configs; no secret) in `$TMPDIR`. This is an orphan, not interference.
  - The `allow_unjailed` fallback spawns `/bin/sh` with no process group of its own, so an abort can orphan its children. That fallback is never set in production code (only `jail.allowUnjailed`, review.mjs:75).
  - The verify jail has `--unshare-net`, so a `verify_cmd` that needs the network now fails deterministically and is retried as a real failure. This is a behaviour change from 71959f8 and b411b67 for plans whose tests reach a registry, a reliability consequence to note.

---

## Vacuous tests and overclaiming documents

- **`reliability-r2-a3.test.mjs:69` (finding 8.1).** It tests a restart into the same directory with the same run_id, a path the lifecycle never takes (defect 8.A). Wrong entry point.
- **The finding 9 stop-signal tests.** `ophanim/operate/reliability-r2-a3-stop-signal.test.mjs:17` and `pantheon/tests/reliability-r2-a3-stop-signal.test.mjs` exercise the API transport only. No test aborts a runOpenItem lane turn (defect 9.A).
- **The finding 1.1 tests** cover `pipelineTurns` and `liveTurn` only. No test covers runOpenItem's `sdkTurn` (defect 1.A).
- **docs/routing-task-profile.md:416-428 ("What is scripted only, and known gaps").** It contradicts the code and the later sections of the same doc:
  - "The implementer is not sandboxed at OS level" (:424): it is, with bwrap and the verify jail.
  - "A lane failure that is not a rejection retries the same lane; the pipeline does not step to another lane on it" (:427): it steps down after one retry.
  - "A pipeline run is not resumed. A stage that is retried starts a new run" (:428): checkpoints resume units.

  This is a stale-register problem (retrospective mode 3).
- **docs/operate-service.md:30.** "If the process is killed during a stage … The next start then releases it as `expired` and resumes". True only after the lease. The service default `lease_ms` is 30 min, and the live run's lease is the whole `elapsed_ms`. The doc does not say the restart waits.
- **The live-run header (live-run.mjs:40-45)** says `elapsed_ms` "bounds … every stage". True for fit (the live-run profile). Not true for argo/legacy runOpenItem lane turns (9.A).
- **Commit 5f26e17's message** ("every turn … defaults to it") overclaims; see 9.A.

## Did the recent fixes break other invariants?

- **c64773c / e880a07.** They introduced or left the siblings 1.A, 1.B, 8.A and the validate 2.3 sibling. No regression of earlier invariants was found.
- **4b1b62f, 5f26e17, 92cbdec.** Correct on the paths they touched. The runOpenItem lane was missed (9.A).
- **71959f8, b411b67 (verify jail).**
  - Validate now runs its commands in the jail, with signal and timeout.
  - The jail hides the work root and the operate state.
  - No-network verify is a behaviour change for network-needing tests (noted above).
  - No lease or budget invariant was found broken.

---

## Blockers for a live run

The live run is `live-run.mjs`, profile fit, one item. Ordered by consequence:

1. **10.A: run.json claims `acceptance.met: true` before verification.** A kill or crash during the up-to-120 s child verification leaves an accepted-looking record that nothing verified. For a launcher whose output is the evidence, this is a blocker until the interim record says "pending".
2. **8.B: an interrupted live run cannot be resumed until `elapsed_ms + grace` has passed.** The record does not name the held claim as the reason. Block until it is documented, or the launcher can release its own dead claim (same marker, dead pid).
3. **3.A: no cross-process repository lock.** Do not run the service, or `operate tick`, on the same checkout while the live run is in progress. As an operating rule this is acceptable; without that rule, a spurious `GIT_FAILED` costs an attempt.

Not live-run blockers (argo/legacy and service paths), but block those paths:

- **1.A**: runOpenItem undercounts multi-request turns, so spend can exceed `total_provider_calls`.
- **9.A**: runOpenItem lane turns are not cancelled by the stage stop and orphan an agy process for up to 915 s.

Should be fixed, not blocking:

- 1.B, a zero-call throw counted at the full stage budget;
- 8.A, the orphan integration branch;
- the validate budget-stop cause label;
- the `budget_stops` regex;
- the stale docs at routing-task-profile.md:416-428.
