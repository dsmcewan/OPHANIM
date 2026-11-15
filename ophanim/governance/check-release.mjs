// Independent finite behavior checks for the two allowed synthetic releases.
// This does not execute a supplied path or accept caller-supplied test results.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {canonical, hash, rawHash} from './check-contract.mjs';

export const FIXTURE_SOURCE_SHA = '51ae3483e233fda0452c8b01f3ec77a628814c3453913658fc6d8183560bda8a';
const FIXTURES = new URL('../fixtures.mjs', import.meta.url);
const OWNERS = Object.freeze({facilities:'Facilities queue',software:'IT queue',records:'Records queue'});
const POLICY = Object.freeze({schema:'ophanim.synthetic-release-policy/v1',versions:['synthetic-v1','synthetic-v2'],canonicalServices:OWNERS,approvedAlias:{'office-support':'facilities'},deniedServices:['unapproved-service','payroll-admin'],fixtureOnly:true});
const same = (a,b) => canonical(a) === canonical(b);
const metadata = workers => workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));

export async function evaluateRelease(request) {
  if (request.obligation.kind !== 'synthetic-release') return null;
  const artifact=request.obligation.inputs?.artifact, release=request.candidate.output;
  const file=fileURLToPath(FIXTURES), stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>262144 || fs.realpathSync(file)!==file || rawHash(fs.readFileSync(file))!==FIXTURE_SOURCE_SHA) throw Error('Pinned synthetic worker source differs');
  if (!artifact || !same(Object.keys(artifact).sort(),['options','schema','sourceSha','workers']) || artifact.schema!=='ophanim.synthetic-worker-artifact/v1' || artifact.sourceSha!==FIXTURE_SOURCE_SHA || hash(artifact)!==release.artifactSha) throw Error('Release artifact is not the pinned synthetic source and configuration');
  const options=artifact.options;
  if (!options || Object.keys(options).some(k=>!['department','departments','version','delayMs','routingAliases'].includes(k)) || !POLICY.versions.includes(options.version)) throw Error('Only the two bounded synthetic release configurations are admitted');
  if (typeof options.department!=='string' || !/^[a-z][a-z0-9-]{0,31}$/.test(options.department) || !Array.isArray(options.departments) || options.departments.length<1 || options.departments.length>8 || new Set(options.departments).size!==options.departments.length || !options.departments.includes(options.department) || options.departments.some(x=>typeof x!=='string' || !/^[a-z][a-z0-9-]{0,31}$/.test(x)) || !Number.isInteger(options.delayMs) || options.delayMs<0 || options.delayMs>1000) throw Error('Invalid bounded release resources or departments');
  const aliases=options.routingAliases??{};
  if (!same(aliases,options.version==='synthetic-v2'?POLICY.approvedAlias:{})) throw Error('Release routing aliases exceed the independently fixed policy');
  const {createWorkers}=await import(FIXTURES.href);
  const declaredWorkers=createWorkers(options);
  if (!same(metadata(declaredWorkers),artifact.workers) || !same(artifact.workers,release.workers)) throw Error('Actual worker registry differs from release manifest');
  // Delay is an independently bounded scheduling parameter. Removing the wait
  // here leaves the selected transformation and routing configuration intact.
  const workers=createWorkers({...options,delayMs:0});
  const outcomes=[];
  for (const department of options.departments) {
    const scope='department:'+department;
    const run=async(kind,inputs,expected)=>{
      const worker=workers.find(w=>w.kinds.includes(kind)&&w.scopes.includes(scope));
      if (!worker) throw Error('Missing independently scoped worker');
      const value=await worker.run({obligation:{id:'evaluation:'+kind,kind,scope},inputs,priorAttempts:0});
      if (!same(value.output,expected)) throw Error('Release behavior failed fixed '+kind+' expectation');
      return value;
    };
    for (const service of Object.keys(OWNERS)) {
      const base={caseId:'evaluation-'+service,department,service,summary:'Replace meeting room lamp',requester:'reviewer@example.invalid',sourceRevision:'evaluation-r1'};
      await run('normalize-intake',{request:{...base,service:' '+service.toUpperCase()+' ',summary:' Replace  meeting room lamp '}},base);
      const routed={...base,owner:OWNERS[service]};
      await run('route-intake',{owners:OWNERS,dependencies:{normalized:{sha256:hash(base),output:base}}},routed);
      const draft={key:'evaluation:draft:'+base.caseId,caseId:base.caseId,department,owner:OWNERS[service],title:service+': '+base.summary,requester:base.requester,sourceRevision:base.sourceRevision,status:'draft'};
      const result=await run('draft-task',{actionPrefix:'evaluation',dependencies:{routed:{sha256:hash(routed),output:routed}}},draft);
      if (!same(result.effects,[{key:draft.key,payload:draft}])) throw Error('Draft effect differs from fixed output');
      outcomes.push({department,service,result:'canonical-pass',outputSha:hash(draft)});
    }
    for (const service of ['office-support',...POLICY.deniedServices]) {
      const source={caseId:'evaluation-'+service,department,service,summary:'Replace meeting room lamp',requester:'reviewer@example.invalid',sourceRevision:'evaluation-r1'};
      const worker=workers.find(w=>w.kinds.includes('route-intake')&&w.scopes.includes(scope));
      let value=null;
      try {value=await worker.run({obligation:{id:'evaluation:route',kind:'route-intake',scope},inputs:{owners:OWNERS,dependencies:{normalized:{sha256:hash(source),output:source}}},priorAttempts:0});} catch { /* An unsupported route must stop before an action. */ }
      const known=service==='office-support'&&options.version==='synthetic-v2';
      if (known) {
        if (!same(value?.output??null,{...source,owner:OWNERS.facilities})) throw Error('Approved alias repair failed independent behavior check');
      } else if (value && Object.values(OWNERS).includes(value.output?.owner)) throw Error('Unsupported route gained an authorized owner');
      if (!known && value?.effects?.length) throw Error('Unsupported route proposed an action');
      outcomes.push({department,service,result:known?'approved-alias-pass':'unsupported-held'});
    }
  }
  return {schema:'ophanim.synthetic-release-evaluation/v1',fixtureOnly:true,sourceSha:FIXTURE_SOURCE_SHA,policySha:hash(POLICY),artifactSha:hash(artifact),version:options.version,capability:options.version==='synthetic-v2'?'canonical-and-approved-alias':'canonical-only',outcomes};
}
