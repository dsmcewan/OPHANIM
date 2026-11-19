export type Vendor='anthropic'|'agy_google'|'openai'|'xai';
export type OpaqueItem=Record<string,unknown>;
export interface ModelCapability {
  vendor:Vendor;
  surface:'messages'|'genai'|'responses';
  window:number;
  output:number|null;
  efforts:string[];
  compaction?:boolean;
  inputCeiling?:number;
  combined?:boolean;
  /** No frontier effort/output default is imposed where the caller names none. */
  providerDefaults?:boolean;
}
export interface RequestOptions {
  vendor:Vendor;
  model:string;
  prompt:string;
  history?:OpaqueItem[];
  extra?:OpaqueItem;
  scope?:OpaqueItem;
  sessionId?:string;
  effort?:string;
  /** Explicit mode requires and preserves a caller cap; defaults retain long-decode behavior. */
  outputBudgetPolicy?:'long_decode'|'explicit';
  architecture?:boolean;
  contractHeader?:string;
  signal?:AbortSignal;
  continuity?:'replay'|'server';
  previousResponseId?:string;
  /** Names the pane streamed events belong to; defaults to the vendor. */
  label?:string;
}
export interface PreparedRequest {
  vendor:Vendor;
  model:string;
  cap:ModelCapability;
  request:OpaqueItem;
  options:{signal?:AbortSignal;headers:Record<string,string>};
  continuity:'replay'|'server';
  history:OpaqueItem[];
  prompt:string;
  outputBudgetPolicy?:'long_decode'|'explicit';
}
export type TokenCounter=(request:OpaqueItem)=>Promise<number>;
export const COMPACTION_BETA:string;
export function prepareRequest(options:RequestOptions):PreparedRequest;
export function checkBudget(prepared:PreparedRequest,countTokens?:TokenCounter):Promise<number|null>;
export const LONG_DECODE_RESERVE:number;
export function reservedOutput(request:OpaqueItem,cap?:{output?:number|null}):number;
export function estimateInputTokens(request:OpaqueItem):number;
export interface ContextAdmission {model:string;window:number|null;inputCeiling:number|null;output:number;input:number;basis:string}
export function admitContext(options:{model:string;window:number|null|undefined;inputCeiling?:number|null|undefined;output:number;input:number;basis:string}):ContextAdmission;
export function providerTokenCounter(client:unknown,prepared:{cap:{vendor?:string;surface:string};options?:{headers?:Record<string,string>}},signal?:AbortSignal):TokenCounter|undefined;
export function compactConversation(options:{client:unknown;model:string;history:OpaqueItem[];system?:unknown;tools?:unknown;signal?:AbortSignal}):Promise<OpaqueItem[]>;
export function cacheKey(options:{scope:OpaqueItem;sessionId:string;vendor:string;model:string}):string;

export interface TurnOptions extends RequestOptions {
  client:unknown;
  /** Run after token counting and before generation; throw to prevent the request. */
  beforeGenerate?:(options:{signal:AbortSignal})=>Promise<void>;
  /** Refuse refusal blocks, tools and non-text output in presentation-only turns. */
  responseMode?:'any'|'text_only';
  deadline?:number;
  compactAfterBytes?:number;
  countTokens?:TokenCounter;
  onEvent?:(event:OpaqueItem)=>void;
}
export interface TurnResult {
  vendor:Vendor;
  response_id:string|null;
  text:string;
  tools:string[];
  complete:boolean;
  usable_for_resume:boolean;
  why_unusable:string|null;
  history?:OpaqueItem[];
  compacted:boolean;
  resumed:boolean;
  streamed:boolean;
  usage:unknown;
}
export function sendModelTurn(options:TurnOptions):Promise<TurnResult>;

export interface Candidate {vendor:Vendor;model:string;pool:string;poolConfig?:unknown}
export interface Cooldown {
  get(pool:string):Promise<{until:number;reason:string}|null>;
  success(pool:string):Promise<void>;
  refuse(pool:string,value:{until:number;reason:string}):Promise<unknown>;
}
export interface CooldownRecord {version:2;pool:string;until:number;reason:string}
export interface CooldownStore extends Cooldown {
  get(pool:string):Promise<CooldownRecord|null>;
  refuse(pool:string,value:{until:number;reason:string}):Promise<CooldownRecord>;
}
export function openCooldownStore(directory:string):CooldownStore;
export interface FailureClassification {retryable:boolean;retryMs:number|null;quota:boolean}
export function classifyFailure(error:unknown,now?:number):FailureClassification;
export function routeCall<T,S extends Candidate=Candidate>(options:{candidates:S[];invoke:(seat:S,options:{signal:AbortSignal;attempt:number})=>Promise<T>;signal?:AbortSignal;deadline?:number;cooldown?:Cooldown;maxAttempts?:number;admit?:(attempt:{vendor:string;model:string;pool:string;attempt:number})=>void|Promise<void>}):Promise<{value:T;seat:S;attempts:OpaqueItem[]}>;
export function boundedCall<T>(fn:(signal:AbortSignal)=>Promise<T>,options?:{signal?:AbortSignal;deadline?:number}):Promise<T>;

export function modelId(vendor:string,name:string):string;
export function isFrontier(model:string):boolean;
export const models:Record<string,Record<string,string>>;
export const CAPABILITIES:Readonly<Record<string,ModelCapability>>;
export function providerFetch(fetchImpl?:typeof fetch):typeof fetch;
export type Surface='responses'|'messages'|'genai';
export interface TerminalState {complete:boolean;state:string|null;why:string|null}
export const SUCCESSFUL_STOPS:readonly string[];
export function successfulStop(reason:unknown):boolean;
export function terminalState(surface:Surface,observed?:{status?:string|null;stopReason?:string|null;finishReason?:string|null;blocked?:boolean}):TerminalState;
export type ReasoningContext='auto'|'current_turn'|'all_turns';
export const REASONING_CONTEXTS:readonly ReasoningContext[];
export const DOCUMENTED_ALL_TURNS:readonly string[];
export function reasoningContextFor(options:{vendor:string;model:string;requested?:ReasoningContext;continuity?:string}):ReasoningContext|undefined;
export function reasoningContextReport(requested:ReasoningContext|undefined,response:unknown):{requested:ReasoningContext|null;effective:string|null;honoured:boolean|null};
