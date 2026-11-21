# Round 2 (77480d6), assignments 3 and 4, plus the credential follow-up: reconstruction notes

Totals: 0 fully KNOWN, 4 partly KNOWN, 11 DISCOVERABLE, 0 NEW.

Timing:
- Assignment questions committed 49f6be8, 2026-11-18 21:49Z.
- 77480d6 committed 2026-11-19 02:38Z.
- Assignment 4 review from 03:12Z; the runner's Antigravity run from 03:17Z.
- 492b195 (04:36Z) and 54af912 (05:01Z) come after the review.

`L#` refers to lines of the session transcript.

## A4-1: hook fails open on timeout
- **Class:** DISCOVERABLE. "Empty stdout allows" was KNOWN: stated by the owner (L12106), and recorded at jail-hook.mjs:10, workspace.mjs:20 and workspace.mjs:110.
- **Evidence:**
  - The wrapper's design (L12132) guarded against node never starting, not against node hanging while the wrapper buffered.
  - The header claims "stdin that never closes ends in a printed deny", but `finish()` never exits.
  - No test covers the stdin timeout. The closed-stdout test checks exit 0 only (agy-jail-hook.test.mjs:238-245).
  - Assignment 4 Q1 lists timeout and closed stdout.
- **Failed step:** implementation, then verification.
- **Missing capability:** enumerate every way to reach a fail-open state, and assert the decision text.

## A4-2: only the first write path is checked
- **Class:** DISCOVERABLE.
- **Evidence:**
  - The header records "FIRST PRESENT of args.Path, args.TargetFile…" but not its consequence.
  - The only mixed-argument test uses the one order that passes (:86).
  - Assignment 4 Q2 asks "Can one argument launder another?".
- **Failed step:** verification.
- **Missing capability:** turn each question into adversarial cases, both argument orders and both ownership roles.

## A4-3: provider keys inherited; A2A token readable; redaction and cleanup
- **Class:** DISCOVERABLE.
- **Evidence:**
  - The review runner already scrubbed its child env (`scrubEnv`), and agy-cli.mjs:162-163 says so, yet the pipeline passes no scrubbed base (turns.mjs:213).
  - The docs said only "Google API keys are removed".
  - The token location in mcp_config and the rule approving reads in the control dir were decided separately.
  - Assignment 4 Q7 asks about both.
- **Failed step:** planning and implementation (the sibling fix was not ported).
- **Missing capability:** trace each secret to every process and path that can read it.

## A4-4: other units' control dirs are reachable
- **Class:** DISCOVERABLE. The shared network is KNOWN and by design.
- **Evidence:** `--ro-bind / /`; control dirs live at `<run>/control/<unit>`; assignment 4 Q8 asks about another unit's socket.
- **Failed step:** planning ("read-only" was taken to mean confidential).
- **Missing capability:** threat-model the jail by readability as well as writability.

## A4-5: post-turn audit incomplete
- **Class:** DISCOVERABLE. The limit outside the worktree was KNOWN.
- **Evidence:** `inspectWrites` builds its list only from `git status`; assignment 4 Q6 lists modes, `.git` and symlinks.
- **Failed step:** verification.
- **Missing capability:** treat each list in a question as a test matrix.

## A4-6: host-change attribution
- **Class:** partly KNOWN.
- **Evidence:**
  - The coordinator chose the rule itself (L12400): a change outside the jail's reach is reported, not a failure.
  - The doc said "the writer was not established".
  - `realish` cannot see hard links.
- **Failed step:** acceptance (an unknown shown as a pass).
- **Missing capability:** keep "not attributed" separate from "verified clean".

## A4-7: /proc without a PID namespace
- **Class:** DISCOVERABLE.
- **Evidence:** the argv had `--proc /proc` without `--unshare-pid`; the bwrap tests skipped in reviewer sandboxes.
- **Failed step:** verification (silent skips).
- **Missing capability:** zero skips where bwrap works.

## A3 runner: the Antigravity reviewer could not read source
- **Class:** DISCOVERABLE. The failure class was KNOWN; only the name `read_file` was new.
- **Evidence:**
  - The same class had already happened on the write side: 1.5.10's `write_file` was denied as unknown (jail-hook.mjs:19-22).
  - Round 1 assignment 4 had already "completed" without reading source.
  - No live run of the runner's Antigravity route had ever read source.
  - The fixtures pin 1.5.10.
