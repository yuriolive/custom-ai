-- ============================================================================
-- 20260820005000_rpc_model_page.sql
--
-- Phase 4 of the marketplace discovery plan (GitHub #27). Stacks on
-- 20260820000100_base_models.sql (the grouping pointer and the licence columns)
-- and on 20260820001000_rpc_catalog_grouped.sql, whose visibility block and
-- projection discipline this file copies deliberately.
--
-- ── The defect ──────────────────────────────────────────────────────────────
-- `/models/[creator]/[slug]` describes ONE DEPLOYMENT. Three creators serving
-- the same weights at three prices are three pages a shopper has to open in
-- three tabs and diff by eye, which is the one thing a marketplace exists not to
-- make them do. The model page is where price competition becomes visible, and
-- it cannot become visible one listing at a time.
--
-- `model_page` returns the whole model behind one listing URL: the listing the
-- visitor asked for, the base model it serves, that model's parent, and EVERY
-- visible listing of the same model as an offer.
--
-- ── Why one round trip and not four ─────────────────────────────────────────
-- Same reason as `catalog_grouped`, one step sharper. The offer table is a
-- COMPARISON: its rows are only comparable if they come out of one snapshot. Two
-- round trips can disagree — a listing goes `ready`, or gets suspended, between
-- them — and the disagreement is not a missing row, it is a price column that
-- does not add up against a `from` figure computed a moment earlier. Grouping,
-- the anchor, the lineage and the cap all read the same CTE here.
--
-- ── SECURITY INVOKER, deliberately ──────────────────────────────────────────
-- No `security definer`, for the reason spelled out at length in
-- 20260820001000: the predicates in `visible_listing` are the query asking for
-- the PUBLIC catalog (which RLS alone does not express for a signed-in creator,
-- because `custom_models_select_own` ORs their own drafts back in), and RLS
-- underneath stays the floor that holds if this function is ever wrong. The
-- lineage read is the one place that leans on a definer function, and it is not
-- this one: `base_model_visible_to` (20260820000100) is what admits a parent row
-- whose own listings are private, and it returns a boolean and nothing else.
--
-- ── What is NOT here ────────────────────────────────────────────────────────
-- No licence GATE. Whether a `conditional` or `unknown` licence may publish at
-- all is #29's decision and lives on the write path; this function is a read and
-- reports what the columns say. It also does not touch `gateway_resolve`, the
-- addressable id, or any money column.
-- ============================================================================

-- ── The projection, and why it is a jsonb builder ───────────────────────────
-- Rule 2 at the head of components/marketplace/queries.ts: the projection is the
-- security boundary, and this return value is handed to a `"use client"`
-- component, i.e. straight into the RSC payload in the browser. Every key is
-- listed by hand at the bottom of this file and NOTHING HARDWARE-SHAPED IS ON
-- IT — no `gpu_tier_id`, no `predicted_tokens_per_second`, no
-- `placement_rationale`, no `upstream_endpoint_ref` (FR-MKT-002). A shopper
-- compares throughput, context, quality and price; which silicon delivers that
-- is the platform's problem.
--
-- A single `jsonb` rather than `returns table (...)` because the shape is a tree:
-- one listing, one model, one parent, N offers and a total. `returns table`
-- would flatten the model onto every offer row and re-ship the licence text once
-- per listing.
create or replace function public.model_page(
  -- The two segments of the addressable platform model id,
  -- `creator-handle/model-slug` (CONTRACTS.md, top). Both columns are lowercase
  -- by CHECK; the arguments are lowered here as well so a mixed-case URL — the
  -- friendly half of the model-id trap, see the note in the page's
  -- `readParams` — resolves instead of 404-ing.
  p_creator text,
  p_slug    text,
  -- Hard ceiling on the offer rows returned. NOT a page: there is no offer
  -- pagination and there should not be one at a catalog size where a model with
  -- more than a hundred listings does not exist. `offer_total` is returned
  -- unconditionally so the UI can say what it is not showing — a silent
  -- truncation on a price comparison reads as "these are all the offers".
  p_offer_limit integer default 100
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
with args as (
  select
    lower(btrim(p_creator)) as creator,
    lower(btrim(p_slug))    as slug,
    least(greatest(coalesce(p_offer_limit, 100), 1), 500) as lim
),
-- ════════════════════════════════════════════════════════════════════════════
-- THE VISIBILITY PREDICATE — ONE PLACE, AND IT IS ADDITIVE
--
-- Byte-for-byte the same four predicates as `visible_listing` in
-- `catalog_grouped`, and that is a requirement rather than a coincidence: a
-- listing that the catalog counts in a group must be an offer row on the page
-- that group links to, or the card says "3 listings" above a table of two.
-- A new rule (a region block, #29's licence gate) is one `and` in both places.
--
-- These predicates are NOT redundant with RLS. `custom_models` has TWO select
-- policies and Postgres ORs them, so a signed-in creator also matches
-- `custom_models_select_own`, which admits their own rows in ANY status.
-- Without this block a creator would see their own draft listed as an offer,
-- priced, beside the public ones — and would be the only person who could see
-- it, which is the worst version of the bug because it cannot be reproduced.
-- ════════════════════════════════════════════════════════════════════════════
visible_listing as (
  select
    m.id, m.user_id, m.slug, m.display_name, m.description,
    m.measured_tokens_per_second, m.context_length, m.context_verified,
    m.variant_quant_tag,
    m.price_prompt_micro_usd_per_mtoken,
    m.price_completion_micro_usd_per_mtoken,
    m.total_requests, m.total_prompt_tokens, m.total_completion_tokens,
    m.p50_ttft_ms, m.p95_ttft_ms, m.created_at, m.ready_at,
    m.base_model_id,
    -- `creator_public`, not `profiles`: a SECURITY DEFINER view whose column
    -- list is itself a boundary (20260817001900), and the only way to read a
    -- handle as `anon`. An inner join, so a listing whose creator is suspended
    -- has no public identity, therefore no addressable `creator/slug` id, and
    -- is neither the anchor nor an offer.
    c.handle       as creator_handle,
    c.display_name as creator_display_name
  from public.custom_models m
  join public.creator_public c on c.id = m.user_id
  where m.visibility = 'public'
    and m.status = 'ready'
    and m.deleted_at is null
    and m.suspended_at is null
),
-- ── The anchor: the listing whose URL this is ───────────────────────────────
-- Everything below hangs off this row, and the whole function returns NULL when
-- it is missing. ONE null for "no such model", "private", "not ready" and
-- "creator suspended": distinguishing them would tell an anonymous visitor that
-- a private model exists, which is the same reason the gateway answers 404 and
-- not 403 (CONTRACTS.md §Gateway wire contract).
anchor as (
  select v.*
  from visible_listing v
  cross join args a
  where v.creator_handle = a.creator
    and v.slug = a.slug
),
-- ── The offer set ──────────────────────────────────────────────────────────
-- Every visible listing of the SAME base model. An unresolved anchor
-- (`base_model_id is null`, the normal state until #25's cascade runs) is a
-- model of one — never joined to every other unresolved listing, which is what
-- matching on a bare NULL would do: one offer table pricing twelve unrelated
-- models against each other.
--
-- The anchor is always in this set: it is visible by construction, and it either
-- shares its own base model id or is the sole member. That matters because the
-- table marks one row as the listing being read, and a table whose highlighted
-- row is absent is a table the reader cannot place themselves in.
offer as (
  select v.*
  from visible_listing v
  cross join anchor an
  where (an.base_model_id is not null and v.base_model_id = an.base_model_id)
     or (an.base_model_id is null and v.id = an.id)
),
-- Cheapest-first, because that is the ordering a price comparison defaults to
-- and the one the cap should keep if it ever fires. The reader re-sorts on
-- whichever axis they care about, client-side, over this complete set — see the
-- header of components/marketplace/offers.ts for why that is presentation and
-- not the client-side filtering rule 1 forbids.
ranked_offer as (
  select
    o.*,
    row_number() over (
      order by o.price_completion_micro_usd_per_mtoken,
               o.price_prompt_micro_usd_per_mtoken,
               -- Deterministic tiebreak: two listings at one price must not
               -- swap places between two renders of the same page.
               o.id
    ) as rn
  from offer o
),
offer_page as (
  select r.*
  from ranked_offer r
  cross join args a
  cross join anchor an
  -- `or r.id = an.id` so the anchor survives the cap even when it is the
  -- dearest offer of a hundred. Its row is the one carrying the snippet, the
  -- price table and the measured figures further down the page.
  where r.rn <= a.lim or r.id = an.id
),
-- ── The model ──────────────────────────────────────────────────────────────
-- A left join, not an inner one: an unresolved listing has no base model and
-- still has a page. The UI renders that as "lineage not resolved yet", which is
-- a different sentence from "this model is an original" — see `lineage.ts`.
--
-- Columns are named rather than `b.*`: `base_models` holds a 384-float
-- `embedding` and a `search_vector`, and SELECT on the table is table-wide
-- (20260820000100 says so, and says to project for exactly this reason). Neither
-- is a secret, and both are a payload nobody asked for.
model as (
  select
    b.id, b.slug, b.display_name, b.summary, b.family, b.parameter_count,
    b.use_cases, b.parent_id,
    b.license_id, b.license_name, b.license_url, b.license_version,
    b.commercial_hosting
  from anchor an
  join public.base_models b on b.id = an.base_model_id
),
-- ── The parent (§1.2) ──────────────────────────────────────────────────────
-- A fine-tune is its own model WITH A PARENT, never a variant of the model it
-- was trained from, so the lineage link is a real row and not a string. Readable
-- because `base_models_select_public` admits a parent whose only public listings
-- belong to its children (`base_model_visible_to` reaches `parent_id`), which is
-- exactly the case that matters: `Qwen3-8B` may be served here only through
-- fine-tunes and still owes the attribution line.
parent as (
  select p.id, p.slug, p.display_name, p.family, p.parameter_count
  from model m
  join public.base_models p on p.id = m.parent_id
),
-- How many visible listings serve the PARENT itself. Load-bearing for honesty
-- rather than decoration: at zero, "based on Qwen3 8B" must not be a link, since
-- the only place it could go is a catalog search that returns nothing.
parent_listing_count as (
  select count(*) as n
  from visible_listing v
  cross join parent p
  where v.base_model_id = p.id
)
select jsonb_build_object(
  -- ── The listing this URL names. What the snippet, the price table and the
  -- measured figures below the offer table describe. ────────────────────────
  'listing', jsonb_build_object(
    'id',                an.id,
    'creator_handle',    an.creator_handle,
    'creator_display_name', an.creator_display_name,
    'slug',              an.slug,
    'display_name',      an.display_name,
    'description',       an.description,
    'measured_tokens_per_second', an.measured_tokens_per_second,
    'context_length',    an.context_length,
    'context_verified',  an.context_verified,
    'quant_tag',         an.variant_quant_tag,
    'price_prompt_micro',     an.price_prompt_micro_usd_per_mtoken,
    'price_completion_micro', an.price_completion_micro_usd_per_mtoken,
    'total_requests',         an.total_requests,
    'total_prompt_tokens',    an.total_prompt_tokens,
    'total_completion_tokens', an.total_completion_tokens,
    'p50_ttft_ms',       an.p50_ttft_ms,
    'p95_ttft_ms',       an.p95_ttft_ms,
    'created_at',        an.created_at,
    'ready_at',          an.ready_at
  ),
  -- ── The MODEL: what the page is titled with, and what the licence belongs
  -- to. Null until #25's cascade resolves one. ──────────────────────────────
  'model', (
    select jsonb_build_object(
      'id',              m.id,
      -- `publisher/name`. NOT a platform model id and NOT a Hugging Face repo
      -- path: its first segment is a weights publisher, not a creator handle,
      -- so pasting it as `model` is a 404. The page never offers it for copying.
      'slug',            m.slug,
      'display_name',    m.display_name,
      'summary',         m.summary,
      'family',          m.family,
      'parameter_count', m.parameter_count,
      'use_cases',       to_jsonb(m.use_cases),
      'parent_id',       m.parent_id,
      -- ── Licence (§5.1) ────────────────────────────────────────────────
      -- A property of the WEIGHTS, which is why it is on the model and not on
      -- the listing: a community re-quantization routinely carries `other` or
      -- omits the licence, and a permissive string on a quant repo does not
      -- relicense the weights underneath it. `commercial_hosting` is the field
      -- the notice keys off, because "may a third party serve this for money"
      -- is not a function of the SPDX id alone.
      'license_id',      m.license_id,
      'license_name',    m.license_name,
      'license_url',     m.license_url,
      'license_version', m.license_version,
      'commercial_hosting', m.commercial_hosting
    )
    from model m
  ),
  -- ── The parent, for the lineage link. ────────────────────────────────────
  'parent', (
    select jsonb_build_object(
      'id',              p.id,
      'slug',            p.slug,
      'display_name',    p.display_name,
      'family',          p.family,
      'parameter_count', p.parameter_count,
      'listing_count',   coalesce((select n from parent_listing_count), 0)
    )
    from parent p
  ),
  -- ── The offers. THE POINT OF THE PAGE. ──────────────────────────────────
  -- One row per visible listing of this model, each carrying its own
  -- addressable id (assembled in TypeScript from `creator_handle` and `slug`,
  -- the one place that construction happens), its own quality tag as
  -- DISCLOSURE — the tier is the label, the tag is the detail, as
  -- components/marketplace/format.ts rules — and its own two prices.
  'offers', coalesce((
    select jsonb_agg(jsonb_build_object(
      'listing_id',      o.id,
      'creator_handle',  o.creator_handle,
      'creator_display_name', o.creator_display_name,
      'slug',            o.slug,
      'display_name',    o.display_name,
      'quant_tag',       o.variant_quant_tag,
      'context_length',  o.context_length,
      'context_verified', o.context_verified,
      'measured_tokens_per_second', o.measured_tokens_per_second,
      'p50_ttft_ms',     o.p50_ttft_ms,
      'price_prompt_micro',     o.price_prompt_micro_usd_per_mtoken,
      'price_completion_micro', o.price_completion_micro_usd_per_mtoken,
      'total_requests',  o.total_requests,
      'total_completion_tokens', o.total_completion_tokens,
      'created_at',      o.created_at,
      'ready_at',        o.ready_at
    ) order by o.rn)
    from offer_page o
  ), '[]'::jsonb),
  -- Every offer that EXISTS, not every offer returned. The two differ only
  -- above the cap, and the UI says so when they do.
  'offer_total', (select count(*) from offer)
)
from anchor an;
$$;

comment on function public.model_page(text, text, integer) is
  'One model behind one listing URL (#27): the anchor listing, the base model it '
  'serves, that model''s parent for the lineage link, and every visible listing '
  'of the same model as an offer row. One round trip, because the offer table is '
  'a price comparison and its rows are only comparable inside one snapshot. '
  'SECURITY INVOKER on purpose — RLS stays the floor; the predicates in '
  'visible_listing are the query asking for the PUBLIC catalog, and they are '
  'byte-identical to catalog_grouped''s so a group''s listing count matches its '
  'offer table. THE jsonb_build_object AT THE BOTTOM IS THE SECURITY BOUNDARY: '
  'nothing hardware-shaped is on it, and it is handed to a "use client" '
  'component, i.e. into the RSC payload. Returns NULL for unknown, private, '
  'not-ready and creator-suspended alike.';

-- `anon` and `authenticated` both call this: a model page is readable signed out
-- and the same page serves a signed-in visitor. `service_role` for parity with
-- every other function here.
revoke all on function public.model_page(text, text, integer) from public;
grant execute on function public.model_page(text, text, integer)
  to anon, authenticated, service_role;

-- ── The index the offer set needs ───────────────────────────────────────────
-- `custom_models_catalog_group_idx` (20260820001000) leads on
-- `(visibility, status, base_model_id)`, which serves the catalog scan but not
-- this one: the offer set STARTS from a known `base_model_id` and reaches the
-- visibility predicate second, so the group key has to lead. Partial on the same
-- two NULL checks both functions apply, so the index is the public catalog.
create index if not exists custom_models_offer_set_idx
  on public.custom_models (base_model_id, visibility, status)
  where deleted_at is null and suspended_at is null;

comment on index public.custom_models_offer_set_idx is
  'Serves model_page''s offer set (#27), which probes base_model_id first — the '
  'reverse of catalog_grouped''s scan, hence a second index rather than a reuse. '
  'Keep the partial predicate in step with the visibility block in both '
  'functions.';
