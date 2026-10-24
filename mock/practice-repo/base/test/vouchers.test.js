import test from 'node:test';
import assert from 'node:assert/strict';
import { findVoucher, calculateDiscount, isExpired } from '../src/vouchers.js';
import { route } from '../src/router.js';

test('codes are matched case-insensitively and trimmed', () => {
  assert.equal(findVoucher(' welcome10 ').code, 'WELCOME10');
  assert.equal(findVoucher('nope'), null);
});

test('percent discount is rounded to whole VND', () => {
  assert.equal(calculateDiscount(123455, findVoucher('WELCOME10')), 12346);
});

test('old vouchers are expired', () => {
  assert.equal(isExpired(findVoucher('OLD5'), new Date('2026-01-01T00:00:00Z')), true);
});

test('unknown route is 404', () => {
  assert.equal(route('GET', '/nope').status, 404);
});

test('invalid subtotal is rejected', () => {
  assert.equal(route('POST', '/redeem', { code: 'VIP20', subtotal: -1 }).status, 400);
});
