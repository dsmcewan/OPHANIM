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
