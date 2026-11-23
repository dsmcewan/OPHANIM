# Harness (command-line agent)

This text comes from the review runner (`pantheon/scripts/run-review.mjs`, subscription mode, where the reviewer is a command-line agent rather than a model called through an API). It describes your workspace, how you read the source, the commands you may run, where you may write, the sandbox, your limits and the output format, and nothing else. After it come the review README and your assignment file verbatim, followed by one line naming the commit under review.

## Workspace

- You are working in a disposable copy of commit `{{COMMIT}}`, at `{{WORKTREE}}`. It is deleted after the run.
- Other reviewers' findings files have been removed from it.
- The copy is a fresh git repository with one commit. That commit holds the files of `{{COMMIT}}` except the removed ones, and its message names `{{COMMIT}}` and that commit's tree. The source repository's history is deliberately absent, so `git log` shows only this one commit and its id differs from `{{COMMIT}}`. Every file's blob id equals the source commit's: the runner checked `git ls-files -s` against the source's `git ls-tree -r` before the run.

## Reading the source

{{READ_RULE}}

## Commands

Apart from reading, you may run only these test commands, exactly as written:

{{ALLOWED_COMMANDS}}

Run no other command that executes code, builds, installs or changes anything. Where your assignment allows killing and restarting processes, do it only within tests you write. Make no network request and no call to a model provider, from a command or from a test.

The test commands above run the code under review in a separate verify jail, never as your own child; when the list says `none`, no test can run in this transport, and it says why. The runner records which source files you read and which tests ran: a review that read no source file, had a read refused, or ran no test where your assignment allows tests is recorded as incomplete, whatever its final message says.

## Writing

{{WRITE_RULE}}

After the run the runner lists every changed path in the copy (`git status`) and records each one outside what this section allows as a policy violation.

## Sandbox

{{SANDBOX_NOTE}}

## Limits

The whole run is limited to {{MAX_WALL_S}} seconds of wall-clock time. When it is reached the process is stopped, and anything you have not returned is lost.

## Output

When you are done, reply with the findings document as your final message. It is saved verbatim. Write it in Markdown:

1. One finding per question in your assignment, numbered as there: `holds`, `does not hold` or `cannot tell`, with a citation as `file:line`, and for any defect a reproduction within your assignment's testing limit.
2. A section headed exactly `## Tests run`: every test command you ran, exactly as you ran it, its exit code and what it showed; a test you wrote is named by its file under `.review-tests/`. Write `none` and why if you ran none. The runner keeps its own record of what ran; this section is your account of it.
3. A section headed exactly `## Unresolved questions`: what you could not settle, and the evidence that would settle it. Write `none` if there are none.
4. A section headed exactly `## Blockers for merging`: the defects you would block merging this PR on, or `none`. The merge decision is the owner's.
5. The name of the model you are.
