-- ============================================================================
-- search_base_models — hybrid retrieval fused by Reciprocal Rank Fusion (#28).
--
-- Why this file exists: a ranking is the one kind of output that looks correct
-- whatever it does. A fusion that silently drops an arm, a vector arm that
-- ranks over rows the catalog would never show, an embedding written at the
-- wrong width — none of those raise. They come back as a list, in an order, and
-- the only way to know the order is wrong is to assert on it.
--
-- Four things are tested, and they are different kinds of thing:
--
--   1. THE ARMS, SEPARATELY. Lexical alone finds a model by its name; SEMANTIC
--      ALONE FINDS A MODEL WHOSE TEXT SHARES NO LEXEME WITH THE QUERY. The
--      second is the acceptance criterion of the whole issue — it is the only
--      assertion here that the existing prefix FTS cannot already satisfy.
--
--   2. THE FUSION, ARITHMETICALLY. 1/(k + rank) summed over the arms that
--      ranked the document, at k = search_rrf_k(). Asserted as a number and not
--      merely as an order, because an order can be right for the wrong reason
--      with two documents and a coin flip.
--
--   3. THE BOUNDARY. Both arms read the same visible set. The sharp case is a
--      base model whose ONLY listing is a private draft and whose embedding is
--      the NEAREST of all: RLS admits the row to its owner, so only the RPC's
--      own predicates keep it out of the arm — and the fixture makes it the
--      nearest vector precisely so a leak shows up as a wrong first result.
--
--   4. THE DRIFT GUARD. With no query and no embedding this function must
--      return exactly the groups `catalog_grouped` returns. The two visibility
--      blocks are copies of one another (see the header of 20260820006000), and
--      this is what makes "keep them in step" enforceable.
--
-- What is deliberately NOT tested here: money. Nothing on the billing path is
-- touched, and 01-06 own that ground.
-- ============================================================================
begin;
select plan(50);

\set creator_a '00000000-0000-0000-0000-0000000000a1'
\set creator_c '00000000-0000-0000-0000-0000000000c1'
\set base_code   '00000000-0000-0000-0000-0000000000e1'
\set base_vision '00000000-0000-0000-0000-0000000000e2'
\set base_secret '00000000-0000-0000-0000-0000000000e3'

-- ════════════════════════════════════════════════════════════════════════════
-- 0. The plumbing
-- ════════════════════════════════════════════════════════════════════════════
select has_function('public', 'search_base_models',
  array['text', 'vector', 'text', 'text', 'integer', 'integer', 'text', 'text',
        'text', 'text', 'integer', 'integer', 'integer', 'double precision',
        'integer[]', 'integer[]', 'jsonb', 'jsonb'],
  'search_base_models exists with the documented signature');

-- k lives in one place, exactly as the embedding dimension does. If this number
-- moves, every score asserted below moves with it — which is the point: the
-- assertions read `search_rrf_k()` rather than the literal 60.
select is(public.search_rrf_k(), 60, 'RRF k is 60 — Cormack et al. 2009');

select is(
  (select p.prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_base_models'),
  false,
  'search_base_models is SECURITY INVOKER — RLS is still the floor');

select ok(
  has_function_privilege('anon',
    'public.search_base_models(text,vector,text,text,integer,integer,text,text,text,text,integer,integer,integer,double precision,integer[],integer[],jsonb,jsonb)',
    'execute'),
  'anon can search — the catalog is searchable signed out');

-- The WRITE side is service_role only. A creator who could write an embedding
-- could put their listing next to any query in the semantic arm.
select ok(
  not has_function_privilege('authenticated',
    'public.set_base_model_embedding(uuid,vector)', 'execute'),
  'a signed-in creator cannot write a base model embedding');
select ok(
  has_function_privilege('service_role',
    'public.set_base_model_embedding(uuid,vector)', 'execute'),
  'service_role can — the deploy-time embedder holds that key');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Fixture
--
-- Three base models. Their EMBEDDINGS are one-hot vectors in distinct slots, so
-- cosine distance between any two of them is exactly 1 and a blended query
-- vector has an exactly predictable order. The alternative — plausible-looking
-- random floats — would make every ranking assertion below depend on numbers
-- nobody chose.
-- ════════════════════════════════════════════════════════════════════════════
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', :'creator_c',
        'authenticated', 'authenticated', 'carol@search.test', 'x', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"user_name":"carolsearch","full_name":"Carol Search"}'::jsonb,
        now(), now(), '', '', '', '');

