// Capturing a lab's documentation: every page its own index lists is read and kept, used by this repository or not; what is
// not read is recorded with the reason; and nothing but a public page is ever asked for (no key, no other host).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIndex, captureLab, changes, readPage, CLIENT } from "../src/vendor-docs/capture.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
const LAB = { hosts: ["docs.lab.test"], indexes: ["https://docs.lab.test/llms.txt"] };
const NOW = () => "2026-11-20T08:00:00.000Z";

const ROOT = `# Lab documentation

> Every page is available as markdown.

## Documentation sets
- [API guides](https://docs.lab.test/api/llms.txt): Guides and reference.
- [Product help](https://help.elsewhere.test/llms.txt): Another site.

## Optional
- [Everything in one file](https://docs.lab.test/llms-full.txt): Single-file export.
`;
const API = `# API

## Models
- [Model One](https://docs.lab.test/models/one.md): The first model.
- [Model Two](/models/two.md) - The second model.

## Reference
- [Create a response](https://docs.lab.test/reference/create.md)
- [Moved page](https://docs.lab.test/reference/moved.md): Redirects inside the site.
- [Signed-in page](https://docs.lab.test/reference/private.md): Redirects to a sign-in host.
- [Broken page](https://docs.lab.test/reference/broken.md)
`;
const PAGES = {
  "https://docs.lab.test/llms.txt": { body: ROOT, type: "text/plain" },
  "https://docs.lab.test/api/llms.txt": { body: API, type: "text/plain" },
  "https://docs.lab.test/models/one.md": { body: "# Model One\n\nModel ID: `lab-one`\n", type: "text/markdown" },
  "https://docs.lab.test/models/two.md": { body: "# Model Two\n\nModel ID: `lab-two`\n", type: "text/markdown" },
  "https://docs.lab.test/reference/create.md": { body: "# Create a response\n\nPOST /v1/responses\n", type: "text/markdown" },
  "https://docs.lab.test/reference/moved.md": { status: 301, location: "/reference/new-home.md" },
  "https://docs.lab.test/reference/new-home.md": { body: "# New home\n", type: "text/markdown" },
  "https://docs.lab.test/reference/private.md": { status: 302, location: "https://accounts.elsewhere.test/signin" },
  "https://docs.lab.test/reference/broken.md": { status: 500, body: "upstream error" },
};

