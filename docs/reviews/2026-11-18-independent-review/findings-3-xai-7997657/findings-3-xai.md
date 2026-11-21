<!-- Written by pantheon/scripts/run-review.mjs. The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 3, Execution reliability

- status: complete
- stop_reason: final answer
- lab: xAI
- requested_model: `grok-4.7`
- served_model: `grok-4.7`
- commit: `7997657e77d597c6dfda8b7d971d0e4499c88b3a`
- started_at: 2026-11-18T22:51:37.218Z
- ended_at: 2026-11-18T23:10:23.795Z
- provider_calls: 48
- tool_calls: 115
- usage_totals: `{"prompt_tokens":5995752,"completion_tokens":14676,"total_tokens":6068412,"prompt_tokens_details":{"text_tokens":5995752,"audio_tokens":0,"image_tokens":0,"cached_tokens":5766784},"completion_tokens_details":{"reasoning_tokens":57984,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0},"num_sources_used":0,"cost_in_usd_ticks":47983680000}`
- limits: `{"max_turns":60,"max_tool_calls":180,"max_output_tokens":16000,"timeout_s":600}`
- transcript: `findings-3-xai.transcript.json` sha256 `22d33e2bac8130e421900b77a65da15140dd5ce0a4da9584c7c71d4b603aed2d`
- harness_template_sha256: `55b5d8580a3b5ba236cd67d9622230d96a4339cd5d2d71d84183884901a573e9`
- system_sha256: `503b621281cc10f40b44bf77a425223899b7c561075ac15786263dc7d5af3902`
- brief_sha256: `72e744346c35fdc5a3a32f9a71278535f06c14ff510a35e0486ab7fc0e87fcb4`
- tools_sha256: `941d4f1b16028639d7a8614b894b1491109ad27f9ac2db63843cba440c959f7c`

<!-- reviewer's final message, verbatim, follows -->

# Assignment 3: Execution reliability

**Lab:** xAI. **Model:** grok-4.7. **Commit:** `7997657e77d597c6dfda8b7d971d0e4499c88b3a`. No live provider was called. Reproductions are `node --test` on the files named below (scripted turns, temporary directories).

## 1. Call budgets

**does not hold.**

A call that goes through the pipeline's `counted` wrapper is incremented once, synchronously, before the turn (`pantheon/src/pipeline/index.mjs:160-166`). Lane retries, ladder steps, judging-turn admission retries, and subagent turns each call that wrapper again, so those are charged once each. A resumed unit returns before any turn (`pantheon/src/pipeline/index.mjs:230-231`). A quota probe is not a counted turn: it is `probeQuota` inside the implementer adapter and is not added to `provider_calls` (`pantheon/src/pipeline/turns.mjs:217-220`). That matches "probes cost nothing."

Two paths still miss or exceed a bound:

- **Metered failover is a second provider call inside one charge.** `counted` increments once, then `pipelineTurns`' implementer may call the metered Gemini API after the lane refusal (`pantheon/src/pipeline/turns.mjs:232-246`). The API call is not a separate increment. Reproduction: `.review-tests/exec-reliability.test.mjs`, "metered Gemini API failover is a second provider call inside one counted implementer turn" — `apiCalls === 1`, `charged === 1`, probe ran once.
- **The scheduler does not reserve in-flight spend.** `budgetLeft` is `total_provider_calls - spent(work).calls`, and `spent` counts only recorded stages (`ophanim/operate/scheduler.mjs:37-45`, `112`, `134`). With `concurrency > 1`, two stages both pass the check, both run, and both are recorded `passed`. Reproduction: `.review-tests/exec-reliability-2.test.mjs`, "concurrent stages that exceed the budget are recorded passed" — `total_provider_calls: 5`, `stage_provider_calls: 5`, `concurrency: 2`, two plans each reporting 5 calls, `spent.calls > 5`, both stages `passed`.

A stage killed before `recordStage` is also absent from `spent`, so a later attempt can spend a full stage budget again (question 8). The launcher pins `concurrency: 1` (`ophanim/operate/live-run.mjs:504`), so the race is not on that path. The scheduler, the CLI, and the service accept a higher concurrency.

Unknown usage counted at the claim budget (`scheduler.mjs:41-43`) is the stated conservative overcount, not an undercount.

