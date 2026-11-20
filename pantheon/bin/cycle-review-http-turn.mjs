// A reviewer turn for `pantheon-review-cycle --turn`, over plain HTTPS: OpenAI and xAI through their
// Responses APIs, Google through the Gemini API's OpenAI-compatible endpoint. On the owner's machine the
// key comes from the provider's usual variable (OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY); in a cloud
// session with none set, the header carries a placeholder the environment's network proxy replaces. Returns what the provider reported: the reply
// text, its response id and the model it says served the request (recorded on the ledger as such).
const ENDPOINTS = {
  openai: {url: 'https://api.openai.com/v1/responses', shape: 'responses', key: 'OPENAI_API_KEY'},
  xai: {url: 'https://api.x.ai/v1/responses', shape: 'responses', key: 'XAI_API_KEY'},
  agy_google: {url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', shape: 'chat', key: 'GEMINI_API_KEY'},
};

export default async function turn({vendor, model, prompt}) {
  const ep = ENDPOINTS[vendor];
  if (!ep) throw new Error(`no HTTP reviewer endpoint for ${vendor}`);
  const body = ep.shape === 'responses' ? {model, input: prompt} : {model, messages: [{role: 'user', content: prompt}]};
  const res = await fetch(ep.url, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${process.env[ep.key] || 'proxy-injected'}`},
    body: JSON.stringify(body), signal: AbortSignal.timeout(600_000)});
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${vendor}/${model}: HTTP ${res.status} ${JSON.stringify(json?.error ?? json)?.slice(0, 300)}`);
  if (ep.shape === 'responses') {
    if (json.status !== 'completed') throw new Error(`${vendor}/${model}: response status ${json.status}`);
    const text = json.output_text ?? (json.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? [])
      .filter(c => c.type === 'output_text').map(c => c.text).join('');
    return {text, response_id: json.id ?? null, served_model: json.model ?? null};
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw new Error(`${vendor}/${model}: finish_reason ${choice?.finish_reason}`);
  return {text: choice.message?.content ?? '', response_id: json.id ?? null, served_model: json.model ?? null};
}
// WHAT THIS MODULE BILLS (register L-146): every agy_google call above is ONE request to the metered Gemini API, whatever
// the model is named -- this module has no Antigravity lane, so a lane-named model is billed like an API id. The wrapper
// that loads it (src/sdk/live.mjs billedTurnModule: pantheon-review-cycle --turn, bin/cross-lab-review.mjs) reads this
// and charges each such call as primary Gemini API execution before calling it.
turn.meteredGeminiApi = true;
