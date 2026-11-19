# Wave 1 report

Authorized by the owner on 2026-11-19, for Wave 1 only. The frozen candidate `af0dc30` and the sealed self-audits (`audit/round3-self-audit` at `449ca42`) are unchanged. No independent round-3 findings reached this work.

## Execution

| Worker | Branch | Commit | Files | Ownership check |
|---|---|---|---|---|
| Agent 1: lifecycle and recovery | `wave1/lifecycle` | `aa50169` (on `3f08956`) | `ophanim/operate/{gates,reconcile,scheduler,stages,context,work-ledger,cli}.mjs`, two docs, tests | All files owned. `investigate()` untouched. One edit in the contribution region of `stages.mjs` reserved for wave 2 is recorded as L-114. |
| Agent 4: sandbox and reviewer execution | `wave1/sandbox-runner` | `e144e1e` | `pantheon/src/agy/*`, `agy-cli.mjs`, `review-runner/*`, review harness docs, `routing-task-profile.md`, tests | All files owned. Exported signatures unchanged; only optional parameters were added. |
| Agent 5a: CI qualification | `wave1/ci-gates` | `00de3de` | `.github/workflows/qualification.yml`, `ci-summary.mjs`, `scripts/test-gates/**`, the `package.json` scripts block | All files owned. No existing test or implementation code changed. |
| Read-only: L-001/L-002 | none | `docs/execution/l001-l002/` (coordinator) | none | No files written. |

The ownership manifest is `docs/execution/wave-1-ownership.json`. A mechanical check found no file claimed by two workers.

## Acceptance checks (coordinator)

- **Tests detect the original failures.** Agent 1's 20 tests fail on `08ee51a`. Agent 4's 9 new tests fail on `08ee51a`, with the probes showing the leaked secret, the readable home and the reachable network. Agent 5a's checker fails on a real Node 22 proof run (14 cancelled).
- **Mutation checks.** Agent 1's first report claimed 22 of 22 killed, but the log showed one mutation never applied and one never recorded. After the correction, 25 of 25 are recorded and killed, and the runner now exits non-zero when a target doesn't apply. Agent 4: 12 of 12 controls, each removal failing a named test.
- **Sibling paths investigated.** Each worker delivered the six investigation points per finding. New siblings found during the work:
  - Agent 4: the subagent seat runs a card with `run_command`, and the API runner's `run_tests` ran next to the provider key.
  - Agent 1: a byte-identical re-plan was refused for an empty diff.
- **No silent skips or cancellations.** See the integrated results below.
- **Invalidated assumptions in other components.**
  - Agent 4's jail broke two tests outside any Wave 1 owner (`frontier-board`, `quota-failover`): their fake CLIs wrote outside the jail. The coordinator applied the fixture fix at integration (`39a7859`), restoring the environment variable afterwards. What those tests check is unchanged.
  - Agent 4's change removed command execution from the board Antigravity seat (L-407) and test execution from Codex reviewers (L-406). Both are recorded as consequences, not hidden.
- **Real execution boundary.** Agent 4's probes ran under real bwrap with synthetic credentials. Agent 1's tests drive `tick`, `watch` and the service.

## Integrated result

Integration branch `wave1/integration`. The merge order was 5a, then 1, then 4, then the coordinator's fixture fix, the real-bwrap baseline update and this report. Results under Node 24.22.1, with bwrap 0.9.0 working:

| Suite | Tests | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| `test:proof` | 355 | 0 | 0 | 0 |
| model-client | 62 | 0 | 0 | 0 |
| ledger | 47 | 0 | 0 | 0 |
| pantheon | 1404 | 0 | 0 | 0 |
| `test:gates:self` | 19 | 0 | 0 | 0 |
| `test:gates` (run mode, per-file attribution) | all of the above | PASS | | |

- **Real-bwrap baseline.** It now lists 16 suites, after adding Agent 4's three new real-bwrap suites. The gate reports no new or missing suites.
- **Lint (report-only).** It found the 99 earlier findings plus 4 in this wave's new tests. Those 4 were reviewed: three are scripted executors in scheduler-only tests, where the asserted property is not the scripted stage's outcome, and one is a deliberate subset. The 4 are recorded for wave 3 to mark with justified allowlist comments.

## Status by finding (three distinct levels)

| Entry | Status |
|---|---|
| L-101 claim identity wedges replanning | **class covered.** Every entry point, gate route reason and blocked-stage kind is listed. Capacity wakes are mutation-verified through all four stages. Exception: the status-entry wake is tested through plan only (L-106). |
| L-102 ticket stakes erased | **class covered.** Every declared ticket field is kept. |
| L-103 dossier continuation unreachable | **repaired.** The planner path is tested; the other seats share the fixed code. |
| L-104 lesser lifecycle items | **repaired.** Exceptions: change-review citations (L-107, wave 2) and the intake classification (L-108). |
| L-401 unjailed Antigravity single turns | **class covered.** Every agy launch site is listed, jailed with a scrubbed environment, and probed at the process boundary. |
| L-404 reviewed tests near a reviewer CLI's login | **qualified.** Scope: API tests run in the verify jail; Grok tests run through launchers (`--allow` unobserved on a real Grok); Codex runs no tests. |
| L-501 coverage gate | **qualified.** Scope: read detection for Codex and Grok parses command strings; the agy unhooked check is unobserved on a real CLI. |
| L-502 tool drift | **qualified.** Scope: tools are discovered only through zero-spend commands. |
| L-503 CI gates | **qualified.** Scope: cancellations and real-bwrap skips fail CI; the lint is report-only. |
| L-004 trusted Antigravity host access | **retained** as owner-directed, unresolved. Not broadened. |

Passing tests are not architectural acceptance. Each `qualified` entry keeps its scope limits in the register.

## New architectural obligations found

- **Codex reviewers can't run tests (L-406).** A runner-served test tool that runs the verify launcher outside Codex's sandbox is needed before OpenAI reviews can execute tests again.
- **The board Antigravity seat lost command execution (L-407).** `run-item.mjs` must pass a verify launcher. This is wave 2, agent 3.
- **Per-request charging (wave 2, agent 3).** It must charge inside `runAgyCliTurn`, after the jail is built and before the spawn, because an agy turn can now fail before any spend. It must not assume the quota probe ran.
- **L-001 implementation (wave 2, agent 2).** It must give dispatcher findings a lab and model, or Agent 1's labless filter drops them (L-114). It must also bind change-review citations (L-107).
- **Attempt identity.** Wave 2 must build claims through `attemptInputs` and `sameAttempt`, not hand-built inputs.

## Process incidents in this wave

- **Coordinator.** `5f17a50` was pushed with WF4 failing, because the commit command checked `grep`'s exit status rather than the test's. `b58dda7` fixed it, and test exit codes are now checked directly. CI caught the failure.
- **Agent 1.** It reported a mutation count the log didn't support. The coordinator caught it at acceptance and it was corrected. A local commit (`83ae827`) briefly reverted source files after a base-code check. The agent caught it before reporting; it was never pushed.
- **Coordinator.** The first integrated test run was cut off by its time limit before the gate's run mode finished. It was re-run in full with a longer limit.
