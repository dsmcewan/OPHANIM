# Wave 2, sub-wave 2a report

Base `bce84eb`, with the ownership manifest at `docs/execution/wave-2-ownership.json`. The frozen candidate `af0dc30` and the sealed self-audits (`449ca42`) are unchanged. No independent round-3 findings reached this work.

## Contributions and acceptance checks

| Agent | Branch, commit | Ownership | Regression evidence | Mutations |
|---|---|---|---|---|
| 2, identity | `wave2/identity` `9198ef4` | All files owned. `pipeline/index.mjs` edits stay in the lineage and Stage 5 regions (adding `stage5_excluded`); none touch worktree, lock or charging code. One new non-test tool file, `ophanim/operate/wave2-identity.mutate.mjs`, is outside the listed globs; it is recorded as a dependency-map note. | 17 tests fail with the `bce84eb` sources restored. Three pass there by design: they only kill mutations of code that was already correct. | 22 recorded, each failing at least one test, on a 106-of-106 green baseline. Runner exits non-zero on a target that doesn't apply exactly once or on a survivor. Checked by the coordinator in `summary.json`. |
| 3a, reliability | `wave2/reliability` `72303b2` | All files owned. Neither `stages.mjs` nor `pipeline/index.mjs` was touched; the needed change there is saved as `docs/execution/wave-2b-needed.patch`. | Pantheon: 11 of 11 fail on `bce84eb`. Ophanim: 7 fail and 1 is cancelled, timing out because the base has no interrupt. All 4 self-audit reproductions now fail. | 25 recorded, 25 killed (checked by the coordinator in `mutations.json`). |

The two agents changed no file in common.

## Integrated result

