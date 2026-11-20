# The `foundry` profile: design

Status: a proposal for the owner's approval. Nothing here is built. Written 2026-11-20 against
`feature/antigravity-sdk-intake` at `bec9a99`.

Every statement about the present code was read from the file it names. None of it was traced through a run. A
second reader checked the draft against the code and found five statements wrong; they are corrected here.

Two questions are open for the owner (section 10). The design is written on the answer marked as assumed.

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
| Research | Runs before the planner only when a research request is recorded for the item. The team is a Gemini Carbon coordinator with Hydrogen subordinates, read-only, bounded (12 coordinator rounds, 40 members, 240 requests). Every member that answered is a contributor. A concluded team records nothing more. | `ophanim/operate/research.mjs`, `pantheon/src/antigravity/research.mjs`, `config/antigravity-sdk.json` |
| Models for the work | A fixed table of role by difficulty, one lab per role: Anthropic planners, OpenAI dispatchers, Gemini implementers on the Antigravity SDK. | `pantheon/src/route/fit-matrix.mjs FIT_MATRIX` |
| Models for review | Chosen by code from the reviewer pool. The rule is by model: a reviewer is not a model that contributed. Three labs sit; a lab that contributed may sit with another of its models, marked `shared_lab`. | `pantheon/src/ledger/review-cycle.mjs reviewSeatsByModel` |
| Plan | The planner writes the plan, including how a failed slice is recovered and how the change is undone, and cuts it into `work_units`. The panel reviews plan and cut together. Only an approved version writes the ticket. | `ophanim/operate/stages.mjs`, `pantheon/src/pipeline/work-units.mjs` |
| Dispatch | One dispatcher turn per unit: is it cohesive, confirm the role, raise the difficulty, write the rubric. The rubric is frozen by hash. A unit it finds not cohesive goes back to the planner. Units that could run together and own overlapping paths are refused here, not when the plan is validated. | `pantheon/src/pipeline/dispatch.mjs` |
| Implement | One implementer per unit, chosen by that unit's difficulty, in its own worktree. Its subagents are its own Hydrogen sessions. | `pantheon/src/pipeline/implement.mjs`, `antigravity/subagents.mjs` |
| Unit review | Pinned to the exact model of that unit's dispatcher, because the dispatcher is recorded as a non-authoring arbiter (owner decisions of 2026-11-17 and 2026-11-19). | `pantheon/src/pipeline/review.mjs`, `dispatch.mjs` |
| Change review, validation | The panel reviews the change; an independent validator judges it against the original requirement and can return it to implement or to plan. | `ophanim/operate/stages.mjs` |
| Stages and claims | Five ledger stages: plan, implement, review, validate, outcome. Each is one claim with a budget. Every billed Gemini request cites one live claim. | `ophanim/operate/work-ledger.mjs` |
| Profile | An argument of the stage executors, `fit` unless given. The scheduler, the `operate` commands and the stage records do not name it. The live-run launcher refuses anything but `fit`. | `stages.mjs makeExecutors`, `live-run.mjs` |
| Reflection | Not a step. A `reflection` trigger can start the research team. The owner-corrections registry records failure classes. | `research.mjs`, `ophanim/lessons/corrections.mjs` |

Profiles today are `argo`, `legacy` and `fit` (`pantheon/src/route/frontier.mjs PROFILES`).

## 3. Goals

1. A fourth profile, `foundry`, beside `fit`. `fit` keeps its behaviour and its tests.
2. Under `foundry`, every item is researched before anything else is decided.
3. Under `foundry`, the researcher proposes the whole team for the ticket before planning, from its findings and the
   difficulty it reports. Code admits or refuses the proposal against the rules already in force.
4. Under `foundry`, the planner does not cut. The dispatcher reviews the approved plan, then cuts it.
5. Under `foundry`, a coded check runs at every boundary and starts a reflection only when a named trigger fired.

## 4. Non-goals

