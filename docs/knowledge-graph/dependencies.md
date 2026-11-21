# Knowledge graphs: the dependency graph

**Direction** The owner, 2026-11-20: "We need a dependency graph as well."; "Investigative systems automation through provence centered evidence and auditing ... We can have every single thing in there. Figure it out."; "Build it here bring in Telis, Argo, Lexi functionality. don't wait for the coordinator".
**Contract** `ophanim.graph/v1`, 1.2.0 (Slice B2's), unchanged by these sources (`docs/knowledge-graph/architecture.md`). Nothing here adds an entity type, a relationship type or a file of `packages/graph/`.
**Base** `main` at `6511f59` (merged at `21d2bca`). Ported onto Slice B2 at `2d13a5b` (the owner: "Combine, B2 as base"): B2's sources stand for everything both efforts held, and only what B2 lacks is here, opt-in. Every source declares its extractor's version (`checkpoint.md` section 5a); the two that read code include the parser's version. The numbers in section 2 are of this repository at `2f83a50` with TELOS at `0c9b539`; section 3's are of the readings before the port, at `0eea481`.
**Standing** Built in one session outside the coordinator's slices, on the owner's direction; ported onto B2; taken over by the coordinator on 2026-11-21, after PR #75 closed when its base branch was deleted (the owner chose that the coordinator finish it). Not independently reviewed. Register: KG-30 to KG-38.

## 1. In one paragraph

There is no second graph. Each kind of dependency is one more **registered source** on the existing graph: a deterministic extractor reads a source at a version and states facts, each with where it was read and, for code, the lines. What a reading sees and cannot resolve is counted or listed, never guessed, and a name is never followed to another repository by resemblance. The systems graph already stated which file imports which. These sources state the rest: packages and pinned versions, the platform's modules, environment variable names, programs, files read by path, calls between functions, what this repository pins from outside, who is authorized to change what, what the runtime built, and the same for the three sibling repositories.

## 2. The sources

What this repository's code needs (packages and what the lockfile resolves, built-ins, environment variable names, programs, hosts, files read by path, the pins, the ownership manifests, other literals) is Slice B2's: `ophanim.packages`, `.imports`, `.environment`, `.paths`, `.pins`, `.authority`, `.literals`, in the default open. These sources add what B2 does not hold, and none of them is in the default open (`ORDER` is unchanged): `ophanim/graph/deps/index.mjs` composes them beside B2's when asked.

| Source | Module | Basis | Reads | States | Facts at `2f83a50` |
|---|---|---|---|---|---:|
| `ophanim.calls` | `deps/code.mjs` | structural | this repository's code at the commit | which function calls which: a function depends on the function it calls, in its file, in another file, through a re-export or a workspace package, and on the package it calls into | 16,452 |
| `ophanim.runtime.<name>` | `deps/runtime.mjs` | declared | one runtime state directory (`ophanim.runtime/v1`), after its chain verifies | what the board source's obligation nodes lack: attempts and their workers, accepted outputs and confirmed effects (by digest), the state node; never a dependency between obligations (the board source's fact) | per state |
| `sibling.<name>.code`, `.code-text` | `deps/code.mjs`, `deps/text.mjs` | structural, textual | a sibling's checkout at a commit (TELOS at the commit this repository pins); never executed | the whole of what its code needs, in B2's types and id forms, under the sibling's own file ids (`<name>:<path>`), each under a `systems/repository` entity; mentions apart | TELOS: 8,255 / 639 |
| `sibling.telos.weave` | `deps/weave.mjs` | declared | TELOS's committed Clotho ledger snapshot | each record TELOS wove and signed, after the chain, every record hash and every signature are checked | 4,817 |
| `sibling.<name>.declared` | `deps/declared.mjs` | declared | requirements, compose files, workflows, `OWNERSHIP.json`, `CURRENT-AUTHORITY.json`, `REPO_INVENTORY.md`, gate records | distributions required, services and the variable names they are given, CI actions, ownership lanes, the active authorization, the commits an inventory audited | TELOS: 41 |

Composed with B2's default sources, with TELOS and without an ARGO or LEXI checkout (each listed absent, with why), the graph is 18 sources, 63,960 assertions (15,517 entities, 48,443 relationships), at `2f83a50` (`node ophanim/graph/deps/cli.mjs stats --telos <checkout>`). PR #75's author measured all four repositories at `2d13a5b`: 23 sources, 73,151 facts, about 13 seconds.

**Readers.** JavaScript and TypeScript are read by the TypeScript compiler's parser, already a dev dependency (`deps/parse.mjs`); no type checker runs and no file is imported or executed. Python is read by a line-and-token reader in the same shape (`deps/python.mjs`): it reads no calls. Manifests have readers of their own (`deps/manifests.mjs`).

**Ids** (`deps/ids.mjs`) are Slice B2's, re-exported unchanged: a package (`systems/package`), an environment variable by NAME (`systems/environment-variable`), a program (`systems/executable`), a host (`systems/host`), a repository (`systems/repository`). The sibling repositories' and Python's forms are added in the same types (`<repository>:<path>` for a sibling's file, `python/<module>`, `pypi/<name>`, `image/<name>`). Nothing here adds a type.

## 3. What was brought in from TELOS, ARGO and LEXI

