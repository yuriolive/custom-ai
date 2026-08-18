-- ============================================================================
-- I5 — concurrent requests on one wallet CANNOT collectively overdraw.
--
-- This file deliberately does NOT run inside a transaction: every other test
-- here is single-connection, and a single connection cannot exercise FOR UPDATE
-- contention, lock ordering, or deadlock detection at all. Each scenario fans
-- work out over genuinely separate backend sessions via dblink, released
-- against a shared wall-clock barrier so they collide instead of queueing.
--
-- Fixtures are created and torn down explicitly (both at the top and the
-- bottom) because there is no enclosing ROLLBACK to clean up after us.
-- ============================================================================
select plan(33);

create extension if not exists dblink with schema extensions;

-- ── uuids used throughout ───────────────────────────────────────────────────
-- e1 payer   e2 creator   e3/e4 swapped payer<->creator pair (deadlock probe)
-- f1/f3/f4 models cloned from the seed row so every NOT NULL column is real.

-- ── teardown helper, run first (in case a previous run died mid-file) ───────
create or replace function pg_temp.teardown() returns void language plpgsql as $$
begin
  delete from public.creator_earnings
   where usage_transaction_id in (select id from public.usage_transactions
                                   where user_id in ('e0000000-0000-0000-0000-0000000000e1',
                                                     'e0000000-0000-0000-0000-0000000000e2',
                                                     'e0000000-0000-0000-0000-0000000000e3',
                                                     'e0000000-0000-0000-0000-0000000000e4'));
  delete from public.wallet_ledger
   where user_id in ('e0000000-0000-0000-0000-0000000000e1','e0000000-0000-0000-0000-0000000000e2',
                     'e0000000-0000-0000-0000-0000000000e3','e0000000-0000-0000-0000-0000000000e4');
  delete from public.usage_transactions
   where user_id in ('e0000000-0000-0000-0000-0000000000e1','e0000000-0000-0000-0000-0000000000e2',
                     'e0000000-0000-0000-0000-0000000000e3','e0000000-0000-0000-0000-0000000000e4');
  delete from public.custom_models where id in ('f0000000-0000-0000-0000-0000000000f1',
                                                'f0000000-0000-0000-0000-0000000000f3',
                                                'f0000000-0000-0000-0000-0000000000f4');
  delete from auth.users where id in ('e0000000-0000-0000-0000-0000000000e1',
                                      'e0000000-0000-0000-0000-0000000000e2',
                                      'e0000000-0000-0000-0000-0000000000e3',
                                      'e0000000-0000-0000-0000-0000000000e4');
end $$;
select pg_temp.teardown();

-- ── fixtures ────────────────────────────────────────────────────────────────
create or replace function pg_temp.mkuser(p_id uuid, p_handle text) returns void
language plpgsql as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token,
                          email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated',
          p_handle || '@concurrency.test', 'x', now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('user_name', p_handle),
          now(), now(), '', '', '', '');
end $$;

-- Clone the seeded model so every NOT NULL / snapshot column is realistic.
create or replace function pg_temp.mkmodel(p_id uuid, p_owner uuid, p_slug text,
                                           p_pp bigint, p_pc bigint, p_fee integer)
