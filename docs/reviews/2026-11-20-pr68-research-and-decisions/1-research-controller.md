# Assignment 1: The research team's controller and session

**Scope:** bounds (depth, active members, request budget), read-only enforcement and scope, evidence-bound reports, stop conditions, resume.
**Testing:** scripted sessions and isolated processes; the installed SDK against a loopback provider where the suite already does. No live provider.

## Where to look

- `pantheon/src/antigravity/research.mjs` (`runResearchTeam`, `reportRefusal`)
- `pantheon/src/antigravity/turn.mjs`, the research mode: tools, scope, `research.hide`, the read-only bind, the digest per read
- `pantheon/src/route/fit-matrix.mjs` (`researchSeat`, `researchLimits`), `pantheon/src/config/antigravity-sdk.json` (`research`)
- tests: `pantheon/tests/research-team.test.mjs`, `research-routing.test.mjs`, the research tests of `antigravity-turn.test.mjs` and `antigravity-sdk-contract.test.mjs`

## Questions

1. **Bounds.** Can depth 10, the coordinator model's active ceiling (8 under Carbon) or the team's request budget be exceeded by any path: a caller's limits, a resumed team, a race between members, a failed or cancelled member?
2. **Charge before send.** Is every billed request charged before it is sent, once, and is a refused request never sent and never counted?
3. **Read-only.** Can a research session write, run a command or delegate? Can it read outside its scope, or read what the controller hides (the work ledger and its key, the item's state, the owner's status keys), by any tool, argument spelling, link or search?
4. **Evidence.** Can a report be accepted that cites a source its member never read, a version that is not the bytes read, or a claim with no source? What does the controller do with an absent path?
5. **Stopping.** Does a team stop when its coordinator is satisfied, and start nothing more after a refused charge or a spent budget? Can a failed, stopped or cancelled team leave a conclusion?
6. **Tests.** Name any property whose test still passes with the property removed.
