-- ============================================================================
-- 20260820001000_rpc_catalog_grouped.sql
--
-- Phase 3 of the marketplace discovery plan (GitHub #26). Stacks on
-- 20260820000100_base_models.sql, which added the pointer this groups on.
--
-- ── The defect ──────────────────────────────────────────────────────────────
-- The catalog card is a DEPLOYMENT. Six quantizations of Qwen3-8B draw six
-- unrelated cards; the quality facet DELETES cards instead of picking a variant
-- inside one (a model whose cheapest listing is Q4 vanishes when you ask for
-- `maximum`, even when the same creator serves a Q8 of it); and two creators
-- serving identical weights render as two cards a shopper diffs by eye.
--
-- `catalog_grouped` is the read side of the fix: one round trip that groups
-- listings by `base_model_id`, aggregates each group, ranks and pages the
-- groups, AND returns the counts the category tabs and the facet rail render.
-- All of it server-side, which is rule 1 at the head of
-- components/marketplace/queries.ts: filtering in JavaScript would mean shipping
-- every public listing to every visitor and would make every count in the UI a
-- lie.
--
-- ── Why one function and not five ───────────────────────────────────────────
-- The tab counts have to MATCH THE ROWS THE TAB RETURNS — that is the issue's
-- acceptance criterion, and it only holds if the counts and the page come out of
-- the same filtered set in the same snapshot. Two round trips can disagree
-- (a listing goes ready between them) and the disagreement is visible: `Code 11`
-- above a grid of 10. So `listing` below is computed once and every count, the
-- page, and the total are aggregations of that one CTE.
--
-- ── SECURITY INVOKER, deliberately ──────────────────────────────────────────
-- No `security definer`. The predicates in `visible_listing` are the query
-- actually asking for the public catalog, and RLS underneath is the floor that
-- still holds if this function is ever wrong: `custom_models_select_public`
-- admits public+ready+unsuspended rows only, and `base_models_select_public`
-- admits a base model only when something serves it publicly. A definer function
-- would be faster (it would skip `base_model_visible_to` per base row, which
-- cannot inline) and would make this file the ONLY thing standing between anon
-- and every private draft on the platform. That trade is not worth making at a
-- catalog size where the oracle runs once per base model on the page.
--
-- ── Where the ladder lives ──────────────────────────────────────────────────
-- The quality ladder (tag -> tier) and the price bands are defined ONCE, in
-- components/marketplace/format.ts, and passed in as `p_quality_rungs` /
-- `p_price_rungs`. Restating them in SQL would create a second catalog of the
-- same constants — exactly the failure mode CLAUDE.md documents for the two GPU
-- tier lists, where a change landing in one silently makes the two disagree.
-- The caller passes the rail's DEFINITION; `p_quality_key` / `p_price_key` are
-- keys into it.
-- ============================================================================

-- ── The projection, and why it is a jsonb builder and not `returns table` ───
-- `returns table (...)` would have to name ~30 columns twice (signature and
-- body) and would still not express "and here are the facet counts". A single
-- `jsonb` return keeps the projection in ONE place — the `jsonb_build_object`
-- at the bottom — which is rule 2 at the head of queries.ts: the projection is
-- the security boundary. Nothing hardware-shaped is on it. There is no
-- `gpu_tier_id`, no `predicted_tokens_per_second`, no `placement_rationale`, no
-- `upstream_endpoint_ref`; a developer shops on throughput, context, quality and
-- price, and which silicon delivers that is the platform's problem (FR-MKT-002).
create or replace function public.catalog_grouped(
  -- Free text, pre-tokenized by `toPrefixTsQuery` in queries.ts. Validated
  -- again below, so a malformed value degrades to "no search" instead of
  -- raising 42601 on the front page.
  p_ts_query        text      default null,
  -- Handle-shaped fragment for the creator-handle arm of search. Separate from
  -- p_ts_query because handles live on `profiles`, not in any search_vector.
  p_handle_fragment text      default null,
  p_min_speed       integer   default null,
  p_min_context     integer   default null,
  p_quality_key     text      default null,
  p_price_key       text      default null,
  p_creator         text      default null,
  -- One value from the `use_cases` vocabulary, or NULL for the `All` tab.
  p_category        text      default null,
  p_sort            text      default 'newest',
  p_limit           integer   default 24,
  p_offset          integer   default 0,
  -- The rail's definition. See "Where the ladder lives" above.
  p_speed_steps     integer[] default '{}',
  p_context_steps   integer[] default '{}',
  p_quality_rungs   jsonb     default '[]'::jsonb,
  p_price_rungs     jsonb     default '[]'::jsonb
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
with args as (
  select
    -- A prefix tsquery and nothing else. `to_tsquery` raises on a syntax error,
    -- and this function is called by the catalog front page, so the shape is
    -- re-checked here rather than trusted from the caller: a hand-edited
    -- `?q=` must not be able to 500 the front door. Kept in sync with
    -- `toPrefixTsQuery`, whose output this pattern describes exactly.
    case
      when p_ts_query ~ '^[a-z0-9._/-]+:\*(&[a-z0-9._/-]+:\*)*$' then p_ts_query
    end as ts_query,
    case
      when p_handle_fragment ~ '^[a-z0-9-]{2,40}$' then p_handle_fragment
    end as handle_fragment,
    -- An unknown sort is `newest`, not an error and not an unordered page.
    case
      when p_sort in ('newest', 'speed', 'tokens', 'price', 'latency') then p_sort
      else 'newest'
    end as sort,
    least(greatest(coalesce(p_limit, 24), 1), 100) as lim,
    greatest(coalesce(p_offset, 0), 0) as off
),
-- The quality ladder, unpacked from the caller's definition. `native` means
-- "this rung also matches a NULL tag" — NULL is the unquantized reference, and
-- an `IN` list cannot express it. Only `full` sets it.
quality_rung as (
  select
    r->>'key' as key,
    coalesce(
      (select array_agg(t) from jsonb_array_elements_text(r->'tags') t),
      '{}'::text[]
    ) as tags,
    coalesce((r->>'native')::boolean, false) as native
  from jsonb_array_elements(p_quality_rungs) r
),
-- Price bands. `min` is EXCLUSIVE and `max` INCLUSIVE, matching the bands the
-- catalog has always used: budget <= 500000 < standard <= 2000000 < premium.
price_rung as (
  select
    r->>'key' as key,
    nullif(r->>'min', '')::bigint as min_micro,
    nullif(r->>'max', '')::bigint as max_micro
  from jsonb_array_elements(p_price_rungs) r
),
-- ════════════════════════════════════════════════════════════════════════════
-- THE VISIBILITY PREDICATE — ONE PLACE, AND IT IS ADDITIVE
--
-- Every "is this listing in the public catalog at all" rule lives in this CTE
-- and nowhere else in this function. A new rule (an operator suspension scope,
-- a licence gate, a region block) is ONE `and` here, not a rewrite of the six
-- aggregations below, which read `listing` and never re-derive visibility.
--
-- These predicates are NOT redundant with RLS. `custom_models` has TWO select
-- policies and Postgres ORs them: a signed-in creator also matches
-- `custom_models_select_own`, which admits their own rows in ANY status. Without
-- this block, a creator browsing the catalog would see their own drafts and
-- failed deployments grouped in as though they were public — and, worse, would
-- see them counted on the tabs. RLS is the floor that stops anonymous visitors
-- reading private rows; this is the query asking for the public catalog.
--
-- `suspended_at is null` is load-bearing and is #31's hook: an operator-
-- suspended listing leaves the catalog, leaves its group's aggregates, and
-- leaves every count, in one predicate.
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
    m.search_vector as listing_search_vector,
    -- `creator_public`, not `profiles`: a SECURITY DEFINER view whose column
    -- list is itself a boundary (20260817001900), and the only way to read a
    -- handle as `anon`. An inner join, so a listing whose creator is suspended
    -- (the view filters `is_suspended = false`) has no public identity, no
    -- addressable `creator/slug` id, and is not listed.
    c.handle       as creator_handle,
    c.display_name as creator_display_name
  from public.custom_models m
  join public.creator_public c on c.id = m.user_id
  where m.visibility = 'public'
    and m.status = 'ready'
    and m.deleted_at is null
    and m.suspended_at is null
),
-- ── The one filtered set every aggregation below reads ──────────────────────
-- Free text is a WHERE (it is not a facet and gets no count); the five facets
-- are carried as per-row FLAGS instead, because a facet's own count has to be
-- computed with that facet EXCLUDED. Counting `Maximum` under an active
-- `Maximum` filter would report the count of the thing you already chose and
-- zero for everything else — the rail would go dead after the first click.
listing as (
  select
    v.*,
    b.id              as base_id,
    b.slug            as base_slug,
    b.display_name    as base_display_name,
    b.summary         as base_summary,
    b.family          as base_family,
    b.parameter_count as base_parameter_count,
    coalesce(b.use_cases, '{}'::text[]) as use_cases,
    -- THE GROUPING KEY. An unresolved listing (`base_model_id is null`, the
    -- normal state until #25's cascade runs) is its OWN group of one — never
    -- folded in with every other unresolved listing, which is what grouping on
    -- a bare NULL would do: one card called "12 listings" containing twelve
    -- unrelated models.
    coalesce(b.id::text, 'listing:' || v.id::text) as group_key,
    (p_min_speed is null or v.measured_tokens_per_second >= p_min_speed) as f_speed,
    (p_min_context is null or v.context_length >= p_min_context) as f_context,
    (p_quality_key is null or exists (
      select 1 from quality_rung q
      where q.key = p_quality_key
        and ((q.native and v.variant_quant_tag is null)
             or v.variant_quant_tag = any (q.tags))
    )) as f_quality,
    (p_price_key is null or exists (
      select 1 from price_rung r
      where r.key = p_price_key
        and (r.min_micro is null
             or v.price_completion_micro_usd_per_mtoken > r.min_micro)
        and (r.max_micro is null
             or v.price_completion_micro_usd_per_mtoken <= r.max_micro)
    )) as f_price,
    (p_creator is null or v.creator_handle = p_creator) as f_creator,
    (p_category is null or p_category = any (coalesce(b.use_cases, '{}'::text[])))
      as f_category
  from visible_listing v
  left join public.base_models b on b.id = v.base_model_id
  cross join args a
  where a.ts_query is null
     or v.listing_search_vector @@ to_tsquery('english', a.ts_query)
     -- The base model's OWN text, so searching "qwen" finds a listing whose
     -- slug says nothing about the weights it serves.
     or b.search_vector @@ to_tsquery('english', a.ts_query)
     -- FR-MKT-003 requires search to cover the creator handle. It is a plain
     -- `like` on an already-narrowed set rather than the id round trip
     -- queries.ts needs, because inside one query the join is already here.
     or (a.handle_fragment is not null
         and v.creator_handle like '%' || a.handle_fragment || '%')
),
-- Listings that clear EVERY active facet. Aggregates come from this set, not
-- from the whole group: with `Maximum` selected, "from $0.12" must be a price
-- you can actually pay at maximum quality, not the group's Q4 price.
matching as (
  select * from listing
  where f_speed and f_context and f_quality and f_price and f_creator and f_category
),
-- ── The QUOTED listing ─────────────────────────────────────────────────────
-- The card shows a group but links to, and copies the id of, exactly one
-- listing: the cheapest one that matches. That is what makes the `from` price
-- honest — the price on the card belongs to the page the card opens. With a
-- quality facet active this is the cheapest listing AT THAT QUALITY, which is
-- the whole point of the facet filtering within a group instead of deleting it.
quoted as (
  select distinct on (group_key) *
  from matching
  order by group_key, price_completion_micro_usd_per_mtoken, id
),
grouped as (
  select
    group_key,
    count(*)                          as listing_count,
    count(distinct user_id)           as creator_count,
    -- BEST case, and labelled as such in the UI. An unlabelled max reads as a
    -- promise the median listing does not keep.
    max(measured_tokens_per_second)   as best_tokens_per_second,
    max(context_length)               as best_context_length,
    -- The verified flag OF THE LISTING THAT REACHES that context — not
    -- `bool_or`, which would let a verified 8k listing vouch for an unverified
    -- 262k one in the same group.
    (array_agg(context_verified order by context_length desc, id))[1]
                                      as best_context_verified,
    sum(total_requests)               as total_requests,
    sum(total_completion_tokens)      as total_completion_tokens,
    -- Lowest measured TTFT in the group. NULL sorts last below: an unmeasured
    -- model is not the fastest one.
    min(p50_ttft_ms)                  as best_p50_ttft_ms,
    max(created_at)                   as newest_created_at
  from matching
  group by group_key
),
ranked as (
  select
    g.group_key,
    g.listing_count, g.creator_count,
    g.best_tokens_per_second, g.best_context_length, g.best_context_verified,
    g.total_requests, g.total_completion_tokens,
    q.id                as quoted_id,
    q.slug              as quoted_slug,
    q.display_name      as quoted_display_name,
    q.description       as quoted_description,
    q.variant_quant_tag as quoted_quant_tag,
    q.measured_tokens_per_second as quoted_tokens_per_second,
    q.context_length             as quoted_context_length,
    q.price_prompt_micro_usd_per_mtoken     as quoted_price_prompt_micro,
    q.price_completion_micro_usd_per_mtoken as quoted_price_completion_micro,
    q.p50_ttft_ms       as quoted_p50_ttft_ms,
    q.created_at        as quoted_created_at,
    q.ready_at          as quoted_ready_at,
    q.creator_handle, q.creator_display_name,
    q.base_id, q.base_slug, q.base_display_name, q.base_summary,
    q.base_family, q.base_parameter_count, q.use_cases,
    row_number() over (
      -- One CASE per sort: only the active one is non-NULL, so the rest
      -- collapse to no-ops. A single expression cannot do this because the
      -- five sorts have three different types and two different directions.
      order by
        case when a.sort = 'speed'   then g.best_tokens_per_second   end desc nulls last,
        case when a.sort = 'tokens'  then g.total_completion_tokens  end desc nulls last,
        case when a.sort = 'price'   then q.price_completion_micro_usd_per_mtoken
                                                                     end asc  nulls last,
        case when a.sort = 'latency' then g.best_p50_ttft_ms         end asc  nulls last,
        case when a.sort = 'newest'  then g.newest_created_at        end desc nulls last,
        -- Deterministic tiebreak. Without it two equal groups can swap places
        -- between page 1 and page 2, and one of them is never shown at all.
        g.group_key
    ) as rn
  from grouped g
  join quoted q using (group_key)
  cross join args a
),
page_row as (
  select r.* from ranked r cross join args a
  where r.rn > a.off and r.rn <= a.off + a.lim
),
-- ── Facet counts: each rung counted with ITS OWN facet excluded ─────────────
-- Standard drill-down semantics — AND across facets, OR within one. The count
-- beside `120+ tok/s` answers "how many models would I still have if I asked
-- for this too", which is the only question a rail count can usefully answer.
facet_speed as (
  select s.step, count(distinct l.group_key) as n
  from unnest(p_speed_steps) as s(step)
  left join listing l
    on l.f_context and l.f_quality and l.f_price and l.f_creator and l.f_category
   and l.measured_tokens_per_second >= s.step
  group by s.step
),
facet_context as (
  select s.step, count(distinct l.group_key) as n
  from unnest(p_context_steps) as s(step)
  left join listing l
    on l.f_speed and l.f_quality and l.f_price and l.f_creator and l.f_category
   and l.context_length >= s.step
  group by s.step
),
facet_quality as (
  select q.key, count(distinct l.group_key) as n
  from quality_rung q
  left join listing l
    on l.f_speed and l.f_context and l.f_price and l.f_creator and l.f_category
   and ((q.native and l.variant_quant_tag is null)
        or l.variant_quant_tag = any (q.tags))
  group by q.key
),
facet_price as (
  select r.key, count(distinct l.group_key) as n
  from price_rung r
  left join listing l
    on l.f_speed and l.f_context and l.f_quality and l.f_creator and l.f_category
   and (r.min_micro is null
        or l.price_completion_micro_usd_per_mtoken > r.min_micro)
   and (r.max_micro is null
        or l.price_completion_micro_usd_per_mtoken <= r.max_micro)
  group by r.key
),
-- The creator rung list is DATA, not a parameter: the rail offers the handles
-- that are actually in the catalog.
facet_creator as (
  select l.creator_handle as key, count(distinct l.group_key) as n
  from listing l
  where l.f_speed and l.f_context and l.f_quality and l.f_price and l.f_category
  group by l.creator_handle
),
-- ── Category tabs ──────────────────────────────────────────────────────────
-- `category_all` is the `All` tab and `category_one` the rest, both with the
-- category facet excluded. That is what makes the acceptance criterion hold:
-- with `?use=code` active, `total` below counts groups matching every facet
-- INCLUDING category, and the `code` tab count counts groups matching every
-- other facet plus `code` — the same set, so the tab count and the row count
-- agree by construction rather than by coincidence.
--
-- A listing with no base model contributes to `All` and to no category: an
-- unresolved listing genuinely has no known use cases, and inventing one would
-- put it under a tab whose rows it does not belong in.
category_one as (
  select uc as key, count(distinct l.group_key) as n
  from listing l
  cross join unnest(l.use_cases) as uc
  where l.f_speed and l.f_context and l.f_quality and l.f_price and l.f_creator
  group by uc
),
category_all as (
  select count(distinct l.group_key) as n
  from listing l
  where l.f_speed and l.f_context and l.f_quality and l.f_price and l.f_creator
)
select jsonb_build_object(
  'total', (select count(*) from grouped),
  'page_size', (select lim from args),
  'offset', (select off from args),
  'groups', coalesce((
    select jsonb_agg(jsonb_build_object(
      -- ── Group identity ──────────────────────────────────────────────────
      'group_key',      p.group_key,
      'base_model_id',  p.base_id,
      -- `publisher/name`, and the first segment is the WEIGHTS publisher. It is
      -- NOT a platform handle and NOT an addressable model id — the provenance
      -- line is the whole reason it is here: without it a creator who did
      -- nothing but run a deploy reads as the author of the model.
      'base_slug',      p.base_slug,
      'display_name',   coalesce(p.base_display_name, p.quoted_display_name),
      'description',    coalesce(p.base_summary, p.quoted_description),
      'family',         p.base_family,
      'parameter_count', p.base_parameter_count,
      'use_cases',      to_jsonb(p.use_cases),
      -- ── Aggregates over the MATCHING listings. Every one is a best case and
      -- every one is labelled as such in the card. ────────────────────────
      'listing_count',  p.listing_count,
      'creator_count',  p.creator_count,
      'best_tokens_per_second', p.best_tokens_per_second,
      'best_context_length',    p.best_context_length,
      'best_context_verified',  p.best_context_verified,
      'total_requests',         p.total_requests,
      'total_completion_tokens', p.total_completion_tokens,
      -- ── The quoted listing: what the card links to, copies, and prices ──
      'listing_id',      p.quoted_id,
      'creator_handle',  p.creator_handle,
      'creator_display_name', p.creator_display_name,
      'slug',            p.quoted_slug,
      'quant_tag',       p.quoted_quant_tag,
      'price_prompt_micro',     p.quoted_price_prompt_micro,
      'price_completion_micro', p.quoted_price_completion_micro,
      'quoted_tokens_per_second', p.quoted_tokens_per_second,
      'quoted_context_length',    p.quoted_context_length,
      'p50_ttft_ms',     p.quoted_p50_ttft_ms,
      'created_at',      p.quoted_created_at,
      'ready_at',        p.quoted_ready_at
    ) order by p.rn)
    from page_row p
  ), '[]'::jsonb),
  'categories', jsonb_build_object(
    'all', (select n from category_all),
    'by_key', coalesce((
      select jsonb_object_agg(key, n) from category_one
    ), '{}'::jsonb)
  ),
  'facets', jsonb_build_object(
    'speed',   coalesce((select jsonb_object_agg(step::text, n) from facet_speed), '{}'::jsonb),
    'context', coalesce((select jsonb_object_agg(step::text, n) from facet_context), '{}'::jsonb),
    'quality', coalesce((select jsonb_object_agg(key, n) from facet_quality), '{}'::jsonb),
    'price',   coalesce((select jsonb_object_agg(key, n) from facet_price), '{}'::jsonb),
    'creator', coalesce((select jsonb_object_agg(key, n) from facet_creator), '{}'::jsonb)
  )
);
$$;

comment on function public.catalog_grouped(
  text, text, integer, integer, text, text, text, text, text, integer, integer,
  integer[], integer[], jsonb, jsonb
) is
  'The public catalog, grouped by base model (#26). One round trip: grouping, '
  'filtering, aggregation, ranking, paging, facet counts and category counts, '
  'all from one filtered CTE so a tab count cannot disagree with the rows that '
  'tab returns. SECURITY INVOKER on purpose — RLS stays the floor; the '
  'predicates in visible_listing are the query asking for the PUBLIC catalog, '
  'which RLS alone does not express for a signed-in creator. THE '
  'jsonb_build_object AT THE BOTTOM IS THE SECURITY BOUNDARY: nothing '
  'hardware-shaped is on it, and it is handed straight to a "use client" '
  'component, i.e. into the RSC payload.';

-- `anon` and `authenticated` both call this: the catalog is readable signed out
-- and the same page serves a signed-in visitor. `service_role` for parity with
-- every other function here.
revoke all on function public.catalog_grouped(
  text, text, integer, integer, text, text, text, text, text, integer, integer,
  integer[], integer[], jsonb, jsonb
) from public;

grant execute on function public.catalog_grouped(
  text, text, integer, integer, text, text, text, text, text, integer, integer,
  integer[], integer[], jsonb, jsonb
) to anon, authenticated, service_role;

-- ── The index the grouping actually needs ───────────────────────────────────
-- `custom_models_base_model_idx` (20260820000100) is partial on
-- `base_model_id is not null`, so it does not serve the catalog scan, which
-- starts from the visibility predicate and reaches base_model_id second. This
-- one covers the whole of `visible_listing`: the three-column equality prefix is
-- the predicate, and `base_model_id` rides along so the group key comes off the
-- index instead of the heap.
create index if not exists custom_models_catalog_group_idx
  on public.custom_models (visibility, status, base_model_id)
  where deleted_at is null and suspended_at is null;

comment on index public.custom_models_catalog_group_idx is
  'Serves catalog_grouped (#26). Partial on the same NULL checks the function '
  'applies, so the index IS the public catalog; keep it in step with the '
  'visibility block in catalog_grouped.';
