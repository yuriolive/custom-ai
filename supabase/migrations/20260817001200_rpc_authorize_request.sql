-- ============================================================================
-- 20260817001200_rpc_authorize_request.sql   (PRD §5.7)
-- Phase 1 of reserve-then-settle. Gates on balance NET of outstanding holds,
-- so concurrent requests cannot collectively overdraw (FR-GW-021 / I5).
-- ============================================================================
create or replace function public.authorize_request(
  p_txn_id              uuid,
  p_user_id             uuid,
  p_api_key_id          uuid,
  p_model_id            uuid,
  p_est_prompt_tokens   integer,
  p_max_tokens          integer,
  p_was_streaming       boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance      bigint;
  v_suspended    boolean;
  v_holds        bigint;
  v_available    bigint;
  v_model        record;
  v_hold         bigint;
  v_existing     record;
  v_min_floor    bigint := 100;   -- $0.0001 floor: never engage a GPU on a dust balance
begin
  -- Idempotency: a retried authorize returns the existing reservation unchanged.
  -- DIVERGENCE FROM PRD §5.7 (reported): the PRD body does
  --   `select jsonb_build_object(...) into v_balance;`
  -- which assigns jsonb into a bigint variable and raises at runtime on every
  -- replay. The dead assignment is dropped, and the envelope is filled out with
  -- hold/balance so a replay matches the shape promised in CONTRACTS.md.
  select t.hold_micro_usd, t.user_id
    into v_existing
    from public.usage_transactions t
   where t.id = p_txn_id;

  if found then
    return jsonb_build_object(
      'ok', true, 'txn_id', p_txn_id, 'replayed', true,
      'hold_micro_usd',    v_existing.hold_micro_usd,
      'balance_micro_usd', (select p.balance_micro_usd from public.profiles p
                             where p.id = v_existing.user_id));
  end if;

  -- Lock the payer row: serializes authorize and settle for this user.
  select balance_micro_usd, is_suspended
    into v_balance, v_suspended
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;

  if v_suspended then
    return jsonb_build_object('ok', false, 'code', 'account_suspended');
  end if;

  select id, user_id, status, visibility, platform_fee_bps,
         price_prompt_micro_usd_per_mtoken     as pp,
         price_completion_micro_usd_per_mtoken as pc
    into v_model
    from public.custom_models
   where id = p_model_id and deleted_at is null;

  if not found or v_model.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'model_unavailable');
  end if;

  -- Outstanding holds for this user (open reservations not yet expired).
  select coalesce(sum(hold_micro_usd), 0)
    into v_holds
    from public.usage_transactions
   where user_id = p_user_id
     and status = 'reserved'
     and expires_at > now();

  v_available := v_balance - v_holds;

  -- Conservative worst-case cost for this request.
  v_hold := greatest(
    v_min_floor,
    public.calc_token_cost_micro(
      coalesce(p_est_prompt_tokens, 0),
      coalesce(p_max_tokens, 512),
      v_model.pp, v_model.pc)
  );

  if v_available < v_hold then
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_balance',
      'balance_micro_usd',   v_balance,
      'available_micro_usd', v_available,
      'required_micro_usd',  v_hold);
  end if;

  insert into public.usage_transactions (
    id, user_id, api_key_id, model_id, creator_id, status,
    hold_micro_usd, est_prompt_tokens, max_tokens_requested, expires_at,
    price_prompt_micro_snapshot, price_completion_micro_snapshot,
    platform_fee_bps_snapshot, was_streaming
  ) values (
    p_txn_id, p_user_id, p_api_key_id, p_model_id, v_model.user_id, 'reserved',
    v_hold, p_est_prompt_tokens, p_max_tokens, now() + interval '15 minutes',
    v_model.pp, v_model.pc, v_model.platform_fee_bps, p_was_streaming
  );

  return jsonb_build_object(
    'ok', true, 'txn_id', p_txn_id,
    'hold_micro_usd',    v_hold,
    'balance_micro_usd', v_balance);
exception
  -- Two concurrent authorizes with the same txn id: the loser observes the
  -- winner's row rather than surfacing a 23505 to the gateway.
  when unique_violation then
    return jsonb_build_object('ok', true, 'txn_id', p_txn_id, 'replayed', true);
end $$;

revoke all on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)
  to service_role;
