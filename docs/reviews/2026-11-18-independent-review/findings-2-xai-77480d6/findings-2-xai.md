<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 2, Review independence

- status: complete
- stop_reason: final answer
- via: subscription
- transport: grok-cli
- cli_version: `grok 1.0.44 (5b807183dd79)`
- auth_method_observed: state-dir-present (browser login assumed, not verified)
- subscription_coverage: undocumented
- lab: xAI
- requested_model: `grok-4.7`
- default_reviewer: OpenAI, `gpt-6-astra` (the README's reviewer for this assignment)
- reviewer_override: true (--reviewer xai:grok-4.7)
- served_model: `grok-4.7`
- served_model_source: input (the CLI names no served model; this is the model the runner asked for)
- sandbox: the runner's bwrap jail (host read-only; worktree read-only except .review-tests/; state dir a per-run scratch copy; network not cut)
- grok_permissions: config.toml permission_mode unset (default "ask"); [permission] `rules = [` `{ action = "allow", tool = "Read" },` `{ action = "allow", tool = "Grep" },` `{ action = "allow", tool = "Edit" },` `{ action = "allow", tool = "Bash", pattern = "node --test *" },` `{ action = "allow", tool = "Bash", pattern = "npm run test:proof" },` `{ action = "allow", tool = "Bash", pattern = "npm test" },` `]` `allow = ["Read", "Grep", "Edit", "Bash(node --test *)", "Bash(npm run test:proof)", "Bash(npm test)"]` (6 allow rule(s))
- policy_violations: none
- commit: `77480d6b262c92ceca5a159cc5be3e3ee627b922`
- started_at: 2026-11-19T03:07:54.300Z
- ended_at: 2026-11-19T03:37:53.382Z
- usage_totals: `{"input_tokens":622250,"cache_read_input_tokens":10064128,"cache_creation_input_tokens":0,"output_tokens":117551,"reasoning_tokens":79418,"total_tokens":10803929}` (as the CLI reported it)
- limits: `{"wall_clock_s":3600,"ignored":[]}`
- transcript: `findings-2-xai.transcript.json` sha256 `c17697247eac4c1c756eb9c317d22819ed3eb74a78c1a468b78ca926cd87bd6b`
- harness_cli_template_sha256: `69402fb55cdb7246281546ce42d82ea28d3c5dbe68f646c64cd93e55d172ac36`
- harness_sha256: `c9a7bc5677569c720772ffea8d145c34bfa300a70eafded53fe4a2c6ced3745e`
- brief_sha256: `4eb813d03a1eb87e2740f73db2765ba41158486877cf8bbb20fc7ad11c24ac35`
- prompt_sha256: `cf8d796cf553c13f72ef6943443f524477c80b23609269e3782094ba7bd273e8`
- continued_from: `db2a62c33179bb7d77f814c5d68b60e89aa7492dd9342e4eb1cad3640fa0f3b5` (`findings-2-xai.transcript.json`)
- continuation_method: replayed-own-transcript (a new session; the prompt carries a delimited appendix of the reviewer's own earlier messages and tool results)
- runs: 2
- usage_totals_cumulative: `{"input_tokens":638943,"cache_read_input_tokens":10097792,"cache_creation_input_tokens":0,"output_tokens":118646,"reasoning_tokens":80067,"total_tokens":10855381}`
- wall_clock_cumulative_s: 1815

<!-- reviewer's final message, verbatim, follows -->

# Assignment 2 — Review independence

Lab: xAI. Model that served this review: Grok 4.7. Commit reviewed: `77480d6b262c92ceca5a159cc5be3e3ee627b922`.

Interest. `gpt-6-astra` and `gpt-6.1-sol` are the hard and medium Stage 2 dispatchers and the pinned Stage 5 reviewers in the `fit` matrix, so an OpenAI reviewer would benefit from the arbiter exception under review. This review was served by Grok 4.7. It does not hold that interest.

Probes: `node --test .review-tests/independence-a2.test.mjs` (16 tests, 0 failures). Synthetic names and temporary ledgers only. No provider call.

## 1. Same model, other name

**holds.** A contributing model cannot review under another name that this policy treats as the same model.

`baseOf` lowercases, walks `same_model` to a fixpoint (at most eight steps), and strips a trailing `-YYYYMMDD` (`pantheon/src/review/identity.mjs:45-53`). `resolveModel` takes the lab from `model_lab[base]`, never from the transport (`identity.mjs:91-102`). `contributorKeys` counts the requested name, the served name, and `requested_model` (`identity.mjs:120-131`). `reviewerIdentity` admits an answer only when both names resolve to the same lab (`identity.mjs:159-171`).

Checked, and they collapse to one id: `gemini-4-carbon-high` on `agy_google` with `gemini-4-carbon` on `google`; `gemini-4-hydrogen-xhigh` with `gemini-4-hydrogen`; the retired lane `claude-opus-4-6-thinking` with `claude-opus-4-6`; `grok-4.7-20261118` and `  GROK-4.7  ` with `grok-4.7`. A contributor recorded as asked `gemini-4-carbon-high` and served `gemini-4-carbon` is refused when the answer is served as `gemini-4-carbon-low`. A turn asked as `grok-4.6` and served as `grok-4.7` excludes both ids, including a later answer served as `grok-4.6-20261118`.

A direct vendor cannot wear another lab's name: `resolveModel('openai', 'grok-4.7')` is `{known: false, lab: null}`. An undeclared suffix (`gpt-6-astra-high`) and a hyphenated date (`gpt-4o-2024-08-06`) stay unresolved, so they cannot be admitted as a second reviewer. `gpt-6-sol` and `gpt-6.1-sol` stay distinct, which is the owner's split. A known non-Google model on `agy_google` fails `candidateRefusal` with the route-lab refusal (`identity.mjs:107-110`, `identity.mjs:137-142`).

The lifecycle's pipeline comparison uses this resolver (`ophanim/operate/stages.mjs:962`). The weaker `sameModelName` in `pantheon/src/pipeline/util.mjs:40-43` is the default only inside `judgingTurn` when a caller does not pass `sameModel`.

## 2. Unresolved names

**holds.** An unresolved name is not given a lab or an identity, and an unresolved contributor cannot leave a qualifying panel.

`resolveModel` returns `{known: false, id: null, lab: null}` when the base is undeclared, including `gemini-pro-orchestrator` (`identity.mjs:94-95`). `contributorKeys` puts that row in `unresolved` and adds neither a model id nor a lab (`identity.mjs:125-130`). `reviewSeatsByModel` throws `NO_SEATS` before any seat is chosen (`pantheon/src/ledger/review-cycle.mjs:68-70`). `reviewCycle` throws `UNRESOLVED_CONTRIBUTOR` before the cycle opens (`review-cycle.mjs:157-158`).

`reviewScope` does label a row with `labOf`, which for an unknown model is the vendor string (`pantheon/src/review/scope.mjs:65`, `pantheon/src/config/models.mjs:60-62`). That label is display. `contributorKeys` does not treat it as an identity. A contribution that names a lab and no model excludes the lab (`identity.mjs:124`). It does not admit the unresolved name.

## 3. Answer admission

**does not hold** for the board in-run checker. **holds** for resolver 2 and 3, `judgingTurn`, the validator, and the cycle ledger.

Resolver 2 and 3: a missing or blank served model is `NO_SERVED_IDENTITY` (`identity.mjs:165-166`). `reviewerRefusal` returns that reason. `judgingTurn` refuses `NO_SERVED_MODEL` and does not retry into an admitted verdict (`pantheon/src/pipeline/util.mjs:84-88`). The validator's `servedRefusal` uses `reviewerRefusal` under the model rule, and under the lab rule it also refuses a blank served model (`ophanim/operate/stages.mjs:1242-1246`). A cycle whose three answers name no served model records three failures and `closeCycle` throws `0 of 3 reviews are recorded`.

The hole is `runOpenItem`. The first critique answer is checked (`pantheon/src/board/run-item.mjs:1423-1431`). If that reply has no `VERDICT` line, a second `turn()` is concatenated into `reviewText` and the verdict is parsed from the second reply (`run-item.mjs:1459-1468`). That second call is not passed through `reviewerRefusal`. `recordReview` cites `critiqueTurn`, the turn of the first prompt, and copies that turn's `served_model` (`run-item.mjs:1476-1481`). The ledger then checks the review against the cited turn (`pantheon/src/ledger/lineage-kinds.mjs:128`, `lineage-kinds.mjs:66-68`). A second call with no served model, or a different model, can supply `VERDICT: approve`, and the review verifies under the first turn's identity.

Stage 5 of the unit pipeline does not have this re-ask. It goes through `judgingTurn`. The fit plan path requires work units (`stages.mjs:406`, `stages.mjs:605`) and implements them in the pipeline (`stages.mjs:751`), so a fit live run's Stage 5 does not hit `run-item.mjs`. The board path is what a lifecycle implement uses when the plan has no work units (`stages.mjs:782-786`), and it passes `independence: 'model'` when the model rule is on.

Reproduction: `.review-tests/independence-a2.test.mjs`, test `Q3 the in-run re-ask…`. It asserts the source sequence above, then records a review that cites the first turn (`served_model: grok-4.7`) while a second turn on the same seat has `served_model: null` and reply `VERDICT: approve`. `verify().ok` is true. This does not execute `runOpenItem`. It shows the ledger accepts the recording the re-ask would write.

## 4. History

**holds.** Cycles recorded under resolvers 1 and 2, and under contracts v1 and v2, still verify under the rules stored on them.

The recorded `identity_policy.rules` is what `reviewerIdentity` applies (`identity.mjs:159`). Resolver 1, with no served model, counts the model that was asked (`identity.mjs:167`). Resolver 2 still returns `NO_SERVED_IDENTITY` for a missing served model. A policy below resolver 3 must have `route_labs === undefined` (`identity.mjs:86`). v3-only fields are refused on any other contract (`pantheon/src/ledger/cycle-kinds.mjs:274-275`). A non-v3 close still uses author labs (`cycle-kinds.mjs:226-231`).

A fresh cycle opened under resolver 1 with null served models closed `verified`, and its payload still says resolver 1 with no `route_labs`. A resolver 2 cycle closed `verified`, and reading its recorded rules still refuses a null served model. A v2 cycle and a v1 cycle of one reviewer, shaped as cycles written before `required_reviewers` existed, both close `verified` and the ledger verifies. The current resolver does not reopen those verdicts.

## 5. Quorum

**does not hold** for every path. The product entry points that a fit live run uses do keep three labs and do not seat a contributor. The validator does not fall back to a contributor.

`reviewCycle` sets `required_reviewers` to at least 3 when the caller omits it, and refuses fewer seats with `REVIEW_LABS_BELOW_REQUIRED` (`review-cycle.mjs:163-180`). `makeExecutors` refuses `n` below 3 (`stages.mjs:76`, `stages.mjs:392`). A v3 close checks each answer with `independenceRefusal` (`cycle-kinds.mjs:226-227`). An asked model served by a contributing sibling fails that seat. `closeClaim` refuses a shared lab, and refuses fewer than three labs when `required_reviewers` is present (`cycle-kinds.mjs:221-225`).

The validator asks `reviewSeatsByModel({n: 1})` and, on `NO_SEATS` only, returns pending `REVIEW_CAPACITY_PENDING` (`stages.mjs:1231-1251`). There is no `reviewSeats({n: 1, avoidLabs: []})` fallback. When every declared reviewer identity is a contributor, `n: 1` throws `NO_SEATS`.

Two paths still close short:

- `openCycle` does not default `required_reviewers` (`cycle-kinds.mjs:429-435`). A new v2 cycle opened with `reviewers: 1` and the field omitted closes `verified` with one lab. `closeClaim` applies the floor only when the field is present (`cycle-kinds.mjs:223`). Production callers of `openCycle` are `reviewCycle` and tests. `reviewCycle` now sets the field. The recorder itself still accepts the short cycle.
- The in-run panel size is `REVIEW_LABS`: low 1, normal 1, high 2, critical 3 (`pantheon/src/route/task-profile.mjs:42`). A normal-stakes board review can approve with one lab. Stage 5 of one unit is a single pinned model by the owner's decision. That pin is not a three-lab failure.

## 6. Lineage completeness

**does not hold.** Approved checkpoints and plan revisions carry their authors. The fit implement projection then drops a distinct requested identity before the later panel and the validator see it. The board critique row stores the asked model and not the model that answered.

`contributionsOf` keeps plan, written attempts, answered subagent calls, and reviews with `fed_revision`, and its own key includes `model` and `served_model` (`pantheon/src/pipeline/record.mjs:22-23`, `record.mjs:38-51`). An approved checkpoint writes those rows (`pantheon/src/pipeline/index.mjs:441-442`) and resume copies them back (`index.mjs:485-487`). A resumed unit's checkpoint rows reappear from `contributionsOf`, including a `fed_revision` critique, and an approve-only review does not. A plan revision copies the previous contributions and the findings that have a lab (`stages.mjs:489-493`, `stages.mjs:746-748`).

The drop is `dedupe` (`stages.mjs:296`):

`purpose|vendor|model|lab`

It does not include `requested_model`. The fit implement stage builds each row as `model = served_model ?? model`, and sets `requested_model` only when those two strings differ (`stages.mjs:989-992`), then `dedupe`s them with the earlier contributions (`stages.mjs:998`). Two answered calls that share a purpose, vendor, served model, and lab collapse, and the last row wins. A call asked as `grok-4.6` and served as `grok-4.7`, followed by a call asked and served as `grok-4.7`, leaves only `xai/grok-4.7` in the projection. `candidateRefusal` of `grok-4.6` is null on that projection and matches "contributed" on `contributionsOf`'s own list. `grok-4.6` and `grok-4.7` are different identities. The same collapse of `gemini-4-hydrogen-medium` into `gemini-4-hydrogen` is the same id, so that one is not a bypass. The three-lab panel and the validator read `impl.outputs.contributions` (`stages.mjs:1230`).

The board in-run critique row stores `{vendor, model}` of the asked seat (`run-item.mjs:1214-1218`, `run-item.mjs:1512`). `reviewScope` keeps `requested_model` only when the served string differs (`scope.mjs:65-66`). A critique recorded as asked `grok-4.7` excludes `xai/grok-4.7` and leaves `grok-4.6` eligible. Overlaps assignment 1 (what a resume restores) and assignment 3 (checkpoint seal). The identity consequence is here.

An answered subagent call stores `served_model: null` when the turn names none (`pantheon/src/pipeline/a2a-shim.mjs:131`). `contributorKeys` then resolves the asked name and does not mark the contribution unresolved (`identity.mjs:123-127`). An unnamed answerer is not blocked. Reviewer admission is stricter.

An interrupted, unapproved pipeline copies finding text onto the next stage result (`stages.mjs:938-949`, `stages.mjs:1015-1017`) and removes orphan worktrees (`stages.mjs:933`). It does not merge that run's authors into the new attempt's contributions. Those bytes are discarded. Approved units resume from checkpoints, which do carry authors.

Reproduction: `.review-tests/independence-a2.test.mjs`, tests `Q6 dedupe drops…` and `Q6 an in-run critique row…`.

## 7. Arbiter confinement

**does not hold** for where the exception applies. The influence channel through free text does hold.

There is no allow-list that exempts the dispatcher only at Stage 5 of that unit. `contributionsOf` omits the dispatcher (`record.mjs:3-10`, `record.mjs:55-62`). `arbitersOf` keeps the same turn with `authored: false`. The comment at `stages.mjs:870-881` states the owner's decision: the dispatcher is not a contributor, so the pinned Stage 5 reviewer of that unit can be the same model, and a reviewer whose finding was fed is excluded from the later panel and the validator. The mechanism is wider than the pin. Anything that excludes contributors — `reviewSeatsByModel` for the three-lab panel, and the validator's `allContribs` (`stages.mjs:1230`) — also leaves the dispatcher eligible.

On the default tables, with a fit contribution set (Anthropic planner, Google implementer, xAI subagent, dispatcher omitted), the OpenAI seat is `gpt-6-sol` from the planner table (`pantheon/src/role/seating.mjs:220`), not `gpt-6-astra` (`seating.mjs:255`). `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6-luna` all have `candidateRefusal === null`. After `gpt-6-sol` has also contributed, the three-lab walk reaches `gpt-6-astra`. A seating whose first eligible model of an untouched lab is `gpt-6-astra` returns that model as the `n: 1` validator, with `shared_lab: false`. The fit dispatchers are seated when they are the first eligible model of an eligible lab. Today's default tables do not put `gpt-6-astra` on a standard fit panel ahead of `gpt-6-sol`.

Inside the unit, the pin holds. The frozen unit copies `specialist_role` and `difficulty` (`index.mjs:309`). `reviewerLadderRefusal` requires rung 0 to be the dispatcher seat and every rung to stay on that vendor (`pantheon/src/pipeline/review.mjs:158-166`). A `fed_revision` reviewer is then a critique contributor and is excluded later. That exclusion is of the model.

`rubricHash` covers `unit_id`, `owned_paths`, `verify_cmd`, `invariants`, `rubric`, `specialist_role`, and `difficulty` (`pantheon/src/pipeline/dispatch.mjs:94-95`). Stage 5 re-hashes before any reviewer call (`review.mjs:124-126`). The implementer prompt includes the role, the difficulty, and the frozen rubric lines (`pantheon/src/pipeline/implement.mjs:63-75`) and does not include dispatcher `notes`. `notes` is stored on the dispatch record and is used in the not-cohesive return (`dispatch.mjs:114-117`). `specialist_role` must be a short hyphenated name (`pantheon/src/pipeline/work-units.mjs:36-42`). Difficulty may be raised and may not be lowered (`dispatch.mjs:86`). The dispatcher cannot change `owned_paths` or `verify_cmd`. Role and difficulty reach the implementer and are inside the hash.

Reproduction: `.review-tests/independence-a2.test.mjs`, both `Q7` tests.

## 8. Critique contributors

**holds** on the pipeline path. A reviewer whose finding was fed to a revision is a contributor and is excluded later. A reviewer that only approved stays eligible.

`contributionsOf` includes a review only when `fed_revision` is set (`record.mjs:46`). That flag is set only when `review.status === 'request_changes'` and escalation did not block (`index.mjs:402-406`). An approval does not set it. `approve_refused` is the controller voiding an approval against `verify_cmd` (`review.mjs:146-148`). That feedback is ground truth, and the reviewer is not a critique contributor. If revisions are spent, escalation blocks before `fed_revision` is set, so a finding that reached no revision does not become a contribution.

A scope row with `revision_input !== true` is excluded, with the reason that it reached no revision prompt (`scope.mjs:50-62`). The later panel and the validator consume the rows the implement stage recorded (`stages.mjs:880-881`, `stages.mjs:989-998`, `stages.mjs:1223-1230`).

The board path's loss of the served model is question 6. The approve-only case there matches this rule: only panel members with findings are stored (`run-item.mjs:1512`).

Reproduction: `.review-tests/independence-a2.test.mjs`, test `Q8 a reviewer whose finding is fed…`. `gpt-6-luna` with `fed_revision` is excluded. `gpt-6.1-sol` with an approval is not.

## 9. The input-model marker

**does not hold.** A substituted name can be stored as a provider statement, and an undeclared name can reach the board Antigravity path. A known non-Google model cannot, by pin, escalation, or the lifecycle single-turn helper.

`pipelineTurns`' `single()` sets `served_model_source` to `"provider"` whenever the turn names a served model and omits the source (`pantheon/src/pipeline/turns.mjs:176`). `recordTurn` omits the field when it is absent, and the comment says absence means the provider named it (`lineage-kinds.mjs:184-186`). `reviewerIdentity` does not read `served_model_source` (`identity.mjs:159-171`). A name that was substituted and arrived without the marker is stored, and later admitted, as who answered. A turn that does pass `served_model_source: 'input'` keeps `input`. The fit implementer lane sets the marker itself (`turns.mjs:214`) and does not go through that default. The dispatcher, reviewer, and subagent do go through `single()`. For a real API seat, `"provider"` is the right label only when the transport actually returned the provider's name.

`agySingleTurn` refuses an unknown model and a known non-Google model before any CLI check (`pantheon/src/sdk/agy-turn.mjs:27-31`) and, for a Gemini lane, returns the input model marked `input` (`agy-turn.mjs:38`). The board guard is weaker: it throws only when the name is known and the lab is not Google (`run-item.mjs:597-598`). An undeclared name is not refused. The same function then stamps `served_model: model, served_model_source: 'input'` (`run-item.mjs:613-621`). `agyTurn` has no model check of its own (`run-item.mjs:499-575`). Scout and reviewer default to the SDK transport, which passes `--model` through (`run-item.mjs:513`, `run-item.mjs:539-547`). Planner, implementer, and a declared `agy-cli` lane use the CLI, which compares the model the CLI reports at start (`pantheon/src/board/agy-cli.mjs:632-634`, `agy-cli.mjs:642`). That comparison runs only after the CLI has been started.

Pin and escalation of a known non-Google model stay off Antigravity. `resolvePinned('gpt-6-astra')` is `{vendor: 'openai', model: 'gpt-6-astra'}` and `seatTransport` is `api` (`pantheon/src/route/frontier.mjs:56-68`). `gemini-4-carbon-high` on `agy_google` is `agy-cli`. `resolvePinned('claude-sonnet-4-6')` throws as a retired lane. `pinnedReviewer` of `gpt-6-astra` returns that OpenAI seat (`pantheon/src/route/fit-matrix.mjs:68-71`). `reviewerEscalation` of `gpt-6-luna` stays on `openai` (`fit-matrix.mjs:74-78`). `implementerEscalation` of `gemini-4-hydrogen-medium` stays on `agy_google` (`fit-matrix.mjs:130-134`).

Reproduction: `.review-tests/independence-a2.test.mjs`, test `Q9 a missing marker…`. `agySingleTurn` is called only with `not-a-declared-model` and `gpt-6-astra`, both of which throw `AGY_GEMINI_ONLY` before the CLI exists-check. No Google model is passed, and no CLI or SDK is started.

## 10. Reassessment

**holds.** A later identity correction disqualifies affected reviews as new evidence and does not rewrite the cycle ledger.

`reassess` returns findings. It writes nothing (`identity.mjs:188-198`). `recordReassessment` appends `work.reassessment` only (`ophanim/operate/work-ledger.mjs:397-399`). `append` stamps the work schema (`work-ledger.mjs:349`). Validate requires a different policy digest and findings of `{review, why}` (`work-ledger.mjs:144-152`). Gates treat a disqualified cycle as not reusable: active work is not reused, and a Resolved item becomes `reverification-needed` without a status rewrite (`ophanim/operate/gates.mjs:97-127`). Checks of the cycle still use the policy stored on it.

Reproduction: `.review-tests/independence-a2.test.mjs`, test `Q10…`. A v3 cycle whose contributor is `claude-fable-5-2`, reviewed by `grok-4.7`, `gpt-6-sol`, and `claude-sonnet-5`, closes `verified`. A shallow copy of the current policy that maps `claude-sonnet-5` to `claude-fable-5-2` (same lab, so the route rule does not fire) yields a finding whose reason matches "contributed". `recordReassessment` on a separate work root verifies. The cycle `chain.jsonl` bytes are unchanged, the cycle still verifies, the close is still present, the recorded policy still admits `claude-sonnet-5`, and `policyDigest` of the recorded rules still matches the stored digest.

## Blockers for a live run

1. **Question 6, on the fit implement path.** `dedupe` at `ophanim/operate/stages.mjs:296` drops a distinct `requested_model` when a later row shares purpose, vendor, served model, and lab. The three-lab review and the validator read that list (`stages.mjs:998`, `stages.mjs:1230`). A model that was asked, and that is not the same identity as the model that served, can sit on a later panel. Fix the projection so every requested identity `contributionsOf` kept is still excluded. I would not start a live fit run until that is fixed.

2. **Question 7, the post-pipeline panel and the validator.** The Stage 5 pin matches the owner's decision that the dispatcher is not a contributor of that unit. The omission from `contributionsOf` is global, so the same model can be a three-lab reviewer or the validator whenever it is the first eligible model of an eligible lab. Default tables seat `gpt-6-sol` ahead of the fit dispatchers. The rubric author can still be the validator of the work the rubric shaped. Confine the exception to Stage 5 of that unit, or record an explicit owner acceptance of the wider omission. I would block a live run on the current width. The owner can dismiss this one. It is a scope decision, and this reviewer does not benefit from it.

3. **Question 9, the board Antigravity transport.** `run-item.mjs:597-598` lets an undeclared name through and stamps it as the serving model (`run-item.mjs:615-621`). `agySingleTurn` refuses that name. The fit unit pipeline's declared lanes do not use this guard. Do not run a board Antigravity seat (scout, reviewer, or a fit plan that fell through to `runOpenItem`) until the board guard matches `agySingleTurn`: unknown or non-Google refuses before `agyTurn`. Also stop `pipelineTurns` `single()` from labeling a missing marker `"provider"` when the caller substituted the name (`turns.mjs:176`).

4. **Question 3, board in-run review under the model rule.** The re-ask at `run-item.mjs:1459-1481` can admit a verdict from a turn whose served model was never checked, recorded under the first turn. Stage 5 of the fit unit pipeline uses `judgingTurn` and does not do this. Block any live run whose in-run review is `runOpenItem` with `independence: 'model'` (`stages.mjs:782-786`) until the re-ask is admitted with `reviewerRefusal` on that call's served model.

Not blockers by themselves. The raw `openCycle` of a new one-lab v2 cycle (question 5): `reviewCycle` and `makeExecutors` refuse it, and a live fit run uses those. Historical v1 one-reviewer cycles verifying (question 4): that is the recorded rule. Stage 5's single pinned reviewer: the owner's pin. In-run stakes of one lab for low and normal (`task-profile.mjs:42`): the dial this tree ships, separate from the coordinated three-lab floor. Synthetic labs are not production capacity.

## Model

Grok 4.7 (xAI). Commit `77480d6b262c92ceca5a159cc5be3e3ee627b922`.