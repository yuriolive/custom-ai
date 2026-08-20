-- ============================================================================
-- catalog_grouped — the catalog is a list of MODELS, not of deployments (#26).
--
-- Why this file exists at all: every claim the grouped card makes is an
-- aggregation, and an aggregation over the wrong set is not a bug you can see.
-- "3 listings · from $0.12 · 45 tok/s best" is four separate opportunities to
-- quote a number from a listing that is private, suspended, or excluded by the
-- filter the visitor is looking at. None of those show up as an error; they show
-- up as a price nobody can buy at.
--
-- Four things are tested, and they are different kinds of thing:
--
--   1. THE GROUPING. Three listings of one base model are one card. An
--      unresolved listing (base_model_id is null, the normal state until #25's
--      cascade runs) is its OWN card — grouping on a bare NULL would draw one
--      card called "12 listings" over twelve unrelated models.
--
--   2. THE BOUNDARY. The RPC is SECURITY INVOKER and its own visibility
--      predicates are what make it the PUBLIC catalog rather than "every row
--      the caller can see". The sharp case is a creator's own private listing:
--      RLS admits it (custom_models_select_own), so only the predicate keeps it
--      out — and the fixture below prices that private row at 1 micro-USD
--      precisely so a leak shows up as a wrong `from` price, not as a subtle
--      count.
--
--   3. THE QUALITY FACET'S NEW MEANING. It filters WITHIN a group. `maximum`
--      must keep a model whose cheapest listing is Q4 and quote its Q6 instead
--      of deleting the model. This is the behaviour change of the whole issue.
--
--   4. THE COUNTS. A tab that says `Code 11` above ten rows is worse than no
--      tab. The invariant asserted here is exact: for every category, the tab
--      count equals the total that same category returns when selected.
--
-- What is deliberately NOT tested here: money. No column, RPC or invariant on
-- the billing path is touched, and 01-06 own that ground.
-- ============================================================================
begin;
select plan(50);

\set creator_a '00000000-0000-0000-0000-0000000000a1'
\set creator_b '00000000-0000-0000-0000-0000000000b1'
\set base      '00000000-0000-0000-0000-0000000000e1'

-- ── The rail definition, exactly as components/marketplace/format.ts sends it ─
-- Abbreviated to the rungs this fixture exercises. The full ladder lives in
-- TypeScript on purpose (see the migration header): restating all six rungs here
-- would create a second copy of the constants to drift out of step.
\set quality_rungs '[{"key":"balanced","tags":["Q4_K_M","Q4_0"]},{"key":"high","tags":["Q5_K_M"]},{"key":"maximum","tags":["Q6_K","Q8_0"]},{"key":"full","tags":["F16","BF16","FP16"],"native":true}]'
\set price_rungs '[{"key":"budget","max":500000},{"key":"standard","min":500000,"max":2000000},{"key":"premium","min":2000000}]'

-- ════════════════════════════════════════════════════════════════════════════
-- 0. The plumbing
-- ════════════════════════════════════════════════════════════════════════════
select has_function('public', 'catalog_grouped',
  array['text', 'text', 'integer', 'integer', 'text', 'text', 'text', 'text',
        'text', 'integer', 'integer', 'integer[]', 'integer[]', 'jsonb', 'jsonb'],
  'catalog_grouped exists with the documented signature');

-- SECURITY INVOKER is a deliberate choice, not an omission: RLS stays the floor
-- under the function's own predicates. Flipping this to definer would make this
-- one file the only thing between anon and every private draft on the platform,
-- so it is asserted rather than assumed.
select is(
  (select p.prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'catalog_grouped'),
  false,
  'catalog_grouped is SECURITY INVOKER — RLS is still the floor');

select ok(
  has_function_privilege('anon', 'public.catalog_grouped(text,text,integer,integer,text,text,text,text,text,integer,integer,integer[],integer[],jsonb,jsonb)', 'execute'),
  'anon can call it — the catalog is readable signed out');
select ok(
  has_function_privilege('authenticated', 'public.catalog_grouped(text,text,integer,integer,text,text,text,text,text,integer,integer,integer[],integer[],jsonb,jsonb)', 'execute'),
  'authenticated can call it');

select ok(exists (select 1 from pg_class where relname = 'custom_models_catalog_group_idx'),
  'the grouped-catalog scan is indexed');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Fixture — one base model, five listings, three of which must not count
--
-- The seed carries exactly one listing, which cannot express grouping at all:
-- every aggregate over a single row is that row. So the interesting shape is
-- built here and rolled back.
-- ════════════════════════════════════════════════════════════════════════════
-- The profile comes from the on_auth_user_created trigger, which derives the
-- handle from `user_name` — the same path a real signup takes, so the handle in
-- the creator facet below is not hand-written.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', :'creator_b',
        'authenticated', 'authenticated', 'aliceb@catalog.test', 'x', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"user_name":"aliceb","full_name":"Alice B"}'::jsonb,
        now(), now(), '', '', '', '');

