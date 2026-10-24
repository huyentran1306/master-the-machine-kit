import test from 'node:test';
import assert from 'node:assert/strict';
import { redeem } from '../src/redeem.js';
import { route } from '../src/router.js';

const now = new Date('2026-11-01T08:00:00Z');

test('regular vouchers redeem again', () => {
  const r = redeem({ code: 'WELCOME10', subtotal: 250000, customerTier: 'REGULAR' }, now);
  assert.equal(r.status, 200);
  assert.equal(r.body.discount, 25000);
  assert.equal(redeem({ code: 'SAVE50K', subtotal: 250000 }, now).status, 200);
});

test('VIP rule still enforced', () => {
  assert.equal(redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'REGULAR' }, now).status, 403);
  assert.equal(redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'VIP' }, now).status, 200);
});

test('API never answers 500 for a known voucher', () => {
  assert.notEqual(route('POST', '/redeem', { code: 'SAVE50K', subtotal: 250000 }).status, 500);
});