-- A one-hot vector at `p_slot`, or a two-slot blend. Built from
-- `embedding_dimension()` rather than from a literal 384, so a change of
-- embedding model breaks the migration and this file together instead of
-- leaving a fixture that is quietly the wrong width.
create function pg_temp.vec(p_slot_a int, p_w_a numeric default 1,
                            p_slot_b int default 0, p_w_b numeric default 0)
returns extensions.vector language sql as $fn$
  select ('[' || array_to_string(array(
      select case when i = p_slot_a then p_w_a
                  when i = p_slot_b then p_w_b
                  else 0 end
        from generate_series(1, public.embedding_dimension()) i), ',') || ']')
    ::extensions.vector;
$fn$;

insert into public.base_models (
  id, slug, display_name, summary, family, parameter_count,
  architecture, n_layers, n_kv_heads, head_dim, hidden_size,
  max_position_embeddings, use_cases, commercial_hosting, embedding
) values
  (:'base_code', 'qwen/qwen3-coder-8b', 'Qwen3 Coder 8B',
   'Dense 8B tuned for repository-scale editing.', 'qwen3', 8000000000,
   'qwen3', 36, 8, 128, 4096, 262144,
   array['code', 'tool-use'], 'allowed', pg_temp.vec(1)),
  (:'base_vision', 'meta/pixie-11b', 'Pixie 11B',
   'Image understanding and document parsing.', 'pixie', 11000000000,
   'llama', 40, 8, 128, 4096, 131072,
   array['vision', 'chat'], 'allowed', pg_temp.vec(2)),
  -- Nothing public serves this one. Its embedding sits in the SAME slot as the
  -- vision model, so any query that finds Pixie semantically finds this one
  -- first on the tiebreak unless the visibility predicate excludes it.
  (:'base_secret', 'private/ghost-9b', 'Ghost 9B',
   'Unreleased.', 'ghost', 9000000000,
   'llama', 32, 8, 128, 4096, 32768,
   array['vision'], 'allowed', pg_temp.vec(2));

create function pg_temp.listing(
  p_id uuid, p_user uuid, p_slug text, p_quant text,
  p_ctx integer, p_tps integer, p_price_out bigint, p_base uuid,
  p_visibility public.model_visibility
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
    36, 8, 128, p_ctx, true,
    p_tps, 'l4', 1000000, 4, 'x=1',
    p_price_out / 2, p_price_out,
    p_visibility, 'ready', p_base, now()
  );
$fn$;

select pg_temp.listing('00000000-0000-0000-0000-0000000000f1', :'creator_a',
  'qwen3-coder-8b-q4', 'Q4_K_M', 32768, 90, 120000, :'base_code', 'public');
select pg_temp.listing('00000000-0000-0000-0000-0000000000f2', :'creator_c',
  'pixie-11b-q4', 'Q4_K_M', 32768, 40, 300000, :'base_vision', 'public');
-- The boundary rows. Each is cheaper and faster than everything public, so a
-- leak lands in an aggregate as well as in a count.
select pg_temp.listing('00000000-0000-0000-0000-0000000000f3', :'creator_a',
  'ghost-9b-draft', 'Q4_K_M', 8192, 999, 1, :'base_secret', 'private');
select pg_temp.listing('00000000-0000-0000-0000-0000000000f4', :'creator_c',
  'pixie-11b-susp', 'Q4_0', 999999, 998, 2, :'base_vision', 'public');
update public.custom_models
   set suspended_at = now(), suspension_reason = 'operator takedown, fixture'
 where id = '00000000-0000-0000-0000-0000000000f4';
select pg_temp.listing('00000000-0000-0000-0000-0000000000f5', :'creator_c',
  'pixie-11b-gone', 'Q3_K_M', 888888, 997, 3, :'base_vision', 'public');
update public.custom_models set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000000f5';

-- One call, reused.
create function pg_temp.search(
  p_ts text default null,
  p_embedding extensions.vector default null,
  p_use_case text default null,
  p_handle text default null,
  p_sort text default 'relevance',
  p_creator text default null,
  -- Defaults to the RPC's own ceiling. The ranking-depth assertions pass 2
  -- explicitly, which is "rank everything": with three fixture models a
  -- production-shaped ceiling admits exactly one of them, and a fusion you
  -- cannot see two ranks of is a fusion you cannot assert on.
  p_max_distance double precision default 0.22
) returns jsonb language sql as $fn$
  select public.search_base_models(
    p_ts_query := p_ts,
    p_embedding := p_embedding,
    p_handle_fragment := p_handle,
    p_use_case := p_use_case,
    p_creator := p_creator,
    p_sort := p_sort,
    p_max_distance := p_max_distance,
    p_speed_steps := array[20, 40, 60, 90, 120],
    p_context_steps := array[8192, 32768, 128000]
  );
