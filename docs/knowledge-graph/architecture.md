# Knowledge graphs: the architecture and relationship contract

**Contract** `ophanim.graph/v1`, contract version 1.2.0 (`packages/graph/schema.mjs` `GRAPH_SCHEMA`, `CONTRACT_VERSION`).
**Slice** A of the program the owner's directive of 2026-11-20 sets (`docs/knowledge-graph/directive-2026-11-20.md`): the shared graph foundation (its deliverable 2, and the foundation part of deliverable 3).
**Base** branch `kg/slice-a`, from `c14fed0` (the inventory `docs/knowledge-graph/inventory.md` and the Slice A ownership manifest).
**Decisions** KD1 to KD13 are the coordinator's (the Slice A brief). This document says how each is implemented; it does not reopen them.
**Integrated** slices A, B, C1 and E on `ophanim/knowledge-graphs`; section 19 indexes their documents and where each stands against section 15.

Two tables below, the relationship registry and the entity types, are generated from the code and kept equal to it by `packages/graph/tests/schema.test.mjs` ("registry: the contract document tabulates exactly ..."). A change to either is a change to `schema.mjs`, this document and the contract version together.

## 1. What this is, in one paragraph

OPHANIM's authoritative records stay where they are. A **registered source** (a ledger, a committed file) is **observed** by its **registered deterministic extractor**; the observation, not a copy of the facts, is appended to a `graph` domain on `packages/ledger`'s signed, hash-chained chain. What no source can re-derive (a tool's observation, a rule's derivation, an agent's or model's proposal, a contradiction) is appended there too. A **projection** replays that ledger in ledger order, re-deriving each observed source at the version it was observed at, into in-memory forward and reverse indexes with the full history of every assertion. It answers "as of" any cursor, has a **projection digest**, and serves **bounded, explained traversals**. A change to a source is one **change event**, ordered by ledger sequence and keyed by source and version; its **affected neighbourhood** is a reverse impact closure, never a global invalidation.

```
  registered sources                     graph ledger (packages/ledger chain, domain "graph")        projection (memory)
  (status/work/cycle ledgers,            ┌───────────────────────────────────────────────┐          ┌──────────────────────┐
   committed files, ...)                 │ genesis (operator, orderer; owner's keys)      │  replay  │ every assertion with │
        │  current()  ── version ──►     │ graph.assert    observation of S at V1  ◄──────┼──────────┤ [admitted, retired)  │
        │  readAt(V)  ◄─ re-derive ──    │ graph.assert    tool / rule / agent records │  in      │ forward + reverse    │
        ▼                                │ graph.supersede observation of S at V2      │  ledger  │ as-of(cursor) views  │
  extractor drafts ─► facts at V         │ graph.retract   a record's own origin       │  order   │ projection digest    │
                                         └───────────────────────────────────────────────┘          └──────────┬───────────┘
                                                                                                          traverse.mjs,
                                                                                                          events.mjs
```

## 2. The decisions as implemented

