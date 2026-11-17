// A scripted reviewer turn for the review-cycle CLI test: every lab approves, except xai, which reports
// one finding with a reproduction on the first file of the change.
let n = 0;
export default async function turn({vendor, model, prompt}) {
  const file = /^- (.+)$/m.exec(prompt)?.[1] ?? null;
  const findings = vendor === 'xai' ? [{severity: 'major', file, line: 1, claim: 'the value changed without a test', reproduction: {kind: 'test', run: 'node --test'}}] : [];
  const text = '```json\n' + JSON.stringify({verdict: findings.length ? 'request_changes' : 'approve', findings}) + '\n```';
  return {text, response_id: `resp_cli_${vendor}_${++n}`, served_model: model};
}
