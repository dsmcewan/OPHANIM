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

- **`limits.total_provider_calls` is required.** It caps every provider call the work ledger records over its lifetime, failed and resumed attempts included, across restarts. Usage that was not recorded counts at the claim's full budget.
- **The other limits** are per tick, with the same meanings as for `tick`: `stage_provider_calls`, `iterations`, `elapsed_ms`, `stage_attempts` and `concurrency`.
- **One instance per work ledger.** A lock file in the work ledger's root (`<work_ledger>/service.lock`, whatever the `state_dir`) holds the pid and host.
  - A second service is refused.
  - A dead process's lock on this host is taken over, and the takeover is logged.
  - A lock held from another host is refused.
- **No controller key** (`status/work/keys`): the service stops with exit 3 (`NO_AUTHORITY`) and records nothing.
- **Tick errors** are retried after the interval. After `max_consecutive_errors` in a row, the service stops.

## Stopping

SIGTERM or SIGINT stops the service between ticks. If the process is killed during a stage, that stage's claim lease expires. The next start then releases it as `expired` and resumes from the last recorded stage. No completed stage is repeated.

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
