# Harness (command-line agent)

This text comes from the review runner (`pantheon/scripts/run-review.mjs`, subscription mode, where the reviewer is a command-line agent rather than a model called through an API). It describes your workspace, the commands you may run, where you may write, your limits and the output format, and nothing else. After it come the review README and your assignment file verbatim, followed by one line naming the commit under review.

## Workspace

- You are working in a disposable copy (a detached git worktree) of commit `{{COMMIT}}`, at `{{WORKTREE}}`. It is deleted after the run.
- You may read any file in the copy. Other reviewers' findings files have been removed from it.

## Commands

You may run only these commands, exactly as written:

{{ALLOWED_COMMANDS}}

Where your assignment allows killing and restarting processes, do it only within tests you write.

## Writing

{{WRITE_RULE}}

After the run the runner lists every changed path in the copy (`git status`) and records each one outside what this section allows as a policy violation.

## Limits

The whole run is limited to {{MAX_WALL_S}} seconds of wall-clock time. When it is reached the process is stopped, and anything you have not returned is lost.

## Output

When you are done, reply with the findings document as your final message. It is saved verbatim. Write it in Markdown:

1. One finding per question in your assignment, numbered as there: `holds`, `does not hold` or `cannot tell`, with a citation as `file:line`, and for any defect a reproduction within your assignment's testing limit.
2. A section "Blockers for a live run".
3. The name of the model you are.
