-- ============================================================================
-- base_models — the schema that makes a catalog row a model, not a deployment.
--
-- Three things are worth testing here, and they are not the same kind of thing:
--
--   1. The CONSTRAINTS, because every one of them exists to stop a specific
--      wrong row: an open-vocabulary use case that splits a facet three ways, a
--      licence url attached to no licence, a duplicate listing that renders as
--      "2 listings" for one deployment.
--
--   2. The PINS. `custom_models` is directly INSERT-able and UPDATE-able from
--      the browser under RLS, so six new platform-written columns are six new
--      ways for a creator to write something the platform is supposed to
--      measure. `suspended_at` is the sharp one: a takedown its target can clear
--      is not a takedown, and the ONLY thing stopping that is the WITH CHECK.
--
--   3. The BOUNDARY. base_models has no `visibility` column of its own — it
--      inherits visibility from the listings that serve it. A row named after
--      someone's private fine-tune must not be readable by anon, and a PARENT
--      served only through its children must be.
--
-- What is deliberately NOT tested here: money. No column, RPC or invariant on
-- the billing path is touched by this migration, and 01-06 own that ground.
-- ============================================================================
begin;
select plan(88);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set model   '00000000-0000-0000-0000-0000000000c1'

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The plumbing exists
-- ════════════════════════════════════════════════════════════════════════════
select has_table('public', 'base_models', 'base_models exists');
select has_type('public', 'commercial_hosting', 'the commercial_hosting enum exists');
select enum_has_labels('public', 'commercial_hosting',
  array['allowed', 'conditional', 'prohibited', 'unknown'],
  'commercial_hosting carries exactly the four states of §5.1');
select has_function('public', 'embedding_dimension', 'the dimension constant is a function');
select has_function('public', 'base_model_visible_to', array['uuid', 'uuid'],
  'the visibility oracle exists');

select has_column('public', 'custom_models', 'base_model_id', 'custom_models.base_model_id');
select has_column('public', 'custom_models', 'base_model_match', 'custom_models.base_model_match');
select has_column('public', 'custom_models', 'license_ack_at', 'custom_models.license_ack_at');
select has_column('public', 'custom_models', 'license_ack_version', 'custom_models.license_ack_version');
select has_column('public', 'custom_models', 'suspended_at', 'custom_models.suspended_at');
select has_column('public', 'custom_models', 'suspension_reason', 'custom_models.suspension_reason');

-- Checked against the catalog rather than has_index(): these carry expressions,
-- partial predicates and non-btree access methods, none of which the
-- four-argument has_index() can express (it reads its last argument as a COLUMN).
select ok(exists (select 1 from pg_class where relname = 'custom_models_variant_uniq'),
          'the duplicate-listing unique index exists');
select ok(exists (select 1 from pg_class where relname = 'custom_models_base_model_idx'),
          'the grouping lookup is indexed');
select ok(exists (select 1 from pg_class where relname = 'base_models_embedding_idx'),
          'the embedding has an HNSW index');
select ok(exists (select 1 from pg_class where relname = 'base_models_use_cases_idx'),
          'use_cases has a GIN index (the facet counts scan it)');

-- ── The seed actually groups something ─────────────────────────────────────
-- A grouping schema with nothing grouped makes every downstream card, tab and
-- facet untestable locally, so the fixture link is an assertion, not a nicety.
select isnt((select base_model_id from public.custom_models where id = :'model'::uuid),
            null, 'the seeded listing points at a base model');
select is(
  (select b.commercial_hosting::text from public.base_models b
     join public.custom_models m on m.base_model_id = b.id
    where m.id = :'model'::uuid),
  'unknown',
  'and its licence is honestly `unknown` — the value that must never auto-publish');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The dimension is ONE constant
