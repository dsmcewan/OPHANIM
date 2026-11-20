# Knowledge graphs, Phase 0: the current-state inventory

The directive (`docs/knowledge-graph/directive-2026-11-20.md`, section 10) asks for this first. It lists the graph-like structures that exist in OPHANIM today, who owns each one, what is duplicated, what is missing, what can be queried, what change is observed, and where each lifecycle seat could take graph-derived context. It ends with a measured technology assessment and a proposed slice decomposition. Nothing is implemented here.

The machine-readable companion is `docs/knowledge-graph/inventory.json`.

Every pointer below was checked against the code at the pinned commit. A `file:line` is the first line of the named function or table. "Implicit" means the relation exists as data or code, but nothing indexes it as a relation.

## (a) Pin

| What | Value |
|---|---|
| Repository commit | `46ef822c984a6be3ac80f5680246c61c8945d3f0` (branch `ophanim/knowledge-graphs`; the directive commit, on `9547e12`) |
| TELOS checkout | `0c9b539ddbb08e1464603faf786e0d5cdfc33fb8`, read from `$OPHANIM_TELOS_ROOT/.git/HEAD` (detached). This session's worktree guard refused `git -C $OPHANIM_TELOS_ROOT rev-parse HEAD`, so the file was read directly. The commit equals `TELOS_COMMIT` (`ophanim/governance.mjs:8`). All 13 `TELOS_PINS` digests (`ophanim/governance.mjs:14`) match the checkout's files byte for byte. |
| Status ledger | `node packages/ledger/status.mjs verify`: ok, 58 items, 85 entries, head `sha256:f8526a6753aaad321653ae2d232c36125b47081fd8177ad0735a8fb59ca0c009`. This matches `docs/STATUS.md`. |
| Date | 2026-11-20 |
| Runtime | Node v24.22.1, the same version as CI (`.github/workflows/*.yml` `node-version: '24.22.1'`). SQLite 3.53.4 is built in. |
| Not read | 132 tracked files under `docs/reviews/2026-11-18-independent-review/findings-*` (withheld review findings). They are counted and their references are noted. Their contents were not opened. |
| Not present here | The work ledger (`status/work`, gitignored), every run ledger, review-cycle ledger, evidence store and efficiency ledger from the owner's machine, and every live-provider transcript. No provider was called. |

## (b) Existing structures, per graph

Column key:
- **Records**: the entities and relations, with their direction.
- **Store**: format, path, append-only or mutable, signed or not.
- **Writer → readers**: the authoritative writer first, then the main readers.
- **Identity**: how a record is named and versioned.
- **Queries**: the functions that exist today.
- **Events**: what is emitted on change, or could be.

### Graph A: models, runtimes and capabilities

| # | Structure | Records | Store | Writer → readers | Identity | Queries | Events |
|---|---|---|---|---|---|---|---|
| A1 | Model registry | vendor → short name → API model id (4 vendors, 19 models) | `pantheon/src/config/models.json`, JSON in git, mutable, unsigned | human commit → `modelId` everywhere (adapter, seating, router, identity, fit matrix) | literal provider id string | `modelId` `pantheon/src/config/models.mjs:30`, `resolveSeatModel` :45, `labOf` :60, `vendorsOfLab` :65 | none (a git commit) |
| A2 | Frontier capability table | model → vendor, surface, window, output, efforts, providerDefaults (13 models) | `packages/model-client/registry.mjs:8` (code) plus `models.json` (the same file the Pantheon path symlinks to) | human commit → `frontier.mjs`, `tiers.mjs`, `facts.mjs`, `run-item.mjs` | model id | `isFrontier` registry.mjs:32 | none |
| A3 | Antigravity lanes | lane model → vendor, transport `agy-cli`, lab, base model, thinking level, cited window, `retired` (15 lanes, 13 live) | `pantheon/src/config/lanes.json`, git, unsigned | owner direction via commit → fit matrix, identity policy, `labOf` | lane name (the `agy models` string) | `laneParts` `pantheon/src/route/fit-matrix.mjs:97`, `laneLevels` :102, `laneFor` :110, `quotaFailoverFor` :119 | none |
| A4 | Cited capability facts | model → window, output, efforts, status, api_id, each `{value, source, quote}` (22 records) | `pantheon/src/config/capability-facts.json`, git. A snapshot is a run-ledger `facts` entry (`pantheon/src/ledger/kinds.mjs:46`), signed. | human commit; the operator key records the snapshot → `capabilityDrift`, tiers, router | model id; the ledger entry hash | `capabilityDrift` `pantheon/src/config/facts.mjs:18`, `outputBudgetFor` `pantheon/src/config/tiers.mjs:27` | none; drift is computed when called |
| A5 | Routing classes | model → class (fast, standard, frontier), basis VENDOR or TASTE, status provisional | `pantheon/src/config/classes.json` | owner and operator → `fitCandidates` | model id | `fitCandidates` `pantheon/src/route/frontier.mjs:348`, `fitLevel` :339 | none |
| A6 | Model identity policy | alias → base model (`same_model`), model → lab, route vendors, route labs | `pantheon/src/config/model-identity.json` plus models.json and lanes.json, built into one policy. A v3 cycle records the policy and its digest. | human commit → review seating, cycle ledger, validator | policy digest (`policyDigest` `pantheon/src/review/identity.mjs:80`) | `build` :56, `resolveModel` :91, `contributorKeys` :143, `candidateRefusal` :168, `reviewerIdentity` :182, `reassess` :247 | `reassess` reports what a later policy changes. It runs only through `ophanim/operate/cli.mjs:463`. |
| A7 | Router seat facts | vendor → continuity, windows, efforts, pools; model families; needs it refuses to rank | `SEAT_FACTS` `pantheon/src/route/router.mjs:31`, `MODEL_FAMILY` :200, `KNOWN_NEEDS` :186 (code) | code → seating, facts drift | vendor key | `route` :249, `modelFor` :329, `routeReview` :341 | none |
| A8 | Seating tables | role → ordered seats with band, basis (TASTE, OPERATOR, UNMEASURED) and why (6 roles, 21 rows); intake scouts; subagent depth limit | `SEATING` `pantheon/src/role/seating.mjs:156`, `INTAKE` :338, `DEPTH_LIMIT` :485 (code). A snapshot is a run-ledger `seating` entry (`kinds.mjs:56`). | operator via commit → `selectSeat` (argo, legacy), review seat pools | role plus vendor/model | `selectFor` :622, `escalate` :646, `seatingPlan` :671, `assertReviewCutsAcross` :794, `reviewPlan` :820 | none |
| A9 | Fit matrix | role × difficulty → seat (12 cells); implementer lane ladders (7 rungs); reviewer pinned to the dispatcher | `FIT_MATRIX` `pantheon/src/route/fit-matrix.mjs:42`, `IMPLEMENTER_LADDERS` :49, `REVIEWER_ESCALATION` :55 (code, owner direction 2026-11-17) | owner → `stages.mjs` fit implement stage, `fitCandidates` | `FIT_MATRIX_BODY` :141, hashed into `selectionPolicy` | `fitMatrix` :82, `fitLadder` :90, `pinnedReviewer` :68, `implementerEscalation` :130 | none |
| A10 | Task profile | ticket dimensions (depth, output, stakes, ambiguity, latency, kind) → class floors, review labs, explorer width | `pantheon/src/route/task-profile.mjs:21` (code) | code | `TASK_PROFILE` schema | `taskProfile` :75, `classFloor` :102, `requirementsOf` :114, `stakesFromPaths` :55 | none |
| A11 | Seat selection | role and task → ordered candidates with a selection record (`policy_hash`, source, reason, exclusions, claims). The precedence is escalation, slot-override, ticket-pin, operator-override, policy. This is the directive's pinned, preferred and automatic modes in existing form. | in-memory. The record rides on run.json and stage records. | `selectSeat` → planner seat, board team | `selectionPolicy` `pantheon/src/route/frontier.mjs:192` (sha256 of the tables) | `selectSeat` :215, `PRECEDENCE` :184, `claimsOf` :169, `roleLabs` :328, `registryModels` :306 | none |
| A12 | Escalation decisions | decision → the cited facts and seating entries, and → the previous decision for the same work | run-ledger `escalation` entries (`kinds.mjs:69`), append-only, controller-signed | controller → ledger verify | entry hash | `verifyEscalation` `pantheon/src/route/protocol.mjs:185` re-derives from the cited inputs | an entry is appended |
| A13 | Transports and lanes at run time | seat → transport (SDK, agy CLI, relay); quota refusal → failover; served model vs requested | `pantheon/src/sdk/**`, `pantheon/src/board/agy-cli.mjs` (`runAgyCliTurn` :92, model guard `agyModelMismatch` :48), `TRANSPORTS` `seating.mjs:408`, `AGY_SEAT` :433 | code | seat key | `seatTransport` `frontier.mjs:56`, `readPools` :29, `agyQuotaRefusal` `agy-cli.mjs:19` | per call only |
| A14 | Availability and billing | pool → cooldown; Gemini kind → budget and usage | cooldown store (`packages/model-client/cooldown.mjs:8`). Gemini policy in `pantheon/src/route/gemini-billing.mjs`; usage in `work.billing` entries or a JSONL usage file (E8). | runtime → quota failover, admission | pool id; policy digest | `geminiUsageFile` gemini-billing.mjs:176, `resolveGeminiBilling` :70 | a refusal is recorded per request |
| A15 | Seat store | seat (vendor, purpose, cwd) → token with provenance rank, chain head and length, exchange digests | `$PANTHEON_HOME/seats/<seatKey>.json`, mutable, single writer | `saveSeat` `pantheon/src/seat/store.mjs:74` under `withSeatLock` `pantheon/src/seat/lock.mjs:262` → turn runners | `seatKey` `pantheon/src/seat/identity.mjs:8` (sha256 of vendor, purpose, resolved cwd, first 16 hex); `VENDOR_ALIASES` :24; `RANK` :39 | `loadSeat` store.mjs:26 | none |
| A16 | Chairs | chair (name@pod + cwd) → occupant history and a continuity brief (≤ 4 KiB) | `pantheon/src/team/roster.mjs:56` (5 chairs), `continuity.mjs`, under `$PANTHEON_HOME` | controller | `chairKey` roster.mjs:100 | `nextOccupant` :162, `restoreBrief` continuity.mjs:168 | none |
| A17 | Practice and qualification | run → metrics per profile arm (argo vs fit) and stakes stratum; pair records; dispositions `propose_policy`, `retain`, `insufficient_evidence` | `pantheon.evaluation/v1` records (digest), evidence store (C5); run-ledger `practice.disposition` (`pantheon/src/ledger/practice-kinds.mjs:52`) | `evaluate` `pantheon/src/practice/evaluate.mjs:436`, `automaticAssessment` :520 → cycle close | record digest | `runMetrics` `metrics.mjs:83`, `compareArms` `compare.mjs:145`, `capacityReport` `review-capacity.mjs:111` | appended at a cycle close. **No disposition and no measured qualification of any model is recorded on any ledger in this checkout.** |
| A18 | Lab independence | contributing models → excluded reviewer models; panel of three distinct labs | identity policy (A6) plus cycle ledger fields `author_models`, `excluded_labs`, `contributors` (C3) | `reviewSeatsByModel` `pantheon/src/ledger/review-cycle.mjs:79`; the cycle ledger re-derives every exclusion | policy digest | as A6 | appended at cycle open and close |

