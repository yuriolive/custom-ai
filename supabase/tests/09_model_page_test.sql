-- ============================================================================
-- model_page — the page is a MODEL, and its offer table is a price comparison
-- (#27).
--
-- Why this file exists at all: every row of the offer table is a claim that
-- SOMEONE WILL SELL YOU THIS AT THIS PRICE. A row that should not be there is
-- not a rendering bug — it is a price a visitor cannot buy at, quoted beside
-- prices they can, in a table whose entire purpose is that the rows are
-- comparable. None of that shows up as an error.
--
-- Five things are tested, and they are different kinds of thing:
--
--   1. THE OFFER SET. Every visible listing of one base model, and only those.
--      The fixture prices each excluded listing at 1, 2 or 3 micro-USD so a leak
--      lands as the CHEAPEST row in the table — the most visible place it could
--      land, and the one a reader would act on first.
--
--   2. THE BOUNDARY. Same shape as 08: the RPC is SECURITY INVOKER, so its own
--      predicates are what make it the public catalog rather than "every row the
--      caller can see". The sharp case is a creator reading their own model's
--      page — RLS admits their private draft (custom_models_select_own), so only
--      the predicate keeps it out of the offer table, where they would be the
--      only person able to see it.
--
--   3. THE ANCHOR. The listing whose URL this is must be in its own offer table,
--      even when it is the dearest of a hundred and the cap has fired. A table
--      whose highlighted row is absent is one the reader cannot place themselves
--      in, and the prices further down the page would then belong to no row.
--
--   4. THE LINEAGE (§1.2). A fine-tune is its own model WITH a parent, and the
--      root case is a distinct answer rather than the same blank. `parent` and
--      `parent.listing_count` are what the UI needs to render "based on Qwen3 8B"
--      as a link rather than as a link to nothing.
--
--   5. THE PROJECTION. It is the security boundary (rule 2 at the head of
--      components/marketplace/queries.ts) and it is handed to a "use client"
--      component, i.e. into the RSC payload. Asserted by NAME here: no key of
--      the listing or of an offer may be hardware-shaped.
--
-- What is deliberately NOT tested here: money. No column, RPC or invariant on
-- the billing path is touched, and 01-06 own that ground.
-- ============================================================================
begin;
select plan(44);

\set creator_a '00000000-0000-0000-0000-0000000000a1'
\set creator_c '00000000-0000-0000-0000-0000000000c9'
\set base      '00000000-0000-0000-0000-0000000000e2'
\set finetune  '00000000-0000-0000-0000-0000000000e3'

-- ════════════════════════════════════════════════════════════════════════════
-- 0. The plumbing
-- ════════════════════════════════════════════════════════════════════════════
select has_function('public', 'model_page', array['text', 'text', 'integer'],
  'model_page exists with the documented signature');

-- SECURITY INVOKER is a deliberate choice, not an omission — RLS stays the floor
-- under the function's own predicates. Asserted rather than assumed, because
-- flipping it would make this one file the only thing between anon and every
-- private draft on the platform.
select is(
  (select p.prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'model_page'),
  false,
  'model_page is SECURITY INVOKER — RLS is still the floor');

select ok(
  has_function_privilege('anon', 'public.model_page(text,text,integer)', 'execute'),
  'anon can call it — a model page is readable signed out');
select ok(
  has_function_privilege('authenticated', 'public.model_page(text,text,integer)', 'execute'),
  'authenticated can call it');
select ok(exists (select 1 from pg_class where relname = 'custom_models_offer_set_idx'),
  'the offer set is indexed on the column it probes first');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Fixture — one model with three offers, one fine-tune of it, and four
--    listings that must never appear
--
-- The seed carries one listing of one base model, which cannot express a
-- comparison: every offer table over a single row is that row. So the shape is
-- built here and rolled back.
-- ════════════════════════════════════════════════════════════════════════════
-- The profile comes from the on_auth_user_created trigger, which derives the
-- handle from `user_name` — the same path a real signup takes, so the handle the
-- assertions below match on is not hand-written.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', :'creator_c',
        'authenticated', 'authenticated', 'carol@offers.test', 'x', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"user_name":"carol","full_name":"Carol"}'::jsonb,
        now(), now(), '', '', '', '');

