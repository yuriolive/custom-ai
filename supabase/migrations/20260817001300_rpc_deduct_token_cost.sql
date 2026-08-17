-- ============================================================================
-- 20260817001300_rpc_deduct_token_cost.sql   (PRD §5.7)
--
-- THE atomic settlement primitive. One transaction. One row lock. Idempotent.
--
-- Invariants defended here:
--   I1  profiles.balance_micro_usd can never go negative      (FOR UPDATE + GREATEST + CHECK)
--   I2  a transaction settles at most once                    (status guard + earnings UNIQUE)
--   I3  creator + platform == cost, exactly                   (integer split, remainder to platform)
--   I4  every balance mutation has exactly one ledger row     (single transaction)
--   I5  concurrent requests from one wallet cannot overdraw   (serialized by the row lock)
--
-- Lock order (FR-DB-004): usage_transactions -> profiles(payer) -> profiles(creator).
-- ============================================================================
create or replace function public.deduct_token_cost(
  p_txn_id             uuid,
  p_prompt_tokens      integer,
  p_completion_tokens  integer,
  p_ttft_ms            integer default null,
  p_duration_ms        integer default null,
  p_cold_start         boolean default null,
  p_usage_estimated    boolean default false,
  p_client_disconnected boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_txn         record;
  v_cost        bigint;
  v_platform    bigint;
  v_creator     bigint;
  v_balance     bigint;
  v_new_balance bigint;
  v_write_off   bigint := 0;
  v_is_public   boolean;
  v_accrued     integer := 0;
begin
  if p_prompt_tokens < 0 or p_completion_tokens < 0 then
    raise exception 'token counts must be non-negative (prompt=%, completion=%)',
      p_prompt_tokens, p_completion_tokens
      using errcode = '22023';
  end if;

  -- ── Lock the transaction row FIRST. Deterministic lock order (transaction
  --    then profile) across every RPC in this schema prevents deadlocks. ──────
  select * into v_txn
    from public.usage_transactions
   where id = p_txn_id
     for update;

  if not found then
    raise exception 'unknown transaction %', p_txn_id using errcode = 'P0002';
  end if;

  -- ── I2: IDEMPOTENCY. Edge Function retries are certain, not hypothetical. ──
  if v_txn.status = 'settled' then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'txn_id',             v_txn.id,
      'cost_micro_usd',     v_txn.cost_micro_usd,
      'creator_micro_usd',  v_txn.creator_micro_usd,
      'platform_micro_usd', v_txn.platform_micro_usd,
      'balance_micro_usd',  (select balance_micro_usd from public.profiles where id = v_txn.user_id));
  end if;

  -- A voided txn that is retried is also a replay, not an error: void_reservation
  -- and the zero-token settle path both land here.
  if v_txn.status = 'voided' then
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'voided', true,
      'txn_id',             v_txn.id,
      'cost_micro_usd',     coalesce(v_txn.cost_micro_usd, 0),
      'creator_micro_usd',  coalesce(v_txn.creator_micro_usd, 0),
      'platform_micro_usd', coalesce(v_txn.platform_micro_usd, 0),
      'balance_micro_usd',  (select balance_micro_usd from public.profiles where id = v_txn.user_id));
  end if;

  if v_txn.status not in ('reserved', 'expired') then
    raise exception 'transaction % is in terminal state %', p_txn_id, v_txn.status
      using errcode = '55000';
  end if;

  -- ── Cost from the PRICE SNAPSHOT, never from live model pricing (FR-GW-024) ─
  v_cost := public.calc_token_cost_micro(
              p_prompt_tokens, p_completion_tokens,
              v_txn.price_prompt_micro_snapshot,
              v_txn.price_completion_micro_snapshot);

  -- Zero tokens delivered → void the hold rather than charge a minimum.
  if (p_prompt_tokens + p_completion_tokens) = 0 then
    update public.usage_transactions
       set status = 'voided', prompt_tokens = 0, completion_tokens = 0,
           cost_micro_usd = 0, creator_micro_usd = 0, platform_micro_usd = 0,
           hold_micro_usd = 0, ttft_ms = p_ttft_ms, duration_ms = p_duration_ms,
           cold_start = p_cold_start, client_disconnected = p_client_disconnected,
           settled_at = now()
     where id = p_txn_id;
    return jsonb_build_object('ok', true, 'voided', true, 'cost_micro_usd', 0);
  end if;

  -- ── I3: integer split, remainder to the platform. Sum is exact. ────────────
  v_platform := ceil(v_cost::numeric * v_txn.platform_fee_bps_snapshot / 10000)::bigint;
  v_creator  := v_cost - v_platform;

  select (visibility = 'public') into v_is_public
    from public.custom_models where id = v_txn.model_id;

  -- FR-BIL-021: a creator calling their own private model accrues nothing.
  if not coalesce(v_is_public, false) or v_txn.creator_id = v_txn.user_id then
    v_platform := v_cost;
    v_creator  := 0;
  end if;

  -- ── I1 + I5: lock the payer. All concurrent settlements for this user
  --    serialize here. Lock hold time is microseconds. ────────────────────────
  select balance_micro_usd into v_balance
    from public.profiles
   where id = v_txn.user_id
     for update;

  if v_balance < v_cost then
    -- The hold should have prevented this. Record the shortfall rather than
    -- silently absorbing it, and floor the balance at zero.
    v_write_off := v_cost - v_balance;
    v_new_balance := 0;
  else
    v_new_balance := v_balance - v_cost;
  end if;

  update public.profiles
     set balance_micro_usd        = greatest(0, v_new_balance),
         lifetime_spend_micro_usd = lifetime_spend_micro_usd + (v_cost - v_write_off),
         updated_at               = now()
   where id = v_txn.user_id;

  -- ── I4: the ledger entry for this debit ────────────────────────────────────
  -- Amount is the cash actually moved (cost minus write-off), so
  -- SUM(wallet_ledger.amount) still equals profiles.balance under a shortfall
  -- (see v_balance_drift).
  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    usage_transaction_id, memo
  ) values (
    v_txn.user_id, 'usage_debit', -(v_cost - v_write_off), greatest(0, v_new_balance),
    p_txn_id,
    format('%s prompt + %s completion tokens', p_prompt_tokens, p_completion_tokens)
  );

  -- ── Creator accrual. UNIQUE(usage_transaction_id) is the second line of
  --    defense against double accrual under a concurrent retry. ──────────────
  if v_creator > 0 then
    insert into public.creator_earnings (
      creator_id, model_id, usage_transaction_id,
      gross_micro_usd, platform_fee_micro_usd, net_micro_usd, fee_bps_applied
    ) values (
      v_txn.creator_id, v_txn.model_id, p_txn_id,
      v_cost, v_platform, v_creator, v_txn.platform_fee_bps_snapshot
    )
    on conflict (usage_transaction_id) do nothing;

    -- DIVERGENCE FROM PRD §5.7 (reported): the PRD updates profiles.earnings
    -- unconditionally after an ON CONFLICT DO NOTHING insert, so a racing retry
    -- that skips the accrual row still bumps the creator's earnings — a silent
    -- double-accrual. Only credit when the accrual row was actually created.
    get diagnostics v_accrued = row_count;

    if v_accrued > 0 then
      update public.profiles
         set earnings_micro_usd          = earnings_micro_usd + v_creator,
             lifetime_earnings_micro_usd = lifetime_earnings_micro_usd + v_creator,
             updated_at                  = now()
       where id = v_txn.creator_id;
    end if;
  end if;

  -- ── Settle the transaction and release the hold ────────────────────────────
  update public.usage_transactions
     set status              = 'settled',
         prompt_tokens       = p_prompt_tokens,
         completion_tokens   = p_completion_tokens,
         cost_micro_usd      = v_cost,
         creator_micro_usd   = v_creator,
         platform_micro_usd  = v_platform,
         write_off_micro_usd = v_write_off,
         usage_estimated     = p_usage_estimated,
         ttft_ms             = p_ttft_ms,
         duration_ms         = p_duration_ms,
         cold_start          = p_cold_start,
         client_disconnected = p_client_disconnected,
         hold_micro_usd      = 0,
         settled_at          = now()
   where id = p_txn_id;

  -- Denormalized catalog counters.
  update public.custom_models
     set total_requests          = total_requests + 1,
         total_prompt_tokens     = total_prompt_tokens + p_prompt_tokens,
         total_completion_tokens = total_completion_tokens + p_completion_tokens
   where id = v_txn.model_id;

  return jsonb_build_object(
    'ok', true,
    'txn_id',              p_txn_id,
    'cost_micro_usd',      v_cost,
    'creator_micro_usd',   v_creator,
    'platform_micro_usd',  v_platform,
    'write_off_micro_usd', v_write_off,
    'balance_micro_usd',   greatest(0, v_new_balance));
end $$;

revoke all on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  to service_role;
