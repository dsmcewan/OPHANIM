# Knowledge graphs, Slice C1: the capability and model/runtime graph (advisory)

**Slice** C1 of the program the owner's directive of 2026-11-20 sets (`docs/knowledge-graph/directive-2026-11-20.md`): its Graph A, section 5 and demonstrations 4 and 12, on the Slice A foundation (`packages/graph/`, `docs/knowledge-graph/architecture.md`, contract `ophanim.graph/v1`, now **1.1.0**).
**Branch** `kg/slice-c1`, from `b00c8c4`.
**Owner decisions** (2026-11-20, quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-20 (knowledge graphs, Slice C)"): 1. "Yes, bubble per seat"; 2. "Work by evidence, review by lab"; 3. "Keep the seats as we have them for now until we better understand the metrics". They are the acceptance test together with the directive. KC1 to KC8 are the coordinator's; this document says how each is implemented and does not reopen them.

## 1. What this is, in one paragraph

Pantheon's registries stay where they are. Eight **registered sources** project them, at their versions, as `capability`-domain assertions of the graph contract: the runtime declarations (each claim checked against the code it quotes), the model registry, the lanes, the identity policy, the roles and chairs, the **executable capabilities** (model or lane × runtime × transport × tools × sandbox profile × credential scope, with the constraints under which each works and its **bubble** as the code provides it), and the owner-directed seating tables and fit matrix as **placements** (direction, never measurement). An **advisory eligibility decision** reads that graph for a task's requirements and explains which capabilities the evidence admits and what excluded the others. `selectSeat` makes its live choice exactly as before and then records the decision beside it; the selected seats are byte-identical with and without the graph. **Metrics** are extracted from the execution records as observed assertions, and no `qualified-for` is emitted: the owner has defined no criterion.

| Decision | Implemented in | How |
|---|---|---|
| KC1 the capability graph | `pantheon/src/capability/graph.mjs`, `runtimes.json` | section 2 |
| KC2 the bubble | `runtimes.json` `profiles.*.bubble`, `graph.mjs` `bubbleComponent` | section 4 |
| KC3 eligibility | `pantheon/src/capability/eligibility.mjs` | section 5 |
| KC4 advisory recording | `pantheon/src/route/frontier.mjs` `selectSeat`, `pantheon/src/capability/advisory.mjs`, `pantheon/src/ledger/kinds.mjs` `capability` | section 6 |
| KC5 the metrics | `pantheon/src/capability/metrics.mjs`, `cli.mjs` | section 7 |
| KC6 demonstration 4 | `pantheon/tests/capability-eligibility.test.mjs` | section 8 |
| KC7 the schema, 1.1.0 | `packages/graph/schema.mjs`, the registry tables of `architecture.md` | section 9 |
| KC8 this document | — | — |

## 2. The extractors and sources

Two extractors are registered (`capabilityOrigins`; which key signs each is the owner's, `architecture.md` section 16): `pantheon.capability.declared` (basis declared) projects seven sources; `pantheon.capability.structural` (basis structural) projects the executable capabilities, which are composed from the structure of the others. Each source's **version** is the digest of its data (canonical JSON, `packages/ledger/canonical.mjs`); `readAt(version)` re-derives the facts of a version the adapter holds and throws for any other, so a replay that cannot read a version marks the source unavailable instead of inventing its facts. Sources are observed in `SOURCE_ORDER`, so every relationship's endpoints are projected by its own source or an earlier one. Nothing is continuously synchronized: a source is current as of its last observation (`freshness()`).

| Source | Extractor | What it reads | Facts on this checkout |
|---|---|---|---|
| `pantheon.runtimes` | declared | `pantheon/src/capability/runtimes.json` and the text of every file it quotes (each quote checked verbatim) | 60: 3 runtimes, 3 transports, 4 environments (sandbox profiles), 3 pools (credential scopes), 8 tools, 6 features, 5 limitations; 8 `supports`, 16 `runs-in`, 4 `limited-by` |
| `pantheon.models` | declared | `packages/model-client/models.json`, `registry.mjs` `CAPABILITIES`, `pantheon/src/config/capability-facts.json` (cited), `classes.json` (routing labels), `router.mjs` `SEAT_FACTS` continuity | 65: 4 providers, 4 labs, 19 models; 19 `served-by`, 19 `made-by` |
| `pantheon.lanes` | declared | `pantheon/src/config/lanes.json` | 30: 15 lanes (13 live, 2 retired); 15 `served-by` |
| `pantheon.identity` | declared | `pantheon/src/config/model-identity.json` | 18: 2 models only the identity policy declares; 2 `made-by`, 14 `alias-of` |
| `pantheon.roles` | declared | `pantheon/src/role/roles.mjs`, `pantheon/src/team/roster.mjs`, the roles the tables name | 24: 12 roles, 5 chairs; 7 `holds` |
| `pantheon.executable` | structural | `runtimes.json` `serving` and `profiles`, applied to the registry and the lanes | 316: 35 executable capabilities; 243 `combines`, 38 `limited-by` |
| `pantheon.seating` | declared | `pantheon/src/role/seating.mjs` `SEATING`, `INTAKE`, `DEPTH_LIMIT`; `pantheon/src/route/frontier.mjs` `ARGO_SEATS` (read only) | 103: 34 placements, the subagent depth limit; 68 `places` |
| `pantheon.fit-matrix` | declared | `pantheon/src/route/fit-matrix.mjs` (read only) | 66: 22 placements; 44 `places` |

682 facts in all; `node pantheon/src/capability/cli.mjs snapshot` prints them, with the snapshot digest. `seating.mjs` and `fit-matrix.mjs` are imported and read; neither is modified. `frontier.mjs` gained one export, `ARGO_SEATS` (its ARGO table, frozen), so the graph projects it without importing the selector.

**Evidence types** (`graph.mjs` `EVIDENCE_TYPES`), never merged: `documented` (a registry or vendor document states it, cited), `code` (a property the code provides, with the file and quote), `owner-direction` (a placement: a direction, never a measurement), `measured` (a metric from execution records, section 7). Every placement carries `evidence_type: owner-direction`, is `authoritative` from a declared basis, and is joined to its role and occupant by `places`, which the contract admits only from a declared basis: a placement can never be recorded as a measurement or a qualification.

## 3. The executable-capability model

A **model** (`capability/model`) and its **runtime** (`capability/runtime`) are separate entities; a **lane** (`capability/lane`, e.g. `gemini-4-carbon-high`) is a name of a model at a fixed thinking level on one transport, `alias-of` its model. The **executable capability** (`capability/capability/<profile>/<vendor>/<model>`) `combines` exactly one model or lane, one runtime, one transport, one sandbox profile (environment), one credential scope (pool) and its tools. Its attributes are the constraints under which the combination works: the roles its runtime serves, whether effort is carried, its delegation limits, its availability (a retired lane), its use (a metered Gemini API id whose base model has a lane is a quota failover only), its limitations and its bubble.

The serving profiles (`runtimes.json` `serving`) follow the live selector's own rule (`frontier.mjs` `seatTransport`, `run-item.mjs` `agyTurn`); `capability-graph.test.mjs` derives the expected set from `seatTransport` and compares:

| Profile | Runtime | Transport | Sandbox profile | Credential scope | Serves | On this checkout |
|---|---|---|---|---|---|---|
| `api` | `model-client` (any role; effort carried; no native delegation) | `api` | `provider-hosted` | `vendor-api` | every frontier model, and every registry model whose vendor is not `agy_google` | 18 (3 of them quota-failover only) |
| `agy-cli` | `antigravity-cli` (reviewer, scout, fact-checker, planner, implementer; thinking level fixed by the lane; native subagents denied, Pantheon subagents through `ask_subagent`) | `agy-cli` | `bwrap-jail` (+ `verify-jail` for its one command) | `antigravity-oauth` | every lane, and the non-frontier `agy_google` registry models | 16 (2 retired) |
| `agy-sdk` | `antigravity-sdk` (reviewer, scout, fact-checker; one fact-checker subagent at depth 1 for the reviewer; 40 model calls) | `agy-sdk` (the metering relay) | `host-process` | `gemini-relay` | the non-frontier `agy_google` registry models (`PANTHEON_AGY_TRANSPORT=sdk`) | 1 |

35 executable capabilities. One model can be several capabilities: `gemini-3.6-flash` is `agy-cli/…` and `agy-sdk/…`, two runtimes; `gemini-4-carbon` is served by `model-client` as `api/…` while its lanes are served by `antigravity-cli`.

## 4. The bubble, as recorded

Owner decision 1: every seat is a single-assignment sandbox, its model, runtime and tools isolated, given only scoped credentials and capabilities, torn down after its assignment. This slice RECORDS it per executable capability, where it holds and where it does not; C2 adds the sandbox. Four components, each `{holds, why, limitation, evidence}`:

| Profile | sandbox | credentials | tools | lifetime | isolated |
|---|---|---|---|---|---|
| `api` | not applicable: no tool of the seat executes on the host (`NO_TOOLS`) | holds: the model gets no credential; the controller holds the pool's key | holds: no tool is given | **does not hold**: a seat's records persist under `$PANTHEON_HOME` across its turns; no per-assignment teardown is enforced | no |
| `agy-cli` | holds: the bwrap jail, refused rather than run unjailed (limitation L-004 recorded: the CLI keeps egress and a read-only view of the host) | holds: the worker's allowlist environment, a per-run scratch copy of the OAuth login, dropped afterwards | holds: the jail hook decides every call (reads in the worktree, writes to owned paths, one verify command, no native subagent) | holds: a fresh control dir per turn, removed on every path | yes |
| `agy-sdk` | **does not hold (L-155)**: a plain child process of the controller | holds: only the relay's scoped capability, no Gemini, Vertex or ADC credential (L-155 noted: the unsandboxed `run_command` can still read the controller's environment) | **does not hold (L-155)**: `run_command` runs any command its `_destructive` predicate does not deny, outside any sandbox | holds: one process per launch; the relay session closed and its capability revoked | no |

**L-155** is a `capability/limitation` entity with its register line (`docs/OPEN-LIMITATIONS.md`, "The python SDK seat's agent has an unsandboxed `run_command`") and two code quotes, every quote found; the SDK capability, the `host-process` environment and the `agy-sdk/run_command` tool are each `limited-by` it. **Nothing is recorded as isolated that the code does not isolate**: a component is recorded as holding only when it is declared so AND every quote of its evidence is found verbatim in the file it names; one without evidence, or whose quote is gone, is `unresolved`, and a capability is `isolated` only when all four hold or do not apply. A runtime claim whose quote is missing is an `unresolved` entity, never established, and every capability combining it is then excluded by eligibility ("its runtime … is not established"). What a quote cannot prove: that the quoted code isolates; it proves the code says what the claim cites. The quotes were chosen to be the code that does it.

## 5. The eligibility contract

`decide(snapshot, requirements)` (`eligibility.mjs`) is pure over the snapshot's index (or a graph view's, `indexOfView`), never throws for an unknown name, and returns `{schema: pantheon.capability-eligibility/v1, advisory: true, mode, role, snapshot: {digest, contract, versions}, requirements, eligible, excluded, target, review, lineage, unresolved, explanation, digest}`.

