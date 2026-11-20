# The Carbon research team and the owner's decisions for pull request 68: qualification report

**Work.** Branch `feature/antigravity-sdk-intake` (pull request 68), after `ea858a6`:

| Commit | What |
|---|---|
| `2c6fb6c` | routing of the scout, explorer and researcher roles |
| `fabc00e`, `757827b` | the read-only research session of the SDK transport |
| `1975839` | the team's controller |
| `9186323` | the `work.research` ledger records and the runner |
| `a3377f6` | research in the lifecycle |
| `b58058d` | tests for three claims the first mutation run found unproved; the register; the docs |
| `32f9fd4` | the base merged in (`e654304`, the L-150 and L-151 metering relay) |
| `a1d090f` | owner decision 5: the lessons registry keeps discovery, repair and recurrence proof apart |
| `a2b35e5` | owner decision 4: an implementer pinned to an Antigravity lane keeps its lane fallback |
| `f4bd6bc` | owner decision 1: the model gateway is the one mechanism; the relay is removed |
| `af23623` | owner decision 2: a budget-stopped SDK session keeps its work |
| this commit | this report and the register's counts |

The owner's specification is "OPHANIM: Carbon 4 Research & Exploration Team" (2026-11-20). The owner's decisions are "Owner decisions for PR #68" (2026-11-20). What the capability does is in `docs/routing-task-profile.md`, `docs/operating-workflow.md` and `docs/billing-policy.md`. Its limitations are register entries L-725 to L-736.

**Verification.** One author wrote and tested all of it. There was no independent review of this work. Its tests were checked by mutation runs. Nothing has been answered by the live Gemini API.

## Status

| | |
|---|---|
| Research team | **Qualified as a controller.** Its limits, charges, records and refusals are enforced in code, and each is decided by a test that a mutation was seen to fail. **Not qualified as research** (L-726): whether Carbon and Hydrogen answer in the required report format, delegate sensibly, stop when they have an answer or find anything true is UNVERIFIED |
| Decision 1 (L-724, one gateway) | Done. The relay is removed; its protections and its tests are on the gateway |
| Decision 2 (L-150 requirement 8) | Met for the session's files, shown with scripted sessions. **Not met for the conversation**: the next session is a new one that starts from the kept files (L-736). Requirement 8 is not claimed as passed in full |
| Decision 3 (L-701, live authentication) | **Not done. Blocked on the credential.** No live session was run and nothing was billed. The CLI is not retired |
| Decision 4 (L-721, lane semantics) | Done. Both paths have their own tests |
| Decision 5 (lessons registry) | Done. The registry's verdict on its own mechanism stays "not demonstrated" |

## The research team against the specification's verification list (section 8)

| # | To demonstrate | Result | Decided by |
|---|---|---|---|
| 1 | All three roles select Carbon under the configured policy | pass | `pantheon/tests/research-routing.test.mjs`; mutations RS4, RS6 |
| 2 | Research can activate before a structured plan exists | pass | `ophanim/operate/research-lifecycle.test.mjs` (the real scheduler, gates, plan stage and ledger; a scripted session) |
| 3 | An agent delegates a bounded question and receives evidence-backed results | pass | `pantheon/tests/research-team.test.mjs`; trace A below, on the installed SDK |
| 4 | Nested delegation through level 10 when justified | pass, with scripted sessions | `research-team.test.mjs`; trace B |
| 5 | An attempted level 11 is refused | pass | the same test, and the work ledger's own rule (`research.test.mjs`); RS12, RS13, RS36 |
| 6 | Concurrent Hydrogen agents never exceed 8 per Carbon team | pass | `research-team.test.mjs`; trace C; RS15, RS21 |
| 7 | Shared request budgets hold under concurrent and nested execution | pass | the team's bound, the billing policy's budget and the stage's bound, each before the request is sent; RS22, RS35, RS40 to RS42 |
| 8 | Source identity, findings and lineage survive every delegation boundary | pass | reports held to the digests the controller recorded; each member on the ledger with its parent; RS23, RS24, RS27, RS33, RS37 |
| 9 | Cancellation and interruption preserve recoverable work | pass | no conclusion for a stopped team, finished members reused by digest; RS26, RS29, RS43, RS44 |
| 10 | Independent review eligibility remains correct | pass for the plan's panel, under `independence: 'model'` | `research-lifecycle.test.mjs`; RS48. The research rows are contributions of the plan, which the implement and review stages inherit through the existing lineage; that inheritance was not tested again for research rows. Not tested under `lab` (L-732) |
| 11 | Research ends when its objective is met | pass | `research-team.test.mjs`; RS25 |

