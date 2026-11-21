# L-148 integration report: the view server and its launchers under the one billing contract

**Work.**
- Branch `l148/view-billing`, from `fb58c77`:
  - `210ccca`: the launchers' seat labels (L-152);
  - `0d98dfa`: the L-148 change.
- It is merged onto `ccr-aa24f0d5-336szn`, which by then also carried the owner's requirement 7 confirmation (`da06521`). The files do not overlap.

**Sources.**
- The owner's decision and the requirement 7 confirmation are quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-20 (L-148)".
- The design is in `docs/billing-policy.md`.

**Who verified what.**
- The agent ran the targeted verification its brief allowed.
- The coordinator re-ran all of it independently, plus the L-136 and L-146 mutations that edit the shared modules this change touched.
- No full sweep, as the owner directed. CI runs the full suite on push.

## Status

**L-148: qualified.** The scope is `pantheon-view.mjs`, whose server process is the boundary, and its launchers `swarm-run.mjs` and `discuss-run.mjs`. Every verification bullet the owner listed is tested on the spawned server and launchers, and each test fails on `acf4e3c`.

New findings from the inventory:
- **L-150 (pending owner):** the board's SDK seat is charged once per launch, but a launch can make up to 40 billed model calls. This narrows L-136.
- **L-151 (pending owner):** `agy-seat.py` run directly is ungated.
- **L-152 (repaired):** the launchers' labels.
- **L-153 (open):** `delegate-run.mjs` has the same label defect.
- **L-154 (open):** the lock's limits.

L-147 and L-149 stay open.

## How each entry point reaches the helper

- **`pantheon-view.mjs`** uses `operatorGemini(argv, {runDir: <home>/view, serve: true, make})`, the L-146 helper.
  - **The provider-call boundary.** `createViewServer` calls its `makeClientFor`, now `gemini.clientFor`, inside `runTurn`, for every turn, whoever sent `POST /turn`.
  - **Policy before credentials.** A Gemini client is admitted before it is built, so before any key is read. Each generation request is charged on the record before it is sent.
  - **The record:** `<PANTHEON_HOME>/view/gemini-billing.jsonl`. `--gemini-usage` is refused. `--metered-gemini-failover N` is accepted and authorizes nothing here.
  - **Unchanged:** the port argument, and loopback-only binding.
- **`swarm-run.mjs` and `discuss-run.mjs`** hold no billing authority.
  - A billing flag is refused at startup (`GEMINI_BILLING_INVALID`, exit 2: authorization belongs to the server).
  - A seat the server refuses is printed as `gemini_refused`, with its code and recovery condition, and is that seat's failed turn. `src/swarm/**` is unchanged.
- **`server.mjs`** carries a billing refusal's `code` and `recovery` onto the bus `error` event and the `/turn` result. Both are read off the refusal only; nothing in a request can supply or change them. The origin policy, http-safety, the subscriber bound, the per-seat lock and reseating are unchanged; their tests pass (`view-security`, `view-events`, `view-reseat`, `view-board`).

## Restart semantics, as the owner confirmed

- Each start declares its own policy. With no flag, Gemini is off, whatever the record or the history shows.
- `--gemini-api-primary N` is a cumulative ceiling over the persisted record.
- A larger N is an explicit new authorization, and history is never erased.
- Every start's policy and source, each refusal as it is made, and each exit (SIGTERM included) are appended to `<home>/view/gemini-billing-runs.jsonl`. That file is written, never read to authorize anything.
- Test "view restart", the owner's exact case:

| Step | Result |
|---|---|
| Start with budget 6 | 6 requests charged |
| Restart with 10 | exactly 4 admitted; the 5th refused before it is sent ("budget of 10 is spent (10 of 10 recorded …)") |
| Restart with no flag | `GEMINI_PRIMARY_DISABLED`, no Google request of any kind, despite the earlier authorization in the record and history |
| Restart with 10 again | refused: nothing reset |

Mutations V10 (the record kept per process), V13 (history re-enables), V14 (usage re-enables) and V18 (exit record lost on SIGTERM) are killed.

## Concurrency

- **One process.** Budget 4, 2 already spent; 6 concurrent turns on distinct Gemini seats.
  - Exactly 2 are served and 4 refused (`METERED_GEMINI_BUDGET_EXHAUSTED`, each with its recovery condition).
  - 2 requests reach the provider stub, and the record reads 0, 1, 2, 3.
  - Why it is atomic: `spendGemini` counts and appends synchronously, so no other request runs in between. V6 (the count read before an `await`) is killed.
