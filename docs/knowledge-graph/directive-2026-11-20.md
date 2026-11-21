# Owner directive, 2026-11-20: Federated Knowledge Graph Architecture & Implementation

Recorded verbatim by the coordinator. This is the acceptance test of the knowledge-graph program on branch `ophanim/knowledge-graphs` (based on `9547e12`). Every brief of the program quotes from or points to this file.

---

OPHANIM — Federated Knowledge Graph Architecture & Implementation

Mission

Implement a persistent, interconnected knowledge-graph architecture within OPHANIM.

OPHANIM is an autonomous systems foundry. Its purpose is to investigate requirements, discover dependencies, construct capabilities, verify outcomes, operate systems, and improve its own processes.

The knowledge graphs must become part of that operational intelligence, not merely a visualization, documentation index, or passive memory store.

The objective is to give OPHANIM a continuously maintained understanding of:

- What capabilities and resources exist.
- How systems, components, processes, and dependencies relate.
- What evidence supports its knowledge and decisions.
- What previous failures and corrections have established.
- What work exists, why it exists, and what must happen next.
- How changes in one area affect other areas.
- Which specialized teams can investigate or execute the next eligible work.

Build this by extending OPHANIM's existing architecture, authoritative ledgers, contracts, schedulers, retrieval mechanisms, and agent orchestration.

Do not create a second orchestration system or replace existing authoritative records with a graph database.

---

1. Architectural principle: Specialized graphs, connected intelligence

OPHANIM requires five primary specialized knowledge graphs, connected by stable identities, typed relationships, and provenance.

Graph A — Model, Runtime & Capability Graph

Purpose: Understand what each available model, runtime, tool, agent, and execution environment can actually do.

Represent:

- Model providers and independent laboratories.
- Model identities, versions, supported features, and availability.
- Execution transports, SDKs, runtimes, and authentication requirements.
- Model reasoning capabilities and measured performance.
- Context windows, output constraints, effort levels, latency, and cost.
- Native subagent capabilities and delegation limits.
- Available tools, permissions, and execution environments.
- Role eligibility, model qualifications, and known limitations.
- Historical task outcomes, resource usage, and successful or failed assignments.

Importantly, a model and its runtime are not the same thing.

For example:

"gemini-4-carbon → runs-in → Google Antigravity SDK"

"Antigravity SDK → supports → native subagent delegation"

"gemini-4-hydrogen → eligible-for → bounded research specialist"

Represent the model/runtime combination as an executable capability, including the constraints under which that combination works.

Support three selection modes:

1. Automatic: OPHANIM selects a qualified capability based on task requirements and evidence.
2. Preferred: An operator expresses a preference, with documented, authorized fallback behavior.
3. Pinned: An explicitly required model/runtime combination must be used or the assignment must be refused.

Model qualifications must be based on documented capabilities and measured evidence, with those evidence types distinguished. Do not turn subjective preferences into claims of measured superiority.

Operational use: The planner and scheduler query this graph to assemble qualified teams. They should not require source-code changes every time a new model becomes available.

Graph B — Systems, Components & Dependency Graph

Purpose: Understand the structure of software, business processes, infrastructure, data flows, and the systems OPHANIM constructs.

Represent:

- Enterprises, departments, processes, and applications.
- Repositories, modules, functions, services, APIs, and tools.
- Databases, tables, views, schemas, transformations, files, and pipelines.
- Inputs, outputs, interfaces, dependencies, and downstream consumers.
- Contracts, invariants, acceptance tests, and verification requirements.
- Deployment environments, operational integrations, and system boundaries.
- Existing capabilities and reusable components.
- Direct and indirect change impacts.
- Versions, historical relationships, and superseded components.

This graph should support OPHANIM's construction hierarchy:

Bricks: Individual functions and specialized capabilities.

Mortar: Interfaces, dependencies, coordination, shared state, and handoffs.

Building codes: Contracts, invariants, verification requirements, authority, and rollback.

Construction crews: Dynamically assembled teams.

Buildings: Qualified systems assembled from smaller, reusable capabilities.

A component must not merely be recorded as existing. The graph should explain what it does, what it requires, what consumes it, and what evidence establishes its qualification.

Operational use: Before implementing new work, OPHANIM queries this graph to determine whether the required capability already exists, what can be reused, and what a proposed change might break.

Graph C — Evidence, Decisions & Provenance Graph

Purpose: Preserve how OPHANIM knows what it claims to know.

Represent:

- Original requirements and source documents.
- Observations and source versions.
- Retrieved evidence and delivered context.
- Hypotheses, competing explanations, and contradictions.
- Investigations, experiments, tests, and reproductions.
- Decisions and the evidence that justified them.
- Authorizations and governing contracts.
- Contributions from models, agents, tools, and operators.
- Accepted, rejected, unresolved, and superseded conclusions.
- Historical execution and verification records.

Preserve a strict distinction between:

- What was recorded: The historical trace.
- What is currently established: The verified current projection.
- What could be true or become possible: Hypotheses and candidate states.
- What may change: Authorized transitions.

Do not confuse these categories.

The graph must also distinguish:

- Evidence available somewhere.
- Evidence actually supplied to an agent.
- Evidence subsequently retrieved.
- Evidence cited in a conclusion.
- Evidence independently checked.

A citation alone does not prove that the underlying source supports the claim.

Every material conclusion must remain traceable to its evidence, versions, assumptions, and limitations.

Operational use: OPHANIM retrieves the relevant evidence neighborhood for an investigation or decision without repeatedly transmitting complete historical transcripts.

TELOS and the existing authoritative ledgers retain their verification and governance responsibilities. This graph indexes and connects their records; it does not replace their authority.

Graph D — Failures, Corrections & Learning Graph

Purpose: Give OPHANIM persistent institutional memory about observed failures, their underlying mechanisms, and which corrective practices actually work.

Represent:

- Observed defects and unexpected behaviors.
- Symptoms, triggers, contributing factors, and proposed causes.
- Reproduction steps and negative tests.
- Mutation-testing targets and outcomes.
- Violated contracts and affected invariants.
- Repairs, mitigations, and rejected alternatives.
- Reviewer findings and contradictions.
- Lessons and their applicability conditions.
- Recurring failure classes.
- Known detection gaps.
- Correction evidence and residual limitations.

Separate individual defects from shared root-cause families.

For example, several defects involving model identity may originate from one missing identity-preservation contract across handoffs.

The graph should connect those cases without assuming they share a cause merely because their symptoms are similar.

Integrate the existing lessons and corrections registry rather than creating a competing registry.

Operational use: When a new defect is observed, OPHANIM checks for related failure mechanisms, previous repairs, established tests, and applicable lessons.

Reflection should generate new investigations or corrections only when supported by evidence.

A lesson must not become universal policy merely because one experiment succeeded.

Measure whether OPHANIM can detect and correct previously observed failure classes without requiring the operator to identify the same problem again.

Graph E — Work, Resources & Execution Graph

Purpose: Connect the ticket hopper, plans, work units, teams, contracts, resource constraints, and actual execution.

Represent:

- Original prompts and authorized work identities.
- Unplanned tickets, requirements, plans, and work units.
- Dependencies, shared prerequisites, conflicts, and blockers.
- Assigned roles, teams, agents, and runtime capabilities.
- Execution leases, ownership boundaries, and worktrees.
- Resource budgets, provider requests, usage, and remaining capacity.
- Execution state, checkpoints, retries, interruptions, and recovery.
- Produced artifacts, reviews, validation, and integration.
- Discoveries that create, revise, or invalidate work.
- Completion conditions and unresolved obligations.

A prompt becomes an unplanned work item through the existing authorized intake mechanism.

OPHANIM investigates the objective, identifies its dependencies, creates the plan and work-unit contracts, and schedules eligible execution.

This graph should make relationships between tickets explicit.

For example:

- Ticket A requires an Antigravity SDK transport.
- Ticket B requires dynamic team construction.
- Ticket C requires accurate resource accounting.

All three may depend on a shared model/runtime capability contract.

OPHANIM should discover that prerequisite, investigate whether it already exists, and avoid three independent implementations.

Sharing a dependency does not automatically mean tickets should be merged. Distinct objectives and ownership boundaries must remain intact.

Operational use: The scheduler queries the graph to determine what work is eligible, what is blocked, what can run concurrently, and what newly qualified capability unlocks other work.

---

2. Connect the graphs without collapsing them

These five graphs should remain specialized logical domains with their own schemas, access rules, and update policies.

Use a shared identity and relationship mechanism to connect entities across them.

Examples:

"Work Unit → requires-capability → SDK Gateway"

"SDK Gateway → implemented-by → Component"

"Component → governed-by → Contract"

"Contract → verified-by → Test"

"Test → detects → Failure Mechanism"

"Failure Mechanism → documented-in → Lesson"

"Lesson → applies-to → Other Component"

"Model/Runtime → qualified-for → Work Role"

