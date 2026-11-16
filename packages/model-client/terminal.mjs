// A turn is accepted only on the provider's own successful terminal state.
// One definition shared by the frontier client and Pantheon's direct path, so
// every model in the registry is judged by the same rule.
export const SUCCESSFUL_STOPS=Object.freeze(['end_turn','tool_use','stop_sequence']);
export const successfulStop=reason=>SUCCESSFUL_STOPS.includes(reason);

// Returns {complete, state, why}. `state` is what the provider reported, or
// null when it reported nothing; an unreported state is not a success.
export function terminalState(surface,{status,stopReason,finishReason,blocked}={}){
  if(surface==='responses'){
    if(status==null)return {complete:false,state:null,why:'provider reported no response status'};
    return status==='completed'?{complete:true,state:status,why:null}:{complete:false,state:status,why:`provider response status is ${status}`};
  }
  if(surface==='messages'){
    if(stopReason==null)return {complete:false,state:null,why:'provider reported no stop reason'};
    return successfulStop(stopReason)?{complete:true,state:stopReason,why:null}:{complete:false,state:stopReason,why:`provider stopped with ${stopReason}`};
  }
  if(surface==='genai'){
    if(blocked)return {complete:false,state:finishReason??'BLOCKED',why:'provider blocked the prompt'};
    if(finishReason==null)return {complete:false,state:null,why:'provider reported no finish reason'};
    return finishReason==='STOP'?{complete:true,state:finishReason,why:null}:{complete:false,state:finishReason,why:`provider finished with ${finishReason}`};
  }
  throw new Error(`Unknown surface: ${surface}`);
}
