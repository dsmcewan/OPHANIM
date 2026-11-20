# Knowledge graphs, Slice B2: the dependency sources of Graph B

**Directive** `docs/knowledge-graph/directive-2026-11-20.md`, Graph B ("Systems, Components & Dependency Graph": inputs, outputs, interfaces, dependencies and downstream consumers; deployment environments, operational integrations and system boundaries; versions), section 8 ("what depends on it?"), and the rule "Do not treat correlation, textual similarity, or a model-generated inference as verified dependency or causation". Register KG-7: `governs` and `authorizes`, whose declared source is the ownership manifests.
**Contract** `ophanim.graph/v1`, contract version **1.2.0** (`packages/graph/schema.mjs`; `docs/knowledge-graph/architecture.md` sections 3 and 7).
**Base** `0a4aa44` (branch `kg/slice-b2`). Every real-data number below is of the repository at `dd2b578abd25f908986834988db712f29abe7799`, the commit that adds the code, on this container (Node v24.22.1).
**Decisions** KD2-1 to KD2-10 are the coordinator's (the Slice B2 brief). This document says how each is implemented; it does not reopen them.

## 1. In one paragraph

Eight registered sources, beside Slice B's, read what OPHANIM needs from outside itself: the packages it imports and declares (with the lockfile's resolved versions), the environment variables it reads or sets (by name only), the programs it runs, the hosts its requests name, the tracked files it reads by path, the external sources it pins (TELOS, its lineage, CI actions, runners, the Node version), the authority the ownership manifests grant, and the run-time obligations on the board. Each is read with its own extractor origin and `extractorVersion`, from git's object store at the pinned commit (the board through its own reader, read only), and each fact carries its source, its version and the file and lines it was read from. A literal proves a dependency only as the argument of a call or read a recognizer knows; every other literal, and every literal in a comment, is a `mentions` on a textual basis, which impact never follows. What cannot be resolved is a gap on the node, never a guess. The impact, the section-8 queries and the command line follow the new relationships through the registry's own impact behaviour, and three new questions are answered on real data: what depends on a package, what a component needs from its environment, and which manifest authorized changes to a file under which region limit.

## 2. The sources (KD2-1)

| Source id | Extractor origin | Basis | Version | Read through | Facts at `dd2b578` |
|---|---|---|---|---|---|
| `ophanim.packages` | `ophanim.packages.extractor` (`extract/packages.mjs`) | declared | the commit | the committed `package.json` files and `package-lock.json` files | 268 |
| `ophanim.pins` | `ophanim.pins.extractor` (`extract/pins.mjs`) | declared | the commit | `ophanim/governance.mjs`'s pin tables, `PROVENANCE.json`, `.github/workflows/*.yml`, `engines` | 118 |
| `ophanim.imports` | `ophanim.imports.extractor` (`extract/packages.mjs`) | structural | the commit | every code file, lexed (`extract/code.mjs`); the workspace and the root lockfile | 2,156 |
| `ophanim.environment` | `ophanim.environment.extractor` (`extract/needs.mjs`) | structural | the commit | every code file, lexed | 503 |
| `ophanim.paths` | `ophanim.paths.extractor` (`extract/needs.mjs`) | structural | the commit | every code file, lexed; the commit's tree | 138 |
| `ophanim.authority` | `ophanim.authority.extractor` (`extract/authority.mjs`) | declared | the commit | `docs/execution/*-ownership.json` (`ophanim.wave-ownership/v1`) | 668 |
| `ophanim.literals` | `ophanim.literals.extractor` (`extract/needs.mjs`) | textual | the commit | comments and free literals of every code file | 973 |
| `ophanim.board` | `ophanim.board.extractor` (`extract/board.mjs`) | declared | the controller commit (64 hex) | `ophanim/board.mjs` `verifyRuntimeChain`, `readRuntimeSnapshot`, read only | fixture only (this container holds no board) |

Registration (`extract/index.mjs`): `ORIGIN_SPEC`, `ORDER` (repository, verification, records, lessons, then packages, pins, imports, environment, paths, authority, literals, then status, work, cycle, board), `EXTRACTOR_MODULES`, and `sourcesOf({deps = true, board = null})`. The seven repository-backed sources are composed by default and pinned to the same commit as Slice B's; the board when a state directory is named. Each declares its `extractorVersion` (the digest of its module and local imports, `checkpoint.md` section 5a); `extract-deps.test.mjs` "every new source is registered" and `extract.test.mjs` "every source of the systems graph declares" check it. One origin has one basis, so a source that both proves and names keeps the two apart: the structural sources admit dependencies, the textual literals source admits mentions only, and the packages source (declarations) is a separate declared source from the imports (structure).

