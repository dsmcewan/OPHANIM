# Assignment 3: Execution reliability

Lab: xAI. Model: Grok 4.7. Commit reviewed: `09d490feae4df80effa081d08a02ea240f3dc854`.

Own fixtures only, under `.review-tests/` (`exec-reliability.test.mjs`, `stall-stage.mjs`, `orphan-hang.mjs`). Scripted turns and local processes. No live provider. Command: `node --test .review-tests/exec-reliability.test.mjs`. Result: 11 passed, 0 failed, about 10.3s.

## 1. Call budgets

**holds.** `pantheon/src/pipeline/index.mjs:174`

Every admitted turn increments `provider_calls.total` once, synchronously, before the turn promise. `onCharge` is not awaited, so two units in one wave cannot both pass the last slot. A refused admit does not call the provider. A resumed checkpoint makes no provider call. A quota probe is not charged. A metered failover is one extra admit, and only after `charge()` returns. An aborted signal is checked in `admit` before that API call (`index.mjs:175`, `pantheon/src/pipeline/turns.mjs:236`). A subagent turn is one `counted("subagent")` call (`index.mjs:190`). Inner `num_turns` of one agy session are one call, which is the owner's rule (`ophanim/operate/live-run.mjs:397`). Spend records are cumulative: `spent` keeps the max, not the sum (`ophanim/operate/scheduler.mjs:50`).

Observed: two concurrent units with `max_provider_calls: 3` stayed at or under 3, `total` equalled `onCharge` and the provider log, and `refused_at_limit` was at least 1. A second run on the same checkpoint had `provider_calls.total === 0`. Failover: `api === 1`, `charges === 1`, `probes === 1`. Refused charge and abort-before-failover: `api === 0`.

A pipeline that throws is recorded at the full stage budget (`ophanim/operate/stages.mjs:852`). That over-counts the ledger. It does not place another provider call, and a stage is started only when the remainder covers a whole stage budget (`scheduler.mjs:157`), so the cap still holds.

## 2. Budget stops

**does not hold.** `ophanim/operate/scheduler.mjs:204`

Provider-call stops do stop the item on a non-passing status. `charge` throws `PROVIDER_CALL_LIMIT` (`scheduler.mjs:183`), a result that reports more than its stage budget is rewritten to `failed` (`scheduler.mjs:200`), and only `result.status === 'failed'` returns from the item loop (`scheduler.mjs:233`). A `blocked` stage is not in `STAGES`, so the loop ends (`ophanim/operate/gates.mjs:188`).

The elapsed stop does not. When the stage timer aborts, the result is annotated with `outputs.stopped` and `log.stopped` is set (`scheduler.mjs:204`), and the returned `status` is left as it was. A `passed` result is recorded `passed`, released as `completed`, and the loop continues into the next stage. `planValidity` accepts that record when the item has no dependencies and the outputs omit a ticket (`gates.mjs:44`, `gates.mjs:194`). The stage looks complete, and it is a valid handoff. This is the same defect as question 9. It also touches assignment 1 (lifecycle and evidence): a stopped stage is reused as the next stage's input.

Reproduction, `.review-tests/exec-reliability.test.mjs`, test `Q2 and Q9` (passed, about 7.3s). Real clock, `lease_ms: 8000` (grace 800ms, so the stage aborts at 7200ms), `elapsed_ms: 120000`. The plan executor returns `passed` as soon as `ctx.signal` aborts. The implement executor then charges 1 and returns `failed`. Observed: `dispatched` is `['plan:passed', 'implement:failed']`, `stopped` matches `/stage elapsed limit/`, the plan record's status is `passed` with `outputs.stopped.code === 'STAGE_ELAPSED'`, reconcile's `reuse.plan` is that plan hash, and `spent().calls === 1`.

The suite's own cooperative-stop test (`ophanim/operate/exec-reliability.test.mjs:169`) returns `failed` from the executor, so it never reaches this path.

## 3. Concurrency

**holds.** `pantheon/src/pipeline/paths.mjs:69`

