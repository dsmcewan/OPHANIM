# Knowledge graphs, Slice D part 1: the work and learning graphs, read only

**Directive** `docs/knowledge-graph/directive-2026-11-20.md`: Graph D (failures, corrections and learning) and Graph E (work, resources and execution); section 2's connections and section 4's update rules (idempotent; targeted reassessment, never global invalidation); Slice D ("identify shared prerequisites, relevant historical failures, and actionable reassessment"), its read-only half; demonstrations 1, 2 (its plans and qualifications part), 5, 7, 8, 9 and 12.
**Contract** `ophanim.graph/v1`, contract version **1.2.0, unchanged** (`packages/graph/schema.mjs`). Every fact uses a registered entity and relationship type; no type was missing, so none was added (KD1-8) and `architecture.md` is not changed.
**Base** `b529bf2` (branch `kg/slice-d1`). Real-data numbers are of the repository at `b529bf2` on this container (Node v24.22.1).
**Decisions** KD1-1 to KD1-10 are the coordinator's (the Slice D1 brief). This document says how each is implemented; it does not reopen them.

## 1. In one paragraph

Three new registered sources and six registered rules and tools extend the systems graph with Graph E and Graph D, read only. The **work graph** (`ophanim/graph/work.mjs`) projects the work ledger through its own reader at a pinned anchor: prompts, items, intake, tickets, plans with their typed requirements, units, leases, budgets, spend and billed requests, artifacts, reviews, validations and completion claims, each from the entry that states it. The **learning graph** (`ophanim/graph/learning.mjs`) extends Slice A's lessons adapter: instances become defects, fixes become repairs, and classes without a detector become detection gaps. It also reads review findings and their repairs from the cycle ledger, and records mutation outcomes as observations of a tool. Over them:

- **Shared prerequisites** (demonstration 1) are a derived report, never a merge.
- **Learning reuse** (demonstration 5) returns the established failure classes, detectors, repairs and lessons for a new defect, each with its path. Similar text stays a hypothesis.
- **Targeted reassessment** (demonstrations 2 and 7, `reassess.mjs`) maps a change event or a Slice B impact onto the plans, units, qualifications and completion claims that rest on it. It records the set and claims no completion.
- **Why it exists** (`why.mjs`) joins a component to the requirement and decision that sources state, by Slice B's cross-source join rule, and reports a gap where none is stated.

Two real processes and a killed process (demonstrations 8 and 9) leave one claim, one finding and the same projection.

## 2. The sources (KD1-1, KD1-3, KD1-9)

| Source id | Extractor origin | Basis | Version | Read through | Facts |
|---|---|---|---|---|---|
| `ophanim.work-graph` | `ophanim.work-graph.extractor` (`work.mjs`) | declared | the work ledger's head entry hash | `ophanim/operate/work-ledger.mjs` `openWorkLedger({create: false, keys: null})`, pinned anchor (`readWorkLedgerOnly`) | **0 real** (this container holds no work ledger); 205 on the SYNTHETIC fixture (51 entries) |
| `ophanim.learning` | `ophanim.learning.extractor` (`learning.mjs`) | declared | the registry's git blob id (as Slice A's) | `ophanim/lessons/corrections.json`, the working file at that version or `git cat-file blob` | **139 real** (21 classes: 36 defects, 13 repairs, 12 verified-by, 8 detection gaps, their edges) |
| `ophanim.cycle-learning` | `ophanim.cycle-learning.extractor` (`learning.mjs`) | declared | the cycle ledger's head entry hash | `ophanim/graph/extract/ledgers.mjs` `readCycleLedger` (`openLedgerReadOnly`), `listCycles`, `deriveCycle` | **0 real**; 10 on the SYNTHETIC fixture (one cycle, two findings, one fixed) |

The registration is `ophanim/graph/d1-sources.mjs`, which `extract/index.mjs` takes in four places:
- the import;
- `ORDER`;
- `...D1_ORIGIN_SPEC`;
- `...D1_MODULES`;
- plus one entry in `sourcesOf`, `...d1Sources(...)`.

