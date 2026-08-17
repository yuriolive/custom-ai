-- ============================================================================
-- 20260817000700_custom_models.sql   (PRD §5.4)
-- ============================================================================
create table public.custom_models (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,

  -- ── Identity: (user_id, slug) is the addressable `creator/model-slug` ──────
  slug                text not null check (slug ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name        text not null check (char_length(display_name) between 1 and 100),
  description         text check (char_length(description) <= 2000),

  -- ── Source ────────────────────────────────────────────────────────────────
  hf_repo_slug        text not null check (hf_repo_slug ~ '^[\w.-]+/[\w.-]+$'),
  hf_revision         text not null default 'main',
  served_model_name   text not null,          -- identifier the worker actually serves
  weights_format      public.weights_format not null default 'unknown',

  -- ── Inference runtime, DERIVED from format (FR-DEP-060). Never creator-chosen. ──
  runtime             public.model_runtime not null,

  -- ── Selected VARIANT (FR-DEP-040): a repo yields many, a deployment is one ─
  variant_quant_tag   text,                   -- 'Q4_K_M', 'IQ4_XS', 'AWQ', NULL = native
  -- Family discriminator (FR-DEP-041b): 'noMTP', 'i1', … NULL = the base family.
  -- Two variants sharing a quant tag but differing here are DIFFERENT MODELS.
  variant_family      text,
  -- The specific file llama.cpp must load. vLLM resolves a repo; llama.cpp resolves a
  -- file, and passing only the repo is ambiguous in any multi-quant repo (FR-DEP-061).
  variant_files       text[] not null default '{}',   -- split GGUF: all shards (FR-DEP-042)
  -- Discovered but NOT served in MVP (FR-DEP-046, FR-DEP-063):
  --   {"draft": "…-draft-Q8_0.gguf", "mmproj": "…-vision-f16.gguf"}
  companion_assets    jsonb not null default '{}'::jsonb,
  weights_bytes       bigint not null check (weights_bytes > 0),
  -- MoE: bytes actually READ per decoded token. Drives throughput, not VRAM (FR-DEP-044).
  active_weights_bytes bigint not null check (active_weights_bytes > 0),

  -- ── Architecture, probed from config.json / GGUF header (FR-DEP-043) ──────
  -- Required by the KV-cache term of the capacity solver. n_kv_heads is the GQA
  -- head count, NOT n_attention_heads — confusing them over-estimates KV by up to 8x.
  n_layers            integer check (n_layers > 0),
  n_kv_heads          integer check (n_kv_heads > 0),
  head_dim            integer check (head_dim > 0),
  kv_dtype_bytes      smallint not null default 2 check (kv_dtype_bytes in (1, 2)),
  max_position_embeddings integer,

  -- ── CREATOR INTENT (the only capacity inputs a human supplies) ────────────
  context_length          integer not null default 4096 check (context_length > 0),
  context_verified        boolean not null default false,
  target_tokens_per_second integer not null default 30
                            check (target_tokens_per_second > 0),

  -- ── Private-repo credential: Vault secret UUID ONLY (FR-DEP-010) ──────────
  hf_token_secret_id  uuid,                   -- vault.secrets(id); NULL for public repos
  requires_hf_auth    boolean not null default false,

  -- ── RESOLVED PLACEMENT — solver output, never a creator input ─────────────
  -- Nullable until the solver runs: the creator inserts intent, the Edge Function
  -- writes placement. A 'ready' model must have both (see check constraint below).
  gpu_tier_id         text references public.gpu_tiers(id),
  gpu_usd_per_hour_micro_snapshot bigint,            -- FR-DEP-051: stable cost math
  predicted_tokens_per_second integer,               -- solver estimate (internal)
  measured_tokens_per_second  integer,               -- smoke-test truth (FR-DEP-052);
                                                     -- this is what the catalog displays
  max_concurrent_streams integer check (max_concurrent_streams > 0),
  kv_bytes_per_token  bigint,
  cost_floor_micro_per_mtoken bigint,
  -- Full solver input+output snapshot: which tiers were considered, why each was
  -- rejected, the VRAM breakdown, the constants in force. Makes every placement
  -- auditable and every "why this GPU?" answer reconstructible after the fact.
  placement_rationale jsonb,
  hardware_pinned     boolean not null default false,  -- FR-DEP-056 expert override

  -- ── Weight-cache strategy & the per-model cold-start budget (§6.6 C1) ─────
  -- A single global cold-start timeout either kills healthy large models or masks
  -- dead small ones, so the budget scales with variant size.
  cold_start_budget_s integer not null default 90
                        check (cold_start_budget_s between 90 and 300),
  runpod_volume_id    text,                   -- NULL = node-cached weights only
  volume_gb           integer not null default 0 check (volume_gb >= 0),
  volume_monthly_micro_usd bigint not null default 0,  -- the real, non-zero idle cost
  prefix_caching_enabled boolean not null default true,
  cached_discount_bps integer not null default 0
                        check (cached_discount_bps between 0 and 10000),  -- FR-BIL-043

  -- ── Pricing: micro-USD per 1,000,000 tokens (FR-BIL-002) ──────────────────
  price_prompt_micro_usd_per_mtoken     bigint not null
    check (price_prompt_micro_usd_per_mtoken     between 0 and 1000000000),
  price_completion_micro_usd_per_mtoken bigint not null
    check (price_completion_micro_usd_per_mtoken between 0 and 1000000000),
  platform_fee_bps    integer not null default 2000
                        check (platform_fee_bps between 0 and 10000),
  pricing_version     integer not null default 1,

  -- ── Distribution ──────────────────────────────────────────────────────────
  visibility          public.model_visibility not null default 'private',
  status              public.model_status     not null default 'draft',

  -- ── RunPod resources ──────────────────────────────────────────────────────
  runpod_template_id  text,
  runpod_endpoint_id  text unique,
  runpod_workers_max  integer not null default 3 check (runpod_workers_max between 1 and 10),
  runpod_idle_timeout integer not null default 30 check (runpod_idle_timeout = 30),
  runpod_workers_min  integer not null default 0 check (runpod_workers_min = 0),  -- FR-DEP-031

  -- ── Diagnostics ───────────────────────────────────────────────────────────
  provisioning_error  jsonb,
  remediation_hint    text,
  last_error_at       timestamptz,

  -- ── Denormalized counters (trigger-maintained; catalog sort/display) ───────
  total_requests      bigint not null default 0,
  total_prompt_tokens bigint not null default 0,
  total_completion_tokens bigint not null default 0,
  p50_ttft_ms         integer,
  p95_ttft_ms         integer,

  -- ── Full-text search ──────────────────────────────────────────────────────
  search_vector       tsvector generated always as (
                        setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(slug, '')),         'A') ||
                        setweight(to_tsvector('english', coalesce(hf_repo_slug, '')), 'B') ||
                        setweight(to_tsvector('english', coalesce(description, '')),  'C')
                      ) stored,

  ready_at            timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint custom_models_user_slug_uniq unique (user_id, slug),
  -- Runtime must match format (FR-DEP-060). Enforced in the schema because a mismatch
  -- provisions a worker that cannot start, and fails 100+ seconds into a cold start.
  constraint custom_models_runtime_matches_format check (
    (weights_format = 'gguf' and runtime = 'llamacpp') or
    (weights_format in ('safetensors','awq','gptq') and runtime = 'vllm') or
    weights_format = 'unknown'),
  -- llama.cpp loads a FILE, not a repo. A GGUF deployment without one is unprovisionable.
  constraint custom_models_gguf_needs_file
    check (runtime <> 'llamacpp' or array_length(variant_files, 1) >= 1),
  -- A ready model must have a real endpoint behind it.
  constraint custom_models_ready_needs_endpoint
    check (status <> 'ready' or runpod_endpoint_id is not null),
  -- A ready model must have been placed by the solver and speed-verified.
  constraint custom_models_ready_needs_placement
    check (status <> 'ready' or (gpu_tier_id is not null
                                 and gpu_usd_per_hour_micro_snapshot is not null
                                 and max_concurrent_streams is not null
                                 and measured_tokens_per_second is not null)),
  -- Context can never exceed what the architecture supports.
  constraint custom_models_context_within_arch
    check (max_position_embeddings is null or context_length <= max_position_embeddings),
  -- A private/gated repo must carry a credential reference.
  constraint custom_models_auth_needs_secret
    check (requires_hf_auth = false or hf_token_secret_id is not null)
);

