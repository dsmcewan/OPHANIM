// The model catalogue and the check: every model a lab's documentation describes is recorded with what its own page states
// and the line it states it on; what a page does not state is absent, never filled in; and a fresh reading is compared with
// the catalogue kept in the repository, the registry and the recorded capability facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LAYOUTS, catalogue, keep, tokens } from "../src/vendor-docs/models.mjs";
import { check, recordChanges } from "../src/vendor-docs/check.mjs";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "../src/config");
const json = f => JSON.parse(readFileSync(f, "utf8"));

// One page per lab, written in that lab's layout. The text is made up; the layout is the lab's.
const OPENAI = `# GPT-9 Vega

> A reasoning model.

Model ID: \`gpt-9-vega\`

Status: Deprecated

Use it for hard work.
\`reasoning.effort\` supports \`low\`, \`medium\` (default), \`high\`, and
\`max\`.
The API rejects requests that set reasoning effort to \`none\`.

## Model details

- Default snapshot: \`gpt-9-vega-2026-01-01\`
- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens
- May 18, 2026 knowledge cutoff

## Endpoints

| Endpoint | Route | Support |
| --- | --- | --- |
| Responses | \`v1/responses\` | Supported |
| Realtime | \`v1/realtime\` | Not supported |

## Supported features

- streaming
- structured_outputs

## Snapshots

Snapshots let you lock in a version.

- \`gpt-9-vega\`
- \`gpt-9-vega-2026-01-01\`

## Rate limits

- not a snapshot: \`tier-1\`
`;
const XAI = `# Grok 9

## At a glance

- **Modalities:** text, image → text
- **Context window:** 500,000 tokens
- **Model name:** \`grok-9\`
- **Aliases:** \`grok-9-latest\`, \`grok-fast\`
- **Batch API:** Supported

## Capabilities

- **Function calling:** Yes
- **Structured outputs:** No
- **Reasoning efforts (supported):** \`low\`, \`high\`
- **Reasoning efforts (default):** \`high\`

## Pricing

- **Output:** $1
`;
const GOOGLE = `# Gemini 9 Family

Earlier previews of this family are deprecated.

Gemini 9 Old (\`gemini-9-old\`) is deprecated and will be shut down.

## gemini-9-new  {% id="gemini-9-new" %}

{% table variant="model" %}
  *     {% section class="model-property" %}
  {% icon name="id_card" /%}Model code

    {% /section %}

  * **Gemini API**
    \`gemini-9-new\`

  ---

  *     **Inputs** Text and Image

    **Output** Text

  ---

  *     **Context window (unified input and output token limit)** 1,048,576

    **Max output** 65,536 (default synchronous) / up to 1,048,576 (with [long decode](/docs/long-decode))

  ---

  *     {% section %}
  [**Function calling**](/docs/function-calling)

  {% badge type="supported" /%}

  {% /section %}

  {% section %}
  [**Live API**](/docs/live-api)

  {% badge type="not-supported" /%}

  {% /section %}

  {% section %}
  [**Thinking**](/docs/thinking)

  {% badge label=Supported (low, medium, high) type="supported" /%}

  {% /section %}
{% /table %}

## gemini-9-old  {% id="gemini-9-old" %}

{% table variant="model" %}
  *   {% icon name="id_card" /%}Model code

  * \`gemini-9-old\`

  ---

  *   **Input token limit** 32,000

    **Output token limit** 8,192

  ---

  *   [**Thinking**](/docs/thinking) Not supported
{% /table %}
`;
const GOOGLE_AGENT = "# Agent preview\n\nThe September release (`agent-preview-09`) upgrades the harness. See also `gemini-9-new`.\n";
const ANTHROPIC = `---
title: Claude Lyra 9
url: https://platform.claude.com/docs/en/models/lyra-9/overview
---

**Legacy.** Released June 30, 2026.

Model ID: \`claude-lyra-9\`

Context window: 1M tokens · Max output: 128K tokens · Input pricing: $2 / MTok · Output pricing: $10 / MTok

| Model | Context | Default effort |
| :---- | :------ | :------------- |
| **Claude Lyra 9** (this model) | 1M | \`high\` |

| Feature | Value |
| :------ | :---- |
| [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | Adaptive |
| [Default effort](https://platform.claude.com/docs/en/build-with-claude/effort) | \`medium\` |
| Reliable knowledge cutoff | Jun 2026 |
`;