| Decision | Implemented in | How |
|---|---|---|
| KD1 technology | the whole package | the existing signed ledgers are the source events; a `graph` ledger domain holds what no source re-derives; in-memory forward and reverse indexes rebuilt by deterministic replay; bounded traversal. No new dependency, no graph server, no `node:sqlite`. |
| KD2 the package | `packages/graph/` | domain-free; imports only `packages/ledger` and `node:` built-ins. Rule: `ophanim/ledger/layering.test.mjs` "packages/graph imports only packages/ledger and Node built-ins". The domain adapter (`ophanim/graph/lessons.mjs`) imports `packages/graph`, never the reverse. |
| KD3 identity | `identity.mjs`, `schema.mjs` `idRefusal` | section 4 |
| KD4 the assertion record | `schema.mjs` `RECORD_FIELDS`, `recordRefusal`, `assertion` | section 5; the id is the digest of the canonical content without `observed_at` and `effective_at` |
| KD5 classification and admission | `schema.mjs` `ORIGIN_KINDS`, `defineOrigins`, `overrides`; `projection.mjs` `check` | section 6 |
| KD6 the relationship registry | `schema.mjs` `RELATIONSHIPS` | section 7 (the table is the code's) |
| KD7 storage and keys | `kinds.mjs` | section 8 |
| KD8 projection and replay | `projection.mjs`, `kinds.mjs` `openGraph`, `reconcile`, `recoverGraph` | section 8 |
| KD9 traversal | `traverse.mjs` | section 9 |
| KD10 change events | `events.mjs`; the cursor rule in `projection.mjs` | section 10 |
| KD11 concurrency | `kinds.mjs` `write`; `packages/ledger` `append` | section 11 |
| KD12 one real adapter | `ophanim/graph/lessons.mjs` | section 12 |
| KD13 not in this slice | — | section 15 |

## 3. Five domains, connected without collapsing

Five logical domains share one identity grammar, one assertion record and one relationship registry. Each keeps its own entity types (below), its own sources (each source has one registered extractor, which may project only that source), and its own update policy. A relationship may cross domains only where the registry names the pair: `requires-capability` joins work to capability, `implemented-by` capability to systems, `governed-by` systems to a contract, `verified-by` a contract to a test, `detects` a test to learning, `documented-in` learning to a lesson, `applies-to` learning back to systems or work. There is no store per domain and no store holding everything: one graph ledger per instance holds the observations and the non-source assertions, and the facts stay in their sources.

| Domain | Graph | Schema | Access rule (`scope.access`, default `internal`) | Update policy |
|---|---|---|---|---|
| `capability` | A | model, runtime, transport, tool, agent, capability, role, qualification, ... | internal; provider credentials are never graph data | sources: the model registry, lanes, facts, seating and fit tables (Slice C); `qualified-for` only from a measured observation or a rule over measurements, never from configuration |
| `systems` | B | repository, module, symbol, component, contract, test, suite, mutation, change, ... | internal | sources: the repository at a commit, suites, workflows, mutation tables read as text (Slice B) |
| `evidence` | C | requirement, document, source, observation, claim, hypothesis, decision, authorization, ... | internal or restricted (review material) | sources: the status, work and cycle ledgers read at pinned anchors (Slice B); observations are `observed` with their run; hypotheses are `hypothetical`; TELOS and the ledgers keep their authority |
| `learning` | D | defect, failure-class, failure-mechanism, repair, finding, lesson, detection-gap, ... | internal | source: the lessons registry (this slice, read only) and cycle findings (Slice D); `shares-failure-mechanism-with` never from similar text |
| `work` | E | prompt, item, ticket, plan, work-unit, team, lease, budget, request, artifact, review, ... | internal | sources: intake, tickets, plans, the work ledger (Slice D); the graph never writes the work ledger |

`scope` (`{access, owner}`) is carried by every assertion and enforced by nothing in this slice: access-controlled queries and projections across instances are Slice E's. As integrated, Slice E enforces it on every federation export (public with its details, internal as a reference, restricted withheld; register KG-3, `slice-e.md`); queries inside one instance do not filter by it.

### Entity types

<!-- entity-types:begin -->
| Domain | Graph | Type | Meaning |
|---|---|---|---|
| `capability` | A | `provider` | a model provider or vendor |
| `capability` | A | `lab` | an independent laboratory, the unit of review independence |
| `capability` | A | `model` | a model identity at a version |
| `capability` | A | `runtime` | an SDK, CLI or execution runtime |
| `capability` | A | `transport` | a request transport (API, CLI, relay) |
| `capability` | A | `tool` | a tool an agent may use |
| `capability` | A | `agent` | an agent or seat that executes or reviews work |
| `capability` | A | `environment` | an execution environment (sandbox, host) |
| `capability` | A | `capability` | an executable model/runtime combination with the constraints under which it works |
| `capability` | A | `feature` | a feature a runtime or model provides (native subagents, an effort level) |
| `capability` | A | `role` | a work role (planner, implementer, reviewer, validator) |
| `capability` | A | `qualification` | a qualification record, established only from measured evidence |
| `capability` | A | `limitation` | a known limitation or constraint |
| `capability` | A | `pool` | an availability or quota pool |
| `capability` | A | `lane` | a named serving variant of a model on one transport at a fixed setting (an Antigravity lane name); not a model of its own |
| `capability` | A | `chair` | a roster chair: a named seat position, the roles it holds and the vendors that may occupy it |
| `capability` | A | `placement` | an owner- or operator-directed placement of a model in a role (a seating-table row, an ARGO seat, a fit-matrix cell), with its declared basis; a direction, never a measurement |
| `systems` | B | `enterprise` | an enterprise |
| `systems` | B | `department` | a department |
| `systems` | B | `process` | a business process |
| `systems` | B | `application` | an application |
| `systems` | B | `repository` | a source repository |
| `systems` | B | `module` | a module or source file of code |
| `systems` | B | `symbol` | a function, class or exported symbol |
| `systems` | B | `file` | a file that is not code (data, configuration, document) |
| `systems` | B | `component` | a reusable component |
| `systems` | B | `service` | a running service |
| `systems` | B | `api` | an API |
| `systems` | B | `interface` | an interface or handoff |
| `systems` | B | `datastore` | a database or store |
| `systems` | B | `dataset` | a table, view or dataset |
| `systems` | B | `schema` | a data or record schema |
| `systems` | B | `transformation` | a transformation |
| `systems` | B | `pipeline` | a pipeline |
| `systems` | B | `contract` | a contract |
| `systems` | B | `invariant` | an invariant |
| `systems` | B | `test` | a test or acceptance check |
| `systems` | B | `suite` | a test suite |
| `systems` | B | `mutation` | a mutation target |
| `systems` | B | `workflow` | a CI or operating workflow |
| `systems` | B | `deployment` | a deployment environment |
| `systems` | B | `change` | a commit or change set |
| `systems` | B | `package` | a package code imports or a manifest declares: an npm package at the version its lockfile resolved, a workspace package, or a runtime built-in |
| `systems` | B | `environment-variable` | an environment variable, by its NAME only (never its value) |
| `systems` | B | `executable` | a program code runs by name |
| `systems` | B | `host` | a network host a request names |
| `evidence` | C | `requirement` | an original requirement |
| `evidence` | C | `document` | a source document |
| `evidence` | C | `source` | a registered source and the version last observed of it |
| `evidence` | C | `observation` | an observation, with its run |
| `evidence` | C | `evidence` | a piece of retrieved or delivered evidence |
| `evidence` | C | `claim` | a stated claim |
| `evidence` | C | `hypothesis` | a hypothesis or competing explanation |
| `evidence` | C | `investigation` | an investigation |
| `evidence` | C | `experiment` | an experiment, test or reproduction run |
| `evidence` | C | `decision` | a decision |
| `evidence` | C | `authorization` | an authorization |
| `evidence` | C | `conclusion` | a conclusion |
| `evidence` | C | `record` | an execution or verification record |
| `learning` | D | `defect` | an observed defect or unexpected behaviour |
| `learning` | D | `symptom` | a symptom |
| `learning` | D | `trigger` | a trigger or contributing factor |
| `learning` | D | `cause` | a proposed or established cause |
| `learning` | D | `reproduction` | a reproduction or negative test |
| `learning` | D | `mutation-outcome` | a mutation-testing outcome |
| `learning` | D | `repair` | a repair, mitigation or rejected alternative |
| `learning` | D | `finding` | a reviewer finding |
| `learning` | D | `lesson` | a lesson with its applicability conditions |
| `learning` | D | `failure-class` | a recurring failure class (the lessons registry's unit) |
| `learning` | D | `failure-mechanism` | an underlying failure mechanism shared by defects |
| `learning` | D | `detection-gap` | a known detection gap |
| `work` | E | `prompt` | an original prompt |
| `work` | E | `item` | an authorized work identity (a status item) |
| `work` | E | `ticket` | a ticket |
| `work` | E | `plan` | a plan |
| `work` | E | `work-unit` | a work unit |
| `work` | E | `team` | a team |
| `work` | E | `assignment` | an assignment of a role |
| `work` | E | `lease` | an execution lease or claim |
| `work` | E | `worktree` | a worktree |
| `work` | E | `budget` | a resource budget |
| `work` | E | `request` | a provider request |
| `work` | E | `usage` | resource usage |
| `work` | E | `execution` | an execution or attempt |
| `work` | E | `checkpoint` | a checkpoint |
| `work` | E | `artifact` | a produced artifact |
| `work` | E | `review` | a review |
| `work` | E | `validation` | a validation |
| `work` | E | `obligation` | a completion condition or unresolved obligation |
| `work` | E | `discovery` | a discovery that creates, revises or invalidates work |
<!-- entity-types:end -->

## 4. Identity

A stable id is `<instance>/<domain>/<type>/<key>`.

| Part | Rule |
|---|---|
| `instance` | `[a-z][a-z0-9-]{0,31}`; default `ophanim` |
| `domain` | one of `capability`, `systems`, `evidence`, `learning`, `work` (the directive's graphs A to E) |
| `type` | an entity type registered for that domain (table above) |
| `key` | the source's own stable key, at most 512 characters of URI path characters: `/` separates segments (no empty, `.` or `..` segment), everything else is percent-encoded. `encodeKey` encodes a raw key; `decodeKey` returns it. Example: the detector test `pantheon/tests/output-cap-serialized.test.mjs#fit output` is `ophanim/systems/test/pantheon/tests/output-cap-serialized.test.mjs%23fit%20output`. |

An id that does not parse, or names an unregistered domain or type, is refused (`idRefusal`). A relationship has no id of its own: its subject is `<type>(<from> -> <to>)`, with the endpoints ordered for a symmetric type, so `contradicts(a, b)` and `contradicts(b, a)` are one relationship.

A **version** is a source digest (`sha256:` over canonical JSON through `packages/ledger/canonical.mjs`, the one canonical form) or a source's own immutable id: a git object id (40 or 64 hex) or a ledger entry hash. A branch name or a time is not a version.

## 5. The assertion record

Every field is present in every record (null or empty where it does not apply); a record with any other field is refused.

| Field | Meaning | Rule |
|---|---|---|
| `schema` | `ophanim.graph/v1` | |
| `id` | the assertion id | `sha256:` digest of the canonical record without `id`, `observed_at` and `effective_at`. The same assertion observed again is the same id: its second append is a no-op. |
| `kind` | `entity` or `relationship` | |
| `subject` | the entity id, or the relationship subject | |
| `domain`, `type` | entity: its domain and entity type (they must be the id's); relationship: `domain` null, `type` the relationship type | |
| `from`, `to` | relationship: the endpoints, direction from → to; entity: null | endpoints are registered ids whose types the registry allows |
| `source` | `{id, authority, ref, version}`: the source, its authority, the canonical source reference, the source version or digest | authoritative and observed assertions name a version; a hypothetical without one states its missing evidence |
| `observed_at`, `effective_at` | when the origin observed it; when it took effect in the source (or null) | ISO-8601 UTC; not part of the id |
| `origin` | the registered agent, model, tool, rule or deterministic extractor | must be in the composed origin registry, and the entry's author key must be one the origin names |
| `classification` | `authoritative`, `observed`, `derived` or `hypothetical` | section 6 |
| `status`, `verified_by` | qualification or verification status: `unverified`, `verified` (names what verified it), `unresolved` | a hypothetical is never `verified`; `unresolved` is current but never established |
| `scope` | `{access: public / internal / restricted, owner: instance}` | |
| `supersedes`, `invalidates` | assertion ids this one replaces, or makes no longer valid | stateful rules, section 6 |
| `uncertainty`, `missing_evidence` | stated uncertainty; the conditions of missing evidence | a class without a detector says so here |
| `inputs` | a derived assertion's input assertions | required for, and only for, `derived` |
| `run` | an observed assertion's run identity `{id, ...}` | required for, and only for, `observed` |
| `attributes` | the entity's or relationship's properties | canonical JSON, at most 32 KiB (a source observation: 2 MiB) |

A **retraction** is its own record `{schema, id, kind: retraction, retracts, origin, reason, observed_at}`, its id computed the same way.

## 6. Classification and admission

Four classifications, never merged:

| Classification | Who may admit it | What it is |
|---|---|---|
| `authoritative` | a registered **extractor**, for a source it is registered for, only by OBSERVING that source | projected deterministically from an authoritative source at a version. It is never written to the graph ledger record by record: the ledger holds the observation and replay re-derives the facts (a direct authoritative write is refused, `GRAPH_SOURCE`). |
| `observed` | a registered **tool** | a recorded observation (a test or mutation result, a trace), with its run |
| `derived` | a registered **rule** | computed from other assertions, which it names (`inputs`); recomputable. Once an input is no longer established, the derived assertion is current but stale, not established. |
| `hypothetical` | **anyone registered** (agent, model, and the above) | a proposal |

Origins are composed by the reader (`defineOrigins`), like the ledger's kind registry: `{id: {kind, basis, keys, sources}}`. The **basis** is how the origin knows: `declared` (a source states it), `structural` (parsed from structure), `measured` (a run measured it), `textual` (text matched), `inferred` (a model or agent concluded it). Extractors know by declared, structural or textual bases; tools by measured; rules by any but inferred; agents and models only by inferred. Each relationship type lists, per classification, the bases it may be admitted from (the registry's last column). So `depends-on`, `shares-failure-mechanism-with`, `qualified-for`, `introduced-because-of` and `applies-to` are never admitted from a textual or an inferred basis: text is a `mentions`, a model's inference stays hypothetical until an extractor or rule establishes it, and `qualified-for` is admitted only from measured evidence (never from configuration or preference; `eligible-for` carries a documented basis without a claim of measurement).

The stateful rules, checked in re-derivation under the ledger's lock (`projection.mjs` `check`):

- **Duplicates**: an assertion or retraction id already recorded is refused (`GRAPH_DUPLICATE`); the writer drops it first, so a repeat is a no-op.
- **References**: a relationship's endpoints must be present; a non-hypothetical relationship's endpoints must be established (non-hypothetical). A derived assertion's inputs must be current. Otherwise `GRAPH_REFERENCE`, refused. (Replaying an entry already on the ledger while a source cannot be read is the one exception: the reference is noted as not re-derived, the ledger's `partial`, and the edge stays recorded, orphaned. A new write is always strict.)
- **Supersession** replaces a current assertion of the same subject, by the same origin. Another origin's disagreement is a contradiction, never an overwrite.
- **A hypothetical never supersedes, invalidates or retracts a non-hypothetical assertion** (`overrides`, `GRAPH_HYPOTHETICAL`), and is never returned as established.
- **Retraction** is by the assertion's own origin. A source's facts change only by observing the source again; they are never retracted, superseded or invalidated by a graph entry.
- **Contradictions keep both sides.** `contradicts` (symmetric, not followed by impact) links two claims; both stay current and established if they were; `traverse.mjs` `contradictions` returns the whole set, hypothetical sides included and marked, each member with its supporting assertions. Two origins asserting different values for one subject are both kept: `view.node(id).conflicts` lists every disagreeing attribute with each value's assertion, and the value shown is the strongest classification's, so a hypothesis never changes it.

**The directive's four categories are query modes, not one state** (`view.query(subject, mode)`):

| Directive | Mode | Returns |
|---|---|---|
| what was recorded | `recorded` | every assertion admitted up to the cursor, with what ended it (superseded, retracted, invalidated, withdrawn by its source) |
| what is currently established | `established` | current, not hypothetical, not unresolved, endpoints established, derived inputs established |
| what could be true | `possible` | current but not established, each with why (hypothetical, unresolved, orphaned, stale) |
| what may change | `transitions` | for each current assertion, the transitions the admission rules authorize, and by whom |

Traversals take a mode too: `established` by default, `possible` or `recorded` when asked.

## 7. The relationship registry

Impact says which endpoint a CHANGE reaches: `to → from` (A `depends-on` B: when B changes, A is affected), `from → to` (K `governs` C: when K changes, C is affected), or not followed (`contradicts`, `supersedes`, `qualified-for`, `eligible-for`, `contributed-to`, `shares-failure-mechanism-with`, `mentions`). An inverse pair swaps the endpoints and mirrors the impact. Endpoint patterns are `domain/type`, `domain/*` (any type of the domain) or `*`. "Admitted as" lists, per classification, the bases it may be admitted from. A type absent from a classification is refused in it. An unregistered type, or an endpoint of a type the row does not allow, is refused.

The types beyond the directive's list and its examples: `runs-in` and `eligible-for` (the directive's Graph A examples) and `mentions` (the inventory's home for textual relations, so that they are never read as dependencies). Slices that need more types add them by a reviewed change to `schema.mjs` and this table, with a new contract version.

<!-- relationship-registry:begin -->
| Type | Meaning | From (domain) | To (range) | Symmetric | Inverse | Impact | Admitted as |
|---|---|---|---|---|---|---|---|
| `implements` | the source realizes the target requirement, contract, interface, capability or work obligation | `systems/*`, `work/artifact`, `work/work-unit`, `capability/runtime`, `capability/tool`, `capability/capability`, `learning/repair` | `evidence/requirement`, `systems/contract`, `systems/interface`, `systems/invariant`, `systems/api`, `capability/capability`, `capability/feature`, `work/ticket`, `work/item`, `work/obligation`, `work/plan` | no | `implemented-by` | from → to | authoritative: declared, structural; observed: measured; derived: declared, structural; hypothetical: any basis |
| `implemented-by` | the source requirement, contract, interface, capability or obligation is realized by the target | `evidence/requirement`, `systems/contract`, `systems/interface`, `systems/invariant`, `systems/api`, `capability/capability`, `capability/feature`, `work/ticket`, `work/item`, `work/obligation`, `work/plan` | `systems/*`, `work/artifact`, `work/work-unit`, `capability/runtime`, `capability/tool`, `capability/capability`, `learning/repair` | no | `implements` | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural; hypothetical: any basis |
| `depends-on` | the source cannot be correct or complete without the target | `systems/*`, `work/*`, `capability/*` | `systems/*`, `work/*`, `capability/*`, `evidence/requirement`, `evidence/authorization`, `evidence/decision` | no | — | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `consumes` | the source reads or uses the target as an input | `systems/*`, `work/*`, `capability/agent`, `capability/tool`, `capability/runtime` | `systems/*`, `work/artifact`, `evidence/*`, `capability/*` | no | — | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `produces` | the source creates or writes the target as an output | `systems/*`, `work/*`, `capability/agent`, `capability/tool`, `capability/runtime` | `systems/*`, `work/artifact`, `evidence/*` | no | — | from → to | authoritative: declared, structural; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `governs` | the source contract, invariant, authorization, decision or requirement constrains the target | `systems/contract`, `systems/invariant`, `evidence/authorization`, `evidence/decision`, `evidence/requirement` | `systems/*`, `work/*`, `capability/*` | no | `governed-by` | from → to | authoritative: declared; derived: declared; hypothetical: any basis |
| `governed-by` | the source is constrained by the target contract, invariant, authorization, decision or requirement | `systems/*`, `work/*`, `capability/*` | `systems/contract`, `systems/invariant`, `evidence/authorization`, `evidence/decision`, `evidence/requirement` | no | `governs` | to → from | authoritative: declared; derived: declared; hypothetical: any basis |
| `authorizes` | the source authorization or decision permits the target to exist or proceed | `evidence/authorization`, `evidence/decision` | `work/*`, `systems/change`, `evidence/decision`, `capability/*` | no | — | from → to | authoritative: declared; derived: declared; hypothetical: any basis |
| `verifies` | the source check establishes, by running, whether the target holds | `systems/test`, `systems/suite`, `systems/mutation`, `evidence/observation`, `evidence/experiment`, `evidence/investigation`, `work/validation`, `work/review` | `systems/*`, `evidence/requirement`, `evidence/conclusion`, `evidence/claim`, `capability/*`, `work/*`, `learning/repair` | no | `verified-by` | from → to | authoritative: declared; observed: measured; derived: declared, measured; hypothetical: any basis |
| `verified-by` | the source is established, by running, by the target check | `systems/*`, `evidence/requirement`, `evidence/conclusion`, `evidence/claim`, `capability/*`, `work/*`, `learning/repair` | `systems/test`, `systems/suite`, `systems/mutation`, `evidence/observation`, `evidence/experiment`, `evidence/investigation`, `work/validation`, `work/review` | no | `verifies` | to → from | authoritative: declared; observed: measured; derived: declared, measured; hypothetical: any basis |
| `derived-from` | the source was computed, copied or built from the target | `*` | `*` | no | — | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural; hypothetical: any basis |
| `supports` | the source provides positive support for the target: evidence that bears out a claim, or a runtime that provides a feature; never a dependency | `evidence/*`, `learning/*`, `work/review`, `work/validation`, `capability/qualification`, `systems/test`, `capability/runtime`, `capability/model` | `evidence/*`, `learning/*`, `work/review`, `work/validation`, `capability/qualification`, `work/plan`, `capability/feature` | no | — | from → to | authoritative: declared; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `contradicts` | the source and the target cannot both hold; both are kept and retrievable as a contradiction set | `evidence/*`, `learning/*`, `work/review`, `work/validation`, `capability/qualification` | `evidence/*`, `learning/*`, `work/review`, `work/validation`, `capability/qualification` | yes | — | not followed | authoritative: declared; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `supersedes` | the source replaces the target, an entity of the same domain and type, which stays in the record (same domain and type) | `*` | `*` | no | — | not followed | authoritative: declared, structural; derived: declared, structural; hypothetical: any basis |
| `introduced-because-of` | the source exists because of the target requirement, finding, failure or decision | `systems/*`, `work/*`, `capability/*`, `learning/repair`, `learning/lesson`, `evidence/decision` | `evidence/*`, `learning/*`, `work/ticket`, `work/item`, `work/prompt` | no | — | to → from | authoritative: declared; derived: declared; hypothetical: any basis |
| `invalidates` | the source makes the target no longer valid; the target stays in the record | `systems/change`, `evidence/observation`, `evidence/decision`, `learning/finding`, `work/discovery` | `capability/qualification`, `evidence/*`, `work/*`, `learning/*` | no | — | from → to | authoritative: declared; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `qualified-for` | the source is qualified for the target role on measured evidence; never from configuration or preference | `capability/model`, `capability/capability`, `capability/agent`, `capability/runtime`, `capability/tool`, `work/team` | `capability/role` | no | — | not followed | observed: measured; derived: measured; hypothetical: any basis |
| `eligible-for` | the source may be assigned the target role under a documented basis, without a claim of measured qualification | `capability/model`, `capability/capability`, `capability/agent`, `capability/runtime`, `capability/tool`, `work/team` | `capability/role` | no | — | not followed | authoritative: declared; derived: declared, measured; hypothetical: any basis |
| `contributed-to` | the source contributed to the target | `capability/agent`, `capability/model`, `capability/capability`, `work/team` | `work/*`, `evidence/*`, `learning/*`, `systems/*` | no | — | not followed | authoritative: declared; observed: measured; derived: declared; hypothetical: any basis |
| `shares-failure-mechanism-with` | the source and the target fail by one established mechanism; never inferred from similar symptoms or text | `learning/defect`, `learning/failure-class`, `learning/finding` | `learning/defect`, `learning/failure-class`, `learning/finding` | yes | — | not followed | authoritative: declared; observed: measured; derived: declared, measured; hypothetical: any basis |
| `requires-capability` | the source work or component needs the target capability to be done or to run | `work/*`, `systems/*` | `capability/capability`, `capability/feature`, `capability/runtime`, `capability/tool`, `systems/component`, `systems/service`, `systems/api`, `systems/interface` | no | — | to → from | authoritative: declared; derived: declared, structural; hypothetical: any basis |
| `detects` | the source check fails when the target failure occurs | `systems/test`, `systems/suite`, `systems/mutation`, `evidence/observation`, `work/review` | `learning/*` | no | — | from → to | authoritative: declared; observed: measured; derived: declared, measured; hypothetical: any basis |
| `documented-in` | the source is recorded or explained in the target document or lesson | `*` | `evidence/document`, `learning/lesson`, `learning/failure-class`, `systems/file` | no | — | from → to | authoritative: declared, structural; derived: declared, structural; hypothetical: any basis |
| `applies-to` | the source lesson, failure or repair applies to the target, under its stated conditions | `learning/lesson`, `learning/failure-class`, `learning/failure-mechanism`, `learning/repair` | `systems/*`, `work/*`, `capability/*` | no | — | from → to | authoritative: declared; derived: declared, measured; hypothetical: any basis |
| `runs-in` | the source model, agent or tool executes in the target runtime, environment or transport | `capability/model`, `capability/agent`, `capability/tool` | `capability/runtime`, `capability/environment`, `capability/transport` | no | — | to → from | authoritative: declared; observed: measured; derived: declared; hypothetical: any basis |
| `mentions` | the source text names the target; a textual relation, never a dependency, cause or qualification | `*` | `*` | no | — | not followed | authoritative: textual, declared; derived: textual, structural; hypothetical: any basis |
| `made-by` | the source model was made by the target laboratory: lineage and the reviewer-exclusion input, never a restriction on who may do the work | `capability/model` | `capability/lab` | no | — | not followed | authoritative: declared; derived: declared; hypothetical: any basis |
| `served-by` | the source model, lane or executable capability is served through the target provider, transport or credential pool | `capability/model`, `capability/lane`, `capability/capability` | `capability/provider`, `capability/transport`, `capability/pool` | no | — | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural; hypothetical: any basis |
| `alias-of` | the source name denotes the target model (a thinking or effort variant, a lane name, an alias); it is not another model | `capability/lane`, `capability/model` | `capability/model` | no | — | to → from | authoritative: declared, structural; derived: declared, structural; hypothetical: any basis |
| `limited-by` | the source is constrained by the target known limitation, which carries its source and quote; a limitation is never read as a capability | `capability/capability`, `capability/runtime`, `capability/transport`, `capability/tool`, `capability/environment`, `capability/model`, `capability/lane`, `capability/pool`, `capability/agent` | `capability/limitation` | no | — | to → from | authoritative: declared, structural; observed: measured; derived: declared, structural, measured; hypothetical: any basis |
| `combines` | the source executable capability is the combination of the target model or lane, runtime, transport, tool, sandbox profile (environment) or credential scope (pool); each stays its own entity | `capability/capability` | `capability/model`, `capability/lane`, `capability/runtime`, `capability/transport`, `capability/tool`, `capability/environment`, `capability/pool` | no | — | to → from | authoritative: declared, structural; derived: declared, structural; hypothetical: any basis |
| `holds` | the source roster chair holds the target role | `capability/chair` | `capability/role` | no | — | not followed | authoritative: declared; derived: declared; hypothetical: any basis |
| `places` | the source owner- or operator-directed placement names the target role, or the model, lane or executable capability placed in it; a direction, never a measurement or a qualification | `capability/placement` | `capability/role`, `capability/model`, `capability/lane`, `capability/capability` | no | — | to → from | authoritative: declared; derived: declared; hypothetical: any basis |
| `measures` | the source observation is a defined metric over the recorded executions of the target (its sources and coverage stated); never a qualification | `evidence/observation` | `capability/capability`, `capability/model`, `capability/lane`, `capability/runtime`, `capability/transport`, `capability/role` | no | — | not followed | observed: measured; derived: measured; hypothetical: any basis |
<!-- relationship-registry:end -->

## 8. Storage, keys, replay and the projection

**The ledger.** `createGraphLedger` writes a genesis that declares the domain `graph` with the kinds `graph.assert` (new assertions, none superseding), `graph.supersede` (each record names what it replaces) and `graph.retract` (retraction records). Each entry carries 1 to 1,000 records, is signed by its author's key and co-signed by the orderer, hash-chained, fsynced, and re-derived before it is written and on every verify. A source observation is recorded alone in its entry. Nothing is deleted; supersession and retraction are new entries; every earlier state stays queryable. The kinds can also be composed into another ledger: a reader that does not supply the graph domain checks its entries structurally only (`packages/ledger` domains).

**Keys.** Signing takes the signer and orderer interface the other ledgers use (`generateSigner`, `keyStore`). The origin registry maps each origin to the key ids that may write as it. Tests use synthetic keys generated per test. **Production key custody for the graph domain is the owner's decision** (section 16): this slice names no production key.

**Source observation.** A source adapter is `{id, extractor, authority, ref, current() → {version}, readAt(version) → drafts}`. `observe(source)` reads the current version, re-derives the facts there through the registered extractor (each fact validated as an `authoritative` record of that source), diffs them against the facts the graph holds for that source, and appends ONE observation record: the source node `evidence/source/<source id>` with `{state: current, digest, count, from_version, changes: {count, digest, listed}, nodes, relationships}`. The changed subjects are listed while there are at most 10,000 of them; beyond that only their count and digest are recorded and replay re-derives the list from the two versions (bounded storage; a replay that cannot read the source reports the changes as unknown, `events.test.mjs` "bounded"). An unchanged fact keeps the assertion of the version that last changed it.

**Replay.** `openGraph` replays the ledger by verifying it: the ledger's re-derivation hook is the projection's `sync`, so every entry is checked against the state before it and then applied, in ledger order. An observation is re-derived by asking the source for that version again; its digest and changed subjects must match what was recorded (a mismatch on a source that re-derived the earlier versions is refused, `GRAPH_SOURCE`). A source that cannot be read at replay is marked (`replay: unavailable`, the ledger's `partial`), and its facts are absent, not assumed. A refresh re-verifies the frontier and catches up on what other processes appended.

**The projection.** Every assertion ever admitted, with the seq that admitted it and, once retired, the seq, how (superseded, retracted, invalidated, withdrawn by its source) and by what; forward and reverse incidence per node. `view(cursor)` is the graph as of any ledger seq: a filter over that history, so as-of is exact. **The projection digest** at a cursor is `sha256` over the cursor, the head hash, every assertion's interval sorted by assertion id, the retractions and the source states. The same records give the same digest in any process; the order a source yields its facts in does not change it.

**Reconciliation.** `reconcile()` replays the ledger from nothing into a fresh projection and compares it with the incremental one at the incremental one's cursor: whether it is equal, ahead (it holds something the ledger does not) or behind, and the differing assertions (bounded by `limit`). Nothing is changed.

**Recovery** (from pull request 70). `recoverGraph` opens a ledger that verifies as it is. One that does not is never repaired: its directory is renamed aside whole (`<dir>.set-aside-<n>`) and a new graph ledger is created, with the authority the caller holds, and rebuilt by observing every registered source. What the sources re-derive comes back; what only the set-aside ledger held (tool observations, derivations, proposals) is not trusted and not carried over: it stays in the set-aside directory for inspection. A ledger pinned to another genesis is not set aside (`GRAPH_FOREIGN`).

## 9. Traversal

| Operation | What |
|---|---|
| `neighborhood(view, start, opts)` | bounded k-hop over any registered type (or those asked), out, in or both |
| `closure(view, start, {direction})` | typed transitive closure along the impact-following types only: `reverse` is what a change to the seeds reaches, `forward` what the seeds rest on. Asking for a non-impact type does not add it. |
| `contradictions(view, start)` | the contradiction set |
| `affected(projection, event)` | section 10 |

Defaults (the coordinator's; the owner may change them): depth 4, 500 nodes, 2,000 edges (steps examined). Ceilings no caller can lift: depth 16, 10,000 nodes, 50,000 edges. Every walk is breadth-first and deterministic at its cursor (seeds sorted, steps sorted by relationship subject). Every result reports its coverage (`truncated`, the `limit` hit, the bounds, what was returned and examined, and the sources of the result that are not current) and a `continuation`: after a node or edge cut it resumes the same walk exactly where it stopped; after a depth cut it continues deeper (doubling the depth, up to the ceiling) and returns only what is new. Every result node carries its **explained path**, the relationships from a seed with the assertions supporting each, and its own supporting assertions with their classification, origin and source version.

## 10. Change events, freshness and the cursor rule

**An event** is a source observation: `{seq, key, source, from_version, to_version, state, nodes, relationships}`, key `<source>@<version>` (an `unavailable` or `stale` record: `<source>@<version>#<state>@<seq>`). An entry of the graph ledger's own (a tool's, a rule's, an agent's) is an event of source `graph`, keyed by its entry hash, naming the subjects it asserted or retracted. Events are ordered by ledger seq; a consumer reads them with `events({after: cursor, limit})` and keeps the returned `cursor`. A repeated observation of the same version, and the same state, is not an event.

**The affected neighbourhood** of an event (`affected`) is the reverse impact closure of what changed (each changed entity; for a changed relationship, its dependent end), taken both just before and just after the change, so that a withdrawn node's dependents are found where it still was; plus the relationships incident to a changed entity (its verifications, governing contracts, mentions), named for reassessment without being declared invalid. Bounded and explained like every traversal; never a global invalidation.

**The cursor rule** (from pull request 70): one observation per step of one source's cursor. An observation is admitted only when it starts where that source's last admitted observation ended (its `from_version` is that observation's version, and it supersedes exactly that observation), checked in re-derivation under the ledger's append lock. So a source's events have no gap, no overlap and no reordering: an observation computed on an older state is refused as stale (`GRAPH_STALE`) and the writer reads again; two writers on one change record it once.

**Freshness.** Nothing runs by itself: a source is current only as of its last observation. `freshness()` reads each source's current version now and reports `current`, `stale` (it moved since, or its last observation recorded it so), `unavailable` (it cannot be read) or `never-observed`, with `synchronization: on observation only`. Observing an unreadable source records it `unavailable`; a version the extractor cannot project is recorded `stale` with the version and why; in both, its facts stay as last observed, marked, and the record says what is missing. No source is claimed to be continuously synchronized.

## 11. Concurrency

Two processes appending to one graph ledger go through `packages/ledger`'s append discipline: its exclusive lock file, verification of the head under it, and re-derivation of the new entry against everything before it. A duplicate is refused there, so the writer that loses the race finds it recorded and returns a no-op; a write refused because the state moved under it (a stale supersession, a stale observation) is recomputed on the newer state, a bounded number of times. Readers take no lock. Proven with two real processes in `packages/graph/tests/concurrency.test.mjs`: shared records and edges recorded once, every own record present, the shared source change observed once.

## 12. The source adapter (KD12)

`ophanim/graph/lessons.mjs` projects the lessons registry, `ophanim/lessons/corrections.json` (`ophanim.owner-corrections/v1`), read only:

| Fact | From | Notes |
|---|---|---|
| `learning/failure-class/<class id>` | each class | the class text, source, fix, detector and instances as attributes; a class without an executable detector, or without a fix, carries that as missing evidence |
| `systems/test/<file>#<name>` | each test detector | the registry names a test by a SUBSTRING of its name; the test case itself is the systems graph's to resolve (Slice B) |
| `detects` test → class | each test detector | |
| `systems/change/<commit>` | each `fixed_in` | the systems graph resolves the commit (Slice B) |
| `introduced-because-of` change → class | each `fixed_in` | |

The version is the file's git blob id (the object id git gives those bytes; equal to `git rev-parse HEAD:<file>` when the file is as committed). `readAt` reads the working file when it is that version, else `git cat-file blob <version>`, so a replay re-derives every version from git. On this checkout: 19 classes, 12 test detectors, 13 fixes; 69 facts.

## 13. Measured

On this container (Node v24.22.1). The adapter numbers are from `ophanim/graph/lessons.test.mjs` (its diagnostic line), the synthetic ones from `node packages/graph/bench.mjs` (synthetic keys, a temporary ledger).

| What | Time |
|---|---|
| Lessons registry, real data (69 facts): first observation (extractor, diff, append) | 32 to 45 ms |
| Lessons registry: replay by a fresh open | 13 to 14 ms |
| Synthetic source, 60,000 nodes and 240,000 edges: first observation | 15.3 s |
| the same: replay (re-deriving all 300,000 facts, one ledger entry) | 12.7 s |
| the same: projection digest | 1.3 s |
| 3-hop neighbourhood at the defaults (cut at 500 nodes) | 12.6 ms |
| reverse impact closure at the defaults (cut at depth 4, 303 nodes) | 18.1 ms |
| reverse impact closure at the ceilings (cut at 10,000 nodes) | 247 ms |
| Graph ledger of 2,000 entries of 10 tool observations: append, per entry | 15.3 ms |
| the same: replay (20,000 assertions) | 1.9 s |

Replay costs about 40 µs a fact, almost all of it the canonical digest of each re-derived fact (its id) and its validation: re-derivation, not indexing, is the cost. At the inventory's estimate for OPHANIM (about 5,400 nodes and 11,000 edges) that is about 0.7 s per start; at the inventory's probe scale it is 12.7 s, against 258 ms for bare JSONL. The upgrade path, if replay at start becomes the bottleneck, is a signed projection checkpoint keyed by the ledger head and the source versions (a derived cache, never authoritative), the same shape as the inventory's option 2.

## 14. Incorporated from pull request 70

Pull request 70 (branch `ccr-3b496a5e-q1czrf`, on pull request 68) is integration input; its comparison record is `docs/knowledge-graph/pr70-integration-input.md` on that branch. Read only; nothing was merged or cherry-picked, and its code was not imported.

| PR 70 behaviour | Here | |
|---|---|---|
| 2. The cursor rule: a batch is admitted only when its `from` is where its source's last batch ended, under the append lock | **taken**, on this slice's own kinds: the observation record's `from_version` and its supersession of the last observation, checked in re-derivation (`projection.mjs` `cursorRefusal`). Test: `events.test.mjs` "cursor rule"; mutation G21. | The case it adds over digest idempotency: an older reading that lands after a newer one and whose changes happen to re-derive against the newer state. |
| 3. Recovery: a ledger that does not verify is set aside whole and rebuilt from the sources; a healthy one is opened as it is | **taken** (`kinds.mjs` `recoverGraph`). Test: `replay.test.mjs` "recovery"; mutation G24. | What differs: here the graph ledger also holds assertions no source re-derives. They are not carried into the rebuilt ledger (they come from a ledger that does not verify) and stay in the set-aside directory. |
| 11. Freshness: current, stale, unavailable, never read; an absent source is not applied as nothing | **taken** as `freshness()` with `never-observed`; already covered by the recorded `unavailable` and `stale` states. Test: `events.test.mjs` "freshness"; mutation G26. | |
| 4. Order-independent digest; incremental equals one reading | already covered (KD8): `replay.test.mjs` "the digest is the same whatever order", "reconciliation". | |
| 5. History, supersession, retraction, `at(seq)`, changes since | already covered: `ledger.test.mjs` "history", `events.test.mjs` "events". | |
| 7. Contradictory evidence: every value kept, the strongest class's shown, a hypothesis never changes it, conflicts listed | already covered by contradiction sets; the per-attribute `conflicts` and the shown value were added (`view.node`). Test: `ledger.test.mjs` "contradictions". | |
| 8. What a model or agent says is hypothetical and unverified | already covered (KD5): agents and models admit nothing but hypothetical, which is never verified. | |
| 9, 10. Bounded traversal with ceilings; impact by each relationship's meaning | already covered (KD9, KD6). | |
| 12. A reader without the writer's key can verify and query, not write | follows from `packages/ledger`. | |
| Ledger shape: one `graph.batch` kind per cursor step | **not taken**: the three kinds stand (KD7); the behaviour the batch gave (behaviour 2) holds without it. | |
| A broken reference admitted and listed as unresolved | **not taken**: a new write with a broken reference is refused (KD7, demonstration 12). An edge left without an endpoint by a later change is kept and shown orphaned, and on a replay that cannot read a source it is kept and noted. | |
| 1. Mutation runners read as text; 6. targeted readings per file | left to Slice D and Slice B, as the coordinator assigned. | |

## 15. Left to slices B to E

The interfaces they build on: a source adapter (`{id, extractor, authority, ref, current, readAt}`) and its origin registration; `openGraph({dir, anchor, origins, sources})`; `observe`, `assert`, `supersede`, `retract`; `view(cursor)` and its query modes; `neighborhood`, `closure`, `contradictions`, `affected`; `events` with a cursor; `freshness`; `reconcile`; `recoverGraph`.

| Slice | Supplies |
|---|---|
| B, systems and evidence | the repository extractor at a commit (files, symbols, imports, tests), suites and workflows, mutation tables read as text, the status, work and cycle ledgers read at pinned anchors; resolving the lessons adapter's `systems/test` and `systems/change` nodes; a `graph` retrieval op and dossier view in `ophanim/operate/context.mjs`; the root `test:proof` glob for `ophanim/graph/*.test.mjs` |
| C, capability | model, lane, transport, runtime, role and pool extractors; `qualified-for` only from recorded measurements; eligibility for seat selection, with the capability snapshot hashed into the selection policy |
| D, work and learning | work and learning extractors; shared-prerequisite detection; reassessment from change events; the planner, scheduler and gate integration (graph cursor in `inputSignature`); proposals to the coordinator for lessons and register changes |
| E, federation | instance identity from ledger anchors; export of a permitted projection under an access policy (`scope`); cross-instance references and freshness; disconnected operation |

Not implemented here, on purpose (KD13): any integration with the planner, scheduler, routing, context, review or validator, and federation.

## 16. The owner's to decide

1. **Key custody for the graph domain**: which keys sign which origins (the work-ledger controller, a new graph key, per-extractor keys), and who holds the operator and orderer of the graph ledger's genesis.
2. **Traversal defaults and ceilings**: depth 4, 500 nodes, 2,000 edges are the coordinator's; the ceilings (16, 10,000, 50,000) are this slice's.
3. **Federation policy** (Slice E): which instances, which relationships are permitted across them, and the access policies `scope` will carry.
4. Where a production graph ledger lives, whether it is composed into an existing ledger or kept on its own, and whether its entries anchor to TELOS.

## 17. Caveats

- The lessons registry's detector names a test by a name substring; the graph records that, not the test case.
- `scope` is enforced on every federation export by Slice E (KG-3, qualified, synthetic); queries inside one instance do not filter by it. (This line said "not enforced" until an outside-lab review, GLM 5.3, pointed out it contradicted section 19.)
- Replay re-derives every observed source and costs about 40 µs a fact (section 13).
- A SIGKILL between the ledger lock's exclusive create and the write of its holder record leaves an empty lock that `packages/ledger` breaks only after `lockStaleMs` (default 600 s); a readable lock naming a dead holder is broken at once. Found by this slice's kill test, which shortens the bound; the fix belongs to `packages/ledger` (write the holder record to a temporary file and link it into place).
- The registry of origins is the reader's composition: an origin removed from it makes its entries fail re-derivation, as a removed ledger kind does.

## 18. Verification

`packages/graph/tests/` (schema, ledger, replay, traverse, events, concurrency), `ophanim/graph/lessons.test.mjs`, and the layering rule in `ophanim/ledger/layering.test.mjs`. The mutation runner `packages/graph/tests/graph.mutate.mjs` (`--only`, `--check`) holds 27 mutations, each run on a disposable copy against only the tests that decide it; it exits non-zero on a target that does not apply exactly once, a red baseline, or a survivor.

## 19. The slices as integrated

Each slice's own document is its detailed record (extractors, decisions as implemented, verification, caveats); this section indexes them against section 15. The registry and entity-type tables above include Slice C1's additions (contract 1.1.0: capability-domain types added, no existing type changed).

| Slice | Document | Integrated | What it supplies | Open in the register |
|---|---|---|---|---|
| A, foundation | this document | 97cc60f, c34b98f | the contract, identity, admission, the ledger kinds, replay, traversal, change events, the lessons adapter | KG-1 (replay cost: a signed projection checkpoint comes before Slice D), KG-2, KG-4 |
| B, systems and evidence | `slice-b.md` | d3d8890, dcecdc9, e6c4fe0 | extractors at a commit (repository, suites and workflows, mutation runners read as text, the status, work and cycle ledgers read only, register mentions); impact with explained paths and recorded reassessment sets; historical traceability with gaps reported; the `graph` retrieval op and dossier view in `ophanim/operate/context.mjs`; `ophanim/graph/cli.mjs` | KG-7 |
| C1, capability, advisory | `slice-c1.md` | 4781ce0 | extractors for models, identity, lanes, transports, runtimes, pools, roles and chairs, with the seating tables and fit matrix as owner-directed assertions; the executable capability (model, runtime, transport, tools, sandbox profile, credential scope) and the bubble as the code provides it; eligibility in three modes, recorded beside each live selection without changing it; metrics as observed assertions; no `qualified-for` (the owner defines no criterion yet) | KG-5, KG-6 (Slice C2, with L-155), KG-4 |
| E, federation | `slice-e.md` | 23a0cf4, bb25b5b | instance identity from ledger anchors; exports under an access policy (`scope` enforced); a read-only central projection; freshness and stale marking; catch-up by version; propagation with provenance; synthetic departments | KG-3 (qualified, synthetic), KG-8, KG-4 |
| C2, the SDK seat's bubble | `slice-c2.md` | e20e0cf (e0902da), 8df1c4c | the python SDK seat's whole process jailed in bwrap at both spawn points, fail closed with no override, torn down after its assignment; its bubble recorded as holding with the jail's quotes, so the SDK capability is now isolated under C1's rule; each agy attempt's transport recorded as agy-cli or agy-sdk | L-155 (qualified), KG-6 (partly done), KG-10, KG-4 |
| Replay checkpoint | `checkpoint.md` | dded52f (8b2f2fd) | a signed projection snapshot over the ledger's own checkpoints; open from it in 0.35-0.44 s instead of 2.1 s on the real graph, falling back to the full open on any mismatch, extractor code included | KG-1 (qualified), KG-9, KG-4 |
| B2, dependency sources | `slice-b2.md` | d4446f8 (dd2b578, 8a1c79e), d2d7c04 | external packages at their locked versions, import edges, environment variable names, executables and hosts by recognized calls only, files read by path, pinned external sources, the ownership manifests as `governs` and `authorizes`, the board's `dependsOn`; contract 1.2.0 (four systems-domain entity types added) | KG-7 (partly done), KG-9 |
| Snapshot compaction | `checkpoint.md` | 0f4d309 (04ed307) | a compact snapshot format: 205-266 ms from a current snapshot of the real graph (9.3 MiB), the same digest, every trust check kept | KG-9 (partly done) |
| D1, work and learning (read only) | `slice-d1.md` | 487f63d, merged with the compaction | the work graph from the work ledger's reader; shared prerequisites as a derived report that never merges tickets, with existence from other sources or a gap; the learning graph (defects, repairs, detection gaps, cycle findings, mutation outcomes) with `shares-failure-mechanism-with` only from declared, structural or measured inputs; learning reuse; targeted reassessment with no completion claim; why it exists by declared joins; concurrency and replay | KG-12 |
| D2, the loop | `slice-d2.md` | 0a3df11, c6b167f, merged in the D2 integration | the graph cursor wakes the scheduler; graph-derived gates (blocked with its reason, unlocked on establishment, never merging items that share a prerequisite, cycles refused); typed `requires` in the plan, re-checked by version; the learning-reuse and graph views in the planner's dossier; advisory team proposals with live seats byte-identical; write-back by observation; discoveries as unsigned candidates and coordinator proposals; demonstration 11 (synthetic) | KG-13 |
| D2 fixes (outside-lab review) | `slice-d2.md` | 1bc8a86, merged 18b2a59 | the three defects GLM 5.3 (Zhipu) found in D2, each with a failing-first test and a mutation: the BOUND requirement versions are read (`boundRequiresOf`; planValidity, the block and the unlock), the concurrency report is glob-aware (`pathsOverlap`, the owned-path grammar's one overlap function), and a candidate whose condition no longer holds is retired as `superseded` with the assertion that resolved it, never shown as open | KG-13 |
| Integration toolkit | `scripts/test-gates/TOOLKIT.md` | e8e6d88, 960bc3e, merged 1f6e2ae | T1 `reach.mjs` (every test and runner importing a module, `--transitive`), T2 `affected-runners.mjs` (runners whose targets OR deciding tests changed), T3 `manifest-reach.mjs` (a manifest that cannot contain its slice's changes fails), T4 `stress.mjs` (files K at a time, N rounds, beside busy-loop load); the mechanical detectors of `brief-manifest-disagree` and `runner-deciding-tests-changed-not-rerun` | KG-19 (found with T1 and T4) |
| Penetration-test suite | `docs/pentest.md` | bf4a663, merged fc8a88a, 45dab29 | 42 attacks on the safety invariants in six groups (jail escape, billing bypass, review independence, authorization, federation, graph integrity); each REFUSED or a registered KNOWN_HOLE that turns into a guard when fixed; `scripts/pentest/run.mjs` fails only on a new hole; 32 refused, 10 registered holes confirmed (KG-11, KG-10 x2, L-135, L-147, L-128, L-140, L-117, KG-8 x2), 0 new | KG-8, KG-10, KG-11 |
| Jail descriptors and turns' transport | `slice-c2.md` section 11 | 220b098, 6ff386e, 552022d, merged 3203db8; 84c6619, 822559c, 01ac30a | no descriptor beyond 0, 1 and 2 reaches any jailed command: a single-threaded python3 closer in front of every jail, fail closed with no override, probed on a real case by both gates; a closer refusal states its cause; each agy turn records the transport it ran on (agy-cli or agy-sdk), mapped by the metrics; pentest A1-fd is a guard | KG-11 (qualified: the integration refusals unexplained), KG-6, KG-20 |
| Hub readiness (advisory) | `hub-and-spoke.md` | 7d77566, c104196, merged 188937b | `node ophanim/graph/cli.mjs hub-readiness`: OPHANIM measures whether it may stay whole as the central hub of the collective graph and replicate into three departments (Finance, Technology, Compliance; directive section 6), on a synthetic federation sized from its own graph at x1 and x4. Verdict NOT APPROPRIATE NOW: ingestion (R5: KG-14, KG-21, KG-8) and identity under replication (R10: KG-8) block; the hub-and-spoke shape holds (R1 no withheld value at the hub, R2 exactly the permitted links, R3 stale marking and catch-up, R12 defects travel with provenance). Recommended: a pure hub (R6, KG-22); the ordered path to production is in the document | KG-8, KG-14, KG-21, KG-22, KG-4 |
| Self-repair lane (the inner wheel) | `docs/self-repair.md` | 5ad4b62, 27a9992, 7a6e9f3, merged 09424ad; f4f5bf0, 338d375, 566ef3a, f6de0f4, fe64246, 578856a | one Detect -> Diagnose -> Repair -> Verify round per tick on OPHANIM itself, ON only while the owner-signed `self-repair` item is In progress; Detect reads machine records only (gate and stress records, which the gate and the stress tool feed while the lane is on and the tree is clean, the pentest, the register); a verified repair lands as one revertible commit on `refs/heads/ophanim/self-repair` by fast-forward, a regression traced to it is rolled back by bisect, a moved base re-validates first; weakened assertions, skipped tests, lowered kill counts and the outer wheels are refused at plan and validate; an idle lane inspects itself after the tickets are counted; each round is handed the lane's history, and a defect back after a landed repair is repaired again and routed to the owner as a lesson candidate; the rounds are the learning graph's `ophanim.lane-learning` source | the switch and the protected list are the owner's |
| T2 per mutation | `scripts/test-gates/TOOLKIT.md` | ac21ccc | `affected-runners.mjs --run` passes each runner `--only` the mutations whose edited files or deciding tests changed; a runner whose own file changed, or whose table cannot be read, still runs in full; `--full` restores whole runs | none |
| Merge of PR #67's last commits | this section | 73dc8d0, 682460e, b9760b9 | 52 base commits (the model gateway replacing the L-150 relay, research, prompt intake) merged beside the lane and the graph hooks; the SDK seat's jail allows the gateway session's URL and token by exact name (its token is named TOKEN, which the jail's credential check refuses); the capability record cites the gateway; the history reader lists a merge's own changes (`--cc`); the runner reader reads `[...T.key]`; root `scripts/*.test.mjs` joins `test:gates:self` | KG-23 |
| KG-23 (the Antigravity SDK bridge's capability) | `slice-c1.md` | this branch | the bridge session the fit implementer runs on is its own executable capability: runtime antigravity-sdk-bridge, transport antigravity-sdk, environment bridge-jail, credential scope bridge-gateway, four tools; served for the SDK config's models; a seat's `session_transport` maps to it; established on found quotes and not isolated (its lifetime does not hold) | KG-24 |
| The operational report (deliverable 7) and the demonstrations, run | `operational-report.md` | e664d4d and the report's commit | `scripts/kg-demonstrations.mjs` runs the twelve demonstrations' cells at HEAD and lists the mutations each decides (read as text): 88 tests in 26 cells, all passing; every demonstration decided by mutations; B15 and B16 close two cells; nothing live | the report's section 5 |

Fixed by the coordinator at integration, each with a failing-first test: Slice E's freshness check gave a false reason for an import replayed as `recorded` (bb25b5b); Slice B's runner reader missed Slice E's helper shapes (dcecdc9) and Slice C1's template-literal constants (e6c4fe0), recorded as the lessons class `text-reader-misses-new-shape`. At the batch integration (D2 fixes, toolkit, pentest): the pentest brief placed two attacks under `packages/graph/`, where importing the shared harness broke the graph layering rule, and three pentest files in no suite; moved to `ophanim/graph/pentest/` and both pentest directories added to `test:proof`, the rule unchanged (45dab29), recorded under `brief-manifest-disagree` as a shape `manifest-reach` cannot see (04d2cc2).
