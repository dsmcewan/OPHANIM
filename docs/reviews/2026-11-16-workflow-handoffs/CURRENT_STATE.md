# Current-state evidence audit

Source pin: `e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6`. This audits existing executable choices and retained evidence; it does not qualify an improvement or close the parent routing/coordination requirement.

# Current routing policy: evidence and opinion

Audited source: **`e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6`**, detached snapshot `work/ophanim-current-policy-audit`. This is an audit of current executable policy at that commit, not a proposal-only review. Source files were unchanged. No provider requests, model CLIs, credentials, or owner keys were used.

The current selector is now connected to planning, implementation and review. It applies a static operator profile by default, and the legacy profile uses manually assigned task bands. This establishes repeatable policy execution; it does not establish that the chosen models, effort levels, or budgets are efficient or best for these tasks. No numerical quality/cost weights were found in the audited selectors: ordering is ordinal table position, exact/nearest-lower difficulty, and quota-pool spreading. [Active caller][caller], [profile policy][profile], [legacy bands][bands], [pool router][router]

## Current findings

| ID | Priority | Current observation | Required correction / bounded acceptance |
|---|---|---|---|
| CS1 | P2 | A single justification tag blends an eligibility constraint with a performance preference. `selectSeat('implementer', {profile:'legacy',difficulty:'hard',avoid:['agy_google'],needsContext:100})` returns Astra with `basis:'SURFACE'`, although the source says the API justifies the lab and Astra's rank is the operator's ladder. The medium reviewer returns Grok 4.6 with `basis:'ISOLATION'`, while its reason calls it the “stronger pick” and asserts less overhead than another rung. Independence establishes who is ineligible; it does not validate those comparative claims. This is exposed by the current effective selector, not just a dormant helper. [Assignments][mixed], [recording][profile] | Emit separate `constraints` and `preference/hypothesis` fields. Every comparative quality, latency or cost reason must carry a matched evidence reference or explicitly say `unqualified`. A fixture should assert that SURFACE/ISOLATION alone never qualifies a model ordering. Preserve the user's independent-review requirement as an authorization constraint. |
| CS2 | P2 | With Fable at `high` in the implementer seat, a recorded acceptance rejection deterministically raises effort to `xhigh`, records “the dial is cheaper than the occupant,” and uses the model capability page as `basis`. That cited page supplies the permitted effort values; this audit found no linked task-level comparison proving that strategy cheaper or more successful than reseating. Supported parameter values and an efficient recovery strategy are different claims. The transition and its unmeasured cost rationale both survive into the recorded decision. [Protocol][escalation] | Retain the bounded recovery rule as an explicit provisional policy, with the supported-values source separated from its cost/utility hypothesis. Test that a capability citation cannot classify a strategy as measured. Qualification should require comparable successful-recovery rate, total cost and latency for effort-first versus the candidate alternative. |
| CS3 | P2 | The current ARGO selection reason says ticket difficulty “sets the output tier only.” Yet default planning with Fable and implementation with Astra compile to **65,536 output tokens for easy, medium and hard**. The tier helper returns 4,096 / 16,384 / 32,768, but `defaultOutputFor` preserves the frontier long-decode default; the active caller explicitly invokes it for Anthropic and lets the model client impose it for Astra. Current reviewer calls have their own explicit 4,000 cap and are excluded from this live-path mismatch. This proves a cap-policy mismatch, not actual tokens consumed or money wasted. [Profile claim][profile], [default budgets][tiers], [active budget handling][budgetcaller], [client default][request] | Either make difficulty affect the actual planning/implementation cap, or accurately record that the frontier profile intentionally retains one long-decode cap and why. Assert serialized request caps for both easy and hard at the active `runOpenItem` boundary, with a fake provider, plus a positive reviewer-4,000 case. Choosing lower caps still needs truncation and successful-completion evidence. |

## What is qualified, and what is not

