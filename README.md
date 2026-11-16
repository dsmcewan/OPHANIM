# Ophanim

Ophanim coordinates planning and execution through a persistent blackboard. The blackboard exposes ready obligations. The scheduler assigns work. Workers produce evidence. TELOS verifies what can become accepted state.

The inherited Pantheon engine lives in `pantheon/`. Its public adapter entry point is `pantheon/src/index.mjs`. The companion model client is in `packages/model-client/`. ARGO-specific native Git and Mesh adapters remain in ARGO.

Use Linux, Node 24, Python 3 and Bubblewrap for the inherited acceptance suite.

```sh
npm ci --ignore-scripts
npm test
```

The [provenance record](PROVENANCE.json) records the ARGO source and filtered Git lineage. ARGO retains the historical `pantheon-seat-core/` as an archive.

The current [planning lessons](docs/planning/LESSONS.md) study how to derive and evaluate a plan's requirements. The owner clarified that this is a learning exercise. The earlier [Phase 0–2 packet](docs/planning/phase0-2-evaluation/README.md) is retained as historical, mis-scoped output and is superseded as the direction of this exercise; it is not an active execution backlog.

Continue with the [six-phase learning progression](docs/planning/FUNDAMENTALS.md), [planning coach charter](docs/planning/PLANNING_COACH.md), [progress record](docs/planning/LEARNING_PROGRESS.md) and [CLI resume prompt](docs/planning/CLI_HANDOFF.md). No phase is marked learned until its exercise supplies the required evidence.

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

## Investigation selection

After a governed convergence, Ophanim derives versioned models from the contribution registry and accepted trace. The models preserve function contracts, variable ranges, dependencies and uncertainty. Independently checked observations update the matching scope and keep causal hypotheses provisional.

The controller ranks measurable questions by the value of resolving them. It compares competing predictions with available measurement methods and accounts for forecast workload, confidence, cost, rollout, regression and alternatives. The decision receipt keeps the expected information value separate from any forecast performance gain. Missing estimates produce `insufficient_evidence`. Applicable prior decisions suppress duplicate work. A bounded scope journal binds each decision to its Pantheon trace and can recover a committed decision after interruption.

Routine convergence uses retained local evidence and spends zero model calls. The programmatic `planInvestigation` interface accepts scoped findings, measurement capabilities and value estimates from a trusted integration. An optional `refineInvestigation` adapter can supply one bounded text-only model turn when a positive unresolved design tradeoff justifies its cost. The caller supplies the model route and budget. Advice contributes typed hypotheses for deterministic reevaluation.

```sh
node ophanim/cli.mjs investigate --state /absolute/synthetic-state
node ophanim/cli.mjs investigate --historical-report /absolute/admission-proof.json --output /absolute/new-latency-receipt.json
node ophanim/cli.mjs investigate --historical-report /absolute/admission-proof.json --verify-receipt /absolute/latency-receipt.json
```

To supply a local workload forecast, use `demo --expected-convergences N --investigation-estimate /absolute/forecast.json`. The estimate uses schema `ophanim.investigation-estimate/v1` with the exact `scopeSha`, a `basis`, and `estimates` for applicability, confidence, decision-change probability and costs. It can include an `instrumentationCeilingMs` within the existing cap. These are declared planning inputs. The report records their source identity and keeps empirical measurements separate.

Investigation selection produces a proposal with measurement boundaries, independent verification requirements and stopping conditions. Execution and activation require the existing separate authority. The local synthetic controls retain the same acceptance, effects, latency and recovery requirements.

## Measurement qualification

For a retained callback investigation, the measurement adapter compares the predicted signals against the available measurements. It can recommend monotonic timer scheduling, callback entry, transformation start and completion, and callback return. The resulting durations distinguish timer overshoot from transformation wall time. Aggregate CPU, event-loop statistics, and retained queue and verification spans can provide context. The plan credits measurements that distinguish the competing predictions.

```sh
measurement=ophanim/efficiency/investigation/measurement.mjs
node "$measurement" plan --history /absolute/latency-receipt.json --receipt-sha HISTORY_SHA
node "$measurement" qualify --history /absolute/latency-receipt.json --receipt-sha HISTORY_SHA \
  --admission-proof /absolute/admission-proof.json --forecast /absolute/forecast.json --state /absolute/private-evidence
node "$measurement" verify --history /absolute/latency-receipt.json --receipt-sha HISTORY_SHA \
  --admission-proof /absolute/admission-proof.json --report /absolute/qualification.json --qualification-sha REPORT_SHA
```

The forecast uses schema `ophanim.measurement-forecast/v1`, the exact `scopeSha`, a `basis`, and `estimatedInvestigationMs` covering signed-source verification and calibration. Its `estimates` carry expected convergences, applicability, confidence, decision-change probability, avoidable decision loss per convergence, rollout, regression and opportunity costs. A forecast can decline any collection. Without a justified forecast, the retained historical investigation reports `insufficient_evidence`.

An explicit qualification invocation runs four counterbalanced matched blocks on one frozen, TELOS-accepted synthetic obligation. Each block compares baseline, delayed timer resumption, increased transformation work, and both controls, with collection on and off. The probe retains monotonic marks, measured overhead and the exact accepted output and effect-proposal identities. It cannot apply destination effects or activate a change. The verifier reopens the actual signed source and recomputes contrasts and uncertainty from raw samples. Experiment identity, completed receipts, and interrupted reservations survive restart.

The calibration establishes what the selected measurements can distinguish under controlled conditions. Historical attribution, workflow-level recovery and naturally occurring interactions require separately applicable evidence. The historical stage p95 requirement still governs scheduler decisions.