### Graph B: systems, components and dependencies

| # | Structure | Records | Store | Writer → readers | Identity | Queries | Events |
|---|---|---|---|---|---|---|---|
| B1 | Repository tree | 998 tracked files: 240 modules, 288 test files, 9 mutation runners, 100 Markdown docs | git | commits → the dossier, gates | path at a commit; blob sha | `git ls-files` and `git grep` from the dossier (`ophanim/operate/context.mjs:375`) | commits; nothing indexes them |
| B2 | Import graph | module → module (784 relative imports), test → module (1,128) | implicit in ES imports. **Not materialized anywhere.** | none | path | the only extractor is a regex in `ophanim/ledger/layering.test.mjs:34`, used for one layering assertion (:39) | none |
| B3 | Board DAG | ticket, repro, search, trace, hypothesis, plan, work_item, artifact, critique, decision. Links point from an entry to the entries it cites: `derived_from` and `supersedes` (`schema.mjs:87`), `supports` and `contradicts` (hypothesis, :108), `offer` (:123), `target` (critique → the reviewed bytes, :131), `considered` (decision, :136). `work_item.depends_on` (:169); commit → parents, tree, records. | CAS `<board>/objects/<codec>/<hh>/…`, immutable and content-addressed. A link must already exist at put time (`pantheon/src/board/cas.mjs:42`), so the DAG is acyclic and a fabricated citation cannot be written. Refs are mutable, with compare-and-swap and ledger `ref.move` entries. | `publish` `pantheon/src/board/dag.mjs:125` (seats on their own refs; `ship()` for the shipping ref) → controller, projections | cid `<codec>:<sha256>` (`canon.mjs:38`) | `checkout` dag.mjs:50, `changedSlots` :63, `history` :70 (breadth-first, at most 500 commits), `slotHistory` :86, `entriesOfKind` :99, `linksOf` cas.mjs:19 (forward only), dependency trigger `controller.mjs:206` | commits on refs; reflog |
| B4 | Tickets | item → slot/path, copy[], acceptance_cmd, constraints, forbidden, proposes | `tickets/*.json` (`ophanim.ticket/v1`, 1 file); legacy `pantheon/scripts/tickets/*.json` (12 files, no schema) | owner or planner by commit → board dispatcher, dossier, gates | path plus file digest | `readTicket` `pantheon/src/board/operate.mjs:84`, `dispatchable` :244 | the ticket set is part of `inputSignature` (E13) |
| B5 | Contracts and acceptance | ticket acceptance; plan acceptance `[{id, criterion, test}]`; work-unit `verify_cmd` and `invariants`; dispatcher rubric; eight ship gates; cycle contract versions v1 to v3; TELOS obligations | `pantheon/src/board/schema.mjs` (ticket validator), `ophanim/operate/stages.mjs:68` (plan schema), `pantheon/src/pipeline/work-units.mjs:35`, `dispatch.mjs:49` (rubric) and :139 (`rubricHash`), `integrate.mjs`, `practice-kinds.mjs:54–61` | code; per-run values are recorded on ledgers | schema ids; rubric hash | validators (`planRefusal` stages.mjs:190, `dispatchRefusal` dispatch.mjs:118) | none |
| B6 | Test gates | suite → test files (from package.json and the workflows); file → verdict (PASS, FAIL, UNVERIFIED); lint rules; designated sandbox suites | `scripts/test-gates/*.mjs`, `real-bwrap-suites.json` | code → CI | suite id | `suites` `scripts/test-gates/suites.mjs:56`, `workflowRuns` :88, `coverage` :207, `evaluateRuns` `check.mjs:163`, `filesNaming` :60 | CI step summaries only |
| B7 | Mutation runners | mutation → target file (`edits[].file`) → the test files that must kill it (`tests[]`); runner → register ids | 9 runners, about 239 mutations, each exporting `MUTATIONS` (for example `ophanim/operate/wave3-evidence.mutate.mjs:33`). Logs go to `--log DIR` and are not committed. | coordinator and agents → humans | mutation id within a runner | none. The runners run at import (no main guard), so they cannot be imported as data. | none |
| B8 | CI | push and PR → qualification (npm test, test:proof, test:gates:self, the gate, lint); main, issues and hourly → reconcile and publish | `.github/workflows/qualification.yml`, `operate.yml`, `public-record.yml` | git → GitHub | workflow file | `workflowSteps` `suites.mjs:103`, `qualificationBounds` :124 | GitHub run events |
| B9 | Efficiency component catalog | component → depends-on components, contract, invariants, sources `{path, symbol}`; consumers computed (`ophanim/efficiency/contributions.mjs:331`). Covers 15 components of the synthetic proof controller only. | code constants (`COMPONENTS` :33, `INVARIANTS` :176, `INTERACTIONS` :192), hashed as `registrySha` | code → investigation models (`ophanim/efficiency/investigation/models.mjs`) | `registrySha` | `buildContributionRegistry` :325, `discoverVariables` :361; sources checked to exist (`contributions.test.mjs:31`) | none |
| B10 | TELOS Merkle plan DAG | task → dependencies. The effective hash binds a node's spec hash and its parents' effective hashes, so a change propagates to every dependent by hash. | TELOS `merkle-dag/merkle.mjs` (`effectiveHash`, `topoSort`), `obligation.mjs`; read only, pinned by digest | TELOS → the synthetic proof (`ophanim/governance.mjs:127` `compileAndHashPlan`) | spec and effective hashes | `topoSort`, `undischargedObligations` | none (fail-closed digest check at load) |
| B11 | Synthetic obligation graph | obligation → dependsOn | `ophanim/runtime.mjs` (`validateGraph` :79, `handoffFrontier` :41) | synthetic proof only | obligation id | as named | none |
| B12 | Ownership manifests | wave → subwave → agent → file globs; coordinator-only globs; authorization text; frozen candidate | `docs/execution/*-ownership.json` (7 files, `ophanim.wave-ownership/v1`) | coordinator → `docs/execution/check-ownership.mjs` | file path | glob overlap and diff ownership (`check-ownership.mjs:11–37`) | none |
| B13 | Build-correction graph (orphaned) | node, edge, phase, launch, metrics records, with referential checks | `pantheon/scripts/graph-check.mjs`. Its input, `pantheon/docs/runs/graph/*.jsonl`, was excluded when OPHANIM was extracted (`PROVENANCE.json` `excludedPaths`). Here it has no data and would exit 1. | — | record id | edge endpoints, commits and paths must resolve | — |