- The diagram's guardrail gate (prompt-injection and PII scans), the governor layer and the improvement loop of
  block 8 beyond the reflection step. No scan was found at intake today; each is a separate piece of work.
- `foundry` on the per-file board path (`pantheon-board run`, `runOpenItem`), and in the live-run launcher. `foundry`
  is the governed lifecycle run by `operate tick`, `watch` and `serve`. The other entry points refuse it by name.
- A side-by-side comparison of `fit` and `foundry`. The existing paired runs drive the per-file board path only
  (`practice/compare.mjs dispatchRunner`); nothing compares two lifecycles today. Building that is separate work.
- Retiring `fit`, or changing any `fit` behaviour.
- Changing the research team's own models. The owner fixed them on 2026-11-20 (Carbon, with Hydrogen subordinates).
- A new transport. Each role stays on the lab that can run it today.

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
  the team is refused and its request stays open. Every billed request cites a live claim.
- **Independence.** `foundry` uses the model-level rule `fit` uses. Research members are contributors and are
  excluded from panels as today.
- **Shared code.** `foundry` adds to modules `fit` also runs through (`stages.mjs`, `gates.mjs`, `work-ledger.mjs`,
  `scheduler.mjs`). Every addition is reached only for an item recorded as `foundry`. No ledger stage is added: the
  five stages and their claims stay as they are.
- **Evidence for a kill.** Each new refusal gets a test that failed first, and a mutation in a runner with the run
  bound. After any change to a module the ten existing runners target, those runners are run in full on the final
  tree. This is the lesson of L-719 and L-721: two adapted tests lost what they decided, and only a full run showed it.
- **Review before merge.** The independent review the repository already requires.

## 7. Approaches

How to bring the new lifecycle in:

1. **A new profile beside `fit` (chosen by the owner).** `fit` and its tests are untouched. The cost is two
   lifecycles to keep working until one is retired. (When this was put to the owner, the two were said to be
   comparable on the same ticket with the existing paired runs. That was wrong for the lifecycle; see section 4.)
2. **Change `fit` in place.** One lifecycle. Every `fit` test that assumes a planner's cut, a model per unit or a
   non-authoring dispatcher is rewritten, which is the change that lost P6 and W41, at a larger scale. The `fit`
   policy hash changes again and recorded practice decisions stop applying (L-712).
3. **Switches on `fit`, one per feature.** Dropped: four switches are sixteen combinations to test.

## 8. The lifecycle under `foundry`

```
prompt intake                                                          (unchanged)
PLAN claim       research           every item; findings, a difficulty, a team proposal
                 team admission     code checks the proposal while the team is still open
                 plan               the team's planner; no work_units
                 plan review        the panel, as today; an approved version writes the ticket
IMPLEMENT claim  dispatch           the team's dispatcher reviews the plan: returns it, or accepts and cuts it
                 implement          the team's implementer on every unit; Hydrogen subagents; the team's unit reviewer
REVIEW claim     change review      the panel; shown the plan AND the cut
VALIDATE claim   validate           it can return to implement, to the cut, or to plan
OUTCOME claim    outcome            the unsigned status proposal, as today
a boundary check after every line
```

### 8.1 Which items are `foundry`

The launcher chooses: `operate tick`, `watch` and `serve` take `--profile fit|foundry` (the service takes it from
its configuration). Without it they run `fit`, as today.

The item remembers. The first `foundry` record of an item pins it, and every stage record written under `foundry`
names the profile. An executor of one profile refuses an item pinned to the other, by name (`PROFILE_MISMATCH`). An
item already part-way through under `fit` stays `fit`.

### 8.2 Research on every item

At the start of a `foundry` item's first plan claim, before anything else, the plan stage records a research request:
trigger `intake`, role `researcher`. The team runs under that claim, as research before a plan does today.

The question is built from the prompt's exact text and asks three things: what the change touches, what evidence
planning needs, and how hard it is. The team runs within its existing bounds.

An item whose research is refused (primary execution not declared, or its budget spent) is `pending` with the
refusal's code as its blocker. It is not planned.

