# The operating workflow

How work moves from the status board to a recorded result: Pantheon takes Ready work from the
authoritative board, seats a team, runs evaluation, fixes, tests and an independent review, and ends in an
unsigned proposal; the owner, who alone holds the status ledger's keys, records it; the public record then
shows the evidence.

## The loop

```
status/ledger (verified)                                   docs/STATUS.md, GitHub issues
      |                                                              ^
      | next: Ready + dependencies Resolved + a ticket               | render; push -> public-record.yml
      v                                                              |
tickets/<item>.json --> run <item> --> evidence bundle + UNSIGNED proposal --> apply (owner's keys)
                         |
                         |  runOpenItem: scout, plan, work, isolated acceptance, in-run review, ship
                         |  (every turn, review, lease, ref move and gate verdict on the run ledger)
                         |  the shipped bytes committed on branch pantheon/<item>
                         |  reviewCycle over base..head: 3 reviewers on 3 distinct labs, none the
                         |  implementer's; findings fixed or deferred; the close re-derives
```

1. **The board.** `status/ledger` is authoritative (`packages/ledger/status.mjs`). Every reader verifies it
   against its pinned genesis first; nothing reads `docs/STATUS.md` or GitHub to decide anything.
2. **Tickets.** `tickets/<item>.json` (schema `ophanim.ticket/v1`) is a committed `runOpenItem` ticket for one
   board item: `title`, `goal`, `question`, `repo_root` (relative to the repository), `slot`/`path` or
   `slots`, `copy`, `acceptance_cmd`, `difficulty`, `constraints`, `forbidden`, plus `slice` (an honest
   name for the part of the item it does) and `proposes` (`{state, basis}`: the status the item takes once
   the slice ships and its review closes). A ticket that covers the whole item proposes `Resolved`; a slice
   that leaves the rest of the item to do proposes `Ready` again, with the slice in its basis.
3. **Dispatchable** iff the item's latest status is Ready, every `depends_on` is Resolved, a valid ticket
   exists, and the item's latest status does not already record that ticket's digest (a slice runs once;
   the next slice is a new ticket).
4. **`next`** (`node pantheon/bin/pantheon-board.mjs next [--seat role=vendor/model]...`): the verified
   board's dispatchable items in dependency order, each with its ticket and the team it would seat
   (vendor, model and lab per chair, and the cycle reviewers), and why every other Ready item is not
   dispatchable.
5. **`run <item>`**: the ticket through `runOpenItem` with the run ledger on (at `<board>/ledger`, or
   `OPHANIM_LEDGER`); the shipped artifacts, re-certified from the board, committed on `pantheon/<item>`
   from the repository's `HEAD` without touching the working tree (refused if a file's base version is not
   what the implementer was shown, or if the ticket's `copy` paths have uncommitted changes); then
   `reviewCycle` over `base..head` with `n = 3` reviewers on distinct labs, on the same run ledger. Every
   lab that contributed to the change (`review/scope.mjs`, scope `change`: plan, work, and critiques that
   reached a revision) is excluded, and the author turns are cited, so the cold-review rule is re-derived
   over their lineage. When the configured pool cannot supply three labs outside the contributors (for
   example a model-written plan from Anthropic and OpenAI work leave only two other labs), nothing is
   narrowed: the work and evidence are kept and the review is `REVIEW_CAPACITY_PENDING`. Reviewer turns are injectable (`--turn MODULE`; default the
   live SDK turns, `pantheon/bin/cycle-review-http-turn.mjs` for plain HTTPS).
6. **Findings.** With no findings the cycle closes (`verified`) at once. Otherwise each finding is fixed
   (a later commit and a test that failed before and passes after) or deferred (with a reason) on the run
   ledger with `pantheon/bin/pantheon-review-cycle.mjs fix|defer --ledger <run ledger>`, and
   `pantheon-board.mjs propose --bundle DIR` closes it. A cycle with an unreproduced finding closes
   `unverified`, and such a close cannot propose Resolved without `--accept-unverified REASON` (recorded).
   A reviewer whose turn fails leaves the cycle unable to close (fewer reviews than reviewers): run the
   item again on a fresh board.
