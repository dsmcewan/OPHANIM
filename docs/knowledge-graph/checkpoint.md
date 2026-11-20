# The knowledge graph's replay checkpoint (register KG-1)

Status: built on `kg/checkpoint` from `a028497`, before Slice D. Code: `packages/graph/checkpoint.mjs`; the projection's state serializer and restorer (`projection.mjs`); `openGraph`'s `snapshot` option (`kinds.mjs`); the real graph's opener (`ophanim/graph/extract/index.mjs`). Tests: `packages/graph/tests/checkpoint.test.mjs`, `packages/graph/tests/checkpoint-equality.test.mjs`, two real-graph tests in `ophanim/graph/extract.test.mjs`. Mutations: `packages/graph/tests/checkpoint.mutate.mjs`.

## 1. In one paragraph

Opening a graph used to cost a full re-derivation of every ledger entry, even when nothing had changed since the last open: the real graph (19,188 facts at `a028497`) took 1.7 to 2.1 s in a fresh process, and Slice D would pay that on every scheduler tick. A **snapshot** is the projection state that replay built, at one ledger position, signed by a key the reader pins. It is a derived cache, never authoritative, and may be deleted at any time; deleting it only makes the next open slower. `openGraph({..., snapshot: {dir, keys}})` uses a snapshot only when every check holds. It then verifies the chain against the ledger's own signed checkpoints (frontier mode), restores the projection, and re-derives the entries after the snapshot by the normal path. On any mismatch it performs the full open, as before, and records why. On the real graph an open from a current snapshot takes 353 to 437 ms in a fresh process, against a 0.5 s target.

## 2. The measured split, and why Slice A opened in 'full' mode (KP1)

The real graph at `a028497` was built in a temporary directory with synthetic keys: a genesis and five observations (repository 15,353 facts; verification 3,013; records 525; status 225; lessons 72; 19,188 in all). It was then opened in a fresh process three times through `openGraph`, and three more times with the same steps instrumented (wrapped source reads and kind functions; a throwaway script, not committed).

| Part of the open | Time |
|---|---|
| `openGraph`, fresh process (wall) | 1.68, 1.83, 2.07 s |
| (a) `ledger.verify({mode: 'full'})` | 1.71 to 2.20 s |
|   the ledger's own checks: re-hashing, two signatures per entry, payload objects | 12 to 14 ms |
|   `validate` (each payload's static checks under the reader's registry) | 15 to 19 ms |
|   the re-derivation hook (`projection.sync`): checking and applying every entry | 1.68 to 2.16 s |
|     (c) source reads inside it (`readAt`): repository 451 to 472 ms, verification 243 to 317, records 52 to 74, status 89 to 134, lessons 1 to 2 | 0.84 to 1.00 s |
|     fact re-derivation (`assertion()` and `recordRefusal` per fact, re-run warm on the captured drafts) | 0.66 to 0.93 s (34 to 48 µs a fact) |
|     the rest: diff against the state, admission, indexing | about 0.18 to 0.26 s |
| (b) `projection.catchUp` after the verify | 0.2 to 0.3 ms |
| The projection digest (not part of the open) | 62 to 98 ms |

(a) and (b) are not separate costs in Slice A. The ledger's re-derivation hook *is* the projection's `sync`, so the full verification builds the projection, and `catchUp` finds nothing left to apply. Opening in 'frontier' mode measured the same (verify 1.73 s): this ledger holds six entries, and the ledger writes its first checkpoint at entry 64, so frontier mode verifies every entry exactly as full mode does.

**Why Slice A opens in 'full' mode.** No commit or document records a reason. From the code, and the experiment below:

1. The projection lives only in memory and starts empty at every open, so every entry must be replayed whatever the mode. In frontier mode, the entries before the last ledger checkpoint skip only the ledger's own checks. The projection still re-derives them: `sync` walks back to the genesis from the first frontier entry, or `catchUp` replays them. Frontier mode would therefore save the signatures and `validate` (here about 30 ms of 1.7 s), never the re-derivation.
2. In full mode, the projection's notes on every entry reach the ledger's `partial`, and so `complete`. In frontier mode, an entry replayed by `catchUp` reports only in `verification.notes`, and `complete` stays true.
3. Full mode runs `validate` on every entry: `payloadRefusal` under the reader's contract and origin registry. Frontier mode skips it before the last checkpoint, and nothing else repeats it. The projection's `check` re-checks each record's key against its origin, but not the record's static validity.

