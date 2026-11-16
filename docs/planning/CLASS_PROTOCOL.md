# Planning fundamentals class protocol

The bounded class lifecycle is:

`lesson_planner → planning_coach → class_evaluator → coordinator → verified commit`

The owner has granted standing class-scoped approval while away. Within an active hypothetical class, the coach may teach continuously, request coordinator persistence, hand preserved evidence to the independent twin evaluator, request the following class package and complete the verification-and-commit handoff without waiting for another owner reply. This standing class-scoped approval does not authorize production work, paid-provider changes, live experiments, project implementation, releases, merges or authority changes.

## Required artifacts

Each class has one immutable versioned class package, one preserved unassisted attempt, a complete hint and revision history, one provisional teacher assessment, one independent twin evaluation, one next itinerary, and one following class package or explicit blocked/stop package. The coordinator records artifact paths and identities in [LEARNING_PROGRESS.md](LEARNING_PROGRESS.md).

The twins share the published rubric and evidence vocabulary. The evaluator does not receive the planner's private reasoning or defense. The teacher can diagnose and remediate, but cannot substitute a coached answer for unassisted evidence or certify final transfer.

## Lifecycle

1. **Prepare:** `lesson_planner` reads the latest committed evidence, current board snapshot and next itinerary, then returns exactly one versioned class package. The coordinator persists it before teaching starts.
2. **Teach:** `planning_coach` presents the package unchanged in the terminal, preserves OPHANIM's first answer before hints, asks one targeted diagnostic question at a time and produces provisional criterion-linked feedback.
3. **Preserve:** the coordinator records the prompt/version, attempt, hints, revisions and teacher assessment without overwriting earlier evidence.
4. **Evaluate:** `class_evaluator` independently judges the immutable package and preserved record. Missing identity, evidence or independence yields `insufficient_evidence`.
5. **Route:** the coach creates the mandatory next itinerary. The planner prepares the following class package, remedial package or explicit blocked/stop package from the evaluation.
6. **Reconcile:** the coordinator applies only evidence-supported board transitions through public APIs and re-reads after compare-and-swap refusal.
7. **Verify and commit:** the coordinator runs the focused role/protocol checks, the relevant repository suite and `git diff --check`, reviews the staged diff, and creates the lesson commit before declaring the class complete.

## Completion gate

A class remains open unless all of the following exist and agree:

- a versioned class package preserved before the attempt;
- the preserved unassisted attempt plus all hints and revisions;
- an independent twin evaluation with criterion-level evidence;
- the teacher's next itinerary with an exact resume point;
- the following class package or an explicit blocked/stop package;
- repository verification with no unreported failure; and
- a Git commit containing the complete class record before the class is called complete.

The commit is the final step of the class, not work deferred to the next class. A push or pull-request update may follow the commit; a merge still requires separate authority. Setup, agent discovery, board readiness and document creation do not satisfy this gate and do not count as a learner attempt.

## Current position

Lesson 1 remains unattempted. LF-001 is ready, LF-002 through LF-006 are blocked, and no learning worker, lease or occupancy is active. Role preparation does not start the lesson.

