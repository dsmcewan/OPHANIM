# Cycle review: OPHANIM and Pantheon, start to finish (2026-11-16 → 17)

**Scope.**
- 37 commits on `ccr-aa24f0d5-336szn`, from the first loop evaluation (`f980986`) to the K5b merge (`009152c`).
- Seven cycles. Each ran the same loop: stabilize → identify unresolved → research or propose → apply → validate → record only deltas → hand off on a matching record → converge.
- For each cycle the review gives what was there before, what is there now, how the method changed, and what could be better. A cross-cycle section shows the trend.

## The board at the end

| | Start of cycle 1 | End of cycle 7 |
|---|---|---|
| Pantheon suite | 770 pass, 1 environment failure | 811 pass, the same 1 environment failure (passes in CI) |
| OPHANIM proof suite | 104 pass; 21 could not run here (no TELOS) | 165 pass, 0 fail, with TELOS checked out at the pin |
| Model client | 45 | 48 |
| CI on the final commits | one timing flake (fixed in cycle 1) | every pushed commit green |
| Records a verifier re-derives on the path | the controller delta chain, release signatures, ship gates | all of those, plus 15 ledger kinds: genesis, authority, checkpoint, anchors, facts, seating, escalation, contribution, gate, turn, review, and the efficiency trace, assessment, use, result, debit, promotion and retained records |
| Items On Hold | most proposals, several for lack of work | four, each waiting on something outside the code (see the end) |

## Cycle 1: OPHANIM against the loop (P1–P9)

- **Was:**
  - a no-op still wrote a record;
  - whole-state snapshots, with transitions between them unchecked;
  - verification optional in two places;
  - mutable efficiency accumulators;
  - handoff re-verified everything.
- **Now:**
  - no-ops reuse the settled head (P1);
  - the transition chain is verified (P2);
  - one success shape, with governance checks required (P3);
  - assignment recorded (P4);
  - efficiency debits append-only (P5);
  - delta records with full checkpoints (P6);
  - bounded investigation (P7);
  - frontier-only handoff verification (P8) and refill scheduling (P9), both opt-in.
- **Method:** read the code, propose, and implement in batches you chose; validate with tests and CI. A CI flake was traced to a trace window that began after replays started, fixed, and shown to fail deterministically before the fix.
- **Could be better:**
  - P8 and P9 reached "On Hold: the pinned verifier" without asking what the pinned verifier *was*. That question was not answered until cycle 7.
  - Validation was my own tests only.

## Cycle 2: every model, the same terminal rule

- **Was:** each path judged success its own way.
- **Now:** one `terminalState` rule for every registry model, on both transports, unary and streamed.
- **Method:** the loop applied per model; the registry walk test enumerates them.
- **Could be better:** test fakes were trusted to look like providers. Cycle 6 showed some were more lenient than the real APIs.

## Cycle 3: the Pantheon engine (Q1–Q7, the 1 + 4 chairs)

- **Was:** the model was not recorded on board entries; there were no occupancy generations; stage gates were declared but not enforced; budget was not bound to commits; there was no contribution measure.
- **Now:**
  - Q1 records the model;
  - Q2 adds occupancy transitions;
  - Q3 and Q4 add the chair and controller gates;
  - Q5 adds the lane registry;
  - Q6 binds the budget;
  - Q7 adds measurement (the adjustment half is held).
- **Method:** the On Hold / Resolved rule came in, and dependencies became explicit.
- **Could be better:** you caught what I should have:
  - ranking ignored inconsistent occupancy trails;
  - there was a 1,024-token default;
  - the pinned checker's role in the holds.

## Cycle 4: facts, routing and escalation

- **Was:** capability figures asserted in code, some wrong (efforts, windows); a deprecated default model; no escalation path (`selectFor` and `escalate` had no callers).
- **Now:**
  - cited capability facts with UNRECORDED in place of guesses, and a drift check;
  - code corrected to the documentation;
  - gemini-3.5-flash replaced from Google's deprecation notice;
  - a routing and escalation protocol whose decisions are records that re-derive;
  - reviewer verdicts and cut-off replies wired into escalation.
- **Method:** the vendor's documentation became the evidence, with quotes kept beside each value.
- **Could be better:**
  - `verifyEscalation` existed from this cycle but nothing on the path called it until cycle 7. A verifier off the path is a claim, not a check.
  - `capabilityDrift` had the same problem.

## Cycle 5: swarms, tiers, agy escalation, reseat, frontier move

- **Was:** swarm layers ran off the board; a 1,024-token output default; agy seats escalated with an effort their transport drops; the live view could not reseat; six models ran on a duplicate direct path.
- **Now:**
  - swarms are gated, recorded board transitions measured across all five chairs;
  - provisional output tiers;
  - agy seats step a rung instead;
  - an explicit, recorded reseat in the view;
  - six models on the shared client, with their requests unchanged.
- **Method:** one item after another, self-verified, CI green.
- **Could be better:**
  - **this cycle shipped a regression:** moved models streamed to the wrong pane with turns run together;
  - several defects and eight overstated doc claims shipped with it;
  - CI was green because lenient fakes hid them.

  Sequential self-checking was the weakest point of the whole run.

## Cycle 6: the layered review

- **Was:** one reviewer: me.
- **Now:**
  - three independent reviewers on different models, plus an auditor checking the docs against the code;
  - every finding reproduced before it was fixed;
  - fixes proven by tests that fail on the old code and pass on the new.
