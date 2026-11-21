# Paired audit: delivery plan

> OPHANIM builds this protocol itself, as one item (the owner's direction of 2026-11-21). OPHANIM's planner plans it,
> three labs review the plan, and the item goes through implement, review, validate and outcome as any item. The
> coordinator does not write, review or merge the change.

**The request:** `2026-11-21-paired-audit/request.md`, the signed requirement of the item. It is separate from the
launch-order follow-up and from the other requests, so each can move on its own.

**Where it sits in the owner's order:** outside it. The owner's run order is specialized builders A, then B, then
foundry fix 1. When this item is registered and run is the owner's choice.

## Before starting

- **Merge first.** Merge the pull request that carries this request, then `git checkout main && git pull --ff-only`.
- **Keys and ledger.** Run in WSL with the keys passed through (`WSLENV`), with your status keys where the CLI finds
  them, as for the other items.
- **Credit and caps.** Before a paid run, confirm the planner account has usable credit, and choose the spend caps.
- **PR #84.** Merge it first, so a provider refusing the account stops the run instead of using up its attempts.

## Tasks

### Task 1: Register the item

- [ ] Run:

  ```bash
  node ophanim/operate/cli.mjs prompt \
    --file docs/superpowers/plans/2026-11-21-paired-audit/request.md \
    --author "<your name>" --title "Paired audit: sealed, then challenged" --json
  ```

  Expected: an item ID (`prompt-` and a hex digest), authorized.

### Task 2: Run it alone

- [ ] Read what the work ledger has spent, with a tick that cannot spend. Then run it with `watch --item <ID>` and
  caps you choose, as in the other plans.
- [ ] Send `node ophanim/operate/cli.mjs report --out ophanim-report-paired-audit.md` to the coordinator.

## After it lands

The first audit under the protocol is led by Fable for self-awareness and by Astra for accountability, on the candidate
the owner names; the leads swap on the next comparable item. Under `fit`, every plan is written by an Anthropic
planner, so Fable's audit of such a candidate is recorded as a same-lab audit, and the paired audit never counts toward
an item's three-lab review panel.
