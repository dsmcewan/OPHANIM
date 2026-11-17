# Control contract for the scalable improvement cycle

Owner requirement: the operating cycle must evaluate and test its current state, improve it from evidence, and keep doing so as work and concurrency grow. This is a versioned implementation/acceptance contract. It does not claim the current code enforces every control below.

Reuse the existing authoritative blackboard, dependency tracking, leases/fences, content-addressed artifacts, signed ledgers, controller gates, review-cycle records and investigation history. Connect them into one state machine; a GitHub issue is its public view.

## Governing rule: evidence-supported correctness, with provisional current practice

The owner's further direction is that decisions and their rationale must follow the correct, ledger-documented evidence chain rather than an easy shortcut. Components must operate cohesively, thoroughly and efficiently; each cycle builds on prior cycles, audits inherited state and capabilities, and evaluates improvements through A/B testing. The current configuration represents what has been retained or supported so far, not proof of global optimality.

Every material decision records a concise rationale: objective and acceptance constraints, exact inherited state/policy/dependency versions, cited evidence, eligible alternatives, reasons for rejecting them, uncertainty, predicted outcome and a falsifiable check. Correctness, independent verification and authority are constraints. Optimize total resources per accepted outcome within them; a cheaper or quicker path cannot waive its evidence obligations.

The auditable chain is: **inherited qualified state → question/hypothesis → predeclared baseline and candidate → raw test observations → independent verification → scoped disposition → applied policy/version → observed subsequent outcomes**. Require valid signatures and semantic relationships between these records. A chain of signed claims or a repeated `verified` label is insufficient. Preserve contradictory, negative and inconclusive results.

Maintain a compatible component-state manifest covering routing, coordination, worker adapters/capabilities, acceptance/verifiers, schemas, authority and active policies. A component change triggers evaluation of affected dependencies and end-to-end paths before adoption. The next cycle must demonstrate which admitted version it actually used; it must not merely cite a document describing a different configuration.

Each cycle records an A/B decision: execute a bounded matched comparison, reuse still-applicable qualified comparison evidence with a stated reason, or record the specific evidence/resource/authority gap and next measurement task. Retention remains provisional and labeled. New comparison criteria, sample/uncertainty rules and resource bounds are declared before interpreting results. Compare equivalent tasks under the same acceptance requirements; account for retries, failures and coordination overhead, and for order/environment variation. A positive result supports its tested scope, with rollback and re-evaluation conditions; it does not establish the best approach for every workload.

## Specialized and reusable agents

The owner additionally requires agents to be specialized and reusable. Reuse the existing role/agent store and renderer/consumer machinery, with an explicit bridge into the actual dispatcher. Each specialist needs a stable ID and version/digest, base role and specialty, input/output schemas, permitted tools and write paths, sandbox/authority limits, eligible model/transport capabilities, scoped context and handoff rules, and qualification receipts for the exact rendered definition and runtime.

Dispatch names the selected specialist and qualification version, verifies eligibility before a call, and records the definition actually consumed alongside the actual model. The reusable registry and the live routing candidate set must agree. Unknown, incompatible or unqualified definitions are refused with a specific reason. Silent lossy conversion is not equivalent to qualification.

Reuse qualified instructions, tools, methods and scoped evidence, with handoff/version checks on resume. Keep separate author/reviewer/judge responsibilities and fresh review context where independence requires it. Model changes are explicit eligible reseats; an identity retained in the ledger does not permit an old writer's conversation to become independent review. Newly learned practices version and requalify affected specialists, preserving provenance and a rollback target.

## Empirical qualification replaces opinion-based policy promotion

The owner rejects “my judgment calls, not measurements” as an acceptable basis for adopted routing or workflow policy. An unsupported choice remains a hypothesis with an explicit qualification task. Do not promote it by relabeling a preference, assigning arbitrary weights, repeating it across tickets, or collecting agreement.

Every proposed rule, score, threshold or escalation trigger needs its provenance and category: an owner-authorized constraint, a documented technical capability, a raw observation, a testable hypothesis, a validated measurement or a qualified scoped policy. An authority constraint is not a performance measurement. The existing three-lab operating requirement is retained as a constraint; this audit does not establish three as the empirically optimal number of reviewers.

