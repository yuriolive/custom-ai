-- ============================================================================
-- The licence gate — what may be PUBLISHED, and on whose terms (#29, §5.1).
--
-- Four rows of one table, and every one of them is a different kind of failure
-- if it is wrong:
--
--   allowed      publishes. Nothing to prove except that the gate does not
--                block the ordinary case, which is most listings.
--   conditional  publishes only against an acknowledgement of the licence text
--                actually in force. A STALE ack — the creator accepted Llama
--                3.1's text and the weights are now under 3.3's — is not an
--                ack, and the whole reason `license_ack_version` is a version
--                rather than a boolean is to make that case distinguishable.
--   prohibited   never `public`. A private deploy stays legal: the creator is
--                spending their own money on their own compute, and the gateway
--                404s a private listing for anybody who is not its owner.
--   unknown      neither published nor rejected. It waits in a queue somebody
--                can count.
--
-- The gate is enforced TWICE on purpose and the two halves do different jobs:
-- the CHECK refuses a request to publish something ungated, and the trigger
-- DEMOTES a listing whose licence moved under it. Asserting only one of them
-- would leave either a takedown that fails or a publish that silently does
-- nothing, so both directions are tested on every row of the table.
--
-- What is deliberately NOT tested here: money. This migration touches no money
-- column, no settlement RPC and no billing invariant; 01-06 own that ground.
-- The one money-adjacent claim §5.1 makes — a prohibited model never accrues
-- `creator_earnings` — is a CONSEQUENCE of three facts that already hold, and
-- section 9 asserts the two of them that live in this schema rather than
-- re-deriving a settlement test.
-- ============================================================================
begin;
select plan(83);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set seeded  '00000000-0000-0000-0000-0000000000c1'

-- Base models, one per verdict, plus a chain to walk.
\set bm_allowed     '00000000-0000-0000-0000-00000000ba01'
\set bm_conditional '00000000-0000-0000-0000-00000000ba02'
\set bm_prohibited  '00000000-0000-0000-0000-00000000ba03'
\set bm_unknown     '00000000-0000-0000-0000-00000000ba04'
\set bm_child       '00000000-0000-0000-0000-00000000ba05'
\set bm_grandchild  '00000000-0000-0000-0000-00000000ba06'

-- Listings.
\set l_a '00000000-0000-0000-0000-00000000c101'
\set l_b '00000000-0000-0000-0000-00000000c102'
\set l_c '00000000-0000-0000-0000-00000000c103'
\set l_d '00000000-0000-0000-0000-00000000c104'
\set l_e '00000000-0000-0000-0000-00000000c105'

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The plumbing exists
-- ════════════════════════════════════════════════════════════════════════════
select has_column('public', 'custom_models', 'license_hosting',
                  'custom_models.license_hosting');
select has_column('public', 'custom_models', 'license_terms_version',
                  'custom_models.license_terms_version');
select has_column('public', 'custom_models', 'license_public_requested_at',
                  'custom_models.license_public_requested_at');
select col_not_null('public', 'custom_models', 'license_hosting',
                    'license_hosting is NOT NULL — three-valued logic in a publish gate is how prohibited becomes allowed');
select col_default_is('public', 'custom_models', 'license_hosting', 'unknown',
                      'and it defaults to unknown, not to allowed');
select has_function('public', 'license_governing', array['uuid'],
                    'license_governing() exists');
select ok(exists (select 1 from pg_constraint
                   where conname = 'custom_models_public_needs_license'),
          'the gate is a CHECK constraint, not just pipeline code');
select ok(exists (select 1 from pg_trigger
                   where tgname = 'custom_models_license_gate_insert'),
          'the mirror is written on INSERT');
select ok(exists (select 1 from pg_trigger
                   where tgname = 'custom_models_license_gate_update'),
          'and re-written on UPDATE');
select ok(exists (select 1 from pg_trigger
                   where tgname = 'base_models_resync_license_gate'),
          'a licence change on base_models reaches the listings it governs');
select has_view('public', 'license_review_queue', 'the review queue exists');

-- NOT VALID is the one compromise in the migration and it should never become
-- invisible: an existing public listing whose licence was never captured is
-- grandfathered rather than unpublished by a migration nobody was watching.
-- Validating it later is a deliberate one-line diff, and this assertion is what
-- makes that diff show up here too.
select is((select convalidated from pg_constraint
            where conname = 'custom_models_public_needs_license'),
          false,
          'the gate is NOT VALID: pre-existing public rows are grandfathered, every new write is not');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Fixtures
--
-- `vllm` with weights_format `unknown` satisfies
-- custom_models_runtime_matches_format and sidesteps _gguf_needs_file; neither
-- is under test here. The listing factory writes `visibility` LAST via the
-- return value so a caller can insert a row the gate would refuse and see the
-- refusal, rather than having the factory pre-empt it.
-- ════════════════════════════════════════════════════════════════════════════
insert into public.base_models (id, slug, display_name, license_id, license_name,
                                license_version, commercial_hosting)
values (:'bm_allowed', 'acme/permissive', 'Permissive 7B',
        'apache-2.0', 'Apache License 2.0', '2.0', 'allowed'),
       (:'bm_conditional', 'meta/llama-3.1-8b', 'Llama 3.1 8B',
        'llama3.1', 'Llama 3.1 Community License', '3.1', 'conditional'),
       (:'bm_prohibited', 'acme/research-only', 'Research Only 7B',
        'cc-by-nc-4.0', 'CC BY-NC 4.0', null, 'prohibited'),
       (:'bm_unknown', 'acme/unclassified', 'Unclassified 7B',
        null, null, null, 'unknown');

create function pg_temp.mk_listing(
  p_id uuid, p_user uuid, p_slug text,
  p_base uuid default null,
  p_visibility public.model_visibility default 'private',
  p_ack_version text default null
) returns uuid language sql as $$
  insert into public.custom_models (
    id, user_id, slug, display_name, hf_repo_slug, served_model_name,
    runtime, weights_bytes, active_weights_bytes,
    price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
    visibility, status, base_model_id,
    license_ack_at, license_ack_version,
    -- custom_models_ready_needs_endpoint + _ready_needs_placement
    upstream_endpoint_ref, gpu_tier_id, gpu_usd_per_hour_micro_snapshot,
    max_concurrent_streams, measured_tokens_per_second
  ) values (
    p_id, p_user, p_slug, p_slug, 'acme/' || p_slug, 'acme/' || p_slug,
    'vllm', 1000000000, 1000000000, 100000, 200000,
    p_visibility, 'ready', p_base,
    case when p_ack_version is not null then now() end, p_ack_version,
    '?ref=' || p_slug,
    (select id from public.gpu_tiers where is_enabled limit 1),
    1000000, 4, 40
  ) returning id;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The mirror is the platform's, not the creator's
--
-- A CHECK can only read its own row, so the verdict has to BE on the row — and
-- a mirror a client can write is not a mirror, it is a claim. The trigger
-- overwrites it on the same statement rather than the RLS policy rejecting it,
-- which is defence at the table instead of in one of two policies that a third
-- migration has to remember to re-declare.
-- ════════════════════════════════════════════════════════════════════════════
select is(pg_temp.mk_listing(:'l_a', :'creator', 'gate-allowed', :'bm_allowed'::uuid),
          :'l_a'::uuid, 'a listing under a permissive licence inserts');
select is((select license_hosting::text from public.custom_models where id = :'l_a'::uuid),
          'allowed', 'and its mirror is filled in from the base model, not from the insert');
select is((select license_terms_version from public.custom_models where id = :'l_a'::uuid),
          '2.0', 'the terms version is the licence REVISION where the card declares one');

select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'gate-unknown', %L) $$,
         :'l_b', :'creator', :'bm_unknown'),
  'a listing whose weights have no established terms still DEPLOYS');
