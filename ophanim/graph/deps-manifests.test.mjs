// The declared-dependency readers of the dependency sources (ophanim/graph/deps/manifests.mjs): the text of a
// package.json, a package-lock.json, a pip requirements file, a docker compose file or a GitHub workflow gives what it
// declares, with the line where the format has lines. SYNTHETIC: every file below is text in this test; nothing is run,
// and every credential-looking value below is invented so the tests can show it is not kept.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPackageJson, readPackageLock, readRequirements, readCompose, readWorkflow, hostOf, withoutCredentials} from './deps/manifests.mjs';

const lines = (...l) => l.join('\n') + '\n';
/** Which of `values` appear anywhere in a reading: what must never be kept. */
const kept = (reading, values) => values.filter(v => JSON.stringify(reading).includes(v));

// ---- package.json --------------------------------------------------------------------------------------------------------
test('PACKAGE.JSON: identity, workspaces, engines, scripts and every declared dependency with its kind and its line', () => {
  const r = readPackageJson(lines(
    '{',
    '  "name": "demo",',
    '  "version": "1.2.3",',
    '  "private": true,',
    '  "type": "module",',
    '  "engines": {"node": ">=24 <25"},',
    '  "workspaces": ["packages/*", "tools"],',
    '  "scripts": {"test": "node --test", "fetch": "curl https://user:hunter2@pkgs.example.test/x"},',
    '  "overrides": {"dependencies": {"left-pad": "9.9.9"}},',
    '  "dependencies": {',
    '    "left-pad": "^1.3.0",',
    '    "@scope/kit": "2.0.0"',
    '  },',
    '  "devDependencies": {"left-pad": "1.0.0", "typescript": "5.9.3"},',
    '  "peerDependencies": {"react": ">=18"},',
    '  "optionalDependencies": {"private-kit": "git+https://bot:s3cret@git.example.test/kit.git#v1"}',
    '}',
  ));
  assert.deepEqual(r, {ok: true, name: 'demo', version: '1.2.3', private: true, type: 'module', workspaces: ['packages/*', 'tools'], engines: {node: '>=24 <25'},
    dependencies: [
      {name: 'left-pad', range: '^1.3.0', kind: 'dependencies', line: 11},
      {name: '@scope/kit', range: '2.0.0', kind: 'dependencies', line: 12},
      {name: 'left-pad', range: '1.0.0', kind: 'devDependencies', line: 14},
      {name: 'typescript', range: '5.9.3', kind: 'devDependencies', line: 14},
      {name: 'react', range: '>=18', kind: 'peerDependencies', line: 15},
      {name: 'private-kit', range: 'git+https://git.example.test/kit.git#v1', kind: 'optionalDependencies', line: 16},
    ],
    scripts: {test: 'node --test', fetch: 'curl https://pkgs.example.test/x'}});
  assert.deepEqual(kept(r, ['hunter2', 's3cret', '9.9.9']), [], 'no URL credential is kept, and a "dependencies" key nested elsewhere is not a declaration');
});

test('PACKAGE.JSON: what is absent reads as absent, and workspaces may be written as {packages: [...]}', () => {
  assert.deepEqual(readPackageJson('{}'), {ok: true, name: null, version: null, private: false, type: null, workspaces: [], engines: {}, dependencies: [], scripts: {}});
  assert.deepEqual(readPackageJson('{"workspaces": {"packages": ["a", "b/*"]}, "dependencies": {"odd": 7}}'),
    {ok: true, name: null, version: null, private: false, type: null, workspaces: ['a', 'b/*'], engines: {}, scripts: {},
      dependencies: [{name: 'odd', range: null, kind: 'dependencies', line: 1}]});
});

test('PACKAGE.JSON REFUSED: text that is not JSON, or JSON that is not an object, gives no facts', () => {
  const broken = readPackageJson('{"name": ');
  assert.deepEqual(Object.keys(broken), ['ok', 'why']);
  assert.equal(broken.ok, false);
  assert.match(broken.why, /^not JSON: /);
  assert.deepEqual(readPackageJson('[1, 2]'), {ok: false, why: 'the document is not a JSON object'});
});

