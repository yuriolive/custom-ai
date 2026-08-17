-- ============================================================================
-- 20260817001900_creator_public_definer.sql
--
-- Fixes the defect reported against PRD §5.2: `creator_public` was created
-- `with (security_invoker = true)` over `profiles`, whose only SELECT policy is
-- `id = auth.uid()`. Under invoker semantics the "public creator identity" view
-- showed a signed-in user nothing but themselves, and failed outright for anon,
-- which holds no privilege on profiles at all.
--
-- Resolution: definer semantics. The alternative — a `profiles_select_public`
-- RLS policy — is the wrong tool, because RLS is ROW-level: a policy that admits
-- a row admits every column of it, including balance_micro_usd and
-- earnings_micro_usd. A definer view exposes exactly its projection.
-- ============================================================================

alter view public.creator_public reset (security_invoker);

comment on view public.creator_public is
  'Public creator identity for the catalog. SECURITY DEFINER by design: it reads '
  'profiles with the view owner''s rights, bypassing profiles RLS. '
  'THE COLUMN LIST IS THE SECURITY BOUNDARY. It is the only thing standing '
  'between anon and the wallet columns of every profile on the platform. Adding a '
  'column here publishes it to the anonymous internet — do not widen it without a '
  'deliberate review, and never with `select *`. Row filter: is_suspended = false.';

-- Unchanged, restated so the intended audience is visible next to the decision.
grant select on public.creator_public to anon, authenticated;
