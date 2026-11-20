// The model catalogue: every model a lab's documentation describes, used here or not, with what its own page states.
//
// A catalogued model is not a registered one. The registry (config/models.json) says what this repository may seat; the
// catalogue says what the lab publishes, so that a model released yesterday is visible the day it is looked for and nothing
// is routed to it by being seen.
//
// Every figure is the page's own: the line it stands on is kept beside the value, and what the page does not state is
// absent from the record, never filled in. The four labs lay their model pages out differently, so each has its own reading
// below; a page a reading cannot find a model id on is reported as unread, not guessed at.
export const SCHEMA = "pantheon.vendor-catalog/v1";

const line = (text, re) => { const m = re.exec(text); return m ? { m, quote: m[0].trim() } : null; };
const ticks = s => [...String(s).matchAll(/`([^`]+)`/g)].map(m => m[1]);
/** "1,050,000", "1M", "128K", "500k" as a count of tokens; null when it is not one of those forms. */
export function tokens(s) {
  const m = /^\s*([\d][\d,]*(?:\.\d+)?)\s*([KkMm])?\b/.exec(String(s));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000) : 1));
}
const count = (text, re) => { const f = line(text, re); if (!f) return undefined; const value = tokens(f.m[1]); return value === null ? undefined : { value, quote: f.quote }; };
const said = (text, re) => { const f = line(text, re); return f ? { value: f.m[1].trim(), quote: f.quote } : undefined; };
/** The part of a page under one heading, up to the next heading of the same or a higher level. */
function under(text, heading) {
  const m = new RegExp(`^(#{1,6})\\s+${heading}\\s*$`, "m").exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const end = new RegExp(`^#{1,${m[1].length}}\\s`, "m").exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}
const items = block => [...block.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)].map(m => m[1]);
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)));

const openai = {
  page: /^https:\/\/developers\.openai\.com\/api\/docs\/models\/(?!all\.md$|compare\.md$)[^/?#]+\.md$/,
  read(text) {
    const id = said(text, /^Model ID: `([^`]+)`\s*$/m);
    if (!id) return [];
    // The sentence runs over a line break on some pages, so it is read to its full stop and quoted as one line.
    const sentence = /`reasoning\.effort` supports ([\s\S]{1,400}?)\.(?=\s|$)/.exec(text);
    const efforts = sentence ? { m: sentence, quote: sentence[0].replace(/\s+/g, " ") } : null;
    const preset = efforts ? /`([^`]+)` \(default\)/.exec(efforts.m[1]) : null;
    const supports = {};
    for (const m of under(text, "Endpoints").matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*(Supported|Not supported)\s*\|\s*$/gm)) supports[m[2]] = m[3];
    return [{ id: id.value, name: said(text, /^# (.+?)\s*$/m)?.value,
      aliases: items(under(text, "Snapshots")).flatMap(i => ticks(i)).filter(a => a !== id.value),
      status: said(text, /^Status: (.+?)\s*$/m),
      facts: drop({
        context_window: count(text, /^- ([\d,]+) context window\s*$/m),
        max_input: count(text, /^- Maximum input tokens: ([\d,]+)\s*$/m),
        max_output: count(text, /^- ([\d,]+) max output tokens\s*$/m),
        efforts: efforts ? { values: ticks(efforts.m[1]), quote: efforts.quote } : undefined,
        effort_default: preset ? { value: preset[1], quote: efforts.quote } : undefined,
        // Said in prose on some pages and not as a list: kept as the page words it, for a person to read.
        reasoning_notes: [...text.matchAll(/^.*reasoning effort.*$/gim)].map(m => m[0].trim()),
        input: said(text, /^- Input modalities: (.+?)\s*$/m), output: said(text, /^- Output modalities: (.+?)\s*$/m),
        knowledge_cutoff: said(text, /^- (.+?) knowledge cutoff\s*$/m),
        supports, features: items(under(text, "Supported features")), tools: items(under(text, "Supported tools")),
      }) }];
  },
};

const xai = {
  page: /^https:\/\/docs\.x\.ai\/developers\/models\/[^/?#]+\.md$/,
  read(text) {
    const id = said(text, /^- \*\*Model name:\*\* `([^`]+)`\s*$/m);
    if (!id) return [];
    const supported = line(text, /^- \*\*Reasoning efforts \(supported\):\*\* (.+)$/m);
    const supports = {};
    for (const m of under(text, "Capabilities").matchAll(/^- \*\*([^:*]+):\*\* (Yes|No)\s*$/gm)) supports[m[1]] = m[2];
    const batch = said(text, /^- \*\*Batch API:\*\* (.+?)\s*$/m);
    if (batch) supports["Batch API"] = batch.value;
    const aliases = line(text, /^- \*\*Aliases:\*\* (.+)$/m);
    return [{ id: id.value, name: said(text, /^# (.+?)\s*$/m)?.value, aliases: aliases ? ticks(aliases.m[1]) : [],
      status: said(text, /^.*\b(deprecated|retired)\b.*$/im),
      facts: drop({
        context_window: count(text, /^- \*\*Context window:\*\* ([\d,]+) tokens\s*$/m),
        efforts: supported ? { values: ticks(supported.m[1]), quote: supported.quote } : undefined,
        effort_default: said(text, /^- \*\*Reasoning efforts \(default\):\*\* `([^`]+)`\s*$/m),
        modalities: said(text, /^- \*\*Modalities:\*\* (.+?)\s*$/m), supports,
      }) }];
  },
};

