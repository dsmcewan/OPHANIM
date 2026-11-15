# Ophanim

Ophanim coordinates planning and execution through a persistent blackboard. The blackboard exposes ready obligations. The scheduler assigns work. Workers produce evidence. TELOS verifies what can become accepted state.

The inherited Pantheon engine lives in `pantheon/`. Its public adapter entry point is `pantheon/src/index.mjs`. The companion model client is in `packages/model-client/`. ARGO-specific native Git and Mesh adapters remain in ARGO.

Use Linux, Node 24, Python 3 and Bubblewrap for the inherited acceptance suite.

```sh
npm ci --ignore-scripts
npm test
```

The [provenance record](PROVENANCE.json) records the ARGO source and filtered Git lineage. ARGO retains the historical `pantheon-seat-core/` as an archive.
