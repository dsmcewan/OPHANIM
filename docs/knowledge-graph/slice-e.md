# Knowledge graphs, Slice E: federated instances

**Contract** `ophanim.graph/v1` (unchanged; no schema change was needed) plus two federation record formats, `ophanim.graph.export/v1` and `ophanim.graph.notice/v1` (`packages/graph/federation.mjs`).
**Slice** E of the program the owner's directive of 2026-11-20 sets (`docs/knowledge-graph/directive-2026-11-20.md`, section 6 and demonstration 10). Built on Slice A (`docs/knowledge-graph/architecture.md`, `packages/graph/`), whose files are unchanged except one export line in `packages/graph/index.mjs`.
**Base** `b10cf0a` on branch `kg/slice-e`.
**Decisions** KE1 to KE9 are the coordinator's (the Slice E brief). This document says how each is implemented; it does not reopen them. It is for the coordinator to fold into the architecture document.
**Synthetic.** The demonstration uses two synthetic departmental instances (Finance and Technology) and a central instance, each on its own real `packages/ledger` chain with synthetic keys. No real enterprise data exists here, and no provider is reached.

## 1. What this is, in one paragraph

Each OPHANIM instance keeps its own graph: its own graph ledger (so its own anchor), its own sources, its own namespace (`<instance>/<domain>/<type>/<key>`). A department **exports** a permitted projection of what it currently establishes, under an explicit **access policy** that enforces every assertion's `scope` (register KG-3), signs it and chains it after its previous export in its own outbox. The **central** instance pulls those exports when it can reach a department, checks them, keeps them in its inbox, and imports each one as a **registered source** of its own graph, by version, in order. It never writes into a department: the facts it imports are re-derived from the signed export at replay, owned by the department, and its own write boundary refuses anything in a department's namespace. **Cross-department dependencies** are links the central derives from the departments' **cross-instance references**, with the two imported facts as inputs, so a link is stale the moment either side changes. A change a department exports reaches, through the central's projection, the other departments whose permitted relationships depend on it, as a signed **notice** that keeps the originating instance, version and ledger entry; the recipient pulls it and records it with its own key.

```
 finance instance                         central instance                                   technology instance
 ┌────────────────────────┐   export     ┌──────────────────────────────────────────┐ export ┌────────────────────────┐
 │ own ledger (anchor F)  │──(signed,───►│ inbox: exports, checked, by id            │◄───────│ own ledger (anchor T)  │
 │ own sources, keys      │  chained,    │ ledger (anchor C): one source per dept     │        │ own sources, keys      │
 │ outbox (its own)       │  policy-     │   federation.finance, federation.technology│        │ outbox (its own)       │
 │                        │  filtered)   │ linker: derived links from resolved refs   │        │                        │
 │ receive(notice) ◄──────┼──pull────────┤ outbox: signed notices per recipient       │        │                        │
 └────────────────────────┘              └──────────────────────────────────────────┘        └────────────────────────┘
```

## 2. The decisions as implemented

| Decision | Implemented in | How |
|---|---|---|
| KE1 the module | `packages/graph/federation.mjs`; one export line in `packages/graph/index.mjs` | domain-free; imports only `packages/ledger`, `packages/graph` and `node:` built-ins (the layering rule in `ophanim/ledger/layering.test.mjs` covers it). No other Slice A file changed. |
| KE2 instance identity | `identityOf`, `identityRefusal`, `referenceRefusal` | an instance is `{instance, anchor}`: its id and its graph ledger's genesis hash. A cross-instance reference is `{instance, anchor, node, version}`. Section 3. |
| KE3 export under an access policy | `definePolicy`, `ACCESS_CEILING`, `department(...).exportAt`, `exportRefusal` | section 4 |
| KE4 the central projection | `openCentral`, `centralOrigins`, the linker | section 5 |
| KE5 freshness and disconnection | `openCentral(...).freshness`, `catchUp`, `department(...).publish`, `pull` | section 6 |
| KE6 propagation and handoffs | export `changes`; `propagate`; `department(...).receive` | section 7 |
| KE7 synthetic departments | `packages/graph/tests/federation-fixture.mjs` | Finance and Technology plus a central, synthetic keys per test, every withheld value a synthetic sentinel |
| KE8 the schema | — | registered types only: `systems/process`, `systems/service`, `systems/api`, `systems/datastore`, `systems/dataset`, `evidence/observation`, `evidence/record`, `work/plan`; `depends-on`, `consumes`, `produces`, `implements`, `verifies`, `mentions`. No new type was needed. |
| KE9 this document | `docs/knowledge-graph/slice-e.md` | |

