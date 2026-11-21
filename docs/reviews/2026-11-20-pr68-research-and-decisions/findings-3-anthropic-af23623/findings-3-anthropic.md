## Review of f4bd6bc at af23623 (relay retired, python seat on the gateway)

No request reached the upstream uncharged, charged late, or charged twice in anything I ran. The defects are at the edges: redirects, refusal statuses, the session's account, and lifetime. Scratch checkout: `/tmp/claude-0/-home-user-OPHANIM/0c68b45d-d13a-54b8-88c4-e615fa8b38a0/scratchpad/review-3` (clean; repro scripts in `.../scratchpad/r3out/`). Synthetic keys only, local fake upstream only.

### 1. Findings

**F1. The real key follows a redirect to an origin the upstream rule never checked.** DEFECT (the UPSTREAM claim, `gateway.mjs:21-22`, is checked only at start). `gateway.mjs:260` and `:113` call `fetch` with default redirect handling. Repro: upstream `127.0.0.1:A` answers 307 to `localhost:B`. B received `x-goog-api-key` equal to the real key; the seat got 200; one usage row. The relay did the same, so not a regression. Not recorded.

**F2. Two final refusals are answered with statuses the harness retries.** DEFECT, differs from relay. `PANTHEON_SESSION_CAP` is 429 (`gateway.mjs:230`; relay 403) and `PANTHEON_SESSION_EXPIRED` is 503 (`:199`; relay 401). Repro: real `agy-seat.py` over the stub SDK.
- `maxRequests: 2` gave wire `[200, 200, 429, 429, 429, 429]`.
- `lifetimeMs: 1` gave `503` four times.
- Nothing was charged; the seat exits 5 after the retries.
- `l150-billing.test.mjs:198` and `:452` assert 429 and 503, so the tests pin it. This is the reasoning the commit applied to the refused charge (403) and not to these. Not recorded.

**F3. The session's account reports charged requests as "refused… nothing was charged for it".** DEFECT. `seat-session.mjs:132` lists every row with a `refusal`, and `:63` gives the default recovery text. `gateway.mjs:292` sets `refusal` on a request that was admitted and then failed.
- Unreachable upstream: 502, 1 usage row, yet `summary().refused` says "refused on the wire… nothing was charged for it".
- Client hang-up mid-flight: same.
- `seatAccounting().refused` (`:86`) counts them as refused: 2 where 1 was charged.
- Read only: a stop after the charge (`gateway.mjs:248`) gets the same text.
This account is written to `gateway-session.json` and the seat's `result.json`. Not recorded.

**F4. Lifetime does not end a request in flight.** DEFECT, differs from relay (which timed the upstream call to the session's expiry). `gateway.mjs:146-152`, `:255`; `seat-session.mjs:137` passes no `requestTimeoutMs`. Repro: `lifetimeMs: 300`, hanging upstream. At 2500 ms the request was still in flight and `expired` was still null. It is bounded only by the 10-minute default or the caller's close. Not recorded.

**F5. An oversized body is never answered 413; the l150 test supplies the expected code itself.** DOC MISMATCH plus a test passing for a different reason. `gateway.mjs:205` destroys the request before refusing. Repro: 4 KB and 200 KB bodies against a 1 KB bound gave `UND_ERR_SOCKET` and `ECONNRESET`; not charged. `docs/billing-policy.md:191` says 413. `l150-billing.test.mjs:227` falls back to the literal `"PANTHEON_REQUEST_TOO_LARGE"` on a cut. Renaming the code at `gateway.mjs:205` left l150 at 19/19; the gateway test caught it.

**F6. Claims with no deciding test.** Each edit below left both files green (30/30, 19/19), and no other non-mutate file under `pantheon/tests` or `ophanim/operate` names any of them:
- `run-item.mjs` ~642: `lifetimeMs: (timeoutS + 60) * 1000` removed.
- same line: `maxRequests: SDK_MAX_MODEL_CALLS` set to 100000 (doc line 363 says "bounded by… 40").
- same call: `outcomes: gateway-outcomes.jsonl` removed (doc step 7).
- `agy-seat.py:342`: `os.environ.pop` of the withheld names replaced by `pass`.
- `agy-seat.py:257`: `PANTHEON_SESSION_CAP` and `PANTHEON_SESSION_EXPIRED` removed from `FINAL_REFUSALS`.
- `gateway.mjs:99`: `fsyncSync` removed.

**F7. The seat can read the real key from the controller's environment.** REQUIREMENT gap ("never the real key"), not a regression. Both `run-item.mjs` and `bin/agy-seat.mjs` spawn the seat unjailed at the same uid, and the agent has `RUN_COMMAND` under `allow_all`. Repro through the launcher: the seat's own env had 0 key lines; `/proc/$PPID/environ` had the synthetic key. Not in the L-entries I was allowed to read.

**F8. Comment mismatch.** `agy-seat.py:369-372` says every model, the image model included, "is reached through the gateway"; the gateway refuses any model but the seat's with 403 (`gateway.mjs:220`), and that code is not in `FINAL_REFUSALS`. Read only. Partly L-158.

### 2. Relay protections and the gateway

| Protection | Gateway | Line |
|---|---|---|
| Upstream host check | yes at start; redirects followed (F1) | 135, 260 |
| Method allow-list | yes, stricter (v1beta only, no countTokens, seat's model only) | 165, 194, 217-220 |
| Query allow-list | yes | 196-197 |
| Body must be a JSON object | yes | 211 |
| Body size | differs: connection cut, no 413 (F5) | 205 |
| Session request cap | yes; status differs (F2) | 228-235 |
| Concurrency cap | yes | 201-203 |
| Idle / lifetime | differs: checked on arrival only, no timer, in-flight not cut (F4), 503 not 401 | 146-152, 199 |
| Durable outcome record | yes; no response id or `interrupted`; charged failures read as refusals (F3) | 96-100, 154 |
| Token check | yes | 172-178 |
| Websocket upgrade | yes, as a plain 404 | 194 |
| Client abort | yes; the charge stands | 256, 291-297 |
| Refused charge is 403 | yes | 243 |

### 3. Checked and found sound

- Charge before forward: taking the cap unit after the charge, or answering 429, fails tests in both files; `chargedBefore` asserts it at the fake's edge.
- Cap unit returned on a refused charge: removing `admitted -= 1` fails the gateway test.
- Unwritable usage record: fails closed. Three 403s, 0 forwarded, cap `admitted: 0`. The caller's `admit()` still ran each time (unchanged `spendGemini` order), and `billingRefusal` is null, so the board reports a generic exit 5.
- Stop readings 2 and 3: removing either fails a gateway test.
- Concurrency slot freed, idle bound passed, `HOME` replaced, wire refusals on the account: each removal fails a test.
- No second billing path: no reference to the relay's names remains outside comments (grep); the board and launcher both go through `openSeatSession` to `spendGemini`.
- No key echo: response headers are fixed (`gateway.mjs:262`), and the outcome test asserts neither key nor token is in the file.
- The l150 crash, cancel, controller-kill and restart cells assert what their names say (read).

### 4. Could not check

- The real SDK: no venv on this host, so `l150-real-sdk-proof.mjs` was not run. The retry behaviour in F2 is the stub's model of the harness; real backoff is unknown.
- How the real harness passes the token to `localharness` (argv or not).
- Any `*.mutate.mjs` runner (forbidden), the whole suite, and the pipeline's real-SDK contract suite.
- Durability of the outcome fsync under a crash.
- L-labels: I read only L-156 to L-159, L-724, L-736; none records F1 to F7.