--
-- 384 is gte-small's output width. SQL cannot take a column typmod from a
-- function, so it is written twice — here is the assertion that keeps the two
-- writings equal. Without it, an embedding model swap that updates the function
-- and forgets the column produces a 768-dim vector rejected at INSERT with a
-- message about dimensions that names neither place.
-- ════════════════════════════════════════════════════════════════════════════
select is(public.embedding_dimension(), 384, 'embedding_dimension() is gte-small''s 384');
-- The schema prefix is stripped before comparing, because format_type() omits it
-- whenever the type is visible in the current search_path — and whether
-- `extensions` is on that path is a property of the SERVER, not of this schema.
-- It is on supabase/postgres and off a stock Postgres, so asserting the
-- qualified string passes locally and fails in CI (it did, once). The dimension
-- is what this test is about; where the type lives is 20260820000100's business.
select is(
  (select regexp_replace(format_type(atttypid, atttypmod), '^.*\.', '')
     from pg_attribute
    where attrelid = 'public.base_models'::regclass and attname = 'embedding'),
  'vector(' || public.embedding_dimension() || ')',
  'base_models.embedding is exactly embedding_dimension() wide');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. base_models constraints
-- ════════════════════════════════════════════════════════════════════════════
\set bm_qwen  '00000000-0000-0000-0000-0000000000f1'
\set bm_child '00000000-0000-0000-0000-0000000000f2'
\set bm_priv  '00000000-0000-0000-0000-0000000000f3'

select lives_ok(
  $$ insert into public.base_models (id, slug, display_name, family, parameter_count,
                                     use_cases, license_id, license_name, license_url,
                                     license_version, commercial_hosting)
     values ('00000000-0000-0000-0000-0000000000f1', 'qwen/qwen3-8b', 'Qwen3 8B',
             'qwen3', 8030000000, array['code','reasoning','tool-use'],
             'apache-2.0', 'Apache License 2.0',
             'https://www.apache.org/licenses/LICENSE-2.0', '2.0', 'allowed') $$,
  'a well-formed base model inserts');

select is((select commercial_hosting::text from public.base_models where slug = 'qwen/qwen3-8b'),
          'allowed', 'commercial_hosting round-trips');
-- NOT NULL with a default of `unknown`, so a row written by a probe that could
-- not parse the licence still answers the question `unknown` rather than NULL —
-- three-valued logic in the auto-publish gate is how `prohibited` becomes
-- `allowed` by accident.
select col_not_null('public', 'base_models', 'commercial_hosting',
                    'commercial_hosting is NOT NULL');
select col_default_is('public', 'base_models', 'commercial_hosting', 'unknown',
                      'and it defaults to unknown');

-- The closed vocabulary of §4.1. An open tag cloud degrades into synonyms
-- (`coding`/`code`/`programming`) that split one facet three ways and make every
-- count on the category tabs wrong.
select throws_ok(
  $$ insert into public.base_models (slug, display_name, use_cases)
     values ('acme/one', 'One', array['coding']) $$,
  '23514', null, 'an off-vocabulary use case is rejected');
select throws_ok(
  $$ insert into public.base_models (slug, display_name, use_cases)
     values ('acme/two', 'Two', array['code', null]) $$,
  '23514', null, 'a NULL element in use_cases is rejected');
select lives_ok(
  $$ insert into public.base_models (slug, display_name, use_cases)
     values ('acme/three', 'Three', array['code','reasoning','chat','roleplay',
             'uncensored','multilingual','vision','long-context','tool-use',
             'math','embeddings','summarization']) $$,
  'the whole vocabulary is accepted at once');
select lives_ok(
  $$ insert into public.base_models (slug, display_name) values ('acme/four', 'Four') $$,
  'use_cases defaults to empty rather than NULL');
select is((select use_cases from public.base_models where slug = 'acme/four'),
          '{}'::text[], 'and that default is the empty array');

-- The slug is `publisher/name`, two lowercase segments. One segment is not
-- unique across publishers; an uppercase one breaks a case-sensitive URL.
select throws_ok(
  $$ insert into public.base_models (slug, display_name) values ('qwen3-8b', 'No publisher') $$,
  '23514', null, 'a single-segment slug is rejected');
select throws_ok(
  $$ insert into public.base_models (slug, display_name) values ('Qwen/Qwen3-8B', 'Mixed case') $$,
  '23514', null, 'an upper-case slug is rejected');
select throws_ok(
  $$ insert into public.base_models (slug, display_name) values ('a/b/c', 'Three segments') $$,
  '23514', null, 'a three-segment slug is rejected');