## 3. What a literal proves (KD2-2, KD2-3)

`extract/code.mjs` lexes each code file once per commit: JavaScript (`.mjs .js .cjs .mts .ts`) with comments, string, template and regular-expression literals (a `/` starts a regular expression where an operand cannot end), and Python (`#` comments, prefixed and triple-quoted strings). It produces a MASKED text (comments blanked; every literal's body blanked, newlines kept) and the table of literals. Recognizers match the masked text only, so nothing inside a string or a comment is ever read as code, and an `import` inside a template literal written for a child process is not an import of the file. **Cross-check**: the static import specifiers it reads equal those V8's own module parser reports (`vm.SourceTextModule.moduleRequests`) for every `.mjs` of the tree (620 modules at `0a4aa44`), in `extract-deps.test.mjs`. (Slice B's `verification.mjs` `blankComments`, which the brief allowed exporting, is not regular-expression aware, so it was neither exported nor used; it is unchanged.)

| A literal is a dependency only here | Relationship (structural) | Recorded |
|---|---|---|
| an `import` / `export ... from` / `import()` specifier | `depends-on` a package, a workspace module or a `node:` built-in | specifiers, lines, need, how it resolved |
| `process.env.NAME`, `process.env['NAME']`; `os.environ['NAME']`, `os.environ.get('NAME')`, `os.getenv('NAME')` | read: `consumes`; set or deleted (`=`, `??=`, `delete`): `produces` | the NAME, lines, need; never a value |
| `spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync` bound from `node:child_process`, with a literal command (`exec`/`execSync`: its argv[0]) | `depends-on` an executable | command, api, lines, need |
| the same with `process.execPath` | `depends-on` `capability/runtime/node` | api, lines, need |
| `fetch`, `new URL`, `http(s).request` / `get` whose URL literal names the host (a template's literal head must reach past the host) | `depends-on` a host | host, scheme, api, lines, need; never contacted |
| an `fs` read or probe, or `path.join` / `resolve` / `dirname`, `new URL`, `fileURLToPath` rooted at a KNOWN ROOT (the module's file or directory, `import.meta`, a constant built from them in the file, or imported by name from a module that builds one) that resolves to a tracked file of the commit | `consumes` the file | how (read, probe, path), lines, need |

Everything else is at most a **mention** (`ophanim.literals`, textual): a comment or a free string literal that names a variable some code reads (`process.env.NAME`, `$NAME`, or the bare name), a URL's host, or a tracked path. A recognized call that cannot be resolved is a **gap**, kept on the file's node with its line (`environment_gaps`, `path_gaps`, `import_gaps`): a computed variable name (57), the whole environment passed or spread (67), a computed command (18), a computed or substituted URL (7), an `import()` of a non-literal (43), an fs read relative to the working directory or of a path not in the tree (8). A gap that would name a withheld path (recorded review findings) says so without the path. **Test needs** (a `*.test.*` file, a `*.mutate.mjs` runner, anything under a `test(s)` or `fixture(s)` directory: `needOf`) are recorded with `need: 'test'`, never as run-time needs; a variable read by a test and by a module is two facts. **Values**: no extractor reads an environment value, a secret or a key file; a planted synthetic value is searched for in every fact and is absent (`extract-deps.test.mjs`).

## 4. The schema additions (KD2-7, contract 1.2.0)

Four systems-domain entity types are ADDED; no relationship type is added and no existing type changed. The registry tables of `architecture.md` carry them (`packages/graph/tests/schema.test.mjs` keeps them equal to the code).

| Type | Meaning | Why no registered type has it |
|---|---|---|
| `systems/package` | a package code imports or a manifest declares: an npm package at the version its lockfile resolved (`npm/<name>@<version>`), a workspace package (`workspace/<name>`), or a runtime built-in (`node/<name>`); a name nothing resolves is `npm/<name>`, `unresolved` | `module` is a file of this repository; `component` carries no version or ecosystem |
| `systems/environment-variable` | an environment variable, by its NAME only (never its value) | none names a process environment entry |
| `systems/executable` | a program code runs by name | `capability/tool` is a tool an agent may use, not a program a module spawns |
| `systems/host` | a network host a request names | `api` and `service` would claim an interface the code does not state |

The relationships, all registered, as these sources use them:

| Type | From → to | Impact (the registry's) | Admitted here from |
|---|---|---|---|
| `depends-on` | code → package, executable, host, runtime; package → package (the lockfile tree); a workspace package → its export target; package.json → package (a declaration) and → runtime (`engines`); workflow → action repository, runner, runtime (its version), checked-out repository; governance.mjs → TELOS, each pinned TELOS file, each pinned verifier; obligation → obligation | to → from | structural (imports, environment), declared (packages, pins, board) |
| `consumes` | code → variable (a read); code → tracked file (read by path) | to → from | structural |
| `produces` | code → variable (set or deleted); workflow → variable (set from a secret or a repository variable, by name) | from → to | structural, declared |
| `derived-from` | package → lockfile; workspace package → package.json; a pinned TELOS file → TELOS; repository → its PROVENANCE.json source; a filtered commit → its source commit; an authorization or grant → its manifest | to → from | declared |
| `governs` | a manifest's authorization → the change set of each `coordinator_only` glob | from → to | declared |
| `authorizes` | a grant → the change set of each `files` glob and allowed extra (`systems/change/paths/<glob>`) | from → to | declared |
| `mentions` | code → variable, host or tracked file it only names | not followed | textual |

`authorizes` admits `systems/change` and not a file, so a grant authorizes the **change set** its glob names, one node per glob (the manifest's own unit; a glob longer than a key is keyed by its digest, the glob its attribute). Which grant covers a given FILE is the ownership checker's own match (`path.matchesGlob` of an entry's first word, `docs/execution/check-ownership.mjs`), made at query time and labelled a JOIN. A first version made one change node per matched file (2,700 facts); it put the snapshot open over budget for no new fact, and was replaced (section 7).

## 5. What each source states

| Source | Entities | Relationships |
|---|---|---|
| packages | 60 installed packages (name, resolved version, integrity, lockfile entries), 4 workspace packages | 121 `derived-from` lockfile, 83 lockfile `depends-on`, declarations (6 in 5 package.json files: the declared range and the resolved version apart) and workspace exports |
| imports | 17 `node:` built-ins (each `depends-on` the Node runtime) | 2,115 `depends-on`; no unresolved bare import at this commit |
| environment | 69 variable names (with the pins' and the mentions'), 7 executables, 1 host, the Node runtime | 159 `consumes`, 59 `produces`, 140 `depends-on` (programs, hosts, process.execPath) |
| paths | — | 136 `consumes` (86 distinct files; 53 reads, 2 probes, 107 paths) |
| pins | TELOS at `0c9b539` and its 13 pinned files, 5 local verifier files pinned (each digest equal to the file's bytes at the commit), 3 action repositories, the cloned TELOS repository, `argo` and `pantheon` (PROVENANCE.json), 18 lineage commits, the runner `ubuntu-24.04`, 3 workflows | 38 `depends-on`, 24 `derived-from`, 8 `produces` |
| authority | 15 manifest authorizations, 24 grants (quoted), 210 change sets | 294 `authorizes`, 86 `governs`, 39 `derived-from` |
| literals | variable and host nodes they name | 899 `mentions` |
| board | each obligation (kind, scope, output key, status, attempts, input NAMES) | `depends-on` per `dependsOn` |

Run-time needs at `dd2b578`: 37 variable names read or set by run-time code (40 by tests, 11 by both); programs `git`, `sh`, `tar` and the running Node; **no host is named by a recognized request at run time** (the one recognized host, `127.0.0.1`, is a test need): the provider and GitHub endpoints are named in constants and configuration objects (`const API = 'https://api.github.com'`, `endpoint: "https://api.openai.com/..."`), which are mentions (20 host nodes in all), never dependencies. `bwrap` is spawned through a parameter (`sandboxAvailable(bwrap = "bwrap")`), not a literal: not recorded.

## 6. The queries on real data (KD2-8)

`ophanim/graph/impact.mjs` adds `packageDependents`, `needsOf`, `authorityOf` (`answer(graph, 'package' | 'needs' | 'authority', ...)`) and subject prefixes (`npm:`, `package:`, `lock:<lockfile>#<entry>`, `node:`, `workspace:`, `repository:`, `env:`, `exec:`, `host:`, `runtime:`); `cli.mjs` adds `package NAME`, `needs PATH [--transitive]`, `authority PATH` and `--no-deps`. `impact` already follows `depends-on`, `consumes`, `produces`, `derived-from`, `governs` and `authorizes` (its `CHANGE_TYPES` are the registry's impact types less the qualifications), so `dependents` and `invalidates` reach through them with explained paths. Every answer names its sources, their versions and the lines. Tests: `extract-deps-queries.test.mjs`, `cli.test.mjs`.

| Question | Answer at `dd2b578` |
|---|---|
| What depends on `@google/genai`? | one installed version, `2.32.0` (`sha512-60c79uXp...`, `package-lock.json#pantheon/node_modules/@google/genai`); 9 run-time importers (e.g. `pantheon/bin/pantheon-build.mjs:15`, `pantheon/src/sdk/live.mjs`, a dynamic import) and 1 test importer (`pantheon/tests/google-long-decode.test.mjs`), apart; declared by `pantheon/package.json` (`2.32.0`); its reach, bounded at depth 4: 93 consumers, 41 tests, 3 suites, 1 workflow, 172 mutations, with continuation. `@types/node` is two packages (24.10.1 at the root, 26.6.3 under pantheon). |
| What does `ophanim/public/github.mjs` need? | run time: `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (line 281), `OPHANIM_OWNER_LOGIN`, `OPHANIM_STATUS_LEDGER`, `OPHANIM_WORK_LEDGER`, `PANTHEON_CYCLE_LEDGER`, by name; `git` (line 300); `node:child_process`, `fs`, `path`, `url`; no host (`api.github.com` is a mention); no test need. `--transitive` from `ophanim/operate/cli.mjs`: 106 files, 29 variable needs, 6 programs, each with its path from the subject. |
| Which manifest authorized changes to `ophanim/graph/impact.mjs`, under which limit? | `kg-slice-a` (`ophanim/graph/**`: "KD12 only: the one thin, read-only source adapter (the lessons registry) and its test"), `kg-slice-b` (no limit on it), `kg-slice-b2` ("KD2-8: traverse the new relationships per their impact behaviour; existing answers unchanged"), each quoted with the wave, the authorization text and the branch. `package.json` is governed (coordinator-only) by six manifests, and authorized to four grants under their limits ("the test:lint entry only", ...). |
| What would a change to a lockfile entry reach? | `invalidates lock:package-lock.json#pantheon/node_modules/@google/genai`: the same reach as the package, each node with its path (`depends-on` from the imports source). |
| What would a change to the TELOS pin reach? | `invalidates repository:telos`: `ophanim/governance.mjs` (one hop, the pins source), the 13 pinned TELOS files, and what imports governance.mjs: 90 consumers, 17 tests, 1 suite, 1 workflow at depth 4. |
| What would a change to a workflow reach? | `operate.yml` sets `GITHUB_TOKEN` from a secret (by name); `github.mjs` reads it: the reader is reached by `produces` then `consumes`. |

The section-8 `governs` answer is unchanged (it reads the `governs` / `governed-by` edges of its subject; the manifests govern change sets, which `authority` answers).

## 7. Measurements (KD2-9)

On this container, the real graph at `dd2b578`, built in a temporary directory with synthetic keys, then opened in FRESH processes (module loading outside the times), with and without the dependency sources (`sourcesOf({deps})`):

| | without (Slice B's sources) | with Slice B2's |
|---|---|---|
| Facts | 19,994 | 24,818 (+4,824: packages 268, pins 118, imports 2,156, environment 503, paths 138, authority 668, literals 973) |
| Snapshot | 24.8 MiB | 31.2 MiB |
| **Open from a current snapshot** | 351, 354, 364, 389, 401 ms | **451, 481, 521, 573, 587, 588, 617 ms** |
| Full open | 1.63, 1.80, 1.89 s | 2.49, 2.80, 2.81 s |
| Building (seven observations, same process) | — | packages 55, pins 50, imports 698 (it lexes the code first, about 0.5 s, cached for the others), environment 67, paths 47, authority 159, literals 208 ms |

**The 0.5 s target is NOT met: 5 of 7 opens from a current snapshot took more than 0.5 s (median 573 ms).** Where the time goes, one part at a time in the same process (three runs; without / with): JSON parse of the state 153-205 / 191-292 ms; the projection-digest check 94-134 / 143-157 ms; restoring the indexes 49-66 / 79-89 ms; the sha256 of the state 21 / 26-30 ms; reading the file 16-17 / 18-23 ms. Every part grows with the number of assertions (19,999 / 24,830); none is new work. The open from a snapshot parses the whole state, the constant factor `checkpoint.md` section 11 names. Trimmed already: the per-file authority change sets (2,032 facts) and the long repeated authority and basis strings; what remains is one fact per thing stated (2,115 of the imports' facts are one edge per file and package, 2,066 of them to `node:` built-ins). The next steps belong to `packages/graph` (not this slice): a compact encoding of the snapshot's records, per-source fact caches keyed by `(source, version, facts digest)`, or a snapshot per source family.

## 8. Mutations

`node ophanim/graph/graph-b2.mutate.mjs [--only D1,...] [--check]`, on a disposable copy (recorded findings not copied; one commit), each mutation against only its deciding tests. D3 reads a value only for the synthetic names its test plants.

| Id | Mutation | Decided by |
|---|---|---|
| D1 | a comment is not blanked: its literal read as code, recorded as a dependency | deps "a URL, an environment name or a path in a comment" |
| D2 | a literal outside a recognized call (a URL in a constant) recorded as a host dependency | the same; query "what a component needs" |
| D11 | a mention admitted as a dependency (the literals origin structural, its edges `depends-on`) | deps "every new source is registered", "a URL ... in a comment" |
| D3 | an environment value read and recorded | deps "no environment value is read" |
| D4 | an unresolved alias guessed (a file whose path ends like the specifier) | deps "an alias resolves through the workspace or is a gap" |
| D5 | the declared range recorded as the resolved version | the same; query "what depends on @google/genai" |
| D6 | test needs merged into run-time needs | deps "test needs are kept apart" |
| D7 | a manifest's region limits dropped | deps "a manifest's grants"; query "which manifest authorized" |
| D8 | the code read from the working tree instead of the commit | deps "the working tree is never read" |
| D9 | the new sources composed without their `extractorVersion` | deps "every new source is registered"; extract "every source ... declares" |
| D12 | a withheld path named in a gap | deps "no fact names a withheld path" |
| D10 | impact not following `consumes`, though its impact behaviour says it should | deps "impact follows consumes"; query "what a change ... reaches" |

The runner's result on the commit that adds this document is in the slice report.

## 9. What remains

- **Function-level calls** (item 5) and **the vendor documentation** (item 8): not this slice's.
- **Systems OPHANIM builds**: none is in the repository yet, so none is extracted.
- **Constants are not followed.** A URL, a command or a path held in a constant and used through it (`fetch(`${API}/...`)`, `spawnPromise(bwrap, ...)`) is a mention, not a dependency; following a `const` binding to its use would be a recognized form KD2-2 does not list. So the run-time hosts of the provider SDKs and of GitHub are mentions today.
- **Python imports** and shell scripts are not read for packages or programs; Python is read for `os.environ` only.
- **Documentation** is not scanned for mentions (comments and code literals are); "at most a mention" allows it, and the register's mentions are Slice B's.
- **The workspace root's lockfile** resolves imports; `pantheon/package-lock.json` is read as declarations (the same installed versions) but resolves nothing.
- **The board** is proven on a SYNTHETIC fixture written through `ophanim/board.mjs`: this container holds no runtime board.
- **`checkpoint.test.mjs:120`** (packages/graph, not in this slice's manifest) pins the refusal message `contract 1.1.0`; with KD2-7's bump it fails 1 of 59 `packages/graph` tests. The fix is one line: interpolate `CONTRACT_VERSION`.
- **`npm ci` was not run here** (refused by this session's permission policy, and it would fetch): no `node_modules`, so no test depended on one.

## 10. Owner decisions

None new. The snapshot target (section 7) is a measurement the coordinator weighs against the next `packages/graph` step; whether the dependency sources stay composed by default (`deps: true`) or move to their own snapshot is the coordinator's call at integration.