select is((select license_hosting::text from public.custom_models where id = :'l_b'::uuid),
          'unknown', 'and reads `unknown` rather than NULL');

-- A listing pointing at nothing is the #25 outcome that must not become a hole:
-- resolution never fails a deployment, so an ungrouped listing is common, and
-- nobody has identified those weights — let alone their terms.
select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'gate-ungrouped', null) $$, :'l_c', :'creator'),
  'a listing with no base model at all inserts');
select is((select license_hosting::text from public.custom_models where id = :'l_c'::uuid),
          'unknown', 'and is `unknown`: unidentified weights have unestablished terms');

-- The forged write, on a row that exists.
update public.custom_models
   set license_hosting = 'allowed', license_terms_version = 'i-said-so'
 where id = :'l_b'::uuid;
select is((select license_hosting::text from public.custom_models where id = :'l_b'::uuid),
          'unknown', 'a forged license_hosting is overwritten with the truth on the same statement');
select is((select license_terms_version from public.custom_models where id = :'l_b'::uuid),
          null, 'and so is a forged terms version');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The four rows, on the way IN
-- ════════════════════════════════════════════════════════════════════════════
select lives_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_a'),
  'allowed publishes');

select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_b'),
  '23514', null,
  'unknown does not publish — and it RAISES rather than silently doing nothing');
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_c'),
  '23514', null, 'nor does an ungrouped listing');

