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

The assessment includes a source-linked contribution registry and a variable catalog. They tie each function's contract, dependencies, consumers and measured contribution to the accepted trace. The catalog identifies protected governance requirements, replaceable mechanisms, environmental factors, interactions and the evidence each proposed change would need. Resource measurements shared across functions carry a shared attribution, and missing measurements remain null.

The qualified experiment changes the synthetic baseline from one scheduler slot to three. Admission estimates the work that could overlap, discounts uncertainty and stage latency risk, and compares the expected benefit with replay, verification, authorization and rollout costs. It uses one future exact-scope convergence by default. Supply `--expected-convergences 20` on `demo` when you expect that many matching runs. Forecasts are capped at twenty. A decision of `no_change` retains its reasons and the gate's wall time and CPU cost. Exact matching scope, recipe and accepted result identities retain prior evidence through timing noise.

An admitted experiment uses three alternating pairs of clean trials and a crash and resume at each width, bounded by the separate 30-second replay budget. TELOS independently checks accepted outputs, destination effects, recovery and system-level timing before it can sign a scoped decision. The controller deducts measured assessment cost and a rollout reserve from the expected savings. Realized savings and projected savings have separate fields. Provider spend and model invocations remain zero in this synthetic workflow.

Use `demo --state /absolute/new-state --cases 3 --efficiency-root /absolute/efficiency-ledger` to share the experiment and decision history across fresh synthetic states. A signed decision governs only the exact matching scope and up to 20 qualified convergences. `prove` retains assessment evidence and `verify` rechecks its binding to the board. Earlier proof directories remain verifiable through their original proof format and source paths.

To reproduce a retained three-slot result, pass its original manifest path to the admission proof runner. It independently rechecks the retained evidence, exercises a fresh admission decision with the same inputs and reports a separate deterministic positive case.

```sh
node ophanim/efficiency/admission-proof.mjs report --output /absolute/new-admission-proof --manifest /absolute/original-state/efficiency/convergences/commit-ID/experiment/manifest.json
```
