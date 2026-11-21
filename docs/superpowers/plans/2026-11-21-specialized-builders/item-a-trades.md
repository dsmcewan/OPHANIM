# Specialized builders, item A: real trades, each with its own playbook

## Why

The owner, on 2026-11-21:

- "When a new house is being built and being inspected they never rely on just one person to build the house. They
  have a guy that does the framing and a guy that does the plumbing and a guy that does the electricity."
- "Let OPHANIM build with more specialized builders."
- "Go with your pick, trades plus tests first."

Today a work unit's `specialist_role` is free text that changes nothing about who builds or how. It is only the first
line of the builder's prompt (`pantheon/src/pipeline/implement.mjs`), and every unit gets the same builder
instructions. This item makes the trades real.

## Scope

The approved design is `docs/superpowers/specs/2026-11-21-specialized-builders-design.md`, committed at `219e0fc`.
Read it in full. This item is its sections 6.1, 6.2, 6.5 and 6.6, under the constraints of section 7, plus the rule
for work in progress below.

**Item B** (tests written first) depends on this item and is registered separately. Nothing of item B is built here:
no tests session, red check or `test_paths`.

## What to build

1. **A fixed catalogue of trades,** in one checked-in configuration file read through one module, as
   `pantheon/src/config/antigravity-sdk.json` is. Each trade has:
   - `id` and `description`;
   - `playbook`: the instructions its builder is given;
   - `paths`: globs for the kinds of path its units may own;
   - `subagents`: the subagent types its builder may use;
   - `writes_code`: whether item B's tests-first will apply.

   The first catalogue:

   | Trade | Builds | `writes_code` |
   |---|---|---|
   | `code` | modules, functions and their wiring | true |
   | `tests` | tests: in item B, the first session of a code unit; here, a unit that only adds tests for behaviour that exists | false |
   | `docs` | documentation, the register, design records | false |
   | `config` | configuration, schemas and data tables (JSON and the like) | false |
   | `build` | workflows, package manifests, lockfiles | false |

2. **Every new work unit names exactly one trade from the catalogue.** Free text is refused. The planner chooses it,
   or under the `foundry` profile the dispatcher. The dispatcher may correct it, within the catalogue
   (`pantheon/src/pipeline/dispatch.mjs` confirms or corrects the role today).
3. **Cohesion comes first.** Coupled files still stay in one unit (the rule in `PLANNER_PROMPT`,
   `pantheon/src/pipeline/work-units.mjs`). A unit is never split across trades to satisfy a path rule.
   - A `code` unit may own any path no other unit owns, including the configuration, schema or doc lines coupled to its
     code.
   - A `docs`, `config` or `build` unit may own only paths within its trade's `paths`. Otherwise it is refused at
     planning, with the reason, like any other unit refusal today.
   - A script with behaviour and tests of its own (for example `scripts/test-gates/*.mjs`) is `code`.
4. **The `code` trade's playbook does not offer the `test-constructor` subagent type.** The `tests` trade's may.
5. **The playbook reaches the builder.** The builder's prompt opens with its trade's playbook instead of the bare
   `ROLE: <specialist_role>` line. The unit's facts follow as today: owned paths, invariants, rubric, verify command,
   subagents. Keep one card (`pantheon/.agents/agents/pantheon-unit-worker/agent.md`) unless the SDK needs one per
   trade.
6. **Work in progress.** A unit of a plan approved before this item, with a free-text `specialist_role` and no trade,
   builds as today. A partial checkpoint from before resumes the same way. Any re-plan produces units with trades.

## Decided: do not reopen

**By the owner:** specialized builders, by real trades and tests written first. A different model or lab per trade is
not chosen, because Google implements (the owner's direction of 2026-11-19).

**In the approved design:**
- the five trades;
- cohesion before trade limits;
- `test-constructor` not offered to `code`;
- old plans finishing under the old rules.

## Left to you, the planner

- where the catalogue lives and its exact shape;
- each playbook's text;
- whether `trade` replaces `specialist_role` or limits it to catalogue ids, and how every record written before this
  item (run records, checkpoints, rubric hashes) keeps reading;
- whether the SDK needs a card per trade;
- how the work is cut into units.

## Constraints (design section 7)

- **Owner directions:**
  - Google implements on the Antigravity SDK (2026-11-19).
  - Subagents run on Hydrogen, within their ceilings.
  - The `fit` seating table is unchanged.
- **Independence:**
  - a contributing model never reviews;
  - three distinct labs on every panel;
  - Anthropic does not review its own work.
- **Owned paths** are enforced from disk, never from a builder's account of itself.
- **Billing:** every billed request is admitted and recorded before it is sent (register L-136).
- **Records:** existing ledgers and records stay readable, and an attempt's identity still covers everything that makes
  it different work.
- **Withheld paths:** the `findings-*` paths are not read.

## Done means

- **Each rule has a test that fails without it.** The tests use scripted seats only; nothing reaches a provider:
  - a free-text or unknown trade is refused;
  - a `docs` unit owning a code path is refused, with the reason;
  - a `code` unit owning a coupled configuration file is accepted;
  - the dispatcher's correction stays within the catalogue;
  - the trade's playbook is in the builder's prompt, and the bare `ROLE:` line is not;
  - `test-constructor` is refused to a `code` unit and allowed to a `tests` unit;
  - a unit from a plan approved before this item, with a free-text role, still builds;
  - records written before this item still read.
- A mutation runner for these rules (one `*.mutate.mjs`, as the repository's other runners), with every mutation
  killed.
- `--check` passes on every committed runner, and `scripts/test-gates/affected-runners.mjs <base> <head> --run`
  passes.
- `npm test`, `npm run test:proof`, `npm run test:gates:self` and `npm run test:lint -- --enforce` pass, on Node 24.
- A register entry in `docs/OPEN-LIMITATIONS.md` with the next free `KG-` id. KG-39 is reserved by pull request #84.
  The routing and pipeline docs are updated.
