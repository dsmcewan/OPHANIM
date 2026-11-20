// The captured documentation served over MCP: an agent can list what is held, find a page, read it, search the pages'
// text, and look a model up, all read-only and all from what was captured. Nothing a caller sends reaches the filesystem
// except through the manifest, and every answer says when its source was read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createVendorDocsServer } from "../src/mcp/vendor-docs-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = s => createHash("sha256").update(s).digest("hex");
const PAGES = [
  { url: "https://docs.alpha.test/guides/reasoning.md", title: "Reasoning", section: "Guides", description: "Control how much the model thinks.", body: "# Reasoning\n\nRaise the effort for hard problems. Lower it for simple lookups.\n" },
  { url: "https://docs.alpha.test/guides/tools.md", title: "Tools", section: "Guides", description: "Give the model functions to call.", body: "# Tools\n\n" + "Describe each tool as you would to a new colleague. ".repeat(40) + "\nThe END of the page.\n" },
  { url: "https://docs.alpha.test/posts/harness", title: "Harness design | Alpha", section: "Posts", description: null, body: "<!doctype html><html><head><title>Harness design | Alpha</title><script>x('Raise the effort')</script></head><body><h1>Harness design</h1><p>Checkpoint long work &amp; hand off cleanly.</p></body></html>" },
  { url: "https://docs.alpha.test/guides/lost.md", title: "Lost", section: "Guides", description: null, status: "failed", why: "HTTP 500" },
];
function fixture(t) {
  const store = mkdtempSync(join(tmpdir(), "vendor-docs-mcp-")); t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, "alpha", "blobs"), { recursive: true });
  const pages = PAGES.map(({ body, ...p }) => { if (body === undefined) return p; writeFileSync(join(store, "alpha", "blobs", sha(body)), body); return { ...p, status: "captured", sha256: sha(body), bytes: Buffer.byteLength(body) }; });
  pages.push({ url: "https://docs.alpha.test/guides/escape.md", title: "Escape", section: "Guides", description: null, status: "captured", sha256: "../../../../etc/passwd" });
  writeFileSync(join(store, "alpha", "manifest.json"), JSON.stringify({ lab: "alpha", read: "2026-11-20T08:00:00.000Z", pages, summary: { listed: pages.length, captured: 4 } }));
  const catalogues = { alpha: { lab: "alpha", read: "2026-11-20T08:00:00.000Z", models: {
    "alpha-2": { name: "Alpha 2", page: "https://docs.alpha.test/models/alpha-2.md", first_seen: "2026-11-20", aliases: ["alpha-latest"], facts: { context_window: { value: 1000000, quote: "1M context" }, efforts: { values: ["low", "high"], quote: "q" } } },
    "alpha-1": { name: "Alpha 1", page: "https://docs.alpha.test/models/alpha-1.md", first_seen: "2026-11-01", aliases: [], status: { value: "Deprecated", quote: "Status: Deprecated" }, facts: {} },
    "alpha-0": { name: "Alpha 0", page: "https://docs.alpha.test/models/alpha-0.md", first_seen: "2026-10-01", gone_since: "2026-11-20", aliases: [], facts: {} } } } };
  const reference = { labs: { alpha: { read: "2026-11-20T08:00:00.000Z", topics: { reasoning: [{ url: "https://docs.alpha.test/guides/reasoning.md", title: "Reasoning", description: "Control how much the model thinks.", sha256: "x" }], batch: [] } } } };
  return createVendorDocsServer({ store, labs: ["alpha", "beta"], catalogue: lab => catalogues[lab] ?? null, reference, topics: [{ id: "reasoning", title: "Reasoning control", what: "How much the model thinks." }, { id: "batch", title: "Batch", what: "Later, cheaper." }], registry: { alpha: { two: "alpha-latest" } } });
}
const call = async (s, name, args = {}) => { const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); return { error: r.result.isError === true, text: r.result.content[0].text, data: (() => { try { return JSON.parse(r.result.content[0].text); } catch { return null; } })() }; };

