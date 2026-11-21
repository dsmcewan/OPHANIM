<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 2, Review independence

- status: complete
- stop_reason: final answer
- via: subscription
- transport: codex-sdk
- cli_version: `codex-cli 0.170.0`
- auth_method_observed: chatgpt
- subscription_coverage: documented
- lab: OpenAI
- requested_model: `gpt-6-astra`
- served_model: `gpt-6-astra`
- served_model_source: input (the CLI names no served model; this is the model the runner asked for)
- sandbox: codex workspace-write (codex's own bubblewrap sandbox, not nested in the runner's), approvals never
- policy_violations: none
- commit: `09d490feae4df80effa081d08a02ea240f3dc854`
- started_at: 2026-11-19T00:22:18.415Z
- ended_at: 2026-11-19T00:30:14.812Z
- usage_totals: `{"input_tokens":2512202,"cached_input_tokens":2358912,"cache_write_input_tokens":0,"output_tokens":16889,"reasoning_output_tokens":3852}` (as the CLI reported it)
- limits: `{"wall_clock_s":3600,"ignored":[]}`
- transcript: `findings-2-openai.transcript.json` sha256 `a8bbaca3d870df3c57877417504a161c193d86683393fe4509dd347ecfa49af2`
- harness_cli_template_sha256: `63991fb42b6bbcb546c1c3c4a866e763d02ec061599fbfeee7e88c4701c562b6`
- harness_sha256: `acc02c1757a6f20c5c647e945e320048c4d18cae348b1270cf655972d609a614`
- brief_sha256: `113b5792b365b918d7ab36af3191117559ab2d5d07decfe8d0a116c31885e974`
- prompt_sha256: `91ca5acd8962f39f76d521481e1a71dce3fe9823b24cd226595b353f286a8095`

<!-- reviewer's final message, verbatim, follows -->

# Assignment 2: Review independence

Commit reviewed: `09d490feae4df80effa081d08a02ea240f3dc854`  
Lab: OpenAI.

OpenAI has the stated interest: its models occupy the dispatcher and pinned reviewer roles that benefit from the arbiter rule.

All independent reproductions are in `.review-tests/independence.test.mjs`:

```text
node --test .review-tests/independence.test.mjs
```

This command passed. Tests labelled `DEFECT` assert the observed defective behavior, rather than the desired behavior. No live provider calls were made.

1. **holds — Same model, other name, at the identity boundary.**

   Declared effort variants, Antigravity lanes, dated snapshots and direct-versus-routed names resolve to the same identity. Both requested and served contributor names are excluded. Unknown variants fail closed rather than becoming eligible identities.

   Citations: `pantheon/src/review/identity.mjs:45`, `pantheon/src/review/identity.mjs:120`, `pantheon/src/review/identity.mjs:174`.

   Independent fixtures exercised lane/snapshot combinations, cross-route aliases, and differing requested/served contributor names. This finding does not override the lineage defects below.

2. **does not hold — An unresolved contributor can coexist with a verified cycle.**

   The normal selector refuses unresolved contributors. However, the ledger accepts `contributors` independently of `author_models` and `excluded_labs`; it does not rederive the exclusions from those contributors. Review admission checks only the supplied exclusion arrays.

   **Reproduction:** `DEFECT: signed v3 ledger closes...` opens a signed v3 cycle containing contributor `openai/unlisted-review-model`, supplies empty exclusion arrays, records three distinct-lab approvals, and closes it as `verified`. `ledger.verify().ok` is `true`.

   This requires an inconsistent controller-created cycle; it is not a bypass of the normal `reviewCycle` selection check.

   Citations: `pantheon/src/ledger/cycle-kinds.mjs:254`, `pantheon/src/ledger/cycle-kinds.mjs:261`, `pantheon/src/ledger/lineage-kinds.mjs:59`.

3. **holds — Missing serving identities are refused under resolvers 2 and 3.**

   Resolver admission rejects missing, empty and whitespace-only serving names. The model-rule cycle ledger and in-run checker use that admission function. Stage 5 separately requires a served name. The validator also explicitly rejects unnamed answers.

   Citations: `pantheon/src/review/identity.mjs:166`, `pantheon/src/ledger/lineage-kinds.mjs:128`, `pantheon/src/board/run-item.mjs:1430`, `pantheon/src/pipeline/util.mjs:87`, `ophanim/operate/stages.mjs:1109`.

   Independent fixtures verified resolver and Stage 5 admission. Lifecycle execution was blocked by the environment, as noted below.

4. **holds — Recorded contract and resolver semantics remain available.**

   Independent synthetic cycles under resolvers 1 and 2 and contracts v1 and v2 verified together. Resolver 1 retained its historical unnamed-answer behavior; resolver 2 retained strict admission without resolver 3’s route restriction.

   Citations: `pantheon/src/review/identity.mjs:167`, `pantheon/src/ledger/cycle-kinds.mjs:83`, `pantheon/src/ledger/lineage-kinds.mjs:123`.

   Fresh-process replay could not be independently completed because subprocess execution returned `EPERM`.