| From | What | How |
|---|---|---|
| TELOS, Lachesis (`lachesis/measure.mjs`) | dependencies, blast radius, relevance, the advisory risk class | **Ported** to `deps/measure.mjs` over the graph view. Thresholds and the coverage floor are Lachesis's. Two stated differences: a dependency edge here is `depends-on` or `consumes`; relevance leaves out the introducing-commit term. |
| TELOS, Clotho (`clotho/`, its self-weave) | TELOS's own signed dependency ledger | **Indexed** as what TELOS declares. 4,559 records verify; 4,369 are stated; 186 were woven from files that have since changed and are counted as stale; 4 have no registered counterpart. |
| TELOS | `CURRENT-AUTHORITY.json` | **Indexed**: the active authorization authorizes the active plan, which supersedes four listed plans. |
| TELOS | the 13 files this repository loads | **Linked**: `ophanim/governance.mjs` depends on each by digest pin; the sibling's node for the file is the same node. TELOS is read at the pinned commit; a checkout without it is not read at another. The pin states what this repository declares, the sibling's source states each file's own digest, and the audit compares them: 13 of 13 match. No fact depends on whether a checkout is present. |
| ARGO, `scripts/check-boundaries.mjs` | an import no manifest declares | **Ported as data**: such an import is still a dependency, marked `undeclared` and listed on the repository node. This repository has none; TELOS has 3 (in run deliverables). |
| ARGO | `OWNERSHIP.json`, `REPO_INVENTORY.md`, `PROVENANCE.json` | **Indexed**: 12 lanes govern the files under their paths; the inventory names the commits of LEXI, TELOS and claude-config it audited; this repository is derived from ARGO as the provenance record states. |
| LEXI | backend requirements, compose services, the gate record, Python and frontend code | **Indexed**: 14 distributions, 4 services with the variable names they are given, gate `G0` and the commit it names. LEXI has no dependency tooling of its own to port. |

A cross-check the two TELOS sources make possible: every one of the 225 file-to-file dependencies TELOS's weave declares is also found by this repository's own reading of the same commit. Of the 1,677 dependencies it declares between functions, this reading also states 444: Clotho records that a symbol uses an imported symbol, this reader records a call (KG-33).

## 4. The questions

```sh
node ophanim/graph/deps/cli.mjs needs SUBJECT        # what it depends on, by kind, with lines and sources
node ophanim/graph/deps/cli.mjs needed-by SUBJECT    # what depends on it, and the advisory assessment
node ophanim/graph/deps/cli.mjs audit                # what each reading could not state; where two sources agree
node ophanim/graph/deps/cli.mjs stats
```

`SUBJECT` is a path, `path#function`, `npm:name`, `node:name`, `program:name`, `env:NAME`, `host:name`, `<sibling>:path[#function]` or a graph id. Siblings are read from checkouts named by `--telos`, `--argo`, `--lexi` or `OPHANIM_TELOS_ROOT`, `OPHANIM_ARGO_ROOT`, `OPHANIM_LEXI_ROOT`; one that is not given is listed as absent. `--state NAME=DIR` adds a runtime state directory.

Real answers at the commits above:

| Question | Answer |
|---|---|
| what needs `pantheon/src/config/lanes.json` | 3 modules and 1 test read it by path (an import graph has none of them); 543 nodes in all; class high |
| what needs `telos:build-gate/sign.mjs` | 32 direct dependents, among them this repository's `ophanim/governance.mjs` by digest pin; 331 nodes in all; class high |
| what needs `env:OPHANIM_TELOS_ROOT` | 6 modules and 7 tests |
| what needs `program:git` | 72 modules and 15 tests, across the four repositories (a package, a program or a variable is one node for all of them) |

Every line of an answer names the relationship, the lines it was read from and the source and version that state it. A mention is listed apart and never counted. An answer's coverage is `attested-complete` only when every source is current and no reading of a repository the answer touches reported a gap.

## 5. Rules the sources keep

- A fact is read from git's object store at a commit, never the working tree; a sibling is never executed.
- An environment variable is its name. No value, default or literal beside it enters a fact, and a compose file's `NAME=value` keeps the name only.
- A path joined to a root a file computes becomes an edge only when exactly one tracked file fits, and the edge says the anchor was assumed.
- A weave, a pin table or a runtime chain that does not verify gives no facts: the source says why.
- A file the parser rejects gives no facts and is named.

## 6. Verification

Tests are `ophanim/graph/deps-*.test.mjs` (run by `npm run test:proof`): 115 tests at `2f83a50`, each on a repository or a signed weave made by the test. Before the port, nine defects were found by running the sources on the real repositories, by the graph refusing a fact, or by checking this document's own numbers; each was covered by a test before it was repaired.

**Mutation check.** `ophanim/graph/deps.mutate.mjs` (`2f83a50`, written by the coordinator's agent after the takeover), on the harness of the other runners (`--only`, `--check`, a disposable copy; exit 2, 3 or 1): 40 mutations, at least one per module and per "Must never" clause, each against its deciding tests. All 40 KILLED, the baseline 115/115; the coordinator re-ran 8 of them (D1, D8, D10, D21, D26, D27, D29, D35): all killed. The draft run left five surviving (D8, D10, D21, D27, D35); each gained a test that fails with its mutation and passes without it. No module changed. The Python and manifest readers are now mutation-checked (D13 to D17). This repairs KG-38.

## 7. Limits

Each is in the register (KG-30 to KG-38). In short: calls are resolved for top-level functions only; a computed path or program name is counted, not resolved; a Python import name is not linked to the distribution that provides it; ARGO and LEXI are read at whatever commit their checkout holds; the measures are advisory; nothing in the pipeline consumes this graph yet.
