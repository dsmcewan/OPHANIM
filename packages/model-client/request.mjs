import {createHash} from 'node:crypto';
import {CAPABILITIES} from './registry.mjs';
import {reasoningContextFor} from './reasoning.mjs';

export const COMPACTION_BETA='compact-2026-09-04';
const RESERVED=new Set(['model','input','messages','contents','previous_response_id','stream']);
const count=(n,label)=>{
  if(!Number.isSafeInteger(n)||n<=0) throw new Error(`${label}: token budget must be a positive safe integer`);
  return n;
};
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;

export function cacheKey({scope,sessionId,vendor,model}){
  if(!scope||!sessionId)throw new Error('Cache identity requires explicit scope and session');
  return createHash('sha256').update(JSON.stringify(sorted({scope,sessionId,vendor,model}))).digest('hex');
}

export function prepareRequest({vendor,model,prompt,history=[],previousResponseId,continuity='replay',extra={},scope,sessionId,
  effort,architecture=false,contractHeader='',signal,outputBudgetPolicy='long_decode'}){
  const cap=CAPABILITIES[model];
  if(!cap||cap.vendor!==vendor)throw new Error('Model capability or vendor mismatch');
  if(!['long_decode','explicit'].includes(outputBudgetPolicy))throw new Error('Unsupported output budget policy');
  const outputBudget=(value,label)=>{
    if(outputBudgetPolicy==='explicit'&&value==null)throw new Error('Explicit output budget policy requires an explicit output token cap');
    return count(value??65536,label);
  };
  if(typeof prompt!=='string'||!prompt)throw new Error('Prompt is required');
  if(!Array.isArray(history))throw new Error('History must be an array');
  for(const key of Object.keys(extra))if(RESERVED.has(key))throw new Error(`Reserved request field: ${key}`);
  const e=structuredClone(extra);
  for(const key of ['temperature','top_p','top_k'])delete e[key];
  const allowed=cap.surface==='messages'
    ? ['max_tokens','max_output_tokens','thinking','tool_choice','output_config','system','tools','metadata','stop_sequences','service_tier','cache_control']
    :cap.surface==='genai'?['config','max_tokens','max_output_tokens']
    :['max_tokens','max_output_tokens','reasoning','tools','tool_choice','parallel_tool_calls','instructions','text','store','include','metadata','service_tier','truncation','prompt_cache_key'];
  for(const key of Object.keys(e))if(!allowed.includes(key))throw new Error(`Unsupported ${cap.surface} parameter: ${key}`);
  const options={...(signal?{signal}:{}),headers:{}};
  const pinned=contractHeader?`${contractHeader}\n\n${prompt}`:prompt;
  let request;
  if(cap.surface==='messages'){
    delete e.thinking;
    if(['any','tool'].includes(e.tool_choice?.type))delete e.tool_choice;
    // A providerDefaults model sends no effort unless one is asked for: the provider's default applies.
    // providerDefaults: the architecture flag imposes nothing either; only a named effort is sent.
    const depth=effort??e.output_config?.effort??(cap.providerDefaults?null:architecture?'xhigh':'high');
    if(depth!==null&&!cap.efforts.includes(depth))throw new Error('Unsupported effort for model');
    if(cap.providerDefaults&&e.max_tokens==null&&e.max_output_tokens==null)
      throw new Error('This model takes no long-decode default: pass max_tokens explicitly');
    const max=outputBudget(e.max_tokens??e.max_output_tokens,'max_tokens');
    delete e.max_output_tokens;
    if(max>cap.output)throw new Error('Output token budget exceeds model limit');
    const outputConfig=depth===null?e.output_config:{...e.output_config,effort:depth};
    delete e.output_config;
    request={...e,model,max_tokens:max,...(outputConfig&&Object.keys(outputConfig).length?{output_config:outputConfig}:{}),
      messages:[...structuredClone(history),{role:'user',content:pinned}]};
    if(history.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='compaction')))
      options.headers['anthropic-beta']=COMPACTION_BETA;
  }else if(cap.surface==='genai'){
    const config=e.config??{};
    delete e.config;
    config.maxOutputTokens??=e.max_output_tokens??e.max_tokens;
    delete e.max_output_tokens;delete e.max_tokens;
    delete config.cachedContent;
    const allowedConfig=["maxOutputTokens","thinkingConfig","systemInstruction","tools","toolConfig","responseMimeType","responseSchema","responseJsonSchema","stopSequences","safetySettings","candidateCount","temperature","topP","topK"];
    for(const key of Object.keys(config))if(!allowedConfig.includes(key))throw new Error(`Unsupported Google config parameter: ${key}`);
    for(const key of ['temperature','topP','topK'])delete config[key];
    const thinking={...config.thinkingConfig};
    delete thinking.thinkingBudget;
    const wanted=effort??thinking.thinkingLevel?.toLowerCase()??(cap.providerDefaults?null:'high');
    // `minimal` folds to `low` only on a model that does not document it.
    const depth=wanted==='minimal'&&!cap.efforts.includes('minimal')?'low':wanted;
    if(depth!==null&&!cap.efforts.includes(depth))throw new Error('Unsupported effort for model');
    if(depth!==null)thinking.thinkingLevel=depth.toUpperCase();
    if(Object.keys(thinking).length)config.thinkingConfig=thinking;else delete config.thinkingConfig;
    const max=outputBudget(config.maxOutputTokens,'maxOutputTokens');
    config.maxOutputTokens=outputBudgetPolicy==='explicit'?max:Math.max(65536,max);
    if(config.maxOutputTokens>cap.output)throw new Error('Output token budget exceeds configured long-decode bound');
    if(signal)config.abortSignal=signal;
    request={...e,model,config,contents:[...structuredClone(history),{role:'user',parts:[{text:pinned}]}]};
  }else{
    // A providerDefaults model with no named budget sends none: the provider's default applies.
    const named=e.max_output_tokens??e.max_tokens;
    const max=cap.providerDefaults&&named==null&&outputBudgetPolicy!=='explicit'?null:outputBudget(named,'max_output_tokens');
    if(max!==null&&cap.output&&max>cap.output)throw new Error('Output token budget exceeds model limit');
    delete e.max_tokens;delete e.max_output_tokens;
    const reasoning={...e.reasoning};
    // Documented for OpenAI, so it is passed through (validated) rather than stripped; see reasoning.mjs.
    const context=reasoningContextFor({vendor,model,requested:reasoning.context,continuity});
    if(context===undefined)delete reasoning.context;else reasoning.context=context;
    const depth=effort??reasoning.effort;
    if(depth&&!cap.efforts.includes(depth))throw new Error('Unsupported effort for model');
    if(depth)reasoning.effort=depth;
    const input=continuity==='replay'?[...structuredClone(history),{role:'user',content:pinned}]:pinned;
    request={...e,model,input,...(max!==null?{max_output_tokens:max}:{}),...(Object.keys(reasoning).length?{reasoning}:{}),
      ...(continuity==='replay'?{store:false,include:[...new Set([...(e.include??[]),'reasoning.encrypted_content'])]}:
        previousResponseId?{previous_response_id:previousResponseId}:{})};
    if(scope&&sessionId)request.prompt_cache_key=cacheKey({scope,sessionId,vendor,model});
  }
  return {vendor,model,cap,request,options,continuity,history:structuredClone(history),prompt:pinned,outputBudgetPolicy};
}