### Graph C: evidence, decisions and provenance

| # | Structure | Records | Store | Writer → readers | Identity | Queries | Events |
|---|---|---|---|---|---|---|---|
| C1 | Status ledger | item → status entries. Each entry → the item's previous entry (`derived_from`). Item → `depends_on` items. Entry → `evidence` (run, cycle, commit, tests, ticket). | `status/ledger/{ANCHOR, chain.jsonl, objects/}`. Append-only and hash-chained; ed25519 operator signature plus orderer co-signature. One closed kind, `status` (`packages/ledger/status.mjs:37`), re-derived on append (the standing rule; the previous-entry citation). | the owner only (`set` :126, `apply` :408, keys on the owner's machine) → everything | entry hash `sha256:` over the canonical entry; genesis anchor pinned | `board` :134 (full replay), `latestHash` :72 (linear scan), `propose` :311, `checkEvidenceLedgers` :360 | the head changes; `inputSignature` watches it |
| C2 | Work ledger | `work.intake`, `work.claim`, `work.release`, `work.spend`, `work.stage`, `work.recovery`, `work.reassessment`, `work.billing` (`ophanim/operate/work-ledger.mjs:6–67`, kinds :123). A stage record → its claim and the previous stage (handoff). It carries the identity (item, requirement), input and output digests, team, contributions, findings, usage and cited evidence with versions. | `status/work/` (gitignored; none here). Same chain format; controller-signed. | the controller (scheduler and stage executors) → reconcile, public `work.mjs`, the retriever | entry hash; idempotency key `workKey` :107 (digest of item, stage and inputs) | `of` :401 (re-reads and filters the whole chain on every call), `stages` :470, `claims` :469, `activeClaim` :472, `spent` `scheduler.mjs:51` | the head changes; `inputSignature` watches it |
| C3 | Run ledger with Pantheon and OPHANIM kinds | `facts`, `seating`, `escalation`, `contribution` (`kinds.mjs`); `turn` and `review` (`lineage-kinds.mjs:135`, :161: requested and served model, response id, cites); `lease`, `budget`, `ref.move` (`board-kinds.mjs:22`); `gate` (`gate-kind.mjs:48`); `cycle`, `finding`, `finding.resolution`, `cycle.close`, `cycle.attempt` (`cycle-kinds.mjs:161`); `practice.disposition`; `board.anchor`; `efficiency.*` (`ophanim/ledger/efficiency-kinds.mjs:171–295`); `telos.anchor` (`ophanim/ledger/anchors.mjs:37`) | `<board>/ledger` or `$OPHANIM_LEDGER`. One chain with declared domains (`packages/ledger/chain.mjs:16`): a reader re-derives its own domains and checks foreign ones structurally. | controller, operator, and per-seat keys → `status.mjs apply`, `ophanim/public/provenance.mjs` | entry hash; per-seat key ids | `verify` chain.mjs:231, `read` :137, `payloadOf`; `listCycles` `provenance.mjs:60` | appends |
| C4 | Evidence dossier and retrieval | item → requirement, status history, work records, dependencies and dependents (1 hop, `context.mjs:445`), ticket, issues, named files, **textual** consumers (`git grep -l` of a basename, :486, labelled "not proven dependencies" :509), word-match guesses (labelled hypothesis, :496), commit log, retained runs, repository index | built per stage, not stored. The delivery log (`deliveryOf` :566) and the dossier record ride on the stage record. | `buildDossier` :375 → every judging seat | entry ids S#; `version` is the digest of the bytes shown; `digest` and `stable` (:532) | `makeRetriever` :172 with ops `OPS` :63 (file, list, grep, log, show, status, work, record, issue, output, dossier); `investigate` :621; `versionOf` :347 | none; staleness is checked when gates re-read |
| C5 | Run records and evidence store | run → shipped artifacts, contributors, provider calls; pair → primary and counterpart; proposal → evidence | `run.json` (`pantheon.board-run/v1`, `operate.mjs:48`), `proposal.json` (`ophanim.status-proposal/v1`), evidence store directory (`defaultEvidenceStore` `pantheon/src/practice/evaluate.mjs:215`) | board runs → evaluation, status apply | file digest; `proposalDigest` `status.mjs:280` | directory walk at most 6 levels deep (`evaluate.mjs` `runFiles`), `loadRuns` :258 | none |
| C6 | Review records | cycle → findings → resolutions → close (C3); review runner output per assignment | the cycle ledger, plus `docs/reviews/**` (22 non-findings docs; 132 `findings-*` files not read: transcript JSON, run summary, SHA256SUMS, Gemini billing JSONL per `pantheon/src/review-runner/index.mjs:5–13`) | review runner and cycle executor → coordinator, register | path plus SHA256SUMS | none over the files | none |
| C7 | Plan lineage | revision → the plan it revises; contributions carried through revisions | inside work.stage outputs | `carryForward` `stages.mjs:357`, `chainOf` :371, `dedupe` :381 | stage hash | as named | none |
| C8 | Contributions and served identity | turn → seat, requested model, served model, source marker; stage → contributions; chair → contribution projection; review scope | turn entries (C3); stage records (C2); `chairContributions` `pantheon/src/board/contributions.mjs:42`; `reviewScope` `pantheon/src/review/scope.mjs:57` | recorders → independence checks | `SERVED_SOURCES` `identity.mjs:203` | `contributorKeys` `identity.mjs:143` | appends |
| C9 | Public projections | status → GitHub issues and labels; work view; cycle reports; CI summaries; `docs/STATUS.md`; `docs/cycles/index.md` | `ophanim/public/{record, work, provenance, ci-summary, github}.mjs`; derived, with deterministic bodies | `public-record.yml` and `operate.yml` (GITHUB_TOKEN) → humans | the item marker `<!-- ophanim:item=… -->` (`record.mjs:27`) | `itemView` `work.mjs:27`, `cycleRecord` `provenance.mjs:81` | regenerated on push to main and hourly |
| C10 | TELOS (read only) | proposal event chains, obligations, authority (`CURRENT-AUTHORITY.json`); 50 JSONL files, 5,062 lines, its own domain | the TELOS checkout; 13 pinned files | TELOS → `ophanim/governance.mjs` (pins), `ophanim/ledger/anchors.mjs:31–77` (binds `telos.anchor` entries to TELOS event chains) | event hash | `readProposalEvents`, `verifyProposalChain` (TELOS) | none |
| C11 | Efficiency evidence (synthetic) | convergence → assessment, contribution registry, variables, investigation receipts | `<state>/efficiency/convergences/…` (README), the efficiency ledger | `ophanim/efficiency/**` | digests | replay and verify modules | none |

### Graph D: failures, corrections and learning

