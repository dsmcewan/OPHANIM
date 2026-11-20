// OPHANIM's practices, cross-referenced to the labs' own guidance: a practice is a proposal until the owner accepts it, every
// one rests on words quoted from a lab's page, and the written page is generated from the registry.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCHEMA, REGISTRY, DOC, load, problems, report, render, verify} from './practices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOSTS = {alpha: ['docs.alpha.test'], beta: ['docs.beta.test']};
const cite = (lab, n, over = {}) => ({lab, url: `https://docs.${lab}.test/guide-${n}.md`, sha256: String(n).repeat(64), quote: `Quote ${n} from ${lab}.`, ...over});
const practice = (id, over = {}) => ({id, statement: `Do thing ${id}.`, why: 'Because the labs say so.', status: 'proposed', fit: 'partly', today: 'It half does.', today_refs: ['ophanim/x.mjs:1'], basis: [cite('alpha', 1), cite('beta', 2)], ...over});
const registry = (over = {}) => ({schema: SCHEMA, read: '2026-11-20', method: 'm', themes: [{id: 'tools', title: 'Tools', covers: 'c',
  agree: [{point: 'Both say describe tools plainly.', basis: [cite('alpha', 1), cite('beta', 2)]}], differ: [{point: 'Alpha caps tools; Beta does not.', basis: [cite('alpha', 3)]}],
  practices: [practice('P-tools-1'), practice('P-tools-2', {status: 'accepted', fit: 'does', decided: {by: 'owner', date: '2026-11-21'}})]}], ...over});
const edit = fn => { const r = registry(); fn(r); return problems(r, {hosts: HOSTS}); };

test('a well-formed registry has no problems', () => assert.deepEqual(problems(registry(), {hosts: HOSTS}), []));

test('A PRACTICE IS A PROPOSAL UNTIL THE OWNER ACCEPTS IT: accepted or struck needs the owner\'s dated decision, and a proposal must not carry one', () => {
  assert.deepEqual(edit(r => { delete r.themes[0].practices[1].decided; }), ['P-tools-2: accepted needs the owner\'s dated decision']);
  assert.deepEqual(edit(r => { r.themes[0].practices[1].decided.by = 'claude'; }), ['P-tools-2: accepted needs the owner\'s dated decision']);
  assert.deepEqual(edit(r => { r.themes[0].practices[1].decided.date = 'yesterday'; }), ['P-tools-2: accepted needs the owner\'s dated decision']);
  assert.deepEqual(edit(r => { r.themes[0].practices[1].status = 'struck'; }), []);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].decided = {by: 'owner', date: '2026-11-21'}; }), ['P-tools-1: a proposal carries no decision']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].status = 'adopted'; }), ['P-tools-1: status "adopted" is not one of proposed, accepted, struck']);
});

test('EVERY PRACTICE RESTS ON A LAB\'S OWN WORDS: at least one quotation, each from a page on that lab\'s documentation hosts, with the page\'s digest', () => {
  assert.deepEqual(edit(r => { r.themes[0].practices[0].basis = []; }), ['P-tools-1: rests on no quotation']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].basis[0].quote = ' '; }), ['P-tools-1: a quotation from alpha is empty']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].basis[0].url = 'https://blog.elsewhere.test/x'; }), ['P-tools-1: https://blog.elsewhere.test/x is not on alpha\'s documentation hosts']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].basis[0].lab = 'gamma'; }), ['P-tools-1: gamma is not a lab whose documentation is captured']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].basis[0].sha256 = 'abc'; }), ['P-tools-1: a quotation from alpha carries no page digest']);
  assert.deepEqual(edit(r => { r.themes[0].agree[0].basis = []; }), ['tools: a point of agreement rests on no quotation']);
  assert.deepEqual(edit(r => { r.themes[0].differ[0].basis[0].quote = ''; }), ['tools: a quotation from alpha is empty']);
});

