# Open limitations register

This register records every known limitation, residual exposure, deferred defect and unverified assumption. It exists because the retrospective (`docs/reviews/2026-11-18-independent-review/findings-retrospective/`, failure mode 3) found caveats being dropped, narrowed or under-reported between a fix report and the record.

## Rules

1. **Every caveat gets a disposition.** Each "not fixed", "assumed", "limit" or "left open" line in a fix report, a self-audit, a review or a commit message gets an entry here. The coordinator may not merge the fix branch until each of those lines has an entry.
2. **An entry has six parts:**
   - the item;
   - its source;
   - its consequence, meaning what can go wrong and for whom;
   - every route by which it can be reached;
   - its status;
   - the owner's decision.
3. **Status values:**
   - `open`: no work is assigned.
   - `planned (wave N)`: assigned to a wave that has not started. This is not work in progress.
   - `active (branch)`: a worker is running on that branch now.
   - `repaired (commit)`: the specific reproduction is fixed, and a regression test fails on the pre-fix commit. This says nothing about the rest of the defect class.
   - `class covered (commit)`: every sibling path sharing the mechanism has been listed, and each one is fixed and tested or ruled out with evidence.
   - `qualified (commit)`: the architectural invariant holds within a stated scope, shown at the real execution boundary.
   - `accepted by owner`: the decision is quoted with its date.
   - `pending owner`: the owner must decide; until then it counts as open.
   - `retained (owner-directed)`: the owner directed that the exposure be kept, explicitly unresolved.

   An entry at `class covered` or `qualified` stays in the register for one round, then moves to "Closed" at the end of this file.
4. **No completion while open.** Nothing may be called complete, done or fixed while a related entry is `open`, `planned`, `active`, `repaired` or `pending owner`. A passing regression alone is `repaired`, never `class covered`.
5. **No silent narrowing.** A reviewer's blocker condition is the acceptance test. Narrowing it needs an owner decision recorded here.
6. **Claims at the enforcing layer.** A claim names the layer that enforces it.

Sources are cited as follows:
- self-audit seals: branch `audit/round3-self-audit`. Assignment 1 is `323361a`, 2 is `449ca42`, 3 is `bb1287a`, 4 is `fe2a612`.
- reviews: `findings-*` folders.
- commits: SHA.

## Pending owner decision

Owner constraints (2026-11-19, wave 1 authorization):
- **L-001.** Treat dispatcher text that materially shapes a revised plan as potential contribution lineage. Investigate the exact influence and present any policy decision needed. Do not silently exclude it.
- **L-002.** Reusing an approving reviewer as validator must not be presented as additional independent verification. Establish the independence and capacity implications before asking for a final decision.
- **L-003.** Keep the no-network verify boundary. Dependencies must be provisioned through an explicitly controlled process, not an unexamined network exception.
- **L-004.** Keep the current restrictions and explicitly retain the unresolved exposure of trusted Antigravity's host access. Do not broaden access or claim the boundary is resolved.

L-001 and L-002 were investigated read-only in wave 1. The brief is in `docs/execution/l001-l002/`.

### Owner decisions, 2026-11-19 (from the L-001 and L-002 brief in `docs/execution/l001-l002/`)

- **L-001: A + B.**
  - Preserve requested and served model identities, and complete contribution lineage. The returning dispatcher is recorded as a contributor to the revised plan.
  - Treat structured dispatcher feedback as untrusted advisory data. Validate its schema and allowed operations, and require the planner to independently justify any revision.
  - Do not weaken the three-lab floor or the independence requirements to avoid capacity-pending results.
  - Record shared-lab participation explicitly.
  - Follow-up: a returning dispatcher that also dispatches the revised unit keeps Decision 6's pinned Stage 5 review of its own unit only.
- **L-002.** The validator must be independent of the approving reviewer models, preferably from a lab outside the review panel.
  - Preserve the three-lab review floor. Do not manufacture independence or capacity.
  - Record the actual reviewer and validator identities, the shared labs, and the precise scope of independence.
  - If no eligible validator is available, keep a pending capacity condition rather than reuse an excluded reviewer.
  - Scope: exclude every requested and served model that approved the passing change-review cycle, plus any model whose earlier findings, recommendations or revisions materially contributed to the accepted candidate. Derive the exclusions from actual review and contribution records, not from cycle membership alone. Do not automatically exclude reviewers of unrelated earlier cycles merely because they took part. Prefer a fourth-lab validator. Record the validator's independence scope and any shared-lab participation.