Level 10 on the installed SDK was not run: trace A is two levels. Each level is the same kind of session, opened by the same code, so depth beyond two is shown with scripted sessions only.

## What the installed SDK does, and what OPHANIM does

| | google-antigravity 0.1.24 | OPHANIM |
|---|---|---|
| A child's model | a subagent type may name its model; shown for the implementer's native Hydrogen subagents | seats every research member itself, each in its own session |
| Nesting | declares a subagent depth (default 1). A depth above 1 was read in its types and not exercised | keeps the native depth at 1 and gives a research session no subagent type; opens levels 2 to 10 itself |
| Active children | reports no event when a child ends (L-706) | a pool that counts the sessions it started and saw end |
| Tools | offers the model `view_file`, `list_dir`, `grep_search`, `find_by_name` for the four read tools, and reports a call to the hook as `view_file`, `list_directory`, `search_directory`, `find_file` (shown). Three management tools run with no hook (L-715) | decides each hooked call: reads only, inside the repository, inside the assignment's scope and tools; binds the repository read-only |
| Retries | its harness sends a request again after HTTP 429, 500 or 503 (shown) | answers a refused charge with 403, which the harness does not retry |
| Spend | sends requests | every request passes the billing policy, the team's bound and the stage's bound first |
| Evidence | tool results | the digest of each file as the read was allowed; reports held to it |
| Resuming a conversation | not tried (UNVERIFIED) | keeps a stopped implementer session's files and starts a new session from them (L-736) |

The hierarchy is therefore OPHANIM-controlled delegation. That follows the owner's rule that Hydrogen does not delegate, and the missing child-end event. It is not a finding that the SDK cannot nest (L-725).

## Execution traces

The records are from this session's runs on the source of `a3377f6`. The scripts are not in the repository. The later commits changed the gateway's admission order and its answer to a refused charge, not what these traces show; they were not run again.

### A. A two-level team through the real runner, on the installed SDK

`runResearch` with the real work ledger, the real billing policy (primary declared, budget 20), the installed SDK 0.1.24 and its runtime in the real jail. Only the provider is scripted, on loopback.

