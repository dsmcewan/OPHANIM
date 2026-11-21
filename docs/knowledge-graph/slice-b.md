# Knowledge graphs, Slice B: the OPHANIM systems and evidence graph

**Directive** `docs/knowledge-graph/directive-2026-11-20.md`: Slice B ("Index real repositories, components, contracts, tests, requirements, evidence, and dependencies. Demonstrate source-backed traversal and impact analysis"), graphs B and C, sections 4, 8 and 12, demonstrations 2, 3 and 7 (and 6 and 12 at this level).
**Contract** `ophanim.graph/v1`, 1.0.0, unchanged (`docs/knowledge-graph/architecture.md`). Slice B uses only registered entity and relationship types; it needed no schema change (KB6).
**Base** `b10cf0a` (branch `kg/slice-b`). Every real-data number below is of the repository at `b10cf0ae46edcf10d70c99aa3f215dd183dfc748` and its status ledger at head `sha256:f8526a6753aaad321653ae2d232c36125b47081fd8177ad0735a8fb59ca0c009` (85 entries, 58 items).
**Decisions** KB1 to KB8 are the coordinator's (the Slice B brief). This document says how each is implemented; it does not reopen them. The coordinator folds it into the architecture document at integration.

## 1. In one paragraph

Registered extractors (origins of kind `extractor`) project OPHANIM's own repository, its declared verification, the open-limitations register and the authoritative ledgers into the `ophanim.graph/v1` contract of Slice A. Each fact is authoritative only by an observation of its source at a version: the repository-backed sources are read **at a commit, from git's object store, never the working tree**; the ledgers are read **through their own readers, read only, against pinned anchors**, at their head entry. Over that graph, `ophanim/graph/impact.mjs` answers what a change reaches (a targeted reverse closure along the change-carrying relationships, with explained paths, plus the qualifications and citing records it names for reassessment), records a reassessment set when a source changes or goes missing, walks a component backward through what the sources state (a missing link is a gap), and answers the directive's section 8 queries. The context module gains a `graph` retrieval op and a dossier view that return **references** to the underlying records (source, version, why included, coverage, continuation and the existing op that retrieves the original), never a summary in their place. A command line (`ophanim/graph/cli.mjs`) asks the same questions.

## 2. The extractors and their sources (KB1)

| Source id | Extractor origin | Basis | Version | Read through | Facts at `b10cf0a` | First observation |
|---|---|---|---|---|---|---|
| `ophanim.repo` | `ophanim.repo.extractor` (`extract/repo.mjs`) | structural | the commit (40 hex) | `git ls-tree`, `git cat-file --batch`, `git log` at the commit (`extract/git.mjs`) | 14,211 | 1.0 to 1.4 s |
| `ophanim.verification` | `ophanim.verification.extractor` (`extract/verification.mjs`) | declared | the commit | `scripts/test-gates/suites.mjs` (`suites`, `workflowRuns`, `workflowSteps`) over a skeleton of the commit; mutation runners **as text** | 2,778 | 0.35 to 0.55 s |
| `ophanim.records` | `ophanim.records.extractor` (`extract/records.mjs`) | textual | the commit | the register's text and every code file's text at the commit | 496 | 0.1 s |
| `ophanim.status` | `ophanim.ledgers.extractor` (`extract/ledgers.mjs`) | declared | the head entry hash | `packages/ledger/status.mjs` `openStatusLedger({create: false})`, pinned `STATUS_ANCHOR` | 225 | 0.25 to 0.4 s |
| `ophanim.work` | `ophanim.ledgers.extractor` | declared | the head entry hash | `ophanim/operate/work-ledger.mjs` `openWorkLedger({create: false})`, pinned anchor | fixture only (0 entries here) | — |
| `ophanim.cycle` | `ophanim.ledgers.extractor` | declared | the head entry hash | `ophanim/public/provenance.mjs` `openLedgerReadOnly`, `listCycles`, pantheon `deriveCycle` / `closeClaim` | fixture only | — |
| `ophanim.lessons` | Slice A's `ophanim.lessons.extractor` (unchanged) | declared | the registry's blob id | `ophanim/graph/lessons.mjs` | 69 | 15 to 25 ms |

