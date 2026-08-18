-- ============================================================================
-- 20260817002100_profiles_update_allowlist.sql
--
-- BUG 3 (P2): `authenticated` could rewrite lifetime_earnings_micro_usd,
-- lifetime_spend_micro_usd, and stripe_customer_id on its own profile.
--
-- PRD §5.2's profiles_update_own is a DENYLIST: it names six columns that must
-- not change and implicitly permits everything else. That is the wrong polarity
-- for a security check. It was already incomplete when written — it never
-- covered the two lifetime_* counters or stripe_customer_id — and it silently
-- widens every time a column is added to the table. stripe_customer_id is
-- UNIQUE, so squatting another user's `cus_…` id permanently denies them their
-- Stripe linkage; lifetime_earnings drives payout reporting.
--
-- Fix: invert to an ALLOWLIST. Compare the whole proposed row against the stored
-- row as jsonb, with only the genuinely user-editable columns masked out. Any
-- column added to profiles in future is protected by default and must be
-- explicitly named here to become editable — the failure mode of forgetting is
-- now "my new column is read-only", not "anyone can write my money column".
--
-- updated_at is masked because the BEFORE UPDATE trigger sets it before WITH
-- CHECK runs, so it always differs; it is not user-supplied.
-- ============================================================================
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (to_jsonb(profiles) - 'display_name' - 'avatar_url' - 'bio' - 'updated_at')
        = (select to_jsonb(p) - 'display_name' - 'avatar_url' - 'bio' - 'updated_at'
             from public.profiles p where p.id = auth.uid())
  );

comment on policy profiles_update_own on public.profiles is
  'ALLOWLIST, not a denylist: display_name, avatar_url and bio are the only '
  'columns a user may change. Every other column — present or future — must be '
  'byte-identical to the stored row. To make a new column user-editable you must '
  'add it to the mask here; forgetting leaves it read-only, which is the safe '
  'direction to fail.';

-- Defense in depth: even with the policy, the table-wide UPDATE grant let a
-- client name any column in a SET clause. Narrow the privilege to match the
-- policy, so an attempt on a money column is refused by the privilege layer
-- before RLS is consulted.
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url, bio) on public.profiles to authenticated;