test("token counts are read in the forms the labs write them, and nothing else is taken for one", () => {
  assert.deepEqual(["1,050,000", "1M", "128K", "500k", "1,048,576", "65,536 (default synchronous)", "1.5M"].map(tokens), [1050000, 1000000, 128000, 500000, 1048576, 65536, 1500000]);
  assert.deepEqual(["Flexible", "", "n/a"].map(tokens), [null, null, null]);
});

test("OPENAI'S LAYOUT: the id, snapshots, status and each figure with the line it stands on; a sentence broken over two lines is read whole", () => {
  const [m] = LAYOUTS.openai.read(OPENAI, "https://developers.openai.com/api/docs/models/gpt-9-vega.md");
  assert.deepEqual([m.id, m.name, m.aliases, m.status], ["gpt-9-vega", "GPT-9 Vega", ["gpt-9-vega-2026-01-01"], { value: "Deprecated", quote: "Status: Deprecated" }]);
  assert.deepEqual(m.facts.context_window, { value: 1050000, quote: "- 1,050,000 context window" });
  assert.deepEqual(m.facts.max_input, { value: 922000, quote: "- Maximum input tokens: 922,000" });
  assert.deepEqual(m.facts.max_output, { value: 128000, quote: "- 128,000 max output tokens" });
  assert.deepEqual(m.facts.efforts, { values: ["low", "medium", "high", "max"], quote: "`reasoning.effort` supports `low`, `medium` (default), `high`, and `max`." });
  assert.deepEqual(m.facts.effort_default, { value: "medium", quote: "`reasoning.effort` supports `low`, `medium` (default), `high`, and `max`." });
  assert.deepEqual(m.facts.reasoning_notes, ["The API rejects requests that set reasoning effort to `none`."]);
  assert.deepEqual(m.facts.supports, { "v1/responses": "Supported", "v1/realtime": "Not supported" });
  assert.deepEqual([m.facts.features, m.facts.input.value, m.facts.knowledge_cutoff.value], [["streaming", "structured_outputs"], "text, image", "May 18, 2026"]);
});

test("XAI'S LAYOUT: the model name, its aliases, the reasoning levels and their default, and what the page says it supports", () => {
  const [m] = LAYOUTS.xai.read(XAI, "https://docs.x.ai/developers/models/grok-9.md");
  assert.deepEqual([m.id, m.name, m.aliases], ["grok-9", "Grok 9", ["grok-9-latest", "grok-fast"]]);
  assert.deepEqual(m.facts.context_window, { value: 500000, quote: "- **Context window:** 500,000 tokens" });
  assert.deepEqual(m.facts.efforts, { values: ["low", "high"], quote: "- **Reasoning efforts (supported):** `low`, `high`" });
  assert.deepEqual(m.facts.effort_default.value, "high");
  assert.deepEqual(m.facts.supports, { "Function calling": "Yes", "Structured outputs": "No", "Batch API": "Supported" });
  assert.equal(m.facts.max_output, undefined, "the page states no output limit, so none is recorded");
});

test("GOOGLE'S LAYOUT: one page describes several models, each read from its own table; an agent's page names its model in its text", () => {
  const [fresh, old] = LAYOUTS.google.read(GOOGLE, "https://aistudio.google.com/docs/models/gemini-9.md");
  assert.deepEqual([fresh.id, old.id, fresh.name], ["gemini-9-new", "gemini-9-old", "Gemini 9 Family"]);
  assert.deepEqual(fresh.facts.context_window, { value: 1048576, quote: "**Context window (unified input and output token limit)** 1,048,576" });
  assert.deepEqual(fresh.facts.max_output.value, 65536);
  assert.deepEqual(fresh.facts.supports, { "Function calling": "Supported", "Live API": "Not supported", Thinking: "Supported (low, medium, high)" });
  assert.deepEqual(fresh.facts.efforts, { values: ["low", "medium", "high"], quote: "Thinking: Supported (low, medium, high)" });
  assert.deepEqual([old.facts.context_window.value, old.facts.max_output.value, old.facts.supports, old.facts.efforts], [32000, 8192, { Thinking: "Not supported" }, undefined]);
  assert.deepEqual([fresh.status, old.status], [undefined, { value: "deprecated", quote: "Gemini 9 Old (`gemini-9-old`) is deprecated and will be shut down." }],
    "a sentence about one model of a family page is that model's; one that names no model is nobody's on a page of several");
  const alone = "# Solo\n\nThis model is shut down.\n\n  {% icon /%}Model code\n\n  * `solo-1`\n\n  ---\n";
  assert.deepEqual(LAYOUTS.google.read(alone, "https://aistudio.google.com/docs/models/solo-1.md").map(m => [m.id, m.status]), [["solo-1", { value: "shut down", quote: "This model is shut down." }]]);
  assert.deepEqual(LAYOUTS.google.read(GOOGLE_AGENT, "https://aistudio.google.com/docs/models/agent-preview-09.md").map(m => m.id), ["agent-preview-09"]);
  assert.deepEqual(LAYOUTS.google.read(GOOGLE_AGENT, "https://aistudio.google.com/docs/models/some-other-agent.md"), [], "a name in backticks that is not the page's own is not taken for its model");
});

