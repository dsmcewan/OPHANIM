# Self-audit by the coordinating lab (Anthropic), not independent; commit af0dc30; written before round 3 findings

Assignment 4 — Sandbox security. Commit reviewed: `af0dc3012688703ccac0f6de31836822a3279eae`
("Merge credential isolation: the verify jail"). Audited in a detached worktree at that commit.
Node 24.22.1, bwrap 0.9.0, git 2.43.0. `pantheon` has no `node_modules`; the modules audited import
nothing outside the repo, so the authorized suites and real-bwrap probes ran without `npm ci`.

This is NOT an independent review. Anthropic wrote the PR under review. This is the lab's own
adversarial pre-check before the round-3 external reviewers return. Verdicts are not softened; where a
control genuinely holds at this commit I say so and name the test that would fail otherwise, and where
a residual exposure remains I name it even when the owner has documented it.

Context this commit sits in: the two earlier assignment-4 reviews (`findings-4-openai-77480d6`,
`findings-4-openai-09d490f`) returned "does not hold" on questions 1, 2, 6, 7, 8 and 10. This commit is
the response: `pantheon/src/agy/verify-jail.mjs` (new), the all-targets write check, the snapshot
write-jail, the line-buffered hook wrapper, the env allowlists, and the credential-isolation doc section
(`docs/routing-task-profile.md`, "Credential isolation (2026-11-19)"). My job was to check the fixes are
real and complete.

Tests run (all pass): `agy-jail-hook` (8), `agy-sandbox` + `agy-sandbox-r2a4` (real bwrap),
`verify-jail-credential-isolation` (38 tests, real bwrap, including a 56 s worker-path probe and a 15 s
controller-path probe that find no credential jailed and every credential unjailed).
Repro script: `repro-4/hook-decide-probes.mjs` (pure `decide()` probes; no bwrap needed).

---

## Enumeration: every spawn site that can run worker- or reviewed-code

From `grep -n "spawn|exec|execFile|spawnSync"` over `pantheon/src` and `ophanim/operate`, cross-checked
against the doc's own spawn-site table:

1. **Worker `run_command`** → hook approves only `<ctl>/pantheon-verify` → `verify-jail.mjs launch()`
   (bwrap). Worker-controlled.
2. **Controller ground truth** `pipeline/review.mjs runVerify` → `node verify-jail.mjs --inline` (bwrap).
   Runs the unit's `verify_cmd` = worker-controlled.
3. **Operate validate** `ophanim/operate/stages.mjs:1380` → `node verify-jail.mjs --inline` on the clean
   checkout's acceptance/regression commands = worker-written code.
4. **Review runner agy reviewer** `review-runner/agy.mjs` + `cli-common.mjs launcherCommands` →
   `<ctl>/pantheon-test`, `<ctl>/pantheon-suite-<name>` → `verify-jail.mjs` (`test_files`). Reviewed code.
5. **agy CLI itself** `board/agy-cli.mjs runAgyWorkerTurn` (bwrap, `sandbox.mjs`). Credential-bearing,
   trusted; its worker-controlled tool calls are mediated by the hook.
6. **Subagent / planner over agy** `sdk/agy-turn.mjs` + `board/run-item.mjs` → `board/agy-cli.mjs
   runAgyCliTurn` — see Q7/Q9 below: this path runs the real CLI **unjailed** (no bwrap), with full
   `process.env`, and deliberately passes `--sandbox`. Input is trusted for the planner but is
   **partly worker-controlled for a subagent** (the question text). Containment rests entirely on the
   subagent card advertising no write/run tool.
