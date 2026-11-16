# Planning learning progress

Goal: learn what a plan requires and how to evaluate it through hypothetical exercises. This is not the project qualification roadmap. No learning phase has yet been attempted or passed.

The [learning board](BOARD.md) now tracks phase readiness in a local persistent store. LF-001 is ready; LF-002 through LF-006 are blocked. This file remains the record of attempts, hints, assessments and next itineraries. Initialization is not a learner attempt and started no background worker.

| Phase | Status | Next prerequisite |
| --- | --- | --- |
| 1. Frame the problem | not_attempted | OPHANIM answers the first lesson in FUNDAMENTALS.md before the coach gives a hint. |
| 2. Ground the reasoning | not_attempted | Criterion-linked Phase 1 feedback and an exercise fact packet. |
| 3. Derive necessary work | not_attempted | Evidence/assumption distinctions demonstrated in Phase 2. |
| 4. Test adequacy and failure | not_attempted | Necessary contributions and dependencies demonstrated in Phase 3. |
| 5. Judge further investigation | not_attempted | Sufficiency, feasibility and independent verification demonstrated in Phase 4. |
| 6. Demonstrate transfer | not_attempted | Earlier criteria demonstrated; separate assessor supplies a fresh case. |

Append one short record for each attempt: date/session, phase, exercise/version, learner answer or exact evidence reference, facts/assumptions, hints, observed misconception, revision, assessment basis, status and next prerequisite. Retain the original attempt and all hints. Statuses are `not_attempted`, `attempted`, `needs_revision`, `ready_for_independent_check`, and `demonstrated_with_limits`; use `insufficient_evidence` when an assessment is unsupported. These are educational labels, not runtime Board statuses.

Append the coach's next itinerary after each assessment or handoff. Preserve prior itineraries with their evidence and revision reason. An itinerary schedules learning attention; it is neither a pass nor execution authority.

## Initial itinerary

- **Current position:** Phase 1, first lesson in FUNDAMENTALS.md; not attempted. No learner performance evidence or hint exists yet.
- **Objective and reason:** distinguish the desired outcome, observable success and consequential unknowns before selecting methods. This is the prerequisite for every later planning judgment.
- **Ordered actions:** OPHANIM reads the first lesson and records an unassisted answer. The coach then compares it to Phase 1 criteria, asks one diagnostic question if needed, preserves any revision and records the assessment. The coach creates the following itinerary before handoff.
- **Inputs and ownership:** the fictional first-lesson facts; OPHANIM supplies the answer, the coach supplies feedback, and the coordinator preserves records. Do not book a meeting or choose a provider.
- **Advancement and stopping:** advance only with supported Phase 1 criteria. Missing understanding produces a narrow remedial step; an unsupported assessment remains insufficient evidence. No unattended retry loop.
- **Exact resume point:** answer the first lesson without a hint and append that attempt below this itinerary. No phase has passed.

## Carry-forward record

- 2026-11-16: owner clarified twice that the task is learning what a plan requires. The previous project-specific packet is historical and superseded as the exercise's direction.
- 2026-11-16: planning lessons saved and a six-phase curriculum prepared with a native read-only planning coach. This is curriculum preparation, not a learner attempt or external agent installation.
- 2026-11-16: owner is moving to the CLI and requested the materials in the repository. Resume with Phase 1. No provider call, live experiment, optimization or project release follows from the handoff.
- 2026-11-16: coach directive now requires a saved next itinerary at every assessment handoff or session end. The existing blackboard engine has not been initialized for this learning workflow, and this handoff has started no background learning worker. This Markdown record is the current learning state; no runtime ticket acceptance is claimed.
- 2026-11-16, subsequent owner request “initialize”: created one curriculum ticket, one plan and six phase items through the existing board APIs. Reopened the persisted state and repeated initialization without changing its head. No phase passed, final acknowledgment remains pending, and no runner or model provider was invoked. See BOARD.md and board-initialization.json for the seed, status and verification limits.
- 2026-11-16, owner requested a specialized Coach and a readiness notification: created `.codex/agents/planning-coach.toml`. The native `planning_coach` read the card and learning documents, correctly restated the mission and returned the next itinerary below. This establishes current-session briefing readiness, not learning success or a separate CLI launch. CLI format checks passed; discovery is unverified because its metadata process could not open the local session database. See coach-readiness.json.
- 2026-11-16, owner authorized unattended class-scoped teaching and requested an independent evaluator “as a gift, like a twin.” Added separate `lesson_planner` and `class_evaluator` roles plus the class protocol. They share the public rubric and evidence vocabulary but not private reasoning or defense. The coordinator remains the writer and committer. This preparation did not start Lesson 1 or advance LF-001.

## Coach readiness itinerary — LF-001

This appends to, rather than replaces, the initial itinerary. The new evidence is the initialized board and specialized coach briefing. There is still no learner attempt or hint.

1. **Position:** Phase 1 / LF-001, first lesson in FUNDAMENTALS.md. All learning statuses remain `not_attempted`.
2. **Objective:** distinguish observable success and consequential unknowns before selecting methods.
3. **Actions:** present the saved lesson unchanged; OPHANIM supplies its unassisted answer; coordinator preserves the exact prompt/version and answer; coach checks Phase 1 criteria and asks one diagnostic question if needed; preserve the revision and assessment; coach creates the following itinerary.
4. **Ownership:** OPHANIM reasons, the coach diagnoses, and the coordinator persists evidence and justified Board transitions. The owner observes and steers. A separate final assessor is needed at Phase 6, not before Lesson 1.
5. **Pass/block/stop:** remain at LF-001 until every applicable criterion has support; use narrow remediation or `insufficient_evidence` if it does not. No automatic retry or acceptance.
6. **Resume:** the owner requested notification of readiness. That check is complete for this native session. When the lesson starts, obtain OPHANIM's first answer before hints and append the attempt here. For a separate CLI session, first verify discovery of the named coach and inspect or initialize that checkout's local board.

## Class-role preparation itinerary — LF-001

1. **Position:** Phase 1 / LF-001 remains `not_attempted` and ready. The planner, teacher and independent twin evaluator contracts are prepared; no class evidence exists.
2. **Objective:** begin the unchanged first lesson and distinguish observable success from method selection while preserving a clean unassisted baseline.
3. **Actions:** coordinator persists the versioned Lesson 1 package; coach presents it unchanged; OPHANIM answers before hints; coach diagnoses; evaluator judges preserved evidence; coach writes the next itinerary; planner prepares the following or blocked/remedial package; coordinator verifies and commits before completion.
4. **Ownership:** planner prepares, coach teaches, OPHANIM reasons, evaluator judges independently, and coordinator persists, transitions and commits. Owner standing approval covers this class protocol while the owner is away.
5. **Pass/block/stop:** remain at LF-001 unless every applicable criterion has evidence and evaluator independence is intact. Missing evidence, role discovery or next-class preparation blocks completion. Production authority remains unchanged.
6. **Resume:** verify the three named agents are discoverable in the terminal session, persist Lesson 1 package version 1, then obtain OPHANIM's unassisted answer. Do not provide a hint first.
