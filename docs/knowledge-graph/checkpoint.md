# The knowledge graph's replay checkpoint (register KG-1; its compaction, KG-9)

Status: built on `kg/checkpoint` from `a028497`, before Slice D. Compacted (KG-9) on `kg/compaction` from `b529bf2`: record format `ophanim.graph.snapshot/v2`, the state in a compact encoding (section 4a), the projection digest computed faster and unchanged in value (section 4b). Code: `packages/graph/checkpoint.mjs` (the record, the encoding, its reader and writer); the projection's state serializer, restorer and digest (`projection.mjs`); `openGraph`'s `snapshot` option (`kinds.mjs`); the real graph's opener (`ophanim/graph/extract/index.mjs`). Tests: `packages/graph/tests/checkpoint.test.mjs`, `packages/graph/tests/checkpoint-equality.test.mjs`, `packages/graph/tests/checkpoint-format.test.mjs`, two real-graph tests in `ophanim/graph/extract.test.mjs`. Mutations: `packages/graph/tests/checkpoint.mutate.mjs`.

## 1. In one paragraph

Opening a graph used to cost a full re-derivation of every ledger entry, even when nothing had changed since the last open: the real graph (19,188 facts at `a028497`) took 1.7 to 2.1 s in a fresh process, and Slice D would pay that on every scheduler tick. A **snapshot** is the projection state that replay built, at one ledger position, signed by a key the reader pins. It is a derived cache, never authoritative, and may be deleted at any time; deleting it only makes the next open slower. `openGraph({..., snapshot: {dir, keys}})` uses a snapshot only when every check holds. It then verifies the chain against the ledger's own signed checkpoints (frontier mode), restores the projection, and re-derives the entries after the snapshot by the normal path. On any mismatch it performs the full open, as before, and records why. On the real graph an open from a current snapshot took 353 to 437 ms in a fresh process at `a028497` (19,188 facts), against a 0.5 s target. With Slice B2's sources (25,199 facts at `b529bf2`) it took 451 to 576 ms; after the compaction (KG-9) it takes **195 to 262 ms** from a 9.2 MiB snapshot (31.7 MiB before), against a 0.3 s target, and 0.60 to 0.62 s at three times the facts (1.43 to 1.78 s before; section 8).

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
| `schema` | `ophanim.graph.snapshot/v2` (v1 until KG-9: the state as JSON) |
| `anchor` | the graph ledger's genesis hash |
| `instance` | the projection's instance (fact ids depend on it) |
| `position` | `{seq, hash}`: the last graph entry the projection applied and its entry hash |
| `contract` | `{schema, version, registry}`: `ophanim.graph/v1`, the contract version, and the digest of the entity types, the relationship registry and the admission tables (classifications, bases, origin kinds, statuses, access, source states, kinds, record and retraction fields, the change-list bound) |
| `origins` | the digest of the composed origin registry |
| `adapters` | the registered sources' identity `{id, extractor, authority, ref}` (a fact's id depends on them) |
| `extractors` | each registered source's `extractorVersion`, or null where its adapter declares none (section 5a) |
| `sources` | each source as the projection held it: `{id, version, digest (of its facts), state, replay, seq}` |
| `projection_digest` | the projection digest at `position.seq` |
| `state_encoding` | `ophanim.graph.compact-state/v1`: the state's encoding (section 4a) |
| `state_digest`, `state_bytes` | sha256 and length of the serialized state's bytes, as encoded |
| `signature` | `{key_id, public, sig}`, over the canonical JSON of everything above |

