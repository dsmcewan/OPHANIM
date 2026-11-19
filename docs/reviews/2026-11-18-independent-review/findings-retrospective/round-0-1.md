# Round 0 (7997657) and round 1 (09d490f) — reconstruction (agent report, condensed)

Timeline: 2026-11-18 06:37 5bd89fa BRIEF.md already asked Q13 (tampered/stale checkpoint), Q15 (every provider call charged incl. quota failover), Q4 (panel <3 labs), Q5 (specialist_role), Q9 (input-model marker). 21:49 49f6be8 split into 4 assignments (A3 Q4 stale holder, Q10 fresh process). 22:21 7997657; Grok A3 22:51–23:10. 23:10–00:08 fix agent → 09d490f; report 23:56:41 "Not fixed, or left as is". 00:08:23 coordinator relayed three open items (single-process budget reservation; legacy implement path no per-call charge; stage ignoring stop signal "still finishes, record notes it") and "No real Codex turn has run here, so the first run is the first real check." 00:22–01:45 round-1 reviews. 09d490f claims "each of the seven problems ... now has a fix".

## Round 0, A3 grok at 7997657 (all DISCOVERABLE)
- Q4 no lease fence. operate-service.md:30 "No completed stage is repeated"; repo already had fenced leases elsewhere (ledger-provenance-evaluation.md:403, loop-evaluation.md:25); 75945ea tested only happy-path expiry; coordinator wrote the Q4 question at 21:49 without checking. Failed: planning (sibling-subsystem invariant not ported) + verification. Capability: port invariants across sibling subsystems; self-answer each review question before dispatch.
- Q8/Q1 restart double charge, lost findings, checkpoints not wired. operate-service.md "across restarts ... unrecorded usage counts at full budget" but spent() counted stage records only; routing-task-profile.md:454 claimed checkpoint re-verify but stages.mjs:817 never passed checkpoints; 3b0ee62 test drove runPipeline directly. Failed: implementation (module not wired) + verification (module not lifecycle) + acceptance (doc claimed lifecycle). Capability: claims→tests map through real entry points.
- Q1/Q2/Q3 concurrency over-spend. Same doc claim; concurrency exposed; no concurrent test; Q3 named it. Failed: planning+verification. Capability: enumerate check-then-act races per shared budget.
- Q1 metered failover second call. BRIEF Q15 asked exactly this 16h earlier. Failed: verification (question never self-checked). Capability: self-audit against one's own review questions.
- Q7 self-consistent forged checkpoint. BRIEF Q13; doc claims tampered checkpoint rejected; tamper test changed patch OR tree, never a consistent forgery. Failed: verification. Capability: adversarial tests.
- Q10 run.json same-process verify. Launcher spec "a fresh reader must verify"; question raised to fresh process; pattern existed (test-restart-child.mjs). Failed: planning (question stronger than implementation, never reconciled).

## Round 1 A3 (grok recovered + astra extra)
- Q2/Q9 elapsed abort → passed handoff. KNOWN: fix report "Not fixed: stage that ignores ctx.signal still completes and is recorded"; relayed 00:08:23 as "record notes it should have stopped". Test exec-reliability.test.mjs:169 hard-coded status 'failed'. Failed: acceptance (framed cosmetic, consequence unassessed, no owner decision) + verification (fixture scripted the result) + implementation (fix introduced half-stop). Capability: consequence analysis of accepted limitations; tests must not script the asserted result.
- Q8 Stage-5 review lost between saves. Round 0 asked "no lost finding"; fix covered units[].findings only. DISCOVERABLE. Capability: enumerate crash windows between persistence points (crash-point sweep).
- Q1 cross-process budget race. KNOWN: fix report "does not cover two separate scheduler processes ... reviewer only flagged one process"; relayed 00:08:23. But assignment Q3 explicitly asks "Can two scheduler processes claim". Failed: acceptance (deferred on misread scope, no owner decision) + implementation. Capability: read the stated requirement, not the repro scope.
- Q1 single-turn failover uncharged. Round 0 Grok Q6 cited laneFirstTurn as sibling; coordinator's fix prompt scoped defect 4 to "inside pipelineTurns" only. DISCOVERABLE. Failed: planning (coordinator narrowed). Capability: enumerate every call site sharing an invariant.
- Q7 checkpoint approval shape-only. Round 0 blocker required binding; coordinator's fix prompt said "(Signing is optional; re-verification is required.)"; checkpoint.mjs header overclaimed. DISCOVERABLE (narrowed). Failed: acceptance (coordinator narrowed a reviewer's blocker without owner decision, reported fixed).
- Q8 standalone pipeline restart. Round 0 named orphan worktrees; fix lifecycle-only. DISCOVERABLE (weak). Capability: each entry point is its own path.