- **Found and fixed:**
  - the stream-pane regression, which was already true for fable and astra;
  - a false reseat announcement, and `__proto__` passing as a vendor;
  - stored escalation records failing their own digest, and rewording breaking re-derivation;
  - `difficulty: "toString"` yielding `max_tokens: NaN`;
  - swarms ignoring difficulty, `architecture` imposing `xhigh`, and `carriesEffort` deciding by model name alone;
  - eight doc claims.
- **Method:** the review was still a separate pass, run by hand and recorded in chat and a doc table.
- **Could be better:** your correction was that it should not be a separate layer at all, but the same loop hardened through provenance, on a ledger. Cycle 7 is that.

## Cycle 7: ledger provenance (inventory → TELOS → K1–K5b)

- **Was:**
  - escalations, turns, gate verdicts and efficiency records lived off the ledger, in `run.json` and side files;
  - authorship was asserted, not observed;
  - a promotion could name its own authority root;
  - legacy debit files could inflate savings, and extra result files could inflate convergences;
  - TELOS was treated as a governance gate beside the ledger, not as the ledger.
- **Now:**
  - two inventories mapped every record against author, integrity, re-derivation, enforcement, evidence and whether it is on the ledger;
  - reading TELOS at its pin showed it is the right ledger for authorization and settlement, but not the whole system's;
  - one chain was built above it, keeping its concepts:
    - **K1:** closed kinds, per-author signatures, re-derivation before every append, checkpoints;
    - **K2:** genesis-pinned authority, with anchors to TELOS chains and board commits;
    - **K3:** facts, seating, escalation and contribution, plus gate verdicts re-derived at named heads;
    - **K4:** turns with the served model, cold review, and per-seat keys;
    - **K5 and K5b:** efficiency records, the debit loophole closed, and fresh assessments verified before use.
  - The run paths verify the ledger before relying on it, and record as they go.
  - Held items were re-checked against current vendor documentation:
    - gemini-3.8-flash is recorded as a stable API model;
    - grok-4.5's efforts are narrowed to the ones that take effect.
- **Method:**
  - independent items ran in parallel, in isolated worktrees, and were merged after review;
  - "start when its dependencies have converged" replaced the numbered order;
  - each merge was re-tested across all three suites.
- **Could be better:** see the next section.

## How it improved across cycles

| Dimension | Cycles 1–2 | Cycles 3–5 | Cycles 6–7 |
|---|---|---|---|
| What counts as evidence | a passing test | a cited document quote; a re-derivable record | a signed ledger entry, re-derived on the path, citing its inputs and lineage |
| Who catches mistakes | CI | you, mostly (occupancy, defaults, pins, framing) | independent reviewers and an auditor, then the ledger itself refusing forgeries |
| How a fix is proven | tests pass | tests pass | fails on the old code, passes on the new |
| Scheduling | batches you picked | a numbered sequence | dependencies; independent work in parallel |
| Holds | many, some only for lack of work | fewer, re-checked each cycle | four, all external; re-checked against current docs |
| Verifiers on the path | the controller chain, ship gates | plus terminal state and stage gates | plus every ledger kind, and fresh assessments |

## What could be better

1. **I needed the frame corrected too often.** The corrections were:
   - layers are one loop;
   - all of OPHANIM, not just the review;
   - a ledger;
   - TELOS is the ledger;
   - start when the dependencies have converged;
   - run independent work in parallel;
   - make the review multi-cycle.

   Each cost a cycle. The P8/P9 holds pointed at TELOS from cycle 1. Reading it then would have saved cycles 6 and 7 at least one turn each.
2. **The review layer should run every cycle by default.** It is cheap next to a shipped regression, and cycle 5 shows the cost of skipping it. On the ledger it is now the same mechanism: review entries under cold-review rules.
3. **Nothing has met a live provider.** Every turn, served model, truncation and tier was checked against fakes. The first live run is the real validation. It needs credentials, and it would also settle `all_turns` and give the tiers evidence.
4. **The ledger is opt-in.** *(Addressed in cycle 8: on by default, with key custody and rotation; see the ledger evaluation doc.)* `runOpenItem` and `executeRequest` record only when the caller passes a recorder. Nothing creates the genesis, holds the operator key, or rotates seat keys outside tests. Key custody is fixture-grade.
5. **Some records are still off the ledger, or only signed inputs:**
   - the `run.json` display copies;
   - seat conversation files;
   - lease rows (a signed input to LEASE);
   - budget limits;
   - the ref reflog.

   Each is named in the docs. None is yet an entry.
6. **Gaps in coverage:**
   - the retained-experiment positive path is not tested end to end, because it needs a full 1→3 qualification;
   - a held investigation receipt cannot show which failure produced it, where the decision depends on retained evidence.
7. **The status is scattered.** Three evaluation documents each hold a status table. One board, itself a projection of the ledger, would be easier to keep true.
8. **Process slips:**
   - one merge commit (`09926bf`) went out without the attribution lines;
   - `.claude/` worktrees were excluded locally, not in the repository. *(Fixed in cycle 8: `.gitignore`.)*

## What remains On Hold (all external)

| Item | Waiting on |
|---|---|
| K6: TELOS reviewer slots signed by real Pantheon seats, plus pinned-verifier admission (which also unblocks Q7 adjustment, P8/P9 admission and signed transitions) | your governance decision on the pinned TELOS verifier and on who is trusted. K1–K5b built the evidence it would rest on: per-seat keys, cold review, genesis authority. |
| `all_turns` on GPT-6 Astra, Sol and Luna | one live call with an OpenAI key |
| Output-tier adjustment | recorded truncations from real runs (`truncationEvidence`) |
| Models left on the direct path | xAI has not documented output ceilings (re-checked 2026-11-17); routing gemini-3.6-flash off the agy seats is your decision; haiku gains nothing yet |
