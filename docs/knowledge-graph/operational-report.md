# Operational report: the knowledge-graph program

The directive's deliverable 7 (`docs/knowledge-graph/directive-2026-11-20.md`): exact commits, verified behaviours, limitations and remaining dependencies. Every number below was measured on this repository at the commit it names, on Node 24.22.1, by the command given beside it. **Nothing here is live operational evidence.** Each demonstration runs on a synthetic fixture, on the real repository read at a commit, or on both. No demonstration has run on live models or a live owner workload.

## 1. The deliverables

| # | Deliverable | Where | State |
|---|---|---|---|
| 1 | Current-state inventory | `inventory.md`, `.json` (pinned to `46ef822`, TELOS `0c9b539`) | Done. It records the state before the slices; this report is the state after them. |
| 2 | Versioned architecture and relationship contract | `architecture.md`; `ophanim.graph/v1`, contract 1.2.0 (`packages/graph/schema.mjs`) | Done. Section 19 indexes every slice. |
| 3 | Persistence, traversal, update, reconciliation | `packages/graph/`: the `graph` domain on the signed ledger, projection, bounded traversal, change events, replay and reconciliation, the signed snapshot (KG-1) | Done. |
| 4 | Integration with the workflows | See below | Done, with each advisory part labelled. |
| 5 | Tests, distinguishing mutations, reproducible evidence | The suites, the committed mutation runners, `scripts/kg-demonstrations.mjs` | Done; section 2 and section 3. |
| 6 | Federation demonstration | Slice E (`packages/graph/federation.mjs`); hub readiness (`hub-and-spoke.md`) | Done, synthetic. The hub is NOT APPROPRIATE NOW for production (section 5). |
| 7 | This report | here | |

