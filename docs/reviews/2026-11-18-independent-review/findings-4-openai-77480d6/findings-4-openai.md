<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->
# Review run: assignment 4, Sandbox security

- status: complete
- stop_reason: final answer
- via: subscription
- transport: codex-sdk
- cli_version: `codex-cli 0.170.0`
- auth_method_observed: chatgpt
- subscription_coverage: documented
- lab: OpenAI
- requested_model: `gpt-6-astra`
- default_reviewer: OpenAI, `gpt-6.1-sol` (the README's reviewer for this assignment)
- reviewer_override: true (--reviewer openai:gpt-6-astra)
- served_model: `gpt-6-astra`
- served_model_source: input (the CLI names no served model; this is the model the runner asked for)
- sandbox: codex permission profile ophanim-review (codex's own bubblewrap sandbox, not nested in the runner's: reads the worktree and the runtime only; writes a scratch TMPDIR outside the worktree; network cut by codex's proxy), approvals never
- policy_violations: none
- commit: `77480d6b262c92ceca5a159cc5be3e3ee627b922`
- started_at: 2026-11-19T03:12:53.695Z
- ended_at: 2026-11-19T03:15:37.498Z
- usage_totals: `{"input_tokens":672154,"cached_input_tokens":568704,"cache_write_input_tokens":0,"output_tokens":6030,"reasoning_output_tokens":761}` (as the CLI reported it)
- limits: `{"wall_clock_s":3600,"ignored":[]}`
- transcript: `findings-4-openai.transcript.json` sha256 `c2760e19381d576a7d2cc2bb9c11db9e5ea71cd859b71497f4c6caaa54671d86`
- harness_cli_template_sha256: `69402fb55cdb7246281546ce42d82ea28d3c5dbe68f646c64cd93e55d172ac36`
- harness_sha256: `05e7228061eda1b922db1a8e6e0eecf50854b198a072e68c8ad01b401092d18e`
- brief_sha256: `b857f22a980653914949d8be59296c670a0441339fb42502e89d41b5d4e98a70`
- prompt_sha256: `88ddbd8c3f88d5aa46badc7766bb3f74280fe34c9913012fec617c2558ed6009`

<!-- reviewer's final message, verbatim, follows -->

# Assignment 4 — Sandbox security

Commit reviewed: `77480d6b262c92ceca5a159cc5be3e3ee627b922` (runner-supplied pin). Git could not independently resolve HEAD because the worktree’s external Git directory was inaccessible.

Review used source inspection and authorized existing tests only. No new probes, file edits, credentials, or live provider calls.

## Findings

1. **Hook fail-closed — does not hold.**

   Malformed input, unreadable policy, unknown tools, and ordinary Node failures produce denials. The wrapper also substitutes a denial when its child exits without output (`pantheon/src/agy/workspace.mjs:105`). These cases passed the existing hook suite.

   However, the wrapper buffers all child output until the child exits (`pantheon/src/agy/workspace.mjs:111`). A stuck child or wrapper killed by the 30-second hook timeout can therefore leave the CLI with empty output—even if the child already generated a denial. The Node stdin timer generates a decision but does not terminate the process or close stdin (`pantheon/src/agy/jail-hook.mjs:363`). Closed stdout cannot deliver a denial; write failures are swallowed (`pantheon/src/agy/jail-hook.mjs:328`). Under the supplied empty-output-means-allow semantics, this is not fail-closed.

   **Reproduction:** The authorized hook suite exercises closed stdout, but asserts only exit code zero (`pantheon/tests/agy-jail-hook.test.mjs:238`). For owner-run confirmation, keep the registered wrapper’s stdin open past its timeout, or terminate the wrapper before it forwards output, and observe the CLI’s decision. This additional demonstration was not run.

2. **Write paths — does not hold.**

   Only the first non-null recognized path argument is checked, in the order `Path`, `TargetFile`, `AbsolutePath`, `File` (`pantheon/src/agy/jail-hook.mjs:130`). The selected path receives ownership, reserved-directory, and symlink checks (`pantheon/src/agy/jail-hook.mjs:136`); other arguments receive none.

   **Reproduction, described only:** Give `replace_file_content` an owned `Path` and an unowned `TargetFile`. The hook approves based on `Path`, leaving the target normally associated with that tool unchecked. Whether the CLI accepts both arguments needs owner-side confirmation; the hook’s validation gap is directly established by source. The existing test checks the opposite ordering—unowned `Path`, owned `TargetFile`—which cannot expose this defect (`pantheon/tests/agy-jail-hook.test.mjs:86`).

   Path normalization also precedes filesystem traversal (`pantheon/src/agy/jail-hook.mjs:123`). A path containing a symlink followed by `..` can have different lexical and filesystem meanings. Reject traversal components before normalization, rather than relying on the normalized pathname.

3. **Commands — holds for exact-command admission, with an execution-safety limitation.**

   The worker hook compares the trimmed command against the configured worker command and rejects a supplied `Cwd` outside the real worktree (`pantheon/src/agy/jail-hook.mjs:157`). The worktree is POSIX single-quoted, including embedded apostrophes (`pantheon/src/agy/jail-hook.mjs:68`). Leading/trailing whitespace is accepted intentionally; appended commands are rejected. Existing command tests passed (`pantheon/tests/agy-jail-hook.test.mjs:121`).

   This proves string equality, not that the allowed command is safe. `verify_cmd` is inserted verbatim as shell code (`pantheon/src/agy/jail-hook.mjs:76`), and plan validation requires only a nonempty string (`pantheon/src/pipeline/work-units.mjs:105`). Shell operators already present in that field are authorized. Further, an allowed test command executes worker-editable code without per-operation hook checks. The containment must remain effective against that code.

4. **MCP — holds for the implemented hook protocol.**

   Wrapped calls must name `pantheon-subagents/ask_subagent` and an allowed role (`pantheon/src/agy/jail-hook.mjs:246`). Explicit direct-call server identities are checked; unknown spellings deny by default. Bare recognized eager names infer the configured server (`pantheon/src/agy/jail-hook.mjs:232`), so that case depends on the CLI’s name resolution.

   Native `invoke_subagent` and `define_subagent` are denied before dispatch (`pantheon/src/agy/jail-hook.mjs:291`). The relay independently restricts tool name, arguments, and roles (`pantheon/src/pipeline/a2a-mcp-server.mjs:79`, `pantheon/src/pipeline/a2a-mcp-server.mjs:110`). Hook and observed-payload tests passed. End-to-end relay verification was blocked by the runner’s socket-path limit.

5. **Writable surface — cannot tell for the complete runtime boundary.**

   In the default configuration, the explicit host-backed writable mounts are:

   - The unit worktree.
   - `<control_dir>/run`, including its scratch files.
   - Scratch copies mounted over `antigravity-cli` and, when present, `config/projects`.
   - Within the CLI scratch, copied `bin` files and the recursively copied `builtin` tree.

   Other writable filesystem surfaces include private `/tmp` and `/dev`. The control directory is read-only except `run`; the main Git directory is bound read-only last (`pantheon/src/agy/sandbox.mjs:138`). Thus `.agents/hooks.json` is readable but not writable through its normal pathname.

   Explicit state-directory overrides and `gemini_state: "rw"` broaden this surface and can expose real-home paths (`pantheon/src/agy/sandbox.mjs:133`, `pantheon/src/agy/sandbox.mjs:315`). These are not defaults.

   Runtime confinement remains **cannot tell**: all relevant bwrap cases skipped. Also, the launch exposes `/proc` without explicitly unsharing the PID namespace (`pantheon/src/agy/sandbox.mjs:146`). Access through host-process descriptors/root links needs owner-side assessment; the mount list alone does not establish that these alternate paths are inaccessible. No escape attempt was run.

6. **Post-turn jail — does not hold as a complete write audit.**

   The audit checks moved HEAD, tracked modifications/deletions, untracked files, ignored files, and escaping symlinks (`pantheon/src/pipeline/implement.mjs:112`). Those are useful checks, but Git status is not a complete filesystem-change inventory.

   Non-executable permission-bit changes, directory metadata, and writes later restored to their original contents can escape the audit. Git metadata changes other than a changed HEAD are not inventoried. A linked worktree’s `.git` pointer file is also not an ordinary tracked file. The read-only Git mount and hook are separate preventive controls, not proof that the post-turn audit detects these changes.

   **Reproduction, described only:** In a disposable fixture, change an unowned tracked file’s permissions from `0644` to `0600` without changing its contents or executable bit, then call `inspectWrites`. Its Git-status input supplies no changed pathname, so the ownership check never sees the modification (`pantheon/src/pipeline/implement.mjs:118`). This was not executed because new fixtures are prohibited.

7. **Credentials — does not hold.**

   Several protections are present: top-level history files are excluded from the state-copy allowlist, known history directories start empty, and the scratch root is chmodded `0700` (`pantheon/src/agy/sandbox.mjs:190`, `pantheon/src/agy/sandbox.mjs:328`). Preflight output has substantial redaction, and `mcp list` records server names instead of its raw listing (`pantheon/src/board/agy-cli.mjs:488`).

   Remaining defects:

   - **Other provider keys are inherited.** `workerEnv` removes only `GEMINI_API_KEY` and `GOOGLE_API_KEY`; OpenAI, Anthropic, and xAI credentials remain (`pantheon/src/board/agy-cli.mjs:164`). The production pipeline supplies no scrubbed base environment (`pantheon/src/pipeline/turns.mjs:213`).
   - **The A2A token is model-readable.** It is written into the control directory’s MCP configuration (`pantheon/src/agy/workspace.mjs:138`), while read tools may read any path inside that directory (`pantheon/src/agy/jail-hook.mjs:218`).
   - **Redaction is not universal.** Hook logs retain raw payloads (`pantheon/src/agy/jail-hook.mjs:355`); worker records retain raw stderr tails and tool information (`pantheon/src/board/agy-cli.mjs:615`), and final JSON summaries are returned without redaction (`pantheon/src/board/agy-cli.mjs:641`).
   - **Cleanup is not guaranteed on every failure.** Scratch creation precedes argument validation, outside the later spawn cleanup handler (`pantheon/src/board/agy-cli.mjs:557`). Removal errors are silently ignored (`pantheon/src/agy/sandbox.mjs:420`).

   **Reproductions, described only:** Supply dummy `OPENAI_API_KEY` and `XAI_API_KEY` values to `workerEnv`; both survive. Request `view_file` on the generated MCP configuration; the hook approves access to the bearer token. Return that dummy token in a final JSON summary or stderr; the corresponding worker-record fields retain it. To test cleanup, prepare a fake-home scratch and supply a forbidden model argument; argument validation throws after scratch creation. No real credentials are needed.

   The read-only bind of the entire host also leaves other same-user credential files readable to code executed by the verification command (`pantheon/src/agy/sandbox.mjs:146`).

8. **Network — does not hold as an isolation boundary between units.**

   Network access is deliberately unrestricted: there is no Google-only egress rule or network namespace isolation (`pantheon/src/agy/sandbox.mjs:146`). Verification code can therefore reach host loopback services, LAN services, and cloud metadata endpoints when those are reachable from the host.

   A2A sockets are per unit (`pantheon/src/pipeline/index.mjs:91`), and POST requests require a random per-unit bearer token checked with `timingSafeEqual` (`pantheon/src/pipeline/a2a-shim.mjs:63`, `pantheon/src/pipeline/a2a-shim.mjs:87`).

   However, the host-wide read-only bind exposes other units’ control directories when outside the private `/tmp`. Read-only mounts permit reading their MCP configurations and connecting to Unix sockets. Workers run under the same host identity; file mode `0700` does not distinguish them. Consequently, the bearer token is not isolated from another unit’s executed code.

   **Reproduction, described only:** On an isolated owner fixture, create two units with control directories outside `/tmp`. From one unit’s verification process, read the other unit’s dummy MCP configuration and contact its socket using that token. No provider call is necessary; use a mock subagent. This was not run.

9. **Forbidden flags — holds for the dedicated worker launch paths inspected.**

   `workerArgv` constructs the worker options and rejects both forbidden flags, including `--flag=value` forms (`pantheon/src/board/agy-cli.mjs:139`). The assembled launch is checked again immediately before use (`pantheon/src/board/agy-cli.mjs:563`). Prompt text is deliberately excluded from flag checking.

   The pipeline calls this dedicated worker path (`pantheon/src/pipeline/turns.mjs:213`). The older board CLI helper does emit `--sandbox` (`pantheon/src/board/agy-cli.mjs:40`), but it is not the inspected pipeline worker path. Runtime bwrap launch tests skipped, so this conclusion is source-based.

10. **Host changes — does not hold as evidence excluding an escape.**

    `jailReach` classifies paths using the expected bind list (`pantheon/src/agy/sandbox.mjs:434`). The probe then treats every observed change classified outside that list’s writable reach as compatible with `gemini_state_untouched: true` (`pantheon/scripts/agy-worker-probe.mjs:165`).

    This describes expected mount visibility; it does not identify the writer. It cannot rule out writes through alternate inode aliases, host services, or an actual escape. The observed-fixture tests confirm the classification behavior, not attribution.

    **Reproduction, described only:** Create a hard-link alias of a fake host-state file inside a writable directory on the same filesystem. Write through the alias and compare snapshots. `realpath` does not identify hard-link aliases, so classification of the original host pathname can remain “outside_jail_reach” while its contents changed through a writable path. No such probe was run.

    Unexpected host changes should remain unresolved evidence unless independently attributed. They should not satisfy an “untouched” check merely because the intended jail design says they were unreachable.

## Test results and limits

| Authorized suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `agy-jail-hook` | 8 | 0 | 0 |
| `agy-sandbox` | 3 | 0 | 4 |
| `agy-worker` | 1 | 0 | 12 |
| `agy-preflight` | 9 | 0 | 4 |
| `agy-worker-probe` | 2 | 0 | 11 |
| `agy-observed-1.5.10` | 8 | 0 | 0 |
| `agy-observed-pass-1.5.10` | 3 | 0 | 0 |
| `agy-card-tools` | 4 | 0 | 0 |
| `pipeline-a2a` | 2 | 8 | 0 |
| `pipeline-mcp` | 2 | 3 | 0 |
| `pipeline-run` | 4 | 10 | 0 |

Bwrap reported `Failed to mount tmpfs`; its runtime checks are **cannot tell**, not product defects. A2A/MCP failures reported overlong Unix socket paths under the supplied `TMPDIR`; the pipeline has an explicit refusal for that condition (`pantheon/src/pipeline/index.mjs:96`). The pipeline-run failures therefore do not establish write-jail failures.

## Blockers for a live run

- Hook timeout/output failures can leave an allow-by-empty-output result.
- Conflicting write-path arguments are not rejected or fully validated.
- Provider credentials and A2A tokens are exposed to worker-executed code, with incomplete output redaction and cleanup.
- Cross-unit socket authentication lacks credential isolation.
- The complete filesystem/process boundary remains unverified.
- Git-status auditing and mount-based host-change attribution overstate what they can prove.

Lab: **OpenAI**. Model identity available to this session: **Codex, GPT-6-based**. The exact served-model identifier is not exposed here; I cannot independently attest the assignment’s requested `gpt-6.1-sol` identity.