**Requirements** (`requirementsOf`; an unknown field is refused): `role`, `mode`, `context` (estimated tokens), `effort`, `features`, `delegation` (depth), `avoid` and `avoid_labs` (contributors), `bubble` (`record` by default, or `required`), `billing.gemini_primary`, `target` (preferred or pinned), `quota_failover`, `task` (the task profile, recorded), `runtime`, `agy_transport`, `review_floor`.

**Checks**, each exclusion with its check and reason: `established` (an unresolved or hypothetical capability), `component` (a component not established), `availability` (a retired lane, with its lanes.json text), `runtime`, `role` (the runtime's roles), `use` (quota failover only), `limitation` (one that blocks, or blocks the role), `feature` (not provided by the runtime's `supports`, or excluded by a limitation), `billing` (the SDK seat when `gemini_api_primary` is declared off; unknown, it is a condition), `context` (the documented window, M7: unrecorded excludes), `effort` (carried, and on the model's documented ladder), `delegation`, `independence` (review roles only), `bubble` (only when required).

**Modes**, mapped onto `selectSeat`'s precedence (`MODE_OF_SOURCE`): automatic = `policy` / `profile`; preferred = `operator-override` / `slot-override`, with its documented fallback ("an explicit seat is its chair's only occupant; its pools, in order, are the only transport failover": no other capability); pinned = `ticket-pin` / `escalation`. A pinned capability that is not eligible is reported `would_refuse: true` ("WOULD BE REFUSED (advisory: nothing is refused live)").

**Lab** (owner decision 2): `made-by` (a lane through `alias-of` its model) gives each capability's lab, recorded for lineage. It excludes only for a role that REVIEWS (`roles.mjs`: needs a different vendor, or may judge: `reviewer`, `judge`): a contributing lab's or vendor's capability is excluded, and the decision reports the distinct labs that remain against the floor (three, the change review's, unchanged). For every other role the avoided labs and vendors are recorded and never applied. Owner-directed placements are reported beside each eligible capability (`placed`), never read as evidence: a capability no table places is eligible on its evidence.