// ---- package-lock.json ---------------------------------------------------------------------------------------------------
test('PACKAGE-LOCK v3: each installed package by its path, named after the last node_modules/, with only the HOST it resolves from', () => {
  const r = readPackageLock(lines(
    '{',
    '  "name": "demo",',
    '  "version": "1.0.0",',
    '  "lockfileVersion": 3,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {"name": "demo", "version": "1.0.0", "workspaces": ["packages/*"], "devDependencies": {"a": "1"}},',
    '    "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha512-AAAA", "dev": true},',
    '    "node_modules/a/node_modules/@scope/b": {"version": "2.1.0", "resolved": "https://user:tok3n@Private.Example.TEST:8443/b.tgz", "integrity": "sha512-BBBB", "optional": true},',
    '    "node_modules/@demo/graph": {"resolved": "packages/graph", "link": true},',
    '    "packages/graph": {"name": "@demo/graph", "version": "0.1.0"},',
    '    "node_modules/alias": {"name": "real-name", "version": "3.0.0", "resolved": "https://registry.npmjs.org/real-name/-/real-name-3.0.0.tgz", "integrity": "sha512-CCCC", "peer": true, "devOptional": true}',
    '  }',
    '}',
  ));
  assert.deepEqual(r, {ok: true, lockfileVersion: 3, root: {name: 'demo', version: '1.0.0', workspaces: ['packages/*']}, packages: [
    {path: 'node_modules/a', name: 'a', version: '1.0.0', resolved_host: 'registry.npmjs.org', integrity: 'sha512-AAAA', dev: true, optional: false, link: false, line: 8},
    {path: 'node_modules/a/node_modules/@scope/b', name: '@scope/b', version: '2.1.0', resolved_host: 'private.example.test', integrity: 'sha512-BBBB', dev: false, optional: true, link: false, line: 9},
    {path: 'node_modules/@demo/graph', name: '@demo/graph', version: null, resolved_host: null, integrity: null, dev: false, optional: false, link: true, line: 10, target: 'packages/graph'},
    {path: 'packages/graph', name: '@demo/graph', version: '0.1.0', resolved_host: null, integrity: null, dev: false, optional: false, link: false, line: 11},
    {path: 'node_modules/alias', name: 'alias', version: '3.0.0', resolved_host: 'registry.npmjs.org', integrity: 'sha512-CCCC', dev: false, optional: false, link: false, line: 12,
      alias_of: 'real-name', peer: true, dev_optional: true},
  ]});
  assert.deepEqual(kept(r, ['tok3n', 'a-1.0.0.tgz', '8443']), [], 'the resolved URL is not kept, only its host');
});

test('PACKAGE-LOCK v1: the nested dependencies tree is read into the same shape, each package at the path npm would install it', () => {
  const r = readPackageLock(lines(
    '{',
    '  "name": "old", "version": "0.0.1", "lockfileVersion": 1,',
    '  "dependencies": {',
    '    "a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha1-AAAA", "dev": true,',
    '      "dependencies": {',
    '        "b": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz", "integrity": "sha1-BBBB", "optional": true}',
    '      }},',
    '    "c": {"version": "git+https://bot:pw0rd@git.example.test/c.git#abc"}',
    '  }',
    '}',
  ));
  assert.deepEqual(r, {ok: true, lockfileVersion: 1, root: {name: 'old', version: '0.0.1', workspaces: []}, packages: [
    {path: 'node_modules/a', name: 'a', version: '1.0.0', resolved_host: 'registry.npmjs.org', integrity: 'sha1-AAAA', dev: true, optional: false, link: false, line: 4},
    {path: 'node_modules/a/node_modules/b', name: 'b', version: '2.0.0', resolved_host: 'registry.npmjs.org', integrity: 'sha1-BBBB', dev: false, optional: true, link: false, line: 6},
    {path: 'node_modules/c', name: 'c', version: 'git+https://git.example.test/c.git#abc', resolved_host: null, integrity: null, dev: false, optional: false, link: false, line: 8},
  ]});
  assert.deepEqual(kept(r, ['pw0rd']), []);
});

test('PACKAGE-LOCK REFUSED: not JSON, no package list of either kind, or a lockfile version this reader does not know', () => {
  assert.match(readPackageLock('not json').why, /^not JSON: /);
  assert.deepEqual(readPackageLock('"a string"'), {ok: false, why: 'the document is not a JSON object'});
  assert.deepEqual(readPackageLock('{"lockfileVersion": 3}'), {ok: false, why: 'no `packages` map (lockfile v2, v3) and no `dependencies` tree (v1)'});
  assert.deepEqual(readPackageLock('{"lockfileVersion": 4, "packages": {}}'), {ok: false, why: 'lockfileVersion 4 is not one this reader knows (1, 2, 3)'});
});