The composition (`extract/index.mjs`) registers the origins (`ORIGIN_SPEC`), pins the three repository-backed sources to ONE commit (a mention or a mutation names a file the repository source holds, in the same tree), and observes the sources in reference order (`ORDER`: repository, verification, records, lessons, status, work, cycle). Its graph ledger is created with **synthetic keys generated for the process** and never persisted; production key custody for the graph domain stays the owner's decision (architecture section 16).

**What each source states.**

| Source | Entities | Relationships |
|---|---|---|
| repository | `systems/repository/ophanim` (commit, counts, withheld paths counted); `systems/module/<path>` (code that is not a test); `systems/test/<path>` (`*.test.{mjs,js,cjs}`, with its test-case names); `systems/file/<path>` (everything else); `systems/symbol/<path>#<name>` (exports); `systems/contract/<schema id>` (an exported constant carrying `scope.name/vN`); `systems/change/<commit>` (the ancestry); `work/ticket/<item>` and `work/item/<item>` (`tickets/*.json`, `ophanim.ticket/v1`) | `depends-on` (a relative import resolved in the commit's tree; the specifier regex is `ophanim/ledger/layering.test.mjs`'s `SPEC`, kept equal by a test), `consumes` (a named import of an exported symbol), `produces` (module to its symbols), `implements` (a schema constant to its contract; a ticket's slot path to the ticket), `derived-from` (a file to each commit that changed it; a ticket to its file), ticket `depends-on` the item it names, ticket `consumes` its copy paths |
| verification | `systems/suite/<id>` (each suite `suites.mjs` reads), `systems/workflow/<file>`, `systems/mutation/<runner>#<id>` (with `result: null`: a run result is not in the repository) | suite `depends-on` each test file it runs and `derived-from` its package.json; workflow `depends-on` each suite whose script it runs and `derived-from` its file; mutation `depends-on` each file it edits (role `target`) and each test that decides it (role `decides`), `derived-from` its runner; a deciding test `verifies` the file the mutation edits |
| records | `evidence/record/register/<id>` (each `L-nnn` / `KG-n` entry: section, status cell, text, the owner decisions quoted for it); an id cited by code but defined by no entry: the same type, `unresolved` | `mentions` only: a code or test file to an entry it cites (with its lines), an entry to a file of the tree it names, an entry to another entry |
| status | `work/item/<item>` (title, state, basis, checked, waiting_on, dependencies, latest entry); `evidence/record/status/<entry>`; an item named as a dependency but not on the ledger, `unresolved` | item `depends-on` item; item `derived-from` its latest entry; an entry `derived-from` the item's previous entry |
| work | `work/lease/<claim>`, `work/execution/<stage record>`, `work/item/<item>` | lease and execution `depends-on` the item; execution `derived-from` its claim and the stage it received |
| cycle | `work/review/<cycle>` (scope, base, head, files, reviews by lab, close or why not), `learning/finding/<finding>` (severity, claim, file, resolution) | finding `derived-from` its cycle |

**Read as text, never imported.** A mutation runner starts its run at import, so `extract/verification.mjs` parses its source text (`mutationTable`): the `MUTATIONS` array only, string and list constants (multi-line, with spreads), `T.key` pattern tables, helper calls that build a test path (`t('schema', ...)`), shared edit constants, the runner's default deciding tests (`m.tests ?? SUITES`, or its `SUITE`/`SUITES`, marked `defaulted`), and the one generated family in the tree (`...[...].map((stage, i) => ({id: \`K${i + 1}\`, ...}))`), expanded as text. At `b10cf0a`: 10 runners, **271 of 271 mutations** read, each with its target files and deciding test files; the count equals each runner's own `--check` count (`extract.test.mjs`). A canary runner that writes a file when executed is extracted and the file never appears.

**Never read.** Recorded review findings (`findings-*`, 132 tracked paths at `b10cf0a`) are counted on the repository node and never opened; no fact names one; the mutation runner of this slice does not copy them.

**The status ledger** read here is the repository's `status/ledger` (85 entries, anchor `sha256:816a7952...`), the ledger whose governance is TELOS-backed. Nothing under `$OPHANIM_TELOS_ROOT` is read or written by this slice. `readStatusLedger` always passes `create: false` and names no key directory; an absent ledger is refused before anything is created, a ledger pinned to another genesis is refused, and the ledger's bytes are unchanged after a reading (`extract.test.mjs`).

## 3. Impact and reassessment (KB2)

`impact(view, seeds)` is the reverse closure of the seeds along the **change-carrying** relationships: the registry's impact types less `verifies`, `verified-by`, `detects` and `supports` (`CHANGE_TYPES`). Those four carry a change of a check's subject to its **qualification**: they are reported ONE hop from the changed neighbourhood ("what it established is to be reassessed") and never propagated, so a changed test reaches what it verifies as a qualification to re-check, not as a changed module whose importers change too. `mentions` is never followed (Slice A's closure refuses it); the records that cite or are cited by a changed node are listed separately, "named for reassessment, never declared affected". Each affected node carries its explained path, each step with the source and version that state it. The result is grouped (consumers, tests, suites, workflows, mutations, contracts, work, records), bounded by Slice A's traversal bounds (depth 4, 500 nodes, 2,000 steps by default), and returns its coverage and continuation. A **contract** is reached through what carries it: a change of `ophanim.graph/v1` is a change of `packages/graph/schema.mjs#GRAPH_SCHEMA`, whose consumers it reaches. `impactOfRange` seeds the files a commit range changed (`git diff --name-status` between two commits, never the working tree), on a graph observed at the range's end; removed paths are listed.

`reassess(graph, event)` RECORDS the reassessment set of a source observation on the graph ledger: a `derived` `work/discovery/reassess/<seq>` assertion of the registered rule `ophanim.impact.rule`, its input the observation that caused it (so it becomes stale, not established, once the source is observed again). For a source observed **changed**, the set is Slice A's `affected` (the reverse closure before and after) along the change-carrying types, each member with why. For a source **unavailable or stale**, its facts are as last observed and cannot be re-checked: they and what rests on them are listed `unverifiable`, never current. The record states `completion: 'not claimed'`, its members while they fit 24 KB, their total and the digest of every member's id (the set is re-derivable: `reassessmentSet` is deterministic at the cursor).

**Real results** (graph at `b10cf0a`):

| Change | Affected | Qualifications / citing records | Coverage |
|---|---|---|---|
| `ophanim/efficiency/investigation/chairs.mjs` | 5 consumers, 3 tests, the suite `test:proof`, the workflow `qualification.yml`, the ticket `co1-readability` (it is the ticket's slot) | 0 / 0 | complete: 12 nodes, 21 steps, of 3,703 entities |
| `ophanim/operate/context.mjs` | 146 consumers, 33 tests, 1 suite, 1 workflow, 149 mutations, 7 contracts | 137 / 67 (L-001, L-504, ...) | cut at depth 4 (338 nodes), with its continuation |
| contract `ophanim.graph/v1` | 73 consumers, 6 tests, 12 mutations (depth 2) | 16 / 0 | cut at depth 2 |
| `ophanim/operate/wave3-evidence.test.mjs` | its suite, workflow and the 21 mutations it decides; NOT `context.mjs` | 3 (`context.mjs`, `gates.mjs`, ...: it verifies them) / 1 | complete |

## 4. Historical traceability (KB3)

`trace(view, subject)` walks backward through what the sources state, each link with its relationship, source and version:

- **requirement**: a ticket that names the component as its slot (`implements`), the status item the ticket names (a JOIN on the item id both the ticket and the status ledger state, labelled as such), an `introduced-because-of` relationship;
- **register**: the entries that name it or that it cites, labelled textual ("the text names it; not a statement that it introduced, decided or corrected it"); the ones in an owner-decision section or with decisions are its **decisions**;
- **evidence**: the tests that import it (structural), the tests a mutation runner declares decide it (declared `verifies`), the mutations that edit it, the suites that run those tests and the workflows that run the suites;
- **implementing commits**: the ancestry's commits that changed the path (structural), the first and the later ones;
- **later corrections**: lessons classes whose detector is a test of it (a join on the registry's `<file>#<name substring>`), lessons whose fix names a commit that changed it (a prefix join), the register entries naming it.

A category no source fills is a **gap**, reported with why: never filled by resemblance (mutation B10). Real results:

| Component | Requirement | Decisions / register | Evidence | Commits | Corrections | Gaps |
|---|---|---|---|---|---|---|
| `ophanim/efficiency/investigation/chairs.mjs` | ticket `co1-readability`; status item `co1-readability` (on the ledger) | none / none | 3 tests, suite `test:proof` | 3; introduced by `390a938` | none | decision, mutations |
| `ophanim/operate/context.mjs` | none stated | 1 / L-001, L-201, L-202, L-504 (mentions) | 6 importing tests, 18 declared verifiers, 20 mutations, suites `test:proof` and `test:pantheon` | 8; introduced by `22cbbb8` "Evidence before judgment: a dossier, model-driven retrieval, ..." | lessons `stored-not-delivered`, `bound-declared-not-enforced` (their detectors are its tests) | requirement; two correction commits (the registry names each fix as "this commit (...)", which resolves to no commit) |
| `ophanim/graph/lessons.mjs` | none stated | none | 1 test, 1 verifier, 1 mutation | 1; introduced by `56956b7` (Slice A) | none | requirement, decision |

## 5. The context operation (KB4)

`ophanim/operate/context.mjs` gains `graph` in `OPS` and in `makeRetriever` (a new `graph` option: an opened graph, or a function returning one), and a DERIVED view at the end of `buildDossier` (a new `graph` option).

- **The op** `{"op":"graph","query":"neighbourhood"|"impact"|"trace"|"contradictions"|"node","subject":ID|PATH|"L-504"|"item:ID", ...}` or `{"op":"graph","query":Q,"continuation":TOKEN}`. Its body is a header (what it is: "REFERENCES ... NOT the evidence itself"; the coverage; the `continue` request; every source with its version and state; gaps; conflicts) and one JSON row per node: the node, why it is included (its explained path or relationship), its sources (source, version, ref, assertion, classification) and `retrieve`, the EXISTING op that returns the original record (`show` at the commit for a file, `status` for an item, `record` / `work` for a work record) or why none can. `query: "node"` lists every assertion of a node, disputed ones included, so a seat can challenge the projection.
- **Bounds.** The traversal is clamped to `GRAPH_RETRIEVAL` (defaults depth 2, 60 nodes, 400 steps; ceilings depth 4, 200 nodes, 1,000 steps) whatever the request asks; a continuation claiming more than the ceilings is refused. The bytes are windowed by the retriever's existing `finish` (result_bytes, total_bytes) like every op, with `next`.
- **Version and re-check.** The version is the digest of the body (THE VERSION CONTRACT). A retriever without a graph returns `UNAVAILABLE` and `versionOf` undefined, so a plan citing a graph view is stale until a re-reader with the graph re-reads it (`gates.mjs evidenceCheck`), never presumed unchanged. The body names source versions, so a new commit changes the version of any view over repository facts (like `index:<head>`, L-111).
- **The dossier view** `graph:<item>#neighbourhood`, kind `derived`, versioned by the digest of its bytes, cut to its share (`GRAPH_RETRIEVAL.dossier_bytes`, 4,000 bytes, the cap `add` gives a derived entry) and to what is left of the initial view, with `{"op":"dossier","source":...}` as its continuation, or omitted with that request. **Without a graph the dossier is exactly as before**: no entry and no omission, so its `digest` and `stable` are unchanged for every existing caller.
- **Unchanged**: every other op, its version and its re-check; `RETRIEVAL_HELP` (bound into review prompts by `prompt_sha`) is not changed; the graph op's help is `GRAPH_RETRIEVAL_HELP`, for a caller that supplies a graph. All 67 tests of the existing importers of `context.mjs` pass unchanged.
- **Not wired here**: no stage passes a graph yet (`stages.mjs`, `reconcile.mjs` and `gates.mjs` are Slice D's); until then the op is reachable only by a caller that supplies one.

## 6. The command line (KB5)

`node ophanim/graph/cli.mjs QUERY SUBJECT [--commit C] [--since C] [--depth N] [--max-nodes N] [--max-edges N] [--no-status] [--no-lessons]`, with QUERY one of `why`, `requirement`, `governs`, `dependents`, `evidence`, `changed-since`, `invalidates`, `unknown`; also `trace SUBJECT`, `impact-range FROM TO` and `stats`. SUBJECT is a path, a graph id, `L-504`, `item:<id>`, a schema id or `commit:<40 hex>`. Each run builds the graph afresh at the commit (resolved once and pinned) in a temporary directory with synthetic keys, and prints JSON: the graph's commit, cursor, digest and per-source observation, then the answer, bounded, explained and naming every source and version; gaps and unresolved links are part of it. `governs` says so when no `governs` relationship is stated (none is, today: no extractor projects contracts as governing). Exit 0, 1 (cannot be answered; the reason is the output) or 2 (usage).

## 7. Measurements (KB7)

On this container (Node v24.22.1), the real graph at `b10cf0a` (`extract.test.mjs` diagnostic; a separate-process replay measured with a throwaway script):

| What | Value |
|---|---|
| Facts | 17,779 (repository 14,211; verification 2,778; records 496; status 225; lessons 69), plus 5 observation records; 3,703 entities, 14,081 relationships. The timings below were taken at 17,759 facts, before the generated-family expansion added 20. |
| Build: five first observations (extract, diff, append) | 1.9 to 2.0 s |
| Replay in the same process (git readings cached) | 1.25 to 1.48 s (70 to 83 µs a fact) |
| Replay in a FRESH process (cold): `openGraph` re-deriving every source | 1.47 to 1.64 s; digest equal, complete |
| Projection digest | 52 to 57 ms |

**Replay exceeds about 1 s** (KB7). About 0.8 s is re-reading the sources at their versions (git objects, the skeleton for `suites.mjs`, the status ledger's verification) and about 0.7 s is Slice A's re-derivation (canonical digest and validation, about 40 µs a fact, register KG-1). **Proposed, not built**: a signed projection checkpoint beside the graph ledger, keyed by the ledger head and each source's observed version and digest, signed by the graph's operator; at open, a checkpoint whose key matches is loaded instead of re-deriving, its signature and digest checked; any mismatch falls back to full replay. It is a derived cache, never authoritative (the inventory's option 2). A cheaper first step: per-source fact caches keyed by `(source, version, facts digest)`, which the observation record already names.

## 8. Taken from pull request 70

Branch `ccr-3b496a5e-q1czrf`, `ophanim/graph/extract.mjs` (read with `git show FETCH_HEAD:...`, read only; nothing merged, cherry-picked or imported).

| PR 70 | Here |
|---|---|
| `mutationTargets(text)`: string constants, `const T = {...}` test-list tables, `const NAME = [...]` lists, chunking on `{id: '` | **taken and extended** in `verification.mjs` `mutationTable`: bounded to the `MUTATIONS` array; lists over several lines and spreading each other; every file a mutation edits (`file:`, `one(...)`, shared edit constants), not only the first; helper calls evaluated as text; name patterns kept apart from files; the runner's default deciding tests applied and marked; the generated family expanded. PR 70 read 511 of 512 targets on its tree; here 271 of 271. |
| repository reading from the working tree (`git ls-files -co`, `fs.readFileSync`) | **not taken**: KB1 reads at a commit from git's object store |
| test that imports a module recorded as `verifies` | **not taken**: an import is `depends-on` (structural); `verifies` is admitted only where a runner DECLARES the test decides the file (the registry admits authoritative `verifies` from a declared basis only) |
| register rows as `learning/limitation` with `applies-to` from the paths a row names | **not taken**: `applies-to` is not admitted from a textual basis; an entry is `evidence/record` and a named path is `mentions` |
| relationship types `part-of`, `instance-of`, `cited-by`, `modifies`, `provides`, `member-of`, `executable` entities | **not taken**: not registered in `ophanim.graph/v1`; Slice B used only registered types |

## 9. The demonstrations at this level

| Demonstration | Test | Evidence |
|---|---|---|
| 2 impact propagation | `impact.test.mjs` "a real component change", "only change-carrying", "a contract change", "a commit range" | REAL: chairs.mjs, context.mjs, `ophanim.graph/v1`, wave3-evidence.test.mjs at `b10cf0a`; SYNTHETIC: the commit range (a temporary repository) |
| 3 historical traceability | `impact.test.mjs` "trace:" | REAL: chairs.mjs (ticket and status item), context.mjs (register, verifiers, mutations, lessons; the requirement gap) |
| 7 source invalidation | `impact.test.mjs` "reassess:" | SYNTHETIC change (a temporary repository); a COPY of the real status ledger, made unreadable |
| 6 contradictory evidence | `graph-context.test.mjs` "a contradictory pair" | SYNTHETIC claims by two synthetic tools; a synthetic model's proposal refused as a supersession, kept as hypothetical |
| 12 negative cases | `extract.test.mjs` "demonstration 12", "the register's ids", "the status ledger is read ONLY"; `graph-context.test.mjs` "bounded" | REAL refusals of a foreign or absent status ledger; SYNTHETIC unregistered and misfiled extractors, broken imports, a ticket path not in the tree, an uncited register id, a forged continuation |
| section 8 queries | `impact.test.mjs` "answer:", `cli.test.mjs` | REAL |
| KB4 context | `graph-context.test.mjs` | REAL (references followed to the original bytes with `show`; the dossier of `co1-readability`) |

## 10. Mutations

`node ophanim/graph/graph-b.mutate.mjs [--only B1,...] [--check]`, each mutation run on a disposable copy (recorded findings not copied; the copy is a repository of its own with one commit) against only its deciding tests.

| Id | Mutation | Decided by |
|---|---|---|
| B1 | the repository extractor reads the working tree instead of the commit | extract "read at a commit" |
| B2 | a mention admitted as `depends-on` (the records origin declared, its citation edges typed `depends-on`) | extract "the register's ids" |
| B3 | a mutation runner executed (imported) instead of read as text | extract "read as TEXT" (the canary) |
| B4 | impact propagates through a qualification (`verifies`) | impact "only change-carrying" |
| B5 | impact turned into an undirected walk over every type to the ceilings (a global invalidation) | impact "a real component change" |
| B6 | a change event reassessed from every node of the graph | reassess |
| B7 | the context op returns a summary without its source references, versions or retrieval | graph op "references" |
| B8 | the dossier's graph view loses its byte bound | dossier |
| B9 | the graph op's traversal clamp removed | graph op "bounded" |
| B10 | a traceability gap filled by inference (a status item whose name resembles the file) | trace |
| B11 | a missing source reassessed as current | reassess |
| B12 | the status ledger opened writable (`create: true`) | extract "the status ledger is read ONLY" |
| B13 | an id no register entry defines shown as an entry | extract "the register's ids" |
| B14 | a fact's ref carries the commit (every commit changes every fact) | reassess |

The runner's result on the commit that adds this document is in the slice report.

## 11. Found and fixed in this slice

A fact's `ref` first named the commit (`path@<commit>`). The ref is part of an assertion's content, so EVERY commit changed EVERY repository fact: a change event listed the whole tree, a global invalidation by the back door. Refs now name where in the source a fact is (a path, a register entry by id), never the version (the observation carries it), and no fact text names the commit. Held by mutation B14.

## 12. Limits, caveats and future work

- The import regex is the layering test's: it also matches `from '...'` inside strings; only a relative specifier that resolves to a file of the tree becomes an edge (the rest is listed unresolved). Template-literal dynamic imports are not read. A rename is not followed through history.
- A ticket's item and a lessons class's commit or detector are joined to the repository by a stated identity at query time (labelled), not by a graph edge: a cross-source join rule (a registered `rule` admitting derived `introduced-because-of` and `derived-from` with inputs) is future work for Slice D.
- No extractor projects `governs`: contracts are read only as schema ids an exported constant carries. Ownership manifests (`docs/execution/*-ownership.json`, which state an authorization and the files it covers) are a natural declared source of `governs` and `authorizes`; not extracted here.
- The register is parsed from its Markdown table rows and decision bullets; an entry defined only in prose is not an entry. Paths an entry names are matched exactly against the tree.
- Mutation results are not in the repository and none is claimed (`result: null`); the runners' kill records (their `--log` summaries) are not a source yet.
- The work and cycle ledgers are proven on fixtures only: this container holds none.
- The graph is rebuilt per CLI run and per test process; replay is above 1 s (section 7).
- `scope` is recorded, not enforced (KG-3).
- The `graph` op is reachable only by a caller that supplies a graph; the stages, `reconcile.mjs` and the scheduler do not yet (Slice D). Until `reconcile.mjs` passes the graph, a plan citing a graph view is stale on its next gate (the safe direction).

**Owner decisions** (unchanged from Slice A, section 16): key custody for the graph domain; the traversal defaults; where a production graph ledger lives. New here: whether a projection checkpoint (section 7) is wanted before Slice D wires the graph into every gate.
