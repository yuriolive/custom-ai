-- ============================================================================
-- I3 — creator_micro + platform_micro == cost_micro, EXACTLY.
--
-- Property-style sweep: every combination of {fee_bps} x {price pair} x {token
-- pair} is authorized and settled for real through the shipped RPCs, and the
-- identity is asserted over the whole result set at once. Deliberately includes
-- fee_bps 0 / 1 / 9999 / 10000 and price/token pairs that produce costs of
-- exactly 1 and 2 micro-USD, where integer rounding is most likely to break.
-- ============================================================================
begin;
select plan(14);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set apikey  '00000000-0000-0000-0000-0000000000b1'
\set model   '00000000-0000-0000-0000-0000000000c1'

-- Fund the payer far beyond anything the sweep can spend, through the real RPC
-- so the ledger stays consistent (I4).
update public.profiles set max_balance_micro_usd = 1000000000000 where id = :'payer';
select public.credit_wallet(:'payer'::uuid, 500000000000::bigint, 'grant'::public.ledger_kind,
                            null, null, 'i3 sweep funding');

create temp table sweep(
  fee_bps     integer,
  pp          bigint,
  pc          bigint,
  prompt      integer,
  completion  integer,
  txn         uuid,
  cost        bigint,
  creator     bigint,
  platform    bigint
);

do $$
declare
  v_fee   integer;
  v_pp    bigint;
  v_pc    bigint;
  v_p     integer;
  v_c     integer;
  v_txn   uuid;
  v_res   jsonb;
  v_auth  jsonb;
begin
  foreach v_fee in array array[0, 1, 2000, 5000, 9999, 10000] loop
    for v_pp, v_pc in
      select a, b from (values
        (500000::bigint, 1500000::bigint),   -- the seeded price point
        (1::bigint,            1::bigint),   -- sub-micro rates -> cost floors at 1..2
        (0::bigint,            0::bigint),   -- free model -> FR-BIL-004 minimum unit
        (1000000::bigint,1000000::bigint),   -- exactly 1 micro per token
        (2000001::bigint,3000007::bigint)    -- prime-ish rates, worst case for rounding
      ) as t(a, b)
    loop
      for v_p, v_c in
        select a, b from (values
          (1, 0), (0, 1), (1, 1), (2, 0), (0, 2), (3, 7),
          (999, 1), (1000, 2000), (65536, 1)
        ) as t(a, b)
      loop
        update public.custom_models
           set platform_fee_bps = v_fee,
               price_prompt_micro_usd_per_mtoken = v_pp,
               price_completion_micro_usd_per_mtoken = v_pc
         where id = '00000000-0000-0000-0000-0000000000c1';

        v_txn := extensions.gen_random_uuid();

        v_auth := public.authorize_request(
                    v_txn,
                    '00000000-0000-0000-0000-0000000000a2'::uuid,
                    '00000000-0000-0000-0000-0000000000b1'::uuid,
                    '00000000-0000-0000-0000-0000000000c1'::uuid,
                    v_p, v_c, true);

        if not (v_auth->>'ok')::boolean then
          raise exception 'sweep authorize failed unexpectedly: %', v_auth;
        end if;

        v_res := public.deduct_token_cost(v_txn, v_p, v_c, 10, 100, false, false, false);

        insert into sweep values (
          v_fee, v_pp, v_pc, v_p, v_c, v_txn,
          (v_res->>'cost_micro_usd')::bigint,
          (v_res->>'creator_micro_usd')::bigint,
          (v_res->>'platform_micro_usd')::bigint);
      end loop;
    end loop;
  end loop;
end $$;

-- Sanity: the sweep actually ran.
select is((select count(*)::int from sweep), 270, 'sweep settled 270 transactions');

-- ── I3 proper ───────────────────────────────────────────────────────────────
select is(
  (select count(*)::int from sweep where creator + platform <> cost),
  0,
  'I3: creator + platform == cost for every swept combination'
);

select is(
  (select count(*)::int from sweep where creator < 0 or platform < 0 or cost < 0),
  0,
  'I3: no component of the split is ever negative'
);

-- The split matches the documented formula, computed independently in numeric.
select is(
  (select count(*)::int from sweep
     where platform <> ceil(cost::numeric * fee_bps / 10000)::bigint),
  0,
  'platform_micro == CEIL(cost * fee_bps / 10000) for every combination'
);

select is(
  (select count(*)::int from sweep where fee_bps = 10000 and creator <> 0),
  0,
  'fee_bps = 10000 leaves the creator exactly 0'
);

select is(
  (select count(*)::int from sweep where fee_bps = 0 and platform <> 0),
  0,
  'fee_bps = 0 leaves the platform exactly 0'
);

select is(
  (select count(*)::int from sweep where fee_bps = 0 and creator <> cost),
  0,
  'fee_bps = 0 gives the creator the entire cost'
);

-- fee_bps = 1 on a 1-micro cost: CEIL(0.0001) = 1, so the platform takes it all.
select is(
  (select count(*)::int from sweep where fee_bps = 1 and cost = 1 and platform <> 1),
  0,
  'fee_bps = 1 on a 1-micro cost rounds the whole unit to the platform'
);

-- The rounding-sensitive costs are genuinely present in the sweep.
select cmp_ok((select count(*)::int from sweep where cost = 1), '>', 0,
              'sweep exercises cost = 1 micro-USD');
select cmp_ok((select count(*)::int from sweep where cost = 2), '>', 0,
              'sweep exercises cost = 2 micro-USD');

-- ── The persisted rows agree with the RPC return values ─────────────────────
select is(
  (select count(*)::int
     from sweep s join public.usage_transactions t on t.id = s.txn
    where t.cost_micro_usd <> s.cost
       or t.creator_micro_usd <> s.creator
       or t.platform_micro_usd <> s.platform
       or t.status <> 'settled'),
  0,
  'usage_transactions rows agree with the deduct_token_cost return envelope'
);

-- ── creator_earnings reconciles row-by-row and in aggregate ─────────────────
select is(
  (select count(*)::int
     from sweep s join public.creator_earnings e on e.usage_transaction_id = s.txn
    where e.gross_micro_usd <> s.cost
       or e.net_micro_usd <> s.creator
       or e.platform_fee_micro_usd <> s.platform),
  0,
  'creator_earnings rows reconcile against the settled split'
);

select is(
  (select coalesce(sum(net_micro_usd), 0)::bigint from public.creator_earnings
     where usage_transaction_id in (select txn from sweep)),
  (select coalesce(sum(creator), 0)::bigint from sweep),
  'sum of accrued creator earnings == sum of creator shares'
);

-- ── I4 over the whole sweep ─────────────────────────────────────────────────
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: v_balance_drift is empty after 270 settlements');

select * from finish();
rollback;