test("ANTHROPIC'S LAYOUT: the id, the lifecycle word, the summary line's figures, and the default effort from the model's own row", () => {
  const [m] = LAYOUTS.anthropic.read(ANTHROPIC, "https://platform.claude.com/docs/en/models/lyra-9/overview.md");
  assert.deepEqual([m.id, m.name, m.status], ["claude-lyra-9", "Claude Lyra 9", { value: "Legacy", quote: "**Legacy.** Released June 30, 2026." }]);
  const summary = "Context window: 1M tokens · Max output: 128K tokens · Input pricing: $2 / MTok · Output pricing: $10 / MTok";
  assert.deepEqual([m.facts.context_window, m.facts.max_output], [{ value: 1000000, quote: summary }, { value: 128000, quote: summary }]);
  assert.equal(m.facts.effort_default.value, "medium", "the feature row, not the comparison table's column");
  assert.deepEqual([m.facts.thinking.value, m.facts.knowledge_cutoff.value, m.facts.efforts], ["Adaptive", "Jun 2026", undefined]);
});

const U = { openai: "https://developers.openai.com/api/docs/models/", google: "https://aistudio.google.com/docs/models/" };
const manifestOf = pages => ({ read: "2026-11-20T08:00:00.000Z", pages: pages.map(([url, body, extra = {}]) => ({ url, status: "captured", sha256: `sha-of-${url.split("/").pop()}`, body, ...extra })) });
const cat = (lab, pages) => catalogue({ lab, manifest: manifestOf(pages), text: p => p.body });

test("THE CATALOGUE HOLDS EVERY MODEL PAGE OF THE CAPTURE: a page with no id, or not captured, is named as unread and nothing is invented for it", () => {
  const c = cat("openai", [
    [`${U.openai}gpt-9-vega.md`, OPENAI],
    [`${U.openai}mystery.md`, "# Mystery\n\nNo id here.\n"],
    [`${U.openai}lost.md`, "", { status: "failed", why: "HTTP 500" }],
    [`${U.openai}all.md`, OPENAI],
    ["https://developers.openai.com/api/docs/guides/text.md", OPENAI],
  ]);
  assert.deepEqual(Object.keys(c.models), ["gpt-9-vega"]);
  assert.deepEqual([c.models["gpt-9-vega"].page, c.models["gpt-9-vega"].sha256, c.read, c.lab, c.schema], [`${U.openai}gpt-9-vega.md`, "sha-of-gpt-9-vega.md", "2026-11-20T08:00:00.000Z", "openai", "pantheon.vendor-catalog/v1"]);
  assert.deepEqual(c.unread, [
    { url: `${U.openai}lost.md`, why: "not captured: HTTP 500" },
    { url: `${U.openai}mystery.md`, why: "no model id where this lab's model pages state one" },
  ]);
  assert.throws(() => catalogue({ lab: "newlab", manifest: manifestOf([]), text: () => "" }), { code: "VENDOR_LAYOUT_UNKNOWN" });
});

test("a model described on two pages is recorded once, from the first, with the other page named beside it", () => {
  const c = cat("google", [[`${U.google}gemini-9.md`, GOOGLE], [`${U.google}gemini-9-old.md`, GOOGLE.split("## gemini-9-old")[1].replace(/^/, "# Old\n\n## gemini-9-old")]]);
  assert.deepEqual(Object.keys(c.models), ["gemini-9-new", "gemini-9-old"]);
  assert.deepEqual([c.models["gemini-9-old"].page, c.models["gemini-9-old"].also, c.unread], [`${U.google}gemini-9-old.md`, [`${U.google}gemini-9.md`], []]);
});