$fn$;

-- The group for one base slug out of a given call, or NULL if it is not there.
create function pg_temp.pick(p_result jsonb, p_slug text)
returns jsonb language sql as $fn$
  select g from jsonb_array_elements(p_result->'groups') g
   where g->>'base_slug' = p_slug;
$fn$;

-- The ordered list of base slugs a call returns — the ranking itself.
create function pg_temp.order_of(p_result jsonb)
returns text[] language sql as $fn$
  select array(select g->>'base_slug' from jsonb_array_elements(p_result->'groups') g);
$fn$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. THE LEXICAL ARM ALONE
-- ════════════════════════════════════════════════════════════════════════════
select isnt(pg_temp.pick(pg_temp.search(p_ts := 'coder:*'), 'qwen/qwen3-coder-8b'), null,
  'a lexical query finds the model by its name');
select is((pg_temp.search(p_ts := 'coder:*')->>'total')::int, 1,
  'and finds only it — a search is not the catalog');
select is((pg_temp.pick(pg_temp.search(p_ts := 'coder:*'), 'qwen/qwen3-coder-8b')->>'fts_rank')::int, 1,
  'it is rank 1 of the lexical arm');
select is(pg_temp.pick(pg_temp.search(p_ts := 'coder:*'), 'qwen/qwen3-coder-8b')->>'vector_rank', null,
  'and has no vector rank at all: no embedding was passed');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*'), 'qwen/qwen3-coder-8b')->>'rrf_score')::numeric,
  1.0 / (public.search_rrf_k() + 1),
  'so its fused score is one arm''s worth: 1/(k+1)');

-- A malformed tsquery is degraded to "no lexical arm", never raised: this
-- function is reachable from `?q=` on the front door.
select lives_ok(
  $$select public.search_base_models(p_ts_query := 'not a tsquery!!')$$,
  'a malformed tsquery degrades instead of raising 42601');

-- FR-MKT-003: the creator handle is searchable, and it is a separate sanitizer
-- from the tsquery, so it is a separate arm input.
select is((pg_temp.search(p_handle := 'carolsearch')->>'total')::int, 1,
  'a creator-handle fragment finds that creator''s models');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. THE SEMANTIC ARM ALONE — the acceptance criterion
--
-- `zzznolexeme` appears in no display name, slug, family, use case or summary in
-- the fixture, so the lexical arm returns nothing at all. The embedding points
-- at the vision model's slot. If hybrid retrieval works, Pixie comes back.
-- ════════════════════════════════════════════════════════════════════════════
select is((pg_temp.search(p_ts := 'zzznolexeme:*')->>'total')::int, 0,
  'the query matches nothing lexically');

select is((pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))->>'total')::int, 1,
  'but with its embedding the semantic arm answers it');
select is(
  pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))
    ->'groups'->0->>'base_slug',
  'meta/pixie-11b',
  'and it is the RIGHT model — a query that matches nothing lexically and '
  'everything semantically returns the model it means');
select is(
  (pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))
    ->'groups'->0->>'vector_rank')::int,
  1,
  'found at rank 1 of the vector arm');
select is(
  pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))
    ->'groups'->0->>'fts_rank',
  null,
  'and by no lexical rank at all — the arms are genuinely independent');

-- A base model that has not been embedded yet is not a nearest neighbour of
-- everything; it is simply not in the arm.
update public.base_models set embedding = null where id = :'base_vision';
select is((pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))->>'total')::int, 0,
  'an unembedded model is skipped by the vector arm, not ranked as distance NULL');
update public.base_models set embedding = pg_temp.vec(2) where id = :'base_vision';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. THE FUSION — arithmetic, not vibes
--
-- The query says `qwen` (lexical rank 1 = the coder, nothing else matches) and
-- points its vector at the vision model's slot (vector rank 1 = Pixie). Two
-- documents, one from each arm, each with exactly one arm's worth of score.
-- ════════════════════════════════════════════════════════════════════════════
select is((pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(2))->>'total')::int, 2,
  'a full outer join of the arms: a document either arm found is a result');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(2)),
                'meta/pixie-11b')->>'rrf_score')::numeric,
  1.0 / (public.search_rrf_k() + 1),
  'the semantic-only hit scores 1/(k+1)');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(2)),
                'qwen/qwen3-coder-8b')->>'rrf_score')::numeric,
  1.0 / (public.search_rrf_k() + 1),
  'and so does the lexical-only hit — RRF is scale-free, so neither arm outbids '
  'the other by having bigger numbers');

