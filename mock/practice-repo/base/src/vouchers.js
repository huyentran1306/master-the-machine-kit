export const VOUCHERS = [
  { code: 'WELCOME10', kind: 'percent', value: 10, expiresOn: '2026-12-31' },
  { code: 'SAVE50K', kind: 'fixed', value: 50000, expiresOn: '2026-12-31' },
  { code: 'VIP20', kind: 'percent', value: 20, expiresOn: '2027-06-30', tags: ['VIP'] },
  { code: 'OLD5', kind: 'percent', value: 5, expiresOn: '2025-01-31' },
];

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function findVoucher(code) {
  const wanted = normalizeCode(code);
  return VOUCHERS.find((v) => v.code === wanted) ?? null;
}

export function isExpired(voucher, now = new Date()) {
  const expiry = new Date(`${voucher.expiresOn}T00:00:00Z`);
  return now >= expiry;
}

export function calculateDiscount(subtotal, voucher) {
  if (voucher.kind === 'percent') return Math.round((subtotal * voucher.value) / 100);
  return voucher.value;
}