## 2. Budget stops

**does not hold.**

On one item, the scheduler stops before the next claim and records `stopped` (`ophanim/operate/scheduler.mjs:115-116`, `134`). A pipeline turn past `max_provider_calls` throws `PROVIDER_LIMIT` before the call (`index.mjs:163`). The unit is finished `blocked`, not `approved` (`index.mjs:303-310`), and the fit stage is recorded `failed` when `refused_at_limit > 0` (`ophanim/operate/stages.mjs:873-875`). That part does not leave a partial unit looking approved.

The concurrent path does not stop the work that crossed the total. Both stages are already `passed` when `stopped` is set for the next stage (same reproduction as question 1). The stop does not unwind them. The scheduler also does not reject a `passed` result whose reported `usage.provider_calls` is above the stage budget; it records whatever the executor returns (`scheduler.mjs:154-162`).

## 3. Concurrency

**does not hold.**

Two units in one wave do not run with overlapping owned paths. `lockConflicts` refuses a plan whose unordered units overlap (`pantheon/src/pipeline/dispatch.mjs:136-144`), and `waves` also splits a level so no wave holds an overlapping pair (`dispatch.mjs:154-169`). `runPipeline` uses that wave list (`index.mjs:179-189`).

Two scheduler processes cannot both claim the same item while a lease is still live. The ledger lock serializes appends, and claim re-derivation refuses an unreleased claim whose lease is still in the future (`ophanim/operate/work-ledger.mjs:118-126`). Reproduction: `.review-tests/exec-reliability-3.test.mjs`, "two processes: the ledger lock refuses a second live claim" — exactly one of two simultaneous claims succeeded.

After the lease time, an unreleased claim does not block a new one: the check is `leased_at + lease_ms > at` (`work-ledger.mjs:124`). A second process can claim the same item and stage before the first tick releases the expired claim. Both can then `recordStage` (question 4).

Under `--concurrency` greater than 1, up to that many items run at once (`scheduler.mjs:169-178`). Claims are per item, so two items do not share a claim, but the provider-call check is not a reservation. The reproduction in question 1 spent 10 against a total of 5 and recorded both stages `passed`. The launcher forces `concurrency: 1`. The service and CLI do not.

## 4. Leases

**does not hold.**

A claim past its lease is released as `expired` at the start of the next tick (`ophanim/operate/scheduler.mjs:85-88`), and `activeClaim` ignores an expired lease (`work-ledger.mjs:253`). That release does not fence the result. `work.stage` re-derivation checks that the stage cites one claim and matches item, stage, and attempt. It does not check that the claim is unreleased or that the lease is still valid (`work-ledger.mjs:163-181`). `earliestGate` then treats the latest stage record with the right handoff as the work (`ophanim/operate/gates.mjs:166-194`), including a record written after the claim was released as `expired`.

Reproduction: `.review-tests/exec-reliability.test.mjs`, "stale holder records a passed stage after the lease is released as expired". After the tick released the implement claim as `expired`, the old holder appended a `passed` stage citing that claim, with a finding. The next tick ran implement zero times and the gate was `review`. The stale outputs were the handoff.

So the next tick does not reliably resume from the last valid stage. A holder that outlives its lease can still record, and that record can be the one that is reused.

## 5. Retries and the lane ladder

**holds.**

In the implementer loop (`pantheon/src/pipeline/index.mjs:279-307`): a non-quota `lane_failure` sets `again` only when `retried` is false, so the same lane is tried at most twice; the next failure steps down and clears `retried`. A quota cause (`lane_failure.cause === "quota"`, from `code === "quota_exhausted"` in `implement.mjs:47-51`) does not retry. With no rung left the unit is `blocked`, `code: "LANE_LADDER_EXHAUSTED"`, and every failure is on that attempt's `lane_failures` (vendor, model, level, kind, cause, why, retry, next) plus an `escalations` entry per step-down. The loop does not call `escalate` and does not increment `state.revisions`, so a lane failure spends no review revision. Each attempt still goes through `counted`, so each call is charged.

A soft quota phrase that the probe does not confirm is thrown as `lane_failure` kind `exit`, not as quota (`turns.mjs:222-224`). That is a lane failure, retried once, not an immediate step-down. That matches the adapter's own rule.

