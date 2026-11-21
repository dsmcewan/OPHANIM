# Foundry fix 3: a served model that is not known is never credited to the model asked for

## Why

The owner, on 2026-11-21: "Write them up as OPHANIM requests." Tested on PR #76's code at `52bd1ee` (`ophanim/foundry/`,
on `ophanim/dependency-graph`) with the stand-in command line; nothing reached a provider.

The foundry's rule (`ophanim/foundry/trial.mjs`, header) is to never "count a trial whose served model differs from the
one asked for as a measurement of the one asked for". A served model that is **not known** is a third case, and it is
counted.

## What happens, and why

- **The adapter knows it is unknown.** When the command line's usage names no model, `ophanim/foundry/claude-cli.mjs:91`
  sets `served` to `null`.
- **The reply then claims the requested model.** `:100` replies with `model: served ?? requested`.
- **The pipeline records that as served.** It takes the reply's model as the turn's `served_model`
  (`pantheon/src/sdk/adapter.mjs:285`).
- **So the identity check passes.** `identity_ok` (`trial.mjs:127`) compares that to the requested model, and finds
  them equal.

**The run that shows it.** The foundry's adder request, with a stand-in command whose output carries no `modelUsage`
for Haiku:
- the trial recorded `identity_ok: true`;
- both builder turns were recorded as served by Haiku;
- Haiku was ranked, and won.

The existing control (`ophanim/tests/foundry.test.mjs:112-117`) covers a served model that **differs**, and passes. It
never reaches this branch.

## What to build

1. **An unknown served model stays unknown end to end.** The adapter's reply and its call row say the served model is not
   known; they do not name the requested model in its place. The turn records it as unknown, and `identity_ok` is false
   for it.
2. **Such a trial is left out of the ranking and of the graph,** with its own reason: the served model is not known. This
   is distinct from "the served model was not the one asked for". It stays on the record as a trial.
3. **Every transport the foundry composes does the same:** an identity its provider did not report is never filled in
   from the request.

## Left to you, the planner

How "unknown" is carried through the pipeline. Pantheon's `served_model_source` values (`provider`, `input`, `unnamed`)
are a starting point. A reply object may still need a `model` string, so the unknown must be explicit rather than
silently filled.

## Constraints

- No test reaches a provider.
- The mismatch rule and its control stay as they are.
- Records written before this change still read.

## Done means

- **Each rule has a test that fails on `52bd1ee`:**
  - no `modelUsage` gives a trial left out with the reason "the served model is not known", not ranked and not on the
    graph;
  - the adapter's call row and reply carry the unknown and not the requested model.
- **Positive controls:**
  - a served model equal to the requested one is credited;
  - the existing mismatch control still leaves a mismatched trial out.
- A mutation runner for these rules, every mutation killed. `--check` on every runner passes, and the foundry's focused
  tests pass, on Node 24.
- A register entry with the next free `KG-` id on this branch.
