import { findVoucher, isExpired, calculateDiscount } from './vouchers.js';

export function redeem({ code, subtotal, customerTier } = {}, now = new Date()) {
  if (!Number.isInteger(subtotal) || subtotal <= 0) {
    return { status: 400, body: { error: 'INVALID_SUBTOTAL' } };
  }
  const voucher = findVoucher(code);
  if (!voucher) return { status: 404, body: { error: 'VOUCHER_NOT_FOUND' } };
  if (isExpired(voucher, now)) return { status: 410, body: { error: 'VOUCHER_EXPIRED' } };
  if (voucher.tags.includes('VIP') && customerTier !== 'VIP') {
    return { status: 403, body: { error: 'VIP_ONLY' } };
  }
  const discount = calculateDiscount(subtotal, voucher);
  return { status: 200, body: { code: voucher.code, discount, total: subtotal - discount } };
}