`pathsOverlap` treats an uncertain pair as overlap. `lockConflicts` refuses an unordered overlap (`pantheon/src/pipeline/dispatch.mjs:136`). `waves` puts an overlapping pair in different waves (`dispatch.mjs:154`). The scheduler claim is exclusive (`ophanim/operate/work-ledger.mjs:58` fence, and the claim refusal `already claimed`). `--concurrency` above 1 runs that many items when each still has a full stage budget; a live claim reserves the rest of its budget (`scheduler.mjs:48`, `scheduler.mjs:245`).

Observed: `pathsOverlap('src/shared/**', 'src/shared/leaf.mjs')` is true, `lockConflicts` length 1, and no wave of `a`/`b`/`c` contains an overlapping pair. `concurrency: 2` on two items reached peak 2 and both passed, with `spent().calls <= 20`. A second OS process, holding a live claim, made `claim()` throw `/already claimed/`, and a second `tick` dispatched nothing. The holder was still alive at that check (SIGKILL came after).

## 4. Leases

**holds.** `ophanim/operate/work-ledger.mjs:58`

An unreleased claim past `leased_at + lease_ms` is released as `expired` at the start of the next tick (`scheduler.mjs:108`). The next tick resumes the unfinished stage and does not repeat a passed plan. After that release, `recordStage` and `recordSpend` throw `LEASE_FENCED` even when `at` is inside the original lease. The fence uses the record's `at`.

Observed: a claim leased at `2026-11-17T00:00:00Z` for 1000ms, with a spend of 2, was released as `expired` at `T0+5000` (`released_expired` stages `['implement']`). A later `recordStage` of `{forged: true}` and a later `recordSpend`, both stamped inside the original lease, threw `LEASE_FENCED`. The following tick ran implement once. No stage on the ledger has `outputs.forged`. The passed plan is still the only plan record.

## 5. Retries and the lane ladder

**holds.** `pantheon/src/pipeline/index.mjs:304`

A non-quota `lane_failure` is retried once on the same lane (`again = !quota && !retried`), then stepped down. A failure whose `cause` is `quota` steps down on the first failure. `escalate` runs only for `rejected` and `attempt_refused` (`pantheon/src/pipeline/review.mjs:178`), which is after the lane loop. An exhausted ladder finishes the unit `blocked` with code `LANE_LADDER_EXHAUSTED` and every failure in `attempts[].lane_failures`. No reviewer turn is made.

A soft quota phrase whose probe is not `exhausted` stays a lane failure and is retried once (`turns.mjs:222`). That matches the quota-evidence rule. It is a lane failure, and the immediate step-down is for a proven quota refusal.

Observed, three scripted ladders of three rungs, `max_revisions: 0`. Timeout on the first implementer call: the same model twice, `lane_failures[0].next === 'same_lane'`, `escalations.length === 0`, unit `approved`. Explicit `quota_exhausted` (429): one failure `['quota', false, 'next_rung']`, models carbon then hydrogen. Always-timeout: `blocked`, `LANE_LADDER_EXHAUSTED`, `lane_failures.length === 6`, reviewer calls 0, `attempts.length === 1`.

## 6. Metered failover off

**holds.** `pantheon/src/pipeline/turns.mjs:226`

With `meteredFailover === false`, a proven quota refusal throws `quota_exhausted` with `quota_failover: {used: false, disabled: true}` and does not call `api`. The unit ends `blocked`, `LANE_LADDER_EXHAUSTED`. The board walk skips a `quota_failover` candidate when no lane quota refusal was recorded (`pantheon/src/route/quota-failover.mjs:26`).

Observed: `api === 0`, `probes >= 1`, `onCharge` has no `metered_failover`, `quota_failover.disabled === true` and `used === false`, run status `incomplete`. `routeSeats` on a 503 lane, then the API seat, then a spare OpenAI seat: `asked` does not include `gemini-4-carbon`, `skipped` is `['gemini-4-carbon']`.

## 7. Checkpoints