-- The ROOT model, and a `conditional` licence with every licence column filled:
-- the page owes an attribution notice for exactly this posture, and it can only
-- render one if all four columns survive the projection.
insert into public.base_models (
  id, slug, display_name, summary, family, parameter_count,
  architecture, n_layers, n_kv_heads, head_dim, hidden_size,
  max_position_embeddings, use_cases,
  license_id, license_name, license_url, license_version, commercial_hosting
) values (
  :'base', 'meta/llama-3.1-8b', 'Llama 3.1 8B', 'Dense 8B.', 'llama-3.1', 8000000000,
  'llama', 32, 8, 128, 4096, 131072,
  array['code', 'chat'],
  'llama3.1', 'Llama 3.1 Community License',
  'https://example.invalid/llama3_1/LICENSE', '3.1', 'conditional'
);

-- The FINE-TUNE: its own model, with a parent (§1.2). Never a variant of the
-- model it was trained from — its output is not its parent's.
insert into public.base_models (
  id, slug, display_name, family, parameter_count, parent_id,
  use_cases, commercial_hosting
) values (
  :'finetune', 'somelab/llama-3.1-8b-uncensored', 'Llama 3.1 8B Uncensored',
  'llama-3.1', 8000000000, :'base',
  array['uncensored', 'chat'], 'conditional'
);

create function pg_temp.listing(
  p_id uuid, p_user uuid, p_slug text, p_quant text,
  p_ctx integer, p_verified boolean, p_tps integer,
  p_price_out bigint, p_base uuid, p_visibility public.model_visibility
) returns void language sql as $fn$
  insert into public.custom_models (
    id, user_id, slug, display_name, description, hf_repo_slug, served_model_name,
    weights_format, runtime, variant_quant_tag, weights_bytes, active_weights_bytes,
    n_layers, n_kv_heads, head_dim, context_length, context_verified,
    measured_tokens_per_second, p50_ttft_ms, gpu_tier_id,
    gpu_usd_per_hour_micro_snapshot, max_concurrent_streams, upstream_endpoint_ref,
    price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
    visibility, status, base_model_id, ready_at
  ) values (
    p_id, p_user, p_slug, p_slug, 'fixture', 'fixture/' || p_slug, p_slug,
    'gguf', 'llamacpp', p_quant, 5000000000, 5000000000,
    32, 8, 128, p_ctx, p_verified,
    p_tps, 900, 'l4', 1000000, 4, 'x=1',
    p_price_out / 2, p_price_out,
    p_visibility, 'ready', p_base, now()
  );
$fn$;

-- The three offers. No listing is best at everything, which is the only fixture
-- shape that can catch a sort or an aggregate reading from the wrong row: the Q4
-- is cheapest and fastest, the Q8 has the longest context and the highest price.
select pg_temp.listing('00000000-0000-0000-0000-00000000a001', :'creator_a',
  'llama31-8b-q4', 'Q4_K_M',  32768, true,  90,  120000, :'base', 'public');
select pg_temp.listing('00000000-0000-0000-0000-00000000a002', :'creator_a',
  'llama31-8b-q6', 'Q6_K',   131072, false, 60,  900000, :'base', 'public');
select pg_temp.listing('00000000-0000-0000-0000-00000000a003', :'creator_c',
  'llama31-8b-q8', 'Q8_0',   131072, true,  45, 2500000, :'base', 'public');

-- The four that must never be offers. Each is priced so a leak lands as the
-- CHEAPEST row of the table rather than as a subtle count.
select pg_temp.listing('00000000-0000-0000-0000-00000000a004', :'creator_a',
  'llama31-8b-secret', 'Q5_K_M', 8192, false, 300, 1, :'base', 'private');
