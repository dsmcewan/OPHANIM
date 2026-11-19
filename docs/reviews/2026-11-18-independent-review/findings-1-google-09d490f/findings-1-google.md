<!-- Written by pantheon/scripts/run-review.mjs. The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 1, Lifecycle and evidence

- status: complete
- stop_reason: final answer
- lab: Google
- requested_model: `gemini-4-carbon`
- served_model: `gemini-4-carbon`
- commit: `09d490feae4df80effa081d08a02ea240f3dc854`
- started_at: 2026-11-19T00:29:22.539Z
- ended_at: 2026-11-19T00:55:57.627Z
- provider_calls: 33
- tool_calls: 65
- usage_totals: `{"promptTokenCount":8656611,"candidatesTokenCount":37373,"totalTokenCount":8782104,"thoughtsTokenCount":88120,"cachedContentTokenCount":7573755}`
- limits: `{"max_turns":40,"max_tool_calls":120,"max_output_tokens":64000,"timeout_s":1800}`
- transcript: `findings-1-google.transcript.json` sha256 `491950658617e05a98249b1620e5c38f02d41d6799ce559df7e1eaafc01252d6`
- harness_template_sha256: `55b5d8580a3b5ba236cd67d9622230d96a4339cd5d2d71d84183884901a573e9`
- system_sha256: `d21aefc2f06f8e881721513665a83452654234965872748dd74e474ae79c30ef`
- brief_sha256: `cb6e0057b8ccee827a519576e2113f1a3538490088cfaaf45bfd7eb6d3f2c7db`
- tools_sha256: `941d4f1b16028639d7a8614b894b1491109ad27f9ac2db63843cba440c959f7c`

<!-- reviewer's final message, verbatim, follows -->

# Independent Review Findings — Assignment 1: Lifecycle and Evidence

- **Reviewer:** Google (`gemini-3.1-pro-preview`)
- **Assignment:** 1 — Lifecycle and evidence
- **PR / Branch:** PR #67, branch `ccr-aa24f0d5-336szn`
- **Commit reviewed:** `09d490feae4df80effa081d08a02ea240f3dc854`
- **Verification suite:** `.review-tests/lifecycle-evidence-audit.test.mjs` (`node --test .review-tests/lifecycle-evidence-audit.test.mjs`, 11/11 passing deterministic fixture reproductions; no live provider calls, no `agy`, temporary directories only)

---

## Findings

### 1. Earliest gate — **does not hold**

**Citations:** `ophanim/operate/gates.mjs:44-69`, `ophanim/operate/gates.mjs:85-109`, `ophanim/operate/gates.mjs:127-195`, `ophanim/operate/stages.mjs:467-491`, `ophanim/operate/stages.mjs:598-600`, `ophanim/operate/scheduler.mjs:208-212`.

Initial routing holds on clean items: Ready items without a ticket route to `plan` (`mode: "author"`, `gates.mjs:155`), Ready items with a valid ticket route to `plan` (`mode: "revalidate"`, `gates.mjs:122, 155`), and Resolved items without verified three-lab completion evidence route to `evidence-gap` (or `awaiting-owner` once recovery writes an unsigned proposal, `gates.mjs:29-38, 85-109`). However, three defects break earliest-gate routing and allow stages to run on changed upstream inputs:

1. **Superseded `passed` stages are resurrected after a return (`gates.mjs:57-69, 160-191`).** When `plan` (`p1`) and `implement` (`i1`) pass, a later stage (`review` or `validate`, e.g. `v1`) returns `status: "returned"` with `next.stage: "implement"`, and the revised `implement` attempt `i2` (`handoff.from === p1.hash`) ends in `returned` (to `plan`), `blocked`, or `pending`, `chainFrom()` (`gates.mjs:63`) selects `after.filter(s => s.status === 'passed').at(-1)` — resurrecting `i1` and `r1`. `tried` (`gates.mjs:166`) then inspects `r1.hash` (`[v1]`) and ignores `i2` completely. Consequently:
   - An `implement` revision that returns to `plan` (e.g. scope violation at `stages.mjs:724` or non-cohesive unit return at `stages.mjs:912`) is **never routed to `plan`**; it re-runs `implement` until `stage_attempts` blocks it.
   - A structural `pending` (`REVIEW_CAPACITY_PENDING`) or `blocked` (`IN_RUN_REVIEW_UNRESOLVED` / `PIPELINE_UNITS_UNRESOLVED`) `implement` revision is not routed to `blocked`, but re-dispatched repeatedly in the same tick until `stage_attempts` is spent (visible in `ophanim/operate/stages.test.mjs:207` and `ophanim/operate/context.test.mjs:224`, where `.slice(0, 5)` and `.slice(0, 8)` mask the extra re-dispatches).
