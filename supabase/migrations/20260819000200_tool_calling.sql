-- ============================================================================
-- 20260819000200_tool_calling.sql
--
-- FR-TOOL-003: a per-model capability flag for tool calling.
--
-- The gateway stops rejecting `tools` with 501 in this change, which creates a
-- new failure mode worth a column: llama.cpp running `--jinja` renders tools
-- through the MODEL'S OWN chat template, and a template with no tool handling
-- does not error — it silently returns ordinary prose. A tool-calling client
-- parses that as a successful turn that made no tool call, which is the worst
-- possible way to find out the model cannot do this.
--
-- THREE-STATE, deliberately nullable:
--   true   the chat template was read and declares tool support
--   false  the chat template was read and declares none      -> gateway 400
--   null   the template could not be read                    -> gateway allows
--
-- `null` is absence of evidence. Every row provisioned before this migration
-- carries it and there is no way to backfill from SQL — the answer lives in a
-- Jinja template inside a GGUF file on the Hub. Refusing those rows would break
-- calls that work today; refusing a measured `false` prevents a silent failure.
-- ============================================================================

alter table public.custom_models
  add column supports_tools boolean;

comment on column public.custom_models.supports_tools is
  'FR-TOOL-003. Whether this model''s chat template can render tool definitions, '
  'measured at provisioning by reading the template (repo chat_template.jinja, '
  'tokenizer_config.json, or the GGUF tokenizer.chat_template key). NULL means '
  'the template could not be read, NOT that tools are unsupported: the gateway '
  'forwards `tools` on NULL and rejects only a measured FALSE. Platform-measured, '
  'never creator-supplied — RLS pins it on both insert and update.';

-- ── RLS: the flag is a measurement, not a claim ─────────────────────────────
-- `custom_models` is directly UPDATE-able by its owner from the browser. Without
-- pinning, a creator could set supports_tools = true on their own row and buy
-- back exactly the silent prose-instead-of-tool-call this column exists to
-- prevent. Both policies are otherwise byte-identical to their previous
-- definitions (20260817000700 for insert, 20260817002300 for update).

drop policy custom_models_insert_own on public.custom_models;

create policy custom_models_insert_own on public.custom_models
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status in ('draft', 'validating')
    and upstream_endpoint_ref is null
    and runpod_template_id is null
    and runpod_workers_min = 0
    and runpod_idle_timeout = 30
    -- Solver output columns must be empty on creator insert.
    and gpu_tier_id is null
    and measured_tokens_per_second is null
    and max_concurrent_streams is null
    and placement_rationale is null
    -- Measured at provisioning by the service role, never asserted by a creator.
    and supports_tools is null
  );

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
    and supports_tools     is not distinct from
                             (select m.supports_tools     from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
  );

-- ============================================================================
-- gateway_resolve: carry the flag. Additive — one more jsonb key on the same
-- envelope; every existing key keeps its name, type and meaning. Otherwise
-- identical to 20260817002300.
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
         m.max_concurrent_streams, m.variant_files, m.supports_tools
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
    -- NULL stays NULL through jsonb: "unknown" must not collapse to false.
    'supportsTools',        v_model.supports_tools,
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
