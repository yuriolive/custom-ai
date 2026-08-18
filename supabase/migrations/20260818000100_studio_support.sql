-- ============================================================================
-- 20260818000100_studio_support.sql — what Creator Studio needs that the
-- schema did not already provide.
--
-- Three things, and deliberately nothing else:
--
--   1. resolve_placement_batch() — a THIN LOOP over the existing solver.
--      FR-DEP-050 / FR-DB-007 forbid a second placement implementation, and
--      that prohibition is the reason this function exists rather than a
--      TypeScript solver in the browser. The Studio's variant consequence
--      table (FR-STU-004a) needs one placement PER VARIANT, live, on every
--      slider movement. Twelve individual PostgREST round trips per keystroke
--      is the only alternative to this wrapper, and it is a worse one.
--      NOT ONE LINE OF PLACEMENT ARITHMETIC LIVES HERE. Every number this
--      returns came out of resolve_placement().
--
--   2. Realtime on custom_models — FR-STU-008 streams provisioning status to
--      an open form. RLS still applies to the replication stream, so a
--      creator only ever sees their own rows change.
--
--   3. next_available_slug() — the Studio derives a slug from the display
--      name, and (user_id, slug) is UNIQUE. Deriving it in the browser races
--      against itself on a double submit and produces a 409 the creator
--      cannot act on. Resolving it server-side under the caller's own user id
--      is both correct and one round trip.
-- ============================================================================

-- ── 1. Batch placement ──────────────────────────────────────────────────────
--
-- p_variants is an array of {id, weights_bytes, active_weights_bytes}. The
-- architecture arguments are shared across every variant because they describe
-- the MODEL, not the quantization: block count, GQA head count and head_dim are
-- properties of the network, and quantizing it changes the weight bytes only.
--
-- Returns: [{ "variant_id": text, "placement": <envelope>, "max_context": int }]
-- in the order supplied. A malformed element yields an infeasible envelope
-- rather than aborting the batch, so one bad variant cannot blank the table.
--
-- `max_context` answers the consequence table's "Max context" column, and it is
-- obtained by ASKING THE SOLVER rather than by dividing anything here. The
-- solver already reports `max_context_at_this_quality` whenever a request does
-- not fit, so probing it at the architecture's own ceiling yields that variant's
-- true maximum: if the ceiling fits, the ceiling IS the maximum (the schema
-- forbids exceeding max_position_embeddings anyway); if it does not, the
-- infeasible envelope names the largest window that does. Two calls, one round
-- trip, and still exactly one implementation of the arithmetic.
create or replace function public.resolve_placement_batch(
  p_variants                 jsonb,
  p_n_layers                 integer,
  p_n_kv_heads               integer,
  p_head_dim                 integer,
  p_context_length           integer,
  p_target_tokens_per_second integer,
  p_kv_dtype_bytes           smallint default 2,
  p_n_attention_layers       integer  default null,
  p_ssm_state_bytes_per_seq  bigint   default 0,
  -- The architecture's own context ceiling (max_position_embeddings). NULL
  -- skips the max-context probe entirely.
  p_ceiling_context          integer  default null
)
returns jsonb
language plpgsql stable parallel safe
set search_path = public, pg_temp
as $$
declare
  v_variant jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_weights bigint;
  v_active  bigint;
  v_place   jsonb;
  v_ceiling jsonb;
  v_max_ctx integer;
