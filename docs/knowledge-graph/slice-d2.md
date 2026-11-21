# Knowledge graphs, Slice D part 2: the graph in the foundry's loop

**Directive** `docs/knowledge-graph/directive-2026-11-20.md`: Graph E's operational use ("The scheduler queries the graph to determine what work is eligible, what is blocked, what can run concurrently, and what newly qualified capability unlocks other work"); section 4 ("A newly discovered dependency must be able to affect active planning and scheduling without stopping unrelated work"); section 5 (dynamic teams use the graphs); section 9 (the graphs participate in the recurring process); section 12 (bounds); demonstrations 2, 8 and 11. The owner, 2026-11-20: "autonomous systems foundry."
**Contract** `ophanim.graph/v1`, unchanged. No entity or relationship type was added.
**Base** `8be624d` (branch `kg/slice-d2`). Measurements are of this container (Node v24.22.1).
**Decisions** KD2-1 to KD2-9 are the coordinator's (the Slice D2 brief). This document says how each is implemented; it does not reopen them.

## 1. In one paragraph

The work and learning graphs of Slice D part 1 now run inside the scheduler's loop. A new module, `ophanim/operate/graph-loop.mjs`, is the graph handle the scheduler takes as `graph` (`tick`, `watch`, `inputSignature`). Through it:

- the graph's **cursor** is part of the input signature, so a change in the graph wakes a tick;
- each tick opens the graph **once, from its signed snapshot**, and observes the work source after each append;
- the **gates** read a graph-derived input. A stage after the plan is blocked while the plan requires a prerequisite the graph shows MISSING, and unlocked when the prerequisite is established;
- the **planner** is given the graph's and the learning graph's views, and binds typed `requires` to the versions the graph states. `planValidity` re-checks those versions and D1's reassessment sets;
- every stage records an **advisory team proposal** beside its live seats, which are byte-identical with and without it;
- **discoveries** become intake candidates and proposals to the coordinator, never executed and never a direct edit.

Without a `graph` option, every function is exactly as before. Every existing test that imports the five changed modules passes unchanged.

## 2. The cursor (KD2-1)

| What | Where | How |
|---|---|---|
| The cursor | `graph-loop.mjs` `cursor()` | `{anchor, seq, head, sources: [[id, state, observed version]]}` of the graph ledger. It is cached by the ledger's last line, so an unchanged graph costs one file read. |
| In the signature | `scheduler.mjs` `inputSignature({graph})` | The cursor rides with the routing it decides (`routing = {routing, graph: cursor}`). Without a graph the digest is byte-identical to before. The routing is reconciled through the graph's gate inputs, **read only** (`context({write: false})`): nothing is recorded by a signature. |
| The wake | `watch({graph})` | `watch` passes `graph` to `inputSignature` and to `tick`. A change in the graph alone (a new `implemented-by`, a re-observed source, a recorded reassessment) changes the signature and runs a tick; an unchanged graph does not. Only an **observed** change is a change: a source that moved but has not been observed is not (directive section 4: "Do not claim continuous synchronization"). |
| One open per tick | `tick`: `loop.open()` once | `openGraph({snapshot: {dir, keys}})` with the reader's pinned snapshot key (`checkpoint.md`). The tick ends with `loop.checkpoint()`, which writes a snapshot only when the graph moved. A fresh process's next tick opens from it with nothing re-derived (`rederived: 0`). |
| The work source observed | `tick`: after intake and recovery, after each stage record (`loop.writeBack`), at the end | `observeWork()` observes D1's `ophanim.work-graph` source. It first compares the work ledger's head line with the one it last observed, so an unchanged ledger is not re-verified. A repeated observation is a no-op (`packages/graph` `observationOf`): nothing is appended twice. |

## 3. The gates (KD2-2)

`reconcile.mjs` prepares the graph context once per reconciliation (`graph.prepare`). It hands `earliestGate` the item's **graph-derived input** (`gateInput`: `version(id)`, `reassessed(record)`, `plan(record)`). `gates.mjs` `earliestGate` is now `withGraph(gateOf(args), graph)`; `gateOf` is the previous body, unchanged except that `planValidity` and `validationEvidence` receive the graph.

