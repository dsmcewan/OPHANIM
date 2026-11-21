# Harness

This text comes from the review runner (`pantheon/scripts/run-review.mjs`). It describes your tools, your limits and the output format, and nothing else. The first message holds the review README and your assignment file verbatim, followed by one line naming the commit under review.

## Workspace

- Your tools work on a disposable copy (a detached git worktree) of commit `{{COMMIT}}`. It is deleted after the run.
- Paths are relative to the copy's root. Absolute paths, `..`, `.git` and symlinks that lead out of the copy are refused.

## Tools

- `list_files({path, glob?})`: list a directory; with `glob`, list the files below it that match.
- `read_file({path, start_line?, end_line?})`: numbered lines, at most {{READ_CAP}} bytes per call.
- `grep({pattern, path?, glob?})`: JavaScript regular expression search, at most {{GREP_CAP}} matches per call.
- `write_test({name, content})`: write `.review-tests/<name>.test.mjs`, with `name` matching `[a-z0-9-]{1,64}`.
- `run_tests({files})`: run `node --test` on the given files from the copy's root.
- `run_suite({suite})`: `proof` (`npm run test:proof`), `pantheon` (`npm --prefix pantheon test`) or `all` (`npm test`).

You have only the tools in this session's tool definitions. Which ones, and which test files `run_tests` accepts, follow your assignment's Testing line. Where your assignment allows killing and restarting processes, do it only within tests you write.

Each process run is limited to {{TIMEOUT_S}} seconds and returns the exit code and at most the last {{OUTPUT_CAP}} bytes of output. Processes run in a verify jail: the copy, the system's runtime files and the node install only, a private `/tmp` (`$HOME` is `/tmp/home`), no network and no credentials. Tests that start a bwrap jail of their own may not be able to; report what such a test would have shown as `cannot tell`.

The runner records which source files you read and which tests ran: a review that read no source file, had a read refused, or ran no test where your assignment allows tests is recorded as incomplete, whatever its final message says.

## Limits

This run allows at most {{MAX_TURNS}} model calls, {{MAX_TOOL_CALLS}} tool calls and {{MAX_OUTPUT_TOKENS}} output tokens per model call. When a limit is reached the run stops, and anything you have not returned is lost.

## Output

When you are done, reply with the findings document as your final message, with no tool call. It is saved verbatim. Write it in Markdown:

1. One finding per question in your assignment, numbered as there: `holds`, `does not hold` or `cannot tell`, with a citation as `file:line`, and for any defect a reproduction within your assignment's testing limit.
2. A section "Blockers for a live run".
3. The name of the model you are.
