// Independent review 2026-11-16, SY4: the root lockfile pinned 49 of its 52 registry packages by version
// only, with no `integrity` and no `resolved`, so `npm ci` could not check the bytes it installed. A
// workspace install reads only the root lockfile, so every registry package in it must carry both.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lockOf = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

// A registry package: an installed entry (under node_modules/) that is not a workspace link and not a
// local file or git dependency.
export function unpinned(lock) {
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.split('/').includes('node_modules') || entry.link) continue;
    if (entry.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) continue;
    if (!entry.integrity || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity) || !entry.resolved) out.push(`${key}@${entry.version}`);
  }
  return out;
}

test('SY4: every registry package in the root lockfile carries integrity and resolved', () => {
  const lock = lockOf('package-lock.json');
  assert.equal(lock.lockfileVersion, 3);
  const registry = Object.entries(lock.packages).filter(([k, e]) => k.split('/').includes('node_modules') && !e.link);
  assert.ok(registry.length >= 50, `the root lockfile names the vendor SDKs and their dependencies (${registry.length})`);
  assert.deepEqual(unpinned(lock), [], 'registry packages pinned by version only');
});

test('SY4: the root and pantheon lockfiles agree on every package they both pin', () => {
  const rootLock = lockOf('package-lock.json'), nested = lockOf('pantheon/package-lock.json');
  const differ = [];
  for (const [key, entry] of Object.entries(rootLock.packages)) {
    if (!key.startsWith('pantheon/node_modules/')) continue;
    const other = nested.packages[key.slice('pantheon/'.length)];
    if (!other) continue;
    for (const f of ['version', 'resolved', 'integrity']) if (other[f] !== entry[f]) differ.push(`${key} ${f}`);
  }
  assert.deepEqual(differ, []);
});

test('SY4: the check itself refuses a package without integrity', () => {
  const lock = {packages: {'': {}, 'node_modules/a': {version: '1.0.0'}, 'node_modules/b': {version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz', integrity: 'sha512-AAAA'},
    'node_modules/ws': {link: true, resolved: 'pkg'}}};
  assert.deepEqual(unpinned(lock), ['node_modules/a@1.0.0']);
});