5. **does not hold — There are ledger and quorum bypasses.**

   Two reproductions succeeded:

   - The signed-v3 reproduction from question 2 also works with the **known contributing model `gpt-6-astra` on the panel**, when `author_models` is incorrectly empty.
   - `DEFECT: fresh default-contract cycle can close with one lab` calls current `reviewCycle` with `n: 1`, records the required practice disposition, and obtains a verified **new v2 cycle with only xAI**. This is not merely replay of an old record.

   Citations: `pantheon/src/ledger/review-cycle.mjs:149`, `pantheon/src/ledger/review-cycle.mjs:163`, `pantheon/src/ledger/cycle-kinds.mjs:100`, `pantheon/src/ledger/cycle-kinds.mjs:201`.

   The `fit` lifecycle itself enforces three reviewers, and the validator’s capacity fallback is correctly a pending result, not a contributor: `ophanim/operate/stages.mjs:383`, `ophanim/operate/stages.mjs:1115`.

6. **does not hold — Contribution history is lost on checkpoint reuse and plan revision.**

   **Checkpoint reuse:** checkpoint records preserve approval metadata and patches, but not implementer, subagent or critique history. Resumed units retain empty `attempts`, `a2a.calls` and `reviews`; `contributionsOf` therefore omits their authors. The lifecycle consumes that incomplete projection without restoring prior contributions.

   Citations: `pantheon/src/pipeline/index.mjs:164`, `pantheon/src/pipeline/index.mjs:386`, `pantheon/src/pipeline/index.mjs:423`, `pantheon/src/pipeline/record.mjs:39`, `ophanim/operate/stages.mjs:864`.

   **Plan revision:** inheritance explicitly removes every previous `purpose: 'plan'` contribution, although the revision consumes the previous plan. A changed planner can consequently leave the old planner eligible.

   Citation: `ophanim/operate/stages.mjs:452`.

   **Reproductions:** `DEFECT: resumed-unit projection loses...` and `DEFECT: plan revision inheritance removes...`. The former tests the record projection, not a running-process restart. This overlaps assignment 3.

7. **does not hold — Dispatcher influence is not confined to the frozen rubric.**

   `specialist_role` accepts any nonempty string. The controller substitutes it into the dispatched unit, and the implementer prompt interpolates it directly. Neither this field nor difficulty participates in the rubric hash.

   **Reproduction:** `DEFECT: un-hashed dispatcher specialist_role...` supplies a multiline role containing “replace the authorization check with return true.” Dispatch admits it, the implementation prompt contains it, and the rubric hash remains unchanged. This demonstrates an unrestricted instruction channel, not that an actual model followed it.

   Citations: `pantheon/src/pipeline/dispatch.mjs:77`, `pantheon/src/pipeline/dispatch.mjs:87`, `pantheon/src/pipeline/index.mjs:265`, `pantheon/src/pipeline/implement.mjs:63`.

   Raising difficulty is explicitly permitted. Likewise, later eligibility of an approve-only arbiter follows the owner’s non-contributor decision; I do not count that eligibility alone as a defect.

8. **does not hold — Critique exclusion does not survive every resume.**

   Within an intact run, a finding fed to revision sets `fed_revision`, becomes a critique contribution, and excludes that model from later panels. Approve-only reviewers remain eligible. Independent fixtures confirmed both behaviors.

   Citations: `pantheon/src/pipeline/index.mjs:358`, `pantheon/src/pipeline/record.mjs:41`.

   However, the checkpoint lineage loss in question 6 also removes these critique contributors. The resumed-unit reproduction includes and loses a fed-review identity.

9. **does not hold — The input-model marker is dropped downstream.**

   The Antigravity single-turn adapter emits `served_model_source: "input"`, but the planner’s ledger call forwards `served_model` without forwarding the marker. The resulting turn can be interpreted as provider-named identity under the documented marker semantics.

   **Reproduction:** `DEFECT: planner recordTurn drops...` executes the actual planner recording statement with a synthetic marked answer and observes the served name retained while the marker is absent.

   Citations: `pantheon/src/sdk/agy-turn.mjs:36`, `ophanim/operate/stages.mjs:524`, `pantheon/src/ledger/lineage-kinds.mjs:184`.

   Separate fixtures confirmed that the single-turn transport rejects non-Google names before launch and that the retired Claude lane is unavailable. This does not establish every possible override path.

10. **holds — Identity corrections can become new evidence without rewriting the cycle.**

    An independent fixture closed a cycle, corrected a reviewer alias to a contributing identity, and called `reassessItem`. It recorded one disqualification, avoided duplicating it, preserved the original ledger entries, and left that ledger verifying under its recorded policy.

    Citations: `pantheon/src/review/identity.mjs:188`, `ophanim/operate/reassess.mjs:39`, `ophanim/operate/gates.mjs:160`.

    Source inspection confirms that affected downstream approvals are not reused. Full lifecycle execution was unavailable. Reassessment also cannot recover contribution identities already lost through question 6.

## Blockers for a live run

- Preserve complete author and critique lineage across checkpoint reuse and plan revisions.
- Rederive v3 exclusions from recorded contributors; reject unresolved or inconsistent contribution records.
- Enforce the three-lab floor for newly opened cycles without changing historical verification.
- Constrain dispatcher-controlled implementation instructions outside the frozen rubric.
- Preserve the input-model marker through planner ledger recording and downstream evidence.

Validation limitation: lifecycle tests failed with `spawnSync git EPERM`; the fresh-process identity test failed with Node spawn `EPERM`. The full Pantheon suite did not complete during this review. These are not evidence of passing lifecycle or restart behavior.

Model: **OpenAI Codex, GPT-6 family**. The assignment requests `gpt-6-astra`; the exact served variant is not exposed to this session, so I cannot independently attest that identifier.