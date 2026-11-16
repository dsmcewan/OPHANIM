# Loop evaluation: OPHANIM against the loop operating principle

Status: evaluation and proposals. No runtime behaviour has changed.
Base commit: `3b00139` (main after PR #2).

This document maps the blackboard → scheduler → workers → TELOS → retained
evidence → efficiency → investigation flow onto the eight loop steps. It
lists where the code already matches the principle and where it doesn't.
It then proposes small changes, each of which the existing `prove`, `verify`
and `investigate` paths (or `npm run test:proof`) can check.

## 1. Mapping: loop step → current mechanism

| Loop step | OPHANIM mechanism | Where |
|---|---|---|
| **1. Stabilize on the known** | The controller loads the head snapshot of `refs/board/ophanim` under the `ophanim-controller` seat lock. `decode` requires exactly one controller-authored state record and the `ophanim.runtime/v1` schema. Every accepted row is checked again: its publication lineage (`checkDependencyContext`), its output digest and a fresh `governance.verifyCandidate` call. | `board.mjs:33-77`, `runtime.mjs:182-245` |
| **2. Identify the unresolved** | The open set is any row in `pending`, `running`, `gating` or `effect_pending`, or a `pendingRelease`. New obligations come from the planner and `validatePlan`. Specs are immutable: a changed spec fails. `validateGraph` rejects cycles, cross-scope edges and duplicate output ownership. Interrupted `running` rows are reset and fenced. | `runtime.mjs:197-252` |
| **3. Research / propose against the known** | `planning.planner.plan` proposes and `validatePlan` independently admits. `authorizePlan` registers the plan. The scheduler takes the ready set (pending rows whose dependencies are all accepted), sorts it by id and slices it to `slots`. Each row gets a worker by round-robin over the eligible kind/scope registry. | `runtime.mjs:197-223, 301-304, 342-349` |
| **4. Apply** | The worker runs on frozen inputs and receives only accepted dependency outputs. Its candidate is published to a fenced `refs/seat/<seat>/wip` branch under a lease generation. Output size, the effect key and effect payload equality are enforced. | `runtime.mjs:301-336`, `board.mjs:79-94` |
| **5. Validate ground truth** | `verifyCandidate` runs the full TELOS lifecycle on the retained candidate (pinned TELOS sources and checker digests). On rejection, the row records `gate.rejected` and opens a repair. Effects go intent → apply → inspect → confirmed, and the payload digest must match. Release activation needs a signed decision that is verified again before it is applied. | `runtime.mjs:279-300, 254-278, 132-146`, `governance.mjs` |
| **6. Record what changed** | Every transition goes through `ctx.save`, which publishes a **full canonical state snapshot** as a Pantheon trace commit, plus one appended event. Workers' candidates are content-addressed blobs. TELOS writes plan, ledger and receipt records once each. | `board.mjs:63-74` |
| **7. Handoff** | The next run starts only from the head snapshot. It checks accepted rows again. A candidate must still match its immutable publication, and its dependency versions must match the accepted dependency digests. Efficiency recovery requires `digest(snapshot)===digest(priorRuntime)`. `resume` requires the saved request's `stateDir` identity. Activation refuses a worker artifact that differs from the accepted release. | `runtime.mjs:224-245`, `recovery.mjs:437-462`, `cli.mjs:136-137, 204-209` |
| **8. Converge or continue** | `runtime.settled` records `blocked`, `accepted_change` or `no_change`. Efficiency assessment runs after convergence and binds the trace to `boardCommit` and `stateSha`. It can propose one slot change, which needs independent replay, TELOS qualification and a signed, scoped decision. Investigation ranks questions only from a trusted `accepted_change` trace. Measurement qualification is a separate, explicitly invoked loop with its own verifier. | `runtime.mjs:350-356`, `efficiency/assessment.mjs`, `efficiency/investigation/*` |

Nested loops already present:

- **Assignment** (step 3 applied to coordination). The scheduler loop is ready set → dispatch → gate → settle.
- **Optimization**. The efficiency gate runs admit → replay → TELOS check → sign → promote, and only on an exact-scope accepted trace.
- **Research**. Investigation ranks questions by information value. Measurement qualification calibrates what can be distinguished. Both stay inside the loop: they propose, and something independent verifies.

## 2. Where the implementation already matches

1. **Verified starting point.** Accepted state is checked again against TELOS on every run, never trusted from the snapshot alone (`runtime.mjs:240-245`).
2. **Nothing moves on an unverified claim.** A candidate becomes `accepted` only after `verifyCandidate` returns `ok:true` *and* its effects are confirmed by inspection. Release and scheduler-policy changes need signed decisions, which are verified independently.
3. **Immutable inputs.** A changed obligation spec, a reused release id with changed content, a changed effect identity, or changed efficiency evidence (`put`) all fail closed.
4. **Handoff by digest.** Recovery, efficiency verification (`verifyEfficiencyRecord`), prior-experiment reuse (`readRetainedExperiment`) and investigation history (`checkSources`) each recompute from the retained board and compare canonically.
5. **Missing is not zero.** Recovered traces mark unavailable measurements as `null` with a `missingMeasurements` list (`recovery.mjs:424-427`).
6. **Post-convergence ordering.** Efficiency, contribution and investigation steps run only after `runtime.settled` and do nothing on `blocked` or `no_change` traces (`assessment.mjs:94-104`, `controller.mjs:116-129`).
7. **Determinism.** Ready sets are sorted, worker choice is deterministic, and every digest uses canonical JSON.

## 3. Gaps and friction

Evidence for G1 and G2 comes from a probe that drives `runRuntime` directly. It uses a stub `verifyCandidate` and a linear chain of N obligations, runs once, then resumes three times with nothing to do (script in Appendix A).

| N | run | convergence | revision | board bytes on disk | final snapshot bytes | TELOS `verifyCandidate` calls |
|---|---|---|---|---|---|---|
| 6 | 0 | accepted_change | 26 | 226,621 | 12,387 | 6 |
| 6 | 1–3 | no_change | 28 → 30 → 32 | +27 KB each | +231 B each | 6 each |
| 18 | 0 | accepted_change | 74 | 1,626,091 | 36,109 | 18 |
| 18 | 1–3 | no_change | 76 → 78 → 80 | +75 KB each | +232 B each | 18 each |

### G1. A no-op still changes the record (equilibrium never shows)

Every `runRuntime` call emits `runtime.opened` and `runtime.settled`. Each is a new full-snapshot commit with a higher `revision` and two more events. A resume with nothing unresolved therefore produces a new head commit. Through the CLI it also produces a new `efficiency/convergences/<commit>/` directory containing a trace, an assessment and an investigation receipt. The principle says the local end state is "nothing changed". At the moment the record cannot show that, because finding equilibrium is itself a change. Each no-op also runs N TELOS verifications.

### G2. Recording is whole-state, not only what changed

`ctx.save` writes the entire canonical state on every event. The state includes the ever-growing `events` array and each row's `history`. Storage is O(transitions × state size): about 45× the final state for N=18 (1.63 MB of board for a 36 KB state). The variables that actually moved in a transition are one row plus one event. The was/is pair is only implicit: it would mean diffing two full snapshots, and nothing ever does that.

### G3. Transitions between snapshots are not checked

`verify` checks the *final* state digest and every accepted row's TELOS plan and publication. It does not walk the commit chain to confirm that each snapshot follows from its parent. Specifically, nothing confirms that:

- `revision` increments by one;
- `events` is append-only;
- accepted rows and confirmed effects never change once set;
- `activeRelease` changes only together with a `release.activated` event and a verified decision.

The Pantheon DAG holds the parents, but the "was → is" consistency of the trail is assumed, not checked.

### G4. Verification is optional in two places

- `runtime.mjs:216`: `authorizePlan` is invoked only `if(typeof governance.authorizePlan==='function')`. A governance adapter without it admits plans with no registration.
- `runtime.mjs:137`: `transitionRelease` accepts `valid===true || valid?.ok===true || valid?.valid===true`. Three shapes of success is a loose contract for a release gate. Every other gate in the codebase requires `ok===true`.
- (Minor) `createGovernance` defaults `telosRoot` to a developer path (`/home/colchis/Projects/TELOS`). The pin check rejects it safely, but the default should be "required" rather than a path that happens to fail.

### G5. Assignment isn't fully part of the recorded loop

- **Wave barrier.** The scheduler dispatches `ready.slice(0,slots)` and waits for `Promise.allSettled` on the whole batch before it recomputes the ready set (`runtime.mjs:342-349`). One slow job leaves the other slots idle. That makes the 1-vs-3-slot experiment measure the barrier as well as the parallelism.
- **The assignment decision isn't evidenced.** `work.started` records the chosen worker, but not the ready set or the policy that produced the choice. An auditor cannot check from the trail that the assignment was the deterministic result of the known state.

### G6. Efficiency ledger keeps mutable accumulators

`recordValue` rewrites `uses/assessment-costs/<use>.json` in place with `writeJson` (`assessment.mjs:130-139`). Everything else in the efficiency tree is write-once (`put`). These debit files are not bound to a trace or the board. A crash between the result `put` and the cost `writeJson` can double-count or drop a debit. `measuredNetMs` is then summed from these mutable files.

### G7. Investigation history doesn't close cleanly

- **Capacity has no exit.** When a scope reaches 32 packets or 64 entries, every later decision becomes `blocked` / `retained-evidence-capacity` (`controller.mjs:154-156`). No loop step resolves that blocker, so the scope stays out of equilibrium for good.
- **Quadratic re-derivation.** For every packet in history, `checkSources` re-runs `verifyAdmissionTrace` and the full `derive` with that packet's history (`controller.mjs:163-183`). That happens on every record and every verification, so verification cost is roughly O(packets²) in model derivations.

### G8. Re-verification breadth on handoff

Every run calls TELOS again for *every* accepted row (step 1), including rows that no ready or unsettled obligation will consume. This is correct, but it holds every variable rather than "only those relevant to the current step". Once G3 makes the chain checkable, the full sweep can move to `verify` and the per-run sweep can shrink to the frontier.

## 4. Proposals

The proposals are ordered by value against cost. Each one keeps determinism and provenance, and the existing system keeps working underneath it. Schema changes are versioned, so earlier proof directories still verify under their original format, as the README already requires.

### P1. A no-op leaves no new record (fixes G1)

At the start of `runRuntime`, after obligation intake, check five conditions:

- no row is in `pending`, `running`, `gating` or `effect_pending`;
- there is no `pendingRelease`;
- no new obligation or plan was admitted in this call;
- the head's last event is `runtime.settled`;
- the head's recorded `blockers` are unchanged.

If all five hold, return `{convergence:'no_change', boardCommit:<existing head>}` without emitting `runtime.opened` or `runtime.settled`. `assessConvergence` then sees an unchanged `boardCommit`. Its `put` writes are already idempotent for the same commit, and `recoverInterruptedAssessment` already returns `null` when the report exists. So no new efficiency directory appears.

- *Keeps:* accepted-row TELOS verification can still run read-only before returning, so nothing moves on an unverified claim, and in any case nothing moves.
- *Validate:* the probe in Appendix A should show a constant `revision` and constant board bytes across runs 1–3. Add a test to `ophanim/tests/` that asserts `resume` twice yields identical head commits. `prove` and `verify` must still pass. If a proof scenario currently asserts a `runtime.opened` event on resume, rebind that assertion to the head commit.

### P2. Verify the transition chain (fixes G3)

Add a pure `verifyRuntimeChain(stateDir)` to `board.mjs`. It walks `refs/board/ophanim` parents from the head and decodes each snapshot. For every parent → child pair it asserts:

- `revision` increments by one;
- `child.events` equals `parent.events` plus exactly one event, with `sequence === revision`;
- an `accepted` row is identical in the child, or the transition event is a governed rollback;
- a `confirmed` effect is identical in the child;
- `activeRelease` changes only on `release.activated`.

Call it from `verifyProof` for every entry in `finalStates`, and make `status` print `{head, chainVerified}`.

- *Keeps:* read-only, no new state.
- *Validate:* `verify` on a fresh `prove` output passes. A unit test that hand-edits a mid-chain snapshot (accepted output flipped, re-published under the controller) must fail.

### P3. One success shape and required governance (fixes G4)

- If `planning` is supplied, `authorizePlan` must be a function. Otherwise fail with `'Governance plan registration required'`.
- `transitionRelease` accepts only `valid?.ok===true`. The fixture governance already returns `{ok:true,…}`, so proofs are unaffected.
- `createGovernance` requires an explicit absolute `telosRoot` and drops the developer-path default.
- *Validate:* `npm run test:proof`. Add a negative test where a governance stub without `authorizePlan` is refused.

### P4. Record the assignment decision (G5, evidence half)

Add `readySetSha` (digest of the sorted ready ids at dispatch), `slots` and `policy:'sorted-id/round-robin'` to the `work.started` event. Assignment then becomes a checkable instance of the loop: given the parent snapshot, a verifier can recompute the ready set and the worker choice and compare them. Extend P2's chain check to do that recomputation.

- *Keeps:* the same dispatch order.
- *Validate:* the P2 chain verifier recomputes and matches on every `prove` scenario.

### P5. Make efficiency debits append-only (fixes G6)

Replace the mutable `assessment-costs/<use>.json` with write-once `assessment-costs/<use>/<traceSha>.json` files, written with `put`, each holding `{traceSha, assessmentCostMs, interrupted}`. `recordValue` computes the totals by reading those records. Two runs over the same trace collapse to one file, because the record is keyed by `traceSha`. That removes the read-modify-write race.

- *Validate:* `verifyEfficiencyRecord` gains a check that `measuredValue` equals the recomputed sum. Run the `demo --efficiency-root` flow twice over a shared ledger and get identical totals. The existing `recovery.test.mjs` interruption cases still pass.

### P6. Delta snapshots with checkpoints (fixes G2; larger, versioned)

Introduce `ophanim.runtime/v2` commits. Each commit's trace record carries:

```
{ schema, revision, prevStateSha, event, changed: { obligations: {id: row}, effects: {key: effect}, releases?, activeRelease?, pendingRelease?, plans? }, stateSha }
```

`stateSha` is the digest of the materialized state after the change. Write a full snapshot (the v1 shape) at every `runtime.settled` as a checkpoint. `decode` materializes from the nearest checkpoint forward, and it verifies `prevStateSha` and `stateSha` at every step. This verification is the was/is pair, and it makes P2 nearly free.

- *Expected effect:* bytes per transition fall from O(state) to O(one row + one event). In the N=18 probe this should drop from about 1.6 MB to roughly 2× the final state.
- *Keeps:* the materialized state at every `runtime.settled` is byte-identical to v1, so `stateSha`, efficiency traces and `verifyEfficiencyRecord` are unaffected. v1 boards still decode.
- *Validate:* a differential test runs the same request under v1 and v2 and compares the `stateSha` at each settle. `prove` and `verify` then pass with the v2 runtime.

### P7. Close investigation capacity and bound verification (fixes G7)

- **Exit from capacity.** When a scope is at capacity, write one deterministic `ophanim.investigation-scope-checkpoint/v1` packet. It names the retired packet ids, and its `entries` are the folded result of `derive` over them, which is already deterministic. Later history starts from the checkpoint. The blocker then resolves inside the loop instead of persisting.
- **Memoize `checkSources`.** Packet ids are content digests, so within one call cache `id → verified`, and a packet whose `historyIds` are all verified needs one `derive` only. That makes the cost linear in packets.
- *Validate:* `controller.test.mjs` and `verify.test.mjs` gain a 33-packet case. The receipt from the checkpointed history must verify under `investigate --state`, and must be identical to a re-derivation from the checkpoint.

### P8. Re-verify only the frontier on handoff (fixes G8, after P2)

Once `verify` runs the full chain and the TELOS sweep (P2), the per-run step-1 sweep can cover only:

- accepted rows that are direct dependencies of non-accepted rows;
- rows with unconfirmed effects;
- rows touched by a release change since the last checkpoint.

`checkDependencyContext` still runs at every `finish`.

- *Keeps:* every value a worker consumes is still TELOS-verified before use. This changes the *runtime* cost, not the trust model.
- *Validate:* the `verificationCalls` counter in `output.measurements` falls on resume scenarios, and `prove` and `verify` still pass. Gate this proposal behind P2, and treat it as an efficiency candidate under the existing admission discipline rather than a default flip.

### P9. Refill-on-completion scheduling as a qualified candidate (G5, throughput half)

Don't change the default. Add a second scheduler policy, `ophanim.scheduler-policy/v2` with `mode:'refill'`. When any job settles, the policy recomputes the ready set and fills free slots in the same sorted-id order. Submit it through the existing efficiency admission path (replay, TELOS qualification, signed scoped decision) exactly as the 1→3 slot experiment works today. That keeps the optimization inside the same loop and still records P4's `readySetSha`, so it remains deterministic given completion order.

- *Validate:* `admission-proof.mjs report` with the refill policy, and the TELOS `check-efficiency` contrast against the wave baseline.

## 5. Suggested order

1. P1, P3 and P4: small and local, with no schema change.
2. P2: read-only verifier, which enables P6 and P8.
3. P5 and P7: efficiency and investigation closure.
4. P6: versioned storage change, validated differentially against v1.
5. P8 and P9: runtime-cost changes, admitted through the existing efficiency gate rather than flipped by default.

After each step the loop itself is the acceptance test. Run `prove`, then `verify`, then `resume` twice. The second `resume` must leave the head commit and the efficiency tree byte-identical (P1). That is the recorded form of "nothing changed".

## Appendix A: probe

Run from any directory. It uses a stub governance, so it measures the runtime and board only, not TELOS.

```js
import fs from 'node:fs'; import path from 'node:path';
import {runRuntime} from '/abs/OPHANIM/ophanim/runtime.mjs';
const N = Number(process.argv[2] ?? 6);
const stateDir = fs.mkdtempSync(path.join(process.cwd(), 'state-'));
let verify = 0;
const governance = {verifyCandidate: async () => { verify++; return {ok: true, planRef: null, evidenceRefs: []}; }};
const worker = {id: 'w', version: '1', kinds: ['k'], scopes: ['s'],
  run: async ({obligation, inputs}) => ({output: {id: obligation.id, deps: Object.keys(inputs.dependencies)}})};
const id = i => `o${String(i).padStart(2, '0')}`;
const obligations = Array.from({length: N}, (_, i) => ({id: id(i), kind: 'k', scope: 's', outputKey: id(i),
  dependsOn: i ? [id(i - 1)] : [], expected: null}));
const du = d => fs.readdirSync(d, {withFileTypes: true}).reduce((t, e) => t + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
for (let run = 0; run < 4; run++) {
  verify = 0;
  const r = await runRuntime({stateDir, obligations, workers: [worker], governance, slots: 1});
  console.log(JSON.stringify({run, convergence: r.convergence, revision: r.state.revision,
    snapshotBytes: JSON.stringify(r.state).length, boardBytes: du(path.join(stateDir, 'pantheon')), verifyCalls: verify}));
}
```

Not run in this evaluation: the TELOS-backed `prove` and `verify` flow. It needs the pinned TELOS checkout (`OPHANIM_TELOS_ROOT`), which was not available in this environment. The proposals name the proof-path checks that should accompany each change.