const google = {
  page: /^https:\/\/aistudio\.google\.com\/docs\/models\/[^/?#]+\.md$/,
  // One page can describe several models, each in its own property table that opens with "Model code". A page with no
  // such table (a managed agent's) names its model in backticks in its text: it is taken only when that name is the page's own.
  read(text, url) {
    const name = said(text, /^# (.+?)\s*$/m)?.value;
    const starts = [...text.matchAll(/Model code\s*$/gm)].map(m => m.index);
    // A family page can say of one model that it is deprecated. The sentence belongs to the model it names; a page about
    // one model alone may say it without naming it.
    const ended = [...text.matchAll(/^.*?\b(deprecated|shut down)\b.*$/gim)].map(m => ({ value: m[1].toLowerCase(), quote: m[0].trim() }));
    const statusOf = (id, alone) => ended.find(e => ticks(e.quote).includes(id)) ?? (alone ? ended.find(e => !ticks(e.quote).length) : undefined);
    if (!starts.length) {
      const own = decodeURIComponent(new URL(url).pathname.split("/").pop().replace(/\.md$/, ""));
      return ticks(text).includes(own) ? [{ id: own, name, aliases: [], status: statusOf(own, true), facts: {} }] : [];
    }
    return starts.flatMap((at, i) => {
      const block = text.slice(at, starts[i + 1] ?? text.length);
      const codes = ticks(block.split(/\n\s*---/)[0]);
      if (!codes.length) return [];
      const supports = {};
      for (const m of block.matchAll(/\[\*\*([^*\]]+)\*\*\]\([^)]*\)\s*\{% badge (?:label=(.*?) )?type="([a-z-]+)" \/%\}/g)) supports[m[1]] = (m[2] ?? (m[3] === "supported" ? "Supported" : "Not supported")).trim();
      for (const m of block.matchAll(/\[\*\*([^*\]]+)\*\*\]\([^)]*\)[ \t]+((?:Supported|Not supported)[^\n]*)/g)) supports[m[1]] ??= m[2].trim();
      const thinking = /^Supported \(([a-z, ]+)\)$/.exec(supports.Thinking ?? "");
      return [{ id: codes[0], name, aliases: codes.filter((c, j) => j > 0 && c !== codes[0]),
        status: statusOf(codes[0], starts.length === 1),
        facts: drop({
          context_window: count(block, /\*\*(?:Context window[^*]*|Input token limit|Input context window)\*\*\s*([\d,]+)/),
          max_output: count(block, /\*\*(?:Output token limit|Max output)\*\*\s*([\d,]+)[^\n]*/),
          efforts: thinking ? { values: thinking[1].split(",").map(s => s.trim()), quote: `Thinking: ${supports.Thinking}` } : undefined,
          input: said(block, /\*\*Inputs?\*\*\s*([^\n]+)/), output: said(block, /\*\*Output\*\*\s*([^\n]+)/),
          supports,
        }) }];
    });
  },
};