7. **The proposal** (`ophanim.status-proposal/v1`, written to the bundle as `proposal.json`):

   ```
   {schema, item,
    from: {state, entry},                       the latest status entry it was made against
    to: {state, basis, checked, waiting_on?, owner_role?},
    evidence: {run: {ledger_anchor, ledger_head, run_json_digest, shipped, gate_entry},
               review: {cycle_ledger_anchor, cycle, close_entry, outcome, reviewers: [{vendor, model, served_model, lab}]},
               commit, tests: {cmd, exit}, ticket: {path, digest, slice}},
    accept_unverified_reason?,
    locations: {run_ledger, cycle_ledger, run_json, ticket}}  local hints only: not digested, never recorded
   ```

   A proposal to Resolved must cite a shipped run, a commit, tests that exited 0 and a review-cycle close.
   Every proposal's evidence is bound to its item: `evidence.ticket.path` is `tickets/<item>.json`, and where
   apply checks them, the ticket's own `item` is the proposal's (with the cited digest), run.json's key is the
   ticket's, and the review cycle's scope is `board/<item>/<base12>` with the cited commit as its head. A
   change to Resolved is applied only when the run ledger, the cycle, run.json and the ticket were all
   checked on the applying machine (`checked: structural`); otherwise it is refused, and the owner records
   the status directly (`status.mjs set`) if that is what they decide.
   `status.mjs propose --json ...` builds one by hand, with no key.
8. **`check <proposal.json>`** re-derives the evidence with Pantheon's kinds: the run ledger verifies
   against its anchor, the cycle closed with the stated outcome on the stated labs, the commit is the
   reviewed head, descends from the cycle's base, and its diff is the one the reviewers were given.
9. **`apply`** (`node packages/ledger/status.mjs apply <proposal.json> [--keys DIR]`; the key directory is
   also `OPHANIM_STATUS_KEYS`, default `<ledger>/keys`): verifies the status ledger; refuses a malformed
   proposal and a **stale** one (its `from.entry` is not the item's latest status); re-checks the cited
   ledgers where `locations` says they are on this machine (structurally: the genesis is the cited
   anchor, every signature, link and payload verifies, the cited head, gate, cycle and close entries are
   there with the stated kinds, the close's outcome and labs match, and the reviews recorded on the cycle
   are the reviewers named); then records the status, signed with the owner's operator and orderer keys,
   citing only the item's previous status, with an `evidence` object (`ophanim.status-evidence/v2`; entries recorded under v1 keep v1's rules: the
   proposal's digest, the run, the review, the commit, the tests, the ticket and whether the cited ledgers
   were re-checked), and re-renders `docs/STATUS.md`. The keys are only read, never written or printed;
   a missing key directory is refused, not created.
10. **The public record.** `ophanim/public/record.mjs` puts an **Evidence** section in the item's issue
    body when its latest status carries `evidence`: the run ledger's anchor and head, the run.json digest,
    the gate verdict, the review cycle, its close and outcome, each reviewer's vendor, requested and served
    model and lab, the commit, the tests and the ticket. Reviewers are model seats: they appear only as text,
    never as GitHub assignees, reviewers or approvers (`docs/public-record.md`).

## Who signs what

| Record | Signed by | Where the key is |
|---|---|---|
| Status entries (`status/ledger`) | the status ledger's operator, ordered by its orderer | the owner's machine only (e.g. `~/.local/share/ophanim/status-ledger/keys`); no session holds them |
| Turns and reviews on the run ledger | each seat occupancy's own key | `<run ledger>/keys`, on the machine that ran the board |
| Leases, ref moves, gate verdicts, cycles, findings, resolutions, closes | the run ledger's controller | the same |
| Seat admissions (authority entries) | the run ledger's operator | the same |
| The produced commit | the repository's configured git identity (the owner) | git |
| The proposal | nobody: it is unsigned, and is only data until `apply` | |

Pantheon (`pantheon/bin/pantheon-board.mjs`, `pantheon/src/board/operate.mjs`) never writes the status
ledger and never reads its keys. It imports `packages/ledger`, never `ophanim/`.

## Rehearsal versus operational

- **Rehearsal** (`ophanim/tests/board-operating-cycle.test.mjs`, in `npm run test:proof`): no network,
  scripted plan, work and review seats, scripted cycle reviewers, a temporary git repository and a
  temporary status ledger signed by test keys held outside it. It proves the mechanics end to end (next,
  run, ship, commit, a review cycle closed by three labs, the proposal, check, apply to Resolved with
  evidence, the issue body), a second cycle where a finding without a reproduction is deferred and the
  `unverified` close is accepted only with a stated reason, and the refusals (stale, tampered head, forged
  lab, unverified close without a reason, no keys). It is not evidence that any live model did any work, and it changes nothing on the
  real board.
