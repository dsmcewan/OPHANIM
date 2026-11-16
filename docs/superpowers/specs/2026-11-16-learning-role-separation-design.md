# Learning Role Separation Design

## Intent

Finish the planning-fundamentals class workflow with specialized support for preparing the next class and evaluating completed class evidence. Preserve the owner's rule that every class ends with verified, committed evidence and a prepared resume point.

## Goals

- Add a `lesson_planner` custom agent that prepares one next class from the latest evidence and itinerary.
- Add a separate `class_evaluator` custom agent that evaluates a completed class against published criteria.
- Keep `planning_coach` as the terminal teacher and OPHANIM as the learner.
- Keep all three specialists advisory and read-only; the coordinator persists evidence, transitions the board, and commits.
- Carry the owner's standing class-scoped approval so the terminal class can continue through evaluation, next-package preparation, verification and commit without owner check-ins.
- Require the next class package and next itinerary before a class can be declared complete.
- Preserve unassisted attempts, hints, revisions, assessment basis, uncertainty, and evaluator independence.

## Non-goals

- Do not start Lesson 1, a background runner, a provider call, or an experiment.
- Do not create a subjective automatic acceptance oracle.
- Do not let a planner grade its own class or a teacher certify final transfer.
- Do not alter TELOS, production authority, model routing, or release policy.

## Constraints

- Project-local agents live under `.codex/agents/*.toml` and inherit the parent model and permissions.
- Role instructions are behavioral constraints, not filesystem enforcement.
- One class and one learning-board item are active at a time.
- The coordinator must commit the class record before the class is complete.
- Standing approval is limited to the hypothetical class lifecycle and does not authorize production work, provider changes, experiments, releases or merges.
- Phase 6 still requires a separate assessor who did not teach, plan, or write the learner's answer.

## Approaches

1. One combined planner/evaluator agent: smallest surface, but it grades its own instructional design and weakens the evidence boundary.
2. A planner plus an independent evaluator: slightly more configuration, but it preserves separation of duties and makes unsupported advancement easier to detect. **Selected.** The evaluator is a twin in the useful sense: it shares the planner's rubric and evidence language as a gift to the learner, while remaining a separate role that cannot defend, rewrite, or grade its own design.
3. Add only a planner and let the teaching coach evaluate: fewer roles, but the coach would both guide and judge the same class.

## Design

`lesson_planner` reads the curriculum, latest progress, current board snapshot, and prior evaluation. It produces exactly one versioned class package containing the objective, supplied facts, deliberate unknowns, unassisted prompt, diagnostic purpose, published evaluation criteria, stop conditions, and exact resume point. It cannot teach, supply the answer, evaluate the resulting attempt, edit files, or transition the board.

`planning_coach` presents the approved class package in the terminal, preserves the unassisted attempt, asks one targeted diagnostic question at a time, and returns provisional criterion-linked feedback plus the mandatory next itinerary. It cannot certify final transfer.

`class_evaluator` is the planner's independent twin. It reads the same published rubric and evidence vocabulary, then judges the immutable class package and preserved attempt record without inheriting the planner's private reasoning or defense. It reports criterion-by-criterion evidence, coached versus unassisted performance, contradictions, missing evidence, and one of the existing educational statuses. It cannot repair the learner's answer, create the next lesson, edit files, transition the board, or evaluate a class it planned or taught.

The coordinator validates the records, applies justified board transitions through public APIs, prepares the next planner handoff, runs repository checks, and commits before declaring the class complete. The owner's standing class-scoped approval lets this sequence finish without an owner check-in while leaving all non-class authority unchanged. If any evidence, evaluator independence, next itinerary, next class package, verification, or commit is missing, the class remains open.
