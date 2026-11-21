# Specialized builders: real trades, and tests written first

Status: a proposal for the owner's approval. Nothing here is built. Written 2026-11-21 against `main` at `10893d4`.
Every statement about the present code was read from the file it names; none was traced through a run.

## 1. Intent

The owner, on 2026-11-21:

- "When a new house is being built and being inspected they never rely on just one person to build the house. They
  have a guy that does the framing and a guy that does the plumbing and a guy that does the electricity."
- "Let OPHANIM build with more specialized builders."
- Of the three ways offered (section 5): "Go with your pick, trades plus tests first."

The reason, in the owner's terms: no single builder does the whole job and then vouches for it. Each part of the work
is done by someone whose trade it is, and checked by someone who did not do it.

Two things follow. **The trades become real.** A trade name carries its own instructions and limits, not only a label.
**The standard is set before the work.** A unit's tests are written by a tests specialist from the unit's acceptance
criteria before any code exists, and the code builder works to them without being able to change them.

And OPHANIM builds this change itself, through its own pipeline, rather than the coordinator writing it (section 9).

## 2. What exists today (the `fit` profile)

- **Units.** The planner splits a ticket into work units (`pantheon/src/pipeline/work-units.mjs`, `PLANNER_PROMPT`).
  Each has `owned_paths` (the only paths its builder may change, enforced from disk), `depends_on`, `difficulty`,
  `specialist_role`, `allowed_subagents`, `verify_cmd` (one deterministic command whose exit code is ground truth) and
  `invariants`. The planner is told: "Coupled files belong to ONE unit: the types, the implementation that uses them
  and the tests that prove them stay together. Never split ... an implementation from its tests."
- **The trade is a name only.** `specialist_role` is free text in a fixed shape (lower-case words joined by `-`), for
  example `node-esm-library-engineer`. The dispatcher (`pipeline/dispatch.mjs`) confirms or corrects it and writes the
  unit's frozen rubric. The name changes nothing about who builds or how. It is the first line of the builder's prompt
  (`pipeline/implement.mjs`: `ROLE: <specialist_role> — the single implementer of work unit ...`) and is shown to the
  acceptance reviewer (`pipeline/review.mjs`).
- **One builder per unit, chosen by difficulty alone.** Every unit's builder is the Antigravity SDK Gemini seat for its
  difficulty: easy Hydrogen, medium Neon, hard Carbon (`pantheon/src/route/fit-matrix.mjs`, owner direction
  2026-11-19). Every builder gets the same card (`pantheon/.agents/agents/pantheon-unit-worker/agent.md`) and the
  same instructions apart from that first line.
- **The builder writes its own tests.** The prompt says the builder owns "its types, its implementation and its tests,
  together, in one change". Its helpers are the SDK's own subagents on Hydrogen
  (`pantheon/src/config/antigravity-sdk.json`), within a ceiling (Carbon 8, Neon 4, Hydrogen none). Among their pinned
  types is `test-constructor`, which writes tests under the builder's direction.
- **The inspection.** After the builder, the controller runs `verify_cmd`, and an acceptance reviewer pinned to the
  dispatcher's model judges the change against the frozen rubric. A model that contributed is never on a review
  panel, and every panel has three distinct labs.

The `foundry` profile design (`docs/superpowers/specs/2026-11-20-foundry-profile-design.md`) is a proposal, not built.
Under it the dispatcher, not the planner, cuts the units, and one implementer model serves the whole ticket. This
design works under either: whoever cuts the units chooses their trades, and the implement stage does the rest.

## 3. Goals

1. **A fixed catalogue of trades.** Each has a playbook: what it builds, which kinds of path it may own, which subagent
   types it may use, and what "done" means for it. A unit names one trade from the catalogue; free text is refused.
2. **The trade's playbook reaches its builder.** It replaces the bare `ROLE:` line, and its limits are enforced.
3. **Tests first, for every unit whose trade writes code.**
   - A tests session writes the unit's tests first, from its frozen rubric and invariants.
   - The controller checks that they fail on the unit's starting tree.
   - A separate code session then builds until they pass. It cannot change them.
4. **The inspection checks the standard too.** The acceptance reviewer judges whether the tests cover the rubric, as
   well as the change against it, and sees the record of the tests failing first and passing after.
