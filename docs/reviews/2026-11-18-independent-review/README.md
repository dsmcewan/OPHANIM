# Independent review of PR #67, split into four assignments

**For:** reviewers from labs other than Anthropic, which wrote this PR. Self-review confers no approval, so nothing in this PR has been independently reviewed yet. The owner assigns each assignment to a lab (table below).

**Candidate:** PR #67, branch `ccr-aa24f0d5-336szn`. Pin the exact commit you review in your findings. The PR is a draft and is not merged.

| # | Assignment | Reviewer lab (owner, 2026-11-18) | Scope | Testing |
|---|---|---|---|---|
| 1 | [Lifecycle and evidence](1-lifecycle-evidence.md) | Google, `gemini-4-carbon` | Planning, handoffs, evidence freshness, scheduling, recovery | Local deterministic fixtures |
| 2 | [Review independence](2-review-independence.md) | OpenAI, `gpt-6-astra` | Model identity, contribution lineage, review quorum, validation | Synthetic identity and ledger tests |
| 3 | [Execution reliability](3-execution-reliability.md) | xAI, `grok-4.7` | Provider-call limits, concurrency, leases, retries, checkpoints | Mock providers and isolated processes |
| 4 | [Sandbox security](4-sandbox-security.md) | OpenAI, `gpt-6.1-sol` | Antigravity jail, filesystem permissions, credential isolation, network boundaries | Source inspection and existing authorized tests only |

The owner chooses the specific model for each assignment; record the model that actually served your review in your findings. Note for assignment 2: `gpt-6-astra` and `gpt-6.1-sol` are also the hard and medium Stage 2 dispatchers (and pinned Stage 5 reviewers) in the `fit` matrix, so OpenAI's models benefit from the arbiter rule under review; the reviewer should state that interest. Assignments 2 and 4 go to two different OpenAI models; each review is done independently, without seeing the other's findings until both are returned.

## Ground rules (all assignments)

- **No live calls.** No provider calls, no `agy` model turns, no `scripts/agy-worker-probe.mjs`, no `ophanim/operate/live-run.mjs --confirm-spend`. No credentials are needed or should be loaded.
- **Leave the owner's records alone.** Do not write to the canonical status ledger, any controller or status key, or anything outside a temporary directory you create.
- **No weakening.** Do not weaken independence, narrow scope, reduce the three-lab panel, or count synthetic labs as production capacity.
- **The owner's decisions are given.** These include the model-level rule for `fit`, the routing matrix, the dispatcher-as-arbiter rule and the Antigravity input-model marker. Judge whether the code does what they say and whether it is safe, not whether you would have chosen them.
- **The implementing agent's tests are supporting evidence, not proof.** Write your own fixtures where an assignment allows it.
- **Overlaps are fine.** Where one area touches another (a checkpoint touches both reliability and review lineage), report it under your assignment and name the other one.

## What to return

For each question in your assignment, give a finding: `holds`, `does not hold` or `cannot tell`. Cite the file and line. For any defect, include a reproduction: a test or a command sequence that runs within your assignment's testing limit.

End with a short list of the defects you would block a live run on.

Name your lab and model and the commit you reviewed. Return the findings as `findings-<n>-<lab>.md` in this directory, or as a PR comment.

## Running a review

The owner runs each assignment on their own machine with `node pantheon/scripts/run-review.mjs`. `--via` is required and has no default: it chooses between the metered API and the owner's subscriptions every time. The reviewer works on a disposable copy of the commit (in subscription mode a fresh single-commit git repository, see below) and is given this README and its assignment file verbatim, plus a fixed preamble. The runner writes `findings-<n>-<lab>.md` and its transcript to this directory. `--dry-run` prints the plan and starts no model turn.

**Subscription mode (`--via subscription`).** One command-line agent per vendor, signed in to the owner's subscription: assignment 1 runs on Antigravity (`agy`, lane `gemini-4-carbon-high`), assignments 2 and 4 on OpenAI Codex signed in with ChatGPT, driven through the official Codex TypeScript SDK (`@openai/codex-sdk`, pinned in `pantheon/package.json`, which runs the Codex CLI binary it ships), and assignment 3 on xAI's Grok Build CLI. The preamble is [HARNESS-cli.md](HARNESS-cli.md).

