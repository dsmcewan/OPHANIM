import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRequest,reasoningContextFor,reasoningContextReport} from '../index.mjs';

test('the frontier client passes a documented reasoning.context through instead of stripping it',()=>{
  for(const context of ['auto','current_turn','all_turns']){
    const {request}=prepareRequest({vendor:'openai',model:'gpt-6-astra',prompt:'q',extra:{reasoning:{context}}});
    assert.equal(request.reasoning.context,context);
  }
  assert.throws(()=>prepareRequest({vendor:'openai',model:'gpt-6-astra',prompt:'q',extra:{reasoning:{context:'everything'}}}),/Unknown reasoning.context/);
});

test('without a request, no undocumented mode is sent, and xAI never receives the field',()=>{
  const astra=prepareRequest({vendor:'openai',model:'gpt-6-astra',prompt:'q',continuity:'replay'});
  assert.equal(astra.request.reasoning?.context,undefined,'astra keeps its own default');
  assert.equal(reasoningContextFor({vendor:'openai',model:'gpt-6.1-sol',continuity:'replay'}),'all_turns');
  assert.equal(reasoningContextFor({vendor:'openai',model:'gpt-6.1-sol',continuity:'server'}),undefined);
  const grok=prepareRequest({vendor:'xai',model:'grok-4.7',prompt:'q'});
  assert.equal(grok.request.reasoning?.context,undefined);
  assert.throws(()=>prepareRequest({vendor:'xai',model:'grok-4.7',prompt:'q',extra:{reasoning:{context:'all_turns'}}}),/not documented for xai/);
});

test('the effective mode is what the response reports',()=>{
  assert.deepEqual(reasoningContextReport('all_turns',{reasoning:{context:'current_turn'}}),{requested:'all_turns',effective:'current_turn',honoured:false});
  assert.deepEqual(reasoningContextReport(undefined,{reasoning:{context:'current_turn'}}),{requested:null,effective:'current_turn',honoured:null});
  assert.equal(reasoningContextReport('all_turns',{}).honoured,null,'an unreported mode is unknown, not honoured');
});