/** A scripted site. Every request is recorded with the headers it carried. */
function site(pages = PAGES) {
  const asked = [];
  const fetch = async (url, init = {}) => {
    asked.push({ url: String(url), headers: { ...(init.headers ?? {}) }, redirect: init.redirect, method: init.method ?? "GET" });
    const p = pages[String(url)];
    if (!p) return new Response("not found", { status: 404 });
    const headers = { "content-type": p.type ?? "text/plain" };
    if (p.location) headers.location = p.location;
    return new Response(p.status && p.status >= 300 && p.status < 400 ? null : p.body ?? "", { status: p.status ?? 200, headers });
  };
  return { fetch, asked };
}
const store = t => { const d = mkdtempSync(join(tmpdir(), "vendor-docs-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const run = (t, over = {}) => { const s = site(over.pages); const dir = store(t); return captureLab({ lab: "lab", def: LAB, store: dir, fetch: s.fetch, now: NOW, sleep: async () => {}, ...over.options }).then(manifest => ({ manifest, dir, asked: s.asked })); };
const byUrl = (manifest, url) => manifest.pages.find(p => p.url === url);

test("an index is read as sections of titled links, with relative links resolved and both description styles kept", () => {
  const entries = parseIndex(API, "https://docs.lab.test/api/llms.txt");
  assert.deepEqual(entries.map(e => [e.section, e.title, e.url, e.description]), [
    ["Models", "Model One", "https://docs.lab.test/models/one.md", "The first model."],
    ["Models", "Model Two", "https://docs.lab.test/models/two.md", "The second model."],
    ["Reference", "Create a response", "https://docs.lab.test/reference/create.md", null],
    ["Reference", "Moved page", "https://docs.lab.test/reference/moved.md", "Redirects inside the site."],
    ["Reference", "Signed-in page", "https://docs.lab.test/reference/private.md", "Redirects to a sign-in host."],
    ["Reference", "Broken page", "https://docs.lab.test/reference/broken.md", null],
  ]);
});

test("EVERY PAGE THE LAB LISTS IS CAPTURED: nested indexes are followed and each page is kept with its digest, section and time read", async t => {
  const { manifest, dir } = await run(t);
  const one = byUrl(manifest, "https://docs.lab.test/models/one.md");
  assert.deepEqual(
    { title: one.title, section: one.section, description: one.description, status: one.status, sha256: one.sha256, bytes: one.bytes, read: one.read, via: one.index },
    { title: "Model One", section: "Models", description: "The first model.", status: "captured", sha256: sha(PAGES[one.url].body), bytes: Buffer.byteLength(PAGES[one.url].body), read: NOW(), via: "https://docs.lab.test/api/llms.txt" });
  assert.equal(readFileSync(join(dir, "lab", "blobs", one.sha256), "utf8"), PAGES[one.url].body, "the page's own bytes are kept under its digest");
  assert.equal(readPage({ store: dir, lab: "lab", url: one.url }), PAGES[one.url].body);
  assert.deepEqual(manifest.pages.filter(p => p.status === "captured").map(p => p.url).sort(), [
    "https://docs.lab.test/models/one.md", "https://docs.lab.test/models/two.md",
    "https://docs.lab.test/reference/create.md", "https://docs.lab.test/reference/moved.md"]);
  assert.deepEqual(manifest.indexes.map(i => [i.url, i.sha256]), [
    ["https://docs.lab.test/llms.txt", sha(ROOT)], ["https://docs.lab.test/api/llms.txt", sha(API)]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "lab", "manifest.json"), "utf8")), manifest, "the manifest on disk is the one returned");
  assert.deepEqual(manifest.summary, { listed: 8, captured: 4, skipped: 2, refused: 1, failed: 1 });
});

test("WHAT IS NOT READ IS RECORDED WITH THE REASON, and is never asked for: another host, and a single-file export", async t => {
  const { manifest, asked } = await run(t);
  const outside = byUrl(manifest, "https://help.elsewhere.test/llms.txt");
  const whole = byUrl(manifest, "https://docs.lab.test/llms-full.txt");
  assert.deepEqual([outside.status, outside.why], ["skipped", "outside the lab's documentation hosts (docs.lab.test)"]);
  assert.deepEqual([whole.status, whole.why], ["skipped", "a single-file export of pages that are listed one by one"]);
  assert.deepEqual(asked.filter(a => !a.url.startsWith("https://docs.lab.test/")), [], "no request left the lab's documentation hosts");
  assert.equal(asked.some(a => a.url.endsWith("llms-full.txt")), false);
});

test("A REDIRECT IS FOLLOWED ONLY INSIDE THE LAB'S HOSTS: a sign-in page on another host is refused and nothing of it is kept", async t => {
  const { manifest, asked, dir } = await run(t);
  const moved = byUrl(manifest, "https://docs.lab.test/reference/moved.md");
  assert.deepEqual([moved.status, moved.final, moved.sha256], ["captured", "https://docs.lab.test/reference/new-home.md", sha("# New home\n")]);
  const priv = byUrl(manifest, "https://docs.lab.test/reference/private.md");
  assert.deepEqual([priv.status, priv.why, priv.sha256 ?? null], ["refused", "redirects to accounts.elsewhere.test, outside the lab's documentation hosts", null]);
  assert.equal(asked.some(a => a.url.includes("accounts.elsewhere.test")), false, "the other host was never asked");
  assert.equal(asked.every(a => a.redirect === "manual"), true, "no request lets the runtime follow a redirect by itself");
  assert.equal(existsSync(join(dir, "lab", "blobs", sha(""))), false);
});

test("NO KEY IS EVER SENT: each request carries the client's name and what it accepts, whatever keys the process holds", async t => {
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY"]) { const had = process.env[k]; process.env[k] = "not-a-real-key"; t.after(() => { if (had === undefined) delete process.env[k]; else process.env[k] = had; }); }
  const { asked } = await run(t);
  assert.ok(asked.length >= 8, "the capture made its requests");
  for (const a of asked) {
    assert.deepEqual(Object.keys(a.headers).map(h => h.toLowerCase()).sort(), ["accept", "user-agent"], `${a.url} carried other headers`);
    assert.deepEqual([a.headers["user-agent"], a.headers.accept], [CLIENT, "*/*"]);
    assert.equal(a.method, "GET");
  }
  assert.doesNotMatch(CLIENT, /ophanim|pantheon/i, "the client name says nothing about this project");
});

test("A PAGE THAT FAILS IS RECORDED AND THE REST IS STILL CAPTURED: it is asked again a bounded number of times first", async t => {
  const { manifest, asked } = await run(t, { options: { retries: 2 } });
  const broken = byUrl(manifest, "https://docs.lab.test/reference/broken.md");
  assert.deepEqual([broken.status, broken.why, broken.sha256 ?? null], ["failed", "HTTP 500", null]);
  assert.equal(asked.filter(a => a.url === broken.url).length, 3, "one attempt and two retries");
  assert.equal(byUrl(manifest, "https://docs.lab.test/reference/create.md").status, "captured");
});

test("a lab whose index cannot be read is an error, not an empty capture, and the last good manifest is left in place", async t => {
  const dir = store(t);
  const good = site();
  const first = await captureLab({ lab: "lab", def: LAB, store: dir, fetch: good.fetch, now: NOW, sleep: async () => {} });
  const down = site({});
  await assert.rejects(captureLab({ lab: "lab", def: LAB, store: dir, fetch: down.fetch, now: NOW, sleep: async () => {} }),
    { code: "VENDOR_INDEX_UNREADABLE", message: /https:\/\/docs\.lab\.test\/llms\.txt: HTTP 404/ });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "lab", "manifest.json"), "utf8")), first);
});

