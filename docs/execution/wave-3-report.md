# Wave 3: integrated verification report

**Authorization.** The owner authorized Wave 3 on 2026-11-19:
- **3A, qualification infrastructure:** L-126, L-505 and L-506.
- **3B:** L-504's four invariants, L-124, L-106 and L-503.
- 3A was to be integrated and verified before any final qualification claim from 3B.

**Base.** `ef78a74`.

**Integrated result.**
- `wave3b2/integration`, on the branch `ccr-aa24f0d5-336szn`.
- Sub-wave reports: `wave-3a-report.md`, `wave-3b1-report.md`, `wave-3b2-report.md`.
- Ownership manifest, with mechanical checks: `wave-3-ownership.json`, `check-ownership.mjs`.

**Preserved.**
- The frozen candidate `af0dc30`.
- The sealed self-audits on `audit/round3-self-audit`, at `449ca42`.
- The independent-review evidence (`docs/reviews/**/findings-*`).

No agent read independent round-3 findings.

**Process.**
- Seven agents ran in four sub-waves (3A, 3B-1, 3B-2, plus the 3B-2 follow-ups).
- No two concurrent agents owned the same file; this was checked mechanically before every dispatch and on every branch.
- Cross-owner changes were applied by the owner of the file, as routed patches, each with a test that fails without it.

## What is established, by level

The levels follow the register's definitions:
- **Repaired:** a reproduction is fixed, and its regression test fails on the pre-fix code.
- **Class covered:** every sibling path is listed and is either fixed and tested or ruled out with evidence.
- **Qualified:** the invariant holds within a stated scope, at the real execution boundary.

### Repaired reproductions

The coordinator re-ran every base-failure figure below.

| Entry | Reproduction | Evidence |
|---|---|---|
| L-126 | The review runner mutated the worktree list outside the repository lock. | The real-process test fails 3 of 3 on `ef78a74`. 8 of 8 mutations killed. |
| L-124 | The agy SDK seat spent with metered failover off. Its only protection was that the key was withheld. | The SDK rows of the spend test fail on `5f24c68`. Mutations S6 and S7 are killed. |
| L-143 | The recorded codex argv named the binary twice under the outer runtime. Found by the lint review. | The whole-argv test fails 1 of 7 on the unfixed code. Mutation M21 is killed. |

### Covered defect classes

| Entry | Class | Evidence |
|---|---|---|
| L-106 | The status-entry wake, for every stage that can wait: plan, implement, review, validate and outcome. Also the attempt-identity collision wake and the scheduler attempt-bound wake. Each is tested through `tick` and through the service. | The base already held, so each row is proven by a killed mutation (K1–K10). |

### Qualified invariants

Each invariant has a stated scope; the full text is in the register.

- **L-504 invariant 1, version = delivered bytes.**
  - *Repaired:* every retriever op and consumer. On `5f24c68`, 13 of 21 rows fail. 31 mutations killed.
  - *Outside the scope:* an item's own work view and a stage's own output, which are never re-checked against the present, by policy.
- **L-504 invariant 2, identity through every projection.**
  - *Repaired or covered:* every enumerated projection. On `5f24c68`, 51 of 69 rows fail in ophanim and 21 of 32 in pantheon. 48 mutations killed. The board contributor rows were added by a routed patch.
  - *Outside the scope:* seat rows deliberately name the seat asked.
- **L-504 invariant 3, the Antigravity model guard.**
  - *Holds:* the served model is checked before any result is acted on, at every entry point the wave owns. On `5f24c68`, 77 of 79 rows fail.
  - *Outside the scope:*
    - the owner's diagnostic probe, which has no test;
    - the operator path `seat/turn.mjs` (L-135);
    - the SDK seat, which compares only what its own script reports;
    - a failure without an init line, which keeps its classification.
- **L-504 invariant 4, no metered spend with failover off.**
  - *Holds:* every seat on the paths that carry the switch. On `5f24c68`, 9 of 42 rows fail; the rest are proven by mutation. 23 mutations killed in all, across the guard and spend tests.
  - *Outside the scope:* entry points that carry no switch (L-136).
