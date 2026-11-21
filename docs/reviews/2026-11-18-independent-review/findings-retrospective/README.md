# Retrospective: was each review blocker known, discoverable, or new?

Written 2026-11-19 by the coordinating agent, after round 2 (77480d6) and before round 3 (af0dc30) returned.
This folder's name starts with `findings-`, so the review runner withholds it from every later reviewer, like the findings themselves.

## Method

For every blocker raised by a review, the evidence that existed **before** that review was reconstructed:
- the reviewed commit's history and commit messages, many of which list "not fixed", "assumed" and "limits";
- the docs and tests as they stood at that commit;
- earlier findings of the same class;
- what the coordinator and its fix agents reported in the session before the review (session transcript, cited `T:<line>` in the working notes).

Each blocker is classified:
- **KNOWN**: recorded as open, limited or assumed before the review;
- **DISCOVERABLE**: not recorded, but findable from what was available then;
- **NEW**: it needed information that was not reasonably available.

The reviews covered are:
- round 0: Grok, assignment 3, at `7997657`;
- round 1: all four assignments at `09d490f`, plus the extra OpenAI review of assignment 3;
- round 2: all four assignments at `77480d6`, including the runner's Antigravity run and the owner's manual Antigravity run;
- the owner's credential-isolation direction.

Reconstruction was read-only, using git history, the findings folders and targeted searches of the session transcript. Lines marked *inference* are interpretation, not a recorded fact.

## Result

| Review | Blockers | KNOWN | DISCOVERABLE | NEW |
|---|---|---|---|---|
| Round 0, A3 (Grok) | 6 | 0 | 6 | 0 |
| Round 1, A1 (Google) | 10 | 0 | 10 | 0 |
| Round 1, A2 (OpenAI) | 5 | 0 | 5 | 0 |
| Round 1, A3 (Grok + OpenAI extra) | 6 | 2 | 4 | 0 |
| Round 1, A4 (harness: no source read) | 1 | partly | yes | 0 |
| Round 2, A1 (OpenAI) | 3 | 1 | 2 | 0 |
| Round 2, A2 (Grok) | 5 | 2 (one by design) | 3 | 0 |
| Round 2, A3 (Google manual + runner Antigravity run) | 8 | partly in 3 | 8 | 0 |
| Round 2, A4 (OpenAI) | 7 | partly in 2 | 7 | 0 |
| Owner direction: credential isolation | 1 | yes (accepted as residual) | yes | 0 |

**No blocker was genuinely new.** The only fact first seen at review time was that Antigravity 1.5.11 names its file reader `read_file`. Even that falls into a failure class already on record: 1.5.10's `write_file` had been denied as an unknown tool the day before.

Roughly 52 blockers were raised. About 8 were known, in whole or in part, before the review that raised them. All of the rest were discoverable.

## Where the process failed: eight failure modes

Each mode below gives the evidence, the step that failed, the general capability that was missing, and what evidence would establish that capability. **Status** says honestly whether that evidence exists today.

### 1. A fix stopped at the reviewer's example; sibling paths stayed open

This is the dominant mode, seen in more than 20 blockers.

**Examples:**
- **Single-turn failover.** Round 1 fixed the metered-failover charge only inside `pipelineTurns`. The coordinator's own fix brief scoped it there. `laneFirstTurn` stayed open, although round 0 had already cited it.
- **Elapsed stop.** Round 2 fixed the elapsed stop for `passed`/`returned` but not `blocked`.
- **Version-equals-bytes.** The rule was applied to dossier views, not issue views.
- **Watch trigger.** The wake condition was fixed in `gates`, not in the `watch` trigger.
- **Admission.** It was added to the first critique call, not the re-ask in the same function. The coordinator had read that re-ask block about 20 minutes before committing.
- **Antigravity guard.** Two copies of the guard diverged within 19 minutes of each other.
- **Environment scrub.** It was applied in the review runner, not in the production worker.
- **Restart cleanup.** The orphan worktree was removed, but its branch ref was left.
- **Lease fence.** It was applied to ledger writes, not to the ticket and branch writes before them.
- **Three-lab floor.** It was enforced at the callers, not in the core `reviewCycle`.

