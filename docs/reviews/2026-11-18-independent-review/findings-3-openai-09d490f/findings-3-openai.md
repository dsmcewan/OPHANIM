<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 3, Execution reliability

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
- started_at: 2026-11-19T01:37:29.346Z
- ended_at: 2026-11-19T01:45:35.434Z
- usage_totals: `{"input_tokens":3109790,"cached_input_tokens":2984064,"cache_write_input_tokens":0,"output_tokens":19185,"reasoning_output_tokens":4693}` (as the CLI reported it)
- limits: `{"wall_clock_s":3600,"ignored":[]}`
- transcript: `findings-3-openai.transcript.json` sha256 `21aa6164434f35e9d235b5b0f6120dcdf9ebf786cd6937e8745e72a5d6c3b002`
- harness_cli_template_sha256: `63991fb42b6bbcb546c1c3c4a866e763d02ec061599fbfeee7e88c4701c562b6`
- harness_sha256: `1a6bcae9f63ffa9a3e358ee9c5e26d0153cff186057fcdd7dd167d158bb56ada`
- brief_sha256: `8ad7e9d1a429be0193303230ad438be288e853aed95213e249664325153c03e9`
- prompt_sha256: `6df0cab90bf7302131b14d44ce9e89aba8588f28cdcf2e5684e7e1bdab92e1ba`

<!-- reviewer's final message, verbatim, follows -->

# Assignment 3: Execution reliability

Commit reviewed: `09d490feae4df80effa081d08a02ea240f3dc854`

Independent fixtures reproduced five failures. The supporting checks in `.review-tests/positive.test.mjs` passed. No live providers were called.

1. **Call budgets — does not hold.**

   Two defects bypass accounting:

   - **Concurrent schedulers can exceed the shared total.** Budget checking and claim creation are separate operations (`ophanim/operate/scheduler.mjs:157`, `ophanim/operate/scheduler.mjs:168`). Claims enforce item exclusivity but not aggregate budget reservations (`ophanim/operate/work-ledger.mjs:137`). Two isolated processes, synchronized after checking their budgets, each charged one call against `total_provider_calls: 1`. The resulting ledger verified successfully with two calls spent.

     Reproduction: `node --test .review-tests/budget-race.test.mjs`

   - **Single-turn quota failover hides its second call.** `laneFirstTurn` invokes the lane and then the API without a second charge (`pantheon/src/sdk/agy-turn.mjs:62`, `pantheon/src/sdk/agy-turn.mjs:70`). The pipeline supplies an additional charge callback only to implementers (`pantheon/src/pipeline/index.mjs:188`); the lifecycle meter also counts the enclosing turn once (`ophanim/operate/stages.mjs:117`). A mock single-turn pipeline fixture sent two requests while recording one against `max_provider_calls: 1`. This fixture uses the configurable Google dispatcher; the same failover helper serves lifecycle Google seats.

     Reproduction: `node --test .review-tests/single-failover.test.mjs`

2. **Budget stops — does not hold.**

   An elapsed-budget abort adds stop metadata but preserves the executor’s returned status (`ophanim/operate/scheduler.mjs:204`). That status is recorded and released as completed when it is `passed` (`ophanim/operate/scheduler.mjs:212`, `ophanim/operate/scheduler.mjs:228`).

   The fixture waits beyond the elapsed budget, confirms that the signal aborted, then returns `passed`. The ledger records both `status: passed` and `STAGE_ELAPSED`. A recorded stop therefore does not necessarily prevent a successful handoff.

   Reproduction: `node --test .review-tests/elapsed.test.mjs`

3. **Concurrency — holds for path and claim exclusion; shared-budget safety fails as described in question 1.**

   Unordered units with overlapping ownership are refused before execution (`pantheon/src/pipeline/dispatch.mjs:136`, `pantheon/src/pipeline/index.mjs:156`). Claim re-derivation rejects an existing active claim on the same item (`ophanim/operate/work-ledger.mjs:145`), under the ledger’s append lock (`packages/ledger/chain.mjs:375`).

   Independent checks verified overlapping-path rejection, duplicate-claim rejection, and two simultaneous scheduler executors under `concurrency: 2`, with correct accounting within one process.

   Check: `node --test .review-tests/positive.test.mjs`

4. **Leases — holds for explicit tick/claim recovery and stale-holder fencing.**

   Tick releases expired claims before reconciliation (`ophanim/operate/scheduler.mjs:107`). Claim creation also releases an expired predecessor (`ophanim/operate/work-ledger.mjs:291`). Stage records and spending both enforce the fence (`ophanim/operate/work-ledger.mjs:302`, `ophanim/operate/work-ledger.mjs:307`).

   Independent checks confirmed an `expired` release, acceptance of the replacement claim, rejection of the old holder’s stage and spend, and retention of its earlier charge.

   Check: `node --test .review-tests/positive.test.mjs`

