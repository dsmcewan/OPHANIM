# Knowledge graphs: what already exists, and what is missing

**Pinned at** `af23623` (branch `feature/antigravity-sdk-intake`, pull request 68). Read by three read-only passes over the code on 2026-11-20; nothing was run. File and line references are to that commit. Two integration points and the ledger package's interface were then read again by hand (`pantheon/src/route/fit-matrix.mjs:246`, `ophanim/operate/context.mjs:296-407`, `packages/ledger/chain.mjs`, `ophanim/operate/work-ledger.mjs:411-452`).

The owner's specification is "OPHANIM: Federated Knowledge Graph Architecture & Implementation" (2026-11-20). This document is its first deliverable. The design that follows from it is `docs/knowledge-graph/architecture.md`.

## Summary

OPHANIM already records most of the relationships the specification names. They are fields of signed ledger entries, of JSON configuration and of two hand-kept registries. What it lacks is one identity scheme across them, a reverse index, and any way to ask a question that crosses two of them. Every existing query is a linear scan of one ledger for one item.

No graph database is needed. The records are small (hundreds of ledger entries, about 130 register entries, 48 lesson instances, a few thousand source files and import edges), every one is already versioned by a digest or a sequence number, and the ledger package already provides an append-only, hash-chained, locked and fsynced log with re-derivation on append. The graph is built as a projection over those records, kept in a ledger of its own kind for history, and held in memory for traversal.

## 1. Authoritative sources and who may write them

| Source | Identity and version | Writer | Role for the graphs |
|---|---|---|---|
| Status ledger (`status/ledger`, `packages/ledger/status.mjs`) | entry hash; `seq`; item id | the owner's operator key only | authority for what work is authorized and its state. Never written by a projection |
| Work ledger (`status/work`, `ophanim/operate/work-ledger.mjs`) | entry hash; `seq` | the controller key only | authority for the lifecycle: claims, stages, research, billing, recovery, reassessment |
| Pantheon run and cycle ledgers (per board) | ledger head, anchors | Pantheon kinds | authority for a run's turns and a review cycle |
| System ledger (`ophanim/ledger/system.mjs`) | entry hash | controller key | efficiency records, TELOS and board anchors |
| TELOS (`OPHANIM_TELOS_ROOT`) | its own anchors | its verifier | governance and verification. Not indexed by this work beyond the anchors already on the system ledger |
| Repository files at a commit | path; git blob; sha256 of the bytes | commits | components, tests, contracts, documents |
| Prompt records (`intake/prompts/<item>.json`) | `prompt-` + 128 bits of a digest | anyone; authorized only by an owner-signed status entry that binds the digest | original requirements |
| Tickets (`tickets/<item>.json`) | path + sha256 | the plan stage | derived requirement |
| Capability facts (`pantheon/src/config/capability-facts.json`, `models.json`, `lanes.json`, `classes.json`, `model-identity.json`, `antigravity-sdk.json`) | file digest; per-field `source` and `quote` | commits | model, runtime and limit facts, with their basis |
| Lessons registry (`ophanim/lessons/corrections.json`) | class id; instance position | by hand, coordinator only; checked by `corrections.test.mjs` | failure classes, instances, detectors |
| Limitations register (`docs/OPEN-LIMITATIONS.md`) | `L-nnn` | by hand, coordinator only | known limits, decisions, routes. No code reads it |
| Mutation runners (`*.mutate.mjs`) | mutation id | commits | which test decides which line of which file |

## 2. Graph-like structures that already exist

| Structure | Where | What it relates |
|---|---|---|
| Ledger lineage | every entry's `derived_from[]`, `parent`, `seq` (`chain.mjs:300`) | entry to entry; total order per ledger |
| Item dependencies | status `depends_on[]` (`status.mjs:46`); `dependencyOrder` (`scheduler.mjs:457`) | item to item |
| Stage handoffs | `handoff.from`, `inputs.upstream`, `identity.requirement`, `identity.ticket` (`work-ledger.mjs:357-368`) | stage to stage, requirement and ticket |
| Plan evidence | `outputs.evidence[]`, `outputs.deps`, `outputs.context.research[]` (`stages.mjs:1183-1192`; `gates.mjs:55-67`) | plan to the source versions it was made on |
| Contributions and team | `team[]`, `contributions[]`, `findings[]` on a stage record (`work-ledger.mjs:330`) | model and lab to work; the review exclusions follow from them (`stages.mjs:621`) |
| Research hierarchy | `work.research` `request`, `team`, `node.parent`, `depth` (`work-ledger.mjs:184-211`) | request to team to member to conclusion |
| Work units | `depends_on`, `owned_paths`, waves, `unit_key` chained through upstream keys (`work-units.mjs`, `dispatch.mjs:178-214`, `checkpoint.mjs:99`) | unit to unit, unit to paths |
| Board DAG | lineage links `derived_from`, `supersedes`, `supports`, `contradicts`, `considered` per kind; commits with slot trees (`pantheon/src/board/dag.mjs`, `schema.mjs:89-138`) | ticket, hypothesis, plan, artifact, critique, decision inside one board |
| Dossier views | `relations`, `consumers`, `guess`, `runs`, `index`, `research`, each with `source` and `version` (`context.mjs:296-407`) | what a seat is shown, and what it later retrieved (`deliveryOf`) |
| Component catalog | `COMPONENTS`, `INVARIANTS`, `INTERACTIONS`, hand-kept (`ophanim/efficiency/contributions.mjs:33-192`) | named components, dependencies and invariants |
| Import scan | one regex scanner in a test (`ophanim/ledger/layering.test.mjs:34`) | the layering rule only |
| Capability facts and drift | `capability-facts.json`; `capabilityDrift` (`config/facts.mjs:18`) | model facts to their sources; code copies checked against them |
| Selection records | `pantheon.selection/v1`, `pantheon.research-routing/v1` (`frontier.mjs:221`, `fit-matrix.mjs:246`) | a seat to the candidates passed over and why |
| Model identity | `resolveModel`, `contributorKeys`, `route_labs` (`review/identity.mjs`) | served name to base model to lab |
| Lessons | class, instances, `detector{file,name}`, `recurrence_check` (prose) | failure class to its test |
| Public projections | `ophanim/public/` (issues and pull-request provenance from the ledgers); the status board (`renderBoard`) | generated views; never read back |