select pg_temp.listing('00000000-0000-0000-0000-00000000a005', :'creator_c',
  'llama31-8b-susp', 'Q4_0', 8192, false, 999, 2, :'base', 'public');
update public.custom_models
   set suspended_at = now(), suspension_reason = 'operator takedown, fixture'
 where id = '00000000-0000-0000-0000-00000000a005';
select pg_temp.listing('00000000-0000-0000-0000-00000000a006', :'creator_c',
  'llama31-8b-gone', 'Q3_K_M', 8192, false, 888, 3, :'base', 'public');
update public.custom_models set deleted_at = now()
 where id = '00000000-0000-0000-0000-00000000a006';
-- A listing of the FINE-TUNE. Same weights family, same architecture, DIFFERENT
-- model — so it must not appear among the parent's offers, and vice versa.
select pg_temp.listing('00000000-0000-0000-0000-00000000a007', :'creator_c',
  'llama31-8b-unc-q4', 'Q4_K_M', 32768, false, 70, 400000, :'finetune', 'public');

-- Two UNRESOLVED listings: no base model, which is every listing's state until
-- #25's cascade runs. Two, because one cannot prove they are not folded together.
select pg_temp.listing('00000000-0000-0000-0000-00000000a008', :'creator_c',
  'mystery-a', 'Q4_K_M', 8192, false, 20, 80000, null, 'public');
select pg_temp.listing('00000000-0000-0000-0000-00000000a009', :'creator_c',
  'mystery-b', 'Q6_K', 8192, false, 25, 90000, null, 'public');

create function pg_temp.page(
  p_creator text, p_slug text, p_limit integer default 100
) returns jsonb language sql as $fn$
  select public.model_page(p_creator, p_slug, p_limit);
$fn$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. THE ANCHOR AND THE MODEL
-- ════════════════════════════════════════════════════════════════════════════
select is(pg_temp.page('carol', 'llama31-8b-q8')->'listing'->>'slug', 'llama31-8b-q8',
  'the anchor is the listing the URL names');
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'display_name', 'Llama 3.1 8B',
  'the page is titled with the MODEL, not with whichever deployment was visited');
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'slug', 'meta/llama-3.1-8b',
  'the base slug carries the weights publisher — the provenance line needs it');

-- The friendlier half of the model-id trap: a mixed-case URL copied out of
-- Hugging Face resolves rather than 404-ing, because both columns are lowercase
-- by CHECK and the arguments are lowered inside the function.
select is(pg_temp.page('CAROL', 'Llama31-8B-Q8')->'listing'->>'slug', 'llama31-8b-q8',
  'a mixed-case URL resolves to the same page');

-- ONE null for "no such model", "private", "not ready" and "creator suspended".
-- Distinguishing them would tell an anonymous visitor that a private model
-- exists (CONTRACTS.md §Gateway wire contract).
select ok(pg_temp.page('carol', 'no-such-listing') is null,
  'an unknown listing is NULL, and the caller turns that into a 404');
select ok(pg_temp.page('jonathancoletti', 'llama31-8b-secret') is null,
  'a private listing is the same NULL — not a different answer');
select ok(pg_temp.page('carol', 'llama31-8b-susp') is null,
  'a suspended listing has no page');
select ok(pg_temp.page('carol', 'llama31-8b-gone') is null,
  'a soft-deleted listing has no page');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. THE OFFER SET
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers')),
  3::bigint,
  'three visible listings of one model are three offers');
select is((pg_temp.page('carol', 'llama31-8b-q8')->>'offer_total')::int, 3,
  'and the total agrees with the rows');

-- Cheapest first, which is both the ordering a price comparison defaults to and
-- the ordering the cap keeps if it ever fires.
select is(
  pg_temp.page('carol', 'llama31-8b-q8')->'offers'->0->>'slug', 'llama31-8b-q4',
  'offers arrive cheapest-output-first');