test("WHAT CHANGED SINCE THE LAST CAPTURE: pages added, removed and changed are named, and an unchanged page is not", async t => {
  const dir = store(t);
  const before = await captureLab({ lab: "lab", def: LAB, store: dir, fetch: site().fetch, now: NOW, sleep: async () => {} });
  const later = structuredClone(PAGES);
  later["https://docs.lab.test/api/llms.txt"].body = API.replace("- [Model Two](/models/two.md) - The second model.\n", "- [Model Three](/models/three.md): Released today.\n");
  later["https://docs.lab.test/models/three.md"] = { body: "# Model Three\n\nModel ID: `lab-three`\n", type: "text/markdown" };
  later["https://docs.lab.test/models/one.md"].body = "# Model One\n\nModel ID: `lab-one`\n\nDeprecated.\n";
  const after = await captureLab({ lab: "lab", def: LAB, store: dir, fetch: site(later).fetch, now: () => "2026-11-27T08:00:00.000Z", sleep: async () => {} });
  assert.deepEqual(changes(before, after), {
    added: ["https://docs.lab.test/models/three.md"],
    removed: ["https://docs.lab.test/models/two.md"],
    changed: ["https://docs.lab.test/models/one.md"],
  });
  assert.equal(readFileSync(join(dir, "lab", "blobs", sha("# Model Two\n\nModel ID: `lab-two`\n")), "utf8").startsWith("# Model Two"), true, "an earlier page's bytes stay readable by digest");
  assert.deepEqual(changes(after, after), { added: [], removed: [], changed: [] });
});

test("a page larger than the bound is recorded and not kept", async t => {
  const { manifest } = await run(t, { options: { maxBytes: 30 } });
  const one = byUrl(manifest, "https://docs.lab.test/models/one.md");
  assert.deepEqual([one.status, one.why], ["skipped", `larger than the bound of 30 bytes (${Buffer.byteLength(PAGES[one.url].body)})`]);
  assert.equal(byUrl(manifest, "https://docs.lab.test/reference/new-home.md") ?? null, null, "a redirect's target is not a listed page of its own");
});