### 8.3 The team proposal

The coordinator's final report gains two parts, both in a fixed form that code validates:

- `difficulty`: `easy`, `medium` or `hard`, with the findings it rests on.
- `team`: for each role, a first choice and an ordered list of fallbacks, each with the finding it rests on.

What the researcher may choose, role by role (assumed answer to question 1 of section 10):

| Role | Chosen from |
|---|---|
| planner | the Anthropic models the routing table declares for planners |
| dispatcher | the OpenAI models it declares for dispatchers |
| implementer | the Gemini models the Antigravity SDK configuration declares, each with a recorded effort level |
| unit reviewer | the OpenAI models declared for dispatchers, other than the dispatcher chosen |
| plan reviewers, change reviewers, validator | the existing reviewer pool |

The subagent seat is not in the proposal: it is Hydrogen, by the owner's decision.

The researcher is shown these lists as data, with each model's recorded facts. It cannot name anything else.

So each role keeps its lab, as in the owner's diagram, and what is dynamic is the model within it, chosen role by
role. Under `fit` one difficulty picks every seat from one column of the table.

One model per role for the whole ticket. There are no units before planning, so a unit's own difficulty no longer
chooses its implementer. The reported difficulty is recorded and shown to the planner and the dispatcher; it selects
nothing in code. The dispatcher still records a difficulty per unit; that selects nothing either.

### 8.4 Team admission

`admitTeam(proposal, context)` is code. It returns the admitted team, or every rule the proposal breaks, by name:

- a model outside the list for its role;
- a reviewer or the validator that is a contributing model: a research member, the planner, the dispatcher, the
  implementer, the subagent model;
- the unit reviewer being the dispatcher's or the implementer's model;
- fewer than three labs on either panel;
- a Gemini seat whose billing kind is not declared.

Admission runs while the research team is still open. A refused proposal goes back to the coordinator as its next
round, with the refusals, inside the team's existing bound of rounds. No second team is started for it. The team's
conclusion then carries the admitted team.

A team that concludes with no admitted proposal (its rounds or requests spent, or stopped) leaves the item `pending`
with blocker `TEAM_NOT_ADMITTED`. Nothing is seated from the `fit` table. A new intake request, which the owner or an
operator can record, starts again.

The admitted team is one signed record on the work ledger (a new kind, `work.team`): the item, the research
conclusion it came from, the proposal's digest, the team, and each refusal on the way. Its digest is part of every
later stage's attempt inputs, so a stage run under another team is another attempt.

Only intake research carries a proposal. Research asked for later (by the plan stage for a gap, by an operator, after
a review finding) changes what a plan rests on, as today, and does not change the team. A new intake request does:
its conclusion is admitted as a new team, and every stage that ran under the old one is stale, approved units
included.

Panels are still re-checked when they are seated, by the existing rule: a fallback that answered can make a chosen
reviewer a contributor. That seat is replaced by the proposal's next reviewer. With none left the stage is `pending`,
as a short pool is today.

### 8.5 Plan

The plan document is today's, without `work_units`. A plan that carries them is refused: under `foundry` the planner
does not cut. The planner's prompt loses its decomposition paragraph. The plan review is unchanged.

### 8.6 The dispatcher reviews, then cuts

A new first step of the implement stage, under its claim: one read-only dispatcher turn over the approved plan and the
dossier.

- **Not accepted.** The dispatcher returns findings. They are recorded, and the item returns to the plan stage as an
  inadequate plan does today. At most two such returns per item; a third leaves the item blocked for the owner, with
  the findings.
- **Accepted.** The dispatcher returns `work_units` in today's schema, each with its rubric. The controller applies
  the checks it applies to a planner's units today: the schema, dependency loops and reserved paths when they are
  read, and overlapping paths between units that could run together when they are dispatched. Each rubric is frozen
  by hash, as today. A cut that fails a check goes back to the dispatcher with the reasons, at most twice; then the
  stage is blocked.

