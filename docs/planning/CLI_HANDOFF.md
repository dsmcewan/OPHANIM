# CLI handoff: planning fundamentals

Open the OPHANIM checkout and read [LESSONS.md](LESSONS.md), [FUNDAMENTALS.md](FUNDAMENTALS.md), [CLASS_PROTOCOL.md](CLASS_PROTOCOL.md), [LESSON_PLANNER.md](LESSON_PLANNER.md), [PLANNING_COACH.md](PLANNING_COACH.md), [CLASS_EVALUATOR.md](CLASS_EVALUATOR.md) and [LEARNING_PROGRESS.md](LEARNING_PROGRESS.md).

The [learning board](BOARD.md) is initialized in this workspace using Pantheon's existing storage APIs: LF-001 is ready and LF-002 through LF-006 are blocked. No background learning loop was started. Its local store is ignored by Git; on another checkout use the documented initialization command, which preserves existing state. `LEARNING_PROGRESS.md` retains attempts, assessments and next itineraries. The separate [OPHANIM runtime](../../ophanim/runtime.mjs) expects synthetic known-output obligations; do not route this qualitative curriculum through it or treat coach feedback as a deterministic acceptance oracle.

Paste this into the CLI assistant:

> Continue OPHANIM's planning-fundamentals learning exercise. OPHANIM is the learner. We are learning how to derive and evaluate a plan, not advancing an actual project's backlog.
>
> Read docs/planning/LESSONS.md, FUNDAMENTALS.md, CLASS_PROTOCOL.md, LESSON_PLANNER.md, PLANNING_COACH.md, CLASS_EVALUATOR.md and LEARNING_PROGRESS.md. Use the specialized lesson_planner, planning_coach and class_evaluator agents defined in .codex/agents/ through the CLI's supported agent facility, inheriting the current authorized model configuration. Verify each named role is discovered; record any limitation and do not install providers. The roles are advisory/read-only by instruction and inherit parent permissions; use a read-only parent session when filesystem enforcement is needed.
>
> Read docs/planning/BOARD.md and inspect the local learning board. If absent, use its owner-authorized initialization procedure. Preserve existing board state and learning evidence. A ready item is not a running worker or a completed lesson; do not start the generic build runner.
>
> Start at the recorded phase. All phases currently say not_attempted. Preserve the learner's answer before hints; let the coach ask one diagnostic question at a time. Evaluate against the phase's observable criteria, record hints and revisions, and advance only with evidence. Final transfer requires a separate assessor and an uncoached unfamiliar example.
>
> The coach MUST create the next learning itinerary before every assessment handoff or session end, and check it on resume. Include the current evidence, next objective and reason, ordered actions, inputs/owners, pass/block/stop conditions and exact resume point. Save it through the coordinator in LEARNING_PROGRESS.md. If criteria are unmet, the itinerary stays remedial or blocked; it never authorizes automatic advancement.
>
> Follow the class protocol: lesson_planner prepares one immutable versioned package, planning_coach teaches it, class_evaluator independently judges the preserved evidence, and the coordinator verifies and commits the complete record before declaring the class complete. The planner and evaluator share only the published rubric and evidence vocabulary, not private reasoning or defense.
>
> The owner is away and grants standing approval for this bounded class lifecycle. Continue without waiting for owner check-ins, but do not extend that approval to production work, paid-provider changes, experiments, releases, merges or authority changes.
>
> Keep the exercises hypothetical. No implementation tickets, paid calls, live experiments, signed-source optimization, authority changes or releases are authorized. The earlier docs/planning/phase0-2-evaluation packet is historical and superseded for this exercise. Do not resume it as an execution backlog.
>
> Follow the latest saved itinerary's exact resume point. The owner most recently asked to be told when learner and coach are ready: first provide a readiness-only check and the next itinerary, without answering the exercise. When the lesson begins, if no learner attempt exists, OPHANIM answers the first lesson in FUNDAMENTALS.md without a coach hint first. Record the attempt and obtain feedback; preserve completed work on later resumes.

No native agent's running state transfers automatically between ChatGPT and the CLI. The charter, progress record and preserved attempts are the handoff. Preserve local changes and use a separate worktree if needed; do not reset or discard another session's work to load this branch.
