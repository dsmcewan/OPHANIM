# OPHANIM routing, escalation and coordination review

Reviewed November 16, 2026 (America/New_York), at PR #6 head `94a115cbc8d9702e7f0edadc2718c46412921d5c`. This is a review of that implementation, not a claim about a later deployment. Product code was not changed during this audit.

**Conclusion:** the build path uses an explicit static role policy. Its difficulty-aware selector is not connected to initial dispatch. Several escalation, limit, coordination and accounting defects prevent a claim that the system is selecting efficient practices from evidence. The requested continuing best-practice evaluation is also absent from cycle completion.

The owner has now made determining effective model-routing and coordination practices a priority, with continued assessment every cycle. The companion cycle contract specifies that requirement; it is not implemented merely by publishing this review.

## Findings

### M1 — Initial dispatch bypasses task-fit selection

**Owner-priority policy/integration gap.** The default profile is `argo`. `roleTurn` uses `frontierCandidates` in its fixed order; the legacy profile walks `candidatesFor` in array order. Neither initial path calls `routeFor` or `selectFor`. Ticket `difficulty` selects an output tier, but it does not select the initial model. No prompt/history size is supplied to model selection.

Two otherwise equivalent fake-provider builds, one `easy` and one `hard`, both requested:

| Role | Actual first requested model | Effective output allowance |
|---|---|---:|
| Planner | `claude-fable-5-2` | 65,536 |
| Implementer | `gpt-6-astra` | 65,536 |

The scout received its separate explicit 700-token cap. The implementer probe deliberately stopped at its captured request, before generation/acceptance. This confirms the selection path, not task quality.

The static selection is labeled `OPERATOR` / “ARGO November model policy”; it is not an accidental SDK model fallback. However, it does not satisfy the new request to determine fit and efficiency per task. Pure selector tests passing do not establish that the production caller uses them.

**Change:** establish one effective role-selection policy used by planning, implementation, review and swarms. Admit by task needs and context before comparing eligible cost/latency choices. Keep explicit owner pins recognizable as overrides. Record the full selection reason and policy version. Do not silently replace existing approved policy based on an unmeasured quality ranking.