test("WHAT IS KEPT REMEMBERS: the day each model was first seen is carried, a model no longer described stays with the day it was found gone, and one seen again is no longer gone", () => {
  const first = keep(null, cat("openai", [[`${U.openai}gpt-9-vega.md`, OPENAI], [`${U.openai}gpt-8.md`, OPENAI.replaceAll("gpt-9-vega", "gpt-8")]]));
  assert.deepEqual([first.models["gpt-9-vega"].first_seen, first.models["gpt-8"].first_seen], ["2026-11-20", "2026-11-20"]);
  const later = cat("openai", [[`${U.openai}gpt-9-vega.md`, OPENAI], [`${U.openai}gpt-10.md`, OPENAI.replaceAll("gpt-9-vega", "gpt-10")]]);
  const second = keep(first, { ...later, read: "2026-12-01T00:00:00.000Z" });
  assert.deepEqual([second.models["gpt-9-vega"].first_seen, second.models["gpt-10"].first_seen, second.models["gpt-8"].gone_since, second.models["gpt-8"].facts.context_window.value],
    ["2026-11-20", "2026-12-01", "2026-12-01", 1050000]);
  const third = keep(second, { ...first, read: "2026-12-09T00:00:00.000Z" });
  assert.deepEqual([third.models["gpt-8"].gone_since ?? null, third.models["gpt-8"].first_seen, third.models["gpt-10"].gone_since], [null, "2026-11-20", "2026-12-09"]);
  const fourth = keep(third, { ...first, read: "2026-12-20T00:00:00.000Z" });
  assert.equal(fourth.models["gpt-10"].gone_since, "2026-12-09", "the day a model was found gone is not moved by a later reading");
});

const model = (over = {}) => ({ name: "M", page: "https://docs.lab.test/m.md", sha256: "a", aliases: [], facts: { context_window: { value: 1000, quote: "1,000 context window" }, efforts: { values: ["low", "high"], quote: "q" } }, ...over });
const catalogueOf = (models, read = "2026-11-20T08:00:00.000Z") => ({ schema: "pantheon.vendor-catalog/v1", lab: "lab", read, models, unread: [] });
const kinds = r => r.findings.map(f => [f.kind, f.id ?? null]);

test("A MODEL RELEASED SINCE THE CATALOGUE WAS KEPT IS REPORTED, and so is one that is gone, changed, or back", () => {
  const kept = catalogueOf({ a: model(), b: model(), c: model(), d: { ...model(), gone_since: "2026-11-01" }, f: { ...model(), gone_since: "2026-10-01" } });
  const fresh = catalogueOf({ a: model({ sha256: "reworded", facts: { ...model().facts, context_window: { value: 1000, quote: "1,000 tokens of context" } } }),
    c: model({ sha256: "changed", status: { value: "Deprecated", quote: "Status: Deprecated" }, facts: { context_window: { value: 2000, quote: "2,000 context window" } } }),
    d: model(), e: model({ name: "Model E", page: "https://docs.lab.test/e.md" }) }, "2026-11-27T08:00:00.000Z");
  const r = check({ lab: "lab", kept, fresh, today: "2026-11-27T09:00:00Z" });
  assert.deepEqual(kinds(r), [["changed", "c"], ["released", "d"], ["released", "e"], ["gone", "b"]]);
  assert.deepEqual(r.findings.map(f => f.why), [
    "status: nothing -> \"Deprecated\"; context_window: 1000 -> 2000; efforts: [\"low\",\"high\"] -> nothing",
    "M: described at https://docs.lab.test/m.md (it was gone since 2026-11-01)",
    "Model E: described at https://docs.lab.test/e.md",
    "no longer described (it was at https://docs.lab.test/m.md)",
  ]);
  assert.equal(r.findings.some(x => x.id === "f"), false, "a model already recorded as gone is not found gone again at each reading");
  assert.equal(r.counts.pages_changed, 2, "a page that was only reworded is counted, and is not a change of the record");
  assert.deepEqual(recordChanges(model(), model({ aliases: ["m-latest"] })), [{ field: "aliases", was: "[]", now: "[\"m-latest\"]" }]);
});

test("a catalogue never kept, or kept too long ago, is itself something to do; one read within the bound is not", () => {
  const fresh = catalogueOf({ a: model() });
  assert.deepEqual(kinds(check({ lab: "lab", kept: null, fresh, today: "2026-11-20" })), [["never-kept", null]]);
  const kept = catalogueOf({ a: model() }, "2026-11-01T08:00:00.000Z");
  assert.deepEqual(kinds(check({ lab: "lab", kept, fresh, today: "2026-11-15T23:00:00Z", maxAgeDays: 14 })), []);
  const stale = check({ lab: "lab", kept, fresh, today: "2026-11-16T00:00:00Z", maxAgeDays: 14 });
  assert.deepEqual(stale.findings, [{ kind: "stale", why: "the kept catalogue was read 2026-11-01, 15 days before 2026-11-16 (more than 14)" }]);
  assert.deepEqual(kinds(check({ lab: "lab", kept: { ...kept, read: "not a date" }, fresh, today: "2026-11-16" })), [["stale", null]], "a read date that cannot be read is not taken for a recent one");
});

