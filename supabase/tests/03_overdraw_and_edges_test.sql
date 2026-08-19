-- ============================================================================
-- I1 — the balance can never go negative, and I4 must survive every path that
-- gets there. Plus the adversarial edge inputs: zero tokens, negative tokens,
-- self-dealing (FR-BIL-021), an under-estimated hold, and a settle that is
-- larger than the entire wallet.
--
-- These are SEQUENTIAL. The concurrent versions live in 05_concurrency_test.sql.
-- ============================================================================
begin;
select plan(39);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set apikey  '00000000-0000-0000-0000-0000000000b1'
\set model   '00000000-0000-0000-0000-0000000000c1'

-- ── Negative token counts are rejected outright ─────────────────────────────
select public.authorize_request('a0000000-0000-0000-0000-000000000001'::uuid, :'payer'::uuid,
                                :'apikey'::uuid, :'model'::uuid, 10, 10, true);
select throws_ok(
  $$ select public.deduct_token_cost('a0000000-0000-0000-0000-000000000001'::uuid, -1, 10) $$,
  '22023', null, 'negative prompt_tokens is rejected');
select throws_ok(
  $$ select public.deduct_token_cost('a0000000-0000-0000-0000-000000000001'::uuid, 10, -5) $$,
  '22023', null, 'negative completion_tokens is rejected');

-- ── Zero tokens: void the hold rather than charge a minimum ─────────────────
create temp table b0 as select balance_micro_usd as bal from public.profiles where id = :'payer'::uuid;
create temp table r0 as
select public.deduct_token_cost('a0000000-0000-0000-0000-000000000001'::uuid, 0, 0) as j;
select is((select (j->>'voided')::boolean from r0), true, 'zero tokens voids the reservation');
select is((select (j->>'cost_micro_usd')::bigint from r0), 0::bigint, 'zero tokens costs nothing');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          (select bal from b0), 'I1: zero tokens does not move the balance');
select is((select count(*)::int from public.wallet_ledger
             where usage_transaction_id = 'a0000000-0000-0000-0000-000000000001'::uuid),
          0, 'I4: zero-token void writes no ledger row');
select is((select hold_micro_usd from public.usage_transactions
             where id = 'a0000000-0000-0000-0000-000000000001'::uuid),
          0::bigint, 'zero-token void releases the hold');

-- ── Unknown transaction ─────────────────────────────────────────────────────
select throws_ok(
  $$ select public.deduct_token_cost('deadbeef-0000-0000-0000-000000000000'::uuid, 1, 1) $$,
  'P0002', null, 'settling an unknown transaction raises');

-- ── Self-dealing: payer == creator accrues 0 to the creator (FR-BIL-021) ────
update public.profiles set max_balance_micro_usd = 1000000000 where id = :'creator'::uuid;
select public.credit_wallet(:'creator'::uuid, 10000000::bigint, 'grant'::public.ledger_kind,
                            null, null, 'self-deal funding');

create temp table ce0 as
select earnings_micro_usd as earn, lifetime_earnings_micro_usd as life
  from public.profiles where id = :'creator'::uuid;

select public.authorize_request('a0000000-0000-0000-0000-000000000002'::uuid, :'creator'::uuid,
                                null, :'model'::uuid, 1000, 2000, true);
create temp table rs as
select public.deduct_token_cost('a0000000-0000-0000-0000-000000000002'::uuid, 1000, 2000) as j;

select is((select (j->>'creator_micro_usd')::bigint from rs), 0::bigint,
          'FR-BIL-021: payer == creator accrues 0 to the creator');
select is((select (j->>'platform_micro_usd')::bigint from rs),
          (select (j->>'cost_micro_usd')::bigint from rs),
          'FR-BIL-021: the whole cost goes to the platform when self-dealing');
select is((select earnings_micro_usd from public.profiles where id = :'creator'::uuid),
          (select earn from ce0), 'self-dealing does not bump earnings_micro_usd');
select is((select lifetime_earnings_micro_usd from public.profiles where id = :'creator'::uuid),
          (select life from ce0), 'self-dealing does not bump lifetime_earnings_micro_usd');
