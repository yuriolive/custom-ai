-- ============================================================================
-- #37 — the placement solver may never emit a slot count whose AGGREGATE
-- allocation exceeds usable VRAM.
--
-- The bug: the solver handed the worker `parallel=91`. llama.cpp computes
-- `total_ctx = ctx_size * parallel` and allocates that KV eagerly at load, so the
-- container booted, asked one card for 46592 MiB, and died before serving a token.
-- The fit test it passed was `weights + ONE stream + overhead <= usable` — a figure
-- that corresponds to nothing the worker does.
--
-- WHY THESE ASSERTIONS ARE PHRASED AS "NO VIOLATIONS" rather than one test per
-- (tier, shape) pair: the tier catalog is data, and a plan() count that changes when
-- a GPU is added or retired makes this file fail for a reason unrelated to what it
-- checks. `is(<list of offenders>, null)` keeps the count fixed and still names every
-- offender in the diagnostic. The `at least 20 feasible placements` assertion below is
-- what stops the whole sweep from passing vacuously if the shapes stop resolving.
--
-- The mirror of this file on the Python side is tools/modal/test_tier_drift.py
-- (AggregateCapacityTest) — two catalogs, one invariant, and #37 is what happens when
-- only one of them is checked.
-- ============================================================================
begin;
select plan(31);

-- ── The shapes, and why each is here ────────────────────────────────────────
--   mvp_target       the seeded MVP-0 model, hybrid attention/SSM, 8k context
--   incident_iq2_m   the exact #37 container: the IQ2_M variant at 9.90 GiB, 8k
--                    context, the geometry the probe reads for this architecture.
--                    This shape produced 91 slots and a 745472-token total context.
--   mvp_target_262k  the architecture's full context ceiling: the regime where one
--                    slot nearly fills the card and the cap cannot be what binds
--   small_dense      a small dense model on big hardware: the regime where nothing
--                    BUT the cap binds, which is the case the old solver got wrong
--   pure_attention   the same 27B read as if every block held a KV cache (the
--                    pre-hybrid fallback, ~4x the KV)
--   impossible       weights no GPU can hold, so infeasibility stays infeasible
create temporary view placement_sweep as
with shapes(name, weights, ctx, n_layers, n_attn, kv_heads, head_dim, ssm) as (
  values
    ('mvp_target',      16810714528::bigint,   8192,  65, 16, 4, 256,
     public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint)),
    ('incident_iq2_m',  10630054871::bigint,   8192,  65, 16, 4, 256,
     public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint)),
    ('mvp_target_262k', 16810714528::bigint, 262144,  65, 16, 4, 256,
     public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint)),
    ('small_dense',      2147483648::bigint,   4096,  32, 32, 8, 128, 0::bigint),
    ('pure_attention',  16810714528::bigint,   8192,  65, 65, 4, 256, 0::bigint),
    ('impossible',     966367641600::bigint,   8192, 100,100, 8, 128, 0::bigint)
)
select s.name, s.ctx, s.weights, t.id as tier,
       public.resolve_placement(
         s.weights, s.weights, s.n_layers, s.kv_heads, s.head_dim,
         s.ctx, 30, 2::smallint, t.id, s.n_attn, s.ssm) as p
  from shapes s cross join public.gpu_tiers t
 where t.is_enabled;

-- Only feasible envelopes carry the capacity keys (they come from the winning-tier
-- object), so every assertion below reads from this.
create temporary view feasible_placements as
select name, ctx, weights, tier,
       (p->>'max_concurrent_streams')::integer          as slots,
       (p->>'max_concurrent_streams_uncapped')::integer as slots_uncapped,
       (p->>'max_slots_ceiling')::integer               as ceiling,
       (p->>'weights_bytes')::bigint                    as weights_bytes,
       (p->>'overhead_bytes')::bigint                   as overhead_bytes,
       (p->>'overhead_base_bytes')::bigint              as overhead_base_bytes,
       (p->>'bytes_per_stream')::bigint                 as bytes_per_stream,
       (p->>'slot_cost_bytes')::bigint                  as slot_cost_bytes,
       (p->>'aggregate_bytes')::bigint                  as aggregate_bytes,
       (p->>'usable_vram_bytes')::bigint                as usable_bytes,
       (p->>'kv_bytes_per_token')::bigint               as kv_bytes_per_token,
       (p->>'cost_floor_micro_per_mtoken')::bigint      as cost_floor,
       p
  from placement_sweep
 where (p->>'feasible')::boolean;

-- ── The sweep is not vacuous ────────────────────────────────────────────────
select ok((select count(*) from placement_sweep) > 0, 'the placement sweep resolved');
select cmp_ok((select count(*)::int from feasible_placements), '>=', 20,
  'the sweep produced feasible placements to check — a sweep where everything is '
  'infeasible would pass every violation check below without asserting anything');

-- ── THE INVARIANT ───────────────────────────────────────────────────────────
select is(
  (select string_agg(format('%s/%s: %s slots need %s of %s usable',
                            name, tier, slots, aggregate_bytes, usable_bytes), '; ')
     from feasible_placements where aggregate_bytes > usable_bytes),
  null,
  'no placement allocates more than usable VRAM in aggregate (weights + overhead + '
  'slots x per-stream) — the #37 fit test asked about ONE stream');