- **Operational**: live seats on a real ticket, reviewed live by three labs, applied with the owner's keys
  to `status/ledger`, committed and pushed, and published.

The workflow is **operational** when one live cycle meets all of these:

1. `node pantheon/bin/pantheon-board.mjs next` on the committed board lists the item with its ticket.
2. `run <item>` with live seats ships the ticket's change (acceptance exit 0 in the isolated sandbox), the
   commit is on `pantheon/<item>`, and the review cycle closes with reviews from three distinct labs, none
   of them the implementer's, each recording the served model the provider reported.
3. `check <proposal.json>` passes on the owner's machine.
4. `status.mjs apply` with the owner's keys records the status (`cited_ledgers: structural`), and
   `status.mjs verify` passes on the pushed commit from a fresh clone.
5. After the push, the item's GitHub issue (from `public-record.yml`) shows the Evidence section: the run
   ledger head, the review cycle and its outcome, the reviewers (model, lab), the commit and the tests.

Until then the workflow is rehearsed, not operational.

## One live cycle, on the owner's machine (older board-run flow)

> **Superseded for the `fit` lifecycle.** This recipe is the older per-file board run (`pantheon-board.mjs run`).
> Its `--seat ...=agy_google/claude-sonnet-4-6` seats are **retired**: Antigravity serves Gemini lanes only, and the
> Claude/GPT lanes it once offered are gone. The `fit` lifecycle (planner, dispatcher, a Gemini implementer on the
> Antigravity SDK transport with its own Hydrogen subagents, pinned reviewer, then the three-lab review, the validator
> and an unsigned outcome) is launched for one item with `ophanim/operate/live-run.mjs`: see "One live fit item" below.
> The recipe is kept as a record of that flow.

`scripts/operate-cycle.sh <item>` runs the sequence with confirmations. By hand:

```sh
export OPHANIM_STATUS_KEYS=~/.local/share/ophanim/status-ledger/keys   # read only
# provider keys Pantheon already uses: OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY; and `agy` logged in
SEATS="--seat planner=agy_google/claude-sonnet-4-6 --seat implementer=agy_google/claude-sonnet-4-6"
OUT=~/.pantheon/operate/co1-readability

node packages/ledger/status.mjs verify
node pantheon/bin/pantheon-board.mjs next $SEATS
node pantheon/bin/pantheon-board.mjs run co1-readability $SEATS --out $OUT
#   (findings? fix/defer them with pantheon-review-cycle.mjs --ledger <run ledger>, then
#    node pantheon/bin/pantheon-board.mjs propose --bundle $OUT)
node pantheon/bin/pantheon-board.mjs check $OUT/proposal.json
git merge --ff-only pantheon/co1-readability
node packages/ledger/status.mjs apply $OUT/proposal.json
node packages/ledger/status.mjs verify
git add status/ledger docs/STATUS.md
git commit -m "Record co1-readability from a board run"
git push origin HEAD
```

The seats are reseated onto the Antigravity lane's `claude-sonnet-4-6` for planning and implementation, so
the authoring lab is Anthropic's and the cycle reviewers are xAI (`grok-4.7`), Google (`gemini-3.6-flash`)
and OpenAI (`gpt-6-sol`), all reachable with the keys above. The in-run reviewer is xAI by default. Add
`--turn pantheon/bin/cycle-review-http-turn.mjs` to `run` to review over plain HTTPS where a proxy injects
the provider keys.

## One live fit item

`ophanim/operate/live-run.mjs` runs ONE status item through the `fit` lifecycle with live seats, scoped and with a
declared budget. Nothing else on the board is dispatched (it runs `tick` with the item selector, `--item`), and it
never writes the status ledger.