const anthropic = {
  page: /^https:\/\/platform\.claude\.com\/docs\/en\/models\/[^/?#]+\/overview\.md$/,
  read(text) {
    const id = said(text, /^Model ID: `([^`]+)`\s*$/m);
    if (!id) return [];
    const row = label => said(text, new RegExp(`^\\|\\s*(?:\\[${label}\\]\\([^)]*\\)|${label})\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m"));
    const summary = line(text, /^Context window: (.+?) · Max output: (.+?)(?: ·.*)?$/m);
    const effort = row("Default effort");
    const lifecycle = line(text, /^\*\*([A-Z][A-Za-z ]+)\.\*\*\s*(.*)$/m);
    return [{ id: id.value, name: said(text, /^title: (.+?)\s*$/m)?.value, aliases: [],
      status: lifecycle ? { value: lifecycle.m[1], quote: lifecycle.quote } : undefined,
      facts: drop({
        context_window: summary && tokens(summary.m[1]) !== null ? { value: tokens(summary.m[1]), quote: summary.quote } : undefined,
        max_output: summary && tokens(summary.m[2]) !== null ? { value: tokens(summary.m[2]), quote: summary.quote } : undefined,
        effort_default: effort ? { value: ticks(effort.value)[0] ?? effort.value, quote: effort.quote } : undefined,
        thinking: row("Thinking"), modalities: row("Input → output"), knowledge_cutoff: row("Reliable knowledge cutoff"),
      }) }];
  },
};

export const LAYOUTS = Object.freeze({ openai, xai, google, anthropic });

/**
 * The catalogue of one lab from a capture: {schema, lab, read, models: {id: {name, page, sha256, aliases, status?, facts}},
 * unread: [{url, why}]}. `text(page)` gives a captured page's text. Models are keyed and ordered by id.
 */
export function catalogue({ lab, manifest, text, layout = LAYOUTS[lab] }) {
  if (!layout) throw Object.assign(new Error(`no reading of model pages is written for the lab ${lab}`), { code: "VENDOR_LAYOUT_UNKNOWN" });
  const models = {}, unread = [];
  for (const page of manifest.pages.filter(p => layout.page.test(p.url)).sort((a, b) => (a.url < b.url ? -1 : 1))) {
    if (page.status !== "captured") { unread.push({ url: page.url, why: `not captured: ${page.why ?? page.status}` }); continue; }
    const found = layout.read(text(page), page.url);
    if (!found.length) { unread.push({ url: page.url, why: "no model id where this lab's model pages state one" }); continue; }
    for (const m of found) {
      // The first page to describe an id keeps it (a lab describes some models on a family page as well as their own).
      // The other page is named beside it, so the second description is known to exist and is not merged in unseen.
      if (models[m.id]) { (models[m.id].also ??= []).push(page.url); continue; }
      models[m.id] = drop({ name: m.name, page: page.url, sha256: page.sha256, aliases: [...new Set(m.aliases ?? [])].sort(), status: m.status, facts: m.facts ?? {} });
      models[m.id].aliases ??= []; models[m.id].facts ??= {};
    }
  }
  return { schema: SCHEMA, lab, read: manifest.read, models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1))), unread };
}

/**
 * The catalogue to keep, given the one kept before: each model carries the day it was first seen, and a model the lab no
 * longer describes stays, with the day it was found gone and its last record. A model seen again is no longer gone.
 */
export function keep(previous, fresh, { day = String(fresh.read).slice(0, 10) } = {}) {
  const models = {};
  for (const [id, m] of Object.entries(fresh.models)) models[id] = { first_seen: previous?.models?.[id]?.first_seen ?? day, ...m };
  for (const [id, m] of Object.entries(previous?.models ?? {})) if (!models[id]) models[id] = { ...m, gone_since: m.gone_since ?? day };
  return { ...fresh, models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1))) };
}
