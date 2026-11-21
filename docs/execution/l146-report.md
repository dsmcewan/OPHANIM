# L-146 integration report: five more billed Gemini paths under the one policy

**Work.**
- Branch `l146/billing-paths`, from `a984b60`:
  - `9616c88`: the five paths and their tests;
  - `ecfd4e8`: the view route listed in the sibling table.
- It fast-forwards onto `ccr-aa24f0d5-336szn`.
- The owner's decision is quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-20 (L-146)".
- The design is in `docs/billing-policy.md`, "Operator scripts".

**Who verified what.**
- The agent ran the targeted verification its brief allowed.
- The coordinator re-ran, independently: the ownership check, the base proof, the new tests, the existing importers, the lint and the mutation runner.
- No full sweep, as the owner directed. CI runs the full suite on push.

## Status

**L-146: qualified (scope: the five identified paths, plus the HTTPS turn module's route through `pantheon-review-cycle --turn`).**
- Every reachable cell of the owner's verification sentence is tested on the real script, with fakes only at the provider edge. Each fails on `fd9f001`.
- Outside the scope: the view server route (L-148, pending owner).
- **L-147 stays open,** as the owner directed: there is still no board-resume billing test.

## The mechanism (reused; not five implementations)

- **The flags.** `route/gemini-billing.mjs billingFlagsFromArgv(argv)` takes `--gemini-api-primary N`, `--metered-gemini-failover N` and `--gemini-usage FILE` out of a script's argv. It resolves them through L-136's `billingFromFlags`.
- **The one helper.** `sdk/live.mjs operatorGemini(argv, {script, runDir, make})` is built on `geminiBilling`, `geminiUsageFile` and `spendGemini`.
  - **The usage record.** `<runDir>/gemini-billing.jsonl` where the script has a run directory: the cross-lab review directory, and live-ship's board. Otherwise `--gemini-usage FILE`, which is required to enable; there is no silent default location.
  - **Startup refusals.** A malformed or zero budget, or an enabled kind without a record, is `GEMINI_BILLING_INVALID`: exit 2, nothing runs.
  - **`clientFor(vendor, …)`.**
    - It admits the policy **before** `make()`, so before any credential is read.
    - It wraps the client's generation methods (`generateContent` and `generateContentStream`, the same set the adapter charges), so every request is charged through `spendGemini` before the SDK sends it.
    - Other labs' clients are returned unchanged.
  - **The record.** The policy with its source, rows with model and purpose, and refusals with code. It is printed as `gemini_billing {...}` at exit, and appended to `<runDir>/gemini-billing-runs.jsonl` where there is a run directory.
- **The HTTPS turn module** (`cycle-review-http-turn.mjs`, behind cross-lab-review and `pantheon-review-cycle --turn`) declares `turn.meteredGeminiApi = true`. `billedTurnModule` then charges every Google call as primary, whatever the model is named. A declaration can only add charges.
- **No script implements billing.** The coordinator's grep found no `spendGemini`, `geminiAdmission`, `geminiUsageFile` or `billingRecord` in the five scripts.

## The defect found before dispatch

`cycle-review-http-turn.mjs` sends every `agy_google` seat to the metered Gemini API. `billedTurnModule` let a seat through unbilled when its model is lane-named, for example `gemini-4-hydrogen-xhigh`, whose transport is `agy-cli`.

The agent reproduced it on `a984b60`: with billing off and no key, a request was sent and no refusal recorded. It also showed this is the **default** route of `pantheon-review-cycle review --turn cycle-review-http-turn.mjs`, whose Google seat is `agy_google/gemini-3.8-flash-high`, a lane-named model.

The fix is the module's one-line declaration above.
- Base: the cross-lab lane-seat cell sent the request and exited 0, and the review-cycle cell sent the request.
- Mutations L1 and L2, which undo the fix, are both killed.

## The contract, requirement by requirement

| # | Requirement (owner's words, shortened) | Result | Evidence |
|---|---|---|---|
| 1 | Default off for every execution | PASSED | "off: keys and a Google session present", in every path's test: no Google request reaches the edge, and `GEMINI_PRIMARY_DISABLED` is on the record. Fails on base. Mutation D1 killed. |
| 2 | Primary separate from failover; a direct reviewer needs primary | PASSED | "failover-only: still refused", in each path. The HTTPS module charges every Google call as primary (L1, L2). Mutation X1 killed. |
| 3 | No credential confers permission: environment keys, inherited, proxy-injected, authenticated sessions | PASSED | Synthetic `GEMINI_API_KEY` and `GOOGLE_API_KEY`, an ADC file, `GOOGLE_GENAI_USE_VERTEXAI` with project and location, and look-alike variable names. "off: no key, the proxy path": the same policy refusal, not a key error. For cross-lab that is the `Bearer proxy-injected` path. K1 and P1 (client made before the policy) killed. No real proxy was used; nothing left the machine. |
| 4 | Affirmative flag and declared budget before any metered request | PASSED | The "startup refusal" cells (no `--gemini-usage`, budget `0`, an unbudgeted flag): exit 2, nothing runs. D1 and U1 killed. |
| 5 | Admit and charge before send; record usage, refusals, model, basis | PASSED | `chargedBefore`: the usage rows already persisted when each request reached the edge. Rows checked for kind, vendor, model, purpose and source (the flag). Refusals checked for code, model and source. C1, C2, O1 and R1 killed. |
| 6 | Operator scripts included | PASSED | All five gated. G1–G5, each script's gate removed, killed. |
| 7 | Fail closed; evidence and recoverable state kept | PASSED | The budget-smaller and budget-spent cells keep the usage file and record the refusal. Cross-lab writes `review-<vendor>.refused.json`, never a review; the other labs run; a recovery re-run completes the seat. E1, E2 and B1 killed. Live-ship's limits: L-149. |
| — | Reuse L-136's mechanism, not five implementations | PASSED | One helper plus `billedTurnModule`, built on L-136's functions; grep as above. |
| — | Verification sentence, per reachable path, with retries and multiple requests | PASSED | The matrix below. Multiple requests: live-check (a hop and a second turn: 3), stream-check (the streamed request and its hop), live-ship (the planner, its retry after a 5xx, and the implementer). |
| — | L-146 qualified only when the identified paths are covered | MET | All five covered. Unreachable cells shown from the code (below). |

## Per path

Test file: `pantheon/tests/l146-billing.test.mjs`. Every cell listed passes on `ecfd4e8` and fails on `fd9f001`; the coordinator's base run gave 0/41.

| Path | Off, keys and session | Off, no key (proxy) | Failover only | Primary declared (requests) | Budget smaller / spent | Startup refusal |
|---|---|---|---|---|---|---|
| cross-lab-review | ✔ (lane-named seat; the other lab unaffected; a refusal file, not a review) | ✔ (default seats, `Bearer proxy-injected`) | ✔ | ✔ the recovery run completes the refused seat | spent ✔ (by the recovery run, in this directory) | ✔ |
| live-check | ✔ | ✔ | ✔ | ✔ 3 (a hop and the second turn) | ✔ / ✔ | ✔ |
| stream-check | ✔ | ✔ | ✔ | ✔ 2 (the streamed request and its hop) | ✔ / ✔ | ✔ |
| view-check | ✔ | ✔ | ✔ | ✔ 1 (only the Gemini seat is charged) | — / ✔ | ✔ |
| live-ship | ✔ | ✔ | ✔ | ✔ 3 (planner, its retry, implementer) | ✔ / ✔ | ✔ |
| review-cycle `--turn` (HTTPS module) | ✔ (the cycle stays open) | — | — | ✔ (the resume) | — | — |

**Not reachable, from the code.**
- view-check: a multi-request Gemini turn. Its model is fixed at `gemini-3.6-flash`, the direct path, with no hop.
- live-ship: its Gemini scout (`SCOUTS = ["xai"]`) and a Gemini reviewer (`reviewPlan` pairs the openai maker with xai). Both are gated anyway.
- cross-lab: retries. There is one attempt per seat by design.

## Mutations

Runner: `pantheon/tests/l146-billing.mutate.mjs`. Each mutation runs only the tests that decide it.

Baseline 41/41. **19/19 killed, exit 0**: the agent's run on `9616c88`, and the coordinator's on `ecfd4e8`, 95 s.

| ID | Mutation | Tests failing |
|---|---|---|
| G1–G5 | Each script's gate removed: cross-lab, live-check, stream-check, view-check, live-ship | 6, 7, 7, 6 and 7 respectively |
| L1 | `billedTurnModule` ignores the module's declaration (lane pass-through restored) | 7 |
| L2 | The module no longer declares its Gemini calls metered | 7 |
| X1 | `--metered-gemini-failover N` authorizes primary calls | 10 |
| K1 | A `GEMINI_API_KEY` hands out the ungated client | 23 |
| D1 | No flag resolves to primary enabled | 22 |
| C1 | Charge after send (the gated client) | 11 |
| C2 | Charge after send (`billedTurnModule`) | 9 |
| O1 | Only a client's first request charged | 6 |
| B1 | Budget not enforced | 16 |
| U1 | Enabling without `--gemini-usage` accepted (a silent default record) | 6 |
| P1 | Client made, and the key read, before the policy check | 8 |
| E1 | A cross-lab refusal reported as a failed seat (no refusal record) | 5 |
| E2 | A cross-lab refusal written as an empty review | 5 |
| R1 | The billing record not printed or kept | 29 |

## Coordinator verification

On `ecfd4e8` (Node 24, exit codes read directly), plus the new tests on `fd9f001`:

| Step | Result |
|---|---|
| `check-ownership.mjs docs/execution/l146-ownership.json L146 --diff agent-l146-billing a984b60 ecfd4e8` | 12 files, 0 problems |
| The new tests on `fd9f001`'s code, copied onto a disposable checkout | **0/41 pass** (exit 1). Failures name the property: "no billed Gemini request may reach the edge", "each billed request must be sent only after its own usage row was persisted", "the lane-named Google seat must not reach the metered API" |
| The new tests on `ecfd4e8` | 41/41 pass (exit 0) |
| The existing importers of the changed modules, once: `l136-billing`, `l136-policy`, `cycle-review-http-turn`, `pipeline-charge-per-request`, `pipeline-ladder`, `quota-failover`, `reliability-r3-a3`, `reliability-r2-a3-rest`, `wave3-agy-guard`, `wave3-spend` and `ophanim/operate/reliability-wave2b` | 192/192 pass (exit 0) |
| `npm run test:lint -- --enforce` | exit 0, no unsuppressed finding |
| `l136-billing.mutate.mjs --check` | 26 targets, each exactly once |
| `l146-billing.mutate.mjs`, full | 19/19 killed (exit 0) |

Not run, by the owner's instruction: `npm test`, `test:proof`, `test:gates` and the other mutation runners. CI runs the full suite on push.

## Caveats and their dispositions

- **The `cycle-review-http-turn.mjs` edit.** The manifest's region limit said its `--turn` use stays unchanged, while the brief required the fix that changes it. The brief governs, and the edit is accepted. The manifest records a dated amendment, and the lessons registry records the conflict as class `brief-manifest-disagree`: its second instance after L-136.
- **The view server route.** `pantheon-view.mjs`, `swarm-run` and `discuss-run` are not gated: L-148, pending owner.
- **live-ship.** Its budget is per board directory, and it sends a lane id to the raw API on fall-through: L-149, open.
- **The Vertex blind spot in the L-136 recorder.** It counts only `generativelanguage.googleapis.com`. No exposure: the L-136 tests set no Vertex variable (the coordinator checked by grep). The L-146 recorder counts every `googleapis.com` host. A future ticket below covers widening the L-136 recorder.
- **A new output line.** Each of the five scripts prints one `gemini_billing {...}` line at exit. This is documented.
- **The agent's one failing existing test** (L-407 in `reliability-r3-a3`, `EXIT:125` from the verify launcher). It failed in the agent's environment only. The coordinator's run passes it (192/192 in the importer set).

## Future tickets (nonblocking)

1. Widen the L-136 fetch recorder's billed flag to Vertex hosts.
2. The refusal and run records written into a review directory hold absolute paths, in `why` and `where`. If such a directory is committed, the machine-paths test (`ophanim/tests/machine-paths.test.mjs`) would refuse it. Record the paths relative to the directory instead.
3. Decide whether live-ship's Gemini fall-through seats should stay. They are part of L-149.