select is(
  (pg_temp.page('carol', 'llama31-8b-q8')->'offers'->0->>'price_completion_micro')::bigint,
  120000::bigint,
  'and the cheapest row is a price somebody actually charges');

-- THE LEAK TESTS. Every excluded listing is priced at 1, 2 or 3 micro-USD, so a
-- leak would be the first row of the table rather than a subtle count.
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers') o
    where (o->>'price_completion_micro')::bigint < 100000),
  0::bigint,
  'no private, suspended or deleted listing reaches the offer table');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers') o
    where o->>'slug' = 'llama31-8b-unc-q4'),
  0::bigint,
  'a FINE-TUNE is not an offer of its parent — its output is not the parent''s');

-- The anchor is in its own table. Without it the price table and the snippet
-- further down the page belong to no row the reader can see.
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers') o
    where o->>'listing_id' = '00000000-0000-0000-0000-00000000a003'),
  1::bigint,
  'the anchor appears in its own offer table');

-- ── The cap ────────────────────────────────────────────────────────────────
-- The anchor here is the DEAREST of three, so a cap of one would drop it if the
-- `or r.id = an.id` escape were missing. Two rows, and a total that still counts
-- all three: a silent truncation on a price comparison reads as "these are all
-- the offers".
select is(
  (select count(*) from jsonb_array_elements(
     pg_temp.page('carol', 'llama31-8b-q8', 1)->'offers')),
  2::bigint,
  'a cap of one keeps the cheapest offer AND the anchor');
select is((pg_temp.page('carol', 'llama31-8b-q8', 1)->>'offer_total')::int, 3,
  'while the total still counts every offer behind the cap');
-- Anchored on the CHEAPEST listing, so the clamp is the only thing under test:
-- with the anchor and the cheapest row being the same row, a clamped limit of one
-- returns exactly one. Anchoring on the dearest (above) would return two whether
-- the clamp worked or not.
select is(
  (select count(*) from jsonb_array_elements(
     pg_temp.page('jonathancoletti', 'llama31-8b-q4', 0)->'offers')),
  1::bigint,
  'a zero cap is clamped to one row rather than returning an empty table');

-- ── The unresolved listing is a model of ONE ────────────────────────────────
-- Matching on a bare NULL would put every unresolved listing in one offer table,
-- pricing unrelated models against each other.
select is(jsonb_typeof(pg_temp.page('carol', 'mystery-a')->'model'), 'null',
  'an unresolved listing has no model — that is not the same as having no page');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'mystery-a')->'offers')),
  1::bigint,
  'and it is a model of one, never joined to every other unresolved listing');
select is(
  pg_temp.page('carol', 'mystery-a')->'offers'->0->>'slug', 'mystery-a',
  'the one offer being itself');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. THE LINEAGE (§1.2)
-- ════════════════════════════════════════════════════════════════════════════
select ok(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'parent_id' is null,
  'a root model reports no parent, which the UI renders as a distinct sentence');
select is(jsonb_typeof(pg_temp.page('carol', 'llama31-8b-q8')->'parent'), 'null',
  'and carries no parent object to render');

select is(pg_temp.page('carol', 'llama31-8b-unc-q4')->'model'->>'display_name',
  'Llama 3.1 8B Uncensored',
  'a fine-tune is its OWN model, titled with its own name');
select is(pg_temp.page('carol', 'llama31-8b-unc-q4')->'parent'->>'display_name',
  'Llama 3.1 8B',
  'and names the model it was trained from');
-- The count that decides whether the lineage line is a LINK. A parent with no
-- visible listings has nowhere for the link to go, and linking to an empty
-- catalog search reads as a broken page.
select is((pg_temp.page('carol', 'llama31-8b-unc-q4')->'parent'->>'listing_count')::int, 3,
  'with a count of the parent''s own visible listings, so the link is not a dead end');