select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'gate-prohibited', %L, 'private') $$,
         :'l_d', :'creator', :'bm_prohibited'),
  'a PRIVATE deploy of prohibited weights is fine: the creator''s own money, the creator''s own compute');
select is((select license_hosting::text from public.custom_models where id = :'l_d'::uuid),
          'prohibited', 'and the verdict is recorded on it');
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_d'),
  '23514', null, 'prohibited can never reach public');
select throws_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'gate-prohibited-2', %L, 'public') $$,
         :'l_e', :'creator', :'bm_prohibited'),
  '23514', null, 'and not by being born public either — the INSERT is checked too');
select is((select count(*)::int from public.custom_models where id = :'l_e'::uuid),
          0, 'the rejected row really is absent');

-- ── conditional: the ack, and what a stale one is worth ────────────────────
select lives_ok(
  format($$ select pg_temp.mk_listing(%L, %L, 'gate-conditional', %L, 'private') $$,
         :'l_e', :'creator', :'bm_conditional'),
  'a conditional listing deploys');
select is((select license_terms_version from public.custom_models where id = :'l_e'::uuid),
          '3.1', 'and knows which licence text it has to be acknowledged against');
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_e'),
  '23514', null, 'conditional does not publish without an acknowledgement');

update public.custom_models
   set license_ack_at = now(), license_ack_version = '3.0'
 where id = :'l_e'::uuid;
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_e'),
  '23514', null,
  'nor with an ack of the PREVIOUS text — a revised licence is a different licence');

update public.custom_models
   set license_ack_at = now(), license_ack_version = '3.1'
 where id = :'l_e'::uuid;
select lives_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_e'),
  'and publishes once the acknowledgement names the text actually in force');

-- Half an ack is not an ack. `custom_models_license_ack_complete` (#24) already
-- forbids one half; this is the other half of that: a timestamp and a version
-- that name the wrong document are complete and still not enough.
update public.custom_models set visibility = 'private' where id = :'l_e'::uuid;
update public.custom_models set license_ack_at = null, license_ack_version = null
 where id = :'l_e'::uuid;
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_e'),
  '23514', null, 'withdrawing the acknowledgement withdraws the right to publish');

-- A conditional verdict with no licence recorded at all cannot be
-- acknowledged, and therefore cannot publish. Fail-closed on purpose: it is a
-- conclusion with no premise, and the operator who reached it has to say which
-- document they read.
update public.base_models
   set license_id = null, license_name = null, license_version = null
 where id = :'bm_conditional'::uuid;
select is((select license_terms_version from public.custom_models where id = :'l_e'::uuid),
          null, 'a conditional licence with no id and no version has nothing to acknowledge');
update public.custom_models
   set license_ack_at = now(), license_ack_version = '3.1'
 where id = :'l_e'::uuid;
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_e'),
  '23514', null, 'so it does not publish, whatever the ack claims');
update public.base_models
   set license_id = 'llama3.1', license_name = 'Llama 3.1 Community License',
       license_version = '3.1'
 where id = :'bm_conditional'::uuid;
select is((select license_terms_version from public.custom_models where id = :'l_e'::uuid),
          '3.1', 'restoring the licence restores what there is to acknowledge');

-- Where a card declares a licence but no revision, the ID is the identity of
-- the text: `llama3.1` and `llama3.3` are different documents, so an ack still
-- names something specific.
select is((select license_terms_version from public.custom_models where id = :'l_d'::uuid),
          'cc-by-nc-4.0', 'with no declared revision the licence id IS the terms version');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The chain: a derivative does not escape its parent's terms
