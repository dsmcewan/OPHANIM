// Responses `reasoning.context`: which earlier reasoning a turn may render.
//
// Read from developers.openai.com on 2026-11-16 (guides/reasoning#preserve-reasoning-across-calls,
// guides/deployment-checklist, guides/latest-model):
//   - values are auto | current_turn | all_turns; omitting it is the same as `auto`, the model's default;
//   - `all_turns` is documented for the GPT-5.6 family and GPT-6.1 Sol. GPT-6 Astra is shown with it in
//     one guide and left out of the supported list in another; GPT-6 Sol and Luna are not stated;
//   - the response's `reasoning.context` field reports the EFFECTIVE mode, so it is recorded, not assumed.
// Nothing here covers xAI, so this transport never sends the field there.
export const REASONING_CONTEXTS = Object.freeze(['auto', 'current_turn', 'all_turns']);
export const DOCUMENTED_ALL_TURNS = Object.freeze(['gpt-6.1-sol']);

/** The value to send, or undefined to omit it. Throws on a value the docs do not define. */
export function reasoningContextFor({vendor, model, requested, continuity}) {
  if (requested !== undefined && !REASONING_CONTEXTS.includes(requested)) throw new Error(`Unknown reasoning.context: ${requested}`);
  if (vendor !== 'openai') {
    if (requested !== undefined) throw new Error(`reasoning.context is not documented for ${vendor}`);
    return undefined;
  }
  if (requested !== undefined) return requested;
  // A replayed conversation asks for earlier reasoning only where that is documented to work.
  return continuity === 'replay' && DOCUMENTED_ALL_TURNS.includes(model) ? 'all_turns' : undefined;
}

/** What was asked for, what the provider says it used, and whether they agree. */
export function reasoningContextReport(requested, response) {
  const effective = response?.reasoning?.context ?? null;
  return {requested: requested ?? null, effective,
    honoured: requested === undefined || requested === 'auto' ? null : effective === null ? null : effective === requested};
}
