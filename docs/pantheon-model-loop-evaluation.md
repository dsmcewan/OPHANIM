# Loop evaluation: Pantheon's model paths

> **Scope of what is proven** (added after the independent review of 2026-11-16, finding FW1). OPHANIM's `prove` and `verify` run against fixture authority: a candidate is accepted when its output equals the obligation's stored `expected` value (`ophanim/governance/check-contract.mjs`), and the three TELOS reviewer approvals are generated and signed by the same process that needs them (`ophanim/governance.mjs`). They therefore certify crash consistency and record integrity, not that work without a stored answer can be verified. Model turns in the suites run against scripted fakes; no live provider is called in CI. Binding real reviewers to the ledger is item K6 on the [status board](STATUS.md), a governance decision.

Companion to [loop-evaluation.md](loop-evaluation.md). That document covered OPHANIM's controller. This one applies the same loop steps to how each of the 19 registered models is called, recorded and continued.

Scope: `packages/model-client`, plus Pantheon's `src/sdk/{adapter,stream,seat-sdk}.mjs` and `src/seat`, `src/route`. Everything was evaluated and tested with injected fake clients. No live vendor calls were made.

## 1. Two routes, one loop

Each model reaches a vendor by one of two routes. `isFrontier(model)` decides which.

- **Frontier client** (`packages/model-client`, `sendModelTurn`). It covers the 6 models with a `CAPABILITIES` record: `claude-fable-5-2`, `gemini-4-carbon`, `gemini-4-argon`, `gpt-6-astra`, `grok-4.3`, `grok-4.7`.
- **Direct adapter** (`pantheon/src/sdk/adapter.mjs` and `stream.mjs`). It covers the other 13.

| Loop step | Frontier client | Direct adapter (before this change) |
|---|---|---|
| Stabilize on the known | `prepareRequest` refuses a model without a capability record. Effort and output budget are checked against that record. | Builds the request from the adapter table. There is no per-model record. |
| Validate before applying | `checkBudget` requires a provider token count for models with an input ceiling or combined window. | None. |
| Apply | `exchange`. Gemini continuation hops are bounded, and a repeated checkpoint is refused. | `client.*.create` / `generateContent` |
| **Validate ground truth** | A turn counts only on the provider's **successful terminal state**: Responses `status:'completed'`, Messages `stop_reason ∈ {end_turn, tool_use, stop_sequence}`, Gemini `finishReason:'STOP'` with no `blockReason`. | **Only on the presence of an id or a terminal event.** A truncated reply (`incomplete`, `max_tokens`, `MAX_TOKENS`) was marked `usable_for_resume: true`. |
| Record what changed | Opaque history is kept verbatim: Responses items, Anthropic blocks with signatures, Gemini parts with thought signatures. | Responses items were kept. **Gemini replay kept only the text**, and streamed Anthropic replay kept only the text. |
| Handoff | `seat-sdk.sdkTurn` (shared): an intent file before the call, and a two-phase history write. | Same. **The stored `chain` was never re-checked against the stored `exchanges`** before a turn built on them. |
| Assignment | `route/frontier.mjs` and `routeCall` choose candidates by role, credential pool and cooldown. | `route/router.mjs` uses recorded facts only. |

## 2. Per-model result

How each model was tested: two fake turns per transport (unary and streamed), one ending in the provider's success state and one in a truncation (`tests/model-terminal-state.test.mjs`). "Before" is the same test run against the unchanged source.

| Vendor | Model | Route | Surface | Truncation accepted before (unary / streamed) | After |
|---|---|---|---|---|---|
| OpenAI | gpt-6-luna | direct | responses | yes / no | refused |
| OpenAI | gpt-6-sol | direct | responses | yes / no | refused |
| OpenAI | gpt-6.1-sol | direct | responses | yes / no | refused |
| OpenAI | gpt-6-astra | frontier | responses | no / no | refused |
| xAI | grok-4.3 | frontier | responses | no / no | refused |
| xAI | grok-4.5 | direct | responses | yes / no | refused |
| xAI | grok-4.6 | direct | responses | yes / no | refused |
| xAI | grok-4.7 | frontier | responses | no / no | refused |
| xAI | grok-4.20-multi-agent | direct | responses | yes / no | refused |
| xAI | grok-build-0.1 | direct | responses | yes / no | refused |
| Google | gemini-3.5-flash | direct | genai | yes / yes | refused |
| Google | gemini-3.8-flash-high | direct | genai | yes / yes | refused |
| Google | gemini-4-carbon | frontier | genai | no / no | refused |
| Google | gemini-4-argon | frontier | genai | no / no | refused |
| Anthropic | claude-haiku-4-5-20251001 | direct | messages | yes / yes | refused |
| Anthropic | claude-sonnet-5 | direct | messages | yes / yes | refused |
| Anthropic | claude-opus-5 | direct | messages | yes / yes | refused |
| Anthropic | claude-opus-5-5 | direct | messages | yes / yes | refused |
| Anthropic | claude-fable-5-2 | frontier | messages | no / no | refused |

19 of the 26 direct-path combinations accepted a truncated reply as a usable turn. On the direct path, a Messages call that names no `max_tokens` is capped at 1024 output tokens (`adapter.mjs`). So any long reply from the four direct Anthropic models stopped at `max_tokens` and was recorded as complete.

## 3. Implemented