insert into public.base_models (
  id, slug, display_name, summary, family, parameter_count,
  architecture, n_layers, n_kv_heads, head_dim, hidden_size,
  max_position_embeddings, use_cases, commercial_hosting
) values (
  :'base', 'qwen/qwen3-8b', 'Qwen3 8B', 'Dense 8B.', 'qwen3', 8000000000,
  'qwen3', 36, 8, 128, 4096, 262144,
  array['code', 'reasoning', 'tool-use'], 'allowed'
);

-- One row per listing. The columns that matter are the last eight; the rest is
-- what the schema's CHECKs require of a `ready` row.
create function pg_temp.listing(
  p_id uuid, p_user uuid, p_slug text, p_quant text,
  p_ctx integer, p_verified boolean, p_tps integer,
  p_price_out bigint, p_base uuid, p_visibility public.model_visibility
) returns void language sql as $fn$
  insert into public.custom_models (
    id, user_id, slug, display_name, description, hf_repo_slug, served_model_name,
    weights_format, runtime, variant_quant_tag, weights_bytes, active_weights_bytes,
    n_layers, n_kv_heads, head_dim, context_length, context_verified,
    measured_tokens_per_second, gpu_tier_id, gpu_usd_per_hour_micro_snapshot,
    max_concurrent_streams, upstream_endpoint_ref,
    price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
    visibility, status, base_model_id, ready_at
  ) values (
    p_id, p_user, p_slug, p_slug, 'fixture', 'fixture/' || p_slug, p_slug,
    'gguf', 'llamacpp', p_quant, 5000000000, 5000000000,
    36, 8, 128, p_ctx, p_verified,
    p_tps, 'l4', 1000000, 4, 'x=1',
    p_price_out / 2, p_price_out,
    p_visibility, 'ready', p_base, now()
  );
$fn$;

-- The three that count. Cheapest is the Q4; the fastest is the Q4; the longest
-- context is on the Q8. No single listing is best at everything, which is the
-- only fixture shape that can catch an aggregate reading from the wrong row.
select pg_temp.listing('00000000-0000-0000-0000-0000000000f1', :'creator_a',
  'qwen3-8b-q4', 'Q4_K_M',  32768, true,  90,  120000, :'base', 'public');
select pg_temp.listing('00000000-0000-0000-0000-0000000000f2', :'creator_a',
  'qwen3-8b-q6', 'Q6_K',   131072, false, 60,  900000, :'base', 'public');
select pg_temp.listing('00000000-0000-0000-0000-0000000000f3', :'creator_b',
  'qwen3-8b-q8', 'Q8_0',   262144, true,  45, 2500000, :'base', 'public');

-- The three that must not. Each is priced or measured so that a leak is visible
-- in an aggregate rather than only in a count.
select pg_temp.listing('00000000-0000-0000-0000-0000000000f4', :'creator_a',
  'qwen3-8b-secret', 'Q5_K_M', 8192, false, 300, 1, :'base', 'private');
