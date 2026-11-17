// Canonical JSON and its digest: the bytes every ledger hash and signature is computed over.
//
// This is the same canonical form as ophanim/board.mjs (sorted keys, plain finite JSON only, accessors and
// cycles refused, nesting bounded at 60), copied rather than imported so the ledger core depends on
// nothing outside this package. The two must stay byte-identical: every hash already on a ledger was
// computed with it. ophanim/ledger/layering.test.mjs checks that they agree.
import {createHash} from 'node:crypto';

export function canonical(value){
  const seen=new Set();
  function walk(v,depth=0){
    if(depth>60)throw Error('JSON nesting bound exceeded');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw Error('Plain finite JSON required');
    seen.add(v);
    const out=Array.isArray(v)?v.map(item=>walk(item,depth+1)):Object.fromEntries(Object.keys(v).sort().map(k=>{
      const d=Object.getOwnPropertyDescriptor(v,k);if(d.get||d.set)throw Error('JSON accessors refused');return [k,walk(v[k],depth+1)];
    }));
    seen.delete(v);return out;
  }
  return JSON.stringify(walk(value));
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