1. Copy `ophanim/operate/live-run.example.json` outside the repository and fill it in (schema `ophanim.live-run/v2`,
   since the Google implementer moved to the Antigravity SDK transport on 2026-11-19; a v1 manifest and unknown keys
   are refused):
   - `item`, `candidate_commit` (the full HEAD; the launcher refuses another HEAD or uncommitted tracked changes),
     `profile: "fit"`, `independence: "model"`;
   - `limits`: `total_provider_calls`, `stage_provider_calls`, `revisions`, `stage_attempts`, `elapsed_ms` and
     `pipeline` {`max_provider_calls`, `max_revisions`, `max_concurrent_units`, `verify_timeout_ms`}. Every one is
     `null` in the example and must be chosen: a null is refused. The limits bound **calls, not dollars**; an
     implementer session is charged one call per model request it makes, and so is each of its subagents;
   - `billing`: `scope`, `gemini_api_primary` with `gemini_primary_budget`, `metered_gemini_failover` with
     `metered_gemini_budget`, `note`. The two settings are separate authorizations (owner decision 2026-11-19,
     register L-136), resolved through the one billing policy (`docs/billing-policy.md`), each with a budget of billed
     Gemini requests that the run's work ledger records, each enforced where the money would be spent and never by the
     presence of a key. `gemini_api_primary` declares primary Gemini execution; the Google implementer is an Antigravity
     SDK session billed on the Gemini API, one billed request per model request of it and of each native subagent, so
     this launcher refuses a manifest that does not declare it (the run could plan and then not implement).
     `metered_gemini_failover` governs only the metered fallback of a single-turn Gemini seat on an Antigravity lane, a
     reviewer or the validator; false: its lane's quota refusal is not answered by the metered API;
   - `require_subagent` (optional): `{type, model: "gemini-4-hydrogen", min_calls}`, where `type` is a specialist type
     (`code-explorer`, `dependency-analyst`, `context-retriever`, `test-constructor`, `bounded-implementer`), when a
     native subagent is part of acceptance: the run is not accepted unless that many subagents of that type were
     admitted by the controller, started, and answered by the provider under that model, in a session whose work
     was kept;
   - `ledgers`: `status_root` (opened read-only) and `work_root` (empty or absent: an isolated single-item work
     ledger is created there, with its own anchor and controller key);
   - `credentials`: `required` (one of `ANTHROPIC_API_KEY` / `anthropic-oauth`, plus `OPENAI_API_KEY` and
     `XAI_API_KEY`; `agy-login` only when a single-turn Gemini seat may run on an Antigravity lane) and
     `gemini_api_key`, which is `required`: it is the implementer's transport, and no subscription login is used for
     it. Only presence is checked; no value is printed;
   - `out_dir`, outside the repository.