select throws_ok(
  $$ insert into public.base_models (slug, display_name) values ('qwen/qwen3-8b', 'Duplicate') $$,
  '23505', null, 'the slug is unique');

-- Licence facts that describe no licence.
select throws_ok(
  $$ insert into public.base_models (slug, display_name, license_url)
     values ('acme/five', 'Five', 'https://example.test/LICENSE') $$,
  '23514', null, 'a licence url without a licence id is rejected');
select throws_ok(
  $$ insert into public.base_models (slug, display_name, license_version)
     values ('acme/six', 'Six', '3.1') $$,
  '23514', null, 'a licence version without a licence id is rejected');
-- throws_ok proves the statement raised; this proves it left nothing behind.
select is((select count(*)::int from public.base_models
            where slug in ('acme/one', 'acme/two', 'acme/five', 'acme/six')),
          0, 'every rejected row really is absent');

-- ── §1.2: a fine-tune is its OWN model, with a parent ──────────────────────
select lives_ok(
  $$ insert into public.base_models (id, slug, display_name, parent_id, use_cases)
     values ('00000000-0000-0000-0000-0000000000f2', 'somelab/qwen3-8b-uncensored',
             'Qwen3 8B Uncensored', '00000000-0000-0000-0000-0000000000f1',
             array['uncensored']) $$,
  'a fine-tune is its own row with a parent');
select throws_ok(
  $$ update public.base_models set parent_id = id
      where id = '00000000-0000-0000-0000-0000000000f2' $$,
  '23514', null, 'a model cannot be its own parent');

-- ON DELETE SET NULL, not CASCADE: deleting Qwen3-8B must not delete every
-- fine-tune of it. A child that loses its parent loses one line of provenance,
-- not its existence — and losing the child would take its listings' grouping
-- with it.
select lives_ok(
  $$ delete from public.base_models where id = '00000000-0000-0000-0000-0000000000f1' $$,
  'a parent can be deleted');
select is((select count(*)::int from public.base_models
            where id = '00000000-0000-0000-0000-0000000000f2'),
          1, 'the fine-tune survives its parent');
select is((select parent_id from public.base_models
            where id = '00000000-0000-0000-0000-0000000000f2'),
          null, 'and its parent_id is nulled, not dangling');

-- Put the parent back for the visibility section below.
insert into public.base_models (id, slug, display_name, family, use_cases)
values (:'bm_qwen', 'qwen/qwen3-8b', 'Qwen3 8B', 'qwen3', array['code','reasoning']);
update public.base_models set parent_id = :'bm_qwen'::uuid where id = :'bm_child'::uuid;

-- ── The generated FTS vector actually indexes what it claims to ────────────
select ok(
  (select search_vector from public.base_models where id = :'bm_qwen'::uuid)
    @@ to_tsquery('english', 'qwen3'),
  'the display name reaches the FTS vector');
select ok(
  (select search_vector from public.base_models where id = :'bm_qwen'::uuid)
    @@ to_tsquery('english', 'reasoning'),
  'a use-case tag reaches the FTS vector (layer A is searchable text too)');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. custom_models: the new constraints
--
-- A listing factory, so the fifteen mandatory columns are written once. `vllm`
-- with weights_format `unknown` satisfies custom_models_runtime_matches_format
-- and sidesteps custom_models_gguf_needs_file, neither of which is under test
-- here.
-- ════════════════════════════════════════════════════════════════════════════
create function pg_temp.mk_listing(
  p_id uuid, p_user uuid, p_slug text, p_repo text,
  p_quant text default null, p_family text default null,
  p_visibility public.model_visibility default 'public',
  p_status public.model_status default 'ready',
  p_base uuid default null
) returns uuid language sql as $$
  insert into public.custom_models (
    id, user_id, slug, display_name, hf_repo_slug, served_model_name,
    runtime, variant_quant_tag, variant_family,
    weights_bytes, active_weights_bytes,
    price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
    visibility, status, base_model_id,
    -- custom_models_ready_needs_endpoint + _ready_needs_placement
    upstream_endpoint_ref, gpu_tier_id, gpu_usd_per_hour_micro_snapshot,
    max_concurrent_streams, measured_tokens_per_second
  ) values (
    p_id, p_user, p_slug, p_slug, p_repo, p_repo,
    'vllm', p_quant, p_family,
    1000000000, 1000000000, 100000, 200000,
    p_visibility, p_status, p_base,
    case when p_status = 'ready' then '?ref=' || p_slug end,
    case when p_status = 'ready' then (select id from public.gpu_tiers where is_enabled limit 1) end,
    case when p_status = 'ready' then 1000000 end,
    case when p_status = 'ready' then 4 end,
    case when p_status = 'ready' then 40 end
  ) returning id;
