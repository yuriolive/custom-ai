-- ============================================================================
-- supabase/seed.sql — local development fixture for MVP-0.
--
-- Applied by `supabase db reset` after every migration. Everything here is
-- disposable dev data; nothing in it is a secret worth protecting.
--
-- TWO profiles, deliberately:
--   jonathancoletti  the CREATOR. Owns the model. Wallet is empty.
--   devcaller        the PAYING DEVELOPER. Holds the $10 wallet and the API key.
--
-- They must be distinct. FR-BIL-021 (implemented in deduct_token_cost) zeroes the
-- creator's share when the payer IS the creator, so a single self-dealing profile
-- settles 100/0 and the MVP-0 acceptance criterion — "exactly one
-- usage_transactions row settles with a correct 80/20 split" — is unreachable.
--
-- PLACEHOLDERS: every value marked `PLACEHOLDER` must be replaced after the
-- RunPod provisioning spike lands. They are marked inline, not collected at the
-- bottom, so they cannot be shipped by accident.
-- ============================================================================

-- ── 1. Auth users ───────────────────────────────────────────────────────────
-- public.profiles.id references auth.users(id), and the on_auth_user_created
-- trigger derives the handle from raw_user_meta_data->>'user_name'. Inserting
-- the auth user is therefore what creates the profile row.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-0000000000a1',
   'authenticated', 'authenticated', 'jonathancoletti@example.test',
   extensions.crypt('devpassword', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"user_name":"jonathancoletti","full_name":"Jonathan Coletti"}'::jsonb,
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-0000000000a2',
   'authenticated', 'authenticated', 'devcaller@example.test',
   extensions.crypt('devpassword', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"user_name":"devcaller","full_name":"Dev Caller"}'::jsonb,
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

-- ── 2. Wallet: $10.00 = 10,000,000 micro-USD, on the CALLER ────────────────
-- Credited through credit_wallet() rather than by UPDATE so the wallet_ledger
-- row exists and public.v_balance_drift stays empty (invariant I4).
-- The creator's wallet stays at 0: creator royalties accrue to
-- profiles.earnings_micro_usd, which is a separate account (FR-BIL-024).
select public.credit_wallet(
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  10000000::bigint,           -- $10.00
  'grant'::public.ledger_kind,
  null, null,
  'local dev seed grant'
);

-- ── 3. API keys — both belong to the CALLER ─────────────────────────────────
--
-- LENGTH IS LOAD-BEARING. A platform key is EXACTLY 51 characters:
-- `sk-plat-` (8) + 43 body characters matching [A-Za-z0-9_-] — 43 being the
-- base64url encoding of 32 random bytes. auth.ts (`isWellFormedApiKey`,
-- KEY_TOTAL_LENGTH = 51, KEY_BODY_RE = /^[A-Za-z0-9_-]{43}$/) shape-checks the
-- bearer token BEFORE it ever queries Postgres, and returns 401
-- invalid_api_key on a mismatch.
--
-- That makes a wrong-length fixture fail SILENTLY and misleadingly: nothing
-- errors at INSERT, because key_prefix and key_hash each satisfy their own CHECK
-- independently — the schema has no way to know the plaintext they were derived
-- from was the wrong length. The only symptom is a 401 at auth time that looks
-- exactly like a bad credential. An earlier revision of this file seeded 41- and
-- 39-character keys for precisely this reason; the assertion block below now
-- makes that failure loud, at `db reset`, instead.
--
-- Reproduce either digest with:
--   node -e "console.log(require('crypto').createHash('sha256')
--     .update('<plaintext>').digest('hex'))"

-- LIVE KEY (dev only — obviously fake, valid nowhere but a local reset):
--   sk-plat-mvp0seedkey-local-dev-fixture-not-real-keys
--   sha256 = 88a3a9a61884397844427033a8355299a054a88974e533542e7ff22790cfd365
-- Use as: OpenAI(base_url="http://127.0.0.1:54321/functions/v1/gateway/v1",
--                api_key="sk-plat-mvp0seedkey-local-dev-fixture-not-real-keys")
insert into public.api_keys (id, user_id, name, key_hash, key_prefix)
values (
  '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-0000000000a2',
  'local dev key (51-char, active)',
  '88a3a9a61884397844427033a8355299a054a88974e533542e7ff22790cfd365',
  'sk-plat-mvp0seed'
) on conflict (id) do nothing;