begin
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' then
    return '[]'::jsonb;
  end if;

  -- A caller-supplied array is not a work queue. 64 is far above any real
  -- repo (the MVP's own adversarial fixture yields 12) and far below anything
  -- that would make this loop a denial-of-service primitive.
  if jsonb_array_length(p_variants) > 64 then
    raise exception 'resolve_placement_batch: % variants exceeds the limit of 64',
      jsonb_array_length(p_variants);
  end if;

  for v_variant in select * from jsonb_array_elements(p_variants) loop
    v_weights := nullif(v_variant->>'weights_bytes', '')::bigint;
    v_active  := coalesce(nullif(v_variant->>'active_weights_bytes', '')::bigint, v_weights);

    -- THE ONLY ARITHMETIC. Everything numeric below is this function's output.
    v_place := public.resolve_placement(
                 v_weights, v_active,
                 p_n_layers, p_n_kv_heads, p_head_dim,
                 p_context_length, p_target_tokens_per_second,
                 p_kv_dtype_bytes,
                 null,                       -- no tier pinning from the Studio
                 p_n_attention_layers, p_ssm_state_bytes_per_seq);

    -- Max context at THIS quality, from the same function (see the header).
    v_max_ctx := null;
    if p_ceiling_context is not null and p_ceiling_context > 0 then
      if p_ceiling_context = p_context_length then
        -- Already answered: the requested window IS the ceiling.
        v_ceiling := v_place;
      else
        v_ceiling := public.resolve_placement(
                       v_weights, v_active,
                       p_n_layers, p_n_kv_heads, p_head_dim,
                       p_ceiling_context, p_target_tokens_per_second,
                       p_kv_dtype_bytes, null,
                       p_n_attention_layers, p_ssm_state_bytes_per_seq);
      end if;

      v_max_ctx := case
        when (v_ceiling->>'feasible')::boolean then p_ceiling_context
        else least(p_ceiling_context,
                   coalesce((v_ceiling->>'max_context_at_this_quality')::integer, 0))
      end;
    end if;

    v_out := v_out || jsonb_build_object(
      'variant_id',  v_variant->>'id',
      'placement',   v_place,
      'max_context', v_max_ctx);
  end loop;

  return v_out;
end $$;

revoke all on function public.resolve_placement_batch(
  jsonb,integer,integer,integer,integer,integer,smallint,integer,bigint,integer)
  from public, anon;
-- Same audience as resolve_placement itself: the Studio calls it directly for
-- live preview, and it is a pure function over public capability data plus
-- numbers the caller already supplied.
grant execute on function public.resolve_placement_batch(
  jsonb,integer,integer,integer,integer,integer,smallint,integer,bigint,integer)
  to authenticated, service_role;

-- Asserted, not assumed. A batch whose numbers drift from a direct call would
-- put one figure in the variant table and a different one in the Deployment
-- Plan for the same variant — the exact "two implementations drift" failure
-- FR-DEP-050 exists to prevent, reintroduced by the wrapper meant to avoid it.
do $$
declare
  v_direct jsonb;
  v_batch  jsonb;
begin
  -- The seeded MVP target's real geometry (see supabase/seed.sql §4).
  v_direct := public.resolve_placement(
    16810714528, 16810714528, 65, 4, 256, 8192, 30, 2::smallint, null,
    16, public.calc_ssm_state_bytes(49, 128, 6144, 16, 4, 2::smallint));

  v_batch := public.resolve_placement_batch(
    jsonb_build_array(jsonb_build_object(
      'id', 'base:Q4_K_M',
      'weights_bytes', 16810714528,
      'active_weights_bytes', 16810714528)),
    65, 4, 256, 8192, 30, 2::smallint,
    16, public.calc_ssm_state_bytes(49, 128, 6144, 16, 4, 2::smallint));

  if (v_batch->0->>'variant_id') is distinct from 'base:Q4_K_M' then
    raise exception 'resolve_placement_batch dropped the variant id';
  end if;
  if (v_batch->0->'placement') is distinct from v_direct then
    raise exception 'resolve_placement_batch diverged from resolve_placement: % vs %',
      v_batch->0->'placement', v_direct;
  end if;
end $$;

-- ── 2. Realtime (FR-STU-008) ────────────────────────────────────────────────
-- The provisioning stepper watches its own row. RLS is enforced on the
-- replication stream, so custom_models_select_own is what scopes it.
--
-- REPLICA IDENTITY FULL is required for the OLD row to reach a subscriber, and
-- without it Realtime cannot evaluate an RLS policy against an UPDATE at all —
-- the change arrives with an empty payload and the stepper silently never moves.
alter table public.custom_models replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'custom_models')
    then
      alter publication supabase_realtime add table public.custom_models;
    end if;
  else
    raise warning 'publication supabase_realtime is absent; the provisioning stepper will fall back to polling';
  end if;
