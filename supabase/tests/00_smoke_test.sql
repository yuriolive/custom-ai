-- Smoke: pgTAP is wired up and the seed fixture is present.
begin;
select plan(3);

select has_table('public', 'usage_transactions', 'usage_transactions exists');
select is(
  (select balance_micro_usd from public.profiles where handle = 'devcaller'),
  10000000::bigint,
  'devcaller seeded with $10.00'
);
select is((select count(*)::int from public.v_balance_drift), 0, 'no ledger drift after seed');

select * from finish();
rollback;
