# Planning fundamentals: learning progression

OPHANIM is the learner. The goal is to understand how a plan's requirements are derived and how its adequacy is judged. All exercises are hypothetical. The user is not being assigned homework, and the exercises do not create a project backlog.

Start with [the lessons already learned](LESSONS.md). Use the [planning coach charter](PLANNING_COACH.md), preserve attempts in [learning progress](LEARNING_PROGRESS.md), and use [the CLI handoff](CLI_HANDOFF.md) when continuing elsewhere.

## Phases and advancement

These are learning phases, distinct from the earlier project qualification roadmap. Every phase currently starts as **not attempted**.

| Phase | Steps and exercise | Evidence needed to advance |
| --- | --- | --- |
| 1. Frame the problem | Read a small fictional request. State the outcome, observable success and permitted activity. Identify consequential ambiguity before choosing tasks. | OPHANIM distinguishes the objective from a proposed method, respects the learning boundary, and identifies missing information that changes success. |
| 2. Ground the reasoning | Read fictional room cards containing capacity, availability and missing facts. Separate observations, assumptions and unknowns; identify reusable information. | Every material claim has a supplied basis or an explicit uncertainty label. Unknown capacity or availability is not silently favorable, zero or false. |
| 3. Derive necessary work | Examine a deliberately flawed draft containing unnecessary decoration, omitted confirmation and notification before a decision. Reconstruct necessary contributions and dependencies. | Each retained step serves the outcome or a downstream consumer. Removal and merge decisions have reasons; the dependency order follows actual inputs. |
| 4. Test adequacy and failure | Change attendance or cancel a fictional reservation. Reassess sufficiency, feasibility, recovery and stopping conditions. | OPHANIM finds affected assumptions and dependencies, preserves constraints, and identifies independently checkable success/failure evidence. A valid sequence is not treated as guaranteed success. |
| 5. Judge further investigation | Compare checking existing evidence, asking for a missing fact and a costly fictional measurement. Include unknown costs and competing explanations. | OPHANIM names the decision learning could change and a discriminating observation. It separates mandatory requirements, information value and authority, retaining `no_change` or `insufficient_evidence` when justified. |
| 6. Demonstrate transfer | A separate assessor supplies an unfamiliar hypothetical objective, with a private evaluation key. OPHANIM responds without hints, then handles one changed condition. | The assessor finds evidence of necessary and sufficient work, justified dependencies, feasible constraints, honest uncertainty, independent verification and coherent revision. Terminology alone does not establish understanding. |

The coach supplies complete small exercise materials and records their version and advancement criteria before OPHANIM attempts them. Deliberately missing facts must be identifiable as unknowns; the coach must not require an undisclosed preference as the only correct answer. Phase 6's case and evaluation key come from the separate assessor, not the teaching coach.

## Session loop

1. Read the last progress entry and confirm the active phase and learning objective.
2. Present one exercise. Obtain and preserve OPHANIM's first attempt before supplying a hint or answer.
3. The coach identifies a demonstrated misconception and asks one diagnostic question. Avoid supplying a finished plan for OPHANIM to repeat.
4. Preserve each hint and revision. Check the published advancement criteria against the actual answer.
5. Advance only when every applicable criterion has support. A coached correction is recorded as coached; it is not unassisted mastery.
6. If understanding remains unresolved, record the missing prerequisite and a targeted remedial exercise. Stop the session instead of starting an unattended retry loop.
7. Before each assessment handoff or session end, the coach must produce the next itinerary under its charter: evidence, objective, ordered actions, inputs/owners, advancement/stopping conditions and exact resume point. The coordinator saves it with the progress record; it does not authorize phase advancement by itself.

There is one active exercise at a time. The coach's phase judgment is provisional instructional feedback. Final transfer requires a separate assessor who did not teach or write the learner's answer. If that assessor is unavailable, retain `ready_for_independent_check` rather than claiming mastery. A failed transfer returns to the relevant prerequisite; it does not erase previous attempts.

## First lesson — no solution supplied

> This is a hypothetical learning exercise. Six people need a one-hour discussion of a draft. All six can attend from 14:00 to 15:00, and any proposed room must accommodate six people. You are examining what a plan would require; you are not arranging the meeting.
>
> Before choosing a room, tool, person or task, state the observable outcome that would count as success and identify any part of that outcome the supplied facts do not yet establish.

Assess Phase 1 using its criteria above. Do not quietly convert the prompt into a booking, a notification, a provider call or an implementation ticket.

## Connection to OPHANIM

The [functional models](../../ophanim/efficiency/investigation/models.mjs) ground contributions in contracts and consumers, distinguish unknown observations from zero, and keep causal claims provisional. The [investigation selector](../../ophanim/efficiency/investigation/select.mjs) requires discriminating evidence and separates information value from authority. These are teaching references; this curriculum does not claim to be a controller-validated plan or to change those interfaces.

No fixed model roster, new service, installed agent runtime, experiment, paid call, optimization or release is needed to read and work through these exercises within the current assistant session. A future external runtime still requires its actual supported invocation and existing approvals. Persistent notes help resume the learning process; they do not establish model-weight training or lasting competence without demonstrated transfer.