## 6. The advisory recording

`selectSeat` (`frontier.mjs`) is now `liveSelection` (the previous body, unchanged) followed by `adviseSelection` (`advisory.mjs`), which adds `selection.advisory` to every candidate: `{schema: pantheon.capability-advisory/v1, advisory: true, mode, snapshot (digest), decision (digest), capability, eligible, why}`, and on the seat (rank 0) the decision itself (`compactDecision`: every field but the per-capability detail, which `decide(snapshot, requirements)` re-derives; about 4.5 KB, 0.3 KB on a fallback). The record rides wherever the selection does (run.json turns, stage records), like the shadow selection. An advisory that fails records its error and leaves the selection as it was. `advisory: false` returns the live choice alone; `capability` passes another snapshot (tests, demonstration 4).

**The proof** (`capability-advisory.test.mjs`): 1,089 cases (11 roles × 3 profiles × 3 difficulties × 11 input variants: context estimates, avoided vendors and labs, ticket pins, operator and per-slot overrides, a recorded escalation, a pin the override also names) give byte-identical choices with the graph, without it, and under a changed graph (a lane retired, L-004 made blocking) that judges 1,584 live candidates ineligible and moves none. The seat is still the first candidate, and the policy hash is the live policy's.

**Not hashed into `selectionPolicy`.** The inventory proposed hashing the capability snapshot into the policy hash. Under decision 3 the graph chooses nothing, so the policy hash (what chose the seat) must not change; hashing it would also stop every recorded practice disposition from applying (its policy hash would no longer match). The snapshot is recorded beside the selection instead.

