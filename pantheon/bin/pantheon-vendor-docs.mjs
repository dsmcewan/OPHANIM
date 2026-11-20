#!/usr/bin/env node
// Each lab's own documentation: capture it whole, catalogue every model it describes, and say what there is to do.
//
//   pantheon-vendor-docs capture [--lab <lab>]... [--store <dir>] [--concurrency <n>]
//   pantheon-vendor-docs models  [--lab <lab>]... [--store <dir>] [--offline] [--write] [--max-age <days>] [--all]
//
// `capture` reads every page each lab lists. `models` captures (unless --offline, which uses the last capture), reads every
// model page, and compares the result with the catalogue kept in the repository, the registry and the recorded capability
// facts. It exits 0 when there is nothing to do, 2 when there is, 1 on an error. --write keeps the fresh catalogue
// (src/config/vendor-catalog/<lab>.json); it never touches the registry or any route.
//
// The pages are kept outside the repository's history (default .ophanim-state/vendor-docs, which git ignores): they are
// the labs' text, tens of megabytes of it, and are read again whenever they are wanted.
// Where the network is reached through a proxy named in the environment, run with NODE_USE_ENV_PROXY=1.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLab, changes, readManifest } from "../src/vendor-docs/capture.mjs";
import { catalogue, keep } from "../src/vendor-docs/models.mjs";
import { check } from "../src/vendor-docs/check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, "../src/config");
const read = file => JSON.parse(readFileSync(file, "utf8"));
const CONFIG = read(join(CONFIG_DIR, "vendor-docs.json"));
export const DEFAULT_STORE = resolve(HERE, "../../.ophanim-state/vendor-docs");
export const catalogueFile = lab => join(CONFIG_DIR, "vendor-catalog", `${lab}.json`);
const USAGE = "usage: pantheon-vendor-docs capture|models [--lab <lab>]... [--store <dir>] [--concurrency <n>] [--offline] [--write] [--max-age <days>] [--all]";

function parse(argv) {
  const a = { command: argv[0], labs: [], store: process.env.PANTHEON_VENDOR_DOCS || DEFAULT_STORE, concurrency: 6, offline: false, write: false, all: false, maxAge: 14 };
  const whole = (flag, value, min, max) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} is a whole number from ${min} to ${max}`); return n; };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--offline" || flag === "--write" || flag === "--all") { a[flag.slice(2)] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--lab") { if (!CONFIG.labs[value]) throw new Error(`unknown lab ${value} (known: ${Object.keys(CONFIG.labs).join(", ")})`); a.labs.push(value); }
    else if (flag === "--store") a.store = resolve(value);
    else if (flag === "--concurrency") a.concurrency = whole(flag, value, 1, 16);
    else if (flag === "--max-age") a.maxAge = whole(flag, value, 0, 3650);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!a.labs.length) a.labs = Object.keys(CONFIG.labs);
  return a;
}

function reportCapture(lab, before, m) {
  const s = m.summary, c = changes(before, m);
  console.log(`${lab}: ${s.listed} pages listed, ${s.captured} captured, ${s.skipped} skipped, ${s.refused} refused, ${s.failed} failed; ${m.indexes.length} index(es)`);
  if (before) console.log(`  since ${before.read}: ${c.added.length} added, ${c.removed.length} removed, ${c.changed.length} changed`);
  for (const p of m.pages.filter(p => p.status === "failed" || p.status === "refused")) console.log(`  ${p.status}: ${p.url} (${p.why})`);
  for (const i of m.indexes.filter(i => i.status !== "captured")) console.log(`  index ${i.status}: ${i.url} (${i.why})`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parse(process.argv.slice(2));
    if (a.command === "capture") process.exitCode = await capture(a);
    else if (a.command === "models") process.exitCode = await models(a);
    else throw new Error(USAGE);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
