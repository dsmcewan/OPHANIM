# Fixture governance evidence

The adapter uses the pinned TELOS implementation with local synthetic identities.
Its fixed initialization has seven signed events: draft, creation call, candidate,
three independent fixture review records, and authorization decision. A restart
validates the retained chain and requires every existing event to equal the exact
expected prefix for that request. It preserves those records and appends only
missing events through TELOS's locked, verified head check. Missing fixture review
packets can be reconstructed only as the exact deterministic signed packets.

Torn JSON, invalid signatures, different signed events, conflicting packets, and
retained writer locks remain refusals. Recovery never truncates or deletes this
evidence or removes a lock on the assumption that its owner has died. These states
need inspection; the fixture recovery does not claim arbitrary journal repair.
Read-only verification does not perform initialization or recovery.

Retained proofs currently bind absolute workspace, checker, and Node executable
paths. They are verified in their original locations. Moving the checkout, state
directory, or executable is not a supported proof migration: retain the original
evidence and produce a fresh qualification in the new location. No path or proof
schema migration is implemented here.

Run the focused checks with:

```sh
node --test ophanim/governance/governance.test.mjs
```

The interruption tests reconstruct each durable initialization boundary, including
the packet-before-decision boundary, and check preservation of the signed prefix.
Separate negative cases preserve and reject torn, forged, validly signed but
conflicting histories, and conflicting review packets.

## Scheduler efficiency authority

`verifyEfficiencyCandidate({candidate, evidenceRoot})` accepts only the closed
baseline slot change from 1 to 3, for one exact fixture, obligation graph, worker
artifact, implementation policy, and original accepted result. The separate
`check-efficiency-artifact.mjs` executable preserves the original checker bytes
and legacy proof bindings. It verifies retained file hashes, the original signed
acceptances, all eight controlled replay trials, CAS publications, accepted node
proofs, exact outputs, and one destination application per effect. Stage p95 and
worker input byte counts are derived again from retained controller evidence.

Admission requires three alternating pairs plus a recovery trial at each width.
The worst candidate must improve on the best baseline by at least 10% and 100 ms;
stage p95 and recovery must stay within the explicit conservative bounds. A
forecast of twenty matching convergences must exceed the measured trial cost.
The initial realized net value remains negative by that cost. These are local
wall-clock measurements with zero model calls, not provider savings or attested
remote timing. Insufficient benefit returns `no_change` without authority to
change the scheduler.

Only the guarded controller calls `issueEfficiencyDecision` after admission.
The signed decision binds the exact policy, scope, baseline release, slot change,
and evidence. `verifyEfficiencyDecision` normally checks that signed decision,
the retained signed plan and artifact receipt, exact expected fields, current
source policy, and unchanged manifest without rerunning the benchmark checks.
Pass `replayEvidence: true` for full independent retained-evidence replay. Neither
verification mode runs new business work or directly changes scheduler slots.