returns void language plpgsql as $$
declare v_cols text;
begin
  select string_agg(quote_ident(attname), ',' order by attnum) into v_cols
    from pg_attribute
   where attrelid = 'public.custom_models'::regclass
     and attnum > 0 and not attisdropped and attgenerated = '';
  execute format('create temporary table _mm as select %s from public.custom_models where id = %L',
                 v_cols, '00000000-0000-0000-0000-0000000000c1');
  execute format('update _mm set id=%L, user_id=%L, slug=%L,
                    runpod_endpoint_id=''endpoint-'' || %L,
                    price_prompt_micro_usd_per_mtoken=%s,
                    price_completion_micro_usd_per_mtoken=%s,
                    platform_fee_bps=%s, visibility=''public'', status=''ready''',
                 p_id, p_owner, p_slug, p_slug, p_pp, p_pc, p_fee);
  execute format('insert into public.custom_models(%s) select %s from _mm', v_cols, v_cols);
  execute 'drop table _mm';
end $$;

select pg_temp.mkuser('e0000000-0000-0000-0000-0000000000e1', 'conc-payer');
select pg_temp.mkuser('e0000000-0000-0000-0000-0000000000e2', 'conc-creator');
select pg_temp.mkuser('e0000000-0000-0000-0000-0000000000e3', 'conc-x');
select pg_temp.mkuser('e0000000-0000-0000-0000-0000000000e4', 'conc-y');

-- 1 micro-USD per token on the prompt side, nothing on completion: a hold of
-- exactly 1000 micro-USD for est_prompt_tokens = 1000, max_tokens = 0.
select pg_temp.mkmodel('f0000000-0000-0000-0000-0000000000f1',
                       'e0000000-0000-0000-0000-0000000000e2', 'conc-model-1', 1000000, 1000000, 2000);
select pg_temp.mkmodel('f0000000-0000-0000-0000-0000000000f3',
                       'e0000000-0000-0000-0000-0000000000e3', 'conc-model-3', 1000000, 1000000, 2000);
select pg_temp.mkmodel('f0000000-0000-0000-0000-0000000000f4',
                       'e0000000-0000-0000-0000-0000000000e4', 'conc-model-4', 1000000, 1000000, 2000);

-- ── the fan-out primitive: N genuinely separate sessions, one barrier ────────
create or replace function pg_temp.fanout(p_sqls text[], p_delay double precision default 1.5)
returns text[]
language plpgsql as $$
declare
  n        integer := coalesce(array_length(p_sqls, 1), 0);
  i        integer;
  c        text;
  barrier  timestamptz := clock_timestamp() + (p_delay || ' seconds')::interval;
  wrapped  text;
  out      text[] := '{}';
  r        text;
begin
  for i in 1..n loop
    c := 'fc' || i;
    perform extensions.dblink_connect(
      c, 'host=db port=5432 dbname=postgres user=postgres password=postgres');
    -- The FROM clause is evaluated before the target list, so every session
    -- sleeps until the same instant and then runs the RPC simultaneously.
    wrapped := format(
      'select (%s)::text from (select pg_sleep(greatest(0, extract(epoch from (%L::timestamptz - clock_timestamp()))))) _barrier',
      p_sqls[i], barrier);
    perform extensions.dblink_send_query(c, wrapped);
  end loop;

  for i in 1..n loop
    c := 'fc' || i;
    begin
      select t.x into r from extensions.dblink_get_result(c) as t(x text);
    exception when others then
      r := 'ERROR ' || sqlstate || ' ' || sqlerrm;
    end;
    begin
      perform extensions.dblink_get_result(c);
    exception when others then null;
    end;
    begin
      perform extensions.dblink_disconnect(c);
    exception when others then null;
    end;
    out := out || coalesce(r, 'NULL');
  end loop;
  return out;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 1 — 30 concurrent authorizes against a wallet that funds exactly 5.
-- ════════════════════════════════════════════════════════════════════════════
select public.credit_wallet('e0000000-0000-0000-0000-0000000000e1'::uuid, 5000::bigint,
                            'grant'::public.ledger_kind, null, null, 'concurrency fixture');

create temp table s1(res text);
insert into s1
select unnest(pg_temp.fanout(
  (select array_agg(format(
     'public.authorize_request(%L::uuid, %L::uuid, null, %L::uuid, 1000, 0, true)',
     ('11110000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
     'e0000000-0000-0000-0000-0000000000e1',
     'f0000000-0000-0000-0000-0000000000f1'))
     from generate_series(1, 30) g)));

select is((select count(*)::int from s1), 30, '30 concurrent authorize_request calls completed');
select is((select count(*)::int from s1 where res like 'ERROR%'), 0,
          'no concurrent authorize raised an unexpected error');
select is((select count(*)::int from s1 where (res::jsonb->>'ok')::boolean), 5,
          'I5: exactly 5 of 30 concurrent authorizes are granted by a 5000-micro wallet');
select is((select count(*)::int from s1
             where (res::jsonb->>'code') = 'insufficient_balance'), 25,
          'I5: the other 25 are refused with insufficient_balance');
select is((select count(*)::int from public.usage_transactions
             where user_id = 'e0000000-0000-0000-0000-0000000000e1' and status = 'reserved'), 5,
          'I5: exactly 5 reservations exist');
select is((select coalesce(sum(hold_micro_usd),0)::bigint from public.usage_transactions
             where user_id = 'e0000000-0000-0000-0000-0000000000e1' and status = 'reserved'),
          5000::bigint,
          'I5: outstanding holds sum to exactly the wallet balance, never more');

-- ── settle all 5 CONCURRENTLY, each for exactly its hold ────────────────────
create temp table s1b(res text);
insert into s1b
select unnest(pg_temp.fanout(
  (select array_agg(format('public.deduct_token_cost(%L::uuid, 1000, 0)', id))
     from public.usage_transactions
    where user_id = 'e0000000-0000-0000-0000-0000000000e1' and status = 'reserved')));

select is((select count(*)::int from s1b where res like 'ERROR%'), 0,
          'no concurrent settlement raised');
select is((select balance_micro_usd from public.profiles
             where id = 'e0000000-0000-0000-0000-0000000000e1'), 0::bigint,
          'I1/I5: 5 concurrent settlements land the wallet on exactly 0');
select is((select count(*)::int from public.wallet_ledger
             where user_id = 'e0000000-0000-0000-0000-0000000000e1' and kind = 'usage_debit'), 5,
          'I4: exactly 5 debit rows for 5 settlements');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after 5 concurrent settlements');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 2 — concurrent settles that each blow past their hold.
-- 5 reservations of 1000 against a 5000 wallet, each settled for 4000.
-- ════════════════════════════════════════════════════════════════════════════
select public.credit_wallet('e0000000-0000-0000-0000-0000000000e1'::uuid, 5000::bigint,
                            'grant'::public.ledger_kind, null, null, 'overrun fixture');

select public.authorize_request(('22220000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
                                'e0000000-0000-0000-0000-0000000000e1'::uuid, null,
                                'f0000000-0000-0000-0000-0000000000f1'::uuid, 1000, 0, true)
  from generate_series(1, 5) g;

create temp table s2(res text);
insert into s2
select unnest(pg_temp.fanout(
  (select array_agg(format('public.deduct_token_cost(%L::uuid, 4000, 0)', id))
     from public.usage_transactions
    where user_id = 'e0000000-0000-0000-0000-0000000000e1' and status = 'reserved')));

select cmp_ok((select balance_micro_usd from public.profiles
                 where id = 'e0000000-0000-0000-0000-0000000000e1'), '>=', 0::bigint,
              'I1: balance is not negative after 5 concurrent over-runs');
select is((select balance_micro_usd from public.profiles
             where id = 'e0000000-0000-0000-0000-0000000000e1'), 0::bigint,
          'I1: the wallet is drained to exactly 0, not below');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after concurrent over-run settlements');
-- BUG PROBE: any settlement whose entire cost is written off (balance already 0)
-- inserts a usage_debit of amount 0 and trips wallet_ledger_sign_matches_kind.
select diag('scenario 2 observed errors: ' ||
            coalesce((select string_agg(distinct res, ' || ') from s2 where res like 'ERROR%'), 'none'));
select is((select count(*)::int from s2 where res like 'ERROR%'), 0,
          'no concurrent over-run settlement raised an error');
select is((select count(*)::int from public.usage_transactions
             where user_id = 'e0000000-0000-0000-0000-0000000000e1'
               and id::text like '22220000%' and status = 'reserved'), 0,
          'every over-run reservation reached a terminal state (none stranded as reserved)');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 3 — settle racing settle on the SAME txn id, different token counts.
-- ════════════════════════════════════════════════════════════════════════════
select public.credit_wallet('e0000000-0000-0000-0000-0000000000e1'::uuid, 100000::bigint,
                            'grant'::public.ledger_kind, null, null, 'same-txn fixture');
select public.authorize_request('33330000-0000-0000-0000-000000000001'::uuid,
                                'e0000000-0000-0000-0000-0000000000e1'::uuid, null,
                                'f0000000-0000-0000-0000-0000000000f1'::uuid, 1000, 0, true);

create temp table b3 as select balance_micro_usd as bal from public.profiles
                        where id = 'e0000000-0000-0000-0000-0000000000e1';

create temp table s3(res text);
insert into s3
select unnest(pg_temp.fanout(
  (select array_agg(format(
     'public.deduct_token_cost(%L::uuid, %s, 0)',
     '33330000-0000-0000-0000-000000000001', 100 * g))
     from generate_series(1, 8) g)));

select is((select count(*)::int from s3 where res like 'ERROR%'), 0,
          'I2: 8 concurrent settlements of one txn id all return cleanly');
select is((select count(*)::int from public.wallet_ledger
             where usage_transaction_id = '33330000-0000-0000-0000-000000000001'), 1,
          'I4: concurrent same-txn settlement writes exactly ONE ledger row');
select is((select count(*)::int from public.creator_earnings
             where usage_transaction_id = '33330000-0000-0000-0000-000000000001'), 1,
          'I2: concurrent same-txn settlement accrues exactly ONE creator_earnings row');
select is(
  (select bal from b3) - (select balance_micro_usd from public.profiles
                            where id = 'e0000000-0000-0000-0000-0000000000e1'),
  (select cost_micro_usd from public.usage_transactions
     where id = '33330000-0000-0000-0000-000000000001'),
  'I2: the wallet moved by the settled cost exactly once');
select is((select count(distinct (res::jsonb->>'cost_micro_usd')) ::int from s3
             where res not like 'ERROR%'), 1,
          'I2: all 8 racing callers observe the SAME cost');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 4 — authorize racing settle on one wallet.
-- ════════════════════════════════════════════════════════════════════════════
create temp table s4(res text);
insert into s4
select unnest(pg_temp.fanout(array(
  select case when g % 2 = 0
    then format('public.authorize_request(%L::uuid, %L::uuid, null, %L::uuid, 1000, 0, true)',
                ('44440000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
                'e0000000-0000-0000-0000-0000000000e1',
                'f0000000-0000-0000-0000-0000000000f1')
    else format('public.deduct_token_cost(%L::uuid, 1000, 0)',
                ('44440000-0000-0000-0000-' || lpad((g-1)::text, 12, '0'))::uuid)
  end
  from generate_series(2, 21) g)));

select cmp_ok((select balance_micro_usd from public.profiles
                 where id = 'e0000000-0000-0000-0000-0000000000e1'), '>=', 0::bigint,
              'I1: balance non-negative with authorize and settle interleaved concurrently');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift with authorize racing settle');
select is((select count(*)::int from s4 where res like 'ERROR 40P01%'), 0,
          'authorize racing settle produced no deadlock');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 5 — 10 concurrent duplicate Stripe webhooks, same stripe_event_id.
-- ════════════════════════════════════════════════════════════════════════════
create temp table b5 as select balance_micro_usd as bal from public.profiles
                        where id = 'e0000000-0000-0000-0000-0000000000e2';

create temp table s5(res text);
insert into s5
select unnest(pg_temp.fanout(
  (select array_agg(format(
     'public.credit_wallet(%L::uuid, 250000::bigint, ''topup''::public.ledger_kind, %L, %L, ''dup webhook'')',
     'e0000000-0000-0000-0000-0000000000e2', 'evt_concurrent_dupe_1', 'cs_test_1'))
     from generate_series(1, 10) g)));

select is((select count(*)::int from s5 where res like 'ERROR%'), 0,
          'no concurrent duplicate webhook raised');
select is((select count(*)::int from public.wallet_ledger
             where stripe_event_id = 'evt_concurrent_dupe_1'), 1,
          'FR-BIL-034: 10 concurrent duplicate webhooks write exactly ONE ledger row');
select is((select balance_micro_usd from public.profiles
             where id = 'e0000000-0000-0000-0000-0000000000e2') - (select bal from b5),
          250000::bigint,
          'FR-BIL-034: the wallet is credited exactly once');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after concurrent duplicate webhooks');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 6 — lock-order probe. The documented order is
-- usage_transactions -> profiles(payer) -> profiles(creator). When a creator is
-- ALSO a payer in a concurrent transaction, that order is a cycle:
--   session A locks X (payer) then updates Y (creator)
--   session B locks Y (payer) then updates X (creator)
-- Fire 20 such swapped settlements simultaneously and count deadlocks.
-- ════════════════════════════════════════════════════════════════════════════
update public.profiles set max_balance_micro_usd = 100000000
 where id in ('e0000000-0000-0000-0000-0000000000e3','e0000000-0000-0000-0000-0000000000e4');
select public.credit_wallet('e0000000-0000-0000-0000-0000000000e3'::uuid, 10000000::bigint,
                            'grant'::public.ledger_kind, null, null, 'deadlock fixture');
select public.credit_wallet('e0000000-0000-0000-0000-0000000000e4'::uuid, 10000000::bigint,
                            'grant'::public.ledger_kind, null, null, 'deadlock fixture');

-- X pays for Y's model, and Y pays for X's model, alternating.
select public.authorize_request(('55550000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
         case when g % 2 = 0 then 'e0000000-0000-0000-0000-0000000000e3'::uuid
                             else 'e0000000-0000-0000-0000-0000000000e4'::uuid end,
         null,
         case when g % 2 = 0 then 'f0000000-0000-0000-0000-0000000000f4'::uuid
                             else 'f0000000-0000-0000-0000-0000000000f3'::uuid end,
         1000, 0, true)
  from generate_series(1, 20) g;

create temp table s6(res text);
insert into s6
select unnest(pg_temp.fanout(
  (select array_agg(format('public.deduct_token_cost(%L::uuid, 1000, 0)', id) order by id)
     from public.usage_transactions
    where id::text like '55550000%' and status = 'reserved')));

select diag('scenario 6 observed errors: ' ||
            coalesce((select string_agg(distinct res, ' || ') from s6 where res like 'ERROR%'), 'none'));
select is((select count(*)::int from s6 where res like 'ERROR 40P01%'), 0,
          'no deadlock when a creator is concurrently a payer (20 swapped settlements)');
select is((select count(*)::int from s6 where res like 'ERROR%'), 0,
          'no swapped settlement failed for any reason');
select is((select count(*)::int from public.usage_transactions
             where id::text like '55550000%' and status <> 'settled'), 0,
          'all 20 swapped settlements reached settled');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after the swapped payer/creator settlements');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO 7 — CONTROL for scenario 6. Identical volume and contention, but all
-- 20 settlements flow in the SAME direction (one payer -> one creator), so the
-- payer->creator lock order forms no cycle. If this passes while scenario 6
-- fails, the swapped payer/creator relationship is the sole cause.
-- ════════════════════════════════════════════════════════════════════════════
select public.authorize_request(('66660000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
                                'e0000000-0000-0000-0000-0000000000e3'::uuid, null,
                                'f0000000-0000-0000-0000-0000000000f4'::uuid, 1000, 0, true)
  from generate_series(1, 20) g;

create temp table s7(res text);
insert into s7
select unnest(pg_temp.fanout(
  (select array_agg(format('public.deduct_token_cost(%L::uuid, 1000, 0)', id) order by id)
     from public.usage_transactions
    where id::text like '66660000%' and status = 'reserved')));

select diag('scenario 7 observed errors: ' ||
            coalesce((select string_agg(distinct res, ' || ') from s7 where res like 'ERROR%'), 'none'));
select is((select count(*)::int from s7 where res like 'ERROR%'), 0,
          'CONTROL: 20 same-direction concurrent settlements do not deadlock');

-- ── teardown ────────────────────────────────────────────────────────────────
select pg_temp.teardown();
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift left behind after teardown');

select * from finish();