2. **An open `plan` cycle is resumed across a changed requirement (`stages.mjs:467-491`, `scheduler.mjs:208`).** `plan()` stores its review ledger at `<stateDir>/<item>/plan-ledger` under scope `plan/<item>`, keyed only by item ID (`stages.mjs:467, 471`). If `plan` attempt 1 opens a review cycle for requirement `R1` and pends transiently (`REVIEW_PENDING`), and the owner then updates the status ledger with a new Ready requirement `R2`, `earliestGate` routes to `plan` with `gate.requirement = R2` (`gates.mjs:128, 155`), but `plan()` sees `!open.close` on `plan-ledger` (`stages.mjs:480-483`), loads `resume.doc` from `R1`, skips the planner and `planRefusal` (`stages.mjs:491, 493`), finishes reviewing the `R1` plan, and `scheduler.mjs:208` stamps the resulting `passed` stage's `identity.requirement` with `R2`'s digest. Downstream `implement`, `review`, `validate`, and `outcome` then execute on the stale `R1` plan.
3. **Upstream changes to files cited in `investigation.*.sources` or `copy` do not invalidate `plan` (`stages.mjs:598`, `gates.mjs:52`).** See Question 5 (Defect 5b): when `j.evidence` cites non-file views (e.g. `S1`) while `investigation.*.sources` and `copy` cite repository files, `plan.outputs.evidence` is empty, so laterstages run even after those upstream files change.

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q1"` (tests `Q1A defect` and `Q1B defect`).

---

### 2. Handoffs — **does not hold**

**Citations:** `ophanim/operate/work-ledger.mjs:218-227`, `ophanim/operate/work-ledger.mjs:253-254`, `ophanim/operate/scheduler.mjs:71-82`, `ophanim/operate/scheduler.mjs:145-160`, `ophanim/operate/stages.mjs:281-285`, `ophanim/operate/stages.mjs:629-635`, `ophanim/operate/stages.mjs:975-985`, `ophanim/operate/stages.mjs:1057-1064`, `ophanim/operate/stages.mjs:1199-1206`.

Within `tick()`, `openWorkLedger` runs full `L.verify()` (`work-ledger.mjs:253`), `earliestGate` walks `chainFrom` checking `s.inputs.upstream === outputsDigest(last.outputs)` (`gates.mjs:63`), and `verifyHandoff` rejects cross-item `gate.from` hashes because `work.stages(gate.item)` filters by `s.identity.item === gate.item` (`scheduler.mjs:76`, `work-ledger.mjs:323`). However, handoff verification is incomplete at the ledger, `verifyHandoff`, and executor layers:

1. **`work.stage` allows `from: null` on non-`plan` stages and allows stage-skipping handoffs (`work-ledger.mjs:218-227`).** `rederive` only checks handoff invariants inside `if (from !== null)`. Appending `implement`, `review`, `validate`, or `outcome` with `from: null` succeeds and passes `work.verify()`. Even when `from !== null` and `prev.status === "passed"`, `rederive` does not check `prev.stage === STAGES[STAGES.indexOf(p.stage) - 1]`, so e.g. `outcome` citing `plan` directly also passes `work.verify()`.
2. **`verifyHandoff(work, gate)` checks only one hop and checks neither `inputs` digest nor `identity.requirement` (`scheduler.mjs:71-82, 145-160`).** Given an `implement` record appended with `from: null` (which verifies on the work ledger), `verifyHandoff(work, {item, gate: "review", from: impl.hash})` accepts it. Nor does `verifyHandoff` check `rec.identity.requirement === requirementDigest(gate.requirement)` before `exec` runs and spends provider calls (`work.recordStage` only rejects the mismatch after execution).
3. **Stage executors do not verify `ctx.upstream` (`stages.mjs:281-285, 629, 975, 1057, 1199`).** None of `implement`, `review`, `validate`, or `outcome` calls `verifyHandoff` or checks `ctx.upstream.identity.item === ctx.item`. Calling `ex.review` or `ex.validate` directly with another item's `implement`/`review` record consumes that other item's commit and stage chain (`chainOf` at `stages.mjs:282` switches lookup to `r.identity.item`) and opens `board/<itemA>/<base>` over `<itemB>`'s commit.

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q2"`.

