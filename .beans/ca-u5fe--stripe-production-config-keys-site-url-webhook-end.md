---
# ca-u5fe
title: 'Stripe production config: keys, SITE_URL, webhook endpoint'
status: todo
type: task
priority: high
created_at: 2026-08-20T00:52:41Z
updated_at: 2026-08-20T00:52:41Z
parent: ca-l5oz
---

The wallet top-up code is shipped and verified locally against `stripe listen` +
`stripe trigger` (credit applied, redelivery of the same `event.id` wrote no second row,
a partial refund debited, `v_balance_drift` stayed empty). What remains is operator
configuration.

## Todo
- [ ] `STRIPE_SECRET_KEY` in Vercel
- [ ] `STRIPE_WEBHOOK_SECRET` in Vercel
- [ ] `SITE_URL` in Vercel
- [ ] Register the production webhook endpoint in the Stripe dashboard
