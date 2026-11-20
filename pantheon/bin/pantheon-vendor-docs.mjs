#!/usr/bin/env node
// Each lab's own documentation: capture it whole, catalogue every model it describes, and say what there is to do.
//
//   pantheon-vendor-docs capture [--lab <lab>]... [--store <dir>] [--concurrency <n>]
//   pantheon-vendor-docs models  [--lab <lab>]... [--store <dir>] [--offline] [--write] [--max-age <days>] [--all]
//   pantheon-vendor-docs reference [--store <dir>] [--offline] [--write]
//   pantheon-vendor-docs find <lab> <word>...      pantheon-vendor-docs show <lab> <address> [--raw]
//
// `capture` reads every page each lab lists. `models` captures (unless --offline, which uses the last capture), reads every
// model page, and compares the result with the catalogue kept in the repository, the registry and the recorded capability
// facts. It exits 0 when there is nothing to do, 2 when there is, 1 on an error. --write keeps the fresh catalogue
// (src/config/vendor-catalog/<lab>.json); it never touches the registry or any route.
// `reference` reads, for each capability, the pages chosen in src/config/vendor-topics.json and reports one that is gone
// or changed since it was read; --write keeps the reference and regenerates docs/vendor-labs.md. `find` and `show` read
// the captured pages: the labs' full text, at hand without the network.
//
// The pages are kept outside the repository's history (default .ophanim-state/vendor-docs, which git ignores): they are
// the labs' text, tens of megabytes of it, and are read again whenever they are wanted.
// Where the network is reached through a proxy named in the environment, run with NODE_USE_ENV_PROXY=1.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLab, changes, readManifest, readPage, plain } from "../src/vendor-docs/capture.mjs";
import { reference, referenceChanges, render, find } from "../src/vendor-docs/reference.mjs";
import { catalogue, keep } from "../src/vendor-docs/models.mjs";
import { check } from "../src/vendor-docs/check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, "../src/config");
const read = file => JSON.parse(readFileSync(file, "utf8"));
const CONFIG = read(join(CONFIG_DIR, "vendor-docs.json"));
export const DEFAULT_STORE = resolve(HERE, "../../.ophanim-state/vendor-docs");
export const catalogueFile = lab => join(CONFIG_DIR, "vendor-catalog", `${lab}.json`);
export const REFERENCE_FILE = join(CONFIG_DIR, "vendor-reference.json"), REFERENCE_DOC = resolve(HERE, "../../docs/vendor-labs.md");
const USAGE = "usage: pantheon-vendor-docs capture|models|reference [--lab <lab>]... [--store <dir>] [--concurrency <n>] [--offline] [--write] [--max-age <days>] [--all]\n       pantheon-vendor-docs find <lab> <word>...\n       pantheon-vendor-docs show <lab> <address>";