**The analysis of a plan** (`graph-loop.mjs` `analyzePlan`) reads the plan node's requirement relationships (`requires-capability`, `depends-on`) as the graph holds them, each joined to the plan line that states it (`requires[i]`, or `capabilities[i]` for an id D1 admitted from there).

| Case | Result |
|---|---|
| An ESTABLISHED requirement of a prerequisite that `existenceOf` (D1) shows missing, which the plan does not implement | the stage after the plan is `blocked`, code `GRAPH_PREREQUISITE_MISSING`. The blocker carries `prerequisite`, `line` and `statement` (the plan line), `implementers` (the items whose plan implements it), and `candidate` when none does, plus `resume_when`. The gate keeps what it would have routed (`routed`). |
| A hypothetical (possible, never established) requirement | **never blocks**: it is listed in `graph.advisory`, classification `hypothetical`. The basis, and so the attempt identity, is unchanged by it. |
| A plan whose typed requirements the graph has not observed | `GRAPH_PLAN_UNOBSERVED`: nothing after the plan is dispatched on requirements the graph cannot check. |
| A prerequisite cycle (A waits for B's prerequisite while B waits for A's) | `GRAPH_PREREQUISITE_CYCLE` with the cycle, for every member. It is reported and refused, never looped and never broken silently. A cycle through a status dependency counts when it contains a graph wait. |
| The prerequisite established (a source states an `implemented-by` or `implements`, or an executable capability provides it) | the gate routes the stage, carrying `graph: {basis, unlocked, requirements, advisory}`. `unlocked` names each requirement the plan cited as absent that is now established, with what establishes it and when. |

**The prerequisite's own work** (the coordinator's decision on D1's question). A requirement with `implements: true` does not block its own plan. Another item that requires the prerequisite waits for the implementer:

- its block names the implementer;
- `reconcile` lists it in `graph_depends_on`;
- `dependencyOrder` orders the implementer first, as a status dependency is ordered.

If no current plan implements a missing prerequisite, it is ONE intake **candidate**, whatever the number of requiring items (section 6).

**The attempt identity.** `attemptInputs` adds `graph: <basis>` when the gate carries one. The basis is the digest of the plan, whether it is observed, and each established requirement's existence and version. `sameAttempt` compares it with the other identity fields (`GRAPH_IDENTITY_FIELD`; `IDENTITY_FIELDS` is unchanged). An attempt after an unlock is new work. An item whose plan states no typed requirement carries no `graph` field: its identity, and every gate it gets, are exactly as before.

**The unlock, recorded.** The dispatched stage record's inputs carry `graph_unlocked` (prerequisite, line, basis, established_at). The tick's `dispatched` row names `unlocked`, and the queue report lists it.

**The queue report** (`tick` result `queue`, `scheduler.mjs` `queueReport`):

- `eligible` (in dispatch order);
- `blocked` (gate, code, prerequisite, line, implementers, cycle, why);
- `concurrent`: groups of eligible items whose claimed paths are disjoint. The paths are the plan node's slices and its units' owned paths, as the graph states them. Two paths clash when they could name a common path, decided by the owned-path grammar's one overlap function (`pantheon/src/pipeline/paths.mjs` `pathsOverlap`: `*`, `?`, `**`, a path inside a directory, case; conservative when unsure). `src/a/*` and `src/a/b.mjs` are never in one group (D2 fixes: the report compared paths by exact equality). This is a report: the work ledger's per-item claims are what allow concurrency, as before;
- `unlocked`;
- `order`;
- `shared`: the current plans' shared prerequisites, each item listed apart;
- `cycles`;
- `candidates`.

Two items sharing a prerequisite stay two entries, each with its own claims: nothing is merged.

**Unrelated work is untouched.** The test compares the unrelated item's gate with the graph and without it, `deepEqual`, before and after the unlock. Its stage records carry no graph field.

## 4. The planner (KD2-3)

- **The plan schema** (`ophanim.plan/v1`) gains an optional typed `requires: [{id, why, version?, implements?}]`. Each id is a graph entity a work item can require (`gates.mjs` `requirableRefusal`: `requires-capability` or `depends-on` from a plan). The free-text `capabilities` field stays.
- **`planRefusal`** takes `graph: {stateOf}` and refuses, in `gates.mjs` `requiresRefusal`:
  - an entry that is not `{id, why}`;
  - an id that is not a graph id, or names something no work item can require;
  - a duplicate;
  - a `version` other than the one the graph states;
  - any typed requirement when no graph is supplied (it could not be bound).