| # | Structure | Records | Store | Writer → readers | Identity | Queries | Events |
|---|---|---|---|---|---|---|---|
| D1 | Owner-corrections registry | class → instances (`observed_by` owner or mechanism, date, ref commit, note), `fixed_in` commit, detector (a named test, or `none` with why and next step), source text | `ophanim/lessons/corrections.json` (`ophanim.owner-corrections/v1`): 19 classes, 30 instances, 12 test detectors | coordinator at each integration (git log: L-136, L-146, L-148, L-150 integrations). `ophanim/lessons/**` is coordinator-only in every manifest. | class id | `load` `corrections.mjs:21`, `problems` :28, `report` :48; `corrections.test.mjs` (proof suite) | none |
| D2 | Open-limitations register | L-id → item, source, consequence, routes, status (open, planned, active, repaired, class covered, qualified, accepted, retained, pending owner), owner decision | `docs/OPEN-LIMITATIONS.md`: 97 L-rows in Markdown tables, mutable, coordinator-only | coordinator → humans. No parser exists. Code cites L-ids in comments: 663 mentions of 43 distinct ids in 151 `.mjs` files; 31 ids appear in commit subjects. | L-number | none | none |
| D3 | Mutation evidence | see B7: mutation → target path and killing tests; base-failure runs | runner tables plus uncommitted logs | coordinator and agents | mutation id | none | none |
| D4 | Self-audit records | assignment → assessment, manifest, reproductions (37 tests) | ref `audit/round3-self-audit` (sealed `449ca42`), `self-audit/round3/assignment-{1..4}/`, 45 files; not in the working tree | coordinator | sealed commit | git only; code cites "self-audit round 3, assignment N (sealed …), question K" in 58 `.mjs` files | none |
| D5 | Reviewer findings | finding → severity, file, reproduction, resolution (fixed with a commit and test, or deferred with a reason) | cycle ledger (`cycle-kinds.mjs:161`, reproduction :215); `findings-*` documents (not read) | cycle executor and coordinator | entry hash | close re-derivation | appends |
| D6 | Self-evaluation conditions | owner condition → where it is served → gap | `docs/self-evaluation.md` (8 rows, prose) | coordinator | row number | none | none |

### Graph E: work, resources and execution

| # | Structure | Records | Store | Writer → readers | Identity | Queries | Events |
|---|---|---|---|---|---|---|---|
| E1 | Work identity | status item (C1); the requirement is the latest Ready entry | status ledger | owner | item id; `requirementDigest` `ophanim/operate/gates.mjs:26` | `requirementOf` gates.mjs:21 | head change |
| E2 | Intake | source (status, issue, ticket) → item, or **candidate** (an unmarked issue or an orphan ticket: recorded, never executed) | `work.intake` (once per source) | `tick` `ophanim/operate/scheduler.mjs:200–206` from `reconcile` `reconcile.mjs:100` (issue marker :23) | `{source, ref}` | `intakes` work-ledger.mjs | the issue snapshot is in `inputSignature` |
| E3 | Re-derived tickets | plan → ticket, keeping the owner's declared dimensions | the ticket file; `ticket_given` on the record | `ticketOf` `stages.mjs:295`, `OWNER_DECLARED` :292 | ticket digest | `ticketGiven` `reconcile.mjs:89` | none |
| E4 | Plans | plan → `dependencies` (item ids), `capabilities` (**free-text strings**, checked only as non-empty, `stages.mjs:201`), acceptance, slices, copy, work_units, limits, evidence citations with versions, unresolved | inside `work.stage` outputs (`ophanim.plan/v1`, `stages.mjs:68`) | planner seat → gates, implement stage | stage hash; plan digest | `planValidity` `gates.mjs:55`, `evidenceCheck` :80 | staleness computed on each reconcile |
| E5 | Work units | unit → depends_on units, owned_paths, difficulty, specialist role, allowed subagents, verify_cmd, invariants | plan outputs; `pipeline.json`; checkpoints | planner → pipeline | `unit_id`; `rubricHash` | `upstreamOf` `pantheon/src/pipeline/dispatch.mjs:178` (transitive), `lockConflicts` :196, `waves` :214 (Kahn, refuses cycles) | none |
| E6 | Leases and locks | lifecycle claim (30-minute lease, fence); board lease generation (`pantheon/src/board/runtime.mjs:38`) with ledger `lease` entries; seat lock; worktree lock; service lock | work ledger; `<board>/runtime/leases.json` plus ledger; `<lock>` files | controller | claim hash; generation | `activeClaim`, `expiredClaims` work-ledger.mjs:472–474; `fenceRefusal` :90 | expired claims are released per tick |
| E7 | Budgets and provider calls | claim → charged calls (before each call); reservation against a total; run limits | `work.spend`; claim `reserve`; run-ledger `budget`; run.json and pipeline.json counters; live-run record | controller | claim hash | `spent` `scheduler.mjs:51`; `DEFAULT_LIMITS` scheduler.mjs:28 and `pantheon/src/pipeline/index.mjs:108`; the definition of one provider call is in `docs/routing-task-profile.md:434` | a budget stop is recorded |
| E8 | Gemini usage | billed request → kind, setting, budget, policy digest, claim | `work.billing` (`work-ledger.mjs:452`) under operate; elsewhere a JSONL usage file with its own lock (`gemini-billing.mjs:143–176`); review runner `findings-<n>-<lab>.gemini-billing.jsonl` | `spendGemini` | policy digest | `billings` work-ledger.mjs | a refusal is recorded per request |
| E9 | Worktrees | unit → worktree from the base plus upstream patches; integration branch `pantheon/pipeline/<run_id>` | git worktrees under the run directory | `bindWorktree` `dispatch.mjs:244`, `repoMutex` `pantheon/src/pipeline/git.mjs:197`, `recoverOrphanWorktrees` `pipeline/index.mjs:709` | run id plus unit id | `liveOwner` `pipeline/index.mjs:659` | none |
| E10 | Ownership manifests | see B12 | | | | | |
| E11 | Board run records | board → run.json, progress.jsonl, seats/, runtime/, ledger/ | `$PANTHEON_HOME/boards/<name>/`. Here: 337 directories dated 2026-11-16 to 2026-11-19, apparently left over from test runs on this machine (unverified). They hold 333 blobs, **0 entries, trees or commits**, and 295 run ledgers with 885 lines in all. | board runs | board directory; anchors | the evidence store walk (C5) | none |
| E12 | Service state | tick → event; status heartbeat | `<state>/service-status.json`, `<state>/service.jsonl` (`ophanim/operate/service.mjs:118–120`) | `runService` service.mjs:114 | — | none | the JSONL log is an operational log, not a change feed |
| E13 | Scheduler and gates | item → earliest unmet gate, blocker, routing basis (`route`); attempt identity | computed per tick | `earliestGate` `gates.mjs:176`, `attemptInputs` :130 (ATTEMPT_IDENTITY 2), `tick` `scheduler.mjs:165`, `dependencyOrder` :450, `watch` :461 | route digest | as named | `inputSignature` :95 |
| E14 | Evidence recovery | Resolved item without evidence → the sources searched → an unsigned proposal | `work.recovery`; `status/operate/recovery/<item>/` | `recoverEvidence` `ophanim/operate/evidence-recovery.mjs:137` | `sourcesDigest` :63 | `bundlesOf` :38 | the recovery sources are in `inputSignature` |

## (c) Authoritative sources and their owners

| Source | Authoritative writer | Authorization | Readers that must not override it |
|---|---|---|---|
| `status/ledger` | the owner, via `packages/ledger/status.mjs set` and `apply` | the operator and orderer keys, on the owner's machine only | Pantheon's `next`, reconcile, the dossier, public projections, `docs/STATUS.md` |
| work ledger (`status/work`) | `ophanim/operate/work-ledger.mjs`, driven by the scheduler and stage executors | the controller key `status/work/keys` (without it: `NO_AUTHORITY`) | public `work.mjs`, reconcile, the retriever |
| run and cycle ledgers (`<board>/ledger`) | `pantheon/src/ledger/system.mjs` recorders; `review-cycle.mjs` | the operator (authority), controller (decisions), per-seat keys (turns, reviews) | `status.mjs apply` (structural re-check), `provenance.mjs` |
| board CAS and refs | `dag.mjs` `publish`; `integrate.mjs` `ship()` for the shipping ref | ref classes as write permissions (`pantheon/src/board/refs.mjs:28`), leases, the `SHIP_ONLY` refusal | controller, projections |
| seat store and chairs | `seat/store.mjs` (single writer), `team/continuity.mjs` | the seat lock | turn runners |
| model registry, lanes, facts, classes, identity rules, seating, fit matrix | humans by commit. The fit matrix and lanes are owner direction (2026-11-17). | code review; facts carry source and quote | every router; snapshots are recorded as ledger inputs (`facts`, `seating`) |
| tickets | committed files; planner re-derivations | git; the owner declares the dimensions | board dispatcher, gates |
| lessons registry, open-limitations register, ownership manifests, `docs/execution/**`, `docs/reviews/**` | the coordinator (`coordinator_only` in every manifest, e.g. `docs/execution/l150-ownership.json`) | owner decisions quoted in the register | humans; `check-ownership.mjs` |
| CI workflows and suites | git | — | `suites.mjs` |
| TELOS pins and records | TELOS (a separate repository) | pinned commit and file digests | `governance.mjs`, `ledger/anchors.mjs` |
| GitHub issues, labels, `docs/STATUS.md`, `docs/cycles/index.md` | derived projections | GITHUB_TOKEN; manual `status.mjs render` | **never** an input to a decision (`docs/operating-workflow.md` step 1). Issue text is data for intake only. |

