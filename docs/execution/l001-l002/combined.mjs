// "Combined" check: with the fourth-lab preference, how often is the RETURNING DISPATCHER the validator,
// without vs with L-001 (the dispatcher recorded as a contributor)? Same 324-combination grid as l001.mjs.
const R=new URL('../../../', import.meta.url).pathname;
const {SEATING, candidatesFor} = await import(R+'pantheon/src/role/seating.mjs');
const {resolveModel, contributorKeys, candidateRefusal} = await import(R+'pantheon/src/review/identity.mjs');
const {reviewSeatsByModel} = await import(R+'pantheon/src/ledger/review-cycle.mjs');
const {FIT_MATRIX, IMPLEMENTER_LADDERS} = await import(R+'pantheon/src/route/fit-matrix.mjs');
const id = s => resolveModel(s.vendor, s.model)?.id;
const row = (purpose, s) => ({purpose, vendor: s.vendor, model: s.model, lab: resolveModel(s.vendor, s.model)?.lab});
const pool = new Map();
for (const role of ['reviewer', ...Object.keys(SEATING).filter(r=>r!=='reviewer')]) for (const c of candidatesFor(role)) { const r = resolveModel(c.vendor,c.model); if (!r?.known) continue; if(!pool.has(r.lab)) pool.set(r.lab, []); if(!pool.get(r.lab).some(x=>x.id===r.id)) pool.get(r.lab).push({id:r.id,vendor:c.vendor,model:c.model}); }
const eligible = contribs => { const k = contributorKeys(contribs); return [...pool].map(([lab,a])=>[lab, a.filter(x=>!candidateRefusal({vendor:x.vendor,model:x.model},k)).map(x=>x.id)]); };
const P = c => { try { return reviewSeatsByModel({n:3, contributions:c}) } catch { return null } };
// validator with the fourth-lab preference: exclude contributors + the 3 reviewers, then prefer a lab outside the panel
const validator = (c, panel) => {
  const withRev = [...c, ...panel.map(s=>({purpose:'reviewer', vendor:s.vendor, model:s.model, lab:s.lab}))];
  const el = eligible(withRev), panelLabs = new Set(panel.map(s=>s.lab));
  const off = el.filter(([l,a])=>!panelLabs.has(l)&&a.length), on = el.filter(([l,a])=>panelLabs.has(l)&&a.length);
  const first = (off.length ? off : on)[0];
  return first ? {id:first[1][0], fourth: off.length>0} : null;
};
const sol = {vendor:'openai', model:'gpt-6-sol'}, g47 = {vendor:'xai', model:'grok-4.7'};
const subsets = [['easy'],['medium'],['hard'],['easy','medium'],['easy','hard'],['medium','hard'],['easy','medium','hard']];
let total=0, withoutL001=0, withL001=0, pendWith=0, pendWithout=0;
for (const pd of ['easy','medium','hard']) for (const units of subsets) for (const sub of [false,true]) for (const ladder of ['first','all']) for (const finders of [[],[sol],[sol,g47]]) for (const dOld of ['easy','medium','hard']) {
  if (units.includes(dOld)) continue;
  const c = [row('plan', FIT_MATRIX.planner[pd]), ...finders.map(f=>row('critique',f))];
  for (const d of units) { for (const s of (ladder==='first'?IMPLEMENTER_LADDERS[d].slice(0,1):IMPLEMENTER_LADDERS[d])) c.push(row('work',s)); if (sub) c.push(row('subtask',FIT_MATRIX.subagent[d])); c.push(row('arbiter',FIT_MATRIX.dispatcher[d])); }
  const D = row('arbiter', FIT_MATRIX.dispatcher[dOld]), dId = id(D);
  total++;
  const p0 = P(c); if (p0) { const v0 = validator(c, p0); if (v0?.id===dId) withoutL001++; if (!v0) pendWithout++; }
  const c1 = [...c, D], p1 = P(c1); if (p1) { const v1 = validator(c1, p1); if (v1?.id===dId) withL001++; if (!v1) pendWith++; }
}
console.log(JSON.stringify({total, dispatcherIsValidator_withoutL001: withoutL001, dispatcherIsValidator_withL001: withL001, validatorPending_withoutL001: pendWithout, validatorPending_withL001: pendWith}));
