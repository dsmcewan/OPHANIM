# The execution service

`node ophanim/operate/cli.mjs serve --config FILE` keeps the governed lifecycle running: plan, implement, review, validate and outcome. It runs where the provider keys and the controller key are. Code: `ophanim/operate/service.mjs`. Templates: `ophanim/operate/service/`.

## What it does each turn

1. **Ticks when something changed or a retry is due.** What counts as a change: the status ledger head, the work ledger head, the tickets, or the published issues. A due retry is a transient wait, such as a reviewer seat that failed.
2. **Each tick:**
   - releases claims whose lease expired, which is how interrupted work resumes;
   - records intake;
   - searches for completion evidence for Resolved items that lack it (see below);
   - dispatches ready stages in dependency order, within the limits.
3. **Writes its state:**
   - `<state_dir>/service-status.json`: running, error, blocked or stopped, plus a heartbeat, the last tick and the provider calls spent against the cap;
   - one line per event in `<state_dir>/service.jsonl`.

## Bounds

- **`limits.total_provider_calls` is required.** It caps every provider call the work ledger records over its lifetime, failed and resumed attempts included, across restarts. A provider call is one billed request, as defined in [What one provider call is](routing-task-profile.md#what-one-provider-call-is): each is charged on the work ledger before it is sent.
- **A stage that throws** is recorded with what it was charged, 0 included. Usage counts at the claim's full budget only when it is genuinely unknown: the executor says it made calls outside the charge. Before this, a stage that threw having made no call consumed its whole stage budget (self-audit round 3, assignment 3, L-302).
- **The other limits** are per tick, with the same meanings as for `tick`: `stage_provider_calls`, `iterations`, `elapsed_ms`, `stage_attempts` and `concurrency`.
- **`billing` (optional): the Gemini billing policy** of every tick ([docs/billing-policy.md](billing-policy.md), register L-136). Absent, both settings are off: the metered Gemini failover of an Antigravity lane is refused (`METERED_GEMINI_DISABLED`) and no Gemini API seat is served as a primary (`GEMINI_PRIMARY_DISABLED`), whatever keys the environment holds. The subscription lanes are never refused. To enable a kind, declare it with its budget: `"billing": {"metered_gemini_failover": {"enabled": true, "budget": 20}}`. An enabled setting without a positive-integer budget, or an unknown key, refuses the config at startup (`GEMINI_BILLING_INVALID`), before anything runs.
  - The budget counts billed Gemini requests of that kind over the work ledger's lifetime: each is recorded as a `work.billing` entry before it is sent, so retries, restarts and later ticks draw on the same budget. A request past it is refused (`METERED_GEMINI_BUDGET_EXHAUSTED`) before it is sent.
  - A refused stage is not a failure: it is recorded as a transient pending with the refusal, its work (approved units' checkpoints, the attempt) is kept, and it is dispatched again once the refused kind's setting changes (a new budget, enabled). The service's `started` and `stopped` records and each tick record carry the policy and its consumption.
- **One instance per work ledger.** A lock file in the work ledger's root (`<work_ledger>/service.lock`, whatever the `state_dir`) holds the pid and host.
  - A second service is refused.
  - A dead process's lock on this host is taken over, and the takeover is logged.
  - A lock held from another host is refused.
- **One repository, several processes** (the service and an `operate tick`, or two ticks, on one checkout; self-audit round 3, assignment 3, L-303). Every change to the repository's worktree list goes through one lock that spans processes: `git worktree add`, `remove` and `prune`, and creating or deleting a run's integration branch. It covers a unit's worktree, the integration worktree, and orphan recovery. The lock is the file `<git common dir>/pantheon-worktrees.lock` (`pantheon/src/pipeline/git.mjs` `repoMutex`), so every linked worktree of the repository shares it.
  - The lock file names its holder: pid, host, process start time and boot id. A waiter polls until the lock is free. After 5 minutes it fails with `REPO_LOCK_TIMEOUT`, naming the holder.
  - A lock whose holder is dead is removed. Dead means a pid on this host that is not running, a pid now used by another process (its start time differs), or a holder from before the last boot. The waiter checks the lock again under a short "breaker" file before removing it, so it never removes a lock another process has taken in the meantime.
  - Residual risk: a waiter killed while it holds the breaker, followed by two waiters clearing that breaker at the same moment. That window is microseconds long.
  - A lock held from another host is never judged dead from here. It is waited for until the timeout.
  - The review runner (`pantheon/src/review-runner/index.mjs`) also adds and removes worktrees on its own repository. It does not take this lock yet.
- **No controller key** (`status/work/keys`): the service stops with exit 3 (`NO_AUTHORITY`) and records nothing.
- **Tick errors** are retried after the interval. After `max_consecutive_errors` in a row, the service stops.

## When an item is dispatched again

Each stage attempt is claimed under an **attempt identity** (`gates.mjs` `attemptInputs`, version 2): what the stage received, the requirement, the status entry, and the **routing basis**, which is what made the gate route the stage. The routing basis is the present state the gate read: the ticket, the dependencies' entries, the evidence that made an earlier record stale and what it reads now, or a wake condition. It is never a record hash. So:

- **Something the gate reads changed** (a cited file, the ticket, a dependency, the status entry, the evidence a validator relied on): the stage is new work and is dispatched, bounded by `stage_attempts` on that identity.
- **Nothing changed**, yet the gate routes the stage again: the work is already done. Reconciliation reports the item **blocked** with `ATTEMPT_IDENTITY_COLLISION` and the reason. This shows in `tick`, `watch`, the service log and the CLI, not as a silent skip.
- **A transient retry** (a reviewer seat that failed) keeps the identity of the attempt it retries, so retries stay bounded.

A **structural block** waits for something it can observe:

- **Review capacity** (`REVIEW_CAPACITY_PENDING`): the block records the reviewer pool's signature (seating, seat facts, configured pools, n, independence, profile). The stage is dispatched again when the executors' pool signature differs. A reader with no executors, such as a status view, cannot see the pool and shows the item blocked.
- **Any structural block:** the owner records a new status entry of the item. That is the owner's signed "resume", dispatched once per new entry.
- **An outcome after a new status entry:** the proposal is made against the entry the gate routed on, and the record names both entries. Before this, it was refused ("re-dispatch it") and blocked for good.

A **passed outcome** awaits the owner only while its proposal file is the one recorded and its evidence still re-checks as `status.mjs apply` would. Otherwise the outcome is produced again.

Ledgers written before version 2 keep verifying. A key is compared, never re-derived from inputs. Their structural blocks do not record the status entry they ran against, so a new status entry does not wake them; a capacity block from before version 2 is re-asked once, at no provider cost.

## Stopping

SIGTERM or SIGINT stops the service, and also `cli.mjs tick` and `watch` (self-audit round 3, assignment 3, L-121). The stage in flight is stopped too, not only the loop: the signal is passed to `tick` as its `interrupt`.

- The stage gets the stop on its signal. A live seat aborts its request or its CLI process.
- Its claim is released as `interrupted`, with no stage record. The late result is not a handoff, and the calls charged under the claim stay counted.
- The next start resumes the item at once.
- A watch that is waiting between polls ends at once.
- If the command has not returned 10 seconds after the signal, or a second signal arrives, every claim it still holds is released as `interrupted` on the work ledger, and the process exits with 128 + the signal number.

The lease fence is unchanged: a released claim can record and charge nothing. `tick`'s `interrupt` is described in `ophanim/operate/scheduler.mjs` (L-305). The live-run launcher works the same way on SIGINT, SIGTERM and SIGHUP.

If the process is **killed** during a stage (SIGKILL, a power loss), that stage's claim stays held **until its lease ends**: `lease_ms`, 30 minutes by default. Nothing can claim the item before then; the lease is the fence that keeps two holders from running one stage. The item shows gate `claimed`. Once the lease has ended, the next tick releases the claim as `expired` and resumes from the last recorded stage. No completed stage is repeated. A restart does not shorten the wait.

The killed attempt's run is cleaned when the item's next implement attempt starts (L-304). That attempt removes the run's worktrees and its integration branch, `pantheon/pipeline/<run_id>`. A run that is still live is left alone. So is a run that ended: its branch is either handed on or kept as evidence.

## Evidence recovery for Resolved items

This covers items the status ledger shows as Resolved on an attested basis only. The service searches the item's retained runs: `bundles` in the config, and the outcomes on the work ledger.

A run's proposal is used only when **all** of these hold:

- it proposes Resolved for this item;
- it was made against a requirement that is still the item's;
- it passes the status ledger's proposal rules, which include a verified close by three labs;
- everything it cites re-checks structurally;
- its commit exists in the repository.

What happens next:

- **A proposal applies:** the service writes it **unsigned** under `status/operate/recovery/<item>/`.
- **Nothing applies:** the item stays an evidence gap, recorded with what was searched. It is searched again only when its sources change.

The service never records a status. The owner applies a proposal with:

```
node packages/ledger/status.mjs apply <proposal>
```

To re-verify an item with nothing recoverable, the owner records it Ready again, and it goes through the lifecycle.

## Install

- **Linux:** `ophanim/operate/service/ophanim-operate.service` (a systemd user unit). It does not restart on exit 3.
- **macOS:** `ophanim/operate/service/com.ophanim.operate.plist` (a launchd agent).
- **Config:** start from `ophanim/operate/service/service.example.json`.

Provider keys and `GITHUB_TOKEN` come from the environment, never from these files.
