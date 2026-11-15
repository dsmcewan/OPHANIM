# Ophanim

Ophanim coordinates planning and execution through a persistent blackboard. The blackboard exposes ready obligations. The scheduler assigns work. Workers produce evidence. TELOS verifies what can become accepted state.

The inherited Pantheon engine lives in `pantheon/`. Its public adapter entry point is `pantheon/src/index.mjs`. The companion model client is in `packages/model-client/`. ARGO-specific native Git and Mesh adapters remain in ARGO.

Use Linux, Node 24, Python 3 and Bubblewrap for the inherited acceptance suite.

```sh
npm ci --ignore-scripts
npm test
```

The [provenance record](PROVENANCE.json) records the ARGO source and filtered Git lineage. ARGO retains the historical `pantheon-seat-core/` as an archive.

## Run the synthetic planning proof

Use a separate TELOS checkout at `0c9b539ddbb08e1464603faf786e0d5cdfc33fb8` and set `OPHANIM_TELOS_ROOT` to its absolute path. Ophanim checks the TELOS source files against built-in digests before loading the governance code. The proof creates local fixture identities and a synthetic queue inside the output directory.

```sh
export OPHANIM_TELOS_ROOT=/absolute/path/to/pinned-telos
node ophanim/cli.mjs prove --output /absolute/path/to/new-proof
node ophanim/cli.mjs verify --output /absolute/path/to/proof
```

The proof runs the complete Operations intake flow, injects failures, resumes child processes, verifies and activates a narrow alias repair, and rehearses rollback. It also composes dependent units, replicates the workflow into a second scope, and compares one and three scheduler slots using the same synthetic work. The verifier reconstructs the retained source, board, governance and destination evidence and replays deterministic semantic checks. It uses the original proof paths and executable paths bound by TELOS. Run a fresh proof on a different checkout or installation.

Use `node ophanim/cli.mjs resume --state /absolute/path/to/proof/scenario-state` to resume a retained scenario with a saved request. Use `node ophanim/cli.mjs status --state /absolute/path/to/proof/scenario-state` to inspect its obligations and effect state.

The qualification covers deterministic workers, fixture TELOS authority and local queue effects. Live models, shared drives, business destinations and production rollout each require their own qualification.

## Execution efficiency after convergence

Each governed CLI convergence retains an assessment next to the accepted Pantheon commit under the state's `efficiency/convergences/` directory. It records the obligation graph, exact input and policy identities, acceptance evidence, worker and verifier timings, and context bytes. An interrupted assessment recovers from the retained board and distinguishes missing measurements from measured zero activity.

The first optimizer can propose changing a synthetic baseline from one scheduler slot to three. It screens for enough independent work before spending its separate 30-second replay budget. An eligible experiment uses three alternating pairs of clean trials plus a crash and resume at each width. The evaluator compares accepted outputs, destination effects, TELOS checks, recovery, and resource use. Identical scope fingerprints prevent retrying an already recorded experiment. Disposable trials omit recursive optimization.

The TELOS adapter owns the executable acceptance checks and signs eligible scheduler decisions. A proposal must preserve the worker and acceptance policy and meet the minimum latency and recovery criteria. The controller also charges the assessment and verification time against the bounded forecast. A measured gain that cannot repay that cost produces `no_change`. Realized savings and projected savings are recorded separately. These measurements cover local fixture execution, where provider spend and model calls are zero.

Use `demo --state /absolute/new-state --cases 3 --efficiency-root /absolute/efficiency-ledger` to share the experiment and decision history across fresh synthetic states. A signed decision governs only the exact matching scope and up to 20 qualified convergences. `prove` retains assessment evidence and `verify` rechecks its binding to the board. Earlier proof directories remain verifiable through their original proof format and source paths.
