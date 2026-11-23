# Paired audit: two models audit one pinned candidate, seal before they see each other, then challenge each other

## Why

The owner, on 2026-11-21:

> Write the paired-audit requirement as a separate OPHANIM item. Fable leads self-awareness. Astra leads
> accountability. Give them the same pinned evidence. Each seals its findings and its own self-audit before seeing the
> other's work. Then reveal the findings, have each model challenge the other, and seal both challenges before opening
> either self-audit. Preserve who spotted each issue first, what evidence settled it, and whether OPHANIM catches the
> next recurrence before I intervene.

The same day's diagnosis of OPHANIM's corrections record (`ophanim/lessons/corrections.json`) is why this matters:
- Most defects were checked on the path their author imagined.
- 14 of 25 failure classes recurred, holding 55 of 66 instances.
- Detection moved from the owner to mechanism and review, but prevention did not.

A paired audit makes each auditor say what it assumed, and what would prove it wrong, before it can be anchored on the
other's view. It also keeps the record of who caught what first.

## The two lenses, and who leads

- **Self-awareness, led by Anthropic Fable 5.2 (`claude-fable-5-2`) on the first item.** For each consequential claim
  about the candidate:
  - the evidence that supports it;
  - what the auditor assumed;
  - one observation that would overturn it.
- **Accountability, led by OpenAI GPT-6 Astra (`gpt-6-astra`) on the first item.** For each consequential decision in
  the candidate:
  - the rule that governs it;
  - the point at which that rule was enforced;
  - the action recorded;
  - its outcome.
- **Rotation.** On the next comparable item the leads swap. Both models apply both lenses; the lead owns its lens's
  completeness. What counts as comparable (for example the same request class), and the rotation itself, are recorded.

## What to build

1. **Pin before anyone sees anything.** Before either session opens, one record on the work ledger pins:
   - the candidate (a commit);
   - its requirement and its rubric;
   - the digest of the evidence both auditors are given;
   - the roles: who leads which lens.

   Both sessions are given exactly that evidence. A changed candidate starts a **linked round**: a new round that
   names the one it follows. It never amends the old one.
2. **Two separate sessions, two identities.**
   - Each model has its own session and state over the same pinned evidence.
   - Every turn records the model requested and the model the provider reports serving it.
   - A missing or mismatched served identity, or an unavailable model, leaves the pair **incomplete**, recorded with
     the reason. A fallback model never earns the absent model's audit credit.
3. **Two sealed records each.** Each auditor returns:
   - its **findings**: each with an ID, the claim and its lens's fields;
   - a short **self-audit**: its likeliest error, and the evidence that could expose it.

   The two are sealed separately: each one's digest is recorded on the work ledger when it is submitted.
4. **Isolation until release.** No content of the peer's work reaches a session before its release step. That covers
   its prompts, any shared retrieval, and any record its tools can read. A delayed submission leaves its peer seeing
   nothing early.
5. **Reveal the findings, then challenge.**
   - Only after both first submissions are sealed are the **findings**, and only the findings, released to the other
     model.
   - Each model then challenges the other's most consequential claim, by finding ID. It cites evidence, and proposes
     the smallest check that could decide the claim.
   - Both challenges are sealed **before either self-audit is opened**.
6. **Open and verify.** At the final reveal, every digest is verified against what is opened, and a mismatch is
   recorded as such, not repaired. Originals are kept beside every amendment. The record says:
   - **who first raised each issue:** in the first sealed submissions, or in a challenge. Both are credited when both
     raised it independently;
   - **what the check established,** and the evidence that settled it;
   - **what remains open.**
7. **Interruption.** A timeout or a stopped run resumes from the last sealed step. Sealed steps are never re-run or
   re-sealed.
8. **Lineage and gates.**
   - A critique used in a repair is carried into that repair's contributor lineage: its model is a contributor to the
     repair, so the existing exclusion keeps it off the repair's review.
   - The existing review, validation and owner-outcome gates apply unchanged.
   - **The paired audit never replaces, or counts toward, the item's three-lab review panel.**
9. **Recurrence.** When a later candidate meets an issue class the audit recorded, the record counts:
   - the opportunities there were to exercise the same condition;
   - who detected it before action: OPHANIM's own checks or audit, or the owner;
   - whether the earlier repair held;
   - whether the owner had to intervene again.

   These feed the corrections record's existing fields (`observed_by`, dates, `corrected_by`, the dated success
   criterion), so "did OPHANIM catch it before the owner did" is read from records.

## Independence (constraint, not optional)

- **Anthropic does not review its own work.** Under `fit`, every plan is written by an Anthropic planner. So Fable's
  audit of any candidate an Anthropic model contributed to is recorded as a **same-lab audit**: its findings stand as
  findings, and it is never an independent review of that contribution.
- **A contributing model never reviews.** Either auditor that contributed to the candidate is recorded as such.
- **Every review panel keeps three distinct labs.** Nothing here relaxes that.

## Left to you, the planner

- where the protocol lives (a stage, a lane, or an extension of `pantheon/scripts/run-review.mjs`, which already runs
  one review assignment against a disposable worktree of a commit);
- the record shapes and the sealing format, which must be append-only and verified by digest;
- how "most consequential" is chosen for a challenge, and the definition of a comparable item for rotation;
- how the work is cut into units.

## Constraints

- Every billed request is admitted and recorded before it is sent (register L-136), against a budget the owner
  declares. Paid runs are the owner's to launch.
- Tests use scripted seats only; nothing reaches a provider.
- Records written before this change still read.
- The `findings-*` paths are not read.
- Every record says whether it is **synthetic** (scripted seats) or **live**.

## Done means

- **Each rule has a test that fails on the base it is built on:**
  - the pin precedes every session;
  - a peer's content is absent from a session's prompts, retrieval and tool-visible records until its release step;
  - self-audits cannot be opened before both challenges are sealed;
  - a tampered sealed record is detected at reveal;
  - originals are kept beside amendments;
  - first-raised attribution, including credit for a jointly raised issue;
  - resumption from the last sealed step;
  - a linked round on a changed candidate;
  - an incomplete pair on an unavailable model, a missing or mismatched served identity, or a fallback;
  - lineage for a critique used in a repair;
  - rotation;
  - the recurrence counts;
  - the same-lab label on Fable's audit of an Anthropic-contributed candidate.
- **An offline demonstration, labelled synthetic, run through the real protocol with scripted seats:**
  - one submission is delayed, and its peer sees nothing early;
  - an interrupted round resumes from its last sealed step;
  - **the Foundry fix 1 case:** a claim that the shared cap held is challenged and decided by the grant authorized
    before a concurrent send, not by the recorded $0.30 overrun (a receipt above its grant);
  - a correct claim survives its challenge.
- A mutation runner for these rules, every mutation killed. `--check` on every runner passes, and the repository's
  suites pass, on Node 24.
- A register entry with the next free `KG-` id, and the review docs updated.
