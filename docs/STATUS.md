# Status board

<!-- Generated from the status ledger (status/ledger). Do not edit by hand: record a status change
     with `node packages/ledger/status.mjs set ...`, then `node packages/ledger/status.mjs render`. -->

**Ledger:** `status/ledger` · anchor `sha256:816a79525846cb2ade6173260237f1236cd5bea103d9027be51ea2981a2b536d` · head `sha256:79860d3d2aedf8acde56ea6a4255da6245f713e84817e08ed3634f0a10cd8c8c` · 77 entries.
Verify it: `node packages/ledger/status.mjs verify`.

**Counts:** Resolved: 35 · In progress: 1 · Ready: 2 · On Hold: 18.

**Rule** (enforced when a status is recorded): On Hold only for something outside the work, meaning governance, a credential, evidence from real runs, an unpublished fact, or a person's decision, or for an item that depends on one. An item that is merely not started is Ready, and starts.

| Item | State | Waiting on | Basis | Checked |
|---|---|---|---|---|
| **all_turns on GPT-6 Astra, Sol, Luna** (`all-turns`) | On Hold | credential | docs conflict on Astra, silent on Sol and Luna; one live call settles it | 2026-11-17 |
| **Independent evaluation plan, Phases 0 to 6** (`cross-lab-evaluator`) | On Hold | decision | needs a cross-lab evaluator with TELOS access and live-run budget (review decisions 5 to 7) | 2026-11-17 |
| **Cross-lab review of the ledger work (PR #6)** (`cross-lab-review`) | On Hold | credential | reviewers from OpenAI, xAI and Google are ready to run (npm run review-cycle with the HTTPS turn); the saved provider keys are still rejected | 2026-11-17 |
| **xAI models on the shared client** (`direct-path-xai`) | On Hold | fact | xAI documents no output ceilings (re-checked 2026-11-17) | 2026-11-17 |
| **FW3: core premises open (0 of 6 trials delegated; swarm not independent)** (`fw3-premises`) | On Hold | evidence | needs live runs with real providers | 2026-11-17 |
| **FW4: a threat model naming the adversary (independent review)** (`fw4-threat-model`) | On Hold | decision | the review assigns this to the decision authority: which adversary the controls must stop (careless owner, compromised agent session, malicious repo writer, provider substitution). A draft can be proposed for decision | 2026-11-17 |
| **gemini-3.6-flash off the agy seats** (`gemini-routing`) | On Hold | decision | would move OAuth agy seats onto the metered API | 2026-11-17 |
| **GitHub Projects view of the loop** (`github-projects`) | On Hold | credential | user-owned Projects need a token with project scope; neither GITHUB_TOKEN nor this session has one. The publisher syncs Projects only when that token is configured | 2026-11-17 |
| **TELOS reviewers bound to real seats (K6)** (`k6`) | On Hold | governance | pinned TELOS verifier admits ledger entries and seat-signed reviews | 2026-11-17 |
| **Seat files from before the ledger** (`legacy-seat-files`) | On Hold | decision | a resumed board from before the ledger has seat turns that were never recorded; refused today. Adopting them as signed inputs is a choice about trust | 2026-11-17 |
| **ME2: thin admission statistic (three pairs per width; p95 equals max)** (`me2-admission-stat`) | On Hold | decision | thresholds are a decision (review decision 4); more samples need live runs | 2026-11-17 |
| **P8/P9 admission through the efficiency gate** (`p8-p9-admission`) | On Hold | depends on k6 | needs the pinned verifier to admit it | 2026-11-17 |
| **Q7 seat adjustment from evidence** (`q7-adjustment`) | On Hold | depends on k6 | needs the pinned verifier to admit a seating dimension | 2026-11-17 |
| **RU3: governance.mjs, which holds the pins, is not itself pinned** (`ru3-pin-boundary`) | On Hold | governance | what the pinned verifier covers is a governance decision | 2026-11-17 |
| **Signed transitions** (`signed-transitions`) | On Hold | depends on k6 | governance decision on the pinned verifier | 2026-11-17 |
| **Operator key custody (hardware or remote signer)** (`signer`) | On Hold | decision | keys generated in an agent session stay there (independent review SY1/WF2); the status board key is the same question. Needs the owner to hold the operator key or name a signer | 2026-11-17 |
| **SY3: proofs bind absolute paths and cannot be checked on another machine** (`sy3-portable-proofs`) | On Hold | decision | whether a retained proof must verify elsewhere is review decision 8 | 2026-11-17 |
| **Adjusting the output tiers** (`tier-adjustment`) | On Hold | evidence | moves only on recorded truncations from real runs | 2026-11-17 |
| **Surviving mutants: order signature, parent linkage, checkpoint, revision continuity, ready-set, handoff, effect confirmation, RU4, CO2** (`review-mutants`) | In progress |  | independent review: checks no test protects; each gets a killing test | 2026-11-17 |
| **CO1: ophanim/ is expensive to review (6% comments, long lines)** (`co1-readability`) | Ready |  | reformat and document without behaviour change | 2026-11-17 |
| **ME3: nine canonical-JSON functions that disagree at the edges** (`me3-canonical`) | Ready |  | unify without changing hashes existing records depend on; needs a differential over every committed ledger and TELOS-bound digest first | 2026-11-17 |
| **Escalation on agy seats** (`agy-escalation`) | Resolved |  | steps a rung instead of an effort the transport drops | 2026-11-17 |
| **One ledger across boards and domains** (`board-resolver`) | Resolved |  | entries name their board (scope) and re-derive against it; domains declared by operator-signed entries; a reader checks foreign-domain entries structurally and reports them as foreign, never re-derived | 2026-11-17 |
| **Cited capability facts** (`facts`) | Resolved |  | every registry model cited; UNRECORDED where unstated; drift check empty | 2026-11-17 |
| **Six models on the shared client** (`frontier-move`) | Resolved |  | requests unchanged (providerDefaults); remaining models held (direct-path-xai, gemini-routing) | 2026-11-17 |
| **FW1: prove/verify certify against a stored answer (independent review)** (`fw1-stored-answer`) | Resolved |  | by design (fixture authority); the scope caveat is now in all five evaluation docs; real verification is K6 | 2026-11-17 |
| **Gate verdicts recorded on the run path** (`gate-on-run-path`) | Resolved |  | runOpenItem records each ship verdict, including refusals, as a scoped gate entry that re-derives after the board moves on | 2026-11-17 |
| **gemini-3.8-flash** (`gemini-3.8`) | Resolved |  | recorded as a stable API model; default stays on 3.6 (current, supports minimal) | 2026-11-17 |
| **Ledger core (K1)** (`k1`) | Resolved |  | closed kinds, per-author signatures, re-derivation before append, checkpoints | 2026-11-17 |
| **Genesis and anchors (K2)** (`k2`) | Resolved |  | genesis-pinned authority; TELOS and board anchors | 2026-11-17 |
| **First ledger kinds (K3)** (`k3`) | Resolved |  | facts, seating, escalation, contribution; gate verdicts at named heads | 2026-11-17 |
| **Turns, cold review, seat keys (K4)** (`k4`) | Resolved |  | served-model lineage; cold review; per-seat keys | 2026-11-17 |
| **Efficiency records (K5, K5b)** (`k5`) | Resolved |  | debit loophole closed; trace, assessment and retained on the ledger; fresh assessments verified | 2026-11-17 |
| **Layered review findings** (`layered-review`) | Resolved |  | regression and defects fixed with fails-before tests; doc claims corrected | 2026-11-17 |
| **The ledger by default** (`ledger-default`) | Resolved |  | pinned genesis, key custody, seat-key rotation; on by default for runOpenItem and the CLI (PR #6) | 2026-11-17 |
| **Reseat from the live view** (`live-reseat`) | Resolved |  | explicit, consented, recorded per seat | 2026-11-17 |
| **ME1: no test failed when the author-signature check was deleted (independent review)** (`me1-author-signature`) | Resolved |  | test where the orderer authors in a seat name; the deletion mutant now fails it | 2026-11-17 |
| **Remaining off-ledger records** (`off-ledger-records`) | Resolved |  | lease rows, budget caps and ref moves are ledger entries recorded before the file changes; seat files are checked against ledger turns at handoff (ophanim/ledger/board-kinds.mjs) | 2026-11-17 |
| **OPHANIM loop P1-P7** (`p1-p7`) | Resolved |  | equilibrium reuse, chain verification, required gates, assignments, append-only debits, deltas, investigation checkpoints (docs/loop-evaluation.md) | 2026-11-17 |
| **Frontier handoff and refill scheduling (P8, P9)** (`p8-p9`) | Resolved |  | implemented, opt-in; admission through the efficiency gate is held separately (p8-p9-admission) | 2026-11-17 |
| **Routing and escalation protocol** (`protocol`) | Resolved |  | decisions re-derive; reviewer verdicts and truncations escalated | 2026-11-17 |
| **GitHub as the public projection of the ledger** (`public-record`) | Resolved |  | issues, labels, PR provenance, cycle reports and CI summaries generated from committed ledgers; seats never shown as GitHub identities (docs/public-record.md); publishes on push to main only | 2026-11-17 |
| **Engine Q1-Q6** (`q1-q6`) | Resolved |  | model in the author, occupancy, chair and controller gates, lane registry, budget binding (docs/pantheon-engine-loop-evaluation.md) | 2026-11-17 |
| **Q7 contribution measurement** (`q7-measurement`) | Resolved |  | projection, recomputation check and ranking across five chairs | 2026-11-17 |
| **OpenAI reasoning.context** (`reasoning-context`) | Resolved |  | settled from the vendor docs; effective mode recorded | 2026-11-17 |
| **Ref recorded but its file write fails** (`ref-write-gap`) | Resolved |  | the ref file is prepared before the move is recorded; if the final rename fails, an undo reset (to null for a creation) is recorded, so the ledger and the file agree. Test fails on the old code | 2026-11-17 |
| **Review layer every cycle** (`review-every-cycle`) | Resolved |  | cycle, review, finding, resolution and close entries; independent reviewers on distinct labs; close re-derives (verified only when every finding has a reproduction); next cycle refused until the last is closed; npm run review-cycle | 2026-11-17 |
| **RU1: cross-lab rule compared vendor strings (independent review)** (`ru1-cross-lab`) | Resolved |  | one labOf backs law 3, assertReviewCutsAcross and the ledger; reviewer seating avoids same-lab vendors; regression test fails on the old code | 2026-11-17 |
| **RU2: frontier verification accepted a keyless forgery (independent review)** (`ru2-frontier-forgery`) | Resolved |  | authority entries are always fully verified; regression test in packages/ledger fails on the old code | 2026-11-17 |
| **Ledger as a shared package** (`shared-package`) | Resolved |  | packages/ledger holds the domain-free core; Pantheon kinds under pantheon/src/ledger, OPHANIM kinds under ophanim/ledger; dependency runs OPHANIM -> Pantheon -> packages/ledger, enforced by layering.test | 2026-11-17 |
| **Status board from a ledger** (`status-board`) | Resolved |  | status entries with the standing rule enforced on append; docs/STATUS.md generated from status/ledger | 2026-11-17 |
| **SY4 lockfile integrity, SY5 append cost and lock, WF3 sandbox python path, WF4 machine paths** (`supply-portability`) | Resolved |  | lockfile has integrity for every registry package (guarded in CI); appends stay constant-time with a verified cached head and a lock with backoff and stale-lock recovery; sandbox binds alternatives links (the long-standing env failure now passes); no /home/<user> paths, guarded | 2026-11-17 |
| **Swarms on the board** (`swarms`) | Resolved |  | gated, recorded transitions; all five chairs measured | 2026-11-17 |
| **SY1: the ledger had no shipped caller (independent review)** (`sy1-ledger-caller`) | Resolved |  | the ledger is on by default for runOpenItem and the OPHANIM CLI (PR #6); key custody is tracked under signer | 2026-11-17 |
| **One terminal-state rule for every model** (`terminal-state`) | Resolved |  | shared rule on both transports, unary and streamed (docs/pantheon-model-loop-evaluation.md) | 2026-11-17 |
| **Output-token tiers** (`token-tiers`) | Resolved |  | provisional tiers by difficulty, capped at documented ceilings; adjustment held (tier-adjustment) | 2026-11-17 |
