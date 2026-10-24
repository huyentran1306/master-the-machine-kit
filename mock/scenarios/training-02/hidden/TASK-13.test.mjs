import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { route } from '../src/router.js';

const expectedCodes = ['WELCOME10', 'SAVE50K', 'VIP20', 'OLD5'];

test('catalogue returns every voucher in repository order', () => {
  const r = route('GET', '/vouchers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vouchers.map((voucher) => voucher.code), expectedCodes);
});

test('catalogue query parameters do not alter the list', () => {
  assert.deepEqual(route('GET', '/vouchers?source=campaign-picker'), route('GET', '/vouchers'));
});

test('catalogue entries retain their complete voucher definitions', () => {
  const r = route('GET', '/vouchers');
  assert.deepEqual(r.body.vouchers.find((voucher) => voucher.code === 'VIP20').tags, ['VIP']);
});

test('README documents the catalogue endpoint', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /GET\s+`?\/vouchers(?:`|\s|$)/i);
});