// ---- requirements.txt ----------------------------------------------------------------------------------------------------
test('REQUIREMENTS: name (as PyPI normalises it, and as written), specifier, extras, marker and line; what is not a named requirement is unresolved', () => {
  const r = readRequirements(lines(
    '# a comment',
    '',
    'fastapi>=0.139.0',
    'uvicorn[standard, http2] >= 0.49 , < 1.0  # trailing comment',
    'PyMuPDF==1.28.0 ; python_version < "3.11"',
    'Typing_Extensions.Backport',
    'requests \\',
    '    >=2.0 \\',
    '    --hash=sha256:aaaa --hash=sha256:bbbb',
    'kit @ https://bot:s3cret@Files.Example.TEST/kit-1.0.whl ; sys_platform == "linux"',
    'local-kit @ file:///opt/kits/local',
    '-r base.txt',
    '--requirement=more/extra.txt',
    '-c constraints.txt',
    '--index-url https://user:pw0rd@pypi.example.test/simple',
    '--no-binary :all:',
    '-e git+https://t0ken@git.example.test/x.git#egg=x',
    'git+https://git.example.test/y.git',
    './vendor/pkg',
    'dist/pkg-1.0-py3-none-any.whl',
    'pkg-2.0.tar.gz',
    'bad name here',
    'weird==',
  ));
  assert.deepEqual(r, {ok: true,
    requirements: [
      {name: 'fastapi', written: 'fastapi', specifier: '>=0.139.0', extras: [], marker: null, line: 3},
      {name: 'uvicorn', written: 'uvicorn', specifier: '>=0.49,<1.0', extras: ['standard', 'http2'], marker: null, line: 4},
      {name: 'pymupdf', written: 'PyMuPDF', specifier: '==1.28.0', extras: [], marker: 'python_version < "3.11"', line: 5},
      {name: 'typing-extensions-backport', written: 'Typing_Extensions.Backport', specifier: '', extras: [], marker: null, line: 6},
      {name: 'requests', written: 'requests', specifier: '>=2.0', extras: [], marker: null, line: 7, hashes: 2},
      {name: 'kit', written: 'kit', specifier: '', extras: [], marker: 'sys_platform == "linux"', line: 10, url_host: 'files.example.test'},
      {name: 'local-kit', written: 'local-kit', specifier: '', extras: [], marker: null, line: 11, url_host: null},
    ],
    includes: [{path: 'base.txt', line: 12, kind: 'requirement'}, {path: 'more/extra.txt', line: 13, kind: 'requirement'}, {path: 'constraints.txt', line: 14, kind: 'constraint'}],
    options: [{text: '--index-url https://pypi.example.test/simple', line: 15}, {text: '--no-binary :all:', line: 16}],
    unresolved: [
      {line: 17, text: '-e git+https://git.example.test/x.git#egg=x'},
      {line: 18, text: 'git+https://git.example.test/y.git'},
      {line: 19, text: './vendor/pkg'},
      {line: 20, text: 'dist/pkg-1.0-py3-none-any.whl'},
      {line: 21, text: 'pkg-2.0.tar.gz'},
      {line: 22, text: 'bad name here'},
      {line: 23, text: 'weird=='},
    ]});
  assert.deepEqual(kept(r, ['s3cret', 'pw0rd', 't0ken', 'kit-1.0.whl']), [], 'no URL credential is kept, and of a named URL only the host');
});

test('REQUIREMENTS: an empty file declares nothing, and text holding a NUL byte is refused', () => {
  assert.deepEqual(readRequirements('# only a comment\n\n'), {ok: true, requirements: [], includes: [], options: [], unresolved: []});
  assert.deepEqual(readRequirements('fastapi\0>=1'), {ok: false, why: 'the text holds a NUL byte: not a requirements file'});
});