--
-- Not a hypothetical. "apache-2.0" on a Llama fine-tune is a common and wrong
-- model card, and #25's cascade writes whatever the repo declares. The verdict
-- is therefore the STRICTEST reading over the row and its ancestors, with
-- `unknown` DEFERRING rather than winning — the same rule `strictest()` applies
-- in packages/hf-probe/src/license.ts, for the same reason.
-- ════════════════════════════════════════════════════════════════════════════
insert into public.base_models (id, slug, display_name, parent_id,
                                license_id, license_version, commercial_hosting)
values (:'bm_child', 'somelab/research-ft', 'Research FT',
        :'bm_prohibited'::uuid, 'apache-2.0', '2.0', 'allowed');

select is((select hosting::text from public.license_governing(:'bm_child'::uuid)),
          'prohibited',
          'a permissive fine-tune of non-commercial weights is still non-commercial');
select is((select terms_version from public.license_governing(:'bm_child'::uuid)),
          'cc-by-nc-4.0',
          'and the terms that govern are the ones that actually restrict');

insert into public.base_models (id, slug, display_name, parent_id, commercial_hosting)
values (:'bm_grandchild', 'somelab/research-ft-quant', 'Research FT Q4',
        :'bm_child'::uuid, 'unknown');
select is((select hosting::text from public.license_governing(:'bm_grandchild'::uuid)),
          'prohibited', 'and it reaches a grandchild: the walk is not one level deep');

update public.base_models set commercial_hosting = 'allowed'
 where id = :'bm_prohibited'::uuid;
select is((select hosting::text from public.license_governing(:'bm_grandchild'::uuid)),
          'allowed',
          '`unknown` on a row DEFERS to a real answer in the chain rather than blocking it');
select is((select terms_version from public.license_governing(:'bm_grandchild'::uuid)),
          '2.0',
          'and the nearest contributing row supplies the text — the child''s, not the root''s');
update public.base_models set commercial_hosting = 'prohibited'
 where id = :'bm_prohibited'::uuid;

select is((select hosting::text from public.license_governing(
             '00000000-0000-0000-0000-0000000000ff'::uuid)),
          null, 'a base model that does not exist yields no row rather than a verdict');
select is((select count(*)::int from public.license_governing(null)),
          0, 'and neither does NULL');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. When the licence moves under a published listing
--
-- This is the direction the CHECK cannot handle. An operator classifying
-- weights as prohibited must SUCCEED — a takedown that fails with a constraint
-- violation leaves the listing published, which is precisely backwards — so the
-- trigger demotes instead of raising.
-- ════════════════════════════════════════════════════════════════════════════
select is((select visibility::text from public.custom_models where id = :'l_a'::uuid),
          'public', 'the permissive listing is published');

update public.base_models set commercial_hosting = 'prohibited'
 where id = :'bm_allowed'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_a'::uuid),
          'private', 'classifying its weights as prohibited takes it out of the catalog');
select isnt((select license_public_requested_at from public.custom_models where id = :'l_a'::uuid),
            null, 'and remembers that its creator asked for public');
select is((select license_hosting::text from public.custom_models where id = :'l_a'::uuid),
          'prohibited', 'the mirror moved with it');

-- The reverse decision completes the request the demotion preserved. This is
-- what stops the review queue from being a rejection with extra steps: the
-- operator establishes the terms and the listing the creator asked for appears.
update public.base_models set commercial_hosting = 'allowed'
 where id = :'bm_allowed'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_a'::uuid),
          'public', 'establishing terms that allow hosting publishes the held listing');
select is((select license_public_requested_at from public.custom_models where id = :'l_a'::uuid),
          null, 'and the request is satisfied rather than left standing');

-- A creator who takes their own listing private has withdrawn the request.
-- Without this, a later operator decision would re-publish something its owner
-- unpublished on purpose.
update public.custom_models set visibility = 'private' where id = :'l_a'::uuid;
select is((select license_public_requested_at from public.custom_models where id = :'l_a'::uuid),
          null, 'going private by choice withdraws the standing request');
