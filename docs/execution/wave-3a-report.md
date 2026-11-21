# Wave 3, sub-wave 3A report (qualification infrastructure)

Base `ef78a74`, with the ownership manifest at `docs/execution/wave-3-ownership.json` (subwave 3A, two agents, no shared file; checked mechanically by `docs/execution/check-ownership.mjs`). The frozen candidate `af0dc30`, the sealed self-audits (`449ca42`) and the independent-review evidence are unchanged. No independent round-3 findings reached this work.

## Contributions and acceptance checks

| Agent | Branch, commit | Ownership (mechanical diff check) | Regression evidence | Mutations |
|---|---|---|---|---|
| 3a-lock (L-126) | `wave3/review-runner-lock` `e120fe9` | 2 files, 0 problems | **Re-run by the coordinator:** with `ef78a74`'s `index.mjs` restored, the new real-process test fails 3 of 3 (exit 1); with the fix it passes 3 of 3. | 8 of 8 killed (each runs the runner's add, remove or prune outside the lock, keys the lock on the wrong path, or releases it before git exits); runner exit 0 |
| 3a-gate (L-505, L-506) | `wave3/test-gate` `4cb1784` | 16 files, 0 problems (`package.json` scripts and the workflow's test steps only) | **Agent's evidence, checked by the coordinator in `evidence-base.txt` / `evidence-new.txt`:** on the `ef78a74` gate, the three hang fixtures gave **no verdict** (the gate itself hung, killed after 60 s), and exit(0), exit(1), SIGKILL and timer-throw in non-bwrap files **passed** as CI ran it. A describe() that threw passed the logs gate. On the new gate each FAILS with its file named. A silent exit(0) in a *text log* still passes by nature; only the per-file run catches it. | 20 of 20 killed on `1f0357d`; runner exit 0. The final amend (`4cb1784`) changes only the `test:proof` step bound from 5 to 6 minutes. |

**Process note:** agent 3a-gate was stopped during its own final suite run, before it delivered a report. Its work was committed. The coordinator took the evidence above from the agent's recorded outputs and ran the full verification below on the integrated tree itself.

**Access-rule note:** a broad grep by agent 3a-lock printed a few lines of `docs/OPEN-LIMITATIONS.md` and `docs/execution/wave-2-ownership.json`. Neither file is review evidence, and the agent did not use them. No `findings-*` path was read by either agent.

## Integrated result

Integration branch `wave3a/integration` on `ca578bd`: agent 3a-lock merged, then agent 3a-gate, then the register and this report. The steps were run in CI's order, under Node 24.22.1 with bwrap working (4 cores). Every exit code was read directly.

| Step (as CI runs it) | Exit | Wall | Result |
|---|---|---|---|
| Test gate, every suite re-run per file | 0 | 463 s | PASS: model-client 62, ledger 47, pantheon 1442, proof 384, gates:self 26; fail, cancelled and skipped 0 everywhere |
| `npm test` | 0 | 235 s | 62 / 47 / 1442, fail 0, cancelled 0, skipped 0 |
| `npm run test:proof` | 0 | 199 s | 384, fail 0, cancelled 0, skipped 0 |
| `npm run test:gates:self` | 0 | 32 s | 26, fail 0, cancelled 0, skipped 0 |
| Test gate on the logs | 0 | 0 s | PASS |
| Test lint (report-only) | 0 | 1 s | 105 findings, unchanged |

The real-bwrap suites derived from source number 19, matching the baseline.

## Status by entry

| Entry | Status |
|---|---|
| L-126 review runner lock | **Repaired** (`e120fe9`). Siblings outside the lock are recorded: L-130 (the integration-branch `update-ref -d`) and the probe's add on its private repository. |
| L-505 hung tests and files | **Qualified** (`4cb1784`): every file CI runs finishes or fails, named, within bounds. Out of scope: a hang outside any test names only the file; a process that leaves its process group survives the watchdog. |
| L-506 files that end early | **Qualified** (`4cb1784`): CI runs every suite per file, and incomplete execution fails, attributed to its file. Out of scope: a conditionally skipped registration cannot be detected. |
| L-503 | Unchanged except that the per-file run now covers every suite. Lint enforcement is planned for 3B-2. |

## New entries

- **L-133:** a flake in a wave-2b test caused by an unlocked `git branch --list`.
- **L-134:** CI now runs every test twice. The test steps take about 15.5 minutes locally against a 25-minute job, so a slow runner fails closed on a step bound.

## Effect on 3B

3B's tests now run under the new gate:
- a 120 s per-test timeout, unless a test declares its own;
- a per-file watchdog;
- a failure for any file that does not report its own summary.

3B's qualification claims rest on this gate.
