# Foundry fix 4: the day tape's blocks account for every trade, once, in order

## Why

The owner, on 2026-11-21: "Write them up as OPHANIM requests." Tested on PR #76's code at `52bd1ee` (`ophanim/foundry/`,
on `ophanim/dependency-graph`) against the committed tape; nothing reached a provider.

## What happens, and why

- **The partition.** `blocks` (`ophanim/foundry/requests/market-maker-day/seed/sim.mjs:85`) cuts the tape into 6 blocks
  of `Math.floor(13387 / 6)` = 2,231 trades each. That covers 13,386 trades.
- **The last trade falls in no block.** Trade index 13386 is in neither the acceptance blocks (the first two) nor the
  operation blocks (the other four).
- **The test checks only counts and sizes.** `ophanim/tests/foundry-market-maker-day.test.mjs:27-31` checks the tape's
  length, the number of blocks and their size. It never checks that the blocks, joined, are the tape. A count-only
  check would also pass a partition that repeats one trade and drops another.

**The run that shows it.** The committed tape (13,387 trades) through `blocks()`: 13,386 joined, 1 missing, at index
13386.

## What to build

1. **Every trade is accounted for, exactly once, in its original order.** The remainder goes to the last block, so
   blocks differ by at most one trade. That keeps every trade in use. The acceptance still replays the first two
   blocks, and the operation the other four.
2. **The test checks the join, not the counts.** It asserts the joined blocks equal the tape, by trade and in order.

## Left to you, the planner

How the operation's reported figures (shares, fills, PnL) change with the one extra trade, stated in the change's
report. Any recorded figures or expectations that depend on the old partition are updated, each named.

## Constraints

- No test reaches a provider or the network.
- The tape and its metadata are not changed.
- The acceptance blocks are never touched by the operation.

## Done means

- **Each rule has a test that fails on `52bd1ee`:**
  - the joined blocks equal the tape, which fails today with 1 missing;
  - a crafted tape whose partition would repeat one trade and drop another is caught by the join, where a count would
    miss it.
- **Positive control:** a tape whose length divides by 6 gives six equal blocks, as today.
- A mutation runner for these rules, every mutation killed. `--check` on every runner passes, and the foundry's focused
  tests pass, on Node 24.
- A register entry with the next free `KG-` id on this branch.
