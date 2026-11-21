# Foundry fixes: delivery plan

> OPHANIM builds these itself, as four items. The coordinator found the defects on 2026-11-21 by testing PR #76's foundry
> code with stand-in transports, and wrote each one up as a request. OPHANIM's planner plans each fix, three labs review
> the plan, and the item goes through implement, review, validate and outcome. The coordinator does not write, review or
> merge the fixes.

**Where they build** (the owner's choice of 2026-11-21): on the foundry branch, `ophanim/dependency-graph`, where the
foundry lives (PR #76 merged there at `52bd1ee`). It is not on main.

**The four requests,** each the signed requirement of one item, in the order to run them:

1. `2026-11-21-foundry-fixes/fix-1-shared-cap.md`: a reused client spent $1.70 against a $1 cap. Most consequential;
   run it first.
2. `2026-11-21-foundry-fixes/fix-2-keep-measuring.md`: thin history picks a winner on noise. Uses the owner's
   "keep measuring" choice.
3. `2026-11-21-foundry-fixes/fix-3-unknown-served-model.md`: a missing served model is credited to the model asked
   for.
4. `2026-11-21-foundry-fixes/fix-4-day-tape-partition.md`: the day tape drops its last trade.

## Before starting

**Check these calls of the coordinator's before you register.** Each request states its call as a requirement, and
registering it makes the call yours:
- **Fix 1:**
  - with $0.10 left, call 3 is granted exactly $0.10, and is not refused;
  - an unknown cost counts at the call's whole grant;
  - a transport that takes no per-call grant counts at the whole shared remainder;
  - an overrun is recorded;
  - the grant is rounded down to the cent.
- **Fix 2:**
  - sufficiency is judged over every eligible setup, including a new one with no trial;
  - in a live run, only live trials count toward sufficiency;
  - ties among the least-measured setups are broken by the existing ranking.
- **Fix 3:** "the served model is not known" is its own reason, distinct from a mismatch.
- **Fix 4:** each of the last `r` blocks takes one extra trade (`r` the remainder), rather than the remainder being
  reserved.

**Use main's OPHANIM.** The foundry branch is behind main and has no `prompt` command. So you run main's OPHANIM from
your main checkout, with `--repo` set to a worktree of the foundry branch. Always pass your main ledgers as well:
without them, `--repo` moves the ledgers too.

Run in WSL with the four keys passed through (`WSLENV`), as before.

## Tasks

### Task 1: Set up the foundry worktree, once

- [ ] From your main checkout, on an up-to-date `main`:

  ```bash
  git fetch origin ophanim/dependency-graph
  git worktree add ../OPHANIM-foundry origin/ophanim/dependency-graph
  (cd ../OPHANIM-foundry && npm ci --ignore-scripts)
  L="--repo ../OPHANIM-foundry --status-ledger status/ledger --work-ledger status/work"
  ```

### Task 2: Register fix 1

- [ ] Run:

  ```bash
  node ophanim/operate/cli.mjs prompt $L \
    --file docs/superpowers/plans/2026-11-21-foundry-fixes/fix-1-shared-cap.md \
    --author "<your name>" --title "Foundry fix 1: the shared cap holds for every turn" --json
  ```

  Expected: an item ID (`prompt-` and a hex digest), authorized. Note it: it is `F1` below.

### Task 3: Run fix 1 alone

- [ ] Read what the work ledger has spent, with a tick that cannot spend:

  ```bash
  node ophanim/operate/cli.mjs tick $L > /tmp/ophanim-before.json
  S=$(node -p 'const t=require("/tmp/ophanim-before.json"); t.spent.calls + t.spent.reserved')
  G=$(node -p 'require("/tmp/ophanim-before.json").billing.used.gemini_api_primary')
  ```

- [ ] Run it. A suggested first cap is 200 provider calls and 100 billed Gemini requests, since these are small
  changes:

  ```bash
  node ophanim/operate/cli.mjs watch $L --item <F1> \
    --total-provider-calls $((S+200)) --gemini-api-primary $((G+100)) 2> /tmp/ophanim-f1.jsonl
  ```

- [ ] When it reaches outcome and you accept it, merge its shipped branch (`pantheon/<F1>`) into
  `ophanim/dependency-graph`. Then move the worktree to the new head:

  ```bash
  git fetch origin ophanim/dependency-graph
  git -C ../OPHANIM-foundry checkout --detach origin/ophanim/dependency-graph
  ```

  Fixes 1 and 3 both change `ophanim/foundry/claude-cli.mjs`, so each fix builds on the one before it.
- [ ] Send `node ophanim/operate/cli.mjs report $L --out ophanim-report-f1.md` to the coordinator.

### Task 4: Fixes 2, 3 and 4, one at a time

- [ ] For each, repeat Tasks 2 and 3 with its file and title, and with `--item` set to its own ID:
  - "Foundry fix 2: while the history is thin, keep measuring, and say so"
  - "Foundry fix 3: an unknown served model is never credited"
  - "Foundry fix 4: the day tape's blocks account for every trade"

## Expect

- **Scope:** `--item` limits dispatch to the one fix. Each tick still reconciles your other items against the foundry
  checkout, and may record intake and evidence-recovery entries for them, but it dispatches nothing for them.
- **A provider refusing your account:** without PR #84 on the main you run from, a refusal of the account (no credit, a
  bad key) uses up the fix's plan attempts. With #84 merged, the run stops instead and waits.