Integration branch `wave2a/integration`. Agent 2 was merged first, then Agent 3a, then the real-bwrap baseline update (adding Agent 3a's two new suites, with no remaining drift), the register and this report. Results under Node 24.22.1 with bwrap working. Every exit code was read directly.

| Suite | Tests | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| `test:proof` | 371 | 0 | 0 | 0 |
| model-client / ledger / pantheon | 62 / 47 / 1425 | 0 | 0 | 0 |
| `test:gates:self` | 19 | 0 | 0 | 0 |
| `test:gates` (run mode) | all five suites | PASS | | |

Lint (report-only): 105 findings, none in wave-2 test files.

## Status by entry

| Entry | Status |
|---|---|
| L-001 (owner decision A + B) | **Repaired.** No dispatcher text reaches any prompt, record or dossier view. The dispatcher's requested and served models are a contributor to the revised plan. |
| L-002 (owner decision) | **Repaired under the model rule. Qualified under the lab rule**: only the corrections apply there. |
| L-201 every retrieval round admitted | **Class covered.** |
| L-202 planner rounds as contributors | **Repaired.** |
| L-203 served-model marker kept | **Class covered.** |
| L-204 ledger enforcement | **Qualified.** Unpinned CLI callers remain (L-117). |
| L-205 mutation survivors | **Repaired.** M1 to M10 are all killed. |
| L-107 change-review citations | **Qualified.** They are bound to versions but not re-checked on reuse (L-115). |
| L-114 labless filter | **Repaired.** |
| L-301 per-request charging | **Qualified.** The stage meter and pipeline admission await the 2b patch. |
| L-302 zero-call exception | **Repaired.** |
| L-305 interrupted live run | **Repaired for the live run.** The service and CLI don't wire it yet (L-121). |
| L-306 stop signal on the board's agy paths | **Class covered.** |
| L-307 acceptance before verification | **Repaired.** |
| L-308 budget-stop classification | **Qualified.** The validator label awaits the 2b patch. |
| L-407 board seat command execution | **Repaired.** |
| L-410 SDK seat environment | **Repaired.** |

## Capacity effect of the owner decisions (recomputed on the integrated selector)

*These figures are as of wave 2a, on the routing tables of the brief's base `5a40b3c`. #68 changed those tables; the figures for current `main` are in "Re-check on `main`" below.*

- **Validator, clean path (84 combinations, 78 with a panel).** Before, the validator was one of the change reviewers in 78 of 78. Now it never is. It comes from a fourth lab in 60, and is pending in 0.
- **With earlier finders `grok-4.7` and `sonnet`:** the validator is pending in 4 of 78.
- **L-001 on the revised plan panel.** Its OpenAI seat moves to a shared-lab Anthropic seat. It still has three labs.
- **L-001 on the change panel.** 30 of 324 combinations change, and 24 become REVIEW_CAPACITY_PENDING.
- **Combined.** Without L-001, the fourth-lab preference would have made the returning dispatcher the validator in 90 of 324 cases. L-001 removes all 90.

## Re-check on `main` (2026-11-21, `ba3f038`)

The brief's scripts (`docs/execution/l001-l002/`) were re-run on `main`, after first reproducing every figure above at `5a40b3c`. The review pool is unchanged. The routing tables are not: since #68 the subagents are `gemini-4-hydrogen` at every difficulty (they were Grok models) and the medium implementer is `gemini-4-neon`. With no Grok contributor, `grok-4.7` is seated on every change panel.

| Measure | Brief's tables (`5a40b3c`) | `main` (`ba3f038`) |
|---|---|---|
| Combinations that form a change panel | 78 of 84 | 84 of 84 |
| Validator was one of the change reviewers (the old rule) | 78 of 78 | 84 of 84 |
| Validator from a fourth lab (the implemented rule) | 60 | 72 |
| Validator takes a same-lab sibling | 18 | 12 |
| Validator pending, no earlier finders | 0 | 0 |
| Validator pending, earlier finders `grok-4.7` and `sonnet` | 4 of 78 | 8 of 84 |
| Validator pending, each of the other five finder sets tried | 0 | 0 |
| L-001: change-panel combinations that change | 30 of 324 | 0 of 324 |
| L-001: of those, `REVIEW_CAPACITY_PENDING` | 24 | 0 |
| Returning dispatcher is the validator, without L-001 | 90 of 324 | 120 of 324 |
| Returning dispatcher is the validator, with L-001 | 0 of 324 | 0 of 324 |
| Dispatcher `notes` reaching the planner prompt (`notes-probe.mjs`) | 50,199 characters | 109 characters |

What still holds: the revised plan's panel still moves its OpenAI seat to an Anthropic seat of the planner's lab once the dispatcher is a contributor, and L-001 still removes every case in which the returning dispatcher would be the validator. Without the fourth-lab preference the validator would be `grok-4.6`, a sibling of the seated `grok-4.7`, in all 84 combinations, so the preference matters more than it did.

**Method and limits.** Same constructed grid as the brief, not observed traffic. The validator is modelled through `reviewSeatsByModel` with the excluded set the validate stage uses (contributors plus the passing cycle's reviewers), and the fourth-lab preference as "the first eligible model of a lab outside the panel". At `5a40b3c` this reproduces 60 of 78 and 90 of 324 exactly. The validate stage itself (`ophanim/operate/stages.mjs`) was not called. `compute.mjs`, `l001.mjs`, `l002stress.mjs` and `notes-probe.mjs` regenerate every row except the two "returning dispatcher is the validator" rows, which `combined.mjs` in the same directory produces. `compute.mjs` writes `scenarios.json` into the current directory, so run it from a scratch directory.

## New caveats

L-115 to L-125 in the register. The main ones:
- **L-115:** citation re-check on reuse, in `gates.mjs`.
- **L-117:** unpinned lab-rule cycles from the CLI and `practice/compare`.
- **L-120:** the board in-run checker under the lab rule.
- **L-121:** the service and CLI don't pass `interrupt`.
- **L-123:** the reviewer's verify run can write the worktree.

## Next

Sub-wave 2b (L-303, L-304, and the saved patch finishing L-301 and L-308). It starts on this integrated commit. One agent owns the worktree, lock, recovery and charging regions of `pipeline/index.mjs`, plus `git.mjs`. It also owns the meter and `BUDGET_STOP` regions of `stages.mjs`, now that agent 2's work is merged.