test("THE REGISTRY IS HELD AGAINST WHAT THE LAB PUBLISHES: a registered name the lab does not describe, one it calls ended or legacy, and a recorded figure its page contradicts", () => {
  const fresh = catalogueOf({
    live: model({ aliases: ["live-latest"] }),
    ended: model({ status: { value: "Deprecated", quote: "Status: Deprecated" } }),
    old: model({ status: { value: "Legacy", quote: "**Legacy.** Released June 30, 2026." } }),
    quiet: model({ facts: {} }),
  });
  const facts = {
    live: { window: { value: 999 }, output: "UNRECORDED", efforts: { values: ["high", "low"] } },
    "live-latest": { window: { value: 1000 } },
    ended: { window: { value: 1000 }, efforts: { values: ["low"], conflict: { resolution: "the narrower list" } } },
    quiet: { window: { value: 5 }, efforts: { values: ["low"] } },
    "lane-name": { api_id: false },
  };
  const kept = keep(null, fresh);
  const r = check({ lab: "lab", kept, fresh, registry: ["live", "live-latest", "ended", "old", "quiet", "vanished", "lane-name"], facts, today: "2026-11-20" });
  assert.deepEqual(r.findings, [
    { kind: "fact-differs", id: "live", why: "context window: recorded 999, the lab's page says 1000" },
    { kind: "registered-ended", id: "ended", why: "the lab says: Status: Deprecated" },
    { kind: "registered-legacy", id: "old", why: "the lab says: **Legacy.** Released June 30, 2026." },
    { kind: "registered-not-published", id: "vanished", why: "registered here, and the lab's documentation describes no model or alias of this name" },
  ]);
  assert.deepEqual([r.counts, r.unregistered], [{ published: 4, registered: 4, unregistered: 0, pages_changed: 0 }, []]);
  const none = check({ lab: "lab", kept, fresh, registry: [], facts, today: "2026-11-20" });
  assert.deepEqual([none.findings, none.unregistered], [[], ["live", "ended", "old", "quiet"]], "a catalogued model that is not registered is counted and is nothing to do");
});

test("a page of the fresh reading that could not be read as a model is carried into the findings", () => {
  const fresh = { ...catalogueOf({ a: model() }), unread: [{ url: "https://docs.lab.test/x.md", why: "no model id where this lab's model pages state one" }] };
  assert.deepEqual(check({ lab: "lab", kept: keep(null, fresh), fresh, today: "2026-11-20" }).findings,
    [{ kind: "unread", why: "https://docs.lab.test/x.md: no model id where this lab's model pages state one" }]);
});

test("THE CATALOGUES KEPT IN THE REPOSITORY: each lab's is well formed, every figure carries the line it was read from, and each page is on the lab's own documentation host", { skip: !existsSync(join(CONFIG, "vendor-catalog")) && "no catalogue is kept yet" }, () => {
  const labs = json(join(CONFIG, "vendor-docs.json")).labs;
  for (const [lab, def] of Object.entries(labs)) {
    const c = json(join(CONFIG, "vendor-catalog", `${lab}.json`));
    assert.deepEqual([c.schema, c.lab], ["pantheon.vendor-catalog/v1", lab]);
    assert.match(c.read, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Object.keys(c.models).length > 0, `${lab}: the catalogue holds no model`);
    for (const [id, m] of Object.entries(c.models)) {
      assert.equal(def.hosts.includes(new URL(m.page).hostname), true, `${lab} ${id}: ${m.page} is not on the lab's documentation hosts`);
      assert.match(m.sha256, /^[0-9a-f]{64}$/, `${lab} ${id}: the page's digest`);
      assert.match(m.first_seen, /^\d{4}-\d{2}-\d{2}$/, `${lab} ${id}: the day first seen`);
      for (const [k, f] of Object.entries(m.facts)) {
        if (Array.isArray(f) || k === "supports") continue;
        assert.ok(typeof f.quote === "string" && f.quote.length > 0, `${lab} ${id}.${k} carries no quoted line`);
      }
    }
  }
});