## (d) Duplicate stores and representations

| # | Fact | Held in | Consistency mechanism |
|---|---|---|---|
| 1 | Model ids | **Not a duplicate** (coordinator correction at integration, 2026-11-20): `pantheon/src/config/models.json` is a git symlink (mode 120000) to `packages/model-client/models.json`, so both paths name ONE file. `frontier.mjs` reads it through the model-client path; seating, adapter and identity through the Pantheon path. | No sync is needed while the symlink holds; a checkout that dereferences symlinks would make two copies (not observed). |
| 2 | Window, output and efforts per model | `capability-facts.json` (cited), `CAPABILITIES` (`packages/model-client/registry.mjs:8`), `SEAT_FACTS.windows` (`router.mjs:31`), `lanes.json` windows | `capabilityDrift` (`facts.mjs:18`); the current drift list is pinned by `pantheon/tests/capability-facts.test.mjs:33` |
| 3 | A model's lab | `labOf` (`models.mjs:60`), the identity policy's `model_lab` (`identity.mjs:56`), `lanes.json` lab fields | both are built from the same files; `build` throws on a conflicting declaration. Cycles recorded under resolver 1 keep their old rule. |
| 4 | Dependency order of status items | `dependencyOrder` in `pantheon/src/board/operate.mjs:229` and in `ophanim/operate/scheduler.mjs:450` (different visit rules; **both silently break cycles**); `waves` (`dispatch.mjs:214`, refuses cycles); TELOS `topoSort` | none between them |
| 5 | Status | `status/ledger` (authoritative); `docs/STATUS.md`; GitHub issues and labels; `docs/reviews/2026-11-17-orchestration/BACKLOG.json` (a committed reconcile snapshot) | `STATUS.md` is regenerated by a manual `render`, with **no CI drift check**. Issues are regenerated on push to main. BACKLOG.json is a point-in-time snapshot by design. |
| 6 | Leases | `<board>/runtime/leases.json`; ledger `lease` entries; work-ledger claims (a different scope) | the ledger is recorded first and a hand-edited file row is refused at its next change (`board-kinds.mjs:1–20`). Lifecycle claims and board leases are distinct by design. |
| 7 | Ref positions | `refs/` files and reflog; ledger `ref.move` | the move is recorded before the rename, and an undo reset is recorded on failure (status item `ref-write-gap`) |
| 8 | Provider-call usage | `work.spend`; run-ledger `budget` (limits); the board runtime spend log keyed by commit; run.json and pipeline.json counters; the live-run record | `spent()` derives the lifecycle total from the work ledger. The run-level counters are per run and are not reconciled with it. |
| 9 | Gemini billed requests | `work.billing`; usage files beside run records; review-runner billing JSONL | one policy module (`gemini-billing.mjs`). **The budgets are per store**: a budget declared to the service and one given to a CLI draw from different records. |
| 10 | Who contributed | stage `contributions`; cycle `contributors` and `author_models`; ledger `contribution` (chair projection); run.json `files[].contributors`; pipeline arbiters | the cycle ledger re-derives cold review over the recorded lineage; revisions carry contributions forward (`stages.mjs:371–381`) |
| 11 | Seat turn history | seat records in `$PANTHEON_HOME/seats`; ledger `turn` entries | checked against each other at handoff (status item `off-ledger-records`); seat files from before the ledger are refused (`legacy-seat-files`, On Hold) |
| 12 | Canonical JSON and digests | nine canonical-JSON functions (status item `me3-canonical`, Ready): `canonical`, `canonicalCodeUnit` and `canonicalCas` (`packages/ledger/canonical.mjs:127–131`), board canon, `ophanim/board.mjs`, identity policy and others | the core and `ophanim/board.mjs` are asserted byte-identical (`ophanim/ledger/layering.test.mjs`); the others are not unified |
| 13 | What a component is and depends on | the efficiency catalog (B9, hand-written, synthetic controller only); the code itself; the dossier's textual consumers | source paths and symbols are checked to exist (`contributions.test.mjs:31`); nothing checks the declared dependencies against the imports |

## (e) Relationship types against the directive's list

| Type | Where it exists today | State |
|---|---|---|
| implements | ticket `slot`/`path`; plan `slices` and `copy`; work-unit `owned_paths`; catalog `sources {path, symbol}` (B9); a lesson's `fixed_in`; a register "repaired (commit)" | implicit. No requirement → commit edge, except status `evidence.commit` (0 entries carry it) and the `pantheon/<item>` branch name. |
| depends-on | status `depends_on` (3 edges, all → `k6`); work-unit `depends_on`; board `work_item.depends_on`; catalog `dependencies`; TELOS task dependencies; plan `dependencies` | explicit within each store, not across stores. Code imports are not materialized (B2). |
| consumes | dossier consumers (textual mentions, labelled unproven, `context.mjs:509`); catalog consumers (`contributions.mjs:331`); stage handoff (inputs equal the previous outputs, by digest) | implicit or textual |
| produces | `work.stage` outputs (digest); artifact entries (bytes); run.json shipped; proposals | implicit |
| governs | cycle contract version plus pinned identity policy; `selectionPolicy` hash; billing policy digest on `work.billing`; ticket `constraints`/`forbidden`; `coordinator_only`; TELOS pins | implicit. No "contract governs component" edge. |
| authorizes | status signatures; ledger genesis and authority entries; manifest `authorization` (prose); live-run confirm string; billing budgets; TELOS `active_authorization` | implicit |
| verifies | ticket `acceptance_cmd`; plan acceptance tests; `verify_cmd`; mutation `tests[]`; lesson detector `{file, name}`; `cycle.close` outcome; proposal `tests {cmd, exit}`; validator `sources` | partly explicit (detectors, mutation tests); no contract ↔ test edge |
| derived-from | every ledger entry's `derived_from` (`chain.mjs` `bodyOf`); board `LINEAGE.derived_from` (`schema.mjs:87`); dossier derived views | **explicit** |
| supports | board `hypothesis.supports` (`schema.mjs:108`; swarm synthesis `run-swarm.mjs:195`); plan citations with delivery records | explicit on the board only |
| contradicts | board `hypothesis.contradicts` (`schema.mjs:108`; refutation `run-swarm.mjs:163`); `work.reassessment` (a later policy against a recorded review) | explicit on the board only |
| supersedes | board `supersedes` (auto-filled, `dag.mjs:173–178`); the status-entry chain; `lanes.json` `retired`; TELOS `supersedes`; register "Closed" | explicit on the board; implicit elsewhere |
| introduced-because-of | code comments citing L-ids (663), review findings ("independent review, assignment N …"), self-audit questions; lesson `source` text; commit subjects | **prose only** |
| invalidates | `planValidity` and `evidenceCheck` (`gates.mjs:55`, :80); `validationEvidence` (:106); `work.reassessment` | computed per tick, not recorded as an edge; the route digest records only what made the gate route |
| qualified-for | `SEATING` (basis TASTE, OPERATOR, UNMEASURED); fit matrix (owner direction, orderings unmeasured); classes (provisional); `roleLabs` (`frontier.mjs:328`); `practice.disposition` (none recorded) | **absent as evidence-backed data**. Eligibility exists; measured qualification does not. |
| contributed-to | turn entries; stage contributions; cycle contributors; chair projections; review scope | explicit per record; no cross-record index |
| shares-failure-mechanism-with | lesson class → instances (grouped by class); register "class covered" (sibling paths listed in prose); mutation path ids (E-*, K-*) | **absent as a typed relation between defects** |

The directive's own examples:
- **requires-capability**: a plan's `capabilities` is free text (E4).
- **runs-in**: `lanes.json` transport.
- **eligible-for**: seating and `roleLabs`.
- **detects**: a lesson's detector.
- **documented-in** and **applies-to**: absent.

## (f) Query and traversal capabilities, and their limits

- **Ledgers.** Every open replays and verifies the whole chain. Queries are linear scans:
  - status `latestHash` (`status.mjs:72`);
  - work `of()` (`work-ledger.mjs:401`) re-reads the chain on every call, and `released()` inside `claim()` makes that quadratic;
  - nothing indexes who cites an entry (the reverse of `derived_from`).

  Checkpoints bound re-derivation (`chain.mjs:8–12`).