- **The binding.** The plan stage binds each requirement to `requirementState(view, id).version`:
  - when nothing but plans states the prerequisite, the version is `GRAPH_ABSENT` ("absent");
  - otherwise it is the digest of its own non-naming established assertions and of what establishes it.

  The plan stage records `outputs.graph = {cursor, head, requires}`, the cursor its dossier was built at and the bound requirements.
- **The binding is what is read** (D2 fixes). Every consumer of a plan's typed requirements reads them through `gates.mjs` `boundRequiresOf(record)`:
  - `planValidity`, `analyzePlan` (the block and the unlock), the reassessment filter and the requirement index;
  - each requirement is the line of the plan document that states it, with the version from `outputs.graph.requires`;
  - the document's own `version` (optional in the planner's answer) is read only for a record with no `outputs.graph.requires`, or a requirement the binding does not name.

  Before the fix nothing read `outputs.graph.requires`. The real plan stage also writes the bound list into the document, so its records were judged correctly. A record whose document states no version was not: a changed fact did not stale it, and an established prerequisite re-planned it instead of unlocking it.
- **The prompt.** With a graph, `plannerPrompt` adds `GRAPH_RETRIEVAL_HELP` and a "Typed requirements" section, and names `requires?` in the answer schema. Without one, the prompt is byte-identical.
- **The evidence.** The plan stage's dossier (`evidenceFor(ctx, {}, graph)`) ends with:
  - Slice B's `graph:<item>#neighbourhood` view;
  - a new `learning:<item>#reuse` view (`context.mjs` `buildDossier` option `learning`): D1's `learningReuse` for up to three files in play, with established classes, repairs, findings and tests to run. What is textual or hypothetical is listed apart.

  Both views share the initial view's existing byte budget (`GRAPH_RETRIEVAL.dossier_bytes` each, then what is left) and its citation rules (`{"op":"dossier","source":...}` continues them). The retriever serves the `graph` op. The planner may still retrieve every original record: the views are references, never conclusions.
- **`stable`** leaves out views derived from the graph, as it leaves out the work ledger's own records. The graph moves with the lifecycle's own consequences, and they never wake a plan that waits for evidence. Without a graph, `stable` is unchanged.
- **The re-check (`gates.mjs` `planValidity`, with the graph).** A plan is STALE, and re-planned, never executed, when any of these holds:
  - a requirement it cited at a version (not absent) now has another version (`graph fact <id> changed`);
  - a recorded reassessment set reached it (`reassessed: ...`);
  - it has typed requirements and no graph is supplied here.

  "Cited" is the BOUND version. A requirement cited as absent is the gate's block and unlock, not a staleness: when it is established, the plan is UNLOCKED, never re-planned. A requirement bound at a version that changes makes the plan stale, and it is RE-PLANNED.
- **D1's reassessment, on each observation event.** The prepared context computes `workReassessmentSet` for every observation event of a source other than the work graph that changed an already observed source. The work graph is excluded because its own events are the lifecycle's consequences, not evidence. With a writing context, `reconcile` RECORDS the set (`reassessWork`, once per event; `completion: 'not claimed'`). Its members map onto the gates:
  - a plan member makes `planValidity` stale;
  - a validation member makes `validationEvidence` stale.

  A plan reached only through its requirement of a prerequisite it cited as absent is not made stale by it: that establishment is the unlock.
- **Its own consequences.** A plan's cited graph views are re-derived by `reconcile.mjs` at the cursor the plan was made at. This is the same rule as the work ledger "as it stood when the plan was made", so the plan's own later records never stale it.

## 5. The team proposals (KD2-4)

`stages.mjs` `makeExecutors` wraps each executor (`advised`). After the stage has returned, with its live seats chosen inside it exactly as before by the owner-directed seating tables and fit matrix, the wrapper adds `outputs.team_proposal` (`graph-loop.mjs` `teamProposal`, schema `ophanim.team-proposal/v1`, `advisory: true`). The proposal records the directive's section 5 queries:

| Step | Recorded |
|---|---|
| 1 work: the unmet obligation | the requirement, the missing prerequisites the plan does not build (`unmet`), the ones it builds |
| 2 systems: existing capabilities and dependencies | each requirement's existence and what establishes it; the slices' modules and their `depends-on` |
| 3 evidence: known and uncertain | established assertions per requirement; the plan's stated uncertainty and the possible-mode (hypothetical, unresolved) assertions |
| 4 learning: failure mechanisms and prior corrections | D1 `learningReuse` for up to two slice paths: classes, tests to run, gaps |
| 5 capability: eligible capabilities | C1's advisory eligibility (`decisionFor(defaultSnapshot(), requirementsOf({role, mode: 'automatic', task}))`) per live role: snapshot, decision digest, up to five eligible capabilities |
| 6 the bounded team | per live role: the live seat and the proposal's candidates, "advisory: the live seat ... is not changed" |
| 7 recorded back | on the stage record, through the work ledger's writer |

**The proof.** The same plan stage runs with and without the graph in two fixture worlds. The planner seat with its selection, and every team row, are deepEqual and byte-equal, and the scripted seats are asked the same sequence of calls (kind, vendor, model).

## 6. The write-back and the discoveries (KD2-5)

- **By observation.** After each stage record, `loop.writeBack(record)` observes the work ledger into the work graph (D1's facts: the plan, units, ticket, artifact, review, validation, completion claim). This is idempotent. Demonstration 11 shows the records of the whole lifecycle in the graph.
- **A missing prerequisite no item implements** is an intake **candidate**, recorded unsigned under `<state dir>/graph-candidates/<digest of the prerequisite>.json`:
  - classification `candidate`, `executable: false`, `required_by`, the gap, and authority "none";
  - it is recorded at the END of a tick, when every item has had its turn to plan (a prerequisite another item implements is no candidate);
  - there is one record per prerequisite; its `required_by` is kept current;
  - its `state` is `open` while its condition holds.

  It is never claimed or executed: the owner adds an item with a signed status entry.
- **A stale candidate is retired** (D2 fixes; `graph-loop.mjs` `recordCandidates`). At the end of the next tick, an open record the reconciliation no longer lists is marked `state: superseded`, with `superseded: {reason, why, resolved_by, graph}`:

  | Reason | `resolved_by` |
  |---|---|
  | `established` | the basis, what establishes it, and the assertion ids that establish it |
  | `implemented` | each implementing item's plan node, record, plan line and its requirement assertions |
  | `no longer required` | the plans of the items that required it, which no longer state it |

  - It is retired only when one of these can be said. A requirement the graph has not yet observed as established is no resolution, and the record stays open.
  - The record is **kept, not removed**. Removing it would erase the evidence that the gap was found, which items required it, and how it closed. The owner, who alone classifies candidates, may be reading it.
  - A retired candidate is never shown as open. The record says `superseded`; the tick's `candidates` and the queue report list only open ones; a later tick leaves it unchanged.
  - If the gap returns, the same record is **reopened** (`state: open`), its retirement kept in `history`.
- **A relevant failure mechanism.** A failed, returned or blocked stage whose finding names a file the learning graph relates to an established failure class becomes a **proposal to the coordinator** (`ophanim.coordinator-proposal/v1`, `kind: lesson-instance`, `applied: false`). It is written once under `<state dir>/graph-proposals/`. It is never an edit of `ophanim/lessons/**` or `docs/OPEN-LIMITATIONS.md`: the test checks both files are byte-identical.
- **A reassessment** is recorded by D1's own rule on the graph ledger, and acts through the gates (section 4).
- **D1's shared-prerequisite findings** are recorded by D1's own rule, once per tick and again only when the current plans' requirements or their existence change.

## 7. Bounds and the measured tick cost (KD2-6)

**The bounds per tick:**

- one open, from the snapshot;
- Slice A's traversal defaults (D1's reassessment and existence use them);
- at most `LOOP_BOUNDS.events` (64) reassessment sets computed per tick. The rest are deferred to the next tick, counted, and never dropped. A configured bound can only be lower;
- at most 32 requirements read per plan, 5 capabilities per role and 2 components per team proposal, and 64 claimed paths per plan;
- no agent is spawned and no provider request is made by the graph: the scripted seats see the same calls with and without it.

**Measured** (`graph-d2-real.test.mjs` "KD2-6"; the real graph of this checkout: repository, verification, records, lessons, learning and Slice B2's dependency sources at HEAD, 26,046 current facts before this slice's commit and 26,507 at it, beside a synthetic work ledger):