---

### 3. Plan — **does not hold**

**Citations:** `ophanim/operate/stages.mjs:191-199`, `ophanim/operate/stages.mjs:472`, `ophanim/operate/stages.mjs:480-491`, `ophanim/operate/stages.mjs:578-624`.

Under `fit` (`needsUnits = profile === "fit"`, `stages.mjs:397, 521`), fresh planner answers without valid `work_units` (or with any `slice.path` unowned by a unit) are refused by `planRefusal` (`stages.mjs:191-199`) before review — except when resuming an open cycle on `plan-ledger` (`stages.mjs:480-491`, which skips `planRefusal`), and except for `LOCK_CONFLICT` between overlapping unordered units (checked later in `runPipeline`, returning `implement` to `plan` at `stages.mjs:898-902`).

However, **contributor lineage for plan-review findings fails across a resumed plan-review cycle** (overlaps Assignment 2, Review independence):

- **Resuming v2's open plan-review cycle drops v1's plan-review finders from `plan.contributions` (`stages.mjs:472, 480-488, 604, 611`).** When plan v1 receives `request_changes` / blocking findings (e.g. from `xai/grok-4.7`), `plan()` closes cycle 1, appends `{purpose: "plan-review", ...}` to the local `contributions` array (`stages.mjs:611`), authors revised plan v2 answering that finding, and opens cycle 2. If 1 of the 3 reviewers on cycle 2 transiently fails (`REVIEW_PENDING`, `stages.mjs:569-574`), attempt 1 returns `status: "pending"`. When attempt 2 runs after `retry_after_ms`, `plan()` re-initializes `contributions` with only the planner (`stages.mjs:452, 472`, since `mode` is `"author"`/`"revalidate"`, not `"revise"`), resumes cycle 2 (`stages.mjs:480-488`), and returns `status: "passed"` (`stages.mjs:604`) **without the v1 plan-review finder in `plan.contributions`**. Downstream `implement`, `review`, and `validate` never see the v1 finder as a contributor, allowing the exact model/lab whose finding revised the plan to sit on the three-lab change review panel and validate the item. (Similarly, any `reply.served_model !== planner.model` recorded in attempt 1 at `stages.mjs:504-506` is lost on attempt 2.)

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q3"`.

---

### 4. Planner seat — **does not hold**

**Citations:** `ophanim/operate/stages.mjs:86`, `ophanim/operate/stages.mjs:441-448`, `ophanim/operate/stages.mjs:458`, `ophanim/operate/stages.mjs:514`, `ophanim/operate/stages.mjs:602`, `ophanim/operate/planner-tier.test.mjs:38-39`.

Seating itself holds: `plan()` extracts `difficulty`, `stakes`, `ambiguity`, and `depth` from `ticket?.spec`, builds `taskProfile(declared)`, and calls `selectSeat("planner", {profile, difficulty: declared.difficulty ?? "medium", task: planTask, ...})` (`stages.mjs:441-445`; `pantheon/src/route/frontier.mjs:339-346`), raising the tier when `stakes` or `ambiguity` sets a higher class floor and defaulting unticketed items to `medium` (`claude-opus-5-5` under `fit`).

However, **an item without a ticket is never recorded on the stage record as planning at medium**:

- `stages.mjs:446-447` builds `plannerTier = {declared, source: ticket ? (...) : 'no ticket: medium'}` and attaches it to `planner.selection.tier`.
- Every place `planner` is written into the stage result — `team` (`stages.mjs:448`), `outputs.planner` (`stages.mjs:458, 514, 602`), `contributions` (`stages.mjs:472`), and `investigations` (`stages.mjs:502`) — passes `planner` through `seatOf()` (`stages.mjs:86`), which keeps only `{vendor, model, lab}` and strips `selection` (and `tier`). `rec.recordTurn` (`stages.mjs:524`) also omits `selection`.
- In `ophanim/operate/planner-tier.test.mjs:38-39`, `const tier = plan.outputs.planner?.selection?.tier ?? seat.selection?.tier; if (tier) assert.equal(...)` evaluated `tier` to `undefined` on every item and never executed the assertion.

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q4"`.

---

### 5. Evidence freshness — **does not hold**

**Citations:** `ophanim/operate/stages.mjs:416-420`, `ophanim/operate/stages.mjs:526-536`, `ophanim/operate/stages.mjs:598`, `ophanim/operate/stages.mjs:1010-1032`, `ophanim/operate/gates.mjs:44-54`, `ophanim/operate/gates.mjs:98-103`, `ophanim/operate/context.mjs:291-341`, `ophanim/operate/evidence-recovery.mjs:60-69`.

Multiple defects break byte-digest binding, staleness detection, and re-searching:

1. **Plan file citations hash post-turn disk bytes rather than the bytes delivered to the planner (`stages.mjs:526, 535`).** `makeRetriever`'s `file` view already computes `version: sha(b)` over the exact buffer delivered (`context.mjs:104, 114`). Instead of recording `got.version`, `stages.mjs:535` calls `bytesOf(file)` (`reconcile.mjs:58-60`), re-reading the file from disk *after* `investigate()` finishes. If the file changed on disk during the planner's investigation, `doc.evidence` and `plan.outputs.evidence` bind `sha256` to the new unseen bytes (`planValidity` then treats the plan as valid for bytes the planner never saw); if deleted, `sha256` is `null` and `gates.mjs:52` (`if (ev.path && ev.sha256 && ...)`) skips checking it.
2. **Dossier working-tree views and resumed review briefs are not bound to the bytes shown (`context.mjs:297, 306-307, 318, 331`, `stages.mjs:416-420, 1010-1032`).** `consumers:<item>` and `guess:<item>` run `git grep` over the working tree while recording `version: head` (not the body digest), and `runs:<item>` records `version: null`. On a resumed `plan` or `review` cycle, `boundBrief` serves the cached initial dossier from attempt 1 to the resumed reviewer while `outputs.context.dossier` records a freshly built dossier (`stages.mjs:401, 562, 1010, 1032`).
3. **Changed files cited in `investigation.*.sources` / `copy` and non-file citations in `evidence` never make a plan stale (`stages.mjs:598`, `gates.mjs:44-54`).** `plan.outputs.evidence` keeps only `doc.evidence.filter(e => e.path)` (`file:` entries in `j.evidence`). Files cited in `j.investigation.<q>.sources` or `j.copy`, and non-file views in `j.evidence` (`issue:N`, `status:<id>#history`, `grep:...`), are omitted from `plan.outputs.evidence`; when their bytes change, `planValidity` still returns `valid: true` and reuses the stale plan and downstream stages.
4. **Evidence recovery `sourcesDigest` omits `locations.ticket`, ledger `objects/`, and repository commit presence, and never invalidates a `recovered` proposal when cited bytes later change (`evidence-recovery.mjs:60-69`, `reconcile.mjs:83`, `gates.mjs:98-103`, `scheduler.mjs:120-125`).** `sourcesDigest` hashes `chain.jsonl` but not `<ledger>/objects/*.json` (where `packages/ledger/chain.mjs:121-135` stores all entry payloads), omits `locations.ticket` (e.g. `<bundle>/ticket.json`), and omits `commitIn(repo, commit)`. If any of those fails on the first search (`not-found`) and is subsequently repaired/fetched, `sourcesDigest` does not change and recovery **never searches again**. Conversely, once `work.recovery` records `outcome: "recovered"`, `gates.mjs:98` routes unconditionally to `awaiting-owner` without re-checking `sourcesDigest`, so subsequent corruption of cited bytes is neither treated as stale nor searched again. (Also, for `EVIDENCE_INSUFFICIENT` plan blocks, creating a missing untracked unignored file in the working tree is readable via `makeRetriever` at `context.mjs:98-104` yet invisible to `buildDossier().stable` at `context.mjs:291-294, 340-341` because `buildDossier` inspects only `git ls-files`.)

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q5"` (tests `Q5A/D defect` and `Q5F defect`).