select pg_temp.listing('00000000-0000-0000-0000-0000000000f5', :'creator_b',
  'qwen3-8b-susp', 'Q4_0', 999999, false, 999, 2, :'base', 'public');
update public.custom_models
   set suspended_at = now(), suspension_reason = 'operator takedown, fixture'
 where id = '00000000-0000-0000-0000-0000000000f5';
select pg_temp.listing('00000000-0000-0000-0000-0000000000f6', :'creator_b',
  'qwen3-8b-gone', 'Q3_K_M', 888888, false, 888, 3, :'base', 'public');
update public.custom_models set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000000f6';

-- An unresolved listing: no base model, which is every listing's state until
-- #25's cascade runs.
select pg_temp.listing('00000000-0000-0000-0000-0000000000f7', :'creator_b',
  'mystery-7b', 'Q4_K_M', 8192, false, 20, 80000, null, 'public');

-- One call, reused. A view rather than a temp table so each assertion below
-- reads the CURRENT role's answer — the boundary tests depend on that.
create function pg_temp.grouped(
  p_quality text default null,
  p_category text default null,
  p_creator text default null,
  p_price text default null,
  p_min_speed integer default null,
  p_ts text default null,
  p_limit integer default 24,
  p_offset integer default 0
) returns jsonb language sql as $fn$
  select public.catalog_grouped(
    p_ts_query := p_ts,
    p_quality_key := p_quality,
    p_category := p_category,
    p_creator := p_creator,
    p_price_key := p_price,
    p_min_speed := p_min_speed,
    p_limit := p_limit,
    p_offset := p_offset,
    p_speed_steps := array[20, 40, 60, 90, 120],
    p_context_steps := array[8192, 32768, 128000, 200000, 1000000],
    p_quality_rungs :=
      '[{"key":"balanced","tags":["Q4_K_M","Q4_0"]},{"key":"high","tags":["Q5_K_M"]},{"key":"maximum","tags":["Q6_K","Q8_0"]},{"key":"full","tags":["F16","BF16","FP16"],"native":true}]'::jsonb,
    p_price_rungs :=
      '[{"key":"budget","max":500000},{"key":"standard","min":500000,"max":2000000},{"key":"premium","min":2000000}]'::jsonb
  );
$fn$;

-- The Qwen3 8B group out of an unfiltered call.
create function pg_temp.qwen(p_quality text default null, p_creator text default null)
returns jsonb language sql as $fn$
  select g from jsonb_array_elements(
           pg_temp.grouped(p_quality := p_quality, p_creator := p_creator)->'groups') g
   where g->>'base_slug' = 'qwen/qwen3-8b';
$fn$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. THE GROUPING — three listings are one card
-- ════════════════════════════════════════════════════════════════════════════
select is((pg_temp.qwen()->>'listing_count')::int, 3,
  'three listings of one base model report as 3 listings on one card');
select is((pg_temp.qwen()->>'creator_count')::int, 2,
  'two creators serving the same weights are one card, counted as two creators');
select is(pg_temp.qwen()->>'display_name', 'Qwen3 8B',
  'the card is named after the MODEL, not after whichever deployment won');
select is(pg_temp.qwen()->>'base_slug', 'qwen/qwen3-8b',
  'the base slug carries the weights publisher — the provenance line needs it');

-- The seeded listing plus this fixture's grouped card plus the unresolved one.
select is((pg_temp.grouped()->>'total')::int, 3,
  'seven listings collapse to three cards');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.grouped()->'groups') g
    where g->>'base_model_id' is null),
  1::bigint,
  'an unresolved listing is its OWN card, never folded in with other NULLs');
select is(
  (select g->>'display_name' from jsonb_array_elements(pg_temp.grouped()->'groups') g
    where g->>'base_model_id' is null),
  'mystery-7b',
  'an unresolved card falls back to the LISTING name — there is nothing else honest to show');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. THE AGGREGATES — best case, from the right row
-- ════════════════════════════════════════════════════════════════════════════
select is((pg_temp.qwen()->>'best_tokens_per_second')::int, 90,
  'best tok/s is the max over the matching listings');
