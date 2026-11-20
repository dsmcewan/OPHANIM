# L-150 and L-151 integration report: per-request charging in the python SDK seat; governed direct execution

> **Superseded in part, 2026-11-20 (register L-724).** The owner made the SDK transport's model gateway (`pantheon/src/antigravity/gateway.mjs`) the one mechanism and had the metering relay this report describes retired. The seat is served by the gateway through `pantheon/src/antigravity/seat-session.mjs`; the environment names, refusal codes and file names below changed with it (`docs/billing-policy.md` has the current ones). What this report shows about L-150 and L-151 was re-run against the gateway: the test file and the real-SDK proof give the same results. The report is kept as it was written.

**Work.**
- Branch `l150/sdk-relay`, from `12b02ec`:
  - `c7d3653`: the agent's change.
  - `b9cbafb`: the coordinator's runner retargets, and a test of the relay's idle and lifetime bounds.
- It fast-forwards onto `ccr-aa24f0d5-336szn`.
- The owner's decisions are quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-20 (L-150, L-151)". The design is in `docs/billing-policy.md`.

**Verification.**
- The agent ran its targeted set and a real-SDK proof.
- The coordinator re-ran the targeted set independently, and then the owner's **integration gates** once, on the merged tree.
- CI passed on `b9cbafb`.

## Status

**L-150: qualified.** Every Gemini request the SDK seat's harness was seen to make is admitted and charged, one by one, before it is sent.

**L-151: qualified.** A direct run without a controller capability makes zero requests.

**L-136** was narrowed at L-148 because the SDK seat was charged once per launch. That narrowing is now resolved.

**New entries:**

| Entry | Item | Status |
|---|---|---|
| L-155 | Key read by the seat's shell | pending owner |
| L-156 | Vertex through the SDK seat refused | open |
| L-157 | Relay behind a proxy | open |
| L-158 | Unobserved SDK call paths refused: explicit blockers | open |
| L-159 | Subagent name; one proof cell | open |
| L-160 | Lint walks agent worktrees | open |

L-147, L-149, L-153 and L-154 stay open.

## What the SDK does (google-antigravity 0.1.24, google-genai 3.6.1; the agent's investigation)

- **The sender.** Requests are sent by the SDK's bundled Go harness (`google/antigravity/bin/localharness`). Python spawns it and talks to it over a loopback websocket.
- **The transport.** REST over HTTP/1.1 with JSON. Streaming is SSE.
- **The default endpoint.** `generativelanguage.googleapis.com`.
- **Requests observed:**
  - `models/{m}:streamGenerateContent?alt=sse` for each model call, retry, continuation, context summary and subagent call;
  - `models/{m}:generateContent` for web search.
- **Redirecting it.** The endpoint is configurable through public API (`types.GeminiAPIEndpoint(base_url, api_key)`, or `GOOGLE_GEMINI_BASE_URL`), so no man-in-the-middle and no package patch is needed. An explicit `api_key` beats environment keys.
- **Shared client.** Subagents use the same endpoint, each with its own `sessionId`.

No stop condition held, so the coordinator's design (D1–D8) was implemented.

## The mechanism

- **The relay** (`pantheon/src/route/gemini-relay.mjs`) listens on loopback, on an ephemeral port. It holds the real key and the run's own billing context, and calls `spendGemini`; it is not a second billing mechanism. For each request:
  1. **Capability:** the session token must be open. Otherwise 401, and nothing is charged or forwarded.
  2. **Allowlist:** `streamGenerateContent` and `generateContent` are billed; `countTokens` is forwarded and not charged; anything else, a websocket upgrade included, is refused (403, fail closed) and recorded.
  3. **Bounds:** the request body, the requests in flight per session, idle time, lifetime, and a token valid for one session.
  4. **Admission,** synchronous: first the session cap (`--max-model-calls`), then `spendGemini`, which applies the policy, then the board's per-request provider-call admission, then the usage row fsynced.
  5. **Forwarding,** only after admission, with the real key; the response is streamed through.
  6. **The outcome,** recorded separately. It never changes the count, so an admitted request counts even when its outcome is unknown.
