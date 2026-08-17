-- ============================================================================
-- 20260817001700_hybrid_attention.sql
--
-- NOT IN THE PRD. The MVP-0 target (JonathanColetti/Qwen3.8-27B-Uncensored-GGUF,
-- arch `qwen35`) is a HYBRID attention/SSM model, and PRD §5.4a's KV term assumes
-- every block holds a growing KV cache. Its GGUF header reports:
--
--   block_count 65   head_count_kv 4   key_length 256   full_attention_interval 4
--   nextn_predict_layers 1             context_length 262144
--   ssm: state_size 128  inner_size 6144  group_count 16  conv_kernel 4
--
-- Only every 4th block is full attention, so 16 of 65 blocks grow with context.
-- Multiplying the KV term across all 65 over-estimates cache demand ~4x and makes
-- the solver reject placements that comfortably fit.
--
-- The two memory terms behave completely differently and must not be conflated:
--
--   * KV cache      — per token, per attention layer. Grows linearly with context.
--   * SSM state     — per SEQUENCE, CONSTANT. A recurrent state is a fixed-size
--                     tensor; it is identical at 4k and at 262k context. It
--                     therefore belongs in the per-stream overhead term, never in
--                     the per-token term. Multiplying it by context_length is the
--                     mirror-image error of the one this migration fixes.
-- ============================================================================

alter table public.custom_models
  -- Blocks that hold a growing KV cache. NULL = every block does (pure attention,
  -- the pre-hybrid assumption), which is what the solver falls back to.
  add column n_attention_layers      integer check (n_attention_layers > 0),
  -- GGUF `*.attention.full_attention_interval`. NULL/1 = every block is full
  -- attention. Kept alongside n_attention_layers so the derivation is auditable.
  add column full_attention_interval integer check (full_attention_interval > 0),
  -- GGUF `*.ssm.*`. All NULL for a non-hybrid model.
  add column ssm_state_size          integer check (ssm_state_size > 0),
  add column ssm_inner_size          integer check (ssm_inner_size > 0),
  add column ssm_group_count         integer check (ssm_group_count > 0),
  add column ssm_conv_kernel         integer check (ssm_conv_kernel > 0),
  -- Materialized output of calc_ssm_state_bytes(), so the gateway and the Studio
  -- read one number instead of re-deriving the formula.
  add column ssm_state_bytes_per_seq bigint not null default 0
                                     check (ssm_state_bytes_per_seq >= 0),
  add constraint custom_models_attn_layers_within_blocks
    check (n_attention_layers is null or n_layers is null or n_attention_layers <= n_layers);

comment on column public.custom_models.n_attention_layers is
  'Blocks holding a growing KV cache — NOT block_count on a hybrid model. '
  'Typically floor(n_layers / full_attention_interval).';
comment on column public.custom_models.ssm_state_bytes_per_seq is
  'Recurrent state, per sequence, CONSTANT in context length. Belongs to the '
  'per-stream overhead term of the solver, never to the per-token term.';

-- ── SSM state size, in one auditable place ──────────────────────────────────
-- conv state: conv_kernel x (inner_size + 2 x group_count x state_size)
-- ssm  state: inner_size x state_size
-- both per SSM block, times the number of non-attention blocks.
create or replace function public.calc_ssm_state_bytes(
  p_n_ssm_layers   integer,
  p_state_size     integer,
  p_inner_size     integer,
  p_group_count    integer,
  p_conv_kernel    integer,
  p_dtype_bytes    smallint default 2
) returns bigint
language sql immutable parallel safe as $$
  select case
    when p_n_ssm_layers is null or p_state_size is null or p_inner_size is null
      or p_group_count is null or p_conv_kernel is null or p_n_ssm_layers <= 0
    then 0::bigint
    else p_n_ssm_layers::bigint * coalesce(p_dtype_bytes, 2::smallint) * (
           p_conv_kernel::bigint * (p_inner_size::bigint
                                    + 2 * p_group_count::bigint * p_state_size::bigint)
           + p_inner_size::bigint * p_state_size::bigint)
  end;