function parse(argv) {
  const a = { command: argv[0], labs: [], words: [], store: process.env.PANTHEON_VENDOR_DOCS || DEFAULT_STORE, concurrency: 6, offline: false, write: false, all: false, maxAge: 14 };
  const whole = (flag, value, min, max) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} is a whole number from ${min} to ${max}`); return n; };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--offline" || flag === "--write" || flag === "--all" || flag === "--raw") { a[flag.slice(2)] = true; continue; }
    if (!flag.startsWith("--")) { a.words.push(flag); continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--lab") { if (!CONFIG.labs[value]) throw new Error(`unknown lab ${value} (known: ${Object.keys(CONFIG.labs).join(", ")})`); a.labs.push(value); }
    else if (flag === "--store") a.store = resolve(value);
    else if (flag === "--concurrency") a.concurrency = whole(flag, value, 1, 16);
    else if (flag === "--max-age") a.maxAge = whole(flag, value, 0, 3650);
    else throw new Error(`unknown option ${flag}`);
  }
  if ((a.command === "find" || a.command === "show") && !CONFIG.labs[a.words[0]]) throw new Error(`${a.command} needs a lab first (known: ${Object.keys(CONFIG.labs).join(", ")})`);
  if (a.command !== "find" && a.command !== "show" && a.words.length) throw new Error(`unexpected ${a.words[0]}`);
  if (!a.labs.length) a.labs = Object.keys(CONFIG.labs);
  return a;
}

function reportCapture(lab, before, m) {
  const s = m.summary, c = changes(before, m);
  console.log(`${lab}: ${s.listed} pages listed, ${s.captured} captured, ${s.skipped} skipped, ${s.refused} refused, ${s.failed} failed; ${m.indexes.length} index(es)`);
  if (before) console.log(`  since ${before.read}: ${c.added.length} added, ${c.removed.length} removed, ${c.changed.length} changed`);
  for (const p of m.pages.filter(p => p.status === "failed" || p.status === "refused")) console.log(`  ${p.status}: ${p.url} (${p.why})`);
  for (const i of m.indexes.filter(i => i.status !== "captured")) console.log(`  index ${i.status}: ${i.url} (${i.why})`);
  if (m.server) console.log(`  documentation server ${m.server.url}: ${m.server.status}${m.server.why ? ` (${m.server.why})` : ""}; it listed ${m.server.listed} documents${m.server.held === null ? "" : ` of the ${m.server.held} it says it holds`}, ${m.server.added} not in the index were asked through it, and ${m.server.followed} more addresses were followed`);
}

async function capture(a) {
  let failed = 0;
  for (const lab of a.labs) {
    const before = readManifest({ store: a.store, lab });
    try { const m = await captureLab({ lab, def: CONFIG.labs[lab], store: a.store, concurrency: a.concurrency }); reportCapture(lab, before, m); if (m.summary.failed) failed++; }
    catch (e) { failed++; console.error(`${lab}: ${e.code ?? "ERROR"}: ${e.message}`); }
  }
  return failed ? 2 : 0;
}

async function models(a) {
  const registry = read(join(CONFIG_DIR, "models.json")), facts = read(join(CONFIG_DIR, "capability-facts.json")).models;
  const today = new Date().toISOString();
  let todo = 0, errors = 0;
  for (const lab of a.labs) {
    try {
      let manifest = readManifest({ store: a.store, lab });
      if (!a.offline) { const before = manifest; manifest = await captureLab({ lab, def: CONFIG.labs[lab], store: a.store, concurrency: a.concurrency }); reportCapture(lab, before, manifest); }
      if (!manifest) throw Object.assign(new Error(`nothing was captured in ${a.store} (run without --offline)`), { code: "VENDOR_NOT_CAPTURED" });
      const fresh = catalogue({ lab, manifest, text: p => readFileSync(join(a.store, lab, "blobs", p.sha256), "utf8") });
      const file = catalogueFile(lab), kept = existsSync(file) ? read(file) : null;
      const r = check({ lab, kept, fresh, registry: Object.values(registry[lab] ?? {}), facts, today, maxAgeDays: a.maxAge });
      const c = r.counts;
      console.log(`${lab}: ${c.published} models described (read ${fresh.read}); ${c.registered} registered here, ${c.unregistered} not; ${c.pages_changed} model page(s) changed since the kept catalogue`);
      for (const f of r.findings) console.log(`  ${f.kind}${f.id ? ` ${f.id}` : ""}: ${f.why}`);
      if (a.all) for (const id of r.unregistered) console.log(`  not registered: ${id}${fresh.models[id].status ? ` (${fresh.models[id].status.value})` : ""}`);
      if (a.write) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(keep(kept, fresh), null, 1) + "\n"); renameSync(`${file}.tmp`, file);
        console.log(`  kept: ${file}`);
      }
      // Once the fresh catalogue is kept, what it differed in from the old one is recorded; the rest still stands.
      const kindsDone = new Set(a.write ? ["never-kept", "stale", "released", "gone", "changed"] : []);
      todo += r.findings.filter(f => !kindsDone.has(f.kind)).length;
    } catch (e) { errors++; console.error(`${lab}: ${e.code ?? "ERROR"}: ${e.message}`); }
  }
  return errors ? 1 : todo ? 2 : 0;
}

async function referenceCommand(a) {
  const topics = read(join(CONFIG_DIR, "vendor-topics.json")), manifests = {};
  for (const lab of Object.keys(topics.pages)) {
    if (!a.offline) { const before = readManifest({ store: a.store, lab }); reportCapture(lab, before, await captureLab({ lab, def: CONFIG.labs[lab], store: a.store, concurrency: a.concurrency })); }
    manifests[lab] = readManifest({ store: a.store, lab });
    if (!manifests[lab]) throw Object.assign(new Error(`${lab}: nothing was captured in ${a.store} (run without --offline)`), { code: "VENDOR_NOT_CAPTURED" });
  }
  const fresh = reference({ topics, manifests }), kept = existsSync(REFERENCE_FILE) ? read(REFERENCE_FILE) : null;
  const changed = referenceChanges(kept, fresh);
  for (const [lab, l] of Object.entries(fresh.labs)) console.log(`${lab}: ${l.pages.captured} of ${l.pages.listed} pages captured (read ${l.read}); ${Object.values(l.topics).filter(p => p.length).length} of ${topics.topics.length} topics answered`);
  for (const p of fresh.problems) console.log(`  problem ${p.lab} ${p.topic}: ${p.url}: ${p.why}`);
  for (const c of changed) console.log(`  changed ${c.lab} ${c.topic}: ${c.url}: ${c.why}`);
  if (!kept) console.log("  no reference is kept in the repository yet");
  if (a.write) {
    // A reference with a chosen page missing is not kept: the written page would show a topic as answered by less than
    // was chosen, with nothing on it to say so.
    if (fresh.problems.length) throw Object.assign(new Error("the reference is not kept while a chosen page is missing: correct src/config/vendor-topics.json or capture again"), { code: "VENDOR_REFERENCE_INCOMPLETE" });
    const catalogues = Object.fromEntries(Object.keys(fresh.labs).map(lab => [lab, read(catalogueFile(lab))]));
    writeFileSync(`${REFERENCE_FILE}.tmp`, JSON.stringify(fresh, null, 1) + "\n"); renameSync(`${REFERENCE_FILE}.tmp`, REFERENCE_FILE);
    writeFileSync(REFERENCE_DOC, render({ reference: fresh, topics, catalogues, registry: read(join(CONFIG_DIR, "models.json")) }));
    console.log(`  kept: ${REFERENCE_FILE}\n  written: ${REFERENCE_DOC}`);
    return 0;
  }
  return fresh.problems.length || changed.length || !kept ? 2 : 0;
}

function lookup(a) {
  const [lab, ...words] = a.words, manifest = readManifest({ store: a.store, lab });
  if (!manifest) throw Object.assign(new Error(`${lab}: nothing was captured in ${a.store} (run capture first)`), { code: "VENDOR_NOT_CAPTURED" });
  if (a.command === "find") {
    const hits = find({ manifest, words });
    for (const p of hits) console.log(`${p.url}\n    ${p.title ?? ""}${p.description ? `: ${p.description}` : ""}`);
    console.error(`${hits.length} page(s) of ${lab}, read ${manifest.read}`);
    return hits.length ? 0 : 2;
  }
  const text = words.length === 1 ? readPage({ store: a.store, lab, url: words[0], manifest }) : null;
  if (text === null) throw new Error(`show needs one address of a captured page of ${lab} (find lists them)`);
  // A web page is shown as its words; --raw prints it as it was served.
  process.stdout.write(a.raw ? text : plain(text));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parse(process.argv.slice(2));
    if (a.command === "capture") process.exitCode = await capture(a);
    else if (a.command === "models") process.exitCode = await models(a);
    else if (a.command === "reference") process.exitCode = await referenceCommand(a);
    else if (a.command === "find" || a.command === "show") process.exitCode = lookup(a);
    else throw new Error(USAGE);
  } catch (e) { console.error(e.code ? `${e.code}: ${e.message}` : e.message); process.exitCode = 1; }
}