---

### 6. Evidence bounds — **does not hold**

**Citations:** `ophanim/operate/context.mjs:108-141`, `ophanim/operate/context.mjs:183-210`, `ophanim/operate/context.mjs:248-254`, `ophanim/operate/context.mjs:370-400`, `ophanim/operate/stages.mjs:465`, `ophanim/operate/stages.mjs:577`, `ophanim/operate/stages.mjs:1080`, `ophanim/operate/stages.mjs:1149`, `ophanim/operate/stages.mjs:1173-1175`.

UTF-8 byte caps (`result_bytes`, `total_bytes`, `dossier_bytes`), round/request caps, and symlink/`.gitignore`/`.git` containment on `op: "file"` hold (`context.mjs:49-71, 95-106, 427-455`). However, four bounds and partial-delivery defects exist:

1. **Containment bypass in `list`, `grep`, `log`, and `show` (`context.mjs:116-141`).** `views.list` (`line 117`) and `views.grep` (`line 123`) refuse only when `contained(repo, p).error === "REFUSED"`, ignoring `"NOT_FOUND"` and `"BAD_REQUEST"`. When `repo` is a subdirectory of a git checkout, git pathspec magic such as `prefix: ":/"` or `path: ":/"` (`:(top)`) causes `contained()` to return `"NOT_FOUND"`, and `git -C repo ls-files -- :/` and `git -C repo grep ... -- :/` list and read tracked files across the parent repository outside `repo`. `views.log` (`line 130`) and `views.show` (`line 136`) do not call `contained()` at all.
2. **Out-of-range line windows and range-exceeding offsets return 0-byte `ok: true` deliveries (`context.mjs:109-114, 183-210`).** Requesting `{op: "file", path: "alpha.mjs", start: 500, lines: 10}` (past EOF) or `{op: "file", path: "big.mjs", start: 1, lines: 5, offset: 5000}` (`offset <= total` but `offset >= range.to`) sets `start >= hi`, bypassing `if (w.to === w.from && start < hi)` (`line 198`) and returning `{ok: true, bytes: 0, text: "", coverage: {complete: false, ...}}` with no error and no continuation.
3. **Cut `add()` dossier views have no continuation (`context.mjs:248-254, 318, 379-392`).** When `buildDossier` truncates an `add()` entry (e.g. `status:<item>#relations` or `consumers:<item>` exceeding 4,000 bytes), `coverage.complete` is `false` with `coverage.next === undefined` (`gapsOf` sets `next: null`), and no retriever operation can continue those views.
4. **Partly delivered (or never-delivered) views are falsely recorded as `complete: true` by pooling requests across retries, versions, and rejected seats (`stages.mjs:465, 577, 1173-1175`).**
   - In `plan()`, each retry `k` and each plan version `v` starts from a fresh `plannerPrompt` containing only `dossier`, not earlier tries'/versions' retrieved windows (`stages.mjs:495-500`), yet `plannerGot()` (`stages.mjs:465`) merges `requests` across **all** planner tries and versions. If try 1 (refused) or v1 retrieved the rest of a partial file and try 2 or v2 did not, `outputs.context.unresolved` drops the gap and `causeOf` (`stages.mjs:577-578`) stamps v2 findings on that file as `evidence-delivered` instead of `evidence-partly-delivered`.
   - In `validate()`, `got` (`stages.mjs:1173`) merges `requests` across **all** validator tries (`k = 0..2`), including rejected seats from other labs (`servedRefusal` / malformed JSON). If rejected Seat 1 retrieved `extra.mjs` in full and accepted Seat 2 never saw `extra.mjs` at all, `val.outputs.sources` records `{ref: "file:extra.mjs", delivered: true, complete: true}` for Seat 2. (Additionally, >2,000-char test outputs shown as `PARTIAL` tails in the validator prompt at `stages.mjs:1080, 1133-1134` are not in `dossier`, so unretrieved partial test outputs are omitted from `investigations[k].unresolved` at `stages.mjs:1149`.)

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q6"`.

