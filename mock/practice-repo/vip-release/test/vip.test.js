import test from 'node:test';
import assert from 'node:assert/strict';
import { redeem } from '../src/redeem.js';

const now = new Date('2026-11-01T08:00:00Z');

test('VIP vouchers are VIP only', () => {
  assert.equal(redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'REGULAR' }, now).status, 403);
});

test('VIP customers can redeem VIP vouchers', () => {
  const r = redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'VIP' }, now);
  assert.equal(r.status, 200);
  assert.equal(r.body.discount, 20000);
});