"Agent → contributed-to → Artifact"

"Artifact → derived-from → Evidence"

"Change → invalidates → Previous Qualification"

Support relationship types including:

- "implements"
- "depends-on"
- "consumes"
- "produces"
- "governs"
- "authorizes"
- "verifies"
- "derived-from"
- "supports"
- "contradicts"
- "supersedes"
- "introduced-because-of"
- "invalidates"
- "qualified-for"
- "contributed-to"
- "shares-failure-mechanism-with"

Relationships must have defined meaning and direction.

Do not treat correlation, textual similarity, or a model-generated inference as verified dependency or causation.

3. Shared graph contracts

Establish versioned schemas for graph entities and relationships.

Each material graph assertion should retain, where applicable:

- Stable identity and namespace.
- Graph domain and entity type.
- Relationship type and direction.
- Source authority and canonical source reference.
- Source version, digest, or immutable evidence identifier.
- Observation and effective timestamps.
- Originating agent, model, tool, or deterministic extractor.
- Classification as authoritative, observed, derived, or hypothetical.
- Qualification or verification status.
- Relevant access and scope restrictions.
- Supersession or invalidation relationships.
- Uncertainty and missing-evidence conditions.

Preserve both historical and current-state queries.

Use source-authoritative events and verified source changes to drive graph projections.

The graph's current state must be reproducible from its recorded inputs.

Do not delete historical evidence simply because a newer version supersedes it.

Graph writes must be validated, scoped, idempotent, and recoverable. Agents may propose relationships, but only authorized mechanisms may admit consequential changes.

4. Continuous discovery and event-driven updates

The graphs must evolve as OPHANIM operates.

Support changes originating from:

- Authorized prompt intake.
- New or updated source documents.
- Repository commits and code changes.
- Execution traces and tool results.
- Database or application metadata changes.
- Completed investigations.
- Test and mutation results.
- Reviewer findings.
- Newly qualified capabilities.
- Changed model availability.
- Decisions, corrections, and lessons.

Prefer incremental, event-driven updates over repeatedly rebuilding every graph in large batches.

Retain bounded full reconciliation and replay for recovery, migration, and consistency checking.

Every update must preserve ordering, source version, provenance, and idempotency. A repeated event must not create duplicate obligations or relationships.

A changed source should trigger targeted reassessment of affected graph neighborhoods, not automatic global invalidation.

A newly discovered dependency must be able to affect active planning and scheduling without stopping unrelated work.

Do not claim continuous synchronization for a source unless its change-detection mechanism is actually operating. Record stale or unavailable sources visibly.

5. Dynamic teams must use the graphs

The graphs should drive team composition rather than merely describe teams after they execute.

For each proposed task, OPHANIM should:

1. Query the work graph to determine the unmet obligation.
2. Query the systems graph for existing capabilities and dependencies.
3. Query the evidence graph to establish what is known and uncertain.
4. Query the learning graph for relevant failure mechanisms and prior corrections.
5. Query the capability graph to select qualified models, tools, and runtime environments.
6. Assemble the bounded team needed for the actual investigation or construction.
7. Record its assignments, contributions, findings, and results back through the existing authorized mechanisms.

A specialized team can itself expose a contract as a delegated capability.

Support nested research and implementation teams within explicitly established depth, concurrency, budget, and authority limits.

Do not equate model count with independent laboratory count. Internal Google subagents remain Google contributors.

Preserve reviewer independence and full contribution lineage.

Teams should be created because a requirement justifies them and released when their assignment is satisfied.

6. Federated enterprise architecture

The eventual architecture must support multiple independent OPHANIM instances.

Central OPHANIM: The enterprise-level orchestration and relationship hub.

Departmental OPHANIM instances: Independent domain-specific foundries responsible for understanding and improving their own operational systems.

For example:

- Finance OPHANIM understands reconciliations, payment flows, spreadsheets, databases, and financial controls.
- Operations OPHANIM understands workflows, service dependencies, historical procedures, and operational bottlenecks.
- Compliance OPHANIM understands obligations, control evidence, exceptions, and verification requirements.
- Technology OPHANIM understands applications, interfaces, infrastructure, and software dependencies.

Each departmental instance maintains its own relevant graph state and authority boundaries.

The central instance links permitted relationships across departmental graphs.

It should understand that a Finance process depends on a Technology service or produces evidence consumed by Compliance without indiscriminately copying either department's entire graph.

Federation must support:

- Cross-instance identity resolution.
- Explicit graph ownership and authority.
- Versioned cross-domain references.
- Access-controlled queries and projections.
- Cross-department dependency discovery.
- Propagation of relevant invalidations and qualification changes.
- Provenance-preserving handoffs.
- Recovery from disconnected or stale departmental instances.
- Independent departmental operation when the central hub is unavailable.

Do not create one giant shared store in which every department owns every other department's data.

Cross-domain graph access must respect the source system's permissions, sensitive-data restrictions, and departmental boundaries.

OPHANIM should generally construct and operate improvements within the appropriate department's systems, rather than relocating every business workflow into the central foundry.

7. Discover actual business operations

The graph architecture must support discovery of real enterprise workflows, not only source-code repositories.

When an OPHANIM instance is authorized to examine a department, it should investigate:

- Actual data sources and destinations.
- Existing spreadsheets, macros, SQL, Access databases, and automation scripts.
- Recurring file exchanges and transformations.
- Operational procedures and historical exceptions.
- Data lineage and business rules.
- Control points, undocumented dependencies, and downstream consumers.
- Existing applications and integrations.
- Repeated manual tasks that could become deterministic automation.

Distinguish documented processes from processes established by observed execution.

A historical spreadsheet or macro may be the only available evidence of a business rule. Preserve that evidence and investigate its actual behavior before proposing a replacement.

The resulting graph should enable OPHANIM to construct a replacement with clear source-to-target mappings, behavioral equivalence criteria where appropriate, exceptions, and downstream compatibility checks.

Do not infer undocumented behavior as established fact.

8. Graph-driven investigation and context delivery

Agents should retrieve relevant connected subgraphs rather than repeatedly consuming complete source histories.

For any investigation, support queries such as:

- Why does this component exist?
- What requirement introduced it?
- Which contracts govern it?
- What depends on it?
- What evidence qualified it?
- What changed since qualification?
- Which earlier defects involved the same mechanism?
- What would this modification invalidate?
- Which models and tools can perform the required task?
- Which tickets share this dependency?
- What remains unknown or disputed?

Return a bounded evidence-backed context package with source references, versions, coverage limits, and continuation options.

Do not use graph summaries as substitutes for underlying evidence.

Agents must retain the ability to challenge an initial graph projection, retrieve original records, and investigate contradictory or omitted material.

A graph query should make the evidence easier to find, not constrain the model to conclusions already represented in the graph.

9. Preserve the existing OPHANIM lifecycle

The knowledge graphs must participate in the existing recurring process:

Observe → Explore → Investigate → Determine Needs and Dependencies → Plan → Construct or Operate → Verify → Learn and Reassess

Their purpose is to make this process better informed, more reusable, and less dependent on operator intervention.

Graph updates should support:

- Automatic discovery of unplanned work relationships.
- New dependencies and shared prerequisites.
- Changes to plan validity.
- Dynamic model and team selection.
- Impact analysis before implementation.
- Correct reviewer exclusions.
- Reuse of qualified components.
- Reflection and self-improvement.
- Recognition of recurring failure classes.
- Preservation of rationale across revisions and restarts.

Never let a graph projection override the authoritative ledger, bypass a required contract, or declare an implementation qualified merely because its graph relationships are populated.

10. Implementation strategy

Start with OPHANIM itself as the first domain.

Inspect the current branch, relevant pull requests, architecture, status and work ledgers, evidence stores, Pantheon board DAG, model routing, scheduler, context retrieval, and lessons registry.

Pin the code and evidence examined.

First produce an inventory identifying:

- Graph-like structures and relationships that already exist.
- Authoritative sources and their owners.
- Missing relationship types.
- Duplicate stores or representations.
- Current query and traversal capabilities.
- Missing event propagation.
- Where the planner, dispatcher, scheduler, implementer, reviewers, and validator can consume graph-derived context.

Determine whether the necessary graph functions can be implemented using existing storage and indexes before introducing a new graph database or infrastructure dependency.

Select technology based on actual traversal, persistence, concurrency, and scale requirements. Do not introduce a graph server merely because this work is called a knowledge graph.

Then implement usable vertical slices:

Slice A — Shared graph foundation

Typed entities and relationships, source identity, namespaces, provenance, versioning, projections, traversal, change events, and deterministic replay.

Slice B — OPHANIM systems and evidence graph

Index real repositories, components, contracts, tests, requirements, evidence, and dependencies. Demonstrate source-backed traversal and impact analysis.

Slice C — Capability and model/runtime graph

Connect registered models, tools, transports, measured qualifications, delegation limits, and routing. Demonstrate dynamic seat eligibility without editing hardcoded role assignments.

