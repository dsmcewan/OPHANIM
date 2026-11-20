// What there is to do when a lab's documentation is read again: a model released since the catalogue was kept, one that is
// gone or whose record changed, and every place this repository's own registry and recorded facts no longer agree with what
// the lab publishes. The check reads and compares. It registers nothing and routes nothing: adopting a model is the
// procedure in docs/model-updates.md, and where work is sent stays the owner's decision.
const ENDED = /deprecat|shut ?down|retired|sunset/i, LEGACY = /legacy/i;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shown = v => (v === undefined ? "nothing" : JSON.stringify(v));

/** What differs between two records of one model, as [{field, was, now}] over its status, aliases and facts. */
export function recordChanges(was, now) {
  const out = [];
  const add = (field, a, b) => { if (!same(a, b)) out.push({ field, was: shown(a), now: shown(b) }); };
  add("status", was.status?.value, now.status?.value);
  add("aliases", was.aliases ?? [], now.aliases ?? []);
  for (const k of [...new Set([...Object.keys(was.facts ?? {}), ...Object.keys(now.facts ?? {})])].sort()) {
    const a = was.facts?.[k], b = now.facts?.[k];
    // A fact is its value. The line it is quoted from may be reworded without the fact changing.
    add(k, a?.value ?? a?.values ?? a, b?.value ?? b?.values ?? b);
  }
  return out;
}

/**
 * Compare a lab's fresh catalogue with the kept one, the registry and the recorded capability facts.
 *   kept      the catalogue in the repository (null when none was ever kept)
 *   fresh     the catalogue just read
 *   registry  the model ids this repository registers for the lab
 *   facts     capability-facts.json's `models`
 * → {lab, findings: [{kind, id?, why}], counts: {published, registered, unregistered, pages_changed}, unregistered: [ids]}
 * Kinds: never-kept, stale, released, gone, changed, unread, registered-not-published, registered-ended (the lab calls it
 * deprecated, shut down or retired), registered-legacy (the lab still serves it and calls it legacy), fact-differs.
 */
export function check({ lab, kept, fresh, registry = [], facts = {}, today, maxAgeDays = 14 }) {
  const findings = [];
  const add = (kind, id, why) => findings.push({ kind, ...(id ? { id } : {}), why });
  const live = Object.entries(kept?.models ?? {}).filter(([, m]) => !m.gone_since);
  if (!kept) add("never-kept", null, "no catalogue of this lab is kept in the repository yet");
  else {
    const age = Math.floor((Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(kept.read).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    if (!(age <= maxAgeDays)) add("stale", null, `the kept catalogue was read ${String(kept.read).slice(0, 10)}, ${age} days before ${String(today).slice(0, 10)} (more than ${maxAgeDays})`);
    for (const [id, m] of Object.entries(fresh.models)) {
      const before = kept.models[id];
      if (!before || before.gone_since) { add("released", id, `${m.name ?? id}: described at ${m.page}${before ? ` (it was gone since ${before.gone_since})` : ""}`); continue; }
      const diff = recordChanges(before, m);
      if (diff.length) add("changed", id, diff.map(d => `${d.field}: ${d.was} -> ${d.now}`).join("; "));
    }
    for (const [id, m] of live) if (!fresh.models[id]) add("gone", id, `no longer described (it was at ${m.page})`);
  }
  for (const u of fresh.unread ?? []) add("unread", null, `${u.url}: ${u.why}`);
  // The registry against what the lab publishes now. An alias is a published name too.
  const named = new Map();
  for (const [id, m] of Object.entries(fresh.models)) { named.set(id, id); for (const a of m.aliases ?? []) if (!named.has(a)) named.set(a, id); }
  for (const id of registry) {
    // A name the capability record already says is not an API id (a lane's name for a model) is not looked for.
    if (facts[id]?.api_id === false) continue;
    const at = named.get(id);
    if (!at) { add("registered-not-published", id, "registered here, and the lab's documentation describes no model or alias of this name"); continue; }
    const m = fresh.models[at];
    const words = m.status ? `${m.status.value} ${m.status.quote ?? ""}` : "";
    if (ENDED.test(words)) add("registered-ended", id, `the lab says: ${m.status.quote ?? m.status.value}`);
    else if (LEGACY.test(words)) add("registered-legacy", id, `the lab says: ${m.status.quote ?? m.status.value}`);
    const f = facts[id];
    // A disagreement between the lab's own pages that the capability record already carries, with how it was resolved, is
    // not found again each time: the record's `conflict` is the finding.
    const differ = (what, recorded, published, field) => { if (!field?.conflict && recorded !== undefined && recorded !== null && published !== undefined && !same(recorded, published)) add("fact-differs", id, `${what}: recorded ${JSON.stringify(recorded)}, the lab's page says ${JSON.stringify(published)}`); };
    differ("context window", f?.window?.value, m.facts.context_window?.value, f?.window);
    differ("max output", f?.output?.value, m.facts.max_output?.value, f?.output);
    differ("reasoning levels", f?.efforts?.values ? [...f.efforts.values].sort() : undefined, m.facts.efforts?.values ? [...m.facts.efforts.values].sort() : undefined, f?.efforts);
  }
  const registered = new Set(registry.map(id => named.get(id)).filter(Boolean));
  const unregistered = Object.keys(fresh.models).filter(id => !registered.has(id));
  const pagesChanged = live.filter(([id, m]) => fresh.models[id] && fresh.models[id].sha256 !== m.sha256).length;
  return { lab, findings, counts: { published: Object.keys(fresh.models).length, registered: registered.size, unregistered: unregistered.length, pages_changed: pagesChanged }, unregistered };
}
