// THE IDS of the dependency sources: one place where a dependency's graph identity is made, so every source that
// names the same package, variable, program, host or file names the same node.
//
// Purpose   The dependency sources (this directory) state what code needs. All of it is said with entity types the
//           contract already registers (packages/graph/schema.mjs, ophanim.graph/v1): nothing here adds a type.
//             systems/repository  <name>                 a repository (this one is `ophanim`; a sibling by its name)
//             systems/module|test|file  <path>           a file of this repository (extract/repo.mjs fileId, unchanged);
//                                 <repository>:<path>    a file of a sibling repository
//             systems/symbol      <path>#<name>          a function or exported name (extract/repo.mjs symbolId for this
//                                                        repository; <repository>:<path>#<name> for a sibling)
//             systems/component   npm:<name>             a package of the npm registry          (ecosystem `npm`)
//                                 pypi:<name>            a package of the Python package index   (ecosystem `pypi`)
//                                 node:<name>            a module of the Node platform itself    (ecosystem `node`)
//                                 program:<name>         a program run by name                   (ecosystem `program`)
//                                 action:<owner/name>    a CI action                             (ecosystem `action`)
//                                 image:<name>           a container image                       (ecosystem `image`)
//             systems/interface   env:<NAME>             an environment variable, by NAME only (never a value)
//             systems/service     host:<host>            a network host named in code or configuration
//                                 <repository>:<name>    a service a repository's composition declares
// Must never  Put a value of an environment variable, a credential or a version into an id (a version is an attribute
//           of the fact that states it, under the source version that observed it).
import {entityId} from '../../../packages/graph/index.mjs';
import {fileId, symbolId, typeOf} from '../extract/repo.mjs';

/** This repository's name in the graph (extract/repo.mjs repoSource's default). */
export const HOME = 'ophanim';
export const ECOSYSTEMS = Object.freeze(['npm', 'pypi', 'node', 'program', 'action', 'image']);
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const need = (ok, why) => { if (!ok) throw Object.assign(new Error(why), {code: 'DEPS_ID_REFUSED'}); };

export const repositoryId = name => { need(NAME.test(name), `"${name}" is not a repository name`); return entityId({domain: 'systems', type: 'repository', key: name}); };
/** A file of `repo` at the type the repository extractor gives its path. */
export const fileIdIn = (repo, p) => (repo === HOME ? fileId(p) : (need(NAME.test(repo), `"${repo}" is not a repository name`), entityId({domain: 'systems', type: typeOf(p), key: `${repo}:${p}`})));
export const symbolIdIn = (repo, p, name) => (repo === HOME ? symbolId(p, name) : (need(NAME.test(repo), `"${repo}" is not a repository name`), entityId({domain: 'systems', type: 'symbol', key: `${repo}:${p}#${name}`})));
export const packageId = (ecosystem, name) => { need(ECOSYSTEMS.includes(ecosystem), `"${ecosystem}" is not one of ${ECOSYSTEMS.join(', ')}`); need(typeof name === 'string' && name.length > 0 && name.length <= 200, 'a package has a name'); return entityId({domain: 'systems', type: 'component', key: `${ecosystem}:${name}`}); };
export const envId = name => { need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), `"${name}" is not an environment variable name`); return entityId({domain: 'systems', type: 'interface', key: `env:${name}`}); };
export const hostId = host => { need(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host), `"${host}" is not a host name`); return entityId({domain: 'systems', type: 'service', key: `host:${host}`}); };
export const serviceId = (repo, name) => { need(NAME.test(repo) && typeof name === 'string' && name.length > 0, 'a composed service has a repository and a name'); return entityId({domain: 'systems', type: 'service', key: `${repo}:${name}`}); };