test("MODEL PAGES THE INDEX DOES NOT LIST ARE FOUND FROM THE LAB'S MODEL LISTING: by its links and by the names in its tables", async t => {
  const listing = `# All models

[Compare](/models/compare.md) and [pricing](/pricing.md).

- [Model One](/models/one.md): listed in the index too.
- [Model Four](/models/four): a link without the markdown ending.
- [Model 4.5](/models/lab-4.5): a name with a dot in it is not a file ending.
- [Model Five](https://docs.lab.test/models/five.md#pricing)
- [Elsewhere](https://other.test/models/six.md)

| Model | Context |
| --- | --- |
| lab-seven (short prompts) | 1M |
| lab-seven (long prompts) | 1M |
| Speech (lab-voice-2) | n/a |
`;
  const pages = { ...PAGES,
    "https://docs.lab.test/api/llms.txt": { body: API + "- [All models](https://docs.lab.test/models/all.md)\n", type: "text/plain" },
    "https://docs.lab.test/models/all.md": { body: listing, type: "text/markdown" },
    "https://docs.lab.test/models/four.md": { body: "# Model Four\n", type: "text/markdown" },
    "https://docs.lab.test/models/five.md": { body: "# Model Five\n", type: "text/markdown" },
    "https://docs.lab.test/models/lab-4.5.md": { body: "# Model 4.5\n", type: "text/markdown" },
    "https://docs.lab.test/models/lab-seven.md": { body: "# Seven\n", type: "text/markdown" },
  };
  const def = { ...LAB, models: { listings: ["https://docs.lab.test/models/all.md"], link: "/models/(?!all\\.md$|compare\\.md$)[^/?#]+\\.md$",
    names: ["^\\|\\s*(lab-[a-z0-9-]+)", "\\((lab-[a-z0-9-]+)\\)"], page: "https://docs.lab.test/models/{name}.md" } };
  const s = site(pages), dir = store(t);
  const manifest = await captureLab({ lab: "lab", def, store: dir, fetch: s.fetch, now: NOW, sleep: async () => {}, retries: 0 });
  const derived = manifest.pages.filter(p => p.derived_from).map(p => [p.url, p.status, p.section, p.index, p.derived_from]);
  assert.deepEqual(derived, [
    ["https://docs.lab.test/models/five.md", "captured", "Models", null, "https://docs.lab.test/models/all.md"],
    ["https://docs.lab.test/models/four.md", "captured", "Models", null, "https://docs.lab.test/models/all.md"],
    ["https://docs.lab.test/models/lab-4.5.md", "captured", "Models", null, "https://docs.lab.test/models/all.md"],
    ["https://docs.lab.test/models/lab-seven.md", "captured", "Models", null, "https://docs.lab.test/models/all.md"],
    ["https://docs.lab.test/models/lab-voice-2.md", "failed", "Models", null, "https://docs.lab.test/models/all.md"],
  ]);
  assert.equal(byUrl(manifest, "https://docs.lab.test/models/one.md").index, "https://docs.lab.test/api/llms.txt", "a page the index lists keeps its listing");
  assert.equal(s.asked.some(a => a.url.includes("other.test") || a.url.endsWith("/pricing.md") || a.url.endsWith("/compare.md")), false, "only model pages on the lab's hosts are followed");
  assert.equal(s.asked.filter(a => a.url.endsWith("/models/lab-seven.md")).length, 1, "a name in two rows is one page");
});

test("a model listing that was not captured is an error: without it the lab's models cannot be enumerated", async t => {
  const def = { ...LAB, models: { listings: ["https://docs.lab.test/models/all.md"], link: "^https://docs\\.lab\\.test/models/[^/?#]+\\.md$" } };
  await assert.rejects(captureLab({ lab: "lab", def, store: store(t), fetch: site().fetch, now: NOW, sleep: async () => {}, retries: 0 }),
    { code: "VENDOR_LISTING_UNREADABLE", message: /https:\/\/docs\.lab\.test\/models\/all\.md/ });
});

