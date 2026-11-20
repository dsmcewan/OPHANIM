REVIEW: research team in pantheon/ at af23623. Repros are in /tmp/claude-0/-home-user-OPHANIM/0c68b45d-d13a-54b8-88c4-e615fa8b38a0/scratchpad/review-1/pantheon/zz-review/ (repro1.mjs, repro2.mjs, real-scope.test.mjs). Scratch checkout is clean of tracked edits; nothing was changed in the two repositories beyond the worktree registration.

## 1. Findings, most severe first

**F1. A specialist's report may cite a file it never read, if any other finished member read it.** REQUIREMENT VIOLATED (evidence-backed; source identity).
- Where: research.mjs:243 passes `known` to `reportRefusal` for every node. The header (lines 24-26) and docs/routing-task-profile.md:701 say this is for the coordinator only.
- Repro (repro1 R1): specialist B examined only `src/zzz.mjs` and cited `src/a.mjs`, which A had read. B finished, its source was stamped with A's digest, and `knowledge` names B as a node that examined it.
- Tests: restricting `known` to the coordinator leaves research-team.test.mjs at 12/12, so no test decides either behaviour.
- Not recorded; L-732 states the opposite ("checks that every cited source was read").

**F2. A file that does not exist is a citable source.** REQUIREMENT VIOLATED.
- Where: turn.mjs:177 returns `kind: "missing"` as a source; :231 and :451 record it at decision time, before and regardless of the read; research.mjs:78 ignores `kind`.
- Repro on the installed runtime in the real jail (real-scope.test.mjs): `view_file src/ghost.mjs` was answered "does not exist" by the runtime, yet `examined` holds it and a report resting on it returns no refusal.
- Not recorded; L-733 covers listings and searches only.

**F3. The team's request budget restarts on every resume.** REQUIREMENT VIOLATED (shared request budget).
- Where: research.mjs:193 starts `requests` at 0; reused nodes (:300, :319) add nothing.
- Repro (R3): `max_requests: 4`; run 1 stopped `RESEARCH_REQUEST_BUDGET` at 4; resumed with its nodes, run 2 spent 4 more. The caller was charged 8.
- In production the 240 is therefore per plan attempt, not per team. Not recorded.

**F4. After a refused charge or a spent budget, the pool still starts every queued specialist.** DEFECT.
- Where: research.mjs:340-345; `runOne` (:234) checks only `aborted()`.
- Repro (R5): 10 delegations, `max_active: 2`, caller refuses the third charge only. All 10 sessions started, the caller was asked 8 more times, 9 members finished and were billed; status `stopped / STAGE_CALLS`.
- Budget variant: `max_requests: 3` gave 10 sessions started, 8 failed.
- The test "A CHARGE THE CALLER REFUSES STOPS THE TEAM WHERE IT IS … no further session is started" has one specialist and cannot see this. Not recorded.

**F5. The 8-active ceiling is not enforced by the controller.** REQUIREMENT VIOLATED when `limits` is overridden.
- Where: research.mjs:188 accepts any `max_active`; only `max_depth` is capped (:189).
- Repro (R2): Carbon coordinator with `limits: {max_active: 20}` gave an observed peak of 20 and `telemetry.active_peak` 20.
- Reachable from the launcher's `research.limits` (ophanim/operate/stages.mjs:637, 683; research.mjs there spreads it at :118). Contradicts docs/routing-task-profile.md:689. Not recorded.

**F6. A failed team still returns `material: true` and a `summary`.** DEFECT.
- Where: research.mjs:355, 364 take them from the last finished coordinator round, whatever the status.
- Repro (R6): round 2 was not JSON; result was `failed / INVALID_REPORT`, `material: true`, summary from round 1. The `conclusion` event carries the same.

**F7. Three claims have no deciding test** (each edit made, run, reverted). CLAIM WITH NO DECIDING TEST.
- "PERSISTENT BEFORE IT RUNS" (research.mjs:304): I moved the admitted record to after `runNode` had started; 12/12 pass. The test only checks admitted-before-finished.
- The `limits.max_depth` cap (:189): deleted; 12/12 pass.
- Symlink resolution in the scope check (turn.mjs:226, `real(`): removed; the 4 research tests in antigravity-turn.test.mjs pass. The behaviour itself is sound (section 2).

**F8. Report checks are weaker than "evidence-backed".** DEFECT (R8, direct calls to `reportRefusal`, all accepted).
- A dependency whose `sources` name an unread file (research.mjs:98 never checks them).
- A hypothesis with status "supported" and no supporting observation.
- A coordinator with `satisfied: true, material: true` and zero sources and observations.
- A content claim citing `.` after a listing, with a null version (this one is already recorded as L-733).
- Truth of findings is partly recorded as L-732.

**F9. Smaller.**
- research.mjs:212 does not await `charge`. An async refusing admit (R7) gave an unhandled rejection, the request was counted, and the team was `satisfied`. Production's admit is synchronous.
- Read only, not reproduced: `runOne`'s catch (:251-255) drops the `examined`, usage and served model that turn.mjs:328 attaches to the error. A failed or cancelled member's tokens are missing from telemetry, and a model that answered inside it is not a contributor.
- The digest is of the whole file at decision time; `view_file` of lines 1-1 gets the whole-file digest.

**F10. Depth is a label.** DOC OR COMMENT MISMATCH with "nested delegation" (partly recorded as L-725).
- The coordinator is level 1, so level 10 is nine delegations.
- Every level is opened by the coordinator.
- `specialistPrompt` (:159-166) gives a level-d member the gap's text only, so the parent's findings and sources do not cross the boundary downward.

## 2. Checked and found sound

- **Read-only bind:** removing the `--ro-bind` flip (turn.mjs:346) fails the "REAL JAIL, A RESEARCH SESSION" test.
- **Scope decisions** (repro2, `toolDecision` on a real policy): refused for a symlinked file or directory pointing out of scope, a symlink out of the repository, a relative path, a `file:` URI, another key spelling, a different case, and no path. Scope `./src` fails closed.
- **Installed runtime, scope `["src"]`:** `grep_search` and `find_by_name` over `src` containing symlinks to `../docs` and `/etc` returned nothing, including with `Includes: ["../docs/**"]`.
- **Tools:** write, command, `invoke_subagent`, MCP, `manage_task` and `send_message` are all refused in research mode. Restoring the native ceiling fails a test.
- **Depth:** levels 2 to 10 run and level 11 is refused and recorded (test read; baseline 12/12).
- **Budget within one run:** the bound holds under concurrency, because check, charge and count are synchronous (R3 run 1 and R5b stop exactly at the limit).
- **Contract tests:** the three research tests in antigravity-sdk-contract.test.mjs pass here against the installed SDK, including the charge-then-send order and the tools offered.
- **Routing:** code and test read, not run. Three roles on Carbon, Hydrogen subordinate, fit hash pinned.

## 3. Not checked

- Anything against the live Gemini API.
- Whether the lifecycle acts on `material` or `summary` of a failed team, and how production resume records feed F3 (lifecycle reviewer's slice).
- The gateway's charge path itself.
- Whether a real launcher sets `research.limits`.
- A file changing between the decision-time digest and the runtime's read.
