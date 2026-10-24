import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { route } from '../src/router.js';

test('summary returns exactly the public mobile-picker fields', () => {
  const r = route('GET', '/vouchers/VIP20/summary');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    code: 'VIP20',
    kind: 'percent',
    value: 20,
    expiresOn: '2027-06-30',
  });
});

test('summary follows existing voucher-code normalization', () => {
  assert.deepEqual(route('GET', '/vouchers/%20welcome10%20/summary').body, {
    code: 'WELCOME10',
    kind: 'percent',
    value: 10,
    expiresOn: '2026-12-31',
  });
});

test('unknown summaries use the established voucher-not-found response', () => {
  assert.deepEqual(route('GET', '/vouchers/NOPE/summary'), {
    status: 404,
    body: { error: 'VOUCHER_NOT_FOUND' },
  });
});

test('README documents the summary endpoint', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /GET\s+`?\/vouchers\/:code\/summary/i);
});