// The registry against the kept catalogues, computed here without the network. This list is what stands today. A new
// disagreement fails this test, and one that is settled must be taken out of it: the adoption procedure's last check.
const STANDING = [
  ["xai", "registered-not-published", "grok-build-0.1"],
  ["anthropic", "registered-legacy", "claude-haiku-4-5-20251001"],
  ["anthropic", "registered-legacy", "claude-sonnet-5"],
  ["anthropic", "registered-legacy", "claude-opus-5"],
];
test("THE REGISTRY AGAINST THE KEPT CATALOGUES: what stands between them is exactly the list recorded here", () => {
  const registry = json(join(CONFIG, "models.json")), facts = json(join(CONFIG, "capability-facts.json")).models, found = [];
  for (const lab of Object.keys(json(join(CONFIG, "vendor-docs.json")).labs)) {
    const kept = json(join(CONFIG, "vendor-catalog", `${lab}.json`));
    const described = { ...kept, models: Object.fromEntries(Object.entries(kept.models).filter(([, m]) => !m.gone_since)) };
    for (const f of check({ lab, kept, fresh: described, registry: Object.values(registry[lab] ?? {}), facts, today: kept.read }).findings) found.push([lab, f.kind, f.id ?? null]);
  }
  assert.deepEqual(found, STANDING);
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/pantheon-vendor-docs.mjs");
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test("THE COMMAND, from a capture already taken: a model the lab now describes is reported as released, one it dropped as gone, it exits 2, and it writes nothing unless told to", t => {
  const store = mkdtempSync(join(tmpdir(), "vendor-docs-cli-")); t.after(() => rmSync(store, { recursive: true, force: true }));
  const url = "https://docs.x.ai/developers/models/grok-9.md", digest = "0".repeat(64);
  mkdirSync(join(store, "xai", "blobs"), { recursive: true });
  writeFileSync(join(store, "xai", "blobs", digest), XAI);
  writeFileSync(join(store, "xai", "manifest.json"), JSON.stringify({ lab: "xai", read: "2026-12-24T08:00:00.000Z", pages: [{ url, status: "captured", sha256: digest }] }));
  const kept = join(CONFIG, "vendor-catalog", "xai.json"), before = readFileSync(kept, "utf8");
  const r = cli("models", "--offline", "--lab", "xai", "--store", store, "--max-age", "3650");
  assert.equal(r.code, 2, r.err);
  assert.match(r.out, /^xai: 1 models described \(read 2026-12-24T08:00:00\.000Z\); 0 registered here, 1 not;/m);
  assert.match(r.out, /^  released grok-9: Grok 9: described at https:\/\/docs\.x\.ai\/developers\/models\/grok-9\.md$/m);
  assert.match(r.out, /^  gone grok-4\.7: no longer described/m);
  assert.match(r.out, /^  registered-not-published grok-4\.7: /m);
  assert.equal(readFileSync(kept, "utf8"), before, "the kept catalogue is not written without --write");
  const none = cli("models", "--offline", "--lab", "google", "--store", store);
  assert.deepEqual([none.code, none.err.trim()], [1, `google: VENDOR_NOT_CAPTURED: nothing was captured in ${store} (run without --offline)`]);
  // The captured pages are at hand without the network: found by their words, printed by their address.
  const found = cli("find", "xai", "--store", store, "grok-9", "pricing");
  assert.deepEqual([found.code, found.out, found.err.trim()], [2, "", "0 page(s) of xai, read 2026-12-24T08:00:00.000Z"], "every word must be found: the search reads the index's words, not the page's text");
  const byAddress = cli("find", "xai", "--store", store, "MODELS/GROK-9");
  assert.deepEqual([byAddress.code, byAddress.out, byAddress.err.trim()], [0, `${url}\n    \n`, "1 page(s) of xai, read 2026-12-24T08:00:00.000Z"]);
  const shown = cli("show", "xai", url, "--store", store);
  assert.deepEqual([shown.code, shown.out], [0, XAI]);
  const absent = cli("show", "xai", "https://docs.x.ai/developers/models/never.md", "--store", store);
  assert.deepEqual([absent.code, absent.out, absent.err.trim()], [1, "", "show needs one address of a captured page of xai (find lists them)"]);
  assert.deepEqual(cli("find", "--store", store, "grok").code, 1, "a search names its lab");
  const bad = cli("models", "--lab", "nowhere");
  assert.deepEqual([bad.code, bad.err.trim()], [1, "unknown lab nowhere (known: openai, xai, google, anthropic)"]);
});
