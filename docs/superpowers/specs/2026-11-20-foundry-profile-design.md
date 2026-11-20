# The `foundry` profile: design

Status: a proposal for the owner's approval. Nothing here is built. Written 2026-11-20 against
`feature/antigravity-sdk-intake` at `bec9a99`.

Every statement about the present code was read from the file it names. None of it was traced through a run.

## 1. Intent

The owner wants the lifecycle to work this way, in the owner's words where they were given:

- "A research team to thoroughly research my prompt."
- "All the models are chosen before planning and I want it dynamic", "based on the research team's findings and
  difficulty", chosen by "the researcher on the team".
- "The planner wrote the plan, the dispatcher reviews and then splits."
- "Gemini Hydrogen subagents."
- A reflection step, "checked at every boundary" between the blocks of the owner's architecture diagram.

The reasons the owner gave:

- For the reflection: "OPHANIM must learn from its own operation without repeatedly rediscovering the same defects
  or endlessly analyzing itself."
- For the dispatcher's split: the planner wrote the plan, so another seat reviews it and cuts it.
- For the team: it should follow what the research found about this prompt, not a fixed table.

No further reason was given, and none is assumed here.

## 2. What exists today (the `fit` profile)

| Step | Today | Where |
|---|---|---|
| Prompt intake | An authorized prompt becomes a work item with a signed status entry. | `ophanim/operate/prompt-intake.mjs` |
| Research | Runs before the planner only when a research request is recorded for the item. The team is Gemini Carbon with Hydrogen subordinates, read-only. Every member that answered is a contributor. | `ophanim/operate/research.mjs`, `pantheon/src/antigravity/research.mjs` |
| Models | Read from a fixed table of role by difficulty. | `pantheon/src/route/fit-matrix.mjs`, `frontier.mjs selectSeat` |
| Plan | The planner writes the plan and cuts it into `work_units`. Three labs that did not write it review plan and cut together. Only an approved version writes the ticket. | `ophanim/operate/stages.mjs`, `pantheon/src/pipeline/work-units.mjs` |
| Dispatch | One dispatcher turn per unit: is it cohesive, confirm the role, raise the difficulty, write the rubric. The rubric is frozen by hash. A unit it finds not cohesive goes back to the planner. | `pantheon/src/pipeline/dispatch.mjs` |
| Implement | One implementer per unit, chosen by that unit's difficulty, in its own worktree. Its subagents are its own Hydrogen sessions. | `pantheon/src/pipeline/implement.mjs`, `antigravity/subagents.mjs` |
| Unit review | Pinned to the exact model of that unit's dispatcher, because the dispatcher is recorded as a non-authoring arbiter (owner decisions of 2026-11-17 and 2026-11-19). | `pantheon/src/pipeline/review.mjs`, `dispatch.mjs` |
| Change review, validation | Three labs that contributed nothing review the change; an independent validator judges it against the original requirement and can return it to implement or to plan. | `ophanim/operate/stages.mjs` |
| Stage handoffs | Each stage's result is a signed `work.stage` record; the next stage re-derives its handoff from the ledger. | `ophanim/operate/work-ledger.mjs` |
| Reflection | Not a step. A `reflection` trigger can start the research team; the owner-corrections registry records failure classes. | `research.mjs`, `ophanim/lessons/corrections.mjs` |

Profiles today are `argo`, `legacy` and `fit` (`pantheon/src/route/frontier.mjs PROFILES`). Paired runs compare two
profiles on the same tickets (`pantheon/src/practice/compare.mjs`).

## 3. Goals

1. A fourth profile, `foundry`, beside `fit`. `fit` keeps its behaviour and its tests.
2. Under `foundry`, every item is researched before anything else is decided.
3. Under `foundry`, the researcher proposes the whole team for the ticket before planning, from its findings and the
   difficulty it reports. Code admits or refuses the proposal against the rules already in force.
4. Under `foundry`, the planner does not cut. The dispatcher reviews the approved plan, then cuts it.
5. Under `foundry`, a coded check runs at every boundary and starts a reflection only when a named trigger fired.

## 4. Non-goals

- The diagram's guardrail gate (prompt-injection and PII scans), the plan's "recovery conditions", the governor layer
  and the improvement loop of block 8 beyond the reflection step. None was found at intake or in the plan schema
  today; each is a separate piece of work.