Before measurement, declare the question, competing hypotheses/configurations, baseline, acceptance criteria, task/sample scope, metrics, uncertainty/stop rules, limits and promotion/rollback conditions. Validate instrument correctness, identities, units, completeness, environment and repeatability; preserve raw observations and independent reproductions. Critique the proposal and method independently before adoption. Validate the implemented configuration against the evaluated candidate, then check subsequent outcomes and drift. A plausible rationale, benchmark from another context, green implementation test or reviewer vote cannot substitute for these stages.

When data or authority is missing, record `insufficient_evidence` with the exact next experiment/dependency. Retain a specifically authorized baseline provisionally within its existing scope, or refuse the new scope. No agent can certify its own unsupported hypothesis into established practice. This empirical chain and its parent acceptance coverage must be enforced in the continuing cycle; documenting it alone does not complete that work.

## Mandatory cross-model accountability

The owner explicitly prohibits bypassing independent cross-model review. Preserve an inspectable proposal, exact candidate bytes, raw tests, dissent, response, and separate reviewer identity for every consequential transition. Review covers planning, implementation, test adequacy, routing/escalation, specialist definitions, handoffs, learned policies, and changes to these controls. Use fresh independent first-pass judgments before sharing other verdicts. Model labels, several agents of one family, unanimous agreement, or shared conversations do not establish independence.

The operating workflow's documented three-lab review requirement cannot be lowered by a caller or availability fallback. Exclude every authoring lab, including the planner, and preserve author-turn lineage. If there are too few eligible independent labs, refuse or reseat through an explicit qualified decision before doing work. Missing reviewers, partial verification, deferred blockers, unverified closes and a free-text acceptance reason cannot authorize completion. A correction changes the candidate and requires acceptance and independent review of the final corrected bytes. Reviewer failure produces bounded recovery or an explicit pending state.

Accountability is evidence-based rather than a popularity vote: a reproducible counterexample remains actionable even when other reviewers approve. Record why it is upheld or rejected and independently validate its disposition. Audit reviewer coverage and blind spots, test the gates adversarially, and require independent qualification for protected rule changes. Reviews are bounded by target and budget; auditing auditors must not create an unlimited recursive debate. An actual external model review remains a distinct recorded step; this Codex team's internal reviews do not satisfy that step.

## Routing requires a capability profile and an alternative set

The owner's correction is explicit: `easy` / `hard` is not an adequate routing scale or a substitute for considering the breadth of alternatives. Keep the original objective visible through ticket decomposition. A completed slice does not close the parent requirement or silently discard unevaluated dimensions.

Before routing, characterize the task's domain and operation, uncertainty and evidence gaps, context size/structure, tools and modality, schema/reasoning requirements, impact and reversibility, permitted data/authority, independence constraints, dependencies, deadline, resource bounds and qualified prior outcomes. Distinguish a capability failure from a missing tool, bad context, unavailable evidence, transport failure or an invalid acceptance test. These failures require different remedies; escalation cannot just choose a nominally stronger model.

Construct an eligible set across specialized agents/models, transports, tools, context strategies and team arrangements. Include reuse of qualified evidence, deterministic execution, retrieval/research, decomposition, a different specialist, repair of the brief/environment, and independent parallel comparison where justified. Enumerate registered candidates programmatically and give a specific eligibility/selection reason; do not restrict consideration to a fixed preferred pair or invent unsupported numerical rankings. Unknown capabilities remain unknown and become bounded qualification questions. Select a configuration against acceptance constraints and observed quality, reliability, latency and total resource use; retain relevant alternatives that trade these off. A route records its considered set, exclusions, uncertainty and trigger for revisiting the decision.

Maintain finite research and comparison budgets. Each cycle refreshes the highest-value unresolved practice question using current primary documentation, the ledger's outcomes and matched/held-out tests. New providers, techniques or configurations enter a versioned discovery/qualification queue before they can affect production. A/B tests compare meaningful alternative configurations, including failures, retries, verification and coordination cost. Evidence may retain the current route provisionally; documentation or green plumbing tests alone cannot establish that it is optimal.

Tickets must trace each parent acceptance requirement to an executable check, qualified evidence or an explicitly open follow-up. Independent review checks that coverage and the alternative set, not merely whether the authored tests pass. Closing the routing/coordination requirement requires implemented profile-based dispatch, exercised alternative selection/escalation, actual policy consumption and comparative evidence; fixing a default, adding a binary difficulty label or closing one child ticket is insufficient.

