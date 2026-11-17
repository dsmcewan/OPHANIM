import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareRequest,checkBudget,sendModelTurn,estimateInputTokens,admitContext} from '../index.mjs';

// Audit M7: context admission must cover every frontier capability, not only those with an
// inputCeiling or a combined window. Fakes only; no request leaves the process.
const uncovered=[
  ['anthropic','claude-fable-5-2',{max_tokens:4000}],
  ['anthropic','claude-opus-5-5',{max_tokens:4000}],
  ['openai','gpt-6-sol',{max_output_tokens:4000}],
  ['openai','gpt-6-luna',{max_output_tokens:4000}],
  ['xai','grok-4.7',{max_output_tokens:4000}],
];
const options=(vendor,model,extra,more={})=>({vendor,model,prompt:'Reply.',effort:'low',extra,...more});

function fakeClient(){
  const generated=[];
  const done={id:'r',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]};
  return {generated,client:{
    responses:{create:async req=>{generated.push(req);return done;}},
    messages:{create:async req=>{generated.push(req);return {stop_reason:'end_turn',content:[{type:'text',text:'ok'}]};}},
  }};
}

test('a two-million-token provider count is consulted and refused on Fable, Sol and every other uncovered model; within-window passes',async()=>{
  for(const [vendor,model,extra] of uncovered){
    let counted=0;
    const prepared=prepareRequest(options(vendor,model,extra));
    await assert.rejects(checkBudget(prepared,async()=>{counted++;return 2_000_000;}),
      error=>error.code==='CONTEXT_WINDOW_EXCEEDED'&&/window/i.test(error.message)&&error.admission.basis==='provider_count',model);
    assert.equal(counted,1,`${model}: the injected counter is called`);
    const {client,generated}=fakeClient();
    await assert.rejects(sendModelTurn({...options(vendor,model,extra),client,countTokens:async()=>2_000_000}),/window/i);
    assert.equal(generated.length,0,`${model}: no generation follows a refused admission`);
    // Within the window the same model is admitted and generates.
    let within=0;
    const result=await sendModelTurn({...options(vendor,model,extra),client,countTokens:async()=>{within++;return 1000;}});
    assert.equal(within,1,`${model}: counted before admission`);
    assert.equal(result.complete,true,model);
    assert.equal(generated.length,1,model);
  }
});

test('output headroom is reserved: an uncapped providerDefaults request reserves the documented output limit',async()=>{
  const prepared=prepareRequest(options('openai','gpt-6-sol',undefined));
  assert.equal(prepared.request.max_output_tokens,undefined,'the provider default applies to the request itself');
  assert.equal(await checkBudget(prepared,async()=>1_050_000-128_000),922_000);
  await assert.rejects(checkBudget(prepared,async()=>1_050_000-128_000+1),/window/i);
});

test('without a supported count the qualified upper-bound estimate refuses an over-window history before generation',async()=>{
  const history=[{role:'user',content:'x'.repeat(1_100_000)},{role:'assistant',content:'ok'}];
  const {client,generated}=fakeClient();
  // Compaction is held off so admission itself is what is tested; Sol has no compaction at all.
  await assert.rejects(sendModelTurn({...options('openai','gpt-6-sol',{max_output_tokens:4000}),history,continuity:'replay',client}),
    error=>error.code==='CONTEXT_WINDOW_EXCEEDED'&&error.admission.basis==='byte_upper_bound');
  await assert.rejects(sendModelTurn({...options('anthropic','claude-fable-5-2',{max_tokens:4000}),history,client,compactAfterBytes:Infinity}),
    error=>error.code==='CONTEXT_WINDOW_EXCEEDED'&&error.admission.basis==='byte_upper_bound');
  assert.equal(generated.length,0);
  // The estimate covers system and tools as well as history.
  const small=prepareRequest(options('anthropic','claude-fable-5-2',{max_tokens:4000,system:'s'.repeat(5000)}));
  assert.ok(estimateInputTokens(small.request)>5000);
  const fine=await sendModelTurn({...options('anthropic','claude-fable-5-2',{max_tokens:4000}),client});
  assert.equal(fine.complete,true);
  assert.equal(generated.length,1);
});

test('the Anthropic provider count is used when the SDK supports it, over system, tools and history',async()=>{
  const counted=[];
  const {client,generated}=fakeClient();
  client.messages.countTokens=async body=>{counted.push(body);return {input_tokens:2_000_000};};
  const extra={max_tokens:4000,system:'be brief',tools:[{name:'t',input_schema:{type:'object'}}]};
  await assert.rejects(sendModelTurn({...options('anthropic','claude-fable-5-2',extra),history:[{role:'user',content:'earlier'},{role:'assistant',content:'ok'}],client}),/window/i);
  assert.equal(generated.length,0);
  assert.equal(counted.length,1);
  assert.equal(counted[0].system,'be brief');
  assert.equal(counted[0].tools.length,1);
  assert.equal(counted[0].messages.length,3);
  assert.equal('max_tokens' in counted[0],false,'output caps are not inputs to the count');
});

test('an unknown window is not admitted, and each refusal names its reason',()=>{
  assert.throws(()=>admitContext({model:'m',window:null,output:10,input:1,basis:'provider_count'}),error=>error.code==='CONTEXT_WINDOW_UNKNOWN');
  assert.throws(()=>admitContext({model:'m',window:100,inputCeiling:50,output:10,input:50,basis:'provider_count'}),error=>error.code==='INPUT_CEILING');
  assert.deepEqual(admitContext({model:'m',window:100,output:10,input:90,basis:'provider_count'}),
    {model:'m',window:100,inputCeiling:null,output:10,input:90,basis:'provider_count'});
});
