// The terminal rule: a turn is accepted only on the provider's own successful terminal state.
// Independent review 2026-11-16, CO2 (mutants C1, C2): this package's own tests killed neither
// terminal-rule mutant; only Pantheon's registry walk did, so the package could not defend its central
// rule alone. These cases pin the rule here, both as the shared table and through exchange().
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terminalState,successfulStop,SUCCESSFUL_STOPS} from '../terminal.mjs';
import {exchange} from '../wire.mjs';

test('Messages: only end_turn, tool_use and stop_sequence are successful stops; max_tokens is truncation',()=>{
  assert.deepEqual([...SUCCESSFUL_STOPS].sort(),['end_turn','stop_sequence','tool_use']);
  for(const stop of ['end_turn','tool_use','stop_sequence']){
    assert.equal(successfulStop(stop),true,stop);
    assert.deepEqual(terminalState('messages',{stopReason:stop}),{complete:true,state:stop,why:null});
  }
  for(const stop of ['max_tokens','pause_turn','refusal','model_context_window_exceeded']){
    assert.equal(successfulStop(stop),false,stop);
    assert.deepEqual(terminalState('messages',{stopReason:stop}),{complete:false,state:stop,why:`provider stopped with ${stop}`});
  }
  assert.deepEqual(terminalState('messages',{}),{complete:false,state:null,why:'provider reported no stop reason'});
});

test('Responses: only status completed is complete; incomplete, failed and in-progress are not',()=>{
  assert.deepEqual(terminalState('responses',{status:'completed'}),{complete:true,state:'completed',why:null});
  for(const status of ['incomplete','failed','in_progress','queued','cancelled']){
    assert.deepEqual(terminalState('responses',{status}),{complete:false,state:status,why:`provider response status is ${status}`},status);
  }
  assert.deepEqual(terminalState('responses',{}),{complete:false,state:null,why:'provider reported no response status'});
});

test('GenAI: only STOP is complete, and a blocked prompt never is',()=>{
  assert.equal(terminalState('genai',{finishReason:'STOP'}).complete,true);
  for(const finishReason of ['MAX_TOKENS','SAFETY','RECITATION','OTHER'])assert.equal(terminalState('genai',{finishReason}).complete,false,finishReason);
  assert.equal(terminalState('genai',{finishReason:'STOP',blocked:true}).complete,false);
  assert.equal(terminalState('genai',{}).complete,false);
  assert.throws(()=>terminalState('carrier-pigeon',{}),/Unknown surface/);
});

// The same rule through the wire: a Messages turn that stopped on max_tokens is never complete, on the
// unary path or the streaming path, however much text it produced.
test('exchange() refuses a Messages turn truncated by max_tokens, unary and streaming',async()=>{
  const prepared={vendor:'anthropic',cap:{surface:'messages'},request:{model:'m',messages:[]},options:{},history:[],prompt:'q'};
  const content=[{type:'text',text:'partial answer'}];
  for(const [stop,want] of [['end_turn',true],['max_tokens',false]]){
    const unary=await exchange(prepared,{messages:{create:async()=>({id:'r',stop_reason:stop,content,usage:{}})}});
    assert.equal(unary.complete,want,`unary ${stop}`);
    assert.equal(unary.terminal_state,stop);
    const stream=await exchange(prepared,{messages:{create:async function*(){
      yield {type:'content_block_start',index:0,content_block:{type:'text',text:''}};
      yield {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial answer'}};
      yield {type:'message_delta',delta:{stop_reason:stop},usage:{}};
      yield {type:'message_stop'};
    }}},()=>{});
    assert.equal(stream.complete,want,`streaming ${stop}`);
    assert.equal(stream.terminal_state,stop);
  }
});
