# The foundry

OPHANIM "is an autonomous systems foundry. Its purpose is to investigate requirements, discover dependencies, construct
capabilities, verify outcomes, operate systems, and improve its own processes" (owner directive, 2026-11-20,
`docs/knowledge-graph/directive-2026-11-20.md`). The stages existed apart. `ophanim/foundry/` runs them as one path for
one request, and lets the knowledge graph decide who builds (owner direction, 2026-11-20: "Use the knowledge_graph";
"A/B test and keep metrics of the best and fastest set up").

Every limit of what follows is in `docs/OPEN-LIMITATIONS.md`, rows F-1 to F-14. Four of them (F-10 to F-13) are where
the foundry, as built, sits outside rules the rest of the system keeps: one lifecycle and its work ledger,
owner-directed seats, one store of measurements, and the central billing policy. F-10 and F-11 wait on the owner.

## What it does

A **request** (`ophanim.foundry.request/v1`, `request.mjs`) states the product's goal in words a builder with no tools
can work from, the files to produce, the command that accepts them, the command that operates them, and what the
product may depend on. Its seed directory carries everything those commands need. The acceptance contract is the
requester's: no builder writes it.

`runFoundry` (`foundry.mjs`) carries the request through seven stages and records each:

| Stage | What happens | Built on |
|---|---|---|
| observe | The request is read and digested; every earlier trial in the state directory is loaded. | `request.mjs` |
| investigate | The graph is composed. The capability graph's eligibility decision says which executable capabilities may plan, build and review, and why; the ones this environment reaches are kept; what is already measured for this class of task is read from the graph. | `pantheon/src/capability/graph.mjs`, `eligibility.mjs`; `graph.mjs`, `setups.mjs` |
| plan | The setups to try (arms) and the order of the trials. The best setup measured so far leads, setups not yet measured come next. | `foundry.mjs` `chooseArms` |
| construct | Each trial hands the request to Pantheon's board pipeline with the setup's seats: it plans, builds each file, runs the acceptance command in the Bubblewrap jail and has the product reviewed. | `pantheon/src/board/run-item.mjs` `runOpenItem`; `trial.mjs` |
| verify | The acceptance result, and the dependency gate: the product's source is read for what it needs (packages, platform modules, environment names, hosts, programs, files) and anything the request did not allow is refused, with its line. | `ophanim/graph/deps/parse.mjs`; `trial.mjs` `dependencyGate` |
| operate | An accepted product is run with the request's operate command in the same jail; its report and score are recorded. | `pantheon/src/board/acceptance.mjs` |
| learn | The setups are ranked over every trial of the class. Each trial's run record goes through Pantheon's own capability-metrics extractor, and one observation per setup is stated on the graph, joined to the implementer's capability by `measures`. The winner's product is written out with what stands behind it. | `pantheon/src/capability/metrics.mjs`; `graph.mjs`, `setups.mjs` |

With `rework` rounds, an accepted product whose reviewer requested changes is built again by the same setup with the
previous revision and the review in hand. A rework trial is recorded against its parent and is never ranked with first
builds.

**The criterion** (`setups.mjs` `CRITERION`), in order: the share of trials accepted; the operation score, where the
request defines one; the median wall time of the accepted trials; the median reported cost. Fewer than three accepted
trials for any setup and the ranking says the order is not established. The criterion orders. It qualifies nothing: no
`qualified-for` is emitted, because that needs a criterion the owner defines (`metrics.mjs`).

**The model seats.** The capability graph admits planner, implementer and reviewer seats across every lab it lists
(anthropic, openai, xai, agy_google); `candidateSetups` keeps the ones `reachable(seat)` says this environment can serve.
Two transports supply that reachability (`transports.mjs`): the Claude command line (`claude-cli.mjs`), one `claude -p`
process per turn with no tools, no settings, no saved session, an empty directory and a spending cap; and pantheon's live
SDK seats (`sdk/live.mjs` `liveClients`) for the OpenAI/xAI API and for agy_google. `composeSeats` (`seats.mjs`) joins
them into one `makeClientFor(vendor)` that dispatches each lab to the transport serving it, under one shared spending
cap, and reports a trial `live` only when every reachable transport is live. `build --seats all` uses the composed
provider; the default (`--seats claude-cli`) uses the command line alone, so a run never reaches beyond it unasked.