## 6. Metered failover off

**holds** on the fit launcher path.

`pipelineTurns` throws `quota_exhausted` with `quota_failover: { used: false, disabled: true }` before `api()` when `agy.meteredFailover === false` (`pantheon/src/pipeline/turns.mjs:226-229`). The single-turn seat does the same in `laneFirstTurn` (`pantheon/src/sdk/agy-turn.mjs:66-68`). The launcher passes the manifest flag into both (`ophanim/operate/live-run.mjs:501-503`). The pipeline then treats it as any quota refusal and, with the ladder spent, blocks the unit (`index.mjs:289-306`). The fit stage records that as `blocked` with `PIPELINE_UNITS_UNRESOLVED` (`stages.mjs:887-892`).

Reproduction: `.review-tests/exec-reliability-2.test.mjs`, "meteredFailover false never calls the API" — the rejection carries `disabled: true`, and the injected API counter stays 0. The probe still runs; it is not the metered API.

`runOpenItem` (argo and legacy) does not receive this flag (`stages.mjs:667`). The fit launcher does not use that path when the plan has work units. A fit run with the switch off does not call the metered API through the pipeline or the single-turn seats.

## 7. Checkpoints

**does not hold.**

The write is a temp file plus rename, patch first, then the JSON (`pantheon/src/pipeline/checkpoint.mjs:47-59`). A leftover `*.tmp` is not read (`readCheckpoint` only opens `<hex>.json`). Reproduction: `.review-tests/exec-reliability-3.test.mjs`, "a half-written checkpoint temp file is not a checkpoint". A crash after the patch rename and before the JSON rename leaves the old JSON pointing at new bytes, which fails the digest check. That part does not accept a half-written file.

On resume, the digest and the applied tree are checked (`checkpoint.mjs:87-91`, `index.mjs:386-391`). A different `base_commit`, unit key, or upstream tree is refused (`checkpoint.mjs:82-91`). A patch whose bytes do not match `patch_digest` is refused.

A tampered checkpoint that stays internally consistent is accepted. `checkpointRefusal` does not re-run `verify_cmd`, and resume does not either (`index.mjs:375-399`). Reproduction: `.review-tests/exec-reliability.test.mjs`, "a self-consistent tampered checkpoint is resumed as approved without re-running verify". The patch was replaced with one that writes `EVIL`, the recorded digest and tree were updated to match, and the unit's `verify_cmd` was `test -f src/a/impl.mjs && ! grep -q EVIL src/a/impl.mjs`. The second run resumed the unit with zero provider calls, marked it `approved`, and merged `EVIL` onto the integration branch.

`unit_key` matches its documented formula: every `UNIT_KEYS` field, the run's base commit, and transitive upstream keys (`checkpoint.mjs:38-41`, `work-units.mjs:34`). It does not include the rubric, the verify result, or a signature. That is why a forgery under the same key is looked up and then accepted. Relative to "can a tampered checkpoint be accepted", the key is not a complete bind on the approved result.

The fit executor does not pass `checkpoints` into `runPipeline` (`stages.mjs:817`), so the launcher does not use this resume path today. The pipeline feature itself accepts the forgery.

## 8. Process restart

**does not hold.**

A kill before `recordStage` leaves an open claim and no stage record. `spent` does not see those calls. After the lease expires, the next tick releases the claim as `expired` and runs the stage again, charging it again. Reproduction: `.review-tests/exec-restart-charge.test.mjs`. After the first executor had already counted 4 external calls and not returned, `spent` was 0. The resume recorded 4 and the external counter was 8. The first run's findings were never on the ledger.

The fit implement stage makes this worse. Each attempt uses a new directory (`stages.mjs:801`) and does not pass `checkpoints` (`stages.mjs:817`). A kill mid-wave drops every unit already approved in that pipeline, including findings kept only in that run's `pipeline.json`. The next attempt pays for them again. Incremental `pipeline.json` writes also swallow errors (`index.mjs:128`), so a failed snapshot is not itself a failure of the run.