```
{
 "team": "rt-897e14e756464945",
 "status": "satisfied",
 "stop_reason": "SATISFIED",
 "routing_record": {
  "schema": "pantheon.research-routing/v1",
  "role": "scout",
  "chosen": {
   "effort": "high",
   "model": "gemini-4-carbon"
  },
  "candidates": [
   {
    "effort": "high",
    "model": "gemini-4-carbon"
   }
  ],
  "rejected": [],
  "policy": "sha256:1b9b295e2ec1e2c2bf6d9364d6be29ec718fe52e64a90cab81944e2b2eb3fa66"
 },
 "hierarchy": [
  {
   "node": "rn-6047a96f36fe5234",
   "kind": "coordinator",
   "level": 1,
   "parent": null,
   "round": 1,
   "specialty": null,
   "asked": "gemini-4-carbon@high",
   "answered": "gemini-4-carbon (provider)",
   "tools": [
    "view_file",
    "list_directory",
    "search_directory",
    "find_file"
   ],
   "scope": [
    "."
   ],
   "examined": [
    "README.md@sha256:f34848ca9266"
   ],
   "requests": 2,
   "state": "finished"
  },
  {
   "node": "rn-a7219a50c4b2bc8b",
   "kind": "specialist",
   "level": 2,
   "parent": "rn-6047a96f36fe5234",
   "round": 1,
   "specialty": "source-inventory",
   "asked": "gemini-4-hydrogen@medium",
   "answered": "gemini-4-hydrogen (provider)",
   "tools": [
    "view_file"
   ],
   "scope": [
    "src"
   ],
   "examined": [
    "src/u1/keep.mjs@sha256:4542346a248d"
   ],
   "requests": 2,
   "state": "finished"
  },
  {
   "node": "rn-6047a96f36fe5234",
   "kind": "coordinator",
   "level": 1,
   "parent": null,
   "round": 2,
   "specialty": null,
   "asked": "gemini-4-carbon@high",
   "answered": "gemini-4-carbon (provider)",
   "tools": [
    "view_file",
    "list_directory",
    "search_directory",
    "find_file"
   ],
   "scope": [
    "."
   ],
   "examined": [],
   "requests": 1,
   "state": "finished"
  }
 ],
 "work_ledger": [
  "request",
  "team",
  "node:coordinator:admitted level 1",
  "node:coordinator:finished level 1",
  "node:specialist:admitted level 2",
  "node:specialist:finished level 2",
  "node:coordinator:admitted level 1",
  "node:coordinator:finished level 1",
  "conclusion"
 ],
 "telemetry": {
  "depth_reached": 2,
  "active_peak": 1,
  "nodes_created": 1,
  "coordinator_rounds": 2,
  "nodes": {
   "finished": 1
  },
  "requests": {
   "total": 5,
   "by_model": {
    "gemini-4-carbon": 3,
    "gemini-4-hydrogen": 2
   }
  },
  "tokens": {
   "total": 575,
   "by_model": {
    "gemini-4-carbon": 345,
    "gemini-4-hydrogen": 230
   }
  },
  "refusals": {},
  "reused": 0
 },
 "contributors": [
  {
   "node": "rn-6047a96f36fe5234",
   "kind": "coordinator",
   "depth": 1,
   "parent": null,
   "requested_model": "gemini-4-carbon",
   "served_model": "gemini-4-carbon",
   "served_model_source": "provider"
  },
  {
   "node": "rn-a7219a50c4b2bc8b",
   "kind": "specialist",
   "depth": 2,
   "parent": "rn-6047a96f36fe5234",
   "requested_model": "gemini-4-hydrogen",
   "served_model": "gemini-4-hydrogen",
   "served_model_source": "provider"
  }
 ],
 "provider_requests_in_order": [
  "gemini-4-carbon@high",
  "gemini-4-carbon@high",
  "gemini-4-hydrogen@medium",
  "gemini-4-hydrogen@medium",
  "gemini-4-carbon@high"
 ],
 "tools_offered_to_the_model": [
  "gemini-4-carbon: find_by_name,grep_search,list_dir,view_file",
  "gemini-4-hydrogen: view_file"
 ],
 "billing_rows_in_order": [
  [
   "primary",
   "gemini-4-carbon",
   "research",
   "scout",
   "sdk"
  ],
  [
   "primary",
   "gemini-4-carbon",
   "research",
   "scout",
   "sdk"
  ],
  [
   "primary",
   "gemini-4-hydrogen",
   "research",
   "scout",
   "sdk"
  ],
  [
   "primary",
   "gemini-4-hydrogen",
   "research",
   "scout",
   "sdk"
  ],
  [
   "primary",
   "gemini-4-carbon",
   "research",
   "scout",
   "sdk"
  ]
 ],
 "stage_charges_in_order": [
  "gemini-4-carbon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
  "gemini-4-hydrogen",
  "gemini-4-carbon"
 ],
 "findings_text": [
  "- README.md says only: base [README.md@sha256:f34848ca9266]",
  "- src/u1/keep.mjs exports the constant keep with the value 1 [src/u1/keep.mjs@sha256:4542346a248d]",
  "- The repository's one export is keep, from src/u1/keep.mjs [src/u1/keep.mjs@sha256:4542346a248d]",
  "- unresolved (rn-6047a96f36fe5234 u1): what the source files under src export (the README does not say)"
 ],
 "evidence_files": [
  "findings.json",
  "rn-6047a96f36fe5234.r1.json",
  "rn-6047a96f36fe5234.r2.json",
  "rn-a7219a50c4b2bc8b.json"
 ],
 "session_directories_left": [],
 "repository_changed": ""
}
```

Read from it: the coordinator and the specialist were asked on the models the routing chose and answered by them; the specialist's delegation gave it one tool and one directory, and the model was offered that one tool; the provider received five requests, and each has a billing row and a stage charge for the same model in the same order; each cited source carries the digest the controller recorded; no session directory was left, and the repository did not change.

### B. Ten levels, and a refused eleventh (scripted sessions)

A coordinator that asks one level deeper each round, each time for a gap the level above reported.