## 3. Identity and cross-instance references (KE2)

An instance is its id plus the anchor its graph ledger is pinned to (its genesis hash). The central pins each department it federates by `{instance, anchor, keys}` (the keys its exports are signed with). An export, a reference or a notice that names the right instance with another anchor is refused: a renamed or replaced ledger is a different instance.

A department records a dependency on another instance's node as a **cross-instance reference**, never as an edge to a node it does not hold: the attribute `federation_references` (`REFERENCES`) of one of its own nodes, `[{type, to: {instance, anchor, node, version}}]`. The type must be registered, allowed between the two endpoint types, and permitted by the policy. The `version` is the version of the node it relies on, as the other instance exported it: the hash of that instance's ledger entry that admitted the node's current established support. So a reference goes stale when, and only when, the node it names changes.

The central resolves a reference against what it imported (`resolve`, and every link it derives):

| Outcome | When |
|---|---|
| resolved | the instance is federated, the anchor is the pinned one, the node is among what that instance exports, at the version named |
| `unknown-instance` | the hub does not federate that instance |
| `wrong-anchor` | the anchor is not the one pinned for that instance |
| `not-imported` | nothing of that instance has been imported yet |
| `missing-node` | the node is not among what the instance exports. A withheld (restricted) node gives the same answer: the export never says which. |
| `stale-version` | the node is exported at another version; the answer names the current one so the referrer can reassess and re-pin |
| `malformed` | the reference is not `{instance, anchor, node, version}` |

Nothing unresolved is guessed: it is listed, with why, in `dependencies().unresolved`.

## 4. The access policy (KE3, register KG-3)

`definePolicy({id, version, access, relationships, placeholders, counts})`. `access` names a treatment per `scope.access`; the module enforces the coordinator's ceiling, so a policy may be stricter, never looser:

| `scope.access` | Ceiling (`ACCESS_CEILING`) | Treatment in the test policy | What the export carries |
|---|---|---|---|
| `public` | details, reference or withhold | details | id, domain, type, version, its permitted references, and `details`: its attributes (references aside) and the provenance of each established assertion (classification, origin, status, source id, authority and reference) |
| `internal` | reference or withhold | reference | id, domain, type, version and its permitted cross-instance references; no attributes, no source reference, no digest of either |
| `restricted` | withhold | withhold | nothing: at most a count (`withheld.nodes`), and an opaque placeholder where a permitted relationship needs it as an endpoint |

A node's access is the most restrictive of its established assertions' scopes; a relationship's likewise. A relationship is exported only if its type is in `relationships`, its own access is not withheld, and at least one endpoint is exported; a withheld endpoint becomes `{placeholder}` when `placeholders` is on, else the relationship is withheld. Withheld relationships and references are counted when `counts` is on. A policy that names a type the central could not admit across the boundary (an import is authoritative from a declared basis, a link is derived from a declared basis) is refused: `qualified-for` cannot cross; a measured qualification crosses as its evidence (the observation and its `verifies` edge).

What never leaves a department, whatever the policy:

- **source nodes** (`evidence/source/*`): they commit to the digest of a whole source, withheld parts included;
- **source digests**: a public node's details carry its source's id, authority and reference, not `source.version` (a digest over the whole source); the node's own `version` (a ledger entry hash, which reveals nothing of the content) is its provenance instead;
- **digests of withheld content**: a node's version is a ledger entry hash, never an assertion id (which is a digest over the attributes);
- **withheld ids inside public text**: public details are scrubbed of any string or key naming a withheld node (its id, raw or decoded), replaced by `[withheld]`;
- **received notices**: recorded `restricted`, so they are never re-exported.