A worktree whose directory was removed, left registered, did not block a later `worktree add` at a different path (`.review-tests/exec-reliability-3.test.mjs`). The lifecycle's new directory avoids a same-path collision. I could not show a leftover `index.lock` blocking `git status` in this environment, so I cannot tell whether a kill inside `git` leaves a lock that later stops the next run. The double charge and the lost finding do not depend on that.

A kill during the checkpoint rename sequence does not leave a readable half-written checkpoint (question 7). That does not save the lifecycle path, which never reads checkpoints.

## 9. Timeouts

**holds**, and the between-stages limit matters.

`elapsed_ms` is checked only at the start of a stage attempt (`scheduler.mjs:116`) and, in the launcher, only before a tick (`live-run.mjs:509-518`). A stage that has started is not stopped. Reproduction: `.review-tests/exec-reliability-2.test.mjs`, "a stage that overruns elapsed_ms is still recorded passed" — limit 30 ms, executor slept 80 ms, stage `passed`, `stopped` set only for the next iteration. The stage budget's `elapsed_ms` is passed through (`scheduler.mjs:138`) and only recorded by the executors; `stages.mjs` never stops on it. The implement stage is the whole pipeline, and the worker's own timeout defaults to 1800 s (`turns.mjs:165`, `agy-cli.mjs:531`). A live implement stage can keep making calls long after `elapsed_ms`. The call budget still bounds how many calls are admitted, not how long the stage runs.

Verify is enforced: `runVerify` passes `limits.verify_timeout_ms` into `exec`, which kills the process group (`pantheon/src/pipeline/review.mjs:49-55`, `git.mjs:29-30`). Print timeout is both a CLI flag (`--print-timeout`) and a process kill after `timeoutS + graceS` (`pantheon/src/board/agy-cli.mjs:157`, `589-602`).

## 10. Run record

**does not hold.**

`run.json` is written in the same process that ran the ticks (`live-run.mjs:527`, `543-545`). `freshVerification` re-opens the work ledger, the cited run ledgers, and the status ledger and verifies them (`live-run.mjs:460-482`). That is a fresh reader of the files, not a fresh process. Nothing in `runConfirmed` spawns a child to re-verify.

The listing of stops and blockers is otherwise filled in. `budgetStops` takes launcher stops, every tick `stopped`, a stage `next.why` matching the budget pattern, and `refused_at_limit` (`live-run.mjs:451-458`). `blockers` takes tick `blocked` entries for the item and every stage that carries a `blocker` (`live-run.mjs:535`). A quota block with failover off is a blocker, not a budget stop, and the existing launcher test expects it on `rec.blockers`. I did not find a budget stop that this assembly drops. The fresh-process clause is what fails.

## Blockers for a live run

1. **No lease fence on the result.** A holder can `recordStage` after its claim was released as `expired`, and the next tick will treat that stage as done and skip the resume. That is on the recovery path the launcher uses. Do not start a live run until a stage record is refused unless the claim is still the unreleased, unexpired claim.

2. **A killed implement stage is paid for again, and its findings are dropped.** Unrecorded calls are invisible to `spent`, the next attempt uses a new pipeline directory, and checkpoints are not passed. Across a restart the declared `total_provider_calls` does not bound calls that already happened, and in-run findings that existed only in the killed `pipeline.json` are gone. Do not start a live run that may be interrupted until that resume keeps completed units and counts calls that already left the process.

3. **Do not raise scheduler concurrency above 1** until in-flight stage budgets are reserved. At 2, two stages both recorded `passed` and the total was exceeded. The launcher pins 1; the service and CLI do not.

4. **Do not enable metered Gemini failover** until that API call is charged on its own. With the switch off, the API is not called and the block is recorded. With it on, the call sits inside an already-counted implementer turn.

5. **Do not turn on pipeline checkpoint resume** until a checkpoint is re-verified by `verify_cmd` (and bound so a rewritten patch, digest, and tree cannot be accepted together). The launcher does not pass `checkpoints` today. The feature as written merged a forged tree that failed the unit's own verify command.

`elapsed_ms` not stopping a stage already in flight is real and matters for a long implement stage, but the call budget still admits calls, and the between-stages check is what the code and the assignment's docs describe. I would not block a live run on that alone if the call budget is the spend cap and the two fencing and restart defects above are fixed first.

## Model

grok-4.7