The dispatcher is not asked whether a unit is cohesive: it cut it.

Under `foundry` the dispatcher is recorded as a **contributor** (purpose `split`). It wrote the shape of the work.
The existing exclusion of contributing models then keeps its model off both panels and away from the validator with
no new rule. The 2026-11-17 decision that the dispatcher is a non-authoring arbiter stays as written, for `fit`.

The cut is not reviewed by an outside panel on its own (assumed answer to question 2 of section 10). The change
reviewers and the validator are shown the plan and the cut, and are asked whether the cut fitted the plan. The
validator gains one verdict, a defect of the cut, which returns the item to the dispatch step. At most two such
returns per item; a third leaves the item blocked for the owner.

### 8.7 Implement and unit review

Every unit is implemented by the team's implementer; its ladder is the team's fallbacks. Subagents are the
implementer's own Hydrogen sessions within its ceiling, as today (Carbon 8, Neon 4, Hydrogen none).

The unit reviewer is the team's, and is not pinned to the dispatcher. Its ladder is the team's fallbacks.

### 8.8 The boundary check and the reflection

After every line of the diagram in section 8, `boundaryCheck` runs: code only, over the ledger records of the step
that just ended. It looks for the owner's triggers:

| Trigger | Read from |
|---|---|
| a significant discovery | a research conclusion marked material; a blocking finding |
| a failure | a stage released as failed, blocked or returned |
| a contradiction | a validator verdict against an approving review; a dispatcher's return of an approved plan |
| a revision | a plan version after the first; a unit revised; a cut returned |
| a recovery | an expired claim resumed; a fallback seat that answered; a model-guard refusal; evidence recovery |
| completed work with new evidence | the outcome boundary |

Every check is recorded (a new kind, `work.reflection`, phase `check`): the item, the boundary, the triggers found,
and the decision. Most are `none`.

When a trigger fired, one reflection runs before the work goes on, under a live claim:

- at a boundary inside a stage, under that stage's claim;
- at a boundary between two stages, as the first act of the next stage's claim;
- at the outcome boundary, under the outcome claim before it is released.

Its requests are charged to that claim's budget, inside a bound of its own that is declared before it starts.

A reflection is run by the research team's machinery, seated as the existing `reflection` trigger seats it (the
explorer role), read-only, with the owner's five-part text as its charter: observe, investigate, derive obligations,
preserve learning, apply and verify. Research sessions may not read the ledger or the item's state, so the controller
hands the reflection a derived, read-only view of the item's records: the stage records, findings, decisions and
verification results, with no key in it.

Its records are `work.reflection` records, not research records. So a reflection never makes a plan stale by itself,
and the rule that an open research request holds up the plan does not see it.

Its conclusion (`work.reflection`, phase `conclusion`) has a fixed form: what was observed, the cause, whether it is
one defect or a class, obligations, lessons, and a verdict of `no_change`, `insufficient_evidence` or `obligations`.

- **Obligations** are proposals. They are recorded as intake candidates, which the code already never executes until
  the owner adds an item (`reconcile.mjs`).
- **Invalidated evidence.** A reflection that names evidence a plan rests on as invalid records a research request
  with the existing `invalidated-evidence` trigger. That is the one way a reflection sends an item back, and it is the
  path that exists for it today.
- **Lessons** carry their evidence, when they apply and their limits. They stay on the ledger and are shown in later
  items' dossiers as one derived view. Nothing becomes policy from them.

Bounds:

- one reflection per boundary per attempt;
- three per item; after that checks are still recorded, with decision `capped`;
- a reflection's own records never fire a trigger;
- a reflection that reaches its bound concludes `insufficient_evidence`, and the lifecycle goes on;
- a reflection the billing policy refuses is recorded as skipped, and the lifecycle goes on. Research at intake blocks
  an item; a reflection never does.

## 9. Delivery

Three pull requests. After each, `foundry` runs end to end on scripted providers and every `fit` suite passes with
no `fit` test file changed.

