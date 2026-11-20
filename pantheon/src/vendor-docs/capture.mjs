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
        return { ok: false, status: "refused", why: `redirects to ${next.hostname}, outside the lab's documentation hosts` };
      at = next.href;
      continue;
    }
    if (res.status !== 200) return { ok: false, status: "failed", why: `HTTP ${res.status}` };
    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type"), final: at };
  }
  return { ok: false, status: "failed", why: `more than ${MAX_HOPS} redirects` };
}

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
    if (!got.ok) { page.status = got.status; page.why = got.why; return; }
    if (got.bytes.length > maxBytes) { page.status = "skipped"; page.why = `larger than the bound of ${maxBytes} bytes (${got.bytes.length})`; return; }
    const digest = sha256(got.bytes);
    if (!existsSync(join(blobs, digest))) writeFileSync(join(blobs, digest), got.bytes);
    Object.assign(page, { status: "captured", sha256: digest, bytes: got.bytes.length, type: got.type, read: now(), ...(got.final !== page.url ? { final: got.final } : {}) });
  };
  await pool([...listed.values()].filter(p => !p.status), concurrency, read);
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
  const pages = [...listed.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const count = status => pages.filter(p => p.status === status).length;
  const manifest = { schema: SCHEMA, lab, client: CLIENT, read: now(), hosts: [...def.hosts], indexes, pages,
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
