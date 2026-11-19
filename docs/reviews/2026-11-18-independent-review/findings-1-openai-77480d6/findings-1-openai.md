<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 1, Lifecycle and evidence

- status: complete
- stop_reason: final answer
- via: subscription
- transport: codex-sdk
- cli_version: `codex-cli 0.170.0`
- auth_method_observed: chatgpt
- subscription_coverage: documented
- lab: OpenAI
- requested_model: `gpt-6.1-sol`
- default_reviewer: Google, `gemini-4-carbon` (the README's reviewer for this assignment)
- reviewer_override: true (--reviewer openai:gpt-6.1-sol)
- served_model: `gpt-6.1-sol`
- served_model_source: input (the CLI names no served model; this is the model the runner asked for)
- sandbox: codex permission profile ophanim-review (codex's own bubblewrap sandbox, not nested in the runner's: reads the worktree and the runtime only; writes .review-tests/ and a scratch TMPDIR outside the worktree; network cut by codex's proxy), approvals never
- policy_violations: none
- commit: `77480d6b262c92ceca5a159cc5be3e3ee627b922`
- started_at: 2026-11-19T03:12:49.663Z
- ended_at: 2026-11-19T03:16:16.162Z
- usage_totals: `{"input_tokens":1287165,"cached_input_tokens":1176832,"cache_write_input_tokens":0,"output_tokens":7282,"reasoning_output_tokens":1633}` (as the CLI reported it)
- limits: `{"wall_clock_s":3600,"ignored":[]}`
- transcript: `findings-1-openai.transcript.json` sha256 `87e4b49cd6311a525dffc4fbc63ae51fbd14fa05ee856c71fecd7dd8a47922d8`
- harness_cli_template_sha256: `69402fb55cdb7246281546ce42d82ea28d3c5dbe68f646c64cd93e55d172ac36`
- harness_sha256: `03c8ae7217502e1b2a3d518ce51d7d411cff6f8f981f1a4e9a3b6015e9315986`
- brief_sha256: `9b76307457d9614e8a4302ece5006c86039fce1d27a41f347c3776b0e5b5adcd`
- prompt_sha256: `72682d7fd4336e3101adefa701a059a56d6259aa4785d562db3894ca89f5b202`

<!-- reviewer's final message, verbatim, follows -->

# Assignment 1: Lifecycle and evidence

Lab: OpenAI  
Model: GPT-6 (Codex); the exact serving-model identifier is not exposed in this session.  
Commit reviewed: `77480d6b262c92ceca5a159cc5be3e3ee627b922` (harness pin). Git could not independently confirm HEAD because the worktree’s referenced git directory was inaccessible.

Independent reproductions:

```bash
env NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 node --test .review-tests/lifecycle-independent.test.mjs
```

All five tests passed. Three assert the observed defective behavior described below; one checks reassessment routing; one diagnoses the sandbox limitation. The existing scheduler, planner-tier and context-bounds suites also passed: 20 tests, zero failures.

1. **Earliest gate — does not hold.** Initial routing distinguishes unticketed planning, ticket revalidation and Resolved evidence gaps (`ophanim/operate/gates.mjs:112`, `ophanim/operate/gates.mjs:190`). However, downstream execution remains eligible after cited derived evidence changes.

   **Reproduction:** the independent test “a cited derived relations view changes but its approved plan remains reusable” approves a plan citing `status:target#relations`, then adds a dependent item. The relations view’s digest changes, but reconciliation still selects `implement`; expected: `plan`. `versionOf` excludes dossier views, and plan validity ignores an undefined current version (`ophanim/operate/context.mjs:252`, `ophanim/operate/gates.mjs:62`).

2. **Handoffs — holds.** The receiver checks item identity, stage order, passed status, requirement identity and every upstream output digest back to the plan (`ophanim/operate/work-ledger.mjs:285`). Scheduler verification precedes dispatch (`ophanim/operate/scheduler.mjs:75`); ledger append independently rederives the handoff (`ophanim/operate/work-ledger.mjs:258`). Existing malformed-handoff and cross-item regression tests passed.

3. **Plan — holds.** Under `fit`, missing or invalid `work_units` are refused during plan validation (`ophanim/operate/stages.mjs:198`, `ophanim/operate/stages.mjs:605`). Findings requiring changes lead to another plan version and review cycle; finders enter the contribution list (`ophanim/operate/stages.mjs:716`, `ophanim/operate/stages.mjs:720`). Insufficient review capacity produces a pending result rather than approval.

4. **Planner seat — holds.** Selection uses the ticket’s declared difficulty and task profile, including stakes. Unticketed items select medium and record `no ticket: medium` (`ophanim/operate/stages.mjs:479`). The existing test covering easy, medium, hard, critical stakes and unticketed items passed.

5. **Evidence freshness — does not hold.** File citations retain delivered versions (`ophanim/operate/stages.mjs:613`), but two non-file cases fail:

   - **Derived dossier evidence is never freshness-checked.** The relations reproduction in question 1 demonstrates changed cited bytes leaving the plan reusable (`ophanim/operate/context.mjs:252`).
   - **Issue title/state changes retain the old version.** The delivered issue text includes title and state, while its version hashes only the body (`ophanim/operate/context.mjs:193`). The independent test “issue title/state changes alter shown bytes without altering their version” changes both fields and observes different delivered text with an identical version.

   Automatic re-search also has a trigger gap: `inputSignature` omits ordinary evidence files and retained-run contents (`ophanim/operate/scheduler.mjs:83`). The independent test “watch never wakes an evidence-blocked plan when only the missing evidence appears” creates the missing file. Explicit reconciliation selects `plan`, but the next watch check runs zero ticks (`ophanim/operate/scheduler.mjs:295`). The service uses this watch mechanism (`ophanim/operate/service.mjs:139`).

6. **Evidence bounds — holds.** Retrieval checks resolved-path containment, applies byte windows and continuations, and enforces investigation limits before delivery (`ophanim/operate/context.mjs:52`, `ophanim/operate/context.mjs:217`, `ophanim/operate/context.mjs:508`). Delivery completeness is computed from ranges within one view/version (`ophanim/operate/context.mjs:436`). All eight existing context-bounds tests passed, including partial histories, oversized lines, budgets and containment.

7. **Scheduling — holds.** The item selector records other runnable items as skipped and dispatches only the selected item (`ophanim/operate/scheduler.mjs:264`). Intake deduplicates by source and reference (`ophanim/operate/scheduler.mjs:114`). Existing selector and intake tests passed. The watch-trigger defect is reported under question 5.

8. **Recovery — cannot tell end to end.** Source inspection supports unsigned proposals and no status-ledger writes: recovery writes a proposal file, while scheduling records the search on the work ledger and suppresses repeat searches for the same status/source digest (`ophanim/operate/evidence-recovery.mjs:137`, `ophanim/operate/evidence-recovery.mjs:154`, `ophanim/operate/scheduler.mjs:135`). Successful recovery/application tests could not reach their assertions because implementation isolation failed in this environment.

9. **Reassessment — holds for gate routing.** Disqualified reviews stop the reusable chain before validation and outcome; Resolved items receive `reverification-needed` (`ophanim/operate/gates.mjs:196`, `ophanim/operate/gates.mjs:121`). The independent deterministic test confirms both behaviors. End-to-end re-review remains **cannot tell** here because nested isolation prevents implementation.

10. **Outcome — cannot tell end to end.** The outcome executor invokes the same structural evidence checker used by status `apply`, blocking and renaming a refused proposal (`ophanim/operate/stages.mjs:1365`, `packages/ledger/status.mjs:404`). The existing outcome/application fixtures could not reach this stage in this environment.

## Blockers for a live run

- Recompute cited dossier-view versions before reusing plans.
- Include delivered issue title/state in evidence versioning.
- Wake reconciliation when evidence files or recovery sources change.

Before approval, rerun recovery, re-review and outcome/application tests where nested bwrap works. Here the diagnostic reported `Failed to create NETLINK_ROUTE socket: Operation not permitted`; this is an environment limit, not a demonstrated product defect.

Model: GPT-6 (Codex), OpenAI; exact serving-model identifier unavailable.