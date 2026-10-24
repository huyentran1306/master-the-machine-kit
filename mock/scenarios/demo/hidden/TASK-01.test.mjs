import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { route } from '../src/router.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('GET /health', () => {
  const r = route('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', version: pkg.version });
});

test('hidden: query string tolerated', () => {
  assert.equal(route('GET', '/health?probe=1').status, 200);
});

test('hidden: documented in README', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /\/health/);
});