## 3. What can be asked today

All read-only: `earliestGate`, `planValidity`, `evidenceCheck`, `validationEvidence` (`gates.mjs`); `reconcile` (`reconcile.mjs:108`); the work ledger's `stages`, `claims`, `billings`, `research`, `handoffRefusal`; `buildDossier` and the retriever's eleven operations (`context.mjs`); `dependencyOrder`; the board's `history`, `ancestors`, `changedSlots`; `corrections.mjs report`; `selectSeat` and its record.

Each answers one question about one item or one board. None follows a relation backwards, and none crosses from one store to another. "What depends on this file", "which tickets need the same thing", "which lesson's test covers this component" and "what did this model's work feed" have no function.

## 4. Gaps

**Identity.** An item is a slug, a component is a path, a model is a vendor and a name, a lesson is a class id, a register entry is `L-nnn`. Nothing names them in one scheme, so nothing can point from one to another.

**Relationship types with no record.**

| Missing | Consequence today |
|---|---|
| work requires a capability; a capability is implemented by a component | two tickets that need the same missing thing cannot be seen to. Each plans its own |
| component depends on component (imports); test verifies component | no impact analysis. The dossier's `consumers` view is a text search |
| contract or register entry governs a component | the register's `Routes` column is prose |
| test detects a failure class; a lesson applies to a component | a lesson's `recurrence_check` is prose |
| model runs in a runtime; the pair is qualified for a role, on what evidence | routing tables in source decide; the facts file is checked for drift, not queried |
| evidence was supplied, retrieved, cited, checked | recorded per stage (`deliveryOf`), not connected across stages |
| a change invalidates a qualification | staleness is checked per plan against file digests only |

**Duplicate representations.** Model facts are in `capability-facts.json` and copied in source three times (`packages/model-client/registry.mjs:8`, `route/router.mjs:31`, `role/seating.mjs:156`); `capabilityDrift` checks one copy. `models.json` exists twice, identical. The component catalog in `efficiency/contributions.mjs` is kept by hand beside the code it describes. `SEAT_FACTS` still names `claude-fable-5-1`. `TRANSPORTS` in `seating.mjs:408` says the agy CLI is not implemented. `docs/self-evaluation.md:15` says four lesson classes have no detector; the registry has nine. `gemini-4-neon` has no record in `capability-facts.json`. These are recorded here, not repaired by this work.

**Event propagation.** There is a replayable sequenced log per ledger and a `watch` loop that ticks when an input signature changes. There is no propagation from a changed file to the things that depend on it beyond a plan's own cited digests. A changed register entry, lesson, capability fact or test wakes nothing.

**Unpersisted results.** Mutation results are printed and written to a temporary directory. Which mutation was killed on which commit is prose in reports.

## 5. Where each seat is given context

| Seat | Assembled at | A graph-derived package can enter as |
|---|---|---|
| Planner, plan reviewers, research team, validator | `evidenceFor(ctx)` to `buildDossier` and the retriever (`stages.mjs:728-733`); derived views in `context.mjs:379-407` | one more derived view of the dossier, with a version, retrievable and continuable like the others |
| Research seat selection | `researchSeat(role, {qualified})` (`fit-matrix.mjs:246`) | the `qualified` test, which exists for this |
| Scheduler | `earliestGate`, `dependencyOrder`, `exec` context (`scheduler.mjs:348`) | a prerequisite the graph found becomes a `depends_on` the owner signs, or a recorded blocker; the scheduler's own rules are unchanged |
| Implementer (fit units) | `runPipeline` with `carried` lines appended to unit invariants (`stages.mjs:1504-1577`) | carried lines |
| Dispatcher, in-run reviewer | inside Pantheon's `runPipeline` | not changed by this work |
| Change reviewers | `boundBrief` (`stages.mjs:1755`) | the dossier view |
| Reflection | `ophanim/lessons/corrections.mjs report` | the learning projection reads the registry; it does not write it |

## 6. Technology

| Option | For | Against | Decision |
|---|---|---|---|
| A graph server | traversal at scale; a query language | a new service, a second authority to keep in step, nothing here needs its scale; the current state must be reproducible from the ledgers anyway | no |
| An embedded database | indexes on disk | a binary dependency; history and provenance would still be hand-built | no |
| Recompute from the sources on every query | no store at all | no history, no change events, no freshness for federation | no |
| **A projection ledger on `packages/ledger`, folded into memory** | reuses the chain, lock, fsync, re-derivation and signing already qualified here; history and change events for free; rebuilt from the sources when lost | traversal is in memory, so it is bounded by what one process can hold; adequate for this repository, unmeasured beyond it | **yes** |

A relation that no existing record carries (a ticket's required capability, an admitted cross-domain link, a proposal by an agent) is recorded on the work ledger under one new kind, by the controller key, like `work.research`. The projection reads it from there. Nothing consequential is written to the graph directly.