$$;

select throws_ok(
  format($$ update public.custom_models set license_ack_at = now() where id = %L $$, :'model'),
  '23514', null, 'a licence ack timestamp without a version is rejected');
select throws_ok(
  format($$ update public.custom_models set license_ack_version = '3.1' where id = %L $$, :'model'),
  '23514', null, 'a licence ack version without a timestamp is rejected');
select lives_ok(
  format($$ update public.custom_models
               set license_ack_at = now(), license_ack_version = '3.1' where id = %L $$, :'model'),
  'both halves of the ack together are accepted');
select lives_ok(
  format($$ update public.custom_models
               set license_ack_at = null, license_ack_version = null where id = %L $$, :'model'),
  'and both can be cleared together');

select throws_ok(
  format($$ update public.custom_models set suspended_at = now() where id = %L $$, :'model'),
  '23514', null, 'a suspension with no reason is rejected');
select throws_ok(
  format($$ update public.custom_models set suspension_reason = 'dmca' where id = %L $$, :'model'),
  '23514', null, 'a reason with no suspension is rejected');
select lives_ok(
  format($$ update public.custom_models
               set suspended_at = now(), suspension_reason = 'dmca notice 2026-08-20'
             where id = %L $$, :'model'),
  'a suspension with a reason is accepted');
select lives_ok(
  format($$ update public.custom_models
               set suspended_at = null, suspension_reason = null where id = %L $$, :'model'),
  'and an operator can lift it again');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. custom_models_variant_uniq
--
-- The `coalesce` is the whole point. NULLs are DISTINCT from each other in a
-- unique index, so without it the two rows the constraint most needs to catch —
-- a repo with no quant tag, deployed twice — are exactly the two it misses.
-- ════════════════════════════════════════════════════════════════════════════
\set l1 '00000000-0000-0000-0000-0000000000e1'
\set l2 '00000000-0000-0000-0000-0000000000e2'
\set l3 '00000000-0000-0000-0000-0000000000e3'

select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'native-1', 'acme/model') $$, :'l1', :'creator'),
  'a listing with no quant tag and no variant family inserts');
select throws_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'native-2', 'acme/model') $$, :'l2', :'creator'),
  '23505', null,
  'the SAME repo with two NULL variant columns collides — this is what coalesce buys');
select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'i1-quant', 'acme/model', null, 'i1') $$, :'l2', :'creator'),
  'a different variant_family is a different listing');
select throws_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'dupe-seed', %L, 'Q4_K_M', null) $$,
         :'l3', :'creator', 'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF'),
  '23505', null, 'redeploying the seeded variant collides');

-- Soft delete must free the slot, or a creator who deletes a listing can never
-- deploy that variant again.
update public.custom_models set deleted_at = now() where id = :'l1'::uuid;
select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'native-3', 'acme/model') $$, :'l3', :'creator'),
  'the variant can be redeployed once the old listing is soft-deleted');
delete from public.custom_models where id in (:'l1'::uuid, :'l2'::uuid, :'l3'::uuid);

-- A different OWNER serving the same repo and variant is the marketplace working
-- as intended — two listings of one model, which is what base_models exists to
-- group — not a duplicate.
select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'same-weights', %L, 'Q4_K_M', null) $$,
         :'l1', :'payer', 'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF'),
  'a second creator may serve the same repo and variant');
delete from public.custom_models where id = :'l1'::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. The pins — six platform-written columns a creator must not reach
--
-- Each UPDATE below writes BOTH halves of any paired constraint, so a 23514
-- cannot stand in for the 42501 we are actually asserting.
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;

