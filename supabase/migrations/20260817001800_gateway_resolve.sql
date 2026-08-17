-- ============================================================================
-- 20260817001800_gateway_resolve.sql
--
-- NOT IN THE PRD. §4.2.2 describes gateway auth+resolution as "a single JOIN",
-- but there is no FK path from api_keys to custom_models, so PostgREST cannot
-- express it in one round trip. This RPC is that round trip.
--
-- Two deliberate NON-filters, both load-bearing for the gateway's error mapping.
-- Neither may be "optimized" into a WHERE clause later:
--
--   1. The key lookup does NOT filter `revoked_at is null`. The gateway must
--      return 401 `invalid_api_key` vs 401 `revoked_api_key`, and it cannot tell
--      them apart if a revoked key simply vanishes. `revoked_at` is returned raw.
--      NOTE: this means api_keys_hash_active_idx — partial on exactly that
--      predicate — cannot serve this lookup, hence the plain index below.
--
--   2. The model lookup does NOT filter on visibility, status, or deleted_at.
--      The gateway returns an IDENTICAL 404 for "no such model" and "private,
--      and you are not the owner" so that a probe cannot enumerate private
--      models — a rule that needs the caller's identity and so cannot live in a
--      WHERE clause here. visibility, status, deleted_at and the owner id are
--      returned raw; the gateway decides.
--
-- Read-only by design: it does NOT bump last_used_at / request_count. Writing on
-- the hot path would add row contention to every request, and CONTRACTS.md
-- forbids caching key validity, so this runs on every single call.
--
-- Key naming is camelCase, matching `ResolvedRequest` in packages/shared/types.ts
-- so the gateway can consume the envelope directly. The billing RPCs use
-- snake_case; this one is deliberately different because its consumer is a typed
-- TS interface rather than a SQL caller.
-- ============================================================================

-- Index for the unfiltered hot-path lookup.
--
-- The coordinator asked for a plain (key_hash) index because
-- api_keys_hash_active_idx is partial on `revoked_at is null` and so cannot serve
-- NON-filter 1. That is correct — but the index already exists: `key_hash text
-- not null UNIQUE` in 20260817000500 created `api_keys_key_hash_key`, a plain
-- b-tree on exactly (key_hash), which serves this lookup for every key, revoked
-- or not. A second one would be pure write amplification on the same column, so
-- none is added here.
--
-- CONSEQUENCE, worth knowing before anyone "cleans up" the schema: the partial
-- api_keys_hash_active_idx is now dead weight for the gateway path. It is kept
-- only for its uniqueness semantics over live keys. Dropping the UNIQUE
-- constraint on key_hash — e.g. to allow hash reuse after revocation — would
-- silently remove the only index this function can use.
do $$
begin
  if not exists (
    select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_class t on t.oid = i.indrelid
     where t.relname = 'api_keys'
       and i.indpred is null                                   -- not partial
       and i.indnatts = 1
       and pg_get_indexdef(i.indexrelid) like '%(key_hash)%')
  then
    execute 'create index api_keys_hash_idx on public.api_keys (key_hash)';
  end if;
end $$;

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
   where k.key_hash = p_key_hash;          -- NO revoked_at filter. See header.

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_key');
  end if;

  select p.id, p.handle, p.is_suspended, p.balance_micro_usd, p.rate_limit_rpm
    into v_payer
    from public.profiles p
   where p.id = v_key.user_id;

  if not found then
    -- api_keys.user_id is NOT NULL and cascades, so this is unreachable short of
    -- corruption. Reported as a key problem rather than raising.
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
     and m.slug   = p_model_slug;          -- NO visibility/status filter. See header.

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

comment on function public.gateway_resolve(text, text, text) is
  'Gateway auth + model resolution in one round trip. Returns a discriminated '
  'envelope ({found:false, reason:''no_key''|''no_model''}) instead of raising, so '
  'the gateway owns the HTTP mapping. Deliberately does NOT filter revoked keys '
  'or non-ready/private models — see the migration header before adding a WHERE.';

revoke all on function public.gateway_resolve(text, text, text) from public, anon, authenticated;
grant execute on function public.gateway_resolve(text, text, text) to service_role;