end $$;

-- ── 3. Slug allocation ──────────────────────────────────────────────────────
-- SECURITY DEFINER so it can see the caller's OWN rows including soft-deleted
-- ones. That matters: (user_id, slug) is UNIQUE with no partial predicate, so a
-- deleted model still occupies its slug and a suggestion that ignores it
-- produces a 409 on submit. auth.uid() is read inside the function — the caller
-- cannot ask about somebody else's namespace, and the only thing disclosed is
-- whether a slug of the caller's own is free.
create or replace function public.next_available_slug(p_base text)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_base  text;
  v_try   text;
  v_n     integer := 2;
begin
  if v_user is null then
    raise exception 'next_available_slug requires an authenticated caller';
  end if;

  -- Mirror the custom_models.slug CHECK: ^[a-z0-9][a-z0-9._-]{1,62}$
  v_base := lower(coalesce(p_base, ''));
  v_base := regexp_replace(v_base, '[^a-z0-9._-]+', '-', 'g');
  v_base := regexp_replace(v_base, '^[^a-z0-9]+', '');
  v_base := regexp_replace(v_base, '[-._]+$', '');
  v_base := left(v_base, 55);
  if char_length(v_base) < 2 then
    v_base := 'model';
  end if;

  v_try := v_base;
  while exists (select 1 from public.custom_models
                 where user_id = v_user and slug = v_try) loop
    v_try := left(v_base, 55) || '-' || v_n::text;
    v_n := v_n + 1;
    if v_n > 200 then
      raise exception 'could not find a free slug for %', v_base;
    end if;
  end loop;

  return v_try;
end $$;

revoke all on function public.next_available_slug(text) from public, anon;
grant execute on function public.next_available_slug(text) to authenticated, service_role;

-- ── 4. HF token custody (FR-DEP-010 … FR-DEP-014) ───────────────────────────
--
-- The `vault` schema is not in config.toml's exposed `schemas` list, so
-- PostgREST cannot reach it and there is no way for any client — service role
-- included — to call vault.create_secret over the wire. These two wrappers are
-- the entire supported surface, and both are service_role-only.
--
-- NEITHER WRAPPER CAN READ A SECRET BACK. There is deliberately no
-- studio_read_hf_token(): FR-DEP-011 puts decryption inside an Edge Function
-- reading vault.decrypted_secrets directly, and a public wrapper that returned
-- plaintext would be reachable by anything holding the service role, including
-- a Next.js route handler — which is exactly the exposure the requirement
-- exists to prevent.
create or replace function public.studio_store_hf_token(
  p_token   text,
  p_label   text
) returns uuid
language plpgsql volatile security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_token is null or char_length(p_token) < 8 then
    raise exception 'refusing to store an implausible Hugging Face token';
  end if;
  -- The label is descriptive only and must never contain the token. Callers
  -- pass a repo slug; this truncates rather than trusting them on length.
  v_id := vault.create_secret(p_token, gen_random_uuid()::text,
                              left(coalesce(p_label, 'hf token'), 200));
  return v_id;
end $$;

revoke all on function public.studio_store_hf_token(text, text)
  from public, anon, authenticated;
grant execute on function public.studio_store_hf_token(text, text) to service_role;

-- FR-DEP-014: deleting a model destroys the secret in the same transaction.
--
-- CORRECTION TO THE PRD: FR-DEP-014 names `vault.delete_secret`. No such
-- function exists in supabase_vault as shipped (the schema has create_secret
-- and update_secret only) — deletion is an ordinary DELETE against
-- vault.secrets. Verified against the installed extension, not assumed.
create or replace function public.studio_destroy_hf_token(p_secret_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = public, vault, pg_temp
as $$
begin
  if p_secret_id is null then return false; end if;
  delete from vault.secrets where id = p_secret_id;
  return found;
end $$;

revoke all on function public.studio_destroy_hf_token(uuid)
  from public, anon, authenticated;
grant execute on function public.studio_destroy_hf_token(uuid) to service_role;
