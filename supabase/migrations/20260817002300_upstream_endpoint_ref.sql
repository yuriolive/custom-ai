-- ============================================================================
-- 20260817002300_upstream_endpoint_ref.sql
--
-- SUPERSEDES the "blocked" note in 20260817002200. The blocker there was
-- supabase/tests/05_concurrency_test.sql:74 writing the column by name into a
-- temp clone of custom_models; that line and the TS-side references
-- (packages/shared/types.ts, resolve.ts, index.ts, tests/gateway_test.ts) have
-- since been renamed by their owners, so the physical rename can land.
--
-- `runpod_endpoint_id` was a misnomer twice over: MVP-0 serves from Modal, not
-- RunPod, and the value is not an id — it is a URL query string that SELECTS a
-- container pool. The new name says what it is: an opaque, provider-shaped
-- reference to whatever serves this model upstream.
-- ============================================================================

alter table public.custom_models
  rename column runpod_endpoint_id to upstream_endpoint_ref;

-- Keep constraint/index names in step with the column they cover.
alter table public.custom_models
  rename constraint custom_models_runpod_endpoint_id_key
    to custom_models_upstream_endpoint_ref_key;

alter index public.custom_models_endpoint_idx
  rename to custom_models_upstream_ref_idx;

-- Replaces the misnomer comment from 20260817002200.
comment on column public.custom_models.upstream_endpoint_ref is
  'OPAQUE, provider-shaped reference to the container pool serving this model. '
  'Only the upstream-URL builder may interpret it. RunPod: an endpoint id used '
  'as a URL path segment. Modal (MVP-0): a URL query string selecting the pool '
  '(model_repo, model_file, ctx_size, parallel), appended verbatim. The gateway '
  'must never parse, validate, or pattern-match it — the shape differs per '
  'provider and the next one will match neither. ENVIRONMENT-SPECIFIC: it '
  'changes on every redeploy of the upstream worker and is not a constant.';

-- Two RLS policies reference this column: custom_models_insert_own asserts it IS
-- NULL on creator insert, and custom_models_update_own asserts it is unchanged.
-- Postgres rewrote both COLUMN REFERENCES as part of the rename.
--
-- But it does NOT rewrite a subquery's output LABEL. custom_models_update_own
-- was stored as `(select m.runpod_endpoint_id from ...)`, and after the rename
-- pg_policies renders it as:
--
--     (select m.upstream_endpoint_ref as runpod_endpoint_id from ...)
--
-- — correct behaviour, cosmetically alarming. A dead column name sitting inside
-- a security policy is exactly the kind of thing that costs someone an afternoon
-- deciding whether the policy still protects anything, so the policy is recreated
-- below with the new name rather than left carrying the historical label. The
-- predicate is otherwise byte-identical to 20260817000700.
drop policy custom_models_update_own on public.custom_models;

create policy custom_models_update_own on public.custom_models
  for update to authenticated
  using (user_id = auth.uid() and deleted_at is null)
  with check (
    user_id = auth.uid()
    and slug               = (select m.slug               from public.custom_models m where m.id = custom_models.id)
    and hf_repo_slug       = (select m.hf_repo_slug       from public.custom_models m where m.id = custom_models.id)
    -- `is not distinct from` on the nullable columns: `=` yields NULL, i.e. a
    -- WITH CHECK failure, for every pre-provisioning draft. See 20260817000700.
    and gpu_tier_id        is not distinct from
                             (select m.gpu_tier_id        from public.custom_models m where m.id = custom_models.id)
    and upstream_endpoint_ref is not distinct from
                             (select m.upstream_endpoint_ref from public.custom_models m where m.id = custom_models.id)
    and hf_token_secret_id is not distinct from
                             (select m.hf_token_secret_id from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
  );

-- Asserted rather than assumed: an RLS policy that silently lost its reference to
-- this column would let a creator point their own model at any upstream pool.
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'custom_models'
     and (coalesce(qual,'') || coalesce(with_check,'')) like '%upstream_endpoint_ref%';
  if v_n <> 2 then
    raise exception
      'expected 2 custom_models policies to reference upstream_endpoint_ref after rename, found %', v_n;
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'custom_models'
       and (coalesce(qual,'') || coalesce(with_check,'')) like '%runpod_endpoint_id%')
  then
    raise exception 'a custom_models policy still mentions the old column name';
  end if;
end $$;

-- ============================================================================
-- gateway_resolve: read the renamed column. `upstreamEndpointRef` is the key the
-- gateway is already on; `runpodEndpointId` stays as a deprecated alias with the
-- identical value, per the coordinator — it costs one jsonb key and keeps any
-- consumer I cannot see from breaking. Delete it once nothing reads it.
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
         m.upstream_endpoint_ref, m.status, m.visibility, m.deleted_at,
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
    'upstreamEndpointRef',  v_model.upstream_endpoint_ref,
    -- DEPRECATED alias, identical value. Safe to delete once nothing reads it.
    'runpodEndpointId',     v_model.upstream_endpoint_ref,
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