Required adversarial routing cases include equally labeled tasks with different domains/tools/privacy/independence needs selecting different eligible configurations; an apparently expensive task solved by a qualified deterministic tool; missing evidence leading to research rather than blind model escalation; an unavailable reviewer never reducing independence; and an untested candidate remaining unqualified despite a high generic benchmark score. These are implementation requirements, not tests claimed to pass in this audit.

Research context checked 2026-11-16: [RouteLLM](https://arxiv.org/abs/2406.18665) studies preference-trained routing between a strong and weak model; it provides one baseline, not the owner's required alternative space. [LLMRouterBench](https://arxiv.org/abs/2601.07206) evaluates a broader model pool and reports complementarity, baseline comparisons and performance/cost/latency considerations. These published results do not qualify OPHANIM's routes. [Who Convinced Whom?](https://arxiv.org/abs/2610.35930) reports, in its tested debate setting, that greater agreement can coexist with more shared errors; our inference is to measure independence and error, rather than reward agreement alone.

## Completion and handoff contract

Every attempt must identify:

- Task ID and ticket digest; exact expected predecessor/status entry; source base and qualified dependency/input versions.
- Attempt/request ID, shared claim/lease ID and fencing generation; worker/role/model/lab/pool identity; deadline and remaining attempt/resource bounds.
- Exact candidate commit/tree and artifact manifest; immutable acceptance contract; executed test command/environment/output digest and exit; passing ship-gate receipt.
- Independent reviews of that final candidate, with requested/served model, lab, immutable brief and disposition of each finding.
- Run/cycle evidence anchors and heads; full verification outcome; current practice-policy identity and its retained/admitted disposition.
- Next owner, acknowledged handoff, pending/terminal state, recovery pointer, and rollback/compensation target where applicable.

The receiving component re-derives these relationships before accepting responsibility. It must not infer them from a valid signature on an unrelated record, a commit message, a worker's success claim, or a display status.

## Required control matrix

| Control | Required behavior | Acceptance probe | Audit state |
|---|---|---|---|
| Exact task/evidence binding | A run can complete only its own ticket and acceptance scope | Transplant A's authentic evidence to B; invent tests/gate | W1 fails |
| Final corrected candidate | All fixes are in the accepted and independently reviewed final bytes | Review H, fix in F, try to complete H | W2 fails |
| Atomic owner application | Expected item predecessor is checked under the same write transaction | Insert a hold after precheck, before append | W3 fails |
| Shared admission/idempotency | One active attempt per item/ticket/base; duplicate submission returns its attempt | Two controllers or retry before owner apply | W4 fails |
| Bounded recovery | Resume missing work/review under immutable identity without rebuilding valid work | Fail one reviewer with a shared run ledger | W5 partially repaired by the follow-up resume path; fresh-run recovery still repeats work |
| Public read-only verification | Public proof validates without signing keys or filesystem writes | Copy evidence excluding keys; verify in a fresh location | W6 fails |
| Complete semantic verification | Incomplete/foreign/unavailable required evidence cannot return full success | Remove referenced board data | W7 fails |
| Versioned dependencies | Bind consumed versions and implement explicit invalidation rules | Reopen/change a dependency during the attempt | W8 lacks contract/recheck |
| Resource admission | Global per-attempt/token/call/time bounds include retries and coordination; unknown cost stays unknown | Exhaust shared budget while multiple workers contend | Earlier routing audit remains open; not qualified here |
| Mandatory cross-model completion | Three eligible nonauthoring labs, exact final candidate, no override/deferred blocker; fresh independent verdicts | Lower n, allow planner lab, waive unverified close, defer a blocker | New confirmed bypasses; candidate fixes in progress, cross-model review pending |
| Capability-based alternatives | Route by task requirements, eligible specialist/tool/transport/team choices and measured trade-offs | Same easy/hard label with different constraints; missing-evidence escalation | Required by owner; full implementation/comparative qualification pending |
| Parent acceptance coverage | Child completion preserves unmet parent requirements | Fix one default and attempt to close broad routing requirement | Required by owner; no full closure claimed |
| Independent audit/control authority | Proposed improvement cannot weaken its own acceptance, verifier, key authority or protected budget | Candidate edits the gate or removes a required test | Require separate protected-change qualification |
| Continuing practice assessment | Each cycle records assessment and disposition; next dispatch loads it | Close with no learning; change a document without changing dispatcher policy | W9 fails |
| Qualified reusable specialists | Live routing, agent registry and consumed definition/qualification identity agree | Request each active role/model definition; dispatch an unknown or unqualified specialist | W10 has registry drift and an incomplete dispatch bridge |
| Scalable queue/supervision | Priority, backpressure, fairness, cancellation and restart are explicit | Duplicate delivery, stale workers, contention, worker crash and growing retained history | No scale qualification established |

The audit-state column reports this snapshot. It must become actual executable pass/fail tests, with failing-before/passing-after evidence, rather than a checklist that certifies itself.

## Cycle state machine

`assess → prioritize → claim → plan → implement → execute acceptance → independent review → repair/review final candidate → verify complete handoff → owner/policy-authorized application → publish → assess`

At each transition, persist its immutable inputs and idempotency identity before dispatch. Exactly one accountable owner holds responsibility per claim or handoff scope; parallel workers may own different scopes. Late results must carry the original claim generation and be fenced when stale. A timeout, refusal, cancellation or conflict produces a named state and recovery decision. A new board directory or agent must not reset a task's global resource/review history.

The owner-signing boundary remains explicit. Automation needs an authorized, scoped signing path; publication credentials do not confer ledger or policy-promotion authority.

## Continuing audits and self-improvement

**Every task handoff:** check identity/scope, expected predecessor, consumed dependencies, ownership/fence, remaining limits and exact evidence. Reject missing, conflicting, replayed or stale evidence with the specific control's reason. Reuse already valid results.

**Every cycle:** record the effective routing/coordination/workflow policy; inspect failures, retries, queue delay, handoff overhead, resource use and accepted outcomes; choose the highest-value ready practice question. Record `retain`, `insufficient_evidence`, `propose_measurement` or `propose_policy`, even when no experiment runs. Create a bounded ticket for actionable priority work. Genuine external holds do not require other Ready work to stop.

**Before promotion:** compare the current policy and candidate against predeclared quality/resource criteria on matched tasks. Include unsuccessful attempts and coordination overhead. Use an independent review of the method and raw results, plus held-out failure/adversarial cases. Admit only the exact scoped candidate that was evaluated. Keep a rollback pointer and conditions that trigger re-evaluation. A synthetic test qualifies mechanics; it does not establish live cost or quality improvements.

**Before increasing scale or changing a critical boundary:** test concurrent claims, duplicate/reordered delivery, stale generations, worker/reviewer loss, process death at persistence boundaries, dependency changes, owner-apply races and contention on shared ledgers/budgets. Publish latency/storage/recovery curves and observed failure bounds. Apply backpressure at the measured limits.

**For the audits themselves:** pin the reviewed source/target hashes, bind verdicts to those exact bytes, keep finite per-target round/attempt limits and retain negative findings. Test that each critical check fails when removed or bypassed. A repeated unresolved blocker, exhausted budget, missing authority or absent evidence produces a specific stop/defer decision; it does not become a fresh unlimited audit under a new worker.

## Safe implementation order

1. Fix W1/W2 so completion names the correct task and final corrected candidate. Add rejection cases for swapped task/ticket/tests/gate/commit and unincorporated fixes.
2. Make application freshness atomic; add shared task claims, pending-run lookup and idempotent acknowledgments before model calls.
3. Add bounded review/attempt resume, explicit terminal failure/cancellation and dependency-version reconciliation.
4. Separate public verification from writer/key custody; require complete proof packs and complete semantic verification for automatic completion.
5. Connect the existing practice-investigation tools to required cycle assessments, validated priority tickets and actual next-dispatch policy consumption. Retain the prior routing/coordination repairs and real usage accounting as dependencies.
6. Qualify concurrency/recovery with guarded fake-provider tests, then perform a bounded live operational cycle and matched improvement comparison under explicit applicable authority and budget.

Preserve historical hashes and earlier record semantics. Add/version new enforcement for new attempts rather than rewriting old evidence. Changes to pinned TELOS trust, operator key authority, protected acceptance or live spending require their own existing authority; self-improvement does not grant a component permission to certify a weaker verifier.
