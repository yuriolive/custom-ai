-- ============================================================================
-- 20260818000300_stripe_topup.sql   (PRD §4.4.4 — FR-BIL-030…036)
-- ============================================================================
-- Everything the Stripe top-up path needs that the original billing migrations
-- left out, and nothing else:
--
--   1. credit_wallet() gains p_stripe_payment_intent_id. The column already
--      existed on wallet_ledger; no RPC could populate it. Without it a later
--      `charge.refunded` webhook — which identifies itself by payment intent and
--      by nothing else we store — cannot be traced back to the user it must
--      debit.
--   2. debit_wallet_reversal(): the missing half of FR-BIL-035. credit_wallet
--      refuses non-positive amounts by design, so a refund or a dispute had no
--      way in.
--   3. profiles.flagged_for_review_at — a chargeback is a fraud signal a human
--      must look at. It deliberately does NOT auto-suspend: a suspension is a
--      customer-visible outage, and a first dispute is frequently a cardholder
--      mistake rather than fraud.

-- ── 1. profiles: ops review flag ────────────────────────────────────────────
alter table public.profiles
  add column if not exists flagged_for_review_at timestamptz,
  add column if not exists flagged_for_review_reason text;

comment on column public.profiles.flagged_for_review_at is
  'Set by debit_wallet_reversal on a chargeback (FR-BIL-035). Ops-facing signal '
  'only — it gates no request path. Clearing it is a human decision.';

create index if not exists profiles_flagged_for_review_idx
  on public.profiles (flagged_for_review_at desc)
  where flagged_for_review_at is not null;

-- ── 2. credit_wallet: carry the payment intent ──────────────────────────────
-- Dropped and recreated rather than overloaded: two functions differing only by
-- a trailing defaulted parameter is an ambiguity trap for every positional
-- caller (seed.sql, supabase/tests/*). The new trailing parameter defaults to
-- null, so every existing 5- and 6-argument call site keeps working unchanged.
drop function if exists public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text);

create function public.credit_wallet(
  p_user_id                  uuid,
  p_amount_micro_usd         bigint,
  p_kind                     public.ledger_kind,
  p_stripe_event_id          text default null,
  p_stripe_session_id        text default null,
  p_memo                     text default null,
  p_stripe_payment_intent_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_balance bigint;
  v_max     bigint;
  v_new     bigint;
begin
  if p_amount_micro_usd <= 0 then
    raise exception 'credit amount must be positive' using errcode = '22023';
  end if;

  -- Fast path for a redelivered webhook. The UNIQUE constraint on
  -- stripe_event_id is what makes this correct under concurrency; this check
  -- only saves the row lock.
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
    -- Reported, not raised: the caller is a webhook handler that must answer
    -- 200 or Stripe retries this forever. Refunding the charge is an ops
    -- decision, and the ledger stays clean either way.
    return jsonb_build_object('ok', false, 'code', 'max_balance_exceeded',
                              'max_micro_usd', v_max);
  end if;

  update public.profiles
     set balance_micro_usd = v_new, updated_at = now()
   where id = p_user_id;

  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    stripe_event_id, stripe_session_id, stripe_payment_intent_id, memo
  ) values (
    p_user_id, p_kind, p_amount_micro_usd, v_new,
    p_stripe_event_id, p_stripe_session_id, p_stripe_payment_intent_id, p_memo
  );

  return jsonb_build_object('ok', true, 'balance_micro_usd', v_new);
exception
  when unique_violation then                     -- concurrent duplicate webhook
    return jsonb_build_object('ok', true, 'replayed', true);
end $fn$;

-- ── 3. Reversals: refund and chargeback (FR-BIL-035) ────────────────────────
create or replace function public.debit_wallet_reversal(
  p_user_id                  uuid,
  p_amount_micro_usd         bigint,               -- POSITIVE magnitude; stored negated
  p_kind                     public.ledger_kind,   -- 'refund' | 'chargeback'
  p_stripe_event_id          text default null,
  p_stripe_payment_intent_id text default null,
  p_memo                     text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_balance bigint;
  v_new     bigint;
  v_applied bigint;
begin
  if p_kind not in ('refund', 'chargeback') then
    raise exception 'debit_wallet_reversal handles refund/chargeback only, got %', p_kind
      using errcode = '22023';
  end if;
  if p_amount_micro_usd <= 0 then
    raise exception 'reversal amount must be a positive magnitude' using errcode = '22023';
  end if;

  if p_stripe_event_id is not null
     and exists (select 1 from public.wallet_ledger where stripe_event_id = p_stripe_event_id) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;

  select balance_micro_usd into v_balance
    from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'unknown user %', p_user_id using errcode = 'P0002';
  end if;

  -- FLOORED AT ZERO, DELIBERATELY. balance_micro_usd has a CHECK >= 0, so an
  -- unfloored debit would abort the webhook transaction and Stripe would retry
  -- it forever. The ledger records what was actually applied, not what was
  -- demanded, so SUM(amount) == balance still holds (invariant I4). The
  -- unrecovered remainder is a payment loss, tracked in Stripe, not here.
  v_new     := greatest(0, v_balance - p_amount_micro_usd);
  v_applied := v_balance - v_new;

  update public.profiles
     set balance_micro_usd = v_new,
         updated_at        = now(),
         flagged_for_review_at =
           case when p_kind = 'chargeback' then now() else flagged_for_review_at end,
         flagged_for_review_reason =
           case when p_kind = 'chargeback'
                then left(coalesce(p_memo, 'stripe dispute'), 200)
                else flagged_for_review_reason end
   where id = p_user_id;

  -- A zero-magnitude reversal (balance already 0) still deserves an audit
  -- trail, but wallet_ledger_sign_matches_kind forbids amount = 0. The profile
  -- flag above is the record in that case; no ledger row is written.
  if v_applied = 0 then
    return jsonb_build_object('ok', true, 'applied_micro_usd', 0,
                              'balance_micro_usd', v_new, 'floored', true);
  end if;

  insert into public.wallet_ledger (
    user_id, kind, amount_micro_usd, balance_after_micro_usd,
    stripe_event_id, stripe_payment_intent_id, memo
  ) values (
    p_user_id, p_kind, -v_applied, v_new,
    p_stripe_event_id, p_stripe_payment_intent_id, p_memo
  );

  return jsonb_build_object('ok', true, 'applied_micro_usd', v_applied,
                            'balance_micro_usd', v_new,
                            'floored', v_applied < p_amount_micro_usd);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'replayed', true);
end $fn$;

-- ── 4. Grants. Both functions move money: service_role only, as before. ─────
revoke all on function public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.debit_wallet_reversal(uuid,bigint,public.ledger_kind,text,text,text)
  from public, anon, authenticated;
grant execute on function public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text,text)
  to service_role;
grant execute on function public.debit_wallet_reversal(uuid,bigint,public.ledger_kind,text,text,text)
  to service_role;
