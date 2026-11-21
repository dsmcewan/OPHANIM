// A PROVIDER REFUSING THE ACCOUNT (register KG-39). One provider error is classified here: whether the vendor refused
// the ACCOUNT the call was made on -- no credit, a spend cap or an exhausted quota, a key that is not valid -- rather
// than this request or this moment. Such a refusal is not a property of the item being worked: every call to that
// vendor on that account is refused the same way until the owner acts. So the stage meter sends that vendor nothing
// more in the stage (stages.mjs `meter`), the scheduler records the stage PENDING on a transient owner blocker that
// counts against no attempt bound, and the tick stops (scheduler.mjs).
//
// Read from the vendor SDK's own error: its HTTP status, its parsed body and its message (@anthropic-ai/sdk and openai
// APIError: `status`, `error`, `code`; @google/genai ApiError: `status`, the body as the message). Deliberately narrow:
// a rate limit (a 429 that is not a quota or spend cap), a bad request, a vendor error, the network and the meter's own
// refusals are NOT refusals of the account -- each keeps the handling it has (seating.mjs shouldFallThrough, the
// stage's budget, the retry of a transient pending). A 403 is not classified: it is as often one model the key may not
// use as the account itself.
export const ACCOUNT_REFUSED = 'PROVIDER_ACCOUNT_REFUSED';

// What the owner does about each kind, named on the blocker.
export const REMEDY = Object.freeze({
  credit: 'add credit to the account this key bills, or use a key of an account that has it',
  quota: 'raise the account\'s spend limit or quota, or wait for it to reset',
  key: 'replace the key: the provider does not accept it',
});

const QUOTA_CODES = ['insufficient_quota', 'enforced_spend_limit_reached'];
const CREDIT_TEXT = /credit balance is too low/i;
const KEY_TEXT = /incorrect api key provided|api key not valid|API_KEY_INVALID|invalid x-api-key/i;

const textOf = e => [e?.message, typeof e?.error === 'string' ? e.error : null, e?.error?.message, e?.error?.error?.message]
  .filter(x => typeof x === 'string').join(' ');
const codesOf = e => [e?.code, e?.error?.code, e?.error?.type, e?.error?.error?.type, e?.error?.error?.details?.error_code, e?.error?.details?.error_code]
  .filter(x => typeof x === 'string');

/**
 * The refusal of the account in a provider error, or null when the error is anything else.
 * `seat` names who was asked ({vendor, model}). Returns {code, vendor, model, kind: credit|quota|key, status, why}.
 */
export function accountRefusal(err, seat = {}) {
  if (!err || typeof err !== 'object') return null;
  // A refusal the stage's meter already classified, passed on with the error it refused a later call with.
  if (err.account_refused?.code === ACCOUNT_REFUSED) return err.account_refused;
  const status = Number.isInteger(err.status) ? err.status : Number.isInteger(err.response?.status) ? err.response.status : null;
  if (status === null) return null;
  const text = textOf(err), codes = codesOf(err);
  const kind = CREDIT_TEXT.test(text) ? 'credit'
    : codes.some(c => QUOTA_CODES.includes(c)) ? 'quota'
    : status === 401 || codes.includes('authentication_error') || codes.includes('invalid_api_key') || KEY_TEXT.test(text) ? 'key'
    : null;
  if (!kind) return null;
  const said = (err.error?.error?.message ?? err.error?.message ?? (typeof err.error === 'string' ? err.error : null) ?? err.message ?? '').trim();
  return {code: ACCOUNT_REFUSED, vendor: seat.vendor ?? null, model: seat.model ?? null, kind, status, why: (said || `${status}`).slice(0, 300)};
}