```
{
 "status": "exhausted",
 "stop_reason": "NOTHING_ADMISSIBLE",
 "levels": [
  "level 2 gemini-4-hydrogen rn-d5c1aa1460ee2ad9 <- rn-89a17c3eceedc016 (finished)",
  "level 3 gemini-4-hydrogen rn-baab73f883749334 <- rn-d5c1aa1460ee2ad9 (finished)",
  "level 4 gemini-4-hydrogen rn-e596a5a18246fa4c <- rn-baab73f883749334 (finished)",
  "level 5 gemini-4-hydrogen rn-d8f9eb0a7092dbec <- rn-e596a5a18246fa4c (finished)",
  "level 6 gemini-4-hydrogen rn-dc0623becaff6383 <- rn-d8f9eb0a7092dbec (finished)",
  "level 7 gemini-4-hydrogen rn-969205609186704c <- rn-dc0623becaff6383 (finished)",
  "level 8 gemini-4-hydrogen rn-ef1bbc461230a200 <- rn-969205609186704c (finished)",
  "level 9 gemini-4-hydrogen rn-a302465e19d3dcd6 <- rn-ef1bbc461230a200 (finished)",
  "level 10 gemini-4-hydrogen rn-3d3bb0f6525bf72e <- rn-a302465e19d3dcd6 (finished)"
 ],
 "refusals": [
  "RESEARCH_DEPTH_EXCEEDED attempted level 11: level 11 was asked for under node rn-3d3bb0f6525bf72e at level 10: a research team is at most 10 levels deep"
 ],
 "telemetry": {
  "depth_reached": 10,
  "active_peak": 1,
  "nodes_created": 9,
  "coordinator_rounds": 10,
  "nodes": {
   "finished": 9
  },
  "requests": {
   "total": 19,
   "by_model": {
    "gemini-4-carbon": 10,
    "gemini-4-hydrogen": 9
   }
  },
  "tokens": {
   "total": 1450,
   "by_model": {
    "gemini-4-carbon": 1000,
    "gemini-4-hydrogen": 450
   }
  },
  "refusals": {
   "RESEARCH_DEPTH_EXCEEDED": 1
  },
  "reused": 0
 },
 "peak_seen_by_the_script": 1
}
```

Nine specialists, one per level, never more than one active. Reaching level 10 took ten coordinator rounds. The team ended `exhausted`: its only request of the last round was refused, and nothing admissible was left to ask.

### C. Twelve asked for at once (scripted sessions)

```
{
 "status": "satisfied",
 "specialists": 12,
 "active_peak_recorded": 8,
 "peak_seen_by_the_script": 8,
 "depth_reached": 2,
 "requests": {
  "total": 14,
  "by_model": {
   "gemini-4-carbon": 2,
   "gemini-4-hydrogen": 12
  }
 },
 "tokens": {
  "total": 800,
  "by_model": {
   "gemini-4-carbon": 200,
   "gemini-4-hydrogen": 600
  }
 },
 "one_finding_many_members": [
  {
   "text": "the scheduler is called from tick",
   "evidence": [
    "src/a.mjs@sha256:111111111111 examined by 12 members"
   ]
  }
 ]
}
```

Twelve specialists were created, eight ran at once, and the depth stayed 2. Each specialist is its own session and is shown only its own question: members do not see each other's findings, so two that test competing hypotheses stay independent of each other. The same claim from the same source by twelve members is one piece of evidence that names all twelve.

## The owner's decisions

### 1. One gateway (L-724)

`pantheon/src/route/gemini-relay.mjs` is deleted. The board's python SDK seat and `bin/agy-seat.mjs` are served by `pantheon/src/antigravity/gateway.mjs` through `antigravity/seat-session.mjs`, whose admission is `spendGemini`. There is one billing path.

Protections the relay had and the gateway lacked, each now on the gateway with a test and a mutation (GP1 to GP14): the real key is forwarded only to a Google API host or loopback; a session's own maximum request count; a bound on requests in flight; an idle bound and a lifetime; the exact query a call may carry; a body that is not a JSON object is refused before it is charged; each request's outcome is written to a durable record as it ends; the session's own account is served to the holder of its token.

One change of behaviour: a refused charge is answered 403, not 429. The SDK's harness retried the 429, and each retry asked the run's admission again.

The relay's test file (`pantheon/tests/l150-billing.test.mjs`, 19 tests) is kept whole against the gateway. Its runner (`l150-billing.mutate.mjs`) is retargeted and has 22 mutations.

The real-SDK proof (`bin/agy-seat.mjs` cells, installed SDK, scripted provider) through the gateway passes the ten cells it passed through the relay and fails the same one: P7 with a budget of 100, which the base recorded as L-159. `l150/sdk-relay` was not merged and nothing was pushed to it.

### 2. A budget-stopped SDK session keeps its work (L-150 requirement 8; L-736)

Built on the existing unit checkpoints (`pantheon/src/pipeline/checkpoint.mjs`), not beside them.

