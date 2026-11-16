# Vendor model and effort facts — read 2026-09-27

Every figure here was fetched from the vendor's own documentation on 2026-09-27 and is quoted or
transcribed, not recalled. Where a vendor's docs do not state something, this file says
**UNRECORDED** rather than guessing: an invented context window or effort default is worse than an
absent one, because it gets cited.

## Anthropic — platform.claude.com

`@anthropic-ai/sdk` 0.128.0 installed. First-party CLI is **`ant`**, listed alongside seven client
SDKs; this repo drives none of them.

| model ID | context | max output | default effort | price in/out per MTok |
|---|---|---|---|---|
| `claude-fable-5-1` | 1M | 128K | `high` | $10 / $50 |
| `claude-opus-5-5` | 1M | 128K | `medium` | $4 / $20 |
| `claude-sonnet-5` | 1M | 128K | `high` | $2 / $10 |
| `claude-haiku-4-5-20251001` | 200K | 64K | **not supported** | $1 / $5 |

- `claude-opus-5` is listed under **"Legacy models (still available)"**. The current opus is
  `claude-opus-5-5`. The planner ladder names `claude-opus-5` because the operator said "Opus"; the
  distinction is recorded here so the choice is visible rather than accidental.
- Thinking is "Adaptive (always on)" on Fable and Opus 5.5, "Adaptive" on Sonnet 5, "Extended" on
  Haiku 4.5. Extended thinking (`thinking.type: "enabled"` + `budget_tokens`) is **not accepted** on
  models after Opus 4.6 / Sonnet 4.6.
- `max_tokens` is **required** on `messages.create`.
- The SDK retries 429, 408, 409 and >=500 **twice by default**. This repo sets `maxRetries: 0` so the
  harness owns retry; see the note in `src/sdk/adapter.mjs`.
- A non-streaming request expected to run past ~10 minutes is **refused by the SDK**, and the default
  timeout scales with `max_tokens` up to 60 minutes.

## OpenAI — developers.openai.com

`reasoning.effort` accepts, **model-dependent**:

    none  minimal  low  medium  high  xhigh  max

- **GPT-6 Astra does not support `none`.**
- GPT-6 Sol and Luna default to `medium`. GPT-5.5 and GPT-5.6 also default to `medium`.
- Context windows and max output: **UNRECORDED.** The models catalogue lists names and descriptions
  only; the figures live on per-model pages not fetched here. So `SEAT_FACTS.openai` carries no
  `windows` map, and no seat may claim a CONTEXT basis on this lab until it does.

## xAI — docs.x.ai

| model ID | context |
|---|---|
| `grok-4.7` | 500k |
| `grok-4.6` | 500k |
| `grok-4.5` | 500k |
| `grok-4.3` | 1M |
| `grok-4.20-0309-reasoning` | 1M |
| `grok-4.20-0309-non-reasoning` | 1M |
| `grok-4.20-multi-agent-0309` | 1M |
| `grok-build-0.1` | 256k |

- **`grok-4.20-multi-agent` was the wrong ID.** The documented one is
  `grok-4.20-multi-agent-0309`. A wrong model id is a runtime failure, so this is corrected in
  `SEAT_FACTS`.
- `grok-4.7` exists and is newer than the `grok-4.6` this repo defaults to. Left as the default
  because nothing here has measured either, and switching on novelty is not a basis.
- Reasoning effort: **UNRECORDED** on the models page.
- Base URL and OpenAI-SDK compatibility: not stated on that page. This repo's `base_url`
  (`https://api.x.ai/v1`) and OpenAI-surface use are justified by executed conformance tests, not
  by that page.

## Antigravity — antigravity.google/docs/models