**The experiment.** The graph suite was run three times with the open's mode and the checkpoint interval made configurable, then reverted (not committed). In full mode with a checkpoint every 2 entries, 4 tests failed; they count ledger entries or lines, so the extra checkpoint entries break them. In frontier mode with checkpoints every 2 entries, the same 4 failed plus 2 more: `replay.test.mjs:105` and `federation.test.mjs:402`. Both assert `verification.complete === false` for a source that cannot be read, and in frontier mode it read `true`; that is point 2. In frontier mode at the committed interval (64), all 37 passed.

**The finding.** No property that Slice A's tests hold depends on 'full' in the ledgers they build: those ledgers have fewer than 64 entries, so frontier mode verifies every entry. Two properties do depend on 'full' once a ledger checkpoint follows the entries in question:

- The `complete`/`partial` report (point 2). Here the re-derivation still runs; only its report is lost.
- The static validation under the reader's registry (point 3). This one is skipped and not re-checked, and no existing test exercises it.

The snapshot path keeps both. It applies the entries after the snapshot itself, with `validate` and the notes against each entry (section 5). With no snapshot, the full open is unchanged, and a new test pins both properties on a ledger whose last entry is a checkpoint.

## 3. The trust model

There are two parts, and no third:

- **The chain** rests on the ledger's own signed checkpoints, unchanged (`packages/ledger`; KP7 leaves the ledger alone). Every 64 entries the orderer writes a `checkpoint` entry committing to every earlier entry hash. `verify({mode: 'frontier'})` re-hashes the whole prefix, re-checks signatures and payloads only after the last checkpoint, and always fully verifies authority entries (RU2).
- **The derived state** rests on the snapshot's Ed25519 signature: the ledger's signature scheme and signer interface (`generateSigner`), over the canonical JSON of the record. The signature must verify under a key in the **reader's pinned set** (`keys: {key_id: public key}`). A snapshot carries its signer's public key for audit, but the reader never trusts it.
- **Fallback.** On any failed check, the full open is performed, as without a snapshot, and the reason is recorded. Nothing is partially trusted. A snapshot that fails after its state was restored is reset before the next candidate or the full open.

## 4. The record

One file per snapshot, `graph-snapshot-<seq, 12 digits>-<16 hex of the state digest>.json`. Line one is the signed record. The rest of the file is the serialized state, as bytes.

| Field | What |
|---|---|
| `schema` | `ophanim.graph.snapshot/v1` |
| `anchor` | the graph ledger's genesis hash |
| `instance` | the projection's instance (fact ids depend on it) |
| `position` | `{seq, hash}`: the last graph entry the projection applied and its entry hash |
| `contract` | `{schema, version, registry}`: `ophanim.graph/v1`, the contract version, and the digest of the entity types, the relationship registry and the admission tables (classifications, bases, origin kinds, statuses, access, source states, kinds, record and retraction fields, the change-list bound) |
| `origins` | the digest of the composed origin registry |
| `adapters` | the registered sources' identity `{id, extractor, authority, ref}` (a fact's id depends on them) |
| `extractors` | each registered source's `extractorVersion`, or null where its adapter declares none (section 5a) |
| `sources` | each source as the projection held it: `{id, version, digest (of its facts), state, replay, seq}` |
| `projection_digest` | the projection digest at `position.seq` |
| `state_digest`, `state_bytes` | sha256 and length of the serialized state |
| `signature` | `{key_id, public, sig}`, over the canonical JSON of everything above |

The state (`ophanim.graph.projection-state/v1`, `projection.serialize()`) holds the cursor and head, the entry log, every assertion with its interval (in admission order), the retractions, each source's observation log, the facts of each source, and the sources not re-derived. The materialized-fact and fact-key caches are not part of it. `restore()` rebuilds the indexes by subject and incidence in the same order that replay pushed them. It refuses a state whose cursor is not its last entry, or that lists an assertion twice.

## 5. Opening with a snapshot (KP3)

`openGraph({..., snapshot: {dir, keys}})` tries the snapshots in `dir`, newest first, and uses the first for which **all** of the following hold:

1. its record is a snapshot record, and its signature verifies under a key in `keys`;
2. its anchor is the reader's;
3. its contract (version and registry digest), origin-registry digest, instance and registered sources equal the reader's, and so does every source's extractor version (section 5a);
4. the ledger verifies in frontier mode, and its own entry at the snapshot's seq is a graph entry with the recorded hash (a rewritten, forked or shorter ledger refuses it);
5. its state bytes have the signed digest and length; the state restores; the restored state is at the recorded position, reproduces the recorded projection digest, and holds the recorded sources.

