// THE ITEM'S RESEARCH AS THE LEDGER RECORDS IT (work.research; operate/research.mjs). Pure views over those records, with
// no provider, session or file behind them: what was asked, what is still open, what was concluded, the one view the
// dossier shows of it, and who contributed. Kept apart from research.mjs so that the dossier and the gates can read them
// without loading the transport.
import {openResearchRequests} from './work-ledger.mjs';

/** The item's research on the ledger: {requests, open, teams, conclusions}. */
export function researchOf(work, item) {
  const all = work?.research ? work.research(item) : [];
  return {all, requests: all.filter(r => r.phase === 'request'), open: openResearchRequests(all), teams: all.filter(r => r.phase === 'team'), conclusions: all.filter(r => r.phase === 'conclusion')};
}
/**
 * The item's research as ONE view of its dossier, or null when there is none: every conclusion's concise, source-linked
 * findings and every request still open. Its bytes are its version (context.mjs): new findings are new evidence.
 */
export function researchView(work, item) {
  const r = researchOf(work, item);
  if (!r.conclusions.length && !r.open.length) return null;
  const lines = [];
  for (const c of r.conclusions) {
    const t = r.teams.find(x => x.team === c.team);
    lines.push(`## Research team ${c.team} (${t?.role ?? 'research'}; trigger: ${t?.trigger ?? 'unknown'}): ${c.status}${c.material ? '; MATERIAL: what was found changes what a plan should rest on' : ''}`,
      `question: ${t?.question ?? '(not recorded)'}`, ...(c.summary ? [`answer: ${c.summary}`] : []), c.findings_text || '(no finding)', '');
  }
  for (const q of r.open) lines.push(`## Research requested and not yet answered (${q.trigger}, by ${q.by}): ${q.question}`, '');
  return {text: lines.join('\n').trimEnd(), as_of: (r.conclusions.at(-1) ?? r.open.at(-1)).at};
}

/** Every member of the item's concluded research that answered: {team, node, kind, depth, vendor, requested_model, served_model, served_model_source}. */
export const researchContributors = (work, item) => researchOf(work, item).conclusions.flatMap(c => (c.contributors ?? []).map(x => ({team: c.team, ...x})));