The official models page lists what the **editor** offers:

    Gemini 3.8 Flash   Gemini 3.7 Flash   Gemini 3.6 Flash   Gemini 3.1 Pro
    Claude Sonnet 4.6 (thinking)   Claude Opus 4.6 (thinking)   GPT-OSS-120b
    Nano Banana 2 (image generation, used by the agent's mockup tool)

**This corrects a recorded claim of mine.** `NOT_SEATED.agy` said "Gemini, Opus 4.6 and GPT-OSS" —
seven models, not three. More importantly:

- The official page gives **no API model IDs, no context windows, no base URL, no auth scheme and no
  quota detail**. It documents an editor, not an API.
- ~~So the claim that agy has "a Python SDK and a CLI emitting `--output-format stream-json`" remains
  **UNVERIFIED**.~~ **VERIFIED 2026-09-27, later the same day**, against the installed software rather
  than a page:
  - The SDK is first-party: `google-antigravity` 0.1.18 (`import google.antigravity`), installed at
    `~/Projects/agentic-pipeline/sdk/.venv-antigravity`, documented at
    `https://antigravity.google/docs/sdk/` and `github.com/Google-Antigravity/antigravity-sdk-python`.
    It bundles the Go `localharness` binary (128 MB) and takes `GEMINI_API_KEY`. Contract read from
    the package: `LocalAgentConfig(model, system_instructions, workspaces, tools, subagents,
    capabilities, policies, hooks, triggers, budget_config, response_schema)`; `SubagentConfig`
    (static, scoped tools, `max_subagent_depth`, `allowed_subagents`); hooks `pre_turn`,
    `post_turn`, `pre_tool_call_decide`, `post_tool_call`, `on_tool_error`, `on_interaction`,
    `on_compaction`, `stop`; triggers `TriggerContext.send()` pushes a message into the agent;
    the harness exposes `invoke_subagent`, `define_subagent`, `manage_subagents` and `send_message`
    when subagents are enabled. First live turn from this repo: `outputs/agy-smoke/sdk1/result.json`
    (gemini-3.7-flash, 22 s, 5 tool calls, 1 subagent, 106,340 prompt tokens of which 32,508 cached).
  - The CLI is `agy` 1.2.11: `-p/--print`, `--output-format text|json|stream-json`
    (`init`/`step_update`/`result` events, `step_update` carrying `subagent_info`), `--input-format
    stream-json`, `--json-schema`, `--agent <name>` selecting a custom agent from
    `.agents/agents/<name>/agent.md` (YAML frontmatter `name`, `description`, `tools`, `mainAgent`,
    `subagent`, `model: inherit|flash|pro`, `commandExecutionPolicy`, `agents`, `skills`; body = system
    prompt), `@<subagent> <message>` to message a running subagent, `AGY_ERROR` JSON on stderr with
    exit 3. `agy models` on this login lists gemini-3.8/3.7/3.6-flash-{high,medium,low},
    gemini-3.1-pro-{high,low}, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium.
    Headless runs auto-deny `run_command` unless `permissions.allow` carries a rule or
    `--dangerously-skip-permissions` is passed (`outputs/agy-smoke/smoke2.json`, `denied_actions`).
- The "one subscription, so fan-out across its models contends on one pool" claim stands as
  **plausible and unverified** — the models page only points at a plans page for rate limits.
- The routing layer outside this repo could not admit the seat: `~/.claude/skills/multi-model-seats/
  scripts/build-candidate-table.mjs` has no Antigravity reach source, so `route-cli.mjs` never lists
  `antigravity` as present and the seat-plan gate has nothing to authorize. Worked around for this
  run with a `--table` override built from a live `models.list` (32 Gemini rows with
  `inputTokenLimit` as `context_window`); the table gap itself is unfixed and recorded here.

## Where each Claude model is actually selected — added 2026-09-28

Answering "what are the Claude model selections" against the running code, not from memory. Every
model ID below is read from `src/config/models.json`, referenced by name (`modelId(vendor, name)`)
from `src/role/seating.mjs`, `src/route/router.mjs` and `src/sdk/adapter.mjs` — one spelling, three
readers, after 2026-09-28's consolidation (`src/config/models.mjs`).

| where | model | why |
|---|---|---|
| `SEATING.planner`, hard band | `claude-fable-5-1` | top of the operator's ladder for planning; 1M window, always-on thinking (see the Anthropic table above) |
| `SEATING.planner`, medium band | `claude-opus-5` | same 1M window; FIT split, not a demotion — see `seating.mjs`'s BAND doc comment |
| `SEATING.planner`, easy band | `claude-sonnet-5` | same window again; the better pick on a one-line brief, no always-on thinking overhead |
| `SEATING.reviewer`, last reseat | `tier: "default"` → `SEAT_FACTS.anthropic.models.default` = `claude-haiku-4-5-20251001` | only reached when both xai and agy_google are already disqualified by the isolation rule; ISOLATION basis |
| `SEATING.judge`, rank 0 | `tier: "strong"` → `claude-sonnet-5` | must not have produced any of what it reads; `assertJudgeEligible` overrides this order at runtime |
| `ADAPTERS.anthropic.default_model` (`src/sdk/adapter.mjs`) | `claude-haiku-4-5-20251001` | **changed 2026-09-28** (was `claude-sonnet-5`) — this is `sendTurn`'s fallback when a caller omits `model` entirely; an unspecified call should cost the least, not the flagship's price. See `tests/adapter-cheap-default.test.mjs`. |
| `NOT_SEATED["claude-fable-5-1"]` | — | named for completeness: `seating.mjs` also documents fable as "a session tier used to design and hand off, not a vendor this harness calls" in one comment, while `SEATING.planner` literally seats it as a real, called model. Both statements are in the source; this file does not resolve the tension, only surfaces it. |

### The `agy_google` merge, and why it does NOT contradict this file's own Antigravity section above

2026-09-28 merged the vendor identifiers `"google"` (raw Gemini API) and `"agy"` (the Antigravity
SDK Agent subprocess) into one, `"agy_google"`, because both authenticate with the same
`GEMINI_API_KEY` — verified against `antigravity.google/docs/sdk/overview/` ("The SDK uses API key
authentication... Gemini API key") and against this file's own SDK section above (`GEMINI_API_KEY`,
`google-antigravity` 0.1.18).

That merge is scoped correctly to what `scripts/agy-seat.py` actually calls: `AGY_SEAT.lanes.sdk`
(`src/role/seating.mjs`), the **SDK** lane. It is NOT scoped to `AGY_SEAT.lanes.cli`, the **CLI**
lane (`agy` 1.2.11) — and this file's own evidence above shows why that distinction matters: `agy
models` on the operator's real login lists `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and
`gpt-oss-120b-medium` alongside the Gemini rows — a genuinely broader, multi-vendor roster,
consistent with what `NOT_SEATED.agy`'s corrected comment already found (seven models, not three,
just not the three originally guessed). Pantheon's own `AGY_SEAT.lanes` comment says the CLI lane
is unused by default ("headless mode auto-denies `run_command`... which is why the sdk lane is the
default"), which is why the merge is safe today. If the CLI lane were ever seated instead, folding
it into `agy_google` would be wrong — it can reach non-Gemini models on what may be a different
credential/quota than `GEMINI_API_KEY`, an open question this file already marked **unverified**
("one subscription, so fan-out... contends on one pool" — plausible and unverified) before today.

## What this file does NOT license

Nothing here measures quality. Context window, effort defaults, price and API shape are facts;
"which model is better at planning" remains in `UNMEASURED` in `src/route/router.mjs`.

## Re-read 2026-11-16: cited records for every registry model

The machine-readable record is `src/config/capability-facts.json`. Every figure in it carries the vendor URL and the quoted text; anything a vendor does not state is `UNRECORDED`. `src/config/facts.mjs` computes where the code disagrees, and `tests/capability-facts.test.mjs` pins that list. A new disagreement fails the test, and fixing one means removing it from the list. This section supersedes the figures above where they differ. For example, the current Fable is `claude-fable-5-2`, not `-5-1`.

| model | window | max output | efforts (default) | note |
|---|---|---|---|---|
| gpt-6-luna, gpt-6-sol | 1,050,000 | 128,000 | none…max (medium) | max input 922,000; ×2 pricing over 272K input; 6-sol points to 6.1-sol as newer |
| gpt-6.1-sol | 1,050,000 | 128,000 | low…max (medium) | the only GPT-6 model documented for `reasoning.context: all_turns` |
| gpt-6-astra | 1,050,000 | 128,000 | low…max (not stated) | `none` returns HTTP 400 |
| grok-4.3 | 1,000,000 | UNRECORDED | none…xhigh (low) | |
| grok-4.5, grok-4.6, grok-4.7 | 500,000 | UNRECORDED | low…xhigh (high) | |
| grok-4.20-multi-agent | 1,000,000 | `max_tokens` unsupported | low/medium = 4 agents, high/xhigh = 16 | alias of `-0309`; Responses or xAI SDK only; no custom tools |
| grok-build-0.1 | 256,000 | UNRECORDED | UNRECORDED | |
| gemini-3.5-flash | 1,048,576 | 65,536 | UNRECORDED | **deprecated; routed to Gemini 3.6 Flash** |
| gemini-3.8-flash-high | — | — | — | **not a Gemini API id**; the agy CLI's name for gemini-3.8-flash at high thinking |
| gemini-4-carbon, gemini-4-argon | 1,048,576 (input + output) | 65,536 sync, up to 1,048,576 with long decode | low…high (medium) | |
| claude-haiku-4-5-20251001 | 200K | 64K | not supported (extended thinking) | legacy; retirement "not sooner than October 15, 2026" |
| claude-sonnet-5, claude-opus-5 | 1M | 128K | five levels (high) | legacy; current lines are sonnet-5-5 and opus-5-5 |
| claude-opus-5-5 | 1M | 128K | five levels (medium) | |
| claude-fable-5-2 | 1M | 128K | five levels (high) | |

Disagreements between the code and these facts, as of this reading:
- **`CAPABILITIES` efforts:** `gpt-6-astra` allows `ultra`, which its page does not list. `grok-4.3` and `grok-4.7` allow only `low` and `high`, but the docs give `none…xhigh` and `low…xhigh`.
- **Router escalation ladder:** for all four GPT-6 models the ladder climbs to `ultra`. No OpenAI model page lists `ultra`. It comes from a client configuration reference, not the API.
- **Registry:**
  - `gemini-3.8-flash-high` is registered as a Gemini API model but belongs to the agy CLI lane.
  - `gemini-3.5-flash`, the agy_google API default, is deprecated.