| What | Measured (three runs) |
|---|---|
| Building the real graph (full open, every source observed) | 3.2 to 3.8 s, once |
| Writing its snapshot | 0.29 to 0.36 s |
| A tick of one item through five scripted stages, without the graph | 113 to 137 ms |
| The same tick with the graph | 1.43 to 1.59 s: **added 1.30 to 1.48 s** |
| of which: open from the snapshot | 185 to 261 ms |
| of which: preparing the gate inputs (every reconcile of the tick) | 193 to 232 ms |
| of which: observing the work source (14 to 16 observations; about 10 recorded) | 0.58 to 0.74 s |
| of which: writing the snapshot at the end | 242 to 342 ms |
| A tick with nothing to dispatch, with the graph (it records one ticket intake) | 0.8 to 1.2 s |

The cost is per tick, not per gate. It is dominated by one snapshot open, one snapshot write and one work observation per append. Before the shared-prerequisite scan was bounded to once per tick, preparing the inputs cost 2.1 s a tick; this is why that scan is bounded.

## 8. Demonstration 8 in the loop (KD2-8)

`graph-d2-concurrency.test.mjs`. Two REAL processes (`fixtures/graph-d2-child.mjs`) tick the same world with the graph loop: the work ledger's append lock and the graph ledger's lock apply between them. Two items share a dependency, and two form a prerequisite cycle. The test shows:

- both processes executed stages;
- **no duplicate claim or execution**: each stage of each item is recorded once, with no two claims of one attempt;
- **no circular execution**: the cycle is reported by `GRAPH_PREREQUISITE_CYCLE` and refused, and nothing past the plan is claimed for it;
- **no lost graph update**: a fresh open holds every plan and artifact, the work graph is observed at the work ledger's head, and `graph.reconcile()` (incremental against a replay from nothing) is equal;
- the shared dependency is ONE D1 finding naming both items;
- no work-ledger version is observed twice.

## 9. Demonstration 11, SYNTHETIC, and the owner's live command (KD2-7)

**SYNTHETIC** (`graph-d2-demo11.test.mjs`). The unplanned item `graph-demo` is authorized by a status entry signed with the fixture's SYNTHETIC owner key, in a fixture status ledger; the real ledger and keys are never touched. The REAL stage executors run over Pantheon's scripted clients and seats: no provider request, no network. The demonstration goes through these steps:

1. **Intake.** `status:graph-demo` is recorded, and it is in the work graph as a prompt.
2. **Investigation and planning.** The planner is given the graph's and learning graph's views. Its plan states a typed requirement of the contract `ophanim.graph-demo-dispatch/v1`, which no module carries, bound as absent. A second item requires the same contract, and the team proposal is recorded.
3. **The shared prerequisite found.** One D1 finding names both items, the contract is missing, and one intake candidate is recorded.
4. **The gate blocks** both items after planning (`GRAPH_PREREQUISITE_MISSING`, `requires[0]`).
5. **The prerequisite lands.** A SYNTHETIC commit adds a module exporting the contract constant. An observer observes the repository, and the graph change **wakes** `watch`.
6. **The gate unlocks.** Implementation, the three-lab review, validation and the unsigned outcome run on scripted seats. The implement record carries `graph_unlocked`.
7. **The records update the graphs.** The plan, artifact, review, validation and completion claim are in the graph. The claim is unsigned (`signed: false`), and the D1 finding now records the contract as existing. The status ledger is unchanged.

**Live.** A live run needs three things:

- the owner's signed item (inventory (k) 2);
- the owner's machine with provider keys (k) 1;
- the graph's keys (k) 4, KG-4.

It also needs the launcher to pass the loop to `tick`. `ophanim/operate/live-run.mjs` is outside this slice's manifest. The patch the coordinator would apply is in the slice report, unapplied and UNVERIFIED: an optional manifest key `graph: {dir, anchor, snapshot_dir, keys_file}`, `graphLoopOf(m, repo)`, and `...(graph ? {graph} : {})` on the run's `tick`.

With that patch, and a graph ledger created with the owner's keys (`createGraphLedger`, its anchor in the manifest), the owner would run, on their machine:

```sh
# 1. Authorize the unplanned item (the owner's key; the real status ledger):
node packages/ledger/status.mjs set --json '{"item":"<item-id>","title":"<title>","state":"Ready","basis":"<the requirement>","checked":"<YYYY-MM-DD>"}' --keys <owner key directory>
# 2. Check the run, then run it (the manifest names `graph`, its limits and billing):
node ophanim/operate/live-run.mjs --manifest <manifest.json> --dry-run
node ophanim/operate/live-run.mjs --manifest <manifest.json> --confirm-spend "<item-id>@<first 7 of candidate_commit>"
```

## 10. What is advisory, and why

| Advisory | Why |
|---|---|
| The team proposal | Owner decision 2026-11-20: "Keep the seats as we have them for now until we better understand the metrics". It is computed after the stage, from the seats the stage chose, and it is never read back. |
| A hypothetical requirement | Only an established relationship blocks (KD2-2). A model's inference cannot hold work, as it cannot overwrite evidence (demonstration 6). |
| The `concurrent` groups | Concurrency is what the work ledger's claims allow today. The report says which items' claimed paths are disjoint; the workers are unchanged. |
| Candidates and proposals | Discoveries never execute (KD2-5). The owner signs items, and the coordinator edits the registry and the register. |
| The cursor's "observed versions" | A source that moved is a change only once observed. Nothing claims continuous synchronization (directive section 4). |

What is NOT advisory:

- the block on a missing established prerequisite;
- the refusal of a cycle;
- the staleness of a plan whose cited graph facts changed or that a reassessment reached;
- the graph basis in the attempt identity.

## 11. Tests and mutations

| Test file | Covers |
|---|---|
| `graph-d2-loop.test.mjs` | KD2-1 cursor and wake; KD2-2 block with reason, one candidate, shared never merged, unlock, unrelated untouched; hypothetical never blocks; own work and the wait, a cycle refused; KD2-3 bound versions, stale re-planned with the reassessment recorded; KD2-5 and KD2-6 idempotent write-back, one open from the snapshot; the per-tick reassessment bound. The D2 fixes: the BOUND version read (stale and re-planned; absent then established, unlocked); the glob-aware concurrency report; a stale candidate retired, never shown as open, reopened |
| `graph-d2-stages.test.mjs` | KD2-3 the planner's views, typed requires bound, its views re-derived at its cursor; KD2-4 team proposal recorded, live seats byte-identical, no extra provider request; `planRefusal` of typed requires |
| `graph-d2-concurrency.test.mjs` | demonstration 8 (two real processes) |
| `graph-d2-demo11.test.mjs` | demonstration 11, SYNTHETIC |
| `graph-d2-real.test.mjs` | KD2-6 measured on the real graph; KD2-5 a failure mechanism becomes a proposal, the registry and register unchanged |

`node ophanim/operate/graph-d2.mutate.mjs [--only G1,...] [--check]` runs each mutation on a disposable copy that keeps the history (a local clone with a sparse checkout that never materializes `findings-*`, this working tree committed on top), against only its deciding tests. The copy is made under the home directory by default (`--copy-root`), not the OS temp directory: the verify jail mounts a fresh tmpfs on `/tmp`, so demonstration 11's jailed verify command cannot run from a tree copied there. The first full run, with the copy under `/tmp`, stopped at a red baseline for exactly that reason.