| The decision asks | What exists | Decided by |
|---|---|---|
| Record the exact point of refusal and all previously admitted requests | the partial checkpoint's `stopped` (code, attempt, the session's request number, used, budget) and `admitted` (each usage row); `requests.jsonl` in the unit's control directory, appended as each request ends | `pipeline-antigravity-sdk.test.mjs`, `antigravity-turn.test.mjs`; PC18, PC19, PC20 |
| Retain the candidate changes, usable checkpoints and investigation evidence | the session's jail-checked files as a sealed patch; the session's tool decisions, subagent record and gateway record with it. Approved checkpoints of other units are untouched | PC1, PC2, PC3 |
| Resume from a verified checkpoint where safe | the next run restores the patch only when seal, verdict, unit, base, upstream, patch digest, owned paths and resulting tree hold; attempt 1 starts from it and is told so | PC5 to PC14, PC21; the lifecycle test (PC22) |
| Never treat unverified partial work as an approved artifact | verdict `unverified`; a restored unit runs verify and Stage 5 on the whole change; the earlier model stays a contributor and cannot review it; a partial checkpoint marked approved is refused | PC4, PC6, PC15, PC16 |
| If safe continuation cannot be demonstrated, say so | see below | |

**What is demonstrated:** continuation of the *work*. A stage that waited on the budget is attempted again by the real scheduler and its session starts in a worktree that holds the earlier session's files (`ophanim/operate/fit-lifecycle.test.mjs`).

**What is not demonstrated, and is not claimed:** continuation of the *session*. The next session is a new SDK conversation. The earlier model's reasoning, tool history and anything it had not written to a file are gone. Whether the SDK can resume a conversation was not tried. Whether a live model keeps restored files or rewrites them is UNVERIFIED: every session in these tests is scripted. The requests of the stopped session stay billed, and the dispatcher is asked again on each run (L-722).

### 3. Live authentication (L-701): not done

The decision requires `GEMINI_API_KEY` in the authorized execution environment, the zero-spend preflight, then one authorized, tightly budgeted live SDK implementation session.

- This environment has no `GEMINI_API_KEY` variable.
- Its one saved Google credential is sent in the `Authorization` header. Two zero-spend requests with it were answered HTTP 401 `UNAUTHENTICATED` on the native path the SDK uses, and HTTP 400 "Please pass a valid API key" on the OpenAI-compatible path, which reads a key from that header.
- The session's credential form refuses to save a key for the `x-goog-api-key` header.

No preflight against Google passed. No live session was started. Nothing was billed. No provider model identity, usage or session outcome exists to record. The CLI path is not retired (L-703), and the two entries the owner named to watch before retirement, L-715 and L-704, are open and unchanged.

What unblocks it: a key Google accepts, set as the environment variable `GEMINI_API_KEY` of the environment the run is launched in. The preflight (`sdkPreflight` and the availability probe) sends no generation request.

### 4. Lane semantics (L-721)

Under `fit`, an implementer pinned to an Antigravity lane is seated on `[the pin, the pin's metered failover of the same model, the other lanes of the legacy ladder]`. The primary API seat is never among them. With every candidate out, the unit is refused and the reason is recorded. The unpinned `fit` implementer stays a primary Gemini API seat with its own authorization, charge before each call and budget exhaustion.

`pantheon/tests/fit-sdk-routing.test.mjs` and `quota-failover.test.mjs` hold both paths apart; mutations LP1 to LP4. The `fit` policy digest changed (L-712).

### 5. The lessons registry

Each instance now records who observed it: the owner, a review, or the mechanism's own check. A correction counts as a success of its mechanism only when its own specified check detected an owner-raised class after the mechanism existed. Six instances found by review were reclassified: they are evidence that independent review worked. The report keeps `discovered`, `repaired` and `recurrence_proven` apart. The registry's verdict on its own mechanism is still "not demonstrated" (`ophanim/lessons/corrections.test.mjs`).

## Tests

On `af23623`. Node 24.22, bubblewrap 0.9.0; the pinned SDK installed.

| Check | Result |
|---|---|
| `npm test` | 62, 47 and 1,884 pass in the three packages; 0 fail, 0 skipped |
| `npm run test:proof` | 538 pass, 0 fail, 0 skipped |
| `npm run test:gates:self` | 35 pass |
| Test lint, enforcing | 0 findings |
| Target check of all ten mutation runners | 517 targets, each applies exactly once |

## Mutation results

