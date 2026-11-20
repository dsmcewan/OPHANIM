// WHAT A SIBLING REPOSITORY'S OWN FILES DECLARE, at a commit, as a graph source with a DECLARED basis.
//
// Purpose   Beside its code, a repository states things outright: the distributions it requires, the services it composes
//           and what each is given, the actions its CI uses, who is responsible for which paths, which plan governs
//           and which it replaced, which commits of other repositories it audited, and the gates it recorded. Each is a
//           declaration in a file of the repository, so each is stated here as declared, under that file's path and
//           the commit it was read at. This repository's own declarations are pins.mjs and authority.mjs; this source
//           is for the siblings (TELOS, ARGO, LEXI), read from a checkout and never executed.
// Inputs    The sibling's repository root, a commit, and its name in the graph. Files are found by NAME and read by
//           SHAPE (manifests.mjs readers for the first three); a file whose shape is not the one its name promises is
//           listed as unread with why, and states nothing.
// Outputs   declaredSource(); declaredFacts(); declaredOrigin(names); declaredSourceIdOf(name).
// Facts     requirements*.txt         file depends-on pypi:<distribution> (specifier, line); file depends-on an included file
//           docker-compose*.y(a)ml    the file produces each service; a service depends-on the services it waits for, the
//                                     image it runs (tag apart) and the Dockerfile it is built from; a service consumes
//                                     each environment variable it is given, by NAME
//           .github/workflows/*       the workflow depends-on each action it uses (refs, lines)
//           OWNERSHIP.json            each lane is an authorization that governs the files under its paths
//           CURRENT-AUTHORITY.json    the active authorization authorizes the active plan; the plan supersedes each
//                                     plan the record lists as superseded
//           REPO_INVENTORY.md         the inventory is derived-from each commit of another repository it names
//           records/gates/*/reference.v*.json   a gate record, derived-from the commit it names
// Invariants  Read from git's object store at the commit. An environment variable is its name: no value is read into a
//           fact. A path that covers more than WIDE files is listed with its count, not expanded.
// Must never  Run a sibling's code; follow a name to another repository by resemblance; state anything of a file that
//           is not the shape its name promises.
import path from 'node:path';
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, resolveCommit} from '../extract/git.mjs';
import {readRequirements, readCompose, readWorkflow} from './manifests.mjs';
import {HOME, repositoryId, fileIdIn, packageId, envId, serviceId, changeIdIn, workflowIdIn} from './ids.mjs';

export const DECLARED_EXTRACTOR = 'sibling.declared.extractor';
export const declaredSourceIdOf = name => `sibling.${name}.declared`;
export const declaredOrigin = names => Object.freeze({kind: 'extractor', basis: 'declared', sources: names.map(declaredSourceIdOf)});
export const WIDE = 200;

const REQUIREMENTS = /(^|\/)requirements[^/]*\.txt$/, COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/, WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const GATE = /^records\/gates\/([^/]+)\/reference\.v\d+\.json$/, INVENTORY_ROW = /^\|\s*\[([A-Za-z0-9._-]+)\]\(https?:\/\/[^)\s]+\)\s*\|\s*`([0-9a-f]{40})`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/;
const NAMED = ['OWNERSHIP.json', 'CURRENT-AUTHORITY.json', 'REPO_INVENTORY.md'];
const dirOf = p => { const d = path.posix.dirname(p); return d === '.' ? '' : d; };
const join = (dir, p) => path.posix.normalize(dir ? `${dir}/${p}` : p);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const scalar = v => ['string', 'number', 'boolean'].includes(typeof v);

