# Assignment 3: One gateway: the model gateway and the python SDK seat

**Scope:** the model gateway, the seat session, the board's python SDK seat, the one billing path, credential isolation.
**Testing:** source inspection and local fakes only (a loopback upstream; synthetic keys). No live provider.

## Where to look

- `pantheon/src/antigravity/gateway.mjs`, `seat-session.mjs`
- `pantheon/src/board/run-item.mjs`, `agy-cli.mjs`, `pantheon/bin/agy-seat.mjs`, `pantheon/scripts/agy-seat.py`
- `pantheon/src/route/gemini-billing.mjs` (`spendGemini`)
- the deleted relay, for comparison: `git show 32f9fd4:pantheon/src/route/gemini-relay.mjs`
- tests: `pantheon/tests/antigravity-gateway.test.mjs`, `l150-billing.test.mjs`

## Questions

1. **One billing path.** Can any Gemini request of the seat reach the upstream without passing `spendGemini`, or be charged late or twice?
2. **The relay's protections.** Which protection of the deleted relay does the gateway lack or do differently (upstream check, method and query allow-list, body validation, request cap, concurrency, idle and lifetime, outcome record, token check, abort)?
3. **The key.** Can the session learn the real key: from a response, an error, a redirect, a file, its arguments, or the controller's own process?
4. **Refusals.** Which refusals are answered with a status the SDK's harness retries, and what does each retry cost?
5. **The account.** Does the session's account say truthfully what was charged, refused and failed?
6. **Tests.** Name any property whose test still passes with the property removed.