| Evidence class | Current source / observed control | Limit |
|---|---|---|
| User-authorized constraint | The current request requires independent cross-model accountability. This is a governance constraint, not an empirical claim that every such review improves quality. | An internal same-family review does not satisfy cross-lab qualification. |
| Repository-recorded preference | ARGO's static order is explicitly tagged `OPERATOR`; seven legacy assignments are tagged `TASTE`. This audit found no hidden numerical optimizer. | “Approved” in source is the repository's assertion of authorization. A comment is not an approval receipt or a performance benchmark. |
| Documentary capability | `capability-facts.json` has a read date and per-field vendor documentation citations; the selector refuses unknown/small context windows for policy candidates. | These establish the recorded API/transport bounds and supported controls. This audit did not revalidate external pages or call the live providers. They do not establish optimal task ranking. [Facts][facts], [context admission][admission] |
| Deterministically verified behavior | The guarded probe made 18 role/profile/difficulty selections, compiled requests locally, and passed 16 assertions. Selection identity/reason travels with the actual caller. | Fakes and request compilation verify mechanics, not provider quality, actual spend, latency or real recovery success. |
| Historical case evidence | The evidence-base prose records two concrete design defects found by OpenAI/xAI reviewers. This supports the value of those specific reviews. | It does not rank the current models or measure generalized review uplift. The separate paired evaluation is reported as all ties and zero delegations in six delegating-arm trials. Both are historical; the env-lab receipt is referenced, not bundled here. [Two cases][cases], [paired evaluation][paired] |
| Current efficiency measurement | No matched task-level cost/quality/latency dataset for the current ARGO models, task bands, effort-first policy or token tiers was found in this bounded tracked-source audit. `docs/pantheon-engine-loop-evaluation.md` explicitly says the tiers had no recorded truncations when introduced. | This is an evidence gap in this repository snapshot, not a claim that no external receipts exist. [Tier evidence scope][tierevidence] |

`SEAT_FACTS` also retains vendor-level latency labels described as measured on 2026-09-27, and inferred AGY windows. The current policy selectors use documented windows rather than those inferred window entries; the audit found no latency-based ranking in their active choice path. Treat the legacy labels as historical metadata, not current per-model performance. [Historical metadata][historical]

## Present unqualified policy knobs

These are permissible explicit policies, not established optima: static ARGO role order; legacy easy/medium/hard model bands and nearest-lower-band fallback; high default effort on frontier Messages/Gemini; effort-first recovery; four escalation steps; output doubling; three default work revisions; fifteen-minute turn deadline; and prompt-characters/4 context estimation. The output tiers are already honestly labelled provisional. No benchmark evidence in this audit establishes these choices as the best values. [Bands][bands], [effort defaults][request], [escalation][escalation], [run controls][runcontrols], [context estimate][contextestimate], [tiers][tiers]

`truncationEvidence` is an available aggregation helper, but the audited runtime source has no caller that consumes its result to change the policy. A cycle may record and review work without qualifying or revising these model-selection practices. The current task should therefore begin by assessing the existing policy, with candidate changes held as hypotheses until qualified; recording a future requirement alone leaves the existing claims unchanged.

## Minimum current-state acceptance

1. Export the effective current policy, including role order, bins, output and effort defaults, context estimator and recovery limits. Preserve existing constraints; identify each remaining choice as an explicit preference or hypothesis until evidence qualifies it.
2. Reject unsupported comparative claims in machine-readable decisions, including claims smuggled through SURFACE/ISOLATION or a vendor capability citation. Record evidence provenance, source version, task population and limits when a claim is qualified.
3. Verify actual request serialization for each current role/profile/difficulty and declared override. Do not infer budgets or models from helper output alone.
4. Assess the current baseline on representative, independently checked tasks before changing it. Record success/rework, actual usage/cost, latency, truncation and recovery outcomes; compare candidate policies under the same authorized constraints. Explicit user constraints stay constraints even if a benchmark favors removing them.
5. Each subsequent cycle should review accumulated evidence, regressions and policy drift, and either retain the current version with a reason or propose a separately reviewed candidate. A benchmark or same-family self-review must not independently authorize its own promotion.

## Reproduction and scope

Run the retained `probe.mjs` with the offline guard:

```sh
/usr/bin/node --import /mnt/c/Users/dsmce/Documents/Codex/2026-11-16/he/work/workflow-audit/offline-guard.mjs /mnt/c/Users/dsmce/Documents/Codex/2026-11-16/he/work/workflow-audit/current-state/probe.mjs
```

Results: `probe-results.json`; compact stdout: `probe.stdout.json`. Sixteen assertions passed. This probe exercises current pure selectors, escalation and request compilation; it does not execute an end-to-end operating cycle or a provider. The source links pin every claim to the audited commit. Findings are not fixes and are not cross-lab approval.

