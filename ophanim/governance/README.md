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