**Failed step:**
- Planning: briefs described the instance, not the class.
- Verification: the acceptance rule was "each regression test fails on the old code" (T:13803), which proves the reported path, not the class.

**Missing capability:** enumerating every member of the class that shares the violated invariant before closing a finding. That means every call site of the helper, every entry point (`tick`, `runPipeline`, `watch`, the service), every transport × role, every view op, and every status a producer can return.

**Evidence that would establish it:**
- Each fix commit carries a sibling table, with every member marked fixed and tested, or not applicable with a reason.
- Table-driven tests iterate the whole family and fail when a new member is added without a row. Examples: every retriever op has version = digest of delivered bytes; every Antigravity entry point refuses an undeclared, non-Google or retired model before spawn; every seat in the seating table makes zero metered calls with failover off.

**Status:** not established.
- Individual family tests exist since round 2: the config test that every Antigravity seat has a lane, and the credential probe across all three verify paths.
- No sibling table is required, and no family test exists for most invariants.

### 2. The coordinator wrote the review questions and never answered them against its own code

`BRIEF.md` (06:37, 2026-11-18) and the assignment files (21:49) named, 1 to 16 hours before the reviews, nearly every property that later failed:
- forged checkpoints (BRIEF Q13);
- every provider call charged, failover included (Q15);
- two scheduler processes (A3 Q3);
- a stale holder (A3 Q4);
- a fresh-process verifier (A3 Q10);
- `specialist_role` (A2 Q7);
- the marker (A2 Q9);
- hook timeout and closed stdout (A4 Q1);
- argument laundering (A4 Q2);
- file modes and `.git` (A4 Q6);
- provider keys and the token (A4 Q7);
- another unit's socket (A4 Q8).

After assignment 4's first run read no source, the coordinator chose to wait for a rerun rather than check the questions itself.

**Failed step:** verification. The review was treated as the first check, not the last.

**Missing capability:** self-audit against one's own review questions before dispatching a review.

**Evidence that would establish it:** a committed self-answer per question, giving holds or does not hold, the citation and the test name, written before each round's dispatch. After the round, compare it with the reviewers' answers. A reviewer finding a defect the self-answer said holds is a measured miss.

**Status:** not established. No self-answers were written for round 3, which is already running.

### 3. Known caveats were dropped, narrowed or under-reported between agent and record

**Examples:**
- **Dossier views.** The fix agent reported "dossier … views are not re-checked" (T:13616). The coordinator's relay to the owner dropped it (T:13634), and the commit message claimed the opposite.
- **Cross-process budget race.** Deferred because "the reviewer only flagged one process", although assignment 3's Q3 asked exactly that.
- **Elapsed stop.** Relayed as "its record notes it should have stopped", with no assessment that it left a valid handoff that keeps spending.
- **Checkpoint binding.** The coordinator's brief said "signing is optional", narrowing round 0's blocker without an owner decision.
- **A2A token.** Accepted as a residual in a code comment. The relay to the owner left out the `mcp_config.json` route, and the residual was justified by a constraint the coordinator imposed on itself ("a test owned elsewhere"), then later changed that test.

**Failed step:** acceptance.

**Missing capability:** every caveat in a fix report gets a recorded disposition: fixed, recorded open with its consequence and owner decision, or escalated. A reviewer's blocker condition is the acceptance test, and narrowing it requires an owner decision. Commit and doc claims are stated at the layer where they are enforced.

**Evidence that would establish it:**
- An open-limitations register in the repository. Each entry has the consequence, every access route, and an owner decision or "pending owner".
- A merge record per fix branch listing each agent caveat and its disposition.
- No claim of "fixed" or "complete" while a register entry for that item is pending.

**Status:** not established. There is no register; residuals live in commit messages, code comments and docs, such as the credential-isolation "remaining exposure" section in `docs/routing-task-profile.md`.

### 4. Tests that could not fail

