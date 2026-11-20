// Each lab's own documentation, captured whole: every page the lab's index lists is read and kept, whether this repository
// uses what it describes or not. A reference that covers only what is already used cannot show what was released since.
//
// What is asked for is a public page and nothing else. No request carries a key (the labs' API hosts are not touched here),
// the client names nothing about this project, a link outside the lab's documentation hosts is never requested, and a
// redirect is followed by this code, one hop at a time, only while it stays on those hosts: a sign-in page on another host
// is not documentation and is not kept as if it were.
//
// A page is kept under the digest of its bytes. The manifest names every listed page with its digest and the time read, so
// two captures can be compared, and what was not read stays in it with the reason.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = "pantheon.vendor-docs-manifest/v1";
/** Sent as the client's name. It identifies a documentation reader and nothing about who runs it. */
export const CLIENT = "docs-reader/1.0";
// The listed links already name the markdown form of each page. Asking for markdown as well makes one lab's site look for
// the markdown of the markdown and answer 404, so nothing is preferred here.
const HEADERS = Object.freeze({ "user-agent": CLIENT, accept: "*/*" });
const RPC_HEADERS = Object.freeze({ "user-agent": CLIENT, accept: "application/json, text/event-stream", "content-type": "application/json" });
const MAX_LISTS = 200;
const MAX_FOLLOWED = 3000, FOLLOW_DEPTH = 5;
const MAX_HOPS = 3;
const MAX_INDEXES = 64;
const INDEX_BYTES = 4_000_000;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });

/** The titled links of an index (the `llms.txt` form): [{section, title, url, description}], in the index's order. */
export function parseIndex(text, base) {
  const entries = [];
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    const link = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:(?::|-|–|—)\s*(.*?))?\s*$/.exec(line);
    if (!link) continue;
    let url;
    try { url = new URL(link[2], base).href; } catch { continue; }
    entries.push({ section, title: link[1].trim(), url, description: link[3] ? link[3].trim() : null });
  }
  return entries;
}

/** What a listed link is for this lab: an index to follow, a page to read, or something not read (with the reason). */
function classify(url, def) {
  const u = new URL(url);
  if (u.protocol !== "https:") return { kind: "skipped", why: "not an https link" };
  if (!def.hosts.includes(u.hostname)) return { kind: "skipped", why: `outside the lab's documentation hosts (${def.hosts.join(", ")})` };
  if (def.server?.url === u.href) return { kind: "skipped", why: "the lab's documentation server: it is asked as a server, not read as a page" };
  if (/\/llms-full\.txt$/.test(u.pathname)) return { kind: "skipped", why: "a single-file export of pages that are listed one by one" };
  if (/\/llms\.txt$/.test(u.pathname)) return { kind: "index" };
  return { kind: "page" };
}

/** The model pages a listing names: its links that match `link` (the markdown ending added where the link has none), and
 *  the page of each name its `names` patterns find. In the listing's order, each once. */
export function modelPages(text, base, { link, names = [], page } = {}) {
  const urls = new Set();
  if (link) {
    const wanted = new RegExp(link);
    for (const m of String(text).matchAll(/\]\(([^)\s]+)\)/g)) {
      let u;
      try { u = new URL(m[1], base); } catch { continue; }
      u.hash = "";
      const href = /\.(md|txt|json|xml|html?)$/i.test(u.pathname) ? u.href : Object.assign(u, { pathname: `${u.pathname}.md` }).href;
      if (wanted.test(href)) urls.add(href);
    }
  }
  if (page) for (const pattern of names) for (const m of String(text).matchAll(new RegExp(pattern, "gm")))
    urls.add(page.replace("{name}", encodeURIComponent(m[1])));
  return [...urls];
}