5. **The records say who did what.** The tests session and the code session are separate contributors on every record
   that names contributors.

## 4. Non-goals and anti-goals

**Non-goals:**
- A different model or lab per trade. That would be option 2 of section 5, and it is not chosen: by the owner's
  direction of 2026-11-19, Google implements.
- Any change to the planner, dispatcher, reviewer or validator seating, the independence rules or the billing policy.
- A new subagent model.

**Anti-goals** (failures even if the code works):
- **Tests written to pass.** A test that already passes before the code exists does not test the change. The check
  that it fails first is the point of tests-first.
- **A builder editing the standard.** The code session may not change the tests to make them pass, directly or through
  a subagent.
- **Trades drifting back into free text,** or one trade quietly doing another's work through its owned paths.
- **Ceremony without gain.** Units whose trade writes no code (docs, configuration) do not get a tests session.

## 5. Approaches

1. **Real trades, each with its own playbook.** Chosen. A fixed catalogue; each unit's builder gets its trade's
   instructions and limits. It keeps the Gemini builders the owner chose. This is the smallest change that makes the
   trade names mean something.
2. **A different builder model per trade.** Not chosen. It would change routing and Gemini billing, and it conflicts
   with the owner's direction that Google implements.
3. **The tests trade comes first.** Chosen, for units whose trade writes code. It separates who sets the standard from
   who meets it, which a playbook alone does not.

The tests stay in the **same unit** as the code they prove. Splitting them into units of their own would break the
cohesion rule above, and a unit that only holds tests could not pass its own `verify_cmd` before the code exists. So
tests-first is two sessions inside one unit, not two units.

## 6. The design

### 6.1 The trade catalogue

The catalogue is one checked-in configuration file read through one module, like `config/antigravity-sdk.json`. Where
it lives and its exact shape are left to the builder. Each trade has:

- `id`;
- `description`;
- `playbook`: the instructions its builder is given;
- `paths`: the kinds of path a unit of this trade may own, as globs;
- `subagents`: the subagent types its builder may use;
- `writes_code`: whether tests-first applies.

