# Assignment 3: Execution reliability

**Scope:** provider-call limits, concurrency, leases, retries, checkpoints.
**Testing:** mock providers and isolated processes. Use the scripted clients in `pantheon/tests/fixtures/dispatch.mjs` and the fake `agy` it installs, under temporary directories. You may kill and restart processes to test leases and resume. No live provider.

## Where to look

- `ophanim/operate/scheduler.mjs`: `tick`, `watch`, `DEFAULT_LIMITS`, leases and expired claims, the `only` selector.
- `ophanim/operate/work-ledger.mjs`: claims, releases and stage records.
- `ophanim/operate/live-run.mjs`: the one-item launcher's limits, stop conditions and run record.
- `pantheon/src/pipeline/`:
  - `index.mjs`: waves, concurrency, limits, the `checkpoint.mjs` hookup;
  - `implement.mjs`: the lane ladder and same-lane retry;
  - `checkpoint.mjs`, `review.mjs`, `turns.mjs`.
- `pantheon/src/route/quota-failover.mjs` and `pantheon/src/agy/quota.mjs`: quota detection and the metered-failover switch.
- `pantheon/src/board/run-item.mjs`: per-file runs under `argo` and `legacy`, including resume.
- Existing tests: `ophanim/operate/{scheduler,service,live-run,cli}.test.mjs`, `pantheon/tests/pipeline-{run,ladder,resume,async,turns}.test.mjs`, `quota-failover.test.mjs`, `provider-call-bound-resume.test.mjs`.

## Questions

1. **Call budgets.** Is every provider call charged exactly once? That includes lane retries, ladder steps, quota probes (which should cost nothing), metered failover, subagent calls and resumed units. Can any path exceed `total_provider_calls`, `stage_provider_calls` or the pipeline's `max_provider_calls`?
2. **Budget stops.** When a limit is reached, does the run stop with a recorded reason and no partial stage left looking complete?
3. **Concurrency.** Can two units in one wave run with overlapping owned paths? Can two scheduler processes claim the same item and stage? What happens under `--concurrency` greater than 1?
4. **Leases.** Is a claim whose lease expired released as `expired`, and does the next tick resume from the last valid stage? Can a stale holder still record a result after its lease was released?
5. **Retries and the lane ladder.** Is a non-quota lane failure retried at most once on the same lane, then stepped down? Does a quota refusal step down immediately? Does an exhausted ladder end `blocked` with every failure recorded? Do lane failures spend no review revision?
6. **Metered failover off.** Is the metered Gemini API never called? Is the resulting block recorded?
7. **Checkpoints.** Is an approved unit's checkpoint written atomically? On resume, is it re-verified by patch digest and resulting tree before being skipped? Can a stale or tampered checkpoint, or one with different upstream trees, be accepted? Is `unit_key` complete?
8. **Process restart.** If the process is killed mid-stage, mid-wave or mid-checkpoint-write, does the next run produce a correct record, with no double charge, no lost finding and no orphaned worktree that later interferes?
9. **Timeouts.** Are verify timeouts, print timeouts and the launcher's `elapsed_ms` enforced where documented? The docs say `elapsed_ms` is checked between stages only; confirm that and whether it matters.
10. **Run record.** Does the launcher's `run.json` re-verify from a fresh process, and does it list every budget stop and blocker?

## Out of scope here

Identity rules (assignment 2) and the security of the jail (assignment 4).
