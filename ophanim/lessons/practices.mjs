#!/usr/bin/env node
// OPHANIM's practices, cross-referenced to the labs' own guidance (ophanim/lessons/practices.json).
//
// Purpose: the labs each publish how they say their models should be instructed, given context and tools, run as agents,
// checked and contained. Captured, that is a library; it changes nothing here until it is read across the labs, set
// beside what this repository does, and turned into practices of its own. This registry is that: per theme, where the labs
// agree, where they differ, and the practices proposed for OPHANIM, each resting on words quoted from a lab's page.
// Inputs: the registry file. Outputs: problems() (is it well formed), report() (what stands), render() (the written page,
// docs/ophanim-best-practices.md), verify() (are the quotations still in the pages as captured).
// Invariants: a practice is a proposal until the owner accepts or strikes it, and only the owner's dated decision changes
// that; every practice and every point of agreement or difference carries at least one quotation, from a page on that
// lab's documentation hosts, with the page's digest.
// Must never: present a proposal as the owner's practice, state what a lab recommends without its words, or count a
// quotation as held when its page was not there to check.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTRY = path.join(ROOT, 'ophanim/lessons/practices.json');
export const DOC = path.join(ROOT, 'docs/ophanim-best-practices.md');
export const SCHEMA = 'ophanim.practices/v1';
const STATUS = ['proposed', 'accepted', 'struck'];
const FIT = ['does', 'partly', 'does-not', 'unknown'];
const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();

export function load(file = REGISTRY) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Every quotation of the registry with where it stands: [{where, lab, url, sha256, quote}], theme points before practices. */
function quotations(reg) {
  const out = [];
  for (const t of reg.themes ?? []) {
    for (const point of [...(t.agree ?? []), ...(t.differ ?? [])]) for (const b of point.basis ?? []) out.push({where: t.id, ...b});
    for (const p of t.practices ?? []) for (const b of p.basis ?? []) out.push({where: p.id, ...b});
  }
  return out;
}

/** What is wrong with a registry, as sentences; none when it is well formed. `hosts` is {lab: [documentation hosts]}. */
export function problems(reg, {hosts}) {
  if (reg.schema !== SCHEMA) return [`schema ${reg.schema}, expected ${SCHEMA}`];
  const out = [], seen = new Set();
  const basis = (who, list) => {
    for (const b of list) {
      if (!hosts[b.lab]) { out.push(`${who}: ${b.lab} is not a lab whose documentation is captured`); continue; }
      let host = null;
      try { host = new URL(b.url).hostname; } catch { /* reported as not on the lab's hosts */ }
      if (!hosts[b.lab].includes(host)) out.push(`${who}: ${b.url} is not on ${b.lab}'s documentation hosts`);
      if (!/^[0-9a-f]{64}$/.test(b.sha256 ?? '')) out.push(`${who}: a quotation from ${b.lab} carries no page digest`);
      if (!flat(b.quote)) out.push(`${who}: a quotation from ${b.lab} is empty`);
    }
  };
  for (const t of reg.themes ?? []) {
    for (const [kind, points] of [['agreement', t.agree ?? []], ['difference', t.differ ?? []]]) for (const point of points) {
      if (!(point.basis ?? []).length) out.push(`${t.id}: a point of ${kind} rests on no quotation`);
      basis(t.id, point.basis ?? []);
    }
    for (const p of t.practices ?? []) {
      if (seen.has(p.id)) out.push(`${p.id}: the id is used twice`);
      seen.add(p.id);
      if (!String(p.id).startsWith(`P-${t.id}-`)) out.push(`${p.id}: the id does not name its theme (${t.id})`);
      if (!flat(p.statement)) out.push(`${p.id}: no statement`);
      if (!STATUS.includes(p.status)) out.push(`${p.id}: status ${JSON.stringify(p.status)} is not one of ${STATUS.join(', ')}`);
      else if (p.status === 'proposed') { if (p.decided) out.push(`${p.id}: a proposal carries no decision`); }
      else if (p.decided?.by !== 'owner' || !/^\d{4}-\d{2}-\d{2}$/.test(p.decided?.date ?? '')) out.push(`${p.id}: ${p.status} needs the owner's dated decision`);
      if (!FIT.includes(p.fit)) out.push(`${p.id}: fit ${JSON.stringify(p.fit)} is not one of ${FIT.join(', ')}`);
      if (!(p.basis ?? []).length) out.push(`${p.id}: rests on no quotation`);
      basis(p.id, p.basis ?? []);
    }
  }
  return out;
}

/** What stands: counts by status and by fit, and how much of the labs' text it rests on. */
export function report(reg) {
  const all = (reg.themes ?? []).flatMap(t => t.practices ?? []), quotes = quotations(reg);
  const count = (list, key, values) => Object.fromEntries(values.map(v => [v, list.filter(x => x[key] === v).length]));
  return {themes: (reg.themes ?? []).length, practices: all.length, ...count(all, 'status', STATUS), fit: count(all, 'fit', FIT),
    quotations: quotes.length, pages: new Set(quotes.map(q => q.url)).size, labs: [...new Set(quotes.map(q => q.lab))].sort()};
}

