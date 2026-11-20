// The reference across labs: for each capability, the page of each lab's own documentation that describes it, with the
// lab's own title and description; and the written page generated from it. A person chooses which page answers a topic;
// everything else is read from the capture, and a chosen page that is gone or has changed since it was read is reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reference, referenceChanges, render, find } from "../src/vendor-docs/reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "../src/config"), DOC = join(HERE, "../../docs/vendor-labs.md");
const json = f => JSON.parse(readFileSync(f, "utf8"));

const page = (url, title, section, description, sha256, status = "captured") => ({ url, title, section, description, status, ...(status === "captured" ? { sha256 } : { why: "HTTP 500" }) });
const MANIFESTS = {
  alpha: { lab: "alpha", read: "2026-11-20T08:00:00.000Z", indexes: [{ url: "https://docs.alpha.test/llms.txt", status: "captured", sha256: "i1" }],
    summary: { listed: 4, captured: 3, skipped: 0, refused: 0, failed: 1 }, pages: [
      page("https://docs.alpha.test/guides/reasoning.md", "Reasoning", "Guides", "Control how much the model thinks.", "a1"),
      page("https://docs.alpha.test/reference/create.md", "Create a response", "Reference", null, "a2"),
      page("https://docs.alpha.test/guides/batch.md", "Batch | jobs", "Guides", "Send many requests.", "a3"),
      page("https://docs.alpha.test/guides/lost.md", "Lost", "Guides", null, null, "failed"),
    ] },
  beta: { lab: "beta", read: "2026-11-21T08:00:00.000Z", indexes: [{ url: "https://docs.beta.test/llms.txt", status: "captured", sha256: "i2" }],
    summary: { listed: 1, captured: 1, skipped: 0, refused: 0, failed: 0 }, pages: [
      page("https://docs.beta.test/thinking.md", "Thinking", null, "Thinking levels.", "b1"),
    ] },
};
const TOPICS = { topics: [{ id: "generate", title: "Generating a response", what: "The method a request is made with." }, { id: "reasoning", title: "Reasoning control", what: "How much the model thinks." }],
  pages: { alpha: { generate: ["https://docs.alpha.test/reference/create.md"], reasoning: ["https://docs.alpha.test/guides/reasoning.md", "https://docs.alpha.test/guides/lost.md", "https://docs.alpha.test/guides/never-listed.md"] },
    beta: { generate: [], reasoning: ["https://docs.beta.test/thinking.md"] } } };

test("EACH TOPIC'S PAGES CARRY THE LAB'S OWN WORDS: title, description and digest are read from the capture, and each lab's sections are counted", () => {
  const r = reference({ topics: TOPICS, manifests: MANIFESTS });
  assert.deepEqual(r.labs.alpha.topics.reasoning, [{ url: "https://docs.alpha.test/guides/reasoning.md", title: "Reasoning", description: "Control how much the model thinks.", sha256: "a1" }]);
  assert.deepEqual(r.labs.alpha.topics.generate, [{ url: "https://docs.alpha.test/reference/create.md", title: "Create a response", description: null, sha256: "a2" }]);
  assert.deepEqual([r.labs.beta.topics.generate, r.labs.beta.topics.reasoning.map(p => p.sha256)], [[], ["b1"]]);
  assert.deepEqual([r.labs.alpha.read, r.labs.alpha.pages, r.labs.alpha.sections, r.labs.alpha.indexes], ["2026-11-20T08:00:00.000Z", { listed: 4, captured: 3 },
    [{ section: "Guides", pages: 3 }, { section: "Reference", pages: 1 }], [{ url: "https://docs.alpha.test/llms.txt", sha256: "i1" }]]);
  assert.deepEqual(r.labs.beta.sections, [{ section: "(no section)", pages: 1 }]);
  assert.equal(r.schema, "pantheon.vendor-reference/v1");
});