- **L-505, hung tests and files.**
  - *Holds:* every file of every suite CI runs finishes or fails, named, within bounds far below the job limit.
  - *Outside the scope:* a hang outside any test names only the file; a process that leaves its process group survives the watchdog.
- **L-506, files that end early.**
  - *Holds:* incomplete execution fails, attributed to its file, in every suite.
  - *Outside the scope:* a registration skipped under a wrong condition cannot be detected.
- **L-503, the lint review and enforcement.**
  - *Done:* all 105 findings were reviewed, and the lint is enforced in CI with reasoned suppressions only. The verdicts were 25 real defects (each fix proven by mutation), 43 sound and 37 rule misreads. 25 single-line suppressions remain, each with its reason.
  - *Outside the scope:* the lint is a heuristic, and its blind spots are L-144.

### The integrated tree

All of the following ran on the integrated tree, under Node 24 with bwrap working.

| Suite | Tests | Result |
|---|---|---|
| model-client | 62 | pass |
| ledger | 47 | pass |
| pantheon | 1598 | pass |
| proof | 500 | pass |
| gates:self | 35 | pass |

- **Gates:** the per-file run and the logs gate both pass. Every suite has fail 0, cancelled 0 and skipped 0.
- **Lint:** enforced, with 0 unsuppressed findings.
- **Mutations:** 157 of 157 killed across the five committed runners (wave 3 and wave 2).

CI history on the branch:
- **`5f24c68` failed CI once.** The new 120-second per-test bound cancelled a credential-isolation test, which runs 4–7 times slower on the CI runner. It was fixed at `6cc403a` with a declared bound; no assertion changed. Recorded under L-134.
- **Passed CI:** `6cc403a`, `09bc5fb` and `ffcafb4`. The CI run on this integration is pending at the time of writing.

## Limits on these claims

- **L-123 bounds every artifact-integrity claim.** The verify jail mounts the worktree read-write. Nothing in Wave 3 claims that an artifact is unchanged after verification, and no such claim may be made until that boundary is addressed.
- **Mutation testing shows only that each enumerated path's test detects the listed regressions.** The enumerations were made by the agents from the code and checked by the coordinator through spot re-runs of the base failures. They are not a formal proof of completeness.
- **The test lint finds three patterns.** It does not find every test that cannot fail (L-144).

## Remaining limitations (open, not addressed by Wave 3)

The register holds 43 open entries:
- L-108 to L-113, L-115 to L-120, L-122, L-123, L-125;
- L-127 to L-142, L-144, L-145;
- L-402, L-403, L-405, L-406, L-408, L-409;
- L-601 to L-604.

Also unresolved are L-003 (pending owner) and L-004 (retained, owner-directed). These remain explicitly unresolved. The ones that need the owner's attention first:

- **L-136.** `operate tick`, `watch` and `serve`, and four other CLIs, carry no metered-failover switch and default to metered Gemini failover on. This needs an owner decision on the default.
- **L-123.** The writable verification boundary; it constrains every artifact-integrity claim.
- **L-135.** The operator `seat/turn.mjs` agy turn runs unjailed, with the whole environment and no requested model.
- **L-134.** CI runs every test twice, using about 17–20 minutes of the 25-minute job.

## Effects to know

- **Version-scheme migration (invariant 1).** Records made before `915d0a7` that cite `show`, `status`, `work`, `record`, an empty `grep` or `log`, or the requirement view will see a new-form version once. Plans waiting on evidence will see a changed `stable` digest once. Each such record is re-planned or re-validated once.
- **Model guard.** A model-guard refusal (`AGY_MODEL_MISMATCH`) now blocks the pipeline unit instead of revising on the same lane or stepping to another model.
- **Metered refusal.** A metered-spend refusal (`METERED_GEMINI_DISABLED`) is recorded as an attempt refused with zero provider requests.
- **Per-test bound.** Tests needing more than 120 seconds must declare their own bound. Two do.