update public.base_models set commercial_hosting = 'conditional', license_version = '9'
 where id = :'bm_allowed'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_a'::uuid),
          'private', 'so a later licence change does not re-publish it');
update public.base_models set commercial_hosting = 'allowed', license_version = '2.0'
 where id = :'bm_allowed'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_a'::uuid),
          'private', 'and neither does a favourable one');

-- A revision bump under a published conditional listing: the ack is now against
-- the old text, so the listing leaves the catalog until it is re-acknowledged.
update public.custom_models set license_ack_at = now(), license_ack_version = '3.1'
 where id = :'l_e'::uuid;
update public.custom_models set visibility = 'public' where id = :'l_e'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_e'::uuid),
          'public', 'the acknowledged conditional listing is published');
update public.base_models set license_version = '3.3' where id = :'bm_conditional'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_e'::uuid),
          'private',
          'revising the licence unpublishes it — the old ack is not an ack of the new text');
update public.custom_models set license_ack_at = now(), license_ack_version = '3.3'
 where id = :'l_e'::uuid;
select is((select visibility::text from public.custom_models where id = :'l_e'::uuid),
          'public', 'and re-acknowledging the new text publishes it again');

-- The SUBTREE, because the verdict reads ancestors: a decision about a parent
-- has to reach the listings of its descendants, not only the listings pointing
-- straight at it.
update public.base_models set commercial_hosting = 'allowed'
 where id = :'bm_prohibited'::uuid;
select is(pg_temp.mk_listing('00000000-0000-0000-0000-00000000c106', :'creator',
                             'gate-grandchild', :'bm_grandchild'::uuid, 'public'),
          '00000000-0000-0000-0000-00000000c106'::uuid,
          'a listing two levels below permissive weights publishes');
update public.base_models set commercial_hosting = 'prohibited'
 where id = :'bm_prohibited'::uuid;
select is((select visibility::text from public.custom_models
            where id = '00000000-0000-0000-0000-00000000c106'::uuid),
          'private',
          'and a decision about the ROOT unpublishes it — the resync walks descendants');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. The review queue
--
-- §7 asks who staffs it and in what window. Neither is answered here — but a
-- queue nobody can count is the rejection-with-extra-steps that question is
-- warning about, so it is countable, and it holds only the verdict an operator
-- can actually resolve.
-- ════════════════════════════════════════════════════════════════════════════
update public.custom_models set license_public_requested_at = now()
 where id in (:'l_b'::uuid, :'l_c'::uuid, :'l_d'::uuid, :'l_e'::uuid);

select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_b'::uuid),
          1, 'an unknown-licence listing whose creator asked for public is in the queue');
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_c'::uuid),
          1, 'so is an ungrouped one');
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_d'::uuid),
          0, 'a prohibited listing is NOT: that is a decided answer, not a question');
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_e'::uuid),
          0, 'and neither is a conditional one: the acknowledgement is the creator''s to give');
select isnt((select waiting_for from public.license_review_queue where model_id = :'l_b'::uuid),
            null, 'the queue reports how long the creator has been waiting');

update public.custom_models set license_public_requested_at = null where id = :'l_c'::uuid;
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_c'::uuid),
          0, 'a listing nobody asked to publish is not in a queue of publish requests');

update public.custom_models set deleted_at = now() where id = :'l_b'::uuid;
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_b'::uuid),
          0, 'a deleted listing leaves the queue');
update public.custom_models set deleted_at = null where id = :'l_b'::uuid;

update public.custom_models set status = 'failed' where id = :'l_b'::uuid;
select is((select count(*)::int from public.license_review_queue
            where model_id = :'l_b'::uuid),
          0, 'and so does one whose deployment never came up — it is not waiting on us');