- **Failed step:** verification and acceptance of the runner.
- **Missing capability:** a tool-drift preflight and a coverage gate.

## A3-B1: metered failover off broken for the Google reviewer seat
- **Class:** DISCOVERABLE.
- **Evidence:**
  - `gemini-3.6-flash` has no lane, and `laneFirstTurn` goes straight to `api()`.
  - The repo contradicted itself: live-run.mjs:169 says the key "is used for nothing else"; docs and STATUS assume the seat runs on OAuth.
  - Three earlier reviews marked Q6 as holding while checking only seats that have lanes.
- **Failed step:** planning and acceptance.
- **Missing capability:** enforce billing at the point of spend; check every claim against every seat.

## A3-B2: an elapsed abort in fit implement wedges as blocked
- **Class:** DISCOVERABLE (a sibling path of round 1).
- **Evidence:** the brief named the `passed` example; 222de24 handled only `passed`/`returned`; `runPipeline` returns `blocked` on abort.
- **Failed step:** planning.
- **Missing capability:** enumerate every status a producer can return under the condition.

## A3-B3: checkpoint resume (receipt, sibling cohesion, sameModel)
- **Class:** DISCOVERABLE.
- **Evidence:** Grok at 7997657 said "the key is not a complete bind"; 09d490f enabled resume while `subagentReceipt` already read `u.a2a.calls`.
- **Failed step:** implementation.
- **Missing capability:** audit every consumer of a record that a new path produces.

## A3-B4: call-budget miscounts
- **Class:** mixed.
  - The catch-block overcharge was KNOWN (Grok at 09d490f, accepted as conservative).
  - Continuation hops were DISCOVERABLE: run-item already counted `provider_requests`.
  - The runOpenItem resume was DISCOVERABLE.
- **Failed step:** planning ("provider call" was never defined per transport).
- **Missing capability:** one written unit of count across transports.

## A3-B5: quota ladder and false-positive 429
- **Class:** partly KNOWN.
- **Evidence:** the doc called the 429/stderr heuristic undocumented; the observed fact "Gemini models share one group" was never carried into the ladder.
- **Failed step:** implementation.
- **Missing capability:** re-derive dependent designs when an observation changes.

## A3-B6: unfenced side effects; service lock in state_dir; branch ref left on restart; carried findings dropped
- **Class:** DISCOVERABLE (missed siblings of earlier fixes).
- **Evidence:**
  - The round 0 fence covered `work.spend` and `work.stage` only.
  - The round 1 restart reproduction still failed on the branch ref.
  - "One instance per work ledger" is documented, but the lock lives in state_dir.
- **Failed step:** verification (the reviewer's reproduction and its variants were not re-run).

## A3-B7: run-record omissions
- **Class:** DISCOVERABLE.
- **Evidence:** a regex on `next.why`; earlier reviewers spot-checked only the pipeline path, and their "holds" was taken as covering every stage.
- **Failed step:** acceptance.
- **Missing capability:** derive completeness structurally, with a test per stage.

## Credential isolation
- **Class:** DISCOVERABLE before round 2. After the review it was KNOWN and accepted as residual.
- **Evidence:**
  - 492b195 agy-cli.mjs:172-176: "CHOICE, recorded: the unit's own A2A token stays an explicit extra … the code the verify command runs can read it from the control dir's MCP config anyway (same uid)".
  - The commit message reads as closure ("the model's read tools cannot read the control dir").
  - The coordinator told the owner (L14356) it would keep the token in the environment, and left out the mcp_config route.
  - The constraint "a test owned elsewhere" was self-imposed; that test was later changed in 71959f8.
  - Assignment 4's last Q7 item (other same-user credential files) was neither fixed nor recorded.
- **Failed step:** acceptance. Planning had also never defined the trust boundary.
- **Missing capability:**
  - an explicit trust-boundary invariant;
  - residuals recorded with every access route;
  - no self-imposed constraints used to justify a security exposure.
