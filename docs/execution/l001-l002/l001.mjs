const R='/home/user/OPHANIM/';
const {resolveModel, contributorKeys, candidateRefusal} = await import(R+'pantheon/src/review/identity.mjs');
const {reviewSeatsByModel} = await import(R+'pantheon/src/ledger/review-cycle.mjs');
const {FIT_MATRIX, IMPLEMENTER_LADDERS} = await import(R+'pantheon/src/route/fit-matrix.mjs');
const id = s => resolveModel(s.vendor, s.model)?.id;
const row = (purpose, s) => ({purpose, vendor: s.vendor, model: s.model, lab: resolveModel(s.vendor, s.model)?.lab});
const P = c => { try { return reviewSeatsByModel({n:3, contributions:c}).map(s=>s.identity) } catch { return 'PENDING' } };
const V = c => { try { return reviewSeatsByModel({n:1, contributions:c})[0].identity } catch { return 'PENDING' } };
const sol = {vendor:'openai', model:'gpt-6-sol'}, g47={vendor:'xai',model:'grok-4.7'};
console.log('Is gpt-6.1-sol a review candidate? eligible check:', id(FIT_MATRIX.dispatcher.medium));
// 1) revised plan panel
for (const pd of ['easy','medium','hard']) {
  const base = [row('plan', FIT_MATRIX.planner[pd])];
  console.log(`plan panel (planner ${pd}):`, P(base).join(', '), '| with gpt-6-sol an earlier plan finder:', P([...base,row('plan-review',sol)]).join(', '));
  for (const dd of ['easy','medium','hard']) {
    const D = row('arbiter', FIT_MATRIX.dispatcher[dd]);
    console.log(`   +dispatcher ${id(D)} as plan-revision contributor:`, P([...base,D]).join(', '), '| and gpt-6-sol finder:', P([...base,row('plan-review',sol),D]).join(', '));
  }
}
// 2) change panel / validator, revised plan units (no unit at D_old's difficulty) with and without D_old
const subsets = [['easy'],['medium'],['hard'],['easy','medium'],['easy','hard'],['medium','hard'],['easy','medium','hard']];
let total=0, changed=0, pend=0, valChanged=0; const seatedOld = {};
for (const pd of ['easy','medium','hard']) for (const units of subsets) for (const sub of [false,true]) for (const ladder of ['first','all']) for (const finders of [[],[sol],[sol,g47]]) for (const dOld of ['easy','medium','hard']) {
  if (units.includes(dOld)) continue; // D6 already excludes it when it dispatches again
  const c = [row('plan', FIT_MATRIX.planner[pd]), ...finders.map(f=>row('critique',f))];
  for (const d of units) { for (const s of (ladder==='first'?IMPLEMENTER_LADDERS[d].slice(0,1):IMPLEMENTER_LADDERS[d])) c.push(row('work',s)); if (sub) c.push(row('subtask',FIT_MATRIX.subagent[d])); c.push(row('arbiter',FIT_MATRIX.dispatcher[d])); }
  const D = row('arbiter', FIT_MATRIX.dispatcher[dOld]);
  const p0 = P(c), v0 = V(c), p1 = P([...c,D]), v1 = V([...c,D]);
  total++;
  const oldId = id(D);
  if (Array.isArray(p0) && (p0.includes(oldId) || v0===oldId)) seatedOld[`${oldId} seated today (panel${v0===oldId?'+validator':''}) finders=${finders.map(id).join('+')||'none'}`] = (seatedOld[`${oldId} seated today (panel${v0===oldId?'+validator':''}) finders=${finders.map(id).join('+')||'none'}`]??0)+1;
  if (JSON.stringify(p0)!==JSON.stringify(p1)) changed++;
  if (p1==='PENDING' && p0!=='PENDING') pend++;
  if (v0!==v1) valChanged++;
}
console.log({total, panelChangedByExcludingDold: changed, newlyPending: pend, validatorChanged: valChanged});
console.log('cases where D_old is seated on the change panel/validator today:', JSON.stringify(seatedOld,null,1));
console.log('--- detail of cases where D_old seated today');
for (const pd of ['medium']) for (const units of subsets) for (const sub of [false,true]) for (const ladder of ['first','all']) for (const finders of [[sol],[sol,g47]]) for (const dOld of ['easy','medium','hard']) {
  if (units.includes(dOld)) continue;
  const c = [row('plan', FIT_MATRIX.planner[pd]), ...finders.map(f=>row('critique',f))];
  for (const d of units) { for (const s of (ladder==='first'?IMPLEMENTER_LADDERS[d].slice(0,1):IMPLEMENTER_LADDERS[d])) c.push(row('work',s)); if (sub) c.push(row('subtask',FIT_MATRIX.subagent[d])); c.push(row('arbiter',FIT_MATRIX.dispatcher[d])); }
  const D = row('arbiter', FIT_MATRIX.dispatcher[dOld]); const p0=P(c);
  if (Array.isArray(p0) && p0.includes(id(D))) console.log(`planner=${pd} units=${units} sub=${sub} ladder=${ladder} finders=${finders.map(id)} Dold=${id(D)} | today: ${p0} val ${V(c)} | excl: ${P([...c,D])}`);
}
