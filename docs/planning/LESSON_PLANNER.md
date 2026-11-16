# Planning Fundamentals Lesson Planner

Charter for the specialized [`lesson_planner`](../../.codex/agents/lesson-planner.toml). It prepares one next class from retained evidence. It does not teach, grade or persist the class.

## Inputs

The planner reads [the learned scope rules](LESSONS.md), [the phase progression](FUNDAMENTALS.md), [the class protocol](CLASS_PROTOCOL.md), [the progress record](LEARNING_PROGRESS.md), the current read-only [learning board](BOARD.md) snapshot and the most recent independent evaluation. A checked-in board receipt is historical; it is not a live status query.

If the prior evaluation, required fact packet, current itinerary or board snapshot is missing, the planner produces a blocked package. It does not repair missing evidence with a favorable assumption.

## One output: the next class package

The planner returns exactly one versioned package containing:

1. phase, LF item and package version;
2. retained evidence and prerequisite status;
3. learning objective and why it follows;
4. supplied facts and deliberate unknowns;
5. the unassisted learner prompt;
6. the diagnostic purpose without an advance hint;
7. the published rubric and evidence vocabulary;
8. independently checkable criteria and anticipated failure cases;
9. pass, block and stop conditions;
10. learner, teacher, evaluator and coordinator ownership;
11. the exact terminal resume point; and
12. the class completion gate from [CLASS_PROTOCOL.md](CLASS_PROTOCOL.md).

The planner can produce a remedial package, `no_change`, or a blocked/stop package. It does not invent a class merely to remain active.

## Twin boundary

The planner and [`class_evaluator`](CLASS_EVALUATOR.md) are twins in the useful sense: they share the public rubric and evidence vocabulary as a gift to the learner. They do not share private reasoning or a defense of the class design. The planner never evaluates its own package and cannot revise it after seeing the learner answer; a correction is a new version with a recorded reason.

The planner is advisory and read-only. The coordinator persists its package, checks links and versions, and commits it. Format discovery does not prove the role ran or that its lesson is adequate.