| ID | Item | Source | Consequence | Routes | Status |
|---|---|---|---|---|---|
| L-001 | The dispatcher's "not cohesive" `notes` reach the planner's revision prompt, but the dispatcher is not recorded as a contributor. A finding with no lab excludes nobody. | Self-audit A2, D-B | If the revised units change difficulty, the dispatcher model (for example `gpt-6-astra`) stays eligible for the revised plan's panel, the change panel and the validator. That is a route by which a rubric author judges work its text shaped, and Decision 6 doesn't cover it. | `dispatch.mjs` ~117 → `stages.mjs` ~1188 | accepted by owner, 2026-11-19 (A + B; see above). Implementation planned for wave 2, agent 2. |
| L-002 | `docs/review-independence.md:140-142` says the validator excludes the change reviewers. The code does not, and the validator is one of the three approving change reviewers. | Self-audit A2, D-A | The doc's capacity argument rests on a false premise. Either the code excludes the change reviewers from validation, which costs capacity, or the doc is corrected. | validator seat selection in `stages.mjs` | accepted by owner, 2026-11-19 (exclude the approving and contributing models; prefer a fourth lab; capacity pending, never reuse). Implementation planned for wave 2, agent 2. |
| L-003 | A verify run has no network, so a `verify_cmd` that needs a package registry always fails. | Credential isolation (b411b67); doc "Remaining exposure" 3 | A unit whose verification needs dependencies blocks unless they are in the worktree or the toolchain before the turn. This was deliberate and never put to the owner. | every verify-jail path | pending owner. Owner-directed for now: keep no network. Open requirement: a controlled process for provisioning dependencies. |
| L-004 | Antigravity's own egress is unrestricted, and agy (trusted) reads the whole host read-only. | Doc "Credential isolation"; self-audit A4 Q5 and Q8 | A compromised or misbehaving agy CLI could read same-user host files and send them anywhere. Untrusted code is in the verify jail, but agy itself is not confined. | agy worker jail (`sandbox.mjs`) | retained (owner-directed 2026-11-19: keep current restrictions; exposure unresolved) |

## Open, planned or active

### Lifecycle and evidence: self-audit A1 (sealed `323361a`)

