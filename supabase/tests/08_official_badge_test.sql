-- ============================================================================
-- The `official` badge — who owns the upstream repository (GitHub #30).
--
-- This file is the authority on the RULE. There is deliberately no TypeScript
-- copy of it: a badge decided in two places is a badge that disagrees with
-- itself the first time one of them is edited, which is the failure this repo
-- already documents for its two GPU tier catalogs. TypeScript owns the strings
-- (lib/hf, lib/marketplace/provenance.ts); SQL owns the decision.
--
-- Four things are worth asserting here, and they are different kinds of thing:
--
--   1. The RULE — username match, org match, base-model-publisher match, and
--      every way a listing correctly fails to earn the badge.
--   2. The NEUTRAL DEFAULT. "No badge" is reachable three separate ways (no HF
--      account linked at all, a different account, an org they are not in) and
--      all three must be indistinguishable from outside. A creator who never
--      signed in with Hugging Face is not a suspicious creator.
--   3. The FORGERY SURFACE. Every column of `hf_identities` is an assertion
--      about an account on someone else's service. A creator who could write
--      `orgs` could wear a lab's badge, and the absence of a write policy is the
--      whole security argument — there is nothing else behind it.
--   4. The MONEY BOUNDARY. HF OAuth proves control of an account, not
--      authorship of weights, so the badge must not reach the gateway, a
--      settlement, or the right to publish. Those assertions are TRIPWIRES:
--      they pass today by construction and exist to fail loudly for whoever
--      wires the badge into something that pays out.
-- ============================================================================
begin;
select plan(38);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set model   '00000000-0000-0000-0000-0000000000c1'

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The plumbing exists
-- ════════════════════════════════════════════════════════════════════════════
select has_table('public', 'hf_identities', 'hf_identities exists');
select has_function('public', 'listing_is_official', 'the badge oracle exists');
select has_function('public', 'hf_namespaces_valid', 'the namespace-array predicate exists');

-- The composite argument is not decoration: it is what makes PostgREST expose
-- the function as a VIRTUAL COLUMN of `custom_models`, which is the only reason
-- the catalog can read the badge in the same indexed query as the rest of the
-- card. A refactor to `listing_is_official(uuid)` would typecheck, pass every
-- other assertion in this file, and silently drop the column out of the
-- projection — leaving every listing rendered as third-party.
select ok(
  exists (
    select 1
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'listing_is_official'
       and p.pronargs = 1
       and p.proargtypes[0] = 'public.custom_models'::regtype::oid
  ),
  'and its single argument is still the composite row PostgREST needs');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Normalization is enforced by the schema, not only by the writer
--
-- lib/hf/namespaces.ts lowercases before it writes. These assertions are what
-- make that a guarantee rather than a habit: a mixed-case row would match
-- nothing, and the badge would go missing with no error raised anywhere.
-- ════════════════════════════════════════════════════════════════════════════
delete from public.hf_identities where user_id = :'creator'::uuid;

select throws_ok(
  format($$ insert into public.hf_identities (user_id, hf_sub, username)
            values (%L, 'sub-1', 'JonathanColetti') $$, :'creator'),
  '23514', null, 'a mixed-case username is rejected, not silently stored');
select throws_ok(
  format($$ insert into public.hf_identities (user_id, hf_sub, username, orgs)
            values (%L, 'sub-1', 'jonathancoletti', array['Qwen']) $$, :'creator'),
  '23514', null, 'a mixed-case org is rejected too');
select throws_ok(
  format($$ insert into public.hf_identities (user_id, hf_sub, username, orgs)
            values (%L, 'sub-1', 'jonathancoletti', array['qwen', null]) $$, :'creator'),
  '23514', null, 'a NULL org element is rejected — bool_and alone would swallow it');
select lives_ok(
  format($$ insert into public.hf_identities (user_id, hf_sub, username, orgs)
            values (%L, 'sub-1', 'jonathancoletti', '{}') $$, :'creator'),
  'a normalized identity with no orgs inserts');

select is((select memberships_readable from public.hf_identities where user_id = :'creator'::uuid),
          false,
          'memberships_readable defaults to false — "never allowed to look", not "no orgs"');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The rule
--
-- The seeded listing serves `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` and is
-- grouped to base model `jonathancoletti/qwen3.8-27b-uncensored`, so it is the
-- one fixture where both arms of the rule are live at once. Every case below
-- moves exactly one fact.
-- ════════════════════════════════════════════════════════════════════════════
create function pg_temp.official(p_id uuid) returns boolean language sql as $$
  select public.listing_is_official(m) from public.custom_models m where m.id = p_id;
$$;

select is(pg_temp.official(:'model'::uuid), true,
          'the creator''s username owns the repo the listing serves → official');

update public.hf_identities set username = 'someoneelse' where user_id = :'creator'::uuid;
select is(pg_temp.official(:'model'::uuid), false,
          'a different HF account → third-party, the neutral state');

update public.hf_identities set orgs = array['jonathancoletti'] where user_id = :'creator'::uuid;
select is(pg_temp.official(:'model'::uuid), true,
          'an ORG the creator belongs to owns the repo → official');

update public.hf_identities set orgs = array['qwen', 'meta-llama'] where user_id = :'creator'::uuid;
select is(pg_temp.official(:'model'::uuid), false,
          'belonging to other orgs earns nothing');

-- ── The base-model arm ──────────────────────────────────────────────────────
-- The lab that serves its own weights through a quantization repo in a namespace
-- it does not own. `hf_repo_slug` alone would call this third-party, which is
-- the one case where the badge would be most obviously wrong.
\set bm_qwen '00000000-0000-0000-0000-0000000000f8'
\set quant   '00000000-0000-0000-0000-0000000000e8'

insert into public.base_models (id, slug, display_name)
values (:'bm_qwen'::uuid, 'qwen/qwen3-8b', 'Qwen3 8B');

insert into public.custom_models (
  id, user_id, slug, display_name, hf_repo_slug, served_model_name, runtime,
  weights_bytes, active_weights_bytes,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  visibility, status, base_model_id
) values (
  :'quant'::uuid, :'creator'::uuid, 'qwen3-8b-gguf', 'Qwen3 8B GGUF',
  'TheBloke/Qwen3-8B-GGUF', 'TheBloke/Qwen3-8B-GGUF', 'llamacpp',
  1000000000, 1000000000, 100000, 200000,
  'private', 'draft', :'bm_qwen'::uuid
);

select is(pg_temp.official(:'quant'::uuid), true,
          'the base model''s PUBLISHER counts, even when the deployed repo''s owner does not');

update public.hf_identities set orgs = array['meta-llama'] where user_id = :'creator'::uuid;
select is(pg_temp.official(:'quant'::uuid), false,
          'and it drops away the moment that org membership does');

-- The other direction: owning the deployed repo is enough on its own, with no
-- base model resolved at all. Requiring BOTH arms would mean no listing can be
-- official until the #25 cascade has grouped it — a badge that does not exist
-- yet is not a stricter badge, it is an absent one.
update public.hf_identities set username = 'thebloke', orgs = '{}'
 where user_id = :'creator'::uuid;
update public.custom_models set base_model_id = null where id = :'quant'::uuid;
select is(pg_temp.official(:'quant'::uuid), true,
          'owning the deployed repo is sufficient with no base model resolved');

-- ── Every way "no badge" happens ────────────────────────────────────────────
delete from public.hf_identities where user_id = :'creator'::uuid;
select is(pg_temp.official(:'model'::uuid), false,
          'no linked HF account → third-party, identically to a mismatch');

-- ── A badge belongs to an account, not to a repository ──────────────────
-- Two creators may serve the same weights — that is what base_models exists to
-- group, and 07 already asserts the duplicate-listing constraint permits it. The
-- one who owns the upstream repo is official; the other is not, and neither fact
-- says anything about the second listing's throughput, context or price.
\set rehost '00000000-0000-0000-0000-0000000000e9'
insert into public.hf_identities (user_id, hf_sub, username, orgs)
values (:'creator'::uuid, 'sub-1', 'jonathancoletti', array['qwen']);
insert into public.custom_models (
  id, user_id, slug, display_name, hf_repo_slug, served_model_name, runtime,
  weights_bytes, active_weights_bytes,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  visibility, status
) values (
  :'rehost'::uuid, :'payer'::uuid, 'same-weights', 'Same weights',
  'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',
  'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',
  'llamacpp', 1000000000, 1000000000, 100000, 200000, 'public', 'draft'
);

select is(pg_temp.official(:'model'::uuid), true, 'the repo owner''s listing is official');
select is(pg_temp.official(:'rehost'::uuid), false,
          'and a second creator serving the SAME repo is not — a badge belongs to an '
          'account, not to a set of weights');

-- ── The forged-row guard ────────────────────────────────────────────────────
-- A composite-argument function is callable with a HAND-BUILT row. If the rule
-- trusted the argument's `user_id` and `hf_repo_slug`, it would be an oracle for
-- guessing a creator's org list one call at a time: pick a namespace, ask, read
-- the boolean. Only `id` is trusted; every other fact is re-read from the table.
select is(
  (select public.listing_is_official(
            jsonb_populate_record(null::public.custom_models,
              to_jsonb(m) || jsonb_build_object('id', '00000000-0000-0000-0000-00000000beef')))
     from public.custom_models m where m.id = :'model'::uuid),
  false,
  'a row carrying a foreign id answers about THAT id — the payload is not trusted');

select is(
  (select public.listing_is_official(
            jsonb_populate_record(null::public.custom_models,
              to_jsonb(m) || jsonb_build_object('user_id', :'payer',
                                                'hf_repo_slug', 'qwen/qwen3-8b')))
     from public.custom_models m where m.id = :'model'::uuid),
  true,
  'and a forged owner and repo on a REAL id change nothing — both are re-read');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The forgery surface
--
-- There is no cryptography behind `hf_identities` at read time. Its values are
-- worth something only because the sole writer is /auth/callback, holding a
-- token the Hub issued seconds earlier. The write policies ARE the security
-- argument, so they get asserted rather than assumed.
-- ════════════════════════════════════════════════════════════════════════════
select ok(not has_table_privilege('anon', 'public.hf_identities', 'SELECT'),
          'anon cannot read hf_identities — the badge is public, the org list is not');
select ok(not has_table_privilege('authenticated', 'public.hf_identities', 'INSERT'),
          'authenticated cannot INSERT an identity');
select ok(not has_table_privilege('authenticated', 'public.hf_identities', 'UPDATE'),
          'authenticated cannot UPDATE one — this is what stops a creator typing `qwen` into orgs');
select ok(not has_table_privilege('authenticated', 'public.hf_identities', 'DELETE'),
          'authenticated cannot DELETE one');
select ok(has_table_privilege('authenticated', 'public.hf_identities', 'SELECT'),
          'but a creator may READ, so the Studio can name the account that is linked');
select ok(has_table_privilege('service_role', 'public.hf_identities', 'INSERT'),
          'and the callback, as service_role, can write');

insert into public.hf_identities (user_id, hf_sub, username)
values (:'payer'::uuid, 'sub-2', 'someoneelse');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;

-- Guard: without this the counts below could both be zero and pass vacuously.
select is(auth.uid(), :'creator'::uuid, 'the session really is the creator');
select is((select count(*)::int from public.hf_identities where user_id = auth.uid()), 1,
          'a creator sees their own link');
select is((select count(*)::int from public.hf_identities where user_id <> auth.uid()), 0,
          'and nobody else''s');

-- The pair that is the entire point of the SECURITY DEFINER oracle: the BADGE
-- stays readable by a caller who cannot read the table it is derived from.
-- Inlined rather than via pg_temp, because a temp-schema helper is not reachable
-- under a switched role.
select is(
  (select public.listing_is_official(m) from public.custom_models m where m.id = :'model'::uuid),
  true,
  'the oracle answers for a caller with no access to hf_identities at all');

reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The badge is not allowed to matter
--
-- Tripwires. Each passes today by construction; each exists so that wiring the
-- badge into money, routing or the right to publish fails HERE first, against a
-- message saying why it must not.
-- ════════════════════════════════════════════════════════════════════════════
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    not like '%hf_identit%',
  'gateway_resolve does not read hf_identities — the badge never routes a request');
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    not like '%listing_is_official%',
  'nor the badge itself');