// A lab's own documentation server (the MCP form): it lists the documents it holds and returns one by its address. It is
// asked at an address on the lab's documentation hosts, for pages the index does not list, some of them on other sites of
// the lab that are never asked directly.
const SERVER = "https://docs.lab.test/mcp";
const HELD = [
  { url: "https://docs.lab.test/models/one#limits", url_without_anchor: "https://docs.lab.test/models/one", hierarchy: { lvl0: "Documentation", lvl1: "Model One" } },
  { url: "https://help.lab.test/agent/config", url_without_anchor: "https://help.lab.test/agent/config", hierarchy: { lvl0: "Agent", lvl1: "Configuration reference" } },
  { url: "https://help.lab.test/agent/config#keys", url_without_anchor: "https://help.lab.test/agent/config", hierarchy: { lvl0: "Agent", lvl1: "Configuration reference" } },
  { url: "https://help.lab.test/agent", url_without_anchor: "https://help.lab.test/agent", hierarchy: { lvl0: "Agent", lvl1: "Agent" } },
  { url: "https://docs.lab.test/guides/unlisted", url_without_anchor: "https://docs.lab.test/guides/unlisted", hierarchy: { lvl0: "Documentation", lvl1: "A guide the index omits" } },
  { url: "https://videos.elsewhere.test/intro", url_without_anchor: "https://videos.elsewhere.test/intro", hierarchy: { lvl0: "Videos", lvl1: "Intro" } },
];
const BODIES = {
  "https://help.lab.test/agent/config": "# Configuration reference\n\nSee [advanced](/agent/advanced), ![a picture](/img/keys.png), [Model One](https://docs.lab.test/models/one) and [elsewhere](https://other.test/x).\n",
  "https://help.lab.test/agent/advanced": "# Advanced configuration\n\n[Deeper](https://help.lab.test/agent/deeper#section) and back to [the reference](/agent/config.md).\n",
  "https://help.lab.test/agent/deeper": "# Deeper\n\n[A page that is not there](/agent/gone)\n",
  "https://help.lab.test/agent/redirected": "# Where the old address went\n",
  "https://docs.lab.test/guides/unlisted": "# A guide the index omits\n\n[Another guide](https://docs.lab.test/guides/another) and [the agent](https://help.lab.test/agent/from-the-guide).\n",
};
function served({ pages = PAGES, held = HELD, perPage = 2, total = held.length, down = false } = {}) {
  const s = site(pages), posts = [];
  const answer = (id, result) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") !== "POST") return s.fetch(url, init);
    posts.push({ url: String(url), headers: { ...(init.headers ?? {}) }, redirect: init.redirect, body: JSON.parse(init.body) });
    if (down || String(url) !== SERVER) return new Response("no", { status: 503 });
    const { id, method, params } = JSON.parse(init.body);
    assert.equal(method, "tools/call");
    if (params.name === "list_docs") {
      const from = params.arguments.cursor ? Number(params.arguments.cursor) : 0, hits = held.slice(from, from + perPage);
      return answer(id, { content: [{ type: "text", text: JSON.stringify({ hits, nbHits: total, ...(from + perPage < held.length ? { nextCursor: String(from + perPage) } : {}) }) }] });
    }
    // The other labs' servers: one lists page names and returns a page by its name, one prints its navigation and
    // returns a page by its path.
    if (params.name === "list_names") return answer(id, { content: [{ type: "text", text: JSON.stringify(["models/one", "guides/unlisted", "guides/absent", 7]) }] });
    if (params.name === "navigation") return answer(id, { content: [{ type: "text", text: "## Guides\nDefault: /guides/unlisted\n\n### Start here\n- Model One: /models/one\n- A guide the index omits: /guides/unlisted\n\n### Later\n(not expanded)\n- Gone: /guides/absent\n" }] });
    const named = params.arguments.name ?? params.arguments.path;
    if (named !== undefined) {
      const text = BODIES[`https://docs.lab.test/${String(named).replace(/^\//, "")}`];
      return answer(id, text === undefined ? { isError: true, content: [{ type: "text", text: `No page ${named}` }] } : { content: [{ type: "text", text }] });
    }
    const body = BODIES[params.arguments.url];
    return answer(id, body === undefined ? { isError: true, content: [{ type: "text", text: `Failed to fetch ${params.arguments.url}.md: 404 Not Found\nmore detail` }] } : { content: [{ type: "text", text: body }] });
  };
  return { fetch, asked: s.asked, posts };
}
const WITH_SERVER = { ...LAB, server: { url: SERVER, list: "list_docs", fetch: "fetch_doc", hosts: ["docs.lab.test", "help.lab.test"] } };
const viaServer = (t, over = {}) => { const s = served(over); return captureLab({ lab: "lab", def: over.def ?? WITH_SERVER, store: store(t), fetch: s.fetch, now: NOW, sleep: async () => {}, retries: 0 }).then(manifest => ({ manifest, ...s })); };

