# Status board

<!-- Generated from the status ledger (status/ledger). Do not edit by hand: record a status change
     with `node ophanim/ledger/status.mjs set ...`, then `node ophanim/ledger/status.mjs render`. -->

**Ledger:** `status/ledger` · anchor `sha256:816a79525846cb2ade6173260237f1236cd5bea103d9027be51ea2981a2b536d` · head `sha256:4cddf4a50fc69c6d10195a052a303a897dca9737c4a04a39da03cde55137f68c` · 36 entries.
Verify it: `node ophanim/ledger/status.mjs verify`.

**Counts:** Resolved: 21 · In progress: 2 · Ready: 3 · On Hold: 9.

**Rule** (enforced when a status is recorded): On Hold only for something outside the work, meaning governance, a credential, evidence from real runs, an unpublished fact, or a person's decision, or for an item that depends on one. An item that is merely not started is Ready, and starts.

| Item | State | Waiting on | Basis | Checked |
|---|---|---|---|---|
| **all_turns on GPT-6 Astra, Sol, Luna** (`all-turns`) | On Hold | credential | docs conflict on Astra, silent on Sol and Luna; one live call settles it | 2026-11-17 |
| **xAI models on the shared client** (`direct-path-xai`) | On Hold | fact | xAI documents no output ceilings (re-checked 2026-11-17) | 2026-11-17 |
| **gemini-3.6-flash off the agy seats** (`gemini-routing`) | On Hold | decision | would move OAuth agy seats onto the metered API | 2026-11-17 |
| **TELOS reviewers bound to real seats (K6)** (`k6`) | On Hold | governance | pinned TELOS verifier admits ledger entries and seat-signed reviews | 2026-11-17 |
| **P8/P9 admission through the efficiency gate** (`p8-p9-admission`) | On Hold | depends on k6 | needs the pinned verifier to admit it | 2026-11-17 |
| **Q7 seat adjustment from evidence** (`q7-adjustment`) | On Hold | depends on k6 | needs the pinned verifier to admit a seating dimension | 2026-11-17 |
| **Signed transitions** (`signed-transitions`) | On Hold | depends on k6 | governance decision on the pinned verifier | 2026-11-17 |
| **Hardware or remote signer** (`signer`) | On Hold | decision | which signer holds operator keys is a custody decision | 2026-11-17 |
| **Adjusting the output tiers** (`tier-adjustment`) | On Hold | evidence | moves only on recorded truncations from real runs | 2026-11-17 |
| **Remaining off-ledger records** (`off-ledger-records`) | In progress |  | lease rows, budget limits, ref moves, seat files checked against turns: being built | 2026-11-17 |
| **Status board from a ledger** (`status-board`) | In progress |  | this board: status entries with the standing rule enforced; docs/STATUS.md generated | 2026-11-17 |
| **One ledger across boards** (`board-resolver`) | Ready |  | gate and contribution kinds resolve their own board per entry; dependencies converged | 2026-11-17 |
| **Review layer every cycle** (`review-every-cycle`) | Ready |  | review entries under cold-review rules by default; dependencies converged | 2026-11-17 |
| **Ledger as a shared package** (`shared-package`) | Ready |  | move ophanim/ledger to packages/ledger so Pantheon does not import OPHANIM; dependencies converged | 2026-11-17 |
| **Escalation on agy seats** (`agy-escalation`) | Resolved |  | steps a rung instead of an effort the transport drops | 2026-11-17 |
| **Cited capability facts** (`facts`) | Resolved |  | every registry model cited; UNRECORDED where unstated; drift check empty | 2026-11-17 |
| **Six models on the shared client** (`frontier-move`) | Resolved |  | requests unchanged (providerDefaults); remaining models held (direct-path-xai, gemini-routing) | 2026-11-17 |
| **gemini-3.8-flash** (`gemini-3.8`) | Resolved |  | recorded as a stable API model; default stays on 3.6 (current, supports minimal) | 2026-11-17 |
| **Ledger core (K1)** (`k1`) | Resolved |  | closed kinds, per-author signatures, re-derivation before append, checkpoints | 2026-11-17 |
| **Genesis and anchors (K2)** (`k2`) | Resolved |  | genesis-pinned authority; TELOS and board anchors | 2026-11-17 |
| **First ledger kinds (K3)** (`k3`) | Resolved |  | facts, seating, escalation, contribution; gate verdicts at named heads | 2026-11-17 |
| **Turns, cold review, seat keys (K4)** (`k4`) | Resolved |  | served-model lineage; cold review; per-seat keys | 2026-11-17 |
| **Efficiency records (K5, K5b)** (`k5`) | Resolved |  | debit loophole closed; trace, assessment and retained on the ledger; fresh assessments verified | 2026-11-17 |
| **Layered review findings** (`layered-review`) | Resolved |  | regression and defects fixed with fails-before tests; doc claims corrected | 2026-11-17 |
| **The ledger by default** (`ledger-default`) | Resolved |  | pinned genesis, key custody, seat-key rotation; on by default for runOpenItem and the CLI (PR #6) | 2026-11-17 |
| **Reseat from the live view** (`live-reseat`) | Resolved |  | explicit, consented, recorded per seat | 2026-11-17 |
| **OPHANIM loop P1-P7** (`p1-p7`) | Resolved |  | equilibrium reuse, chain verification, required gates, assignments, append-only debits, deltas, investigation checkpoints (docs/loop-evaluation.md) | 2026-11-17 |
| **Frontier handoff and refill scheduling (P8, P9)** (`p8-p9`) | Resolved |  | implemented, opt-in; admission through the efficiency gate is held separately (p8-p9-admission) | 2026-11-17 |
| **Routing and escalation protocol** (`protocol`) | Resolved |  | decisions re-derive; reviewer verdicts and truncations escalated | 2026-11-17 |
| **Engine Q1-Q6** (`q1-q6`) | Resolved |  | model in the author, occupancy, chair and controller gates, lane registry, budget binding (docs/pantheon-engine-loop-evaluation.md) | 2026-11-17 |
| **Q7 contribution measurement** (`q7-measurement`) | Resolved |  | projection, recomputation check and ranking across five chairs | 2026-11-17 |
| **OpenAI reasoning.context** (`reasoning-context`) | Resolved |  | settled from the vendor docs; effective mode recorded | 2026-11-17 |
| **Swarms on the board** (`swarms`) | Resolved |  | gated, recorded transitions; all five chairs measured | 2026-11-17 |
| **One terminal-state rule for every model** (`terminal-state`) | Resolved |  | shared rule on both transports, unary and streamed (docs/pantheon-model-loop-evaluation.md) | 2026-11-17 |
| **Output-token tiers** (`token-tiers`) | Resolved |  | provisional tiers by difficulty, capped at documented ceilings; adjustment held (tier-adjustment) | 2026-11-17 |