7. **Review runner codex / grok transports** (`review-runner/sandbox.mjs`, `codex.mjs`, `grok.mjs`) —
   reviewed tests in codex's/grok's own sandbox, not the verify launcher (doc remaining-exposure #4).
8. Trusted-program/trusted-input: `git.mjs`, operate git/tar, `quota.mjs`, preflight subcommands,
   `acceptance.mjs` (its own `--unshare-all` jail).

The two paths that matter for "is the invariant actually enforced" and are **not** the verify jail are
#6 and #7. Both are named in the doc, but #6's subagent case is understated (Q7).

---

## Per-question answers

### 1. Hook fail-closed — **holds** (for every failure mode the module controls).

Fix verified. Node hook (`jail-hook.mjs`): empty output is never produced — every path prints exactly
one `auto_approve`/`deny` line. Stdin that never closes → deny after `STDIN_TIMEOUT_MS` (10 s) then
`process.exit()` (`:537-541`). Unwritable stdout → `WRITE_FAILED_EXIT` (3), not an empty allow
(`:492-494`). `uncaughtException`/`unhandledRejection`/`exit` all fail closed (`:497-499`). Malformed
JSON, unreadable policy, missing policy fields, unknown tool, unknown/newly-advertised tool name, unknown
MCP spelling → deny (`decide`/`decideUnsafe` `:435-453`; confirmed in `repro-4`).

The wrapper (`workspace.mjs hookWrapper` `:129-163`) is the fix to the 77480d6 "does not hold": it reads
node's stdout **line by line** and forwards the first decision line at once; a watchdog `kill -9`s node
after `WRAPPER_TIMEOUT_S` (20 s) < the CLI's 30 s `HOOK_TIMEOUT_S` and prints its own deny; nothing / a
partial line / a crash → deny. So a node stuck past 30 s can no longer leave an empty stdout.

Residual, not a module defect: if the **CLI itself closes the wrapper's stdout**, the wrapper's `printf`
fails (`exit 3`) and the CLI, by the owner-stated semantics, reads empty output = allow. This is inherent
to a stdout-as-decision hook protocol and is outside anything `jail-hook.mjs`/`workspace.mjs` can
prevent; the 30 s window and the double timeout make it require the CLI to actively discard the pipe.
Tests that would fail if the fix regressed: `agy-jail-hook.test.mjs` (stdin-timeout, write-failure,
unknown-tool, malformed cases). The existing closed-stdout test asserts only exit code (noted at
77480d6); I did not add a live wrapper-timeout harness (no new bwrap-level hook fixture was needed to
confirm the source paths).

### 2. Write paths — **holds**.

Fix verified. `writePathArgsOf` (`:226-249`) now walks **every** path-like argument (the four
`WRITE_PATH_KEYS` at top level, plus any `*path|file|dir|target|uri` key at any depth, plus any top-level
string that looks like a path under a non-content key), and `decideWrite` (`:253-264`) checks them all,
denies if they resolve to **different** files ("conflicting targets"), and requires each to be absolute,
`.`/`..`-free as written (`traversalOf`, pre-normalization `:270-271`), inside the worktree, not in
`.git`/`.agents`, not through a final symlink, with every intermediate symlink resolved, and matched by
`owned_paths` both as written and as resolved. `repro-4` confirms: owned `Path` + unowned `TargetFile`
→ DENY; owned `Path` + unowned nested `DestinationPath` → DENY. The 77480d6 laundering defect is closed.
Test that would fail otherwise: `agy-jail-hook.test.mjs` "question 2". (My repro's `..` line is moot —
Node `path.join` collapses `..` before the hook sees it; the suite uses literal-string traversal.)

### 3. Commands — **holds** (string-exact admission; content contained by the jail, as designed).

`decideCommand` (`:287-302`) approves only a `CommandLine` that equals the policy's `worker_verify_cmd`
exactly, which `isVerifyLauncher` forces to be `<control_dir>/pantheon-verify`; any `Cwd` must `realpath`
to the worktree. Trailing `; rm` etc. → DENY (`repro-4`). The plain `cd … && verify_cmd` is denied (it
would run as agy's child). `verify_cmd` itself is constrained to the safe form at plan validation
(`work-units.mjs:109` → `verifyCmdProblem`) **and** re-checked in `workerVerifyCommand`: no
`; | || & > < ( ) { } $ \` \ # ~` outside quotes (`repro-4`). It does not make the content safe —
`sh -c '...'` passes the safe form — but that is explicitly what the bwrap verify jail contains, and the
command only ever runs inside it. No command injection via the worktree path: it is POSIX single-quoted
(`shQuote`). Test: `agy-jail-hook.test.mjs` command cases + `pipeline-work-units.test.mjs`.

### 4. MCP — **holds**.

Only `pantheon-subagents/ask_subagent` with a role in `policy.roles` is approved, in both the
`call_mcp_tool` wrapper form and the direct/eager form (`decideMcp` `:394-403`, `mcpCallOf` `:419-427`).
`invoke_subagent`/`define_subagent` → hard deny before dispatch (`HARD_DENY`, `:439`). Any other server,
tool, or role, and any unrecognized-but-MCP-shaped name → deny (`mcpOf` default). Confirmed in `repro-4`.
Defense in depth at the relay (`a2a-mcp-server.mjs`): tool name fixed to `ask_subagent`, args
`{role,question}` only, role enum enforced, and at the shim (`a2a-shim.mjs`): bearer token
(`timingSafeEqual`), unit-id match, role allowlist, call/byte bounds, `message/send` only. Test:
`agy-jail-hook.test.mjs` MCP cases, `pipeline-mcp.test.mjs`, `pipeline-a2a.test.mjs`.

### 5. Writable surface — **holds for the intended set; residual is agy's read-only view of the whole host**.

`bwrapArgs` (`sandbox.mjs:127-174`): `--ro-bind / /` then writable = the worktree, `<ctl>/run`, the
gemini scratch copy (`antigravity-cli`, `config/projects`, `bin`, `builtin`), explicit `agy_state_dirs`,
`/tmp` tmpfs, `/dev`. The main repo `.git` is `--ro-bind` **last** (`:157-159`), so no commit/ref move.
The control dir is `--ro-bind` (`:153`), so `.agents/hooks.json` is readable but **not writable** — the
worker cannot disable its own hook. Other units' control dirs are hidden by a tmpfs
(`siblingsHidden`). Nothing is created under the real home. Confirmed by `agy-sandbox` (real bwrap):
"inside the sandbox the worker writes its worktree and run/, nothing else".

Honest residuals (not defects; the trusted CLI needs them): (a) the **entire host is readable** to the
agy process (trusted), so same-uid credential files are readable by agy — this is why worker-controlled
**code** is moved into the verify jail (allowlist), where they are not. (b) The worker bwrap keeps
`/proc` with `--unshare-pid` (fresh `/proc`, no host PIDs) but it does **not** `--unshare-net`
(by design, Q8). (c) `gemini_state: "rw"` or explicit `agy_state_dirs` override widens the surface and can
expose real-home paths — not a default. Test that would fail otherwise: `agy-sandbox.test.mjs`
bwrapArgs/read-only-.git cases.

### 6. Post-turn jail — **holds**.

Fix verified. `inspectWrites` (`implement.mjs:168`) checks moved HEAD, `git status` (tracked,
untracked, ignored, deletions), **and** a pre/post `snapshotTree` comparison (`:118-155`) that catches
what git cannot: mode-only change keeping the exec bit, directory metadata, a write restored to original
bytes (via ctime + owned-file content hash), a hard link made to a file (nlink), and the `.git` pointer
file (`GIT_POINTER_CHANGED`). The 77480d6 "0644→0600" defect is closed. Confirmed by `agy-sandbox-r2a4`
"question 6": mode-only, restored-bytes, hard-link, chmod'ed-dir, touched-.git all flagged and discarded;
owned writes still pass. A worker-spawned background daemon cannot outlive the snapshot: worker code runs
only via the verify launcher, whose bwrap is `--die-with-parent` and whose process group is killed on
turn end. Test: `agy-sandbox-r2a4.test.mjs` question-6 cases.

### 7. Credentials — **holds for the worker/verify path; one residual on the subagent-over-agy path**.

Worker/verify path, all verified (real-bwrap `verify-jail-credential-isolation` probe finds nothing
jailed, everything unjailed):
- History withheld from the state copy: `GEMINI_CLI_COPY` allowlist copies only settings/token/id/
  pbtxt/timestamp; `history.jsonl`, `conversation_summaries.db`, `jetbox_summaries_proto.pb` recorded by
  name/size only (`sandbox.mjs:244`, `copyLevel`).
- OAuth token confined to a 0700 scratch and removed after the run; a failed removal is **surfaced**
  (`removed:false`, `removal_error.contains_credentials:true`), not swallowed (`dropGeminiState`
  `:471-476`). `--keep` records `kept_contains_credentials`.
- A2A bearer token kept out of env/config/logs: in `<ctl>/a2a.token` (0600); MCP config names only
  `PANTHEON_A2A_TOKEN_FILE`; `workerEnvOf` drops every secret-named extra incl. the token; the turn
  adapter strips `PANTHEON_A2A_TOKEN` (`turns.mjs:206`); hook/record/summary redaction via `redact.mjs`;
  the read tools deny the whole control dir (`decideRead` `:360-377`). Confirmed in `repro-4` and the
  "A2A token redacted from stderr_tail, tool_steps, jail_log, text and JSON summary" test.
- Provider keys stripped from the production worker env: `turns.mjs:206` passes
  `base_env: workerEnv()`, an allowlist that drops `*_API_KEY` and secret-named vars (the 77480d6
  "other provider keys inherited" defect is closed for the worker path).
- The verify jail scrubs env (`verifyEnvOf`), hides all homes/`~/.gemini`/secret dirs, replaces git
  configs (no remote-URL token), hides FETCH_HEAD/logs/remotes, `--unshare-net`, fresh `/proc`.

**Residual (and a gap in the stated remaining-exposure list):** the subagent-over-agy transport
`sdk/agy-turn.mjs` → `runAgyCliTurn` (`board/agy-cli.mjs:38-50`) runs the real CLI **unjailed** with
`env = { ...process.env }` minus only the two Google keys — so `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`XAI_API_KEY` are present — and deliberately passes `--sandbox`. Its input is partly worker-controlled
(the implementer's question text relayed through the A2A shim). Containment rests **entirely** on the
subagent card exposing no write/run tool; the worker env allowlist (`workerEnvOf`) is **not** applied
here, and this is not the bwrap worker jail nor a verify jail. It is a text-only turn today (no code
execution, so no exfiltration channel), which is why I do not mark Q7 "does not hold" — but the doc's
"Credential isolation" invariant ("worker-controlled content … must not be able to obtain or disclose a
credential") and its remaining-exposure list do **not** mention that a subagent question reaches a
full-credential, `--sandbox`-only CLI. If any agy default or card change ever gave that seat a tool, the
provider keys are right there. This belongs on the remaining-exposure list.

### 8. Network — **holds for untrusted code; agy's own egress is unrestricted by design**.

Worker bwrap does **not** `--unshare-net` (the CLI must reach Google), so the **agy process** can reach
host loopback, LAN, 169.254.169.254 and any visible socket. But worker-controlled **code** runs only in
the verify jail, which `--unshare-net`s (only its own loopback; no host loopback, LAN, metadata, or
host abstract sockets; no path socket outside the worktree), and a policy asking for `network` is refused
(`checkPolicy` `:296`). A2A sockets are per unit (`index.mjs` `<run>/control/<unit_id>/a2a.sock`) and
bearer-token-protected (`timingSafeEqual`); sibling control dirs are hidden in the worker jail and in the
verify jail. Confirmed by the credential-isolation probe (tries a host TCP listener, a host abstract
socket, and 169.254.169.254:80, finds none jailed, all unjailed). Residual (by-design, inherent):
the trusted agy process has unrestricted egress, so a prompt injection into agy — not its tool-mediated
code — could drive network calls; bwrap has no egress filter. This is the stated design, not a defect.

### 9. Forbidden flags — **holds for every worker/review launch; residual on the planner/subagent path**.

`workerArgv` → `assertWorkerArgv` (`agy-cli.mjs:146-166`) rejects `--dangerously-skip-permissions` and
`--sandbox`, both bare and as `--flag=value`, skipping the `--print` payload. The review runner's agy
reviewer uses the same `workerArgv`. So no worker or review launch can carry either flag. The planner/
subagent path `runAgyCliTurn` (`:40`) **does** emit `--sandbox` on purpose — but it is the CLI's own
sandbox for a non-bwrap, trusted-card turn, not a worker launch, and does not bypass any Pantheon jail
(there is none on that path to bypass). No path reaches a **worker** with a forbidden flag. Test:
`agy-worker.test.mjs` / preflight argv assertions.

### 10. Host changes — **holds** (and the module is honest about its limit).

`jailReach` (`sandbox.mjs:490-515`) classifies a host path against the actual bind list and — the fix to
the 77480d6 hard-link gap — returns `unresolved` (never "outside the jail's reach") for a regular file
with `nlink > 1`, since realpath cannot name an alias that may sit under a writable bind. The probe
(`agy-worker-probe.mjs`) treats classification as **evidence**, not attribution; the doc and the module
comment both say a change outside the expected writable reach is unresolved evidence, not proof the jail
is innocent. This does not hide a real escape because a multi-link file is explicitly never cleared. The
classification is sound; it does not over-claim. (No live probe was run — read-only per the brief.)

---

## Is the stated "remaining exposure" list complete, and do the docs overclaim?

The doc lists 5 remaining exposures (agy's other tool processes; what the allowlist itself exposes; no
network→no install; codex/grok transports; same-uid processes outside both jails). Two omissions:

- **Not listed:** the subagent-over-agy transport (`sdk/agy-turn.mjs`/`runAgyCliTurn`) running unjailed
  with all provider keys in env and `--sandbox`, on partly worker-controlled question text (Q7/Q9). The
  list covers "agy's own tool processes" for the **worker** jail but not this separate unjailed CLI
  launch for subagents.
- **Understated:** item 1 ("agy's own tool processes other than run_command") is framed as the worker
  bwrap jail only; the same reasoning (an undocumented agy tool that runs worker-chosen content without
  passing the hook) applies, and there the env is the full credential-bearing set.

Docs do **not** otherwise overclaim: the invariant is stated carefully ("per-unit scoping and the
subagent call bound are safeguards, not isolation"), the verify-jail table matches the code, the
"First passing live worker turn" section marks owner-stated vs observed facts, and the live-run turn
is honestly flagged as not-yet-exercised for the CLI's own command sandbox and the lazy MCP path.

---

## Blockers for a live run

None of the round-2 "does not hold" items survive at af0dc30 as code defects — the verify jail, the
all-targets write check, the snapshot audit, the hook wrapper and the env allowlists close them, and the
authorized real-bwrap suites prove it. Remaining items a live run should carry a note on (not hard
blockers, but the owner should decide):

1. **Subagent-over-agy env is not scrubbed and the path is unjailed** (Q7/Q9). Provider keys
   (`OPENAI_/ANTHROPIC_/XAI_`) reach `runAgyCliTurn` with `--sandbox`, relying solely on the subagent
   card having no tool. Apply `workerEnvOf` to this path too, or route it through a jail, and add it to
   the remaining-exposure list. This is the one item I would want resolved or explicitly accepted before
   a live run that uses agy-served subagents.
2. **Agy's unrestricted egress** (Q8) and **agy's read-only view of the whole host** (Q5) are inherent
   to running the real CLI; they are the reason untrusted code is in the verify jail, but a prompt
   injection into agy itself is unmediated. Accept as design or add an egress filter.
3. **codex/grok review transports** still run reviewed tests in their own CLI sandbox, not the verify
   launcher (doc remaining-exposure #4) — not an agy path, owner-named, bounded plan exists.
4. **Hook wrapper vs a CLI that closes the wrapper's stdout** (Q1): untestable from the module; the
   30 s + 20 s + 10 s timeout stack makes it require the CLI to actively discard the pipe.

Lab: Anthropic (coordinating lab — self-audit, confers no independent approval). Commit af0dc30.
