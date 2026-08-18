-- ============================================================================
-- Can `anon` or `authenticated` reach a financial table or a money RPC?
-- Probed as the REAL roles (SET ROLE), not by reading the grant catalog.
-- ============================================================================
begin;
select plan(25);

\set payer   '00000000-0000-0000-0000-0000000000a2'
\set creator '00000000-0000-0000-0000-0000000000a1'

-- ── Function EXECUTE privileges ─────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.deduct_token_cost(uuid,integer,integer,numeric,numeric,boolean,boolean,boolean)', 'EXECUTE'),
          'anon cannot execute deduct_token_cost');
select ok(not has_function_privilege('authenticated', 'public.deduct_token_cost(uuid,integer,integer,numeric,numeric,boolean,boolean,boolean)', 'EXECUTE'),
          'authenticated cannot execute deduct_token_cost');
select ok(not has_function_privilege('anon', 'public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)', 'EXECUTE'),
          'anon cannot execute authorize_request');
select ok(not has_function_privilege('authenticated', 'public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)', 'EXECUTE'),
          'authenticated cannot execute authorize_request');
select ok(not has_function_privilege('authenticated', 'public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text)', 'EXECUTE'),
          'authenticated cannot execute credit_wallet');
select ok(not has_function_privilege('anon', 'public.credit_wallet(uuid,bigint,public.ledger_kind,text,text,text)', 'EXECUTE'),
          'anon cannot execute credit_wallet');
select ok(not has_function_privilege('authenticated', 'public.void_reservation(uuid,text,text)', 'EXECUTE'),
          'authenticated cannot execute void_reservation');
select ok(not has_function_privilege('authenticated', 'public.expire_stale_holds()', 'EXECUTE'),
          'authenticated cannot execute expire_stale_holds');
select ok(not has_table_privilege('authenticated', 'public.v_balance_drift', 'SELECT'),
          'authenticated cannot select the drift audit view');
select ok(not has_table_privilege('anon', 'public.v_balance_drift', 'SELECT'),
          'anon cannot select the drift audit view');

-- ── Table privileges on the financial tables ────────────────────────────────
select ok(not has_table_privilege('anon', 'public.profiles', 'SELECT'),
          'anon has no SELECT on profiles');
select ok(not has_table_privilege('anon', 'public.wallet_ledger', 'SELECT'),
          'anon has no SELECT on wallet_ledger');
select ok(not has_table_privilege('anon', 'public.usage_transactions', 'SELECT'),
          'anon has no SELECT on usage_transactions');
select ok(not has_table_privilege('authenticated', 'public.wallet_ledger', 'INSERT'),
          'authenticated has no INSERT on wallet_ledger');
select ok(not has_table_privilege('authenticated', 'public.wallet_ledger', 'UPDATE'),
          'authenticated has no UPDATE on wallet_ledger');
select ok(not has_table_privilege('authenticated', 'public.wallet_ledger', 'DELETE'),
          'authenticated has no DELETE on wallet_ledger');
select ok(not has_table_privilege('authenticated', 'public.usage_transactions', 'UPDATE'),
          'authenticated has no UPDATE on usage_transactions');
select ok(not has_table_privilege('authenticated', 'public.creator_earnings', 'UPDATE'),
          'authenticated has no UPDATE on creator_earnings');

-- ── Live probe as `authenticated` impersonating the payer ───────────────────
-- profiles has UPDATE granted to authenticated with an RLS policy that asserts
-- the money columns are unchanged. Try to raise our own balance anyway.
-- Suspend the payer first, so "clear your own suspension" is a real state change
-- rather than a vacuous no-op update.
update public.profiles set is_suspended = true where id = :'payer'::uuid;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
set local role authenticated;

-- Guard: if auth.uid() were null the UPDATEs below would match zero rows and
-- pass vacuously. Assert the impersonation is real first.
select is(auth.uid(), '00000000-0000-0000-0000-0000000000a2'::uuid,
          'the session really is acting as the payer');

select throws_ok(
  $$ update public.profiles set balance_micro_usd = balance_micro_usd + 1000000000
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot raise its own balance_micro_usd');

select throws_ok(
  $$ update public.profiles set earnings_micro_usd = 999999999
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot raise its own earnings_micro_usd');

select throws_ok(
  $$ update public.profiles set max_balance_micro_usd = 999999999999
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot raise its own max_balance_micro_usd');

select throws_ok(
  $$ update public.profiles set is_suspended = false
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot clear its own suspension');

-- BUG PROBE: lifetime_* and stripe_customer_id are NOT in the WITH CHECK list,
-- so an authenticated client can rewrite them. lifetime_earnings drives creator
-- payout reporting; stripe_customer_id is UNIQUE, so writing another user's id
-- both hijacks their Stripe linkage and denies them theirs.
select throws_ok(
  $$ update public.profiles set lifetime_earnings_micro_usd = 999999999
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot rewrite its own lifetime_earnings_micro_usd');

select throws_ok(
  $$ update public.profiles set stripe_customer_id = 'cus_hijacked'
       where id = '00000000-0000-0000-0000-0000000000a2' $$,
  '42501', null, 'authenticated cannot set its own stripe_customer_id');

reset role;
select * from finish();
rollback;