Sources: [default profile and candidate factory](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L160-L164), [actual dispatch](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L434-L455), [static role policy](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/route/frontier.mjs#L5-L11), [difficulty helper](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/route/protocol.mjs#L164-L181).

### M2 — P2: a recorded escalation stop does not stop acceptance repairs

After failed acceptance, the implementation applies `raise_effort` and `step_rung`; a `stop` decision leaves the slot in the outer revision loop. With the default Astra implementer identity, the first rejection recorded `stop`, but the run still made three implementation calls. Configuring eight revisions produced eight calls and seven `stop` records, all at the same model and effort setting.

The prompts include updated acceptance feedback: these are repeated configuration choices, not identical requests. The revision limit still bounds execution. The defect is that a terminal protocol decision has no terminal effect.

**Change:** honor stop per slot and end combined revision when no slot can proceed. If same-model repair remains desirable, give it a distinct, explicitly bounded action. Add an integration test proving no generation follows a terminal stop.

Source: [revision loop](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L737-L845).

### M3 — P2: per-slot model and pool overrides do not reliably reach the request

The selected per-slot seat is reduced to a vendor and model, and the work turn rebuilds candidates from a model pin. A ticket naming Luna plus a specific per-slot Sol override sent Luna. A specific `openai_second` pool override sent the request through `openai_first`.

**Change:** preserve the complete selected seat—including model, transport, pool and pool configuration—through initial work, retries and resume. Define and test override precedence. Do not re-resolve an explicit seat using the first pool in a registry.

Sources: [crew construction](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L671-L678), [work call](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L772-L774).

### M4 — P2: the Google adapter expands explicit small output caps

A fake Google call through `sendTurn` with `maxOutputTokens: 4000` sent 65,536. The same happened to a 700-token cap. Direct use of the shared client with `outputBudgetPolicy: 'explicit'` preserved both values, demonstrating that the lower-level capability exists but is not carried through the adapter. The reviewer call requests 4,000 tokens, so this affects an actual bounded-call pattern.

The larger allowance is not itself a billed token count. The problem is that the caller's bound and effective provider request disagree, which can permit more generation and undermine budget/context reasoning.

**Change:** propagate explicit output-budget policy through the adapter and seat API, and test the effective request on each fallback provider. Preserve long-decode defaults only when deliberately requested by the effective policy.

Sources: [reviewer's cap](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L911), [adapter handoff](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/sdk/adapter.mjs#L259-L276), [Google allowance expansion](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/packages/model-client/request.mjs#L76-L78).

### M5 — P2: token/cost evidence is dropped, and unknown cost becomes zero

In a complete fake-provider build, all four API results supplied 1,234 input and 56 output tokens. None of the four saved turn rows retained usage. The direct streamed adapter also returned `usage: null` despite a provider final carrying usage. Effective effort/output limits are absent from successful API turn rows.

A quota-fallback variant made five API invocations and saved four successful turns, with no structured routing-attempt record. Its error was retained in `progress.jsonl`; it was not entirely lost. Both runs declared a $0.01 limit, but all 12 publication spend rows omitted USD and the derived budget reported `$0` spent. This demonstrates unmeasured accounting defaulting to zero, not a real bill or a proven overspend. Publication counts are also not provider-request counts.

**Change:** retain usage and effective settings for every attempt, including refusals/truncations where available. Record routing attempts and outcomes as structured evidence. Represent unavailable cost as unknown; attach a versioned price source when estimating cost. Enforce provider-call/spend bounds at the generation boundary, including retries and coordination overhead, rather than treating commit bookkeeping as an API bill.

Sources: [saved API turn](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L421-L429), [publication accounting](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/dag.mjs#L205-L207), [missing USD becomes zero](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/runtime.mjs#L202-L205), [routing attempts discarded](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L450-L455).

### M6 — P2: the default legacy implementer is rejected as an API pin

With only a fake API planner override to avoid the real OAuth planner, both easy and hard legacy builds selected the declared AGY Sonnet lane, then failed before implementation with `Pinned model is not in the model registry`. The work call sends the lane model through an API-only registry lookup.

**Change:** retain the selected lane seat directly and resolve it using its declared transport. Add an integration case for the unmodified legacy implementer, with a mocked lane transport.

Sources: [legacy pin path](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-item.mjs#L446-L447), [API-only pin validation](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/route/frontier.mjs#L29-L35).

### M7 — Context admission is incomplete across model paths

`checkBudget` exits before counting tokens for capabilities without `inputCeiling` or `combined`. For Fable and Sol, an injected provider counter reporting two million input tokens was never called, and the fake generation endpoint was invoked. Astra and Google have active checks, so this is uneven coverage rather than absence everywhere. Separately, `routeFor` accepts an unknown-window lane for a two-million-token requirement after rejecting known smaller windows.

These are preflight probes, not evidence that an actual over-window request succeeded at a provider. They establish that local admission does not consistently protect the model window.

**Change:** reserve system/tools/history/output headroom before dispatch; require a supported count/qualified estimate and a known compatible context bound, or decompose/refuse with a named reason. Carry the actual context requirement into the live selector.

Sources: [budget guard](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/packages/model-client/request.mjs#L102-L112), [unknown window admission](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/route/protocol.mjs#L167-L173).

### C1 — P2: swarm coordination confuses transport vendors with model labs

The swarm deduplicates exploration by `vendor`. A controlled set containing Anthropic/Sonnet, AGY/Claude, then OpenAI/Sol selected the first two and returned success, although both selected models map to Anthropic. A second controlled set explored with Anthropic and OpenAI, then accepted an AGY/Claude judge sharing the Anthropic fork's lab.

The ordinary review rule already uses lab identity; the correction has not reached these coordination decisions.

**Change:** use `labOf(vendor, model)` for explore uniqueness, refutation exclusions and judge eligibility. Retain the fork's model/lab so later selection can enforce this. Add a regression where different transports serve the same model lab.

Sources: [exploration selection](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-swarm.mjs#L74-L81), [refutation and synthesis exclusions](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/board/run-swarm.mjs#L143-L163).

### C2 — P2: a failed reviewer has no supported cycle retry/resume path

One fake 503 left two of three reviews recorded. `closeCycle` refused because the third review was missing. Calling `reviewCycle` again on the same range refused the unclosed prior cycle before invoking any retry reviewer. The ledger still verified. Low-level manual completion is possible; this is a missing supported driver/CLI recovery path, not an irrecoverable ledger.

**Change:** resume an open cycle and retry only its missing/failed seats under the original bound brief and change. Retain prior valid responses, attempt limits and failure evidence. Do not create a new cycle to evade an unresolved one.

Sources: [open before reviewer calls](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/ledger/review-cycle.mjs#L55-L59), [required review count](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/ledger/cycle-kinds.mjs#L129-L148), [next-cycle guard](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/ledger/cycle-kinds.mjs#L172-L176).

### C3 — Owner-priority gap: cycle completion requires no retained practice decision

Two complete cycles with six injected reviewers closed `verified` with zero learning, practice-comparison or policy-disposition records. The close gate requires reviews and findings/resolutions; it does not require a coordination assessment or a decision the next dispatcher consumes.

Existing chair contribution, investigation ranking, retained history and continuity mechanisms should be reused. Their current presence does not supply the missing feedback connection: production dispatch does not consume a learned routing/coordination policy. Provider allocation is explicitly missing evidence, and existing scheduler qualification is scoped primarily to slots 1→3, not general seat-policy self-modification.

**Change:** implement the companion standing cycle contract. Every cycle must record a bounded assessment and a disposition—even `retain` or `insufficient_evidence`. Give actionable practice investigations priority in the existing dependency queue; independently qualify a scoped candidate before activation. A later cycle must identify the admitted decision it actually loaded. Historical cycle hashes and pinned TELOS authority must retain their existing meaning.

Sources: [current close gate](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/pantheon/src/ledger/cycle-kinds.mjs#L129-L148), [provider-allocation evidence gap](https://github.com/dsmcewan/OPHANIM/blob/94a115cbc8d9702e7f0edadc2718c46412921d5c/ophanim/efficiency/contributions.mjs#L148-L169).

## What worked in the checks

- Transport retries are bounded, authentication/invalid-request failures stop, and Retry-After/cancellation/deadline cases pass.
- SDK retry defaults are explicitly disabled by the adapter; this avoids hidden nested retry amplification.
- Existing effort/output escalation tests and review-triggered resume tests pass.
- Ordinary cross-lab review and byte-bound acceptance/ship gates remain active.
- Swarm stage checks, chair caps and isolated board publications exist. Chair caps count rounds, so they do not alone bound provider calls or dollar cost.
- Resume retains forced seat, effort, step count and pending reviewer feedback.

## Validation and scope

The evidence bundle includes scripts and machine-readable outputs for the captured model requests, stop behavior, overrides, Google caps, context guards, usage/accounting, swarm labs, failed-cycle recovery and missing learning records. They use disposable data and keys; no owner keys are needed to reproduce the audit.

Existing checks passed in these bounded groups: 30 client/output/budget checks; 42 routing/escalation/cooldown checks; 12 swarm/team/budget checks; 6 chair-investigation checks. These groups overlap; do not sum them as unique coverage. Passing unit checks did not catch the reproduced integration gaps.

No numerical savings, cheapest-model ranking, or current provider model availability/pricing was established. The repository's own evaluation documents scope these new routing rules to fakes and mark quality/cost comparisons unmeasured. No qualifying provider-routing dataset was found in the bounded matching local outputs inspected; that is not a claim about every machine or historical run.

**Execution qualification:** an initial exploratory Sol escalation test was not fully isolated and could reach the real AGY CLI instead of the fake injector. Its error record was lost during scratch cleanup after an assertion failure. Whether that attempt reached a provider or incurred cost could not be established. No test child remained. All retained final reproductions use fakes; packaged scripts explicitly block AGY CLI/SDK spawning. This uncertainty is excluded from evidence of live behavior.

The useful next step is to fix the deterministic routing/coordination defects and instrument actual requests first, then qualify a small matched live comparison under an explicit existing or separately approved budget. Green tests alone are not evidence of efficient model allocation.