select is((select count(*)::int from public.creator_earnings
             where usage_transaction_id = 'a0000000-0000-0000-0000-000000000002'::uuid),
          0, 'self-dealing writes no creator_earnings row');

-- ── A private model accrues nothing to the creator either ───────────────────
update public.custom_models set visibility = 'private' where id = :'model'::uuid;
select public.authorize_request('a0000000-0000-0000-0000-000000000003'::uuid, :'payer'::uuid,
                                :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);
select is((public.deduct_token_cost('a0000000-0000-0000-0000-000000000003'::uuid, 1000, 2000)
             ->>'creator_micro_usd')::bigint,
          0::bigint, 'a private model accrues 0 to the creator');
update public.custom_models set visibility = 'public' where id = :'model'::uuid;

-- ── I1: settle far more than the entire wallet ──────────────────────────────
-- Drain the payer to a known small balance by spending it, then bill a huge
-- request against the leftover. The hold cannot have covered this.
create temp table drain as select balance_micro_usd as bal from public.profiles where id = :'payer'::uuid;

-- Reprice so a modest token count blows past any wallet.
update public.custom_models
   set price_prompt_micro_usd_per_mtoken = 1000000000,
       price_completion_micro_usd_per_mtoken = 1000000000
 where id = :'model'::uuid;

-- Authorize with a tiny estimate (hold = the $0.0001 floor), settle enormous.
select public.authorize_request('a0000000-0000-0000-0000-000000000004'::uuid, :'payer'::uuid,
                                :'apikey'::uuid, :'model'::uuid, 0, 0, true);
-- Reserved NOW, while the wallet still has money, so it can be settled after the
-- wallet has been emptied — exactly the concurrent-drain shape, sequentialised.
select public.authorize_request('a0000000-0000-0000-0000-000000000005'::uuid, :'payer'::uuid,
                                :'apikey'::uuid, :'model'::uuid, 0, 0, true);
create temp table big as
select public.deduct_token_cost('a0000000-0000-0000-0000-000000000004'::uuid, 1000000, 1000000) as j;

select cmp_ok((select (j->>'cost_micro_usd')::bigint from big), '>',
              (select bal from drain), 'the settle is larger than the entire wallet');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          0::bigint, 'I1: the balance floors at exactly 0, never negative');
select is((select (j->>'balance_micro_usd')::bigint from big), 0::bigint,
          'I1: the returned balance is 0');
select is((select write_off_micro_usd from public.usage_transactions
             where id = 'a0000000-0000-0000-0000-000000000004'::uuid),
          (select (j->>'cost_micro_usd')::bigint - (select bal from drain) from big),
          'the shortfall is recorded as write_off_micro_usd, not silently absorbed');
select is((select amount_micro_usd from public.wallet_ledger
             where usage_transaction_id = 'a0000000-0000-0000-0000-000000000004'::uuid),
          (select -bal from drain),
          'I4: the ledger row records the cash actually moved, not the notional cost');
select is((select count(*)::int from public.wallet_ledger
             where usage_transaction_id = 'a0000000-0000-0000-0000-000000000004'::uuid),
          1, 'I4: exactly one ledger row for the write-off settlement');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift even when a settlement wrote off part of the cost');

-- The creator was accrued a share of money that was never collected. If that is
-- intended, the platform is eating the write-off; assert it explicitly so the
-- behaviour is visible rather than accidental.
select is(
  (select gross_micro_usd from public.creator_earnings
     where usage_transaction_id = 'a0000000-0000-0000-0000-000000000004'::uuid),
  (select (j->>'cost_micro_usd')::bigint from big),
  'creator_earnings.gross is the FULL cost even though only part was collected');

-- ── A second settle against a wallet that is ALREADY EMPTY ──────────────────
select is((public.authorize_request('a0000000-0000-0000-0000-000000000006'::uuid, :'payer'::uuid,
             :'apikey'::uuid, :'model'::uuid, 0, 0, true)->>'code'),
          'insufficient_balance', 'an empty wallet cannot authorize a new request');

