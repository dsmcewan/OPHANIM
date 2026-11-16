import models from './models.json' with {type:'json'};
export {models};
export const modelId=(vendor,name)=>{
  const id=models[vendor]?.[name];
  if(!id) throw new Error(`Unknown model alias ${vendor}/${name}`);
  return id;
};
export const CAPABILITIES=Object.freeze({
  [modelId('anthropic','fable')]:{vendor:'anthropic',surface:'messages',window:1000000,output:128000,efforts:['low','medium','high','xhigh','max'],compaction:true},
  [modelId('google','carbon')]:{vendor:'agy_google',surface:'genai',window:1048576,output:262144,efforts:['low','medium','high'],combined:true},
  [modelId('google','argon')]:{vendor:'agy_google',surface:'genai',window:1048576,output:262144,efforts:['low','medium','high'],combined:true},
  [modelId('openai','astra')]:{vendor:'openai',surface:'responses',window:1050000,output:128000,efforts:['low','medium','high','xhigh','max'],inputCeiling:250000},
  [modelId('xai','grok-4.3')]:{vendor:'xai',surface:'responses',window:1000000,output:null,efforts:['none','low','medium','high','xhigh']},
  [modelId('xai','grok-4.7')]:{vendor:'xai',surface:'responses',window:500000,output:null,efforts:['low','medium','high','xhigh']},
  // Moved from the direct path 2026-11-16: every figure is cited in pantheon/src/config/capability-facts.json.
  // providerDefaults: no frontier policy is imposed where the caller names none. Effort is left to the
  // provider's documented default, and Responses output to the provider's; Messages still needs an
  // explicit max_tokens (Pantheon's output tiers supply it). The move changes the path, not the request.
  // gemini-3.6-flash stays direct: Pantheon sends every non-frontier agy_google seat through the agy
  // transports (OAuth), so moving it would reroute the agy seats onto the metered API.
  [modelId('openai','luna')]:{vendor:'openai',surface:'responses',window:1050000,output:128000,efforts:['none','low','medium','high','xhigh','max'],providerDefaults:true},
  [modelId('openai','sol')]:{vendor:'openai',surface:'responses',window:1050000,output:128000,efforts:['none','low','medium','high','xhigh','max'],providerDefaults:true},
  [modelId('openai','sol-6.1')]:{vendor:'openai',surface:'responses',window:1050000,output:128000,efforts:['low','medium','high','xhigh','max'],providerDefaults:true},
  [modelId('anthropic','sonnet')]:{vendor:'anthropic',surface:'messages',window:1000000,output:128000,efforts:['low','medium','high','xhigh','max'],providerDefaults:true},
  [modelId('anthropic','opus')]:{vendor:'anthropic',surface:'messages',window:1000000,output:128000,efforts:['low','medium','high','xhigh','max'],providerDefaults:true},
  [modelId('anthropic','opus-5-5')]:{vendor:'anthropic',surface:'messages',window:1000000,output:128000,efforts:['low','medium','high','xhigh','max'],providerDefaults:true},
});
export const isFrontier=model=>Object.hasOwn(CAPABILITIES,model);