**A ledger input** (`pantheon/src/ledger/kinds.mjs`, an addition; the existing kinds are unchanged): kind `capability`, authored by the inputs' authors (operators), payload `{schema, graph, contract, sources: [{id, extractor, version, digest, count}], digest}` (`currentCapability()`, the snapshot the live selections name). Re-derived: the digest is the digest of its sources; a source at the version this checkout holds must re-derive to the recorded facts digest; a source at another version is noted, never assumed. The recorder is not wired to append it at run start (section 11).

## 7. The metrics

Owner decision 3: the metrics are recorded so they can be understood before any switch. `extractMetrics(records, {snapshot})` maps each record to its executable capability and states, per capability, with `sources` and the `coverage` of what was read:

| Metric | Definition | Records |
|---|---|---|
| `attempts` | every row of a run's `attempts` (each provider call, failed ones included) whose seat is this capability; a review transcript as one assignment of its requested model on `api` | run.json, review transcripts |
| `provider_requests` | the sum of each attempt's `provider_requests`, an unknown count taken as ONE (`run-item.mjs` `providerCallsOf`); a transcript's `provider_calls`; a work-ledger stage's `usage.provider_calls` only when its team is exactly one seat | run.json, transcripts, work-ledger stages |
| `outcomes` | per role (the purpose: plan planner, work implementer, critique reviewer, scout scout) and task profile (the selection's stakes and depth, or its difficulty, else `unrecorded`): **answered** an attempt with outcome ok; **accepted** a work turn of the final revision of a run that shipped through its REVIEW gate (the practice metrics' `accepted`); **revised** an implementer seat an escalation record names after a rejection (a critique that did not approve, an acceptance command that failed); **refused** an attempt refused before an answer (`refused_preflight`, `refused_metered`, `refused_seat`, `quota`); **failed** an attempt that ended `error`, `transient` or `incomplete`; **identity-mismatch** an attempt that failed closed on `AGY_MODEL_MISMATCH`; a one-seat work-ledger stage adds its status under `stages`, a transcript its status | run.json, work-ledger stages, transcripts |
| `tokens` | input and output summed over the attempts that reported both; null (never 0) when none did, with `missing` | run.json, transcripts |
| `cost_usd` | the sum of a stated `usd` / `cost_usd`; null unless every attempt states one; no price is estimated | run.json |
| `latency_ms` | over answered attempts that recorded `ms`: n, median, p90 (nearest rank), max | run.json |
| `billing_refusals` | billed-Gemini requests refused at their point of spend, by code | run.json (`refused_metered`), relay outcomes, transcripts' `gemini_billing` |
| `gemini_requests` | rows of the Gemini usage record (each one billed request), by kind | Gemini usage rows |