---

### 7. Scheduling — **does not hold**

**Citations:** `ophanim/operate/scheduler.mjs:113-116`, `ophanim/operate/scheduler.mjs:237-245`, `ophanim/operate/cli.mjs:355-372`, `ophanim/operate/work-ledger.mjs:7-8`, `ophanim/operate/work-ledger.mjs:54`, `ophanim/operate/work-ledger.mjs:121-128`, `ophanim/operate/issues.mjs:25-30`.

The `--item` selector part **holds**: in both `tick` and `watch` (`cli.mjs:355-371`, `scheduler.mjs:238-243`), passing `only` dispatches only that item and records every other runnable item in `skipped` with `why: "outside the --item scope"`.

However, **"Is intake recorded once per source?" does not hold**:

1. **Ticket sources and linked-issue sources are never recorded (`scheduler.mjs:114-116`, `work-ledger.mjs:7-8, 54`).** `work-ledger.mjs` declares `INTAKE_SOURCES = ["status", "issue", "ticket"]` (*"a source of work seen by reconciliation: a status item, a published issue, a ticket"*), yet `scheduler.mjs:114-116` records only `status:<item>` for `rec.items` and `issue:<number>` for unmarked `rec.candidates`. Existing tickets (`rec.items[].ticket` and `rec.orphans`) and linked/unknown-marker issues (`rec.items[].issues`) are never recorded as intake sources (`source: "ticket"` is never written anywhere in the codebase).
2. **The same source can be recorded more than once (`scheduler.mjs:114-116`, `work-ledger.mjs:126-127`).** Unlike `work.recovery` (`work-ledger.mjs:106-109`) and `work.reassessment` (`work-ledger.mjs:118-119`), `work.intake.rederive` (`work-ledger.mjs:126-127`) has no uniqueness check on `ref` or `(source, ref)`. Moreover, `scheduler.mjs:114` builds `known = new Set(work.intakes().map(i => i.ref))` before the loops and never calls `known.add(...)` inside them; when an `issues` snapshot contains duplicate issue numbers (note `normalizeIssues` at `issues.mjs:29` sorts without deduplicating), `tick` appends duplicate `work.intake` entries for the same `issue:<number>` in a single tick, and `work.verify()` accepts them.

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q7"`.

---

### 8. Recovery — **holds**

**Citations:** `ophanim/operate/evidence-recovery.mjs:78-135`, `ophanim/operate/scheduler.mjs:120-130`, `ophanim/operate/work-ledger.mjs:93-110`.

- **Unsigned proposals only:** `recoverEvidence()` (`evidence-recovery.mjs:96, 131-134`) constructs proposals via `propose()` (`packages/ledger/status.mjs:304-312`, which uses no keys and produces no signature) and writes unsigned JSON files under `<outDir>/<item>/proposal-<digest12>.json`.
- **Never touches the status ledger:** `recoverEvidence()` reads the status ledger through `statusHistory()` with `{create: false}` (`reconcile.mjs:24`), never accesses status keys, and never calls `set` or `applyProposal`; `scheduler.mjs:127-129` writes only `work.recovery` on the work ledger.
- **Never searches the same sources twice:** `scheduler.mjs:124` skips any `(item, status_entry, sources)` already present in `work.recoveries(item)`, and `work.recovery.rederive` (`work-ledger.mjs:106-109`) enforces uniqueness of `(item, status_entry, sources)` on append and verification. *(Note: `evidence-recovery.mjs:97` forwards `old.accept_unverified_reason` without requiring `old.evidence.review?.outcome === "verified"`; if an owner applied such an unverified recovered proposal, `gates.mjs:35` would still treat the new status entry as an `evidence-gap`, triggering a search against the new `status_entry`. And see Question 5 Defect 4 regarding `sourcesDigest` omissions when cited ledger objects or `locations.ticket` change.)*