test("THE LAB'S OWN DOCUMENTATION SERVER SUPPLIES WHAT ITS INDEX DOES NOT LIST: every document it holds is paged through, and each one not already captured is read through it", async t => {
  const { manifest, posts, asked } = await viaServer(t);
  const config = byUrl(manifest, "https://help.lab.test/agent/config");
  assert.deepEqual({ status: config.status, title: config.title, section: config.section, via: config.via, index: config.index, sha256: config.sha256, bytes: config.bytes },
    { status: "captured", title: "Configuration reference", section: "Agent", via: SERVER, index: null, sha256: sha(BODIES[config.url]), bytes: Buffer.byteLength(BODIES[config.url]) });
  assert.equal(byUrl(manifest, "https://docs.lab.test/guides/unlisted").status, "captured");
  assert.deepEqual(posts.filter(p => p.body.params.name === "list_docs").map(p => p.body.params.arguments), [{ limit: 50 }, { limit: 50, cursor: "2" }, { limit: 50, cursor: "4" }]);
  assert.deepEqual(posts.filter(p => p.body.params.name === "fetch_doc").map(p => p.body.params.arguments.url).sort(),
    ["https://docs.lab.test/guides/unlisted", "https://help.lab.test/agent", "https://help.lab.test/agent/advanced", "https://help.lab.test/agent/config", "https://help.lab.test/agent/deeper", "https://help.lab.test/agent/gone"],
    "a document the index already supplied is not read again, a document listed twice is read once, and one on a site that is not the lab's is not read");
  assert.equal(manifest.pages.filter(p => p.url.startsWith("https://docs.lab.test/models/one")).length, 1, "the same page under its markdown address and its plain one is one page");
  assert.deepEqual(manifest.server, { url: SERVER, status: "read", held: 6, listed: 6, added: 3, followed: 3 });
  assert.equal(asked.some(a => a.url.includes("help.lab.test")), false, "the lab's other site is never asked directly: its pages come through the server");
});

test("what the server holds and cannot return, or holds on a site that is not the lab's, is recorded with the reason and is not a failed page", async t => {
  const { manifest } = await viaServer(t);
  const lost = byUrl(manifest, "https://help.lab.test/agent"), video = byUrl(manifest, "https://videos.elsewhere.test/intro");
  assert.deepEqual([lost.status, lost.why, lost.sha256 ?? null], ["skipped", "the lab's documentation server lists it and did not return it (Failed to fetch https://help.lab.test/agent.md: 404 Not Found)", null]);
  assert.deepEqual([video.status, video.why], ["skipped", "the lab's documentation server lists it on videos.elsewhere.test, which is not one of the lab's sites"]);
  assert.equal(manifest.summary.failed, 1, "only the index's own broken page is a failure");
});

