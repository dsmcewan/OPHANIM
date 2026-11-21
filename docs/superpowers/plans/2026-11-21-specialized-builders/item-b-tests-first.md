# Specialized builders, item B: a unit's tests are written first, by someone who does not write its code

## Why

The owner, on 2026-11-21:

- "When a new house is being built and being inspected they never rely on just one person to build the house."
- "Let OPHANIM build with more specialized builders."
- "Go with your pick, trades plus tests first."

Today a unit's builder writes "its types, its implementation and its tests, together, in one change"
(`pantheon/src/pipeline/implement.mjs`), so the builder sets its own standard. This item separates who sets the
standard from who meets it.

## Scope

The approved design is `docs/superpowers/specs/2026-11-21-specialized-builders-design.md`, committed at `219e0fc`.
Read it in full. This item is its sections 6.3, 6.4 and 6.6, under the constraints of section 7.

It **depends on item A** (the trade catalogue, registered as this item's dependency) and builds on it. The tests stay
in the **same unit** as the code they prove. This is two sessions inside one unit, not two units.

## What to build: for every unit whose trade has `writes_code`

1. **Planning.** The unit declares `test_paths`: a part of its `owned_paths`, all within the `tests` trade's `paths`.
   A code unit without them is refused. Its `verify_cmd` must run them.
2. **New tests and guards.** The tests session labels each test it leaves:
   - `new`: it checks behaviour this unit adds;
   - `guard`: it checks behaviour that already exists and must keep working (a regression or back-compat test).

   A unit has at least one `new` test, unless the dispatcher marked it **behaviour-preserving** (a refactor, a move, a
   rewiring), with its reason on the record. Then every test is a guard, and the reviewer checks the claim against the
   diff: new behaviour in a behaviour-preserving unit is a defect.
3. **The tests session builds first, on the unit's starting tree.**
   - It owns only `test_paths`.
   - It writes the tests from the frozen rubric and the invariants, under the `tests` playbook.
   - It never sees the code session's work, on a revision included.
   - It ends with a **coverage map**: structured data, not prose. It maps each rubric criterion (by id) to the test
     names that check it, with each test's label. The controller checks every name against the files on disk and the
     red check's output. A name that matches no test is refused, and so is a criterion with no test.
4. **The red check.** The controller runs `verify_cmd` on the starting tree plus the tests.
   - Every `new` test must fail, and every `guard` must pass. For a behaviour-preserving unit, every guard must pass.
   - A failure counts only when it is one of these:
     - a `new` test failing on an assertion;
     - a test file failing to load because a module or export it imports from the unit's **code** paths
       (`owned_paths` minus `test_paths`) does not exist yet. This is the normal case under the repository's static
       ESM imports.
   - Any other failure is refused with the reason, and the tests session is asked again within the unit's budget.
     That covers a syntax error in a test, an import of something outside the unit, and a timeout or throw before any
     assertion.
   - If nothing fails, the tests do not test the change, and the tests session is asked again with that reason.
   - Tests already in a file the session added to may go red with it for the same load reason. They must be green
     again after the code session.
   - The record keeps the result: exit code, which tests failed and why, and the digest of the output. The gate's log
     readers (`scripts/test-gates/parse-log.mjs`) are a starting point for reading it.
5. **The code session builds next, in the same worktree.**
   - It owns `owned_paths` minus `test_paths`.
   - A change to a test path, by the session or a subagent, is detected from disk, and the attempt is discarded, as
     any change outside owned paths is today.
   - `verify_cmd` must then pass.
6. **Objections.** If the code session believes a test is wrong, it does not change it. It may file an objection, as
   structured data: the test's name, checked by the controller to exist, and the id of the rubric criterion it believes
   the test misreads. No free text is passed on.
7. **The reviewer's inputs.** The acceptance reviewer (`pantheon/src/pipeline/review.mjs`) is given:
   - the rubric;
   - the diff of both sessions, read from disk;
   - the checked coverage map;
   - the checked objections;
   - the red and green records.

   It reads any test it needs from disk itself. Everything it is given is read from disk or checked by the
   controller, as today; no builder prose reaches it, and owner decision L-001 is untouched.
8. **Revision routing.** The reviewer may find a defect in the tests, the code or both.
   - **In the tests:** the code session's work is set aside in its checkpoint. The tests session revises on the starting
     tree plus the tests, without seeing the code. The red check runs again. Then the code session resumes from its kept
     work, with the revised tests read-only.
   - **In the code:** the unit goes back to the code session only.

   Revision stays within the unit's attempt bound.
9. **Seats.** Both sessions sit on the unit's existing implementer seat and ladder (Gemini, by difficulty), on the
   **same model**, by the owner's choice of 2026-11-21. They are separate sessions: a fresh conversation, their own
   playbook and their own owned paths.
10. **Contributors.** Both sessions are recorded as contributors, with the purposes `tests` and `code`, so the existing
    exclusion keeps both off every review panel.
11. **Budget.** Tests-first adds one builder session per code unit; the red check calls no provider. Every call is
    charged as today, against the stage budget and the Gemini billing policy. The change's report states the extra
    cost.
12. **Restarts.** Checkpoints follow the session: a stopped tests session resumes as a tests session, a stopped code
    session as a code session. The red record survives a restart.
13. **Work in progress.** A code unit of a plan approved before this item, with no `test_paths`, builds in one session
    as today. A partial checkpoint from before resumes the same way.

Units whose trade writes no code (`docs`, `config`, `build`, and a `tests`-only unit) are built in one session, as
item A leaves them.

## Decided: do not reopen

**By the owner:**
- tests written first, by a separate session;
- the same Gemini model for both sessions.

**In the approved design:**
- the tests stay in one unit with their code;
- `test_paths` are declared at planning;
- the `new` and `guard` labels, and behaviour-preserving units marked by the dispatcher;
- the red check's rule;
- the tests session never seeing the code;
- the coverage map and objections as checked data only.

## Left to you, the planner

- how the red check reads its rule from the verify output;
- the mechanics of setting the code aside and resuming it;
- the checkpoint format for two sessions;
- the exact shape of the coverage map and the objections;
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
  - a code unit without `test_paths` is refused;
  - a `new` test that already passes on the starting tree is refused;
  - a load failure on a missing module or export of the unit's code paths counts as red;
  - a syntax error in a test file, or an import from outside the unit, is refused;
  - a `guard` failing on the starting tree is refused;
  - a behaviour-preserving unit with all guards passes the red check, and new behaviour in its diff is found;
  - the code session changing a test path has its attempt discarded;
  - a coverage-map name matching no test is refused, and so is a criterion with no test;
  - an objection naming no existing test is refused;
  - no builder prose is in the reviewer's inputs;
  - a tests defect sets the code aside, and the tests session's prompt and tree hold none of the code;
  - a code defect returns to the code session only;
  - a restart resumes the right session with its red record;
  - a code unit of a plan approved before this item builds in one session;
  - both sessions are on the records as contributors and are excluded from review.
- A mutation runner for these rules, with every mutation killed.
- `--check` passes on every committed runner, and `scripts/test-gates/affected-runners.mjs <base> <head> --run`
  passes.
- `npm test`, `npm run test:proof`, `npm run test:gates:self` and `npm run test:lint -- --enforce` pass, on Node 24.
- A register entry in `docs/OPEN-LIMITATIONS.md` with the next free `KG-` id. The routing and pipeline docs are
  updated.