---

### 9. Reassessment — **does not hold**

**Citations:** `ophanim/operate/gates.mjs:81-95`, `ophanim/operate/gates.mjs:137-140`, `ophanim/operate/gates.mjs:160-195`, `ophanim/operate/scheduler.mjs:148-149`, `ophanim/operate/scheduler.mjs:168-170`, `ophanim/operate/stages.mjs:988-1030`, `ophanim/operate/reassess.mjs:17-45`.

When a change review (`review` stage) is disqualified and its replacement `rereview` succeeds in one attempt, `chainFrom(..., s => !hit(s))` (`gates.mjs:160`) stops `rev1`, `val1`, and `out1` from being reused; and when a `Resolved` item's `evidence.review.cycle` is disqualified, `gates.mjs:89-94` marks it `reverification-needed` without touching the status ledger or dispatching it. However, two defects break reassessment guarantees:

1. **A transient `pending` or `failed` re-review drops `gate.rereview` on retry — wedging `tick` on a claim-key collision and causing `ex.review` to reuse the disqualified cycle (`gates.mjs:170, 184-194`, `scheduler.mjs:148-149, 168-170`, `stages.mjs:988-1030`).** After `rev1` (`passed`) is disqualified by reassessment `R1`, attempt 1 of the re-review (`rev2`, `handoff.from === impl.hash`) runs under `mode: "rereview"`. If `rev2` ends in `status: "pending"` (e.g. a transient 503 on 1 reviewer seat) or `status: "failed"`, then on the next tick `tried` (`gates.mjs:166`) is `[rev1, rev2]` and `latestTry` is `rev2`. Because `rev2.status !== "passed"`, `voided` (`gates.mjs:170`) is `null`, and lines `185` (`mode: "resume"`) and `194` return `gate: "review"` **without `rereview`**:
   - In `scheduler.mjs:148-149`, omitting `gate.rereview` omits `inputs.rereview`, producing the exact `workKey` of `rev1`'s already-completed claim. `work.claim` (`work-ledger.mjs:146`) throws `"already completed for these exact inputs"`, and `tick` (`scheduler.mjs:170`) skips the item on every subsequent tick forever.
   - In `stages.mjs:988-1030`, when `ex.review` receives that gate (`rr === null`), it opens `o.run.ledger` instead of `rereview-<hash>-ledger`, finds `rev1`'s closed disqualified cycle (`last.close` is truthy), makes 0 provider calls, and returns `status: "passed"` citing the **exact disqualified review cycle**. (Similarly, for a reassessed `plan` that blocks on `EVIDENCE_INSUFFICIENT`, waking at `gates.mjs:137-140` drops `rereview.policy_rules`, seating plan reviewers under the uncorrected policy.)
2. **A `Resolved` item whose *plan* review was disqualified by a recorded reassessment is marked `complete` instead of `reverification-needed` (`gates.mjs:89`, `reassess.mjs:21`).** `reassessItem()` (`reassess.mjs:21`) reassesses and records `work.reassessment` for `plan` review cycles as well as `review` cycles, and `gates.mjs:149-150` disqualifies active items whose plan review failed reassessment. Yet for `Resolved` items, `gates.mjs:89` checks only `disqualified.get(item.evidence?.review?.cycle)` and ignores `stages` / plan-review reassessments, reporting `gate: "complete"`. (Additionally, `evidence-recovery.mjs:78-109` never checks `work.reassessments(item)`, so recovery will propose a retained bundle whose review cycle has been disqualified.)

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q9"`.

---

### 10. Outcome — **does not hold**

**Citations:** `ophanim/operate/stages.mjs:1199-1226`, `pantheon/src/board/operate.mjs:766-824`, `packages/ledger/status.mjs:347-418`.

Yes — `outcome()` can produce a `passed` stage record and write `proposal.json` whose cited evidence fails structural verification in `status.mjs apply` (`applyProposal` / `checkEvidenceLedgers`):

