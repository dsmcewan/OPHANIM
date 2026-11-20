# L-136 integration report: one Gemini billing policy

**Work.** Branch `l136/billing-policy`: `0fbf93e` (the policy and its tests) and `613a4e2` (its mutation runner). It fast-forwards onto `ccr-aa24f0d5-336szn` from `3165a85`.

**Who verified what.**
- The owner stopped the agent while it was verifying, before it wrote its report.
- The coordinator verified the work from the run logs, the code and the steps below:
  - It finished the interrupted mutation run, running only the mutations that run never reported.
  - It ran each verification step that had not been run on the final commit, once.
- The owner's decisions are quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-19 (L-136, after wave 3)".
- The design is in `docs/billing-policy.md`.

## Status

**L-136: qualified (scope), not closed.** The owner's conditions hold, and are tested, at the seven entry points and in live-run.

Two parts of the closure condition are still not demonstrated by a test:
- the cells that are unreachable (below);
- the board's `resume` budget (L-147).

Billed paths outside the seven are not under the policy (L-146, pending owner).

**L-124: repaired, split.** The python SDK seat is primary execution. It is refused unless `gemini_api_primary` is declared with a budget.

## The contract, requirement by requirement

| # | Requirement (the owner's words, shortened) | Result | Evidence |
|---|---|---|---|
| 1 | `metered_gemini_failover` false when absent | PASSED | Every new test fails on `3165a85`, where the defaults were on. Mutations D1–D7 killed: the default flipped back at each entry point and in the central resolution. |
| 2 | Opt-in by a supported setting or CLI flag | PASSED | Flags `--metered-gemini-failover N` and `--gemini-api-primary N` on tick, watch, board, compare, review-cycle and run-review. The `billing` block of the `serve` config. The live-run manifest. Enabling without a positive-integer budget is refused at startup (`GEMINI_BILLING_INVALID`; nothing runs; mutation E1 killed). |
| 3 | `GEMINI_API_KEY` never authorizes spend | PASSED at the seven entry points | Every test runs with synthetic `GEMINI_API_KEY`, `GOOGLE_API_KEY` and look-alike variables set. Mutation K1 (the key admits a kind that is off) killed. **Not true repository-wide**: see L-146. |
| 4 | Disabled: refused before admission or launch, recorded, work recoverable | PASSED | Each test asserts that no request reached the provider edge and that the refusal is recorded with its code. A later run with the policy declared resumes the same work. C1 (usage persisted after the send), W1 (a refused stage keeps a failure or block instead of pending) and W2 (a changed policy does not wake the stage) killed. |
| 5 | Enabled: declared budgets, pre-call charging, auditable usage | PASSED | The tests check the order: charge, then send. The usage row is asserted field by field: kind, model, purpose, role, source, budget, `used_before`, `remaining_after`. B1 (budget not enforced) and C1 killed. |
| 6 | Same policy across retries, restarts and the service | PASSED, except the board `resume` | Tested:<br>• the operate tick, killed and restarted<br>• `serve` across ticks, where a retried refused attempt stays refused<br>• `review-cycle resume`<br>• `run-review --continue`<br>R1–R3 (budget counted from process memory, from one claim, or from this process only) killed. **Not tested:** `pantheon-board resume` (L-147; by reading the code it uses the run's own usage file). |
| 7 | Every entry point: key present with failover off, enabled, budget exhausted | PASSED for every reachable cell | The matrix below. |
| — | Primary and fallback authorized separately | PASSED | X1 (the failover switch admits a primary seat) and X2 (the reverse) killed. Wave 3 mutations S7, S10 and S11 (a primary seat classified as a failover) killed. |
| — | Board reviewer and scout default to the subscription CLI lane | PASSED | T1 killed. With `PANTHEON_AGY_TRANSPORT=sdk` the SDK seat is primary and is refused without the setting (T2 killed). |
| — | Extend L-124, no second mechanism | PASSED (read in the code) | `gemini-billing.mjs` is re-exported by `quota-failover.mjs`. The old `meteredFailover` and `failover` options now throw at every former consumer instead of being ignored. `wave3-agy-spend.mutate.mjs`: 25/25 killed on the final commit. |
| — | Close only after all seven are demonstrated | MET for the reachable cells | The unreachable cells are argued from the code (below), not tested. |

No requirement failed. The contract needed no repair.

## The seven entry points

Every behavioural test drives the real entry point: a spawned CLI, or the CLI's `main` with real argv. Fakes are used only at the provider edge, and they record every call. Every test cell below failed on `3165a85`.

| Entry point | Failover (off with key / declared / budget spent) | Primary (off with key / declared / budget spent) |
|---|---|---|
| `operate tick` | `operate tick: with a key present and nothing declared …` (ophanim/operate/l136-billing.test.mjs) | unreachable* |
| `operate watch` | `operate watch --once: refused and recorded …` | unreachable* |
| `operate serve` | `operate serve (service config billing): …`, including a config that declares no billing (added after D2 survived) | unreachable* |
| `pantheon-board` run | `pantheon-board run, FAILOVER (the in-run critique's Antigravity lane refused for quota; its metered spare)` | `pantheon-board run, PRIMARY (an operator's Gemini API reviewer seat)`, and the SDK seat through `PANTHEON_AGY_TRANSPORT=sdk` |
| `pantheon-compare` | `pantheon-compare, FAILOVER (the fit arm's lane ladder refused for quota …)` | `pantheon-compare, PRIMARY (a ticket's Gemini API pin, both arms)` |
| `pantheon-review-cycle` review, resume | unreachable** | `pantheon-review-cycle review/resume, PRIMARY (a Google reviewer served by the Gemini API)`, restart included |
| review runner `--via api` | unreachable** | `run-review --via api, PRIMARY (a Google reviewer)`, `--continue` included |

\* `operate` primary: `cli.mjs` and `service.mjs` pass no routing profile, and `makeExecutors` defaults to `fit`. Under `fit` every Gemini seat is an Antigravity lane, and plans carry no seat pins. Only live-run can choose another profile, and live-run keeps primary off. This was checked by reading the code, not by a test.

\*\* The Google reviewer of the review cycle and of the review runner is the Gemini API itself. No subscription lane stands in front of it, so there is no failover to refuse. This is the agent's argument from the code; the coordinator has not tested it.

The central resolution and its order at the point of spend have their own fast unit suite, `pantheon/tests/l136-policy.test.mjs`. It checks the order: the policy, then the caller's admission, then the usage row, then the request.

## Mutations (on `613a4e2`)

| Runner | Result |
|---|---|
| `pantheon/tests/l136-billing.mutate.mjs` | **26/26 killed.** <br>• First full run, before the commit: D2 (a `serve` config without billing resolves to on) survived, because the serve test always declared billing. The fix added a case that declares nothing. <br>• Second full run, on the committed tree: killed by SIGKILL after 19 of 26, all 19 killed (D1–D7, K1, X1, X2, C1, B1, R1–R3, W1, W2, T1, T2). <br>• The other 7 were run by the coordinator on `613a4e2` with `--only`: E1 and P1–P6 all killed, exit 0. |
| `pantheon/tests/wave3-agy-spend.mutate.mjs` | 25/25 killed on the final tree (baseline 138/138), exit 0 |

The cause of the SIGKILL is not established. Memory was ample (16 GB, no out-of-memory record), and the run's waiting loop was killed at the same moment.

## Existing tests changed

Only where a test relied on the old defaults. Each now opts in explicitly with a budget, through `pantheon/tests/fixtures/billing.mjs`, or asserts the new code in place of the old message.

The coordinator counted the assertion lines each file removed and added, and read every changed assertion except those in `wave3-spend`. None is weaker.
- `board-agy-planner-role` asserted the SDK seat as the default. It now asserts:
  - the CLI default;
  - the primary refusal;
  - that the SDK lane is attempted when that transport is set.
- `reliability-r2-a3-rest` matches the code and the reason where it matched only "disabled".
- `live-run.test` asserts a pending billing refusal with its code, and that the unit's block is kept beside it.
- `wave3-spend` was rewritten for the primary/failover split (20 assertion lines out, 22 in). Its runner killed every mutation.

The files:
- ophanim: `live-run`, `reliability-r2-a3-rest`, `wave3-identity`.
- pantheon: `agy-worker`, `board-agy-planner-role`, `fit-review-intake`, `output-cap-serialized`, `pipeline-exec-reliability(-a3)`, `pipeline-turns`, `quota-failover`, `reliability-r2-a3(-rest)`, `reliability-r3-a3`, `review-runner-continue`, `review-runner-run`, `wave3-agy-guard`, `wave3-spend`.
- The runner `wave3-agy-spend.mutate.mjs`.

## Suites (Node 24, on `613a4e2`, exit codes read directly)

| Step | Exit | Result |
|---|---|---|
| `npm run test:proof` | 0 | 504/504; 0 failed, cancelled or skipped |
| `npm test` | 0 | 1731/1731 (model-client 62, ledger 47, pantheon 1622) |
| `npm run test:gates:self` | 0 | 35/35 |
| `npm run test:gates` (run mode, every suite per file) | 0 | every suite PASS. The new files: `l136-policy` 0.1 s, `pantheon/tests/l136-billing` 20 s, `ophanim/operate/l136-billing` 35 s |
| `npm run test:lint -- --enforce` | 0 | 0 unsuppressed findings (25 suppressed, unchanged) |
| `l136-billing.mutate.mjs` | 0 | 26/26 killed (19 in the interrupted run, 7 with `--only`) |
| `wave3-agy-spend.mutate.mjs` | 0 | 25/25 killed |

The agent's earlier full verification, on the tree before the commit, failed `test:gates:self` once. A declared 600 s timeout exceeded the 360 s per-file bound, and the timeout was lowered to 300 s before the commit. The run above is on the committed tree.

## Ownership

`check-ownership.mjs docs/execution/l136-ownership.json L136 --diff agent-l136-billing 3165a85 l136/billing-policy` first reported `pantheon/src/route/gemini-billing.mjs` as UNOWNED.

The brief allowed "a module beside it that it re-exports", but the manifest omitted it. That was the coordinator's error, not the agent's. The manifest records a dated post-hoc amendment.

## Open items, for the register

- **L-146 (pending owner).** These billed primary Gemini paths sit outside the seven and are not gated:
  - `bin/cross-lab-review.mjs` calls `cycle-review-http-turn.mjs` directly. Its default Google seat goes to the metered API with `GEMINI_API_KEY`, or with a proxy-held credential when no key is set.
  - `scripts/live-check`, `live-ship`, `stream-check` and `view-check`.
- **L-147 (open).** No test covers `pantheon-board resume` budget continuity. When `evidence.json` has no `board`, the budget is counted from a fresh file.

## Future tickets (nonblocking; not in this change)

1. **Choose suites per mutation in `l136-billing.mutate.mjs`.**
   - Problem: every mutation runs all three suites, about 55 s of real-process tests. The fast policy suite alone decides the central-resolution mutations.
   - Fix: map each mutation to the suites that decide it, and keep the spawned entry-point tests for the wiring mutations (P1–P6, D1–D6, T1, T2).
   - Consequence if left: about 15 minutes per full run.
2. **Rename the review runner's usage record.** `findings-<n>-<lab>.gemini-billing.jsonl` falls under the `findings-*` withholding rule, so an agent auditing billing would have to read a withheld path. A non-`findings` name would keep the record auditable without touching the rule.
3. **Watch CI for the new real-process files.**
   - Locally under the gate: `ophanim/operate/l136-billing.test.mjs` takes 35 s and `pantheon/tests/l136-billing.test.mjs` 20 s.
   - At CI's observed 4–7x slowdown that is up to about 245 s, against the 360 s per-file bound (the L-134 class). Each test declares 300 s.
   - First evidence: the CI run on this push.

## Reflection (evidence-driven, bounded)

**What happened against what was expected**
- The mutation runner did its job. D2 found a real gap: the serve test never omitted billing.
- The wave 3A gate did its job. Its coverage check failed the agent's first full verification, because a declared 600 s test timeout exceeded the 360 s per-file bound. The timeout was lowered to 300 s before the commit.
- Two things went wrong:
  - The final mutation run was killed after 19 of 26. The work moved on to commit and verification without saying so. The commit message reports the earlier full run and a targeted rerun, which is true, but not that the final-tree run was incomplete.
  - The coordinator's own manifest and brief disagreed about the new module.

**Why**
- The serve default was tested through the CLI flag path only. That is the existing class `bound-declared-not-enforced`: a rule stated "at every entry point" was checked on the easy path. It was recorded as a mechanism detection. It is not counted as success: the class's registered detector did not fire, and one instance is not a demonstrated mechanism.
- The coordinator's directive "finish the current mutation run" did not say what finishing means once a run has been interrupted. Rerunning the unreported subset is finishing, not a new sweep.

**Owner intervention**
- The owner had to bound the execution: two full verification sets and two full sweeps of each runner in about two hours, where each mutation runs the expensive suites.
- This was recorded as a new owner-observed class, `verification-cost-unbounded`. It has no detector: it is conduct and test cost, not a code property. The next step is a verification budget in the coordinator's briefs.
- The re-runs themselves answered real findings. The cost of each cycle is what needs bounding.

**Where else this applies**
- live-run, the other configuration channel, fails closed: its manifest requires `billing.metered_gemini_failover`.
- The other entry points' absent cases were already killed (D1, D3–D6).
- No other change.

**Unresolved**
- The cause of the SIGKILL.
- Whether a change's own mutation runner counts as "the mechanism" for the corrections registry's success criterion. If it does, D2 would be that class's first demonstrated success. It is not claimed here.