- **Board.** Links are forward only (`linksOf`). History is walked breadth-first with a limit of 500 commits (`dag.mjs:70`). `entriesOfKind` scans that history. There is no backlink query.
- **Dependency orders.** There are two topological orders over `depends_on` that drop cycles silently (duplicate 4 in (d)), and checks one hop deep (`dispatchable`, `planValidity`). Only the pipeline has a transitive closure (`upstreamOf`), overlap conflicts and cycle detection, and only within one plan's units.
- **Dossier and retrieval.** These give one hop of dependencies and dependents, textual consumers, word-match guesses and git history, within byte budgets (80 KB view, 16 KB per result, 160 KB per investigation; `context.mjs:62`). Every cut can be continued. The ops are text retrieval; none queries relations.
- **Identity.** Alias resolution runs to a fixpoint of at most 8 steps (`identity.mjs` `baseOf`).
- **Evidence store.** A directory walk at most 6 levels deep. No index.
- **Capability.** Candidates are filtered by window, lab and class floor (`fitCandidates`). `capabilityDrift` compares the duplicated tables.
- **Learning.** `report()` aggregates by class only. Nothing queries by component or file. The register has no reader at all.
- **Not available anywhere:**
  - a k-hop neighbourhood across record types;
  - a transitive impact closure across stores;
  - a historical point-in-time view, other than replaying one ledger prefix, one board history or git;
  - contradiction sets, other than board hypothesis links;
  - cross-instance references.

## (g) Event propagation

