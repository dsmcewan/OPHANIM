import {setTimeout as delay} from 'node:timers/promises';

export function classifyFailure(error,now=Date.now()){
  const status=error?.status??error?.response?.status;
  const raw=error?.headers?.get?.('retry-after')??error?.headers?.['retry-after'];
  const numeric=Number(raw);
  const retryMs=raw==null?null:Number.isFinite(numeric)?Math.max(0,numeric*1000):Math.max(0,Date.parse(raw)-now);
  const wait=Number.isFinite(retryMs)?retryMs:null;
  const code=error?.code??error?.cause?.code;
  const detail=error?.error?.error?.details?.error_code??error?.error?.details?.error_code??code;
  const quota=['enforced_spend_limit_reached','insufficient_quota','quota_exhausted'].includes(detail);
  if(status===429)return {retryable:true,retryMs:quota?null:wait,quota:quota||wait===null};
  if(status>=500&&status<=599)return {retryable:true,retryMs:wait??1000,quota:false};
  if(['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(code)||error?.name==='APIConnectionTimeoutError')
    return {retryable:true,retryMs:1000,quota:false};
  return {retryable:false,retryMs:null,quota:false};
}

export async function boundedCall(fn,{signal,deadline=Date.now()+900000}={}){
  signal?.throwIfAborted();
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new Error('Request deadline exceeded');
  const controller=new AbortController();
  let rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const stop=reason=>{controller.abort(reason);rejectStop(reason);};
  const aborted=()=>stop(signal.reason??new DOMException('Aborted','AbortError'));
  signal?.addEventListener('abort',aborted,{once:true});
  const timer=setTimeout(()=>stop(new Error('Request deadline exceeded')),remaining);
  try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',aborted);}
}

// `admit` (optional): called before EVERY attempt -- the first and each retry of a transient failure -- with
// {vendor,model,pool,attempt}. Each attempt is its own provider request, so a caller with a call bound charges it here;
// a throw refuses the attempt (nothing is sent) and ends the routing with that error. Without it a 5xx retry inside one
// routed call was a second request no bound saw (independent review round 2, assignment 3 (Google gemini-4-carbon,
// manual, 77480d6), finding 1.1).
export async function routeCall({candidates,invoke,signal,deadline=Date.now()+900000,cooldown,maxAttempts=2,admit}){
  if(!Array.isArray(candidates)||!candidates.length||typeof invoke!=='function')throw new Error('Routing needs candidates and invoke');
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw new Error('Invalid bounded attempt policy');
  if(admit!==undefined&&typeof admit!=='function')throw new Error('admit is a function');
  const closed=new Set();
  const attempts=[];
  for(const seat of candidates){
    signal?.throwIfAborted();
    if(Date.now()>=deadline)throw new Error('Routing deadline exceeded');
    if(!seat.pool)throw new Error('Every candidate needs an explicit credential pool identity');
    if(closed.has(seat.pool))continue;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      // Another process can extend this pool's refusal while this request is waiting.
      if((await cooldown?.get(seat.pool))?.until>Date.now()){closed.add(seat.pool);break;}
      if(admit)await admit({vendor:seat.vendor,model:seat.model,pool:seat.pool,attempt});
      try{
        const value=await boundedCall(s=>invoke(seat,{signal:s,attempt}),{signal,deadline});
        await cooldown?.success(seat.pool);
        return {value,seat,attempts:[...attempts,{vendor:seat.vendor,model:seat.model,pool:seat.pool,status:'ok'}]};
      }catch(error){
        signal?.throwIfAborted();
        const failure=classifyFailure(error);
        if(!failure.retryable)throw error;
        attempts.push({vendor:seat.vendor,model:seat.model,pool:seat.pool,status:error.status??'transport'});
        const until=Date.now()+(failure.retryMs??60000);
        await cooldown?.refuse(seat.pool,{until,reason:failure.quota?'quota':'transient'});
        if(failure.quota||attempt+1===maxAttempts||until>=deadline){closed.add(seat.pool);break;}
        await delay(failure.retryMs,undefined,{signal});
      }
    }
  }
  throw Object.assign(new Error('All configured credential pools unavailable'),{code:'POOLS_UNAVAILABLE',attempts});
}
