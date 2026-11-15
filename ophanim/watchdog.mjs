import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {writeJson} from './fixtures.mjs';

const CLI=fileURLToPath(new URL('./cli.mjs',import.meta.url));

// The watchdog is a separate process from the runtime. It owns the process
// group, observes heartbeats and persists the reason for terminating a stall.
export async function guardWorker({requestFile,reportFile,timeoutMs=30000,stallMs=3000}) {
  if(!path.isAbsolute(requestFile)||!path.isAbsolute(reportFile)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000||!Number.isSafeInteger(stallMs)||stallMs<100||stallMs>timeoutMs)throw Error('Bounded watchdog request required');
  const startedAt=Date.now();
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[CLI,'worker','--request',requestFile],{detached:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});
    let lastHeartbeat=Date.now(),heartbeats=0,reason='worker-exited',terminating=false,timer,killTimer,stdout='',stderr='',events=[];
    const stop=why=>{
      if(terminating)return;
      terminating=true;reason=why;
      try{process.kill(-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},100);
    };
    const append=(current,chunk)=>{
      const next=current+chunk;
      if(Buffer.byteLength(next)>262144){stop('output-limit');return next.slice(-131072);}
      return next;
    };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk);});
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk);});
    child.on('message',message=>{
      if(message?.type==='heartbeat'){lastHeartbeat=Date.now();heartbeats++;}
      else if(message?.type==='event'&&events.length<2000)events.push(message.event);
    });
    child.on('error',error=>{clearInterval(timer);clearTimeout(killTimer);reject(error);});
    timer=setInterval(()=>{
      const now=Date.now();
      if(now-startedAt>=timeoutMs)stop('deadline');
      else if(now-lastHeartbeat>=stallMs)stop('heartbeat-stalled');
    },25);
    const parentClosed=()=>stop('watchdog-parent-disconnected');
    const terminated=()=>stop('watchdog-sigterm'),interrupted=()=>stop('watchdog-sigint');
    if(process.connected)process.on('disconnect',parentClosed);
    process.on('SIGTERM',terminated);process.on('SIGINT',interrupted);
    child.on('close',(exitCode,signal)=>{
      clearInterval(timer);clearTimeout(killTimer);process.off('disconnect',parentClosed);
      process.off('SIGTERM',terminated);process.off('SIGINT',interrupted);
      const report={schema:'ophanim.watchdog/v1',watchdogPid:process.pid,workerPid:child.pid,startedAt,endedAt:Date.now(),durationMs:Date.now()-startedAt,heartbeats,reason,exitCode,signal,events,stdout,stderr};
      writeJson(reportFile,report);resolve(report);
    });
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2]!=='--request'||!process.argv[3]||process.argv.length!==4)throw Error('Usage: watchdog.mjs --request /absolute/request.json');
    const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
    const report=await guardWorker(request);
    process.stdout.write(JSON.stringify({reportFile:request.reportFile,reason:report.reason,exitCode:report.exitCode,signal:report.signal})+'\n');
    process.exitCode=report.exitCode===0?0:1;
  } catch(error) {process.stderr.write(error.stack+'\n');process.exitCode=2;}
}
