import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

test('MVS: one trailing slash is equivalent to a canonical voucher lookup', () => {
  const r = route('GET', '/vouchers/WELCOME10/');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 'WELCOME10');
});

test('MVS: an unknown code with one trailing slash remains a voucher not found', () => {
  assert.deepEqual(route('GET', '/vouchers/NOPE/'), {
    status: 404,
    body: { error: 'VOUCHER_NOT_FOUND' },
  });
});

test('hidden: a lookup with query parameters is also normalized by the gateway', () => {
  assert.equal(route('GET', '/vouchers/WELCOME10/?source=gateway').status, 200);
});

test('hidden: two slashes do not make a different route valid', () => {
  assert.deepEqual(route('GET', '/vouchers/WELCOME10//'), {
    status: 404,
    body: { error: 'NOT_FOUND' },
  });
});
