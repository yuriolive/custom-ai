-- ============================================================================
-- 20260817001600_grants.sql
--
-- NOT IN THE PRD. Supabase CLI >= 2.10 (and the current cloud default) no longer
-- auto-exposes newly created public entities to the Data API roles: with
-- `auto_expose_new_tables` unset, anon / authenticated / service_role receive NO
-- privileges on anything created above. RLS would then be irrelevant because the
-- table grant fails first.
--
-- Granting explicitly is also the safer posture: the privilege grant states the
-- intended verb set per role, and RLS narrows it to rows. FR-DB-002 is enforced
-- twice — no client role is granted INSERT/UPDATE/DELETE on any financial table,
-- and no such policy exists either.
-- ============================================================================

-- ── service_role: the Edge Function identity. BYPASSRLS; the RPCs are the
--    intended entry point, but the gateway also reads these tables directly. ──
grant select, insert, update, delete on
  public.profiles, public.api_keys, public.gpu_tiers, public.solver_config,
  public.custom_models, public.usage_transactions, public.wallet_ledger,
  public.creator_earnings
  to service_role;

grant usage, select on sequence
  public.wallet_ledger_id_seq, public.creator_earnings_id_seq
  to service_role;

-- ── authenticated: reads are row-filtered by RLS; writes exist only where a
--    policy above defines them (profiles/api_keys/custom_models). ─────────────
grant select on
  public.profiles, public.api_keys, public.gpu_tiers, public.solver_config,
  public.custom_models, public.usage_transactions, public.wallet_ledger,
  public.creator_earnings
  to authenticated;

grant update on public.profiles      to authenticated;   -- profiles_update_own
grant update, delete on public.api_keys to authenticated; -- api_keys_update_own / _delete_own
grant insert, update on public.custom_models to authenticated; -- custom_models_insert_own / _update_own

-- ── anon: the public catalog only. Every other table stays unreachable at the
--    privilege layer, so a leaked anon key cannot even attempt a read. ────────
grant select on public.custom_models to anon;   -- custom_models_select_public

-- No grants of any kind to anon on profiles, api_keys, usage_transactions,
-- wallet_ledger, creator_earnings, gpu_tiers, or solver_config.