- **Two processes on one record.** Two servers on the same home; budget 3, 2 spent.
  - Both pass the policy check and wait at the record's lock.
  - Exactly 1 request is sent. The other is refused by the count taken again under the lock.
  - V7 (lock removed) and V8 (no count under the lock) are killed.
  - The lock is `<record>.lock`, using the seat lock's protocol (`src/seat/lock.mjs`), held for one count and one append.
- **A stale lock** (a dead holder, or a reused pid) is reclaimed, and the turn is charged. V9 (never cleared) is killed.

## The contract, requirement by requirement

| # | Requirement (owner's words, shortened) | Result | Evidence |
|---|---|---|---|
| 1 | Default off when authorization is absent | PASSED | "view off" (keys, ADC and Vertex look-alikes; no key, the proxy path), the launchers against an off server, restart with no flag. V1 killed |
| 2 | The existing shared helper, no other implementation | PASSED | `operatorGemini` only; the lock reuses the seat lock's protocol. V1 killed |
| 3 | Explicit primary authorization and a declared budget | PASSED | Startup refusals: budget `0`, budget `yes`, `--gemini-usage`. V19 killed |
| 4 | Primary separate from failover | PASSED | "failover-only: still refused". V4 killed |
| 5 | Enforced at the provider-call boundary, not only at the launcher | PASSED | `/turn` sent directly is gated; launcher flags refused. V2 (authorization only in the launchers) killed |
| 6 | Concurrent requests within one shared budget | PASSED | "view one process", "view two processes". V6, V7, V8 killed |
| 7 | No reset on restart | PASSED | "view restart" (above). V10, V13, V14, V18 killed |
| 8 | Client fields, environment keys, proxy and session credentials are not authorization | PASSED | "view client fields" (a body `gemini_api_primary` or `budget`: refused when off, not widened when on). Keys, ADC and Vertex look-alikes; the no-key proxy path. V3, V20 killed |
| 9 | Non-Gemini functionality preserved | PASSED | An xai seat in the same `/turn` succeeds while Gemini is refused; the launchers' other seats run (needs L-152's repair). V12 killed |
| 10 | Refusals, charges, models, basis and recovery recorded | PASSED | Usage rows (kind, model, purpose, source); the runs journal; code and recovery on the bus event and the `/turn` result. V11, V16, V17 killed |
| — | No metered request before admission and charging | PASSED | `chargedBefore`: each billed request reaches the edge with its own usage row already persisted. V5 killed |
| — | Inventory of Google API egress paths | DONE (report only) | Below; uncovered paths registered |
| — | Existing contracts preserved | PASSED | `src/swarm/**` untouched; the view-server, L-136 and L-146 tests pass (383/383) |

## Inventory of Google API egress paths

| Path (entry point → code) | Endpoint | Metered | Protected by | Test |
|---|---|---|---|---|
| `pantheon-view` `/turn` (the page, either launcher, any local client) → `server.mjs runTurn` → `clientFor` → `adapter.mjs` | generativelanguage, or Vertex | primary | L-148 server gate | `l148-billing` |
| `view-check`, `live-check`, `stream-check`, `live-ship` → `operatorGemini` | the SDK client | primary | L-146 helper | `l146-billing` |
| `cross-lab-review`, `pantheon-review-cycle --turn` → `cycle-review-http-turn.mjs` | generativelanguage, OpenAI-compatible endpoint | primary | L-146 `billedTurnModule` | `l146-billing` |
| `pantheon-review-cycle`, `pantheon-compare`, `pantheon-board` run and resume (API seats, failover) | the SDK client | both | L-136 | `l136-billing` |
| `run-review --via api` → `review-runner/vendors.mjs` | generateContent | primary | L-136 | `l136-billing` |
| `operate` tick, watch, serve; `live-run` | the SDK client | mostly failover | L-136 (work ledger) | `ophanim/operate/l136-billing` |
| `open-items-run.mjs`, `pantheon-build.mjs` (`runOpenItem`) | the SDK client | either | L-136, both kinds forced off | none for these two entry points |
| The board's python SDK seat (`PANTHEON_AGY_TRANSPORT=sdk`) → `run-item.mjs` ~609-628 | the Gemini API or Vertex | primary | L-136, **partial**: one charge per launch for up to 40 model calls | **L-150** |
| `scripts/agy-seat.py` run directly | the Gemini API or Vertex | primary | **none** | **L-151** |
| Token counting (`model-client/client.mjs`, `adapter.mjs`) | countTokens | no (free) | sent only by an admitted client; never charged | the `l148` off cells (zero Google requests) |
| Vertex routing (`GOOGLE_GENAI_USE_VERTEXAI`) of any SDK client | aiplatform | yes | the gate of the seat it serves | the "keys and a Google session" cells |
| Antigravity CLI lanes and the `agy --print /usage` probe (`src/agy/quota.mjs`) | OAuth subscription | no | not gated, by design | the `l136` lane cell |
| `scripts/delegate-run.mjs` | (no Google seat) | — | the server would gate one | none (its labels: L-153) |