test('the rest of a record is held too: ids are unique and name their theme, the fit is one of the known answers, and a statement is never empty', () => {
  assert.deepEqual(edit(r => { r.themes[0].practices[1].id = 'P-tools-1'; }), ['P-tools-1: the id is used twice']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].id = 'P-agents-1'; }), ['P-agents-1: the id does not name its theme (tools)']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].fit = 'mostly'; }), ['P-tools-1: fit "mostly" is not one of does, partly, does-not, unknown']);
  assert.deepEqual(edit(r => { r.themes[0].practices[0].statement = ''; }), ['P-tools-1: no statement']);
  assert.deepEqual(problems({...registry(), schema: 'x'}, {hosts: HOSTS}), ['schema x, expected ophanim.practices/v1']);
});

test('THE REPORT COUNTS WHAT STANDS: proposals, accepted and struck apart, and how each practice fits what the repository does today', () => {
  const r = report(registry());
  assert.deepEqual(r, {themes: 1, practices: 2, proposed: 1, accepted: 1, struck: 0, fit: {does: 1, partly: 1, 'does-not': 0, unknown: 0}, quotations: 7, pages: 3, labs: ['alpha', 'beta']});
});

test('THE WRITTEN PAGE says of each practice whether it is a proposal, quotes the lab under it with the page, and shows what the repository does today', () => {
  const md = render(registry());
  assert.match(md, /^# OPHANIM's practices, against the labs' own guidance$/m);
  assert.match(md, /^1 proposed, 1 accepted by the owner, 0 struck\.$/m);
  assert.match(md, /^## Tools$/m);
  assert.match(md, /^- Both say describe tools plainly\. \(alpha, beta\)$/m);
  assert.match(md, /^- Alpha caps tools; Beta does not\. \(alpha\)$/m);
  assert.match(md, /^### P-tools-1 \(proposed\)\n\n\*\*Do thing P-tools-1\.\*\* Because the labs say so\.\n\n- \*\*Today \(partly\):\*\* It half does\. `ophanim\/x\.mjs:1`\n- \*\*alpha:\*\* "Quote 1 from alpha\." \[guide-1\.md\]\(https:\/\/docs\.alpha\.test\/guide-1\.md\)\n- \*\*beta:\*\* "Quote 2 from beta\." \[guide-2\.md\]\(https:\/\/docs\.beta\.test\/guide-2\.md\)$/m);
  assert.match(md, /^### P-tools-2 \(accepted by the owner, 2026-11-21\)$/m);
  assert.equal(render(registry()), md);
});

test('THE QUOTATIONS ARE CHECKED AGAINST THE CAPTURED PAGES: a quotation that is no longer in its page, a page that changed, and a page not captured are each named', () => {
  const pages = {'https://docs.alpha.test/guide-1.md': {sha256: '1'.repeat(64), text: 'Intro.\n\nQuote 1   from alpha.\n'}, 'https://docs.beta.test/guide-2.md': {sha256: 'f'.repeat(64), text: 'Quote 2 from beta.'}};
  const r = verify(registry(), {page: (lab, url) => pages[url] ?? null});
  assert.deepEqual(r, {checked: 7, held: 6, problems: [
    {where: 'tools', lab: 'alpha', url: 'https://docs.alpha.test/guide-3.md', why: 'the page is not captured here'},
  ], changed: ['https://docs.beta.test/guide-2.md']});
  const moved = verify(registry(), {page: (lab, url) => (url.endsWith('guide-1.md') ? {sha256: '1'.repeat(64), text: 'Rewritten.'} : pages[url] ?? null)});
  assert.deepEqual(moved.problems.filter(p => p.why === 'the quotation is not in the page as captured').map(p => p.where), ['tools', 'P-tools-1', 'P-tools-2']);
});

test('THE REGISTRY IN THE REPOSITORY is well formed, and docs/ophanim-best-practices.md is the page it generates', {skip: !fs.existsSync(REGISTRY) && 'no practices are kept yet'}, () => {
  const kept = load();
  const hosts = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'pantheon/src/config/vendor-docs.json'), 'utf8')).labs).map(([lab, d]) => [lab, [...d.hosts, ...(d.server?.hosts ?? [])]]));
  assert.deepEqual(problems(kept, {hosts}), []);
  assert.equal(fs.readFileSync(DOC, 'utf8'), render(kept));
  assert.equal(report(kept).accepted, kept.themes.flatMap(t => t.practices).filter(p => p.decided?.by === 'owner' && p.status === 'accepted').length, 'nothing is accepted but by the owner');
});