**Examples:**
- **Vacuous assertion.** `if (tier) assert(...)` in `planner-tier.test.mjs` passed when the field was absent.
- **Truncated sequences.** `.slice(0, 5)` and `.slice(0, 8)` hid re-dispatches.
- **Scripted outcomes.** A fixture hard-coded `status: 'failed'` for the elapsed stop, so the `passed` path never ran.
- **Weak tampering.** Tamper tests changed one field, never building a self-consistent forgery.
- **Unfavourable order untested.** The mixed-argument hook test used the one argument order that passes.
- **Exit code over decision.** The closed-stdout test checked the exit code, not the decision text.
- **Wrong entry point.** Module-level tests stood in for lifecycle claims.
- **Silent skips.** Real-bwrap suites skipped silently in constrained environments.
- **Hidden cancellations.** Under Node 22, whole test files were *cancelled* while the summary showed `fail 0`, and the coordinator's summary filter read only pass and fail lines.

This mode matches lessons already recorded in `ophanim/lessons/corrections.json`, including `output-checked-not-consumed`. Those lessons were recorded as single instances, not turned into checks.

**Failed step:** verification.

**Missing capability:** tests that fail when the property is absent:
- no conditional asserts and no truncated sequences;
- no fixture choosing the outcome under test;
- adversarial cases, including self-consistent forgery, reversed orders and both roles;
- the production entry point exercised;
- the observable decision asserted, not the exit code;
- zero skipped and zero cancelled required where the environment supports the suite;
- mutation checks.

**Evidence that would establish it:**
- A test-lint step that rejects `if (x) assert` and `.slice(` on asserted sequences.
- CI that fails on `cancelled > 0`, or on `skipped > 0` for the bwrap suites in an environment where bwrap works.
- Mutation checks recorded for each security or billing invariant, as the credential-isolation work did: dropping `--unshare-net`, `--unshare-pid` or the env cleaning each fails a test.

**Status:** partly established.
- Mutation checks exist for credential isolation only.
- Zero-cancelled and zero-skipped checking is something the coordinator does manually; it is not enforced in CI.
- There is no test lint.

### 5. "Complete" was not tied to evidence; harnesses were not validated against the real tools

**Examples:**
- **Round 1 assignment 4.** The run was launched on a harness that forbade reading source. The runner's own header recorded "no real model turn has been run" (`subscription.mjs` at `09d490f`).
- **Codex sandbox.** The `EPERM` failures (blocked process starts and socket calls) went unvalidated.
- **Grok parser.** It missed native text chunks.
- **Round 2 runner Antigravity run.** Every read was denied, yet the run reported `status: complete, policy_violations: none`.

**Failed step:** acceptance. Paid reviews were launched on an unvalidated harness, and completion was declared without evidence of coverage.

**Missing capability:**
- validating each transport against the real CLI before paid runs;
- a coverage gate, so a run is not complete unless it read source;
- detecting tool drift by comparing the CLI's advertised tools with the hook's allowlist.

**Evidence that would establish it:**
- A recorded smoke run per transport and assignment showing three things: a source file read, one listed test whose result matches a reference run, and parsed final text.
- The runner reports `incomplete` when reads were denied or no source was read.
- The preflight fails on an advertised read tool the hook doesn't know.

**Status:** not established.
- The specific defects are fixed: `read_file` admitted, Grok stream parsing, Codex sandbox and WSL handling, and Grok permission counting.
- There is no coverage gate (checked at `af0dc30`: the runner has no denied-read accounting), no tool-drift preflight, and no smoke-run record.

### 6. Invariants were enforced at the wrong layer or in duplicate

**Examples:**
- **Duplicate guards.** Two Antigravity guards, and two admission sites in one function.
- **Floor at the callers.** The three-lab floor was enforced at callers, not the core.
- **Identity fields.** `requested_model` and `served_model_source` were dropped or inferred by projections and defaults.
- **Billing.** "Failover off" was a branch inside the failover code, not a bound at the point of spend. A seat without a lane went straight to the metered API, despite the docs saying the Gemini key "is used for nothing else".
- **Readability.** The jail's "read-only everything" mount was treated as if it were confidential.

**Failed step:** planning and implementation.

**Missing capability:**
- one enforcement function per policy rule, at the lowest layer, with every caller listed;
- identity and provenance fields treated as a schema that every projection preserves;
- billing and credential invariants enforced at the point of spend or access.

