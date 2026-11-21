# Knowledge graphs: the twelve demonstrations

The directive's section 11 requires twelve behavioural demonstrations. It also requires distinguishing tests and targeted mutations, and it asks for synthetic demonstrations to be kept apart from live operational evidence. This document records, for each demonstration:
- where it is shown;
- whether it runs on real or synthetic data;
- which mutations establish that it is enforced;
- what remains for live evidence.

**Real** means this repository, its history, its registries, its register, its lessons and its status ledger, read at a pinned commit.

**Synthetic** means fixtures written through the real writers: work, cycle and status ledgers with synthetic keys, temporary repositories, and synthetic departments. This container holds no work or cycle ledger, no provider keys and no owner key.

| # | Demonstration | Shown in | Data | Enforced by (mutation runners) | Live evidence still needed |
|---|---|---|---|---|---|
| 1 | Shared dependency discovery | `ophanim/graph/graph-d1-work.test.mjs`; in the loop, `ophanim/operate/graph-d2-loop.test.mjs` and `graph-d2-demo11.test.mjs` | Synthetic work items; whether the prerequisite exists is checked against the real capability graph and repository | `graph-d1.mutate.mjs` S1, S2; `graph-d2.mutate.mjs` G5, G6, G8, G16 | The owner's work ledger |
| 2 | Impact propagation without invalidating unrelated work | `ophanim/graph/impact.test.mjs`, `cli.test.mjs` (real); `graph-d1-reassess.test.mjs` (plans and qualifications); `graph-d2-loop.test.mjs` (an unrelated item's gate unchanged) | Real repository; synthetic work | `graph-b.mutate.mjs` B4-B6, B14; `graph-d1.mutate.mjs` R1-R3; `graph-d2.mutate.mjs` G5, G7, G12 | None for the systems graph; the owner's work ledger for the work graph |
| 3 | Historical traceability | `ophanim/graph/cli.test.mjs` (`trace`); `graph-d1-why.test.mjs` (why it exists: requirement, decision, introducing commit, later corrections); the shallow-history case | Real history, plus a temporary repository cloned shallow | `graph-b.mutate.mjs` B10; `graph-d1.mutate.mjs` Y1, Y2 | None |
| 4 | Capability-based routing | `pantheon/tests/capability-eligibility.test.mjs` (a data change gives a new explainable decision), `capability-advisory.test.mjs` | Real registries; advisory (owner decision of 2026-11-20: live seats unchanged until the metrics are understood) | `capability.mutate.mjs` (17 mutations, C1 to C19) | The advisory-to-live switch and the qualification criterion are the owner's (KG-4) |
| 5 | Learning reuse | `ophanim/graph/graph-d1-learning.test.mjs` (a failure in `context.mjs` is related to its established classes, their detector tests and prior repairs); the dossier view in `graph-d2-stages.test.mjs` | Real lessons registry, register and runners | `graph-d1.mutate.mjs` L1-L3; `graph-d2.mutate.mjs` G10, G15 | Real cycle-ledger findings |
| 6 | Contradictory evidence stays distinguishable | `packages/graph/tests/traverse.test.mjs` (contradiction sets); `ophanim/graph/graph-context.test.mjs` (through the context op) | Synthetic and real | `graph.mutate.mjs` (classification and override mutations); `graph-b.mutate.mjs` B7 | None |
| 7 | Source invalidation with no unsupported completion claim | `ophanim/graph/impact.test.mjs` (changed and missing sources); `graph-d1-reassess.test.mjs` | Real repository; synthetic work | `graph-b.mutate.mjs` B11; `graph-d1.mutate.mjs` R2, R3 | None |
| 8 | Concurrency | `packages/graph/tests/concurrency.test.mjs`; `ophanim/graph/graph-d1-concurrency.test.mjs`; `ophanim/operate/graph-d2-concurrency.test.mjs` (two real processes each) | Synthetic | `graph.mutate.mjs`; `graph-d1.mutate.mjs` C1; `graph-d2.mutate.mjs` G6, G9, G17 | None |
| 9 | Restart and replay | `packages/graph/tests/replay.test.mjs`, `checkpoint*.test.mjs`; `graph-d1-concurrency.test.mjs` (SIGKILL, then reopen, replay and snapshot) | Real graph (snapshot equality) and synthetic | `graph.mutate.mjs`; `checkpoint.mutate.mjs` K1-K30; `graph-d1.mutate.mjs` | None |
| 10 | Federation | `packages/graph/tests/federation.test.mjs` | Synthetic departments (Finance, Technology, a central instance) | `federation.mutate.mjs` E1-E21 | The production access policy, key custody and placement are the owner's (KG-4) |
| 11 | Actual lifecycle integration | `ophanim/operate/graph-d2-demo11.test.mjs`: intake; planning with typed requires; a shared prerequisite; block, then unlock on establishment; implementation, three-lab review and validation, with records written back into the graphs | SYNTHETIC: a fixture status ledger signed by a synthetic owner key, scripted seats, no provider request | `graph-d2.mutate.mjs` G1-G19 | LIVE needs the owner's signed status item, the owner's machine and keys, and the unapplied `docs/execution/kg-d2-proposed.patch`. The commands are in `slice-d2.md` |
| 12 | Negative cases | invalid identities and unsupported edges: `packages/graph/tests/schema.test.mjs`, `ledger.test.mjs`; stale records, broken references and unregistered extractors: `ophanim/graph/extract.test.mjs`, `graph-d1-*.test.mjs`; unauthorized writes: `federation.test.mjs`; unverified model claims: `capability-graph.test.mjs` | Real and synthetic | `graph.mutate.mjs`, `federation.mutate.mjs`, `graph-b.mutate.mjs` B12, B13, `capability.mutate.mjs`, `graph-d1.mutate.mjs` | None |

## What separates synthetic from live

- **The work graph** (demonstrations 1, 2, 7, 8 and 11 in part) has run only on synthetic work ledgers. This container holds none. The first real run is on the owner's ledgers (KG-12).
- **Routing** (demonstration 4) is advisory by the owner's decision. The live switch waits for the metrics and an owner-defined qualification criterion.
- **Federation** (demonstration 10) uses synthetic departments, because no departmental instances exist yet.
- **The lifecycle** (demonstration 11) is synthetic until the owner signs an item and runs it live.

## Register

The open items these demonstrations leave are in `docs/OPEN-LIMITATIONS.md`: KG-4 (owner decisions), KG-7, KG-9, KG-12 and KG-13.
