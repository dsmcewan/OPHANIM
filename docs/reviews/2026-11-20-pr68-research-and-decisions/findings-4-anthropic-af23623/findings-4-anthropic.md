Review of ea858a6..af23623 at af23623. Scratch checkout: `/tmp/claude-0/-home-user-OPHANIM/0c68b45d-d13a-54b8-88c4-e615fa8b38a0/scratchpad/review-4`; repros are tests named `R4-*` in `pantheon/tests/r4-repro.test.mjs` there (untracked). Source edits were reverted after each mutation; nothing was changed in either repository.

## 1. Findings

### Part 1 (af23623)

**1.1 A partial checkpoint is silently abandoned when the unit key changes. REQUIREMENT VIOLATED ("report the limitation explicitly") and DOC MISMATCH.**
- Where: `pantheon/src/pipeline/index.mjs:645-646` (lookup by key; `if (!got.found) return null`).
- R4-1: after the stop, I committed an unrelated file on `main`. Next run: `partial_resume` null, `partial_rejected` null, `checkpoints.partial_rejected` `[]`, a fresh billed session, unit approved.
- R4-1b: adding sibling unit `b` to the plan gives the same result.
- In both, the old `<hex>.partial.json/.patch` stay on disk after approval, because removal targets the new key.
- The commit message and `docs/routing-task-profile.md` say "otherwise the unit starts from its base and the record says why".
- The unit-key and base branches of `partialRefusal` cannot be reached from the pipeline; the test at line 616 calls the function directly.
- Partly recorded as L-736 ("Stale files"), but that text says such a checkpoint "is refused on every run and left in place until … approved". Neither was observed.

**1.2 Any exception at admission is treated as a budget stop. DEFECT.**
- Where: `gateway.mjs:240` → `turn.mjs:503` (PROVIDER_LIMIT) → `implement.mjs:82` `budgetStopOf`.
- R4-4: the usage ledger's `record` throws EIO on request 3. The work is kept, with `stopped.code: "PROVIDER_LIMIT"`, although `provider_calls.refused_at_limit` is 0.
- The unsent request is also counted in `provider_calls` (total 4, continuation 2).
- This contradicts "a session that failed for any other reason is discarded" and "exact point of refusal".
- The repro uses the test helper's wrapping; the real gateway path was read, not run.
- Not recorded.

**1.3 Reviewer findings are not carried into the partial checkpoint. DEFECT (evidence not retained).**
- Where: `index.mjs` `keepPartial` (the record has no findings); `implement.mjs:131`.
- R4-6: attempt 1 written, Stage 5 `request_changes` ("case X fails"), attempt 2 stopped.
- The partial holds the rejected attempt-1 work plus the fix. The next run's prompt has the RESUMED block but not the finding.
- Not recorded.

**1.4 Second stop of a resumed unit. DEFECT, minor.**
- R4-2: the new partial's `stopped`, `admitted` and `session` are the second session's only; the first session's admitted rows are gone from the checkpoint. Lineage is kept (carbon and argon both contributors after run 3).
- R4-5: a second session that deletes the restored file and is stopped writes a partial with `changed: []` and a 0-byte patch, while the reason says "1 file(s) … kept". The next run rejects it: "names no changed path".

**1.5 CLAIMS WITH NO DECIDING TEST.**
Each mutation below left `pipeline-antigravity-sdk.test.mjs` at 31/31.

| Mutation | Line | Change | Also still passing |
|---|---|---|---|
| M8 | `implement.mjs:83` | drop `\|\| e?.code === "PROVIDER_LIMIT"` | lifecycle "runs out INSIDE" test |
| M1 | `implement.mjs:355` | `jail.ok && jail.changed.length` → `jail.ok` | same lifecycle test |
| M3 | `record.mjs` subagent loop | restricted to `status === "written"` | same lifecycle test |
| M4 | `implement.mjs:351` | drop `native ?` | `pipeline-exec-reliability`, `l150-billing` |
| M7 | `index.mjs:469` | `restored && n === 1` → `restored` | not run |

- M8: no test shows the run's provider-call bound keeping work. The behaviour itself works (R4-14).
- M1: the "session wrote nothing" case is undecided.
- M3: a kept stopped session's subagents as contributors is undecided.
- M4: `reliability-r3-a3` fails one test (L-407) with and without the mutation.
- Killed: removing the `from_partial` loop in `record.mjs` fails line 558.

