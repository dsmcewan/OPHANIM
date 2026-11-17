// Audit M5 (docs/reviews/2026-11-16-routing-coordination): usage the provider reported was not kept.
// Each case is a provider's own reporting shape; the exchange must return what it was told, whole.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {exchange} from '../wire.mjs';

const messagesPrepared=()=>({vendor:'anthropic',cap:{surface:'messages'},request:{model:'m',max_tokens:100,messages:[{role:'user',content:'q'}]},options:{headers:{}},history:[],prompt:'q'});

test('a streamed Messages turn keeps the input tokens message_start reported, beside the output message_delta reported',async()=>{
  // The provider reports input on message_start and the output count on message_delta. Keeping only the
  // last usage object lost the input count entirely.
  const client={messages:{create:async()=>(async function*(){
    yield {type:'message_start',message:{usage:{input_tokens:1234,output_tokens:1,cache_read_input_tokens:7}}};
    yield {type:'content_block_start',index:0,content_block:{type:'text',text:''}};
    yield {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hi'}};
    yield {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:56}};
    yield {type:'message_stop'};
  })()}};
  const r=await exchange(messagesPrepared(),client,()=>{});
  assert.equal(r.complete,true);
  assert.deepEqual(r.usage,{input_tokens:1234,output_tokens:56,cache_read_input_tokens:7});
});

test('a truncated streamed Messages turn still reports the usage it consumed',async()=>{
  const client={messages:{create:async()=>(async function*(){
    yield {type:'message_start',message:{usage:{input_tokens:1234,output_tokens:1}}};
    yield {type:'content_block_start',index:0,content_block:{type:'text',text:''}};
    yield {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'cut'}};
    yield {type:'message_delta',delta:{stop_reason:'max_tokens'},usage:{output_tokens:100}};
    yield {type:'message_stop'};
  })()}};
  const r=await exchange(messagesPrepared(),client,()=>{});
  assert.equal(r.complete,false);
  assert.deepEqual(r.usage,{input_tokens:1234,output_tokens:100});
});

test('Google continuation hops: each hop is its own billed request, so usage is summed across hops, not overwritten',async()=>{
  let calls=0;
  const client={models:{generateContent:async()=>++calls===1
    ?{candidates:[{content:{parts:[{text:'a'}]},finishReason:'CONTINUATION',continuationToken:'t1'}],usageMetadata:{promptTokenCount:1000,candidatesTokenCount:40,totalTokenCount:1040}}
    :{candidates:[{content:{parts:[{text:'b'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1100,candidatesTokenCount:16,totalTokenCount:1116}}}};
  const r=await exchange({vendor:'google',cap:{surface:'generateContent'},request:{config:{},contents:[]},history:[],prompt:''},client);
  assert.equal(calls,2);
  assert.deepEqual(r.usage,{promptTokenCount:2100,candidatesTokenCount:56,totalTokenCount:2156});
});

test('Google streaming: within one hop the last chunk is cumulative; across hops usage is summed',async()=>{
  let calls=0;
  const client={models:{generateContentStream:async function*(){
    if(++calls===1){
      yield {candidates:[{content:{parts:[{text:'a'}]}}],usageMetadata:{promptTokenCount:1000,candidatesTokenCount:10}};
      yield {candidates:[{content:{parts:[{text:'b'}]},finishReason:'CONTINUATION',continuationToken:'t1'}],usageMetadata:{promptTokenCount:1000,candidatesTokenCount:40}};
    }else yield {candidates:[{content:{parts:[{text:'c'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:234,candidatesTokenCount:16}};
  }}};
  const r=await exchange({vendor:'google',cap:{surface:'generateContent'},request:{config:{},contents:[]},history:[],prompt:''},client,()=>{});
  assert.deepEqual(r.usage,{promptTokenCount:1234,candidatesTokenCount:56});
});

test('a streamed Responses turn that ends incomplete keeps the usage on its terminal event',async()=>{
  const client={responses:{create:async()=>(async function*(){
    yield {type:'response.created',response:{id:'r1'}};
    yield {type:'response.output_text.delta',delta:'cut'};
    yield {type:'response.incomplete',response:{id:'r1',status:'incomplete',output:[],usage:{input_tokens:1234,output_tokens:56}}};
  })()}};
  const r=await exchange({vendor:'openai',cap:{surface:'responses',vendor:'openai'},request:{model:'m',input:'q'},options:{},history:[],prompt:'q',continuity:'server'},client,()=>{});
  assert.equal(r.complete,false);
  assert.deepEqual(r.usage,{input_tokens:1234,output_tokens:56});
});
