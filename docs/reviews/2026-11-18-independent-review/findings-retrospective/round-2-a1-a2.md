# Round 2 (77480d6), assignments 1 and 2 — reconstruction (agent report, condensed)
Transcript cites T:<line> are lines of the session transcript jsonl.

A1-1 Cited dossier views never freshness-checked (sol Q1/Q5). KNOWN.
- Round 1 Q1.3/Q5.3 same class. Brief T:13521 said non-file citations must stale the plan.
- Fix agent hand-back T:13616 (2026-11-19T01:38): "Work-ledger, dossier and output views are not re-checked."
- Code at 77480d6 (3ef4449): context.mjs:247-252 versionOf returns undefined for dossier/work/output; gates.mjs:48 "undefined ... not judged".
- Commit 3ef4449 message overclaimed: "every non-file view with its version ... planValidity re-reads them".
- Tests: lifecycle-evidence-review.test.mjs:160 named for non-file views but only status#history; :202 checks dossier versions exist, never reads them in planValidity.
- Coordinator relay T:13634 listed only two plan-resume gaps; dossier exclusion dropped. Acceptance claim T:13803 "regression tests already cover each fix".
- Failed: acceptance (caveat dropped, overclaim). Capability: reconcile every "not done" line of a fix report against the finding and commit text; fix, record open, or escalate.
- Evidence now: test citing a dossier view → view changes → gate 'plan'; no op returns undefined from versionOf unless listed open; merge record of caveat dispositions.

A1-2 Issue version ignores title/state (sol Q5). DISCOVERABLE.
- context.mjs:193 (c4c40c2) version sha(body) while delivered text has [state] title. Round 1 Q5.2 principle "bind versions to bytes shown" applied in 3ef4449 only to dossier views. No test changes title/state.
- Failed: implementation+verification (invariant not applied to every view). Capability: apply invariant across every member of a family. Evidence: table-driven test over every OPS entry: version === sha(delivered), fails when a new op lacks a row.

A1-3 Watch never wakes on evidence/recovery-source change (sol Q5/Q7). DISCOVERABLE.
- scheduler.mjs:83-89 inputSignature unchanged since 75945ea. Round 1 Q5.4 named the scenario; 3ef4449 fixed buildDossier().stable, gates, sourcesDigest but not watch (scheduler.mjs:288-297). Tests call buildDossier directly; only watch test covers status change.
- Failed: planning+verification (tested the function named, not the production entry point watch/service). Capability: end-to-end tests through the real trigger. Evidence: watch({once:true}) ticks when only an evidence file / retained bundle changes; inventory of gate wake conditions vs watch inputs cross-checked by test.

A2-1 dedupe drops requested_model; board critique row stores asked model (grok Q6). DISCOVERABLE.
- stages.mjs:296 key purpose|vendor|model|lab (1b48d9c); requested_model rows from 4a09e85 deduped at :998; identity.mjs:123 treats requested_model as identity. e029bc4 (round-1 Q6 fix) edited :991-992 and added a dedupe call, key unchanged. No ophanim test with requested≠served. Board run-item.mjs:1214-1218, :1512 store asked model; round-1 fixes went only to pipeline (T:13553).
- Failed: implementation+verification. Capability: identity-bearing fields as a schema preserved by every projection on every path. Evidence: property test contributorKeys(project(L)) ⊇ contributorKeys(L) across dedupe, implement projection, reviewScope, board rows; guard listing every contribution-row construction.

A2-2 Dispatcher exception wider than Stage 5 (grok Q7). KNOWN by design, flagged for review; resolved by Decision 6.
- docs/review-independence.md Decision 5 at 77480d6 "Flagged for independent review"; stages.mjs:871-882 "FLAGGED FOR INDEPENDENT REVIEW". Round 1 Q7 saw and did not count it.
- Failed: none in execution; planning stated the exception as a reclassification ("not a contributor") not a scope. Capability: express exceptions as scopes. Evidence: Decision 6 tests (arbiterExclusions, stage5Keys, negative test where a dispatcher would be first eligible panel seat).

A2-3a Board Antigravity guard admits undeclared names (grok Q9). DISCOVERABLE (partly KNOWN).
- e448ece (22:20 11-17) board guard made?.known && lab!==google; 0fbee75 (22:39) agySingleTurn stricter !known || lab!==google, not back-ported. Decision 3 assumed undeclared Orchestrator ids "cannot be seated" (unchecked). Decision 2 flagged "SDK lane has no start-up check" for review. No test passes an undeclared name to board agyTurn.
- Failed: implementation (second enforcement point instead of shared guard). Capability: one enforcement function per policy rule, call sites enumerated. Evidence: both sites call one exported guard; parameterized test over every Antigravity entry point (board SDK, board CLI, agySingleTurn, laneFirstTurn) with undeclared, non-Google, retired names → AGY_GEMINI_ONLY before spawn.

A2-3b single() defaults served_model_source to "provider" (grok Q9). DISCOVERABLE.
- turns.mjs:176 (4a09e85). Round 1 Q9 "marker dropped downstream"; e029bc4 fixed planner recordTurn + contribution rows only (one test, plan-lineage). 222de24 edited adjacent lines. Decision 2 rule "a turn without the marker was named by its provider" became an unchecked inference.
- Failed: verification (tested at reproduction site only). Capability: trace a provenance field from every producer to every sink. Evidence: transport × role matrix test: ledger served_model_source equals transport's assertion; missing marker never inferred "provider".

A2-4 Board in-run re-ask admitted unchecked (grok Q3). DISCOVERABLE.
- Re-ask run-item.mjs:1459-1468 from root 390a938; admission :1426-1432 added in 9051f0b (21:11 11-17) "Admission requires the answering model to be named". At 20:50 the coordinator read the re-ask block (T:10611) ~20 min before committing. recordReview cites first turn. Round 1 Q3 (OpenAI) said it held, looking only at first call (review miss too). No test with a verdict-less reply under IN_RUN_MODEL.
- Failed: implementation at 9051f0b (rule enforced per call site, not per answer). Capability: enumerate every provider call that can affect a verdict; prove each passes admission. Evidence: test with verdict-less first reply and re-ask served by unnamed/contributing model → refused; inventory of every turn( call in run-item with admission status.

A2-5 openCycle doesn't default required_reviewers (grok Q5, not a blocker). KNOWN (backward-compat trade-off).
- e029bc4 kept recorder-level compatibility; agent T:13553 reported it; commit/doc overclaimed "a newly opened cycle needs three labs on every contract" (enforced in reviewCycle only).
- Failed: acceptance wording. Capability: state claims at the layer where enforced. Evidence: doc names reviewCycle as enforcement point, or openCycle refuses under a versioned contract with a test (done in 10759c8/b05ae7c).

Patterns: (1) fixes stop at the reviewer's reproduction (brief T:13521 asked only to port the reproduction); acceptance rule "fails on old code" (T:13803) proves the path, not the class. (2) caveats lost between agent report and record; commit/doc overclaims. (3) duplicate enforcement points diverge. (4) identity/provenance fields not treated as a schema. (5) tests target the named function, not the production entry.
