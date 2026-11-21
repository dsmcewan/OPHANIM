You are an independent reviewer. Another engineer wrote a change; your job is to find where it does not do what its requirements say, by reading the code and by running reproductions. You have not been given the author's conclusions on purpose. Be adversarial and concrete; do not praise.

## What to review
Repository: /home/user/OPHANIM-sdk (git). The change under review is the diff `ea858a6..af23623`. Review the FINAL state at af23623. Your slice is the RESEARCH TEAM inside `pantheon/` (another reviewer covers the lifecycle side in ophanim/, others cover billing gateway and checkpoints):
- `pantheon/src/route/fit-matrix.mjs` (researchSeat, researchSubordinate, researchLimits), `pantheon/src/antigravity/config.mjs`, `pantheon/src/config/antigravity-sdk.json` (key `research`)
- `pantheon/src/antigravity/turn.mjs`: the read-only "research" mode of a session (search for `research`): which tools are allowed, scope enforcement, read-only bind in the jail, the digest recorded per file read
- `pantheon/src/antigravity/research.mjs`: the team controller `runResearchTeam` (depth, justification of each delegation, concurrency pool, shared request bound, seven-part reports checked against what the controller saw examined, de-duplication, stop conditions, resume)
- tests: `pantheon/tests/research-routing.test.mjs`, `research-team.test.mjs`, the research tests inside `antigravity-turn.test.mjs` and `antigravity-sdk-contract.test.mjs`
See the diff with: `git -C /home/user/OPHANIM-sdk diff ea858a6 af23623 -- <path>`.

## The owner's requirements for this capability (verbatim points)
Scout, explorer and researcher run on `gemini-4-carbon` through the Antigravity SDK on the Gemini API with GEMINI_API_KEY (no CLI, no OAuth). Subordinates are `gemini-4-hydrogen`. Maximum delegation depth 10. At most 8 concurrently active Hydrogen agents per Carbon team. Every billed request passes the centralized charge-before-send boundary. Research is read-only. Reports are evidence-backed (seven parts: question, sources, observations, hypotheses, dependencies, unresolved, next). "Do not build a second orchestration framework." "Do not change the implementer's hard/medium/easy model assignments." "Do not weaken existing invariants." "Report actual SDK capabilities separately from capabilities implemented by OPHANIM." "Do not simulate success."
To be demonstrated: (1) all three roles select Carbon under the configured policy; (3) an agent delegates a bounded question and receives evidence-backed results; (4) nested delegation through level 10 when justified; (5) an attempted level 11 is refused; (6) concurrent Hydrogen agents never exceed 8 per Carbon team; (7) shared request budgets hold under concurrent and nested execution; (8) source identity, findings and lineage survive every delegation boundary; (9) cancellation and interruption preserve recoverable work; (11) research ends when its objective is met.

## What to look for
Bounds that are declared but can be exceeded (depth, active count, request budget: race conditions, off-by-one, a path that skips the check, a resumed team, a failed or cancelled member that still holds or frees a slot wrongly). Read-only enforcement that can be bypassed (a tool or argument spelling not covered, a path escaping the scope via `..`, symlink, absolute path, case; a scope of `.`; tools the runtime offers that no hook decides). Reports accepted that cite sources the member never read, or digests that are not of the bytes read. A charge that can happen after the request is sent, or a request sent with no charge. Lineage lost across a delegation. A team that reports `satisfied` or a conclusion after a failure. Tests that would still pass if the property they name were removed (say which line you would change and what you observed). Statements in code comments that the code does not do.

## How to work
- Do NOT modify /home/user/OPHANIM-sdk or /home/user/OPHANIM, do not commit, push, or run any `*.mutate.mjs` file there. Make your own scratch checkout: `S=/tmp/claude-0/-home-user-OPHANIM/0c68b45d-d13a-54b8-88c4-e615fa8b38a0/scratchpad/review-1 && git -C /home/user/OPHANIM-sdk worktree add --detach $S af23623 && ln -s /home/user/OPHANIM-sdk/node_modules $S/node_modules && ln -s /home/user/OPHANIM-sdk/pantheon/node_modules $S/pantheon/node_modules`. Write repro scripts and edits only there.
- Every command: `export PATH=/opt/node24/bin:$PATH OPHANIM_TELOS_ROOT=/root/.local/share/ophanim/telos`. Run a test file with `timeout -k 2 300 node --test --test-timeout=120000 <file> > out.txt 2>&1` and read the summary lines; never run the whole suite (`npm test`), only targeted files. bubblewrap is installed; the SDK's python is /root/.local/share/pantheon/venv-antigravity/bin/python.
- Never call a real provider: no request to generativelanguage.googleapis.com, api.openai.com or api.x.ai, and never print an environment variable's value or any credential. Everything here runs against scripted or loopback providers.
- Do NOT read `docs/execution/research-team-report.md`, any pull request text, or `docs/OPEN-LIMITATIONS.md` before you have formed your findings. Other docs (`docs/routing-task-profile.md`, `docs/billing-policy.md`) are the author's claims: test them against the code. At the very end you may grep `docs/OPEN-LIMITATIONS.md` for entries L-725 to L-736 only to label a finding "already recorded as L-nnn".
- To check whether a test really decides a property, edit the source line in YOUR scratch checkout, run that test file, record the result, and revert.
- Budget: about 40 tool calls. Depth over breadth: three verified findings beat ten guesses.

## What to return
A report of at most 900 words:
1. Findings, most severe first. For each: a one-line statement; severity (REQUIREMENT VIOLATED / DEFECT / CLAIM WITH NO DECIDING TEST / DOC OR COMMENT MISMATCH); file:line; the reproduction you ran and what you observed, or "read only, not reproduced"; whether it is already recorded as a limitation.
2. What you checked and found sound, with how you checked (one line each).
3. What you could not check, and why.
Do not soften a finding and do not invent one: if you found nothing in an area, say so.
