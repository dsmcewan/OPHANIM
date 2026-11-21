// THE ITEM'S RESEARCH AS THE LEDGER RECORDS IT (work.research; operate/research.mjs). Pure views over those records, with
// no provider, session or file behind them: what was asked, what is still open, what was concluded, the one view the
// dossier shows of it, and who contributed. Kept apart from research.mjs so that the dossier and the gates can read them
// without loading the transport.
import {openResearchRequests} from './work-ledger.mjs';

/** The bytes of the research view a dossier delivers (context.mjs cuts the view here; a plan is given what is inside them). */
export const RESEARCH_VIEW_BYTES = 6000;
/** The item's research on the ledger: {requests, open, teams, conclusions}. */
export function researchOf(work, item) {
  const all = work?.research ? work.research(item) : [];
  return {all, requests: all.filter(r => r.phase === 'request'), open: openResearchRequests(all), teams: all.filter(r => r.phase === 'team'), conclusions: all.filter(r => r.phase === 'conclusion')};
}
/**
 * The item's research as ONE view of its dossier, or null when there is none: every conclusion's concise, source-linked
 * findings and every request still open. Its bytes are its version (context.mjs): new findings are new evidence.
 */
export function researchView(work, item, {bytes = RESEARCH_VIEW_BYTES} = {}) {
  const r = researchOf(work, item);
  if (!r.conclusions.length && !r.open.length) return null;
  const size = s => Buffer.byteLength(s, 'utf8');
  const cut = (s, n) => { if (size(s) <= n) return s; let out = s.slice(0, n); while (size(out) > n) out = out.slice(0, -1); return out; };
  // WHAT IS SHOWN FIRST IS WHAT A PLAN MOST NEEDS: the requests still open, then the conclusions that say they change
  // what a plan should rest on, newest first, then the rest, newest first. Each conclusion has an equal share of the
  // view, so one long conclusion cannot push another out (independent review of ea858a6..af23623, lifecycle finding 2:
  // the oldest were kept, a later material conclusion fell outside the cut, and the plan recorded it as given).
  const head = r.open.map(q => `## Research requested and not yet answered (${q.trigger}, by ${q.by}): ${q.question}\n`);
  const ordered = [...r.conclusions].map((c, i) => ({c, i})).sort((a, b) => (b.c.material === true) - (a.c.material === true) || b.i - a.i).map(x => x.c);
  const share = Math.max(400, Math.floor((bytes - size(head.join('\n'))) / Math.max(1, ordered.length)));
  const parts = [...head], given = [];
  let used = size(head.join('\n'));
  for (const c of ordered) {
    const t = r.teams.find(x => x.team === c.team);
    const whole = [`## Research team ${c.team} (${t?.role ?? 'research'}; trigger: ${t?.trigger ?? 'unknown'}): ${c.status}${c.material ? '; MATERIAL: what was found changes what a plan should rest on' : ''}`,
      `question: ${t?.question ?? '(not recorded)'}`, ...(c.summary ? [`answer: ${c.summary}`] : []), c.findings_text || '(no finding)'].join('\n');
    const note = `\n(cut here: the rest of this team's findings is in its conclusion on the work ledger, ${c.hash})`;
    const block = (size(whole) <= share ? whole : cut(whole, share - size(note)) + note) + '\n';
    // GIVEN means its block is inside the bytes the dossier delivers: the heading, the answer and the first findings.
    if (used + size(block) + 1 <= bytes) given.push(c.hash);
    parts.push(block); used += size(block) + 1;
  }
  return {text: parts.join('\n').trimEnd(), as_of: (r.conclusions.at(-1) ?? r.open.at(-1)).at, given};
}

/** Every member of the item's concluded research that answered: {team, node, kind, depth, vendor, requested_model, served_model, served_model_source}. */
export const researchContributors = (work, item) => researchOf(work, item).conclusions.flatMap(c => (c.contributors ?? []).map(x => ({team: c.team, ...x})));