A run's attempt that records transport `agy` (CLI or SDK not said) is listed as not mapped, never guessed. The work ledger is read structurally (payload digests checked, signatures not verified here: `pantheon/` may not import `ophanim/`). Practice records are the pairs' runs, read with `practice/evaluate.mjs` `loadRuns`.

**Observed assertions** (`observedAssertions`): one `evidence/observation` per capability, classified `observed` by the registered tool `pantheon.capability.metrics` (basis measured), its run the digest of the records read, joined by `measures` to the capability (admitted only as observed or derived, measured). **No `qualified-for`**: it is admitted only from measurements under a criterion THE OWNER defines; `QUALIFICATION_CRITERION` is null, and `qualificationsOf` emits nothing and says so, even when a caller passes a criterion of its own.

**The report**: `node pantheon/src/capability/cli.mjs metrics` reads every `run.json` under `$PANTHEON_HOME/boards` when no source is named (the owner's real records), or the records named (`--boards`, `--runs`, `--practice`, `--work-stages`, `--work-ledger`, `--transcripts`, `--gemini-usage`, `--relay-outcomes`), and prints the metrics per capability with sources and coverage (live and synthetic runs counted apart, by each run's `providers.kind`). This container's records are not used: the demonstration runs on `pantheon/tests/fixtures/capability-records.json`, every record marked SYNTHETIC, which the tests lay out in a temporary directory exactly as the real records are laid out (`boards/<name>/run.json`, a practice pair with its digest, JSON-lines usage and outcome records, transcripts), so the real readers read them; `--synthetic` labels such a report. One file, because `pantheon/.gitignore` keeps real receipts (`*.jsonl`, `transcripts/`) out of the repository.