-- Guard: without this the UPDATEs below could match zero rows and pass vacuously.
select is(auth.uid(), :'creator'::uuid, 'the session really is acting as the model owner');

select throws_ok(
  format($$ update public.custom_models set base_model_id = %L where id = %L $$,
         :'bm_qwen', :'model'),
  '42501', null, 'a creator cannot attach their listing to a base model');
select throws_ok(
  format($$ update public.custom_models set base_model_match = '{"signal":"manual"}'::jsonb
             where id = %L $$, :'model'),
  '42501', null, 'a creator cannot forge the grouping audit trail');
select throws_ok(
  format($$ update public.custom_models
               set license_ack_at = now(), license_ack_version = '3.1' where id = %L $$, :'model'),
  '42501', null, 'a creator cannot write their own licence acknowledgement');
select throws_ok(
  format($$ update public.custom_models
               set suspended_at = now(), suspension_reason = 'self-inflicted' where id = %L $$, :'model'),
  '42501', null, 'a creator cannot suspend their own listing');

-- Positive control: the pins must not have frozen the columns a creator owns.
-- Without this, a policy that rejected every UPDATE would pass everything above.
select lives_ok(
  format($$ update public.custom_models set display_name = 'Renamed by its owner'
             where id = %L $$, :'model'),
  'a creator can still rename their own model');
select lives_ok(
  format($$ update public.custom_models set visibility = 'private' where id = %L $$, :'model'),
  'a creator can still change their own visibility');

reset role;
update public.custom_models set visibility = 'public' where id = :'model'::uuid;

-- ── And the operator's suspension survives the creator's own UPDATE ────────
-- The sharp case: not "can they set it" but "can they clear it by writing every
-- OTHER column", which is what a form POST does.
update public.custom_models
   set suspended_at = now(), suspension_reason = 'acceptable use'
 where id = :'model'::uuid;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok(
  format($$ update public.custom_models
               set suspended_at = null, suspension_reason = null,
                   display_name = 'Definitely fine now'
             where id = %L $$, :'model'),
  '42501', null, 'a creator cannot clear an operator suspension, by any policy');

-- ── A suspended listing leaves the public catalog at once ──────────────────
reset role;
set local role anon;
select is((select count(*)::int from public.custom_models where id = :'model'::uuid),
          0, 'anon cannot see a suspended listing');
reset role;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.custom_models where id = :'model'::uuid),
          1, 'but its owner still sees it, so the Studio can show why');
reset role;

update public.custom_models set suspended_at = null, suspension_reason = null
 where id = :'model'::uuid;

set local role anon;
select is((select count(*)::int from public.custom_models where id = :'model'::uuid),
          1, 'and it returns to the catalog when the suspension is lifted');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. base_models visibility
--
-- base_models has no `visibility` of its own; it inherits from the listings that
-- serve it. Three rows, three cases: served publicly, served only privately, and
-- served only through a child.
-- ════════════════════════════════════════════════════════════════════════════
-- bm_qwen  <- the seeded public+ready listing
update public.custom_models set base_model_id = :'bm_qwen'::uuid where id = :'model'::uuid;
-- bm_priv  <- a PRIVATE listing owned by the creator, and nothing else
insert into public.base_models (id, slug, display_name)
values (:'bm_priv', 'acme/internal-support-bot', 'Acme Internal Support Bot');
select pg_temp.mk_listing(:'l1'::uuid, :'creator'::uuid, 'internal-bot', 'acme/internal',
                          null, null, 'private', 'draft', :'bm_priv'::uuid);
-- bm_child <- public listing; its PARENT bm_qwen has one of its own, so give the
-- parent-reachability case a row that has NO listing at all.
\set bm_orphan_parent '00000000-0000-0000-0000-0000000000f4'
insert into public.base_models (id, slug, display_name)
values (:'bm_orphan_parent', 'meta/llama-3.1-8b', 'Llama 3.1 8B');
update public.base_models set parent_id = :'bm_orphan_parent'::uuid where id = :'bm_child'::uuid;
select pg_temp.mk_listing(:'l2'::uuid, :'creator'::uuid, 'llama-ft', 'someone/llama-ft',
                          null, null, 'public', 'ready', :'bm_child'::uuid);