- `foundry` on the per-file board path (`pantheon-board run`, `runOpenItem`). `foundry` is the governed lifecycle
  under `ophanim/operate` only. The board commands refuse `--profile foundry` by name.
- Retiring `fit`, or changing any `fit` behaviour.
- Changing the research team's own models. The owner fixed them on 2026-11-20 (Carbon, with Hydrogen subordinates).

## 5. Anti-goals

Each of these would make the work a failure even if it ran.

- `foundry` falling back to the `fit` table or the `fit` path without saying so.
- A team admitted that breaks an independence rule or the billing policy.
- A review panel of fewer than three labs.
- A `fit` test file edited to make room for `foundry`.
- A reflection that starts another reflection, or that creates executable work without the owner.
- A single successful reflection promoted into a rule.

## 6. Constraints

- **The register.** Every limit and every "not built" line of this work gets an entry in `docs/OPEN-LIMITATIONS.md`.
  That file is the coordinator's on the base.
- **Billing.** The research team spends on the Gemini API as the `primary` kind. With primary execution not declared
  the team is refused and its request stays open (`research.mjs`, SPEND).
- **Independence.** Under `fit` the review rule is at model level (`stages.mjs independenceFor`). `foundry` uses the
  same rule. Research members are contributors and are excluded from panels as today.
- **Evidence for a kill.** Each new refusal gets a test that failed first, and a mutation in a runner with the run
  bound. After any change to a module the ten existing runners target, those runners are run in full on the final
  tree. This is the lesson of L-719 and L-721: two adapted tests lost what they decided, and only a full run showed it.
- **Review before merge.** The independent review the repository already requires.

## 7. Approaches

How to bring the new lifecycle in:

1. **A new profile beside `fit` (chosen by the owner).** `fit` and its tests are untouched, and paired runs can
   compare the two on the same tickets. The cost is two lifecycles to keep working until one is retired.
2. **Change `fit` in place.** One lifecycle. Every `fit` test that assumes a planner's cut, a model per unit or a
   non-authoring dispatcher is rewritten, which is the change that lost P6 and W41, at a larger scale. The `fit`
   policy hash changes again and recorded practice decisions stop applying (L-712).
3. **Switches on `fit`, one per feature.** Dropped: four switches are sixteen combinations to test.

## 8. The lifecycle under `foundry`

```
prompt intake            (unchanged)
  -> research            every item; the researcher's conclusion carries findings, a difficulty, a team proposal
  -> team admission      code checks the proposal; refused -> the researcher is asked again
  -> plan                the team's planner; no work_units
  -> plan review         three labs, as today; an approved version writes the ticket
  -> dispatch            the team's dispatcher reviews the plan: returns it, or accepts and cuts it
  -> implement           the team's implementer on every unit; Hydrogen subagents; the team's unit reviewer
  -> change review       three labs; they are shown the plan AND the cut
  -> validate            the validator; it can return to implement, to the cut, or to plan
  -> outcome             the unsigned status proposal, as today
a boundary check after every arrow
```

### 8.1 Research on every item

Under `foundry` the scheduler records a research request for every new item before its first plan claim: trigger
`intake`, role `researcher` (a request may name its role). An open request already makes the plan stale and runs the
team before the planner (`research.mjs`, ACTIVATION); nothing new is needed for the ordering.

The question is built from the prompt's exact text and asks three things: what the change touches, what evidence
planning needs, and how hard it is.

An item whose research is refused (primary execution not declared, or its budget spent) is `pending` with the
refusal's code as its blocker. It is not planned.

### 8.2 The team proposal

The researcher's conclusion gains two parts, both in a fixed form that code validates:

- `difficulty`: `easy`, `medium` or `hard`, with the findings it rests on.
- `team`: for each role, a first choice and an ordered list of fallbacks, each with the finding it rests on.

The roles: planner, dispatcher, implementer, unit reviewer, the three plan reviewers, the three change reviewers,
validator. The subagent seat is not in the proposal: it is Hydrogen, by the owner's decision.

The researcher is shown, as data, the models the routing configuration declares for each role with their recorded
facts. It cannot name anything else.

