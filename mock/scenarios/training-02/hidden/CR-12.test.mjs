import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

const codes = (url) => route('GET', url).body.vouchers.map((voucher) => voucher.code);

test('MVS: percent catalogue contains only percent vouchers in repository order', () => {
  assert.deepEqual(codes('/vouchers?kind=percent'), ['WELCOME10', 'VIP20', 'OLD5']);
});

test('MVS: fixed catalogue contains only fixed vouchers', () => {
  assert.deepEqual(codes('/vouchers?kind=fixed'), ['SAVE50K']);
});

test('MVS: unknown kinds are rejected consistently', () => {
  assert.deepEqual(route('GET', '/vouchers?kind=seasonal'), {
    status: 400,
    body: { error: 'INVALID_KIND' },
  });
});

test('hidden: no kind returns the complete catalogue', () => {
  assert.deepEqual(codes('/vouchers'), ['WELCOME10', 'SAVE50K', 'VIP20', 'OLD5']);
});

test('hidden: duplicate kind parameters are invalid even if values match', () => {
  assert.deepEqual(route('GET', '/vouchers?kind=percent&kind=percent'), {
    status: 400,
    body: { error: 'INVALID_KIND' },
  });
});

test('hidden: fields from the selected voucher are not projected away', () => {
  assert.deepEqual(route('GET', '/vouchers?kind=percent').body.vouchers[1].tags, ['VIP']);
});
