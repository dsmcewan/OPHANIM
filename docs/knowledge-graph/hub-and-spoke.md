# Knowledge graphs: OPHANIM as the hub of three replicated departments

**The owner's words (2026-11-20)**: "I want Ophanim to determine if its appropriate to Hub and Spoke. Say into three domains." Then: "But being the central one that runs the collective knowledge graph." Then: "No it doesn't amoeba split... replicates is the better word."
**The question, as the coordinator framed it after both clarifications**: *Is it appropriate for OPHANIM to replicate into three departmental instances (Finance, Technology, Compliance: full foundries from the same code, each with its own ledgers, authority and graph), with the original as the central hub running the collective knowledge graph, and what must be true first?* This is the directive's section 6 ("Central OPHANIM: the enterprise-level orchestration and relationship hub"; `docs/knowledge-graph/directive-2026-11-20.md`), with its own example: "a Finance process depends on a Technology service or produces evidence consumed by Compliance."
**Advisory.** Nothing is split, federated or replicated for real, and no production behaviour changes. The production federation policy and its placement are the owner's (register KG-4).
**Base** `d0ccbc3` (branch `kg/hub-spoke`; the redirect's ownership amendment `fa53d45` cherry-picked as `80df929`). Every number below is of the repository at `d0ccbc3`, on this container (Node v24.22.1, 4 CPUs, 16 GB), measured by `node ophanim/graph/cli.mjs hub-readiness --scales 1,4 --commit d0ccbc3` (651 s; run alone, after an earlier run whose x1 phase overlapped a test run of mine: that run gave the same verdict and statuses, with slower opens).
**Dropped by the redirect**: the first brief's code partition (P-dir, P-detected, P-file, criteria H1-H8). OPHANIM does not divide its code; it replicates whole.

## 1. The determination

**NOT APPROPRIATE NOW.** Two blocking criteria fail: **R5** (the hub accepts a spliced chain, a rolled-back chain and a re-created ledger) and **R10** (replicas provisioned from one template share one anchor, and one is imported as another). Both are holes in `packages/graph/federation.mjs` (KG-14, KG-8, and one unregistered), not in the shape. The shape itself is sound where it was measured: the hub held none of 35,593 (x1) and 142,343 (x4) withheld values, never changed a department ledger, linked exactly the permitted cross-department dependencies with provenance, marked a disconnected department stale, caught up by version with no duplicate, let every department run while it was down, and carried a Technology defect to Finance and, through Finance, to Compliance as signed notices each recorded with the recipient's own key.

**Recommended shape**: (a) a **pure hub**, with Technology a replica like Finance and Compliance (section 5). **The path to production**, in order: fix the hub's ingestion (KG-14 and the rollback), make an instance's identity something a re-created ledger cannot share (KG-8) and generate every replica's keys at creation; the owner's decisions (KG-4); a `replicate` command; code lineage in exports and a replica upgrade path; the pure-hub rule; the central snapshot wired in; the hub's catch-up taken off the foundry tick; lessons permitted to cross (section 7).

## 2. Method

**The federation** (`ophanim/graph/fixtures/hub-world.mjs`): three departmental instances and the central hub, each on its OWN real `packages/ledger` chain with synthetic keys generated per world, built only with Slice E's machinery (`department`, `definePolicy`, `openCentral`, `outboxTransport`, `noticeTransport`) and the coordinator's test policy `POLICY` imported, unedited, from `packages/graph/tests/federation-fixture.mjs` (public with details, internal as reference, restricted withheld; `consumes`, `depends-on`, `implements`, `produces`, `verifies` may cross; placeholders and counts on). That fixture's own world is two departments, so the three-department world is built beside it from the same parts.

**The directive's example, seeded**: Technology publishes its payments API (`technology/systems/service/payments-api`, internal); Finance's payment run (`finance/systems/process/payment-run`) pins it with a `depends-on` cross-instance reference; Finance's run `produces` its reconciliation report (`finance/evidence/record/recon-report`, public); Compliance's control test (`compliance/systems/process/control-test`) pins the report with `consumes`. Two references are FORBIDDEN and must never link: Compliance's `depends-on` to Technology's restricted card vault, and its `mentions` of the API (a type the policy does not permit).

**Sizing** from OPHANIM's own graph (`stats` at `d0ccbc3`: 28,255 facts, 5,590 entities, 22,665 relationships). At x1 each department holds 5,590 entities and 22,665 relationships; at x4, 22,360 and 90,660. Access mix (a proposal): entities 1 in 10 restricted, 4 in 10 internal, the rest public; relationships 1 in 10 restricted, 3 in 10 internal, 1 in 25 a `mentions`. Every withheld value is a sentinel `SYNTH-WITHHELD-...`; every restricted entity's key starts `zzsealed`, so one pass over a directory finds any leak.

**Runs** (`ophanim/graph/hub.mjs`): the COST criteria (R1, R2, R4, R8) at each scale in a process of their own (`fixtures/hub-child.mjs scale`, heap 8 GB): seed, the hub's first catch-up, the search, the links, two ticks (Technology's API changes, Finance re-pins it, Compliance re-pins the report; each also changes one node of its own), a signed central snapshot, then the central opened in FRESH processes, in full (the hub as built) and twice from the snapshot. The BEHAVIOURAL criteria (R3, R5, R6, R7, R9, R10, R11, R12) on small federations (24 entities, 60 relationships per department): their logic does not depend on size. The REPOSITORY facts from the graph built at the commit: its size, the register through the records source (`ophanim/evidence/record/register/KG-*`, KG-4's row parsed by `registerEntries`), the variables the run-time code reads to find its state, and OPHANIM's own graph exported as a department; and 20 CODE facts located at file:line in the commit's tree (`codeFacts`; none is a gap).

**Thresholds** are PROPOSALS (`THRESHOLDS` in hub.mjs), the owner's to change. A criterion is `pass`, `fail` (blocking or not), `gap` (something that does not exist) or `condition`. The verdict: a blocking fail makes it NOT APPROPRIATE NOW; otherwise any condition or gap makes it APPROPRIATE WITH CONDITIONS, in `PRIORITY` order (integrity and identity first, cost last).

## 3. The criteria

| | Criterion | Threshold (proposal) | Measured | Status |
|---|---|---|---|---|
| R1 | Authority | 0 withheld values and 0 owner-disclosed restricted ids in the central; every department ledger byte-identical across every hub operation; a central write into a department refused | x1: 0 of 8,480 restricted and 27,113 internal values found in 93.2 MB (30 files); x4: 0 of 33,908 and 108,435 in 374.5 MB. 0 restricted ids disclosed by their owner (3 occurrences of the vault's id are in Compliance's OWN reference to it, by design: KE3 discloses a reference's target id). Ledgers unchanged across 3 of 3 hub operations at each scale. Central write: `FEDERATION_UNAUTHORIZED` (`federation.mjs:576`) | **pass** |
| R2 | The collective graph | exactly the permitted links, each with 2 imported inputs and a pinned `{instance, anchor, node, version}`; 0 forbidden | both scales: `depends-on payment-run -> payments-api` and `consumes control-test -> recon-report`, derived by `federation.linker`, established; the vault reference unresolved (`missing-node`), the `mentions` withheld at Compliance (1); a change to the API reaches the run, the report and the control test (3 instances) | **pass** |
| R3 | Freshness and recovery | a disconnected department stale, and every link on it; by version, once; departments run with the hub down | Compliance offline: `stale` ("unreachable ..."), only its link stale, Finance and Technology current. Hub offline: 3 of 3 departments published, answered, and `pull` said unreachable. Back: each imported exactly the exports since, in outbox order, 0 duplicates; a second catch-up imported 0 and issued 0 notices | **pass** |
| R4 | Hub cost | fresh-process open <= 1000 ms at x1 by the hub AS BUILT (margin 500 ms) | x1 (63,210 facts): full open 18,134 ms, 959 MB; from the snapshot 466 and 546 ms, 234 MB (24.8 MB snapshot written in 835 ms; digest equal). x4 (252,852 facts): full 84,755 ms, 4,110 MB; snapshot 2,196 and 2,199 ms, 681-687 MB (99.8 MB, written in 8,643 ms). The hub's first catch-up: 8.0 s (x1), 42.9 s (x4); its process 2.3 GB and 5.9 GB. The hub as built opens in full: nothing writes or passes a central snapshot | **gap** |
| R5 | Ingestion integrity | 0 spliced, forked, rolled-back or spoofed exports accepted | spliced (KG-14): 2 stored, 0 imported, freshness `current`, pending 0. Fork: refused `FEDERATION_FORK`. Rollback: a signed export of an earlier view (seq 2) chained after seq 3: stored, imported, projection reverted, `current`. Another anchor: `FEDERATION_IDENTITY`. Unpinned key: `FEDERATION_SIGNATURE`. Genesis spoof (KG-8): re-created ledger, same anchor, forged fact imported, `current`. Copied value (KG-8): in the hub | **fail (blocking)** |
| R6 | The hub's dual role | the hub's own facts reach the collective graph only through an export under the same policy | a department named as the central: refused (`federation.mjs:479`). A caller-added origin (`openCentral` spreads `...opts` after its origins and sources, `federation.mjs:569`): a hub-namespace fact recorded and established, its internal detail in the hub's files, no policy applied. OPHANIM's own graph as a department: 5,401 nodes and 16,108 relationships exported (all internal: references only), 6,552 relationships withheld (types the policy does not permit), 5.5 MB, 615 ms | **condition** |
| R7 | Governance | the hub cannot record work, a status or an intake in a department; the owner's decisions listed | central write refused; a hub-signed status into a replica's status ledger refused by its chain ("the orderer co-signs every entry"), whose kind also admits only the ledger's own operators as authors (`status.mjs:40`); a `federation` intake refused even under the replica's own key (`work-ledger.mjs:86`); no department keyring holds a central key. KG-4 `pending owner` (`docs/OPEN-LIMITATIONS.md:211`) | **condition** |
| R8 | Load | open + an incremental catch-up <= 1000 ms per tick at x1, as built | x1: incremental catch-up 11,957 and 10,462 ms (3 imports, 3 notices each); a tick 28,595 ms as built, 10,928 ms from a snapshot. x4: 57,161 and 47,244 ms; 131,999 and 49,439 ms. A department's own observe and publish: 4.0-5.5 s (x1), 30-36 s (x4) | **fail (not blocking)** |
| R9 | Replication | one command or function; own ledgers, anchors, keys, config; nothing shared | 3 replicas from one commit, each with 5 ledgers (status, work, cycle, run, graph): 15 of 15 anchors distinct, roots and key directories disjoint, billing resolved through the one policy. But no command or function in the code does it (no run-time symbol for it), and the defaults collide (section 6) | **gap** |
| R10 | Identity under replication | distinct anchors also under identical authority; no replica accepted as another | replicas from one template: status, work, cycle, run distinct (their creators generate keys); **graph identical**. With identical authority all 3 department anchors equal, and Finance, holding the template keys, was imported as Compliance (1 export, forged fact in the hub). With keys of its own: 3 distinct anchors, `FEDERATION_SIGNATURE` | **fail (blocking)** |
| R11 | Code lineage | an export names its code; code repairs reach replicas by version | an export's fields: `anchor, audience, changes, contract, exported_at, id, instance, nodes, policy, previous, relationships, schema, seq, signature, version, withheld`: `contract` is `ophanim.graph/v1` (`federation.mjs:302`), never the contract version (1.2.0), the commit or an extractor version (source nodes never leave: `federation.mjs:223`). An export with a type the hub's contract lacks: refused whole. Federation carries facts, never code | **gap** |
| R12 | Collective learning | a defect reaches every dependent replica, transitively, with provenance, recorded with its own key; a lesson can cross | a Technology defect: 1 notice to Finance, 1 to Compliance (through Finance's report), 0 to Technology; origin `technology`, its export, every change's ledger entry, via `central`; each recorded by the recipient's receiver key (5 own keys, 0 foreign); 0 ledger files in the hub. A lesson (`learning/failure-class` with `applies-to`): withheld under the test policy (1), not linked; `applies-to` is admissible across if the owner permits it | **condition** |

## 4. The holes, measured (asserted as they are; none fixed here)

- **KG-14, a spliced chain** (`federation.mjs:520`: `offer` refuses only a second export after the same predecessor). A legitimately signed export whose `previous` names an id the hub never received, and one chained after it, are both stored; the catch-up imports neither; `freshness` reads `current` with 0 pending. A buggy or hostile department halts its own propagation silently. HIGH, as registered.
- **UNREGISTERED, a rollback**: an export of the department's EARLIER view (seq 2), signed and chained after the stored tail (seq 3), is stored and imported, and the hub's projection of that department goes back; `freshness` reads `current`. The hub checks neither that `seq` increases nor that `version` moves forward. Same root as KG-14 (the hub trusts the chain fields); the coordinator may fold it into KG-14 or register it.
- **KG-8, the genesis spoof**: a department ledger re-created with the identical authority has the identical anchor; signed with the department's export key and chained after the tail, its forged inventory is imported as the department's. It needs the department's private keys: a custody failure, or replicas provisioned from one template (R10).
- **KG-8, the copied value**: a restricted value copied by the department into a public attribute leaves under the policy and reaches the hub; the hub cannot tell (the scrub finds withheld ids, not values).
- **Guards that held**: a fork (`FEDERATION_FORK`), another instance's anchor (`FEDERATION_IDENTITY`), an unpinned key (`FEDERATION_SIGNATURE`), a central write into a department (`FEDERATION_UNAUTHORIZED`), a department named as the central, a hub-signed status, a federation intake.

## 5. The hub's dual role: two shapes (R6)

| | (a) a PURE hub; Technology a replica like the others | (b) the hub is also Technology |
|---|---|---|
| What the code enforces | the central's namespace holds imports and derived links; it refuses a department named as itself and any write into a department | the same, but nothing stops the hub recording its OWN facts in its namespace: `openCentral` spreads its caller's options after its origin registry and sources (`federation.mjs:569`), and a fact so recorded is in the collective graph with no export and no policy (measured) |
| OPHANIM's own facts | exported by the Technology replica under the same policy as every spoke (measured on the real graph: 5,401 nodes as references, 6,552 relationships withheld) | either the same, as a SEPARATE department instance on the hub's machine (its own ledger, keys and outbox), or privileged, if they are put in the hub's namespace |
| Authority and keys | the hub holds only the central's import, link, notice and snapshot keys | one machine holds the hub's keys and a department's export, placeholder and receiver keys (KG-4 custody) |
| Independence | a hub outage leaves all three departments working (R3) | a hub outage takes Technology down with it |
| Load (R8) | the hub carries only the collective graph's catch-up | the hub also carries Technology's foundry loop and its self-repair lane |

**Recommended: (a).** It is the only shape in which every department is treated the same, and nothing the code permits can make the hub's own facts privileged. If (b) is chosen, Technology must still be a separate department instance on the hub's machine, never facts in the central's namespace. Until a guard exists, that is a deployment rule: `openCentral` would have to refuse a caller's `origins` or `sources`, and the central's namespace would have to admit only the linker. That change belongs in `packages/graph`, which is the coordinator's.

## 6. Replication, identity and code lineage (R9, R10, R11)

**What exists.** Each ledger has its own creator, and each makes its own keys: `openStatusLedger({create: true})` (`packages/ledger/status.mjs`), `openWorkLedger` (`ophanim/operate/work-ledger.mjs`), `openPantheonLedger` for the review cycles and `openSystemLedger` for the runs (both on `openLedgerHome`, `packages/ledger/home.mjs`, keys in `<root>/keys`). The graph ledger is `createGraphLedger`, with the caller's keys. Billing goes through `resolveGeminiBilling`. `replica()` in `fixtures/hub-world.mjs` composes them in a temporary directory: 3 replicas, 15 distinct anchors. **No command or function in the code composes them.** No run-time symbol for replication exists, and nothing outside the manifest was needed for the synthetic one.

**What collides by default** (every default a replica must override; each located at the commit):

| State | Default | Where |
|---|---|---|
| status ledger | the checkout's `status/ledger` (TRACKED: 87 files at `d0ccbc3`) | `ophanim/operate/cli.mjs:133`; the graph CLI `ophanim/graph/cli.mjs:86` |
| its expected anchor | THIS instance's genesis, pinned in code (`STATUS_ANCHOR`) | `ophanim/graph/extract/ledgers.mjs:38`: a replica's own status ledger would read as unavailable to its own graph |
| work ledger | the checkout's `status/work` | `ophanim/operate/cli.mjs:134` |
| review-cycle ledger | `<git common dir>/pantheon-cycles`: SHARED by every worktree of one clone | `pantheon/bin/pantheon-review-cycle.mjs:81` |
| seat records | `~/.pantheon`: shared by every instance of a user | `pantheon/src/seat/store.mjs:9` (read from a parameter, so Graph B does not state this variable: a gap of the environment extractor) |
| run ledger anchor | `OPHANIM_LEDGER_ANCHOR` from the environment | `ophanim/ledger/system.mjs:58` |
| seats | `FIT_MATRIX`, a code table at the commit: no per-instance seat config | `pantheon/src/route/fit-matrix.mjs:42` |

The variables the run-time code reads to locate an instance's state, as Graph B states them: `OPHANIM_LEDGER` (4 readers), `OPHANIM_LEDGER_ANCHOR` (2), `OPHANIM_STATUS_KEYS` (1), `OPHANIM_STATUS_LEDGER` (3), `OPHANIM_WORK_LEDGER` (1), `PANTHEON_CYCLE_LEDGER` (2), `PANTHEON_CYCLE_LEDGER_ANCHOR` (1), `PANTHEON_EVIDENCE_STORE` (1).

**Identity (R10).** KG-8, exercised directly: the four ledgers whose creators generate keys get distinct anchors even when the replicas are made the same way. The graph ledger made from one key template does not: all three department anchors are equal, and the hub, pinning `{instance, anchor, keys}`, imports Finance's signed export as Compliance's. The graph's key ids are fixed names (`graph-operator`, ...; `ophanim/graph/extract/index.mjs:145`), so only their material tells instances apart. **Replication is unsafe until KG-8 is fixed**: a genesis must carry what makes an instance unique (a nonce, or the instance name), and every replica must generate its own keys at creation, never from a template.

**Code lineage (R11).** What stays replica-local: its five ledgers and their keys, its `PANTHEON_HOME`, its billing setting, its domain sources. What is code, on the hub's line: everything else. That includes the seats (`fit-matrix.mjs`) and the lessons registry: `ophanim/lessons/corrections.json` is a tracked file, so a lesson is a code change. A replica's self-repair lane would make its code diverge. So code repairs must land on the hub's line, and each replica must upgrade to a commit by version. Federation cannot carry this:
- An export carries graph facts and names the contract id `ophanim.graph/v1` (`federation.mjs:302`). It never names the contract version (1.2.0), the commit or an extractor version, so the hub cannot tell a replica that is behind it (`federation.mjs:403` checks the id only).
- An export carrying a type the hub's contract lacks is refused whole: on an upgrade, the hub goes first.
- A snapshot is bound to its own instance's contract and extractors (`packages/graph/checkpoint.mjs:277`).

Code propagation is a GAP: confirmed.

## 7. Verdict and the path to production

**NOT APPROPRIATE NOW** (failing R5, R10). The path, in order (each step is a condition; the first two block):

1. **R5**: the hub's `offer` requires that `previous` is the stored chain tail and that `seq` strictly increases (KG-14, and the rollback); `freshness` counts what is stored but unimported. In `packages/graph/federation.mjs` (the coordinator's).
2. **R10**: KG-8 fixed (a genesis no re-created ledger can share), keys generated per replica at creation, never from a template; the hub pins export keys that no other department holds.
3. **R7**: the owner decides (KG-4): key custody for every department and the hub, the production access policy, placement and transports, freshness bounds and cadence, which instances federate; and whether work may ever cross. Today it cannot: a department's work comes only from its own owner-signed status ledger.
4. **R9**: one `replicate` command that composes the creators into a fresh instance with no default that points into the checkout, `~/.pantheon` or the git common directory, and the status anchor passed in, not pinned in code.
5. **R11**: exports name the commit and contract version that made them, and the hub refuses or labels a replica that is behind; code repairs land on the hub's line, and replicas upgrade by version, the hub first.
6. **R6**: shape (a), the pure hub; a guard in `openCentral` against caller-added origins and sources.
7. **R4**: the signed central snapshot wired in (x1: 0.47-0.55 s from it against 18.1 s in full, around the coordinator's 0.5 s margin). At x4 even the snapshot open takes 2.2 s: the central grows with every department, so it needs compaction per department (KG-9).
8. **R8**: the hub's catch-up off the foundry tick, on its own schedule. Today it costs 10.9 s a tick from a snapshot at x1, and 28.6 s as built. It also needs exports that carry changes rather than whole projections, and a propagation cursor (KG-8), before the self-repair lane joins the same machine.
9. **R12**: the owner's policy permits `applies-to` so lessons cross; until then only defects in shared dependencies propagate.

## 8. Gaps

- **Graph B states no writer of any ledger.** The paths source records reads (read, probe, path), the environment source variable reads and sets, and nothing records a file writing a ledger. The first brief's store-attribution (H5) was a gap for every store. Under the redirect, each replica's ledgers are its own by construction (R9).
- **Variables read from a parameter** (`env.PANTHEON_HOME`, `pantheon/src/seat/store.mjs:9`) are not stated by the environment extractor. The code fact stands in for them.
- **Dynamic imports with a computed specifier** are gaps on their files' nodes (`import_gaps`; Slice B2 counted 43 at `dd2b578`). They do not bear on this determination, which uses no import edge.
- **Synthetic departments**: nothing here is real departmental data, a real transport or real key custody.
- **The self-repair lane's load** (R8) is not measured: it is another agent's lane.

## 9. What the owner decides

1. Whether to replicate at all, and the shape: (a), a pure hub, or (b), the hub also Technology as a separate instance (section 5).
2. KG-4's federation items: the production access policy (and whether `applies-to` crosses), key custody for each replica and the hub (export keys, placeholder secrets, receiver keys, the central's import, link, notice and snapshot keys, rotation), where each instance runs and its transport, the freshness bound and publishing cadence, which instances federate and whether notices pass to third instances. Also KG-4's graph items: the keys that sign graph facts and snapshots, and where a production graph ledger lives.
3. Whether work may ever cross a department boundary. Today it cannot, and a department's work stays in its own owner-signed status ledger.
4. The thresholds above, each a proposal.

## 10. Caveats

- Synthetic departments are not real departmental data, and the access mix is a proposal; real departments would differ in size, shape and the share they withhold.
- The cost numbers are of one container. The x4 department publishes (30-36 s each) and the hub's per-tick catch-up mostly measure exports that carry the WHOLE projection each time; a delta export would change R8, not the verdict.
- The behavioural criteria ran at a small size: their logic does not depend on size, but it is measured there, not at scale.
- A replica here is state, keys and config bound to a commit. Its code was not checked out separately: no worktree was created, so the repository's git directory was not touched.
- A code partition is not a data partition or a team partition. The first brief's question about OPHANIM's own code was set aside by the redirect, not answered.

## 11. Commands

`node ophanim/graph/cli.mjs hub-readiness [--scales 1,4] [--commit C]`; `node --test ophanim/graph/hub.test.mjs` (15 tests); `node ophanim/graph/hub.mutate.mjs [--only H1,...] [--check]` (20 mutations).