set local role anon;
select is((select count(*)::int from public.base_models where id = :'bm_qwen'::uuid),
          1, 'anon sees a base model served by a public listing');
select is((select count(*)::int from public.base_models where id = :'bm_priv'::uuid),
          0, 'anon does NOT see a base model served only privately');
select is((select count(*)::int from public.base_models where id = :'bm_orphan_parent'::uuid),
          1, 'anon sees a PARENT reachable only through a child''s listing (§5.2 provenance)');
select is((select count(*)::int from public.base_models where slug = 'acme/four'),
          0, 'a base model nothing serves at all is invisible');
reset role;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.base_models where id = :'bm_priv'::uuid),
          1, 'the owner of the private listing sees its base model (the Studio case)');
reset role;

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.base_models where id = :'bm_priv'::uuid),
          0, 'another signed-in user does not');
reset role;

-- A suspended listing must not keep its base model alive in the catalog either,
-- or a takedown leaves a card behind with no listings under it.
update public.custom_models
   set suspended_at = now(), suspension_reason = 'acceptable use'
 where id = :'model'::uuid;
set local role anon;
select is((select count(*)::int from public.base_models where id = :'bm_qwen'::uuid),
          0, 'suspending the only listing hides its base model too');
reset role;
update public.custom_models set suspended_at = null, suspension_reason = null
 where id = :'model'::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Role reachability on base_models
--
-- Every column is platform output, so there is no client write policy at all.
-- Probed at BOTH layers: the privilege (which fails first) and a live attempt.
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_table_privilege('anon', 'public.base_models', 'SELECT'),
          'anon can select base_models (the catalog needs it)');
select ok(not has_table_privilege('anon', 'public.base_models', 'INSERT'),
          'anon has no INSERT on base_models');
select ok(not has_table_privilege('authenticated', 'public.base_models', 'INSERT'),
          'authenticated has no INSERT on base_models');
select ok(not has_table_privilege('authenticated', 'public.base_models', 'UPDATE'),
          'authenticated has no UPDATE on base_models');
select ok(not has_table_privilege('authenticated', 'public.base_models', 'DELETE'),
          'authenticated has no DELETE on base_models');
select ok(has_table_privilege('service_role', 'public.base_models', 'INSERT'),
          'service_role writes base_models');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select throws_ok(
  $$ insert into public.base_models (slug, display_name) values ('acme/forged', 'Forged') $$,
  '42501', null, 'a creator cannot create a base model');
select throws_ok(
  $$ update public.base_models set display_name = 'Renamed by a stranger'
      where slug = 'qwen/qwen3-8b' $$,
  '42501', null, 'a creator cannot rename someone else''s model');
select throws_ok(
  $$ update public.base_models set commercial_hosting = 'allowed'
      where slug = 'qwen/qwen3-8b' $$,
  '42501', null, 'a creator cannot relicense weights they merely re-quantized');
reset role;

-- The visibility oracle must not become a read primitive on its own.
select ok(has_function_privilege('anon', 'public.base_model_visible_to(uuid,uuid)', 'EXECUTE'),
          'anon may call the visibility oracle (its own policy does)');
select is(public.base_model_visible_to(null, null), false,
          'the oracle answers false for a NULL id rather than erroring');

-- ════════════════════════════════════════════════════════════════════════════
-- 9. The gateway path is untouched
--
-- The addressable model id stays creator-handle/model-slug and base_models is
-- unreachable from the upstream path. These two assertions are the tripwire: a
-- future change that teaches gateway_resolve about base models, or that reworks
-- the hot-path index, has to come past them.
-- ════════════════════════════════════════════════════════════════════════════
select ok(exists (select 1 from pg_class where relname = 'custom_models_resolve_idx'),
          'the gateway resolve index is still there');
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    not like '%base_model%',
  'gateway_resolve does not read base_models');
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    not like '%suspended_at%',
  'and it does not read suspended_at yet either — #31 owns that, and this '
  'assertion is the reminder that shipping it means changing this line');

select * from finish();
rollback;
