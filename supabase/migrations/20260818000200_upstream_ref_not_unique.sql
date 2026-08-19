-- ============================================================================
-- 20260818000200_upstream_ref_not_unique.sql
--
-- DROP UNIQUE (upstream_endpoint_ref).
--
-- Found by deploying two models through Creator Studio, not by reading the
-- schema. The second deployment failed with:
--
--   duplicate key value violates unique constraint
--   "custom_models_upstream_endpoint_ref_key"
--
-- The constraint arrived as `runpod_endpoint_id text unique` in
-- 20260817000700, where it was reasonable: RunPod's model was one provisioned
-- endpoint per model, so two models sharing an endpoint id meant a
-- provisioning bug. Both halves of that premise are now false.
--
-- 1. MODAL, which is what MVP-0 actually serves from, has no per-model
--    resource at all. `upstream_endpoint_ref` holds a QUERY STRING that
--    selects an autoscaled container pool for a (repo, file, ctx_size,
--    parallel) tuple (tools/modal/README.md, and the column's own comment
--    since 20260817002300). Two creators deploying the same variant of the
--    same public repo at the same context window SHOULD land on one pool —
--    that is the design, not a collision. Under this constraint the second of
--    them cannot deploy at all, and the failure names a Postgres index rather
--    than anything a creator could act on.
--
-- 2. RUNPOD, per CONTRACTS.md §Environment, is "MVP-0: one manually
--    provisioned endpoint" — a single RUNPOD_ENDPOINT_ID shared by every
--    model. So the constraint forbids the exact topology the frozen
--    environment contract specifies. Reproduced: the first model to deploy
--    takes the id and every later one is rejected.
--
-- The column is documented as an OPAQUE, PROVIDER-SHAPED REFERENCE that only
-- the upstream-URL builder may interpret. A reference is not an identity, and
-- uniqueness was asserting it was one.
--
-- Nothing depended on the uniqueness: `gateway_resolve` looks the model up by
-- (creator handle, slug) and reads this column as an output. The lookup index
-- (`custom_models_upstream_ref_idx`) is a plain index and is untouched, so
-- finding every model on a given pool — the one real reason to query this
-- column — still works, and now returns the several rows it should.
-- ============================================================================

alter table public.custom_models
  drop constraint if exists custom_models_upstream_endpoint_ref_key;

comment on column public.custom_models.upstream_endpoint_ref is
  'OPAQUE, provider-shaped reference to the container pool serving this model. '
  'Only the upstream-URL builder may interpret it. RunPod: an endpoint id used '
  'as a URL path segment. Modal (MVP-0): a URL query string selecting the pool '
  '(model_repo, model_file, ctx_size, parallel), appended verbatim. The gateway '
  'must never parse, validate, or pattern-match it. ENVIRONMENT-SPECIFIC: it '
  'changes on every redeploy of the upstream worker and is not a constant. '
  'DELIBERATELY NOT UNIQUE (20260818000200): pools are SHARED. On Modal the same '
  '(repo, file, ctx, parallel) tuple is one pool no matter how many models point '
  'at it, and on RunPod MVP-0 runs every model through a single manually '
  'provisioned endpoint.';

-- Asserted, because a re-added unique index would break the second deployment
-- of any repo and the error would name an index rather than a cause.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.custom_models'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) like '%upstream_endpoint_ref%')
  then
    raise exception 'upstream_endpoint_ref is unique again; see 20260818000200 for why it must not be';
  end if;
end $$;
