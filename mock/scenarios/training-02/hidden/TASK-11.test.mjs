import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { route } from '../src/router.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('GET /version returns package metadata', () => {
  const r = route('GET', '/version');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { name: pkg.name, version: pkg.version });
});

test('query parameters do not change the version response', () => {
  assert.deepEqual(route('GET', '/version?from=support'), route('GET', '/version'));
});

test('README documents the endpoint', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /GET\s+`?\/version|`GET \/version`/i);
});
