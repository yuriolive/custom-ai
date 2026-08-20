-- Smoke: pgTAP is wired up and the seed fixture is present.
begin;
select plan(4);

select has_table('public', 'usage_transactions', 'usage_transactions exists');
select is(
  (select balance_micro_usd from public.profiles where handle = 'devcaller'),
  10000000::bigint,
  'devcaller seeded with $10.00'
);
select is((select count(*)::int from public.v_balance_drift), 0, 'no ledger drift after seed');
-- The FR-CON-001 backfill in 20260819000400 runs at migrate time. The seed has no
-- usage_transactions rows, so it is a no-op here — and this asserts it stayed one.
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'no api-key counter drift after seed');

select * from finish();
rollback;
