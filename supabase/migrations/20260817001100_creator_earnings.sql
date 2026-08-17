-- ============================================================================
-- 20260817001100_creator_earnings.sql   (PRD §5.6)
-- ============================================================================
create table public.creator_earnings (
  id                  bigserial primary key,
  creator_id          uuid not null references public.profiles(id) on delete restrict,
  model_id            uuid not null references public.custom_models(id) on delete restrict,
  usage_transaction_id uuid not null unique
                        references public.usage_transactions(id) on delete restrict,

  gross_micro_usd     bigint not null check (gross_micro_usd >= 0),
  platform_fee_micro_usd bigint not null check (platform_fee_micro_usd >= 0),
  net_micro_usd       bigint not null check (net_micro_usd >= 0),
  fee_bps_applied     integer not null,

  payout_id           uuid,                   -- Phase 2: Stripe Connect transfer
  paid_out_at         timestamptz,

  created_at          timestamptz not null default now(),

  constraint creator_earnings_reconciles
    check (net_micro_usd + platform_fee_micro_usd = gross_micro_usd)
);

-- UNIQUE on usage_transaction_id makes double-accrual impossible even if
-- deduct_token_cost is retried (FR-BIL-013).

create index creator_earnings_creator_time_idx on public.creator_earnings (creator_id, created_at desc);
create index creator_earnings_unpaid_idx on public.creator_earnings (creator_id)
  where paid_out_at is null;

alter table public.creator_earnings enable row level security;

create policy creator_earnings_select_own on public.creator_earnings
  for select to authenticated using (creator_id = auth.uid());
-- No client write policy (FR-DB-002).
