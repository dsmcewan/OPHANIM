# Wave 3, sub-wave 3B-1 report (class-level verification)

**Base:** `5f24c68`, the integrated 3A. The ownership manifest is `docs/execution/wave-3-ownership.json` (subwave 3B-1). Three agents ran with no shared file; this was checked mechanically on every branch.

**Integrated onto:** `6cc403a`.

**Unchanged:** the frozen candidate `af0dc30`, the sealed self-audits (`449ca42`) and the independent-review evidence. No independent round-3 findings reached this work.

**L-123 still applies:** no claim here concerns an artifact's integrity after verification.

## Contributions and acceptance checks

The coordinator re-ran every base-failure figure below. For each, it restored the agent's production files to `5f24c68` and ran the agent's new tests there.

### 3b-evidence (L-504 invariant 1, L-106)
- **Branch:** `wave3/evidence-wake`, commits `915d0a7` and `6472d7e`.
- **Ownership:** 6 files, 0 problems.
- **Base failure:**
  - `wave3-evidence`: **13 of 21 fail** on the base.
  - `wave3-wake`: the base already held all 17 tests, so each row is proved by a mutation instead.
- **Mutations:** 31 / 31 killed.

### 3b-identity (L-504 invariant 2)
- **Branch:** `wave3/identity-projections`, commits `30705d5` and `e7336e2` (the S7 test, added at the coordinator's request).
- **Ownership:** 17 files, 0 problems.
- **Base failure:**
  - ophanim `wave3-identity`: **51 of 69 fail**.
  - pantheon `wave3-identity`: **21 of 32 fail**.
  - The S7 test fails when only `stages.mjs` is restored.
- **Mutations:** 48 / 48 killed.

### 3b-agy-spend (L-504 invariants 3 and 4, L-124)
- **Branch:** `wave3/agy-guard-spend`, commits `1537124` and `d1a63cc` (the board identity patch, routed from 3b-identity).
- **Ownership:** 8 files, 0 problems.
- **Base failure:**
  - `wave3-agy-guard`: **77 of 79 fail**.
  - `wave3-spend`: **9 of 42 fail**. Paths that held on the base are proved by mutation.
- **Mutations:** 23 / 23 killed.

### Routed patches

Each patch was applied by the owner of the file it touches, with a test that fails without it:
- `3b-agy-spend-1` was applied by 3b-identity: a model-guard refusal is recorded with both identities and blocks the unit.
- `3b-identity-1` was applied by 3b-agy-spend: the board records an unnamed serving model as unknown.

## Integrated result

**Branch:** `wave3b1/integration`. The order was:
1. 3b-evidence merged;
2. 3b-identity merged;
3. 3b-agy-spend merged;
4. a `docs/review-independence.md` section (coordinator);
5. the register and this report.

There were no conflicts.

**Environment:** Node 24.22.1, bwrap working, 4 cores. Every exit code was read directly.

| Step (as CI runs it) | Exit | Wall | Result |
|---|---|---|---|
| Test gate, every suite re-run per file | 0 | 468 s | PASS: model-client 62, ledger 47, pantheon 1598, proof 500, gates:self 26; fail, cancelled and skipped 0 everywhere |
| `npm test` | 0 | 221 s | 62 / 47 / 1598, no fail, cancel or skip |
| `npm run test:proof` | 0 | 198 s | 500, no fail, cancel or skip |
| `npm run test:gates:self` | 0 | 32 s | 26, no fail, cancel or skip |
| Test gate on the logs | 0 | 0 s | PASS |
| Test lint (report-only) | 0 | 1 s | 105 findings, the same set as before; none in wave 3 files |

**Real-bwrap suites:** 19, unchanged.

**Mutation runners on the integrated tree:**

| Runner | Killed |
|---|---|
| wave3-evidence | 31 / 31 |
| wave3-identity | 48 / 48 |
| wave3-agy-spend | 23 / 23 |
| wave 2 `wave2-identity` | 22 / 22 |
| wave 2 `reliability-wave2b` | 33 / 33 |

That is **157 of 157 killed**. Each runner checked that every target applies exactly once and exited 0. No cross-branch interaction let a mutation survive.

**A first run failed at setup, not in the code.** The `public-types` test failed because `npm ci` inside `pantheon/` removes the root's dev dependencies (`typescript`). CI runs only the root install. After a root reinstall the run above is clean. The 3B-2 briefs tell agents not to run the pantheon install.

## Status by entry

**L-504: qualified.**

- **Invariant 1** (version = delivered bytes): repaired for every retriever op and consumer.
  - Defects fixed: `show`; `status`; the requirement view; another item's `work` view; the file re-check of newly refused bytes; and the contract of empty `grep` and `log`, `work` and `record`.
  - Not re-checked against the present, by policy: an item's own `work` view and a stage's own output.
- **Invariant 2** (identity through every projection): repaired or covered for every enumerated projection, including the board's contributor rows. Seat rows deliberately name the seat asked.
- **Invariant 3** (the Antigravity model guard): checked before any result is acted on, at every entry point. Exceptions:
  - the owner's diagnostic probe, which has no test;
  - the operator path `seat/turn.mjs` (L-135).

  Further limits: the SDK seat compares only what its own script reports, and a failure without an `init` line keeps its classification.
- **Invariant 4** (no metered spend with failover off): holds for every seat on the paths that carry the switch. Entry points without the switch are recorded as L-136.

**Other entries:**

| Entry | Status |
|---|---|
| L-124 | **Repaired.** The SDK seat refuses billed use with failover off, before admission and spawn. |
| L-106 | **Class covered.** Every stage that can wait, plus the collision and attempt-bound wakes. The base held; this is proved by mutations K1–K10. |

## Effects to know

**Migration (invariant 1):** these records will see a new-form version once:
- records made before `915d0a7` that cite `show`, `status`, `work`, `record`, an empty `grep` or `log`, or the requirement view;
- plans waiting on evidence, which will see a changed `stable` digest once.

Each affected record is re-planned or re-validated once.

**L-136, the service default:** `operate tick`, `watch` and `serve` (and four other CLIs) carry no metered-failover switch, so they default to metered Gemini failover **on**. Only live-run carries the switch from its manifest. This needs an owner decision.

## New register entries

| Entry | Item |
|---|---|
| L-135 | the operator `seat/turn.mjs` agy turn is unjailed, with no model |
| L-136 | entry points without the failover switch |
| L-137 | `pipelineTurns` wiring |
| L-138 | plan `copy` path containment |
| L-139 | legacy attempts never wake |
| L-140 | the `stage5Keys` own-dispatcher exemption also exempts an author |
| L-141 | `subagentReceipt` resolves non-xAI names by string |
| L-142 | a fixture marker outside the vocabulary |

L-128 is extended: a throw without admission is uncharged.

## Next

Sub-wave 3B-2 (L-503): review all 105 lint findings and enforce the lint in CI. Two agents work on separate trees, from this integrated commit.