/** One GET, with redirects followed here and only inside the lab's hosts. → {ok, bytes, type, final} | {ok:false, status, why} */
async function get(url, { def, fetch, retries, sleep }) {
  let at = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res, lastWhy = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { res = await fetch(at, { method: "GET", headers: { ...HEADERS }, redirect: "manual" }); }
      catch (e) { res = null; lastWhy = `no answer (${e?.cause?.code ?? e?.code ?? e?.name ?? "error"})`; }
      // A refusal the site means (404, 403) is not asked again. A fault or a rate limit is, a bounded number of times.
      if (res && res.status !== 429 && res.status < 500) break;
      if (res) lastWhy = `HTTP ${res.status}`;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
    if (!res || res.status === 429 || res.status >= 500) return { ok: false, status: "failed", why: lastWhy };
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      let next;
      try { next = new URL(location, at); } catch { return { ok: false, status: "failed", why: `HTTP ${res.status} with no usable location` }; }
      if (next.protocol !== "https:" || !def.hosts.includes(next.hostname))
        return { ok: false, status: "refused", why: `redirects to ${next.hostname}, outside the lab's documentation hosts`, to: next.href };
      at = next.href;
      continue;
    }
    if (res.status !== 200) return { ok: false, status: "failed", why: `HTTP ${res.status}` };
    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type"), final: at };
  }
  return { ok: false, status: "failed", why: `more than ${MAX_HOPS} redirects` };
}

/** One call of a tool of the lab's documentation server (the MCP form, over HTTP). → {text} | {error} */
async function ask(server, fetch, name, args, id) {
  let res;
  try { res = await fetch(server.url, { method: "POST", headers: { ...RPC_HEADERS }, redirect: "manual", body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }); }
  catch (e) { return { error: `no answer (${e?.cause?.code ?? e?.code ?? e?.name ?? "error"})` }; }
  if (res.status !== 200) return { error: `HTTP ${res.status}` };
  const raw = await res.text(), event = /^data: (.*)$/m.exec(raw);
  let message;
  try { message = JSON.parse(event ? event[1] : raw); } catch { return { error: "an answer that is not JSON" }; }
  if (message.error) return { error: String(message.error.message ?? "an error") };
  const text = message.result?.content?.find(c => c.type === "text")?.text ?? "";
  return message.result?.isError ? { error: text.split(/\r?\n/)[0].slice(0, 300) } : { text };
}

// The labs' documentation servers do not list their documents the same way. Each way has a reading here:
//   hits   a page of results at a time, each with the document's address, and the number held (paged by a cursor)
//   names  every page's name at once; a page's address is made from its name, and it is asked for by its name
//   paths  the site's navigation as text, a titled line per page with its path; a page is asked for by its path
// → {held, next, docs: [{url, title, section, ask}]}; `ask` is what the page is asked for with when it is not its address.
const SHAPES = {
  hits: { paged: true, read(text) {
    const page = JSON.parse(text);
    return { held: typeof page.nbHits === "number" ? page.nbHits : null, next: page.nextCursor,
      docs: (page.hits ?? []).map(h => ({ url: h.url_without_anchor ?? h.url, title: h.hierarchy?.lvl1 ?? null, section: h.hierarchy?.lvl0 ?? null })) };
  } },
  names: { read(text, server) {
    const names = JSON.parse(text);
    if (!Array.isArray(names)) throw new Error("not a list");
    return { held: null, docs: names.filter(n => typeof n === "string").map(n => ({ url: server.page.replace("{name}", n), title: null, section: null, ask: n })) };
  } },
  paths: { read(text, server) {
    const docs = [];
    let section = null;
    for (const line of String(text).split(/\r?\n/)) {
      const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
      if (heading) { section = heading[1]; continue; }
      const page = /^\s*[-*]\s+(.+?):\s+(\/\S+)\s*$/.exec(line);
      if (page) docs.push({ url: new URL(page[2], server.url).href, title: page[1], section, ask: page[2] });
    }
    return { held: null, docs };
  } },
};

/** A page's address without what does not change which page it is: the markdown ending, a closing slash, a fragment. */
const same = url => { const u = new URL(url); return u.origin + u.pathname.replace(/\.md$/, "").replace(/\/$/, "") + u.search; };

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) { const i = next++; await work(items[i]); }
  }));
}