## 8. Demonstrations 4 and 12

**Demonstration 4** (`capability-eligibility.test.mjs`, "demonstration 4"): a task's requirements (the implementer pinned to `gemini-4-hydrogen-high`) select eligible capabilities from versioned evidence (the decision names the snapshot digest and each source's version). Three DATA changes, no code edit, each give a new decision that says why: the lane retired (`availability: retired: …`), a lane removed (`not an executable capability of the capability graph`), and a limitation changed (L-004 made to block the reviewer: `limitation: L-004 blocks the reviewer role`); the versions name the sources that changed. Through a real graph ledger (synthetic keys): the lane source's observation is one change event naming exactly that lane, the executable source's names the capability, the affected neighbourhood holds the capability and not an unrelated one, and the decision over the new view would refuse the pin. Live selection is unchanged: the fit matrix still seats the lane, byte-identical, and its advisory record says it is no longer eligible and records the new decision and snapshot.

**Demonstration 12** (`capability-graph.test.mjs`, "negative cases"): a model's claim (a hypothetical `supports`) is recorded, never established, and changes no decision; a model may not admit it as observed; an unknown model, runtime or role is unresolved and a pin of it would be refused; an edge to an entity the graph does not hold is refused (`GRAPH_REFERENCE`); an isolation claim without found code evidence stays unresolved.

## 9. The schema additions (contract 1.1.0)

Added to `packages/graph/schema.mjs` and the registry tables of `architecture.md` (kept equal by `packages/graph/tests/schema.test.mjs`); no existing type changed.

| Added | Kind | Meaning (direction) | Impact | Admitted as |
|---|---|---|---|---|
| `lane` | entity | a named serving variant of a model on one transport at a fixed setting | — | — |
| `chair` | entity | a roster chair | — | — |
| `placement` | entity | an owner- or operator-directed placement, never a measurement | — | — |
| `made-by` | relationship | model → lab: lineage and the reviewer-exclusion input | not followed | authoritative, derived: declared |
| `served-by` | relationship | model, lane, capability → provider, transport, pool | to → from | authoritative, derived: declared, structural; observed: measured |
| `alias-of` | relationship | lane, model → model: not another model | to → from | authoritative, derived: declared, structural |
| `limited-by` | relationship | a capability-domain entity → limitation | to → from | authoritative: declared, structural; observed: measured; derived: + measured |
| `combines` | relationship | executable capability → model, lane, runtime, transport, tool, environment, pool | to → from | authoritative, derived: declared, structural |
| `holds` | relationship | chair → role | not followed | authoritative, derived: declared |
| `places` | relationship | placement → role, model, lane, capability | to → from | authoritative, derived: declared (never measured) |
| `measures` | relationship | observation → capability, model, lane, runtime, transport, role: a metric, never a qualification | not followed | observed, derived: measured |

## 10. Verification

`pantheon/tests/capability-graph.test.mjs`, `capability-eligibility.test.mjs`, `capability-advisory.test.mjs`, `capability-metrics.test.mjs` (the real registries; synthetic fixtures for the records; synthetic keys). The mutation runner `pantheon/tests/capability.mutate.mjs` (`--only`, `--check`) holds 17 mutations, each run on a disposable copy against only its deciding tests; it exits non-zero on a target that does not apply exactly once, a red baseline, or a survivor.

## 11. What C2 and the owner must supply

**C2** (owner decision 1, planned):
- the per-seat sandbox for the SDK seat's tool execution, closing L-155; then the `agy-sdk` profile's `sandbox` and `tools` components are re-declared with the code evidence of that sandbox;
- per-assignment teardown for the API seats (or a recorded decision on what the bubble requires of a provider-hosted seat whose continuity persists);
- the review runner's toolbox (`pantheon/src/review-runner/`), whose API reviewers do get tools, is not modeled here: the `api` profile describes the board's seats;
- recording the agy transport (CLI or SDK) on each run attempt, so its metrics map without ambiguity;
- wiring the run recorder (`pantheon/src/ledger/system.mjs`, `run-item.mjs`) to append the `capability` input once per run, as it does `facts` and `seating`.

