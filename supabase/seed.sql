-- ============================================================================
-- supabase/seed.sql — local development fixture for MVP-0.
--
-- Applied by `supabase db reset` after every migration. Everything here is
-- disposable dev data; nothing in it is a secret worth protecting.
--
-- PLACEHOLDERS: every value marked `PLACEHOLDER` must be replaced after the
-- RunPod provisioning spike and the GGUF-header probe land. They are marked
-- inline, not collected at the bottom, so they cannot be shipped by accident.
-- ============================================================================

-- ── 1. Auth user ────────────────────────────────────────────────────────────
-- public.profiles.id references auth.users(id), and the on_auth_user_created
-- trigger derives the handle from raw_user_meta_data->>'user_name'. Inserting
-- the auth user is therefore what creates the profile row.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000a1',
  'authenticated', 'authenticated', 'jonathancoletti@example.test',
  extensions.crypt('devpassword', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"user_name":"jonathancoletti","full_name":"Jonathan Coletti"}'::jsonb,
  now(), now(),
  '', '', '', ''
) on conflict (id) do nothing;

-- ── 2. Wallet: $10.00 = 10,000,000 micro-USD ────────────────────────────────
-- Credited through credit_wallet() rather than by UPDATE so the wallet_ledger
-- row exists and public.v_balance_drift stays empty (invariant I4).
select public.credit_wallet(
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  10000000::bigint,           -- $10.00
  'grant'::public.ledger_kind,
  null, null,
  'local dev seed grant'
);

-- ── 3. API key ──────────────────────────────────────────────────────────────
-- PLAINTEXT KEY (dev only, never valid anywhere but a local reset):
--   sk-plat-mvp0seedkey0000000000000000000000
-- sha256(plaintext), lowercase hex:
--   b17d62828e69077b7bc277ae9de745fc5474ad94a702e15f22888c0bbd060e49
-- Reproduce with:
--   node -e "console.log(require('crypto').createHash('sha256')
--     .update('sk-plat-mvp0seedkey0000000000000000000000').digest('hex'))"
-- Use as: OpenAI(base_url="http://127.0.0.1:54321/functions/v1/gateway/v1",
--                api_key="sk-plat-mvp0seedkey0000000000000000000000")
insert into public.api_keys (id, user_id, name, key_hash, key_prefix)
values (
  '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-0000000000a1',
  'local dev key',
  'b17d62828e69077b7bc277ae9de745fc5474ad94a702e15f22888c0bbd060e49',
  'sk-plat-mvp0seed'
) on conflict (id) do nothing;

-- ── 4. The MVP-0 target model ───────────────────────────────────────────────
-- Sizes and filenames are the real probed values from
-- tests/fixtures/hf-qwen38-27b-uncensored-gguf.json (Q4_K_M, base family).
insert into public.custom_models (
  id, user_id, slug, display_name, description,
  hf_repo_slug, hf_revision, served_model_name,
  weights_format, runtime,
  variant_quant_tag, variant_family, variant_files, companion_assets,
  weights_bytes, active_weights_bytes,
  n_layers, n_kv_heads, head_dim, kv_dtype_bytes, max_position_embeddings,
  context_length, context_verified, target_tokens_per_second,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  platform_fee_bps,
  visibility, status
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000a1',
  'qwen3-8-27b-uncensored-gguf',
  'Qwen3.8 27B Uncensored (GGUF)',
  'MVP-0 acceptance target. Q4_K_M, base family (NOT the noMTP family).',
  'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',
  'main',
  -- PLACEHOLDER: the exact --alias / model id the llama.cpp worker image serves.
  -- Confirm against the pinned LLAMACPP_WORKER_IMAGE during the provisioning spike.
  'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',
  'gguf', 'llamacpp',
  'Q4_K_M',
  null,                                                    -- base family
  array['Qwen3.8-27B-Uncensored-Q4_K_M.gguf'],             -- single shard, not split
  -- Discovered but NOT served in MVP (FR-DEP-046 / FR-DEP-063).
  '{"draft":"Qwen3.8-27B-Uncensored-draft-Q8_0.gguf",
    "mmproj":"Qwen3.8-27B-Uncensored-vision-f16.gguf"}'::jsonb,
  16810714528,
  -- PLACEHOLDER: assumes a dense model, so active == total. If the GGUF header
  -- reports an MoE expert layout this is wrong and every throughput number
  -- derived from it is wrong with it (FR-DEP-044).
  16810714528,
  -- PLACEHOLDER (all four): config.json is ABSENT from this repo, so the
  -- attention geometry must come from the GGUF key-value header (FR-DEP-043
  -- path 2). These are plausible Qwen-class values used only so the solver can
  -- be exercised locally. n_kv_heads is the GQA count, NOT n_attention_heads.
  64, 8, 128, 2, null,
  4096, false, 30,
  -- PLACEHOLDER: pricing is not calibrated against the resolved cost floor yet.
  500000,       -- $0.50 per 1M prompt tokens
  1500000,      -- $1.50 per 1M completion tokens
  2000,         -- 20% platform fee -> the 80/20 split in the acceptance test
  'public', 'draft'
) on conflict (id) do nothing;