test("A CHOSEN PAGE THAT IS NOT IN THE CAPTURE IS A PROBLEM, named with why: it is left out of the topic and never shown as if it were read", () => {
  const r = reference({ topics: TOPICS, manifests: MANIFESTS });
  assert.deepEqual(r.problems, [
    { lab: "alpha", topic: "reasoning", url: "https://docs.alpha.test/guides/lost.md", why: "listed by the lab and not captured (HTTP 500)" },
    { lab: "alpha", topic: "reasoning", url: "https://docs.alpha.test/guides/never-listed.md", why: "not in the lab's documentation as captured" },
  ]);
  assert.throws(() => reference({ topics: TOPICS, manifests: { alpha: MANIFESTS.alpha } }), { code: "VENDOR_NOT_CAPTURED", message: /beta/ });
});

test("A TOPIC PAGE THAT CHANGED SINCE IT WAS READ IS REPORTED, so what was concluded from it is read again; an unchanged one is not", () => {
  const kept = reference({ topics: TOPICS, manifests: MANIFESTS });
  const later = structuredClone(MANIFESTS);
  later.alpha.pages[0].sha256 = "a1-rewritten";
  const fresh = reference({ topics: TOPICS, manifests: later });
  assert.deepEqual(referenceChanges(kept, fresh), [{ lab: "alpha", topic: "reasoning", url: "https://docs.alpha.test/guides/reasoning.md", why: "changed since it was read 2026-11-20" }]);
  assert.deepEqual([referenceChanges(kept, kept), referenceChanges(null, fresh)], [[], []]);
});

const CATALOGUES = { alpha: { lab: "alpha", read: "2026-11-20T08:00:00.000Z", models: {
  "alpha-2": { name: "Alpha 2", page: "https://docs.alpha.test/models/alpha-2.md", first_seen: "2026-11-20", aliases: ["alpha-latest"], facts: { context_window: { value: 1050000 }, max_output: { value: 128000 }, efforts: { values: ["low", "high"] }, effort_default: { value: "high" } } },
  "alpha-1": { name: "Alpha 1", page: "https://docs.alpha.test/models/alpha-1.md", first_seen: "2026-11-20", aliases: [], status: { value: "Deprecated" }, facts: {} },
  "alpha-0": { name: "Alpha 0", page: "https://docs.alpha.test/models/alpha-0.md", first_seen: "2026-11-01", gone_since: "2026-11-20", aliases: [], facts: {} },
  "alpha-mini": { name: "Alpha Mini", page: "https://docs.alpha.test/models/alpha-mini.md", first_seen: "2026-11-20", aliases: [], status: { value: "Legacy" }, facts: { context_window: { value: 200000 } } },
} }, beta: { lab: "beta", read: "2026-11-21T08:00:00.000Z", models: {} } };

