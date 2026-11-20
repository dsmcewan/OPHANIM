#!/usr/bin/env node
// Each lab's own documentation: capture it whole, and see what changed since the last capture.
//
//   pantheon-vendor-docs capture [--lab <lab>]... [--store <dir>] [--concurrency <n>]
//
// The store is outside the repository's history (default .ophanim-state/vendor-docs, which git ignores): the pages are the
// labs' text, tens of megabytes of it, and are read again whenever they are wanted.
// Where the network is reached through a proxy named in the environment, run with NODE_USE_ENV_PROXY=1.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLab, changes, readManifest } from "../src/vendor-docs/capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, "../src/config/vendor-docs.json"), "utf8"));
export const DEFAULT_STORE = resolve(HERE, "../../.ophanim-state/vendor-docs");

function parse(argv) {
  const a = { command: argv[0], labs: [], store: process.env.PANTHEON_VENDOR_DOCS || DEFAULT_STORE, concurrency: 6 };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--lab") { if (!CONFIG.labs[value]) throw new Error(`unknown lab ${value} (known: ${Object.keys(CONFIG.labs).join(", ")})`); a.labs.push(value); }
    else if (flag === "--store") a.store = resolve(value);
    else if (flag === "--concurrency") { a.concurrency = Number(value); if (!Number.isInteger(a.concurrency) || a.concurrency < 1 || a.concurrency > 16) throw new Error("--concurrency is a whole number from 1 to 16"); }
    else throw new Error(`unknown option ${flag}`);
  }
  if (!a.labs.length) a.labs = Object.keys(CONFIG.labs);
  return a;
}

async function capture(a) {
  let failed = 0;
  for (const lab of a.labs) {
    const before = readManifest({ store: a.store, lab });
    try {
      const m = await captureLab({ lab, def: CONFIG.labs[lab], store: a.store, concurrency: a.concurrency });
      const s = m.summary, c = changes(before, m);
      console.log(`${lab}: ${s.listed} listed, ${s.captured} captured, ${s.skipped} skipped, ${s.refused} refused, ${s.failed} failed; ${m.indexes.length} index(es)`);
      if (before) console.log(`  since ${before.read}: ${c.added.length} added, ${c.removed.length} removed, ${c.changed.length} changed`);
      for (const p of m.pages.filter(p => p.status === "failed" || p.status === "refused")) console.log(`  ${p.status}: ${p.url} (${p.why})`);
      for (const i of m.indexes.filter(i => i.status !== "captured")) console.log(`  index ${i.status}: ${i.url} (${i.why})`);
      if (s.failed) failed++;
    } catch (e) { failed++; console.error(`${lab}: ${e.code ?? "ERROR"}: ${e.message}`); }
  }
  return failed ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parse(process.argv.slice(2));
    if (a.command !== "capture") throw new Error("usage: pantheon-vendor-docs capture [--lab <lab>]... [--store <dir>] [--concurrency <n>]");
    process.exitCode = await capture(a);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
