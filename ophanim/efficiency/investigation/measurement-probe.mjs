import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {digest} from '../../board.mjs';
import {createWorkers, makeFixtures} from '../../fixtures.mjs';

export const MEASUREMENT_RECIPE = Object.freeze({
  schema: 'ophanim.measurement-protocol/v1',
  methods: Object.freeze(['phase-boundaries']),
  timerDelayMs: 3,
  timerHoldNs: 18_000_000,
  transformPasses: 8192,
  markNames: Object.freeze([
    'timerScheduledNs',
    'timerEnteredNs',
    'transformStartedNs',
    'transformCompletedNs',
    'callbackReturnedNs'
  ]),
  calibrationRounds: 32
});
const ORDERS = [
  ['baseline','timer','combined','transform'],
  ['timer','transform','baseline','combined'],
  ['transform','combined','timer','baseline'],
  ['combined','baseline','transform','timer'],
];
const BOUNDARIES = Object.freeze({
  runtimeDispatches:0,replays:0,modelCalls:0,destinationEffects:0,executionAuthorized:false,policyAuthorized:false,
});
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = url => createHash('sha256').update(fs.readFileSync(url)).digest('hex');
const clock = () => process.hrtime.bigint();
const sourceIdentities = () => ({
  probeSha:sha(new URL(import.meta.url)),fixtureSha:sha(new URL('../../fixtures.mjs',import.meta.url)),
});

export function createPhaseRecorder(names, {enabled=false, origin=clock()}={}) {
  if (!Array.isArray(names)||!names.length||names.length>12||new Set(names).size!==names.length||
    names.some(name=>typeof name!=='string'||!/^[a-z][a-zA-Z0-9]{0,31}Ns$/.test(name))||typeof origin!=='bigint')
    throw Error('Bounded phase measurement contract required');
  if (!enabled) return {mark:()=>{},finish:()=>null};
  const ordered=[...names];
  let index=0,invalid=false;
  const marks={};
  return {
    mark(name) {
      if (invalid||index>=ordered.length||name!==ordered[index]) {
        invalid=true;
        return;
      }
      marks[name]=Number(clock()-origin);
      index++;
    },
    finish() {
      if (invalid||index!==ordered.length) return null;
      return Object.freeze({...marks});
    },
  };
}

function fixtureWorkload(options, obligationId) {
  const {count,namespace,department='operations'}=options;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 6 ||
    Object.keys(options).some(key => !['count', 'namespace', 'department'].includes(key))
  )
    throw Error('Bounded measurement fixture required');
  const fixture={count,namespace,department};
  const trusted=makeFixtures(fixture);
  const target=obligationId===undefined?trusted.obligations[0]:trusted.obligations.find(row=>row.id===obligationId);
  if (!target) throw Error('Measurement stage absent from frozen fixture');
  const {expected,...obligation}=target;
  // The frozen fixture contract provides exact upstream artifacts for this
  // isolated invocation. Historical scope binding is checked by its reader.
  const dependencies=Object.fromEntries(target.dependsOn.map(id=>{
    const output=trusted.obligations.find(row=>row.id===id).expected;
    return [id,{output,sha256:digest(output)}];
  }));
  const input={obligation,inputs:{...target.inputs,dependencies},priorAttempts:0};
  const worker=createWorkers({department,delayMs:0}).find(item=>item.kinds.includes(target.kind));
  const expectedEffects=target.effectKey?[{key:target.effectKey,payload:expected}]:[];
  return {
    input,
    worker,
    workload: {
      fixture,
      fixtureSha: digest(trusted),
      obligationId: target.id,
      specSha: digest(target),
      inputSha: digest(input),
      expectedOutputsSha: digest({[target.id]: expected}),
      expectedEffectsSha: digest(expectedEffects)
    }
  };
}

function burnUntil(stop) {
  while(clock()<stop) { /* Hold the event loop before the due timer resumes. */ }
}

