import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDiscount, findVoucher } from '../src/vouchers.js';

test('MVS: fixed discount is capped by a small subtotal', () => {
  assert.equal(calculateDiscount(30000, findVoucher('SAVE50K')), 30000);
});

test('MVS: normal fixed discount is unchanged', () => {
  assert.equal(calculateDiscount(80000, findVoucher('SAVE50K')), 50000);
});

test('hidden: zero total boundary and one VND order', () => {
  const fixed = findVoucher('SAVE50K');
  assert.equal(calculateDiscount(50000, fixed), 50000);
  assert.equal(calculateDiscount(1, fixed), 1);
});

test('hidden: percent calculation remains unchanged', () => {
  assert.equal(calculateDiscount(123455, findVoucher('WELCOME10')), 12346);
});
