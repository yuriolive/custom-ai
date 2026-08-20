-- ============================================================================
-- 20260820000100_solver_slot_cap.sql   (fixes #37)
--
-- The solver handed the worker `parallel=91`. llama.cpp computes
-- `total_ctx = ctx_size * parallel` and allocates that KV EAGERLY at load, so the
-- container booted, asked one card for 46592 MiB of KV, and died:
--
--   [serve] ctx_size(per slot)=8192 parallel=91 total_ctx=745472
--   E ggml_backend_cuda_buffer_type_alloc_buffer: allocating 46592.00 MiB ... out of memory
--
-- READ THE ARITHMETIC BEFORE CHANGING ANY CONSTANT BELOW. 46592 MiB / 745472 tokens
-- = 65536 bytes/token, and 2 x 16 attention blocks x 4 kv heads x 256 key_length x 2
-- bytes = 65536 exactly. `kv_bytes_per_token` was never wrong, and neither was the
-- attention-layer count. Four other things were:
--
--   1. NOTHING CAPPED THE SLOT COUNT. `v_concurrent` was whatever the KV pool
--      divided into. A big card therefore produced a big `--parallel`, and a big
--      `--parallel` multiplies the context llama.cpp allocates up front. 91 slots is
--      not an operating point anybody chose; it is a division result.
--
--   2. THE COST FLOOR DIVIDED BY THAT SAME NUMBER. `1e6 / (tok_s * v_concurrent *
--      util)` made a tier look cheaper the more slots it could nominally hold, so the
--      pricing math actively rewarded inflating the value that becomes `--parallel`.
--      Decode on one GPU shares one memory-bandwidth budget: 91 slots do not decode
--      91x faster, they decode at roughly 1/91 each. One number was doing two jobs
--      and was being maximised for the second. They are two numbers now:
--      `max_concurrent_streams` (a capacity ceiling, and the worker's slot count) and
--      `batch_throughput_factor` (how much aggregate throughput batching is assumed
--      to buy, which is a property of the hardware, not of the slot count we ask for).
--
--   3. OVERHEAD WAS FLAT. `max(2 GiB, 10% of weights)` is independent of both the
--      slot count and the total context, while llama.cpp's compute buffers scale
--      with both: the unified attention mask alone is sized by the KV cell count, and
--      every slot carries its own output/sampling buffers. At 745k total context that
--      term is not 2 GiB. It is now base + per-slot + per-context-token, which folds
--      into ONE per-slot cost because total context is `ctx * slots` (see v_slot_cost).
--
--   4. THE FIT TEST WAS SINGLE-STREAM. `weights + ONE stream + overhead <= usable`
--      says nothing about what the worker allocates, which is `weights + overhead +
--      slots x per_stream`. That aggregate is what has to fit, and it is now both
--      solved for and re-asserted before the placement is emitted.
--
-- Sibling of #36: that issue stops a doomed container from billing. This one stops
-- the doomed parameter set from being produced.
--
-- tools/modal/tiers.py CARRIES THE SAME CHANGE. There are two catalogs, this one runs
-- at request time, and they had already drifted on exactly this number (this file
-- applied prefix_cache_reserve, tiers.py applied nothing, so the Python solver
-- returned ~17.6% more slots than the RPC). test_tier_drift.py fails if the
-- constants, or the hard cap literal below, stop matching.
-- ============================================================================

-- ── The 15% reserve, named for what it actually does ────────────────────────
-- `prefix_cache_reserve` was described as "the fraction of the KV region held for
-- prefix caching", justified by NFR-CACHE-021 (without a reserved pool, cached
-- prefixes are evicted on arrival and APC silently does nothing). That is true of a
-- server with a separate prefix-cache allocation. llama.cpp has none: prefix reuse
-- happens INSIDE a slot's own KV, by keeping the common prefix of the previous
-- sequence in the same cells. There is no pool to reserve and no allocation the
-- worker would make for one, so this fraction never bought caching behaviour.
--
-- What it did buy, silently, is the only slack standing between the solver's model of
-- VRAM and llama.cpp's real allocation — fragmentation, the contiguous-block
-- requirement of a single multi-GiB cudaMalloc, and every buffer the overhead term
-- does not name. That is worth keeping and worth being honest about, so the value is
-- unchanged and the name is not. Renamed rather than dropped: the reserve is load
-- bearing, and deleting it would have quietly handed those bytes to slot KV.
--
-- DELETE, not update: `prefix_cache_reserve` has no reader after this migration, and
-- a config row nothing reads is a lie waiting to be believed by the next person who
-- greps for prefix caching. (When APC gets a real pool on a vLLM worker, that is a
-- new key with a new meaning, not this one resurrected.)
delete from public.solver_config where key = 'prefix_cache_reserve';

insert into public.solver_config (key, value, description) values
  ('kv_headroom_reserve', 0.15,
   'Fraction of the KV region left unallocated: allocator fragmentation, the contiguous-block cost of one multi-GiB cudaMalloc, and buffers the overhead term does not model. NOT a prefix-cache pool — llama.cpp has none, it reuses slot KV.'),

  -- ── The cap (#37) ────────────────────────────────────────────────────────
  -- Policy, not physics: the largest slot count the platform will ASK a worker for.
  -- 8 is far above what an MVP endpoint needs (assumed_utilization is 0.35 — the
  -- platform's own model says these endpoints are not saturated) and far below the
  -- regime where `ctx_size * parallel` becomes the binding allocation. Raising it is
  -- a deliberate act with a measurement behind it, which is why it is a row and not
  -- a division result. It can never exceed the hard cap in resolve_placement().
  ('max_slots_ceiling', 8,
   'Maximum llama.cpp slots (--parallel) the solver will emit. A ceiling on capacity, not a throughput multiplier.'),

  -- Compute buffers that scale with TOTAL context (ctx x slots). llama.cpp sizes the
  -- unified attention mask by KV cells and reserves graph buffers against the same
  -- number; ~1 KiB/token is the mask at the default n_ubatch of 512, and the graph
  -- reservation holds more than the mask. Deliberately a round, conservative figure:
  -- the production incident bounds this term from BELOW (weights 9.90 GiB + KV 45.5
  -- GiB failed on an 80 GiB card) without identifying the mechanism, so it is carried
  -- as recalibratable config rather than as a fitted constant. #36 retains llama.cpp's
  -- own "KV self size" line, which is what will let this be measured instead of chosen.
  ('graph_bytes_per_ctx_token', 2048,
   'Compute/mask buffer bytes per token of TOTAL context (ctx_size x parallel)'),

  -- Per-slot, independent of context: output and logits buffers, sampler state, and
  -- llama.cpp's per-sequence bookkeeping.
  ('slot_overhead_bytes', 67108864,
   'Fixed bytes per llama.cpp slot, independent of context length'),

  -- The multiplier the COST FLOOR is allowed to assume from batching, replacing
  -- `max_concurrent_streams` in that formula. Batching does buy real aggregate
  -- throughput (weights are read once per batch, not once per sequence), but it is
  -- bounded by the same memory-bandwidth budget every stream shares — so it is a
  -- property of the hardware, and it must not grow just because the solver found room
  -- for another slot. 4x is conservative for small batches on a bandwidth-bound
  -- decode; the floor it produces is higher than the old one because the old one
  -- assumed dozens of streams each running at FULL single-stream speed.
  ('batch_throughput_factor', 4,
   'Aggregate decode throughput assumed from batching, as a multiple of single-stream tok/s. Used by the cost floor INSTEAD of the slot count.')
on conflict (key) do update set
  value       = excluded.value,
  description = excluded.description;

-- ============================================================================
-- resolve_placement v3.
--
-- Same signature (so every call site, including resolve_placement_batch and the
-- Studio's RPC, is untouched) and the same envelope keys, plus:
--
--   max_concurrent_streams_uncapped   what the KV pool divided into, before the cap.
--                                     Kept so placement_rationale records WHY the
--                                     slot count is what it is (FR-DEP-051), and so
--                                     a cap that starts binding everywhere is visible
--                                     rather than inferred.
--   slot_cost_bytes                   per-slot allocation: stream KV + SSM state +
--                                     per-slot overhead + this slot's share of the
--                                     context-scaled compute buffers.
--   aggregate_bytes                   what the worker will actually allocate. THE
--                                     number that has to fit.
--   kv_headroom_bytes                 renamed from prefix_cache_bytes (see above).
--
-- `overhead_bytes` keeps its name and changes meaning: it is now the overhead AT THE
-- EMITTED SLOT COUNT, not a flat figure, so `weights_bytes + overhead_bytes +
-- max_concurrent_streams * bytes_per_stream = aggregate_bytes` holds in the envelope
-- and any reader can check the fit without knowing these constants.
-- ============================================================================
create or replace function public.resolve_placement(
  p_weights_bytes         bigint,
  p_active_weights_bytes  bigint,
  p_n_layers              integer,
  p_n_kv_heads            integer,
  p_head_dim              integer,
  p_context_length        integer,
  p_target_tokens_per_second integer,
  p_kv_dtype_bytes        smallint default 2,
  p_pin_tier_id           text default null,
  p_n_attention_layers    integer default null,
  p_ssm_state_bytes_per_seq bigint default 0
)
returns jsonb
language plpgsql stable parallel safe
set search_path = public, pg_temp
as $$
declare
  -- A slot count no config row may exceed. `max_slots_ceiling` is policy and lives in
  -- solver_config so it can be recalibrated; THIS is the bound that survives a bad
  -- row, a NULL read, or a future migration that "temporarily" raises the ceiling.
  -- The bug this file fixes emitted 91, and a config-only guard would have let a
  -- single UPDATE reintroduce it. Mirrored as SLOT_HARD_CAP in tools/modal/tiers.py;
  -- test_tier_drift.py compares the two literals.
  v_slot_hard_cap constant integer := 32;

  v_mfu            numeric;
  v_vram_util      numeric;
  v_assumed_util   numeric;
  v_tolerance      numeric;
  v_headroom       numeric;
  v_slot_ceiling   integer;
  v_graph_per_tok  bigint;
  v_slot_fixed     bigint;
  v_batch_factor   numeric;
  v_volume_threshold numeric;
  v_download_rate    numeric;

  v_attn_layers   integer;
  v_ssm_bytes     bigint;
  v_kv_per_token  bigint;
  v_per_stream    bigint;   -- kv for one full context + the constant SSM state
  v_base_overhead bigint;   -- CUDA context, framework, weight-scaled buffers
  v_slot_cost     bigint;   -- everything one additional slot costs
  v_tier          record;
  v_usable        bigint;
  v_kv_total      bigint;
  v_required      bigint;   -- aggregate at one slot: the "does it fit at all" figure
  v_aggregate     bigint;   -- aggregate at the slot count actually emitted
  v_overhead      bigint;   -- overhead at that same slot count
  v_tok_s         numeric;
  v_pool          bigint;   -- bytes left for slots after weights + base overhead
  v_allocatable   bigint;   -- v_pool minus the headroom reserve
  v_fit_slots     integer;  -- what the pool divides into, uncapped
  v_concurrent    integer;  -- what we will actually ask the worker for
  v_price_streams numeric;
  v_cost_floor    bigint;

  v_considered    jsonb := '[]'::jsonb;
  v_reject        text;
  v_best          jsonb := null;
  v_any_fits      boolean := false;
  v_fastest       numeric := 0;
  v_max_ctx_fit   integer := 0;
begin
  select max(case when key = 'mfu'                  then value end),
         max(case when key = 'vram_utilization'     then value end),
         max(case when key = 'assumed_utilization'  then value end),
         max(case when key = 'speed_tolerance'      then value end),
         max(case when key = 'kv_headroom_reserve'  then value end),
         max(case when key = 'max_slots_ceiling'    then value end),
         max(case when key = 'graph_bytes_per_ctx_token' then value end),
         max(case when key = 'slot_overhead_bytes'  then value end),
         max(case when key = 'batch_throughput_factor'   then value end),
         max(case when key = 'volume_threshold_bytes' then value end),
         max(case when key = 'download_bytes_per_s'   then value end)
    into v_mfu, v_vram_util, v_assumed_util, v_tolerance, v_headroom,
         v_slot_ceiling, v_graph_per_tok, v_slot_fixed, v_batch_factor,
         v_volume_threshold, v_download_rate
    from public.solver_config;

  -- A missing or absurd row must not widen the cap or delete the headroom: every
  -- default here is the SAFE direction (fewer slots, more reserve), and the ceiling
  -- is clamped to the hard cap rather than trusted.
  v_headroom      := least(0.9, greatest(0, coalesce(v_headroom, 0.15)));
  v_slot_ceiling  := least(v_slot_hard_cap, greatest(1, coalesce(v_slot_ceiling, 1)));
  v_graph_per_tok := greatest(0, coalesce(v_graph_per_tok, 2048));
  v_slot_fixed    := greatest(0, coalesce(v_slot_fixed, 67108864));
  v_batch_factor  := greatest(1, coalesce(v_batch_factor, 1));

  -- Architecture geometry is nullable on custom_models (a GGUF-only repo whose
  -- header read failed leaves it NULL). Without this guard every arithmetic
  -- result below is NULL and the function returns a misleading envelope.
  if p_weights_bytes is null or p_active_weights_bytes is null or p_active_weights_bytes <= 0
     or p_n_layers is null or p_n_kv_heads is null or p_head_dim is null
     or p_context_length is null or p_context_length <= 0 then
    return jsonb_build_object(
      'feasible', false,
      'considered', '[]'::jsonb,
      'blocking_reason', 'Architecture or weight metadata is incomplete; the GGUF header / config.json probe must succeed before placement',
      'max_context_at_this_quality', 0,
      'fastest_available_tokens_per_second', 0);
  end if;

  -- HYBRID: only attention blocks hold a growing cache. Absent an explicit count,
  -- assume every block does — the conservative, pre-hybrid reading.
  v_attn_layers := least(coalesce(p_n_attention_layers, p_n_layers), p_n_layers);
  v_ssm_bytes   := greatest(0, coalesce(p_ssm_state_bytes_per_seq, 0));

  -- KV cache per token: 2 (K and V) x ATTENTION layers x kv_heads x head_dim x dtype.
  -- Confirmed against llama.cpp's own allocation on the #37 container, to the byte.
  v_kv_per_token := 2::bigint * v_attn_layers * p_n_kv_heads * p_head_dim
                    * coalesce(p_kv_dtype_bytes, 2::smallint);

  -- The slot-INDEPENDENT part of overhead: CUDA context, framework, and buffers that
  -- scale with the weights. The parts that scale with slots and with total context
  -- are in v_slot_cost, where they belong.
  v_base_overhead := greatest(2147483648::bigint, (p_weights_bytes * 0.10)::bigint);

  -- One stream = its full KV cache PLUS its constant recurrent state.
  v_kv_total   := v_kv_per_token * p_context_length;
  v_per_stream := v_kv_total + v_ssm_bytes;

  -- What each additional slot really costs. The context-scaled term appears HERE
  -- rather than as a separate total-context term because total context IS
  -- ctx x slots: folding it in keeps the fit a single division instead of a fixed
  -- point, and makes "one more slot" carry its own compute buffers.
  v_slot_cost := v_per_stream + v_slot_fixed + v_graph_per_tok * p_context_length;

  for v_tier in
    select * from public.gpu_tiers
     where is_enabled
       and (p_pin_tier_id is null or id = p_pin_tier_id)
     order by usd_per_hour_micro asc
  loop
    v_usable := (v_tier.vram_bytes * v_vram_util)::bigint;

    -- Single-stream decode is memory-bandwidth bound: read active weights per token.
    v_tok_s := (v_tier.memory_bandwidth_bytes_s * v_mfu) / p_active_weights_bytes;

    v_pool        := greatest(0, v_usable - p_weights_bytes - v_base_overhead);
    v_allocatable := floor(v_pool::numeric * (1 - v_headroom))::bigint;

    -- Slots the tier can hold, then the ceiling. Both directions matter: the divide
    -- keeps us inside the card, the cap keeps us inside a sane operating point.
    v_fit_slots  := case when v_slot_cost > 0
                    then greatest(0, floor(v_allocatable::numeric / v_slot_cost)::integer)
                    else 0 end;
    v_concurrent := least(v_fit_slots, v_slot_ceiling);

    v_overhead  := v_base_overhead
                   + v_concurrent::bigint * (v_slot_fixed + v_graph_per_tok * p_context_length);
    v_aggregate := p_weights_bytes + v_base_overhead + v_concurrent::bigint * v_slot_cost;

    -- "Does this tier fit at all" is the aggregate at ONE slot, not a bare stream:
    -- a single slot still pays the per-slot and compute-buffer costs.
    v_required := p_weights_bytes + v_base_overhead + v_slot_cost;

    v_reject := null;

    if v_required > v_usable then
      v_reject := format('needs %s GB, usable %s GB',
                         round(v_required / 1073741824.0, 1),
                         round(v_usable   / 1073741824.0, 1));
    elsif v_tok_s < p_target_tokens_per_second * v_tolerance then
      v_reject := format('%s tok/s, target %s',
                         round(v_tok_s), p_target_tokens_per_second);
    elsif v_concurrent >= 1 and v_aggregate > v_usable then
      -- UNREACHABLE BY CONSTRUCTION, and asserted anyway. v_concurrent came from
      -- dividing v_allocatable (which is strictly below v_usable - weights - base
      -- overhead) by v_slot_cost, so the aggregate cannot exceed usable unless one of
      -- those relationships is broken by a future edit. #37 shipped a solver whose
      -- emitted slot count was never checked against what the worker would allocate;
      -- the whole point of this branch is that such a placement is REJECTED here
      -- rather than handed to llama.cpp, which discovers it with a cudaMalloc failure
      -- 60 seconds into a cold start. supabase/tests/07_placement_capacity_test.sql
      -- is the standing proof this branch stays unreachable.
      v_reject := format('solver over-committed VRAM: %s slots need %s GB of %s GB usable',
                         v_concurrent,
                         round(v_aggregate / 1073741824.0, 1),
                         round(v_usable / 1073741824.0, 1));
    end if;

    if v_reject is null and v_concurrent >= 1 then
      v_any_fits := true;

      -- micro-USD per 1M tokens at assumed saturation. NOTE what is NOT here:
      -- v_concurrent. Pricing against the slot count is what made a bigger
      -- `--parallel` look cheaper (#37). Aggregate throughput is capped by
      -- batch_throughput_factor, and the slot count can only ever REDUCE it — a
      -- one-slot placement cannot batch, so it must not be priced as if it could.
      v_price_streams := least(v_concurrent::numeric, v_batch_factor);
      v_cost_floor := ceil(
        (v_tier.usd_per_hour_micro::numeric / 3600)
        * (1000000.0 / (v_tok_s * v_price_streams * v_assumed_util))
      )::bigint;

      if v_best is null then          -- tiers iterate cheapest-first: first hit wins
        v_best := jsonb_build_object(
          'gpu_tier_id',            v_tier.id,
          'gpu_label',              v_tier.label,
          'usd_per_hour_micro',     v_tier.usd_per_hour_micro,
          'predicted_tokens_per_second', round(v_tok_s)::integer,
          'max_concurrent_streams', v_concurrent,
          'max_concurrent_streams_uncapped', v_fit_slots,
          'max_slots_ceiling',      v_slot_ceiling,
          'n_layers',               p_n_layers,
          'n_attention_layers',     v_attn_layers,
          'kv_bytes_per_token',     v_kv_per_token,
          'kv_bytes_total',         v_kv_total,
          'ssm_state_bytes_per_seq', v_ssm_bytes,
          'bytes_per_stream',       v_per_stream,
          'slot_cost_bytes',        v_slot_cost,
          'weights_bytes',          p_weights_bytes,
          'overhead_bytes',         v_overhead,
          'overhead_base_bytes',    v_base_overhead,
          'aggregate_bytes',        v_aggregate,
          'usable_vram_bytes',      v_usable,
          'kv_dtype_bytes',         p_kv_dtype_bytes,
          'kv_headroom_bytes',      (v_pool * v_headroom)::bigint,
          -- Weight-cache strategy (§6.6 C1). Large variants need a network volume,
          -- which is a real fixed monthly cost that must reach the cost floor and
          -- the Deployment Plan card — the one place "$0 idle" is not literal.
          'needs_volume',           (p_weights_bytes > v_volume_threshold),
          'volume_gb',              case when p_weights_bytes > v_volume_threshold
                                      then ceil(p_weights_bytes / 1073741824.0 * 1.25)::integer
                                      else 0 end,
          'cold_start_budget_s',    least(300, greatest(90,
                                      45 + ceil(p_weights_bytes / v_download_rate)::integer)),
          'cost_floor_micro_per_mtoken', v_cost_floor);
      end if;
    end if;

    -- Track the best near-misses so infeasibility messages can be specific.
    if v_required <= v_usable then
      v_fastest := greatest(v_fastest, v_tok_s);
      -- Largest context ONE slot could hold here: an advisory maximum the creator can
      -- actually deploy at, not an optimistic number that fails on submit. Same
      -- headroom reserve as the slot calc, and the same two per-slot terms — the SSM
      -- state and the fixed slot overhead come off the top (charged once per stream
      -- regardless of context), while the compute-buffer term scales WITH context and
      -- so joins kv_bytes_per_token in the divisor.
      v_max_ctx_fit := greatest(v_max_ctx_fit, greatest(0, floor(
        (v_allocatable - v_ssm_bytes - v_slot_fixed)::numeric
        / (v_kv_per_token + v_graph_per_tok))::integer));
    end if;

    v_considered := v_considered || jsonb_build_object(
      'tier',       v_tier.id,
      'accepted',   (v_reject is null and v_concurrent >= 1),
      'reason',     coalesce(v_reject,
                      case when v_concurrent < 1 then 'no room for a single stream'
                           else 'accepted' end),
      'predicted_tokens_per_second', round(v_tok_s)::integer,
      -- The aggregate at one slot, so `required_bytes` is comparable across tiers
      -- and is never 0 (escalate() in lib/studio/server/deploy.ts filters on > 0).
      'required_bytes', v_required);
  end loop;

  if v_best is not null then
    return jsonb_build_object('feasible', true, 'considered', v_considered)
           || v_best;
  end if;

  -- ── Infeasible: name the blocking quantity and offer a concrete remedy ─────
  return jsonb_build_object(
    'feasible',   false,
    'considered', v_considered,
    'blocking_reason',
      case
        when not v_any_fits and v_max_ctx_fit = 0
          then 'Weights do not fit on any available GPU'
        when v_max_ctx_fit < p_context_length
          then format('Context of %s tokens does not fit; %s is the maximum at this quality',
                      p_context_length, v_max_ctx_fit)
        else format('Target of %s tok/s is unreachable; %s tok/s is the fastest available',
                    p_target_tokens_per_second, round(v_fastest))
      end,
    'max_context_at_this_quality', v_max_ctx_fit,
    'fastest_available_tokens_per_second', round(v_fastest)::integer);
end $$;

-- Grants are carried by CREATE OR REPLACE (same signature), so they are not
-- restated here. The audience is unchanged: authenticated + service_role.

-- ── The regression, asserted at migration time ───────────────────────────────
-- #37's own shape: the IQ2_M variant of the MVP repo (9.90 GiB per the container log)
-- at 8192 context, pinned to the 80 GiB card the incident landed on. Before this
-- migration the same call returned 91 slots and a 745472-token total context. If a
-- later edit brings that back, `db reset` fails here — before any test runs, and
-- before anything can deploy from it.
do $$
declare
  v_p       jsonb;
  v_slots   integer;
  v_ssm     bigint := public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint);
begin
  v_p := public.resolve_placement(
    10630054871, 10630054871, 65, 4, 256, 8192, 30, 2::smallint, 'a100_80', 16, v_ssm);

  if not (v_p->>'feasible')::boolean then
    raise exception '#37 regression fixture became infeasible: %', v_p->>'blocking_reason';
  end if;

  v_slots := (v_p->>'max_concurrent_streams')::integer;
  if v_slots < 1 or v_slots > 8 then
    raise exception '#37: solver emitted % slots for the incident shape (ceiling 8)', v_slots;
  end if;

  if (v_p->>'aggregate_bytes')::bigint > (v_p->>'usable_vram_bytes')::bigint then
    raise exception '#37: aggregate % exceeds usable %',
      v_p->>'aggregate_bytes', v_p->>'usable_vram_bytes';
  end if;

  -- The envelope must be self-checkable without knowing any of the constants above,
  -- because that identity is what lib/studio/server/deploy.ts verifies before it
  -- hands a slot count to a worker. Exact equality, not an inequality: `<=` would
  -- still pass if overhead_bytes silently reverted to a flat figure.
  if (v_p->>'weights_bytes')::bigint
     + (v_p->>'overhead_bytes')::bigint
     + v_slots::bigint * (v_p->>'bytes_per_stream')::bigint
     <> (v_p->>'aggregate_bytes')::bigint then
    raise exception '#37: envelope does not add up: weights + overhead + slots x per_stream <> aggregate';
  end if;
end $$;