**holds.** `pantheon/src/pipeline/checkpoint.mjs:50`

`writeCheckpoint` writes the patch and then the JSON, each via a random temp file and `rename`. A reader of the final name never sees a half-written body. `readCheckpoint` rejects a truncated final file as not JSON. Resume applies the patch on a freshly bound base, requires the recorded tree (`pantheon/src/pipeline/index.mjs:415`), and re-runs `verify_cmd` (`index.mjs:418`). `checkpointRefusal` rejects a schema, key, or unit mismatch, a non-approve verdict, a different base, a digest mismatch, and an upstream set, key, or tree mismatch (`checkpoint.mjs:82`).

`unit_key` is the canonical hash of every `UNIT_KEYS` field (`pantheon/src/pipeline/work-units.mjs:34`: `unit_id`, `depends_on`, `owned_paths`, `difficulty`, `specialist_role`, `allowed_subagents`, `verify_cmd`, `invariants`), plus `base_commit` and the upstream keys (`checkpoint.mjs:41`). Rubric text is outside the key, which the header states (`checkpoint.mjs:9`). Changing an invariant changes the key. Adding a rubric field does not.

`rubric_hash` and `review_digest` are checked for shape only (`checkpoint.mjs:90`). Resume happens before dispatch, so they are not recomputed against a new rubric. A shape-valid substitution is accepted when the patch, the tree, and `verify_cmd` still hold. A patch, digest, and tree rewritten to agree with each other are accepted when `verify_cmd` passes. That is the stated ground-truth rule (`checkpoint.mjs:20`). I would not block a live run on it.

Observed: a successful write leaves no `.tmp`. A sibling `ignored.tmp` is not the checkpoint. Digest, base, and upstream mismatches match `/hashes to/`, `/base/`, and `/upstream/`. Truncated JSON matches `/not JSON/`. An approved unit, then a forge of the patch, digest, tree, and `rubric_hash` to content that fails `verify_cmd` (`EVIL`): the next run has `resumed === false`, `checkpoint_rejected.why` matches `/verify_cmd fails/`, and `provider_calls.total > 0`.

## 8. Process restart

**does not hold.** `pantheon/src/pipeline/index.mjs:343`

Three of the four clauses hold.

- Kill mid-stage. Charges are appended before the call returns (`scheduler.mjs:188`). After SIGKILL, the claim has those charges and no stage record. The next tick, past the lease, releases it as `expired` and runs the stage once. The dead claim is not charged again. Observed: two `charge(1)` calls, then SIGKILL, then one resumed charge. `spent().calls === 3`. `released_expired.length === 1`.
- Kill mid-checkpoint-write. The final name appears only after `rename` (`checkpoint.mjs:50`). A torn final body is rejected (question 7). A leftover `.tmp` is not read.
- Kill mid-wave, orphan worktree. `releaseWorktree` is in the unit `finally` (`index.mjs:375`, `pantheon/src/pipeline/dispatch.mjs:196`), which SIGKILL skips. The next run binds `pipeline-<attempt>-<time>` under a new directory. Observed: the second `runPipeline` completed, and `git worktree list` still shows the dead path. The orphan remains and does not interfere. I would not block a live run on it.

The lost finding does not hold, and it overlaps assignment 1. Stage 5 pushes the review and `save()`s, and only then pushes `u.findings` (`index.mjs:343` through `index.mjs:352`). The next `save()` is after `escalate` (`index.mjs:364`). Carry of an interrupted attempt reads `units[].findings` only (`ophanim/operate/stages.mjs:823`). A `request_changes` review that is already on disk, and not yet copied into `findings`, is absent from the next implement. The next attempt does not show that feedback.