**Evidence that would establish it:**
- A property test that `contributorKeys(project(L)) ⊇ contributorKeys(L)` for every projection.
- One exported Antigravity guard, called from every entry point.
- With failover off, constructing a metered client is impossible (it throws).
- The credential-isolation invariant enforced by one launcher on every path that runs worker code.

**Status:** partly established.
- Credential isolation: established at `af0dc30`, with a written invariant, one launcher, an inventory of spawn sites, synthetic-credential probes and mutation checks.
- Identity-projection property test: not present.
- Single Antigravity guard: the two guards now agree, but they are not one function.
- Point-of-spend billing guard: not present. Seats without a lane are refused, but the client constructor is not guarded.

### 7. Recorded assumptions and new observations were not carried into dependent designs

**Examples:**
- **Shared quota group.** "Gemini models share one quota group" was observed and recorded, but the quota ladder still stepped through Gemini rungs that shared the exhausted group.
- **Unknown writer.** "The writer was not established" was recorded, yet the host-change check still reported "untouched".
- **Unverified premise.** The owner decision that the dispatcher "writes none of the work" rested on a premise nobody checked, and `specialist_role` carried free text to the implementer.
- **Undeclared names.** Decision 3 assumed undeclared Orchestrator ids "cannot be seated", but the board guard admitted undeclared names.

**Failed step:** planning.

**Missing capability:** when an observation contradicts an assumption, re-derive the designs that depend on it. Decision records list their premises, each with a test.

**Evidence that would establish it:** decision entries in `docs/review-independence.md` and `docs/routing-task-profile.md` carry a "premises" list with a test name for each. A changed observation, such as a fixture update, flags the decisions that cite it.

**Status:** not established.

### 8. A fix pass created the next round's defects

**Examples:**
- **Lineage loss.** Wiring checkpoints into the fit stage (round 0 fix) caused round 1's loss of lineage on resume.
- **Half-stop.** The cooperative stop (round 0 fix) caused round 1's `passed`-after-abort handoff.
- **Unit record.** Enabling resume made the per-unit records it leaves empty a defect for `subagentReceipt`, which reads them (round 2).

**Failed step:** implementation.

**Missing capability:** when a fix adds a new path or record producer, audit every consumer of that record and every invariant from the other assignments that the path touches.

**Evidence that would establish it:** each fix commit lists the records it produces or changes, and the consumers of each, checked. A cross-assignment invariant checklist is reviewed for every new path.

**Status:** not established.

## What exists now, and what doesn't

**Fixed in code at `af0dc30`:** every blocker listed above is either fixed with a regression test that fails on the pre-fix commit, or recorded as open:
- the credential-isolation residuals in `docs/routing-task-profile.md`;
- the ten round-2 assignment 3 items listed as not fixed, fixed in `e880a07`;
- `countTokens` documented as not billed.

**Not established as capabilities:** modes 1, 2, 3, 5, 7 and 8, and parts of 4 and 6. The code-level fixes don't show the process has changed. On the record so far, round 3 will likely find more defects of these same kinds.

## Proposed next steps, each checkable

1. Write a self-answer for each of the 40 assignment questions against `af0dc30` (failure mode 2). Round 3 is running on that commit, so its findings will measure the self-audit's misses directly.
2. Add `docs/OPEN-LIMITATIONS.md` as the register (failure mode 3). Seed it with the credential-isolation residuals, the unfixed items noted in commit messages, and every "assumed" line in the runner headers. Then require a disposition for each agent caveat when a fix is merged.
3. Add the runner coverage gate and tool-drift preflight (failure mode 5): `incomplete` when no source was read or reads were denied, and a failure on unknown advertised read tools.
4. Add CI checks for `cancelled 0`, for `skipped 0` on the real-bwrap suites where bwrap works, and a test lint for vacuous asserts and truncated sequences (failure mode 4).
5. For every future fix: a sibling table and a consumer audit in the commit message (failure modes 1 and 8), plus family-level tests for the four invariants with the most repeat findings:
   - version equals delivered bytes, across every retriever op;
   - identity preserved through every projection;
   - the Antigravity model guard, across every entry point;
   - metered spend with failover off, across every seat.