```
node pantheon/scripts/run-review.mjs --via subscription --assignment 1 --commit <40-hex> --max-wall-s 3600 --dry-run
node pantheon/scripts/run-review.mjs --via subscription --assignment 1 --commit <40-hex> --max-wall-s 3600
node pantheon/scripts/run-review.mjs --via subscription --assignment 2 --commit <40-hex> --max-wall-s 3600
node pantheon/scripts/run-review.mjs --via subscription --assignment 3 --commit <40-hex> --max-wall-s 3600 [--grok-state-dir ~/.grok]
node pantheon/scripts/run-review.mjs --via subscription --assignment 4 --commit <40-hex> --max-wall-s 3600
```

- `--max-wall-s` is required. It is the whole run's wall clock; with `--timeout-s` also given, the smaller one applies. The CLI's process group is killed when it is reached; for Codex, the SDK's abort signal stops the codex process. The CLIs have no turn, tool-call or output-token caps, so `--max-turns`, `--max-tool-calls` and `--max-output-tokens` are ignored, with a note.
- A dry run executes only the zero-spend preflights: for Codex, a check of the installed SDK's source (it must set `CODEX_API_KEY` only when it is given an API key, which the runner never does), then `codex --version`, `codex login status` (it must report a ChatGPT sign-in) and `codex debug models` (it must list the model), run against the codex binary the SDK will start (its own, or `--codex-cli PATH`); `grok --version` and a non-empty Grok state directory; and the jailed `agy` preflight (an in-jail `/usage` for the login and the lane's quota, the card and `agy agents`). It then prints the plan: the exact argv (the prompt as its sha256; Codex receives it on stdin from the SDK), the SDK version and options, the environment names passed and removed, the sandbox, the writable paths, and what is verified and what is assumed.
- A run that cannot start refuses (exit 1). It never falls back to the API. Every key, token and secret is removed from the CLI's environment, including `OPENAI_API_KEY`, `CODEX_API_KEY` and `XAI_API_KEY`, so a CLI cannot switch to metered billing. The Codex SDK is given that environment explicitly and never an API key or a base URL, and the CLI is told `forced_login_method="chatgpt"`, so it refuses an API-key login. `--allow-api-key-in-cli` accepts a Codex CLI that reports an API-key login. `--skip-model-check` accepts a model catalog that cannot be read.
- Sandboxes:
  - Antigravity runs in the unit worker's bwrap jail, with the PreToolUse hook enforcing a review policy. It may write only under `.review-tests/` (nothing for assignment 4), it may run only the exact test commands the preamble lists, and it has no MCP server.
  - Codex runs in its own sandbox under a permission profile the runner defines, with approval policy `never`. Its commands read only the review copy and the runtime (no home directory), write only a per-run scratch `TMPDIR` outside the copy and, for assignments 1 to 3, `.review-tests/`, and have no network (codex's proxy with no host allowed). The preflight checks with `codex debug prompt-input` that codex will apply exactly that profile. Tests that start a bwrap jail of their own cannot run inside it. The scratch `TMPDIR` is at most 48 bytes long, so the Unix sockets the tests create under it fit the 107-byte limit; `pipeline-run.test.mjs` already fails with a 60-byte one. It is a short directory under the review temp base, or under `/var/tmp` when that path would be too long; at 77480d6 a 107-byte `TMPDIR` made the A2A tests fail with `listen EINVAL`. The findings header records it as `scratch_tmpdir`.
  - Codex on WSL. Codex's own bwrap fails there before any turn: it cannot create `/run/WSL` under the profile's denied `/run`. Clearing `WSL_INTEROP` does not help. When `/proc/sys/kernel/osrelease` names Microsoft or WSL, or `WSL_DISTRO_NAME` is set, the runner starts codex through an outer bwrap namespace, the mitigation the operator used at 77480d6. In it the host is read-only, `/run` and `/tmp` are private, and only the run's temp directory, the scratch `TMPDIR` and `$CODEX_HOME` are writable. Codex then applies the unchanged permission profile, and every preflight, the exact-profile check included, runs through the same launcher. The findings header records it as `codex_outer_runtime`, with the cost: one more namespace level. `--codex-outer-runtime on|off` overrides the detection; the default is `auto`.
  - Grok runs in the runner's bwrap jail: the worktree is read-only except `.review-tests/` (assignments 1 to 3), and the CLI sees a per-run copy of its state directory.
- Grok permissions (a manual step). The jail is what confines Grok; the CLI's own permission profile decides only which tool calls it attempts. Under its default profile (`ask`), a headless run cancels every tool call no allow rule covers, and the CLI exits 0 with `stopReason: "cancelled"`. That happened to an authorized `.review-tests/` edit on 2026-11-19, and to a `wc`/`find` read in the first leg of round 2. The runner records such a run as `failed`, with a stop reason that names the cancelled tool calls and points here; any stop reason other than `end_turn` counts as unfinished. Before running an assignment on Grok, add allow rules to `config.toml` in the Grok state directory. That is `~/.grok/config.toml`, or the directory passed with `--grok-state-dir`; the run sees its own copy. Use the string form below. Grok CLI 1.0.44 loaded zero rules from the structured `rules = [{ action = "allow", ... }]` array that [docs.x.ai/build/features/permissions](https://docs.x.ai/build/features/permissions) shows, and loaded every rule of this form (observed at 77480d6). The list allows reading, editing (the jail still limits writes to `.review-tests/`, and to nothing for assignment 4), the read-only commands the preamble lists, and the listed test commands:

  ```toml
  [permission]
  allow = [
    "Read", "Grep", "Edit",
    "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(sed -n *)", "Bash(nl *)", "Bash(wc *)", "Bash(ls *)", "Bash(ls)",
    "Bash(find *)", "Bash(rg *)", "Bash(grep *)", "Bash(diff *)", "Bash(cmp *)", "Bash(file *)", "Bash(stat *)",
    "Bash(git log *)", "Bash(git log)", "Bash(git show *)", "Bash(git show)", "Bash(git diff *)", "Bash(git diff)",
    "Bash(git grep *)", "Bash(git ls-files *)", "Bash(git blame *)", "Bash(git status *)", "Bash(git status)", "Bash(git rev-parse *)",
    "Bash(node --test *)", "Bash(OPHANIM_TELOS_ROOT=* npm run test:proof)", "Bash(npm run test:proof)",
    "Bash(npm --prefix pantheon test)", "Bash(npm test)",
  ]
  ```

  The runner does not write these rules. The page documents no path patterns for `Edit`, does not say exactly how `*` matches in a `Bash` pattern (whether `Bash(find *)` also covers `find -exec`, or a piped command, is not documented), and does not say what headless `-p` does with a call that would prompt. A rule the runner wrote could therefore not be shown to stay within `.review-tests/` and the listed commands. The jail, which keeps the host and the copy read-only apart from `.review-tests/`, is the containment, and the post-run `git status` check records any write. Leave out `permission_mode = "always-approve"` and `auto`. The runner reads the file at preflight and records its `[ui]` permission mode, its `[permission]` lines and the string-form rules in the plan (`preflight.checks.permissions`) and the findings header (`grok_permissions`). It refuses to start when the file is missing, has no string-form allow rule (a structured array alone counts as zero), or sets an approve-everything mode. It warns about each allowance above that is missing, and about a structured array it does not count. `--grok-permissions-inspect "<grok arguments>"` also runs the CLI's own permission inspection, the command that gave `findings-runs-77480d6/grok-permission-inspect.json`. It runs in the same jail against a copy of the state directory, with no model turn. Its JSON must report `permissions.loaded` above zero, or the run is refused; skipped rules are warnings.
- The review copy (subscription mode) is a fresh git repository with a single commit, not a `git worktree`. At 77480d6 the worktree's `.git` file pointed into the owner's `.git/worktrees/`, which the Codex sandbox cannot read, so the reviewers could not run git. Making that directory readable would also expose the repository's history, and with it every withheld findings file of earlier rounds. The runner therefore reads the commit's tree into a temporary index, drops the withheld paths, checks out the rest and commits it in a new repository. That repository has no remote, no hooks and no history, and the commit message names the source commit and tree. The commit uses a fixed author and the source commit's date, so the same tree gives the same commit id. The runner then compares the copy's `git ls-files -s` with the source's `git ls-tree -r`, path by path: each mode and blob id must match, apart from the withheld paths. Any mismatch refuses the run. The findings header records the result as `review_copy`.
- After every run the runner compares `git status` of the worktree with its state before the run. A changed path outside `.review-tests/` (any change for assignment 4), or a moved HEAD, is recorded under `policy_violations`, and the status becomes `policy_violation`.
- A failure Codex reports (a `turn.failed` event, or an error raised by the SDK) makes the status `failed`, with Codex's message as the `stop_reason`. A Grok turn that ends with a `stopReason` other than `end_turn` is `failed` too, whatever the CLI's exit code.
- Grok's answer is read from its `streaming-json` events as observed on grok 1.0.44: the `{"type":"text","data":...}` chunks after the last tool event, joined in order. Reasoning (`thought`) events never count.
- The findings header records `via`, `transport`, `cli_version`, `auth_method_observed`, `served_model_source: input` (no CLI names the model that served), `subscription_coverage`, `sandbox`, `review_copy`, for Codex `codex_outer_runtime` and `scratch_tmpdir`, and for Grok `grok_permissions`. `subscription_coverage` is `documented` for Codex and Antigravity. It is `undocumented` for Grok: xAI does not say whether a SuperGrok or X Premium subscription covers CLI usage.

**Another reviewer (`--reviewer <lab>:<model>`).** Either mode can run an assignment on a reviewer other than the one in the table, for example `--assignment 3 --reviewer google:gemini-4-carbon`. The lab is `google`, `openai` or `xai`, and it chooses the transport exactly as for that lab's own assignments: the Gemini API or `agy`, the OpenAI API or Codex (with the ChatGPT-only guard), the xAI API or the Grok CLI. Everything else is the assignment's own: the brief, the withheld findings, the tools, the write rule (nothing for assignment 4, only `.review-tests/` for 1 to 3) and the worktree check. The model is checked as for that lab (the Codex model list, the Antigravity lane). The findings are named by the lab that ran (`findings-<n>-google.md` for a Google reviewer), and the header records `lab`, `requested_model`, `default_reviewer` and `reviewer_override: true`. `--continue` refuses a transcript whose override differs.

**API mode (`--via api`).** The metered API, with the owner's key in `OPENAI_API_KEY`, `XAI_API_KEY` or `GEMINI_API_KEY`. The preamble is [HARNESS.md](HARNESS.md).

```
node pantheon/scripts/run-review.mjs --via api --assignment <n> --commit <40-hex> --max-turns N --max-tool-calls N --max-output-tokens N --timeout-s N [--dry-run]
```

**Continuing an incomplete review (`--continue`).** Add `--continue <findings-<n>-<lab>.transcript.json>` to the command, in either mode, to resume an `incomplete` review instead of starting over:

```
node pantheon/scripts/run-review.mjs --via api --assignment 2 --commit <40-hex> --max-turns 40 --max-tool-calls 200 --max-output-tokens 32000 --timeout-s 600 --continue docs/reviews/2026-11-18-independent-review/findings-<n>-openai.transcript.json
node pantheon/scripts/run-review.mjs --via subscription --assignment 1 --commit <40-hex> --max-wall-s 3600 --continue docs/reviews/2026-11-18-independent-review/findings-<n>-google.transcript.json
```

- The transcript must be for the same assignment, lab, model, `--via` (and transport) and commit. Its findings file must say `status: incomplete` (or `status: failed`, in subscription mode) and name the transcript's sha256, and the README and the assignment file must be unchanged since that run. Otherwise the run is refused. Transcripts written before this feature are refused too: they lack the reviewer's `.review-tests/` files and the full tool results.
- The new limits are the ones passed now, and they may be higher. The findings header adds `continued_from` (the earlier transcript's sha256), `continuation_method`, `runs` and the cumulative usage and calls. The earlier pair is kept as `findings-<n>-<lab>.prev-<sha12>.md` and `.transcript.prev-<sha12>.json`.
- The worktree is rebuilt at the same commit, and the files the reviewer wrote under `.review-tests/` are restored.
- How each transport continues:
  - OpenAI over the API continues from the last response id (`previous_response_id`), sending the pending tool outputs.
  - Gemini and xAI over the API replay the recorded conversation.
  - A reply that was cut off is kept, and the model is asked for the complete document.
  - Antigravity resumes its own conversation (`--conversation <id>`), with the conversation state an incomplete run saved beside its transcript (`findings-<n>-google.agy-state/`).
  - Codex resumes its own thread (the SDK's `resumeThread`, with the thread id from the transcript), working in the rebuilt worktree with the same sandbox. This needs the thread's session file in `~/.codex/sessions` on the same machine.
  - Grok (no documented resume), and Codex when that session file is missing, start a new session. Its prompt is the same preamble, README and assignment, plus a delimited appendix of the reviewer's own earlier messages and tool results from that transcript, and nothing else.

## Running the existing suites

From the repository root:

- `OPHANIM_TELOS_ROOT=<telos checkout> npm run test:proof` (the lifecycle suite);
- `npm test` (Pantheon, the ledger and the model client).

Both should report 0 failures. Assignment 4 may run only the existing tests its file lists.

## Out of scope for every assignment

- The owner's choice of models and labs.
- Live model quality.
- Production operation.
