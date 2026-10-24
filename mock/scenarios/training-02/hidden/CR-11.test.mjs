import test from 'node:test';
import assert from 'node:assert/strict';
import { redeem } from '../src/redeem.js';
import { calculateDiscount, findVoucher } from '../src/vouchers.js';
import { route } from '../src/router.js';

const now = new Date('2027-06-01T08:00:00Z');
const use = (subtotal) => redeem({ code: 'START15', subtotal, customerTier: 'REGULAR' }, now);

test('MVS: minimum order is enforced with the required response', () => {
  const r = use(199999);
  assert.equal(r.status, 422);
  assert.deepEqual(r.body, { error: 'MINIMUM_SUBTOTAL', minimum: 200000 });
});

test('MVS: exact minimum receives 15 percent', () => {
  const r = use(200000);
  assert.equal(r.status, 200);
  assert.equal(r.body.discount, 30000);
});

test('MVS: campaign discount is capped', () => {
  assert.equal(use(1000000).body.discount, 75000);
});

test('MVS: campaign fields are exposed', () => {
  const r = route('GET', '/vouchers/START15');
  assert.equal(r.status, 200);
  assert.equal(r.body.minSubtotal, 200000);
  assert.equal(r.body.maxDiscount, 75000);
  assert.equal(r.body.expiresOn, '2027-12-31');
});

test('hidden: just above the minimum rounds normally', () => {
  assert.equal(use(200003).body.discount, 30000);
});

test('hidden: cap boundary and existing uncapped voucher remain correct', () => {
  const start = findVoucher('START15');
  assert.equal(calculateDiscount(500000, start), 75000);
  assert.equal(calculateDiscount(499999, start), 75000);
  assert.equal(calculateDiscount(123455, findVoucher('WELCOME10')), 12346);
});