-- The parent is readable even though every listing of it belongs to someone else:
-- `base_model_visible_to` reaches `parent_id`, which is the case that matters —
-- a parent may be served here only through its fine-tunes.
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-unc-q4')->'offers')),
  1::bigint,
  'while the fine-tune''s own offer table holds only its own listings');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. THE LICENCE COLUMNS (§5.1)
--
-- The notice the page owes its upstream is CONTENT, and content it cannot render
-- from columns that did not survive the projection.
-- ════════════════════════════════════════════════════════════════════════════
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'commercial_hosting', 'conditional',
  'the posture reaches the page — it is what the notice keys off');
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'license_name',
  'Llama 3.1 Community License',
  'as does the licence name');
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'license_version', '3.1',
  'and the REVISION, without which an acknowledgement names whichever text the reader remembers');
select is(pg_temp.page('carol', 'llama31-8b-q8')->'model'->>'license_url',
  'https://example.invalid/llama3_1/LICENSE',
  'and the link to the text that actually governs');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. THE PROJECTION IS THE SECURITY BOUNDARY
--
-- This return value is handed to a "use client" component, i.e. straight into
-- the RSC payload in the browser. NO HARDWARE IS REPRESENTABLE (FR-MKT-002), and
-- the assertion is by NAME rather than by inspection so a key added to the RPC
-- fails here rather than in a browser.
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select count(*) from jsonb_object_keys(pg_temp.page('carol', 'llama31-8b-q8')->'listing') k
    where k in ('gpu_tier_id', 'predicted_tokens_per_second', 'placement_rationale',
                'upstream_endpoint_ref', 'max_concurrent_streams', 'kv_bytes_per_token',
                'gpu_usd_per_hour_micro_snapshot', 'volume_gb', 'hf_token_secret_id',
                'base_model_match')),
  0::bigint,
  'the anchor listing publishes nothing hardware-shaped');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers') o,
        lateral jsonb_object_keys(o) k
    where k in ('gpu_tier_id', 'predicted_tokens_per_second', 'placement_rationale',
                'upstream_endpoint_ref', 'max_concurrent_streams', 'kv_bytes_per_token',
                'gpu_usd_per_hour_micro_snapshot', 'volume_gb', 'hf_token_secret_id',
                'base_model_match')),
  0::bigint,
  'and neither does any offer row');
-- `embedding` is a 384-float vector and `search_vector` a tsvector. Neither is a
-- secret — both are derived from text this table already publishes — but both are
-- a payload nobody asked for, which is why `model` is a named column list.
select is(
  (select count(*) from jsonb_object_keys(pg_temp.page('carol', 'llama31-8b-q8')->'model') k
    where k in ('embedding', 'search_vector')),
  0::bigint,
  'the model does not ship its embedding or its search vector');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. THE BOUNDARY — a creator reading their own model's page
--
-- The sharp case, and it is only sharp if RLS really does admit the row: without
-- the function's own predicates, `custom_models_select_own` would put this
-- creator's private draft in the offer table, priced at 1 micro-USD, visible to
-- nobody but them. That is the worst version of the bug, because it cannot be
-- reproduced by anyone reviewing it.
-- ════════════════════════════════════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is(
  (select count(*) from public.custom_models
    where id = '00000000-0000-0000-0000-00000000a004'),
  1::bigint,
  'RLS really does admit the creator''s own private listing — so the next assertion means something');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers') o
    where o->>'slug' = 'llama31-8b-secret'),
  0::bigint,
  'and the function''s own predicates keep it out of the offer table anyway');
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers')),
  3::bigint,
  'the creator sees exactly the table a stranger sees');

reset role;
set local role anon;
select is(
  (select count(*) from jsonb_array_elements(pg_temp.page('carol', 'llama31-8b-q8')->'offers')),
  3::bigint,
  'and anon sees the same three offers');
select ok(pg_temp.page('jonathancoletti', 'llama31-8b-secret') is null,
  'while a private listing is still no page at all');
reset role;

select finish();
rollback;
