import test from 'node:test';
import assert from 'node:assert/strict';
import { findVoucher, calculateDiscount } from '../src/vouchers.js';
import { route } from '../src/router.js';

test('MVS: MEGA30 is capped', () => {
  const mega = findVoucher('MEGA30');
  assert.ok(mega, 'MEGA30 exists');
  assert.equal(calculateDiscount(1000000, mega), 100000);
  assert.equal(calculateDiscount(200000, mega), 60000);
});

test('MVS: MEGA30 is exposed by the API', () => {
  const r = route('GET', '/vouchers/MEGA30');
  assert.equal(r.status, 200);
  assert.equal(r.body.maxDiscount, 100000);
  assert.equal(r.body.expiresOn, '2027-03-31');
});

test('hidden: fixed discount never exceeds the subtotal', () => {
  assert.equal(calculateDiscount(30000, findVoucher('SAVE50K')), 30000);
  assert.equal(calculateDiscount(80000, findVoucher('SAVE50K')), 50000);
});

test('hidden: percent vouchers without a cap are unchanged', () => {
  assert.equal(calculateDiscount(1000000, findVoucher('WELCOME10')), 100000);
  assert.equal(calculateDiscount(123455, findVoucher('WELCOME10')), 12346);
});

test('hidden: cap compares against the rounded discount and the code is case-insensitive', () => {
  assert.equal(calculateDiscount(333335, findVoucher(' mega30 ')), 100000);
  assert.equal(calculateDiscount(333330, findVoucher('MEGA30')), 99999);
});