async function runSample({t0, deadline, worker, input, condition, collection}) {
  const recorder=createPhaseRecorder(MEASUREMENT_RECIPE.markNames,{enabled:collection==='on',origin:t0});
  const ensureTime=()=>{
    if (clock()>=deadline) throw Error('Measurement wall limit exhausted');
  };
  ensureTime();
  const startedNs=Number(clock()-t0);
  await new Promise(resolve=>{
    recorder.mark('timerScheduledNs');
    setTimeout(()=>{
      recorder.mark('timerEnteredNs');
      resolve();
    },MEASUREMENT_RECIPE.timerDelayMs);
    if (condition==='timer'||condition==='combined') {
      const holdUntil=clock()+BigInt(MEASUREMENT_RECIPE.timerHoldNs);
      burnUntil(holdUntil<deadline?holdUntil:deadline);
    }
  });
  ensureTime();
  recorder.mark('transformStartedNs');
  const passes=condition==='transform'||condition==='combined'?MEASUREMENT_RECIPE.transformPasses:1;
  let result=await worker.run(input);
  for(let pass=1;pass<passes;pass++){
    if (pass%64===0) ensureTime();
    result=await worker.run(input);
  }
  recorder.mark('transformCompletedNs');
  recorder.mark('callbackReturnedNs');
  const endedNs=Number(clock()-t0);
  ensureTime();
  return {
    startedNs,
    endedNs,
    marks: recorder.finish(),
    outputsSha: digest({[input.obligation.id]: result.output}),
    effectsSha: digest(result.effects ?? [])
  };
}

function measureMarks(t0) {
  const {markNames,calibrationRounds}=MEASUREMENT_RECIPE;
  function elapsed(enabled){
    const start=clock();
    const recorder=createPhaseRecorder(markNames,{enabled,origin:t0});
    for(const name of markNames) recorder.mark(name);
    recorder.finish();
    return Number(clock()-start);
  }
  return Array.from({length:calibrationRounds},(_,round)=>{
    const order=round%2===0?['onNs','offNs']:['offNs','onNs'];
    return {round,...Object.fromEntries(order.map(name=>[name,elapsed(name==='onNs')]))};
  });
}

export async function runMeasurementProbe({scopeSha,sourceSha,recipeId,methods=['phase-boundaries'],
  fixture={count:1,namespace:'measurement-calibration'},obligationId,repeats=4,maxWallMs=3000}={}) {
  if(!hex(scopeSha)||!hex(sourceSha)||typeof recipeId!=='string'||!/^[a-zA-Z0-9:._-]{1,120}$/.test(recipeId)||
    !Array.isArray(methods)||methods.length!==1||methods[0]!==MEASUREMENT_RECIPE.methods[0]||
    !Number.isInteger(repeats)||repeats<3||repeats>6||!Number.isInteger(maxWallMs)||maxWallMs<1||maxWallMs>5000)
    throw Error('Exact bounded measurement recipe required');
  const t0=clock(),deadline=t0+BigInt(maxWallMs)*1_000_000n,startedCpu=process.cpuUsage();
  const sources=sourceIdentities();
  const {worker,input,workload}=fixtureWorkload(fixture,obligationId);
  const markCalibration=measureMarks(t0);
  const samples=[];
  for(let trial=0;trial<repeats;trial++){
    const order=ORDERS[trial%ORDERS.length];
    for(const [index,condition] of order.entries()){
      const collections=(trial+index)%2===0?['on','off']:['off','on'];
      for(const collection of collections){
        const observations=await runSample({t0,deadline,worker,input,condition,collection});
        if (
          observations.outputsSha !== workload.expectedOutputsSha ||
          observations.effectsSha !== workload.expectedEffectsSha
        )
          throw Error('Frozen fixture output or effect proposal differs');
        const identity={scopeSha,sourceSha,recipeId,trial,condition,collection,inputSha:workload.inputSha};
        samples.push({sampleId:digest(identity),trial,condition,collection,inputSha:workload.inputSha,...observations});
      }
    }
  }
  const retainedSources=sourceIdentities();
  if(retainedSources.probeSha!==sources.probeSha||retainedSources.fixtureSha!==sources.fixtureSha)
    throw Error('Measurement source changed during collection');
  const cpu=process.cpuUsage(startedCpu),elapsedNs=Number(clock()-t0);
  if(elapsedNs>maxWallMs*1_000_000)throw Error('Measurement wall limit exhausted');
  return {
    schema: 'ophanim.measurement-probe/v1',
    scopeSha,
    sourceSha,
    recipeId,
    protocol: {...MEASUREMENT_RECIPE, repeats, maxWallMs},
    workload,
    sources,
    samples,
    overhead: {markCalibration},
    resource: {
      elapsedNs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      nodeVersion: process.versions.node,
      clock: 'process.hrtime.bigint'
    },
    boundaries: BOUNDARIES
  };
}
