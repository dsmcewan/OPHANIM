---
assignment: 3
title: Execution reliability
commit: 77480d6b262c92ceca5a159cc5be3e3ee627b922
pr: 67
branch: ccr-aa24f0d5-336szn
lab: Google
requested_model: gemini-4-carbon
lane: gemini-4-carbon-high
served_model: gemini-4-carbon
served_model_source: input
default_reviewer: xai/grok-4.7
reviewer_override: true
via: subscription
transport: agy-cli (manual in-session)
subscription_coverage: documented
status: complete
---

# Independent Review — Assignment 3: Execution Reliability

- **Commit under review:** `77480d6b262c92ceca5a159cc5be3e3ee627b922` (PR #67, branch `ccr-aa24f0d5-336szn`)
- **Reviewer:** Google, `gemini-4-carbon` (Antigravity lane `gemini-4-carbon-high`, `served_model_source: input`; `reviewer_override: true`, standing in for default `xai/grok-4.7`)
- **Review test suite:** [.review-tests/assignment3-reliability.test.mjs](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/.review-tests/assignment3-reliability.test.mjs) (`15/15` passing via `cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs`)
- **Sandbox note:** Per [PROMPT.md:35](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/PROMPT.md#L35), nested `bwrap` namespaces cannot be created inside this review sandbox (`bwrap: Creating new namespace failed: Function not implemented`). Baseline suites (`OPHANIM_TELOS_ROOT='/home/colchis/Projects/TELOS' npm run test:proof` and `npm test`) were executed; `packages/model-client` (`62/62`) and `packages/ledger` pass completely, and all non-`.git` failures in `pantheon` / `ophanim` are nested-`bwrap` refusals. Sub-checks that require executing a live nested `bwrap` child are explicitly noted as `cannot tell` (environment limit) alongside static source citations and mock-transport reproductions.

---

## Findings

### 1. Call budgets — `does not hold` (with post-isolation `runOpenItem` execution `cannot tell` in nested sandbox)

**What holds in `77480d6`:**
- Zero-spend Antigravity quota probes (`agy --print /usage --output-format json`) run outside `admit` / `charge` ([pantheon/src/agy/quota.mjs:230-257](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L230-L257), [pantheon/src/pipeline/turns.mjs:221](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L221)) and cost `0` provider calls.
- Resumed checkpoints return before dispatcher, implementer, subagent, or reviewer turns run ([pantheon/src/pipeline/index.mjs:298](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L298), [pantheon/src/pipeline/index.mjs:452-495](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L452-L495)) and cost `0` calls.
- Pipeline lane retries, ladder steps, subagent calls ([pantheon/src/pipeline/a2a-shim.mjs:120](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/a2a-shim.mjs#L120)), and metered quota failover ([pantheon/src/pipeline/turns.mjs:238](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L238), [pantheon/src/sdk/agy-turn.mjs:80](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/agy-turn.mjs#L80), [ophanim/operate/stages.mjs:126-128](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L126-L128)) pre-charge via `admit` / `ctx.charge` (`work.spend`), and `work.claim` atomically reserves `stage_provider_calls` against `total_provider_calls` under the ledger append lock ([ophanim/operate/work-ledger.mjs:107-123](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L107-L123), [ophanim/operate/work-ledger.mjs:187-190](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L187-L190)).

**Defects:**
1. **Multi-request SDK turns charge `1` call for up to `17+` HTTP provider invocations, exceeding `max_provider_calls`, `stage_provider_calls`, and `total_provider_calls`:**
   - On Google's `genai` surface under default `outputBudgetPolicy: "long_decode"`, `exchange()` loops up to **16** separate billed `generateContent` / `generateContentStream` continuation hops inside a single `sendTurn` call ([packages/model-client/wire.mjs:96-123](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/wire.mjs#L96-L123)). `sendTurn` records `provider_requests: seen.requests` ([pantheon/src/sdk/adapter.mjs:241](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/adapter.mjs#L241), [pantheon/src/sdk/adapter.mjs:274](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/adapter.mjs#L274)), but both `pipelineTurns` metered failover ([pantheon/src/pipeline/turns.mjs:180-187](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L180-L187)) and `liveTurn` ([pantheon/src/sdk/live.mjs:30-34](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/live.mjs#L30-L34)) drop `r.provider_requests` and pre-charge `1` call regardless of hop count.
   - In addition, `sendModelTurn` / `admitDirect` make uncounted provider HTTP calls to `countTokens` ([packages/model-client/client.mjs:23-24](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/client.mjs#L23-L24), [packages/model-client/client.mjs:55-70](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/client.mjs#L55-L70), [pantheon/src/sdk/adapter.mjs:458-459](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/adapter.mjs#L458-L459)) and Anthropic `compactConversation` ([packages/model-client/client.mjs:15-17](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/client.mjs#L15-L17)), and `routeCall` retries transient 5xx failures inside one routed call ([packages/model-client/router.mjs:44-60](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/router.mjs#L44-L60)) when not wrapped by `runOpenItem`'s `admitProviderCall`.
2. **`implementUnits` catch block charges the full `stage_provider_calls` budget when `runPipeline` throws after `0` calls:**
   - In [ophanim/operate/stages.mjs:977-980](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L977-L980), if `runPipeline` throws (for instance `RECORD_WRITE` on initial `save()` at [pantheon/src/pipeline/index.mjs:151](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L151), [pantheon/src/pipeline/index.mjs:244](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L244) before any model turn is invoked), `implementUnits` returns `usage(ctx.budget.provider_calls)`, charging all `stage_provider_calls` (e.g. `40`) for `0` actual calls.
3. **`runOpenItem` resume (`argo`/`legacy` or unitless `fit`) resets `made = 0` while inflating `limit` to `callsBefore + ctx.budget.provider_calls`, and omits `ctx.charge`:**
   - [ophanim/operate/stages.mjs:778-787](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L778-L787) passes `maxProviderCalls: callsBefore + ctx.budget.provider_calls` on resume. In [pantheon/src/board/run-item.mjs:320](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/run-item.mjs#L320) and [pantheon/src/board/run-item.mjs:866-872](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/run-item.mjs#L866-L872), `BOUND_GIVEN` is `true`, so `counted_from` advances to `earlier.length` and `providerCalls` stays `0` while `MAX_PROVIDER_CALLS` becomes `callsBefore + budget`. That single attempt can spend `callsBefore + stage_provider_calls` *new* calls (exceeding both `stage_provider_calls` and `total_provider_calls`). Moreover, [ophanim/operate/stages.mjs:782](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L782) never wires `ctx.charge` (`work.spend`) into `runOpenItem`, so calls made before a mid-stage crash are uncharged (`0` on `work-ledger`). *(Driving `runOpenItem` past its `bwrap` isolation preflight at [pantheon/src/board/run-item.mjs:894](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/run-item.mjs#L894) is `cannot tell` in this nested sandbox; state initialization at line `871` is verified directly.)*

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q1-A`: Under `limits: { max_provider_calls: 4 }`, 1 dispatcher + 1 exhausted lane + 1 metered Gemini failover (`1 countTokens` + `3` continuation hops) + 1 reviewer executes **7** provider requests while `out.provider_calls.total` records `4`.
- `Q1-B`: Forcing initial `pipeline.json` `save()` to throw `RECORD_WRITE` makes `0` provider calls while recording `implStage.usage.provider_calls === 40`.
- `Q1-C`: Resuming `runOpenItem` after `15` prior calls with `maxProviderCalls: 15 + 20` writes `run.json` with `made: 0` and `limit: 35`.

---

### 2. Budget stops — `does not hold`

**What holds in `77480d6`:**
- No partial stage is recorded as `passed`: `scheduler.mjs` downgrades over-budget results to `failed` ([ophanim/operate/scheduler.mjs:214-217](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L214-L217)) and downgrades late `passed`/`returned` results after `STAGE_ELAPSED` to `pending` ([ophanim/operate/scheduler.mjs:223-233](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L223-L233)).

**Defects:**
1. **`STAGE_ELAPSED` abort during `fit` `implement` permanently wedges the item in non-transient `blocked` (`PIPELINE_UNITS_UNRESOLVED`):**
   - When `ac.signal` aborts at `STAGE_ELAPSED` mid-pipeline, `runPipeline` finishes in-flight/unstarted units as `status: "blocked"` ([pantheon/src/pipeline/index.mjs:307](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L307), [pantheon/src/pipeline/index.mjs:372](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L372), [pantheon/src/pipeline/index.mjs:378](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L378)), and `implementUnits` returns `status: "blocked"` with `blocker: { code: "PIPELINE_UNITS_UNRESOLVED" }` (non-transient) ([ophanim/operate/stages.mjs:1044-1050](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1044-L1050)).
   - In [ophanim/operate/scheduler.mjs:225-231](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L225-L231), `const late = result.status === 'passed' || result.status === 'returned'` **ignores `result.status === 'blocked'`**, so the stage is recorded as a permanent structural `PIPELINE_UNITS_UNRESOLVED` block. Subsequent ticks with fresh `elapsed_ms` cannot dispatch the item.
2. **Hitting `pipeline.max_provider_calls < stage_provider_calls` misstates the spent count and does not stop `runConfirmed`:**
   - [ophanim/operate/stages.mjs:1031-1034](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1031-L1034) returns `status: 'failed'` with message `"the stage's ${ctx.budget.provider_calls} provider call(s) were used"` even when `pipeline.max_provider_calls` was `1` and `ctx.budget.provider_calls` was `20`, and `runConfirmed` ([ophanim/operate/live-run.mjs:537-550](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L537-L550)) keeps re-running `implement` `stage_attempts` times instead of stopping.
3. **Stage budget exhaustion inside `plan` / `review` `reviewCycle` masquerades as a transient server failure (`REVIEW_PENDING`):**
   - When a reviewer seat hits `the stage's provider-call budget` / `PROVIDER_CALL_LIMIT` inside `investigatingTurn` ([ophanim/operate/stages.mjs:418-422](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L418-L422)), `plan` ([ophanim/operate/stages.mjs:674-679](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L674-L679)) and `review` ([ophanim/operate/stages.mjs:1163-1168](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1163-L1168)) record `status: 'pending'` with `next.why: 'plan review incomplete'` / `'a reviewer seat failed'`, omitting the budget stop from `live-run.mjs` `budget_stops`.

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q2-A`: `tick` with `elapsed_ms: 1200` aborts `implement` on `STAGE_ELAPSED`, recording non-transient `blocked` (`PIPELINE_UNITS_UNRESOLVED`); a second `tick` with `elapsed_ms: 60000` dispatches `[]`.
- `Q2-B`: `runConfirmed` with `stage_provider_calls: 20, pipeline.max_provider_calls: 1, stage_attempts: 3` runs `implement` 3 times, each using `1` call while reporting `"the stage's 20 provider call(s) were used"`.

---

### 3. Concurrency — `does not hold`

**Analysis & Defects:**
1. **Two units in one wave (`owned_paths`):**
   - `lockConflicts` ([pantheon/src/pipeline/dispatch.mjs:145-154](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/dispatch.mjs#L145-L154)) and `waves` ([pantheon/src/pipeline/dispatch.mjs:163-184](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/dispatch.mjs#L163-L184)) serialize overlapping globs on case-sensitive paths, **but `pathsOverlap` ([pantheon/src/pipeline/paths.mjs:46](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/paths.mjs#L46)) is strictly case-sensitive** (`segOverlap` at [pantheon/src/pipeline/paths.mjs:33-42](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/paths.mjs#L33-L42)). `src/Foo.mjs` and `src/foo.mjs` are scheduled in the same wave and collide at Wave merge on case-insensitive filesystems (macOS `launchd` target in [docs/operate-service.md:60](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/docs/operate-service.md#L60) / NTFS).
2. **Two scheduler processes:**
   - `work.claim` ([ophanim/operate/work-ledger.mjs:184](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L184)) under `locked()` ([packages/ledger/chain.mjs:270-296](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/ledger/chain.mjs#L270-L296)) prevents two processes from claiming the same unexpired `(item, stage)`.
   - **However:** (a) `runService` places `service.lock` in `path.join(c.stateDir, 'service.lock')` ([ophanim/operate/service.mjs:113](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/service.mjs#L113)) rather than `c.workRoot`, violating `"One instance per work ledger"` ([docs/operate-service.md:21](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/docs/operate-service.md#L21)) whenever two configs specify different `state_dir`s (`cli.mjs tick|watch` take no service lock at all); and (b) `work.release` on expired claims ([ophanim/operate/scheduler.mjs:107](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L107)), `work.intake` ([ophanim/operate/scheduler.mjs:115](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L115)), and `work.recordRecovery` ([ophanim/operate/scheduler.mjs:133](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L133)) have no `try/catch`, so two processes racing bookkeeping crash `tick()` with uncaught `LEDGER_REFUSED` (`that claim is already released` / `intake is recorded once per source`).
3. **Under `--concurrency > 1`:**
   - Concurrent item workers in [ophanim/operate/scheduler.mjs:266-274](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L266-L274) share a single mutable `repo` checkout without coordination:
     - `plan` writes uncommitted `tickets/<item>.json` directly into `repo` ([ophanim/operate/stages.mjs:698](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L698)), causing a concurrent item's `implement` whose `copy` covers `.` or `tickets` to fail the dirty-tree check (`git status --porcelain`) at [ophanim/operate/stages.mjs:761-762](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L761-L762) / [ophanim/operate/stages.mjs:907-908](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L907-L908).
     - Each `runPipeline` creates a private `const lock = mutex()` ([pantheon/src/pipeline/index.mjs:221](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L221)), and [ophanim/operate/stages.mjs:933](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L933) calls `recoverOrphanWorktrees` with no mutex at all, racing concurrent `git worktree add/remove/prune` operations against `.git/worktrees`.
     - `validate` executes `execFileSync` synchronously for up to 10 minutes ([ophanim/operate/stages.mjs:1206](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1206)), freezing the Node event loop and starving leases/timers of all sibling items.

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q3-A`: `pathsOverlap('src/Foo.mjs', 'src/foo.mjs')` is `false` (scheduled in one wave), and two `runService` instances with `state-1` and `state-2` execute stages simultaneously (`maxInFlight === 2`, both `code: 0`) on one `work_ledger`.
- `Q3-B`: Under `tick(..., { concurrency: 2 })`, `item-1`'s `plan` writes `tickets/item-1.json` in `repo`, causing concurrent `item-2`'s `implement` to fail with `"the ticket's copy paths have uncommitted changes"`.

---

### 4. Leases — `does not hold`

**What holds in `77480d6`:**
- Expired claims are released with `outcome: 'expired'` at the start of `tick` ([ophanim/operate/scheduler.mjs:106-109](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L106-L109), [ophanim/operate/work-ledger.mjs:370-373](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L370-L373)), reconciliation resumes from the last valid `passed` stage, and `fenceRefusal` ([ophanim/operate/work-ledger.mjs:72-76](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L72-L76), [ophanim/operate/work-ledger.mjs:218](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L218), [ophanim/operate/work-ledger.mjs:255](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/work-ledger.mjs#L255)) refuses `work.spend` and `work.stage` (`LEASE_FENCED`) once a claim is released or past `leased_at + lease_ms`.

**Defect — Un-fenced stale holders still mutate repository files, refs, and shared Pantheon ledgers before `recordStage`:**
- Stage executors perform side-effecting writes *after* their final `charge()` call and *before* returning to `scheduler.mjs:238` (`work.recordStage`):
  - A stale `plan` holder whose lease expired and was superseded by Holder 2 still closes on the shared `planLedger` ([ophanim/operate/stages.mjs:527](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L527), [ophanim/operate/stages.mjs:689](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L689)) and **overwrites `tickets/<item>.json`** ([ophanim/operate/stages.mjs:698](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L698)) before `recordStage` rejects it with `LEASE_FENCED` — corrupting Holder 2's ticket digest and invalidating Holder 2's approved plan back to `gate: 'plan'`.
  - Similarly, a stale `review` holder mutates the upstream `implement` stage's shared `o.run.ledger` ([ophanim/operate/stages.mjs:1125](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1125), [ophanim/operate/stages.mjs:1175](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1175)), and a stale `implement` holder writes branch refs `pantheon/<item>*` ([ophanim/operate/stages.mjs:840](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L840), [ophanim/operate/stages.mjs:1070](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1070)).

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q4`: Holder 1 pauses after its 3rd `plan-review` call; its lease expires and Holder 2 releases it as `expired` and passes `plan`. When Holder 1 resumes, `work-ledger` fences `recordStage` (`LEASE_FENCED`), yet Holder 1 already overwrote `tickets/race-ticket.json`, causing Holder 2's next tick to skip `implement` (`gate === 'plan'`).

---

### 5. Retries and the lane ladder — `does not hold`

**What holds:**
- Inside `runPipeline`'s inner loop ([pantheon/src/pipeline/index.mjs:351-375](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L351-L375)), a non-quota `lane_failure` retries once on the same lane (`again = !quota && !retried`) and then steps `implementer_level + 1`; lane failures spend `0` `state.revisions`; and an exhausted ladder finishes `blocked` (`LANE_LADDER_EXHAUSTED`) with all failures recorded in `attempts[].lane_failures`.

**Defects:**
1. **`implementerPath` conflates rejection thinking-escalation with the lane failover ladder, stepping UP on an already quota-exhausted base model:**
   - [ophanim/operate/stages.mjs:353-357](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L353-L357) and [ophanim/operate/stages.mjs:955](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L955) expand `implementerEscalation` ([pantheon/src/route/fit-matrix.mjs:130-138](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/route/fit-matrix.mjs#L130-L138)) into `seats.implementer.ladder` (for `easy`: `gemini-4-hydrogen-medium -> gemini-4-hydrogen-high -> gemini-4-hydrogen-xhigh -> gemini-3.8-flash-high`). Because Antigravity quota is shared per base model / model group ([pantheon/src/route/quota-failover.mjs:17](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/route/quota-failover.mjs#L17), [pantheon/src/agy/quota.mjs:14](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L14)), a quota refusal on `gemini-4-hydrogen-medium` steps to `-high` and `-xhigh` on the **same exhausted model**, burning 2 doomed launches and 2 `/usage` probes before reaching `gemini-3.8-flash-high`.
2. **Unstructured `\b429\b` matching on `stderr` misclassifies ordinary errors (e.g. stack-trace line `:429:`) as `explicit: true` quota refusals, bypassing `/usage` probe verification:**
   - [pantheon/src/agy/quota.mjs:31](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L31) and [pantheon/src/agy/quota.mjs:45-47](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L45-L47) match `EXPLICIT = /\b429\b|RESOURCE_EXHAUSTED/i` across raw `stderr` (`TypeError at src/parser.mjs:429:15`). In [pantheon/src/pipeline/turns.mjs:220-227](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L220-L227), `explicit === true` overrides `seen.state === "available"` from `probeQuota`, skipping the same-lane retry (when `meteredFailover: false`) or triggering metered Gemini API billing (when `true`). Additionally, `scopeQuota` ([pantheon/src/agy/quota.mjs:204](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L204)) and `errParsed` ([pantheon/src/agy/quota.mjs:249-251](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L249-L251)) leave unscoped non-Gemini exhaustion as `state: "exhausted"`.
3. **Metered API failover format refusal (`API_FILES_REFUSED`) spends a review revision and leaves the unit on the quota-exhausted lane:**
   - When a lane hits quota and the metered API fallback returns prose/malformed JSON ([pantheon/src/pipeline/turns.mjs:247](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L247)), `laneFailureOf(e)` is `null` ([pantheon/src/pipeline/implement.mjs:210-212](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/implement.mjs#L210-L212)), so [pantheon/src/pipeline/index.mjs:379](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L379) and [pantheon/src/pipeline/index.mjs:402](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L402) escalate `attempt_refused` — consuming a review revision without stepping off the quota-exhausted lane.

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q5`: Verifies `implementerPath('easy')` repeats `gemini-4-hydrogen-{medium,high,xhigh}`, `stderr: "TypeError at src/parser.mjs:429:15"` skips the same-lane retry even when `probeQuota` reports `"available"`, and `API_FILES_REFUSED` blocks at `max_revisions: 0` (`"0 revision(s) are spent"`).

---

### 6. Metered failover off — `does not hold`

**What holds:**
- For declared Antigravity lanes on Stage 3 `pipelineTurns` ([pantheon/src/pipeline/turns.mjs:228-231](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/turns.mjs#L228-L231)), `meteredFailover: false` prevents calling `api()` and blocks the unit (`PIPELINE_UNITS_UNRESOLVED`).

**Critical Defect — Default Google cycle reviewer (`gemini-3.6-flash`) bypasses Antigravity and calls the metered Gemini API directly even when `meteredFailover: false`:**
- Every 3-lab `plan` review and post-pipeline `review` under `fit` selects its panel via `reviewSeatsByModel` ([pantheon/src/ledger/review-cycle.mjs:64-68](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/ledger/review-cycle.mjs#L64-L68)) over `SEATING.reviewer` ([pantheon/src/role/seating.mjs:287](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/role/seating.mjs#L287)), which seats Google on `{ vendor: "agy_google", model: "gemini-3.6-flash" }`.
- Because `gemini-3.6-flash` has **no Antigravity lane** in `pantheon/src/config/lanes.json` (`laneLevels("gemini-3.6-flash")` is `[]`), `laneFirstTurn(..., { failover: false })` computes `viaLane = null` at [pantheon/src/sdk/agy-turn.mjs:66-67](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/agy-turn.mjs#L66-L67) and **unconditionally calls `api({ vendor: "agy_google", model: "gemini-3.6-flash" })`**, ignoring `failover: false` ([pantheon/src/sdk/live.mjs:27-37](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/live.mjs#L27-L37)).
  - When `GEMINI_API_KEY` is present in the environment (e.g. `cli.mjs` / `service.mjs` with `meteredFailover: false`), **the metered Gemini API IS called**.
  - In `live-run.mjs` with `billing.metered_gemini_failover: false` and `credentials.gemini_api_key: "not-used"` (which deletes `GEMINI_API_KEY` at [ophanim/operate/live-run.mjs:528](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L528)), Stage 1 `plan` review immediately fails on the Google reviewer seat (`makeClient: agy_google needs GEMINI_API_KEY`) and stalls in `REVIEW_PENDING`.
- Two additional gaps: `routeSeats` ([pantheon/src/route/quota-failover.mjs:19-50](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/route/quota-failover.mjs#L19-L50), used by `runOpenItem`) has no `meteredFailover: false` switch, and a disabled-failover quota refusal on `validate` ([ophanim/operate/stages.mjs:1289](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1289), [ophanim/operate/stages.mjs:1323](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1323)) records `status: 'failed'` with `blocker: null` (`run.json` `blockers === []`).

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q6`: `reviewSeatsByModel` selects `agy_google/gemini-3.6-flash`, and `laneFirstTurn` with `failover: false` invokes `api()` (`apiCalled === 1`, `laneCalled === 0`).

---

### 7. Checkpoints — `does not hold`

**What holds in `77480d6`:**
- `writeCheckpoint` writes `<hex>.patch` then `<hex>.json` via temp-file + `rename` ([pantheon/src/pipeline/checkpoint.mjs:78-82](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L78-L82), [pantheon/src/pipeline/checkpoint.mjs:118-120](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L118-L120)), sealed with HMAC-SHA256 (`sealOf`) under a `0600` controller key ([pantheon/src/pipeline/checkpoint.mjs:88-107](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L88-L107)).
- On resume ([pantheon/src/pipeline/index.mjs:452-495](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L452-L495), [pantheon/src/pipeline/checkpoint.mjs:139-184](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L139-L184)), `checkpointRefusal`, `approvalRefusal`, `git apply --index`, `git write-tree`, and `runVerify` re-verify the HMAC seal, `patch_digest`, `upstream` keys and trees, resulting git tree, `verify_cmd` exit 0, `review_digest`, `rv.diff_digest === record.patch_digest`, recomputed `rubric_hash`, and `contributions` lineage.

**Defects (also touching Assignment 2 review lineage):**
1. **`unitKey` is incomplete — it omits sibling units even though `DISPATCHER_PROMPT` judges `cohesive` against `THE OTHER UNITS OF THE PLAN`:**
   - [pantheon/src/pipeline/checkpoint.mjs:69-73](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L69-L73) hashes only `{ schema, unit, base_commit, upstream }`, while [pantheon/src/pipeline/dispatch.mjs:54](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/dispatch.mjs#L54) and [pantheon/src/pipeline/dispatch.mjs:61-63](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/dispatch.mjs#L61-L63) pass sibling units to the dispatcher to judge coupling/cohesion, and [ophanim/operate/stages.mjs:923](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L923) shares one `checkpoints/` directory across revised plans of an item. Adding or changing a coupled sibling unit leaves `unitKey` unchanged and skips `runDispatcher`.
2. **Resume does not re-check `sameModel` (identity policy) or `limits.max_diff_bytes` against the checkpointed `dispatch` and `review`:**
   - Neither `approvalRefusal` ([pantheon/src/pipeline/checkpoint.mjs:166-184](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L166-L184)) nor `resume` ([pantheon/src/pipeline/index.mjs:477-482](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L477-L482)) checks `sameModel(d.model, d.served_model)` or `sameModel(rv.model, rv.served_model)` or `rv.diff_bytes <= lim.max_diff_bytes`.
3. **Resumed units drop `u.dispatch`, `u.reviews`, and `u.a2a.calls`, omitting arbiters and breaking `live-run.mjs` `subagentReceipt`:**
   - [pantheon/src/pipeline/index.mjs:485-488](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L485-L488) leaves `u.dispatch = null`, `u.reviews = []`, and `u.a2a.calls = []` on resumed units. Consequently, `arbitersOf(run)` ([pantheon/src/pipeline/record.mjs:55-63](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/record.mjs#L55-L63)) omits resumed units' dispatchers and reviewers, `stages.mjs` `team` / `servedIdentities` omits them ([ophanim/operate/stages.mjs:1000-1008](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1000-L1008)), and **`subagentReceipt` ([ophanim/operate/live-run.mjs:435-445](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L435-L445)) reads `u.a2a.calls` only from the final accepted `pipeline.json`, returning `counted: 0, met: false` (exit 3) whenever a required subagent call occurred in a checkpoint-resumed unit.**

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q7`: Unit `a` consults subagent `api-designer` (`grok-4.7`) and checkpoints in Run 1; Run 2 adds sibling unit `d` (which the dispatcher would reject as non-cohesive) and tightens `sameModel` to reject `gpt-6-astra`. Run 2 still resumes `a` (`resumed === true`), drops `a` from `arbitersOf(run2)`, and fails `subagentReceipt` (`counted === 0, met === false`).

---

### 8. Process restart — `does not hold`

**What holds in `77480d6`:**
- Killing mid-checkpoint-write leaves either `.tmp` files (`{ found: false }`) or a `.patch`/`.json` digest mismatch cleanly refused by `checkpointRefusal` ([pantheon/src/pipeline/checkpoint.mjs:155](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/checkpoint.mjs#L155)), and `recoverOrphanWorktrees` ([pantheon/src/pipeline/index.mjs:516-537](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L516-L537), [ophanim/operate/stages.mjs:933](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L933)) removes orphaned worktrees under `<dir>/worktrees`.

**Defects:**
1. **`SIGKILL` mid-wave leaves branch ref `refs/heads/pantheon/pipeline/<run_id>`, breaking pipeline restart with the same `dir` and `run_id`:**
   - [pantheon/src/pipeline/index.mjs:236](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L236) calls `recoverOrphanWorktrees` (which deletes `<dir>/worktrees/_integration` and runs `git worktree prune`), **but never deletes `refs/heads/pantheon/pipeline/<run_id>`** ([pantheon/src/pipeline/index.mjs:223](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L223)). Restarting `runPipeline` into the same `dir` with the same `run_id` immediately fails at [pantheon/src/pipeline/index.mjs:242](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L242) (`git worktree add -q -b pantheon/pipeline/<run_id>` -> `already exists`).
2. **Findings recovered from a killed pipeline run are lost if the next `implement` attempt fails and a third attempt runs:**
   - In [ophanim/operate/stages.mjs:925-950](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L925-L950) and [ophanim/operate/stages.mjs:1015](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1015), Attempt 2 sweeps an unrecorded killed pipeline directory `d1` and records `d1` in Attempt 2's `outputs.carried_runs`. If Attempt 2 fails (e.g. budget/transient failure) and Attempt 3 runs, `recordedRuns` includes `outputs.carried_runs` ([ophanim/operate/stages.mjs:925](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L925)) and skips `d1` ([ophanim/operate/stages.mjs:934](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L934)) without carrying Attempt 2's `findings` forward — **dropping all findings from the killed run** on Attempt 3's stage record.
3. **Uncharged `runOpenItem` calls and lost `plan` author/contributor state on mid-stage kill:**
   - Killing `runOpenItem` ([ophanim/operate/stages.mjs:782](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L782)) mid-stage loses all provider-call charges (`0` `work.spend` entries); killing `plan` after opening a cycle on `planLedger` ([ophanim/operate/stages.mjs:663](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L663)) before `recordStage` leaves `opened === undefined` on resume ([ophanim/operate/stages.mjs:552-571](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L552-L571)), losing `authorLog`, `refused`/`versions` from prior versions in that attempt, and (under `lab` independence, `CYCLE_CONTRACT_V2`) earlier `plan-review` contributors.

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q8-A`: Spawns a child process running `runPipeline(..., { dir: runDir, run_id: 'fixed-run' })`, sends `SIGKILL` mid-wave, and restarts `runPipeline` with the same `dir` and `run_id` -> `restarted.status === 'failed'` (`already exists`).
- `Q8-B`: Attempt 2 carries `"critical defect from killed run"` from killed `pipeline-0-100` and fails on budget; Attempt 3 records `findings === []`.

---

### 9. Timeouts — `does not hold` (with in-`bwrap` `agy` CLI timeout behavior `cannot tell` in nested sandbox)

**Verify & print timeouts:**
- `runVerify` ([pantheon/src/pipeline/review.mjs:49-56](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/review.mjs#L49-L56), [pantheon/src/pipeline/git.mjs:12-41](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/git.mjs#L12-L41)) enforces `verify_timeout_ms` via detached process-group `SIGKILL` (`process.kill(-child.pid, "SIGKILL")`), though [pantheon/src/pipeline/git.mjs:30-38](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/git.mjs#L30-L38) lacks `spawnPromise`'s stdout/stderr pipe-destroy failsafe ([pantheon/src/board/spawn.mjs:36](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/spawn.mjs#L36)) if a grandchild calls `setsid()`, and `runVerify` ignores `signal`.
- `workerArgv` / `runAgyWorkerTurn` ([pantheon/src/board/agy-cli.mjs:546](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/agy-cli.mjs#L546), [pantheon/src/board/agy-cli.mjs:605](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/agy-cli.mjs#L605)) and `agySingleTurn` ([pantheon/src/sdk/agy-turn.mjs:27](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/agy-turn.mjs#L27), [pantheon/src/sdk/agy-turn.mjs:37](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/agy-turn.mjs#L37)) pass `--print-timeout` (`1800s` / `900s`, hardcoded rather than configurable in `live-run` manifests) plus outer `(timeoutS + 15) * 1000` process-group `SIGTERM` -> `SIGKILL` via `spawnPromise` ([pantheon/src/board/spawn.mjs:31-38](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/board/spawn.mjs#L31-L38)). *(Direct execution of `agy` inside `bwrap` on timeout is `cannot tell` in this nested sandbox.)*

**Confirmation of `elapsed_ms` docs vs code, and why it matters:**
- Earlier docs stated `elapsed_ms` was checked between stages only; commit `77480d6` updated [ophanim/operate/live-run.example.json:2](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.example.json#L2) (`"elapsed_ms = the wall-clock bound of the run"`) and [ophanim/operate/live-run.mjs:43](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L43), and added a per-stage `AbortController` (`ac.signal`) in [ophanim/operate/scheduler.mjs:169-171](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L169-L171) and [ophanim/operate/scheduler.mjs:193-195](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L193-L195). **It is therefore no longer checked strictly between stages, and the remaining gaps matter in both directions:**
  1. **Premature 10% stage abort in `live-run.mjs`:** [ophanim/operate/live-run.mjs:532](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L532) sets `lease_ms: L.elapsed_ms`, and [ophanim/operate/scheduler.mjs:169-170](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L169-L170) sets `stageMs = Math.min(L.elapsed_ms - elapsed, L.lease_ms - grace)` where `grace = Math.min(60_000, Math.floor(L.lease_ms / 10))` — aborting Stage 1 up to **60s (10%) early**! Worse, if `ac.signal` fires during `fit` `implement`, it permanently wedges the item in `PIPELINE_UNITS_UNRESOLVED` (Finding 2.1).
  2. **Multi-minute overruns past `elapsed_ms` (and past `lease_ms`):** `buildPlan` / `agyPreflight` (multiple 30s probes at [ophanim/operate/live-run.mjs:368](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L368), [ophanim/operate/live-run.mjs:609](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L609)) runs before `started = Date.now()` ([ophanim/operate/live-run.mjs:523](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L523)); `validate` runs synchronous `execFileSync` with a hardcoded `10 * 60_000` ms timeout ([ophanim/operate/stages.mjs:1206](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1206)) that ignores `ac.signal`; `runVerify` ([pantheon/src/pipeline/review.mjs:130](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/review.mjs#L130)), non-frontier `streamTurn` ([pantheon/src/sdk/adapter.mjs:318](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/adapter.mjs#L318)), `runOpenItem` ([ophanim/operate/stages.mjs:782](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L782)), and post-loop `verifyInChild` (`120_000` ms at [ophanim/operate/live-run.mjs:496](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L496)) all ignore `elapsed_ms` / `signal`.

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q9` (and `Q2-A`): `runVerify({ verify_cmd: 'sleep 10', timeout_ms: 80 })` kills the child group (`timed_out: true`), while `tick` with `elapsed_ms: 500, lease_ms: 500` hands `plan` `ctx.budget.elapsed_ms === 450`.

---

### 10. Run record — `does not hold`

**What holds in `77480d6`:**
- `verifyInChild` ([ophanim/operate/live-run.mjs:496-512](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L496-L512), [ophanim/operate/live-run.mjs:555](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L555)) spawns a real fresh child `node` process ([ophanim/operate/verify-run.mjs:1-31](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/verify-run.mjs#L1-L31)) that re-opens `workRoot` and `statusRoot` read-only, verifies `status` head and file digests are unchanged, and writes an `fsync`'d verdict file.

**Defects:**
1. **Incomplete child verification of `run_ledgers`, `pipeline.json`, and `<out_dir>/run.json`:**
   - `freshVerification` opens `run_ledgers` with `defineKinds({})` ([ophanim/operate/live-run.mjs:476](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L476)) — a structural signature/link check only, skipping all Pantheon domain `validate` / `rederive` rules (`cycleKinds`, `lineageKinds`, etc.).
   - When `plan` ends `pending` ([ophanim/operate/stages.mjs:675](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L675)), it records `outputs.plan_ledger_anchor` **without `outputs.plan_ledger` or `outputs.plan_review`**, so `cite()` at [ophanim/operate/live-run.mjs:470](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L470) skips verifying the open plan ledger completely (`run_ledgers === []`).
   - `freshVerification` never hashes `pipeline.json` against `outputs.run.record_digest`, and runs *before* `<out_dir>/run.json` is written ([ophanim/operate/live-run.mjs:555](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L555) vs [ophanim/operate/live-run.mjs:574](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L574)), with no CLI command that verifies a finished `run.json` file.
2. **`budget_stops` omits stage `stage_provider_calls` stops inside `plan` and `review`:**
   - `budgetStops` ([ophanim/operate/live-run.mjs:452-459](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L452-L459)) inspects `s.next?.why`, not `s.blocker?.what`. When `plan` ([ophanim/operate/stages.mjs:677-679](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L677-L679)) or `review` ([ophanim/operate/stages.mjs:1166-1168](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L1166-L1168)) stops because a reviewer hit `the stage's provider-call budget` / `PROVIDER_CALL_LIMIT`, `s.next.why` is `'plan review incomplete'` / `'a reviewer seat failed'`, leaving `record.budget_stops === []`.
3. **`blockers` omits `final_gate.blocker`, `stage_attempts` exhaustion after a launcher stop, and `validate` disabled-failover quota blocks:**
   - `blockers` ([ophanim/operate/live-run.mjs:564](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L564)) collects only `ticks[].blocked` and `stages[].blocker`, omitting `final_gate.blocker` whenever the loop exits without ticking on a blocked gate (leaving `final_gate.blocker !== null` while `record.blockers === []`).

**Reproduction:**
```bash
cd '/home/colchis/Projects/OPHANIM-a3-agy-77480d6/src' && node --test .review-tests/assignment3-reliability.test.mjs
```
- `Q10`: Case 10-A hits `the stage's provider-call budget` in `plan` review (`r1.record.verification.run_ledgers === []`, `r1.record.budget_stops === []`); Case 10-B verifies `run_ledgers[0].check` is structural-only (`defineKinds({})`); Case 10-C shows `r3.record.final_gate.blocker` populated while `r3.record.blockers` is `[]`.

---

## Blockers for a live run

1. **Metered failover off is broken on every 3-lab `plan` and `review` stage (Finding 6):** `SEATING.reviewer` seats Google on `agy_google/gemini-3.6-flash` ([pantheon/src/role/seating.mjs:287](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/role/seating.mjs#L287)), which has no Antigravity lane in `lanes.json`. `laneFirstTurn(..., { failover: false })` ([pantheon/src/sdk/agy-turn.mjs:66-67](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/sdk/agy-turn.mjs#L66-L67)) routes it directly to the metered Gemini API — either violating `metered_gemini_failover: false` when `GEMINI_API_KEY` is present, or stalling at Stage 1 `plan` (`REVIEW_PENDING`) when `live-run.mjs` withholds `GEMINI_API_KEY`.
2. **`STAGE_ELAPSED` during `fit` `implement` permanently wedges the item (Finding 2.1):** Aborting `runPipeline` on `ac.signal` returns `status: "blocked"` (`PIPELINE_UNITS_UNRESOLVED`), which [ophanim/operate/scheduler.mjs:225](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/scheduler.mjs#L225) fails to convert to a transient `STAGE_ELAPSED` `pending` state, blocking all future resume ticks.
3. **Checkpoint resume breaks `require_subagent` acceptance, skips sibling cohesion re-dispatch, and skips `sameModel` (Finding 7):** Resumed units clear `u.a2a.calls`, `u.dispatch`, and `u.reviews` ([pantheon/src/pipeline/index.mjs:485-488](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L485-L488)), causing `subagentReceipt` ([ophanim/operate/live-run.mjs:435-445](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/live-run.mjs#L435-L445)) to fail acceptance (`counted: 0`) whenever the required subagent call occurred in a checkpoint-resumed unit, while `unitKey` ignores added/changed sibling units.
4. **Uncounted multi-request turns & miscounted budgets (Finding 1):** Google `long_decode` continuation hops (`up to 16` billed requests) + `countTokens` / `compactConversation` execute inside `1` charged call ([packages/model-client/wire.mjs:96-123](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/packages/model-client/wire.mjs#L96-L123)); `implementUnits` catch overcharges full `stage_provider_calls` on `0`-call throws ([ophanim/operate/stages.mjs:977-980](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L977-L980)); and `runOpenItem` resume resets `made = 0` under `callsBefore + budget` ([ophanim/operate/stages.mjs:778-787](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L778-L787)).
5. **Quota ladder & false-positive quota classification defects (Finding 5):** `implementerPath` steps up thinking levels on the same quota-exhausted base model ([ophanim/operate/stages.mjs:353-357](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L353-L357)), `\b429\b` on `stderr` treats stack-trace line numbers as explicit quota exhaustion ([pantheon/src/agy/quota.mjs:31](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/agy/quota.mjs#L31)), and `API_FILES_REFUSED` consumes review revisions ([pantheon/src/pipeline/index.mjs:379](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L379)).
6. **Un-fenced executor side effects & restart hazards (Findings 3, 4, 8):** Stale lease holders overwrite `tickets/<item>.json` and shared Pantheon ledgers before `recordStage` fences them ([ophanim/operate/stages.mjs:698](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L698)); `service.lock` lives in `state_dir` rather than `work_root` ([ophanim/operate/service.mjs:113](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/service.mjs#L113)); `SIGKILL` mid-wave leaves `refs/heads/pantheon/pipeline/<run_id>` ([pantheon/src/pipeline/index.mjs:242](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/pantheon/src/pipeline/index.mjs#L242)); and carried findings from a killed pipeline run are dropped if the next attempt fails ([ophanim/operate/stages.mjs:925-934](file:///home/colchis/Projects/OPHANIM-a3-agy-77480d6/src/ophanim/operate/stages.mjs#L925-L934)).
7. **Run-record omissions (Finding 10):** `run.json` omits stage `stage_provider_calls` stops in `plan`/`review` from `budget_stops`, omits `final_gate.blocker` from `blockers`, skips open `plan_ledger`s when `plan` is `pending`, and checks `run_ledgers` structurally only (`defineKinds({})`).

---

**Reviewed by:** Lab `Google`, model `gemini-4-carbon` (Antigravity lane `gemini-4-carbon-high`, `served_model_source: input`), on commit `77480d6b262c92ceca5a159cc5be3e3ee627b922`.
