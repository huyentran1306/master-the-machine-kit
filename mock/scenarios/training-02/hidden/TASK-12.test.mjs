import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

test('bulk lookup preserves order, normalization and unknown entries', () => {
  const r = route('POST', '/vouchers/lookup', { codes: [' welcome10 ', 'missing', 'VIP20'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.vouchers.length, 3);
  assert.equal(r.body.vouchers[0].code, 'WELCOME10');
  assert.equal(r.body.vouchers[1], null);
  assert.equal(r.body.vouchers[2].code, 'VIP20');
});

test('duplicates stay in their original positions', () => {
  const r = route('POST', '/vouchers/lookup', { codes: ['SAVE50K', 'save50k'] });
  assert.deepEqual(r.body.vouchers.map((v) => v.code), ['SAVE50K', 'SAVE50K']);
});

test('invalid collections are rejected', () => {
  for (const body of [{}, { codes: 'WELCOME10' }, { codes: [] }, { codes: Array(21).fill('WELCOME10') }]) {
    const r = route('POST', '/vouchers/lookup', body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'INVALID_CODES' });
  }
});

test('the upper bound of 20 is accepted', () => {
  const r = route('POST', '/vouchers/lookup', { codes: Array(20).fill('WELCOME10') });
  assert.equal(r.status, 200);
  assert.equal(r.body.vouchers.length, 20);
});