/** The facts the files of `repo` declare at `commit`, as the extractor's drafts. `name` is a sibling's name. */
export function declaredFacts(repo, commit, {name} = {}) {
  if (name === HOME) throw Object.assign(new Error('this repository\'s own declarations are stated by pins.mjs and authority.mjs'), {code: 'DEPS_REFUSED'});
  const tree = treeAt(repo, commit), entries = new Map(tree.entries.map(e => [e.path, e])), paths = [...entries.keys()].sort();
  const wanted = paths.filter(p => entries.get(p).mode !== '120000' && (REQUIREMENTS.test(p) || COMPOSE.test(p) || WORKFLOW.test(p) || GATE.test(p) || NAMED.includes(p)));
  const bytes = blobsAt(repo, wanted.map(p => entries.get(p).blob)), text = p => bytes.get(entries.get(p).blob).toString('utf8');
  const entities = new Map(), edges = new Map(), unread = [], found = {requirements: 0, compositions: 0, workflows: 0, records: []};
  const entity = (id, ref, attributes, extra = {}) => { if (!entities.has(id)) entities.set(id, {entity: id, ref, attributes, ...extra}); return entities.get(id); };
  const edge = (type, from, to, ref, attributes) => { const k = `${type}\0${from}\0${to}`; if (!edges.has(k)) edges.set(k, {type, from, to, ref, attributes}); return edges.get(k); };
  const file = p => entity(fileIdIn(name, p), p, {path: p, blob: entries.get(p).blob, bytes: entries.get(p).size});
  const json = p => { try { const j = JSON.parse(text(p)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };

  for (const p of wanted) {
    if (REQUIREMENTS.test(p)) {
      const r = readRequirements(text(p));
      if (!r.ok) { unread.push({file: p, why: r.why}); continue; }
      found.requirements++;
      const node = file(p), missing = [];
      for (const q of r.requirements) {
        const pkg = entity(packageId('pypi', q.name), p, {ecosystem: 'pypi', name: q.name, written: []});
        if (!pkg.attributes.written.includes(q.written)) pkg.attributes.written.push(q.written);
        edge('depends-on', node.entity, packageId('pypi', q.name), p, {basis: 'declared requirement', specifier: q.specifier, line: q.line,
          ...(q.extras?.length ? {extras: q.extras} : {}), ...(q.marker ? {marker: q.marker} : {})});
      }
      for (const i of r.includes) {
        const target = join(dirOf(p), i.path);
        if (entries.has(target)) { file(target); edge('depends-on', node.entity, fileIdIn(name, target), p, {basis: 'requirements include', line: i.line}); }
        else missing.push({path: i.path, line: i.line, why: 'not in the tree at this commit'});
      }
      if (missing.length) node.attributes.unresolved_includes = missing;
      if (r.unresolved?.length) node.attributes.unread_lines = r.unresolved.map(u => u.line);
    } else if (COMPOSE.test(p)) {
      const r = readCompose(text(p));
      if (!r.ok || !r.services.length) { unread.push({file: p, why: r.ok ? 'no service could be read' : r.why}); continue; }
      found.compositions++;
      const node = file(p), names = new Set(r.services.map(s => s.name));
      for (const s of r.services) {
        const svc = entity(serviceId(name, s.name), p, {name: s.name, compositions: []});
        if (!svc.attributes.compositions.includes(p)) svc.attributes.compositions.push(p);
        edge('produces', node.entity, svc.entity, p, {basis: 'the composition defines it', line: s.line, ...(s.partial ? {partial: true} : {})});
        for (const d of s.depends_on) if (names.has(d)) edge('depends-on', svc.entity, serviceId(name, d), p, {basis: 'compose depends_on', composition: p});
        if (typeof s.image === 'string' && s.image && !s.image.includes('${')) {
          const [bare, digest] = s.image.split('@'), colon = bare.lastIndexOf(':'), tagged = colon > bare.lastIndexOf('/');
          const image = tagged ? bare.slice(0, colon) : bare;
          entity(packageId('image', image), p, {ecosystem: 'image', name: image});
          edge('depends-on', svc.entity, packageId('image', image), p, {basis: 'compose image', ...(tagged ? {tag: bare.slice(colon + 1)} : {}), ...(digest ? {digest} : {}), composition: p});
        }
        const context = typeof s.build === 'string' ? s.build : s.build?.context;
        if (typeof context === 'string') {
          const dockerfile = join(join(dirOf(p), context), (typeof s.build === 'object' && s.build?.dockerfile) || 'Dockerfile');
          if (entries.has(dockerfile)) { file(dockerfile); edge('depends-on', svc.entity, fileIdIn(name, dockerfile), p, {basis: 'compose build', context, composition: p}); }
        }
        for (const n of s.env_names) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { entity(envId(n), p, {name: n}); edge('consumes', svc.entity, envId(n), p, {basis: 'compose environment', composition: p}); }
      }
    } else if (WORKFLOW.test(p)) {
      const r = readWorkflow(text(p));
      if (!r.ok) { unread.push({file: p, why: r.why}); continue; }
      found.workflows++;
      const node = file(p), wf = entity(workflowIdIn(name, p), p, {file: p, name: r.name ?? null, uses: r.uses.length});
      edge('derived-from', wf.entity, node.entity, p, {basis: 'the workflow is this file'});
      const used = new Map();
      for (const u of r.uses) if (u.kind === 'action' && typeof u.action === 'string') {
        const g = used.get(u.action) ?? used.set(u.action, {refs: new Set(), lines: []}).get(u.action);
        if (u.ref) g.refs.add(u.ref); g.lines.push(u.line);
      }
      for (const [action, g] of [...used].sort()) {
        entity(packageId('action', action), p, {ecosystem: 'action', name: action});
        edge('depends-on', wf.entity, packageId('action', action), p, {basis: 'workflow uses', refs: [...g.refs].sort(), lines: g.lines.sort((a, b) => a - b)});
      }
    } else if (p === 'OWNERSHIP.json') {
      const j = json(p), owners = Array.isArray(j?.owners) ? j.owners.filter(o => typeof o?.lane === 'string' && Array.isArray(o.paths)) : [];
      if (!owners.length) { unread.push({file: p, why: j ? 'no owners with a lane and paths' : 'not a JSON object'}); continue; }
      found.records.push(p); file(p);
      for (const o of owners) {
        const id = entityId({domain: 'evidence', type: 'authorization', key: `${name}:ownership/${o.lane}`}), unmatched = [], wide = [];
        let governs = 0;
        for (const pattern of o.paths.filter(x => typeof x === 'string')) {
          const covered = pattern.endsWith('/') ? paths.filter(x => x.startsWith(pattern)) : entries.has(pattern) ? [pattern] : [];
          if (!covered.length) { unmatched.push(pattern); continue; }
          if (covered.length > WIDE) { wide.push({path: pattern, files: covered.length}); continue; }
          for (const f of covered) { file(f); edge('governs', id, fileIdIn(name, f), p, {basis: 'the lane\'s path covers it', path: pattern}); governs++; }
        }
        const gaps = [...(unmatched.length ? [`${unmatched.length} path(s) cover no file of the tree at this commit`] : []), ...(wide.length ? [`${wide.length} path(s) cover more than ${WIDE} files and are not expanded`] : [])];
        entity(id, `${p}#${o.lane}`, {lane: o.lane, paths: o.paths, ...(scalar(o.writes_world_state) ? {writes_world_state: o.writes_world_state} : {}), governs,
          ...(typeof j.ownership_semantics === 'string' ? {semantics: cut(j.ownership_semantics, 400)} : {}), ...(unmatched.length ? {unmatched_paths: unmatched} : {}), ...(wide.length ? {wide_paths: wide} : {})},
        gaps.length ? {missing_evidence: gaps} : {});
        edge('derived-from', id, fileIdIn(name, p), p, {basis: 'the lane is declared in this file'});
      }
    } else if (p === 'CURRENT-AUTHORITY.json') {
      const j = json(p), active = j?.active_plan;
      if (typeof active?.version !== 'string') { unread.push({file: p, why: j ? 'no active plan with a version' : 'not a JSON object'}); continue; }
      found.records.push(p); file(p);
      const plan = v => entityId({domain: 'work', type: 'plan', key: `${name}:plan/${v}`});
      entity(plan(active.version), p, {version: active.version, ...Object.fromEntries(['component', 'path', 'sha256', 'release_anchor'].filter(k => scalar(active[k])).map(k => [k, active[k]])), state: 'active'});
      const a = j.active_authorization;
      if (typeof a?.id === 'string') {
        const authz = entityId({domain: 'evidence', type: 'authorization', key: `${name}:${a.id}`});
        entity(authz, p, {id: a.id, ...(scalar(a.status) ? {status: a.status} : {}), ...(scalar(a.record) ? {record: a.record} : {})},
          a.authorizes_plan === active.sha256 ? {} : {missing_evidence: ['the authorization names a plan digest that is not the active plan\'s']});
        if (a.authorizes_plan === active.sha256) edge('authorizes', authz, plan(active.version), p, {basis: 'the record names the plan this authorization authorizes', plan_sha256: a.authorizes_plan});
      }
      for (const s of Array.isArray(j.superseded) ? j.superseded.filter(x => typeof x?.plan_version === 'string') : []) {
        entity(plan(s.plan_version), p, {version: s.plan_version, ...Object.fromEntries(['sha256', 'authorization', 'authz_status'].filter(k => scalar(s[k])).map(k => [k, s[k]])), state: 'superseded'});
        if (typeof s.superseded_by !== 'string' || s.superseded_by === s.plan_version) continue;
        entity(plan(s.superseded_by), p, {version: s.superseded_by, state: 'named only'});
        edge('supersedes', plan(s.superseded_by), plan(s.plan_version), p, {basis: 'the record lists it as superseded', ...(scalar(s.must_not_govern_new_work) ? {must_not_govern_new_work: s.must_not_govern_new_work} : {})});
      }
    } else if (p === 'REPO_INVENTORY.md') {
      const node = file(p), rows = [];
      let stated = 0;
      text(p).split('\n').forEach((line, i) => {
        const m = INVENTORY_ROW.exec(line), other = m?.[1].toLowerCase();
        if (m && /^[a-z][a-z0-9-]{0,31}$/.test(other) && other !== HOME) {
          if (other !== name) entity(repositoryId(other), p, {name: other});      // this repository's own node is the root fact below
          entity(changeIdIn(other, m[2]), p, {commit: m[2], repository: other});
          edge('derived-from', node.entity, changeIdIn(other, m[2]), p, {basis: 'the inventory names this commit as a source it audited', retained: Number(m[3]), catalogued: Number(m[4]), line: i + 1});
          stated++;
        } else if (line.startsWith('|') && line.includes('`')) rows.push({line: i + 1, why: 'the row names no repository link with a 40-hex commit'});
      });
      if (rows.length) node.attributes.unread_rows = rows;
      if (stated) found.records.push(p); else unread.push({file: p, why: 'no row names a repository link with a 40-hex commit'});
    } else {
      const j = json(p), gateName = GATE.exec(p)[1];
      if (!j || typeof j.gate !== 'string') { unread.push({file: p, why: j ? 'no gate name' : 'not a JSON object'}); continue; }
      found.records.push(p); file(p);
      const id = entityId({domain: 'evidence', type: 'record', key: `${name}:gate/${gateName}`}), attributes = {gate: j.gate, file: p};
      for (const [k, v] of Object.entries(j).sort()) {
        if (k === 'gate' || k === 'signature') continue;
        if (scalar(v)) attributes[k] = typeof v === 'string' ? cut(v, 200) : v;
        else if (Array.isArray(v)) attributes[`${k}_count`] = v.length;
        else if (v && typeof v === 'object') attributes[k] = Object.keys(v).sort();
      }
      entity(id, p, {...attributes, signed: Boolean(j.signature)});
      edge('derived-from', id, fileIdIn(name, p), p, {basis: 'the record is this file'});
      if (/^[0-9a-f]{40}$/.test(j.source_commit ?? '')) {
        entity(changeIdIn(name, j.source_commit), p, {commit: j.source_commit, repository: name});
        edge('derived-from', id, changeIdIn(name, j.source_commit), p, {basis: 'the gate record names this commit'});
      }
    }
  }
  unread.sort((a, b) => (a.file < b.file ? -1 : 1));
  const root = {entity: repositoryId(name), ref: 'git', attributes: {commit, declared: found, ...(unread.length ? {unread} : {})},
    ...(unread.length ? {missing_evidence: [`${unread.length} file(s) are not the shape their name promises and state nothing`]} : {})};
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [root, ...[...entities.values()].sort((a, b) => byId(a.entity, b.entity)), ...[...edges.values()].sort((a, b) => byId(`${a.type}\0${a.from}\0${a.to}`, `${b.type}\0${b.from}\0${b.to}`))];
}

/** The adapter: what the sibling's files declare at the commit `ref` names now (readAt: that commit's objects). */
export function declaredSource({repo, ref = 'HEAD', name, extractor = DECLARED_EXTRACTOR} = {}) {
  return {
    id: declaredSourceIdOf(name), extractor, ref: 'git',
    authority: `what the files of the ${name} repository declare at a commit: its requirements, compositions, workflows and its own records`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => declaredFacts(repo, version, {name}),
  };
}
