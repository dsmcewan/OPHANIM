# Status updates to sign (2026-11-17)

Only the owner's keys sign the status ledger. Run these from the repository root on your machine, with `OPHANIM_STATUS_KEYS` set to your key directory, then `node packages/ledger/status.mjs verify` and commit `status/ledger` and `docs/STATUS.md`. Each one was checked against the status rules on a scratch ledger; none claims Resolved, because no Pantheon run has shipped this work and no cross-lab review cycle has closed on it.

```sh
S="node packages/ledger/status.mjs set --json"

$S '{"item":"routing-coordination-practices","title":"Priority: qualify model routing and coordination practices every cycle","state":"In progress","checked":"2026-11-17","owner_role":"lead@orch","basis":"Audit fixes M1-M7 and C1-C3 merged on ccr-aa24f0d5-336szn (393658d, e481e77, fb67275, 39a98a7, 1b36d6f, 31e0e5b); fit task-profile candidate (6c0c12f, 26cbdcb, f96531a); synthetic comparison and shared metrics (43d6039); continuous evaluator in progress. Not yet: a live cycle, a closed cross-lab review of this work, any measured practice decision."}'

$S '{"item":"fit-routing-candidate","title":"fit: task-profile routing with independent dials (candidate, not default)","state":"In progress","checked":"2026-11-17","owner_role":"lead@orch","basis":"Built and selectable per run (--profile fit); argo stays default. Adoption needs live interleaved evidence per stakes stratum, independent other-lab review, and a recorded practice disposition (docs/routing-task-profile.md)."}'

$S '{"item":"routing-evaluation-review","title":"Cross-lab functional review of routing profiles and their evaluation","state":"On Hold","waiting_on":"credential","checked":"2026-11-17","basis":"Packet and runner ready (docs/reviews/2026-11-17-routing-evaluation, pantheon/bin/cross-lab-review.mjs). The cloud environment injects no provider key; runs on the owner machine with OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY."}'

$S '{"item":"agy-lane-windows","title":"Record the agy lanes documented context windows","state":"On Hold","waiting_on":"fact","checked":"2026-11-17","basis":"Under the M7 rule a lane with no cited window is not admitted for a context estimate, so the Sonnet 4.6 and Opus 4.6 thinking lanes are skipped by legacy routing. Needs the lane bound with a source in pantheon/src/config/lanes.json (window: {value, source, quote})."}'
```