Reproduction, same file, test `Q8` (passed). A child charges twice, writes a pid marker, and is SIGKILLed. Assertions above. A second child binds a unit worktree inside the implementer and is SIGKILLed. The following run's status is `completed`, and the orphan path is still listed. Then a passed plan is planted with `pipeline-dead/pipeline.json`: `findings` contains `KEPT_ON_DISK`, and `reviews[].feedback` contains `ONLY_IN_THE_REVIEW_SAVE` only there. `implement` is called with an already-aborted signal (carry runs before any unit is dispatched). The returned finding texts include `KEPT_ON_DISK` and do not include `ONLY_IN_THE_REVIEW_SAVE`. The extra reviewer seat in that fixture is test seating so the capacity check returns after carry is reached. Carry itself does not depend on it.

## 9. Timeouts

**does not hold.** `ophanim/operate/scheduler.mjs:139`

Verify and print timeouts hold. `runVerify` runs `verify_cmd` in its own process group and SIGKILLs that group at `timeout_ms` (`pantheon/src/pipeline/review.mjs:49`, `pantheon/src/pipeline/git.mjs:29`). The worker argv passes `--print-timeout <timeoutS>s` (`pantheon/src/board/agy-cli.mjs:160`). The controller kills the process group at `timeoutS + graceS` (default grace 15s) (`agy-cli.mjs:595`, `pantheon/src/board/spawn.mjs:42`). Observed: `sleep 30` with `timeout_ms: 200` is `timed_out` in under 5s. `workerArgv` has `--print-timeout` `30s`. `spawnPromise('sleep', ['30'], {timeout: 200})` has `killedFor === 'timeout'`.

`elapsed_ms` is checked between stages, as the scheduler and the launcher are written (`scheduler.mjs:139`, `ophanim/operate/live-run.mjs:530`). The check is strict `>`. It matters, and the stop is not enforced there. The launcher sets `lease_ms` to the full `elapsed_ms` (`live-run.mjs:524`) and each tick's `elapsed_ms` to the remaining wall (`live-run.mjs:538`). Stage grace is `min(60s, lease/10)` (`scheduler.mjs:163`), so the stage timer fires before the between-stage check can see the deadline. A stage that returns `passed` inside that window is a complete handoff, and the next stage starts and can charge, while `log.stopped` is already set. The same reproduction as question 2. The in-flight turn is not aborted: `meter` checks `ctx.signal` only before the next call and invokes `turn(args)` without the signal (`ophanim/operate/stages.mjs:115`). The plan's approve return does not read the signal (`stages.mjs:599`). For a one-hour budget the grace is 60s. A last plan-reviewer turn that is already in flight can return, the plan can be recorded `passed`, and implement can start.

## 10. Run record

**holds.** `ophanim/operate/live-run.mjs:493`

`runConfirmed` writes `run.json` after `verifyInChild`, which spawns `node ophanim/operate/verify-run.mjs`. `budget_stops` includes launcher stops, every `tick.stopped`, a stage `next.why` matching `/PROVIDER_CALL_LIMIT|provider-call budget|budget/i`, and a pipeline `refused_at_limit` (`live-run.mjs:452`). `blockers` includes tick blocks and any stage `blocker` (`live-run.mjs:556`). A stage that looks passed after the elapsed abort is still listed, because `tick.stopped` is copied. That listing is this question. The stage looking complete is question 2.

Observed, scripted `runConfirmed`, no live seats: `verification.process.pid` differs from this process, exit code 0, `ok === true`. `budget_stops` contains a `why` matching `/PROVIDER_CALL_LIMIT/`. `blockers` contains `LANE_LADDER_EXHAUSTED`. The stage status is `blocked`. A second `verifyInChild` on the same ledger returned `ok` from another pid.

## Blockers for a live run

1. An elapsed abort records a `passed` stage and starts the next stage in the same tick. The stop is on the log. The handoff is valid, and the next stage can charge. Questions 2 and 9. Same observation belongs to assignment 1.
2. A kill after the Stage 5 review is saved and before `u.findings` is saved drops that review on the next implement. Carry reads `findings` only. Question 8. Same observation belongs to assignment 1.

The orphan worktree, the shape-only `rubric_hash`, and counting a thrown pipeline at its full stage budget are recorded above. I would not block a live run on them.

## Model

Grok 4.7