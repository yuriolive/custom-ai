-- ============================================================================
-- 20260817002000_settlement_fixes.sql
--
-- Two P1 defects in PRD §5.7's deduct_token_cost, both found by the adversarial
-- pgTAP suite against real Postgres. Neither is exotic; both fire under ordinary
-- concurrent load.
--
-- ── BUG 1: a fully written-off settlement aborts and strands the transaction ──
-- The ledger insert wrote `amount = -(cost - write_off)`. When the wallet is
-- already empty the whole cost is written off, that expression is 0, and
-- wallet_ledger_sign_matches_kind demands `< 0` for usage_debit. The RPC raised
-- 23514, so the status update never ran: the row stayed `reserved` with its hold
-- intact — GPU work unbilled AND spendable balance stranded until the reaper.
-- Observed in 3 of 5 racing settlements.
--
-- Fix: skip the ledger insert when the net amount is zero. wallet_ledger is a
-- CASH BOOK; zero cash moved is not an entry. The alternative — relaxing the
-- constraint to `<= 0` — was rejected: it would admit zero-amount rows into the
-- financial record, so a ledger row would no longer imply a cash movement, and
-- that implication is exactly what invariant I4 and v_balance_drift rest on.
-- The shortfall is already recorded, on usage_transactions.write_off_micro_usd.
--
-- ── BUG 2: the specified lock order is not a total order ─────────────────────
-- FR-DB-004 says `usage_transactions -> profiles(payer) -> profiles(creator)`.
-- That is DETERMINISTIC but NOT TOTAL, and the difference is the whole bug: it
-- orders locks by ROLE, and roles are not a property of the rows. The moment two
-- settlements have swapped roles — A pays X and credits Y, B pays Y and credits
-- X — the "order" is a cycle. 20 simultaneous swapped settlements produced 19
-- deadlocks (40P01); the same load in one direction produced zero.
--
-- Fix: lock the two profile rows in canonical PRIMARY KEY order, never by role.
-- `id` is a total order over profiles, so no two settlements can ever request
-- the same pair in opposite sequence, whoever is paying whom. A retry on 40P01
-- is deliberately NOT added: it would paper over the cycle and turn a hard
-- failure into latency under exactly the load where it matters most.
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
  v_net         bigint;
  v_is_public   boolean;
  v_accrued     integer := 0;
  v_touch_creator boolean;
begin
  if p_prompt_tokens < 0 or p_completion_tokens < 0 then
    raise exception 'token counts must be non-negative (prompt=%, completion=%)',
      p_prompt_tokens, p_completion_tokens
      using errcode = '22023';
  end if;

  -- ── Lock the transaction row FIRST. Every settlement touches exactly one
  --    usage_transactions row, and profiles are always locked after it, so this
  --    tier of the order cannot participate in a cycle. ────────────────────────
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

  -- A voided txn that is retried is also a replay, not an error.
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

  v_touch_creator := (v_creator > 0 and v_txn.creator_id <> v_txn.user_id);

  -- ── I1 + I5 + BUG 2: acquire BOTH profile locks up front, in canonical
  --    primary-key order. `id` is a TOTAL order over profiles, so two
  --    settlements with swapped payer/creator roles still request the pair in
  --    the same sequence and cannot deadlock. Ordering by role instead — the
  --    PRD's `payer then creator` — is a cycle under exactly that workload.
  --    Do not "simplify" this back into role order. ──────────────────────────
  if v_touch_creator then
    if v_txn.user_id < v_txn.creator_id then
      perform 1 from public.profiles where id = v_txn.user_id    for update;
      perform 1 from public.profiles where id = v_txn.creator_id for update;
    else
      perform 1 from public.profiles where id = v_txn.creator_id for update;
      perform 1 from public.profiles where id = v_txn.user_id    for update;
    end if;
  else
    perform 1 from public.profiles where id = v_txn.user_id for update;
  end if;

  select balance_micro_usd into v_balance
    from public.profiles where id = v_txn.user_id;

  if v_balance < v_cost then
    -- The hold should have prevented this. Record the shortfall rather than
    -- silently absorbing it, and floor the balance at zero.
    v_write_off := v_cost - v_balance;
    v_new_balance := 0;
  else
    v_new_balance := v_balance - v_cost;
  end if;

  v_net := v_cost - v_write_off;    -- cash actually collected

  update public.profiles
     set balance_micro_usd        = greatest(0, v_new_balance),
         lifetime_spend_micro_usd = lifetime_spend_micro_usd + v_net,
         updated_at               = now()
   where id = v_txn.user_id;

  -- ── I4 + BUG 1: one ledger row per balance MUTATION. A fully written-off
  --    settlement moves no cash and mutates no balance, so it gets no row —
  --    rather than a zero-amount row that would violate
  --    wallet_ledger_sign_matches_kind and abort the whole settlement. The
  --    shortfall lives on usage_transactions.write_off_micro_usd instead, and
  --    v_balance_drift stays at zero either way. ──────────────────────────────
  if v_net > 0 then
    insert into public.wallet_ledger (
      user_id, kind, amount_micro_usd, balance_after_micro_usd,
      usage_transaction_id, memo
    ) values (
      v_txn.user_id, 'usage_debit', -v_net, greatest(0, v_new_balance),
      p_txn_id,
      format('%s prompt + %s completion tokens', p_prompt_tokens, p_completion_tokens)
    );
  end if;

  -- ── Creator accrual. UNIQUE(usage_transaction_id) is the second line of
  --    defense against double accrual under a concurrent retry. ──────────────
  --
  --    DELIBERATE, and asymmetric: on a write-off the creator accrues against
  --    the full notional cost while the platform only collected v_net. The
  --    creator's GPU work was performed and is owed regardless; a failure of the
  --    platform's own hold logic to reserve enough balance is the platform's
  --    loss, not the creator's. The platform therefore absorbs 100% of every
  --    shortfall, and can go net-negative on a single transaction. This is
  --    bounded by the reservation in authorize_request, so a non-trivial
  --    write_off_micro_usd anywhere is a bug in the hold path, not an expected
  --    cost of doing business — alert on it.
  if v_creator > 0 then
    insert into public.creator_earnings (
      creator_id, model_id, usage_transaction_id,
      gross_micro_usd, platform_fee_micro_usd, net_micro_usd, fee_bps_applied
    ) values (
      v_txn.creator_id, v_txn.model_id, p_txn_id,
      v_cost, v_platform, v_creator, v_txn.platform_fee_bps_snapshot
    )
    on conflict (usage_transaction_id) do nothing;

    -- Only credit when the accrual row was actually created: a racing retry that
    -- hits the ON CONFLICT must not still bump the creator's earnings.
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

comment on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean) is
  'Atomic settlement. Locks usage_transactions, then BOTH profile rows in '
  'canonical id order (a total order — never by payer/creator role, which is a '
  'cycle). Emits a wallet_ledger row only when cash actually moved.';

revoke all on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.deduct_token_cost(uuid,integer,integer,integer,integer,boolean,boolean,boolean)
  to service_role;