-- Now the same query with the vector pointing at the coder: it is rank 1 of BOTH
-- arms, so it scores twice and must outrank the model only one arm found.
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(1, 0.9, 2, 0.1), p_max_distance := 2),
                'qwen/qwen3-coder-8b')->>'rrf_score')::numeric,
  2.0 / (public.search_rrf_k() + 1),
  'a document both arms rank scores 1/(k+1) twice');
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(1, 0.9, 2, 0.1), p_max_distance := 2)),
  array['qwen/qwen3-coder-8b', 'meta/pixie-11b'],
  'and therefore outranks the document only one arm found');

-- Agreement between the arms is what RRF rewards, and the reward is bounded:
-- rank 2 of an arm is worth 1/(k+2), not half of rank 1. That is the property
-- that makes the constant matter, so it is asserted rather than assumed.
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(1, 0.9, 2, 0.1), p_max_distance := 2),
                'meta/pixie-11b')->>'vector_rank')::int,
  2,
  'the second-nearest vector is rank 2 of the arm');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(1, 0.9, 2, 0.1), p_max_distance := 2),
                'meta/pixie-11b')->>'rrf_score')::numeric,
  1.0 / (public.search_rrf_k() + 2),
  'and scores 1/(k+2) — a rank, never a distance');

-- ── The ceiling is what makes the arm a retrieval ──────────────────────────
-- Same query, same embedding, DEFAULT ceiling: the model whose vector points
-- somewhere else entirely drops out of the arm. Without this the semantic arm
-- returns the whole catalog for every query, and "search" becomes "re-sort".
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'zzznolexeme:*',
                                  p_embedding := pg_temp.vec(1, 0.9, 2, 0.1))),
  array['qwen/qwen3-coder-8b'],
  'the distance ceiling drops a model the query does not point at');
select is(
  (pg_temp.search(p_ts := 'zzznolexeme:*',
                  p_embedding := pg_temp.vec(1, 0.9, 2, 0.1),
                  p_max_distance := 2)->>'total')::int,
  2,
  'and raising the ceiling admits it again — the arm is a retrieval, not a sort');

-- An explicit sort beats relevance. `?sort=` is only ever set when the visitor
-- chose one (the default is omitted from the URL), so this is the one case where
-- the fused order must be overruled.
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'coder:*', p_embedding := pg_temp.vec(1, 0.9, 2, 0.1),
                                  p_sort := 'price', p_max_distance := 2)),
  array['qwen/qwen3-coder-8b', 'meta/pixie-11b'],
  'an explicit sort overrules the fused order');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. THE EMBEDDING IS INPUT FROM THE FRONT DOOR
-- ════════════════════════════════════════════════════════════════════════════
-- A wrong-width vector is what a cached client sends the morning after the
-- embedding model changes. It must cost that visitor the semantic arm, not the
-- page.
select lives_ok(
  $$select public.search_base_models(
      p_ts_query := 'qwen:*', p_embedding := '[0.1,0.2,0.3]'::extensions.vector)$$,
  'a wrong-width query embedding does not raise');
select is(
  (public.search_base_models(
     p_ts_query := 'zzznolexeme:*',
     p_embedding := '[0.1,0.2,0.3]'::extensions.vector)->>'total')::int,
  0,
  'it degrades to a lexical-only search rather than being trusted at the wrong width');

-- The WRITE side is the opposite stance, and deliberately so: a wrong width
-- reaching the column is a model that silently never ranks again.
select throws_ok(
  format($$select public.set_base_model_embedding(%L, '[0.1,0.2,0.3]'::extensions.vector)$$,
         :'base_code'),
  '22000',
  null,
  'writing a wrong-width embedding raises instead of silently storing nothing');

select lives_ok(
  format($$select public.set_base_model_embedding(%L, %L::extensions.vector)$$,
         :'base_code', pg_temp.vec(3)::text),
  'a correctly sized embedding writes');
select is(
  (select embedding from public.base_models where id = :'base_code'),
  pg_temp.vec(3),
  'and it is the vector that was written');
