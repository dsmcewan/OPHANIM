# Foundry fix 1: the shared spending cap holds for every turn, a reused client's included

## Why

The owner, on 2026-11-21: "Write them up as OPHANIM requests." This is the most consequential of four foundry defects
found that day by testing PR #76's code (`ophanim/foundry/`, merged into `ophanim/dependency-graph` at `52bd1ee`). It
was tested with stand-in transports only; nothing reached a provider.

The foundry's own invariant (`ophanim/foundry/seats.mjs`, header): "ONE meter for the whole run: every turn of every lab
and every effort counts against maxUsd, and a turn is refused (402 FOUNDRY_BUDGET) once the meter reaches it." It must
never "let a transport's own cap mask the shared meter". At `52bd1ee` it does not hold.

## What happens, and why

- **The snapshot.** `seats.mjs:58` builds each transport's provider **once** per effort, with
  `maxUsd: Math.max(maxUsd - spentUsd(), 0)`: the shared budget left **at that moment**. It then reuses that provider.
- **The provider checks only itself.** The Claude command-line adapter refuses only when its **own** spend reaches that
  snapshot (`ophanim/foundry/claude-cli.mjs:82`). It passes `--max-budget-usd` from its **own** remainder (`:85`).
- **Nothing checks the shared total before a reused provider's turn,** although its comment (`seats.mjs:39-41`) says the
  shared meter is "checked before every turn".
- **Why the existing test passes.** `ophanim/tests/foundry-seats.test.mjs:52-59` builds its second transport only
  after the first has spent. That is the one case where the snapshot is current.

**The run that shows it** (`composeSeats` and `claudeCliClients` at `52bd1ee`, a stand-in `claude` command that records
its flag). The cap was $1 and the per-call cap $0.50; Claude turns cost $0.40 and API turns $0.50:

| Call | Shared left before | Grant passed to the CLI | Outcome | Shared spent after |
|---|---|---|---|---|
| 1 Anthropic | $1.00 | $0.50 | sent | $0.40 |
| 2 OpenAI | $0.60 | (API) | sent | $0.90 |
| 3 Anthropic, reused | $0.10 | **$0.50** | sent | $1.30 |
| 4 Anthropic, reused | **−$0.30** | $0.20 | **sent** | **$1.70** |
| 5 Anthropic | −$0.70 | | refused | $1.70 |

Call 4's flag was passed as `0.19999999999999996`.

## What to build

1. **The shared check, before every turn of every transport.** The shared remainder is the cap, less every provider's
   settled spend, less the grants of calls still outstanding. A turn with nothing left is refused `402 FOUNDRY_BUDGET`,
   whatever the provider's own meter says.
2. **The grant is computed at send time.** It is `min(perCallUsd, the shared remainder)`, worked out at the moment of
   the send, never from the snapshot taken when the provider was built. This applies to the command line's
   `--max-budget-usd` and to any per-call bound an SDK transport takes. It is passed rounded down to the cent, without
   float noise.
3. **An unknown cost is never counted as zero.**
   - A call whose cost is unknown counts at its whole grant until a cost is known.
   - A transport that takes no per-call grant cannot be bounded. Its call counts at the whole shared remainder while it
     is outstanding.
   - A receipt above its grant is recorded as an overrun, counted as reported, and named on the run record.
4. **The record keeps the grant.** The run's per-call rows record each call's grant beside its receipt.

## Left to you, the planner

Where the shared check lives (`composeSeats`, the transports, or both), and how outstanding grants are tracked. Trials
run one at a time today, but the check must also hold if they do not.

## Constraints

- No test reaches a provider: stand-in transports and a stand-in command only.
- The foundry's other invariants stay as they are: a trial is `live` only when every reachable transport is live, and an
  unreachable transport never serves.
- Records written before this change still read.

## Done means

- **Each rule has a test that fails on `52bd1ee`:**
  - **the sequence above, replayed deterministically:**
    - call 3 is sent with a grant of exactly $0.10, the shared remainder, which is below the $0.50 per-call cap;
    - the stand-in reports its specified $0.40, which is recorded as an overrun of $0.30 and counted;
    - call 4 is refused `402 FOUNDRY_BUDGET`;
  - **overlapping calls:** with a first call held open, a second call's grant is no more than the cap, less every
    settled receipt and the first call's outstanding grant. The unused part of the first grant is released when it
    settles;
  - the grant is no more than the shared remainder at every send, recorded through the real `claudeCliClients` and a
    stand-in command;
  - an unknown cost is counted at its grant.
- **Positive controls:**
  - a stand-in that honours its grant ends the same sequence at no more than $1.00;
  - a first call on a new transport with budget left is sent with its full grant;
  - `foundry-seats.test.mjs`'s existing cells still pass.
- A mutation runner for these rules, every mutation killed. `--check` on every runner passes, and the foundry's focused
  tests (`ophanim/tests/foundry*.test.mjs`) pass, on Node 24.
- A register entry with the next free `KG-` id on this branch.