| Id | Mutation | Decided by |
|---|---|---|
| G1 | the cursor left out of `inputSignature` | loop "KD2-1" |
| G2 | a hypothetical relationship blocks | loop "HYPOTHETICAL" |
| G3 | a block without its reason (prerequisite and line dropped) | loop "MISSING"; demonstration 11 |
| G4 | no unlock on establishment | loop "MISSING"; demonstration 11 |
| G5 | unrelated work blocked (a missing prerequisite anywhere blocks every item) | loop "MISSING" |
| G6 | two items sharing a prerequisite merged (only the first queued) | loop "MISSING"; demonstration 8 |
| G7 | a stale plan executed (`planValidity` ignores the graph) | loop "KD2-3" |
| G8 | the prerequisite's own work blocked | loop "own work" |
| G9 | a cycle not refused as one | loop "own work"; demonstration 8 |
| G10 | the planner's views re-derived at the present graph (its own records stale it) | stages "KD2-3 and KD2-4" |
| G11 | typed requirements not bound to the graph's version | stages "KD2-3 and KD2-4" |
| G12 | a reassessment no longer reaches `planValidity` | loop "KD2-3" |
| G13 | the team proposal changes the live seat | stages "KD2-3 and KD2-4" |
| G14 | a discovery executed without an owner-signed item (the candidate claimed) | loop "MISSING" |
| G15 | a direct edit of the lessons registry | real "KD2-5" |
| G16 | a repeated discovery duplicates (a second candidate record) | loop "MISSING" |
| G17 | a repeated observation duplicates (`packages/graph` observe dedupe removed) | loop "KD2-5 and KD2-6"; demonstration 8 |
| G18 | the graph re-derived in full on each tick (no snapshot) | loop "KD2-5 and KD2-6"; real "KD2-6" |
| G19 | the per-tick reassessment bound not applied | loop "per-tick bound" |
| G20 | `planValidity` reads the document's version, not the bound one | loop "the BOUND version ... at a version" |
| G21 | the unlock reads the document's version, not the bound one | loop "the BOUND version ... ABSENT" |
| G22 | the reassessment filter reads the document's version (an establishment re-plans) | loop "the BOUND version ... ABSENT" |
| G23 | the concurrency report compares claimed paths by exact equality | loop "glob-aware" |
| G24 | a stale candidate never retired | loop "stale candidate" |
| G25 | a retired candidate kept open | loop "stale candidate" |
| G26 | a retired candidate never reopened | loop "stale candidate" |

The runner's result on the final commit is in the slice report.

## 12. Outside this slice's manifest

Each item below is reported with a patch or a description in the slice report; none is applied here.

| Change | File | Why it is needed |
|---|---|---|
| `'graph'` added to `INTAKE_SOURCES` | `ophanim/operate/work-ledger.mjs` | The work ledger refuses an intake source other than status, issue or ticket, so a graph candidate is recorded as an unsigned candidate record (section 6), not as a `work.intake` entry. The patch makes it an intake `candidate` (`item: null`), never executed. |
| `graph` in the live-run manifest and its `tick` | `ophanim/operate/live-run.mjs` | The live demonstration 11 (section 9). |
| `graph` for `cli.mjs tick/serve/watch` and `service.mjs` | `ophanim/operate/cli.mjs`, `service.mjs` | Today only a caller that passes a loop (the tests) runs the graph in the loop. Which keys sign the graph ledger and its snapshots is the owner's decision (KG-4). |
| A unit-level `requires` | `pantheon/src/pipeline/work-units.mjs` (`work-units/v1`, `additionalProperties: false`) | KD2-2's "plan or units". Units carry no requirement field, so a block is derived from the plan's requirements only. |

## 13. Caveats, future work, owner decisions

- **Timing of a block's implementer.** Within one tick, an item that plans before the item that implements its prerequisite is blocked with no implementer named. The candidate is recorded only at the end of the tick, when the implementer's plan is seen, so none is recorded then. The next tick names the implementer.
- **The reassessment's path.** D1's set records one path per member. A plan reached both through a requirement it cited as absent and through another changed input is judged by the first path found.
- **A change after an unlock.** A plan that cited a prerequisite as absent is not made stale when that prerequisite changes after being established. Its attempt basis changes (new work for the next stage); it is not re-planned.
- **A plan observed after the change.** A plan recorded before an event, but observed into the graph after it, is not a member of that event's set. Its cited files are still re-checked by their bytes.
- **The concurrency groups** are a report; enforcement by path is future work. Their overlap test is conservative: a path that is not a valid owned-path pattern clashes with every other.
- **The candidate retirement** runs against the reconciliation that produced the tick's candidate list (the loop's last prepared context). A caller that records candidates without that reconciliation retires nothing.
- **Real data.** This container holds no real work ledger. The work graph is proven on synthetic work, and the learning proposal and the tick cost on the real repository graph.
- **Future tickets:**
  - the four outside-manifest changes (section 12);
  - enforcing disjoint paths across concurrent workers;
  - recording reassessment paths for every route that reaches a member.
- **Owner decisions:**
  - key custody for the graph ledger, its extractors, rules and snapshots (KG-4);
  - wiring the loop into the service and the CLI;
  - when the advisory team proposal may become live (decision 3 keeps the seats).
