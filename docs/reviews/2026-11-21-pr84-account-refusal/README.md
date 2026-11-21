# Independent review of PR #84: the stop on a provider refusing the account

**For:** reviewers from labs other than Anthropic, which wrote this PR. Self-review confers no approval, and a green
build is not a review, so nothing in this PR has been independently reviewed yet.

**Candidate:** PR #84, `dsmcewan/OPHANIM`, branch `ccr-aa24f0d5-336szn`, at exactly
`b42c49e99f5140eb2e616af7694f943d5b9d0420`. Its base is `main`; the merge base it is judged against is
`ba3f03862f3e452f4db4f5891a1c288ebbc5cc6e`. The PR is a draft and is not merged. The merge decision is the owner's.

| # | Assignment | Reviewer lab (owner, 2026-11-21) | Scope | Testing |
|---|---|---|---|---|
| 1 | [The account-refusal stop and the seven lessons](1-account-refusal.md) | xAI, `grok-4.7` | The stop on an account refusal, the attempt count, recovery, the rate-limit control, the corrections record's additions | Mock providers and isolated processes |

There is one assignment, and every lab of the panel reviews all of it, separately: xAI (`grok-4.7`), Google
(`gemini-4-carbon`) and OpenAI (`gpt-6-astra`). The table names xAI because the runner's table takes one reviewer per
row. The other two run the same assignment with `--reviewer`. Report the lab and the requested model from the
runner. Record the served model only if the transport attests to it. Otherwise report it as unknown.

## Ground rules

- **No live calls.** No provider calls, no `agy` model turns, no `ophanim/operate/live-run.mjs --confirm-spend`, no
  `ophanim/operate/cli.mjs watch` against real seats. No credentials are needed or should be loaded. Every provider
  error you need is one you script.
- **Leave the owner's records alone.** Do not write to the canonical status ledger, any controller or status key, or
  anything outside a temporary directory you create.
- **No weakening.** Do not weaken independence, narrow scope, reduce the three-lab panel, or count synthetic labs as
  production capacity.
- **The owner's decisions are given.** The owner asked for this stop on 2026-11-21 ("in order to have those there needs
  to be a stop somewhere") after a run's planner calls were refused for the account's credit and the item's plan
  attempts were spent on it. Judge whether the code does what the PR says and whether it is safe, not whether you
  would have designed it so.
- **The author's tests are supporting evidence, not proof.** Write your own fixtures; the testing limit allows it.
- **You review alone.** The other labs' findings are not in your copy, and are released to the owner only after every
  reviewer has finished.

## What to return

For each question in the assignment, give a finding: `holds`, `does not hold` or `cannot tell`. Cite the file and line.
For any defect, include a reproduction: a test or a command sequence within the testing limit.

Then:

- **Tests run:** every test command you ran, exactly as you ran it, with its exit code and what it showed. A test you
  wrote is named by its file under `.review-tests/`. Write `none` if you ran none, and why.
- **Unresolved questions:** what you could not settle, and the evidence that would settle it.
- **Blockers for merging:** the defects you would block merging this PR on, or `none`.

Include the reviewed commit in your findings.

## Running this review

Use a Linux runner with the three authenticated subscription clients, working verification jails, and a checkout
that contains this brief and the bound commit. A cloud runner can run the same command. Add `--dry-run` first
to check this host’s bindings and subscription prerequisites. A completed panel requires live findings from all three labs.

```
node pantheon/scripts/review-pr.mjs --binding docs/reviews/2026-11-21-pr84-account-refusal/binding.json \
  --telos-root <telos checkout> --max-wall-s 3600
```

- The binding record (`binding.json`) names the PR, its base, its head and this brief by sha256, and the panel. Before
  anything is dispatched, the action checks every binding: the head is in the checkout and is still the PR's head on
  `origin`, the merge base with `origin`'s `main` is the bound one, this directory's files are the bound ones, and the
  panel is three distinct labs, none of them the author's. Any mismatch refuses, and nothing runs.
- Each lab then runs, one after another, through `pantheon/scripts/run-review.mjs --via subscription` (Pantheon's
  review runner and its sandboxes, signed in to the owner's subscriptions), each in its own disposable copy of the head.
  Each run's output is kept in a private directory under `/tmp`, which no reviewer's sandbox can see. Only after the
  last reviewer finishes are the findings released, into `findings-<head12>-<run>/` in this directory, with a
  `result.json` that records, per lab, its status, why, the tests the runner saw it run, and its own "Tests run" and
  "Unresolved questions" sections.
- A timeout, a refusal to start (a sign-in the CLI does not have, for one) and missing evidence each leave that lab's
  review **incomplete**, recorded with the reason. So does the runner's coverage gate: a review that read no source
  file, or ran no test where the testing limit allows tests, is incomplete.
- **How each lab's tests run.** Every test runs in the runner's verify jail (no network, no credentials, its own process
  namespace) on the review copy of the head, never in a reviewer's own sandbox.
  - **xAI and Google** run the review's verify launchers themselves.
  - **OpenAI** runs on Codex, signed in to the owner's subscription. Codex's own sandbox cannot start the verify jail
    (register L-404), so its tests are **relayed**: Codex picks a test from the authorized list, the runner checks it
    against the review's test policy, runs it in the verify jail, and returns the result to Codex to judge
    (`pantheon/src/review-runner/relay.mjs`). The transcript and `result.json` record, per relayed test, who requested
    it, which runner executed it, its result, and what Codex concluded. A relayed test that ran and that Codex did not
    conclude on leaves the review incomplete.
  - No lab runs on the metered API.
- `--dry-run` checks the bindings and prints each lab's run-review plan, and runs nothing.

## Out of scope

- The owner's choice of models and labs.
- Live model quality.
- Merging.
