# Completion assessment and the review-capacity decision

Branch `ccr-aa24f0d5-336szn`, PR #67, still a draft. This assesses the work against the original orchestration requirements (owner, 2026-11-17).

Each requirement is rated in four columns:

- **Impl.** (implemented): the code exists on the branch.
- **Synthetic**: exercised end to end with scripted providers only, in a named test or demonstration.
- **Operational**: running on the real backlog through the real trigger.
- **Blocked**: cannot happen yet, with the reason.

| Mark | Meaning |
|---|---|
| ✔ | yes |
| ◐ | partly; the cell says how |
| ✘ | no |
| — | does not apply |

No row is operational yet; the reasons are under "Operational status" below.

## Requirements

### Lifecycle

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **Plan.** Evidence, problem, a substantive plan, three-lab review, revision. | ✔ `stages.mjs` plan | ✔ `stages.test` 1-3, 5 | ✘ | Review capacity (below), for every model-planned item |
| **Implement.** Code, in-run checks, review, revision. | ✔ implement + review | ✔ | ✘ | Review capacity (below) |
| **Validate.** Tests against the original requirement. A defect returns to implement; a bad assumption or criterion returns to plan. Green CI alone never passes. | ✔ | ✔ `stages.test` 5 | ✘ | Review capacity: the change review comes first |
| **A material plan change returns to planning.** | ◐ Changed ticket, requirement or evidence bytes make the plan stale. Validation's `plan_defect` returns to plan. | ✔ | ✘ | — |

The plan-change row is only partly met. There is no separate detector for an implementation that silently goes beyond the plan's scope. Only the acceptance criteria judge that.