5. **Retries and the lane ladder — holds by source inspection for uninterrupted execution.**

   Non-quota failures receive one same-lane retry; quota failures immediately step down. Exhaustion produces `blocked` with `LANE_LADDER_EXHAUSTED` (`pantheon/src/pipeline/index.mjs:313`, `pantheon/src/pipeline/index.mjs:329`). Failures are attached to the attempt before review-revision handling, so they do not consume review revisions (`pantheon/src/pipeline/index.mjs:324`, `pantheon/src/pipeline/index.mjs:354`).

   Full runtime confirmation was limited by the sandbox’s denial of the A2A Unix socket. Crash durability is separately addressed below.

6. **Metered failover off — holds in the inspected adapters.**

   Both single-turn and worker adapters refuse metered fallback when disabled (`pantheon/src/sdk/agy-turn.mjs:66`, `pantheon/src/pipeline/turns.mjs:226`). The worker records the refusal, and ladder exhaustion records a block (`pantheon/src/pipeline/implement.mjs:209`, `pantheon/src/pipeline/index.mjs:329`).

   Independent mocks confirmed zero API calls, one worker quota probe, and the explicit `disabled` marker.

   Check: `node --test .review-tests/positive.test.mjs`

7. **Checkpoints — does not hold.**

   Individual files use temporary-file replacement, patch first (`pantheon/src/pipeline/checkpoint.mjs:50`). Resume checks the patch digest, upstream trees, resulting tree, and reruns verification (`pantheon/src/pipeline/checkpoint.mjs:94`, `pantheon/src/pipeline/index.mjs:415`).

   **Approval evidence is not reverified.** Rubric and review digests are checked only for hash-shaped syntax (`pantheon/src/pipeline/checkpoint.mjs:90`). The fixture supplies fabricated digests and a nonexistent reviewer, while retaining a valid tree and passing verification command. Resume accepts the checkpoint as approved with zero provider calls.

   Reproduction: `node --test .review-tests/checkpoint.test.mjs`

   `unit_key` covers its documented unit definition, base commit, and transitive upstream keys (`pantheon/src/pipeline/checkpoint.mjs:41`); it does not authenticate the approval. This finding overlaps assignment 2.

8. **Process restart — does not hold for standalone pipeline recovery.**

   Pipeline admission increments an in-memory counter without persisting it before dispatch (`pantheon/src/pipeline/index.mjs:174`). The next save follows the dispatcher’s return (`pantheon/src/pipeline/index.mjs:260`).

   The fixture kills a child after its mock dispatcher starts. `pipeline.json` records zero calls despite one call having started. Restarting into the same run directory then fails because the orphaned integration worktree already exists (`pantheon/src/pipeline/index.mjs:198`).

   Reproduction: `node --test .review-tests/restart.test.mjs`

   Scope qualification: lifecycle `fit` execution supplies durable ledger charges and uses a new pipeline directory per attempt (`ophanim/operate/stages.mjs:806`, `ophanim/operate/stages.mjs:847`). Those protections mitigate this reproduction there. Mid-wave finding retention and mid-checkpoint kill recovery were not exhaustively established.

9. **Timeouts — does not hold as a strict elapsed-time guarantee.**

   Verification timeouts kill the command’s process group; the independent timeout check passed (`pantheon/src/pipeline/review.mjs:52`, `pantheon/src/pipeline/git.mjs:29`). Worker print timeout and process watchdog handling are present (`pantheon/src/board/agy-cli.mjs:595`, `pantheon/src/board/agy-cli.mjs:609`).

   The current implementation does more than check elapsed time between stages: it sends a cooperative abort during a stage. However, it continues awaiting the executor, and the live single-turn adapters do not forward that signal (`ophanim/operate/scheduler.mjs:193`, `pantheon/src/sdk/live.mjs:25`, `pantheon/src/sdk/agy-turn.mjs:55`). Question 2’s reproduction confirms execution beyond the deadline and acceptance of the late result.

   Reproduction: `node --test .review-tests/elapsed.test.mjs`

10. **Run record — cannot tell completely.**

    The launcher invokes a fresh child verifier and fails closed without a valid verdict (`ophanim/operate/live-run.mjs:493`). Budget stops and blockers are assembled into the record (`ophanim/operate/live-run.mjs:452`, `ophanim/operate/live-run.mjs:556`).

    The independent launcher fixture recorded its budget stop and passed in-process ledger verification. The child exited zero but supplied no captured verdict, so fresh-process success remains unconfirmed. Details are retained in `.review-tests/verification-result.json`.

    Other runtime limitations: Unix-socket listening failed with `EPERM`; the scripted board fixture was refused by bwrap’s `NETLINK_ROUTE` setup. These are testing limitations, not established repository defects.

## Blockers for a live run

- Authenticate checkpoint approval evidence before reuse.
- Account for every single-turn metered failover request.
- Prevent elapsed-budget stops from producing successful handoffs.
- Make shared-budget reservation atomic before allowing multiple scheduler processes.
- Repair standalone pipeline crash accounting and abandoned-worktree recovery before relying on that restart path.
- Obtain a successful fresh-process verification and rerun the blocked integration tests in a compatible isolated environment.

Lab: **OpenAI**. Configured model: **gpt-6-astra**, as specified by the review harness; the actual serving-model identifier is not independently exposed to this session.