Each source declares its `extractorVersion` through index.mjs's existing `declared` (`checkpoint.md` section 5a): the digest of `work.mjs` or `learning.mjs` and their local imports. The composition rules are:
- `ophanim.learning` is composed with the lessons source, so it is on by default, and it is observed right after it, because its facts reference Slice A's classes, fixes and detectors;
- `ophanim.work-graph` is composed when a work ledger is named;
- `ophanim.cycle-learning` is composed when a cycle ledger is named.

`refs/board/ophanim` is not read beyond Slice B2's board source.

**What each source states.**

| Source | Entities | Relationships |
|---|---|---|
| work graph | `work/prompt/<source>:<ref>` (an intake; a candidate prompt says it is never executed); `work/item`; `work/lease/<claim>` and `work/budget/<claim>`; `work/usage/spend/<entry>` (calls charged before they were made), `work/usage/stage/<record>`; `work/request/<entry>` (a billed Gemini request); `work/execution/<record>`; `work/plan/<record>` (item, requirement digest, dependencies, typed `requires`, free-text capabilities kept as text, slices, acceptance ids, evidence); `work/work-unit/<record>/<unit>`; `work/ticket/<item>`; `work/artifact/<record>`; `work/review/stage/<record>`; `work/validation/<record>`; `work/obligation/completion/<record>` (an UNSIGNED proposal: a completion claim, never a completion); `work/discovery/policy/<entry>` | item `introduced-because-of` prompt; lease `depends-on` item; budget, usage and request `derived-from` lease; plan `derived-from` its record, its item and each cited evidence file (with the digest it was given); plan `depends-on` the items it names; plan `requires-capability` (a capability, feature, runtime, tool, component, service, api or interface) or `depends-on` (a module) for each typed requirement; unit `derived-from` plan, `depends-on` unit; ticket `derived-from` plan; artifact `derived-from` plan, `produces` its files; review `derived-from` and `verifies` the artifact; validation `derived-from` the review and each file it cited, `verifies` the artifact; completion claim `derived-from` the validation |
| learning | `learning/defect/<class>/<digest of observer, date, ref>` (keyed by what the instance records, never its position); `learning/repair/lessons/<class>` (the fix text and, if it is one, the commit; otherwise a missing-evidence condition); `learning/detection-gap/<class>` (the registry's why and next step) | defect `documented-in` class; repair `introduced-because-of` class, `derived-from` the change Slice A names, `verified-by` the class's detector; gap `documented-in` class |
| cycle learning | `learning/finding/<entry>` (a subset of Slice B's attributes, the same values); `learning/reproduction/<entry>`; `learning/repair/finding/<entry>` (commit, test, before and after exits); the fix's change and test | reproduction `derived-from` finding; repair `introduced-because-of` finding, `derived-from` its commit, `verified-by` the test shown failing before and passing after |

**Each fact names the entry that states it.** A source's version is one per observation (the ledger's head), so the entry that states each fact is in its `ref` (`status/work#<entry hash>`, an immutable ledger id) and its attributes (`entry`, `record`, `claim`). A replay re-derives the same facts from the prefix that ends at the recorded head.

**Typed requirements only.** A plan's requirement is admitted as an edge only when it is a graph id: in `requires` (`[id]` or `[{id, why}]`) or in `capabilities`. Free text (`"dynamic team construction"`) stays on the plan as `free_text_capabilities`, with a missing-evidence condition. It never becomes an edge. Today's planner writes free text only (`stages.mjs:201`), so typed requirements are D2's: see section 9.

**Withheld paths.** No source reads a `findings-*` path. `withheldRefusal` refuses one before any read: a cycle-ledger root or a registry under such a directory throws `WITHHELD`. The test counts every `fs` read and finds none. Only what the cycle LEDGER records is used.

## 3. The rules and tool, each with its basis

| Origin | Kind, basis | Admits | What |
|---|---|---|---|
| `ophanim.work.rule` | rule, declared | derived `work/discovery/shared-prerequisite/<digest of the prerequisite>` | KD1-2: a capability or component that the plans of two or more items require, by an established `requires-capability` or `depends-on`. Inputs: the requirement edges, and what establishes the prerequisite where it exists. The finding is a report: the items' ids, each requirement with its ref and entry, and existence. Its attributes are exactly `prerequisite, kind, items, existence, report`: no merge, owner or assignment field. One id per prerequisite in every process (no writer state). A changed finding supersedes the rule's own earlier one. |
| `ophanim.learning.rule` | rule, declared | derived `shares-failure-mechanism-with` | KD1-3: only from inputs that STATE the basis. Each input must be current, established, and from an origin with a declared, structural or measured basis. A textual or inferred basis is refused (`LEARNING_BASIS`). `registryMechanisms` derives one link per pair of defects that the registry records under the same class: 27 on real data. |
| `ophanim.learning.similarity` | rule, **textual** | hypothetical `shares-failure-mechanism-with` only | KD1-4: classes whose text contains the claim's words. Each is a candidate, labelled `hypothetical`, `established: false`, with its score and shared words. The registry admits nothing else from a textual basis: a derived write from this origin is refused by the schema. |
| `ophanim.reassess.rule` | rule, structural | derived `work/discovery/reassess-work/event/<seq>` or `.../seeds/<digest>` | KD1-5: section 5. |
| `ophanim.why.rule` | rule, declared | derived `introduced-because-of` (component to ticket, item, prompt or register entry) | KD1-6: Slice B's cross-source join rule. Section 6. |
| `ophanim.mutation-outcomes.tool` | tool, measured | observed `learning/mutation-outcome/<runner>#<id>/<run>`, and for a survivor a `learning/detection-gap/mutation/...` | KD1-3: from a runner's own `--log` summary.json, with the run's identity (the summary's digest, the runner, the commit). The outcome is `derived-from` Slice B's `systems/mutation`. Each deciding test `detects` a killed mutation. **No run log is committed**, so no real outcome exists; it is proven on a SYNTHETIC summary over the real runner table. |

**Existence** (`existenceOf`) is read only from sources other than the work graph. A node a plan names is established as named, and that is not evidence that it exists. A prerequisite exists when one of these holds:
- an executable capability of the capability graph states it;
- an executable capability `combines` the runtime, transport or tool;
- a runtime that `supports` the feature is combined into one;
- a component `implements` it (or it is `implemented-by` one);
- the repository holds the module at the commit.

Otherwise it is a **gap**, with why.

`dependencyCycles` reports cycles of established `depends-on` among work nodes. None is broken silently.

## 4. Learning reuse (KD1-4, demonstration 5)

`learningReuse(view, {component, test, claim})` answers in four parts.

**Established**, each item with its path, every step naming its source and version:
- **tests**: the failing test, and the tests the sources state check the component. A test imports it (structural), or a runner declares it decides it (declared).
- **classes**: each class whose registry detector is one of those tests. This is a JOIN on the detector's `<file>#<name substring>`, labelled. Each class comes with its recorded defects, repairs (with what verifies them), detection gap and established shared-mechanism links.
- **findings**: review findings that name the same file (a labelled join), with their reproductions and repairs.
- **mutations**: mutations that edit the component, with their observed outcomes, or "no recorded run".

**next**: the detector tests to run, and the next steps the detection gaps state. This is how OPHANIM avoids rediscovering a known problem.

**textual**: register entries that only NAME the component, with their status. A mention is not a lesson about it.

**hypothetical**: mechanism links that no rule established, and similarity candidates for the claim. They are never listed as established.

## 5. Targeted reassessment (KD1-5, demonstrations 2 and 7)

`workReassessmentSet(graph, {event} | {seeds, impact})` builds the set in four steps.

1. **The changed set.** For a current event it is Slice A's `affected`: the reverse closure, before and after, along Slice B's change-carrying types. For an `unavailable` or `stale` event it is every fact of that source, as last observed. For a Slice B impact it is the seeds and the affected nodes.
2. **The start.** The work nodes in the changed set, and the work nodes that rest directly on a changed node through an established change-carrying relationship or `verifies` (a check of a changed subject).
3. **The walk.** From the start, within the WORK domain only, what rests on them: a plan's units and ticket, its artifact, the reviews and validations of that artifact, and the completion claims on those. Bounded: work depth 8 and the traversal's node bound.
4. **The roles.** Each member gets a role and a status:
   - plan: stale, to re-plan or re-validate;
   - unit;
   - ticket;
   - artifact;
   - qualification: to re-check;
   - completion claim: "unsupported until its chain is re-checked (not complete)".

   Every member carries its why and its path. For an unreadable source every member is "unverifiable".

`reassessWork` RECORDS the set as a derived discovery of `ophanim.reassess.rule`. Its inputs are the observation that caused it, or the established assertions of the impact's seeds. It records:
- `completion: 'not claimed'`;
- its members, while they fit 24 KB;
- their total and the digest of every member's id;
- the role counts;
- how many work nodes were untouched.

It invalidates, supersedes and retracts nothing. Once its causing source is observed again, it is stale, not established.

## 6. Why it exists (KD1-6)

`whyJoins` makes three joins, each on an identity that both sources state, labelled, with its inputs:

| Join | States it | Basis |
|---|---|---|
| ticket slot | Slice B's `implements` (the path is the ticket's slot); the ticket names its item; the status ledger states the item | declared |
| plan slice | a passed plan of the work ledger names the path as a slice; the plan's item; the prompt the intake recorded the item from | declared |
| commit message | the commit that INTRODUCED the path (its oldest `derived-from` commit) names a register id (`L-nnn`, `KG-n`) in its subject; the register defines it | declared (an exact id the message states, never a word match) |

`recordWhy` admits each join as a derived `introduced-because-of` of `ophanim.why.rule`. `whyExists` returns:
- the requirements and decisions;
- the introducing commit;
- the recorded joins, established or stale;
- the register entries that only name the component, as textual;
- every unfilled category, as a gap.

A gap is never filled by resemblance. An item named like the file is not its requirement (test, and mutation Y1).

**Real results (`b529bf2`).**

| Component | Requirement | Decision | Gaps |
|---|---|---|---|
| `ophanim/efficiency/investigation/chairs.mjs` | ticket `co1-readability`; status item `co1-readability` (on the status ledger) | none | decision |
| `pantheon/src/route/gemini-billing.mjs` | none stated | `L-136` (its introducing commit `0fbf93e` names it; the register defines it) | requirement |
| `packages/graph/checkpoint.mjs` | none stated | `KG-1` (`fc02390`) | requirement |
| `ophanim/operate/context.mjs` | none stated | none (L-001, L-201, L-202, L-504 only NAME it: textual) | requirement, decision |
| `ophanim/graph/lessons.mjs` | none | none | requirement, decision |

## 7. The queries

| Query | API | Command line (`ophanim/graph/cli.mjs`) |
|---|---|---|
| shared prerequisites | `sharedPrerequisites(view)`, `recordSharedPrerequisites(graph, by)` | `shared-prerequisites --work-root DIR --work-anchor A` (built with the real capability graph) |
| learning reuse | `learningReuse(view, {component, test, claim})` | `learning PATH [--test FILE#NAME] [--claim TEXT]` |
| why it exists | `whyExists(view, id)`, `recordWhy(graph, id, by)` | `why-exists PATH` |
| reassessment | `workReassessmentSet`, `reassessWork(graph, {event} \| {impact}, {by})` | none (called by the consumer of an event; D2) |
| mechanisms | `registryMechanisms`, `assertSharedMechanism`, `similarityCandidates`, `proposeSimilarMechanism` | none |
| mutation outcomes | `recordMutationOutcomes(graph, {summary, runner, commit}, by)` | none |

## 8. The demonstrations

| Demonstration | Test | Evidence |
|---|---|---|
| 1 shared prerequisites | `graph-d1-work.test.mjs` "demonstration 1: two or more ...", "... RECORDED as a report ..." | SYNTHETIC work (the directive's own example). REAL capability graph and repository for existence. The finding names three items (`resource-accounting`, `sdk-transport`, `team-construction`) for the missing `model-runtime-capability-contract`: a gap, one prerequisite and not three implementations. It names two items for `antigravity-sdk`, which exists because one executable capability of the real capability graph (an `agy-sdk` profile) combines it. Recording keeps every ticket, plan, item, unit, prompt and lease exactly as it was, adds two entities and no relationship, and a repeat is a no-op. |
| 2 impact (plans and qualifications) | `graph-d1-reassess.test.mjs` "demonstrations 2 and 7", "demonstration 2: a Slice B impact ..." | SYNTHETIC: a changed module reaches the plan citing its importer, then its ticket, artifact, review, validation and completion claim (6 work nodes reassessed, 82 untouched). A changed module reaches a plan's two units. REAL repository, SYNTHETIC work: the impact of `extract/git.mjs` reaches a plan citing its importer `impact.mjs`, not a plan citing documentation. |
| 5 learning reuse | `graph-d1-learning.test.mjs` "demonstration 5" | REAL: a failure in `ophanim/operate/context.mjs` (its test `context.test.mjs#reviewers and validators use their own evidence`) relates to `stored-not-delivered` (that test is its detector) and `bound-declared-not-enforced`. Each comes with its defects and previous repairs, and the detectors are named as the tests to run. The output-cap test relates to `declared-dimension-not-serialized`, repaired in `cbe0622`. `ophanim/graph/lessons.mjs` relates to nothing: a gap. |
| 7 source invalidation | `graph-d1-reassess.test.mjs` "demonstration 7: ..." (three) | SYNTHETIC: a file only a validation cited reaches exactly that qualification and its completion claim. A deleted file reaches the plans citing it. An unreadable work ledger leaves every work fact unverifiable. Each set is recorded with `completion: 'not claimed'`. |
| 8 concurrency | `graph-d1-concurrency.test.mjs` "demonstration 8" | Two REAL processes on SYNTHETIC work. One work-ledger claim on the shared prerequisite's item: the other is refused, "no duplicate execution". The graph shows one lease, one finding per prerequisite, and one observation of the one change. All 2×12 own assertions are present, with no no-op. No dependency cycle. Reconcile is equal. |
| 9 restart and replay | `graph-d1-concurrency.test.mjs` "demonstration 9" | A REAL process is killed with SIGKILL mid-run. The reopened graph is complete and holds every record the process reported, with one entry per record. A fresh process, a replay from nothing and a signed snapshot (synthetic key) give the same digest. With the work ledger moved away, a fresh process replays it `unavailable`: the open is partial, and its facts are absent. |
| 12 negative cases | `graph-d1-work.test.mjs` (unregistered extractor; absent or foreign work ledger, nothing created); `graph-d1-learning.test.mjs` (broken reference: learning without lessons is refused; similarity-only link never established; textual or empty basis refused; withheld path never read); `graph-d1-reassess.test.mjs` and `graph-d1-why.test.mjs` (stale record; gap never filled) | REAL refusals on the real registry. SYNTHETIC for the rest. |
| KD1-6 why it exists | `graph-d1-why.test.mjs` | REAL (section 6). SYNTHETIC plan-slice join; stale join after a ticket moves its slot. |

## 9. What D2 needs (the scheduler, gates and planner wiring; demonstration 11)

- **Typed requirements from the planner.**
  - Today `stages.mjs:201` checks `capabilities` only as non-empty free text, so a real plan yields no requirement edge.
  - D2 adds a typed `requires` (graph ids) to the plan schema `ophanim.plan/v1` and to the planner prompt (`plannerPrompt` `stages.mjs:320`), and makes `planRefusal` check the ids against the graph.
  - Work units carry no requirement field today: `pantheon.pipeline.work-units/v1` sets `additionalProperties: false`. A unit-level `requires` is a schema change there.
- **The scheduler and gates.**
  - A shared-prerequisite finding becomes a blocker input to `earliestGate` (`gates.mjs:176`), carried in `attemptInputs` (`:130`) so that the attempt identity stays truthful.
  - The graph's cursor goes into `inputSignature` (`scheduler.mjs:95`), so a graph change wakes a tick.
  - A missing prerequisite either blocks its dependents or becomes its own work item. That is the owner's decision, below.
- **Reassessment wiring.**
  - `reconcile.mjs` (`:141`, `:174`) calls `reassessWork` on each new observation event.
  - Its members map onto the existing staleness: a plan member is `planValidity` stale, a qualification is `validationEvidence` stale.
  - The record names what to re-check. The gates still decide.
- **Learning in the planner's dossier.** `learningReuse` becomes a derived dossier view, beside Slice B's `graph:<item>#neighbourhood`, for the planner and validator. Its version is the digest of its bytes, under `boundBrief`'s rules.
- **Demonstration 11.** It needs an owner-authorized unplanned item: a signed status entry and a ticket (inventory (k) 2). One real lifecycle must run on the owner's machine with provider keys and its graph observed; it cannot run in this container.
- **A real work ledger and cycle ledger.** Both sources are proven on fixtures only. Their real facts are 0 here.

## 10. Mutations

`node ophanim/graph/graph-d1.mutate.mjs [--only S1,...] [--check]` runs each mutation on a disposable copy against only its deciding tests. The copy is a local clone that keeps the history (the why tests read introducing commits), with a sparse checkout that never writes a `findings-*` path, and this working tree committed on top of HEAD.

| Id | Mutation | Decided by |
|---|---|---|
| S1 | a shared prerequisite merges the tickets (the later ticket recorded as superseding the first) | work "demonstration 1: ... RECORDED as a report" |
| S2 | a missing prerequisite reported as existing because the graph holds the node a plan names | work "demonstration 1: two or more independent items" |
| L1 | `shares-failure-mechanism-with` admitted from text similarity (the similarity rule declared, its link derived) | learning "shares-failure-mechanism-with is admitted ONLY" |
| L2 | a hypothetical mechanism link shown as established by learning reuse | the same |
| L3 | a withheld path read (the guard dropped) | learning "review findings from the cycle LEDGER" |
| R1 | reassessment invalidates unrelated work (every work node on any change) | reassess "demonstrations 2 and 7", "demonstration 2: a Slice B impact" |
| R2 | reassessment emits a completion claim | reassess "demonstrations 2 and 7" |
| R3 | an unreadable source's work reported with its ordinary status | reassess "demonstration 7: MISSING evidence" |
| C1 | a duplicate claim from two writers (each writer stamps the finding) | concurrency "demonstration 8"; work "... RECORDED as a report" |
| W1 | the work-ledger source opened writable (`create: true`) | work "an absent work ledger is refused" |
| W2 | a free-text capability admitted as a typed requirement | work "projected READ ONLY", "requirementsOf" |
| V1 | the new sources composed without their `extractorVersion` | work "every source of Slice D part 1"; extract "every source of the systems graph declares" |
| Y1 | a gap in why-it-exists filled by resemblance | why "a GAP is never filled by inference" |

The runner's result on the commit that adds this document is in the slice report.

## 11. Caveats and future work

- **Real data.** The work and cycle sources have no real data in this container. The learning reuse and why-it-exists results are real. Shared prerequisites, reassessment, concurrency and replay are proven on synthetic work.
- **Mutation outcomes.** No runner log is committed, so no real outcome is projected. Committing runner summaries, or keeping them in an evidence store, is a future ticket.
- **Composition order.** The learning source references Slice A's facts and is refused without them (broken reference): it must be composed with the lessons source, and `sourcesOf` does so.
- **Commit-message joins.** They read the commit SUBJECT only (Slice B stores 300 characters of it), not the body, and register ids only. Status-item ids in messages are not matched: they are free words, and a word match is not a stated identity.
- **The detector join.** The learning reuse join on a detector is by the test FILE. The registry names a test by a name substring, so a class whose detector file is among the related tests is related even when a different case in that file failed. `detector.exact` says whether the failing test's name contains the registry's substring.
- **Reassessment bounds.** The walk is bounded at work depth 8 and the traversal node bound, and a truncated set says so. The closure that feeds it uses Slice B's change-carrying types: `produces` does not carry a change of an output file back to the artifact that wrote it, by design.
- **Cost.** The default composition now includes the learning source: 139 more facts, observed in about 20 ms.
- **Future tickets.**
  - typed `requires` in the plan and unit schemas (D2);
  - committed mutation summaries as a source;
  - a register parser for the rows' status transitions (the register's history);
  - `violated contracts and affected invariants`, which no source states yet.

## 12. Owner decisions

None new for this slice. For D2: whether a missing shared prerequisite BLOCKS the items that require it, or is proposed as its own work item through intake. Either way the owner adds the item (inventory (k) 2, 3). Key custody for the graph domain (KG-4) is unchanged.