-- REVOKED KEY. Exists so the gateway's 401 invalid_api_key vs 401
-- revoked_api_key distinction is reachable end to end — which requires it to be
-- well-formed, or it dies at the shape gate and never reaches gateway_resolve.
--   sk-plat-mvp0revokedkey-local-dev-fixture-revoked-00
--   sha256 = 9a812296b3a7a756f7f6599e989f41578dc6d114ba4802949d749ddd5bf20baa
insert into public.api_keys (id, user_id, name, key_hash, key_prefix, revoked_at)
values (
  '00000000-0000-0000-0000-0000000000b2',
  '00000000-0000-0000-0000-0000000000a2',
  'revoked dev key (51-char)',
  '9a812296b3a7a756f7f6599e989f41578dc6d114ba4802949d749ddd5bf20baa',
  'sk-plat-mvp0revo',
  now()
) on conflict (id) do nothing;

-- ── 3a. Assert the fixtures are actually usable ─────────────────────────────
-- Recomputes both digests in-database and re-checks the wire shape, so editing a
-- plaintext above without recomputing its hash — or padding it to the wrong
-- length — aborts `db reset` loudly instead of surfacing as a mystery 401 in
-- somebody else's acceptance test three agents downstream.
do $$
declare
  v_keys constant text[] := array[
    'sk-plat-mvp0seedkey-local-dev-fixture-not-real-keys',
    'sk-plat-mvp0revokedkey-local-dev-fixture-revoked-00'
  ];
  v_plain text;
begin
  foreach v_plain in array v_keys loop
    if length(v_plain) <> 51 then
      raise exception 'seed api key % is % chars, auth.ts requires exactly 51',
        left(v_plain, 16), length(v_plain);
    end if;
    if v_plain !~ '^sk-plat-[A-Za-z0-9_-]{43}$' then
      raise exception 'seed api key % fails auth.ts KEY_BODY_RE', left(v_plain, 16);
    end if;
    if not exists (
      select 1 from public.api_keys
       where key_hash = encode(extensions.digest(v_plain, 'sha256'), 'hex')
         and key_prefix = left(v_plain, 16))
    then
      raise exception
        'seed api key %: stored key_hash/key_prefix do not match this plaintext — recompute sha256',
        left(v_plain, 16);
    end if;
  end loop;
end $$;

