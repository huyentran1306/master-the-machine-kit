import test from 'node:test';
import assert from 'node:assert/strict';
import { redeem } from '../src/redeem.js';
import { findVoucher, isExpired } from '../src/vouchers.js';

const vip = (iso) => redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'VIP' }, new Date(iso));

test('MVS 1: valid on the last day', () => {
  const r = vip('2027-06-30T12:00:00Z');
  assert.equal(r.status, 200);
  assert.equal(r.body.discount, 20000);
});

test('MVS 2: expired the next day', () => {
  const r = vip('2027-07-01T00:00:00Z');
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'VOUCHER_EXPIRED');
});

test('hidden: last millisecond of the day is still valid', () => {
  assert.equal(vip('2027-06-30T23:59:59.999Z').status, 200);
});

test('hidden: rule applies to every voucher, not only VIP20', () => {
  assert.equal(isExpired(findVoucher('WELCOME10'), new Date('2026-12-31T23:59:59Z')), false);
  assert.equal(isExpired(findVoucher('WELCOME10'), new Date('2027-01-01T00:00:00Z')), true);
  assert.equal(isExpired(findVoucher('OLD5'), new Date('2026-01-01T00:00:00Z')), true);
});