comment on column public.custom_models.hf_token_secret_id is
  'UUID of a supabase_vault secret. The plaintext HF token is reachable ONLY from '
  'service_role inside an Edge Function. No RLS policy, view, or RPC exposes it.';

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Gateway hot path: resolve creator/slug in one indexed lookup.
create index custom_models_resolve_idx
  on public.custom_models (user_id, slug)
  where deleted_at is null and status = 'ready';

-- Catalog listing.
create index custom_models_catalog_idx
  on public.custom_models (created_at desc)
  where visibility = 'public' and status = 'ready' and deleted_at is null;

create index custom_models_search_idx on public.custom_models using gin (search_vector);
create index custom_models_trgm_idx   on public.custom_models using gin (display_name extensions.gin_trgm_ops);
create index custom_models_owner_idx  on public.custom_models (user_id, created_at desc)
  where deleted_at is null;
-- Capability filters for the marketplace rail (FR-MKT-004). Indexed on what
-- developers actually filter by — speed and context — not on hardware.
create index custom_models_capability_idx
  on public.custom_models (measured_tokens_per_second desc, context_length desc)
  where visibility = 'public' and status = 'ready' and deleted_at is null;
create index custom_models_endpoint_idx on public.custom_models (runpod_endpoint_id)
  where runpod_endpoint_id is not null;

