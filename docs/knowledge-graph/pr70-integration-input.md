# Pull request 70 as integration input for the canonical knowledge-graph work

**The owner's decision (2026-11-20).** "Use ophanim/knowledge-graphs as the canonical implementation branch and packages/graph/ as the foundation location. Stop this session's independent graph implementation. Preserve PR #70 as integration input for the coordinator. Compare its implementation and tests against the canonical Slice A and the original directive. Carry over any demonstrably missing behavior, including the text-only mutation-runner extraction, cursor rule, and recovery handling where applicable. Preserve useful regression tests. Record what was incorporated, what was already covered, and any unresolved differences. Account for PR #70's dependency on PR #68 when transferring changes. Further graph implementation in this session should proceed only through a coordinator-assigned slice with explicit scope against the canonical foundation."

**What this document is.** The comparison, as far as this session can make it, and a list of what to carry over. It was written by the session that built pull request 70. That session has stopped building graph code.

**What this document is not.** A record of incorporation. Nothing from pull request 70 has been put into the canonical branch by this session: `packages/graph/**` belongs to the Slice A agent (`docs/execution/kg-slice-a-ownership.json` on `ophanim/knowledge-graphs`).

## What could be compared, and what could not

| Compared against | State |
|---|---|
| The owner's directive | compared |
| The canonical design: the coordinator's inventory section (j) and the Slice A ownership manifest, at `c14fed0` | compared |
| The canonical Slice A implementation | **not compared.** Branch `kg/slice-a` was not on the remote when this was written (2026-11-20). The column "canonical" below says what the design plans, not what the code does. Whoever has both must complete it |

The decisions KD1 to KD13 that the manifest cites are not in the repository. They were read only through the manifest's region limits.

## Pull request 70, file by file

Branch `ccr-3b496a5e-q1czrf`, on top of pull request 68 (`d6c6d29`).

| File | Lines | What | Needs pull request 68? |
|---|---|---|---|
| `ophanim/graph/contract.mjs` | 184 | identity, assertion shape, 32 relationship types, refusals | no |
| `ophanim/graph/store.mjs` | 231 | the projection ledger on `packages/ledger`, the fold, `sync`, `commit`, `diffOps` | no |
| `ophanim/graph/query.mjs` | 142 | neighbourhood, impact, trace, context package | no |
| `ophanim/graph/graph.test.mjs`, `test-writer-child.mjs` | 279 | 14 tests of the three files above | no |
| `ophanim/graph/extract.mjs` | 307 | six extractors and the text parser for mutation runners | **partly** (below) |
| `ophanim/graph/project.mjs` | 105 | `project`, `freshness`, `reconcile`, `recover` | no |
| `ophanim/graph/project.test.mjs`, `test-fixtures.mjs`, `test-project-child.mjs` | 198 | 6 tests, one against the real checkout | **yes** (below) |
| `docs/knowledge-graph/pr70-work-graph-kind.patch` | 86 | an uncommitted, untested sketch of a `work.graph` ledger kind | applies to `work-ledger.mjs` of pull request 68 |

**The dependency on pull request 68.** The canonical branch is based on `9547e12`, which does not contain pull request 68.

- `contract.mjs`, `store.mjs`, `query.mjs`, `project.mjs` and `graph.test.mjs` import only `packages/ledger` and Node built-ins (and `ophanim/operate/work-ledger.mjs` for opening it read-only in `project.mjs`). The first three and `graph.test.mjs` were copied into a scratch checkout of the canonical branch (`c14fed0`) and run there: 14 of 14 pass. `project.mjs` was not run there.
- `extract.mjs` `readCapabilities` reads `pantheon/src/config/antigravity-sdk.json`. On `9547e12` that file is absent: the reader then leaves out the SDK runtime, its executables and every `qualified-for` edge, and the rest still reads. Nothing in the other five readers is specific to pull request 68.
- `test-fixtures.mjs` copies `antigravity-sdk.json` into the fixture and fails without it.
- `project.test.mjs` asserts facts that exist only with pull request 68: the SDK executables and their roles, `pantheon/src/antigravity/gateway.mjs` and `seat-session.mjs`, register entry L-724, the scout role. Those assertions must be rewritten against the canonical base or kept for after pull request 68 merges.

## Behaviour by behaviour

"Carry" means: this session believes the behaviour is asked for by the directive and is not stated in the canonical design. It is a proposal to the coordinator, not a finding about the canonical code.

