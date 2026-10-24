import { redeem } from './redeem.js';
import { findVoucher } from './vouchers.js';

export function route(method, url, body = {}) {
  try {
    const path = url.split('?')[0];
    if (method === 'POST' && path === '/redeem') return redeem(body);
    const m = path.match(/^\/vouchers\/([^/]+)$/);
    if (method === 'GET' && m) {
      const v = findVoucher(decodeURIComponent(m[1]));
      return v ? { status: 200, body: v } : { status: 404, body: { error: 'VOUCHER_NOT_FOUND' } };
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  } catch (err) {
    console.error(`[router] ${method} ${url} failed:`, err);
    return { status: 500, body: { error: 'INTERNAL_ERROR' } };
  }
}