[caller]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/board/run-item.mjs#L165-L175
[profile]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/route/frontier.mjs#L91-L197
[bands]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/role/seating.mjs#L637-L659
[router]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/route/router.mjs#L240-L316
[mixed]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/role/seating.mjs#L268-L315
[escalation]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/route/protocol.mjs#L26-L133
[tiers]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/config/tiers.mjs#L1-L40
[budgetcaller]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/board/run-item.mjs#L415-L427
[request]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/packages/model-client/request.mjs#L19-L95
[facts]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/config/capability-facts.json#L1-L30
[admission]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/route/protocol.mjs#L158-L197
[cases]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/docs/specs/2026-09-27-evidence-base.md#L714-L748
[paired]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/STATE.md#L421-L430
[tierevidence]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/docs/pantheon-engine-loop-evaluation.md#L280-L295
[historical]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/route/router.mjs#L30-L103
[runcontrols]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/board/run-item.mjs#L124-L134
[contextestimate]: https://github.com/dsmcewan/OPHANIM/blob/e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6/pantheon/src/board/run-item.mjs#L107-L108


---

# Current-state measurement and policy audit

Pinned public source: `e481e778350d22ed1daaf9f6bbb0e1cb51c28ce6` (commit timestamp `2026-11-17T04:19:01Z`). Source worktree: `/mnt/c/Users/dsmce/Documents/Codex/2026-11-16/he/work/ophanim-current-policy-audit`.

The repository has real synthetic measurement and integrity machinery. The examined evidence does **not establish that current live model routing, escalation, reviewer count or coordination choices are empirically efficient**. Its own code distinguishes operator preferences and capability facts from unmeasured result quality/cost. The public status board still holds evidence-driven seating adjustment and independent evaluation, and marks the continuing practice-assessment requirement Ready. This is a current-state finding, not merely a proposal for future work.

## Evidence classes and findings

| Claim or component | Present evidence | What it establishes | What remains unestablished |
|---|---|---|---|
| Public status board | Fresh full verification under the original public anchor: 81 entries, 57 items; 78 status entries, one genesis, checkpoint and authority entry | Signature/hash/link consistency and authorized status statements | Independent truth or completeness of the statements, current artifact acceptance, measured live efficiency |
| Efficiency records, K5/K5b | Status entry 21 is Resolved; basis says trace/assessment/retained records are ledger-bound | Signed implementation-status claim; the code and fixture receipts support existence of record/recomputation mechanisms | A successful live model efficiency experiment or adopted routing optimization |
| Q7 contribution measurement | Status entry 6 Resolved; source projects chair entries, rework, reseats and critiques from reachable board objects | Recomputable contribution accounting mechanisms | Model quality ranking, causal credit, cost per useful result, or authority to reseat models |
| Current seating/router | Explicit TASTE, QUOTA, SURFACE, ISOLATION grounds; router lists code quality, reasoning quality and cost per useful result as UNMEASURED | Visible provisional choices and capability/transport constraints | Matched current-model trials demonstrating that the selected ladder is the efficient choice |
| Historical synthetic 1-slot→3-slot scheduler comparison | Retained, scope-bound timing/acceptance/recovery report; candidate saves 429 ms by its conservative local timing measure but costs 24,046 ms to test; forecast net −15,466 ms and realized net −24,046 ms | A measured comparison with retained negative result and refusal to promote | Any accepted wider scheduler policy, monetary/provider savings, or transfer to live models |
| Synthetic phase measurement qualification | Fresh guarded raw-sample recomputation exactly matches the retained verdict: 32 samples, four counterbalanced blocks, same synthetic accepted output/effect proposals | The instrumentation distinguishes the injected timer and transformation controls and preserves frozen synthetic outputs | Historical cause, naturally occurring workload effects, system throughput/recovery improvement, live provider quality or cost |
| Independent model evaluation / review | Public board holds independent Phases 0–6, real-seat K6, PR6 cross-lab review and core-premise live runs | Open requirements are recorded | Completed independent current-model evaluation or externally reviewed policy promotion |
| Continuous practice learning | Public status entry 81 remains Ready; cycle contract explicitly says it is an implementation/acceptance contract, not an enforcement claim | Owner priority, intended acceptance cases and ordering are concretely documented | Every current cycle retaining a practice disposition and the next actual dispatch loading an admitted learned policy |

