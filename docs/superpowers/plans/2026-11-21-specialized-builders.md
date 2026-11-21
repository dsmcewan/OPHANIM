# Specialized builders: delivery plan

> OPHANIM builds this change itself (the owner's decision of 2026-11-21). So this plan has no coding tasks: its
> tasks are registering the two items and running them. OPHANIM's planner writes each item's plan, three labs review
> it, and the item goes through implement, review, validate and outcome as any item. The coordinator does not write,
> review or merge the change.

**Goal:** OPHANIM builds with real trades, and with each code unit's tests written first by a separate session.

**Spec:** `docs/superpowers/specs/2026-11-21-specialized-builders-design.md` (approved by the owner on 2026-11-21).

**The two requests:** each is the signed requirement of one item, registered verbatim.
- `docs/superpowers/plans/2026-11-21-specialized-builders/item-a-trades.md`: the trade catalogue, the playbooks and
  the path rules.
- `docs/superpowers/plans/2026-11-21-specialized-builders/item-b-tests-first.md`: depends on item A. It covers the
  tests session, the red check, read-only tests, the reviewer's inputs and revision routing.

## Launch order (the owner's choice, 2026-11-21)

**Specialized builders A, then B, then foundry fix 1, then foundry fixes 2 to 4.** This is a sequencing choice, not a
dependency between the items. The foundry fixes are run with main's OPHANIM (see the foundry plan), so once A and B are
on main, fix 1 is built with its tests written first, by a session that does not write its code. Its deterministic $0.10
grant and its overlapping-call case are then the first real test of that rule, on the kind of defect it exists to catch:
a builder and its tests sharing one mistaken assumption.

Three conditions go with it:

1. **B gets more than the automatic panel.** A and B are themselves built the old way, a builder writing its own tests,
   because the pipeline that removes that is not yet there. Before B is accepted, have it reviewed independently as well,
   as the earlier review runs were.
2. **No live foundry run with real money until fix 1 lands.** The foundry's shared cap can be exceeded ($1.70 spent
   against $1 in the coordinator's stand-in run), and this order keeps that open for longer. Synthetic runs are
   unaffected.
3. **PR #84 merged before these runs.** Without it, a provider refusing the account uses up an item's plan attempts
   instead of stopping the run and waiting.

## Before starting

- The design and both requests must be in the checkout you run from, because the planner reads the design from the
  repository. Merge the pull request that carries them, then `git checkout main && git pull --ff-only`.
- Run in WSL, with the four keys passed through from Windows (`WSLENV`), as for the five-ticket run.
- Your status keys must be where the CLI finds them: `--keys DIR`, `OPHANIM_STATUS_KEYS`, or the default
  `status/ledger/keys`. Without them, a request is recorded only as a candidate and nothing runs.

## Tasks

### Task 1: Register item A

- [ ] Run:

  ```bash
  node ophanim/operate/cli.mjs prompt \
    --file docs/superpowers/plans/2026-11-21-specialized-builders/item-a-trades.md \
    --author "<your name>" --title "Specialized builders A: real trades with playbooks" --json
  ```

  Expected: the output names the new item (`prompt-` and a hex digest) and says it is authorized. Note the ID:
  it is `A` below.

### Task 2: Register item B, depending on A

- [ ] Run:

  ```bash
  node ophanim/operate/cli.mjs prompt \
    --file docs/superpowers/plans/2026-11-21-specialized-builders/item-b-tests-first.md \
    --author "<your name>" --title "Specialized builders B: tests written first" --depends-on <A> --json
  ```

  Expected: a second item ID (`B` below), authorized, with A as its dependency.

### Task 3: Run item A

- [ ] Read what the work ledger has spent, with a tick that cannot spend:

  ```bash
  node ophanim/operate/cli.mjs tick > /tmp/ophanim-before.json
  S=$(node -p 'const t=require("/tmp/ophanim-before.json"); t.spent.calls + t.spent.reserved')
  G=$(node -p 'require("/tmp/ophanim-before.json").billing.used.gemini_api_primary')
  ```

- [ ] Run A alone, on a budget you choose. A suggested first cap is 300 provider calls and 150 billed Gemini requests:

  ```bash
  node ophanim/operate/cli.mjs watch --item <A> \
    --total-provider-calls $((S+300)) --gemini-api-primary $((G+150)) 2> /tmp/ophanim-a.jsonl
  ```

  Expected: plan, then implement, review, validate and outcome. If the cap stops a stage, it waits pending with its
  work kept; a later run with more budget resumes it.

- [ ] When A has reached outcome and you have accepted it, run `node ophanim/operate/cli.mjs report --out
  ophanim-report-a.md` and send the report to the coordinator, who reads the results with you.

### Task 4: Run item B

- [ ] Only after A is accepted. B depends on A and is not dispatched before. Run it the same way as Task 3, with
  `--item <B>`. A suggested first cap is 600 provider calls and 300 billed Gemini requests: B is the larger change, and
  tests-first adds a builder session per code unit.
- [ ] Send `report --out ophanim-report-b.md` to the coordinator.

## What the coordinator does

- Reads each report with you and names what each stage reached.
- Raises anything that looks wrong with you. It does not change the items' work.
- Does not review the change as a lab. Independent review is the pipeline's three labs, and anything further is yours
  to ask for.