// The output a request may still generate, reserved before admission. A request that names no cap
// (a providerDefaults model) is reserved at the model's documented output limit, not at zero.
export const LONG_DECODE_RESERVE=65536;
export const reservedOutput=(request,cap={})=>request?.config?.maxOutputTokens??request?.max_output_tokens??request?.max_tokens
  ??cap.output??LONG_DECODE_RESERVE;

// A QUALIFIED ESTIMATE, used only where no provider count is supported: an upper bound, never a count.
// Byte-level tokenizers emit at least one UTF-8 byte per token, so the serialized input-bearing request
// (system, tools, history and prompt; output caps and transport fields excluded) bounds the input tokens
// from above. A per-item framing allowance covers role and message delimiters.
export function estimateInputTokens(request){
  if(!request||typeof request!=='object')throw new Error('Token estimate needs a request');
  const drop=new Set(['model','max_tokens','max_output_tokens','stream','store','include','prompt_cache_key','metadata','service_tier']);
  const body=Object.fromEntries(Object.entries(request).filter(([key])=>!drop.has(key)));
  if(body.config&&typeof body.config==='object'){
    const {maxOutputTokens,abortSignal,httpOptions,automaticContinuation,continuationToken,...rest}=body.config;
    body.config=rest;
  }
  const items=(Array.isArray(request.messages)?request.messages:Array.isArray(request.contents)?request.contents
    :Array.isArray(request.input)?request.input:[]).length+1;
  return Buffer.byteLength(JSON.stringify(body))+items*16+64;
}