test("THE SERVER IS ASKED WITH NO KEY, only at its own address, and never follows a redirect by itself", async t => {
  const { posts } = await viaServer(t);
  assert.ok(posts.length >= 6);
  for (const p of posts) {
    assert.deepEqual(Object.keys(p.headers).map(h => h.toLowerCase()).sort(), ["accept", "content-type", "user-agent"]);
    assert.deepEqual([p.url, p.redirect, p.headers["user-agent"]], [SERVER, "manual", CLIENT]);
  }
  await assert.rejects(viaServer(t, { def: { ...WITH_SERVER, server: { ...WITH_SERVER.server, url: "https://mcp.elsewhere.test/mcp" } } }),
    { code: "VENDOR_SERVER_ELSEWHERE", message: /mcp\.elsewhere\.test/ });
});

test("a server that does not answer, or that says it holds more than it lists, is recorded as such, and the index's pages are still captured", async t => {
  const down = await viaServer(t, { down: true });
  assert.deepEqual(down.manifest.server, { url: SERVER, status: "failed", why: "HTTP 503", held: null, listed: 0, added: 0, followed: 0 });
  assert.equal(byUrl(down.manifest, "https://docs.lab.test/models/one.md").status, "captured");
  const short = await viaServer(t, { total: 9 });
  assert.deepEqual(short.manifest.server, { url: SERVER, status: "read", held: 9, listed: 6, added: 3, followed: 3 }, "the number the server says it holds is kept beside the number it listed");
});

test("A SITE OF THE LAB THAT IS READ ONLY THROUGH THE SERVER HAS NO INDEX HERE, so its pages' own links are followed: a page the server's list omits is still found, and nothing off that site is followed", async t => {
  const { manifest, posts } = await viaServer(t);
  const advanced = byUrl(manifest, "https://help.lab.test/agent/advanced"), deeper = byUrl(manifest, "https://help.lab.test/agent/deeper");
  assert.deepEqual([advanced.status, advanced.title, advanced.derived_from, advanced.via, advanced.sha256], ["captured", "Advanced configuration", "https://help.lab.test/agent/config", SERVER, sha(BODIES[advanced.url])]);
  assert.deepEqual([deeper.status, deeper.title, deeper.derived_from], ["captured", "Deeper", "https://help.lab.test/agent/advanced"]);
  const gone = byUrl(manifest, "https://help.lab.test/agent/gone");
  assert.deepEqual([gone.status, gone.why], ["skipped", "https://help.lab.test/agent/deeper links to it and the lab's documentation server did not return it (Failed to fetch https://help.lab.test/agent/gone.md: 404 Not Found)"]);
  const fetched = posts.filter(p => p.body.params.name === "fetch_doc").map(p => p.body.params.arguments.url);
  assert.deepEqual(fetched.filter(u => /keys\.png|other\.test|guides\/another|from-the-guide|models\/one/.test(u)), [],
    "a picture, another site, a page the index holds, and the links of a page on a site that has an index are not followed");
  assert.equal(fetched.filter(u => u === "https://help.lab.test/agent/config").length, 1, "a link back to a page already held is not asked again");
});

test("a listed page that moved to a site read only through the server is read there through the server, and the old address keeps saying where it went", async t => {
  const pages = { ...PAGES,
    "https://docs.lab.test/api/llms.txt": { body: API + "- [Agent configuration](https://docs.lab.test/reference/agent-config.md)\n", type: "text/plain" },
    "https://docs.lab.test/reference/agent-config.md": { status: 308, location: "https://help.lab.test/agent/redirected" } };
  const { manifest, asked } = await viaServer(t, { pages });
  const old = byUrl(manifest, "https://docs.lab.test/reference/agent-config.md"), moved = byUrl(manifest, "https://help.lab.test/agent/redirected");
  assert.deepEqual([old.status, old.redirects_to], ["refused", "https://help.lab.test/agent/redirected"]);
  assert.deepEqual([moved.status, moved.title, moved.derived_from, moved.sha256], ["captured", "Where the old address went", old.url, sha(BODIES[moved.url])]);
  assert.equal(asked.some(a => a.url.includes("help.lab.test")), false);
  assert.equal(byUrl(manifest, "https://accounts.elsewhere.test/signin") ?? null, null, "a move to a site that is not the lab's is still only refused");
});