-- ── 4a. Run the real solver over that row and store its output ──────────────
-- Placement is never hand-written: FR-DB-008 requires the deploy path to call
-- resolve_placement() server-side. Doing the same here keeps the seed row
-- internally consistent and smoke-tests the solver on every `db reset`.
with r as (
  select public.resolve_placement(
           m.weights_bytes, m.active_weights_bytes,
           m.n_layers, m.n_kv_heads, m.head_dim,
           m.context_length, m.target_tokens_per_second,
           m.kv_dtype_bytes, null
         ) as p
    from public.custom_models m
   where m.id = '00000000-0000-0000-0000-0000000000c1'
)
update public.custom_models m
   set gpu_tier_id                     = r.p->>'gpu_tier_id',
       gpu_usd_per_hour_micro_snapshot = (r.p->>'usd_per_hour_micro')::bigint,
       predicted_tokens_per_second     = (r.p->>'predicted_tokens_per_second')::integer,
       max_concurrent_streams          = (r.p->>'max_concurrent_streams')::integer,
       kv_bytes_per_token              = (r.p->>'kv_bytes_per_token')::bigint,
       cost_floor_micro_per_mtoken     = (r.p->>'cost_floor_micro_per_mtoken')::bigint,
       cold_start_budget_s             = (r.p->>'cold_start_budget_s')::integer,
       volume_gb                       = coalesce((r.p->>'volume_gb')::integer, 0),
       placement_rationale             = r.p
  from r
 where m.id = '00000000-0000-0000-0000-0000000000c1'
   and (r.p->>'feasible')::boolean;

-- ── 4b. Mark it live ────────────────────────────────────────────────────────
-- PLACEHOLDER: runpod_endpoint_id and measured_tokens_per_second are outputs of
-- the provisioning + smoke-test spike. The endpoint id below routes nowhere;
-- point UPSTREAM_BASE_URL at tools/mock-upstream until the real one exists.
update public.custom_models
   set runpod_endpoint_id         = 'PLACEHOLDER-runpod-endpoint-id',
       runpod_template_id         = 'PLACEHOLDER-runpod-template-id',
       measured_tokens_per_second = predicted_tokens_per_second,  -- PLACEHOLDER: smoke-test truth
       status                     = 'ready',
       ready_at                   = now()
 where id = '00000000-0000-0000-0000-0000000000c1'
   and gpu_tier_id is not null;

-- ── 5. OPTIONAL second profile — uncomment for a true 80/20 settlement ──────
-- CONTRACTS.md requires the acceptance test to settle "a correct 80/20 split",
-- but FR-BIL-021 (implemented in deduct_token_cost) zeroes the creator share
-- when the payer IS the creator. With only the profile above, the single seeded
-- key calls its owner's own model and settles 100% to the platform, 0 to the
-- creator. Uncomment to seed a separate paying developer whose settlements do
-- split 80/20.
--
-- insert into auth.users (
--   instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
--   raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
--   confirmation_token, recovery_token, email_change_token_new, email_change
-- ) values (
--   '00000000-0000-0000-0000-000000000000',
--   '00000000-0000-0000-0000-0000000000a2',
--   'authenticated', 'authenticated', 'devcaller@example.test',
--   crypt('devpassword', gen_salt('bf')), now(),
--   '{"provider":"email","providers":["email"]}'::jsonb,
--   '{"user_name":"devcaller","full_name":"Dev Caller"}'::jsonb,
--   now(), now(), '', '', '', ''
-- ) on conflict (id) do nothing;
--
-- select public.credit_wallet('00000000-0000-0000-0000-0000000000a2'::uuid,
--   10000000::bigint, 'grant'::public.ledger_kind, null, null, 'dev caller grant');
--
-- -- plaintext: sk-plat-mvp0callerkey000000000000000000
-- -- sha256:    5b6b0e2b6d9a2a1e9a1a1cbb1f3f5cf0b0b0f1d1d0a6f2c2b5e3a7d4c9e8f0a1  <- PLACEHOLDER, recompute
-- -- insert into public.api_keys (user_id, name, key_hash, key_prefix) values (...);