select is(
  (select string_agg(format('%s/%s: kv %s x total_ctx %s + weights %s > usable %s',
                            name, tier, kv_bytes_per_token, ctx * slots,
                            weights_bytes, usable_bytes), '; ')
     from feasible_placements
    where weights_bytes + kv_bytes_per_token * ctx * slots > usable_bytes),
  null,
  'the KV buffer llama.cpp allocates at load (kv_bytes_per_token x ctx_size x parallel) '
  'fits on the card alongside the weights — this is the allocation that failed in #37');

-- ── The cap, in both directions ──────────────────────────────────────────────
select is(
  (select string_agg(format('%s/%s: %s slots, ceiling %s', name, tier, slots, ceiling), '; ')
     from feasible_placements where slots < 1 or slots > ceiling),
  null,
  'every emitted slot count is between 1 and the solver_config ceiling');

-- The hard bound, restated as a literal on purpose: the assertion above is relative to
-- whatever solver_config says, and #37 is a bug about a number nothing bounded
-- absolutely. 32 is `v_slot_hard_cap` in the solver and SLOT_HARD_CAP in tiers.py.
select is(
  (select string_agg(format('%s/%s: %s slots', name, tier, slots), '; ')
     from feasible_placements where slots > 32),
  null,
  'no placement exceeds the hard slot bound of 32, whatever solver_config holds');

-- ── The envelope is self-checkable ──────────────────────────────────────────
-- A caller must be able to verify the fit without knowing any solver constant, which
-- is exactly what lib/studio/server/deploy.ts does before handing a slot count to a
-- worker. Exact equality: `<=` would still hold if overhead reverted to a flat figure.
select is(
  (select string_agg(format('%s/%s: %s + %s + %s x %s <> %s', name, tier, weights_bytes,
                            overhead_bytes, slots, bytes_per_stream, aggregate_bytes), '; ')
     from feasible_placements
    where weights_bytes + overhead_bytes + slots * bytes_per_stream <> aggregate_bytes),
  null,
  'weights + overhead + slots x bytes_per_stream = aggregate_bytes, exactly');

-- The third of #37's causes: overhead was max(2 GiB, 10% of weights), independent of
-- both slot count and total context, while llama.cpp's compute buffers scale with both.
select is(
  (select string_agg(format('%s/%s: overhead %s = base %s at %s slots',
                            name, tier, overhead_bytes, overhead_base_bytes, slots), '; ')
     from feasible_placements where overhead_bytes <= overhead_base_bytes),
  null,
  'overhead grows with the slot count and the total context — it is not a flat term');

select is(
  (select string_agg(format('%s/%s: slot_cost %s <= per_stream %s',
                            name, tier, slot_cost_bytes, bytes_per_stream), '; ')
     from feasible_placements where slot_cost_bytes <= bytes_per_stream),
  null,
  'a slot costs strictly more than its stream KV: it carries its own buffers');

select is(
  (select string_agg(format('%s/%s: floor %s', name, tier, cost_floor), '; ')
     from feasible_placements where cost_floor is null or cost_floor <= 0),
  null,
  'every feasible placement carries a positive cost floor');

-- ════════════════════════════════════════════════════════════════════════════
-- The incident itself. `a100_80` is the tier the arithmetic pins it to: reversing 91
-- slots through the old formula lands on a card of exactly 85899345920 bytes.
-- ════════════════════════════════════════════════════════════════════════════
select ok((select count(*) = 1 from feasible_placements
            where name = 'incident_iq2_m' and tier = 'a100_80'),
          'the #37 shape still resolves on the tier it landed on — the fix is a cap, '
          'not a refusal to place the model');

select cmp_ok((select slots from feasible_placements
                where name = 'incident_iq2_m' and tier = 'a100_80'),
              '<=', 8, 'the #37 shape resolves to at most 8 slots, not 91');

-- The cap is what bound it, not the fit. If this fails, the assertion above has
-- stopped proving what it claims to: something else became the binding constraint.
select cmp_ok((select slots_uncapped from feasible_placements
                where name = 'incident_iq2_m' and tier = 'a100_80'),
              '>', 8, 'without a ceiling this tier still divides into dozens of slots');

select cmp_ok((select ctx * slots from feasible_placements
                where name = 'incident_iq2_m' and tier = 'a100_80'),
              '<', 745472,
              'the total context handed to llama-server is far below the 745472 that '
              'asked for 46592 MiB of KV');

-- The cost floor no longer moves with the slot count (#37's second cause: dividing by
-- the slot count made a tier look cheaper the more slots it could nominally hold, so
-- the pricing math rewarded inflating the value that becomes `--parallel`). Two
-- contexts, very different uncapped slot counts, identical floor.
select is(
  (select (public.resolve_placement(10630054871, 10630054871, 65, 4, 256, 2048, 30,
             2::smallint, 'a100_80', 16,
             public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint))
          ->>'cost_floor_micro_per_mtoken')::bigint),
  (select cost_floor from feasible_placements
    where name = 'incident_iq2_m' and tier = 'a100_80'),
  'the cost floor is invariant to the slot count above batch_throughput_factor');