## Round 1 A2 (astra)
- Q5b fresh reviewCycle n:1 one lab. f00f0ae (11-17) fixed the same at callers; core review-cycle.mjs defaulted only when byModel. DISCOVERABLE. Capability: invariant at lowest layer.
- Q2/Q5a v3 ledger doesn't rederive exclusions. b9fa745/10cbd52 claims; tests only consistent cycles. DISCOVERABLE. Failed: verification.
- Q6/Q8 lineage lost on checkpoint reuse (introduced by the round-0 fix wiring checkpoints; fix prompt never mentioned lineage) and on plan revision (stages.mjs:450-452 comment "keeps the lineage" above code that drops it; 22cbbb8 had found the same class on 11-17). DISCOVERABLE. Capability: cross-assignment invariant checklist for new paths; adversarial reading of own fix.
- Q7 specialist_role free-text channel. BRIEF Q5 and A2 Q7 asked; owner decision (dispatcher non-authoring) rested on unverified premise "writes none of the work". DISCOVERABLE. Failed: planning. Capability: verify premises of owner decisions.
- Q9 planner recordTurn drops marker. Doc: "a turn without the marker was named by its provider"; e448ece added marker at producer only. DISCOVERABLE.

## Round 1 A1 (gemini) — all DISCOVERABLE
- Q1.1 chainFrom resurrects superseded stages: 62f36b1 fixed same class for plan only ("short-pool test hid this with iterations: 1"); stages.test.mjs:207 .slice(0,5), context.test.mjs:224 .slice(0,8) mask re-dispatches.
- Q1.2 open plan cycle across changed requirement: 75945ea requirement invariant; d609b7a resume keyed by item only.
- Q2 handoff from:null / stage skip: 75945ea claim; only forged non-null test.
- Q3 resumed plan cycle drops v1 finders: same class as 22cbbb8.
- Q4 planner tier vacuous test: planner-tier.test.mjs:38-39 `if (tier) assert` (3b0ee62); matches recorded lesson output-checked-not-consumed / stored-not-delivered (ophanim/lessons/corrections.json:323).
- Q5 freshness gaps: ba6445f fixed retriever versions not dossier; 2ae2116 claims re-search on byte change but ticket/objects not hashed.
- Q6 bounds: c4c40c2 containment for some ops only; ba6445f fixed offsets not line windows.
- Q7 intake: INTAKE_SOURCES declares ticket, no writer; sibling kinds have uniqueness, intake none.
- Q9 rereview retry drops gate.rereview: 9051f0b tests only one-attempt success; gates.mjs:89 checks review cycle only.
- Q10 outcome lacks checkEvidenceLedgers: lesson output-checked-not-consumed (2026-11-17); 2ae2116 added check to recovery not outcome.
Note: reviewer self-named gemini-3.1-pro-preview vs header gemini-4-carbon — unreconciled.

## Process blocker R1-A4 (sol read no source). KNOWN (assumptions recorded) + DISCOVERABLE.
- subscription.mjs:59-62 @09d490f "assumed": no real model turn run; read-only sandbox blocks writes; nested userns unverified; codex has no per-command allowlist. bd2cb8a "Tested against fake CLIs and a fake fetch only." Coordinator 00:08:23 "the first run is the first real check."
- Contradiction in HARNESS-cli.md ("read any file" vs "run only these commands exactly") findable; assignment-4 tests need real bwrap + fake HOME, can't pass in codex read-only sandbox.
- Failed: acceptance (paid reviews launched on unvalidated harness). Capability: validate harness against the real tool before runs. Evidence: recorded smoke run per transport×assignment proving a source read, one listed test matching a reference run, final text parsed.
- Same root: Grok "no final text" (parser missed native type=text chunks); OpenAI spawnSync git EPERM / socket EPERM / no verifier verdict.

## Patterns
1. Fix scoped to cited path, siblings open (10+): laneFirstTurn, recordTurn marker, reviewCycle core vs callers, containment ops, line windows vs offsets, dossier vs retriever versions, plan vs implement re-dispatch, outcome vs recovery evidence check, review vs plan reassessment, lifecycle vs runPipeline restart. Coordinator's own prompts encoded the narrowing.
2. Same class re-found after earlier fix (62f36b1, 22cbbb8, f00f0ae, ba6445f/c4c40c2, lesson output-checked-not-consumed): lessons recorded as instances, not cross-codebase checks.
3. Tests that cannot fail (if(tier), .slice truncation, hard-coded fixture status, non-consistent tamper, module tests for lifecycle claims).
4. Questions authored but never self-answered (BRIEF Q13/Q15; A3 Q3/Q4/Q10; A2 Q5/Q6/Q7/Q9) 1–16h before reviews.
5. Known limitations accepted without owner decision or consequence analysis (cross-process budget, "record notes" elapsed stop, "signing optional", untested harness), relayed as footnotes after "each ... now has a fix".
6. Docs/comments overclaim (operate-service.md "across restarts", routing-task-profile.md:454, checkpoint.mjs "approval is bound", stages.mjs:450 "keeps the lineage").
7. Round-0 fixes created round-1 defects (checkpoint wiring → lineage loss; cooperative stop → passed-after-abort handoff). No cross-assignment invariant review in fix passes.