Then each graph entry after the snapshot is re-derived as full mode re-derives an entry: payload object intact, author permitted, `validate` under the reader's registry, then the kind's re-derivation (`projection.sync`). What an entry cannot re-derive is noted against that entry's seq, exactly as the ledger notes it. If an entry refuses, the snapshot is refused. The full open then refuses the same ledger with the error it gives today.

A snapshot directory that exists but cannot be listed is a reason like any other: the full open is taken, with the reason (`the snapshot directory could not be listed (<code>)`); the open never throws for it. A malformed `snapshot` option (not `{dir: an absolute path, keys: {...}}`) or an `extractorVersion` that is not a non-empty string is the caller's error and throws.

`verification` keeps its fields and adds `snapshot`:

- `used: true`: `{used, seq, hash, file, key_id, state_digest, projection_digest, sources, tail, refused: false, reason: null, refusals}`. `sources` is the snapshot's provenance for what it restored, and `tail` is the count of entries re-derived after it. `refusals` lists any newer snapshot refused, with why.
- Otherwise: `{used: false, seq, refused, reason, refusals}`, followed by the full open.

Other fields:

- `rederived` counts the entries this open re-derived, as frontier mode counts them. A full open counts every graph entry. This is the one existing field that differs from the full open's, by decision: reporting every entry would claim re-derivation this open did not do.
- `partial` adds one note per source that the snapshot holds without having re-derived it (a replay of `unavailable`, `invalid` or `diverged`), at the seq of that observation. `complete` is then false.
- A `refresh()` keeps the provenance while the restored state stands, and says so once a replay from the genesis has replaced it.

## 5a. The extractor's version

The facts a source yields at one version are a function of its extractor's code as well as of the source. When an extractor's code changes and the source's version does not, a full open re-derives other facts, finds that they do not match the recorded digest, notes "the source now yields digest X, not the recorded Y; its facts are not applied", and marks the observation `diverged`: the open is partial. A snapshot derived by the old code would load the old facts as `applied` and report the open complete, a status upgraded in the dangerous direction.

So a source adapter may declare `extractorVersion`, an opaque string. `packages/graph` stays domain-free: it records each registered source's string (or null) in the snapshot and compares it with the reader's adapter, and refuses the snapshot when any differs (`the extractor of source "<id>" is <here> here, not <then> as when it was derived`). The full open then reports what it reports today.

The systems graph (`ophanim/graph/extract/index.mjs`) declares one for every source, the lessons source included: `extractorVersionOf(module)`, the digest of the text of the extractor's own module and of every module it imports by a relative specifier, transitively (static and dynamic imports, found by Slice B's `SPEC` regex), as read from disk, with paths relative to the repository root. Modules imported by name (node built-ins, packages) are not this repository's code and are not followed; a specifier that resolves to no file is part of the digest as unresolved. `EXTRACTOR_MODULES` names, for each source, the module its adapter factory is defined in; the closure is computed, never listed. On this checkout the closures hold 12 (lessons) to 88 (the ledger sources, which reach `ophanim/operate` and `pantheon/src/ledger`) modules. The version is computed once per process, when it first composes its sources: the code the process loaded.

**An adapter that declares no `extractorVersion` relies on the `verifySnapshot` audit for this**: a change of its extractor's code with no change of source version is not detected at open. Slice A's lessons adapter used alone, the federation's import sources and the test fixtures declare none.

## 6. Writing (KP5)

`writeSnapshot(graph, {dir, signer, retain = 2})`:

- It refuses a projection whose position is not an entry of its ledger (for example, a write applied without its ledger entry), and a graph that has applied nothing.
- It serializes the state and signs the record.
- It writes a temporary file (`.tmp-<pid>-<random>-<name>`) in `dir` in 1 MiB chunks, fsyncs it, renames it to its name, and fsyncs the directory. A reader lists only finished names.
- The record has no timestamp, so two writers of the same state write identical bytes under one name: one file remains.
- Retention keeps the newest `retain` by seq.
- It never writes the ledger.
- **When** to write is the consumer's choice (Slice D). This slice provides the call, not a schedule.

`verifySnapshot(options)` is the audit. It performs the full open and the open from the snapshot. It compares the full open's digest at the snapshot's seq with the recorded digest and with the snapshot open's digest, the head digests, and the verification fields. It returns `{ok, used, seq, recorded, full, snapshot, at, differences}` and writes nothing.

## 7. What is preserved, and how it is tested (KP4)

`readout()` in `checkpoint-equality.test.mjs` compares the full open with the open from the snapshot on the following:

- at **every cursor**: the projection digest, the head, the counts, the sources, and, for every subject, its node, all four query modes, its incident edges in all three modes, and its full records;
- at the head, **traversal** from every node: reverse and forward impact closure, the possible-mode closure, the neighbourhood and the contradiction set;
- the **change events** and each event's affected neighbourhood;
- **freshness**;
- the **next observation** of each source (the cursor rule's state);
- the **verification fields** (`ok, entries, head, partial, complete, notes`).

KP4's equality covers every verification field **except `rederived`**, which counts the work this open did (the entries after the snapshot), not the full open's (every graph entry): reporting the full count would claim re-derivation this open did not do. Each equality test asserts instead that the snapshot was used, and that `rederived` equals the number of entries after it.

| Case | Test |
|---|---|
| a snapshot at the head (checkpoints every 2 entries) | `equality: a snapshot at the head` |
| behind the head, the entries after it holding assertions, a supersede and a retract, with ledger checkpoints between them | `equality: a snapshot behind the head` |
| a source whose version changed after the snapshot: moved, then observed again; a slow reading refused by the cursor rule on both opens | `equality: a source whose version changed` |
| a federation import source (Slice E): the central from a snapshot, then an export imported after it; `dependencies` and `freshness` too | `equality: a federation import source` |
| a source the snapshot recorded `unavailable` is never loaded as `applied`, even when readable again; its facts absent, `complete` false; the audit reports the difference | `never better:` |
| the audit passes a sound snapshot, and reports one this reader would not use | `audit:` |
| the real graph opened from a snapshot: the same digest, sources and `complete`; the record holds each extractor's version | `ophanim/graph/extract.test.mjs` "the real graph opened from a signed snapshot" |
| every source of the systems graph declares its extractor version; each declared module defines its adapter factory; the closure follows transitive and dynamic imports and ignores files not imported | `ophanim/graph/extract.test.mjs` "every source of the systems graph declares" |

KP3, KP5 and KP7 are covered in `checkpoint.test.mjs`:

- **trust**: unpinned key; signature; another ledger, a fork, a shorter ledger; contract, origin registry, instance, sources; state bytes and projection digest;
- **extractor**: a snapshot derived by another extractor version (or one declared on one side only) is refused, and the open equals the full open, which marks the source `diverged` and is partial;
- **fallback**: none, partial, the newest refused and the next used; a snapshot directory that cannot be listed;
- **tail**: the chain verified; validation under the reader's registry; notes against each entry;
- **write**: atomic, under a real writer process paused mid-write and then killed; two real writer processes; retention and the ledger untouched;
- **no snapshot**: the full open unchanged on a checkpointed ledger;
- **refresh**: provenance kept.

## 8. Measurements (KP6)

Setup:

- The real graph at `a028497` on this container (Node v24.22.1), built in a temporary directory with synthetic keys.
- Ledger L: the five observations, then 64 entries of a synthetic tool origin (one observation record each), so a ledger checkpoint falls among them; 71 entries.
- Ledger L2: four observations, a snapshot, then the status observation, so the entry after the snapshot re-derives a real source.
- Each open ran in a fresh process; module loading (72 to 100 ms a process) is outside the times below.

| Open | Time |
|---|---|
| **from a current snapshot** (L, at the head) | **353, 379, 388, 437 ms** |
| from a snapshot 1 entry behind (L: one tool entry after it) | 376, 376, 430 ms |
| from a snapshot 64 entries behind (L: 64 tool entries and a ledger checkpoint after it) | 355, 356, 368 ms |
| from a snapshot 1 entry behind (L2: the status observation re-derived from the status ledger) | 451, 495, 540 ms |
| full open of L | 1.81, 1.86, 1.99 s |
| full open of L2 | 1.63, 1.66, 1.68 s |
| writing a snapshot (23.9 MiB) | 323 to 507 ms |

**The target (a current-snapshot open under 0.5 s) is met: 353 to 437 ms.** After the extractor versions were added (section 5a), one fresh-process open from a current snapshot of a rebuilt L (24.2 MiB; its record holds the five extractor versions) took **408 ms**; composing the sources, which now digests each extractor's module closure, took 26 ms of the process's setup, outside the open. Where it goes, re-timed one part at a time in the same process:

- JSON parse of the state: 204 ms
- the projection-digest check: 106 ms
- restoring the indexes: 59 ms
- the sha256 of the state: 19 ms
- reading the file: 14 ms

A snapshot 1 entry behind costs what that entry re-derives. A tool's entry costs almost nothing. A real source's observation costs its read and re-derivation (status: 225 facts, read from its own ledger), which took one of the three L2 runs over 0.5 s (540 ms).

## 9. Mutations

`node packages/graph/tests/checkpoint.mutate.mjs` runs 22 mutations, each against only its deciding tests, on a disposable copy of the tree. It is kept apart from `graph.mutate.mjs` and `federation.mutate.mjs`, and its source shape reads as text for `extract.test.mjs`.

| ID | Regression | Deciding tests |
|---|---|---|
| K1 | the signature not checked | trust: signature |
| K2 | any key accepted (the snapshot's own) | trust: unpinned key |
| K3 | the ledger's entry hash at the seq not checked (a fork accepted) | trust: another ledger, a fork |
| K4 | the contract registry digest ignored | trust: contract |
| K5 | the origin registry digest ignored | trust: contract |
| K6 | the instance and registered sources ignored | trust: contract |
| K21 | a source's extractor version ignored (other code's facts loaded as applied) | extractor |
| K22 | an unlistable snapshot directory throws instead of falling back | fallback: cannot be listed |
| K7 | the state not checked against its signed digest | trust: state; fallback |
| K8 | the projection digest not checked | trust: state |
| K9 | the chain not verified on the snapshot path | tail: chain |
| K10 | the entries after the snapshot not applied | equality: behind; equality: source changed; fallback |
| K11 | an entry after it not validated under the reader's registry | tail: validated |
| K12 | what an entry after it could not re-derive not noted | tail: noted |
| K13 | a source's replay status upgraded on restore | never better |
| K14 | a gap the snapshot holds not noted (complete claimed) | never better |
| K15 | the restorer's order not replay's | equality: head; equality: behind |
| K16 | the refusal reason not recorded (a silent fallback) | trust: unpinned key; fallback |
| K17 | a non-atomic write (a partial file visible) | write: atomic |
| K18 | a snapshot written of a projection that is not its ledger's | write: retention |
| K19 | retention not applied | write: retention |
| K20 | the full open changed when no snapshot is given (frontier) | no snapshot |

The anchor check has no mutation of its own. Every entry hash commits to its parent and so to the genesis, so the entry-hash check at the snapshot's seq refuses any snapshot of another ledger, and removing the anchor check alone would not be detected.

## 10. What the owner decides

- **The key that signs snapshots**, and who holds it (with KG-4). Tests and the real-graph opener use synthetic keys only. A reader pins the keys it accepts. Rotating a key means pinning the new key next to the old one until the old snapshots age out.
- **The audit cadence**: how often `verifySnapshot` performs the full open and compares. The audit is the only check against what no digest covers: an extractor change in a source whose adapter declares no `extractorVersion` (section 5a), and a source that became unreadable after the snapshot (below).
- **Retention**: the default keeps 2 snapshots (about 24 MiB each on the real graph today).
- **When Slice D writes**: a write costs 0.3 to 0.5 s on the real graph, so writing on every tick would cost what it saves.

## 11. Caveats and future work

- **A snapshot holds facts as they were re-derived when it was written.** A source that has become unreadable since keeps those facts, with the `applied` status the snapshot recorded. A full open would mark it `unavailable`. `freshness()` still reads the source now and reports it, and the audit shows the difference. The reverse never happens: a status the snapshot recorded as not re-derived is never loaded as `applied` (`never better`).
- **An extractor whose code changed with no change of source version** refuses the snapshot when its adapter declares `extractorVersion` (every source of the systems graph does). An adapter that declares none keeps the snapshot's facts, where a full open would mark that observation `diverged`; for it, the audit is the check. The version covers the code this repository holds, not the node built-ins or third-party packages an extractor imports by name.
- `partial` is equal to the full open's when the snapshot holds no gap. When it holds one, the snapshot path notes each gap once, at its observation; the full open notes each entry it could not re-derive.
- `rederived` counts the work this open did, as frontier mode does. The equality tests compare it against the number of entries after the snapshot, not against the full open's count.
- **A constant factor, not a different curve.** The open from a snapshot parses the whole state (about 1.3 KB a fact, 23.9 MiB for 19,188 facts), so it grows with the graph. At the synthetic 300,000-fact scale (architecture section 13), expect it to be several seconds. The next steps, if needed: a compact encoding of the records, or per-source fact caches keyed by `(source, version, facts digest)` (slice-b section 7).
- **Future ticket:** a writer killed mid-write leaves its `.tmp-*` file. Readers ignore it, but nothing removes it yet.
- `kinds.mjs` imports `openSnapshot` and `checkpoint.mjs` imports `openGraph`. This is a module cycle of function declarations only, used at call time.
- KG-8 still applies: a ledger re-created with the same authority has the same anchor. Its snapshots are refused by the entry-hash check, not by the anchor.