- Unlike `evidence-recovery.mjs:100` (which calls `checkEvidenceLedgers(p)` before accepting a proposal), neither `outcome()` (`stages.mjs:1219-1225`) nor `proposeFromBundle()` (`operate.mjs:766-824`) calls `checkEvidenceLedgers()`. `proposeFromBundle()` opens only `bundle.review.ledger` and runs `propose()` (`proposalRefusal`, a JSON shape check only).
- Specifically:
  1. `locations.run_json` (`impl.outputs.run.run_json`) is never checked in `validate` or `outcome`. If `run.json` is altered or removed after `review` (e.g. between ticks or across a restart before `outcome`), `outcome` still passes and writes `proposal.json`, which `applyProposal` refuses (`STATUS_REFUSED: run.json is not the one the proposal cites` / `is not at ...`, `status.mjs:368-375`).
  2. After a `rereview` (`rv.outputs.cycle_ledger !== impl.outputs.run.ledger`), `proposeFromBundle` never opens `locations.run_ledger` (`impl.outputs.run.ledger`) at all; if `run_ledger` (`chain.jsonl` or `objects/*.json`) is missing or corrupted, `outcome` passes and `applyProposal` refuses (`status.mjs:349-354`).
  3. Even when both ledgers are present, `proposeFromBundle` never verifies `ev.run.ledger_head`, `ev.run.gate_entry`, or `checkReview`'s `c.scope === boardScopeOf(item, c.base)` and `c.head === commit` (`status.mjs:331-332, 352-353`).

**Reproduction:** Run `node --test .review-tests/lifecycle-evidence-audit.test.mjs --test-name-pattern="^Q10"`.

---

## Blockers for a live run

1. **Plan-review contributor lineage dropped when resuming an open plan cycle (Q3 — `ophanim/operate/stages.mjs:472, 480-488, 604`):** A transient failure on a revised plan's review cycle drops earlier plan-review finders (and served planner overrides) from `plan.contributions`, allowing a contributing model/lab to review or validate the resulting change.
2. **Open plan cycle resumed across a changed requirement (Q1 — `ophanim/operate/stages.mjs:480-491`, `ophanim/operate/scheduler.mjs:208`):** Changing an item's requirement while a plan cycle is open approves the old requirement's plan and stamps `identity.requirement` with the new requirement's digest, executing downstream stages against the wrong requirement.
3. **Superseded `passed` stages resurrected after a downstream return (Q1 — `ophanim/operate/gates.mjs:63-64, 160-181`):** After `review` or `validate` returns work to `implement`, an `implement` attempt that returns to `plan`, blocks, or pends is ignored by `earliestGate`, misrouting returns away from `plan` and burning retries/spend on blocked or pending work.
4. **Re-review retry drops `gate.rereview` after reassessment, wedging `tick` and reusing disqualified cycles in `review()` (Q9 — `ophanim/operate/gates.mjs:170, 184-194`, `ophanim/operate/scheduler.mjs:148-149`, `ophanim/operate/stages.mjs:988-1030`), plus `Resolved` items ignoring disqualified plan-review reassessments (`ophanim/operate/gates.mjs:89`).**
5. **Outcome proposals emitted without `checkEvidenceLedgers` verification (Q10 — `ophanim/operate/stages.mjs:1219-1225`, `pantheon/src/board/operate.mjs:766-824`):** `outcome` can record `passed` for a proposal that `status.mjs apply` refuses structurally.
6. **Evidence freshness & bounds gaps (Q5, Q6 — `ophanim/operate/stages.mjs:465, 535, 598, 1173`, `ophanim/operate/context.mjs:117, 123`, `ophanim/operate/evidence-recovery.mjs:60-69`):** Post-turn `bytesOf(file)` digest binding instead of delivered `got.version`, unmonitored `investigation.*.sources` / `copy` files in `planValidity`, pooling retrieved ranges across retries/versions/rejected validator seats, and `:/` git pathspec containment escape in subdirectory repos.

---

**Lab and model:** Google, `gemini-3.1-pro-preview`
**Commit reviewed:** `09d490feae4df80effa081d08a02ea240f3dc854`