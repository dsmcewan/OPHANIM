# Knowledge graphs: the dependency graph

**Direction** The owner, 2026-11-20: "We need a dependency graph as well."; "Investigative systems automation through provence centered evidence and auditing ... We can have every single thing in there. Figure it out."; "Build it here bring in Telis, Argo, Lexi functionality. don't wait for the coordinator".
**Contract** `ophanim.graph/v1`, 1.1.0, unchanged (`docs/knowledge-graph/architecture.md`). Nothing here adds an entity type, a relationship type or a file of `packages/graph/`.
**Base** `ophanim/knowledge-graphs` at `6196c07` (merged in; first cut from `1f4666b`). Every source declares its extractor's version (`checkpoint.md` section 5a); the two that read code include the parser's version. Every real number below is of this repository at `0eea481`, TELOS at `0c9b539` (the commit this repository pins), ARGO at `a218ee3` and LEXI at `4a9faf3` (the commits their checkouts held).
**Standing** Built in one session outside the coordinator's slices, on the owner's direction. Not independently reviewed. Register: KG-30 to KG-38.

## 1. In one paragraph

There is no second graph. Each kind of dependency is one more **registered source** on the existing graph: a deterministic extractor reads a source at a version and states facts, each with where it was read and, for code, the lines. What a reading sees and cannot resolve is counted or listed, never guessed, and a name is never followed to another repository by resemblance. The systems graph already stated which file imports which. These sources state the rest: packages and pinned versions, the platform's modules, environment variable names, programs, files read by path, calls between functions, what this repository pins from outside, who is authorized to change what, what the runtime built, and the same for the three sibling repositories.

## 2. The sources

| Source | Module | Basis | Reads | States | Facts |
|---|---|---|---|---|---:|
| `ophanim.code` | `deps/code.mjs` | structural | every `.mjs/.js/.cjs/.ts/.tsx/.py` file, `package.json` and lockfiles at the commit | packages (declared where, locked at what), platform modules, environment variable **names**, programs run, files read and written by path, calls between functions | 16,476 |
| `ophanim.code-text` | `deps/text.mjs` | textual | the same parse | `mentions` only: a host or a tracked path a string names | 409 |
| `ophanim.pins` | `deps/pins.mjs` | declared | `ophanim/governance.mjs` (as text), `PROVENANCE.json`, the CI workflows, `package.json` | the TELOS commit and 13 file digests as declared, the 5 local checker digests, the ARGO lineage, CI actions and the Node version | 82 |
| `ophanim.ownership` | `deps/authority.mjs` | declared | `docs/execution/*-ownership.json` | each manifest as an authorization that `governs` the files its paths cover at the commit | 1,779 |
| `ophanim.runtime.<name>` | `deps/runtime.mjs` | declared | one runtime state directory (`ophanim.runtime/v1` on `refs/board/ophanim`), after its chain verifies | obligations and what each depends on, attempts and their workers, accepted outputs and confirmed effects, by digest | per state |
| `sibling.<name>.code`, `.code-text` | the same two modules | as above | a sibling's checkout at a commit | the same facts under the sibling's own node ids (`<name>:<path>`) | 8,240 / 13,024 / 5,538 |
| `sibling.telos.weave` | `deps/weave.mjs` | declared | TELOS's committed Clotho ledger snapshot | each record TELOS wove and signed, after the chain, every record hash and every signature are checked | 4,817 |
| `sibling.<name>.declared` | `deps/declared.mjs` | declared | requirements, compose files, workflows, `OWNERSHIP.json`, `CURRENT-AUTHORITY.json`, `REPO_INVENTORY.md`, gate records | distributions required, services and the variable names they are given, CI actions, ownership lanes, the active and superseded plans, audited commits, gates | 41 / 672 / 161 |

Composed with the systems and evidence sources (`deps/index.mjs`), the graph is 19 sources, 72,012 assertions (18,786 entities, 53,226 relationships), built in about ten seconds.

**Readers.** JavaScript and TypeScript are read by the TypeScript compiler's parser, already a dev dependency (`deps/parse.mjs`); no type checker runs and no file is imported or executed. Python is read by a line-and-token reader in the same shape (`deps/python.mjs`): it reads no calls. Manifests have readers of their own (`deps/manifests.mjs`).

**Ids** (`deps/ids.mjs`) use registered types only: a package, platform module, program, action or image is a `systems/component` (`npm:`, `pypi:`, `python:`, `node:`, `program:`, `action:`, `image:`); an environment variable is a `systems/interface` (`env:NAME`, never a value); a host or a composed service is a `systems/service`; a sibling's file is `<name>:<path>`.

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

Tests are `ophanim/graph/deps-*.test.mjs` (run by `npm run test:proof`): 136 tests, each on a repository or a signed weave made by the test. Nine defects were found by running the sources on the real repositories, by the graph refusing a fact, or by checking this document's own numbers, and each was covered by a test before it was repaired: a call outside any function to an imported package collided with the import's own edge; a workspace's lockfile entry was read as a package with no name; a specifier that names no package broke call resolution; mention lines were merged across targets; the order of an answer's gaps followed assertion ids; a repository whose inventory names itself was stated twice; a path of four segments was taken for a graph id; one commit gave different pin facts with and without a TELOS checkout (the coordinator's finding); a sibling's file first seen as an import target lost its own attributes.

**Mutation check.** 56 lines of the modules written in the main session were each changed once and the relevant tests run: 51 failed a test at first; 4 had no test case, now added, and fail one; 1 was a condition that could never matter, now removed. The workers reported the same check on their modules: 16 lines of the pins and ownership sources (15 failed a test, 1 redundant line removed) and 6 of the runtime source (all failed a test). The two readers (`python.mjs`, `manifests.mjs`) were not mutation-checked. The script is not kept in the repository (KG-38).

## 7. Limits

Each is in the register (KG-30 to KG-38). In short: calls are resolved for top-level functions only; a computed path or program name is counted, not resolved; a Python import name is not linked to the distribution that provides it; ARGO and LEXI are read at whatever commit their checkout holds; the measures are advisory; nothing in the pipeline consumes this graph yet.