-- Put it back where the rest of the file expects it.
select public.set_base_model_embedding(:'base_code', pg_temp.vec(1));

-- ════════════════════════════════════════════════════════════════════════════
-- 6. THE BOUNDARY — both arms read the same visible set
--
-- `private/ghost-9b` shares the vision model's embedding slot and sorts ahead of
-- it on the group-key tiebreak, so if the vector arm ranked over `base_models`
-- rather than over the visible listings it would be the FIRST result of the
-- assertion below, not merely present.
-- ════════════════════════════════════════════════════════════════════════════
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))),
  array['meta/pixie-11b'],
  'a base model whose only listing is a private draft is not in the vector arm');

select is(pg_temp.pick(pg_temp.search(p_ts := 'ghost:*'), 'private/ghost-9b'), null,
  'nor in the lexical arm — one visibility block, both arms');

-- The suspended and the deleted listing are on a model that IS public, so they
-- can only be caught in the aggregates.
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'pixie:*'), 'meta/pixie-11b')->>'listing_count')::int,
  1,
  'a suspended and a soft-deleted listing do not count towards the group');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'pixie:*'), 'meta/pixie-11b')->>'best_tokens_per_second')::int,
  40,
  'nor contribute their 998 tok/s to the best case');
select is(
  (pg_temp.pick(pg_temp.search(p_ts := 'pixie:*'), 'meta/pixie-11b')->>'price_completion_micro')::bigint,
  300000::bigint,
  'nor their price to the `from` price');

-- The sharp case: RLS admits the creator their own private row, so only the
-- RPC's predicates keep it out of their own search results.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is(
  (select count(*) from public.custom_models
    where id = '00000000-0000-0000-0000-0000000000f3'),
  1::bigint,
  'RLS admits the creator their own private listing — so only the predicate excludes it');
select is(pg_temp.pick(pg_temp.search(p_ts := 'ghost:*'), 'private/ghost-9b'), null,
  'and a creator searching the public catalog does not find their own draft in it');
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))),
  array['meta/pixie-11b'],
  'not even through the vector arm, where its embedding is the nearest of all');
reset role;

set local role anon;
select is((pg_temp.search(p_ts := 'coder:*')->>'total')::int, 1,
  'anon searches the same catalog — signed out is not a different index');
select is(
  pg_temp.order_of(pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))),
  array['meta/pixie-11b'],
  'and gets the same semantic answer');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. LAYER A — the closed use-case vocabulary, counted
--
-- The tabs are the layer that improves discovery today, and the invariant is the
-- same one #26 asserts: a tab count that disagrees with the rows that tab
-- returns is worse than no tab.
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select count(*) from jsonb_each_text(pg_temp.search()->'categories'->'by_key') c
    where c.value::int <> (pg_temp.search(p_use_case := c.key)->>'total')::int),
  0::bigint,
  'every use-case tab count equals the total that tab returns');
select is(
  (pg_temp.search()->'categories'->>'all')::int,
  (pg_temp.search()->>'total')::int,
  'the All tab count equals the unfiltered total');
select is(
  (pg_temp.search(p_ts := 'zzznolexeme:*', p_embedding := pg_temp.vec(2))
    ->'categories'->>'all')::int,
  1,
  'and the tabs are counted over the SEARCH result set, not over the catalog');
select is(
  pg_temp.pick(pg_temp.search(p_use_case := 'code'), 'qwen/qwen3-coder-8b')->'use_cases',
  '["code", "tool-use"]'::jsonb,
  'the vocabulary reaches the card as the closed set the schema enforces');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. THE DRIFT GUARD
--
-- With no arms at all, this function IS the catalog. That is not a convenience:
-- it is the only mechanical check that the visibility block copied into
-- 20260820006000 still says what the one in 20260820001000 says. A rule added to
-- either and not the other fails here, in one assertion, on the next CI run.
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select array(select g->>'group_key'
                  from jsonb_array_elements(pg_temp.search(p_sort := 'newest')->'groups') g
                 order by 1)),
  (select array(select g->>'group_key'
                  from jsonb_array_elements(
                    public.catalog_grouped(p_limit := 24)->'groups') g
                 order by 1)),
  'an unsearched search_base_models returns exactly catalog_grouped''s groups');
select is(
  (pg_temp.search(p_sort := 'newest')->>'total')::int,
  (public.catalog_grouped(p_limit := 24)->>'total')::int,
  'and exactly its total — the two visibility blocks have not drifted');

select finish();
rollback;