test("A SERVER THAT LISTS PAGE NAMES: each name is a page of the lab's site, asked for by its name, and only the ones the index did not supply are read", async t => {
  const def = { ...LAB, server: { url: SERVER, list: "list_names", shape: "names", page: "https://docs.lab.test/{name}", fetch: "get_page", fetch_with: "name" } };
  const { manifest, posts } = await viaServer(t, { def });
  const calls = posts.map(p => [p.body.params.name, p.body.params.arguments]);
  assert.deepEqual(calls.filter(c => c[0] === "list_names"), [["list_names", {}]]);
  assert.deepEqual(calls.filter(c => c[0] === "get_page").map(c => c[1]).sort((a, b) => (a.name < b.name ? -1 : 1)), [{ name: "guides/absent" }, { name: "guides/unlisted" }], "the page the index holds is not read again");
  const got = byUrl(manifest, "https://docs.lab.test/guides/unlisted"), absent = byUrl(manifest, "https://docs.lab.test/guides/absent");
  assert.deepEqual([got.status, got.title, got.via, got.sha256], ["captured", "A guide the index omits", SERVER, sha(BODIES[got.url])]);
  assert.deepEqual([absent.status, absent.why], ["skipped", "the lab's documentation server lists it and did not return it (No page guides/absent)"]);
  assert.deepEqual(manifest.server, { url: SERVER, status: "read", held: null, listed: 3, added: 2, followed: 0 });
  assert.equal(got.ask ?? null, null, "what the server was asked with is not kept in the manifest");
});

test("A SERVER THAT PRINTS ITS NAVIGATION: each page line is a page with its title and its group, asked for by its path, with the arguments the configuration gives the listing", async t => {
  const def = { ...LAB, server: { url: SERVER, list: "navigation", list_args: { depth: 10 }, shape: "paths", fetch: "get_doc", fetch_with: "path" } };
  const { manifest, posts } = await viaServer(t, { def });
  const calls = posts.map(p => [p.body.params.name, p.body.params.arguments]);
  assert.deepEqual(calls.filter(c => c[0] === "navigation"), [["navigation", { depth: 10 }]]);
  assert.deepEqual(calls.filter(c => c[0] === "get_doc").map(c => c[1].path).sort(), ["/guides/absent", "/guides/unlisted"]);
  const got = byUrl(manifest, "https://docs.lab.test/guides/unlisted"), absent = byUrl(manifest, "https://docs.lab.test/guides/absent");
  assert.deepEqual([got.status, got.title, got.section, got.sha256], ["captured", "A guide the index omits", "Start here", sha(BODIES[got.url])]);
  assert.deepEqual([absent.status, absent.title, absent.section], ["skipped", "Gone", "Later"]);
  assert.deepEqual(manifest.server, { url: SERVER, status: "read", held: null, listed: 3, added: 2, followed: 0 });
});

test("a server whose way of listing is not one this capture reads is an error naming it, before anything is asked of it", async t => {
  const def = { ...LAB, server: { url: SERVER, list: "navigation", shape: "sitemap", fetch: "get_doc" } };
  const s = served();
  await assert.rejects(captureLab({ lab: "lab", def, store: store(t), fetch: s.fetch, now: NOW, sleep: async () => {}, retries: 0 }), { code: "VENDOR_SERVER_SHAPE", message: /sitemap/ });
  assert.deepEqual(s.posts, []);
});

test("the server's own address, where the index lists it as a link, is not read as a page: it is asked as a server", async t => {
  const pages = { ...PAGES, "https://docs.lab.test/api/llms.txt": { body: API + "- [Documentation server](https://docs.lab.test/mcp): search and read these pages.\n", type: "text/plain" } };
  const { manifest, asked } = await viaServer(t, { pages });
  const link = byUrl(manifest, SERVER);
  assert.deepEqual([link.status, link.why], ["skipped", "the lab's documentation server: it is asked as a server, not read as a page"]);
  assert.equal(asked.some(a => a.url === SERVER), false, "no plain request is made to the server's address");
  assert.equal(manifest.server.status, "read");
});