### One work identity

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **Ledger authoritative.** Issues, tickets, runs and work records joined per item; counts read, never assumed. | ✔ `reconcile.mjs` | ✔ | ◐ Read-only on the real ledger (`BACKLOG.md`: 58 items) | — |
| **Unlinked issues are intake candidates.** Never executed. | ✔ | ✔ (and `SERVICE-DEMO` #103) | ◐ #3 recorded in the real-backlog demo | — |
| **Earliest unmet gate.** An issue without a ticket goes to plan/author; an existing ticket goes to plan/revalidate. A missing stage, an evidence gap, a block, or a wait on the owner is each its own gate. | ✔ `gates.mjs` | ✔ | ◐ Computed on the real backlog; dispatched there only by the recording executors (`DISPATCH.md`) | — |
| **Valid evidence reused; stale evidence re-evaluated.** | ✔ | ✔ `scheduler.test` | ✘ | — |
| **A Resolved label must have completion evidence.** Gaps are recorded; transitions follow existing authority. | ✔ The evidence gap, plus **automatic evidence recovery** (new) | ✔ `evidence-recovery.test`: recovered, applied, not found, tampered, repaired, stale requirement | ◐ 36 real items searched here: all `not-found` | The owner's retained board runs are not in the repository or this container. The service searches them where `bundles` is configured. |

### Teams and handoffs

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **Teams assembled by capability**, within dependencies and limits. | ✔ The selector seats each role; dependency order; limits | ✔ | ✘ | — |
| **The plan handoff names every required field.** Requirement, evidence, problem, scope, exclusions, dependencies, capabilities, acceptance criteria with tests, slices, limits, stopping conditions, recovery, rollback, unresolved findings, approved version. | ✔ `planRefusal` refuses a plan missing any of them | ✔ | ✘ | — |
| **Every handoff carries identity, input and output digests, lineage, findings, usage and the next team, and the receiver verifies it.** | ✔ The work ledger re-derives it; `verifyHandoff` checks it | ✔ A forged handoff is refused | ✘ | — |

### Dispatch and ownership

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **A real trigger and scheduler.** No manual ticket selection. | ✔ `tick`, `watch`; **`serve` (new execution service)**; CI `operate.yml` | ✔ `service.test`, `SERVICE-DEMO` | ✘ | `operate.yml` runs only from `main` (the PR is not merged). The service runs where the provider and controller keys are, so the owner installs it. |
| **Ownership visible publicly.** Team, seats, stage, attempt, lease, budget, blocker, evidence. | ✔ `ophanim/public/work.mjs` | ✔ projection tests | ✘ | Published only once `operate.yml` runs on `main` |
| **No duplicate claims; bounded resume; external waits keep state and wake on change.** | ✔ Ledger-level claim refusal; lease expiry and resume; transient waits retried, structural ones wait for a change | ✔ | ✘ | — |

### Governing requirements

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **Three independent labs** at dispatch, closure and verification; cannot be lowered by an argument. | ✔ | ✔ Defect 2 regression tests; `REVIEW_FLOOR` | ✘ | — |
| **Independence from actual contributions.** Plans, revisions and critiques that reached the bytes all count. | ✔ | ✔ Defect 3; a plan-review finder counts | ✘ | — |
| **No reserved labs; use the existing four; a short panel is pending, never verified.** | ✔ The planner's co-seating was removed | ✔ `stages.test` 1 | ✘ | This is the conflict below |
| **TELOS, signing and historical verification preserved; missing keys give a recorded block.** | ✔ Status signing untouched; `NO_AUTHORITY` (exit 3) | ✔ `test:proof` 228/0 with the pinned TELOS | ✘ | — |
| **Bounds declared before dispatch, counting failures and resumes; unknown cost stays unknown.** | ✔ Per tick; the service's cap covers the ledger's lifetime | ✔ | ✘ | — |
| **No automatic adoption of unqualified policy; synthetic and same-provider runs are not qualification.** | ✔ Nothing adopts routing policy; synthetic results are labelled | — | — | — |

### Known failures from the review of 86ce18a

| Failure | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| 1. A proposal could be replayed onto an unrelated item. | ✔ fixed | ✔ regression test fails on the old code | — | — |
| 2. An n = 1 run could close verified. | ✔ fixed | ✔ regression test fails on the old code | — | — |
| 3. Reviewer-authored content was missing from the contribution scope. | ✔ fixed | ✔ regression test fails on the old code | — | — |
| 4. Twenty copies of one bundle counted as twenty observations. | ✔ fixed | ✔ regression test fails on the old code | — | — |

### Completion evidence and delivery

| Requirement | Impl. | Synthetic | Operational | Blocked |
|---|---|---|---|---|
| **A published Ready item without a ticket goes through the full lifecycle to an outcome.** | ✔ | ✔ `SERVICE-DEMO` run B | ✘ | Under the configured four labs it stops at implementation (`SERVICE-DEMO` run A) |
| **An existing ticket enters the same lifecycle.** | ✔ | ✔ `SERVICE-DEMO` A and B | ✘ | Same capacity block |
| **Live demonstration.** | — | — | ✘ | Provider keys and the controller key are on the owner's machine. The four-lab capacity would also stop it at implementation. |
| **Reviewable branch, not merged.** | ✔ | — | — | — |

## Defects found while preparing this

Three of these were in the lifecycle's own outcome, and none had been caught before. The first two came to light because the evidence-recovery tests re-check proposals the way `apply` does.

1. **The review stage opened its cycle in an `operate/…` scope.** The status ledger's `apply` accepts only `board/<item>/<base>`, so it refused every lifecycle proposal. Fixed.
2. **The outcome bundle did not name the ticket file**, so `apply` could not re-check the ticket. Fixed.
3. **The test only checked the proposal's fields.** The full-lifecycle test now applies the proposal as the owner and reaches `complete`; on the old code it fails.

Recorded in `ophanim/lessons/corrections.json` as `output-checked-not-consumed`.

Earlier in the same branch:

- a structural plan wait was re-dispatched within a single tick;
- the CLI could not seat the real executors;
- a delegated change placed the planner in the implementer's lab. Removed.

## The review-capacity conflict: needs the owner's decision

### The facts, read from the configuration and the selector

- **Labs:** anthropic, google, openai and xai.
- **Seats** (argo profile): the planner is in the anthropic lab and the implementer in the openai lab.
- **Coordinated cycle review:** three reviewers, each from a lab that contributed nothing to the change. The contributors are:
  - the plan the work consumed;
  - the work itself;
  - every critique whose findings reached a revision, including plan-review findings that revised the plan.

  Nothing may be narrowed, reserved or forced to make the numbers work.

### The arithmetic

The review needs 3 labs left over, and there are 4. So **at most one lab may contribute to any change.**

A substantive model-written plan, required for every item, is one contribution. The implementation is another. Because the selector puts them in different labs, every item has at least two contributing labs, leaving only xai and google.

**Under the current rules, no item can complete the lifecycle.** Every item stops at implementation as `REVIEW_CAPACITY_PENDING`, with its reviewed plan and ticket kept. `SERVICE-DEMO` run A shows this, and so does `stages.test` 1.

The same holds even if one lab wrote both plan and code. Any outside critique that reaches a revision (a plan-review finding or an in-run review finding) adds a second lab and stops the item again. Single-lab authorship would therefore complete only work that passes every review without findings on its first attempt.

### Options

No option both completes items and leaves every stated requirement unchanged. Each one changes something only the owner can change.

| Option | Changes | Keeps | Effect | Conflicts with |
|---|---|---|---|---|
| **A. Status quo** | nothing | every requirement | No item ever completes. All work stays pending at implementation, kept for later. | — (it is the current state) |
| **B. One lab authors each item** (plan, code and revisions), as a policy decision | Worker and planner choice: the planner must come from the implementer's lab, or the reverse | three-lab panel; full contribution scope | Only work clean on the first pass completes. Any outside finding that reaches a revision pends. The planner's quality is limited to that lab. | Your direction of 2026-11-17 (no forcing planner and implementer onto one lab); condition 4 (ordinary worker selection must not inherit orchestration constraints) |
| **C. A fifth qualified reviewer lab** | the provider pool | everything else | With 5 labs, two contributing labs are fine (planner plus implementer). A third contributor (any critique reaching a revision) still pends. | You declined a fifth lab on 2026-11-17 |
| **D. Narrow the change-review scope**: a plan already reviewed by three labs is not a contribution to the change | independence scope | three-lab panel | Planner plus implementer leaves 3 labs; items complete unless a critique reaches a revision | "do not drop the planner's contribution or weaken review scope"; the RS2 contribution rule |
| **E. A two-lab change panel for lifecycle items** | panel size | contribution scope | Planner plus implementer leaves 2 labs, enough for 2 | "three independent labs … a caller cannot lower it" |
| **F. Plan without a model**: a deterministic plan from the ticket, with no planner lab | the plan requirement | panel and scope | Only the implementer contributes; 3 labs remain | "A one-line title is not a plan"; the plan must be substantive and model-reviewed |

A critique that reaches a revision adds a contributor under every option. So under A through F, revisions after findings still consume reviewer capacity. That is how the independence rule is written, and nothing here changes it.

### What the branch does today

Option A. Nothing has been weakened or moved, and no lab or pool has changed. The capacity report (`pantheon-board.mjs capacity`, `FOUR_LABS.md`) will measure, on live runs, how often each pending cause happens. That gives the data for choosing among B through E, if you want it before deciding.

## Operational status

**Operational: nothing yet.** Everything above is implemented and tested with scripted providers. Becoming operational needs your actions:

1. **Merge the PR**, your decision. `operate.yml` then reconciles and publishes the public record from `main`, on issue events and hourly.
2. **Install the service** on your machine (`docs/operate-service.md`):
   - a config with a declared provider-call cap;
   - the controller key, created by `cli.mjs tick --init`, or provisioned;
   - provider keys in the environment;
   - `bundles` pointed at the retained board runs, so evidence recovery can search them.
3. **Decide the capacity question.** Until you do, the service will plan items and record them as pending at implementation. It will also write recovery proposals for any Resolved item whose retained run still verifies.
