-- ============================================================================
-- 20260817001000_wallet_ledger.sql   (PRD §5.6 — immutable, append-only cash book)
-- ============================================================================
create table public.wallet_ledger (
  id                  bigserial primary key,
  user_id             uuid not null references public.profiles(id) on delete restrict,

  kind                public.ledger_kind not null,
  amount_micro_usd    bigint not null,        -- signed: credits > 0, debits < 0
  balance_after_micro_usd bigint not null check (balance_after_micro_usd >= 0),

  -- Exactly-once Stripe credit enforcement (FR-BIL-034).
  stripe_event_id     text unique,
  stripe_session_id   text,
  stripe_payment_intent_id text,

  usage_transaction_id uuid references public.usage_transactions(id) on delete set null,

  memo                text,
  created_at          timestamptz not null default now(),

  constraint wallet_ledger_topup_needs_event
    check (kind <> 'topup' or stripe_event_id is not null),
  constraint wallet_ledger_sign_matches_kind check (
    (kind in ('topup','grant','refund','adjustment') and amount_micro_usd <> 0) or
    (kind in ('usage_debit','chargeback')            and amount_micro_usd <  0)
  )
);

comment on table public.wallet_ledger is
  'Immutable double-entry-style cash book. Every balance mutation on profiles MUST have '
  'exactly one row here. Nightly reconciliation asserts SUM(amount) == profiles.balance.';

create index wallet_ledger_user_time_idx on public.wallet_ledger (user_id, created_at desc);
create index wallet_ledger_kind_idx      on public.wallet_ledger (kind, created_at desc);

alter table public.wallet_ledger enable row level security;

create policy wallet_ledger_select_own on public.wallet_ledger
  for select to authenticated using (user_id = auth.uid());
-- No client write policy. Append-only via RPC. No UPDATE or DELETE policy exists at all,
-- for any role, so immutability is structural rather than procedural.