- **The capability.** The child gets `PANTHEON_AGY_RELAY_URL` and `PANTHEON_AGY_RELAY_CAPABILITY`, and a HOME that is a fresh directory of the session. `agySdkEnvOf` withholds every Gemini, Google Cloud, Vertex and ADC variable, even when `PANTHEON_AGY_ENV_PASS` names it, and drops any capability inherited from the parent's environment.
- **`agy-seat.py`.**
  - Without a loopback capability, it refuses before any Agent or client exists: `GEMINI_RELAY_CAPABILITY_ABSENT`, zero requests.
  - On a relay refusal, it ends the turn with exit 5 and keeps `result.json`, `progress.jsonl` and the partial output.
- **The board** (`run-item.mjs`):
  - It keeps the up-front policy check, made before the venv and key checks.
  - It replaces the one charge at spawn with the relay.
  - A refusal is recorded as `refused_metered`, and `provider_requests` equals the requests admitted.
  - Usage rows carry the request identity and the lineage (board run, seat, parent session, and a conversation that is root, subagent or unattributed).
- **The standalone launcher** `pantheon/bin/agy-seat.mjs` (`--gemini-api-primary N --gemini-usage FILE`) runs `agy-seat.py` through the same relay and `spendGemini`.

## The contract, requirement by requirement