update public.custom_models set status = 'ready' where id = :'l_b'::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Role reachability
--
-- The queue is an operator surface (#31 builds the page). A creator who could
-- read it would learn which of everybody else's weights the platform has not
-- classified yet.
-- ════════════════════════════════════════════════════════════════════════════
select ok(not has_table_privilege('anon', 'public.license_review_queue', 'SELECT'),
          'anon cannot read the review queue');
select ok(not has_table_privilege('authenticated', 'public.license_review_queue', 'SELECT'),
          'nor can a signed-in creator');
select ok(has_table_privilege('service_role', 'public.license_review_queue', 'SELECT'),
          'service_role can');
select ok(not has_function_privilege('authenticated', 'public.license_governing(uuid)', 'EXECUTE'),
          'and a creator cannot ask the verdict function directly either');

-- The creator's own policies still hold over the new columns. `license_hosting`
-- is deliberately NOT pinned by RLS — the trigger overwrites it, which is
-- stronger — but `license_ack_*` is pinned by #24 and that must not have
-- regressed, because an ack a creator can write is not a record of what they
-- were shown.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select is(auth.uid(), :'creator'::uuid, 'the session really is acting as the model owner');
select throws_ok(
  format($$ update public.custom_models
               set license_ack_at = now(), license_ack_version = 'forged'
             where id = %L $$, :'l_e'),
  '42501', null, 'a creator cannot acknowledge a licence on their own behalf');
select throws_ok(
  format($$ update public.custom_models set visibility = 'public' where id = %L $$, :'l_d'),
  '23514', null,
  'and a creator flipping the switch on prohibited weights is refused by the CHECK, not by RLS');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Why `prohibited` never accrues creator_earnings
--
-- §5.1 asks for it and no money change delivers it. It follows from three facts
-- and nothing else:
--
--   1. prohibited can never be `public` — asserted above, and asserted again
--      here as a whole-table invariant rather than one row at a time.
--   2. `gateway_resolve` returns `modelVisibility` raw, and the gateway 404s a
--      private listing for anybody who is not its owner. The FACT has to stay
--      in the envelope for that mapping to exist at all, which is what the
--      tripwire below protects.
--   3. Self-dealing writes no `creator_earnings` row. That invariant predates
--      this file and lives in 01_money_identity_test.sql; it is referenced, not
--      re-derived.
--
-- The only caller a prohibited listing can have is its own owner, and their
-- calls settle to the platform. A change that breaks any of the three breaks
-- the claim, and each one has an assertion somewhere.
-- ════════════════════════════════════════════════════════════════════════════
select is((select count(*)::int from public.custom_models
            where visibility = 'public' and license_hosting = 'prohibited'),
          0, 'no listing anywhere is both public and prohibited');
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    like '%modelVisibility%',
  'gateway_resolve still hands the gateway the visibility it 404s a private listing on');
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    not like '%license%',
  'and the gate is NOT on the hot path: resolution reads no licence column');

-- ════════════════════════════════════════════════════════════════════════════
-- 10. The billing path does not walk base_models
--
-- `tg_bump_model_counters` UPDATEs total_requests and the token totals on
-- `custom_models` for every settled request. The gate trigger has a WHEN clause
-- so that path does not fire it, and a recursive walk of `base_models` per
-- request is not something to leave to a comment.
--
-- Proved by making the mirror STALE on purpose and showing a counter-only
-- update leaves it stale — which only holds if the trigger did not run.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.custom_models disable trigger custom_models_license_gate_update;
update public.custom_models set license_hosting = 'allowed' where id = :'l_d'::uuid;
alter table public.custom_models enable trigger custom_models_license_gate_update;

update public.custom_models
   set total_requests = total_requests + 1,
       total_completion_tokens = total_completion_tokens + 42
 where id = :'l_d'::uuid;
select is((select license_hosting::text from public.custom_models where id = :'l_d'::uuid),
          'allowed',
          'a counter bump does not fire the gate trigger — the settlement path stays off base_models');
update public.custom_models set license_public_requested_at = null where id = :'l_d'::uuid;
select is((select license_hosting::text from public.custom_models where id = :'l_d'::uuid),
          'prohibited', 'and the first write that touches the gate''s inputs corrects it');

-- ════════════════════════════════════════════════════════════════════════════
-- 11. The seeded fixture, which is also the acceptance fixture
-- ════════════════════════════════════════════════════════════════════════════
select is((select license_hosting::text from public.custom_models where id = :'seeded'::uuid),
          'allowed', 'the seeded listing has established terms');
select is((select visibility::text from public.custom_models where id = :'seeded'::uuid),
          'public', 'which is the only reason it can be public — MVP-0 needs a caller who is not its creator');
select is((select license_public_requested_at from public.custom_models where id = :'seeded'::uuid),
          null, 'and it is not waiting on anybody');

select * from finish();
rollback;
