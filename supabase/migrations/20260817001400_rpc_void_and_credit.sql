-- ============================================================================
-- 20260817001400_rpc_void_and_credit.sql   (PRD §5.7)
-- ============================================================================
-- Release a hold with no charge: upstream failed before producing any token.
create or replace function public.void_reservation(
  p_txn_id     uuid,
  p_error_code text default null,
  p_error_message text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  update public.usage_transactions
     set status = 'voided', hold_micro_usd = 0,
         cost_micro_usd = 0, creator_micro_usd = 0, platform_micro_usd = 0,
         error_code = p_error_code, error_message = left(p_error_message, 1000),
         settled_at = now()
   where id = p_txn_id and status = 'reserved';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('ok', true, 'voided', v_updated > 0);
end $$;

-- Idempotent Stripe credit. The UNIQUE on stripe_event_id makes a duplicate
-- webhook delivery a no-op instead of a double credit (FR-BIL-034).
create or replace function public.credit_wallet(
  p_user_id          uuid,
  p_amount_micro_usd bigint,
  p_kind             public.ledger_kind,
  p_stripe_event_id  text default null,
  p_stripe_session_id text default null,
  p_memo             text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance bigint;
  v_max     bigint;
  v_new     bigint;
begin
  if p_amount_micro_usd <= 0 then
    raise exception 'credit amount must be positive' using errcode = '22023';
  end if;

  if p_stripe_event_id is not null
     and exists (select 1 from public.wallet_ledger where stripe_event_id = p_stripe_event_id) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;

  select balance_micro_usd, max_balance_micro_usd
    into v_balance, v_max
    from public.profiles where id = p_user_id for update;

  if not found then
    raise exception 'unknown user %', p_user_id using errcode = 'P0002';
  end if;

  v_new := v_balance + p_amount_micro_usd;
  if v_new > v_max then
    return jsonb_build_object('ok', false, 'code', 'max_balance_exceeded',
                              'max_micro_usd', v_max);
  end if;

  update public.profiles
     set balance_micro_usd = v_new, updated_at = now()
   where id = p_user_id;

  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    stripe_event_id, stripe_session_id, memo
  ) values (
    p_user_id, p_kind, p_amount_micro_usd, v_new,
    p_stripe_event_id, p_stripe_session_id, p_memo
  );

  return jsonb_build_object('ok', true, 'balance_micro_usd', v_new);
exception
  when unique_violation then                     -- concurrent duplicate webhook
    return jsonb_build_object('ok', true, 'replayed', true);
end $$;

revoke all on function public.void_reservation(uuid,text,text) from public, anon, authenticated;
revoke all on function public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text)
  from public, anon, authenticated;
grant execute on function public.void_reservation(uuid,text,text) to service_role;
grant execute on function public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text)
  to service_role;