-- ── 4. The MVP-0 target model — owned by the CREATOR ────────────────────────
-- Filenames and sizes are the real probed values from
-- tests/fixtures/hf-qwen38-27b-uncensored-gguf.json (Q4_K_M, base family).
-- Architecture is the REAL GGUF key-value header (arch `qwen35`), read live:
--   block_count 65   head_count 24   head_count_kv 4   key_length 256
--   context_length 262144   full_attention_interval 4   nextn_predict_layers 1
--   ssm: state_size 128  inner_size 6144  group_count 16  conv_kernel 4
-- This is a HYBRID attention/SSM model: only every 4th block holds a growing KV
-- cache, so n_attention_layers = floor(65 / 4) = 16, and the remaining 49 blocks
-- hold a fixed-size recurrent state instead (see 20260817001700).
insert into public.custom_models (
  id, user_id, slug, display_name, description,
  hf_repo_slug, hf_revision, served_model_name,
  weights_format, runtime,
  variant_quant_tag, variant_family, variant_files, companion_assets,
  weights_bytes, active_weights_bytes,
  n_layers, n_attention_layers, full_attention_interval,
  n_kv_heads, head_dim, kv_dtype_bytes, max_position_embeddings,
  ssm_state_size, ssm_inner_size, ssm_group_count, ssm_conv_kernel,
  ssm_state_bytes_per_seq,
  context_length, context_verified, target_tokens_per_second,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  platform_fee_bps,
  visibility, status
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000a1',
  -- Frozen in CONTRACTS.md as the platform id `jonathancoletti/qwen3.8-27b-uncensored-gguf`.
  -- The DOT is significant. This is NOT the Hugging Face repo path: both halves of
  -- the platform id are lowercase by schema CHECK (handle and slug), while the HF
  -- path is `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` and lives in
  -- hf_repo_slug. The slug CHECK already permits '.', so no migration is involved.
  'qwen3.8-27b-uncensored-gguf',
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
  -- PLACEHOLDER: assumes dense compute, so active == total. The header reports no
  -- expert layout, but a hybrid model reads far less than the full weight set per
  -- decoded token in its SSM blocks, so predicted throughput here is a floor.
  16810714528,
  65, 16, 4,          -- blocks, attention blocks, full_attention_interval
  4, 256, 2, 262144,  -- head_count_kv (GQA), key_length, kv dtype, max positions
  128, 6144, 16, 4,   -- ssm state_size, inner_size, group_count, conv_kernel
  public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint),
  8192, false, 30,    -- creator intent: 8k context (arch supports 262144)
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
           m.kv_dtype_bytes, null,
           m.n_attention_layers, m.ssm_state_bytes_per_seq
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
-- upstream_endpoint_ref is the value the passing MVP-0 acceptance run used
-- against the local Modal llama.cpp worker. It is an OPAQUE, provider-shaped
-- reference (see the column comment): for Modal it is a URL query string that
-- selects the container pool, which the gateway appends verbatim.
--
-- CORRECTED after live verification. An earlier revision of this comment said the
-- value must be re-pointed after ANY Modal redeploy. It does not: this row holds
-- only the QUERY STRING, and the query string is a pure function of the
-- (repo, file, ctx_size, parallel) tuple. A redeploy that keeps the same tuple
-- leaves this row valid. The HOST lives in UPSTREAM_BASE_URL, in the function's
-- environment — that is what actually goes stale on redeploy, along with
-- UPSTREAM_PROVIDER if it is still pointing at the mock.
--
-- So when a request 404s or hangs at the upstream, check the ENV first
-- (UPSTREAM_PROVIDER / UPSTREAM_BASE_URL), then this row. A stale pool reference
-- still looks exactly like a cold-start timeout from the client side, which is
-- why the order matters.
--
-- It remains meaningless against RunPod or the mock upstream, where the reference
-- is an id used as a path segment rather than a query string.
--
-- ctx_size below must stay in step with custom_models.context_length (8192): the
-- worker allocates its KV cache from ctx_size, so a larger context_length here
-- would be advertised to callers but truncated by the pool at runtime.
update public.custom_models
   set upstream_endpoint_ref = 'model_repo=JonathanColetti%2FQwen3.8-27B-Uncensored-GGUF'
                               '&model_file=Qwen3.8-27B-Uncensored-Q4_K_M.gguf'
                               '&ctx_size=8192&parallel=1',
       -- PLACEHOLDER: RunPod-only concept; unused on Modal. Left non-null so the
       -- provisioning path has something to overwrite when RunPod is wired up.
       runpod_template_id         = 'PLACEHOLDER-runpod-template-id',
       measured_tokens_per_second = predicted_tokens_per_second,  -- PLACEHOLDER: smoke-test truth
       status                     = 'ready',
       ready_at                   = now()
 where id = '00000000-0000-0000-0000-0000000000c1'
   and gpu_tier_id is not null;

