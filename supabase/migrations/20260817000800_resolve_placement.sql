-- ============================================================================
-- 20260817000800_resolve_placement.sql   (PRD §5.4a)
--
-- Pure function over probed facts. Given a variant's weights, the model's
-- attention geometry, and the creator's intent, return the cheapest GPU tier
-- that satisfies both constraints — plus the full rationale.
--
-- Returns a jsonb envelope in both the feasible and infeasible cases; the
-- infeasible case carries the specific blocking quantity so the UI can render
-- an actionable message rather than "unsupported configuration" (§4.3.3.5).
--
-- FR-DB-007: this is the ONLY placement implementation. A TypeScript
-- reimplementation is prohibited.
-- ============================================================================
create or replace function public.resolve_placement(
  p_weights_bytes         bigint,
  p_active_weights_bytes  bigint,   -- = weights for dense; active experts for MoE
  p_n_layers              integer,
  p_n_kv_heads            integer,  -- GQA count, NOT n_attention_heads
  p_head_dim              integer,
  p_context_length        integer,
  p_target_tokens_per_second integer,
  p_kv_dtype_bytes        smallint default 2,   -- 2 = fp16, 1 = q8_0 (FR-DEP-054)
  p_pin_tier_id           text default null     -- FR-DEP-056 expert override
)
returns jsonb
language plpgsql stable parallel safe
set search_path = public, pg_temp
as $$
declare
  v_mfu            numeric;
  v_vram_util      numeric;
  v_assumed_util   numeric;
  v_tolerance      numeric;
  v_prefix_reserve   numeric;
  v_volume_threshold numeric;
  v_download_rate    numeric;

  v_kv_per_token  bigint;
  v_overhead      bigint;
  v_tier          record;
  v_usable        bigint;
  v_kv_total      bigint;
  v_required      bigint;
  v_tok_s         numeric;
  v_concurrent    integer;
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
         max(case when key = 'prefix_cache_reserve'   then value end),
         max(case when key = 'volume_threshold_bytes' then value end),
         max(case when key = 'download_bytes_per_s'   then value end)
    into v_mfu, v_vram_util, v_assumed_util, v_tolerance, v_prefix_reserve,
         v_volume_threshold, v_download_rate
    from public.solver_config;

  -- ADDED (not in PRD §5.4a): architecture geometry is nullable on custom_models
  -- (a GGUF-only repo whose header read failed leaves it NULL). Without this guard
  -- every arithmetic result below is NULL and the function returns a misleading
  -- "target unreachable" envelope instead of naming the real blocker.
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

  -- KV cache per token: 2 (K and V) x layers x kv_heads x head_dim x dtype.
  v_kv_per_token := 2::bigint * p_n_layers * p_n_kv_heads * p_head_dim * coalesce(p_kv_dtype_bytes, 2::smallint);

  -- Framework, CUDA graphs, temp buffers.
  v_overhead := greatest(2147483648::bigint, (p_weights_bytes * 0.10)::bigint);

  for v_tier in
    select * from public.gpu_tiers
     where is_enabled
       and (p_pin_tier_id is null or id = p_pin_tier_id)
     order by usd_per_hour_micro asc
  loop
    v_usable   := (v_tier.vram_bytes * v_vram_util)::bigint;
    v_kv_total := v_kv_per_token * p_context_length;      -- one stream
    v_required := p_weights_bytes + v_kv_total + v_overhead;

    -- Single-stream decode is memory-bandwidth bound: read active weights per token.
    v_tok_s := (v_tier.memory_bandwidth_bytes_s * v_mfu) / p_active_weights_bytes;

    v_reject := null;

    if v_required > v_usable then
      v_reject := format('needs %s GB, usable %s GB',
                         round(v_required / 1073741824.0, 1),
                         round(v_usable   / 1073741824.0, 1));
    elsif v_tok_s < p_target_tokens_per_second * v_tolerance then
      v_reject := format('%s tok/s, target %s',
                         round(v_tok_s), p_target_tokens_per_second);
    end if;

    -- How many streams fit after weights + overhead, MINUS the prefix-cache pool.
    -- Reserving this pool is what makes automatic prefix caching actually retain
    -- anything under load (NFR-CACHE-021).
    v_concurrent := greatest(0, floor(
      ((v_usable - p_weights_bytes - v_overhead)::numeric * (1 - v_prefix_reserve))
      / v_kv_total)::integer);

    if v_reject is null and v_concurrent >= 1 then
      v_any_fits := true;

      -- micro-USD per 1M tokens at assumed saturation.
      v_cost_floor := ceil(
        (v_tier.usd_per_hour_micro::numeric / 3600)
        * (1000000.0 / (v_tok_s * v_concurrent * v_assumed_util))
      )::bigint;

      if v_best is null then          -- tiers iterate cheapest-first: first hit wins
        v_best := jsonb_build_object(
          'gpu_tier_id',            v_tier.id,
          'gpu_label',              v_tier.label,
          'usd_per_hour_micro',     v_tier.usd_per_hour_micro,
          'predicted_tokens_per_second', round(v_tok_s)::integer,
          'max_concurrent_streams', v_concurrent,
          'kv_bytes_per_token',     v_kv_per_token,
          'kv_bytes_total',         v_kv_total,
          'weights_bytes',          p_weights_bytes,
          'overhead_bytes',         v_overhead,
          'usable_vram_bytes',      v_usable,
          'kv_dtype_bytes',         p_kv_dtype_bytes,
          'prefix_cache_bytes',     ((v_usable - p_weights_bytes - v_overhead)
                                     * v_prefix_reserve)::bigint,
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
      -- Same prefix reserve as the concurrency calc: an advisory maximum the creator
      -- can actually deploy at, not an optimistic number that fails on submit.
      v_max_ctx_fit := greatest(v_max_ctx_fit, greatest(0, floor(
        ((v_usable - p_weights_bytes - v_overhead)::numeric * (1 - v_prefix_reserve))
        / v_kv_per_token)::integer));
    end if;

    v_considered := v_considered || jsonb_build_object(
      'tier',       v_tier.id,
      'accepted',   (v_reject is null and v_concurrent >= 1),
      'reason',     coalesce(v_reject,
                      case when v_concurrent < 1 then 'no room for a single stream'
                           else 'accepted' end),
      'predicted_tokens_per_second', round(v_tok_s)::integer,
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

revoke all on function public.resolve_placement(
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text) from public, anon;
grant execute on function public.resolve_placement(
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text)
  to authenticated, service_role;
-- Readable by authenticated users: the Studio calls it directly for live preview.
-- It is a pure function over public capability data and creator-supplied numbers,
-- so it discloses nothing sensitive.