| Change | Observed? | Mechanism | Operating? |
|---|---|---|---|
| Status ledger head, work ledger head, tickets, issue snapshot, routing state, reviewer-pool signature | yes | `inputSignature` (`scheduler.mjs:95`), polled by `watch` (:461, every 60 s by default) and `serve` | only where the service runs (the owner's machine; not verifiable here). CI runs a read-only reconcile on push to main, on issue events and hourly (`operate.yml`), and dispatches nothing. |
| A file or view a plan or validation cited | yes, for that record only | `planValidity`, `evidenceCheck`, `validationEvidence` (`gates.mjs:55–128`) on each reconcile; the re-route enters the attempt identity | on each tick, where ticks run |
| A dependency's latest status entry | yes, one hop | `planValidity` compares the entries of dependencies | as above. **A dependent of a dependent is not reached**: a re-plan writes the work ledger, not the status ledger. |
| Identity policy change (aliases, labs) | recorded only on request | `reassess` via `cli.mjs:463`; gates act on recorded reassessments (`gates.mjs:197`) | manual |
| Registry, lanes, facts, classes, seating, fit matrix | no | selections record `policy_hash`; escalations re-derive at verify | no propagation to pending seats or earlier qualifications |
| Code commits (outside cited files) | no | — | the dossier's consumer list is rebuilt only when a dossier is built |
| Test, mutation and CI results | no | logs and step summaries only | — |
| Lessons registry, register | no | `corrections.test.mjs` checks the registry is well formed, not that it changed | — |
| Reviewer findings | recorded on the cycle ledger | copied to the register and lessons by hand | — |
| Model availability | per call | quota failover; cooldown store | not reflected in later eligibility beyond the cooldown |
| TELOS change | refused | digest check at load (`governance.mjs`) | fail-closed, not propagated |
| Public projections | regenerated | `public-record.yml` on push to main | in CI |

The existing pattern for a change feed is the live view's bus (`pantheon/src/view/bus.mjs`): a monotonic `seq`, a bounded replay buffer and an explicit "missed" signal. Every ledger entry already carries `seq` and a parent hash, so a ledger is an ordered, resumable event log. A projection can resume from a (ledger anchor, seq, head) cursor.

## (h) Consumption points

The insertion points named here keep the existing contracts in force:
- a seat may cite only what was delivered to it, versioned (`deliveryOf`);
- a review cycle's first prompt is bound by `prompt_sha` and re-derived (`review-cycle.mjs:222`, :259–260);
- the dispatcher and implementer read only the frozen rubric and unit, because free text there is an unreviewed instruction channel (`work-units.mjs:38`);
- reviewer exclusions are re-derived by the cycle ledger, never taken from a caller.

| Seat | Where its inputs are assembled | Where graph-derived context can enter |
|---|---|---|
| Planner (Stage 1) | seat `stages.mjs:718` (`selectSeat`); evidence `stages.mjs:603–609` (`evidenceFor` → `buildDossier` `context.mjs:375`, `makeRetriever` :172); prompt `plannerPrompt` `stages.mjs:320`, called at :847; retrieval `investigate` :852 | **a derived dossier view** (`graph:<item>#neighbourhood`, kind `derived`, versioned by the digest of its bytes) in `buildDossier`, and **a `graph` retrieval op** in `OPS` (`context.mjs:63`) with `versionOf` (:347). A citation is then bound and re-checked by `planValidity` through `reconcile.mjs:141` `versionOf`. Typed `requires` references could replace the free-text `capabilities` (`stages.mjs:201`). |
| Plan reviewers | seats `stages.mjs:594` (`panel` → `reviewSeatsByModel`), used at :739, :956, :1053 and on resume :797; brief `stages.mjs:972` (`PLAN_BRIEF` + dossier, via `boundBrief` :642) | the same dossier view inside the bound brief, fixed at cycle open, plus retrieval rounds (`investigatingTurn` :619), which are recorded on the work ledger, not the cycle ledger |
| Dispatcher (Stage 2) | seat `stages.mjs:1327` (`fitMatrix('dispatcher', …)`); prompt `DISPATCHER_PROMPT` `pantheon/src/pipeline/dispatch.mjs:96`, turn :155 | indirectly only: through the planner's work units (invariants, verify_cmd), which plan review checks. Direct context would have to be structured data inside `rubricHash` (:139). |
| Implementer (Stage 3) | seat `stages.mjs:1330` (`IMPLEMENTER_LADDERS[…][0]`, a hard-coded table); prompt `IMPLEMENTER_PROMPT` `pantheon/src/pipeline/implement.mjs:66`, built at :265; legacy board path `pantheon/src/board/run-item.mjs:1359` | the seat: capability eligibility (Slice C) in place of the table lookup, which is owner-dependent (k). The content arrives only through the dispatched unit and rubric. |
| In-run reviewer (Stage 5) | seat pinned to the dispatcher (`fit-matrix.mjs:68`, `stages.mjs:1332`); prompt `REVIEWER_PROMPT` `pantheon/src/pipeline/review.mjs:87`, call :170 | the rubric only; the seat must not move (owner decision) |
| Change reviewers (three labs) | seats `stages.mjs:1541` (`cycleReviewers`); brief `stages.mjs:1574–1582` (`REVIEW_BRIEF` + dossier); cycle `reviewCycle` `review-cycle.mjs:170` | the dossier view in the bound brief, plus retrieval. The graph's contributed-to edges may serve as a **cross-check** of the exclusions, never their source. |
| Validator | seat `stages.mjs:1680–1760` (excludes contributors and passing reviewers, L-002); prompt `stages.mjs:1769–1782`; retrieval :1808 | the dossier view and retrieval. Its cited sources are bound by `validationEvidence` (`gates.mjs:106`). |
| Scheduler | `tick` `scheduler.mjs:165`: reconcile :190 → `earliestGate` per item (`reconcile.mjs:174` → `gates.mjs:176`, with one hop of `depStatus`) → `dependencyOrder` :222 → runnable queue :427 → `concurrency` workers :436; wake by `inputSignature` :95 | a graph-derived blocker (for example a shared prerequisite) as an `earliestGate` input carried in `route` (`attemptInputs` :130, so the attempt identity stays truthful), and the graph cursor in `inputSignature`, so a graph change wakes a tick |
| Board dispatcher (`next`) | `boardNext` `pantheon/src/board/operate.mjs:258`, `dispatchable` :244, `seatTeam` :131 | the same as the scheduler, read only. Pantheon may not import `ophanim/` (`layering.test.mjs:39`). |
| Seat selection (all roles) | `selectSeat` `frontier.mjs:215`; `selectionPolicy` :192; escalation re-derivation `protocol.mjs:185` from cited `facts` and `seating` entries | eligibility from the capability graph, with **its snapshot digest hashed into `selectionPolicy` and recorded as a ledger input** (like `facts` and `seating`, `kinds.mjs:46–69`), so recorded decisions still re-derive |

## (i) Technology assessment

### Measured sizes (this checkout)

| Quantity | Count |
|---|---|
| Tracked files (findings files excluded from reading) | 998 (132 not read) |
| Modules / lines / exported symbols | 240 / 53,861 / 1,554 |
| Test files / test cases (about) | 288 / 1,979 |
| Mutation runners / mutations (about) | 9 / 239 |
| Markdown docs (of them under `docs/reviews`) | 100 (22) |
| Tickets / ownership manifests | 13 / 7 |
| Register rows / lesson classes / lesson instances | 97 / 19 / 30 |
| Status ledger entries / items / `depends_on` edges / entries with evidence | 85 / 58 / 3 / 0 |
| Work ledger entries | 0 here (not committed; the owner's ledger is not available) |
| Fixture ledger (`pantheon/tests/fixtures/cycle-v1-ledger`) | 30 entries |
| TELOS JSONL records (its own domain) | 50 files, 5,062 lines |
| Local boards (`$PANTHEON_HOME/boards`) | 337 directories; 333 blobs, 0 entries, trees or commits; 295 run ledgers, 885 lines |
| Registry models / lanes (live) / fact records / seating rows / roles / chairs / fit cells | 19 / 15 (13) / 22 / 21 / 7 / 5 / 12 |
| Commits / commit-to-file touches / parent links | 269 / 3,097 / 317 |
| Import edges, module → module / test → module | 784 / 1,128 |

### Estimated OPHANIM self-graph

**Nodes, about 5,400:**
- 866 files and 1,554 symbols;
- about 1,979 test cases and about 239 mutations;
- 269 commits;
- 143 status items and entries;
- 97 register rows and 49 lesson classes and instances;
- about 120 capability nodes (models, lanes, labs, roles, chairs, seating rows, fit cells);
- about 80 manifests, assignments, workflows, suites and self-audit records.

**Edges, about 11,000:**
- 1,912 imports;
- 1,554 symbol-in-file and 1,979 test-in-file;
- about 840 mutation → target and test;
- 3,414 commit → file and commit → parent;
- 663 code → L-id mentions (textual);
- about 110 status chain and dependency edges;
- 288 suite → file;
- about 300 ownership-glob → file;
- about 160 capability edges.

**Operational growth.** One item's lifecycle writes roughly 20 to 30 work-ledger entries per attempt, and one review cycle roughly 12 to 20. The program's lifetime plausibly stays under 100,000 edges per instance.

### What the twelve demonstrations need from traversal

- **Bounded k-hop neighbourhoods** with byte and node budgets: demonstrations 1, 4, 5 and 8.
- **A typed reverse transitive closure** (impact): demonstrations 2 and 7. Highly connected nodes need bounds: `packages/ledger/canonical.mjs` has 39 importers.
- **Historical point-in-time views**: demonstrations 3 and 9, by ledger `seq` or git commit.
- **Contradiction sets** that keep both sides: demonstration 6.
- **Idempotent, ordered and recoverable writes** under concurrency: demonstrations 8 and 9.
- **Cross-instance references** with an access filter and freshness: demonstration 10.
- **Referential-integrity refusal**: demonstration 12. Precedents are the CAS link check (`cas.mjs:42`) and `graph-check.mjs`.

### Probe

One synthetic probe, `/home/user/kg-tmp/sqlite-probe.mjs`, ran on 60,000 nodes and 240,000 random edges, about 10 to 20 times the estimate. No repository data and no provider were used. Results on 4 CPUs:

| Operation | (1) JSONL replay + in-memory index | (2) `node:sqlite` |
|---|---|---|
| Load | parse 12.5 MB of JSONL and build forward and reverse maps: **266 ms** | bulk insert in one transaction: **1,210 ms**; database file 10.3 MB |
| 3-hop neighbourhood (65 nodes) | 0.2 ms | 0.4 ms (recursive CTE) |
| Full reverse closure (58,803 nodes) | **35 ms** | **471 ms** (recursive CTE with `UNION` deduplication) |
| Point-in-time | replay a prefix, or filter on `seq` | `seq <= ?` inside the recursive CTE works |
| Second writer | — | refused: `database is locked` (the `timeout` option is honoured) |

Facts about `node:sqlite` in v24.22.1:
- It loads without a runtime warning.
- Node's own `--help` still lists it as "experimental node:sqlite module" (`--no-experimental-sqlite`).
- JSON1, `createSession` and `applyChangeset`, `backup`, `serialize` and `setAuthorizer` are present.
- The repository's one existing use, `projectAgyDb` (`pantheon/src/context/project.mjs:207–209`), constructs with `new sqlite(path)`, not `new DatabaseSync(path)`. Under JavaScript constructor semantics that returns the class, not a connection, so `db.prepare` fails. Its test (`pantheon/tests/context-sqlite-lazy.test.mjs`) accepts any error that is not "not available". This was found by reading the code, not by running it.
- `pantheon/.gitignore` already ignores `**/*.sqlite`.

### The three options

| Criterion | (1) Append-only JSONL plus an index rebuilt by replay | (2) `node:sqlite` as a derived, rebuildable index | (3) External graph database or server |
|---|---|---|---|
| Persistence | the sources are the existing ledgers (fsync on append, `chain.mjs:400`) plus, for assertions that cannot be re-derived, a new `graph` domain on the same ledger core; the index lives in memory | the same sources plus a `.sqlite` cache, which must record the source cursors it reflects and be rebuilt on mismatch: **a new duplicate store** | separate storage, backups, and a second persistent copy of facts the ledgers already hold |
| Concurrency | the ledger append lock (`chain.mjs:270`: `wx` lock file with holder token, stale break after 600 s, 10 s wait) serializes writers, and re-derivation under it refuses duplicates; the work-ledger reservation precedent (`work-ledger.mjs:21–29`); readers need no lock | WAL readers plus a single writer: a second lock regime beside the ledger lock, the seat lock (`lock.mjs:262`) and the Gemini usage lock (`gemini-billing.mjs:143`) | transactions on the server; network partitions; credentials |
| Replay and idempotency | deterministic replay in `seq` order; an assertion's identity is its content digest; a repeat is refused on append (precedent: `work.intake` `once: 1`, the claim `workKey`) | rebuild by replay; primary-key upserts; stale while the cursor lags | an import pipeline to be built; replay means re-import |
| Measured performance | load 266 ms at 240k edges (about 15 ms at the estimate); fastest closure | 4.6× slower to load and 13× slower on closure at 240k edges; no gain at the estimated scale | not measured; scale does not call for it |
| CI and runtime footprint | none new (Node built-ins; no new dependency for the lockfile-integrity guard) | built into Node 24, but labelled experimental; `engines` is `>=24 <25`; the one existing consumer is broken and untested | a new service in CI, a client dependency, credentials, network allowlisting; acceptance sandboxes run with a private network (`bwrap-v1`) |
| Federation | each instance keeps its own ledgers (own genesis and anchor); it exports a permitted projection as a signed chain; the core already checks foreign domains structurally without re-deriving them (`chain.mjs:16–24`); works disconnected | changesets could ship deltas, but signing and provenance still have to be built on top | a central server tends toward "one giant shared store" and needs connectivity, against section 6 |

### Recommendation

**Option (1).** Use the existing append-only signed ledgers as the source events. Admitted graph assertions that cannot be re-derived from a source go into a new `graph` ledger domain on `packages/ledger`. Build deterministic in-memory projections, indexed in both directions, by replay from per-source cursors. Traversals are bounded and typed.

Tradeoffs:
- traversal code has to be written, though it is small and `upstreamOf` and `waves` are precedents;
- each process start replays (cheap at this scale);
- there is no ad-hoc query language;
- memory grows linearly, in megabytes.

Keep option (2) as a documented upgrade path: a derived cache that is never authoritative, rebuildable, and keyed by source cursors.

The coordinator decides. Evidence that would change this recommendation:
- measured replay of the real sources over about 1 s per tick or per CLI invocation;
- an operating graph above about 10⁶ edges, or an index above about 500 MB;
- many concurrent reader processes that need a shared warm index;
- federation delta volume where row-level changesets matter;
- Node marking `node:sqlite` stable.

Nothing found here supports option (3).

## (j) Proposed slice decomposition

**Layering constraints:**
- `packages/*` imports nothing from `pantheon/` or `ophanim/`;
- `pantheon/` imports nothing from `ophanim/` (`ophanim/ledger/layering.test.mjs:39`).

**Coordinator-only paths:** `docs/OPEN-LIMITATIONS.md`, `docs/execution/**`, `docs/reviews/**`, `ophanim/lessons/**`, plus root `package.json` and `package-lock.json`, which are shared.

| Slice | New modules (owned) | Existing files it must touch (owned unless noted) | Depends on |
|---|---|---|---|
| **A**, shared foundation | `packages/graph/` (domain-free, imports only `packages/ledger`): `package.json`, `index.mjs`, `schema.mjs` (contract `ophanim.graph/v1`: entity and relation types with direction, domain and range; classification authoritative, observed, derived or hypothetical; status), `identity.mjs` (stable ids `<instance>/<domain>/<type>/<key>` + version = source digest via `packages/ledger/canonical.mjs`), `kinds.mjs` (ledger kinds `graph.assert`, `graph.retract`, `graph.supersede` in a `graph` domain; re-derive checks schema and referential integrity), `projection.mjs` (replay by cursor, forward and reverse index, as-of, projection digest), `traverse.mjs` (bounded k-hop, typed closure, contradiction sets, explained paths), `events.mjs` (change events `{source, from, to, nodes}`), `tests/*.test.mjs` | `ophanim/ledger/layering.test.mjs` (add the `packages/graph` rule); coordinator: root `package.json` (workspace, test script), `package-lock.json` | — |
| **B**, systems and evidence | `ophanim/graph/extract/repo.mjs` (files, symbols, imports and test → module at a **commit**, not the working tree; reuse the specifier regex from `layering.test.mjs:34`), `extract/verification.mjs` (suites via `scripts/test-gates/suites.mjs`, workflows, mutation tables read **as text**), `extract/ledgers.mjs` (status, work and cycle ledgers, read-only against pinned anchors), `extract/records.mjs` (L-ids and code mentions as `mentions`, kind derived, never depends-on), `impact.mjs`, `cli.mjs`, tests | `ophanim/operate/context.mjs` (a `graph` op in `OPS` :63 and `makeRetriever` :172; a derived view in `buildDossier` :375; `versionOf` :347); coordinator: the root `test:proof` glob | A |
| **C**, capability | `pantheon/src/capability/graph.mjs` (vendor, lab, model identity, lane, transport, runtime, role, chair, pool; runs-in, served-by, made-by, alias-of, eligible-for with basis documented, operator or measured, qualified-for **only** from recorded measurements, limited-by with source and quote), `pantheon/src/capability/eligibility.mjs` (explainable decision; the automatic, preferred and pinned modes mapped onto the `PRECEDENCE` of `selectSeat`; pinned is refused when ineligible), `pantheon/tests/capability-*.test.mjs` | `pantheon/src/route/frontier.mjs` (`policyCandidates` and `fitCandidates` consume eligibility; `selectionPolicy` hashes the capability snapshot); `pantheon/src/ledger/kinds.mjs` (a capability snapshot input, beside `facts` and `seating`). Read only: `fit-matrix.mjs` and `seating.mjs` (owner-directed tables). | A |
| **D**, work and learning | `ophanim/graph/work.mjs` (items, intake, tickets, plan dependencies and requirements, units, claims, spend, billing; shared-prerequisite detection), `ophanim/graph/learning.mjs` (lessons, register rows, mutations, cycle findings; shares-failure-mechanism-with **only** from an admitted `graph.assert`, never from text similarity), `ophanim/graph/reassess.mjs` (change event → targeted reassessment), tests | `ophanim/operate/stages.mjs` (planner prompt :320 and plan schema :190/:201 for typed `requires`; fit seats :1326–1333 through C's eligibility); `ophanim/operate/gates.mjs` (`earliestGate` :176 blocker and wake, carried in `attemptInputs` :130); `ophanim/operate/scheduler.mjs` (`inputSignature` :95, queue :427); `ophanim/operate/reconcile.mjs` (:174). Proposed to the coordinator: changes under `ophanim/lessons/**` and the register. | A, B, C |
| **E**, federation | `packages/graph/federation.mjs` (instance identity = ledger anchors; export of a permitted projection under an access policy; cross-instance references `{instance, anchor, node, version}`; freshness and stale marking; import as a foreign domain), `ophanim/graph/federation.test.mjs` (two temporary instances plus a central projection; disconnected operation) | none. It uses the domain mechanism of `packages/ledger` read-only. **File ownership inside `packages/graph/`**: A owns every file except `federation.mjs`. | A (B or D content optional; synthetic departmental graphs suffice) |

**Order:** A, then B, C and E in parallel, then D.

**Overlaps resolved by assignment:**
- `stages.mjs`, `gates.mjs`, `scheduler.mjs` and `reconcile.mjs` belong to D only;
- `context.mjs` belongs to B only;
- `frontier.mjs` and `pantheon/src/ledger/kinds.mjs` belong to C only.

**Open conflict.** Turning the nine mutation runners' tables into importable data needs a main guard in 9 files owned by earlier waves: `ophanim/operate/*.mutate.mjs` and `pantheon/tests/*.mutate.mjs`. B should read them as text, or the coordinator assigns that refactor.

## (k) Owner-dependent items

1. **Live operational evidence.** This session holds no provider keys. Live capability routing (demonstration 4) and a live lifecycle (demonstration 11) need the owner's machine, a `live-run` manifest with declared limits, and `--confirm-spend`.
2. **An authorized unplanned work item for demonstration 11.** Intake records an unmarked issue as a candidate that is never executed (`reconcile.mjs:108`). An item exists only through an owner-signed status entry (`status.mjs set` with the owner's keys) and, for dispatch, a ticket.
3. **Status ledger writes.** Every resulting status change is the owner's `apply` or `set`.
4. **Key custody and authority for a graph ledger.** Its genesis names its operator and orderer. Which key signs admitted assertions (the work-ledger controller, or a new one) is an authority decision.
5. **Dynamic seat eligibility in place of the fit matrix and seating tables.** Both are owner direction (2026-11-17). Replacing the table lookups at `stages.mjs:1326–1333` changes that policy.
6. **Measured qualification.** "qualified-for" requires measured evidence. Practice dispositions require independent cross-lab evaluation (status item `cross-lab-evaluator`, On Hold on a decision). Today no measured qualification exists to project.
7. **Cross-lab review of the graph work itself.** Review cycles need provider keys (`cross-lab-review`, On Hold, waiting on a credential).
8. **Federation scope.** Which instances, which relations are "permitted", and the access policies.
9. **The TELOS boundary.** Whether graph entries anchor to TELOS (`telos.anchor`): K6 and the related items are On Hold on governance.
10. **Coordinator-only records.** Register entries for every caveat of every slice, and lessons registry updates.
11. **Bounds.** The default k-hop depth, node and byte budgets of graph views. The directive leaves these to judgment, and they interact with the existing dossier budgets.
12. **The excluded build-correction graph data** (`pantheon/docs/runs/graph/`, retained in ARGO). Whether to import it is a provenance decision.
13. **Technology selection.** The coordinator decides, per the brief.

## (l) Risks, and what could not be determined

**Risks:**
- **A graph becomes a fourteenth duplicate.** Every projection must be derived and re-buildable, name its source cursors, and never be read as authority. This includes the option (2) cache.
- **Textual relations read as dependencies.** Dossier consumers, L-id mentions and word matches must stay `derived` or `hypothesis`, with a `mentions` edge type, never `depends-on`.
- **Working-tree reads break replay.** The dossier reads the working tree for some ops. Graph extractors must read at a commit (`git ls-tree`, `git show`) for reproducible projections.
- **Canonicalization divergence** (`me3-canonical`). Graph digests must use one function (`packages/ledger/canonical.mjs`) and never re-hash existing records.
- **Tick cost compounds.** Reconcile already rebuilds dossiers per plan per tick (`docs/context-and-evidence.md`, "Dossier cost"). A projection must update incrementally by cursor inside the service, not rebuild per gate.
- **Bound prompts.** Graph text in a review brief must be fixed at cycle open (`boundBrief`). Otherwise `prompt_sha` will not re-derive on resume.
- **Silent cycle-breaking** in both status `dependencyOrder` functions hides a dependency cycle that a graph would surface. Decide whether a cycle refuses or blocks.
- **Highly connected nodes** make unbounded closures cover most of the repository. Edge-type filters and budgets are required (directive section 12).
- **`node:sqlite`** is labelled experimental, and the repository's only consumer of it is broken. Adopting it needs its own qualification.

**Could not determine:**
- The live state on the owner's machine: work ledger entries, run and cycle ledgers, evidence stores, the efficiency ledger, the service's operation. This is why the work-ledger count is 0 and the operating column of (g) is unverified.
- The contents of the `findings-*` records. Their relations to register rows are known only from references in other files.
- Node's documented stability index for `node:sqlite` in v24.22.1. The docs are not available offline; only the `--help` text and the absence of a warning were observed.
- Whether anything outside the tests keeps the two `models.json` files in sync. A search found nothing.
- Whether the 337 local boards are test leftovers. Their dates and their missing DAG commits suggest so.
