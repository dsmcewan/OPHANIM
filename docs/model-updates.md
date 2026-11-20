# When a lab releases a model

The labs are not called the same way and do not offer the same things, and they release models faster than a registry kept by hand follows. This is how a release is seen, recorded and, when the owner decides so, taken up.

Two things are kept apart throughout:

- **Catalogued**: the lab's documentation describes the model. Every such model is in `pantheon/src/config/vendor-catalog/<lab>.json`, used here or not.
- **Registered**: this repository may seat the model (`pantheon/src/config/models.json`). Nothing is registered, seated or routed by being catalogued.

## 1. See it

```
NODE_USE_ENV_PROXY=1 node pantheon/bin/pantheon-vendor-docs.mjs models
```

This reads every page each lab's documentation lists (about four minutes for the four labs, most of it Anthropic's API reference in each SDK's form), reads every model page, and compares the result with the kept catalogue, the registry and the recorded capability facts. It changes nothing. It exits 0 when there is nothing to do, 2 when there is, 1 when it could not read a lab.

| It prints | Meaning |
|---|---|
| `released <id>` | the lab describes a model the kept catalogue does not hold |
| `gone <id>` | the lab no longer describes a model the kept catalogue holds |
| `changed <id>` | a figure, status or alias of a catalogued model changed (each change is named) |
| `registered-not-published <id>` | a registered name the lab's documentation describes no model or alias of |
| `registered-ended <id>` | the lab calls a registered model deprecated, shut down or retired |
| `registered-legacy <id>` | the lab still serves a registered model and calls it legacy |
| `fact-differs <id>` | a figure in `capability-facts.json` is not the one on the lab's page |
| `unread` | a model page no model id could be read from (the lab changed its layout, or the page failed) |
| `stale` | the kept catalogue is older than the bound (`--max-age`, 14 days by default) |

`--all` also lists every catalogued model that is not registered. `--offline` compares the last capture without the network.

The documentation hosts must be reachable: `developers.openai.com`, `docs.x.ai`, `aistudio.google.com`, and for Anthropic `platform.claude.com`, `code.claude.com` (the Claude Code documentation) and `www.anthropic.com` (its engineering and research posts, read from the site's sitemap as web pages). No key is sent to them.

Three labs run a documentation server of their own, and the capture asks each for what the lab's index does not list. OpenAI's (`developers.openai.com/mcp`) is how the Codex documentation (on `learn.chatgpt.com`, never asked directly) is read: the server's list, then that site's own links, each page through the server. xAI's (`docs.x.ai/api/mcp`) supplies a few pages its index omits. Anthropic's (`platform.claude.com/docs/mcp`) lists nothing its index does not; its API reference as written for each SDK is listed nowhere and is captured from addresses made from the listed pages' own. Google's (`gemini-api-docs-mcp.dev`) only answers searches, so it is not read.

## 2. Record that it was seen

```
node pantheon/bin/pantheon-vendor-docs.mjs models --offline --write
node pantheon/bin/pantheon-vendor-docs.mjs reference --offline --write
```

The first keeps the fresh catalogue: a new model gets the day it was first seen, and a model that is gone stays with the day it was found gone. The second re-reads the pages chosen for each capability and regenerates `docs/vendor-labs.md`. Commit both. This is a record, not a decision: no route changes.

Read what the lab released before deciding anything. `docs/vendor-labs.md` names each lab's release-notes page; `find <lab> <words>` searches the captured pages and `show <lab> <address>` prints one.

## 3. Decide

Whether to take a model up is the owner's decision. Leaving a model catalogued and unregistered needs nothing further.

## 4. Take it up

Each step has a check that fails until the step is done.

| Step | Where | The check |
|---|---|---|
| Cite its figures from its own page: context window, output limit, reasoning levels, API surface. A figure the page does not state is `UNRECORDED` | `pantheon/src/config/capability-facts.json` | `pantheon/tests/capability-facts.test.mjs`: "every registry model has a record, and every figure is cited or UNRECORDED" |
| Register it | `pantheon/src/config/models.json` | the same test: a registered model with no record fails it |
| Say which lab made it and which names are the same model, where its name does not already say so | `pantheon/src/config/model-identity.json` | `pantheon/tests/review-identity-policy.test.mjs` |
| Give the code its capability record, agreeing with the cited figures | `packages/model-client/registry.mjs` | `capability-facts.test.mjs`: "the code's disagreements with the cited facts are exactly the known list" |
| Run the check again: no `fact-differs` and no `registered-*` line for it | `models --offline` | `pantheon/tests/vendor-docs-models.test.mjs`: "THE REGISTRY AGAINST THE KEPT CATALOGUES" pins what stands; a settled item is taken out of its list |
| Ask the lab for the model once and see it answer under its own name | a live request, with a key the lab accepts | until this has run, the model is registered and **unverified**, and anything written about it says so |
| Seat or route it | the lane, tier and routing tables | the owner's decision; no step above changes where work is sent |

## 5. When a registered model ends

`registered-ended` and `registered-not-published` mean a seat may stop answering. Decide its replacement (steps 3 and 4 for the replacement), then remove the old name from the registry and from every lane and route that names it. `registered-legacy` is a warning with no date: the lab's deprecations page, named in `docs/vendor-labs.md`, says when.

## The captured documentation as an MCP server

`pantheon/bin/pantheon-vendor-docs-mcp.mjs` serves what was captured to a model at work, over stdio: which labs are held and when each was read, find a page by the index's words, search the pages' own text, read a page (a long one in parts, a web page as its words), list a lab's catalogued models or get one with every figure and the line it was read from, and the cross-lab reference by topic. It only reads, and it reads only through the manifest: a lab not captured says so instead of looking empty. Register it as the file's header shows.

A search of the pages' text reads every page of the lab each time; over Anthropic's 6,008 pages that took about eight seconds.

## Looking something up through Context7

A session that has the Context7 connector can ask it about any lab's documentation. The library ids are in `pantheon/src/config/vendor-context7.json`, among them the Codex repository.

Context7 is a third party's index of snippets taken from the labs' pages. It is for a question and for a cross-check. It cannot supply a lab's documentation whole. Measured on 2026-11-20, after the owner asked for it to be used to get everything:

| What was tried | Result |
|---|---|
| Downloading a library (`llms.txt`) | about 200,000 tokens, some 400 snippets, per request. The page number is ignored: every page is the first |
| A topic word on the request | changes which snippets come back for a documentation-site library; made no difference on the Codex repository library |
| 37 topic words on each lab's main library (148 requests, 66 MB, kept beside the capture under `context7/`) | 12% to 36% of the snippets Context7 lists for the lab; 29% to 42% of the pages the direct capture holds whole |
| The Codex repository library, one download | 317 of the 3,241 snippets it lists |
| Its query method with no key | refused ("Monthly quota exceeded"). Through the connector it answers one question at a time |

The cross-check found something the capture alone could not: pages the labs' own indexes do not list (register L-811).

A figure is cited from the lab's own page (`show <lab> <address>`), never from a Context7 snippet.

## What this does not do

- It reads documentation. It does not ask a lab's API which models a given key is served; that needs a key the lab accepts.
- It runs when someone runs it. Nothing schedules it.
- Each lab's model pages are read by a reading written for that lab's layout as it was on 2026-11-20. A lab that changes its layout shows up as `unread` pages or as figures that disappear (`changed ... -> nothing`), not as wrong figures.
- The comparison across labs is a list of each lab's own pages per capability. No statement about how two labs differ is derived from them here.
