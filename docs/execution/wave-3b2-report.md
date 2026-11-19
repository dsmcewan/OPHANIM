# Wave 3, sub-wave 3B-2 report (test-lint review and enforcement, L-503)

**Base:** `09bc5fb`, the integrated 3B-1. **Manifest:** `docs/execution/wave-3-ownership.json`, subwave 3B-2. Two agents worked on separate trees; the follow-up ownership was amended at `ffcafb4`. Every branch was checked mechanically, with 0 ownership problems. The frozen candidate, the sealed self-audits and the independent-review evidence are unchanged.

## The 105 findings, each reviewed on its merits

| Verdict | ophanim | pantheon and packages | Total | Handling |
|---|---|---|---|---|
| A: real defect, the test could not fail | 3 | 22 | 25 | Each test was fixed so it checks the whole property. Each fix is proven by a mutation that the `09bc5fb` test missed and the new test kills (4 + 20 mutations, plus M21 for the P1 test). |
| B: sound, but the rule cannot see why | 29 | 14 | 43 | 26 were restructured with assertions as strong or stronger. 17 were suppressed on one line each, with a specific reason. |
| C: rule misread | 5 | 32 | 37 | 28 were resolved by refining the rules: R1, plus refinements F1–F4. 1 was rewritten as an equivalent. 8 are input-building slices, suppressed on one line each. |

**Production defect found (L-143, repaired at `873a203`).** The review runner's recorded codex argv named the binary twice under the outer runtime. The review evidence therefore misstated the command that ran. The test made whole by the lint review fails 1 of 7 on the unfixed code. The coordinator re-ran this.

**Rule refinements (agent 3b-lint-ophanim, `1583745` and `5c9b5ff`).** Each refinement has self-tests in both directions. Each also has two mutations:
- a revert, killed by the misread test;
- an over-broad version, killed by the true-case test.

**Regression check.** The coordinator re-ran it on an archive of `09bc5fb` with the refined rule. All 25 (A) findings still fire, and the total falls from 101 to 77. Two broader exemptions were proposed and refused, because each one stopped an (A) finding from firing.

**Enforcement.** The qualification workflow runs `npm run test:lint -- --enforce`. Any unsuppressed finding fails the job. A suppression is rejected unless it has a reason of at least five words. The gate's coverage check fails if:
- the step stops enforcing;
- the step discards its exit status;
- the step narrows its paths;
- the `test:lint` script stops running the lint.

These enforcement properties are covered by 11 mutations, all killed.

## Integrated result

**Branch:** `wave3b2/integration`. Agent 3b-lint-ophanim was merged first, then agent 3b-lint-pantheon. There were no conflicts. Node 24.22.1, bwrap working. Every exit code was read directly.

| Step (as CI runs it) | Exit | Wall | Result |
|---|---|---|---|
| Test gate, every suite re-run per file | 0 | 461 s | PASS: model-client 62, ledger 47, pantheon 1598, proof 500, gates:self 35; 0 fail, 0 cancelled, 0 skipped |
| `npm test` | 0 | 208 s | 62 / 47 / 1598, clean |
| `npm run test:proof` | 0 | 187 s | 500, clean |
| `npm run test:gates:self` | 0 | 32 s | 35, clean |
| Test gate on the logs | 0 | 1 s | PASS |
| Test lint, `--enforce` | 0 | 0 s | 0 unsuppressed; 25 suppressed (truncated-sequence 10, scripted-terminal-status 15); 0 rejected |

**Mutation runners on the integrated tree.** All five exited 0; every target applied exactly once and every mutation was killed.

| Runner | Killed |
|---|---|
| wave3-evidence | 31 / 31 |
| wave3-identity | 48 / 48 |
| wave3-agy-spend | 23 / 23 |
| wave2-identity | 22 / 22 |
| reliability-wave2b | 33 / 33 |

The wave 2b runner was re-run after a container restart interrupted it.

## Status

| Entry | Status |
|---|---|
| L-503 | **Qualified** (see the register for scope). The lint is a heuristic for three patterns; its blind spots are L-144. |
| L-143 | Repaired. |
| L-144 | New: the lint's blind spots. |
| L-145 | New: a guard test that today checks zero seats. |
