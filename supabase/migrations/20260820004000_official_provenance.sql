-- ============================================================================
-- 20260820004000_official_provenance.sql
--
-- Phase 7 of the marketplace discovery plan (GitHub #30). Builds on #24
-- (`base_models`) and #23 (Hugging Face sign-in).
--
-- ── What this answers ───────────────────────────────────────────────────────
-- "Is this listing served by the people who own the weights upstream, or by
-- somebody else?" Both answers are legitimate. A marketplace where every model
-- is served by its author is a marketplace with six models in it; third-party
-- hosting is the normal, healthy case and the schema treats it as the DEFAULT,
-- not as a deficiency.
--
-- ── What a badge is NOT allowed to become ──────────────────────────────────
-- Hugging Face OAuth proves control of an HF ACCOUNT. It does not prove
-- authorship of the weights: any member of an org can push a repo they did not
-- train, and an org can be joined. That is good enough to put a word on a card
-- and NOT good enough for anything with money attached, so:
--
--   * the badge NEVER gates the right to list — nothing in this file touches
--     `visibility`, `status`, or either creator RLS policy on `custom_models`;
--   * the badge NEVER feeds a price, a rank or a payout — `listing_is_official`
--     is not referenced by `gateway_resolve`, by any settlement RPC, or by any
--     ORDER BY in components/marketplace/queries.ts. The pgTAP suite
--     (08_official_badge_test.sql) asserts the first half of that, and it is
--     the tripwire for anyone who tries the second.
--
-- The gate that actually governs earning is #29 (licence acknowledgement), and
-- it is deliberately a different mechanism reading different columns.
-- ============================================================================

-- ── An immutable "every element is an HF namespace" predicate ──────────────
-- A CHECK expression may not contain a subquery, and there is no array operator
-- for "every element matches this regex" — so the `unnest` has to happen inside
-- a function. `coalesce(..., true)` because `bool_and` over the empty set is
-- NULL, and an empty org list is valid rather than unknown.
--
-- The NULL-element case is NOT handled here: `v ~ …` is NULL for a NULL element
-- and `bool_and` swallows it. The caller pairs this with an explicit
-- `array_position(orgs, null) is null`, the same guard `base_models` uses on
-- `use_cases` and for the same reason.
create or replace function public.hf_namespaces_valid(p_values text[])
returns boolean
language sql immutable parallel safe strict
as $$
  select coalesce(bool_and(v ~ '^[a-z0-9][a-z0-9._-]{0,62}$'), true)
    from unnest(p_values) v
$$;

comment on function public.hf_namespaces_valid(text[]) is
  'True when every element is a syntactically valid, lowercased Hugging Face '
  'namespace. Exists because a CHECK cannot hold a subquery and no operator '
  'expresses "all elements match". Does NOT reject a NULL element — pair it '
  'with array_position(…, null) is null.';

revoke all on function public.hf_namespaces_valid(text[]) from public;
grant execute on function public.hf_namespaces_valid(text[])
  to anon, authenticated, service_role;

-- ============================================================================
-- hf_identities — the DERIVED facts of a Hugging Face sign-in
-- ============================================================================
-- One row per platform user who has signed in through `custom:huggingface`.
--
-- ── Why derived facts and not a token ──────────────────────────────────────
-- The obvious design is to keep the HF access token and ask the Hub at read
-- time. It does not work here, for a reason recorded when HF login shipped
-- (#23, bean ca-uquk): `session.provider_token` EXISTS ONLY ON THE RESPONSE TO
-- THE CODE EXCHANGE and does not survive a session refresh. It is not a
-- credential this platform holds; it is a value that passes through
-- `/auth/callback` once. So the callback reads the userinfo endpoint with it,
-- writes the two facts a badge needs — the username, and the orgs — and the
-- token is never persisted and never logged (CONTRACTS.md §Environment).
--
-- The cost of that choice is staleness: leaving an org does not clear the row
-- until the next sign-in. That is the correct trade for a badge. It would NOT
-- be the correct trade for an authorization decision, which is the other reason
-- this must never gate anything.
create table public.hf_identities (
  -- The platform user. PK as well as FK: one HF identity per account, and the
  -- row IS the link, so there is nothing to have two of.
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- HF's stable subject id. The username can be renamed on the Hub and the
  -- `sub` cannot, so this is what identifies the account across a rename — the
  -- username below is a LABEL that happens to also be the namespace.
  hf_sub text not null check (char_length(hf_sub) between 1 and 200),

  -- `preferred_username` from the userinfo response, lowercased.
  --
  -- Lowercased at write time rather than compared case-insensitively at read
  -- time, because the comparison happens once per catalog row and the
  -- normalization happens once per sign-in. HF usernames are case-preserving
  -- and case-insensitive for addressing: `JonathanColetti` and
  -- `jonathancoletti` are the same account and the same namespace.
  username text not null
    check (username ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),

  -- The `preferred_username` of every org the account belongs to, lowercased.
  -- Empty is the honest default: the `read-memberships` scope is optional, and
  -- an app that was never granted it sees no orgs at all rather than an error.
  -- An empty array therefore means "no orgs KNOWN", never "no orgs" — which is
  -- exactly why it can only ever cost a badge, never grant one.
  orgs text[] not null default '{}',

  -- Whether the userinfo response actually carried the memberships list. Splits
  -- "this account is in no orgs" from "we were never allowed to look", which is
  -- the difference between a correct third-party state and a missing scope in
  -- the dashboard. Support needs it; the badge rule does not read it.
  memberships_readable boolean not null default false,

  linked_at timestamptz not null default now(),
  -- Bumped on every sign-in, so a stale row is visible as a stale row.
  refreshed_at timestamptz not null default now(),

  constraint hf_identities_orgs_shaped check (
    array_position(orgs, null) is null
    and public.hf_namespaces_valid(orgs)
  )
);

comment on table public.hf_identities is
  'Derived facts of a Hugging Face sign-in: the account username and its org '
  'usernames, both lowercased. NOT a credential store — the HF access token is '
  'read once in /auth/callback and never persisted (session.provider_token does '
  'not survive a refresh, see #23). Feeds the `official` badge and NOTHING with '
  'money attached.';

comment on column public.hf_identities.orgs is
  'Org usernames, lowercased. Empty means "none known", which includes "the '
  'read-memberships scope was never granted" — so it can only ever cost a '
  'badge, never grant one.';

comment on column public.hf_identities.memberships_readable is
  'True when the userinfo response carried the memberships list at all. '
  'Separates "in no orgs" from "not allowed to look" for support; the badge '
  'rule does not read it.';

-- No `tg_set_updated_at` trigger and no `updated_at` column. `refreshed_at` is
-- not a row-modification timestamp — it is a claim about WHEN THE HUB WAS LAST
-- ASKED, which only the callback knows. A trigger that bumped it on any write
-- would let an unrelated backfill make a stale org list look fresh.

-- The badge oracle below looks up by `user_id`, which is the PK. This index
-- serves the other direction: "which platform account claims this HF
-- namespace", the question an operator asks when two accounts both claim one.
create index hf_identities_username_idx on public.hf_identities (username);
create index hf_identities_orgs_idx on public.hf_identities using gin (orgs);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.hf_identities enable row level security;

-- A creator may READ their own link — the Studio has to be able to say "linked
-- as @you", and a badge nobody can explain is worse than no badge.
create policy hf_identities_select_own on public.hf_identities
  for select to authenticated
  using (user_id = auth.uid());

-- NO client INSERT/UPDATE/DELETE policy, and this one is load-bearing rather
-- than tidy. Every column here is an ASSERTION ABOUT AN EXTERNAL ACCOUNT. A
-- creator who could write `orgs` could type `qwen` into it and wear the badge of
-- a lab they have nothing to do with; a creator who could write `username` could
-- do the same one column over. The values are only worth anything because the
-- only writer is the callback, holding a token HF just issued.
--
-- There is deliberately no SECURITY DEFINER "link me" RPC either: an RPC that
-- takes the org list as an argument is the same forgery with extra steps. The
-- org list must come from the Hub, in the same request that proved the sign-in.

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Nothing is auto-exposed (see 20260817001600), so the table grant is what
-- makes the policy above matter at all.
--
-- NOT granted to `anon`, and that is a real decision rather than caution: an
-- anonymous reader must be able to see the BADGE and must not be able to
-- enumerate which orgs a creator belongs to. Those are different facts, and the
-- boolean oracle below is what separates them.
grant select on public.hf_identities to authenticated;
grant select, insert, update, delete on public.hf_identities to service_role;

-- ============================================================================
-- listing_is_official — the badge, as a PostgREST computed column
-- ============================================================================
-- Signature `f(public.custom_models) returns boolean`, which PostgREST exposes
-- as a virtual column: `select=id,slug,listing_is_official`. That shape is what
-- lets the catalog read the badge in the SAME indexed query as the rest of the
-- card, instead of a second round trip per row or a client-side join.
--
-- ── Why derived and not materialized ───────────────────────────────────────
-- The alternative is a stored `official_at` on `custom_models`, written by a
-- background pass. It needs a writer that fires on THREE unrelated events — a
-- listing being created, a listing being grouped to a base model (#25), and a
-- creator linking or re-linking HF — and any one of them missed leaves a badge
-- that is silently wrong. Derived costs one lookup per rendered row and cannot
-- be stale.
--
-- ── Why SECURITY DEFINER ───────────────────────────────────────────────────
-- Same reason as `base_model_visible_to` one migration over: the predicate has
-- to read a table the caller must NOT be able to read. `hf_identities` is not
-- granted to `anon` at all, so an invoker-rights function would return false for
-- every anonymous visitor — i.e. the badge would exist only for the signed-in.
-- The function returns one boolean about a row the caller already holds the id
-- of; it reveals nothing about WHICH namespace matched and cannot enumerate.
--
-- ── Why it re-reads the row it was handed ──────────────────────────────────
-- A composite-argument function is callable directly with a HAND-BUILT row:
-- `select public.listing_is_official(row(...)::public.custom_models)`. Trusting
-- the passed `user_id` and `hf_repo_slug` would turn this into an oracle for
-- guessing a creator's org list one call at a time. So only `m.id` is trusted,
-- and every fact the rule reads is fetched from the table under that id. A
-- fabricated row names no real listing and gets `false`.
create or replace function public.listing_is_official(m public.custom_models)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.custom_models c
      join public.hf_identities i on i.user_id = c.user_id
      left join public.base_models b on b.id = c.base_model_id
     where c.id = m.id
       and (
         -- ── The rule, in one place ──────────────────────────────────────
         -- The creator's verified HF namespaces are their username plus their
         -- orgs. A listing is official when that set contains the owner of the
         -- repository it serves.
         --
         -- TWO repositories can be the upstream, and both count:
         --
         --   1. `hf_repo_slug` — the repo this listing actually deploys. This
         --      is what "upstream" means everywhere else in this codebase
         --      (`upstream_endpoint_ref`, lib/studio/server/upstream.ts), and
         --      it is present on every row from the moment it is drafted.
         --
         --   2. `base_models.slug` — the publisher of the WEIGHTS, once the
         --      listing is grouped (#25 writes the pointer). This covers the
         --      lab that serves its own weights through a quantization repo
         --      under a different namespace, which the first check alone
         --      would call third-party.
         --
         -- OR rather than AND, because each is sufficient on its own and
         -- neither is available in every state: requiring both would mean no
         -- listing can be official until the cascade has grouped it.
         lower(split_part(c.hf_repo_slug, '/', 1)) = any (
           array[i.username] || i.orgs
         )
         or (
           b.slug is not null
           and split_part(b.slug, '/', 1) = any (array[i.username] || i.orgs)
         )
       )
  );
$$;

comment on function public.listing_is_official(public.custom_models) is
  'True when the creator''s verified Hugging Face namespaces (username + orgs) '
  'contain the owner of the repo this listing serves, or the publisher of the '
  'base model it is grouped to. False is the NEUTRAL third-party state, not a '
  'demerit. Exposed as a PostgREST computed column. MUST NEVER feed a price, a '
  'rank or a payout: HF OAuth proves control of an account, not authorship of '
  'weights (#30). SECURITY DEFINER because hf_identities is not readable by '
  'anon; only m.id is trusted from the argument, so a hand-built row is inert.';

revoke all on function public.listing_is_official(public.custom_models) from public;
grant execute on function public.listing_is_official(public.custom_models)
  to anon, authenticated, service_role;