-- ── 4c. The base model the listing serves ───────────────────────────────────
-- Without this the local database has the grouping schema and nothing grouped,
-- which makes the catalog work of the discovery plan untestable: a card that
-- aggregates over listings needs a row with listings under it.
--
-- The slug's first segment is the WEIGHTS publisher, and here it coincides with
-- the platform creator handle because the same person published the repo and
-- registered the listing. That is a coincidence of this fixture, exactly like the
-- HF-path coincidence CONTRACTS.md warns about at the top — the two namespaces
-- are unrelated, and `base_models.slug` is never an addressable platform id.
--
-- commercial_hosting stays `unknown`: the seeded repo's licence was never
-- captured (lib/studio/server/model-card.ts discards it today — #25), and
-- `unknown` is the honest answer rather than a guess. It is also the value that
-- must never auto-publish, so seeding it exercises the interesting case.
--
-- No parent_id. The repo is an original as far as anything here knows; inventing
-- a parent would put a claim about real weights into a fixture that cannot
-- support it. The parent case is covered by supabase/tests/07_base_models_test.sql.
insert into public.base_models (
  id, slug, display_name, summary, family, parameter_count,
  architecture, n_layers, n_attention_heads, n_kv_heads, head_dim, hidden_size,
  full_attention_interval, max_position_embeddings,
  use_cases, commercial_hosting
) values (
  '00000000-0000-0000-0000-0000000000d1',
  'jonathancoletti/qwen3.8-27b-uncensored',
  'Qwen3.8 27B Uncensored',
  'Hybrid attention/SSM model: only every 4th of its 65 blocks holds a growing '
  'KV cache, which is why it fits a 262k context on hardware its parameter count '
  'would not suggest.',
  'qwen3.8', 27000000000,
  -- The fingerprint, from the same GGUF header the listing was probed from
  -- (20260817001700). n_attention_heads is absent from that header, so it stays
  -- NULL rather than being back-derived from hidden_size — the derivation this
  -- codebase already documents as unsafe.
  'qwen35', 65, null, 4, 256, 5120, 4, 262144,
  array['uncensored', 'chat', 'long-context'],
  'unknown'
)
on conflict (slug) do nothing;

update public.custom_models
   set base_model_id = '00000000-0000-0000-0000-0000000000d1',
       -- The audit trail §2.1 asks for: this link was made by hand in a fixture,
       -- not by the cascade, and a re-resolution pass has to be able to tell.
       base_model_match = jsonb_build_object(
         'signal', 'manual',
         'relation', null,
         'confidence', 1.0,
         'confirmed_by', null,
         'at', now(),
         'note', 'seeded by supabase/seed.sql, not resolved by the #25 cascade')
 where id = '00000000-0000-0000-0000-0000000000c1';

-- ── 4d. Two more listings of the SAME base model ────────────────────────────
-- Without these the local catalog cannot show the thing #26 built: every
-- aggregate over a single listing is that listing, so a one-listing fixture
-- renders a grouped card that is indistinguishable from the ungrouped one it
-- replaced. Three listings of one base model is the smallest fixture where
-- "3 listings", "best tok/s", "max context" and "from $x" are all visibly
-- different numbers, and where the quality facet has a variant to pick INSIDE
-- the group instead of a card to delete.
--
-- THESE TWO DO NOT SERVE. `upstream_endpoint_ref` names quant files that the
-- upstream repo may not hold, so a chat completion against either will fail at
-- the worker. That is deliberate and is the honest trade: they exist to populate
-- the CATALOG, which is a read surface, and the MVP-0 acceptance run goes through
-- `…c1` — the one listing whose ref was verified against a live Modal worker.
-- Do not point a smoke test at these.
--
-- Same creator, same repo, same revision, different quantization, which is
-- exactly what `custom_models_variant_uniq` (20260820000100) permits: one
-- creator, one repo, one revision, one variant = one listing.
--
-- Inserted as `draft` and flipped to `ready` by the update below, the same two
-- steps §4a/§4b take for `…c1`: `custom_models_ready_needs_endpoint` and
-- `custom_models_ready_needs_placement` both fire on INSERT, so a row cannot be
-- born `ready` before the solver has run over it.
insert into public.custom_models (
  id, user_id, slug, display_name, description,
  hf_repo_slug, served_model_name, weights_format, runtime,
  variant_quant_tag, variant_files,
  weights_bytes, active_weights_bytes,
  n_layers, n_attention_layers, full_attention_interval,
  n_kv_heads, head_dim, kv_dtype_bytes, max_position_embeddings,
  ssm_state_size, ssm_inner_size, ssm_group_count, ssm_conv_kernel,
  ssm_state_bytes_per_seq,
  context_length, context_verified, target_tokens_per_second,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  platform_fee_bps, visibility, status, base_model_id
) values
  ('00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000a1',
   'qwen3.8-27b-uncensored-q6', 'Qwen3.8 27B Uncensored (Q6_K)',
   'Six-bit build of the same weights: effectively indistinguishable from FP16, '
   'and slower and dearer than the Q4 for it.',
   'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'qwen3.8-27b-uncensored-q6',
   'gguf', 'llamacpp', 'Q6_K',
   array['Qwen3.8-27B-Uncensored-Q6_K.gguf'],
   -- Six-bit is ~1.5x the four-bit weight set. The same dense-compute
   -- PLACEHOLDER as `…c1`: active == total.
   24500000000, 24500000000,
   65, 16, 4,
   4, 256, 2, 262144,
   128, 6144, 16, 4,
   public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint),
   32768, false, 30,
   900000, 2400000,
   2000, 'public', 'draft', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000c3',
   '00000000-0000-0000-0000-0000000000a1',
   'qwen3.8-27b-uncensored-q8', 'Qwen3.8 27B Uncensored (Q8_0)',
   'Eight-bit build at the architecture''s full 262k context — the long-context '
   'end of this model, and the dearest.',
   'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'qwen3.8-27b-uncensored-q8',
   'gguf', 'llamacpp', 'Q8_0',
   array['Qwen3.8-27B-Uncensored-Q8_0.gguf'],
   32000000000, 32000000000,
   65, 16, 4,
   4, 256, 2, 262144,
   128, 6144, 16, 4,
   public.calc_ssm_state_bytes(65 - 16, 128, 6144, 16, 4, 2::smallint),
   262144, true, 30,
   1800000, 4800000,
   2000, 'public', 'draft', '00000000-0000-0000-0000-0000000000d1')