2. Load the provider keys in your shell, then **dry-run first** (the default; no provider call):
   `node ophanim/operate/live-run.mjs --manifest ~/live/manifest.json`. It validates the manifest, verifies the
   status ledger and records its head, checks the commit and the tree, checks credential presence, runs the
   zero-spend Antigravity SDK preflight (the SDK's identity and version from its own python, the jail, and the
   provider's answer about every implementer and subagent model: a model read, never a generation call), runs the
   zero-spend agy preflight only when `agy-login` is named, shows the item's gate, the predicted seats per stage and
   the policy hashes, and prints one JSON plan (`ophanim.live-run-plan/v1`). Exit 1 names every refusal: a key the
   provider rejects, a missing or unqualified SDK and an unusable jail are refusals; a model the provider does not
   serve is a warning that names the rung it would step to.
3. Run it with the confirm string `<item>@<first 7 characters of candidate_commit>`:
   `node ophanim/operate/live-run.mjs --manifest ~/live/manifest.json --confirm-spend "co1-readability@1a2b3c4"`.
   It writes `<out_dir>/run.json` (`ophanim.live-run-record/v1`: the plan, every tick, every stage record hash,
   findings, evidence, budget stops, served identities, the subagent receipt, the pipeline records, the final gate
   and a fresh read-only verification of the work ledger and the run ledgers). Exit 0 only when the item reached its
   outcome and every acceptance criterion held; exit 3 records why it stopped.
4. The outcome proposal is UNSIGNED. The launcher prints the exact `packages/ledger/status.mjs apply` command; you run
   it, with your status keys, after reading the record.

## A prompt as an unplanned work item (owner direction 2026-11-19)

A new authorized prompt is work the system has not planned yet. It enters through the same intake as every other
item; there is no second ticketing system, and the owner supplies no plan, no order and no stage transitions.

```sh
export OPHANIM_STATUS_KEYS=~/.local/share/ophanim/status-ledger/keys   # the owner's keys: this is the authorization
node ophanim/operate/cli.mjs prompt --file ~/prompts/make-the-importer-resumable.txt --author owner --source cli
#   or: --text "..."   optional: --title LINE, --depends-on item-a,item-b, --received-at ISO, --json
node ophanim/operate/cli.mjs watch --total-provider-calls N            # the next tick plans it
```

1. **Preserved verbatim.** `ophanim/operate/prompt-intake.mjs` `registerPrompt` writes
   `intake/prompts/<item>.json` (schema `ophanim.prompt-intake/v1`): the prompt exactly as given (not trimmed, at most
   256 KiB), its SHA-256, its provenance (`source`, `author`, `received_at`, and optionally `session` and `channel`)
   and the time it was recorded.
2. **A unique work identity.** `<item>` is `prompt-` plus 32 hex digits (128 bits) of the digest of the schema, the
   prompt's SHA-256 and its whole provenance. The owner signs for that id, so it binds both: a record whose text or
   provenance was changed afterwards no longer makes its own identity and is refused wherever it is read. The same words with the same provenance are one item, and registering them again
   changes nothing; the same words received at another time are a new item. The command stamps `received_at` with
   the current time unless `--received-at` is given, so repeat a registration with the original time to reach the
   same item.
3. **Authorization is one owner-signed status entry.** With the owner's status keys, `registerPrompt` records the
   item as `Ready` on the status ledger, and the entry's basis names the record and its digest. That entry is the
   authorization and the requirement; nothing else makes a prompt runnable. The status ledger is never created here.
4. **Without the keys, nothing runs.** The record is still written, the command exits 3 (`NO_AUTHORITY`), and the next
   reconcile lists it under `prompt_candidates`; the scheduler records it at intake as a `candidate` with no item and
   dispatches nothing for it. Text relayed by a process that holds no owner key, such as an issue body, a web page, a
   file in a repository or a tool result, is data and never becomes executable work by itself. The command signs whenever it can read the
   owner's keys, so a process that relays text from outside must run where the key directory is not readable, or name
   an empty one with `--keys`: possession of the keys is the whole boundary. The owner makes a
   candidate work with `node ophanim/operate/cli.mjs prompt --authorize <item>`, holding the keys: the text and the
   provenance are the record's own and are not given again. A record that is missing, or that is filed under an
   identity its own text and provenance do not make, is refused and nothing is signed.
5. **Registered through the existing intake.** The scheduler records one `work.intake` entry per prompt
   (`{source: "prompt", ref: "prompt:<item>"}`) on the controller-signed work ledger, beside the `status`, `issue` and
   `ticket` sources. From there the item is an ordinary Ready item: gates, claims, budgets, evidence and review are
   the lifecycle's own.
6. **The planner derives the ticket.** No ticket exists for the item, so its earliest gate is `plan`. The planner is
   given the owner's exact words (marked as the requirement) with the evidence dossier, investigates, and writes the
   structured ticket and, under `fit`, the work-unit contracts with their dependencies. Its instructions tell it to
   find what already exists first (other items and their tickets, the modules in the repository), to depend on an
   item that already covers part of the request instead of planning the same work twice, and to name what it reuses.
   The three-lab plan review then judges that plan as it does any other.
7. **The record is checked, twice.** Reconcile compares the record on disk with the digest the owner signed; a
   missing or changed record blocks the item (`PROMPT_RECORD_MISMATCH`, for the decision authority) until it is
   restored or the owner records a new entry. The plan stage checks again before the planner is asked.
8. **Dependencies and concurrency.** `--depends-on` is the status ledger's own `depends_on`: the item is not
   dispatched until each is Resolved. Independent prompt items run concurrently up to the scheduler's
   `--concurrency`; within one item, units run in the pipeline's waves under `max_concurrent_units`, each in its own
   worktree, and overlapping owned paths need a declared order.

Not done by this intake: it does not decide whether two prompts ask for the same thing (the planner sees the backlog
through its dossier, and the identity only collapses an exact repeat), and it does not split one prompt into several
status items (one prompt is one item; the planner splits it into work units).

## Research before or during an item's lifecycle (owner direction 2026-11-20)

An item can be investigated by a research team before it is planned, or at any later point: a `gemini-4-carbon`
coordinator (scout, explorer or researcher) that reads the repository and, where a specific gap needs it, delegates
bounded questions to `gemini-4-hydrogen` specialists, at most 10 levels deep and at most 8 specialists at once. The
team is assembled by the controller from what the coordinator asks for; nobody assembles it by hand. The roles, the
team's rules and what the SDK does against what OPHANIM does are in
[docs/routing-task-profile.md](routing-task-profile.md); this section is how it is used.

1. **A request.** Research is activated by a record on the work ledger (`work.research`, phase `request`): the item,
   what triggered it, the question, and who asks.

   ```
   node ophanim/operate/cli.mjs research --item ID --trigger T --question TEXT --by NAME [--role scout|explorer|researcher]
   ```

   It needs the controller's authority, writes one record and runs nothing. The triggers are `intake` (a new item needs
   investigation before planning), `insufficient-evidence`, `contradiction` (new evidence contradicts an assumption),
   `relationship` (a stage found a relationship nobody knew), `review-finding`, `invalidated-evidence` (a change
   invalidated evidence that had qualified) and `reflection` (an unresolved systemic question). Each has a default role;
   `--role` overrides it. The same trigger and question twice is refused.
