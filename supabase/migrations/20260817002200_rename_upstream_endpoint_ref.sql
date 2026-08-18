-- ============================================================================
-- 20260817002200_rename_upstream_endpoint_ref.sql
-- SUPERSEDED BY 20260817002300_upstream_endpoint_ref.sql: the rename described
-- below as blocked has since landed. Kept for history; read 002300 instead.
--
-- INTENDED: rename custom_models.runpod_endpoint_id -> upstream_endpoint_ref.
-- NOT DONE — BLOCKED, deliberately. See the block comment below before
-- attempting it again. What this migration does instead is everything the
-- rename was FOR, minus the physical rename: it documents the column's real
-- semantics and introduces the new name on the wire, where nothing is blocked.
--
-- ── Why the column is not renamed ──────────────────────────────────────────
-- supabase/tests/05_concurrency_test.sql:74 writes the column by name:
--
--     update _mm set runpod_endpoint_id=''endpoint-'' || %L, ...
--
-- where `_mm` is a temp clone of custom_models built from pg_catalog at runtime.
-- Renaming the column makes that statement fail at parse time, taking all 33
-- concurrency assertions down with it:
--
--     ERROR: column "runpod_endpoint_id" of relation "_mm" does not exist
--     Parse errors: Bad plan. You planned 33 tests but ran 0.
--
-- I verified this by performing the rename and running the suite; that is the
-- real output, not a prediction. No DB-side shim can rescue it: the reference is
-- to a temp table cloned from the live column list, so a view, a generated
-- column, a rule or a trigger cannot intercept it. The test's own column filter
-- (`attgenerated = ''`) also excludes generated columns from the clone, ruling
-- out the one trick that might otherwise have worked.
--
-- The rename therefore requires a one-line edit to a file owned by the pgTAP
-- agent, which I must not touch. Unblocking it is exactly:
--
--     supabase/tests/05_concurrency_test.sql:74
--     -   runpod_endpoint_id=''endpoint-'' || %L,
--     +   upstream_endpoint_ref=''endpoint-'' || %L,
--
-- plus, in the same pass, `ResolvedRequest.runpodEndpointId` ->
-- `upstreamEndpointRef` in packages/shared/types.ts (frozen, owned by the lead)
-- and the four references in supabase/functions/gateway/resolve.ts. Once those
-- land, this migration becomes a two-line ALTER and the alias below is deleted.
-- ============================================================================

-- What the column actually holds, since the name says otherwise.
comment on column public.custom_models.runpod_endpoint_id is
  'MISNOMER, pending rename to upstream_endpoint_ref (blocked: see migration '
  '20260817002200). This is NOT an id and NOT RunPod-specific. It is an OPAQUE, '
  'provider-shaped reference to the container pool serving this model, and only '
  'the upstream-URL builder may interpret it. RunPod: an endpoint id used as a '
  'URL path segment. Modal (MVP-0): a URL query string selecting the pool — '
  'model_repo, model_file, ctx_size, parallel — appended verbatim. The gateway '
  'must never parse, validate, or pattern-match it. ENVIRONMENT-SPECIFIC: it '
  'changes on every redeploy of the upstream worker and is not a constant.';

-- ============================================================================
-- gateway_resolve: introduce the new name on the wire now.
--
-- The envelope is the one place the new name costs nothing, because it is a
-- jsonb key rather than a schema object: adding `upstreamEndpointRef` alongside
-- the existing `runpodEndpointId` breaks no consumer, and lets the gateway and
-- packages/shared/types.ts migrate on their own schedule. Both keys carry the
-- identical value. Delete `runpodEndpointId` once ResolvedRequest renames its
-- field.
--
-- I confirmed the gateway tree needs no change today: resolve.ts reaches
-- custom_models ONLY through this envelope (its one other direct read is
-- api_keys), `RawModelRow.runpod_endpoint_id` is an internal TS shape built by
-- envelopeToRow() from the envelope key rather than a PostgREST column
-- selection, and the gateway tests build that row in memory without touching
-- the database. Deno is not installed here, so I could not run their suite —
-- another reason this change is additive only.
-- ============================================================================
create or replace function public.gateway_resolve(
  p_key_hash       text,
  p_creator_handle text,
  p_model_slug     text
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_key   record;
  v_payer record;
  v_model record;
begin
  select k.id, k.user_id, k.revoked_at, k.scopes
    into v_key
    from public.api_keys k
   where k.key_hash = p_key_hash;          -- NO revoked_at filter. See 20260817001800.

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_key');
  end if;

  select p.id, p.handle, p.is_suspended, p.balance_micro_usd, p.rate_limit_rpm
    into v_payer
    from public.profiles p
   where p.id = v_key.user_id;

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_key');
  end if;

  select m.id, m.user_id as creator_id, m.slug, m.served_model_name, m.runtime,
         m.runpod_endpoint_id, m.status, m.visibility, m.deleted_at,
         m.price_prompt_micro_usd_per_mtoken     as pp,
         m.price_completion_micro_usd_per_mtoken as pc,
         m.platform_fee_bps, m.context_length, m.cold_start_budget_s,
         m.max_concurrent_streams, m.variant_files
    into v_model
    from public.custom_models m
    join public.profiles c on c.id = m.user_id
   where c.handle = p_creator_handle
     and m.slug   = p_model_slug;          -- NO visibility/status filter.

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_model');
  end if;

  return jsonb_build_object(
    'found', true,
    -- ── ResolvedRequest (packages/shared/types.ts) ──────────────────────────
    'apiKeyId',             v_key.id,
    'userId',               v_payer.id,
    'modelId',              v_model.id,
    'creatorId',            v_model.creator_id,
    -- Preferred name. Migrate consumers to this.
    'upstreamEndpointRef',  v_model.runpod_endpoint_id,
    -- DEPRECATED alias, identical value. Remove once ResolvedRequest renames
    -- the field and the column rename above is unblocked.
    'runpodEndpointId',     v_model.runpod_endpoint_id,
    'servedModelName',      v_model.served_model_name,
    'runtime',              v_model.runtime,
    'pricePromptMicro',     v_model.pp,
    'priceCompletionMicro', v_model.pc,
    'platformFeeBps',       v_model.platform_fee_bps,
    'contextLength',        v_model.context_length,
    'coldStartBudgetS',     v_model.cold_start_budget_s,
    -- ── Raw facts the gateway maps to status codes itself ───────────────────
    'keyRevokedAt',         v_key.revoked_at,          -- non-null => 401 revoked_api_key
    'keyScopes',            to_jsonb(v_key.scopes),
    'userIsSuspended',      v_payer.is_suspended,
    'userBalanceMicroUsd',  v_payer.balance_micro_usd, -- never cache this
    'userRateLimitRpm',     v_payer.rate_limit_rpm,
    'creatorHandle',        p_creator_handle,
    'modelSlug',            v_model.slug,
    'modelStatus',          v_model.status,            -- <> 'ready'  => 503 model_unavailable
    'modelVisibility',      v_model.visibility,        -- private + not owner => 404
    'modelDeletedAt',       v_model.deleted_at,        -- non-null => 404
    'maxConcurrentStreams', v_model.max_concurrent_streams,
    'variantFiles',         to_jsonb(v_model.variant_files));
end $$;

revoke all on function public.gateway_resolve(text, text, text) from public, anon, authenticated;
grant execute on function public.gateway_resolve(text, text, text) to service_role;
