// Reviewer check (review evidence, not product code). Run: node cross-lab-pairing.mjs /path/to/OPHANIM
// Claim under test, pantheon/AGENTS.md: "a reviewer must not share a vendor with the maker" is the
// cross-lab rule. pantheon/src/config/lanes.json records claude-opus-4-6-thinking as vendor agy_google,
// lab anthropic. The pairing below is one Anthropic model reviewing another.
import path from 'node:path';

const repo = process.argv[2];
const seating = await import(path.join(repo, 'pantheon/src/role/seating.mjs'));
const law = await import(path.join(repo, 'pantheon/src/team/law.mjs'));
const lanes = (await import(path.join(repo, 'pantheon/src/config/models.mjs'))).LANES;

const maker = {vendor: 'agy_google', model: 'claude-opus-4-6-thinking'};
const reviewer = {vendor: 'anthropic', model: 'claude-opus-5-5'};
const planner = {vendor: 'agy_google'};
const labOfMaker = Object.values(lanes).map(lane => lane[maker.model]?.lab).find(Boolean);

const names = list => list.map(c => `${c.vendor}/${c.model}`);
console.log('default implementer ladder     :', names(seating.candidatesFor('implementer', {})).slice(0, 2).join(', '));
console.log('reviewer candidates, agy avoided:', names(seating.candidatesFor('reviewer', {avoid: ['agy_google', 'agy_google']})).join(', '));
console.log('lab of the maker per lanes.json :', labOfMaker, '| reviewer vendor:', reviewer.vendor);

let cuts;
try { cuts = seating.assertReviewCutsAcross({assigner: planner, producer: maker, reviewer}); }
catch (error) { cuts = 'REFUSED: ' + error.message; }
console.log('assertReviewCutsAcross          :', cuts);

const verdict = law.enforce({kind: 'review', producer: maker, checker: reviewer, assigner: planner}, {});
console.log('law 3 via enforce               :', JSON.stringify({ok: verdict.ok, applied: verdict.applied, violations: verdict.violations}));

const sameLabAccepted = labOfMaker === reviewer.vendor && cuts === true && verdict.ok === true;
console.log(sameLabAccepted ? 'RESULT: same-lab review ACCEPTED by both rules' : 'RESULT: not reproduced');
process.exitCode = sameLabAccepted ? 0 : 1;