The header line is padded with JSON whitespace so that the state starts at a multiple of 8 bytes in the file (the reader then views the encoding's typed sections in place; it copies a section that is not aligned).

The state (`ophanim.graph.projection-state/v2`, `projection.serialize()`) holds the cursor and head, the entry log, every assertion with its interval (in admission order), **the assertions' positions in id order** (`order`, new in v2), the retractions, each source's observation log, the facts of each source, and the sources not re-derived. The materialized-fact and fact-key caches are not part of it. `restore()` rebuilds the indexes by subject and incidence in the same order that replay pushed them (one pass of its own, in `admit()`'s order: by subject, then each distinct endpoint of a relationship, from then to). It refuses a state whose cursor is not its last entry, that lists an assertion twice, or whose id order is not a permutation of its assertions strictly increasing by id.

## 4a. The compact encoding (KG-9)

The state is a JSON value. v1 wrote it as JSON: about 1.3 KB a fact, most of it the same keys and the same long strings (a source's authority, its version, the schema, the scope) on every fact. v2 writes the same value as:

- a **string table**: every distinct string once, the strings whose every code unit fits one byte as latin1, the rest as UTF-16LE (so a lone surrogate, which UTF-8 cannot carry, survives). Each is read as its own string: slices of one large string made the digest's sort and its serialization two to three times slower;
- a **shape table**: each distinct list of an object's keys, in its own order, so the decoded objects enumerate their keys as the originals did, integer-like keys and `__proto__` included (an own property, never the prototype);
- a **word stream**: every value one 32-bit word, `(payload << 3) | tag`: a string's index, a small non-negative integer, an array's length followed by its elements, an object's shape followed by its values, null, true or false;
- a **number table** (float64) for every other number: negative, fractional, large or -0, exactly.

Layout, little-endian: `u32 L | preamble (L bytes of JSON: the encoding's name, the counts, the shapes) | pad to 8 | numbers (f64) | string offsets (u32) | words (i32) | latin1 text | UTF-16LE text`. On the real graph at `b529bf2` the state is 9.2 MiB, against 31.7 MiB as JSON: 61,582 distinct strings (51 of them UTF-16), 137 shapes and 993,893 words for 25,199 facts.

The decoder (`decodeState`) returns the serialized value exactly or throws, saying why. It refuses another encoding named, sections that do not add up to the bytes, a count that is not one, a string, shape or number index out of its table, a word out of range or without a tag, an array longer than the words left, a word stream that ends inside a value or holds words after it, a number that is not finite, string offsets that do not span the texts or go backwards, a shape listing a key twice, and nesting past 128. The encoder (`encodeState`) refuses a value that is not plain JSON: undefined, a hole, a non-finite number, a non-plain object, a function or a BigInt. v1's `JSON.stringify` dropped such members silently and would have restored another state. Both refuse to run on a big-endian platform, where the full open is then taken: that path is not built.

**The decoder sits in the trusted path**, between the state bytes the signature covers and the restored state, as `restore()` does. Its faithfulness is established by tests and by mutations K23 and K24. The tests are an exact round trip of a graph's state and of every edge of JSON, compared value by value, key order by key order, and as JSON text; and the equality tests, which compare every record of every subject at every cursor with the full open's. It is not re-checked at open: the projection digest covers ids and intervals, not attributes.

## 4b. The projection digest, computed faster (KG-9)

The projection digest is unchanged in value: `sha256(canonical({schema, contract, seq, head, assertions: rows sorted by id, retractions, sources}))`. Two parts of its computation changed:

- **The rows are written by `JSON.stringify`, not by `canonical()`'s generic walk.** `canonical()` writes a string or a finite number as `JSON.stringify` writes it, null as `null` and an array as `[a,b]`. So for a dense array of rows whose every cell is a string, a finite number or null, the two write the same bytes. A row with any other cell is written by `canonical()` itself. `assertions` sorts before every other key of the digest, so the canonical object is `{"assertions":`, then the rows, then the rest's canonical members (`projectionDigest`).
- **A restored projection does not sort the rows again.** The state lists the assertions' positions in id order; `restore()` checks it (a permutation, strictly increasing by id) and keeps the ids in that order. The digest uses them only while they are exactly the ids held: as many as the assertions, each held. Once an assertion is admitted after the restore, the digest sorts, as the full open always does.

`checkpoint-format.test.mjs` "digest:" compares the digest at every cursor with an oracle computed by `packages/ledger`'s `digest()` from the serialized state: sorted (the full open) and from the restored order (an open from a snapshot), before and after a write. On the real graph, the new code's full open of a ledger written by the base code gives the base's digest (section 8.1).

## 5. Opening with a snapshot (KP3)

`openGraph({..., snapshot: {dir, keys}})` tries the snapshots in `dir`, newest first, and uses the first for which **all** of the following hold:

1. its record is a snapshot record of this format, and its signature verifies under a key in `keys`. A record of an older format is refused first, before anything else of it is read, with the reason `older snapshot format: ophanim.graph.snapshot/v1, not ophanim.graph.snapshot/v2 (the next writeSnapshot writes this reader's format)`. Its state is never decoded, and the decoder would refuse its bytes anyway: they do not name the encoding;
2. its anchor is the reader's;
3. its contract (version and registry digest), origin-registry digest, instance and registered sources equal the reader's, and so does every source's extractor version (section 5a);
4. the ledger verifies in frontier mode, and its own entry at the snapshot's seq is a graph entry with the recorded hash (a rewritten, forked or shorter ledger refuses it);
5. its state bytes have the signed digest and length; they decode as exactly the compact encoding (section 4a); the state restores, its id order checked; the restored state is at the recorded position, reproduces the recorded projection digest, and holds the recorded sources. A check that throws on a malformed restored state refuses the snapshot (`its restored state cannot be checked: ...`), not the open.

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
| the real graph opened from a snapshot: the same digest, sources and `complete`; the record holds each extractor's version. Since KG-9 the snapshot it writes and opens is in the v2 format, so this is the test of KC-5 on the real graph | `ophanim/graph/extract.test.mjs` "the real graph opened from a signed snapshot" |
| every source of the systems graph declares its extractor version; each declared module defines its adapter factory; the closure follows transitive and dynamic imports and ignores files not imported | `ophanim/graph/extract.test.mjs` "every source of the systems graph declares" |

KP3, KP5 and KP7 are covered in `checkpoint.test.mjs`:

- **trust**: unpinned key; signature; another ledger, a fork, a shorter ledger; contract, origin registry, instance, sources; state bytes and projection digest;
- **extractor**: a snapshot derived by another extractor version (or one declared on one side only) is refused, and the open equals the full open, which marks the source `diverged` and is partial;
- **fallback**: none, partial, the newest refused and the next used; a snapshot directory that cannot be listed;
- **tail**: the chain verified; validation under the reader's registry; notes against each entry;
- **write**: atomic, under a real writer process paused mid-write and then killed; two real writer processes; retention and the ledger untouched;
- **no snapshot**: the full open unchanged on a checkpointed ledger;
- **refresh**: provenance kept.

The compact format (KG-9) is covered in `checkpoint-format.test.mjs`:

- **format: the compact encoding returns the state exactly**: a graph's state (observations of a changing source, records with latin1, wide and lone-surrogate strings, -0, a fraction and a large integer, a supersede, a hypothesis, a retraction) and every edge of JSON, value by value, key order by key order and as JSON text; each distinct string stored once; bytes that are not aligned;
- **format: the decoder refuses**: seventeen malformed encodings, the older format's JSON state among them; the encoder refuses nine values that are not plain JSON;
- **format: writeSnapshot writes this format**: the record's schema and encoding, the state at a multiple of 8, the state's bytes its digest and its encoding;
- **format: a snapshot in the older format** (KC-4): a v1 record and JSON state, signed by the pinned key, is refused as `older snapshot format`, and the open equals the full open; its state's bytes are refused by the decoder too; a v1 snapshot newer than a v2 one is refused and the v2 one used, its tail re-derived; the next write is v2;
- **format: the restored id order is checked**: a misordered id order and one that lists a position twice, each re-signed by the pinned key, are refused with their reasons;
- **digest:** the digest at every cursor, sorted and from the restored order, before and after a write, equals the oracle's; a row cell that is not a string, a finite number or null is written by `canonical()`.

## 8. Measurements

### 8.1 The compaction (KG-9), at `b529bf2`

Setup: the real graph at `b529bf2` on this container (Node v24.22.1, 4 cores), built in a temporary directory with synthetic keys: twelve observations, 25,199 facts (repository 16,135; verification 3,239; imports 2,175; literals 1,024; authority 724; records 555; environment 521; packages 268; status 225; paths 142; pins 118; lessons 73); a ledger of 13 entries; a snapshot at its head. Each open ran in a fresh process; module loading (76 to 116 ms) and composing the sources (25 to 34 ms) are outside the times. The 2x and 3x graphs are synthetic: the real graph plus one or two **mirror families**, each a copy of every real source with every entity id moved into its own key namespace (`ophanim/<domain>/<type>/mirrorK/<key>`) under its own registered extractor, so the facts keep the real shape and size and every reference stays inside its family. The scripts were throwaway, not committed.

**The split before** (the base code, instrumented in a copy, three fresh-process opens of 505 to 561 ms):

| Part | Time |
|---|---|
| the chain: the ledger's frontier verification and read (unchanged; packages/ledger, with each payload validated under the reader's registry: 13 entries, no ledger checkpoint before entry 64) | 67 to 85 ms (validation about 40 of it) |
| reading the file (31.7 MiB) | 20 to 26 ms |
| sha256 of the state | 26 to 29 ms |
| UTF-8 decode and `JSON.parse` of the state | 165 to 209 ms (decode 42 to 48, parse 118 to 167) |
| `restore()` | 84 to 111 ms |
| the projection-digest check | 103 to 121 ms: the rows 12 to 16, their sort 21 to 26, **`canonical()` 63 to 77**, sha256 5 |
| the record: parse, signature, bindings; the reader's expected bindings | 6 to 7 ms |

**The choice.** The time was in the state's bytes (about 1.3 KB a fact, parsed as JSON) and in the digest's generic canonicalization, not in any check. So the choice is (a) and (d), and not (b) or (c):

- (a) a **compact encoding** (section 4a): 9.2 MiB instead of 31.7 MiB; decoding it takes 78 to 94 ms against 165 to 209 for JSON. The read and the sha256 shrink with the bytes.
- (d) the **same digest, computed faster** (section 4b): the rows written by `JSON.stringify` (byte for byte `canonical()`'s, proved by the oracle test), and the sort replaced by a checked id order carried in the state. The digest check takes 19 to 21 ms against 103 to 121. `restore()` got one pass of its own (37 to 39 ms with the order's check, against 84 to 111).
- Not (b) as described, incremental per-source digests composed: a composed digest is another value unless the full open composes it too. The projection digest's value is fixed for this work (the manifest's region limit), and the measured cost was `canonical()`'s walk and the sort, which (d) removes without changing the value.
- Not (c), per-family segments: at B2's scale every family is registered, so a segment split loads every segment and saves this reader nothing. Its design needs decisions this work does not hold (section 11.1).

**After** (the new code; the parts from two instrumented fresh-process opens of 214 and 235 ms):

| Part | Time |
|---|---|
| the chain (unchanged) | 55 to 66 ms |
| reading the file (9.2 MiB) | 6 ms |
| sha256 of the state | 8 to 9 ms |
| decoding: the preamble and sections; the string table and the shapes' templates; the values | 1; 9 to 12; 68 to 82 ms |
| `restore()`: the indexes; the id order's check; the rest | 28 to 29; 7 to 8; 2 ms |
| the projection-digest check: the rows in id order; their text; the hash and the sources-held check | 5; 10 to 12; 3 ms |
| the record and the expected bindings | 4 to 5 ms |

| Open, fresh process | Before (v1) | After (v2) |
|---|---|---|
| **from a current snapshot, the real graph (25,199 facts)** | 451, 489, 508, 557, 576 ms (31.7 MiB) | **195, 197, 198, 218, 219, 229, 241, 262 ms** (9.2 MiB) |
| from a current snapshot, 2x synthetic (50,398 facts) | 0.88, 1.05, 1.11, 1.16, 1.25 s (64.9 MiB) | 394, 400, 458, 482, 596 ms (18.2 MiB) |
| from a current snapshot, 3x synthetic (75,597 facts) | 1.43, 1.53, 1.55, 1.59, 1.78 s (98.1 MiB) | 599, 600, 601, 615, 623 ms (27.1 MiB) |
| full open: real, 2x, 3x | 2.78 s; not measured; 5.98 s | 2.50 to 2.92 s; 4.50 s; 6.20 to 6.29 s |
| writing the snapshot: real, 2x, 3x | 483 ms; 1.06 s; 1.62 s (one write each) | 293, 310 ms; 744 ms; 939 ms (865 ms before the id order, which costs the writer one sort, was added) |

**The target (a current-snapshot open at B2's scale of 0.3 s or less) is met: 195 to 262 ms** in eight fresh processes. At every scale the open from the snapshot gave the full open's digest. The new code's full open of the base-written real ledger gave the base code's digest (`sha256:d99d6268...`, 25,199 facts), and so did the 3x ledger (`sha256:e34210ff...`): the digest's value is unchanged. The new reader refused both base-written v1 snapshots as `older snapshot format` and took the full open.

**The growth curve.** The open from a snapshot still grows linearly with the facts: about 7.6 µs a fact on this container (0.21 s at 25,199 facts, 0.61 s at 75,597), against about 21 µs a fact before. At 3x, where the time goes (two instrumented opens of 603 and 645 ms):

- decoding the values: 197 to 202 ms;
- the chain: 137 to 177 ms (37 entries, each payload validated);
- the indexes: 86 to 97 ms;
- the string table: 36 to 41 ms;
- the digest's rows, their text and the hash: 55 to 66 ms;
- the id order's check: 25 ms;
- the sha256: 22 ms; the read: 16 ms.

Extrapolated, the open reaches 1 s near 125,000 facts, about five times B2's. The remaining parts grow with the facts (the chain with the entries since the last ledger checkpoint), and none is a check that could be skipped (section 11.1). The before column is this container's; register KG-9 records the coordinator's 531 to 769 ms for the same open.

### 8.2 The checkpoint (KG-1, KP6), at `a028497`

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

A snapshot 1 entry behind costs what that entry re-derives. A tool's entry costs almost nothing. A real source's observation costs its read and re-derivation (status: 225 facts, read from its own ledger), which took one of the three L2 runs over 0.5 s (540 ms). These are the v1 format's numbers; section 8.1 supersedes them.

## 9. Mutations

`node packages/graph/tests/checkpoint.mutate.mjs` runs 30 mutations, each against only its deciding tests, on a disposable copy of the tree. It is kept apart from `graph.mutate.mjs` and `federation.mutate.mjs`, and its source shape reads as text for `extract.test.mjs`. K15's target moved with `restore()`'s loop (KG-9) and was retargeted to the same regression: the restorer's admission order reversed. Every other target and every deciding test of K1 to K22 is unchanged. The forging helpers of `checkpoint.test.mjs` (`forge`, and the state edited after signing) now read and write the state through the compact encoding, and a forger keeps the id order as it keeps the digests.

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
| K23 | the string table misread by the writer: a string's first use refers to the next string (an id restored to the wrong string) | format: the compact encoding returns; equality: head |
| K24 | the string table misread by the reader: the first UTF-16 string read as latin1 | format: the compact encoding returns |
| K25 | an older-format snapshot read as this format: the record's version not checked | format: a snapshot in the older format |
| K26 | the decoder does not check that the state names its encoding | format: the decoder refuses |
| K27 | the digest's rows from the restored id order composed without one assertion | equality: head; digest |
| K28 | the restored id order not checked to increase | format: the restored id order is checked |
| K29 | a digest row cell that is not plain written by `JSON.stringify`, not `canonical()` | digest |
| K30 | the restored id order used after an assertion was admitted | equality: behind; digest |

Two of the mutations the brief names have no target, because the design they test was not built: "a segment accepted under another family's bindings" (no segments, section 8.1) and "the incremental digest composed without one source" (no per-source digests). K27 is the second's counterpart in this design: the digest composed without one of its rows.

The anchor check has no mutation of its own. Every entry hash commits to its parent and so to the genesis, so the entry-hash check at the snapshot's seq refuses any snapshot of another ledger, and removing the anchor check alone would not be detected.

## 10. What the owner decides

- **The key that signs snapshots**, and who holds it (with KG-4). Tests and the real-graph opener use synthetic keys only. A reader pins the keys it accepts. Rotating a key means pinning the new key next to the old one until the old snapshots age out.
- **The audit cadence**: how often `verifySnapshot` performs the full open and compares. The audit is the only check against what no digest covers: an extractor change in a source whose adapter declares no `extractorVersion` (section 5a), and a source that became unreadable after the snapshot (below).
- **Retention**: the default keeps 2 snapshots (about 9 MiB each on the real graph at `b529bf2` in the v2 format; 32 MiB in v1).
- **When Slice D writes**: a write costs 0.29 to 0.31 s on the real graph at `b529bf2` (0.3 to 0.5 s in v1), so writing on every tick would cost what it saves.

## 11. Caveats and future work

- **A snapshot holds facts as they were re-derived when it was written.** A source that has become unreadable since keeps those facts, with the `applied` status the snapshot recorded. A full open would mark it `unavailable`. `freshness()` still reads the source now and reports it, and the audit shows the difference. The reverse never happens: a status the snapshot recorded as not re-derived is never loaded as `applied` (`never better`).
- **An extractor whose code changed with no change of source version** refuses the snapshot when its adapter declares `extractorVersion` (every source of the systems graph does). An adapter that declares none keeps the snapshot's facts, where a full open would mark that observation `diverged`; for it, the audit is the check. The version covers the code this repository holds, not the node built-ins or third-party packages an extractor imports by name.
- `partial` is equal to the full open's when the snapshot holds no gap. When it holds one, the snapshot path notes each gap once, at its observation; the full open notes each entry it could not re-derive.
- `rederived` counts the work this open did, as frontier mode does. The equality tests compare it against the number of entries after the snapshot, not against the full open's count.
- **Still a constant factor, not a different curve (KG-9).** The compact format cut the per-fact cost from about 21 to about 7.6 µs, but the open from a snapshot still decodes and indexes the whole state, so it grows with the graph (section 8.1). What remains is in section 11.1.
- **The encoding refuses, rather than drops, a state that is not plain JSON** (section 4a): a write of such a state throws, no snapshot is written, and the next opens are full. No state of the real graph or of the tests holds one.
- **Big-endian platforms**: the encoding is neither written nor read there; a reader there takes the full open. Untested: this container is little-endian.
- **v1 snapshots** written before KG-9 are refused as `older snapshot format` and the full open is taken. The first `writeSnapshot` writes v2, and retention removes the v1 files, which keep the same name pattern.
- **Future ticket:** a writer killed mid-write leaves its `.tmp-*` file. Readers ignore it, but nothing removes it yet.
- `kinds.mjs` imports `openSnapshot` and `checkpoint.mjs` imports `openGraph`. This is a module cycle of function declarations only, used at call time.
- KG-8 still applies: a ledger re-created with the same authority has the same anchor. Its snapshots are refused by the entry-hash check, not by the anchor.

### 11.1 What remains for KG-9

- **The open still grows linearly**, about 7.6 µs a fact here, and reaches 1 s near 125,000 facts: for example, two opt-in families of 50,000 facts each, registered with today's sources. At 3x, decoding the values (about a third of the open), building the indexes and the string table are the cost of materializing every record and index eagerly. The next step that changes the curve, rather than the constant, is to avoid that work for what a tick does not read. Two routes are candidates, neither built nor measured:
  - **lazy records**: decode the ids, subjects, kinds, endpoints and intervals the indexes and the digest need, and each record's body on first read. That moves the cost to the first whole-graph query, and it moves a decoding refusal from the open to a query unless the whole word stream is validated at open;
  - **per-family segments** with per-source digests: options (c) and (b). These need two decisions that are not this work's. Today a snapshot is refused by a reader whose registered sources differ (the bindings), so a reader without an opt-in family takes the full open, and Slice D needs one snapshot directory per composition. And the per-composition state is not the writer's state minus the family's facts: the full open of that composition marks the family's observations unavailable, notes the references into it, and records other replay statuses. So a segment's acceptance needs its own digest and composition rule, which is a change of the projection digest's definition or a second, composed digest beside it. **These are the coordinator's and owner's to decide.**
- **The chain's frontier verification** (`packages/ledger` and the payload validation in `schema.mjs`, both outside this work) costs 55 to 66 ms at B2's scale and 137 to 177 ms at 3x. It validates every entry after the last ledger checkpoint (every 64 entries), and an observation that lists its changed subjects validates each of them. It is bounded by the checkpoint interval, not by the facts, but it is now a quarter of the open.
- **The decoder is trusted after the signature** (section 4a), as `restore()` was. Its faithfulness is tested and mutation-tested, not re-checked at open.
- Unchanged from KG-1: a writer killed mid-write leaves its `.tmp-*` file; an adapter that declares no `extractorVersion` relies on the audit; an edit in an extractor's import closure invalidates the systems graph's snapshots.