**1.6 DOC OR COMMENT MISMATCH.**
- `antigravity/turn.mjs:377-379` says the point of refusal "is read from" `requests.jsonl`. Nothing reads it (grep: one test only); the partial takes `stopped.request` from the counter in `turns.mjs`.
- `ophanim/operate/stages.mjs:1561,1566` mark team rows `authored: a.status === 'written'`, so a kept stopped attempt is `authored: false` there while `contributionsOf` counts it as work. Read only.

**1.7 Latent, not reachable through `turns.mjs` today.**
- Where: `index.mjs:512-518`.
- R4-12, with a scripted turn that throws the billing refusal unwrapped: the partial is kept, the loop continues on a stale `checkpoint`, and attempt 2 is judged against a moved HEAD and discarded.

### Part 2 (a2b35e5)

No input found that puts a lane-pinned implementer on a primary seat.

**2.1 The rule covers `implementer` only. Latent.**
- Where: `frontier.mjs:260`.
- `selectSeat("subagent", {profile: "fit", pin: <any of 13 live lanes>})` returns `gemini-4-hydrogen@api`, with no failover marker, as second candidate.
- No production caller passes a pin for another role (`run-item.mjs:1243,1287`, `board/operate.mjs:162`).
- Not recorded.

### Part 3 (a1d090f)

Constructed registries passed to `report()` (`corrections.mjs:79-80`):

**3.1 `report()` alone counts success on a class with no detector. DEFECT.**
- Input: `by_detector: true` on a class whose detector is `kind: "none"`. `problems()` flags it and the CLI exits first; `report()` itself returns `demonstrated: true`.

**3.2 Only a self-declared label separates a review find from a detector find.**
- Input: `observed_by: "mechanism"`, `detected_by: "independent adversarial review…"`, `by_detector: true`. Result: success true, `problems()` `[]`.

**3.3 Dates are compared as strings with `>=`. DEFECT, minor.**
- A detection dated `"2026-11-9"`, before the owner's `"2026-11-17"`, counts.
- A detection on the same day as the owner's raising counts.

**3.4 Success survives a later owner re-raise.**
- Detection, then the owner raises the class again: `succeeded: true` and `repeated: true` together.

**3.5 `recurrence_proven` counts any non-empty string.**
- `"none yet: no reusable check exists"` on a review find counts as 1.

## 2. Checked and found sound

- **Restore fidelity (R4-8):** a deletion, rename, mode 755, in-tree symlink and binary file were kept and restored exactly; the unit still went through verify and Stage 5.
- **Lineage:** restored authors stay contributors after a second stop (R4-2), into the approved checkpoint and its later resume (R4-13), and into the lifecycle's contributions (`stages.mjs:1540` uses `contributionsOf`; read).
- **No approval from a partial:** `resumed` stays false, a reviewer is called, and the partial is removed on approval (existing tests, R4-2, R4-13).
- **Forgery without the key:** read plus the existing seal cases. An approved checkpoint and a partial cannot stand in for each other (schema and verdict are checked; read).
- **Stop that wrote nothing (R4-3):** no partial is written; an earlier partial stays.
- **Billing across stop and resume:** the refused request is not on the ledger; the resumed run bills only its own requests (existing assertions; read `spendGemini`).
- **Lane pins:** 13 live lanes × 3 difficulties under `fit` give pin → its own failover → ladder lanes, with no SDK or primary seat. Retired, unknown, upper-case and vendor-prefixed pins throw. An SDK `roleOverride` stands as `operator-override`. The unpinned path is unchanged (the diff is inside `if(pin)`).
- **Lane-pin tests decide the rule:** appending the matrix seats after the lanes fails both test files. Appending an SDK-transport-shaped seat fails only the selector test (`quota-failover` stays 12/12).
- **Lessons registry:** a review find with `by_detector` is not counted. The real registry has 6 review instances, 0 `by_detector`, success not demonstrated. Four mutations of the success rule are all killed by `corrections.test.mjs`.

## 3. Not checked

- Any real SDK session or provider. Every session here is scripted.
- Whether the lifecycle's base or plan actually moves between ticks, which decides how often 1.1 occurs in practice.
- Forgery by a key holder using a symlink that escapes the worktree. By reading, `preexistingEscapes` refuses the next attempt.
- The full suite and the `*.mutate.mjs` runners (not run, per instructions).
- Why `reliability-r3-a3` fails one test at baseline here.