select is((pg_temp.qwen()->>'best_context_length')::int, 262144,
  'best context is the max over the matching listings');
-- Not bool_or: the Q6 in the middle is unverified, and the Q8 that actually
-- reaches 262144 is verified. bool_or would let the Q4's verified 32k vouch for
-- a context it never held.
select is((pg_temp.qwen()->>'best_context_verified')::boolean, true,
  'the verified flag belongs to the listing that reaches the best context');
select is((pg_temp.qwen()->>'price_completion_micro')::bigint, 120000::bigint,
  'the `from` price is the cheapest matching listing');
select is(pg_temp.qwen()->>'slug', 'qwen3-8b-q4',
  'the card links to the listing it quotes, so the `from` price is buyable');
select is((pg_temp.qwen()->>'price_prompt_micro')::bigint, 60000::bigint,
  'both prices come from the SAME listing — a min-of-each pair is a price nobody can pay');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. THE BOUNDARY — RLS is the floor, the predicates are the catalog
-- ════════════════════════════════════════════════════════════════════════════
-- Every excluded row is cheaper and faster than every included one, so any leak
-- lands in an aggregate the assertions above already pin.
select is((pg_temp.qwen()->>'best_tokens_per_second')::int, 90,
  'a suspended listing does not contribute its 999 tok/s to the group');
select isnt((pg_temp.qwen()->>'price_completion_micro')::bigint, 2::bigint,
  'a suspended listing does not become the quoted `from` price');
select isnt((pg_temp.qwen()->>'price_completion_micro')::bigint, 3::bigint,
  'a soft-deleted listing does not become the quoted `from` price');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

-- The sharp one, and it is only sharp if RLS really does admit the row. Asserted
-- rather than assumed: without this, a session that silently failed to become
-- the creator would make all three assertions below pass for the wrong reason.
select is(
  (select count(*) from public.custom_models
    where id = '00000000-0000-0000-0000-0000000000f4'),
  1::bigint,
  'RLS admits the creator their own private listing — so only the RPC predicate excludes it');

select is((pg_temp.qwen()->>'listing_count')::int, 3,
  'a creator browsing the catalog does not see their own private listing in the group');
select isnt((pg_temp.qwen()->>'price_completion_micro')::bigint, 1::bigint,
  'and their private listing does not become the `from` price the public reads');
select is((pg_temp.qwen()->>'best_tokens_per_second')::int, 90,
  'nor does its 300 tok/s become the advertised best');

reset role;
set local role anon;
select is((pg_temp.grouped()->>'total')::int, 3,
  'anon gets the same three cards — the catalog reads signed out');
select is((pg_temp.qwen()->>'listing_count')::int, 3,
  'and the same three listings under the grouped card');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. THE QUALITY FACET FILTERS WITHIN A GROUP
--
-- The behaviour change of the whole issue. Before grouping, `maximum` deleted
-- this model: its listings were separate cards and the Q4 card simply failed the
-- filter. Now the model survives and the card quotes the cheapest listing that
-- can actually serve the request.
-- ════════════════════════════════════════════════════════════════════════════
select isnt(pg_temp.qwen('maximum'), null,
  'a model whose CHEAPEST listing is Q4 survives quality=maximum');
select is((pg_temp.qwen('maximum')->>'listing_count')::int, 2,
  'and reports only the listings that can serve the request');
select is(pg_temp.qwen('maximum')->>'quant_tag', 'Q6_K',
  'quoting the cheapest MAXIMUM-quality listing, not the cheapest listing');
select is((pg_temp.qwen('maximum')->>'price_completion_micro')::bigint, 900000::bigint,
  'so the `from` price is the price at the quality that was asked for');
select is((pg_temp.qwen('maximum')->>'best_tokens_per_second')::int, 60,
  'and the best-case figures are recomputed over the matching listings only');

-- A model drops out only when it genuinely cannot serve the request.
select is(pg_temp.qwen('high'), null,
  'quality=high drops the model, because no PUBLIC listing of it is Q5');
