import test from 'node:test';
import assert from 'node:assert/strict';
import { redeem } from '../src/redeem.js';
import { route } from '../src/router.js';

const now = new Date('2026-11-01T08:00:00Z');

test('regular campaigns redeem again without an exception', () => {
  for (const code of ['WELCOME10', 'SAVE50K']) {
    const r = redeem({ code, subtotal: 250000, customerTier: 'REGULAR' }, now);
    assert.equal(r.status, 200);
  }
});

test('VIP-only campaign is still protected', () => {
  assert.equal(redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'REGULAR' }, now).status, 403);
  assert.equal(redeem({ code: 'VIP20', subtotal: 100000, customerTier: 'VIP' }, now).status, 200);
});

test('the HTTP route does not convert known regular vouchers into 500', () => {
  assert.equal(route('POST', '/redeem', { code: 'WELCOME10', subtotal: 250000, customerTier: 'REGULAR' }).status, 200);
});