**M1. One terminal-state rule for every model.**
- `packages/model-client/terminal.mjs` exports `terminalState(surface, observed)` and `successfulStop`. The frontier client's `wire.mjs` now imports `successfulStop` from it.
- The direct adapter applies the rule on every path: unary Responses in server and replay mode, Messages replay, and Gemini replay.
- The streamers report the provider's terminal state on `done`. Responses streams now treat `response.incomplete` as an error. Anthropic streams capture `stop_reason` from `message_delta`. Gemini streams capture `finishReason` and `blockReason`.
- `streamTurn` sets `complete` only when a terminal event arrived *and* its state is a success.
- An unreported state is not a success. Results carry `terminal_state` and name the reason when they refuse.

**M2. Replay keeps what the provider returned.**
- Direct Gemini replay, unary and streamed, stores the model's own parts, thought signatures included.
- Direct Anthropic streamed replay stores the content blocks (text, thinking with signatures, tool_use with parsed input), not the joined text. Unary already kept them.

**M3. Handoff checks the trail.** Before `sdkTurn` builds on a seat record, it recomputes the chain from the stored `exchanges`. If that chain differs from the stored `chain`, it refuses with `code: "CHAIN_MISMATCH"` and persists nothing.

**Tests.**
- `pantheon/tests/model-terminal-state.test.mjs` has 42 tests. They walk all 19 models in both modes and cover M2 and M3.
- Test fakes that represent completed responses in five existing test files now carry the terminal field a real provider always sends: `status`, `finishReason` or `stop_reason`.

**Results.**
- Pantheon suite: 734 pass and 27 fail. Before the change it was 692 pass with the same 27 failing; those tests need `bwrap` and user namespaces, which the sandbox lacks.
- Model-client suite: 42 pass.

## 4. Found but not changed

Each of these needs a fact or a decision this change does not have.

1. **No capability record for 13 models**, so there is no pre-generation budget check on the direct path.
   - The vendor-model-facts spec marks several windows and output limits as UNRECORDED. Inventing them would break the project's own rule.
   - Moving these models onto the frontier client needs their verified window, output limit and effort levels.
2. **Direct Messages `max_tokens` defaults to 1024.**
   - M1 turns long direct-path Anthropic replies from silent truncation into refused turns.
   - Whether the default should rise, or callers must set it explicitly, is a policy choice.
3. **Conflicting `reasoning.context` for OpenAI.**
   - The direct replay path sends `reasoning: {context: 'all_turns'}`.
   - The frontier client deletes `reasoning.context` for OpenAI.
   - One of them is wrong for the current API. Settling it needs the vendor documentation or a live check.
   - **Resolved from the vendor documentation (2026-11-16), and both were wrong.** Sources on developers.openai.com: `guides/reasoning#preserve-reasoning-across-calls`, `guides/deployment-checklist#use-reasoningencrypted_content` and `guides/latest-model`.
     - The values are `auto`, `current_turn` and `all_turns`. Omitting the field means `auto`, the model's default.
     - `all_turns` is documented for the GPT-5.6 family and GPT-6.1 Sol.
     - The docs conflict on GPT-6 Astra: the checklist shows it with `all_turns`, while the reasoning guide's supported list leaves it out. GPT-6 Sol and Luna are not stated.
     - The response's own `reasoning.context` field reports the effective mode.
     - Reasoning carries over only within one model family.
     - Nothing in the docs covers xAI.
   - **Implemented** in `packages/model-client/reasoning.mjs`, which both paths now use:
     - `reasoningContextFor` validates a requested value and passes it through. The frontier client no longer strips it.
     - With no request, it asks for `all_turns` on replay only for documented models (`gpt-6.1-sol`). Otherwise it omits the field, so the model's default applies. The direct path no longer sends `all_turns` to every OpenAI and xAI model.
     - The field is never sent to xAI, and an explicit request for xAI is refused.
     - `reasoningContextReport` records `{requested, effective, honoured}` from the response on the frontier and direct Responses paths, unary and streamed. A provider that used another mode is reported, not assumed.
   - **Tests:** `packages/model-client/tests/reasoning-context.test.mjs`, plus a new case in `pantheon/tests/sdk-transport.test.mjs`. The transport test that asserted the blanket `all_turns` now asserts that no undocumented mode is sent.
   - **Still unverified:** whether GPT-6 Astra, Sol and Luna accept `all_turns`. The docs do not settle it, so these models get their default until a live call or clearer docs show otherwise. The recorded effective mode is what would show it.
4. **Seat records don't record the model.**
   - A seat keyed on `vendor + purpose + cwd` can be continued by a different model of the same vendor. Replay history, including signatures produced by one model, is then sent to another.
   - Recording the model in the seat record would mean widening `saveSeat`'s field allowlist.
   - **Implemented.**
     - `saveSeat` accepts a validated `model` and a `model_gen` counter.
     - `sdkTurn` resolves the answering model (the explicit one, or the adapter default) and records it.
     - A turn by a different model is refused with `MODEL_CHANGED`, leaving the record untouched, unless the caller passes `reseatModel: true`. Then the change is recorded and `model_gen` advances.
     - A legacy seat without a model adopts it on its next turn, without counting that as a reseat.
   - **Who is affected:**
     - `run-item` is not: it already keys each model to its own seat (`purpose@pool@model`).
     - The live view is: it keys seats by `vendor/purpose`, so switching a pane's model now shows `MODEL_CHANGED` instead of continuing silently.
   - *Check:* `pantheon/tests/seat-model.test.mjs`.

## 5. How to check

```sh
npm --prefix packages/model-client test
cd pantheon && node --test tests/model-terminal-state.test.mjs tests/sdk-*.test.mjs
```

To see the gap, run `model-terminal-state.test.mjs` against the previous `adapter.mjs` and `stream.mjs`: 22 of its 42 tests fail.