Placeholders are `placeholder:` + HMAC-SHA256 over `{instance, anchor, node}` keyed by a secret the department holds: stable across exports, not computable from the node id by anyone without the secret.

**Proven by search** (`federation.test.mjs` "withheld"): for each department, every attribute string, source reference, assertion id, attribute digest, source version and source-observation digest of every non-public established assertion, every form and digest of every restricted id, and the placeholder secret, are searched for in the serialized export; none appears. The same search over the central's whole directory (inbox, ledger, outbox) finds no withheld sentinel ("demonstration 10").

The central re-checks what it can without the department's ledger (`exportRefusal`): identity, audience, id, signature by a pinned key, chain fields, that every node, endpoint and change subject is the exporter's own, that no restricted node and no details of an internal one are present, and that no relationship joins two withheld endpoints. It cannot know whether a department labelled a node `internal` that should have been `restricted`: the department's classification of its own data is authoritative.

### The export record

`{schema: ophanim.graph.export/v1, contract, instance, anchor, version (ledger head entry hash), seq, previous (previous export id or null), exported_at, audience: {instance, anchor}, policy: {id, version, digest}, nodes, relationships, withheld: {nodes, relationships, references}, changes, id, signature: {key_id, sig}}`. `id` is the digest of everything but `id` and `signature`; the signature (Ed25519, the department's export key) covers the record with its id. `changes` lists what changed since `previous`: `{subject: {node} | {relationship: {type, from, to}}, change: added | changed | removed, because: superseded | retracted | invalidated | withdrawn | null, at: {seq, entry}}`, each with the department ledger entry it happened at.

## 5. The central projection (KE4)

`openCentral({dir, anchor, instance, departments, importKeys, linkKeys, maxAgeMs})`. Its own graph ledger, its own keys (`centralOrigins`: one import extractor per department and the linker rule). Each department is a **registered source** of the central graph, `federation.<instance>`: `current()` is the next export to import, `readAt(version)` re-reads that export from the inbox and checks it again, and the extractor projects its nodes and relationships as facts **owned by the department** (`scope.owner` the department, subject in the department's namespace). So the central ledger holds the import records (export id, digest of what was projected, what changed), not copies of the facts, and its state is re-derived from the exports it holds.

The central never writes into a department: it never opens a department's ledger (it holds no department key, and no department keyring holds a central key), and its **write boundary** (`centralRefusal`, on every central write including the linker's) refuses any record owned by another instance, any entity in another instance's namespace, and any record by an import origin outside an import. A department's own write boundary (`department(...).assert/supersede/retract`) refuses any record not owned by it or naming another instance's node, and its export refuses to present another instance's node as its own (`FEDERATION_FOREIGN`): it never takes in as its own what it does not own.

**Cross-department dependency discovery** is over the imported relationships only. After each import the linker derives, for every reference that resolves, the relationship it names (`depends-on(finance/systems/process/payment-run -> technology/systems/service/payments-api)`), as a `derived` assertion of the central's, with the two imported facts as its inputs and the reference as its attribute. Slice A's derived rule does the rest: when either fact changes (a new version imported), the link is current but stale, not established, until the reference resolves again, when it is derived anew and supersedes the stale one; a link whose reference its node no longer carries is retracted. Answers:

- `dependencies({now})`: every link (with whether it is established, and its reference), every reference that does not resolve (and why), every withheld endpoint a department declared (as a placeholder, never a node);
- `closure(start, {direction, now})`: Slice A's bounded, explained closure over the central projection, across instance boundaries, each node marked with its instance and staleness;
- `resolve(ref, {now})`.

## 6. Freshness, disconnection and recovery (KE5)

**Each import records** the export's id as the source version, its `exported_at` as `effective_at`, and the import time as `observed_at`, on the central ledger. `freshness({now})` gives per department `current`, `stale` or `never-imported`, with every reason: unreachable (recorded `unavailable` on the central ledger when a catch-up could not reach it, or this process's last fetch failed), older than its bound (`now - exported_at > maxAgeMs`; default `DEFAULT_MAX_AGE_MS`, one hour, the coordinator's), an export received but not yet imported, an import that could not be re-derived here. **Every central answer** (`dependencies`, `closure`, `resolve`) carries the freshness of the instances it used and a `stale` list, and marks each link or node that rests on a stale import; Slice A traversals also list the stale sources in their coverage. Nothing stale is silently trusted: the facts stay as last imported, marked.

**Independent operation.** A department needs nothing from the hub to write, replay, query, export or publish: its outbox is its own directory, chained by exclusive-create links so its export chain cannot fork. Only `pull` (receiving notices) needs the hub, and an unreachable hub is reported (`{reachable: false, why}`), never an error.

**Catch-up by version.** `catchUp({by, now})` fetches from every department it can reach (checking each export before storing it in its inbox; a second export after the same one is a fork, refused), records the unreachable ones, then imports every pending export **by version**: the next import of a department is always the export whose `previous` is the last one imported, so nothing is skipped and nothing is imported twice; departments are interleaved by export time. It derives links after each import and issues notices at the end. A repeated catch-up imports, links and issues nothing (Slice A's idempotency: the same source version is not observed twice; link and notice ids are content digests). Catch-ups are serialized by an exclusive lock in the central's directory (a lock whose holder died on this host, or older than `lockStaleMs`, is broken), so which notices an import calls for does not depend on how two processes interleave; without the lock each import is still recorded once (Slice A's cursor rule under the ledger lock).

**Recovery.** The central's projection is reproduced by replay from its ledger and the exports in its inbox (another process gets the same digest; `reconcile` is equal). An export missing from the inbox is not invented: replay marks that import not re-derived, its facts are absent, the department is stale, and links that rested on it are not established.

## 7. Propagation and handoffs (KE6)

A department's export lists its `changes`, each with the department ledger entry it happened at (for an invalidation, the entry that recorded the invalidating assertion). After importing an export, the central follows each change through its projection: the reverse impact closure of the changed node (or of a changed relationship's dependent end), in the views just before and just after the import. Each node reached in another instance came through a link the central derived; for each recipient it issues one signed notice (Ed25519, the central's notice key), written once to `outbox/<recipient>/<id>.json`:

`{schema: ophanim.graph.notice/v1, origin: {instance, anchor, export, version, seq, changes: [{change, because, at: {seq, entry}, subject}]}, via: {instance, anchor, seq, entry}, to: {instance, anchor}, references: [{node, type, reference, counterpart}], id, issued_at, signature}`

- **Provenance preserved**: the originating instance, its anchor, its export and ledger version, and each change's own ledger entry; `via` names the central import that carried it.
- **Minimal disclosure**: a notice names to its recipient only its own nodes where the change enters it, the reference it itself holds there, and a change's subject only if the recipient references that very node; the other changes are identified by their provenance alone. Nothing the policy withholds can appear: notices are built from exports.
- **Receipt**: the recipient pulls (`pull`) and `receive` checks the notice (id, signature by a pinned hub key, `via` the pinned hub, `to` this instance, every node named its own), records it in its own ledger as an `observed` `evidence/observation` by its own receiver key (`federation.receiver`), `restricted`, and returns the neighbourhood to reassess in its own graph: the reverse impact closure of the nodes the notice names (its restricted edges included, which the central never saw). It is a targeted reassessment, not an automatic invalidation. A repeat is a no-op.

A change to a restricted node is never exported, so it never propagates (the strict reading of "nothing is propagated that the policy withholds"): a department that wants a dependent to know must change something it permits to cross (for example the qualification evidence of the service that rests on it).

## 8. Verification

`packages/graph/tests/federation.test.mjs` (9 tests; real `packages/ledger` chains, one per instance, synthetic keys), with `federation-fixture.mjs` and `federation-child.mjs` (a second process):

| Test | What it establishes |
|---|---|
| demonstration 10 | three instances, three anchors; exports signed, versioned by the ledger head, addressed to the hub; public with details, internal as reference, a placeholder for a restricted endpoint, the restricted node only counted; the central imports both and derives `finance payment-run depends-on technology payments-api` from the reference; transitive closure across the boundary both ways; no withheld sentinel anywhere in the central's files; with both departments offline the central still answers, marked stale |
| withheld | the disclosure search above, per department; placeholders keyed and stable; a restricted change yields no change entry; policy ceiling refusals; a stricter policy; the central refuses a signed export carrying a restricted node or internal details |
| independence | the hub's directory gone: a department writes, publishes (chained, idempotent), replays to the same digest, queries, and `pull` reports the hub unreachable; on its return a fresh central process imports every export after the last, in order (none skipped), derives the link once, issues the notice once; a second catch-up changes nothing; re-offered exports store nothing; the notice is received once |
| freshness | each import records export, version and times; an unreachable department is recorded and stale in `dependencies`, `resolve`, `closure` and traversal coverage, read from the ledger by another process too; an export past its bound is stale; reconnection and heartbeats make both current again |
| propagation | an invalidation in Technology, its change entries at the invalidating entry (checked against Technology's ledger); one notice to Finance, none to Technology; provenance; minimal disclosure (no withheld sentinel, no unreferenced node); receipt with Finance's own key, restricted; the local neighbourhood; altered, wrongly signed and misaddressed notices refused |
| references | wrong anchor (a replaced ledger with a new genesis), missing node, withheld node (indistinguishable), unknown instance; only the resolving reference linked; a stale version after Technology changes the API (link stale, reference unresolved with the current version); re-pinning derives the link again; an export from the replaced ledger refused |
| authority | the central's keys cannot write Finance's ledger; the central's write boundary refuses a department's namespace and ownership; catch-up, linking and propagation leave Finance's ledger byte for byte as Finance wrote it; a department refuses another's node or ownership; the central refuses an export listing (or a change naming) another instance's node, one altered after signing, one signed by an unpinned key, one addressed elsewhere; a department's export refuses to launder another's node |
| replay | another process reproduces the central's digest, `reconcile` equal; an export lost from the inbox is marked, never invented |
| concurrency | two central processes catching up at once: each export imported once in order, the link once, the notice once; the ledger verifies and reconciles |

The mutation runner `packages/graph/tests/federation.mutate.mjs` (`--only`, `--check`, separate from `graph.mutate.mjs`) holds 21 mutations of `federation.mjs`, each run on a disposable copy against only its deciding tests:

| Id | Regression | Deciding tests |
|---|---|---|
| E1 | an internal node exported with its details | withheld, demonstration 10 |
| E2 | a restricted node exported | withheld |
| E3 | a withheld value leaking through a digest: the placeholder a plain digest of the id | withheld |
| E4 | a withheld value leaking through a digest: a node version that is its assertion id | withheld |
| E5 | a withheld value leaking through an attribute: public details not scrubbed | withheld, demonstration 10 |
| E6 | the anchor not checked | references |
| E7 | a reference's version not checked | references |
| E8 | a stale import shown as current: the age bound ignored | freshness |
| E9 | a stale import shown as current: unreachability ignored | freshness, demonstration 10 |
| E10 | a department's operation depending on the hub: publish asks the hub first | independence |
| E11 | catch-up skipping to the latest export (a lost update) | independence |
| E12 | catch-up duplicating: a notice id that includes its issue time | independence |
| E13 | catch-up duplicating: a link that carries its derivation time | independence |
| E14 | the central writing into a department: its write boundary removed | authority |
| E15 | a department recording as its own what it does not own | authority |
| E16 | a department's export presenting another instance's node as its own | authority |
| E17 | the central importing an export that lists another instance's node | authority |
| E18 | the central accepting an export not signed by a pinned key | authority |
| E19 | propagation dropping its provenance: the hub named as the origin | propagation |
| E20 | propagation dropping its provenance: changes without their ledger entries | propagation |
| E21 | a department recording a notice addressed to another instance | propagation |

## 9. The directive's section 6 and demonstration 10

| Requirement | Where | Evidence |
|---|---|---|
| cross-instance identity resolution | section 3 | references, demonstration 10; E6, E7 |
| explicit graph ownership and authority | sections 3, 5 | authority; E14 to E18 |
| versioned cross-domain references | section 3 | references (stale version, re-pin); E7 |
| access-controlled queries and projections | section 4 | withheld, demonstration 10; E1 to E5 |
| cross-department dependency discovery | section 5 | demonstration 10 (link, closure both ways) |
| propagation of relevant invalidations and qualification changes | section 7 | propagation (invalidation); references (a changed node makes the dependency stale and unresolved, re-derived on re-pin); E19 to E21 |
| provenance-preserving handoffs | section 7 | propagation (checked against the originating ledger); E19, E20 |
| recovery from disconnected or stale departmental instances | section 6 | freshness, independence, replay; E8, E9, E11 to E13 |
| independent departmental operation when the hub is unavailable | section 6 | independence; E10 |
| demonstration 10: permitted relationships exposed without disclosing unauthorized details or requiring permanent connectivity | sections 4 to 6 | demonstration 10, withheld, independence |
| register KG-3: `scope` enforced | section 4 | withheld; E1 to E5 |

## 10. The owner's to decide

1. **The production access policy** (register KG-4): which treatment each access level gets, which relationship types may cross, whether placeholders and counts are disclosed, per department and per hub. The test policy (`federation-fixture.mjs` `POLICY`) is the coordinator's: KE3 exactly.
2. **Departmental key custody**: who holds each department's export key, its placeholder secret (rotating it changes every placeholder, which reads as removed and added), its receiver key, and the central's import, link and notice keys; how the central learns and rotates the pinned export keys.
3. **Where instances run**, and the transports between them (the reference transports here read directories; a real one is a network channel with its own authentication).
4. **Freshness bounds** per department (`maxAgeMs`; the coordinator's default is one hour) and how often departments publish or heartbeat.
5. **Which instances federate**, which hub each department addresses, and whether notices may go to third instances along a path (they do here, with minimal disclosure).

## 11. Caveats

- Synthetic only: two synthetic departments in temporary directories; no real departmental data, transport or key custody was exercised.
- A ledger re-created with exactly the same authority has the same genesis, hence the same anchor (Ed25519 signatures are deterministic and the genesis has no nonce). "A replaced ledger is a different instance" holds when its genesis differs (a new operator key, another pin). The central also refuses an export chain that forks or restarts, which catches a re-created outbox.
- Internal node ids are disclosed by design (KE3: exported as a reference); a sensitive id must be `restricted`. A node's version tells when it last changed, not what changed.
- Scrubbing finds withheld node ids inside public text; it cannot find a withheld *value* copied verbatim into a public attribute. A department's classification of its own data is authoritative.
- Cross-department ordering in a catch-up follows departments' `exported_at` clocks; within a department, chain order always wins.
- Propagation recomputes over all import events at each catch-up (idempotent by content-addressed notices); its cost grows with the central ledger. A propagation cursor would bound it.
- `qualified-for` cannot cross an instance boundary (the central could only admit it as authoritative or derived from a declared basis, which the registry forbids); a qualification crosses as its evidence.
- A reference pins a node version, so any change to the node makes its dependents `stale-version` until they re-pin; that is the intended reassessment trigger, and it is visible, not silent.
- Notices are pulled, not pushed; a department that never pulls never learns of them, and the central's answers do not know whether a notice was received.

## 12. Commands

`node --test packages/graph/tests/*.test.mjs`; `node --test ophanim/ledger/layering.test.mjs`; `node packages/graph/tests/federation.mutate.mjs [--only E1,..] [--check]`.
