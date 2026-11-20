# The Gemini billing policy

Register L-136, extending L-124, register L-146 (the operator scripts) and register L-148 (the view server and its
launchers). The owner's decisions of 2026-11-19 and 2026-11-20 are the acceptance test (`docs/OPEN-LIMITATIONS.md`, "Owner
decisions, 2026-11-19 (L-136, after wave 3)", "Owner decisions, 2026-11-20 (L-146)" and "Owner decisions, 2026-11-20
(L-148)"). This page is the single description
of the policy as implemented; the code that resolves and enforces it is `pantheon/src/route/gemini-billing.mjs`,
re-exported by `pantheon/src/route/quota-failover.mjs` (the L-124 mechanism it extends, not a second one).

## The two settings

| Setting | Kind | What it admits | Default |
|---|---|---|---|
| `metered_gemini_failover` | `failover` | the metered Gemini API answering an Antigravity lane's **proven quota refusal** (and every further request of that answer: a long-decode hop, a compaction) | off |
| `gemini_api_primary` | `primary` | **primary Gemini API or SDK execution**: a Gemini API id seat with no lane in front of it, an operator's or a ticket's Gemini API pin, the `fit` implementer's Antigravity SDK session in the pipeline (`src/antigravity/`: each model request of the session, its native subagents' included), the board's python Antigravity SDK seat (`scripts/agy-seat.py`, billed to `GEMINI_API_KEY` or Vertex), a Google seat of an injected `--turn` module that is not a declared lane (every Google call of a module that declares its Gemini calls metered), an operator script's Google seat (L-146, below) | off |

- Both are **off when absent**. Each is enabled only by an explicit CLI flag or a supported configuration setting.
- **No environment variable and no credential authorizes spend.** A `GEMINI_API_KEY`, `GOOGLE_API_KEY` or Vertex project in
  the environment is never read by the policy. With a key present and nothing declared, every billed Gemini request is refused.
- **Enabling requires a declared budget**: a positive integer of **billed Gemini requests** of that kind. Enabling without one
  (or with zero, a word, a negative or a fraction) is refused at startup with `GEMINI_BILLING_INVALID`; nothing runs.
- **The settings are independent.** The failover switch never admits a primary seat, and the primary setting never admits a
  failover.
- **The subscription lanes are never refused.** The Antigravity CLI lanes (`agy`, the OAuth subscription) make no billed
  Gemini request; neither setting gates them.

The resolved policy is `{schema, metered_gemini_failover: {enabled, budget, source}, gemini_api_primary: {enabled, budget,
source}, digest}`. `source` says where each setting was declared (`flag --gemini-api-primary 5`, `service config … billing.
metered_gemini_failover`, `live-run manifest billing.metered_gemini_failover`, or `default: absent, off`). `digest` covers
what is enforced (enabled and budget of each kind), not where it was declared.

## Where each entry point takes it

