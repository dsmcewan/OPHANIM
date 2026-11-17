// ophanim/watchdog.mjs -- the process boundary around one runtime worker.
//
// Purpose: run `cli.mjs worker` (or `cli.mjs replay-worker`) as a child in its own process group,
//   watch it, and terminate it on a deadline, a stalled heartbeat, too much output, or the watchdog
//   itself being stopped. The reason it ended is persisted, so a stall is evidence, not a silence.
// Inputs:  a request JSON (`--request <abs path>` on the command line, or the object passed to
//   guardWorker): requestFile, reportFile (absolute paths), timeoutMs (100..300000), stallMs
//   (100..timeoutMs), and for a replay, replay=true plus replayRoot.
// Outputs: an `ophanim.watchdog/v1` report written to reportFile and returned: pids, timings,
//   heartbeat count, the termination reason, exit code/signal, up to 2000 runtime events and the
//   last 128 KiB of stdout/stderr once either passes 256 KiB. The CLI prints a one-line summary.
// Invariants: the worker is spawned detached, so the whole group is signalled (SIGTERM, then SIGKILL
//   100 ms later); `reason` is set once, by the first stop; a replay worker gets a minimal
//   environment (PATH, LANG, OPHANIM_TELOS_ROOT) instead of this process's environment.
// Must never: accept relative request/report paths or unbounded limits, leave the worker's group
//   running when it is itself stopped, or judge whether the work was correct (governance does that).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {writeJson} from './fixtures.mjs';

const CLI=fileURLToPath(new URL('./cli.mjs',import.meta.url));

// The watchdog is a separate process from the runtime. It owns the process
// group, observes heartbeats and persists the reason for terminating a stall.
// Resolves with the report once the worker's stdio closes; rejects only if the spawn itself fails.
export async function guardWorker({requestFile,reportFile,timeoutMs=30000,stallMs=3000,replay=false,replayRoot}) {
  // Absolute paths, and integer limits with 100 <= stallMs <= timeoutMs <= 300000.
  if(!path.isAbsolute(requestFile)||!path.isAbsolute(reportFile)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000||
    !Number.isSafeInteger(stallMs)||stallMs<100||stallMs>timeoutMs)
    throw Error('Bounded watchdog request required');
  const startedAt=Date.now();
  return new Promise((resolve,reject)=>{
    const args=replay?[CLI,'replay-worker','--request',requestFile,'--root',replayRoot]:
      [CLI,'worker','--request',requestFile];
    const env=replay?{PATH:process.env.PATH,LANG:'C.UTF-8',OPHANIM_TELOS_ROOT:process.env.OPHANIM_TELOS_ROOT}:
      process.env;
    const child=spawn(process.execPath,args,{detached:true,stdio:['ignore','pipe','pipe','ipc'],env});
    let lastHeartbeat=Date.now(),heartbeats=0,reason='worker-exited',terminating=false,timer,killTimer,
      stdout='',stderr='',events=[];
    // First stop wins: record why, signal the whole group, escalate to SIGKILL after 100 ms.
    const stop=why=>{
      if(terminating)return;
      terminating=true;reason=why;
      try{process.kill(-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},100);
    };
    // Output cap: past 256 KiB the worker is stopped and only the last 128 KiB is kept.
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
    // Poll every 25 ms: the overall deadline first, then the heartbeat gap.
    timer=setInterval(()=>{
      const now=Date.now();
      if(now-startedAt>=timeoutMs)stop('deadline');
      else if(now-lastHeartbeat>=stallMs)stop('heartbeat-stalled');
    },25);
    // If the watchdog itself is told to stop, or loses its parent, it takes the worker down with it.
    const parentClosed=()=>stop('watchdog-parent-disconnected');
    const terminated=()=>stop('watchdog-sigterm'),interrupted=()=>stop('watchdog-sigint');
    if(process.connected)process.on('disconnect',parentClosed);
    process.on('SIGTERM',terminated);process.on('SIGINT',interrupted);
    child.on('close',(exitCode,signal)=>{
      clearInterval(timer);clearTimeout(killTimer);process.off('disconnect',parentClosed);
      process.off('SIGTERM',terminated);process.off('SIGINT',interrupted);
      const report={schema:'ophanim.watchdog/v1',watchdogPid:process.pid,workerPid:child.pid,startedAt,
        endedAt:Date.now(),durationMs:Date.now()-startedAt,heartbeats,reason,exitCode,signal,events,stdout,stderr};
      writeJson(reportFile,report);resolve(report);
    });
  });
}

// Command line: exit 0 if the worker exited 0, 1 if it did not, 2 if the watchdog itself failed.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2]!=='--request'||!process.argv[3]||process.argv.length!==4)
      throw Error('Usage: watchdog.mjs --request /absolute/request.json');
    const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
    const report=await guardWorker(request);
    process.stdout.write(JSON.stringify({reportFile:request.reportFile,reason:report.reason,
      exitCode:report.exitCode,signal:report.signal})+'\n');
    process.exitCode=report.exitCode===0?0:1;
  } catch(error) {process.stderr.write(error.stack+'\n');process.exitCode=2;}
}