create trigger custom_models_updated_at
  before update on public.custom_models
  for each row execute function public.tg_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.custom_models enable row level security;

-- Public catalog: anonymous read of ready, public, non-deleted models only.
create policy custom_models_select_public on public.custom_models
  for select to anon, authenticated
  using (visibility = 'public' and status = 'ready' and deleted_at is null);

-- Owner sees everything of their own, in any status.
create policy custom_models_select_own on public.custom_models
  for select to authenticated using (user_id = auth.uid());

-- Owner creates in a non-live status only. Provisioning/readiness is service_role's job,
-- and pricing/visibility cannot be smuggled past validation. Creator INSERT may also not
-- write solver output — placement is service_role's job (PRD §5.4 final form).
create policy custom_models_insert_own on public.custom_models
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status in ('draft', 'validating')
    and runpod_endpoint_id is null
    and runpod_template_id is null
    and runpod_workers_min = 0
    and runpod_idle_timeout = 30
    -- Solver output columns must be empty on creator insert.
    and gpu_tier_id is null
    and measured_tokens_per_second is null
    and max_concurrent_streams is null
    and placement_rationale is null
  );

-- Owner edits metadata, pricing, and visibility. Owner may NOT change identity,
-- source, hardware, RunPod ids, credential reference, or counters.
-- DIVERGENCE FROM PRD §5.4 (reported): the PRD compares the nullable columns
-- gpu_tier_id / runpod_endpoint_id / hf_token_secret_id with `=`, which evaluates
-- to NULL — i.e. WITH CHECK failure — for every draft model, where all three are
-- NULL. That would make the owner-update policy reject every legitimate pre-
-- provisioning edit. `is not distinct from` is used for all nullable columns.
create policy custom_models_update_own on public.custom_models
  for update to authenticated
  using (user_id = auth.uid() and deleted_at is null)
  with check (
    user_id = auth.uid()
    and slug               = (select m.slug               from public.custom_models m where m.id = custom_models.id)
    and hf_repo_slug       = (select m.hf_repo_slug       from public.custom_models m where m.id = custom_models.id)
    and gpu_tier_id        is not distinct from
                             (select m.gpu_tier_id        from public.custom_models m where m.id = custom_models.id)
    and runpod_endpoint_id is not distinct from
                             (select m.runpod_endpoint_id from public.custom_models m where m.id = custom_models.id)
    and hf_token_secret_id is not distinct from
                             (select m.hf_token_secret_id from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
  );

-- No client DELETE: deletion must tear down RunPod resources and the Vault secret
-- first, so it is an Edge Function workflow ending in a soft delete.
