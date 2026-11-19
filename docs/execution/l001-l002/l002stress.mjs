const R='/home/user/OPHANIM/';
const {resolveModel} = await import(R+'pantheon/src/review/identity.mjs');
const {reviewSeatsByModel} = await import(R+'pantheon/src/ledger/review-cycle.mjs');
const {FIT_MATRIX, IMPLEMENTER_LADDERS} = await import(R+'pantheon/src/route/fit-matrix.mjs');
const row = (purpose, s) => ({purpose, vendor: s.vendor, model: s.model, lab: resolveModel(s.vendor, s.model)?.lab});
const P = (c,n=3) => { try { return reviewSeatsByModel({n, contributions:c}) } catch { return null } };
const S = (v,m)=>({vendor:v,model:m});
const finderSets = {none:[], 'grok-4.7':[S('xai','grok-4.7')], 'sonnet-5':[S('anthropic','claude-sonnet-5')], 'flash':[S('agy_google','gemini-3.8-flash-high')], 'grok-4.7+flash':[S('xai','grok-4.7'),S('agy_google','gemini-3.8-flash-high')], 'grok-4.7+sonnet':[S('xai','grok-4.7'),S('anthropic','claude-sonnet-5')]};
const subsets = [['easy'],['medium'],['hard'],['easy','medium'],['easy','hard'],['medium','hard'],['easy','medium','hard']];
const res = {};
for (const [fname, f] of Object.entries(finderSets)) { const r = res[fname] = {panel:0, panelPending:0, valToday:0, valExclPending:0};
 for (const pd of ['easy','medium','hard']) for (const units of subsets) for (const sub of [false,true]) for (const ladder of ['first','all']) {
  const c = [row('plan', FIT_MATRIX.planner[pd]), ...f.map(x=>row('critique',x))];
  for (const d of units) { for (const s of (ladder==='first'?IMPLEMENTER_LADDERS[d].slice(0,1):IMPLEMENTER_LADDERS[d])) c.push(row('work',s)); if (sub) c.push(row('subtask',FIT_MATRIX.subagent[d])); c.push(row('arbiter',FIT_MATRIX.dispatcher[d])); }
  const p = P(c); if (!p) { r.panelPending++; continue; } r.panel++;
  if (P(c,1)) r.valToday++;
  const v = P([...c, ...p.map(s=>({purpose:'reviewer',vendor:s.vendor,model:s.model,lab:s.lab}))],1); if (!v) { r.valExclPending++; console.log("WAIT:", fname, pd, units.join("+"), "sub="+sub, ladder, "panel", p.map(s=>s.identity).join(",")); }
 } }
console.log(JSON.stringify(res,null,1));