on conflict (id) do nothing;

-- The same solver call §4a makes for `…c1`, for the same reason: placement is
-- never hand-written (FR-DB-008), and `custom_models_ready_needs_placement`
-- refuses a `ready` row without it. Running it here also means a `db reset`
-- smoke-tests the solver on a 262k-context row, which `…c1` (8k) does not.
with r as (
  select m.id,
         public.resolve_placement(
           m.weights_bytes, m.active_weights_bytes,
           m.n_layers, m.n_kv_heads, m.head_dim,
           m.context_length, m.target_tokens_per_second,
           m.kv_dtype_bytes, null,
           m.n_attention_layers, m.ssm_state_bytes_per_seq
         ) as p
    from public.custom_models m
   where m.id in ('00000000-0000-0000-0000-0000000000c2',
                  '00000000-0000-0000-0000-0000000000c3')
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
       placement_rationale             = r.p,
       -- PLACEHOLDER, exactly as in §4b: the smoke test that would measure this
       -- has not run against these two, so the prediction stands in for it.
       measured_tokens_per_second      = (r.p->>'predicted_tokens_per_second')::integer,
       -- The Modal pool reference is a pure function of
       -- (repo, file, ctx_size, parallel) — see §4b — so it is assembled from
       -- the row rather than pasted, and `ctx_size` cannot drift away from
       -- `context_length` the way a hand-written one would.
       upstream_endpoint_ref =
         'model_repo=JonathanColetti%2FQwen3.8-27B-Uncensored-GGUF'
         '&model_file=' || m.variant_files[1]
         || '&ctx_size=' || m.context_length || '&parallel=1',
       status                          = 'ready',
       ready_at                        = now()
  from r
 where m.id = r.id
   and (r.p->>'feasible')::boolean;

-- A row the solver refused stays a `draft` and never reaches the catalog, which
-- is correct but SILENT — and what it would be silent about is the tier catalog
-- no longer fitting these weights, which is worth knowing on a `db reset`.
do $$
declare v_stuck integer;
begin
  select count(*) into v_stuck
    from public.custom_models
   where id in ('00000000-0000-0000-0000-0000000000c2',
                '00000000-0000-0000-0000-0000000000c3')
     and status <> 'ready';
  if v_stuck > 0 then
    raise warning 'seed: % of the grouped-catalog listings did not fit any GPU tier '
                  'and stayed drafts; the grouped card will show fewer listings',
                  v_stuck;
  end if;
end $$;