select ok((select bool_and(not (p->>'feasible')::boolean) from placement_sweep
            where name = 'impossible'),
          'weights no GPU can hold are still infeasible everywhere');

select ok((select bool_and(coalesce(p->>'blocking_reason', '') <> '')
             from placement_sweep where name = 'impossible'),
          'and every infeasible envelope still names what blocked it');

-- ── A context no tier can hold ONE slot of ──────────────────────────────────
-- The near-miss guard reads the WEIGHTS, not the request. When it read the request
-- (`weights + overhead + slot_cost <= usable`, evaluated at the requested context), a
-- context this large failed it on every tier, so max_context_at_this_quality came back
-- 0 and the envelope blamed the weights — which fit fine. The Studio turns that field
-- into a "Reduce context to N" button, so a 0 removes the remedy from the one request
-- that needs it. 4M tokens exceeds every tier's per-slot budget while the 16.81 GiB of
-- weights fit on almost all of them.
create temporary view oversized_context as
select public.resolve_placement(
         16810714528, 16810714528, 65, 4, 256, 4000000, 30, 2::smallint, null, 16,
         public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint)) as p;

select ok((select not (p->>'feasible')::boolean from oversized_context),
          'a 4M-token context is infeasible');
select cmp_ok((select (p->>'max_context_at_this_quality')::integer from oversized_context),
              '>', 0,
              'and the envelope still reports the largest context that WOULD fit, so the '
              'creator gets a remedy instead of being told the weights do not fit');
select cmp_ok((select (p->>'max_context_at_this_quality')::integer from oversized_context),
              '<', 4000000, 'which is smaller than what was asked for');
select ok((select p->>'blocking_reason' like 'Context of%' from oversized_context),
          'and the reason names the context, not the weights');
select cmp_ok((select (p->>'fastest_available_tokens_per_second')::integer
                 from oversized_context),
              '>', 0, 'the fastest-available figure is populated on the same path');

-- ════════════════════════════════════════════════════════════════════════════
-- The constants, and the row that stopped existing.
-- ════════════════════════════════════════════════════════════════════════════
-- llama.cpp has no separate prefix-cache pool — prefix reuse happens inside a slot's
-- own KV — so `prefix_cache_reserve` described an allocation the worker never makes.
-- The 15% is real slack and is kept; only the name changed. A config row nothing reads
-- is a lie waiting to be believed, hence gone rather than left behind.
select is((select count(*)::int from public.solver_config where key = 'prefix_cache_reserve'),
          0, 'prefix_cache_reserve is gone, not merely unread');
select is((select value from public.solver_config where key = 'kv_headroom_reserve'),
          0.15::numeric, 'the 15% reserve survived the rename with its value intact');
select is((select value from public.solver_config where key = 'max_slots_ceiling'),
          8::numeric, 'the slot ceiling is configured');
select cmp_ok((select value from public.solver_config where key = 'max_slots_ceiling'),
              '<=', 32::numeric,
              'and it cannot be configured above the solver hard bound');

select ok((select bool_and(p ? 'kv_headroom_bytes') from feasible_placements),
          'the envelope reports the headroom it left unallocated');
select ok((select bool_and(not (p ? 'prefix_cache_bytes')) from feasible_placements),
          'and no longer reports a prefix-cache pool that never existed');

-- ════════════════════════════════════════════════════════════════════════════
-- The seeded model: the solver runs for real in seed.sql, so this is the number a
-- deployment would actually put in `parallel=` on a fresh database.
-- ════════════════════════════════════════════════════════════════════════════
select ok((select max_concurrent_streams between 1 and 8
             from public.custom_models
            where id = '00000000-0000-0000-0000-0000000000c1'),
          'the seeded model stores a capped slot count');

select ok((select (placement_rationale->>'aggregate_bytes')::bigint
                  <= (placement_rationale->>'usable_vram_bytes')::bigint
             from public.custom_models
            where id = '00000000-0000-0000-0000-0000000000c1'),
          'and its snapshotted rationale fits the card it names');

-- The batch wrapper is a loop over the same function (20260818000100 asserts full
-- envelope equality at migrate time); this checks the one field #37 is about, through
-- the path the Studio's live preview actually calls.
select is(
  (select (public.resolve_placement_batch(
             jsonb_build_array(jsonb_build_object(
               'id', 'incident', 'weights_bytes', 10630054871,
               'active_weights_bytes', 10630054871)),
             65, 4, 256, 8192, 30, 2::smallint, 16,
             public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint))
          ->0->'placement'->>'max_concurrent_streams')::integer),
  (select (public.resolve_placement(
             10630054871, 10630054871, 65, 4, 256, 8192, 30, 2::smallint, null, 16,
             public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint))
          ->>'max_concurrent_streams')::integer),
  'the Studio preview and the deploy path agree on the slot count');

select * from finish();
rollback;
