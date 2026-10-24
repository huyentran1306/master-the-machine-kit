import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

test('MVS: malformed percent encoding is a client error', () => {
  const r = route('GET', '/vouchers/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'INVALID_VOUCHER_CODE' });
});

test('MVS: valid lookup is unchanged', () => {
  assert.equal(route('GET', '/vouchers/WELCOME10').status, 200);
});

test('hidden: another truncated UTF-8 escape is handled', () => {
  assert.deepEqual(route('GET', '/vouchers/%F0%9F').body, { error: 'INVALID_VOUCHER_CODE' });
});

test('hidden: valid encoded spaces still use normal code normalization', () => {
  const r = route('GET', '/vouchers/%20welcome10%20');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 'WELCOME10');
});

test('hidden: a well-formed unknown code remains 404', () => {
  assert.equal(route('GET', '/vouchers/DOES-NOT-EXIST').status, 404);
});