| ID | Item | Consequence | Status |
|---|---|---|---|
| L-101 | The claim key leaves out evidence, ticket, dependencies, status and capacity. A gate that correctly routes back to `plan` is refused as "already completed", and the item is skipped silently, forever. | Stale plans are never re-planned. A plan can stale itself through its own ticket write. Blocks on capacity, and outcomes after a new status entry, never resume. The item vanishes from `watch`/`serve` without being reported as blocked. | class covered (aa50169), except: the status-entry wake is tested through plan only (L-106) |
| L-102 | `ticketOf()` drops stakes, ambiguity and depth when the ticket is re-derived. | A critical item's next planner is seated easy, and the stakes-driven number of review labs drops. | class covered (3f08956) |
| L-103 | A cut dossier view names a continuation that no stage's retriever can serve. | The seat can never fetch the rest, so evidence stays partial. | repaired (3f08956): the planner path is tested; the other seats share `evidenceFor` |
| L-104 | Lesser items: a resumed fit plan approved without `work_units`; the `stable` digest moving on work-ledger-only changes; validator and reviewer citations not bound to versions; the work-ledger header claiming a check the code doesn't do; `awaiting-owner` outcomes not re-checked on reuse; intake classification frozen at first sight. | Spurious re-plans, unbound evidence, and a doc that overclaims. | repaired (3f08956), except change reviewers' citations (L-107) and the intake classification (L-108) |
| L-106 | The status-entry wake is tested only through `plan`. The other stages share the code. | A regression on another stage's status wake would go unnoticed. | open (wave 3 class-level tests) |
| L-107 | Change reviewers' `[source: …]` citations are free text, not bound to versions. | A change review's evidence can't be re-checked on reuse. Fixing it needs structured citations in the review brief and turn construction. | planned (wave 2, agent 2: dependency-map change) |
| L-108 | The intake classification is frozen at first sight. Its only reader is the scheduler's dedup set, so nothing routes on it. | The record can be inaccurate; dispatch is not affected. A fix needs a new work-ledger entry kind. | open |
| L-109 | Structural blocks recorded before attempt identity v2 carry no status entry, so a new owner entry doesn't wake them. Old capacity blocks are re-asked once, which makes no provider call. | Old non-capacity blocks need a changed requirement, or a manual release, to resume. | open |
| L-110 | A transient retry of a plan revision falls back to the newest passed plan, because `revises` is not carried through pending records. | A retried revision can revise the wrong base. | open |
| L-111 | A plan citing `index:<head>` goes stale on every commit. That is now one re-plan per HEAD rather than a wedge. | Spend on re-plans for plans that cite the index. | open |
| L-112 | Only the default `<work root>/../operate` state dir is excluded from the dossier. A custom `stateDir` inside an un-ignored repository can still let a plan stale itself. It is bounded by `iterations` and the budget, and shows as a collision. | Spurious re-plans under a custom state dir. | open |
| L-113 | Status views without executors (`status`, live-run's `gateOf`) show capacity blocks as plain blocked. `stage_attempts` is applied only in `tick`. | The status display is less precise than dispatch. | open |
| L-114 | Agent 1 edited `stages.mjs`'s contribution region, reserved for wave 2: it now filters labless plan-review findings out of contributions. | When wave 2 implements L-001, dispatcher findings must carry their lab and model, or this filter drops them too. | open (dependency note for wave 2, agent 2) |

### Review independence: self-audit A2 (sealed `449ca42`)

| ID | Item | Consequence | Status |
|---|---|---|---|
| L-201 | `investigate()` admits only the last retrieval round. Earlier rounds' served models are not checked, yet their request text shapes the prompt being judged. | A contributing or unnamed model can shape a plan, change or validator judgment unseen. | planned (wave 2, agent 2) |
| L-202 | A planner retrieval round served by another model is not recorded as a plan contributor. | That model can sit on the same plan's review panel. Reproduced with `grok-4.7`. | planned (wave 2, agent 2) |
| L-203 | The validator record drops `served_model_source`. | An Antigravity validator is recorded as if the provider had named it. | planned (wave 2, agent 2) |
| L-204 | Under the lab rule, lab comes from route or vendor; the three-lab floor is enforced only at the recorder; the ledger accepts any `served_model_source`. | These are ledger-level holes on the lab-rule paths. They are not live today, but the ledger does not enforce what the docs claim. | planned (wave 2, agent 2) |
| L-205 | Five identity mutations go undetected by the suites (M1, M2, M5, M9, M10). The fixture always sets served = requested. | Regressions in requested and served identity handling would ship green. | planned (wave 2, agent 2) |

### Execution reliability: self-audit A3 (sealed `bb1287a`)

| ID | Item | Consequence | Status |
|---|---|---|---|
| L-301 | `runOpenItem` counts multi-request turns once, because `sdkTurn` has no `onRequest`. | Billed requests can exceed `total_provider_calls` on the argo/legacy path. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-302 | A zero-call exception is charged the whole stage budget. | False budget stops. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-303 | There is no cross-process repository lock; `repoMutex` works within one process only. | Two processes doing worktree add or prune on one repository collide, so the service and `operate tick` can't share a checkout. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-304 | A killed lifecycle attempt's integration branch is never deleted. The earlier regression test covered a path the lifecycle never takes. | Branch refs accumulate. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-305 | An interrupted live run can't resume until its whole elapsed lease passes, and the record doesn't say why. | A restart appears to hang. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-306 | `runOpenItem`'s Antigravity lane turn ignores the stop signal. Commit `5f26e17` claimed every turn carries it. | The agy process runs up to 915 s after a stop. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-307 | `run.json` records `acceptance.met: true` before verification. | A launcher killed during verification leaves a record that looks accepted. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |
| L-308 | Budget stops are classified by regex, and a validator out of budget is labelled a validation defect. `routing-task-profile.md` ~416-428 and `operate-service.md:30` contradict the code. | The run record and the docs mislead. | planned (wave 2, agent 3; sequential with agent 2 on stages.mjs) |

### Sandbox and credentials: self-audit A4 (sealed `fe2a612`) and the documented remaining exposure

| ID | Item | Consequence | Routes | Status |
|---|---|---|---|---|
| L-401 | Subagent and planner single turns over Antigravity (`agy-turn.mjs` → `runAgyCliTurn`) run the real CLI unjailed, with the full environment (OpenAI, Anthropic and xAI keys) and `--sandbox`, on partly worker-controlled question text. It was missing from the documented remaining-exposure list. | Provider keys sit in a process driven by worker-influenced text. Containment rests only on the subagent card having no tools. | `sdk/agy-turn.mjs`, `board/agy-cli.mjs` `runAgyCliTurn` | class covered (e144e1e): every agy launch site enumerated; jailed with a scrubbed env at the real process boundary |
| L-402 | Antigravity's own helper processes, other than `run_command`, run in agy's credential-bearing jail. | An undocumented tool that runs worker-chosen content would bypass the verify jail. | agy MCP servers, `bin/agentapi` | open (needs a live `/proc` sidecar probe on the owner's machine) |
| L-403 | The allowlist exposes `/usr` whole, the certificate stores, the main repository's objects and refs, and `extra_ro`. | A site secret under `/usr/local/etc` would be readable by verify code. | verify jail | open |
| L-404 | The review runner's Codex and Grok transports run reviewed tests in their own CLI sandbox, near the CLI's login state. | Reviewed code could reach a reviewer CLI's login. | `review-runner/sandbox.mjs`, `cli-common.mjs` | qualified (e144e1e). Scope: API tests run in the verify jail; Grok runs tests through launchers with `--allow`, unobserved on a real Grok (L-408); Codex runs no tests (L-406) |
| L-405 | If the CLI itself closes the hook wrapper's stdout, the empty output means allow. | A fail-open edge in the hook protocol, outside the module's control. | agy hook protocol | open (protocol-inherent; untestable from the module) |
| L-406 | Codex can't run the verify launchers (its sandbox refuses nested namespaces), so Codex reviewers now run no tests. Every Codex review of an assignment that allows tests is `incomplete`. | OpenAI reviews can't execute tests. A runner-served test tool, for example over MCP, running the verify launcher outside Codex's sandbox, would fix it. | open |
| L-407 | The board Antigravity seat (reviewer, scout) can no longer run commands, so it can't run the acceptance command. | The board/argo review path loses its command execution. A fix needs `run-item.mjs` to pass a verify launcher. | planned (wave 2, agent 3) |
| L-408 | Grok's `--allow` is documented by xAI but unobserved on a real Grok, and its `*` matching is undocumented, so `Bash(find *)` or `Bash(sed -n *)` may admit `-exec` or sed's `e` command. | A Grok reviewer might be unable to run tests, or a read-only allowance might admit execution. The jail still contains it. | open |
| L-409 | The agy `unhooked` check fails closed. If a real agy reports denied steps as DONE, runs will be marked `incomplete`. | Possible false incompletes. | open |
| L-410 | The python SDK seat (`PANTHEON_AGY_TRANSPORT=sdk`, in `run-item.mjs`) gets the whole `process.env`. Owner diagnostic scripts (`agy-layout-bisect`, the `--version` probes) are unjailed. | Provider keys are present in a non-default seat process. | planned (wave 2, agent 3, for run-item; diagnostics recorded) |

### Review process (retrospective)

| ID | Item | Consequence | Status |
|---|---|---|---|
| L-501 | The runner reports `complete` when no source was read or reads were denied. | Unusable reviews are counted as reviews; this happened twice. | qualified (e144e1e). Scope: read detection for Codex and Grok parses command strings; the agy unhooked-step check is count-based and unobserved on a real CLI (L-409) |
| L-502 | There is no tool-drift preflight comparing CLI-advertised tools with the hook's allowlist. | A new tool name causes denied reads in production (`write_file` in 1.5.10, `read_file` in 1.5.11). | qualified (e144e1e). Scope: tools are discovered only through zero-spend commands (card, `agy agents`, registry log lines); agy documents no tool-listing command |
| L-503 | CI does not fail on cancelled tests, or on skipped real-bwrap tests, and there is no test lint. | Tests that cannot fail ship green. | qualified (00de3de). Scope: cancelled > 0 and real-bwrap skipped > 0 fail CI; the lint is report-only (99 findings to review in wave 3); see L-505 and L-506 |
| L-504 | Class-level tests are missing for the four invariants with the most repeat findings. | Sibling paths stay open after fixes. | planned (wave 3, against the integrated implementation) |
| L-505 | Under Node 24, a test whose promise never resolves hangs the run instead of being cancelled. Only the job timeout catches it. | A hung suite shows as a timeout, not as a named test. | open |
| L-506 | A file that exits partway through loses its remaining tests from every count. Only the gate's run mode detects this, and CI runs that mode for the real-bwrap files only. | A mid-run exit in a non-bwrap file goes unnoticed in CI. | open |

## Unverified assumptions (the review runner's own plan text)

| ID | Assumption | Consequence if false | Status |
|---|---|---|---|
| L-601 | Codex: the SDK's spawn, argv and env handling were read in its source. Live behaviour has been seen only through the owner's runs. | Billing or sandbox behaviour could differ from the plan. The ChatGPT-only preflight refuses an unexpected login status. | open |
| L-602 | Grok: the login lives in the state dir. Whether a SuperGrok or X Premium subscription covers Grok Build CLI usage is undocumented. | Runs might be metered, or refused, unexpectedly. | open |
| L-603 | Antigravity hook semantics are those observed on 1.5.10 or stated by the owner: empty stdout allows; headless accept-edits soft-denies `run_command` without `auto_approve`. | If a later version changes them, the fail-closed design must be re-derived. | open |
| L-604 | A "provider call" excludes `countTokens`, on the reasoning that providers don't bill it. | If a provider does bill token counts, the budget undercounts. | open |

## Closed

(Entries move here one round after they are fixed, keeping their fixing commit and test.)