/**
 * Check every quotation against the pages as captured. `page(lab, url)` gives {sha256, text} or null.
 * → {checked, held, problems: [{where, lab, url, why}], changed: [urls whose page is not the one quoted from]}
 */
export function verify(reg, {page}) {
  const quotes = quotations(reg), out = {checked: quotes.length, held: 0, problems: [], changed: []};
  for (const q of quotes) {
    const p = page(q.lab, q.url);
    if (!p) { out.problems.push({where: q.where, lab: q.lab, url: q.url, why: 'the page is not captured here'}); continue; }
    if (p.sha256 !== q.sha256 && !out.changed.includes(q.url)) out.changed.push(q.url);
    if (flat(p.text).includes(flat(q.quote))) out.held++;
    else out.problems.push({where: q.where, lab: q.lab, url: q.url, why: 'the quotation is not in the page as captured'});
  }
  return out;
}

const labsOf = list => [...new Set(list.map(b => b.lab))].sort().join(', ');
const label = url => { try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? url); } catch { return url; } };
const standing = p => (p.status === 'proposed' ? 'proposed' : `${p.status === 'accepted' ? 'accepted by' : 'struck by'} the owner, ${p.decided.date}`);

/** The written page (docs/ophanim-best-practices.md). The same registry gives the same text. */
export function render(reg) {
  const r = report(reg);
  const out = ["# OPHANIM's practices, against the labs' own guidance", '',
    'Generated from `ophanim/lessons/practices.json` by `node ophanim/lessons/practices.mjs render`. Do not edit it by hand: a test holds it to the registry.', '',
    `Read ${reg.read}. ${flat(reg.method)}`, '',
    'A practice marked **proposed** is not yet OPHANIM\'s practice. It becomes one when the owner accepts it, and only then; the owner may strike it instead. Every quotation is a lab\'s own words from the page named beside it, and `node ophanim/lessons/practices.mjs verify` checks each against the captured pages.', '',
    `${r.proposed} proposed, ${r.accepted} accepted by the owner, ${r.struck} struck.`];
  for (const t of reg.themes ?? []) {
    out.push('', `## ${t.title}`, '', flat(t.covers));
    for (const [heading, points] of [['Where the labs agree', t.agree ?? []], ['Where they differ', t.differ ?? []]]) {
      if (!points.length) continue;
      out.push('', `**${heading}**`, '');
      for (const point of points) out.push(`- ${flat(point.point)} (${labsOf(point.basis ?? [])})`);
    }
    for (const p of t.practices ?? []) {
      out.push('', `### ${p.id} (${standing(p)})`, '', `**${flat(p.statement)}** ${flat(p.why)}`, '',
        `- **Today (${p.fit}):** ${flat(p.today)}${(p.today_refs ?? []).length ? ` ${p.today_refs.map(x => `\`${x}\``).join(', ')}` : ''}`);
      for (const b of p.basis ?? []) out.push(`- **${b.lab}:** "${flat(b.quote)}" [${label(b.url)}](${b.url})`);
    }
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2], reg = load();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pantheon/src/config/vendor-docs.json'), 'utf8'));
  const hosts = Object.fromEntries(Object.entries(config.labs).map(([lab, d]) => [lab, [...d.hosts, ...(d.server?.hosts ?? [])]]));
  const wrong = problems(reg, {hosts});
  for (const w of wrong) console.error(w);
  if (command === 'render' && !wrong.length) { fs.writeFileSync(DOC, render(reg)); console.log(`written: ${DOC}`); }
  else if (command === 'verify' && !wrong.length) {
    // The pages are outside the repository's history: this check runs where they have been captured.
    const {readManifest, readPage, plain} = await import('../../pantheon/src/vendor-docs/capture.mjs');
    const store = process.env.PANTHEON_VENDOR_DOCS || path.join(ROOT, '.ophanim-state/vendor-docs'), manifests = {};
    const result = verify(reg, {page: (lab, url) => {
      const m = manifests[lab] ??= readManifest({store, lab}), text = m ? readPage({store, lab, url, manifest: m}) : null;
      return text === null ? null : {sha256: m.pages.find(x => x.url === url).sha256, text: `${plain(text)}\n${text}`};
    }});
    console.log(`${result.held} of ${result.checked} quotations are in their pages as captured; ${result.changed.length} page(s) changed since they were quoted`);
    for (const p of result.problems) console.log(`  ${p.where} ${p.lab} ${p.url}: ${p.why}`);
    process.exitCode = result.problems.length ? 2 : 0;
  } else if (command === 'report' && !wrong.length) console.log(JSON.stringify(report(reg), null, 1));
  else if (!wrong.length) { console.error('usage: practices.mjs report|render|verify'); process.exitCode = 1; }
  if (wrong.length) process.exitCode = 1;
}
