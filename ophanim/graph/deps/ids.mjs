// THE IDS of the opt-in dependency sources (this directory): one place where they name a node, so a sibling's package,
// variable, program or file is named exactly as Slice B2's sources name this repository's.
//
// Purpose   Slice B2 (ophanim/graph/extract/, contract 1.2.0) owns the ids of what code needs: a package
//           (`systems/package`), an environment variable by NAME (`systems/environment-variable`), a program
//           (`systems/executable`), a host (`systems/host`), a runtime, a repository. They are re-exported here unchanged,
//           and the sibling repositories' and Python's forms are added in the same types. Nothing here adds a type.
//             systems/module|test|file  <path>           a file of this repository (extract/repo.mjs fileId);
//                                 <repository>:<path>    a file of a sibling repository (B2's telosFileId form)
//             systems/symbol      <path>#<name>          a function or exported name; <repository>:<path>#<name> for a sibling
//             systems/test        <repository>:<path>    a sibling's file as a CHECK, where the sibling itself declares it one
//             systems/change      <commit>               a commit, this repository's or a sibling's (extract/repo.mjs changeId)
//             systems/workflow    <repository>:<file>    a sibling's CI workflow
//             systems/service     <repository>:<name>    a service a sibling's composition declares
//             systems/package     npm/<name>@<version>, npm/<name>, node/<name>, workspace/<name>   B2's forms
//                                 python/<module>        a Python module by its IMPORT name: the standard library or an
//                                                        installed distribution, which the import does not say
//                                 pypi/<name>[@<version>]  a distribution a requirements file declares (a version only when
//                                                        the requirement pins one with ==)
//                                 image/<name>[@<tag>]   a container image a composition runs
//             systems/repository  github.com/<owner>/<name>   a CI action's repository (B2's form)
// Must never  Put a value of an environment variable or a credential into an id; make a second id form for what B2 names.
import {entityId} from '../../../packages/graph/index.mjs';
import {fileId, symbolId, changeId, typeOf} from '../extract/repo.mjs';
import {npmPackageId, unresolvedPackageId, builtinId, workspacePackageId, envId, executableId, hostId, runtimeId, repositoryId} from '../extract/code.mjs';

export {npmPackageId, unresolvedPackageId, builtinId, workspacePackageId, envId, executableId, hostId, runtimeId, repositoryId};
/** This repository's name in the graph (extract/repo.mjs repoSource's default). */
export const HOME = 'ophanim';
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const need = (ok, why) => { if (!ok) throw Object.assign(new Error(why), {code: 'DEPS_ID_REFUSED'}); };
const sibling = repo => need(NAME.test(repo) && repo !== HOME, `"${repo}" is not a sibling repository name`);
const pkg = key => entityId({domain: 'systems', type: 'package', key});

/** A file of `repo` at the type the repository extractor gives its path. */
export const fileIdIn = (repo, p) => (repo === HOME ? fileId(p) : (sibling(repo), entityId({domain: 'systems', type: typeOf(p), key: `${repo}:${p}`})));
export const symbolIdIn = (repo, p, name) => (repo === HOME ? symbolId(p, name) : (sibling(repo), entityId({domain: 'systems', type: 'symbol', key: `${repo}:${p}#${name}`})));
/** A sibling's file as a check, where the sibling's own record declares it one (its file node stays what its path makes it). */
export const checkIdIn = (repo, p) => { sibling(repo); return entityId({domain: 'systems', type: 'test', key: `${repo}:${p}`}); };
/** A commit: a git commit id names one commit whichever repository holds it. */
export const commitId = commit => { need(/^[0-9a-f]{40}$/.test(commit), 'a commit is 40 hex'); return changeId(commit); };
export const workflowIdIn = (repo, file) => { sibling(repo); return entityId({domain: 'systems', type: 'workflow', key: `${repo}:${file}`}); };
export const serviceId = (repo, name) => { sibling(repo); need(typeof name === 'string' && name.length > 0, 'a composed service has a name'); return entityId({domain: 'systems', type: 'service', key: `${repo}:${name}`}); };
export const pythonModuleId = name => { need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), `"${name}" is not a Python module name`); return pkg(`python/${name}`); };
export const pypiPackageId = (name, version = null) => { need(typeof name === 'string' && name.length > 0, 'a distribution has a name'); return pkg(`pypi/${name}${version ? `@${version}` : ''}`); };
export const imageId = (name, tag = null) => { need(typeof name === 'string' && name.length > 0, 'an image has a name'); return pkg(`image/${name}${tag ? `@${tag}` : ''}`); };
export const actionId = name => repositoryId(`github.com/${name}`);
