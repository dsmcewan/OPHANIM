# Foundry fix 2: while the history is thin, keep measuring, and say so

## Why

The owner, on 2026-11-21:
- "Write them up as OPHANIM requests."
- Asked which setup the next run should pick when a task class's history is only synthetic or too thin to be
  sufficient, the owner chose "**Keep measuring**". Until every setup has enough accepted trials, runs keep every setup
  in play; with one slot, the least-measured setup goes next; the record says the basis is synthetic or insufficient.

This refines the direction of 2026-11-20 ("A/B test and keep metrics of the best and fastest setup"; the next run
"starts from the best setup measured so far and tries one not yet measured beside it") for the case where "best so far"
rests on too little to mean anything. Tested on PR #76's code at `52bd1ee` (`ophanim/foundry/`, on
`ophanim/dependency-graph`) with the stand-in command line; nothing reached a provider.

## What happens, and why

- **The order.** `rankSetups` (`ophanim/foundry/setups.mjs:72`) orders setups by acceptance rate, then operation score,
  then **median time**, then cost. At equal scores, time decides.
- **Thin history still names a winner.** `sufficient` (`:73`) is false until every setup has `MIN_SAMPLES` (3)
  accepted trials, but a winner is named anyway.
- **The leader leads regardless.** `chooseArms` (`ophanim/foundry/foundry.mjs:64-68`) puts that winner first, with the
  basis "the best setup measured so far for this class of task", whether or not the history is sufficient and whether
  or not it is synthetic.

**The runs that show it.** The routing test's own setup (`ophanim/tests/foundry.test.mjs:58-85`), with the stand-in
command:
- 1,200 ms injected on Sonnet: Haiku wins.
- The same delay moved to Haiku: Sonnet wins.
- No delay, run three times: Sonnet, Sonnet, then Haiku, decided by 13, 14 and 67 ms of process timing.

Every one of these runs recorded `sufficient: false` and a SYNTHETIC uncertainty. The test's next run then narrows to
the leader with the basis "the best setup measured so far". So a choice made on noise or on an injected delay is carried
forward as if it were measured.

## What to build

1. **Keep measuring while insufficient.** While a task class's history is not sufficient, `chooseArms` keeps every
   eligible setup in play. Not sufficient means some setup has fewer than `MIN_SAMPLES` accepted trials.
   - With enough slots, every setup runs.
   - With fewer slots, the least-measured setups go first: fewest trials, ties broken by the existing ranking.
2. **Once sufficient, the existing rule applies:** the best setup leads, and one not yet measured is tried beside it.
3. **Only live trials make a live selection sufficient.** In a live run, synthetic trials stay on the record, labelled,
   but never count toward sufficiency.
4. **The basis says what it rests on.** Each arm's recorded basis names it:
   - **measuring:** how many accepted trials of the `MIN_SAMPLES` the setup has, and whether they are synthetic or live;
   - **the best setup measured so far:** only when the history is sufficient, and saying whether it is live or
     synthetic.

   "The best setup measured so far" is never recorded for insufficient history. The run record names whether the
   history it selected on was synthetic, live or mixed.

## Left to you, the planner

- the exact basis wording;
- whether `rankSetups`' `why` text changes with it;
- how a live run tells live trials from synthetic ones (the trial records' `live` flag and the graph's uncertainty
  statement are the starting points).

## Constraints

- No test reaches a provider.
- The independence and identity rules stay as they are: a trial whose served model differs is left out.
- Records written before this change still read.

## Done means

- **Each rule has a test that fails on `52bd1ee`:**
  - insufficient history keeps every setup in a run with enough slots;
  - with one slot, the least-measured setup is chosen, ties by the ranking;
  - the basis names insufficiency and synthetic history, and "the best setup measured so far" appears only when the
    history is sufficient;
  - a live run does not count synthetic trials toward sufficiency.
- **Positive control:** with sufficient live history, the best setup leads and one not yet measured is tried beside it.
- `ophanim/tests/foundry.test.mjs`'s expectations that change are changed only where this rule requires it, each one
  named in the change's report.
- A mutation runner for these rules, every mutation killed. `--check` on every runner passes, and the foundry's focused
  tests pass, on Node 24.
- A register entry with the next free `KG-` id on this branch.