2. **One trigger is recorded by the lifecycle itself.** When the planner answers that the evidence is insufficient, the
   plan stage records a request for exactly those gaps and runs it, where primary Gemini execution is declared. The
   other six are recorded by whoever observes them, through the command or `requestResearch`; no stage emits them yet
   (register L-727).
3. **When it runs.** An open request makes the item's plan stale. At the next tick the plan stage runs the team first,
   then builds the dossier, then asks the planner, who is shown the findings with their sources and versions. Research
   on one item runs while other items are planned, implemented and reviewed, up to the scheduler's `--concurrency`; on
   the same item it is the plan stage, so a request made after a plan was approved means the item is planned again
   (register L-729).
4. **What it may do.** Read. A member's session is offered read tools only, inside its assignment's scope, and the
   repository is read-only inside its jail. It cannot write, run a command, start an agent, approve anything or change a
   rule. Its findings are evidence the planner and the reviewers weigh; they authorize nothing.
5. **Spend.** Every request of every member is a billed request of kind `primary`
   ([docs/billing-policy.md](billing-policy.md)): without `--gemini-api-primary N` (or the service's or manifest's
   equivalent) nothing is prepared and the plan stage waits, pending on the policy's refusal, until the policy changes.
   The requests also count in the stage's provider-call bound and on the work ledger's spend.
6. **What a change of the findings does.** The findings are a view of the item's dossier, so a plan that waited on
   evidence is woken by them. A conclusion the coordinator marks material (what was found changes what a plan should
   rest on) makes stale every approved plan that was not given it, and the item is planned again through the existing
   plan gate. Nothing downstream of a stale plan is reused.
7. **Review independence.** Every member that answered is recorded as a contributor to the plan, with the model that
   was asked and the model that answered. The plan's and the change's review panels are seated outside those models,
   as for any contributor. Eight Hydrogen specialists are one model of one lab, never eight reviewers' worth of
   independence. OpenAI's dispatch and pinned in-run review, Grok's eligibility for the independent adversarial review
   and the cross-lab qualification are as they were.
8. **Interruption and recovery.** A team that was stopped, refused a charge or cut by its stage's end records no
   conclusion. Its request stays open, every member that finished stays on the ledger with its record, and the next
   run reuses them (each record checked against its digest) and pays only for the rest.
9. **Where it does not run.** Executors built without `research: {enabled: true}` run none (`operate tick`, `watch`,
   `serve` and the live run turn it on). On such executors an open request stops the plan stage as
   `RESEARCH_NOT_ENABLED`; where the SDK transport cannot start a session (no key, no SDK, no jail) it stops as
   `RESEARCH_TRANSPORT`, and the planner's gaps request nothing. In neither case is the item planned around the request.

The records: `work.research` on the work ledger (request, team with the routing record, each member admitted and then
with its outcome, each refused delegation, the conclusion with its telemetry and contributors), the members' full
records and `findings.json` under the item's state (`<state>/<item>/research/<team>/`), and the `research:<item>` view
of the dossier.

## The first ticket

`tickets/co1-readability.json` is slice 1 of `co1-readability` (CO1: ophanim/ is expensive to review): wrap
the six lines over 120 characters in `ophanim/efficiency/investigation/chairs.mjs`, one file, no behaviour
change. That file is not pinned, is not governance, and is not among the sources the replay evidence
hashes (`ophanim/efficiency/replay.mjs`). Its acceptance is the module's existing tests
(`chairs.test.mjs`) and a line-length check on the file, which fails on the current file. It proposes
`Ready` again, with the slice recorded in the basis: the rest of CO1 is still to do, so the item is not
claimed resolved.