### 1. Signed status is not measurement or independent review

The public ledger freshly verifies as:

`ok: 57 items, 81 entries, head sha256:76892bd2bff0f050c01591dc42b0241112c350d86df14f0ec94e676fd4b60503`

The original anchor is `sha256:816a79525846cb2ade6173260237f1236cd5bea103d9027be51ea2981a2b536d`. Latest state counts are 36 Resolved, 17 On Hold, 1 In progress and 3 Ready. All 78 status payloads contain a textual `basis`, date, title, item, state and wait field; five include dependencies and eight an owner role. These public status payloads contain no structured experiment, review or evidence-reference field. This says what the public board carries; it does not imply that external run ledgers cannot carry richer evidence.

The only tracked `.jsonl` file at this source pin is `status/ledger/chain.jsonl`. No retained experiment/sample/result JSON is tracked under the examined efficiency/state paths. Source, tests and public evaluation documents are present; selected raw measurements survive separately in local report directories. Those are separate provenance classes and should not be combined into a claim that the public status chain proves a live experiment.

Source: `docs/STATUS.md:6`, `:9`, `:16-19`, `:23-27`, `:35`, `:47`, `:58`; exact selected sequence/payload references are in the companion JSON. Public verification command used native Node with the offline guard:

```sh
/usr/bin/node --import /mnt/c/Users/dsmce/Documents/Codex/2026-11-16/he/work/workflow-audit/offline-guard.mjs packages/ledger/status.mjs verify
```

### 2. Current routing choices are explicitly provisional on quality and useful cost

`pantheon/src/route/router.mjs:1-23` states that the earlier paired evaluation tied all tasks and refuses to present a quality ranking. Lines 216–220 list three unmeasured properties: better code, better reasoning, and cheaper useful results. Its continuity, quota and coarse latency grounds address narrower operational questions. The bounded evidence inspected here did not reopen the earlier paired trial's raw records; the introductory comment is historical context, not fresh validation of current models.

`pantheon/src/role/seating.mjs:141-147` defines TASTE as operator preference rather than measurement. Lines 270–295 retain the Astra→Sol→Luna ladder while explicitly noting that historical vendor guidance contradicts its hard/medium/easy ordering; the source labels the choice as the operator's. This audit does not use that historical guidance as current vendor documentation. It shows that the repo itself does not claim a measured quality/cost basis for this ladder.

`pantheon/src/board/contributions.mjs:1-6` and `:99` explicitly say the projection ranks no model and authorizes no seat change. Public `q7-adjustment` is On Hold pending K6 (`docs/STATUS.md:27`), while contribution accounting is Resolved (`:58`). Accounting and selecting a better model therefore have different completion states.

A requirement for three independent reviewers, where adopted as owner policy, is a constraint to enforce. Neither these records nor the phase calibration establish that three is an empirically optimal reviewer count.

### 3. The retained scheduler experiment is a useful negative result

The selected historical report is `/home/colchis/Projects/reports/ophanim-admission-2026-11-15.4yHgI7/admission-proof.json`. Its retained comparison and the investigation's `controlled-replay-verification.json` agree on:

- Baseline conservative completion 1910 ms; candidate 1481 ms; conservative local gain 429 ms.
- Trial cost 24,046 ms; forecast gross gain 8580 ms across 20 matching convergences; forecast net −15,466 ms; realized net −24,046 ms.
- Outcome `no_change`; stage p95 materially regressed, and trial cost exceeded forecast savings.
- `actualNewPolicyAdmitted:false`; model calls, business connections, policy decisions issued and activations all 0.

The report's deterministic positive case demonstrates gate mechanics only. It is separately labelled; it does not overturn the measured historical refusal. The fresh admission section also refuses repeat work (`replays:0`) after retaining the negative result. This supports avoiding needless synthetic experiments, not a live provider optimization claim.

README lines38–44 explicitly scope this to 1→3 synthetic scheduler slots with three alternating clean pairs and a crash/resume per width. Provider spend/model invocations are zero. The three pairs are thin evidence for tail statistics; the public board separately holds ME2 rather than presenting them as sufficient live qualification (`docs/STATUS.md:25`).

### 4. Raw measurement discrimination is reproducible; historical attribution remains unresolved