`ophanim/operate/sdk-intake.mutate.mjs` has 271 targets. Each run copies the tree, runs the named test files unchanged as a baseline, then applies one mutation at a time.

| Run | Tree | Result |
|---|---|---|
| RS1 to RS66 (research) | `a3377f6` | 63 killed, 3 survived (RS8, RS28, RS32), none hung |
| PC1 to PC22, P20, P24 (decision 2) | the tree committed as `af23623` | 23 killed, 1 survived (PC13), none hung. Baseline 285 of 285 |
| PC13 again | the same tree with one test case added | killed |
| W1 to W21, GP1 to GP14, the other 21 of P, R1 to R8, LP1 to LP4, RS4 to RS6, G10 to G12, RS8, RS28, RS32 | `af23623` | 77 of 77 killed, none hung. Baseline 363 of 363 |
| `pantheon/tests/l150-billing.mutate.mjs` (22, retargeted to the gateway) | `af23623` | 22 of 22 killed. Baseline 19 of 19 |

The three research survivors, and what was added:

- **RS8**, a research session's repository bind left writable. The tests read the record of the bind, not the bind. A test now writes from inside the real jail with no tool call.
- **RS28**, a charge the caller refused did not stop the team at once. The next coordinator round started a session before the team stopped. A test now counts the sessions started.
- **RS32**, the findings passed up to the coordinator had no tested bound.

**PC13** was the one survivor of the decision-2 run: a partial checkpoint recorded on other upstream trees was restored when the count of upstream units was the same. The test compared lists of different lengths only. A case with the same unit on another tree was added, and the mutation was then killed.

**Not run again on the final tree:** 170 of this runner's 271 mutations (S, A, B, I, L, the other G and the other 60 RS). They were killed on `ea858a6` or `a3377f6`. The files most of them target changed little or not at all since (in `turn.mjs`, decision 2 added one option to one call), so a mutation that failed a test then is expected to fail it now. That is an argument, not a run.

The base's other eight runners (224 targets) were not run. Every target of all ten runners applies exactly once on `af23623` (L-719).

## Found while qualifying it

1. **Research on by default, and a session's directory inside the repository (L-735).** The targeted tests passed. The full proof suite then failed two existing tests: a plan that waited on evidence started a real research session and was planned twice, and the session refused its own directory, because the item's state is inside the repository it reads. Repaired before the commit: research is the launcher's choice, a session's directory is made outside the repository and removed, and a transport that cannot start a session requests nothing.
2. **A delegation's tools and scope were recorded and not enforced.** Found by reading the runner. The transport now takes the assignment and refuses a tool it was not given and a read outside its scope.
3. **Three claims with no test**, above.
4. **A refused charge was retried by the SDK's harness.** Found when the relay's board test ran against the gateway: the admissions seen were `[0, 1, 2, 2, 2, 2]`. The gateway answered 429, which the harness retries. It now answers 403.
5. **The base's merge moved a sentence past a 300-character cut**, and one lifecycle test failed on the merged tree. The wording was shortened.

These were found by suites, by reading and by mutation runs. None was found by the lessons registry's own checks.

## Remaining limitations

| Entry | What |
|---|---|
| L-701, L-726 | Nothing has reached the live Gemini API. Decision 3 is blocked on the credential |
| L-703, L-704, L-715 | The CLI is not retired. The SDK jail shares the host network. Three SDK management tools run without the controller's hook |
| L-736 | A budget-stopped session's files are kept; its conversation is not resumed |
| L-722 | A retried implement attempt asks the dispatcher again |
| L-725 | The research hierarchy is OPHANIM-controlled; native nesting was not exercised. Each level costs a coordinator round |
| L-727 | Six of the seven triggers are recorded by whoever observes them. Only insufficient evidence is recorded by a stage |
| L-728 | No capability for an experiment that writes or runs something |
| L-729 | Research on an item runs inside its plan stage, under that stage's bounds |
| L-730 | `operate research` does not check that the item exists |
| L-731 | The primary budget is not reserved for a team |
| L-732 | A team decides its own end, and its findings are reviewed only as part of the plan. Review eligibility was tested under `model` independence only |
| L-733 | A listing or a search has no content identifier; only a file that was read has one |
| L-734 | The research session's jail is the implementer's apart from the read-only bind |
| L-159 | Proof cell P7 with a budget of 100 fails through the gateway as it did through the relay |
| L-719 | 101 of this branch's 271 mutations were run on the final tree; the base's other eight runners were not run after this work |
