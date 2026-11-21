# Status updates to sign (2026-11-21)

Only the owner's keys sign the status ledger, and this session holds none, so these are drafted for you to run. Run them from the repository root on your machine with `OPHANIM_STATUS_KEYS` set to your key directory, then `node packages/ledger/status.mjs verify`, `node packages/ledger/status.mjs render`, and commit `status/ledger` and `docs/STATUS.md`.

All 9 were checked against the status rules on a scratch ledger replaying the current board (58 items, head `sha256:f8526a67…`): every one was accepted, giving 66 items (Resolved 36 · On Hold 19 · In progress 8 · Ready 3). None claims Resolved: no Pantheon run has shipped this work and no cross-lab review cycle has closed on it.

**Not drafted, on purpose:**
- `self-repair`: setting it In progress is the ON switch for the self-repair lane (docs/self-repair.md). That is your call, not a status update.
- Holds I could not re-check from here (`cross-lab-review`, `review-mutants`, the K6-dependent items and the rest) keep their 2026-11-17 entries. One to look at: `cross-lab-review` says the provider keys are rejected, but the 2026-11-18 independent review of PR #67 ran through `run-review.mjs --via subscription` (Google, OpenAI, xAI). PR #6 may now be reviewable the same way.

```sh
S="node packages/ledger/status.mjs set --json"

$S '{"item":"knowledge-graph","title":"Knowledge-graph program (directive 2026-11-20): deliverables 1 to 7","state":"On Hold","waiting_on":"decision","owner_role":"decision-authority","checked":"2026-11-21","basis":"All seven deliverables merged to main (PRs #67, #72, #78, #79, #81, #83; report #82 at e250a49): contract ophanim.graph/v1 1.2.0 in packages/graph; workflow integration with the routing and review parts advisory only; 12 demonstrations, 88/88 tests (scripts/kg-demonstrations.mjs at e664d4d); 279/279 mutations killed at 8b55cc0. Waits on the owner decisions in KG-4 (key custody incl. the snapshot key, traversal defaults, federation policy, qualification criterion, the advisory-to-live switch, lab breadth, snapshot retention, API-seat teardown) and KG-24. docs/knowledge-graph/operational-report.md."}'

$S '{"item":"kg-federation-integrity","title":"Federation hub integrity before production (KG-8, KG-14, KG-21, KG-22)","state":"Ready","checked":"2026-11-21","basis":"Hub readiness is NOT APPROPRIATE NOW: R5 fails (spliced and rolled-back exports imported, KG-14, KG-21) and R10 fails (replicas from one template share an anchor, KG-8); pure-hub separation not enforced (KG-22). Holes in packages/graph/federation.mjs, not in the shape (docs/knowledge-graph/hub-and-spoke.md). Nothing external awaited."}'

$S '{"item":"kg-register-open","title":"Knowledge-graph register entries still open","state":"Ready","checked":"2026-11-21","basis":"KG-2 (lock after SIGKILL), KG-5 (advisory record size), KG-6, KG-7, KG-9 (partly done), KG-10 (SDK jail retention), KG-12, KG-13 (fixture-only D1/D2 proofs), KG-15 to KG-18 (GLM 5.3 bounty findings), KG-19 (wall-clock test), KG-20 (shared tmpdir), KG-30 to KG-37 (dependency port; KG-30 for independent review). docs/knowledge-graph/operational-report.md section 5."}'

$S '{"item":"kg-live-evidence","title":"Knowledge-graph demonstrations on live models and a live owner workload","state":"On Hold","waiting_on":"evidence","checked":"2026-11-21","basis":"Every demonstration is synthetic or reads the repository at a commit: demonstration 11 uses scripted seats, the federation departments and capability metrics are synthetic, and no live execution record exists in the container. Needs real runs."}'

$S '{"item":"kg-39-provider-refusal","title":"Operate: a provider refusing the account stops the tick and uses no attempt (KG-39)","state":"In progress","owner_role":"impl@build","checked":"2026-11-21","basis":"Draft PR #84."}'

$S '{"item":"specialized-builders","title":"Specialized builders: real trades, tests written first","state":"In progress","owner_role":"lead@orch","checked":"2026-11-21","basis":"Design and requests merged as PR #86 (1e20dd8): specialized builders and four foundry fixes. Launch order (builders A, then B, then foundry fix 1) in draft PR #89; not yet implemented."}'

$S '{"item":"l001-l002-capacity","title":"Date the L-001/L-002 capacity figures and re-check them on main","state":"In progress","checked":"2026-11-21","basis":"Draft PR #85; docs/execution/l001-l002."}'

$S '{"item":"planning-fundamentals","title":"Planning fundamentals curriculum and coach","state":"In progress","checked":"2026-11-21","basis":"Merged as PR #4 (10893d4): curriculum, coach charter, CLI handoff, learning board, independent lesson planning and class evaluation; Lesson 1 and the LF-001 remedial class complete; continuation assigned to the planning coach."}'

$S '{"item":"co1-readability","title":"CO1: ophanim/ is expensive to review (6% comments, long lines)","state":"In progress","checked":"2026-11-21","basis":"#77 (22be382): whitespace-only wrap of 13 long lines in 6 files (token check 6/6 identical), long lines in scope 81 to 68, scripts/ast-equivalent.mjs with 43 tests. Remaining: the comment ratio, and long lines that are single literals or in byte-pinned files."}'
```
