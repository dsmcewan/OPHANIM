# Assignment 4: Sandbox security

**Scope:** the Antigravity jail, filesystem permissions, credential isolation, network boundaries.
**Testing:** source inspection and the existing authorized tests only.
- You may run the existing tests listed below as they are.
- Do not write new escape attempts, exploit code or probes. Do not run `agy`, the worker probe or the layout bisect, and do not change sandbox settings.
- Where a defect needs a demonstration beyond reading the code and the existing tests, describe the reproduction in words and stop. The owner decides whether and where it is run.

## Background

- Each unit's Gemini worker runs the real `agy` CLI under `bwrap`, with a `PreToolUse` jail hook, a post-turn git-based write jail, and a per-run scratch copy of the CLI's state.
- Live evidence, from agy 1.5.10 on the owner's machine (one turn, mock subagent), is in the "First passing live worker turn" section of `docs/routing-task-profile.md`, and in `pantheon/tests/fixtures/agy-1.5.10-observed*.json`.
- Several CLI mechanics are owner-stated or observed rather than documented by Google. The docs mark each one.

## Where to look

- `pantheon/src/agy/`:
  - `sandbox.mjs`: `bwrap` binds, the state scratch copy, `jailReach`;
  - `jail-hook.mjs`: decisions and fail-closed paths;
  - `workspace.mjs`: the card, `hooks.json`, `mcp_config.json`, `jail.json`;
  - `quota.mjs`.
- In `pantheon/src/board/agy-cli.mjs`: the worker launch, argv guards, preflight and log reading.
- `pantheon/src/pipeline/a2a-shim.mjs` and `a2a-mcp-server.mjs`: the subagent relay over a Unix socket.
- In `pantheon/src/pipeline/implement.mjs` and `paths.mjs`: the post-turn write jail and reserved paths.
- `pantheon/.agents/agents/pantheon-unit-worker/agent.md`.
- `pantheon/scripts/agy-worker-probe.mjs`, `agy-layout-bisect.mjs` and `ophanim/operate/live-run.mjs`: read only.
- Existing tests you may run: `pantheon/tests/agy-*.test.mjs`, `pipeline-a2a.test.mjs`, `pipeline-mcp.test.mjs`, `pipeline-run.test.mjs`. Several use the real `bwrap` and a fake HOME.

## Questions

1. **Hook fail-closed.** Can the hook fail open? Consider a crash, empty output, a timeout, a malformed payload, an unreadable policy, a closed stdout, or an unknown tool or MCP spelling. The owner states that the CLI treats empty output as allow.
2. **Write paths.** Are all path arguments checked for every write tool, including the observed `write_file {Path}`: absolute, no traversal, no symlink escape, not in `.git` or `.agents`, inside the owned paths? Can one argument launder another?
3. **Commands.** Can anything other than the exact `cd '<worktree>' && <verify_cmd>` be approved for `run_command`? Consider quoting, whitespace, a `Cwd` argument and command injection through the worktree path or `verify_cmd`.
4. **MCP.** Is only `ask_subagent` on `pantheon-subagents`, with an allowed role, approved? Are `invoke_subagent` and `define_subagent` always denied?
5. **Writable surface.** Exactly which host paths are writable inside `bwrap`? The intended set is the worktree, the run directory, the per-run scratch copies (`antigravity-cli`, `config/projects`, `bin`) and nothing under the real home. Is the main repository's `.git` read-only? Could the worker reach the control directory's `.agents/hooks.json`?
6. **Post-turn jail.** Is there any write the post-turn git check misses? Consider ignored files, file modes, deletions, symlinks, `.git` and a moved HEAD.
7. **Credentials.** Is history withheld from the state copy? Is the copied OAuth token confined to the 0700 scratch and deleted after a run without `--keep`? Is the A2A bearer token kept out of logs, prompts and summaries? Are provider keys stripped from the worker's environment? Does any summary, preflight output or `mcp list` handling store a credential?
8. **Network.** The network is not cut, because the CLI must reach Google. What does that let the worker reach that matters (host services, cloud metadata, the A2A socket of another unit)? Is the A2A socket per unit and token-protected?
9. **Forbidden flags.** Can `--sandbox` or `--dangerously-skip-permissions` reach a worker launch by any path?
10. **Host changes.** Is the classification of host `~/.gemini` changes into reachable and out-of-reach sound? Could it hide a real escape?

## Out of scope here

Live testing of the jail. If a finding needs one, say so; the owner decides.