| Entry point | Source | Budget scope (the persisted record consumption is counted from) |
|---|---|---|
| `ophanim/operate/cli.mjs tick`, `watch` | flags `--metered-gemini-failover N`, `--gemini-api-primary N` | the work ledger: its `work.billing` entries, every item and run |
| `ophanim/operate/cli.mjs serve` (`service.mjs`) | config `billing: {metered_gemini_failover: {enabled, budget}, gemini_api_primary: {enabled, budget}}` | the work ledger, as above |
| `ophanim/operate/live-run.mjs` (not one of the seven; same policy) | manifest `billing.gemini_api_primary` (must be true: a `fit` run's Google implementer is a primary seat) with `billing.gemini_primary_budget`, and `billing.metered_gemini_failover` with `billing.metered_gemini_budget` (required exactly when it is true) | the run's isolated work ledger |
| `pantheon/bin/pantheon-board.mjs run`, `resume` | the two flags | the board run: `<board>/gemini-billing.jsonl` (its cycle review and a paired counterpart included); `resume` of the same board continues it |
| `pantheon/bin/pantheon-compare.mjs` | the two flags | the whole comparison: `<dir>/gemini-billing.jsonl` (every ticket, both arms, the cycle reviews) |
| `pantheon/bin/pantheon-review-cycle.mjs review`, `resume` | the two flags | the cycle ledger: `<ledger>/gemini-billing.jsonl`; `resume` continues it |
| `pantheon/scripts/run-review.mjs --via api` (`src/review-runner/index.mjs`) | the two flags | the review: `findings-<n>-<lab>.gemini-billing.jsonl` beside its transcript; `--continue` continues it |
| `pantheon/bin/cross-lab-review.mjs <dir>` (L-146) | the two flags | the review directory: `<dir>/gemini-billing.jsonl`; a re-run on the same directory continues it |
| `pantheon/scripts/live-ship.mjs` (L-146) | the two flags | the board: `<dir>/gemini-billing.jsonl` |
| `pantheon/scripts/live-check.mjs`, `stream-check.mjs`, `view-check.mjs` (L-146) | the two flags and `--gemini-usage FILE` | the file the operator names: required to enable either kind (`GEMINI_BILLING_INVALID` without it), so whether a budget spans invocations is the operator's choice; no default location |
| `pantheon/bin/pantheon-view.mjs` (L-148), and through it `scripts/swarm-run.mjs` and `discuss-run.mjs` | the two flags, on the **server's** command line only (`--gemini-usage` is refused) | the seat home it serves: `<PANTHEON_HOME>/view/gemini-billing.jsonl`, shared by every request, every restart and every server process on that home |

Each invocation declares its own policy: a run that passes no flag runs with both kinds off, whatever an earlier run
declared. The policy every billed request ran under is recorded with it (below), and consumption is never reset.

## At the point of spend

Before **every** billed Gemini request (the first request of a turn, each continuation hop, a retry after a 429 or a 5xx,
the spawn of the python SDK seat), in this order (`spendGemini`):

1. **The policy admits it** (`geminiAdmission`): refused when the kind is off, or when the persisted usage of that kind has
   reached its budget. Nothing is admitted, charged, spawned or sent.
2. **The caller's own admission**: its provider-call bound and its charge (`admitRequest`, `admitProviderCall`, `charge`).
   A refusal there also means nothing is sent.
3. **The usage row is persisted** on the billing ledger (fsynced file, or a signed work-ledger entry).
4. Only then is the request sent.

A seat that could only be served by a billed request is also refused up front, before its client is made or anything is
charged (the API seat in `board/run-item.mjs turn()`, a Gemini seat with no lane in `sdk/agy-turn.mjs`, the python SDK
seat before its venv and key checks, an operator script's or the view server's Gemini client in `sdk/live.mjs
operatorGemini`), so a missing
key never masks the policy's refusal.

### Refusal codes

| Code | When |
|---|---|
| `METERED_GEMINI_DISABLED` | a failover request, `metered_gemini_failover` off |
| `GEMINI_PRIMARY_DISABLED` | a primary request, `gemini_api_primary` off |
| `METERED_GEMINI_BUDGET_EXHAUSTED` | either kind, its budget spent; the refusal carries the kind, the budget and the recorded usage |
| `GEMINI_BILLING_INVALID` | at startup: an enabled setting without a positive-integer budget, a budget without its setting, an unknown key |
| `GEMINI_USAGE_LOCKED` | a standalone usage record whose lock a live process has held for more than 30 s: the usage cannot be counted, so the request is not sent (`provider_requests: 0`) |
| `METERED_FAILOVER_DISABLED` | the validator's existing pending code when its seat was refused for the failover-off case (kept; the other refusals keep their own code) |

Every refusal carries `provider_requests: 0` and a `billing` record (kind, setting, source, budget, policy digest). A lane's
quota refusal whose failover the policy refused keeps its own code and status (429), so routing still treats it as a quota
refusal, and is marked `quota_failover: {used: false, disabled: true | code, refused}` with the same `billing` record.

## The records

| Where | What |
|---|---|
| work ledger `work.billing` (operate, live-run) | one signed entry per billed request, under its claim, before it is sent: item, stage, attempt, kind, setting, vendor, model, purpose, role, transport, request, source, budget, policy digest, used before. Its re-derivation enforces the budget under the ledger's append lock: the entries of that kind before it, on the whole ledger, are fewer than its declared budget |
| work ledger stage record, `usage.gemini` | the policy in force, the billed requests of the stage by kind, its rows and its refusals |
| `run.json` `billing` (runOpenItem: board, compare, operate's argo path) | the policy, every usage row and every refusal, appended as they happen; each refused seat is also an attempt with `code` and `provider_requests: 0` |
| `<…>/gemini-billing.jsonl` | the standalone runs' usage record: one JSON line per billed request, appended and fsynced before it is sent; a line that does not parse fails closed (no request is admitted). The count and the append are one step under the record's exclusive lock (`<record>.lock`, L-148): the usage of the row's kind is re-derived under it just before the append, and the request is refused (`METERED_GEMINI_BUDGET_EXHAUSTED`, nothing sent) when that count has reached the budget, so processes sharing a record cannot overspend it. The lock is the seat lock's protocol (`src/seat/lock.mjs`): a holder that is provably dead (its pid gone, or reused) is reclaimed, a live one never; a live holder kept past 30 s refuses the request (`GEMINI_USAGE_LOCKED`, nothing sent) |
| `pantheon-view` (L-148) | `<PANTHEON_HOME>/view/gemini-billing-runs.jsonl`, the authorization history: a `start` line at every start (the policy with its source, the record's path, the usage already recorded), a `refusal` line when each refusal is made (code, kind, model, purpose, source, budget, recorded usage, `provider_requests: 0`, the recovery condition), an `exit` line when the server stops (SIGINT and SIGTERM end it through `exit`); printed too (`gemini_billing_start`, `gemini_billing`). Only ever written: nothing reads it to authorize anything |
| operator scripts (L-146) | a `gemini_billing {…}` line printed whenever the process exits (the policy with its source, the record's path, the usage per kind, the rows with model and purpose, the refusals with code); with a run directory also appended to `<dir>/gemini-billing-runs.jsonl`, one line per invocation; a refused cross-lab seat is `<dir>/review-<vendor>.refused.json` (its code, `provider_requests: 0`, the billing record), never a review |
| review transcript | each billed request's `provider_call` event carries `gemini {kind, setting, source, budget, used_before, remaining_after}`; a refused one is a `provider_call_refused` event; `gemini_billing` holds the policy, rows and refusals; the findings header names the policy |
| bins' printed JSON | `gemini_billing`: the policy, the record's path, the usage per kind, the refusals |

## Retries, restarts and the service

- **Consumption is derived from the persisted record, never from process memory.** A restart, a resumed attempt, a later
  `serve` tick, a `pantheon-board resume`, a `pantheon-review-cycle resume` or a review `--continue` counts what is
  already recorded; a killed process's billed request was recorded before it was sent, so it counts too.
- **A view server's restart (L-148).** Authorization is declared on the command line at each start; with no flag Gemini
  is off, whatever an earlier start authorized and whatever the record or the history holds. `--gemini-api-primary N` is
  the **cumulative** ceiling over the record of the seat home: with 6 requests charged before, a restart with `N = 10`
  admits exactly 4 more, and a restart with the same `N` admits none once it is spent. Only an explicit larger `N` admits
  more; historical usage is never erased. A different `PANTHEON_HOME` is a different set of seats with its own record.
- **A refused stage keeps its work.** A lifecycle stage in which the policy refused a billed request, and which did not
  pass or return, is recorded `pending` on a transient blocker (code: the refusal's; role `decision-authority`) that
  carries the settings of the refused kinds it was refused under. Its outputs (the plan, the cycle, the board, the
  pipeline record) stay on the record; it is never turned into a failure that sends the work back. Its blocker says how
  many requests of the stage had been billed before the refusal (none, when it was refused before any).
- **A retry under the same policy is refused again.** The pending is retried when due (`retry_after_ms`); the billed
  request is refused again before it is admitted (a lane whose quota has reset needs no failover and answers). Refusals
  under the same settings count against the stage's attempt bound.
- **A changed policy wakes it at once.** When a later run declares a different setting (enabled, or another budget) for a
  kind that was refused, the scheduler dispatches the pending stage immediately, through the transient pending's own
  retry route, and refusals recorded under the earlier settings do not count against the attempt bound of the new ones.
  The live-run launcher applies the same test before it decides there is nothing to dispatch: a manifest that declares
  another budget re-dispatches the refused stage at once, and its plan names the wake (`gate.billing_wake`).
- Standalone runs keep their own recovery: a board item that was not shipped is still Ready and is run again; a review
  cycle with a refused seat stays open for `resume`; an incomplete review run is continued with `--continue`; a refused
  cross-lab seat is run again alone on the same directory with the setting declared (its other labs' reviews stay).

## The `fit` implementer on the Antigravity SDK transport

Under `fit` the Google implementer is a session of the official `google-antigravity` SDK on the Gemini API
(`pantheon/src/antigravity/`, `pipeline/turns.mjs`). It is primary Gemini execution, with no lane in front of it and no
failover behind it:

- The policy is asked before the session is started. With `gemini_api_primary` off, or its budget spent, no session is
  prepared or spawned, nothing is admitted or charged on the Gemini side, the provider is not contacted, and the unit
  blocks on that refusal. The attempt is not free: the pipeline has by then asked its dispatcher once for the unit (a
  provider call of another lab, charged on the work ledger) and made the unit's worktree and run branch, and each retry
  under an unchanged policy does so again (register L-722).
- Every billed request of the session is one billed request of kind `primary`: the implementer's own and each native
  subagent's, by the model it asked. The controller's model gateway admits each through this policy, then through the
  pipeline's own call bound, and the usage row is persisted before the request is forwarded.
- A budget that runs out inside a session refuses that request (it is not sent) and blocks the unit, whether the
  session then fails or ends well: the controller keeps the refusal, and does not rest on what the runtime does next.
  The work of that attempt is not kept; once the policy admits it again the session is asked for from the start
  (register L-724).
- The budget is not reserved per session. Concurrent sessions draw on it request by request, so a budget smaller than
  they need together can be spent with no unit completed.
- A usage row that cannot be persisted (the record refuses the append, or a live process keeps it locked) means the
  request is not sent. The session ends and the unit blocks under the run's call-bound code, not a billing code
  (register L-723).

## The board's Antigravity seats

The board's reviewer and scout now default to the Antigravity **CLI lane** (the subscription), as the planner and the
implementer always did. `PANTHEON_AGY_TRANSPORT=sdk` still selects the python SDK seat for those two roles, and that seat
is primary Gemini execution: refused unless `gemini_api_primary` is enabled with a budget.

## Injected modules

- `--clients MODULE`: the module replaces the SDK clients; the policy is enforced before any client is asked (runOpenItem's
  `turn()`, the pipeline's failover), so a fake or a real client is admitted the same way.
- `--turn MODULE` (board, compare, review-cycle, operate): the entry point cannot see the module's requests. A call on a
  Gemini seat that is not a declared Antigravity lane is treated as primary Gemini API execution, **one billed request per
  call**, admitted and recorded before the module is called (`sdk/live.mjs billedTurnModule`). A lane-named seat passes
  through as the module's lane; the call's own billing context reaches the module, so a module built on `liveTurn`
  applies the failover policy itself.
- A module that **declares its Gemini calls metered** (`turn.meteredGeminiApi = true`) has no lane: every call it makes on
  a Gemini seat is charged as primary, a lane-named seat included. `bin/cycle-review-http-turn.mjs` declares it: it sends
  every `agy_google` call to the Gemini API whatever the model is named, so passing a lane-named model (among them
  `pantheon-review-cycle`'s default Google seat) through as a subscription lane billed the metered API outside the
  policy (L-146). A declaration can only add charges.

## Operator scripts (L-146)

`pantheon/bin/cross-lab-review.mjs` and `pantheon/scripts/live-check.mjs`, `live-ship.mjs`, `stream-check.mjs` and
`view-check.mjs` take the policy through one helper, `sdk/live.mjs operatorGemini`, built on the mechanism above
(`billingFlagsFromArgv` in `route/gemini-billing.mjs` over `billingFromFlags`; `geminiBilling`, `geminiUsageFile`,
`spendGemini`). No script has its own admission, count or record. Invoking a script authorizes nothing.

- **Flags**: `--gemini-api-primary N`; `--metered-gemini-failover N` is accepted and authorizes nothing here (no seat of
  these scripts fails over from a lane); `--gemini-usage FILE` where the script has no run directory. A malformed flag, an
  enabled kind without its record, or `--gemini-usage` beside a run directory is `GEMINI_BILLING_INVALID`: exit 2,
  nothing runs.
- **The four SDK scripts** build their clients through `clientFor(vendor, {model, purpose})`: a Gemini client is admitted
  as primary **before** it is made, so a present key, a missing key and a proxy placeholder all give the policy's refusal
  and no request; every generation request the client sends afterwards (each turn's first, each continuation hop, a
  retry) is spent through `spendGemini` before the SDK sends it. Other labs' clients are unchanged. `view-check` gates its
  own client factory over the shared `src/view/server.mjs`, which `bin/pantheon-view.mjs` now gates the same way (L-148).
- **cross-lab-review** calls the HTTPS module through `billedTurnModule` (the module's declaration above): one billed
  request per Google seat, charged before the module is called; the other labs' seats run as before. A refused seat
  writes `review-<vendor>.refused.json`, never a review, and the exit status is 1 as for a failed seat.
- **Reachability** (`pantheon/tests/l146-billing.test.mjs`): every path's Google client is gated; the routes that can be
  reached without editing a script are tested. In `live-ship`, the planner and implementer seats that fall through to the
  appended `agy_google` seat are reachable (and its same-seat retry after a 5xx); the `agy_google` scout is commented out
  (`SCOUTS = ["xai"]`) and an `agy_google` reviewer cannot be paired with the `openai` maker.

## The view server and its launchers (L-148)

`pantheon/bin/pantheon-view.mjs` takes the policy through the same helper (`operatorGemini`, in its long-running `serve`
mode) and enforces it **in the server process, at the provider-call boundary**: `src/view/server.mjs runTurn` calls the
client factory for every turn, whoever sent `POST /turn` (the view page's panes, `swarm-run`, `discuss-run`, any local
client), and that factory is `clientFor`. A Gemini seat's client is admitted before it is made, and each generation
request is charged on the record before it is sent; other labs' clients are made once and reused, unchanged.

- **Flags**: `pantheon-view [port] --gemini-api-primary N`; `--metered-gemini-failover N` is accepted and authorizes
  nothing (no seat of the view fails over from a lane); `--gemini-usage` is refused (the record has a fixed home). A
  malformed or unbudgeted flag: `GEMINI_BILLING_INVALID`, exit 2, the server does not listen.
- **Nothing a client sends is authorization.** The factory is given the turn's vendor, model and seat, never the request:
  a body field (`gemini_api_primary`, `budget`, a flag name) or a header neither enables billing nor widens the declared
  budget. Environment keys, a proxy-held credential (no key: the same refusal) and an authenticated Google session (ADC,
  Vertex) authorize nothing either.
- **Concurrent requests share one budget.** All turns of one server share one billing context and one record. Within the
  process the count and the append are synchronous (`spendGemini`: no await between them, so no other turn runs in
  between); across processes on one seat home the record's lock re-derives the count before the append (above). Of k
  remaining requests, exactly k are sent.
- **Refusals**: `runTurn` publishes the refusal's `code` and its `recovery` condition on the bus `error` event (the pane)
  and returns them in the `/turn` result (`results[i].code`, `results[i].recovery`): `restart pantheon-view with
  --gemini-api-primary N` (off), or `the gemini_api_primary budget of N is spent (U of N recorded at <record>); restart
  pantheon-view with a larger --gemini-api-primary N` (spent). The other seats of the same request are unaffected.
- **The launchers** (`scripts/swarm-run.mjs`, `discuss-run.mjs`) are HTTP clients of the server and hold no billing
  authority: a billing flag given to them is refused at startup (`GEMINI_BILLING_INVALID`, exit 2: "Gemini billing is
  authorized only by that server"). A seat the server refused is printed (`gemini_refused {seat, layer|round, code,
  recovery}`) and recorded as that seat's failed turn, led by its code and recovery; the swarm or the discussion goes on
  as for any failed seat. Their seat labels are identifiers (`<seat>.swarm.<layer>`, `<seat>.discuss`): the server
  refuses any other label with 400, so before L-148 none of their seats, Gemini or not, reached a provider.

## The research team on the Antigravity SDK transport

A research team (`ophanim/operate/research.mjs`, `pantheon/src/antigravity/research.mjs`; owner direction 2026-11-20) is
read-only sessions of the same SDK transport: a coordinator on the role's seat (`gemini-4-carbon`) and specialists on
`gemini-4-hydrogen`. Every one of them is primary Gemini execution, purpose `research`:

- The policy is asked before a team is prepared. With `gemini_api_primary` off, or its budget spent, no directory is
  made, no session is started, no team is recorded, and the request for research stays open on the work ledger. The plan
  stage that was to run it ends pending on that refusal, and the scheduler wakes it when the launcher's policy changes
  (the billing wake above). The planner is not asked meanwhile.
- Every billed request of every member, at every level of the team, is one billed request of kind `primary`: this
  policy first, then the plan stage's provider-call bound and its charge on the work ledger, then the usage row
  (`work.billing`, purpose `research`, with the research role), all before the controller's model gateway forwards it.
  The team has its own bound on requests as well (`research.bounds.max_requests`), shared by concurrent and nested
  members; it is checked first and adds no authorization.
- A budget that runs out inside a team refuses that request (it is not sent) and stops the team without a conclusion.
  Members that finished are kept: their records are on the ledger and in the item's state, and the next run reuses them
  and pays only for the rest. The spending is counted from the ledger and is never reset by a restart or a resume.
- A planner's "insufficient evidence" answer starts research only where `gemini_api_primary` is declared and the
  executors were built with research on (the launchers of this repository do that); otherwise nothing is requested.
- The budget is not reserved per team: teams of several items, and the `fit` implementer, draw on the same
  `gemini_api_primary` budget request by request (register L-731).

## Every billed Gemini path

| Path | Kind | Status |
|---|---|---|
| `sdk/agy-turn.mjs laneFirstTurn`: a lane's quota failover, and its further requests (`sdk/live.mjs` API seat) | failover | admitted per request |
| `sdk/agy-turn.mjs laneFirstTurn`: a Gemini seat with no lane | primary | refused up front unless admitted; then per request |
| `sdk/live.mjs apiTurn` (review-cycle, compare cycle review) | primary | per request |
| `sdk/live.mjs billedTurnModule` (`--turn` modules, e.g. `bin/cycle-review-http-turn.mjs`) | primary | one billed request per call on a non-lane Gemini seat, and on every Gemini seat of a module that declares its Gemini calls metered (`cycle-review-http-turn.mjs`: L-146) |
| `pipeline/turns.mjs` implementer failover, and its further requests | failover | per request |
| `pipeline/turns.mjs` single-turn seats (dispatcher, reviewer, subagent) | as their turn | the stage's context rides with each call |
| `pipeline/turns.mjs` SDK implementer (`fit`: a session of the Antigravity SDK transport, `src/antigravity/`): the implementer's requests and its native subagents' | primary | refused before the session is prepared unless admitted; then per request at the controller's model gateway, each usage row persisted before the request is forwarded |
| `ophanim/operate/research.mjs runResearch` (a research team: the plan stage's requested research and its research on the planner's gaps): the coordinator's requests and every specialist's, at every level | primary (purpose `research`) | refused before the team is prepared unless admitted; then per request at the controller's model gateway, after the team's own request bound and before the stage's call bound, each usage row persisted before the request is forwarded |
| The SDK transport's model metadata requests (`GET models/<id>`: the availability check before a session; the dry run of `ophanim/operate/live-run.mjs`, `sdkPreflight`) | none (not a generation request) | the availability check is made only for a seat the policy admitted; the dry run sends them with the manifest's key and spends nothing. Not observed against the live provider (L-701) |
| `board/run-item.mjs` walk (`routeSeats`): the lane's quota-failover candidate | failover | skipped unless admitted |
| `board/run-item.mjs turn()`: a Gemini API seat (failover candidate, operator seat, ticket pin) | failover or primary | refused up front unless admitted; then per request |
| `board/run-item.mjs agyTurn` python SDK seat (`PANTHEON_AGY_TRANSPORT=sdk`) | primary | refused before the venv and key checks unless admitted; admitted again at the spawn, **one billed request per spawn**: the seat's agent may then make up to `--max-model-calls` (default 40) model calls, and its subagent its own, which the record does not count (L-148 inventory) |
| `review-runner/index.mjs --via api`, Google reviewer | primary | per request, retries included |
| `pantheon/scripts/open-items-run.mjs`, `bin/pantheon-build.mjs` / `view/build-server.mjs` (runOpenItem, not among the seven) | either | both kinds off: refused; no opt-in is exposed there |
| `bin/cross-lab-review.mjs` (the HTTPS module through `billedTurnModule`) | primary | one billed request per Google seat, charged before it is sent; refused up front unless admitted (L-146) |
| `scripts/live-check.mjs`, `live-ship.mjs`, `stream-check.mjs`, `view-check.mjs` (`sdk/live.mjs operatorGemini clientFor`) | primary | refused before the client is made unless admitted; then per request, hops and retries included (L-146) |
| `bin/pantheon-view.mjs` (`POST /turn` on an `agy_google` seat, from the view page, `scripts/swarm-run.mjs`, `discuss-run.mjs` or any local client) | primary | refused before the client is made unless admitted; then per request, charged on the seat home's record before it is sent, under its lock across processes (L-148) |
| `scripts/delegate-run.mjs` (a client of the same server) | none | no Google seat (anthropic, openai, xai); a Google seat added there would be gated by the server as above. Its labels are refused with 400 (the defect the two launchers had) |
| `scripts/agy-seat.py` run **directly** (`.venv-antigravity/bin/python scripts/agy-seat.py --role …`, as its header shows) | primary | **not gated**: the script checks only that `GEMINI_API_KEY` or `PANTHEON_AGY_VERTEX_PROJECT` is set, then runs up to `--max-model-calls` billed model calls (L-148 inventory; reported, not changed) |
| token counts (`countTokens`, through `packages/model-client` `providerTokenCounter` and `google-count.mjs`, and `sdk/adapter.mjs admitDirect`) | none (not billed by the provider, L-604) | sent only by a client the policy already admitted, so never while a kind is off; not charged, so a turn refused at its generation request may already have counted its tokens (a concurrent turn that loses the last request, for one) |
| Vertex AI (`aiplatform.googleapis.com`): every `@google/genai` client that `sdk/adapter.mjs makeClient` builds goes there when `GOOGLE_GENAI_USE_VERTEXAI` is set | as its seat | the gate of the seat whose client it is: refused before the client is made. The L-136 test recorder's `billed` flag counts only `generativelanguage.googleapis.com`, so the L-146 and L-148 tests count every Google host |
| Antigravity CLI lanes (`agy`, every role), and the quota probe `agy --print /usage` (`src/agy/quota.mjs`) | none | subscription (OAuth); never refused; their egress is the CLI's own (L-004) |

## What it does not do

- The budget is a count of billed **requests**, not tokens or money.
- It governs Gemini only. Other providers' spend is bounded by the provider-call limits (`--total-provider-calls`,
  `--max-provider-calls`, `limits.*`).