// ---- docker compose ------------------------------------------------------------------------------------------------------
test('COMPOSE: each service with its line, image, build, what it depends on, the NAMES of its environment, its env files and ports', () => {
  const r = readCompose(lines(
    '# comment',
    "version: '3.8'",
    'services:',
    '  backend:',
    '    build:',
    '      context: .',
    '      dockerfile: docker/backend.Dockerfile',
    '      target: production',
    '    ports:',
    '      - "8000:8000"',
    '      - 9000',
    '    environment:',
    '      - ENVIRONMENT=development',
    '      - DATABASE_URL=postgresql://lexi:hunter2@postgres:5432/lexi',
    '      - API_KEY=${API_KEY}',
    '      - ORIGINS=${ORIGINS:-https://x.example.test}   # with a default',
    '      - PASSTHROUGH',
    '    env_file: .env',
    '    depends_on:',
    '      postgres:',
    '        condition: service_healthy',
    '    healthcheck:',
    '      test: ["CMD", "curl", "-f",',
    '             "http://localhost:8000/health"]',
    '  frontend:',
    '    build: ./web',
    '    depends_on: [backend, postgres]',
    '    env_file:',
    '    - web.env',
    '    - path: optional.env',
    '      required: false',
    '    ports: ["80:80"]',
    '  postgres:',
    '    image: "postgres:15-alpine"  # pinned',
    '    environment:',
    '      POSTGRES_USER: lexi',
    '      POSTGRES_PASSWORD: hunter2',
    "      'POSTGRES_DB': $DB_NAME",
    '    volumes:',
    '      - data:/var/lib/postgresql/data',
    '  idle:',
    'volumes:',
    '  data: {}',
  ));
  assert.deepEqual(r, {ok: true, unresolved: [], services: [
    {name: 'backend', line: 4, image: null, build: {context: '.', dockerfile: 'docker/backend.Dockerfile', target: 'production'}, depends_on: ['postgres'],
      env_names: ['ENVIRONMENT', 'DATABASE_URL', 'API_KEY', 'ORIGINS', 'PASSTHROUGH'], env_files: ['.env'], ports: ['8000:8000', '9000'],
      interpolates: ['API_KEY', 'ORIGINS'], partial: false},
    {name: 'frontend', line: 25, image: null, build: {context: './web', dockerfile: null, target: null}, depends_on: ['backend', 'postgres'],
      env_names: [], env_files: ['web.env', 'optional.env'], ports: ['80:80'], interpolates: [], partial: false},
    {name: 'postgres', line: 33, image: 'postgres:15-alpine', build: null, depends_on: [],
      env_names: ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'], env_files: [], ports: [], interpolates: ['DB_NAME'], partial: false},
    {name: 'idle', line: 41, image: null, build: null, depends_on: [], env_names: [], env_files: [], ports: [], interpolates: [], partial: false},
  ]});
  assert.deepEqual(kept(r, ['hunter2', 'development', 'x.example.test', 'postgresql:']), [], 'an environment entry is its NAME; no value and no default is kept');
});

test('COMPOSE OUTSIDE THE SUBSET: a service using a merge key, an alias, a block scalar, extends or a long-form port is listed, marked partial, with the reason', () => {
  const r = readCompose(lines(
    'x-common: &common',
    '  restart: always',
    'services:',
    '  web:',
    '    <<: *common',
    '    image: web:1',
    '    command: |',
    '      echo one',
    '      import: nothing',
    '    ports:',
    '      - target: 80',
    '        published: 8080',
    '      - "443:443"',
    '  worker:',
    '    extends:',
    '      service: web',
    '    environment:',
    '      - ${DYNAMIC}=value-kept-out',
    '      - GOOD=1',
    '    labels: {tier: back}',
    '  copy: *common',
    '  anchored: &named',
    '    image: plain:2',
    'include:',
    '  - other.yml',
  ));
  const bare = {image: null, build: null, depends_on: [], env_names: [], env_files: [], ports: [], interpolates: []};
  assert.deepEqual(r, {ok: true,
    services: [
      {...bare, name: 'web', line: 4, image: 'web:1', ports: ['443:443'], partial: true},
      {...bare, name: 'worker', line: 14, env_names: ['GOOD'], interpolates: ['DYNAMIC'], partial: true},
      {...bare, name: 'copy', line: 21, partial: true},
      {...bare, name: 'anchored', line: 22, image: 'plain:2', partial: false},
    ],
    unresolved: [
      {service: 'web', key: '<<', line: 5, why: 'a merge key: what it merges in is not read'},
      {service: 'web', key: 'command', line: 7, why: 'a block scalar is not read'},
      {service: 'web', key: 'ports', line: 11, why: 'a port written as a map is not read'},
      {service: 'worker', key: 'extends', line: 15, why: 'extends another service: what it inherits is not read'},
      {service: 'worker', key: 'environment', line: 18, why: 'an entry whose name is not a plain variable name'},
      {service: 'worker', key: 'labels', line: 20, why: 'a flow map is not read'},
      {service: 'copy', key: null, line: 21, why: 'the service is an alias, not a map'},
      {service: null, key: 'include', line: 24, why: 'includes other files: their services are not read'},
    ]});
  assert.deepEqual(kept(r, ['value-kept-out']), []);
});

test('COMPOSE REFUSED: a second document, a tab indent, no services, and every shape the subset reader cannot place, each with its line', () => {
  const why = (...l) => readCompose(lines(...l));
  assert.deepEqual(why('services:', '  a:', '    image: x', '---', 'services:', '  b:', '    image: y'), {ok: false, why: 'line 4: a second document; only one is read'});
  assert.deepEqual(why('services:', '\tweb:', '    image: x'), {ok: false, why: 'line 2: a tab in the indentation'});
  assert.deepEqual(why('volumes:', '  data:'), {ok: false, why: 'no `services` map at the top level'});
  assert.deepEqual(why('services: *elsewhere'), {ok: false, why: 'no `services` map at the top level'});
  assert.deepEqual(why('services:', '  a:', '    command: one', '      two'),
    {ok: false, why: 'line 4: indented deeper than the value above it (a plain scalar over several lines is not read)'});
  assert.deepEqual(why('services:', '    a:', '      image: x', '  b:', '    image: y'), {ok: false, why: 'line 4: the indentation does not line up with a block above it'});
  assert.deepEqual(why('services:', '  a:', '    image: x', '  a:', '    image: y'), {ok: false, why: 'line 4: the key "a" is written twice'});
  assert.deepEqual(why('services:', '  a:', '    ports:', '      - - 1'), {ok: false, why: 'line 4: a list written directly inside a list item'});
  assert.deepEqual(why('services:', '  a:', '    ports: ["80:80"'), {ok: false, why: 'line 3: a flow collection that is never closed'});
  assert.deepEqual(why('services:', '  a:', '    image: "x'), {ok: false, why: 'line 3: a quoted scalar that does not end on its line'});
  assert.deepEqual(why('services:', '  a:', '    just words'), {ok: false, why: 'line 3: neither `key: value` nor a list item'});
  assert.deepEqual(why('- a', '- b'), {ok: false, why: 'the document is not a map'});
  assert.deepEqual(why('# nothing here'), {ok: false, why: 'the document is empty'});
});

test('COMPOSE: a leading document marker is one document, and an anchor names a node that is still read', () => {
  const r = readCompose(lines('---', 'services:', '  a: &base', '    image: x:1', '    environment: &env', '      - ONE=1'));
  assert.deepEqual(r, {ok: true, unresolved: [], services: [
    {name: 'a', line: 3, image: 'x:1', build: null, depends_on: [], env_names: ['ONE'], env_files: [], ports: [], interpolates: [], partial: false}]});
});

// ---- GitHub workflow -----------------------------------------------------------------------------------------------------
test('WORKFLOW: every `uses:` as action, path and ref, every node version, and the first word of every `run:`, by line', () => {
  const r = readWorkflow(lines(
    'name: "CI"   # the name',
    'on: [push]',
    'env:',
    "  NODE_VERSION: '20'",
    'defaults:',
    '  run:',
    '    working-directory: app',
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    "        node-version: ['22', 24]",
    '    steps:',
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    '      - name: Node',
    '        uses: actions/setup-node@v4',
    '        with:',
    '          node-version: ${{ matrix.node-version }}',
    '      - uses: github/codeql-action/upload-sarif@v3',
    '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:3.19',
    '      - uses: "owner/repo/.github/workflows/reuse.yml@main"',
    '      - uses: ${{ matrix.action }}',
    '      - run: npm ci --ignore-scripts',
    '      - name: Script',
    '        run: |',
    '          # a comment',
    '          set -euo pipefail',
    '          uses: not/a-step@v1',
    '          curl -fsS \\',
    '            https://example.test/x',
    '',
    '          TOKEN=abc123 node tool.mjs',
    '          RESULT=$(node other.mjs)',
    '      - name: Folded',
    '        run: >-',
    '          node a.mjs',
    '          --flag',
    '      - with:',
    "          node-version: '24.22.1'",
    '          node-version-file: .nvmrc',
    '        uses: actions/setup-node@v4',
    '  other:',
    '    strategy:',
    '      matrix:',
    '        node-version:',
    '          - 18.x',
    '          - "20.x"',
    '    steps:',
    '      - run: "make all"',
    '      - run: |',
    "          python3 - <<'PY'",
    '          import json',
    '          print(json.dumps({}))',
    '          PY',
    '          echo finished',
  ));
  assert.deepEqual(r, {ok: true, name: 'CI',
    uses: [
      {action: 'actions/checkout', ref: '11d5960a326750d5838078e36cf38b85af677262', line: 14, kind: 'action', comment: 'v4.4.0'},
      {action: 'actions/setup-node', ref: 'v4', line: 16, kind: 'action'},
      {action: 'github/codeql-action', ref: 'v3', line: 19, kind: 'action', path: 'upload-sarif'},
      {action: './.github/actions/local', ref: null, line: 20, kind: 'local'},
      {action: 'docker://alpine', ref: '3.19', line: 21, kind: 'docker'},
      {action: 'owner/repo', ref: 'main', line: 22, kind: 'workflow', path: '.github/workflows/reuse.yml'},
      {action: 'actions/setup-node', ref: 'v4', line: 42, kind: 'action'},
    ],
    node_versions: [{value: '22', line: 12}, {value: '24', line: 12}, {value: '${{ matrix.node-version }}', line: 18, expression: true},
      {value: '24.22.1', line: 40}, {value: '18.x', line: 47}, {value: '20.x', line: 48}],
    node_version_files: [{path: '.nvmrc', line: 41}],
    runs: [
      {line: 24, first_word: 'npm'},
      {line: 28, first_word: 'set', block: true},
      {line: 29, first_word: 'uses:', block: true},
      {line: 30, first_word: 'curl', block: true},
      {line: 33, first_word: 'node', block: true},
      {line: 34, first_word: 'RESULT=', assignment: true, block: true},
      {line: 37, first_word: 'node', block: true},
      {line: 50, first_word: 'make'},
      {line: 52, first_word: 'python3', block: true},
      {line: 56, first_word: 'echo', block: true},
    ],
    unresolved: [{line: 23, text: '${{ matrix.action }}'}]});
  assert.deepEqual(kept(r, ['abc123', 'not/a-step', 'json.dumps']), [],
    'a value assigned before a command is not kept, a `uses:` inside a script is not a step, and the body of a here-document is not commands');
});

test('WORKFLOW REFUSED: text with no top-level `jobs:` is not a workflow file', () => {
  assert.deepEqual(readWorkflow(lines('name: an action', 'runs:', '  using: node24', '  steps:', '    - uses: actions/checkout@v4')),
    {ok: false, why: 'no `jobs:` at the top level: not a workflow file'});
});

// ---- shared --------------------------------------------------------------------------------------------------------------
test('A URL gives its host in lowercase and nothing else; credentials are removed from text that is kept', () => {
  assert.deepEqual(['https://Registry.Example.TEST/a/b', 'git+ssh://git@git.example.test:22/x.git', 'http://u:p@h.example.test:8080/?q=1', 'packages/graph', 'file:///opt/x']
    .map(hostOf), ['registry.example.test', 'git.example.test', 'h.example.test', null, null]);
  assert.equal(withoutCredentials('--extra-index-url https://u:p@a.example.test/s --find-links http://t0k@b.example.test/'),
    '--extra-index-url https://a.example.test/s --find-links http://b.example.test/');
});

test('the same text gives the same reading', () => {
  const pkg = '{"name": "x", "dependencies": {"a": "1"}}', req = 'a>=1\n-r b.txt\n', compose = 'services:\n  a:\n    image: x\n', wf = 'jobs:\n  a:\n    steps:\n      - run: ls\n';
  assert.deepEqual([readPackageJson(pkg), readRequirements(req), readCompose(compose), readWorkflow(wf)],
    [readPackageJson(pkg), readRequirements(req), readCompose(compose), readWorkflow(wf)]);
});
