import {prepareRequest,checkBudget,compactConversation} from './request.mjs';
import {boundedCall} from './router.mjs';
import {exchange} from './wire.mjs';
import {CAPABILITIES} from './registry.mjs';
import {googleCountConfig} from './google-count.mjs';

// THE PROVIDER CALL (docs/routing-task-profile.md, "What one provider call is"; self-audit round 3, assignment 3 (sealed
// bb1287a), L-301): one billed GENERATION request -- a compaction, the turn's request, and each Google continuation hop
// (up to 16, each billed). `onRequest` (optional) is called BEFORE EVERY ONE of them, the first included, with
// {request: n, kind: 'compaction' | 'generation'}; a throw refuses it and nothing is sent. Token counts (countTokens,
// inputTokens.count) are not generation requests and are not charged (L-604).
export const GENERATION_METHODS=Object.freeze({responses:['create'],messages:['create'],models:['generateContent','generateContentStream']});
/** `client` with every generation method preceded by `onRequest` (see above); the original client is not changed. */
export function chargedClient(client,onRequest,{kind=()=>'generation'}={}){
  if(typeof onRequest!=='function')return client;
  let n=0;
  const wrap=(resource,methods)=>{
    if(!resource)return resource;
    const o=Object.create(resource);
    for(const m of methods)if(typeof resource[m]==='function')o[m]=async(...a)=>{await onRequest({request:++n,kind:kind(m,a)});return resource[m](...a);};
    return o;
  };
  const c=Object.create(client);
  for(const [name,methods] of Object.entries(GENERATION_METHODS))if(client[name])c[name]=wrap(client[name],methods);
  if(client.beta?.messages)c.beta=Object.assign(Object.create(client.beta),{messages:wrap(client.beta.messages,GENERATION_METHODS.messages)});
  return c;
}

export async function sendModelTurn({client,onEvent,countTokens,beforeGenerate,onRequest,responseMode='any',compactAfterBytes=512000,deadline=Date.now()+900000,...args}){
  if(!client)throw new Error('SDK client required');
  if(!['any','text_only'].includes(responseMode))throw new Error('Unsupported response mode');
  if(beforeGenerate!==undefined&&typeof beforeGenerate!=='function')throw new Error('Invalid generation preflight');
  if(onRequest!==undefined&&typeof onRequest!=='function')throw new Error('Invalid request charge');
  // Every billed request through the charge; a compaction is the request made with a `compaction` body.
  client=chargedClient(client,onRequest,{kind:(m,a)=>a?.[0]?.compaction?'compaction':'generation'});
  return boundedCall(async signal=>{
    signal.throwIfAborted();
    let history=args.history??[];
    let compacted=false;
    if(CAPABILITIES[args.model]?.compaction&&history.length&&Buffer.byteLength(JSON.stringify(history))>=compactAfterBytes){
      history=await compactConversation({client,model:args.model,history,system:args.extra?.system,tools:args.extra?.tools,signal});
      compacted=true;
    }
    signal.throwIfAborted();
    const prepared=prepareRequest({...args,history,signal});
    if(prepared.options.headers['anthropic-beta'])prepared.options.headers['anthropic-beta']=
      [...(client.argoBetaHeaders??[]),prepared.options.headers['anthropic-beta']].join(',');
    const counter=countTokens??providerTokenCounter(client,prepared,signal);
    await checkBudget(prepared,counter);
    signal.throwIfAborted();
    if(Date.now()>=deadline)throw new Error('Request deadline exceeded');
    await beforeGenerate?.({signal});
    signal.throwIfAborted();
    if(Date.now()>=deadline)throw new Error('Request deadline exceeded');
    return {...await exchange({...prepared,responseMode,...(args.label?{label:args.label}:{})},client,onEvent),compacted};
  },{signal:args.signal,deadline});
}

// The provider's own input count, where its SDK exposes one; undefined where none is supported.
export function providerTokenCounter(client,{cap,options},signal){
  if(cap.surface==='messages'){
    const beta=options?.headers?.['anthropic-beta'];
    const messages=beta?(client.beta?.messages??client.messages):client.messages;
    if(typeof messages?.countTokens!=='function')return undefined;
    return async request=>{
      // The count endpoint's input fields: system, tools and the whole message history.
      const keys=['model','messages','system','tools','tool_choice','thinking'];
      const body=Object.fromEntries(keys.filter(k=>request[k]!==undefined).map(k=>[k,request[k]]));
      return (await messages.countTokens(body,{...(signal?{signal}:{}),...(beta?{headers:{'anthropic-beta':beta}}:{})})).input_tokens;
    };
  }
  if(cap.vendor==='openai'&&client.responses?.inputTokens?.count){
    return async request=>{
      // These are the input-count endpoint's fields; output caps/store/cache hints are not inputs.
      const keys=['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','previous_response_id','conversation','truncation'];
      const body=Object.fromEntries(keys.filter(k=>request[k]!==undefined).map(k=>[k,request[k]]));
      return (await client.responses.inputTokens.count(body,{signal})).input_tokens;
    };
  }
  if(cap.vendor==='agy_google'&&client.models?.countTokens){
    return async request=>{
      const {model,contents,config={}}=request;
      // The Developer API SDK's CountTokensConfig rejects system/tools/generationConfig.
      // Its REST countTokens endpoint accepts generateContentRequest instead. Inject the full
      // count request through the SDK's documented extraBody hook; omit the alternative contents.
      const {systemInstruction,tools,toolConfig,safetySettings,...generationConfig}=googleCountConfig(config);
      const full=systemInstruction!==undefined||tools!==undefined||toolConfig!==undefined||safetySettings!==undefined||generationConfig.responseSchema||generationConfig.responseJsonSchema;
      const body={model:`models/${model}`,contents,
        ...(systemInstruction!==undefined?{systemInstruction}:{}),
        ...(tools!==undefined?{tools}:{}),...(toolConfig!==undefined?{toolConfig}:{}),
        ...(safetySettings!==undefined?{safetySettings}:{}),generationConfig};
      return (await client.models.countTokens({model,...(full?{}:{contents}),config:{abortSignal:signal,
        ...(full?{httpOptions:{extraBody:{generateContentRequest:body}}}:{})}})).totalTokens;
    };
  }
  return undefined;
}