| Requirement (owner's words, shortened) | Result | Evidence |
|---|---|---|
| L-150.1 Every actual request authorized and charged before transmission | PASSED | Each request reached the stand-in upstream with its own usage row already persisted (`chargedBefore`): CI cells and real proof P1, P2, P6a–c and P7. M2 (charge after forward) killed |
| .2 A launch is not one request | PASSED | Board: 5 requests, 5 rows, `provider_requests` 5; nothing charged at spawn. M1 (one charge per launch) killed |
| .3 The execution budget and the session's maximum count | PASSED | The budget cells; the session-cap cell (the board passes `--max-model-calls 40` as the relay's cap). M3, M9 killed; M11 (the run's provider-call bound charged once) killed |
| .4 A bounded channel; atomic admission | PASSED | Size, in-flight limit, token scoping and close (agent); idle and lifetime ("relay idle and lifetime bounds", added by the coordinator). M20, M21 killed |
| .5 Concurrent sessions and subagents share the budget | PASSED | One controller; two relays on one record; two processes; real P3 (two sessions for the last request: one). M10 killed |
| .6 Model, request identity, basis, usage, refusal, lineage recorded | PASSED, **one part UNVERIFIED** | Usage rows (model, identity, source, lineage), outcomes, refusals with codes. Subagent requests are attributed by the SDK's `sessionId` (M19 killed), but the subagent's **name** is not in the request and is not recorded (L-159) |
| .7 Failure, interruption, restart do not reset the budget | PASSED | SIGKILL of the seat, SIGTERM of the launcher, SIGKILL of the controller: rows kept, the last outcome "unknown", the restart refused (real P4). M8 (row refunded when the session dies) killed |
| .8 Exhaustion refuses without losing work or recovery state | PASSED | Seat: exit 5; result, progress and partial output kept. Board: `refused_metered`, the refusal on `run.json`, a restart counts the rows. M14, M15 killed |
| .9 Retries, streaming, continuations, subagents; unsupported paths fail closed | PASSED for observed paths | Real P6a (a 503 retry, continuations, a subagent with its own session), P6b (search), P6c (summarization). Nine unsupported paths and a websocket upgrade refused, nothing forwarded. M4 killed. Unobserved paths: L-158 |
| .10 Not 40 charges because a session could make 40 | PASSED | A 40-capable session with budget 3 was charged 3; a board run, 5 |
| L-151 Direct execution off by default; controller capability; same mechanism; no credential exception | PASSED | The direct cell (keys present, absent, a URL without token, a non-loopback URL): zero requests. Real P5. The launcher uses the same relay and `spendGemini`. M7, M18, M5 killed |
| Verify: three requests, budget 3 | PASSED | relay-three, real P1, board exhaustion |
| Verify: a 40-capable session, budget 3, never a fourth | PASSED | seat exhaustion, real P2 |
| Verify: concurrent sessions, the last request, exactly one | PASSED | three CI cells, real P3 |
| Verify: cancellation, crash, restart preserve spending | PASSED | CI crash cell, real P4 |
| Verify: direct Python without authorization, zero requests | PASSED | CI direct cell, real P5 |
| Verify: every supported SDK billable method covered | PASSED for every method the harness was seen to use | The rest are refused (L-158) |
| Verify: L-136, L-146, L-148 intact | PASSED | The integration gates (below); the L-136, L-146 and L-148 mutations that edit the changed modules are still killed |

## The real-SDK proof (the agent's run, once; not in CI, which has no SDK)

`node pantheon/tests/fixtures/l150-real-sdk-proof.mjs --python <venv> --work <dir>`: the real `agy-seat.py`, the real SDK, the relay, and a loopback stand-in upstream. The seat's `HTTPS_PROXY` pointed at a trap, which recorded nothing.

| Cell | Result |
|---|---|
| P1 | 3 of budget 3, the 4th refused |
| P2 | A 40-capable loop: exactly 3 |
| P3 | Two sessions for the last request: 1 |
| P4 | Seat killed, launcher stopped, controller killed: rows kept, restart refused |
| P5 | Direct run with keys or without: zero |
| P6a | A retry, continuations, a subagent: all charged |
| P6b | Search charged |
| P6c | Summarization charged |
| P7, budget 3 | `refused_metered` after 3 |
| Trap | No request left the host |
| **P7, budget 100** | **FAILED as written** |

P7 with budget 100 expected one critique launch of 5 requests. The real SDK joined the stand-in's text into a verdict the board could not parse, so the board launched the reviewer again: 10 requests over two launches, 10 rows, each charged before it was sent. The per-request invariant held. That a normal real-SDK board run completes in one launch is **unverified** (L-159).

## Mutations

| Runner | Result (each mutation against only the tests that decide it) |
|---|---|
| `pantheon/tests/l150-billing.mutate.mjs` (the agent's 18, plus the coordinator's M20 and M21) | baseline 19/19; **20/20 killed**, exit 0 |
| `l136-billing.mutate.mjs --only T1,T2,D7,K1,X1,X2,C1,B1,R1,R3,E1` | 11/11 killed |
| `l146-billing.mutate.mjs --only X1,K1,D1,C1,O1,B1,U1,P1,R1` | 9/9 killed |
| `l148-billing.mutate.mjs --only V5,V6,V7,V8,V9` | 5/5 killed |
| `wave3-agy-spend.mutate.mjs --only G6,S6,S7` (baseline 138/138) | 3/3 killed |

**The runners the change broke, repaired by the coordinator (`b9cbafb`).** L-150 removed the spawn charge and renamed `run` to `sdkRun` at the seat's identity check, so three targets stopped applying.
- L-136 T2 and wave 3 S6 now remove the relay's per-request `spendGemini`, keeping the run's own admission as the old edit kept `admit()`. Both are killed above.
- Wave 3 G6 targets the identity check as it now reads. The check itself is unchanged; G6 is killed above.

The agent reported T2. **It did not see S6 and G6, because its brief listed the runners to `--check` and left out the wave 3 runner.** Recorded in the lessons registry.

## The integration gates (coordinator, once, on the merged tree `b9cbafb`; Node 24; exit codes read directly)

| Gate | Result |
|---|---|
| `npm run test:proof` | **504/504**; 0 failed, cancelled or skipped |
| `npm test` | **1819/1819**; 0 failed, cancelled or skipped |
| `npm run test:gates:self` | **35/35** |
| `npm run test:gates` (run mode, every suite per file) | **every suite PASS** (model-client 62, ledger 47, pantheon 1710, proof 504, gates-self 35); `l150-billing` 10.8 s |
| `npm run test:lint -- --enforce` | exit 0, no unsuppressed finding. The 25 justified suppressions are unchanged; the local report listed 125 because the lint also walked the four agent worktrees inside the checkout (L-160) |
| CI on `b9cbafb` | push and pull_request: success |

**Targeted, before the gates:**
- The new tests on `12b02ec`'s code: 1/19 pass.
  - 8 relay cells and 5 launcher cells fail only because those modules are new.
  - **The behavioural failures:** the board charged once per launch ("the third request was refused by the run's own admission" fails), a session sent more than its budget ("never a fourth" fails), and `agy-seat.py` ran on the environment key (the direct cell fails).
  - The agent's investigation adds that the base seat with `GEMINI_API_KEY` set sent 6 requests, all uncharged.
- The new tests on `b9cbafb`: 19/19.
- `check-ownership`: 20 files, 0 problems.
- `--check` on all five runners: 26, 19, 20, 20 and 25 targets, each exactly once.

## Existing tests changed by the agent (each to a stronger property)

- `l136-billing`'s SDK cell: no charge at spawn; no key reaches the seat; one relayed request arrives already charged and carries the controller's key; `provider_requests` is 1.
- `reliability-r3-a3` L-410: the capability is given and the key withheld, even when `PANTHEON_AGY_ENV_PASS` names it; `credentials` is `[]`.
- `wave3-agy-guard` C: `provider_requests` 1 now means one request the relay admitted.

## Decisions made by the coordinator

- **`turn()` in `run-item.mjs`.** `laneCharged = 1` became `+= 1`, outside the SDK branch the region limit named. The design's per-request admission needs it, so it is accepted; the manifest records the amendment. This is the fourth instance of lessons class `brief-manifest-disagree`.
- **The behaviour changes D2 decided:**
  - the SDK child's HOME is a fresh directory of the session, which also changes the environment of its `run_command`;
  - Vertex through the SDK seat is refused (L-156);
  - the session cap counts every request, retries included, so it is stricter than the SDK's own count.

## Blockers and open entries

- **L-155 (pending owner): a key read by the seat's shell.** The seat's agent has an unsandboxed `run_command`. As the same user, it can read the controller's `GEMINI_API_KEY` from `/proc/<pid>/environ` and send requests itself, outside the relay. This was so before L-150, when the key was in the seat's own environment, and it is narrower now. Options:
  - sandbox the seat's `run_command`, through the verify jail or the SDK's own sandbox;
  - keep the key out of the controller's exec environment;
  - accept it under L-004.
- **L-156 (open): Vertex through the SDK seat is refused.** The controller has no ADC token to forward with.
- **L-157 (open): the relay behind a proxy.** The relay forwards with Node `fetch`, which ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`.
- **L-158 (open): explicit blockers.** These call paths are compiled into the harness but were not seen in use. Each is refused, and recorded, with nothing forwarded:
  - the Live API (websocket);
  - Files upload, cachedContents, batches, embeddings, tuned models and `v1internal`;
  - `generate_image`, whose tool is disabled.
- **L-159 (open): two claims not shown.** The subagent's name is not recorded; P7 with budget 100.
- **L-160 (open): the lint walks the agent worktrees** under `.claude/worktrees/`.

## Future tickets (nonblocking)

1. Vertex through controller-held ADC (L-156).
2. Run the relay's forwarding through the environment's proxy by default (L-157).
3. A stand-in reply the board parses, so P7 shows a one-launch run (L-159).
4. Skip `.claude/` in `lint-tests.mjs` (L-160).