No model listing, embeddings, files or caches calls were found.

## Mutations

| Runner | Result |
|---|---|
| `pantheon/tests/l148-billing.mutate.mjs` (full; each mutation against only the tests that decide it) | baseline 28/28; **20/20 killed**, exit 0 (V1–V20, as tabled above) |
| `l146-billing.mutate.mjs --only L1,X1,K1,D1,C1,C2,O1,B1,U1,P1,R1` (the mutations that edit `gemini-billing.mjs` or `live.mjs`), on this branch | **11/11 killed**, exit 0 |
| `l136-billing.mutate.mjs --only D7,K1,X1,X2,C1,B1,R1,R3,E1` (the mutations that edit `gemini-billing.mjs`), on this branch | **9/9 killed**, exit 0 |

The record's new count under its lock is a second, independent budget check, so disabling the first check is now partly absorbed by the second. These mutations are still killed, by fewer tests:

| Mutation | Failing tests before | Failing tests now |
|---|---|---|
| L-146 B1 | 16 | 2 |
| L-136 B1 | 11 | 7 |
| L-136 R1 | 10 | 7 |

## Coordinator verification (Node 24; exit codes read directly)

| Step | Result |
|---|---|
| `check-ownership.mjs docs/execution/l148-ownership.json L148 --diff agent-l148-billing fb58c77 l148/view-billing` | 10 files, 0 problems |
| The new tests on `acf4e3c`'s code, copied onto a disposable checkout | **0/28 pass** (exit 1). The failures name the property: "no Google request of any kind may reach the edge", "each billed request must be sent only after its own usage row was persisted", "the history shows an earlier authorization"; base launchers exit 0 with the billing flag accepted |
| The new tests on `0d98dfa` | 28/28 pass |
| The existing importers of every changed module, once, with the L-136 operate and L-146 suites | **383/383** pass (24 files, including `view-security`, `view-events`, `view-reseat`, `view-board`) |
| `npm run test:lint -- --enforce` | exit 0 |
| `--check` on the L-136, L-146 and L-148 runners | 26, 19 and 20 targets, each exactly once |
| The three mutation runs above | exit 0 each |

Not run, by the owner's instruction: `npm test`, `test:proof`, `test:gates`.

## Decisions made by the coordinator

- **The launchers' labels (L-152, `210ccca`) are accepted.** Both launchers sent labels the server refuses with 400 (`server.mjs:205`), so no seat of either ever reached a provider: the base swarm reported 0/4 seats ok. Owner item 9 cannot be shown at the launchers without the repair. The standing rule (wave 3 authorization) is that a defect necessary to establish an assigned invariant is repaired, with a test that fails on the base; the launcher cells do. The repair is a separate two-line commit, and the manifest records a dated amendment.
- **The agent's reading of a contradictory brief.** The brief told it to read the owner decision in `docs/OPEN-LIMITATIONS.md` and also forbade that file. The agent read only the decision's diff hunk. Recorded as a third instance of lessons class `brief-manifest-disagree`. The same contradiction was in the L-136 and L-146 briefs.

## Caveats and their dispositions

- **The lock's limits.** It is single-host, since pid reuse is judged through `/proc`; a waiting request blocks the event loop for up to 30 s before it is refused (`GEMINI_USAGE_LOCKED`, nothing sent); and it imports `src/seat/lock.mjs` through `_internals`. Recorded as L-154 (open).
- **Unlocked first count.** The first count, at admission, is unlocked; only the count under the lock decides. A torn read can only refuse, never overspend. No exposure.
- **Free token counts.** An admitted client may send a free `countTokens` before its generation request is refused in a race. Not billed; no exposure.
- **SIGKILL.** A server killed with SIGKILL loses only its exit record: starts, refusals and charges are already on disk. No exposure to the budget.

## Future tickets (nonblocking)

1. Export a synchronous lock primitive from `src/seat/lock.mjs`, replacing the `_internals` import (L-154).
2. Fix `delegate-run.mjs`'s labels (L-153).
3. Test `open-items-run.mjs` and `pantheon-build.mjs`'s forced-off billing at their own entry points. The inventory found no test for those two entry points; the shared policy is tested.
