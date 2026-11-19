# Wave 2, sub-wave 2b report

Base `58c02d3`, with the ownership manifest at `docs/execution/wave-2-ownership.json` (2b: a single agent, so no file had a concurrent owner). The frozen candidate `af0dc30` and the sealed self-audits (`449ca42`) are unchanged. No independent round-3 findings reached this work.

## Contribution and acceptance checks

| Agent | Branch, commit | Ownership | Regression evidence | Mutations |
|---|---|---|---|---|
| 3b, repo lock and meter | `wave2/repo-lock` `0526d07` | Every changed file is owned. In `stages.mjs` the changes are the meter, `BUDGET_STOP`, the validator's budget-stop label and the implement stage's recovery call. Two call sites outside those regions changed only to pass the meter's `canAsk`: the shared investigation call and the review stop rows. No identity, admission, validator-independence or dispatcher logic changed. In `pipeline/index.mjs` the changes are the lock, worktree recovery, the dead-branch recovery and the charging/admission. One new non-test tool file, `ophanim/operate/reliability-wave2b.mutate.mjs`, is outside the listed globs; it is recorded as a dependency-map note, as for agent 2's runner. | Checked by the coordinator: the five new test files were copied into an unmodified `58c02d3` tree and run there. **14 of 17 tests that loaded fail.** The 3 that pass are guards by design: in-flight reservation, the reviewer `canAsk` stop, and the bwrap precondition. `pipeline-repo-lock` and `pipeline-dead-branch` fail at base on their imports, because the functions are new. The base behaviour they replace is killed by mutations K1 (in-process lock only) and B1–B4. | 33 recorded, 33 killed, on a 129-of-129 green baseline. The runner exits non-zero on a non-applied target, a red baseline or a survivor. Checked by the coordinator in `summary.json`. |

Four existing test files were adapted (`pipeline-ladder`, `pipeline-exec-reliability`, `pipeline-exec-reliability-a3`, `reliability-r2-a3`). Their scripted transports now admit their call where the real transport would. None of their assertions was loosened.

## Integrated result

Integration branch `wave2b/integration`: agent 3b merged onto `5726fa8`, then the real-bwrap baseline update (adding `ophanim/operate/reliability-wave2b.test.mjs`), the register and this report. Results under Node 24.22.1 with bwrap working. Every exit code was read directly.

| Suite | Tests | Fail | Cancelled | Skipped | Exit |
|---|---|---|---|---|---|
| `test:proof` | 384 | 0 | 0 | 0 | 0 |
| model-client / ledger / pantheon | 62 / 47 / 1439 | 0 | 0 | 0 | 0 |
| `test:gates:self` | 19 | 0 | 0 | 0 | 0 |
| `test:gates` (run mode) | all five suites PASS | | | | 0 |

Lint (report-only): the agent reports its file:rule set as identical to `58c02d3`'s; no finding is in a wave-2b test file.

The first integration run failed 25 proof tests and one model-client file. The cause was the worktree setup: dev dependencies were missing, and `OPHANIM_TELOS_ROOT` was not set. The code was not at fault. The table above is the re-run with both fixed.

## Status by entry

| Entry | Status |
|---|---|
| L-303 cross-process repository lock | **Qualified.** The pipeline and lifecycle worktree mutations are under a lock file in the git common directory, tested with real processes. The review runner is outside it (L-126). |
| L-304 dead attempt's integration branch | **Repaired**, per item at its next implement attempt (L-129). |
| L-301 per-request charging | **Class covered.** Every transport and the stage meter charge at the point of spend; turns outside the contract are charged on return (L-128). |
| L-308 budget stops by code | **Repaired.** The planner's own investigation is a sibling left open (L-131). |
| L-121 CLI and service stop | **Repaired.** A hard-stopped `serve` leaves its lock file (L-132). |
| L-305 interrupted live run | **Repaired** for the live run, the service and the CLI. |

## New caveats

L-126 to L-132 in the register:
- **L-126:** the review runner has no repository lock.
- **L-127:** a residual race in the stale-lock breaker.
- **L-128:** late charges for turns outside the contract.
- **L-129:** branch cleanup only happens per item.
- **L-130:** `update-ref` runs outside the lock.
- **L-131:** a planner budget stop has no blocker.
- **L-132:** a stale `service.lock` after a hard stop.

## Interfaces for wave 3

- **Lock:** `repoMutex` lives in `pipeline/git.mjs` and is re-exported from `index.mjs`. `bindWorktree` and `releaseWorktree` take the lock by default. While the lock is held, `.git/pantheon-worktrees.lock` exists.
- **Charging:** stage-meter and `runPipeline` turns receive `admitRequest`. A scripted transport that skips it is charged on return. `m.left()` subtracts reservations.
- **New record shapes:**
  - the validate stage can return a pending `STAGE_PROVIDER_CALLS`;
  - `recovered_branches`;
  - `provider_calls.late_uncharged`.
- **New options:**
  - cli `main` takes `proc`, `exit` and `graceMs`;
  - `runService` takes `onProgress`;
  - `launcherStop` is exported.

## Wave 2 complete

Sub-waves 2a (`58c02d3`) and 2b are integrated. Wave 3 (class-level tests against the integrated implementation, lint review and enforcement, L-504) has not started and waits for owner authorization.
