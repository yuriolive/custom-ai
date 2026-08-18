-- ============================================================================
-- I2 — a transaction settles AT MOST ONCE.
--
-- The nasty cases: a retry that carries DIFFERENT token counts (an Edge Function
-- that recomputed usage before retrying must not re-bill), a retry after a void,
-- a retry after the stale-hold reaper expired the reservation, and a void issued
-- after settlement.
-- ============================================================================
begin;
select plan(25);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set apikey  '00000000-0000-0000-0000-0000000000b1'
\set model   '00000000-0000-0000-0000-0000000000c1'
\set t1      '11111111-1111-1111-1111-111111111111'
\set t2      '22222222-2222-2222-2222-222222222222'
\set t3      '33333333-3333-3333-3333-333333333333'
\set t4      '44444444-4444-4444-4444-444444444444'
\set t5      '55555555-5555-5555-5555-555555555555'

-- ── Case 1: retry with IDENTICAL token counts ───────────────────────────────
select public.authorize_request(:'t1'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                :'model'::uuid, 1000, 2000, true);

create temp table r1 as
select public.deduct_token_cost(:'t1'::uuid, 1000, 2000, 10, 100, false, false, false) as j;

create temp table b1 as
select balance_micro_usd as bal, earnings_micro_usd as earn
  from public.profiles where id = :'payer'::uuid;

create temp table r1b as
select public.deduct_token_cost(:'t1'::uuid, 1000, 2000, 10, 100, false, false, false) as j;

select is((select (j->>'cost_micro_usd')::bigint from r1b),
          (select (j->>'cost_micro_usd')::bigint from r1),
          'retry with identical counts returns the original cost');
select is((select (j->>'replayed')::boolean from r1b), true,
          'retry with identical counts is flagged as a replay');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b1),
          'I2: identical retry does not move the balance');
select is((select count(*)::int from public.wallet_ledger where usage_transaction_id = :'t1'::uuid),
          1, 'I4: exactly one ledger row for the settled transaction');
select is((select count(*)::int from public.creator_earnings where usage_transaction_id = :'t1'::uuid),
          1, 'exactly one creator_earnings row after a retry');

-- ── Case 2: retry carrying DIFFERENT (larger) token counts ──────────────────
select public.authorize_request(:'t2'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                :'model'::uuid, 100, 200, true);

create temp table r2 as
select public.deduct_token_cost(:'t2'::uuid, 100, 200, 10, 100, false, false, false) as j;

create temp table b2 as
select balance_micro_usd as bal, earnings_micro_usd as earn,
       (select earnings_micro_usd from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') as cearn
  from public.profiles where id = :'payer'::uuid;

-- A retry that "knows better" — 100x the tokens. It must be refused as a replay.
create temp table r2b as
select public.deduct_token_cost(:'t2'::uuid, 10000, 20000, 10, 100, false, false, false) as j;

select is((select (j->>'cost_micro_usd')::bigint from r2b),
          (select (j->>'cost_micro_usd')::bigint from r2),
          'I2: retry with LARGER token counts returns the ORIGINAL cost');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b2),
          'I2: retry with different token counts does not re-bill');
select is((select earnings_micro_usd from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
          (select cearn from b2),
          'I2: retry with different token counts does not re-accrue creator earnings');
select is((select prompt_tokens from public.usage_transactions where id = :'t2'::uuid),
          100, 'the settled row keeps the FIRST reported prompt token count');
select is((select count(*)::int from public.wallet_ledger where usage_transaction_id = :'t2'::uuid),
          1, 'I4: still exactly one ledger row after a divergent retry');

-- A retry carrying SMALLER counts must not refund either.
create temp table r2c as
select public.deduct_token_cost(:'t2'::uuid, 1, 1, 10, 100, false, false, false) as j;
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b2),
          'I2: retry with SMALLER token counts does not refund');

-- ── Case 3: retry after an explicit void ────────────────────────────────────
select public.authorize_request(:'t3'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                :'model'::uuid, 100, 200, true);
select public.void_reservation(:'t3'::uuid, 'upstream_error', 'no tokens produced');

create temp table b3 as
select balance_micro_usd as bal from public.profiles where id = :'payer'::uuid;

create temp table r3 as
select public.deduct_token_cost(:'t3'::uuid, 500, 500, 10, 100, false, false, false) as j;

select is((select (j->>'replayed')::boolean from r3), true,
          'settle after void is reported as a replay, not an error');
select is((select (j->>'cost_micro_usd')::bigint from r3), 0::bigint,
          'settle after void costs nothing');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b3),
          'I2: settle after void does not move the balance');
select is((select count(*)::int from public.wallet_ledger where usage_transaction_id = :'t3'::uuid),
          0, 'I4: a voided transaction writes no ledger row');
select is((select status::text from public.usage_transactions where id = :'t3'::uuid),
          'voided', 'a voided transaction stays voided after a settle attempt');

-- A void issued AFTER settlement must be a no-op.
select is((public.void_reservation(:'t1'::uuid, 'late', 'late void')->>'voided')::boolean,
          false, 'void_reservation after settlement is a no-op');
select is((select status::text from public.usage_transactions where id = :'t1'::uuid),
          'settled', 'a settled transaction cannot be voided afterwards');

-- ── Case 4: retry after the stale-hold reaper expired the reservation ───────
select public.authorize_request(:'t4'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                :'model'::uuid, 100, 200, true);
update public.usage_transactions set expires_at = now() - interval '1 hour' where id = :'t4'::uuid;
select cmp_ok(public.expire_stale_holds(), '>=', 1, 'expire_stale_holds sweeps the abandoned hold');
select is((select status::text from public.usage_transactions where id = :'t4'::uuid),
          'expired', 'the reservation is now expired');

-- A hold that expired mid-flight then settles: the work was really done, so it
-- must still bill (exactly once).
create temp table r4 as
select public.deduct_token_cost(:'t4'::uuid, 100, 200, 10, 100, false, false, false) as j;
select cmp_ok((select (j->>'cost_micro_usd')::bigint from r4), '>', 0::bigint,
              'an expired-then-settled transaction still bills');

create temp table b4 as
select balance_micro_usd as bal from public.profiles where id = :'payer'::uuid;
create temp table r4b as
select public.deduct_token_cost(:'t4'::uuid, 100, 200, 10, 100, false, false, false) as j;
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b4),
          'I2: retry after an expired-then-settled transaction does not re-bill');

-- ── Case 5: authorize is idempotent too ─────────────────────────────────────
select public.authorize_request(:'t5'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                :'model'::uuid, 100, 200, true);
select is((public.authorize_request(:'t5'::uuid, :'payer'::uuid, :'apikey'::uuid,
                                    :'model'::uuid, 100, 200, true)->>'replayed')::boolean,
          true, 'a retried authorize_request replays instead of double-holding');
select is((select count(*)::int from public.usage_transactions where id = :'t5'::uuid),
          1, 'a retried authorize_request creates no second reservation');

select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no ledger drift after the whole idempotency sequence');

select * from finish();
rollback;
