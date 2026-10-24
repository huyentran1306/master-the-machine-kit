# voucher-service

Customer-owned voucher redemption API (practice system for the Master the Machine rehearsal).

- `POST /redeem` body `{ "code": "WELCOME10", "subtotal": 250000, "customerTier": "REGULAR" }`
  returns `{ code, discount, total }` or an error code.
- `GET /vouchers/:code` returns the voucher definition.

Run tests: `npm test`. Start: `npm start` (port 3000).
Amounts are integers in VND. Dates are UTC.
