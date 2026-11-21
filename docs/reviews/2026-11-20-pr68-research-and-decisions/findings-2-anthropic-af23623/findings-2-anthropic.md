## Review: research in the lifecycle (`ophanim/operate/`), final state af23623

Reproductions are in `/tmp/claude-0/-home-user-OPHANIM/0c68b45d-d13a-54b8-88c4-e615fa8b38a0/scratchpad/review-2/ophanim/operate/` (`zz1.mjs`, `zz3.mjs`, `zz4.mjs`, `zz5.mjs`, `zz2.test.mjs`). The worktree is left registered and has no tracked changes. No provider was called.

### 1. Findings, most severe first

**F1. A research session may read the controller's private key. REQUIREMENT VIOLATED** (ledger written only with the controller key; research is read-only on the repository).
- Where: `research.mjs:172` (`worktree: repo`, default scope `['.']`, nothing hidden), `stages.mjs:711-714`, `cli.mjs:153` (default work ledger `<repo>/status/work`).
- Repro (`zz1.mjs` d): read-only policy with scope `.`; `toolDecision` for `view_file status/work/keys/controller.json` returned `allow:true, "a read inside the repository"`. That file has a `privatePem` field.
- The validate jail hides `ctx.work.root` and the state dir (`stages.mjs:1836`); research hides neither, so the ledger and evidence files are readable too.
- Decision level only; no live session was run. Not recorded (L-734 and L-735 are adjacent).

**F2. A plan stands although its planner was never shown a material conclusion. REQUIREMENT VIOLATED.**
- Where: `context.mjs:433` caps the research view at 6,000 bytes and keeps the oldest; `stages.mjs:899` records every ledger conclusion as given.
- Repro (`ZZ cut`): two full conclusions, then a material one. Planner prompt holds the material finding: false. Plan record lists its hash: true. Gate: `implement`.
- Not recorded.

**F3. Insufficient-evidence research re-activates without bound. DEFECT** (objective 11; "once per set of gaps").
- Where: `stages.mjs:669-685`, `gates.mjs:276`. "Once" is exact text match, and each conclusion changes the stable digest, so the attempt bound never binds.
- Repro (`ZZ loop`): a planner naming a differently worded gap each time gave 20 teams and 60 billed requests in one tick, and 30 teams and 90 requests over two ticks. It stopped only when my script did.
- Not recorded.

**F4. The lease fence does not cover `work.research`. DEFECT.**
- Where: `work-ledger.mjs:520` (plain `append`), rederive at `:201-214`.
- Repro (`zz1.mjs` b): accepted a node record under a claim expired an hour earlier, and a team plus material conclusion under a released claim; `verify().ok` stayed true.
- Not recorded.

**F5. A member whose evidence file is altered or missing is paid for on every resume and never re-recorded. DEFECT** (doc item 8, "pays only for the rest").
- Where: `research.mjs:133`, `:138`, `:146`. The re-run's `finished` event is dropped as already recorded and the file is not rewritten.
- Repro (`zz1.mjs` a): tamper, stopped run, then a third run. The member ran in runs 2 and 3; 6 primary requests against 4 untampered. Its ledger records stay `[admitted, finished]` with a digest the file never matches again.
- The existing tamper test only counts sessions. Not recorded.

**F6. The 8-active cap is a default a caller can raise. DEFECT.**
- Where: `research.mjs:118` (`{...researchLimits, ...limits}`), `stages.mjs:683` and `:714` (`RES.limits`).
- Repro (`zz5.mjs`): `limits:{max_active:12}` ran 12 concurrent Hydrogen sessions (`active_peak: 12`); with no override it was 8. `max_depth: 20` throws.
- No launcher here passes limits. Not recorded.

**F7. Re-derivation of `work.research` accepts out-of-order and mismatched records. DEFECT** (controller key only).
- Where: `work-ledger.mjs:186-213`.
- Repro (`zz1.mjs` c), all accepted and verifying:
  - a conclusion for a team with no member, citing an open request that is not its team's, which closes that request;
  - a team citing a request hash on no ledger;
  - a node `finished` after the conclusion, never admitted, and again a second time;
  - a specialist under a `failed` parent;
  - a conclusion with status `cancelled`;
  - a request with trigger `whim`.
- Not recorded.

**F8. "A stopped team records no conclusion" is not what the code does. DOC OR COMMENT MISMATCH.**
- Where: `research.mjs:35-36` and `:55`; `docs/operating-workflow.md` item 8.
- Repro (`zz4.mjs`): `coordinator_rounds: 2` gave `stopped / ROUND_LIMIT`, a conclusion with `satisfied:false`, and 0 open requests. `RESEARCH_REQUEST_BUDGET` is on the same code path (read only).

**F9. Two properties have no deciding test here. CLAIM WITH NO DECIDING TEST.**
- I mutated `research.mjs:55` (dropped `status === 'cancelled' ||`) and `:181` (moved `rmSync` out of `finally`).
- `research.test.mjs` stayed 6/6; `research-lifecycle.test.mjs` failed only on the separate charge mutation below.
- Behaviour at HEAD is correct (`zz3.mjs`: cancelled run, no conclusion, 0 control dirs left, resume billed 3+2).

### 2. Checked and found sound
- **Stage charge per research request:** replacing `m.take` at `stages.mjs:714` with a no-op fails the lifecycle test (4 calls, not ≥7).
- **Billing refusal before preparation, and launcher enablement:** read the assertions only (`research.test.mjs`, `cli.test.mjs:175`, `reliability-r2-a3-rest.test.mjs:284`); not mutated.
- **Review independence:**
  - `model`: Carbon and Hydrogen are excluded and the shared lab is recorded.
  - `lab` (my run): no Google reviewer on the researched plan.
  - A Hydrogen member served by `gemini-3.8-flash` removed that pool reviewer; the row keeps both names.
  - An unresolvable served model fails closed as `REVIEW_CAPACITY_PENDING`, with a message that blames the pool.
- **Depth:** level 11 and a parentless specialist are refused by the ledger (author's test, read).
- **A team that always fails:** three attempts, three billed sessions, request stays open, then nothing dispatched (covered by L-729).
- **Request during the lifecycle, and `RESEARCH_NOT_ENABLED` / `RESEARCH_TRANSPORT`:** read the tests only; the assertions look deciding but I did not mutate them.

### 3. Not checked
- A live SDK session or jail, so F1 stops at the tool decision.
- `cli.test.mjs` and `reliability-r2-a3-rest.test.mjs` were not run.
- Whether research rows reach the change-review panel (`stages.mjs:1229`, `:1899`): read only.
- Two controllers running the same team concurrently.
- The stage charge in `researchOnGaps` (`stages.mjs:682`): not mutated.
- Already recorded and not re-tested: L-730 (`operate research` accepts an item the status ledger does not hold). A request on a Resolved item looks ignored the same way (`gates.mjs:212` returns before the research check): read only.