Slice D — Work and learning integration

Connect prompts, tickets, plans, work units, failures, lessons, resources, and execution. Use these relationships to identify shared prerequisites, relevant historical failures, and actionable reassessment.

Slice E — Federated instances

Demonstrate two isolated domain instances plus a central relationship projection. Preserve cross-instance identity, access limits, freshness, and independent operation.

Each slice must work against real existing OPHANIM interfaces and include behavioral verification.

Do not stop at schema definitions, documentation, example diagrams, or simulated graph queries.

11. Required behavioral demonstrations

Demonstrate all of the following:

1. Shared dependency discovery: Two independent tickets require the same missing capability. OPHANIM identifies the shared prerequisite and avoids creating redundant implementations.

2. Impact propagation: A source component or contract changes. The graph identifies the affected consumers, plans, and qualifications without invalidating unrelated work.

3. Historical traceability: A component can be traced backward through its requirements, decisions, evidence, implementation, tests, and subsequent corrections.

4. Capability-based routing: A task's requirements select a qualified model/runtime/team using versioned capability evidence. A changed capability or availability condition produces an explainable new eligibility decision.

5. Learning reuse: A failure observed in one component is related to a relevant previously established failure mechanism. The system identifies the applicable test or investigation instead of rediscovering the entire problem.

6. Contradictory evidence: Conflicting observations remain distinguishable and retrievable. A model's inference cannot silently overwrite verified evidence.

7. Source invalidation: Changed or missing evidence triggers the appropriate reassessment, with recorded downstream effects and no unsupported completion claim.

8. Concurrency: Graph updates from multiple executing tickets remain consistent. A shared dependency does not create duplicate claims, circular execution, or lost updates.

9. Restart and replay: A killed or restarted process reconstructs the same qualified graph projection from its authoritative records without inventing missing state.

10. Federation: Two departmental instances expose permitted relationships to a central OPHANIM without disclosing unauthorized source details or requiring permanent connectivity.

11. Actual lifecycle integration: At least one authorized unplanned work item progresses through investigation and planning using graph-derived relationships, and the resulting implementation and verification records update the relevant graphs.

12. Negative cases: Invalid identities, unsupported edges, stale records, unauthorized writes, broken references, and unverified model claims are refused or explicitly marked unresolved.

Use distinguishing tests and targeted mutations to establish that these behaviors are genuinely enforced.

Separate synthetic demonstrations from live operational evidence.

12. Verification, governance, and resource limits

Preserve:

- Existing authoritative status and work ledgers.
- TELOS verification and authorization boundaries.
- Model and laboratory independence requirements.
- Contributor lineage and reviewer exclusions.
- Worktree isolation and execution ownership.
- Centralized provider billing authorization.
- Request-level accounting and resource limits.
- Recovery, rollback, and checkpoint contracts.
- Evidence versions and immutable historical records.

Do not let graph exploration cause unbounded recursive searches, agent spawning, token expenditure, or storage growth.

Use bounded queries, targeted graph-neighborhood expansion, and justified escalation.

Treat missing evidence and unresolved relationships as meaningful states, not reasons to fabricate conclusions.

For disputed architectural choices, compare alternatives against the actual repository and required behavior. Record tradeoffs and select a qualified implementation within existing authority.

Deliverables

Produce:

1. A current-state inventory of graph-related capabilities and gaps.
2. A versioned graph architecture and relationship contract.
3. Working graph persistence, traversal, update, and reconciliation mechanisms.
4. Integration with existing investigation, planning, routing, scheduling, review, and reflection workflows.
5. Behavioral tests, distinguishing mutations, and reproducible evidence.
6. A federation demonstration.
7. An operational report identifying exact commits, verified behaviors, limitations, and remaining dependencies.

Keep work in a separate qualified branch from unrelated active changes. Reuse existing components before constructing new ones.

Record decisions and lessons through OPHANIM's existing systems.

Do not implement five disconnected databases. Implement five specialized, interoperable knowledge domains with one coherent identity, evidence, and relationship contract.

Definition of success

OPHANIM must be able to receive an objective, discover how it relates to existing systems and prior work, identify the required capabilities and dependencies, organize qualified agents, construct and verify the result, and preserve what the experience taught it.

When something changes, it must know what that change may affect and what needs reassessment.

When something has already been learned, it must be able to find and apply that learning under the conditions where it remains valid.

The knowledge graphs are how OPHANIM develops and maintains an operational understanding of the systems it builds, the organization it serves, and itself.