test("THE WRITTEN PAGE: each topic lists every lab with its page and the lab's description, an empty topic says so, and models are listed with what their pages state", () => {
  const md = render({ reference: reference({ topics: TOPICS, manifests: MANIFESTS }), topics: TOPICS, catalogues: CATALOGUES, registry: { alpha: { two: "alpha-latest" }, beta: {} } });
  assert.match(md, /^# The labs' own documentation: methods, functionality and models$/m);
  assert.match(md, /^### Reasoning control\n\nHow much the model thinks\.\n\n\| Lab \| Page \| The lab's description \|\n\|---\|---\|---\|\n\| alpha \| \[Reasoning\]\(https:\/\/docs\.alpha\.test\/guides\/reasoning\.md\) \| Control how much the model thinks\. \|\n\| beta \| \[Thinking\]\(https:\/\/docs\.beta\.test\/thinking\.md\) \| Thinking levels\. \|$/m);
  assert.match(md, /^\| alpha \| \[Create a response\]\(https:\/\/docs\.alpha\.test\/reference\/create\.md\) \|  \|\n\| beta \| no page of this lab's index was found for this topic \|  \|$/m);
  assert.match(md, /^\| alpha \| 2026-11-20 \| 4 \| 3 \| Guides \(3\), Reference \(1\) \|$/m);
  assert.match(md, /^### alpha: 2 described and current, 1 the lab calls ended, 1 no longer described$/m);
  assert.match(md, /^\| `alpha-2` \| 1,050,000 \| 128,000 \| low, high \(default high\) \|  \| yes \|$/m);
  assert.match(md, /^\| `alpha-mini` \| 200,000 \|  \|  \| Legacy \|  \|$/m);
  assert.doesNotMatch(md, /`alpha-1`|`alpha-0`/, "a model the lab calls ended, or no longer describes, is counted and not listed");
  assert.match(md, /^### beta: 0 described and current, 0 the lab calls ended, 0 no longer described$/m);
  assert.equal(render({ reference: reference({ topics: TOPICS, manifests: MANIFESTS }), topics: TOPICS, catalogues: CATALOGUES, registry: { alpha: { two: "alpha-latest" }, beta: {} } }), md, "the same inputs give the same page");
});

test("a title or description that holds a table bar or a line break cannot break the table it is written into", () => {
  const md = render({ reference: reference({ topics: { topics: [{ id: "batch", title: "Batch", what: "w" }], pages: { alpha: { batch: ["https://docs.alpha.test/guides/batch.md"] }, beta: { batch: [] } } }, manifests: MANIFESTS }),
    topics: { topics: [{ id: "batch", title: "Batch", what: "w" }] }, catalogues: CATALOGUES, registry: {} });
  assert.match(md, /^\| alpha \| \[Batch \\\| jobs\]\(https:\/\/docs\.alpha\.test\/guides\/batch\.md\) \| Send many requests\. \|$/m);
});

test("FINDING A PAGE: every word must be in the title, description, section or address; only captured pages are offered", () => {
  const hits = (...words) => find({ manifest: MANIFESTS.alpha, words }).map(p => p.url.split("/").pop());
  assert.deepEqual([hits("reasoning"), hits("GUIDES", "send"), hits("create", "response"), hits("lost"), hits("reasoning", "batch")], [["reasoning.md"], ["batch.md"], ["create.md"], [], []]);
  assert.deepEqual(hits(), [], "no word is no search, not every page");
});

test("THE PAGE IN THE REPOSITORY IS THE ONE THE KEPT DATA GENERATES: docs/vendor-labs.md is not edited by hand", { skip: !existsSync(join(CONFIG, "vendor-reference.json")) && "no reference is kept yet" }, () => {
  const labs = Object.keys(json(join(CONFIG, "vendor-docs.json")).labs);
  const catalogues = Object.fromEntries(labs.map(lab => [lab, json(join(CONFIG, "vendor-catalog", `${lab}.json`))]));
  const kept = json(join(CONFIG, "vendor-reference.json")), topics = json(join(CONFIG, "vendor-topics.json"));
  assert.equal(readFileSync(DOC, "utf8"), render({ reference: kept, topics, catalogues, registry: json(join(CONFIG, "models.json")) }));
  assert.deepEqual(kept.problems, [], "every chosen page was captured when the reference was kept");
  assert.deepEqual(Object.keys(kept.labs), labs);
  for (const lab of labs) assert.deepEqual(Object.keys(kept.labs[lab].topics), topics.topics.map(t => t.id), `${lab}: every topic is answered or says it is not`);
});

test("the Context7 library ids kept for lookups name every lab, and each is an id of the form Context7 uses", () => {
  const c7 = json(join(CONFIG, "vendor-context7.json")), labs = Object.keys(json(join(CONFIG, "vendor-docs.json")).labs);
  assert.deepEqual(Object.keys(c7.libraries), labs);
  for (const lab of labs) {
    assert.ok(c7.libraries[lab].length > 0, `${lab}: no library`);
    for (const l of c7.libraries[lab]) { assert.match(l.id, /^\/[\w.-]+\/[\w.-]+$/, `${lab}: ${l.id}`); assert.ok(l.what.length > 0, `${lab} ${l.id}: says what it is`); }
  }
  assert.match(c7.read, /^\d{4}-\d{2}-\d{2}$/);
});
