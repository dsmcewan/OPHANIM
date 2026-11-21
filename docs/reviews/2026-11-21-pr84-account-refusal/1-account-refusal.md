# Assignment 1: The account-refusal stop and the seven lessons

**Candidate:** PR #84 at `b42c49e99f5140eb2e616af7694f943d5b9d0420` (base `main`, merge base
`ba3f03862f3e452f4db4f5891a1c288ebbc5cc6e`).
**Scope:** the stop on a provider refusing the account, the attempt count, recovery, the rate-limit control, the
corrections record's additions.
**Testing:** mock providers and isolated processes. Script every provider error yourself, in tests you write under
`.review-tests/`, with temporary ledgers and the scripted seats the existing tests use. You may kill and restart processes
your tests start. No live provider.

## What the PR claims

A provider that refuses the **account** (no credit, a spend cap or quota that is the account's, a key it does not accept)
is not a failure of the work item. Before this PR the plan stage read Anthropic's 400 "Your credit balance is too low"
as a malformed answer, asked the planner twice more and recorded the plan failed, spending one of the item's attempts on
a refusal no retry could change. With the PR:

- `accountRefusal(err, seat)` classifies such an error, and nothing else, as `PROVIDER_ACCOUNT_REFUSED`;
- the stage meter sends that vendor nothing more for the rest of the stage;
- the scheduler records the stage `pending` with a transient blocker for the owner, never `failed`, counts no attempt
  for it, and stops the tick (`STOP_CODES.ACCOUNT`) before it starts the next item;
- once the account is restored, the next tick resumes the same stage.

The copy you review has no git history (see the harness), so the base is not in it. The PR changes these files:

- `ophanim/operate/account-refusal.mjs` (new);
- `ophanim/operate/stages.mjs` (the stage meter);
- `ophanim/operate/scheduler.mjs` (the stop, the attempt count, the pending stage and its blocker);
- `ophanim/operate/account-refusal.test.mjs` and `ophanim/operate/account-refusal.mutate.mjs` (new);
- `ophanim/lessons/corrections.json` (seven instances);
- `docs/OPEN-LIMITATIONS.md` (register KG-39) and `docs/routing-task-profile.md`.

## Where to look

- `ophanim/operate/account-refusal.mjs`: `ACCOUNT_REFUSED`, `accountRefusal`.
- `ophanim/operate/stages.mjs`: the meter's `refusedAccounts`, the `accountRefused` callback.
- `ophanim/operate/scheduler.mjs`: `STOP_CODES`, the run loop's stop check, the attempts filter, the conversion of the
  stage to `pending` and its blocker, `outputs.account_refused`.
- `ophanim/operate/account-refusal.test.mjs`, `ophanim/operate/scheduler.test.mjs`, `ophanim/operate/stages.test.mjs`.
- `ophanim/operate/account-refusal.mutate.mjs`: the mutation runner (`--check`, `--only`).
- `ophanim/lessons/corrections.json` and `ophanim/lessons/corrections.mjs` (`problems()`), with
  `ophanim/lessons/corrections.test.mjs`.
- `docs/OPEN-LIMITATIONS.md`: KG-39.
- Existing tests you may run: `ophanim/operate/account-refusal.test.mjs`, `scheduler.test.mjs`, `stages.test.mjs`,
  `ophanim/lessons/corrections.test.mjs`.

## Questions

1. **The stop comes before the next item.** With two or more items ready, a refusal of the account in the first item's
   stage: does the tick stop before any stage of the next item starts, with no request sent for it? Is the stop
   recorded with `STOP_CODES.ACCOUNT` and a reason naming the vendor and the kind of refusal? Does `watch` stop too, or
   does it tick again into the same refusal? Show it with a test of your own.
2. **The attempt count is kept.** Is the current item's attempt count for the stage the same after the refusal as
   before it, whatever its `stage_attempts` bound? Is the stage left `pending` with a transient
   `PROVIDER_ACCOUNT_REFUSED` blocker, never `failed` or `blocked`? Within the stage, is the refused vendor sent
   nothing more after the refusal, and are other vendors' seats in the same stage unaffected?
3. **Progress after the account recovers.** When the provider accepts the next call, does a later tick resume the same
   item and stage with no manual edit of any ledger, clear or supersede the blocker, and reach the stage's next result?
   Is a refusal that happens again after recovery handled the same way, still with no attempt used?
4. **The control: an ordinary rate limit.** A 429 with `retry-after` that is a rate limit, not the account's quota:
   is it left out of `accountRefusal`, with no account stop, and handled exactly as before the PR (its retries and its
   attempt accounting)? Run it beside question 1's refusal in the same fixture, so that one test shows the two treated
   differently. Name any rate-limit, overload or transient response the classifier would take for an account refusal,
   and any account refusal it would miss, per vendor (Anthropic, OpenAI, Google, xAI).
5. **No other harm.** Can the classifier take a bad request, a model that does not exist, or a malformed answer for an
   account refusal, so that a real defect waits forever as a transient blocker? Does the stop leave other items' claims,
   leases and attempts as they were, and release its own claim?
6. **The seven additions to the corrections record.** At this commit, `ophanim/lessons/corrections.json` adds seven
   instances:
   - one to the existing class `unqualified-claim-as-measurement` and three to `bound-declared-not-enforced`, each
     `observed_by: owner`, dated 2026-11-21, citing PR #76's `52bd1ee` and a foundry-fix request;
   - a new class `environment-refusal-charged-to-work`, with one instance (`observed_by: mechanism`), `fixed_in:
     "8acea7a (PR #84)"` and a test detector, `ophanim/operate/account-refusal.test.mjs`, name `ACCOUNT REFUSAL`;
   - a new class `verification-not-of-the-gated-tree`, with two instances (`observed_by: mechanism`), `fixed_in: null`
     and detector kind `none`.

   Check each against the record's own rules in `ophanim/lessons/corrections.mjs`: does `problems()` find none? Does
   each addition meet the rules `problems()` and the header state (`observed_by` one of `owner`, `review`,
   `mechanism`; a `YYYY-MM-DD` date; `by_detector` only where the rules allow it; a test detector's `file` and `name`,
   or `why` and `next` for kind `none`)? Do the success verdict and the repeated-class counts of `report()` change only
   as these instances should change them? Does the detector named for
   `environment-refusal-charged-to-work` exist at this commit, and does a test of that name fail when the stop is
   removed? Is `fixed_in` a commit that is in this PR's history (the copy has none: say how you judged it)? Is each
   instance filed under the class its note describes? Does the record's success criterion still read correctly with
   them?
7. **The mutation runner.** Does `ophanim/operate/account-refusal.mutate.mjs --check` pass, and is every mutation it
   lists killed? Is any rule in questions 1 to 5 left with no mutation, or with one the tests would not kill? You may
   run it only from a test you write, on a copy it makes itself.