How the graph enters each workflow (deliverable 4):
- **Investigation:** the context operation `graph` and the dossier's graph view (`ophanim/operate/context.mjs`).
- **Planning:** typed `requires` re-checked by version, and the planner's dossier with the learning-reuse and graph views (`ophanim/operate/stages.mjs`, `gates.mjs`).
- **Routing:** the capability advisory beside every live selection (`pantheon/src/capability/`). It is advisory: live selection is byte-identical with and without it.
- **Scheduling:** the graph cursor wakes the scheduler, and graph-derived gates block, unlock and refuse cycles (`ophanim/operate/graph-loop.mjs`).
- **Review:** advisory team proposals beside the live seats. Review independence and the three-lab floor are unchanged.
- **Reflection:** the learning graph (lessons, cycle findings, mutation outcomes, the self-repair lane's rounds), and the lessons adapter.

## 2. The twelve demonstrations (section 11)

`node scripts/kg-demonstrations.mjs` runs exactly the test cells below at HEAD. For each cell it lists the committed mutations that cell decides, read from each runner's table as text. Measured at `e664d4d`: every cell passed.

| # | Demonstration | Cells (tests passed) | Deciding mutations | Basis |
|---|---|---|---|---|
| 1 | Shared dependency discovery | `graph-d1-work` (2/2), `graph-d2-concurrency` (1/1) | 6: graph-d1 C1, S1, S2; graph-d2 G6, G9, G17 | synthetic work ledger; two real processes |
| 2 | Impact propagation | `graph-d1-reassess` (2/2), `impact` (4/4) | 4: graph-d1 R1, R2; graph-b B4, B5 | the real repository; synthetic work |
| 3 | Historical traceability | `impact` trace (1/1), `graph-d1-why` (6/6) | 3: graph-b B10; graph-d1 Y1, Y2 | real components; one synthetic plan |
| 4 | Capability-based routing | `capability-eligibility` (7/7), `capability-sdk-bridge` (3/3) | 10: capability C1, C2, C3, C8, C9, C10, C13, C20, C21, C22 | the real registries; the advisory only |
| 5 | Learning reuse | `graph-d1-learning` (6/6), `graph-lane-learning` (3/3) | 7: graph-d1 L1, L2, L3, LL1 to LL4 | the real lessons registry; synthetic cycle ledger and lane rounds |
| 6 | Contradictory evidence | `packages/graph ledger` (2/2), `graph-context` (1/1) | 4: graph G4, G5, G15; graph-b B15 | synthetic claims |
| 7 | Source invalidation | `graph-d1-reassess` (3/3) | 3: graph-d1 R1, R2, R3 | synthetic |
| 8 | Concurrency | `graph-d1-concurrency` (1/1), `graph-d2-concurrency` (1/1), `packages/graph concurrency` (1/1) | 6: graph-d1 C1; graph-d2 G6, G9, G17; graph G12, G13 | two real processes each |
| 9 | Restart and replay | `graph-d1-concurrency` kill (1/1), `replay` (6/6), `checkpoint` (16/16) | 22: graph G8, G16, G24; checkpoint K1 to K12 and K16 to K22 | a real SIGKILL mid-write; synthetic ledgers |
| 10 | Federation | `federation` (9/9) | 21: federation E1 to E21 | synthetic departments |
| 11 | Actual lifecycle integration | `graph-d2-demo11` (1/1) | 2: graph-d2 G3, G4 | **synthetic**: scripted seats through the real scheduler, stages and graph loop |
| 12 | Negative cases | `extract` (1/1), `graph-d1-why` (2/2), `graph-d1-reassess` (1/1), `schema` (4/4), pentest `f-graph-integrity` (3/3) | 7: graph G1, G2, G3, G11, G20; graph-b B16; graph-d1 Y1 | synthetic; attacks |

Totals: 88 tests across 26 cells, all passing.

### Cells that no mutation decides

Every demonstration has at least one cell that committed mutations decide. Three cells are decided by none:
- **The D1 kill-mid-write cell (9)** rests on the package-level rule "a replay that cannot read a source invents nothing", which mutation G16 checks in `packages/graph/tests/replay.test.mjs`.
- **The D1 stale-reassessment cell (12)** rests on "a derived assertion is not established once its input is gone", which mutation G19 checks in `ledger.test.mjs`.
- **The pentest cell (12)** is an attack guard. It fails when an attack it refuses starts to succeed, which is its own distinguishing check.

B15 and B16 (`e664d4d`) closed the other two cells that had none, the context operation's contradiction (6) and the extract-level negatives (12).

## 3. Verification

- **At `0bf1cc5` (KG-23)**, `npm run test:gates` with every suite run once: model-client 62/62, ledger 47/47, graph 65/65, pantheon 1965/1965, `test:proof` 708/708, `test:gates:self` 104/104; every suite PASS.
- **The merge of PR #67's last commits** (`709a9f8`, verified at `8b55cc0`): 279 of 279 mutations killed, each runner on what the other side changed (PR #79's description).
- **The pentest:** every attack refused or a registered hole confirmed; 0 new holes.
- **Every runner:** `--check` passes, and `ophanim/graph/extract.test.mjs` reads every runner's table in full.
- **CI:** `main`'s own run on `6511f59` passed.

## 4. Governance preserved (section 12)

| Must be preserved | How |
|---|---|
| The authoritative status and work ledgers | Read only, against pinned anchors (`ophanim/graph/extract/ledgers.mjs`, `work.mjs`). The graph never writes them; an absent ledger is refused, and nothing is created. |
| TELOS verification and authorization | Untouched. The graph pins TELOS `0c9b539` and reads it. |
| Model and lab independence; contributor lineage | The capability advisory records lab lineage and never restricts a producer. Review-by-lab exclusion and the three-lab floor are the live rules, unchanged. |
| Worktree isolation and execution ownership | Unchanged. The concurrency report uses the owned-path grammar's overlap. |
| Centralized billing; request-level accounting | Unchanged; the bridge's transport is recorded as primary metered Gemini through the gateway. |
| Recovery, rollback, checkpoints | The graph's snapshot sits on top of the ledger's own checkpoints, and is derived and deletable. The self-repair lane lands only by fast-forward on its own line, with its revert recorded. |
| Evidence versions; immutable history | Every fact carries its source version, and supersede, retract and invalidate are appended, never rewritten. |
| Bounded exploration | Traversal is bounded in nodes, depth and bytes; change events are capped (`CHANGE_LIST_MAX`); a forged continuation is refused. |

## 5. Limitations and remaining dependencies

**Owner decisions (none can be made by the program):**
- KG-4: key custody, including the snapshot key; traversal defaults; the federation production policy and placement; the qualification criterion; the advisory-to-live switch; lab breadth; snapshot audit and retention; API-seat teardown.
- The self-repair lane's switch: an owner-signed `self-repair` item In progress.
- The protected-list calls: the scheduler and work ledger, `packages/graph/checkpoint.mjs`, and L-135.
- KG-24: whether the bridge session's state is removed per session.

**Before federation goes to production:**
- KG-14: the hub does not check `previous`.
- KG-21: the hub accepts a rolled-back export.
- KG-8: a re-created ledger is the same instance, and replicas from one template share an anchor.
- KG-22: the pure-hub separation is not enforced.
- Hub readiness: NOT APPROPRIATE NOW (R5, R10).

**Open register entries:**
- KG-2 (the lock after a SIGKILL), KG-5 (the advisory's record size), KG-6 and KG-7 (partly done), KG-9 (partly done).
- KG-10 (what the SDK seat's jail retains), KG-12 and KG-13 (fixture-only proofs of D1 and D2).
- KG-15 to KG-18 (GLM 5.3's bounty: an unbounded review floor, billing that charges then refuses, `__proto__` lost on decode, symlinks in jail reach).
- KG-19 (a wall-clock test fragile under load), KG-20 (concurrent suites share the tmpdir), KG-24.

**In progress:**
- PR #75's opt-in dependency sources (function calls, the runtime record, TELOS/ARGO/LEXI), taken over by the coordinator: main merged in, its 110 tests passing, its mutation runner being written (KG-30 to KG-38).

**Not demonstrated live:**
- No demonstration has run on live models.
- Demonstration 11 is synthetic.
- The federation's departments are synthetic.
- The capability metrics are synthetic.
- No live execution record exists in this container.

## 6. Exact commits (on `main` through #79, then this branch)

| Work | Commits |
|---|---|
| Directive, inventory | `46ef822`; `992d094` (`d017367`, `b7396a5`) |
| Slice A: foundation and contract | merge `97cc60f`; `c34b98f` |
| Slice E: federation | merge `23a0cf4`; `bb25b5b` |
| Slice B: systems and evidence | merge `d3d8890`; `dcecdc9`, `e6c4fe0` |
| Slice C1: capability, advisory | merge `4781ce0` |
| Replay checkpoint (KG-1) | `fc02390`, `8b2f2fd`; merge `dded52f` |
| Slice C2: the SDK seat's bubble | `e0902da`; merge `e20e0cf`; `8df1c4c` |
| Jail descriptors (KG-11), turns' transport (KG-6) | `220b098`, `6ff386e`, `552022d`; merge `3203db8`; `84c6619`, `822559c`, `01ac30a`, `90407d3` |
| Slice B2: dependency sources | `dd2b578`, `8a1c79e`; merge `d4446f8`; `d2d7c04` |
| Slice D1, compaction (KG-9) | `487f63d`; merge `02a7916`; `04ed307`; merge `0f4d309` |
| Slice D2: the graph in the loop | `0a3df11`, `c6b167f`; merge `2ecb1de`; outside-lab fixes `1bc8a86`, merge `18b2a59` |
| Toolkit (T1 to T4); T2 per mutation | `e8e6d88`, `960bc3e`; merge `1f6e2ae`; `ac21ccc` |
| Pentest suite | `bf4a663`; merge `fc8a88a`; `45dab29`, `8e39867` |
| Hub readiness | `7d77566`, `c104196`; merge `188937b`; `3f5fd77` |
| Self-repair lane | `5ad4b62`, `27a9992`, `7a6e9f3`; merge `09424ad`; `f4f5bf0`, `338d375`, `566ef3a`, `f6de0f4`, `fe64246`, `578856a` |
| Merge of PR #67's last commits | `73dc8d0`, `682460e`, `b9760b9`, `53f71fb`, `89de1fe`, `709a9f8`, `8b55cc0`, `b98f074`; on `main` as `6511f59` |
| KG-23, the bridge's capability | `0bf1cc5`, `eca61d4` |
| The demonstrations, run | `e664d4d` |

## 7. Reproducing this

```
export OPHANIM_TELOS_ROOT=<a checkout of TELOS at 0c9b539>
node scripts/kg-demonstrations.mjs --json demonstrations.json   # the twelve demonstrations, their cells and deciding mutations
npm run test:gates                                              # every suite once, per file
node scripts/test-gates/affected-runners.mjs <base> HEAD --run  # the mutations a change touches
node scripts/pentest/run.mjs                                    # the attacks
```