/**
 * Context admission: the input (counted or estimated) plus the reserved output must fit a KNOWN
 * window. Every refusal names its reason in `code` and carries the figures it was decided on.
 */
export function admitContext({model,window,inputCeiling=null,output,input,basis}){
  const admission={model,window:window??null,inputCeiling:inputCeiling??null,output,input,basis};
  const refuse=(code,message)=>{throw Object.assign(new Error(message),{code,admission});};
  if(!Number.isSafeInteger(window)||window<=0)
    refuse('CONTEXT_WINDOW_UNKNOWN',`${model}: no documented context window; the request cannot be admitted against an unknown bound`);
  if(!Number.isSafeInteger(input)||input<0)refuse('CONTEXT_COUNT_INVALID','Invalid provider token count');
  if(!Number.isSafeInteger(output)||output<0)refuse('CONTEXT_OUTPUT_UNKNOWN',`${model}: no output bound to reserve`);
  if(inputCeiling&&input>=inputCeiling)refuse('INPUT_CEILING',`Input token policy requires fewer than ${inputCeiling} tokens`);
  if(input+output>window)refuse('CONTEXT_WINDOW_EXCEEDED',
    `Combined input and output exceeds model context window: ${input} input (${basis}) + ${output} reserved output > ${window}; decompose the request or choose a larger window`);
  return admission;
}

// Every frontier capability is admitted before generation, not only those with an input ceiling or a
// combined window. A provider count is used where one is supplied; a model whose policy requires one
// (inputCeiling/combined) still refuses without it; elsewhere the qualified upper-bound estimate applies.
export async function checkBudget(prepared,countTokens){
  const {cap,request,model}=prepared;
  let input,basis;
  if(typeof countTokens==='function'){
    input=await countTokens(request);
    if(!Number.isSafeInteger(input)||input<0)throw new Error('Invalid provider token count');
    basis='provider_count';
  }else if(cap.inputCeiling||cap.combined){
    throw new Error('A trustworthy provider token count is required before generation');
  }else{
    input=estimateInputTokens(request);
    basis='byte_upper_bound';
  }
  admitContext({model,window:cap.window,inputCeiling:cap.inputCeiling,output:reservedOutput(request,cap),input,basis});
  return input;
}

export async function compactConversation({client,model,history,system,tools,signal}){
  if(!CAPABILITIES[model]?.compaction)throw new Error('Model does not support configured compaction');
  if(!history?.length)throw new Error('Compaction needs a conversation');
  const pending=new Set();
  for(const m of history)for(const block of Array.isArray(m.content)?m.content:[]){
    if(block.type==='tool_use')pending.add(block.id);
    if(block.type==='tool_result')pending.delete(block.tool_use_id);
  }
  if(pending.size)throw new Error('Cannot compact an unresolved tool turn');
  const messages=client.beta?.messages??client.messages;
  const request={model,messages:structuredClone(history),max_tokens:16384,compaction:{type:'summarize'},
    ...(system!==undefined?{system}:{}),...(tools!==undefined?{tools}:{})};
  const response=await messages.create(request,{signal,headers:{'anthropic-beta':[...(client.argoBetaHeaders??[]),COMPACTION_BETA].join(',')}});
  const blocks=response?.content;
  if(response?.stop_reason!=='compaction'||!Array.isArray(blocks)||blocks.length!==1||blocks[0]?.type!=='compaction'||
    typeof blocks[0].signature!=='string'||!blocks[0].signature)throw new Error('Compaction did not return one complete signed block');
  return [{role:'assistant',content:structuredClone(blocks)}];
}
