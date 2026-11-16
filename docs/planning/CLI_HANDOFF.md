# CLI handoff: planning fundamentals

Open the OPHANIM checkout and read [LESSONS.md](LESSONS.md), [FUNDAMENTALS.md](FUNDAMENTALS.md), [PLANNING_COACH.md](PLANNING_COACH.md) and [LEARNING_PROGRESS.md](LEARNING_PROGRESS.md).

The persistent blackboard engine already exists in [ophanim/board.mjs](../../ophanim/board.mjs), reusing Pantheon's content-addressed store and fenced leases. Its [runtime](../../ophanim/runtime.mjs) dispatches dependency-ready obligations in bounded runs. This learning handoff has not initialized learning tickets or started a background learning loop. The current learning record is `LEARNING_PROGRESS.md`; saving a coach charter or itinerary does not start a worker. Reuse the existing engine if a later, explicit learning-workflow scope calls for it; do not treat subjective coach feedback as a deterministic runtime acceptance oracle.

Paste this into the CLI assistant:

> Continue OPHANIM's planning-fundamentals learning exercise. OPHANIM is the learner. We are learning how to derive and evaluate a plan, not advancing an actual project's backlog.
>
> Read docs/planning/LESSONS.md, FUNDAMENTALS.md, PLANNING_COACH.md and LEARNING_PROGRESS.md. Use a separate read-only planning coach through the CLI's supported assistant facility if available, inheriting the current authorized configuration. A saved charter is not an installed agent; record any limitation and do not install providers.
>
> Start at the recorded phase. All phases currently say not_attempted. Preserve the learner's answer before hints; let the coach ask one diagnostic question at a time. Evaluate against the phase's observable criteria, record hints and revisions, and advance only with evidence. Final transfer requires a separate assessor and an uncoached unfamiliar example.
>
> The coach MUST create the next learning itinerary before every assessment handoff or session end, and check it on resume. Include the current evidence, next objective and reason, ordered actions, inputs/owners, pass/block/stop conditions and exact resume point. Save it through the coordinator in LEARNING_PROGRESS.md. If criteria are unmet, the itinerary stays remedial or blocked; it never authorizes automatic advancement.
>
> Keep the exercises hypothetical. No implementation tickets, paid calls, live experiments, signed-source optimization, authority changes or releases are authorized. The earlier docs/planning/phase0-2-evaluation packet is historical and superseded for this exercise. Do not resume it as an execution backlog.
>
> Follow the latest saved itinerary's exact resume point. If no learner attempt exists, begin by answering the first lesson in FUNDAMENTALS.md without supplying a coach hint first. Record the attempt and obtain feedback; preserve completed work on later resumes.

No native agent's running state transfers automatically between ChatGPT and the CLI. The charter, progress record and preserved attempts are the handoff. Preserve local changes and use a separate worktree if needed; do not reset or discard another session's work to load this branch.