1. **The profile and the boundary check.** `foundry` is registered, pinned per item, and behaves as `fit` does, with
   the boundary check and the reflection added. The check comes first because it only adds a step.
2. **Research on every item and the team.** The intake request, the proposal, admission, `work.team`, every seat
   taken from the team.
3. **The dispatcher's review and cut.** The plan without units, the new dispatch step, the dispatcher as a
   contributor, the unit reviewer from the team, the cut shown to the change reviewers and the validator.

## 10. Who decided what

Decided by the owner, 2026-11-20:

- the dispatcher cuts, after reviewing the plan;
- Gemini Hydrogen subagents;
- the reflection is checked at every boundary;
- all models are chosen before planning, per ticket;
- the choice rests on the research team's findings and the difficulty;
- the researcher on the team makes it;
- a new profile beside `fit`.

Open for the owner. The design assumes the answer given:

1. **What may the researcher choose from?** Assumed: the model within each role's lab, as the diagram draws the labs
   (section 8.3). The other answer, any lab for any role, needs transports that do not exist: today only the
   Antigravity SDK and the older Antigravity lanes can run an implementer.
2. **Is the cut reviewed by an outside panel before the work starts?** Assumed: no. The plan keeps its panel review
   before the ticket, and the cut is judged with the finished change (section 8.6). This is a reading of one unclear
   message.

Calls made in writing this, for the owner to check:

1. The profile's name, `foundry`.
2. One model per role per ticket, with ordered fallbacks named in the proposal.
3. The reported difficulty is recorded and shown; it selects nothing in code.
4. Code refuses a proposal that breaks a rule. The re-ask is a round of the same team. With no admitted team the
   item is pending. No fallback to `fit`.
5. Only intake research changes the team.
6. Under `foundry` the dispatcher is a contributor and the unit reviewer is not pinned to it.
7. Research is required: with Gemini primary execution off, no `foundry` item is planned. Every item pays for a
   research team inside its existing bounds, trivial items included.
8. The launcher chooses the profile and the item is pinned to it.
9. No ledger stage is added. A reflection runs under the claim of the stage that goes on, inside its own bound.
10. A triggered reflection runs before the work goes on, and never blocks on billing or on its bound.
11. Obligations become intake candidates; lessons stay on the ledger and are shown in later dossiers.
12. At most two returns from the dispatcher to the plan, and two from the validator to the cut, per item.
13. `foundry` runs under `operate tick`, `watch` and `serve` only.
14. The delivery order starts with the profile and the boundary check.

## 11. Left to the builder

- The exact fields of the proposal, of `work.team` and of `work.reflection`, within what section 8 fixes.
- Whether the dispatcher's cut and its rubrics are one turn or a cut followed by a rubric turn per unit. Either way
  every rubric is frozen by hash before any implementer runs.
- How the boundary check reads each trigger from the ledger, and the form of the derived view a reflection is given.
- The size of a reflection's own bound.
- How the research team's runner is given a recorder that writes `work.reflection` records.
- The names of the new test files and of the runner for the new mutations.
- How `foundry` is threaded through the places that list profiles (`frontier.mjs`, `practice/compare.mjs`,
  `run-item.mjs`, the command-line flags), and where the other entry points refuse it.

## 12. Known limits of this design

- **The choice is narrow.** Three planners, three dispatchers and three implementers are declared today. "Dynamic"
  is a choice among those, role by role.
- **A unit's difficulty no longer chooses its model.** An easy unit of a hard ticket runs on the hard ticket's
  implementer. That costs more than `fit` does for the same unit.
- **Research on every item costs Gemini requests on every item**, up to the team's bound of 240.
- **The cut is reviewed late.** A poor cut is found by the change review or the validator, after the work is done.
- **`fit` and `foundry` cannot be compared side by side** with what exists.
- **Other loops keep their present bounds.** The two per-item caps here cover only the two new returns. A validator's
  return to the plan is bounded as it is today, per attempt.
- **Nothing here was run.** Every claim about the present code is from reading it.
