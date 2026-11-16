// Models moved from the direct path keep the direct path's request: no frontier effort or output
// default is imposed where the caller names none.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRequest,CAPABILITIES} from '../index.mjs';

test('a moved Responses model sends no effort and no output cap unless asked', () => {
  const {request}=prepareRequest({vendor:'openai',model:'gpt-6-sol',prompt:'q',continuity:'replay'});
  assert.equal(request.max_output_tokens,undefined);
  assert.equal(request.reasoning?.effort,undefined);
  assert.equal(request.store,false);
  assert.ok(request.include.includes('reasoning.encrypted_content'),'replay now keeps encrypted reasoning');
  const asked=prepareRequest({vendor:'openai',model:'gpt-6-sol',prompt:'q',effort:'none',extra:{max_output_tokens:9000}}).request;
  assert.deepEqual([asked.reasoning.effort,asked.max_output_tokens],['none',9000]);
  assert.throws(()=>prepareRequest({vendor:'openai',model:'gpt-6.1-sol',prompt:'q',effort:'none'}),/Unsupported effort/);
});

test('a moved Messages model needs an explicit max_tokens and sends no effort unless asked', () => {
  assert.throws(()=>prepareRequest({vendor:'anthropic',model:'claude-sonnet-5',prompt:'q'}),/pass max_tokens explicitly/);
  const {request}=prepareRequest({vendor:'anthropic',model:'claude-sonnet-5',prompt:'q',extra:{max_tokens:16384}});
  assert.equal(request.max_tokens,16384);
  assert.equal(request.output_config,undefined,'the provider default effort applies');
  const arch=prepareRequest({vendor:'anthropic',model:'claude-sonnet-5',prompt:'q',architecture:true,extra:{max_tokens:1000}}).request;
  assert.equal(arch.output_config,undefined,'the architecture flag imposes no effort either');
  const asked=prepareRequest({vendor:'anthropic',model:'claude-opus-5-5',prompt:'q',effort:'max',extra:{max_tokens:1000}}).request;
  assert.equal(asked.output_config.effort,'max');
  assert.throws(()=>prepareRequest({vendor:'anthropic',model:'claude-sonnet-5',prompt:'q',extra:{max_tokens:200000}}),/exceeds model limit/);
});

test('the long-decode frontier models keep their policy', () => {
  const fable=prepareRequest({vendor:'anthropic',model:'claude-fable-5-2',prompt:'q'}).request;
  assert.deepEqual([fable.max_tokens,fable.output_config.effort],[65536,'high']);
  const astra=prepareRequest({vendor:'openai',model:'gpt-6-astra',prompt:'q'}).request;
  assert.equal(astra.max_output_tokens,65536);
  assert.equal(Object.values(CAPABILITIES).filter(c=>c.providerDefaults).length,6);
});
