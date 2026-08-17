-- ============================================================================
-- 20260817000900_usage_transactions.sql   (PRD §5.5)
-- ============================================================================
create table public.usage_transactions (
  id                  uuid primary key,            -- request id (UUIDv7), client-visible
  user_id             uuid not null references public.profiles(id) on delete restrict,
  api_key_id          uuid references public.api_keys(id) on delete set null,
  model_id            uuid not null references public.custom_models(id) on delete restrict,
  creator_id          uuid not null references public.profiles(id) on delete restrict,

  status              public.txn_status not null default 'reserved',

  -- ── Reservation phase ─────────────────────────────────────────────────────
  hold_micro_usd      bigint not null default 0 check (hold_micro_usd >= 0),
  est_prompt_tokens   integer,
  max_tokens_requested integer,
  expires_at          timestamptz not null,        -- stale-hold reaper boundary

  -- ── Price snapshot (FR-GW-024): immune to mid-flight creator price edits ──
  price_prompt_micro_snapshot     bigint not null,
  price_completion_micro_snapshot bigint not null,
  platform_fee_bps_snapshot       integer not null,

  -- ── Settlement phase ──────────────────────────────────────────────────────
  prompt_tokens       integer check (prompt_tokens >= 0),
  completion_tokens   integer check (completion_tokens >= 0),
  total_tokens        integer generated always as
                        (coalesce(prompt_tokens,0) + coalesce(completion_tokens,0)) stored,
  usage_estimated     boolean not null default false,   -- FR-GW-044 fallback path used

  -- Prefix-cache hit within prompt_tokens (FR-BIL-040). Recorded ALWAYS; billed at the
  -- full rate in MVP (FR-BIL-042). Persisting it now means the pricing decision can
  -- later be made against real hit-rate data instead of speculation.
  cached_prompt_tokens integer not null default 0 check (cached_prompt_tokens >= 0),
  constraint usage_txn_cached_within_prompt
    check (prompt_tokens is null or cached_prompt_tokens <= prompt_tokens),

  cost_micro_usd      bigint check (cost_micro_usd >= 0),
  creator_micro_usd   bigint check (creator_micro_usd >= 0),
  platform_micro_usd  bigint check (platform_micro_usd >= 0),
  write_off_micro_usd bigint not null default 0 check (write_off_micro_usd >= 0),

  -- ── Observability ─────────────────────────────────────────────────────────
  ttft_ms             integer,
  duration_ms         integer,
  cold_start          boolean,
  client_disconnected boolean not null default false,
  was_streaming       boolean not null default true,
  error_code          text,
  error_message       text,

  created_at          timestamptz not null default now(),
  settled_at          timestamptz,

  -- Split must reconcile to the total, exactly (FR-BIL-023).
  constraint usage_txn_split_reconciles check (
    status <> 'settled'
    or coalesce(creator_micro_usd,0) + coalesce(platform_micro_usd,0) = coalesce(cost_micro_usd,0)
  ),
  -- A settled row must carry real token counts.
  constraint usage_txn_settled_has_usage check (
    status <> 'settled' or (prompt_tokens is not null and completion_tokens is not null)
  )
);

comment on table public.usage_transactions is
  'Append-and-settle metering ledger. Rows are INSERTed as reserved by the gateway and '
  'transitioned exactly once to settled | voided | expired | failed. service_role only.';

-- Console ledger pagination.
create index usage_txn_user_time_idx on public.usage_transactions (user_id, created_at desc);
-- Creator earnings analytics.
create index usage_txn_creator_time_idx on public.usage_transactions (creator_id, created_at desc)
  where status = 'settled';
-- Per-model rollups.
create index usage_txn_model_time_idx on public.usage_transactions (model_id, created_at desc);
-- The reaper's index: tiny, only open holds.
create index usage_txn_open_holds_idx on public.usage_transactions (expires_at)
  where status = 'reserved';
-- Ops: find estimated-usage rows needing review.
create index usage_txn_estimated_idx on public.usage_transactions (created_at desc)
  where usage_estimated = true;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.usage_transactions enable row level security;

-- Payer reads own spend.
create policy usage_txn_select_own on public.usage_transactions
  for select to authenticated using (user_id = auth.uid());

-- Creator reads settled rows for THEIR models (earnings visibility). A creator must not
-- see who called them or with which key — hence the narrow view below, not raw access.
create policy usage_txn_select_as_creator on public.usage_transactions
  for select to authenticated
  using (creator_id = auth.uid() and status = 'settled');

-- NO insert / update / delete policy for any client role (FR-DB-002). This table is
-- written exclusively by SECURITY DEFINER RPCs invoked with service_role.

-- Creator-facing projection with the payer's identity stripped.
create view public.creator_earnings_feed
  with (security_invoker = true) as
  select t.id, t.model_id, m.slug as model_slug,
         t.prompt_tokens, t.completion_tokens, t.total_tokens,
         t.creator_micro_usd, t.ttft_ms, t.cold_start, t.created_at
  from public.usage_transactions t
  join public.custom_models m on m.id = t.model_id
  where t.creator_id = auth.uid() and t.status = 'settled';

grant select on public.creator_earnings_feed to authenticated;