/**
 * Capture one lab: follow its indexes, read every listed page, keep each under its digest, write the manifest.
 * `def` is {hosts: [...], indexes: [...]}. Throws VENDOR_INDEX_UNREADABLE when a root index cannot be read: an empty capture
 * would read as "the lab lists nothing", so the last good manifest is left as it is.
 */
export async function captureLab({ lab, def, store, fetch = globalThis.fetch, now = () => new Date().toISOString(),
  sleep = ms => new Promise(r => setTimeout(r, ms)), concurrency = 6, retries = 2, maxBytes = 8_000_000 }) {
  const io = { def, fetch, retries, sleep };
  const dir = join(store, lab), blobs = join(dir, "blobs");
  const indexes = [], listed = new Map();
  const queue = def.indexes.map(url => ({ url, root: true }));
  const seen = new Set(queue.map(q => q.url));
  while (queue.length) {
    const { url, root } = queue.shift();
    const got = await get(url, io);
    if (!got.ok || got.bytes.length > INDEX_BYTES) {
      const why = got.ok ? `larger than ${INDEX_BYTES} bytes` : got.why;
      if (root) throw fail("VENDOR_INDEX_UNREADABLE", `${lab}: the index ${url}: ${why}`);
      indexes.push({ url, status: got.ok ? "skipped" : got.status, why });
      continue;
    }
    indexes.push({ url, status: "captured", sha256: sha256(got.bytes), bytes: got.bytes.length, read: now() });
    for (const entry of parseIndex(got.bytes.toString("utf8"), got.final)) {
      const c = classify(entry.url, def);
      if (c.kind === "index") {
        if (!seen.has(entry.url) && seen.size < MAX_INDEXES) { seen.add(entry.url); queue.push({ url: entry.url, root: false }); }
        continue;
      }
      // A page listed in two sections is one page: the first listing names it.
      if (listed.has(entry.url)) continue;
      listed.set(entry.url, { ...entry, index: url, ...(c.kind === "skipped" ? { status: "skipped", why: c.why } : {}) });
    }
  }
  mkdirSync(blobs, { recursive: true });
  const read = async page => {
    const got = await get(page.url, io);
    if (!got.ok) { page.status = got.status; page.why = got.why; if (got.to) page.redirects_to = got.to; return; }
    if (got.bytes.length > maxBytes) { page.status = "skipped"; page.why = `larger than the bound of ${maxBytes} bytes (${got.bytes.length})`; return; }
    const digest = sha256(got.bytes);
    if (!existsSync(join(blobs, digest))) writeFileSync(join(blobs, digest), got.bytes);
    Object.assign(page, { status: "captured", sha256: digest, bytes: got.bytes.length, type: got.type, read: now(), ...(got.final !== page.url ? { final: got.final } : {}) });
  };
  await pool([...listed.values()].filter(p => !p.status), concurrency, read);
  // One lab writes each page of its API reference once for each SDK, at an address made from the page's own, and lists
  // only one form in its index. The other forms are asked for from each captured page of that section. A form that does
  // not exist (not every page has every form) is recorded as absent: it is not a page that failed.
  if (def.variants) {
    const { section, from, insert } = def.variants, forms = [];
    for (const page of [...listed.values()]) {
      if (page.status !== "captured" || page.section !== section || !page.url.startsWith(from)) continue;
      const rest = page.url.slice(from.length);
      if (insert.some(v => rest.startsWith(`${v}/`))) continue;
      for (const variant of insert) {
        const url = `${from}${variant}/${rest}`;
        if (listed.has(url) || classify(url, def).kind !== "page") continue;
        const entry = { section: `${section} (${variant})`, title: page.title, url, description: null, index: null, derived_from: page.url, variant };
        listed.set(url, entry); forms.push(entry);
      }
    }
    await pool(forms, concurrency, read);
    for (const form of forms) if (form.status === "failed" && form.why === "HTTP 404") Object.assign(form, { status: "skipped", why: `no ${form.variant} form of this page (HTTP 404)` });
  }
  // Two labs do not list their per-model pages in the index. Their model listing does: by links, or only by the names in
  // its tables, from which the page of each model is named. A listing that could not be read is an error for the same reason
  // an index is: the capture would look complete and hold no model.
  const derived = [];
  for (const listing of def.models?.listings ?? []) {
    const from = listed.get(listing) ?? (await (async () => {
      const entry = { section: "Models", title: null, url: listing, description: null, index: null };
      listed.set(listing, entry); await read(entry); return entry;
    })());
    if (from.status !== "captured") throw fail("VENDOR_LISTING_UNREADABLE", `${lab}: the model listing ${listing}: ${from.why ?? from.status}`);
    for (const url of modelPages(readFileSync(join(blobs, from.sha256), "utf8"), from.final ?? listing, def.models)) {
      if (listed.has(url) || classify(url, def).kind !== "page") continue;
      const entry = { section: "Models", title: null, url, description: null, index: null, derived_from: listing };
      listed.set(url, entry); derived.push(entry);
    }
  }
  await pool(derived, concurrency, read);
  // The lab's own documentation server, where it runs one, holds documents its index does not list, some on other sites
  // of the lab. It is asked at its own address, which must be on the lab's documentation hosts, and only for what the
  // index did not already supply. It is an addition: when it does not answer, that is recorded and the capture stands.
  let server;
  if (def.server) {
    const at = new URL(def.server.url);
    if (at.protocol !== "https:" || !def.hosts.includes(at.hostname)) throw fail("VENDOR_SERVER_ELSEWHERE", `${lab}: the documentation server ${def.server.url} is on ${at.hostname}, outside the lab's documentation hosts`);
    const shape = SHAPES[def.server.shape ?? "hits"];
    if (!shape) throw fail("VENDOR_SERVER_SHAPE", `${lab}: no reading is written for a documentation server that lists its documents as "${def.server.shape}"`);
    server = { url: def.server.url, status: "read", held: null, listed: 0, added: 0, followed: 0 };
    const have = new Set([...listed.keys()].map(same)), wanted = [], asks = new Map();
    let cursor, id = 0;
    for (let n = 0; n < MAX_LISTS; n++) {
      const got = await ask(def.server, fetch, def.server.list, { ...(def.server.list_args ?? (shape.paged ? { limit: 50 } : {})), ...(cursor ? { cursor } : {}) }, ++id);
      let page;
      try { page = got.error ? null : shape.read(got.text, def.server); } catch { got.error = "a list this capture cannot read"; }
      if (!page) { Object.assign(server, { status: "failed", why: got.error }); break; }
      server.held = page.held ?? server.held;
      for (const doc of page.docs) {
        server.listed++;
        let url;
        try { url = new URL(doc.url); url.hash = ""; } catch { continue; }
        if (have.has(same(url.href))) continue;
        have.add(same(url.href));
        const entry = { section: doc.section, title: doc.title, url: url.href, description: null, index: null, via: def.server.url };
        if (url.protocol !== "https:" || !(def.server.hosts ?? def.hosts).includes(url.hostname))
          Object.assign(entry, { status: "skipped", why: `the lab's documentation server lists it on ${url.hostname}, which is not one of the lab's sites` });
        else { wanted.push(entry); if (doc.ask !== undefined) asks.set(entry, doc.ask); }
        listed.set(entry.url, entry);
      }
      cursor = page.next;
      // Only a reading that pages gives a cursor: the others end here after their one list.
      if (!cursor || !page.docs.length) break;
    }
    server.added = wanted.length;
    const through = async page => {
      const got = await ask(def.server, fetch, def.server.fetch, { [def.server.fetch_with ?? "url"]: asks.get(page) ?? page.url }, ++id);
      if (got.error) { page.status = "skipped"; page.why = `${page.derived_from ? `${page.derived_from} links to it and the lab's documentation server` : "the lab's documentation server lists it and"} did not return it (${got.error})`; return; }
      const bytes = Buffer.from(got.text, "utf8");
      if (bytes.length > maxBytes) { page.status = "skipped"; page.why = `larger than the bound of ${maxBytes} bytes (${bytes.length})`; return; }
      const digest = sha256(bytes);
      if (!existsSync(join(blobs, digest))) writeFileSync(join(blobs, digest), bytes);
      Object.assign(page, { status: "captured", sha256: digest, bytes: bytes.length, read: now(), title: page.title ?? /^# (.+?)\s*$/m.exec(got.text)?.[1] ?? null });
      texts.set(page.url, got.text);
    };
    const texts = new Map();
    await pool(wanted, concurrency, through);
    // A site of the lab that is read only through the server has no index here, and the server's list is bounded. So on
    // such a site a captured page's own links are followed, through the server, a bounded number of steps; and a listed
    // page that moved there is read where it went. Nothing off those sites is followed.
    const only = new Set((def.server.hosts ?? []).filter(h => !def.hosts.includes(h)));
    const add = (url, from) => {
      if (server.status !== "read" || server.followed >= MAX_FOLLOWED || !only.has(url.hostname) || url.protocol !== "https:") return null;
      url.hash = ""; url.pathname = url.pathname.replace(/\.md$/, "");
      if (/\.[a-z0-9]{2,5}$/i.test(url.pathname) || have.has(same(url.href))) return null;
      have.add(same(url.href)); server.followed++;
      const entry = { section: from.section ?? null, title: null, url: url.href, description: null, index: null, via: def.server.url, derived_from: from.url };
      listed.set(entry.url, entry);
      return entry;
    };
    let frontier = [...listed.values()].filter(p => p.status === "refused" && p.redirects_to).map(p => add(new URL(p.redirects_to), p)).filter(Boolean);
    await pool(frontier, concurrency, through);
    frontier = [...wanted, ...frontier].filter(p => p.status === "captured" && only.has(new URL(p.url).hostname));
    for (let depth = 0; depth < FOLLOW_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const page of frontier) for (const m of (texts.get(page.url) ?? "").matchAll(/\]\(([^)\s]+)\)/g)) {
        let url;
        try { url = new URL(m[1], page.url); } catch { continue; }
        const entry = add(url, page);
        if (entry) next.push(entry);
      }
      await pool(next, concurrency, through);
      frontier = next.filter(p => p.status === "captured");
    }
  }
  const pages = [...listed.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const count = status => pages.filter(p => p.status === status).length;
  const manifest = { schema: SCHEMA, lab, client: CLIENT, read: now(), hosts: [...def.hosts], indexes, ...(server ? { server } : {}), pages,
    summary: { listed: pages.length, captured: count("captured"), skipped: count("skipped"), refused: count("refused"), failed: count("failed") } };
  const file = join(dir, "manifest.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 1) + "\n");
  renameSync(`${file}.tmp`, file);
  return manifest;
}

/** The last manifest of a lab in this store, or null. */
export function readManifest({ store, lab }) {
  const file = join(store, lab, "manifest.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** The text of a captured page, by its listed URL, or null when it was not captured. */
export function readPage({ store, lab, url, manifest = readManifest({ store, lab }) }) {
  const page = manifest?.pages.find(p => p.url === url);
  if (!page?.sha256 || !/^[0-9a-f]{64}$/.test(page.sha256)) return null;
  const file = join(store, lab, "blobs", page.sha256);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** What differs between two manifests of one lab: listed pages added and removed, and pages whose bytes changed. */
export function changes(before, after) {
  const was = new Map((before?.pages ?? []).map(p => [p.url, p])), is = new Map((after?.pages ?? []).map(p => [p.url, p]));
  return {
    added: [...is.keys()].filter(u => !was.has(u)).sort(),
    removed: [...was.keys()].filter(u => !is.has(u)).sort(),
    changed: [...is.keys()].filter(u => was.has(u) && (was.get(u).sha256 ?? null) !== (is.get(u).sha256 ?? null)).sort(),
  };
}
