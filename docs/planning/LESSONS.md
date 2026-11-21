# Planning lessons to carry forward

Owner correction, 2026-11-16: “You are not planning for an actual project you are learning what a plan requires.”

The current exercise studies how to derive, challenge and evaluate a plan. OPHANIM supplies mechanisms and examples for that reasoning. The earlier Phase 0–2 packet was a project-specific response to a learning exercise; it is preserved as historical output and is superseded as the direction of this exercise.

**Lessons from the scope error**

- Establish the level of the task: learning a method, planning a project, or executing work. A request to implement an exercise does not by itself turn its examples into project obligations. The owner's subsequent correction controls the exercise.
- Check intent alignment before reviewing structural correctness. The previous packet's source accuracy, tests and independent reviews did not establish that it answered the right question.
- Derive requirements from observable success, the current situation and constraints. Repository components provide evidence and possible mechanisms; their existence does not make each one a required workstream.
- Select the smallest artifact that demonstrates understanding. More tickets, documents, models or phases are not measures of learning or plan quality.
- Use source findings within their actual scope. OPHANIM's synthetic templates, fixture authority and investigation selector illustrate particular guarantees. They do not supply a general oracle for arbitrary plans.
- Keep necessity, sufficiency, feasibility, information value and authority separate. Mandatory constraints cannot be discarded because they are expensive. A worthwhile investigation still needs permission to execute.
- Preserve uncertainty and negative outcomes. Missing evidence remains unknown; `no_change` and `insufficient_evidence` can be correct conclusions. A new exercise is not materially new evidence for repeating deferred work.

**What a plan must account for**

| Question | What the reasoning must establish |
| --- | --- |
| What counts as success? | An observable outcome and the boundary of the problem. |
| What is already known or available? | Evidence, assumptions, uncertainty and reusable capabilities. |
| Why is each step necessary? | Its required contribution or downstream consumer; what would fail if it were removed. |
| What must precede it? | Real dependencies, inputs, ownership and readiness conditions. |
| Are the steps sufficient together? | Coverage of the outcome, including transitions, handoffs and relevant failure cases. |
| Is the approach feasible? | Available resources, constraints, permissions and justified alternatives. |
| How could it be shown wrong? | Independent acceptance evidence and counterexamples, not the author's confidence. |
| When should it change or stop? | Defined conditions for revision, recovery, stopping or retaining the current state. |

These questions are an evaluation lens. Apply the ones relevant to the hypothetical problem; do not manufacture machinery to fill every category.

**How to demonstrate learning**

Use a small hypothetical objective. Derive its necessary functions and obligations before selecting tools or people. Explain each dependency. Challenge the result by removing a step, merging apparently redundant steps, changing a constraint and introducing a failure. Check both whether the remaining plan still achieves its purpose and whether the proposed evidence could detect its failure. Revise the reasoning, or explicitly stop when information is insufficient.

Learning is demonstrated by explaining and transferring those judgments to an unfamiliar example. No actual project progression, worker dispatch, provider call, experiment, optimization or release follows from this exercise.

The [earlier packet](phase0-2-evaluation/README.md) and its recorded reviews remain historical evidence. Their hashes refer to their recorded Git candidates; they are not renewed claims about this scope correction. This note preserves the correction without rewriting those results.