-- BUG PROBE: the whole cost is written off, so the ledger amount computed by
-- deduct_token_cost is -(cost - write_off) = 0, which violates
-- wallet_ledger_sign_matches_kind (usage_debit requires amount < 0). The
-- settlement raises, the GPU work goes unbilled and the row is stranded as
-- 'reserved'. This is the sequential form of the concurrent drain race.
select lives_ok(
  $$ select public.deduct_token_cost('a0000000-0000-0000-0000-000000000005'::uuid, 1000, 1000) $$,
  'settling a fully written-off request against a zero balance must not raise');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          0::bigint, 'I1: the balance is still 0 after the zero-balance settle attempt');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after the zero-balance settle attempt');

-- ── credit_wallet guards ────────────────────────────────────────────────────
select throws_ok($$ select public.credit_wallet('00000000-0000-0000-0000-0000000000a2'::uuid,
                    0::bigint, 'grant'::public.ledger_kind) $$,
                 '22023', null, 'credit_wallet rejects a zero credit');
select throws_ok($$ select public.credit_wallet('00000000-0000-0000-0000-0000000000a2'::uuid,
                    -100::bigint, 'grant'::public.ledger_kind) $$,
                 '22023', null, 'credit_wallet rejects a negative credit');
select is((public.credit_wallet(:'payer'::uuid, 999999999999::bigint,
             'grant'::public.ledger_kind)->>'code'),
          'max_balance_exceeded', 'credit_wallet enforces max_balance_micro_usd');

-- ── debit_wallet_reversal: refunds and chargebacks (FR-BIL-035) ─────────────
-- The wallet is at 0 here from the write-off above, so start from a known,
-- deliberately small balance.
select public.credit_wallet(:'payer'::uuid, 10000000::bigint, 'topup'::public.ledger_kind,
                            'evt_rev_seed', 'cs_rev_seed', 'reversal fixture', 'pi_rev_seed');

select throws_ok($$ select public.debit_wallet_reversal(
                      '00000000-0000-0000-0000-0000000000a2'::uuid, 100::bigint,
                      'topup'::public.ledger_kind) $$,
                 '22023', null, 'debit_wallet_reversal refuses a non-reversal kind');
select throws_ok($$ select public.debit_wallet_reversal(
                      '00000000-0000-0000-0000-0000000000a2'::uuid, -100::bigint,
                      'refund'::public.ledger_kind) $$,
                 '22023', null, 'debit_wallet_reversal wants a positive magnitude');

-- A partial refund debits exactly what was asked for.
select is((public.debit_wallet_reversal(:'payer'::uuid, 4000000::bigint,
             'refund'::public.ledger_kind, 'evt_rev_1', 'pi_rev_seed', 'partial refund')
           ->>'applied_micro_usd')::bigint,
          4000000::bigint, 'a refund inside the balance applies in full');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          6000000::bigint, 'the balance reflects the refund');

-- Replay of the same Stripe event is a no-op, not a second debit.
select is((public.debit_wallet_reversal(:'payer'::uuid, 4000000::bigint,
             'refund'::public.ledger_kind, 'evt_rev_1', 'pi_rev_seed', 'partial refund')
           ->>'replayed')::boolean,
          true, 'a redelivered reversal event is a no-op');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          6000000::bigint, 'the replayed reversal did not debit twice');

-- A chargeback larger than the balance floors at zero rather than aborting on
-- the CHECK — an aborted transaction here would make Stripe retry forever.
select is((public.debit_wallet_reversal(:'payer'::uuid, 999999999999::bigint,
             'chargeback'::public.ledger_kind, 'evt_rev_2', 'pi_rev_seed', 'dispute')
           ->>'floored')::boolean,
          true, 'an oversized chargeback reports that it floored');
select is((select balance_micro_usd from public.profiles where id = :'payer'::uuid),
          0::bigint, 'I1: the balance floors at 0, never negative');
select isnt((select flagged_for_review_at from public.profiles where id = :'payer'::uuid),
            null, 'a chargeback flags the account for ops review');
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: no drift after refund + floored chargeback');

select * from finish();
rollback;