One model per role for the whole ticket. There are no units before planning, so a unit's own difficulty no longer
chooses its implementer. The dispatcher still records a difficulty per unit; it selects nothing.

### 8.3 Team admission

`admitTeam(proposal, context)` is code. It returns the admitted team, or every rule the proposal breaks, by name:

- a model the configuration does not declare for that role;
- a reviewer or the validator that is a contributor: a research member, the planner, the dispatcher, the implementer,
  the subagent model;
- the unit reviewer being the dispatcher's or the implementer's model;
- fewer than three labs on either panel;
- a Gemini seat whose billing kind is not declared.

A refused proposal goes back to the researcher with the refusals, at most twice. After that the item is `pending`
with blocker `TEAM_NOT_ADMITTED`. Nothing is seated from the `fit` table.

The admitted team is one signed record on the work ledger (a new kind, `work.team`): the item, the research
conclusion it came from, the proposal's digest, the team, and each refusal on the way. Its digest is part of every
later stage's attempt inputs, so a stage run under another team is another attempt.

The team is fixed until a new research conclusion is recorded for the item. Then a new proposal is admitted and the
stages that rested on the old one are stale by the existing evidence check.

Panels are still re-checked when they are seated, by the existing rule: a fallback that answered can make a chosen
reviewer a contributor. That seat is replaced by the proposal's next reviewer. With none left the stage is `pending`,
as a short pool is today.

### 8.4 Plan

The plan document is today's, without `work_units`. A plan that carries them is refused: under `foundry` the planner
does not cut. The planner's prompt loses its decomposition paragraph. The three-lab plan review is unchanged.

### 8.5 The dispatcher reviews, then cuts

A new first step of the implement stage, one read-only dispatcher turn over the approved plan and the dossier:

- **Not accepted.** The dispatcher returns findings. They are recorded, and the item returns to the plan stage as an
  inadequate plan does today, inside the existing bounds on revisions.
- **Accepted.** The dispatcher returns `work_units` in today's schema, each with its rubric. The controller validates
  them as it validates a planner's today (schema, overlapping paths, dependency loops, reserved paths) and freezes each
  rubric by hash, as today. A cut that fails validation goes back to the dispatcher with the reasons, at most twice;
  then the stage is blocked.

The dispatcher is not asked whether a unit is cohesive: it cut it.

Under `foundry` the dispatcher is recorded as a **contributor** (purpose `split`). It wrote the shape of the work.
The existing exclusion of contributors then keeps its model off both panels and away from the validator with no new
rule. The 2026-11-17 decision that the dispatcher is a non-authoring arbiter stays as written, for `fit`.

The cut is not reviewed by outside labs on its own. The change reviewers and the validator are shown the plan and
the cut, and are asked whether the cut fitted the plan. The validator gains one verdict, a defect of the cut, which
returns the item to the dispatch step.

### 8.6 Implement and unit review

Every unit is implemented by the team's implementer; its ladder is the team's fallbacks. Subagents are the
implementer's own Hydrogen sessions within its ceiling, as today (Carbon 8, Neon 4, Hydrogen none).

The unit reviewer is the team's, and is not pinned to the dispatcher. Its ladder is the team's fallbacks.

### 8.7 The boundary check and the reflection

After every boundary in the diagram above, the scheduler runs `boundaryCheck`: code only, over the ledger records of
the step that just ended. It looks for the owner's triggers:

| Trigger | Read from |
|---|---|
| a significant discovery | a research conclusion marked material; a blocking finding |
| a failure | a stage released as failed, blocked or returned |
| a contradiction | a research conclusion that records one; a validator verdict against an approving review |
| a revision | a plan version after the first; a unit revised; a cut returned |
| a recovery | an expired claim resumed; a fallback seat that answered; a model-guard refusal; evidence recovery |
| completed work with new evidence | the outcome boundary |

Every check is recorded (a new kind, `work.reflection`, phase `check`): the item, the boundary, the triggers found,
and the decision. Most are `none`.

When a trigger fired, one reflection runs before the next stage is claimed. It is the research team, started by its
existing `reflection` trigger (which seats the explorer role), read-only, with the owner's five-part text as its charter: observe, investigate, derive obligations,
preserve learning, apply and verify. Research sessions may not read the ledger or the item's state, so the controller
hands the reflection a derived, read-only view of the item's records: the stage records, findings, decisions and
verification results, with no key in it.