**The owner**:
- the **qualification criterion**: which measurements, under what rule, admit `qualified-for` (none is defined; none is emitted);
- the **switch from advisory to live**: when, for which roles, and what replaces the seating tables and fit matrix (decision 3 keeps them);
- **key custody** for the two extractors and the metrics tool (`architecture.md` section 16);
- whether the scout's and explorer's distinct-lab breadth is "review by lab" (the live selector applies `avoidLabs` there; the advisory records it as lineage for a role that does not review).

## 12. Caveats

- A quote check proves the code says what a claim cites, not that the cited code isolates; the quotes are the isolating code.
- The advisory reads `PANTHEON_AGY_TRANSPORT` to tell the CLI from the SDK seat for an `agy` seat, and records it in the requirements.
- The metrics' `accepted` is attributed to the final revision's work turns; a multi-slot run whose slots have different seats is attributed by turn order.
- The default snapshot is built once per process; a registry edited while a process runs is seen by the next process.
- This container holds no live execution records; every metric shown here is synthetic.

## 13. The Antigravity SDK bridge (register KG-23, added after the merge of PR #67)

Since the base's `f58dfc0` the `fit` implementer is an Antigravity SDK session: the bridge (`pantheon/scripts/antigravity-bridge.py`, driven by `pantheon/src/antigravity/turn.mjs`). Its seat reads `{transport: "api", direct_api: true, session_transport: "antigravity-sdk"}`. Before this section the graph had no profile for it, and the advisory recorded such a seat as the shared API client's capability, or as none (gemini-4-neon).

| Component | Recorded as | From |
|---|---|---|
| runtime | `antigravity-sdk-bridge`: the SDK's Agent, every tool call decided by the controller, subagents admitted by the governor (Hydrogen-pinned; Carbon 8, Neon 4, Hydrogen 0); effort carried as the thinking level | turn.mjs, subagents.mjs, config/antigravity-sdk.json |
| transport | `antigravity-sdk`: primary metered Gemini, each request admitted and charged by the controller's model gateway | pipeline/turns.mjs, turn.mjs |
| environment | `bridge-jail`: the worker's bwrap profile, the HOME's credential directories covered; refused rather than started unjailed unless a caller passes `sandbox.allowUnsandboxed` (no launcher here does) | turn.mjs |
| credential scope | `bridge-gateway`: the gateway session's URL and token in the start message; the environment a short allowlist | turn.mjs |
| tools | `antigravity-sdk/read`, `/write`, `/run_command`, `/invoke_subagent` | turn.mjs |
| limitations | `L-704` (network shared, as L-004 for the CLI lanes), `L-715` (three unhooked runtime tools), `bridge-state-persists` (KG-24) | sandbox.mjs, config, turn.mjs, pipeline/index.mjs |

The serving rule `sdk-config-models` serves the SDK config's five models; `capabilityOfSeat` maps a seat whose `session_transport` is `antigravity-sdk` to them. **The bubble:** sandbox, credentials and tools hold; **lifetime does not**: the gateway session is closed and the process group killed on every path, but the session's HOME and the SDK's state stay in the unit's control dir after the run (KG-24). So the bridge's capabilities are established and **not isolated**, and a decision that requires the bubble excludes them, naming the lifetime.

Tests: `pantheon/tests/capability-sdk-bridge.test.mjs` (3 cells, failing on the code before). Mutations: `capability.mutate.mjs` C20 (session_transport ignored), C21 (no model served), C22 (lifetime claimed to hold), all killed.
