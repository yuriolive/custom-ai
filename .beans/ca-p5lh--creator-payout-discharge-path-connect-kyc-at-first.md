---
# ca-p5lh
title: 'Creator payout discharge path: Connect KYC at first disbursement, not at listing'
status: todo
type: feature
priority: high
created_at: 2026-08-20T03:29:12Z
updated_at: 2026-08-20T03:29:12Z
---

Records the outcome of GitHub issue #32 — "Connect before monetised listings, or accrue
and pay later?". Decision: **option 1, accrue now and honour later**, with the KYC gate at
the first *disbursement* rather than at the first *listing*.

Why not the gate-on-listing option: Connect forces KYC before a first payout either way,
so gating the listing only moves the *discovery* of a KYC failure earlier — and it buys
that by making Stripe Connect a hard prerequisite for supply, which is already the
critical path (`ca-4kkd`, `ca-7c3n`). The shipped Terms of Service also already publish
the accrue-then-pay promise ("An accrued balance is owed to you; the mechanism for moving
it is still being built"), so accruals can never be retroactively voided under either
option — which caps what gating late actually costs to an onboarding chase.

## State this bean starts from (verified)
- `deduct_token_cost` writes `creator_earnings` and bumps `profiles.earnings_micro_usd`
  today. Accrual works and reconciles.
- Nothing anywhere writes `creator_earnings.payout_id` or `paid_out_at`. There is no
  payouts table, no Connect account column on `profiles` (only the payer-side
  `stripe_customer_id`), and no pgTAP assertion touching either payout column.
- `POST /api/studio/models` defaults `isPublic` to true and `deploy.ts` writes
  `visibility: 'public'` with creator-set prices. Nothing gates that on anything.

## Todo
- [ ] Confirm with counsel before building any disbursement — `docs/PAYMENTS.md` §4.5 is
      explicit that paying third parties is where the money-transmission analysis changes
- [ ] Connect account state on `profiles` (account id + a payouts-enabled flag), and decide
      whether `20260817002100_profiles_update_allowlist.sql` admits or denies the new columns
- [ ] Express onboarding route + `account.updated` webhook handling on the existing Stripe
      webhook path
- [ ] Disbursement RPC that writes `payout_id` / `paid_out_at` and decrements
      `earnings_micro_usd` in one transaction, refusing to pay an un-onboarded creator
- [ ] pgTAP for the discharge path — the payout columns currently have zero coverage, and a
      money change that does not touch `supabase/tests/` is incomplete
- [ ] Alert on aggregate un-disbursed `earnings_micro_usd`: option 1's whole risk is that
      this number grows unobserved

## Revisit trigger
Gate new monetised listings on Connect onboarding once chasing individual creators for
onboarding stops being tractable. Existing accrued balances are honoured regardless, so the
retrofit is additive and never invalidates a balance.
