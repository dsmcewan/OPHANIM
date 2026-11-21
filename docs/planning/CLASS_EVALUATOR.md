# Planning Fundamentals Class Evaluator

Charter for the specialized [`class_evaluator`](../../.codex/agents/class-evaluator.toml), the lesson planner's independent twin. It judges one completed class from preserved evidence. It does not teach, repair an answer, redesign the class or write the record.

## Evidence packet

The evaluator receives:

- the immutable versioned class package;
- the exact unassisted learner attempt;
- every teacher hint and learner revision;
- the teacher's provisional criterion-linked assessment;
- the published rubric and evidence vocabulary; and
- a current read-only [learning board](BOARD.md) snapshot.

It must not receive the planner's private reasoning or private defense. If evaluator independence, package identity or evidence completeness cannot be established, the result is `insufficient_evidence`, not a guessed score.

## Evaluation output

The evaluator returns a criterion-by-criterion matrix that cites supporting and contradicting evidence, distinguishes coached from unassisted performance, identifies consequential unknowns, and states whether the package supplied a fair observable test. It recommends one existing educational status from [LEARNING_PROGRESS.md](LEARNING_PROGRESS.md), records demonstrated limits and unresolved prerequisites, and names evidence that would falsify its conclusion.

The evaluator may reject a class package as inadequate. It does not answer the exercise, give a remediation hint, create the next class, change the rubric after the attempt, transition the board or certify final transfer. Phase 6 still needs an assessor who did not plan, teach or write the learner's answer.

The coordinator persists the evaluation, reconciles it with the teacher's mandatory next itinerary and asks [`lesson_planner`](LESSON_PLANNER.md) for the following package. The class is not complete until the full [class protocol](CLASS_PROTOCOL.md) is verified and committed.
