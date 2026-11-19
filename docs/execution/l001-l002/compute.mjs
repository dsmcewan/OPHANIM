const R=new URL('../../../', import.meta.url).pathname;
const {SEATING, candidatesFor} = await import(R+'pantheon/src/role/seating.mjs');
const {resolveModel, contributorKeys, candidateRefusal} = await import(R+'pantheon/src/review/identity.mjs');
const {reviewSeatsByModel, reviewSeats} = await import(R+'pantheon/src/ledger/review-cycle.mjs');
const {FIT_MATRIX, IMPLEMENTER_LADDERS} = await import(R+'pantheon/src/route/fit-matrix.mjs');
const id = s => resolveModel(s.vendor, s.model)?.id;
const row = (purpose, s) => ({purpose, vendor: s.vendor, model: s.model, lab: resolveModel(s.vendor, s.model)?.lab});
// pool: every distinct reviewable identity per lab, in seating order
const pool = new Map();
for (const role of ['reviewer', ...Object.keys(SEATING).filter(r=>r!=='reviewer')]) for (const c of candidatesFor(role)) { const r = resolveModel(c.vendor,c.model); if (!r?.known) continue; if(!pool.has(r.lab)) pool.set(r.lab, []); if (!pool.get(r.lab).some(x=>x.id===r.id)) pool.get(r.lab).push({id:r.id, vendor:c.vendor, model:c.model}); }
console.log('POOL', JSON.stringify([...pool].map(([l,a])=>[l,a.map(x=>x.id)])));
console.log('MATRIX', JSON.stringify(Object.fromEntries(Object.entries(FIT_MATRIX).map(([r,v])=>[r,Object.fromEntries(Object.entries(v).map(([d,s])=>[d,id(s)]))]))));
console.log('LADDERS', JSON.stringify(Object.fromEntries(Object.entries(IMPLEMENTER_LADDERS).map(([d,l])=>[d,l.map(id)]))));
const eligible = contribs => { const k = contributorKeys(contribs); return Object.fromEntries([...pool].map(([l,a])=>[l, a.filter(x=>!candidateRefusal({vendor:x.vendor,model:x.model},k)).map(x=>x.id)])); };
const short = s => s ? s.identity ?? id(s) : null;
const DIFFS = ['easy','medium','hard'];
const subsets = [[ 'easy'],['medium'],['hard'],['easy','medium'],['easy','hard'],['medium','hard'],['easy','medium','hard']];
const out = [];
for (const plannerD of DIFFS) for (const units of subsets) for (const sub of [false, true]) for (const ladder of ['first','all']) {
  const c = [row('plan', FIT_MATRIX.planner[plannerD])];
  for (const d of units) {
    for (const s of (ladder==='first' ? IMPLEMENTER_LADDERS[d].slice(0,1) : IMPLEMENTER_LADDERS[d])) c.push(row('work', s));
    if (sub) c.push(row('subtask', FIT_MATRIX.subagent[d]));
    c.push(row('arbiter', FIT_MATRIX.dispatcher[d]));
  }
  let panel=null, val=null, valX=null, err=null;
  try { panel = reviewSeatsByModel({n:3, contributions:c}); } catch(e){ err = 'PANEL_PENDING'; }
  if (panel) {
    try { val = reviewSeatsByModel({n:1, contributions:c})[0]; } catch { val=null; }
    const withRev = [...c, ...panel.map(s=>({purpose:'reviewer', vendor:s.vendor, model:s.model, lab:s.lab}))];
    try { valX = reviewSeatsByModel({n:1, contributions: withRev})[0]; } catch { valX = null; }
    const el = eligible(withRev);
    out.push({plannerD, units: units.join('+'), sub, ladder, panel: panel.map(short), validator: short(val), coincides: panel.some(s=>short(s)===short(val)),
      validatorIfReviewersExcluded: valX ? short(valX) : 'PENDING', eligibleAfterExcl: Object.fromEntries(Object.entries(el).map(([l,a])=>[l,a.length])), eligibleList: el});
  } else out.push({plannerD, units: units.join('+'), sub, ladder, panel: err});
}
console.log('SCENARIOS', out.length, 'coincide', out.filter(o=>o.coincides).length, 'panelPending', out.filter(o=>o.panel==='PANEL_PENDING').length, 'valPendingIfExcl', out.filter(o=>o.validatorIfReviewersExcluded==='PENDING').length);
import fs from 'node:fs'; fs.writeFileSync('scenarios.json', JSON.stringify(out,null,1));
// minimum eligible per lab after excluding reviewers
const mins = {}; for (const o of out.filter(o=>o.eligibleAfterExcl)) for (const [l,n] of Object.entries(o.eligibleAfterExcl)) mins[l] = Math.min(mins[l] ?? 99, n);
console.log('MIN eligible validator models per lab after excluding contributors+3 reviewers:', JSON.stringify(mins));
const tally = {}; for (const o of out.filter(o=>o.eligibleAfterExcl)) { const k = Object.values(o.eligibleAfterExcl).reduce((a,b)=>a+b,0); tally[k]=(tally[k]??0)+1; }
console.log('total eligible validator models after exclusion: histogram', JSON.stringify(tally));
const vt = {}; for (const o of out.filter(o=>o.validator)) vt[o.validator]=(vt[o.validator]??0)+1; console.log('validator today', JSON.stringify(vt));
const vx = {}; for (const o of out.filter(o=>o.validator)) vx[o.validatorIfReviewersExcluded]=(vx[o.validatorIfReviewersExcluded]??0)+1; console.log('validator if reviewers excluded', JSON.stringify(vx));
const pt = {}; for (const o of out.filter(o=>Array.isArray(o.panel))) { const k=o.panel.join(', '); pt[k]=(pt[k]??0)+1;} console.log('panels', JSON.stringify(pt,null,1));