| # | Behaviour in pull request 70 | Decided by (test in `ophanim/graph/`) | Canonical design | Proposal |
|---|---|---|---|---|
| 1 | **A reading never executes its source.** Mutation runners are parsed as text: constants, the `T` table, list constants, `file:` and `one(FILE, ...)` targets, a `SUITE` constant. 511 of the 512 targets the ten runners list are read. A runner's entity carries `mutations_listed` and `mutations_read`, so what was not read is counted | `project.test.mjs` "A READING NEVER EXECUTES ITS SOURCE" (a runner with no main guard whose top level writes a marker file); `mutationTargets` | Slice B: "mutation tables read **as text**"; the inventory's "Open conflict" names the hazard | **Carry to Slice B**: `mutationTargets` and its test. The hazard is real: this session first imported the runners, and `reliability-wave2b.mutate.mjs` started a mutation run |
| 2 | **The cursor rule.** One batch per step of one source's cursor. A batch is admitted only when its `from` equals where that source's last batch ended, checked in re-derivation under the ledger's append lock. The same batch again is `already-applied`; one computed on an older state is `stale` and is computed again | `graph.test.mjs` "THE CURSOR RULE", "CONCURRENCY" (seven processes: four on one change, three on their own) | `projection.mjs` "replay by cursor"; kinds `graph.assert`, `graph.retract`, `graph.supersede`; "a repeat is refused on append" by content digest | **Carry, or show it covered.** Refusing a repeated assertion by digest stops duplicates. It does not stop an older reading from landing after a newer one, which re-asserts what the source dropped. The per-source `from` check does |
| 3 | **Recovery.** A graph ledger that does not verify is never repaired. It is renamed aside whole and a new one is built from the sources. A healthy one is opened as it is | `project.test.mjs` "RESTART AND REPLAY" (a torn last line; a child process killed with SIGKILL while projecting; the result equals an uninterrupted build) | not stated | **Carry**, where the canonical projection is persisted at all. If the canonical index is memory only and rebuilt at each start, there is nothing to recover and the test reduces to "replay gives the same digest" |
| 4 | Order-independent state digest: the same sources at the same versions give the same digest in any reading order; an incremental history ends at the same digest as one reading | `graph.test.mjs` "REPLAY IS DETERMINISTIC"; `project.mjs reconcile` | "projection digest" | probably covered; keep the test |
| 5 | History: a later statement in a slot supersedes, a dropped one is retracted, both are kept with the batch that ended them; `at(seq)`; `changesSince(seq)` | "A READING IS IDEMPOTENT ..." | `graph.supersede`, "as-of", `events.mjs` | covered by design; keep the test as a regression |
| 6 | A targeted reading changes only what is stated under the references it names | "A TARGETED READING ..."; `project.test.mjs` "IMPACT PROPAGATION" | not stated | carry to Slice B if extraction is per file |
| 7 | Contradictory evidence: every source's value is kept; the shown value is the strongest class's; a hypothesis never changes it; conflicts are listed with their sources | "CONTRADICTORY EVIDENCE ..." | `traverse.mjs` "contradiction sets" | compare; keep the test |
| 8 | What a model or an agent says is admitted only as hypothetical and unverified (`GRAPH_MODEL_CLAIM`) | "NEGATIVE CASES" (24 refusals by code) | "classification authoritative, observed, derived or hypothetical"; the inventory's risk "textual relations read as dependencies" | **Carry the rule if absent**, and the table of 24 negative cases as regression tests |
| 9 | Bounded traversal with a stated stop and where to continue; hard ceilings on depth and count | "BOUNDED TRAVERSAL" | "bounded k-hop" | covered by design; compare the bounds (directive section 12) |
| 10 | Impact by the meaning of each relationship: each relationship type states whether a change travels forward, backward, both ways or not at all; a hypothetical edge carries nothing unless asked | "IMPACT follows the meaning of each relationship" | "typed closure", "explained paths" | compare the direction table (`contract.mjs` `RELATIONS[rel].impact`) |
| 11 | Freshness per source: current, stale, unavailable, never read. An absent source is not applied as "nothing"; its last reading stays and is marked | `project.test.mjs` "SOURCE INVALIDATION AND FRESHNESS" | "stale marking" appears under federation only | **Carry**: the directive's section 4 asks that stale or unavailable sources be recorded visibly |
| 12 | A reader without the projector key verifies and queries and cannot write; an edited chain is refused whole | "RESTART: ..." | follows from `packages/ledger` | covered by the ledger |

## Unresolved differences

| | Canonical design | Pull request 70 | Which this session thinks is right |
|---|---|---|---|
| A broken reference (an edge to a thing no source describes) | "re-derive checks schema and referential integrity" reads as: refused on append | admitted, listed by `unresolved()`, shown as `(UNRESOLVED)` | the directive allows both. Refusal drops the edge: in this repository 171 import edges point at files that are not tracked (mostly review reproductions). Marking keeps them visible |
| A text reference (a register row naming a file) | a `mentions` relation, never a dependency | `applies-to`, classed `derived`, basis in the attributes | **canonical.** A separate type cannot be mistaken for an established link |
| A role assigned by the owner | `eligible-for` with its basis; `qualified-for` only from recorded measurements | `qualified-for` with `basis: owner-assigned, measured: false` | **canonical.** It follows the directive's rule that a preference is not a measured claim |
| Repository reads | at a commit (`git ls-tree`, `git show`) | the working tree, each file versioned by its content digest | **canonical** for replay. The working-tree reading is what found new, uncommitted files in this session; that is a convenience, not a requirement |
| Ledger shape | one kind per operation, in a `graph` domain | one `graph.batch` kind per cursor step | either, if behaviour 2 holds |
| Where admitted relations are recorded | a `graph` ledger domain | a `work.graph` kind on the work ledger (sketch only) | the coordinator's decision; item (k) 4 of the inventory names the authority question |
| Capability graph location | `pantheon/src/capability/` | read in `ophanim/graph/extract.mjs` | canonical: the selector lives in `pantheon/` and cannot import `ophanim/` |

## What was not built

No capability-based selection, no shared-prerequisite discovery, no lifecycle integration, no federation, no mutation runner for this code, no command-line verb. Demonstrations 1, 4, 5, 8 (at the level of tickets), 10 and 11 of the directive are not shown by pull request 70. The full suites were not run on its branch; its own 20 tests and the test lint pass.

## How to take something from it

```
git fetch origin ccr-3b496a5e-q1czrf
git show FETCH_HEAD:ophanim/graph/extract.mjs        # mutationTargets, the extractors
git show FETCH_HEAD:ophanim/graph/store.mjs          # the cursor rule (kinds().rederive), sync, diffOps
git show FETCH_HEAD:ophanim/graph/project.mjs        # recover, freshness, reconcile
git show FETCH_HEAD:ophanim/graph/graph.test.mjs     # 14 tests; no dependency on pull request 68
```

## Record of incorporation

To be filled by whoever integrates. This session incorporated nothing.

| Behaviour | Incorporated in (commit) | Already covered by | Left out, and why |
|---|---|---|---|
| | | | |
