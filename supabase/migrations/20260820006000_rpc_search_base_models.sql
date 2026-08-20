-- ============================================================================
-- 20260820006000_rpc_search_base_models.sql
--
-- Phase 5 of the marketplace discovery plan (GitHub #28), layer B. Stacks on
-- 20260820000100_base_models.sql (the `embedding` column and the closed
-- `use_cases` vocabulary) and on 20260820001000_rpc_catalog_grouped.sql (the
-- grouped catalog this mirrors).
--
-- ── What this adds ──────────────────────────────────────────────────────────
-- `catalog_grouped` searches ONE WAY: a prefix `tsquery` over the listing's and
-- the base model's `search_vector`. That answers "which model is called this",
-- and a shopper asks "which model is FOR this" — a query like `write unit tests`
-- shares no lexeme with `Qwen3 8B`, so lexical search answers it with nothing.
--
-- This function fuses two retrieval arms over the SAME visible set:
--
--   * the LEXICAL arm — the prefix tsquery the catalog already runs, plus the
--     creator-handle fragment (FR-MKT-003);
--   * the SEMANTIC arm — cosine distance against `base_models.embedding`,
--     written at DEPLOY time by the `embed` Edge Function (gte-small, 384 dims,
--     `public.embedding_dimension()`).
--
-- ── Why RRF and not a weighted sum ──────────────────────────────────────────
-- `ts_rank` is an unbounded relevance score whose scale depends on the document
-- and the normalization flags; cosine distance is a bounded [0,2] metric. They
-- are not on a comparable scale, so `w * ts_rank + (1-w) * (1 - distance)` needs
-- a `w` that nobody can defend and that silently changes meaning the moment a
-- corpus grows. Reciprocal Rank Fusion throws the SCORES away and keeps only the
-- RANKS:
--
--     score(d) = Σ_arms 1 / (k + rank_arm(d))          k = 60
--
-- which is scale-free by construction, needs no tuning, and degrades gracefully
-- when one arm returns nothing at all (the sum is over the arms that ranked the
-- document, and a document only one arm found still scores). k = 60 is the
-- constant from Cormack et al. 2009, and it is here rather than inline for the
-- same reason `embedding_dimension()` is: a magic number that appears in the RPC
-- and again in every test is a number that drifts.
--
-- ── Why it is not merged in JavaScript ──────────────────────────────────────
-- Merging two arms client-side means fetching BOTH ARMS IN FULL — otherwise the
-- merge is over two truncated lists and the fused ranking is wrong — and then
-- paginating a list the database cannot count. That breaks both rules at the
-- head of components/marketplace/queries.ts at once: it is filtering in
-- JavaScript, and it makes the result count in the UI a lie.
--
-- ── Why it is a SECOND function and not a parameter on catalog_grouped ──────
-- Adding a parameter to an existing function that has defaults creates an
-- OVERLOAD rather than a replacement (`create or replace` matches on the
-- argument list), so the only in-place route is drop-and-recreate — which means
-- restating all 495 lines of 20260820001000 in this file, in a branch that does
-- not own it. This function is therefore `catalog_grouped` with the search
-- predicate replaced by the fusion below and one extra sort, and the honest
-- follow-up once #26 and #27 have landed is to converge the two into one
-- function with a `p_embedding` parameter.
--
-- Until then the drift is guarded rather than hoped about: with no query and no
-- embedding this function is REQUIRED to return the same group set as
-- `catalog_grouped`, and supabase/tests/09_search_rrf_test.sql asserts exactly
-- that. A visibility rule added to one and not the other fails that assertion.
-- ============================================================================

-- ── k, in ONE place ─────────────────────────────────────────────────────────
-- Same discipline as `public.embedding_dimension()`. The RPC reads it, the pgTAP
-- file reads it, and a change to the fusion constant is one edit rather than a
-- grep.
create or replace function public.search_rrf_k()
returns integer
language sql immutable parallel safe
as $$ select 60 $$;

comment on function public.search_rrf_k() is
  'The k of Reciprocal Rank Fusion, 1/(k + rank), from Cormack et al. 2009. A '
  'larger k flattens the contribution of the top ranks; 60 is the published '
  'default and there is no evidence in this corpus to move it. Single source of '
  'truth for the RPC and for pgTAP.';

revoke all on function public.search_rrf_k() from public;
grant execute on function public.search_rrf_k() to anon, authenticated, service_role;

-- ── The RPC ─────────────────────────────────────────────────────────────────
-- The return envelope is KEY-FOR-KEY the envelope `catalog_grouped` returns, so
-- `mapGroup` / `mapCounts` in components/marketplace/queries.ts serve both and a
-- search result is the same card as a catalog card. Rule 2 at the head of that
-- file applies unchanged: the `jsonb_build_object` at the bottom IS the security
-- boundary, and nothing hardware-shaped is on it.
create or replace function public.search_base_models(
  -- Free text, pre-tokenized by `toPrefixTsQuery`. Re-validated below, so a
  -- hand-edited `?q=` degrades to "no lexical arm" instead of raising 42601.
  p_ts_query        text      default null,
  -- The query embedding, from the `embed` Edge Function. Declared WITHOUT a
  -- typmod on purpose: a `vector(384)` parameter rejects a wrong-width value
  -- with an error, and this is the front door — a stale client embedding at the
  -- wrong dimension must degrade to a lexical-only search, not 500 the catalog.
  -- The width is checked below against `public.embedding_dimension()`.
  p_embedding       extensions.vector default null,
  p_handle_fragment text      default null,
  -- One value from the closed `use_cases` vocabulary, or NULL for the `All` tab.
  p_use_case        text      default null,
  p_min_speed       integer   default null,
  p_min_context     integer   default null,
  p_quality_key     text      default null,
  p_price_key       text      default null,
  p_creator         text      default null,
  -- `relevance` is the fused RRF order and is meaningful only under a search;
  -- with no arms it falls back to `newest`, which is what an unsorted catalog is.
  p_sort            text      default 'relevance',
  p_limit           integer   default 24,
  p_offset          integer   default 0,
  -- How deep each arm is read before fusion. NOT the page size: RRF needs a
  -- ranked list per arm, and a document the vector arm places 40th can still win
  -- the fusion. Kept small because the fused set is also the pagination
  -- universe — everything past it is not reachable by paging, which is the
  -- honest trade a top-k retrieval makes and is why the catalog, not this
  -- function, is the browse surface.
  p_arm_limit       integer   default 50,
  -- Cosine-distance ceiling on the semantic arm: 0.22, i.e. cosine SIMILARITY of
  -- at least 0.78.
  --
  -- This is not a fusion weight wearing a hat. A vector index has no notion of
  -- "no match" — `order by embedding <=> q limit k` returns k rows for the empty
  -- query, for a typo, and for a sentence in a language the model has never
  -- seen. Without a ceiling the semantic arm is not a retrieval at all: it is a
  -- re-sort of the entire catalog, and typing three characters would return
  -- every model the platform has, reordered. RRF's objection is to trading two
  -- INCOMPARABLE SCORES off against each other with an undefendable weight; a
  -- per-arm recall cutoff is a property of one arm and is checkable against that
  -- arm alone.
  --
  -- 0.78 is gte-small's own number (Supabase's pgvector guide uses it for this
  -- exact model), and it is a property of the MODEL, not of this catalog: a
  -- different embedding model has a different similarity distribution and needs
  -- a different ceiling. That is the same swap that changes
  -- `embedding_dimension()`, which is why both are named rather than inlined.
  p_max_distance    double precision default 0.22,
  -- The rail's definition, exactly as `catalog_grouped` takes it. The quality
  -- ladder and the price bands live ONCE, in components/marketplace/format.ts.
  p_speed_steps     integer[] default '{}',
  p_context_steps   integer[] default '{}',
  p_quality_rungs   jsonb     default '[]'::jsonb,
  p_price_rungs     jsonb     default '[]'::jsonb
) returns jsonb
language sql
stable
-- SECURITY INVOKER, exactly as `catalog_grouped`: RLS stays the floor under the
-- function's own predicates. `extensions` is NOT on this search_path — the
-- cosine operator is written as `OPERATOR(extensions.<=>)` instead, which is the
-- same operator (so the HNSW index still serves it) without widening what an
-- unqualified name in this body can resolve to.
set search_path = public, pg_temp
as $$
with args as (
  select
    -- Kept in sync with `toPrefixTsQuery`, whose output this pattern describes
    -- exactly. See 20260820001000 for why the shape is re-checked here.
    case
      when p_ts_query ~ '^[a-z0-9._/-]+:\*(&[a-z0-9._/-]+:\*)*$' then p_ts_query
    end as ts_query,
    case
      when p_handle_fragment ~ '^[a-z0-9-]{2,40}$' then p_handle_fragment
    end as handle_fragment,
    -- A wrong-width embedding is DROPPED, not raised on. The width can only be
    -- wrong if the embedding model changed under a cached client, which is a
    -- transient every deploy of a new model has; answering it with the lexical
    -- arm is strictly better than answering it with an error page.
    case
      when p_embedding is not null
       and extensions.vector_dims(p_embedding) = public.embedding_dimension()
      then p_embedding
    end as q_embedding,
    case
      when p_sort in ('relevance', 'newest', 'speed', 'tokens', 'price', 'latency')
      then p_sort
      else 'relevance'
    end as sort,
    least(greatest(coalesce(p_limit, 24), 1), 100) as lim,
    greatest(coalesce(p_offset, 0), 0) as off,
    least(greatest(coalesce(p_arm_limit, 50), 1), 500) as arm_lim,
    -- Clamped to the range cosine distance actually occupies. A caller asking
    -- for 2 is asking for "rank everything", which is a legitimate thing to want
    -- from a test or a diagnostic and is not a legitimate default.
    least(greatest(coalesce(p_max_distance, 0.22), 0), 2) as max_distance,
    public.search_rrf_k() as k
),
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
price_rung as (
  select
    r->>'key' as key,
    nullif(r->>'min', '')::bigint as min_micro,
    nullif(r->>'max', '')::bigint as max_micro
  from jsonb_array_elements(p_price_rungs) r
),
-- ════════════════════════════════════════════════════════════════════════════
-- THE VISIBILITY PREDICATE — BYTE-IDENTICAL TO catalog_grouped's
--
-- Both retrieval arms read from this CTE and from nothing else, which is what
-- the issue means by "both arms stay filtered by the same visibility/status/
-- deleted_at predicates the catalog already applies". A vector arm that ranked
-- over `base_models` directly would happily surface a model whose only listing
-- is a private draft, a suspended listing or a soft-deleted one — RLS would not
-- catch it, because `base_models_select_public` admits a base model that ANY
-- public listing serves, and `custom_models_select_own` ORs a creator's own
-- rows back in for a signed-in creator.
--
-- Keep this block in step with `visible_listing` in 20260820001000. pgTAP
-- asserts the two functions agree on the group set; that assertion is the thing
-- that makes "keep in step" enforceable rather than aspirational.
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
    c.handle       as creator_handle,
    c.display_name as creator_display_name
  from public.custom_models m
  join public.creator_public c on c.id = m.user_id
  where m.visibility = 'public'
    and m.status = 'ready'
    and m.deleted_at is null
    and m.suspended_at is null
),
-- Every visible listing, with its base model and its group key. Same grouping
-- rule as the catalog: an unresolved listing is its OWN group of one.
listing_base as (
  select
    v.*,
    b.id              as base_id,
    b.slug            as base_slug,
    b.display_name    as base_display_name,
    b.summary         as base_summary,
    b.family          as base_family,
    b.parameter_count as base_parameter_count,
    b.search_vector   as base_search_vector,
    b.embedding       as base_embedding,
    coalesce(b.use_cases, '{}'::text[]) as use_cases,
    coalesce(b.id::text, 'listing:' || v.id::text) as group_key
  from visible_listing v
  left join public.base_models b on b.id = v.base_model_id
),
-- ── ARM 1: LEXICAL ──────────────────────────────────────────────────────────
-- The catalog's own predicate, aggregated to the GROUP: a group matches if the
-- base model's text matches, if any of its visible listings' text matches, or if
-- it is served by a creator whose handle contains the fragment (FR-MKT-003).
--
-- The arm's ORDER is `ts_rank` descending. A handle-only match has no lexeme in
-- either vector, so it ranks 0 and lands at the tail of this arm — present, and
-- therefore fusable, but never ahead of a model that actually matched the words.
lexical as (
  select
    l.group_key,
    row_number() over (order by l.rank desc, l.group_key) as rn
  from (
    select
      lb.group_key,
      max(
        greatest(
          case when a.ts_query is not null
               then ts_rank(lb.listing_search_vector, to_tsquery('english', a.ts_query))
               else 0 end,
          case when a.ts_query is not null and lb.base_search_vector is not null
               then ts_rank(lb.base_search_vector, to_tsquery('english', a.ts_query))
               else 0 end
        )
      ) as rank
    from listing_base lb
    cross join args a
    where (a.ts_query is not null or a.handle_fragment is not null)
      and (
        (a.ts_query is not null
         and (lb.listing_search_vector @@ to_tsquery('english', a.ts_query)
              or lb.base_search_vector @@ to_tsquery('english', a.ts_query)))
        or (a.handle_fragment is not null
            and lb.creator_handle like '%' || a.handle_fragment || '%')
      )
    group by lb.group_key
  ) l
  limit (select arm_lim from args)
),
-- ── ARM 2: SEMANTIC ─────────────────────────────────────────────────────────
-- Cosine distance against the deploy-time embedding. `OPERATOR(extensions.<=>)`
-- rather than a bare `<=>`: the operator lives in the `extensions` schema and
-- this function's search_path deliberately does not include it. It is the same
-- operator, so `base_models_embedding_idx` (HNSW, vector_cosine_ops) still
-- serves the ORDER BY.
--
-- Only a RESOLVED group can be here. An unresolved listing has no base model,
-- therefore no embedding, therefore no semantic rank — it is reachable
-- lexically and not otherwise, which is one more thing the resolution cascade
-- (#25) buys. Rows whose embedding is still NULL (not yet embedded) are skipped
-- for the same reason rather than sorted as "distance NULL", which would put
-- every unembedded model at the top of the arm.
--
-- The distance is computed over the VISIBLE set and truncated afterwards, so the
-- arm is exact rather than approximate — which also means the HNSW index does
-- not serve this shape today. That is the right trade at a catalog of this size
-- and it is the only order that is correct: an index-served
-- `order by embedding <=> q limit k` over `base_models` would spend its k slots
-- on models whose only listing is private, suspended or deleted, and hand back a
-- short arm with the visible models filtered out AFTER the cut.
semantic as (
  select
    s.group_key,
    row_number() over (order by s.distance, s.group_key) as rn
  from (
    select
      lb.group_key,
      min(lb.base_embedding OPERATOR(extensions.<=>) a.q_embedding) as distance
    from listing_base lb
    cross join args a
    where a.q_embedding is not null
      and lb.base_embedding is not null
      and (lb.base_embedding OPERATOR(extensions.<=>) a.q_embedding) <= a.max_distance
    group by lb.group_key
  ) s
  limit (select arm_lim from args)
),
-- ── THE FUSION ──────────────────────────────────────────────────────────────
-- A FULL OUTER JOIN, because the whole point is that a document found by only
-- one arm still scores: the semantic-only hit is the case the issue names ("a
-- query that matches nothing lexically but matches semantically returns the
-- right model"), and the lexical-only hit is every exact model name.
--
-- `numeric`, not `double precision`: the fused score is compared for equality in
-- pgTAP, and two orderings that differ in the 17th bit of a float are not a
-- ranking anyone can assert on.
fused as (
  select
    coalesce(l.group_key, s.group_key) as group_key,
    l.rn as fts_rank,
    s.rn as vector_rank,
    coalesce(1.0 / ((select k from args) + l.rn), 0)
      + coalesce(1.0 / ((select k from args) + s.rn), 0) as rrf_score
  from lexical l
  full outer join semantic s on s.group_key = l.group_key
),
-- ── The filtered set every aggregation below reads ──────────────────────────
-- Identical in shape to `listing` in `catalog_grouped`: free text is a WHERE
-- (here, membership of the fused set), the facets are per-row FLAGS so each
-- facet's own count can be computed with that facet excluded.
listing as (
  select
    lb.*,
    f.rrf_score,
    f.fts_rank,
    f.vector_rank,
    (p_min_speed is null or lb.measured_tokens_per_second >= p_min_speed) as f_speed,
    (p_min_context is null or lb.context_length >= p_min_context) as f_context,
    (p_quality_key is null or exists (
      select 1 from quality_rung q
      where q.key = p_quality_key
        and ((q.native and lb.variant_quant_tag is null)
             or lb.variant_quant_tag = any (q.tags))
    )) as f_quality,
    (p_price_key is null or exists (
      select 1 from price_rung r
      where r.key = p_price_key
        and (r.min_micro is null
             or lb.price_completion_micro_usd_per_mtoken > r.min_micro)
        and (r.max_micro is null
             or lb.price_completion_micro_usd_per_mtoken <= r.max_micro)
    )) as f_price,
    (p_creator is null or lb.creator_handle = p_creator) as f_creator,
    (p_use_case is null or p_use_case = any (lb.use_cases)) as f_category
  from listing_base lb
  cross join args a
  -- The search predicate. "No search at all" is EVERY arm being absent, for the
  -- same reason the catalog spells it out: `?q=--` yields no tsquery tokens but a
  -- legal handle fragment, and a query that survives one sanitizer and not the
  -- other must not be answered with the entire catalog.
  left join fused f on f.group_key = lb.group_key
  where (a.ts_query is null and a.handle_fragment is null and a.q_embedding is null)
     or f.group_key is not null
),
matching as (
  select * from listing
  where f_speed and f_context and f_quality and f_price and f_creator and f_category
),
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
    max(measured_tokens_per_second)   as best_tokens_per_second,
    max(context_length)               as best_context_length,
    (array_agg(context_verified order by context_length desc, id))[1]
                                      as best_context_verified,
    sum(total_requests)               as total_requests,
    sum(total_completion_tokens)      as total_completion_tokens,
    min(p50_ttft_ms)                  as best_p50_ttft_ms,
    max(created_at)                   as newest_created_at,
    -- One row per group carries the fused score; max() is a picker, not a sum.
    max(rrf_score)                    as rrf_score,
    min(fts_rank)                     as fts_rank,
    min(vector_rank)                  as vector_rank
  from matching
  group by group_key
),
ranked as (
  select
    g.*,
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
      order by
        -- `relevance` is the fused order. With no arms every score is NULL, so
        -- this collapses and `newest` below carries the ordering — which is why
        -- an unsearched call through this function is the catalog, in catalog
        -- order.
        case when a.sort = 'relevance' then g.rrf_score              end desc nulls last,
        case when a.sort = 'speed'     then g.best_tokens_per_second end desc nulls last,
        case when a.sort = 'tokens'    then g.total_completion_tokens end desc nulls last,
        case when a.sort = 'price'     then q.price_completion_micro_usd_per_mtoken
                                                                     end asc  nulls last,
        case when a.sort = 'latency'   then g.best_p50_ttft_ms       end asc  nulls last,
        case when a.sort in ('relevance', 'newest')
                                       then g.newest_created_at      end desc nulls last,
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
facet_creator as (
  select l.creator_handle as key, count(distinct l.group_key) as n
  from listing l
  where l.f_speed and l.f_context and l.f_quality and l.f_price and l.f_category
  group by l.creator_handle
),
-- The counted use-case tabs — LAYER A, and the layer that improves discovery
-- today. Counted with the category facet excluded, so the `code` tab's number
-- and the total that tab returns when selected are the same set by construction.
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
      'group_key',      p.group_key,
      'base_model_id',  p.base_id,
      'base_slug',      p.base_slug,
      'display_name',   coalesce(p.base_display_name, p.quoted_display_name),
      'description',    coalesce(p.base_summary, p.quoted_description),
      'family',         p.base_family,
      'parameter_count', p.base_parameter_count,
      'use_cases',      to_jsonb(p.use_cases),
      'listing_count',  p.listing_count,
      'creator_count',  p.creator_count,
      'best_tokens_per_second', p.best_tokens_per_second,
      'best_context_length',    p.best_context_length,
      'best_context_verified',  p.best_context_verified,
      'total_requests',         p.total_requests,
      'total_completion_tokens', p.total_completion_tokens,
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
      'ready_at',        p.quoted_ready_at,
      -- ── Retrieval diagnostics ─────────────────────────────────────────────
      -- Which arm found this, and where. They are on the envelope because a
      -- fused ranking nobody can inspect is a ranking nobody can debug — and
      -- because pgTAP asserts on them. `mapGroup` in queries.ts does NOT map
      -- them, so they never reach the RSC payload: the projection there is the
      -- second boundary, exactly as rule 2 describes.
      'rrf_score',       p.rrf_score,
      'fts_rank',        p.fts_rank,
      'vector_rank',     p.vector_rank
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

comment on function public.search_base_models(
  text, extensions.vector, text, text, integer, integer, text, text, text, text,
  integer, integer, integer, double precision, integer[], integer[], jsonb, jsonb
) is
  'Hybrid retrieval over the public catalog (#28): a prefix-FTS arm and a cosine '
  'arm over base_models.embedding, fused by Reciprocal Rank Fusion at '
  'k = search_rrf_k(), in one round trip. Both arms read the SAME visible set, '
  'so neither can surface a private, suspended or soft-deleted listing. Returns '
  'the same envelope as catalog_grouped — same keys, same grouping rule, same '
  'counts — and with no query and no embedding it is REQUIRED to return the same '
  'groups as catalog_grouped; 09_search_rrf_test.sql asserts that so the two '
  'visibility blocks cannot drift.';

revoke all on function public.search_base_models(
  text, extensions.vector, text, text, integer, integer, text, text, text, text,
  integer, integer, integer, double precision, integer[], integer[], jsonb, jsonb
) from public;

grant execute on function public.search_base_models(
  text, extensions.vector, text, text, integer, integer, text, text, text, text,
  integer, integer, integer, double precision, integer[], integer[], jsonb, jsonb
) to anon, authenticated, service_role;

-- ── The write side: one base model's embedding ──────────────────────────────
-- Written at DEPLOY time, per BASE MODEL, never per listing — six quantizations
-- embedded six times cost six times as much and put six near-duplicate vectors
-- in the top-k, crowding every other model out of the arm.
--
-- A function rather than a bare UPDATE from the Edge Function for two reasons:
-- the width is checked in ONE place against `embedding_dimension()` (a 1536-wide
-- vector from a swapped model fails here rather than landing in a column whose
-- typmod silently rejects it later), and `service_role` is the only grantee, so
-- the write path is named and auditable rather than being "whatever holds the
-- key". SECURITY INVOKER: service_role already bypasses RLS, and a definer
-- function would hand the same power to any future grantee.
create or replace function public.set_base_model_embedding(
  p_base_model_id uuid,
  p_embedding     extensions.vector
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_embedding is not null
     and extensions.vector_dims(p_embedding) <> public.embedding_dimension() then
    raise exception
      'embedding width % does not match embedding_dimension() = %',
      extensions.vector_dims(p_embedding), public.embedding_dimension()
      using errcode = '22000';
  end if;

  update public.base_models
     set embedding = p_embedding
   where id = p_base_model_id;
end;
$$;

comment on function public.set_base_model_embedding(uuid, extensions.vector) is
  'Deploy-time write of a base model''s gte-small embedding (#28). Rejects a '
  'wrong-width vector loudly — a silent wrong width is a model that never ranks '
  'in the semantic arm and no error anywhere. service_role only.';

revoke all on function public.set_base_model_embedding(uuid, extensions.vector) from public;
grant execute on function public.set_base_model_embedding(uuid, extensions.vector)
  to service_role;