select ok(
  pg_get_functiondef(
    'public.deduct_token_cost(uuid,integer,integer,numeric,numeric,boolean,boolean,boolean)'::regprocedure)
    not like '%official%',
  'settlement does not read the badge — HF OAuth proves control of an account, not '
  'authorship of weights, and #29 owns the gate that governs earning');
select ok(
  pg_get_functiondef('public.listing_is_official(public.custom_models)'::regprocedure)
    not like '%price%',
  'and the badge reads no price either — the dependency runs in neither direction');

-- The right to list is untouched, which is the difference between a badge and a
-- gate. Both creator-facing policies are asserted, because either one of them
-- growing a reference to the badge is the same regression.
select ok(
  (select pg_get_expr(polwithcheck, polrelid)
     from pg_policy where polname = 'custom_models_insert_own') not like '%hf_identit%',
  'the creator INSERT policy does not mention hf_identities');
select ok(
  (select pg_get_expr(polqual, polrelid)
     from pg_policy where polname = 'custom_models_select_public') not like '%official%',
  'and the public catalog policy does not filter on the badge — a third-party listing '
  'is listed on exactly the same terms');

-- End to end: a creator with no HF identity at all can still take a listing
-- public. If this ever fails, the badge has become a gate.
delete from public.hf_identities where user_id = :'creator'::uuid;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select lives_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'quant'),
  'an unlinked creator can still publish — the badge gates nothing');

select * from finish();
rollback;