Its conclusion is recorded (`work.reflection`, phase `conclusion`) in a fixed form: what was observed, the cause, whether
it is one defect or a class, obligations, lessons, and a verdict of `no_change`, `insufficient_evidence` or
`obligations`.

- **Obligations** are proposals. They are recorded as intake candidates, which the code already never executes until
  the owner adds an item (`reconcile.mjs`).
- **Lessons** carry their evidence, when they apply and their limits. They stay on the ledger and are shown in later
  items' dossiers as one derived view. Nothing becomes policy from them.

Bounds:

- one reflection per boundary per attempt;
- three per item; after that checks are still recorded, with decision `capped`;
- a reflection's own records never fire a trigger;
- a reflection that reaches its request bound concludes `insufficient_evidence`, and the lifecycle goes on;
- a reflection the billing policy refuses is recorded as skipped, and the lifecycle goes on. Research at intake blocks
  an item; a reflection never does.

## 9. Delivery

Three pull requests. After each, `foundry` runs end to end on scripted providers and every `fit` suite passes with
no `fit` test file changed.

1. **The profile and the boundary check.** `foundry` is registered and behaves as `fit` does, with the boundary check
   and the reflection added. The check comes first because it only adds a step.
2. **Research on every item and the team.** The intake request, the proposal, admission, `work.team`, every seat
   taken from the team.
3. **The dispatcher's review and cut.** The plan without units, the new dispatch step, the dispatcher as a
   contributor, the unit reviewer from the team, the cut shown to the change reviewers and the validator.

A paired run of `fit` against `foundry` on the same tickets follows the third. It is a measurement, not a claim that
one is better.

## 10. Who decided what

Decided by the owner, 2026-11-20:

- the dispatcher cuts, after reviewing the plan;
- Gemini Hydrogen subagents;
- the reflection is checked at every boundary;
- all models are chosen before planning, per ticket;
- the choice rests on the research team's findings and the difficulty;
- the researcher on the team makes it;
- a new profile beside `fit`.

Calls made in writing this, for the owner to check:

1. The profile's name, `foundry`.
2. The plan keeps its three-lab review before the ticket. Stated to the owner twice and not corrected.
3. The cut gets no outside review of its own; the change review and the validator judge it. This is a reading of
   one unclear message.
4. One model per role per ticket, with ordered fallbacks named in the proposal.
5. Code refuses a proposal that breaks a rule; two more attempts, then the item is pending. No fallback to `fit`.
6. Under `foundry` the dispatcher is a contributor and the unit reviewer is not pinned to it.
7. Research is required: with Gemini primary execution off, no `foundry` item is planned.
8. A triggered reflection runs before the next stage, inside a hard bound, and never blocks on billing.
9. Obligations become intake candidates; lessons stay on the ledger and are shown in later dossiers.
10. `foundry` is the `ophanim/operate` lifecycle only, not the per-file board path.
11. The delivery order starts with the profile and the boundary check.

## 11. Left to the builder

- The exact fields of the proposal, of `work.team` and of `work.reflection`, within what section 8 fixes.
- Whether the dispatcher's cut and its rubrics are one turn or a cut followed by a rubric turn per unit. Either way
  every rubric is frozen by hash before any implementer runs.
- How the boundary check reads each trigger from the ledger, and the form of the derived view a reflection is given.
- The names of the new test files and of the runner for the new mutations.
- How `foundry` is threaded through the places that list profiles (`frontier.mjs`, `practice/compare.mjs`,
  `run-item.mjs`, the command-line flags), and where the board commands refuse it.

## 12. Known limits of this design

- **The researcher chooses its own lab's seats.** The researcher is Gemini Carbon and may propose Gemini models as
  planner and implementer. Admission stops it seating a contributor as a reviewer; it does not stop a preference for
  its own lab among the working seats. Not addressed here.
- **A unit's difficulty no longer chooses its model.** An easy unit of a hard ticket runs on the hard ticket's
  implementer. That costs more than `fit` does for the same unit.
- **Research on every item costs Gemini requests on every item**, including trivial ones.
- **The cut is reviewed late.** A poor cut is found by the change review or the validator, after the work is done.
- **Nothing here was run.** Every claim about the present code is from reading it.
