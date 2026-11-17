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

## One live cycle, on the owner's machine

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

## The first ticket

`tickets/co1-readability.json` is slice 1 of `co1-readability` (CO1: ophanim/ is expensive to review): wrap
the six lines over 120 characters in `ophanim/efficiency/investigation/chairs.mjs`, one file, no behaviour
change. That file is not pinned, is not governance, and is not among the sources the replay evidence
hashes (`ophanim/efficiency/replay.mjs`). Its acceptance is the module's existing tests
(`chairs.test.mjs`) and a line-length check on the file, which fails on the current file. It proposes
`Ready` again, with the slice recorded in the basis: the rest of CO1 is still to do, so the item is not
claimed resolved.