$$;

-- ============================================================================
-- resolve_placement v2.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the argument list changes, and
-- leaving the 9-argument version in place would create an overload that resolves
-- ambiguously. The two new arguments are defaulted, so every existing 9-argument
-- call site keeps working and keeps its old (pure-attention) semantics.
-- ============================================================================
drop function if exists public.resolve_placement(
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text);

create function public.resolve_placement(
  p_weights_bytes         bigint,
  p_active_weights_bytes  bigint,   -- = weights for dense; active experts for MoE
  p_n_layers              integer,  -- total blocks
  p_n_kv_heads            integer,  -- GQA count, NOT n_attention_heads
  p_head_dim              integer,
  p_context_length        integer,
  p_target_tokens_per_second integer,
  p_kv_dtype_bytes        smallint default 2,   -- 2 = fp16, 1 = q8_0 (FR-DEP-054)
  p_pin_tier_id           text default null,    -- FR-DEP-056 expert override
  -- NEW: blocks that actually hold a KV cache. NULL = all of them.
  p_n_attention_layers    integer default null,
  -- NEW: per-sequence recurrent state; constant in context length.
  p_ssm_state_bytes_per_seq bigint default 0
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

  v_attn_layers   integer;
  v_ssm_bytes     bigint;
  v_kv_per_token  bigint;
  v_per_stream    bigint;   -- kv for one full context + the constant SSM state
  v_overhead      bigint;
  v_tier          record;
  v_usable        bigint;
  v_kv_total      bigint;
  v_required      bigint;
  v_tok_s         numeric;
  v_pool          bigint;   -- bytes left for streams after weights + overhead
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
  v_kv_per_token := 2::bigint * v_attn_layers * p_n_kv_heads * p_head_dim
                    * coalesce(p_kv_dtype_bytes, 2::smallint);

  -- Framework, CUDA graphs, temp buffers.
  v_overhead := greatest(2147483648::bigint, (p_weights_bytes * 0.10)::bigint);

  -- One stream = its full KV cache PLUS its constant recurrent state.
  v_kv_total   := v_kv_per_token * p_context_length;
  v_per_stream := v_kv_total + v_ssm_bytes;

  for v_tier in
    select * from public.gpu_tiers
     where is_enabled
       and (p_pin_tier_id is null or id = p_pin_tier_id)
     order by usd_per_hour_micro asc
  loop
    v_usable   := (v_tier.vram_bytes * v_vram_util)::bigint;
    v_required := p_weights_bytes + v_per_stream + v_overhead;

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
    v_pool := greatest(0, v_usable - p_weights_bytes - v_overhead);
    v_concurrent := greatest(0, floor(
      (v_pool::numeric * (1 - v_prefix_reserve)) / v_per_stream)::integer);

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
          'n_layers',               p_n_layers,
          'n_attention_layers',     v_attn_layers,
          'kv_bytes_per_token',     v_kv_per_token,
          'kv_bytes_total',         v_kv_total,
          'ssm_state_bytes_per_seq', v_ssm_bytes,
          'bytes_per_stream',       v_per_stream,
          'weights_bytes',          p_weights_bytes,
          'overhead_bytes',         v_overhead,
          'usable_vram_bytes',      v_usable,
          'kv_dtype_bytes',         p_kv_dtype_bytes,
          'prefix_cache_bytes',     (v_pool * v_prefix_reserve)::bigint,
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
      -- The SSM state comes off the top: it is charged once per stream regardless
      -- of how much context that stream ends up using.
      v_max_ctx_fit := greatest(v_max_ctx_fit, greatest(0, floor(
        ((v_pool::numeric * (1 - v_prefix_reserve)) - v_ssm_bytes)
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
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text,integer,bigint)
  from public, anon;
grant execute on function public.resolve_placement(
  bigint,bigint,integer,integer,integer,integer,integer,smallint,text,integer,bigint)
  to authenticated, service_role;