test("the server introduces itself and offers only reading tools, each with a closed set of arguments", async t => {
  const s = fixture(t);
  const init = await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ["2025-06-18", "pantheon-vendor-docs"]);
  const tools = (await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools;
  assert.deepEqual(tools.map(x => x.name), ["list_labs", "find_pages", "search_text", "read_page", "list_models", "get_model", "topics"]);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} takes only the arguments it names`);
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "a notification is never answered");
  assert.equal((await s.handle({ jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601);
});

test("WHAT IS HELD: each lab with the day it was read and its page counts; a lab not captured here says so instead of looking empty", async t => {
  const { data } = await call(fixture(t), "list_labs");
  assert.deepEqual(data.labs, [
    { lab: "alpha", captured: true, read: "2026-11-20T08:00:00.000Z", pages: { listed: 5, captured: 4 }, sections: [{ section: "Guides", pages: 4 }, { section: "Posts", pages: 1 }], models: 3 },
    { lab: "beta", captured: false, why: "no capture of this lab is in the store: run `pantheon-vendor-docs capture --lab beta`" },
  ]);
});

test("FINDING A PAGE by the index's words, and SEARCHING the pages' own text: a web page is searched as its words, and each hit carries its place", async t => {
  const s = fixture(t);
  const found = await call(s, "find_pages", { lab: "alpha", words: ["guides", "THINKS"] });
  assert.deepEqual(found.data.pages, [{ url: "https://docs.alpha.test/guides/reasoning.md", title: "Reasoning", section: "Guides", description: "Control how much the model thinks." }]);
  assert.deepEqual((await call(s, "find_pages", { lab: "alpha", words: ["lost"] })).data.pages, [], "a page that was not captured is not offered");
  const hits = (await call(s, "search_text", { lab: "alpha", phrase: "raise the EFFORT" })).data;
  assert.deepEqual(hits.hits.map(h => [h.url, h.excerpt]), [["https://docs.alpha.test/guides/reasoning.md", "# Reasoning Raise the effort for hard problems. Lower it for simple lookups."]],
    "the phrase inside a web page's script is not the page's words");
  assert.deepEqual([hits.read, hits.searched, hits.more], ["2026-11-20T08:00:00.000Z", 3, false]);
  const many = (await call(s, "search_text", { lab: "alpha", phrase: "colleague", limit: 1 })).data;
  assert.deepEqual([many.hits.length, many.more], [1, false], "one hit is given for a page however often the phrase is in it");
  const bounded = (await call(s, "search_text", { lab: "alpha", phrase: "THE", limit: 1 })).data;
  assert.deepEqual([bounded.hits.map(h => h.url), bounded.more], [["https://docs.alpha.test/guides/reasoning.md"], true], "past the limit the answer says there is more, and gives no more");
  const amp = (await call(s, "search_text", { lab: "alpha", phrase: "work & hand off" })).data;
  assert.deepEqual(amp.hits.map(h => h.url), ["https://docs.alpha.test/posts/harness"]);
  assert.equal((await call(s, "search_text", { lab: "alpha", phrase: "ab" })).error, true, "a phrase too short to mean anything is refused");
});

test("READING A PAGE: the lab's text with the day it was read; a long page comes in parts that join exactly; a web page comes as its words unless asked raw", async t => {
  const s = fixture(t);
  const short = (await call(s, "read_page", { lab: "alpha", url: PAGES[0].url })).data;
  assert.deepEqual(short, { lab: "alpha", url: PAGES[0].url, title: "Reasoning", read: "2026-11-20T08:00:00.000Z", sha256: sha(PAGES[0].body), chars: PAGES[0].body.length, offset: 0, text: PAGES[0].body, next_offset: null });
  let text = "", offset = 0, parts = 0;
  while (offset !== null) { const part = (await call(s, "read_page", { lab: "alpha", url: PAGES[1].url, offset, max_chars: 700 })).data; text += part.text; offset = part.next_offset; parts++; assert.ok(part.text.length <= 700); }
  assert.deepEqual([text === PAGES[1].body, parts], [true, Math.ceil(PAGES[1].body.length / 700)]);
  const web = (await call(s, "read_page", { lab: "alpha", url: PAGES[2].url })).data;
  assert.equal(web.text, "Harness design | Alpha\nHarness design\nCheckpoint long work & hand off cleanly.\n");
  assert.equal((await call(s, "read_page", { lab: "alpha", url: PAGES[2].url, raw: true })).data.text, PAGES[2].body);
});

test("NOTHING A CALLER SENDS REACHES THE FILESYSTEM EXCEPT THROUGH THE MANIFEST: an unknown lab, an unlisted address, a page not captured and a manifest entry that points outside the store are each refused by name", async t => {
  const s = fixture(t);
  const refused = async args => { const r = await call(s, "read_page", args); return [r.error, r.text]; };
  assert.deepEqual(await refused({ lab: "../alpha", url: PAGES[0].url }), [true, "unknown lab \"../alpha\" (known: alpha, beta)"]);
  assert.deepEqual(await refused({ lab: "alpha", url: "../../../../etc/passwd" }), [true, "no captured page of alpha at that address (find_pages lists them)"]);
  assert.deepEqual(await refused({ lab: "alpha", url: "https://docs.alpha.test/guides/lost.md" }), [true, "no captured page of alpha at that address (find_pages lists them)"]);
  assert.deepEqual(await refused({ lab: "alpha", url: "https://docs.alpha.test/guides/escape.md" }), [true, "no captured page of alpha at that address (find_pages lists them)"]);
  assert.deepEqual(await refused({ lab: "beta", url: PAGES[0].url }), [true, "no capture of beta is in the store: run `pantheon-vendor-docs capture --lab beta`"]);
  const extra = await s.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read_page", arguments: { lab: "alpha", url: PAGES[0].url, path: "/etc/passwd" } } });
  assert.deepEqual([extra.result.isError, extra.result.content[0].text], [true, "read_page does not take \"path\""]);
  assert.equal((await call(s, "write_page", {})).text, "unknown tool \"write_page\". Available: list_labs, find_pages, search_text, read_page, list_models, get_model, topics.");
});

test("MODELS FROM THE KEPT CATALOGUE: the current ones by default, each saying whether it is registered here; a model is found by an alias; an ended or gone one is given only when asked for", async t => {
  const s = fixture(t);
  const current = (await call(s, "list_models", { lab: "alpha" })).data;
  assert.deepEqual([current.read, current.models], ["2026-11-20T08:00:00.000Z", [{ id: "alpha-2", name: "Alpha 2", status: null, context_window: 1000000, max_output: null, reasoning_levels: ["low", "high"], registered_here: true }]]);
  assert.deepEqual((await call(s, "list_models", { lab: "alpha", include_ended: true })).data.models.map(m => [m.id, m.status, m.registered_here]),
    [["alpha-0", "gone since 2026-11-20", false], ["alpha-1", "Deprecated", false], ["alpha-2", null, true]]);
  const byAlias = (await call(s, "get_model", { lab: "alpha", id: "alpha-latest" })).data;
  assert.deepEqual([byAlias.id, byAlias.asked_for, byAlias.record.facts.context_window, byAlias.registered_here], ["alpha-2", "alpha-latest", { value: 1000000, quote: "1M context" }, true]);
  assert.deepEqual((await call(s, "get_model", { lab: "alpha", id: "alpha-9" })).text, "the catalogue of alpha describes no model or alias \"alpha-9\"");
  assert.equal((await call(s, "list_models", { lab: "beta" })).text, "no catalogue of beta is kept");
});

test("THE CROSS-LAB REFERENCE: for a topic, each lab's pages with the lab's own words, and a lab with none says none", async t => {
  const s = fixture(t);
  const all = (await call(s, "topics")).data;
  assert.deepEqual(all.topics.map(x => [x.id, x.title]), [["reasoning", "Reasoning control"], ["batch", "Batch"]]);
  const one = (await call(s, "topics", { topic: "reasoning" })).data;
  assert.deepEqual(one, { topic: "reasoning", title: "Reasoning control", what: "How much the model thinks.", labs: { alpha: { read: "2026-11-20T08:00:00.000Z", pages: [{ url: "https://docs.alpha.test/guides/reasoning.md", title: "Reasoning", description: "Control how much the model thinks." }] } } });
  assert.deepEqual((await call(s, "topics", { topic: "batch" })).data.labs, { alpha: { read: "2026-11-20T08:00:00.000Z", pages: [] } });
  assert.equal((await call(s, "topics", { topic: "nope" })).text, "unknown topic \"nope\" (known: reasoning, batch)");
});

test("OVER STDIO: one JSON answer per request line and nothing else on standard output", async () => {
  const child = spawn(process.execPath, [join(HERE, "../bin/pantheon-vendor-docs-mcp.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write("not json\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_labs", arguments: {} } }) + "\n");
  child.stdin.end();
  const code = await new Promise(resolve => child.on("close", resolve));
  const lines = out.split("\n").filter(Boolean).map(l => JSON.parse(l));
  // Answers are matched by id: a request that is answered at once may be written before one that was read first.
  const byId = id => lines.find(l => l.id === id);
  assert.deepEqual([code, lines.map(l => l.id).sort(), byId(null).error.code, byId(1).result.serverInfo.name], [0, [1, 2, null], -32700, "pantheon-vendor-docs"]);
  assert.deepEqual(JSON.parse(byId(2).result.content[0].text).labs.map(l => l.lab), ["openai", "xai", "google", "anthropic"]);
});
