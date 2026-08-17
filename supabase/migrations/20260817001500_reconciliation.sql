-- ============================================================================
-- 20260817001500_reconciliation.sql   (PRD §5.7 / §6.5)
-- ============================================================================
-- Sweep abandoned holds so an orphaned reservation cannot permanently strand
-- a user's spendable balance.
create or replace function public.expire_stale_holds()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  update public.usage_transactions
     set status = 'expired', hold_micro_usd = 0, settled_at = now(),
         error_code = 'hold_expired'
   where status = 'reserved' and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- FR-DB-003: not granted to any client role. (The PRD omits these grants.)
revoke all on function public.expire_stale_holds() from public, anon, authenticated;
grant execute on function public.expire_stale_holds() to service_role;

-- Ledger drift audit. MUST return zero rows. Any row is a P1 incident.
create or replace view public.v_balance_drift
  with (security_invoker = true) as
  select p.id as user_id, p.handle,
         p.balance_micro_usd                          as profile_balance,
         coalesce(sum(l.amount_micro_usd), 0)::bigint as ledger_sum,
         p.balance_micro_usd - coalesce(sum(l.amount_micro_usd), 0)::bigint as drift
    from public.profiles p
    left join public.wallet_ledger l on l.user_id = p.id
   group by p.id, p.handle, p.balance_micro_usd
  having p.balance_micro_usd <> coalesce(sum(l.amount_micro_usd), 0)::bigint;

-- Ops-only. Supabase's default privileges would otherwise hand this to anon and
-- authenticated the moment it is created. (The PRD omits this.)
revoke all on public.v_balance_drift from public, anon, authenticated;
grant select on public.v_balance_drift to service_role;

-- Stale-hold reaper. pg_cron may be absent (see 20260817000100_extensions.sql);
-- schedule externally in that case rather than failing the migration.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-stale-holds', '*/5 * * * *',
                          $cron$select public.expire_stale_holds()$cron$);
  else
    raise warning 'pg_cron not installed: schedule public.expire_stale_holds() every 5 minutes externally';
  end if;
end $$;