A transport is reachable only when it can actually serve here: the Claude CLI on `PATH`, or a vendor SDK installed with a
credential present. This repository ships with no vendor SDK and no API key a provider accepts, so **only the Claude
command line is reachable**: one lab, every review by another model of its own lab, Pantheon's REVIEW gate refusing to
ship, and a product `accepted`, never `shipped`. The other three labs are wired and admitted by the graph; they build the
moment their SDK and a working key are present (F-1, F-3).

**Authority.** The trial records in the state directory are the authority. The graph is re-derived from them on every
run with keys made for the run; nothing is kept in it that the records do not hold.

## Running it

```sh
node ophanim/foundry/cli.mjs build --request ophanim/foundry/requests/market-maker/request.json --state /abs/state \
  --arms 3 --implementers claude-haiku-4-5-20251001,claude-sonnet-5,claude-opus-5-5 \
  --planner claude-haiku-4-5-20251001 --reviewer claude-fable-5-2 --rework 1 --max-usd 4
node ophanim/foundry/cli.mjs status --state /abs/state
```

`build` spends on the signed-in account, up to `--max-usd` in total (default 2). It needs Linux and Bubblewrap.
`status` spends nothing.

## The first product: a paper-trading market maker

The request `marketMaker` (`ophanim/foundry/requests/market-maker/`) asks for one file, `strategy.mjs`: a market-making
strategy for BTCUSD with no imports. Its seed holds a simulator that replays 500 recorded public trades (Gemini, read
once on 2026-11-20 through a read-only market-data connector), an acceptance over the first half of the tape and an
operation over the second half, which the acceptance never replays. **It is paper trading. No order was sent, and
nothing in the foundry can send one.**

The foundry was run on it three times on 2026-11-20, with the Claude command line as the only seat. What it recorded is
in `docs/foundry/market-maker/evidence.json`; the product is `docs/foundry/market-maker/strategy.mjs`.

| Trial | Builder | Accepted | Reviewer | Build time | Cost (reported) | Operation score, second half |
|---|---|---|---|---|---|---|
| 1 | claude-haiku-4-5-20251001 | yes | requested changes | 137 s | $0.27 | −15.41 USD |
| 2 | claude-sonnet-5 | yes | requested changes | 184 s | $0.39 | −11.27 USD |
| 3 | claude-opus-5-5 | yes | requested changes | 103 s | $0.36 | −6.52 USD |
| 4 | claude-opus-5-5 | no: the planner seat did not answer in the required form | none | 56 s | $0.03 | not operated |
| 5 | claude-sonnet-5 | yes | requested changes | 167 s | $0.37 | −11.92 USD |
| 6 | claude-sonnet-5, rework of 5 | yes | approved | 177 s | $0.51 | −4.25 USD |

Reported cost in total: $1.93. The planner was claude-haiku-4-5-20251001 and the reviewer claude-fable-5-2 in every
trial.

What the record shows:

- **Every first build passed the acceptance on its first revision** and needed nothing the request did not allow.
- **Every first build lost money on the unseen half of the tape**, and the reviewer said why before the operation
  did: the spreads were narrower than the simulator's fee, and the inventory skew was too weak to stop one-sided
  accumulation. A hand-written reference strategy (`ophanim/foundry/fixtures/market-maker/reference.mjs`) scores
  −7.83 USD on the same half.
- **The rework closed part of that gap.** Given trial 5 and its review, the same setup produced a revision the reviewer
  approved, with a result of −4.25 USD against −11.92 USD before. It is still a loss.
- **The second run started from the setup measured best** (the opus builder) and that trial failed at the planning
  step. Its share accepted fell to one in two, and the third run started from the sonnet builder instead.
- **The ranking is not established.** No setup has three accepted trials; the order is what was measured so far.
- **Nothing was shipped.** Every review was by another model of the builder's lab, and the REVIEW gate refused each.

## Tests

`ophanim/tests/foundry-claude-cli.test.mjs`, `foundry-trial.test.mjs`, `foundry.test.mjs` and
`foundry-market-maker.test.mjs` (27 tests; `npm run test:proof`). They run Pantheon's real pipeline, the real jail and
the real graph. The model seat is a stand-in for the command line (`ophanim/foundry/fixtures/fake-claude.mjs`): no model,
no network, no key. The last test replays the recorded product and checks it reproduces its recorded operation.