select is((pg_temp.grouped(p_quality := 'high')->>'total')::int, 0,
  'and nothing else claims to serve it either');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. THE COUNTS — a tab count equals the rows that tab returns
--
-- Asserted exactly, over every category present, rather than spot-checked: the
-- failure this guards against is one category drifting, and a spot check on
-- `code` would not see it.
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select count(*) from jsonb_each_text(pg_temp.grouped()->'categories'->'by_key') c
    where c.value::int <> (pg_temp.grouped(p_category := c.key)->>'total')::int),
  0::bigint,
  'every category tab count equals the total that category returns');

select is(
  (pg_temp.grouped()->'categories'->>'all')::int,
  (pg_temp.grouped()->>'total')::int,
  'the All tab count equals the unfiltered total');

select is((pg_temp.grouped()->'categories'->'by_key'->>'code')::int, 1,
  'the code tab counts the one model whose base model declares it');
-- `vision` is in the use_cases vocabulary and no visible model declares it.
-- Absent, not zero: a zero-count tab is a control that returns nothing, and the
-- rail draws only the tabs that have rows behind them.
select is(pg_temp.grouped()->'categories'->'by_key'->>'vision', null,
  'a category no visible model declares is absent, not zero — there is no tab to draw');

-- The same invariant on the facet rail, for the two facets whose rungs are
-- enumerable from the fixture.
select is(
  (pg_temp.grouped()->'facets'->'quality'->>'maximum')::int,
  (pg_temp.grouped(p_quality := 'maximum')->>'total')::int,
  'the quality rung count equals the rows that rung returns');
select is(
  (pg_temp.grouped()->'facets'->'price'->>'premium')::int,
  (pg_temp.grouped(p_price := 'premium')->>'total')::int,
  'the price band count equals the rows that band returns');
select is(
  (pg_temp.grouped()->'facets'->'speed'->>'90')::int,
  (pg_temp.grouped(p_min_speed := 90)->>'total')::int,
  'the speed rung count equals the rows that rung returns');

-- Drill-down, not self-reporting. A rail whose counts are computed under its own
-- active filter reports the thing you already chose and zero for everything
-- else, which kills the rail after one click.
select is(
  (pg_temp.grouped(p_quality := 'maximum')->'facets'->'quality'->>'balanced')::int,
  (pg_temp.grouped()->'facets'->'quality'->>'balanced')::int,
  'a facet count excludes its OWN dimension, so the other rungs stay reachable');
select is(
  (pg_temp.grouped(p_creator := 'aliceb')->'facets'->'creator'->>'jonathancoletti')::int,
  2,
  'the creator rail still offers the other creator while one is selected');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Degradation and paging — the front page must survive a hand-edited URL
-- ════════════════════════════════════════════════════════════════════════════
select is((pg_temp.grouped(p_ts := 'bad((query')->>'total')::int, 3,
  'a malformed tsquery degrades to "no search" instead of raising 42601');
select is((pg_temp.grouped(p_ts := 'qwen3:*&8b:*')->>'total')::int, 1,
  'a real prefix query narrows to the model that matches every token');
-- `dense` appears ONLY in base_models.summary — no listing slug, description or
-- repo path carries it. So this hits the base-model arm of the search or nothing.
select is((pg_temp.grouped(p_ts := 'dense:*')->>'total')::int, 1,
  'search reaches the BASE model text, not only the listing slug');

select is(
  (select count(*) from jsonb_array_elements(pg_temp.grouped(p_limit := 2)->'groups')),
  2::bigint,
  'the page is limited');
select is((pg_temp.grouped(p_limit := 2)->>'total')::int, 3,
  'while the total still counts every group behind it');
select is(
  (select count(*) from jsonb_array_elements(
     pg_temp.grouped(p_limit := 2, p_offset := 2)->'groups')),
  1::bigint,
  'and the last page holds the remainder');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.grouped(p_limit := 0)->'groups')),
  1::bigint,
  'a zero limit is clamped to 1 rather than returning an empty page');

select finish();
rollback;