The first catalogue (the coordinator's call; the owner may change it):

| Trade | Builds | Tests first |
|---|---|---|
| `code` | modules, functions and their wiring | yes |
| `tests` | tests: the first session of a code unit, or a unit that only adds tests for behaviour that exists | no (it is the tests) |
| `docs` | documentation, the register, design records | no |
| `config` | configuration, schemas and data tables (JSON and the like) | no |
| `build` | workflows, scripts, package manifests | no |

**Rules:**
- A unit names exactly one trade. The planner (or under `foundry`, the dispatcher) chooses it; the dispatcher may
  correct it, within the catalogue.
- **A unit's trade is the kind of work at its centre, and cohesion comes first.** Coupled files still stay in one unit;
  a unit is never split across trades to satisfy a path rule.
  - A `code` unit may own any path no other unit owns, including the configuration, schema or doc lines coupled to its
    code. Its tests are its `test_paths` (section 6.3).
  - A `docs`, `config` or `build` unit may own only paths within its trade's `paths`. A unit whose paths fall outside
    is refused at planning with the reason, like any other unit refusal today.
- **What counts as what.** A script with behaviour and tests of its own (for example `scripts/test-gates/*.mjs`) is
  `code`. `build` is workflows, package manifests and lockfiles.
- **The `code` trade's playbook does not offer `test-constructor`.** The `tests` trade's playbook may.

What happens to the existing `specialist_role` field (replaced by `trade`, or kept and limited to catalogue ids), and
how earlier run records, checkpoints and rubric hashes stay readable, are left to the builder. Every record written
before this change must still read.

### 6.2 The playbook reaches the builder

The builder's prompt opens with its trade's playbook instead of the bare `ROLE:` line. The unit's facts follow as
today: owned paths, invariants, rubric, verify command and subagents. The card stays one card unless the SDK needs a
card per trade; that is left to the builder.

### 6.3 Tests first, inside one unit

For a unit whose trade has `writes_code`:

- **Planning.** The unit also declares `test_paths`: a part of its `owned_paths`, all within the `tests` trade's
  `paths`. A code unit without them is refused. Its `verify_cmd` must run them.
- **New tests and guards.** The tests session labels each test it leaves either `new` (it checks behaviour this unit
  adds) or `guard` (it checks behaviour that already exists and must keep working: a regression or back-compat test).
  A unit has at least one `new` test, unless the dispatcher marked it **behaviour-preserving** (a refactor, a move, a
  rewiring), with its reason on the record. Then every test is a guard, and the reviewer checks the claim against the
  diff: new behaviour in a behaviour-preserving unit is a defect.
- **Tests session.** It builds first, on the unit's starting tree:
  - It owns only `test_paths`.
  - It writes the tests from the frozen rubric and the invariants, under the `tests` playbook.
  - It never sees the code session's work, on a revision included (below).
  - It ends with a **coverage map**: structured data, not prose. It maps each rubric criterion (by id) to the test
    names that check it, with each test's label (`new` or `guard`). The controller checks every name against the files
    on disk and the red check's output; a name that matches no test is refused, and so is a criterion with no test.
- **The red check.** The controller runs `verify_cmd` on the starting tree plus the tests:
  - Every `new` test must fail, and every `guard` must pass. For a behaviour-preserving unit, every guard must pass.
  - A failure counts only when it is one of these:
    - a `new` test failing on an assertion;
    - a test file failing to load because a module or export it imports from the unit's **code** paths
      (`owned_paths` minus `test_paths`) does not exist yet. This is the normal case under the repository's static
      ESM imports.

    Any other failure is refused, with the reason, and the tests session is asked again within the unit's budget.
    That covers a syntax error in a test, an import of something outside the unit, and a timeout or throw before any
    assertion.
  - Tests that were already in a file the session added to may go red with it for the same load reason. They must be
    green again after the code session.
  - If nothing fails, the tests do not test the change, and the tests session is asked again with that reason.
  - The gate's existing log readers (`scripts/test-gates/parse-log.mjs`) are a starting point for reading the output.
  - The record keeps the result: exit code, which tests failed and why, and the digest of the output.
- **Code session.** It builds next, in the same worktree:
  - It owns `owned_paths` minus `test_paths`.
  - A change to a test path, by the session or its subagents, is detected from disk, and the attempt is discarded, as
    any change outside owned paths is today.
  - `verify_cmd` must then pass (green), as today.
- **The tests are judged too.** If the code session believes a test is wrong, it does not change it. It may file an
  **objection**, as structured data: the test's name, checked by the controller to exist, and the id of the rubric
  criterion it believes the test misreads. No free text is passed on. The acceptance reviewer is given:
  - the rubric;
  - the diff of both sessions, read from disk;
  - the checked coverage map;
  - any checked objections;
  - the red and green records.

  It reads any test it needs from disk itself. So everything the reviewer is given is read from disk or checked by the
  controller, as today: `implement.mjs` keeps a builder's closing note from the reviewer, and `review.mjs` tells the
  reviewer everything it sees was read from disk. Owner decision L-001 is untouched.
- **Revision routing.** The reviewer may find a defect in the tests, in the code or in both.
  - **A defect in the tests:** the code session's work is set aside in its checkpoint. The tests session revises on the
    starting tree plus the tests, still without seeing the code. The red check runs again on that tree. Then the code
    session resumes from its kept work, with the revised tests read-only.
  - **A defect in the code:** the unit goes back to the code session only.

  Revision stays within the unit's attempt bound.
- **Seats.** Both sessions sit on the unit's implementer seat and ladder as today (Gemini, by difficulty). They are
  separate sessions: a fresh conversation, their own playbook and their own owned paths. The tests session sits on
  the same model as the code session, by the owner's choice (section 10).
- **Contributors.** Both sessions are recorded as contributors, each with the purpose it served (`tests`, `code`), so
  the existing exclusion keeps both off every review panel.
- **Budget.** Tests-first adds one builder session per code unit; the red check itself calls no provider. Every call
  is charged as today, against the stage's budget and the Gemini billing policy. The extra cost should be stated in
  the change's report.

Checkpoints and resumption follow the session: a stopped tests session resumes as a tests session, a stopped code
session as a code session. The red record survives a restart. The mechanism is left to the builder.

### 6.4 Work already in progress

A plan approved before this change has units with a free-text `specialist_role`, no trade and no `test_paths`. Such a
unit finishes under the old rules: one session, as today. A partial checkpoint from before resumes the same way. Any
re-plan produces units under the new rules. The old path is kept only for these units, and no new plan may use it.

### 6.5 Units whose trade writes no code

`docs`, `config` and `build` units, and a `tests`-only unit, are built in one session, as today. They get their trade's
playbook and limits, and are checked by their own `verify_cmd` and the acceptance reviewer.

### 6.6 What is checked

The repository's own standards apply:
- every new behaviour has a test that fails without it;
- a mutation runner for the new rules: path limits, a refused trade, the red check, test paths read-only to the code
  session, revision routing;
- a register entry with the next free `KG-` id;
- the routing and pipeline docs updated.

The tests use scripted seats only; nothing reaches a provider. Existing runners must still apply (`--check` on all),
and T2 (`scripts/test-gates/affected-runners.mjs`) must pass on the change.

## 7. Constraints

- **Owner directions:**
  - Google implements on the Antigravity SDK (2026-11-19).
  - Subagents run on Hydrogen, within their ceilings.
  - The `fit` seating table is unchanged.
- **Independence:**
  - a contributing model never reviews;
  - three distinct labs on every panel;
  - Anthropic does not review its own work.
- **Enforcement of owned paths:** what a builder writes is read from disk, never from its account of itself.
- **Billing:** every billed request is admitted and recorded before it is sent (register L-136).
- **Records:** existing ledgers and records stay readable, and an attempt's identity still covers everything that
  makes it different work.
- **Withheld paths:** the `findings-*` paths are not read, by the builder or by its tests.

## 8. Left to the builder

The builder is OPHANIM's own planner and pipeline (section 9). Left to it:

- where the catalogue lives, its shape, and each playbook's exact text;
- `trade` versus `specialist_role`, and how old records keep reading;
- how the red check reads its rule (section 6.3) from the verify output;
- the mechanics of setting the code aside and resuming it, and the checkpoint format for two sessions;
- whether the SDK needs a card per trade;
- how the work is cut into units.

## 9. Delivery: OPHANIM builds it

This is OPHANIM's work, not a coordinator change. It is **two items, in order**:

- **Item A, the trades:** the catalogue, the playbooks reaching the builder, the path rules, and the planner and
  dispatcher choosing from the catalogue (sections 6.1, 6.2, 6.5 and 6.6).
- **Item B, tests first:** depends on item A. It covers the two sessions, the labels, the red check, read-only tests,
  the coverage map and objections, the reviewer's inputs, revision routing, records, checkpoints and work in progress
  (sections 6.3, 6.4 and 6.6).

For each item:

1. The coordinator writes the request: the sections it covers, with section 7, as the item's requirement, so OPHANIM's
   planner does not have to guess what this design settles.
2. The owner registers and authorizes it with the status keys:
   `node ophanim/operate/cli.mjs prompt --file <the request> --author <owner>`.
3. The owner runs it on their machine, where the keys and sign-ins are, with a budget the owner declares for that
   item. The planner's plan is
   reviewed by three labs, and the change goes through implement, review, validate and outcome as any item.
4. The coordinator reads the results with the owner. It does not build, review or merge the change.

The pipeline this changes is the one that will build it. The item is built by the pipeline as it is at the item's
base, so the new rules apply only to items after it.

## 10. Who decided what

**The owner decided:**
- the goal, specialized builders, in the words of section 1;
- approaches 1 and 3, and not 2;
- that OPHANIM builds it.

**The coordinator's calls,** which the owner may change. Several settle questions a reader raised while checking
this design as its builder would:
- the five trades of the first catalogue;
- cohesion before trade limits, with a `code` unit carrying coupled config and docs;
- tests-first only where a trade writes code;
- `test_paths` declared at planning;
- `new` and `guard` labels, and behaviour-preserving units, marked by the dispatcher and checked by the reviewer;
- the red check's rule, with a load failure on missing unit code counting as red;
- the tests session never seeing the code;
- the coverage map and objections as checked data only;
- old plans finishing under the old rules;
- delivery as two items;
- `test-constructor` not offered to the `code` trade;
- both sessions on the unit's existing seat.

The owner also chose, on 2026-11-21, that the tests session sits on the **same Gemini model** as the code session.
They are separate sessions that share no conversation, the tests session never sees the code, and the code session
cannot edit the tests.