The retained phase-calibration qualification is `099ffd4901f9335a87249539cb3fd1d95f5fb9bf64136cb40993a4153e40bb70`; file SHA256 `432c18caae7030f0532c5541df650f0e7831d0cae1b0169e9419a9ca471d7f36`.

This audit freshly reopened the raw `samples.json`, reconstructed the frozen fixture and expected output/effect identities from the retained history/request, and ran the pinned pure `verifyMeasurementProbe`. The complete resulting verdict matches the retained verification exactly under canonical comparison. Four blocks contain 32 samples (four conditions×collection on/off). Median isolated timer contrast is 14.9324985 ms and transformation contrast 9.3253565 ms; the recorded collection window is 501.211304 ms. This read-only recomputation executed no workload sampling, provider call, policy action or destination effect.

The verifier retains `criticalPathMs`, `stageP95Ms`, `throughput` and `recoveryMs` as null; historical timer/transformation attribution remains unresolved. The qualification report has no proposed or accepted policy and records `historicalWideSetting:'refused-stage-p95'`. Its positive information-value calculation uses a declared forecast for the synthetic qualification scenario, not a measured live economic gain. README lines81–85 and `measurement.mjs:106-117`, `:181-187` preserve those boundaries.

Reproduction script: `work/workflow-audit/current-state/recheck-measurement.mjs`; machine-readable result: `measurement-recheck.json`.

### 5. Existing verifier receipts and independent model review must stay distinct

Selected retained `independent-verification.json` receipts report 16 synthetic states, 79 accepted obligations, 26 effects, 6 signed decisions and 26 efficiency/investigation assessments, with 0 model calls/runtime dispatches. These are existing receipts read and content-pinned during this audit. The copied baseline receipts overlap; their counts must not be summed. This audit did not rerun their full signed-authority verifier.

The reason is concrete: `ophanim/governance.mjs:92-112` loads private fixture-authority material even on its read-only path. The current audit forbids reading private keys. It instead performed the public status verification and pure raw-sample recomputation described above. Thus full historical authority/signature re-verification remains an explicit evidence limit here.

Moreover, `ophanim/governance.mjs:183-186` constructs and signs each of the three fixture reviewer approvals in the same process, with provider provenance `fixture-local`. A separate deterministic verifier can independently recompute fixture integrity without supplying independent model judgment. The five evaluation documents' FW1 caveat and README line30 correctly distinguish those properties. Public K6/cross-lab review holds confirm that real-seat review qualification is still open.

## What this supports doing now

Treat present seating as explicitly provisional policy under enforced capability, role and independence constraints. Retain the synthetic negative results and avoid replaying unchanged experiments. Complete the already Ready practice-assessment integration so the current cycle records its actual disposition and the next dispatch consumes its policy identity. Then qualify narrowly scoped live comparisons with actual per-attempt usage/cost, acceptance and independent review before claiming an efficiency improvement. Missing telemetry or cost remains unknown.

The three necessary completion proofs remain separate: measured outcome on the intended scope; eligible independent review of the evidence and interpretation; and an adopted, version-bound policy actually consumed by dispatch. None can be inferred solely from a signed status, passing fake-provider suite, synthetic measurement result or selected model preference.

## Scope and preservation

This was a bounded source/public-ledger audit plus selected local retained-report inspection, not an exhaustive search of every external live run. It made no provider calls, read no pre-existing owner or retained fixture private keys, changed no source content and wrote only its scratch audit files. Every Node invocation used the tested offline guard. All 16 selected current-source content pins match the pinned Git blobs; the materialized worktree has inherited executable-bit metadata differences, so it is not described as a clean Git checkout. The JSON contains exact file hashes, public payload references and qualifications.

The root branch's immutable-proposal correction was separately confirmed on local candidate `d9179ab2e5fe229098fb6c87b8bb0b99b5133794`, status module SHA256 `ab71d0b883ccc581aae6ff16442700d64a6655d0bbdb55168e69a34aa413e305` (content matches that commit). Two scratch fixture cases pass: mutating the caller proposal or verifier-copy cannot alter the persisted private snapshot, and a complete receipt naming a different digest refuses without append. All three existing status-application control tests also pass under the offline guard. These use disposable fixture authority and an injected verifier to isolate snapshot/digest mechanics; they do not establish real domain qualification or independent model review. This correction is not part of public `e481e778` and must not be represented as a control already present in that public source. See `immutable-proposal-confirmation.json` and `verify-immutable-proposal.mjs`.
