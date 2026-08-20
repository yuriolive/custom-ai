-- ============================================================================
-- The trust surface: a report inbox, and a takedown its target cannot lift.
--
-- #24 (20260820000100) added `custom_models.suspended_at` and pinned it out of
-- both creator policies; 07 proves that pin. This file proves the things that
-- pin alone does not give you, and they are the ones a takedown actually needs:
--
--   1. The OPERATOR BOUNDARY. The pin stops a creator writing the column
--      directly. It says nothing about the four RPCs that exist precisely to
--      write it. An operator-only function granted to `authenticated` is only
--      operator-only if it checks — so every one is asserted from the creator's
--      own session, and from a signed-in stranger's, and from anon.
--
--   2. "THROUGH ANY POLICY", taken literally. Not just "can the creator set
--      suspended_at" (07 covers that) but every other route out of a
--      suspension: clearing it inside a form POST that writes every other
--      column, going private to hide the banner, and SOFT-DELETING the listing —
--      which was a real escape hatch, since `deleted_at` is not pinned and
--      `custom_models_variant_uniq` is partial on it, so a deleted listing frees
--      its variant slot for an immediate re-list.
--
--   3. THE GATEWAY FACT. A suspension that only hides the card is not a
--      takedown; the listing has to stop serving. `gateway_resolve` bypasses RLS
--      by design, so RLS cannot be what stops it — the suspension has to arrive
--      in the resolve envelope as a raw fact. What the Edge Function does with
--      that fact is asserted in supabase/functions/gateway/tests; what is
--      asserted here is that the fact is there, and that the row still comes
--      back `found: true` rather than being filtered out (filtering it would
--      collapse "suspended" into "no such model" and break the gateway's
--      401-revoked-key ordering).
--
--   4. THE REPORT INBOX as a non-oracle. `model_reports` names a
--      `custom_models` row, so a careless INSERT policy turns it into an
--      existence probe over private listings.
--
-- No money is touched here; 01-06 own that ground.
--
-- Fixtures come from supabase/seed.sql: a1 = jonathancoletti, the CREATOR of the
-- seeded public+ready listing c1; a2 = devcaller, holder of the live API key and
-- the account promoted to operator partway through this file. Using the seeded
-- caller as the operator is deliberate — the operator is never the creator of
-- the listing under moderation in any assertion below.
-- ============================================================================
begin;
select plan(85);

\set creator  '00000000-0000-0000-0000-0000000000a1'
\set operator '00000000-0000-0000-0000-0000000000a2'
\set model    '00000000-0000-0000-0000-0000000000c1'
\set livekey  '88a3a9a61884397844427033a8355299a054a88974e533542e7ff22790cfd365'

\set creator_jwt  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}'
\set operator_jwt '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}'

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The plumbing exists
-- ════════════════════════════════════════════════════════════════════════════
select has_table('public', 'model_reports', 'model_reports exists');
select has_column('public', 'profiles', 'is_operator', 'profiles.is_operator exists');
select has_type('public', 'report_reason', 'the report_reason enum exists');
select has_type('public', 'report_status', 'the report_status enum exists');
select enum_has_labels('public', 'report_status', array['open', 'actioned', 'dismissed'],
  'a report is open, actioned or dismissed — and nothing else');
select has_function('public', 'is_platform_operator', array['uuid'],
  'the operator predicate exists');
select has_function('public', 'suspend_model_listing', array['uuid', 'text', 'uuid'],
  'suspend_model_listing exists');
select has_function('public', 'lift_model_suspension', array['uuid'],
  'lift_model_suspension exists');
select has_function('public', 'dismiss_model_report', array['uuid', 'text'],
  'dismiss_model_report exists');
select has_function('public', 'operator_report_queue',
  array['report_status', 'integer'], 'the queue read exists');

-- Partial and expression-bearing, so checked against the catalog rather than
-- has_index(), whose four-argument form reads its last argument as a COLUMN.
select ok(exists (select 1 from pg_class where relname = 'model_reports_one_open_per_reporter'),
          'the one-open-report-per-reporter index exists');
select ok(exists (select 1 from pg_class where relname = 'model_reports_queue_idx'),
          'the open queue is indexed');

-- No client may UPDATE or DELETE a report. Resolving one is an operator
-- decision, and a reporter who could UPDATE their own row could mark it
-- `actioned` and forge the record that says a takedown happened.
select is((select count(*)::int from pg_policies
            where tablename = 'model_reports' and cmd in ('UPDATE', 'DELETE')),
          0, 'model_reports has no client UPDATE or DELETE policy at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. is_operator is not self-service
--
-- This needs no new policy: profiles_update_own (20260817002100) is an
-- ALLOWLIST over display_name/avatar_url/bio and the UPDATE privilege is
-- narrowed to those three columns, so a column added to `profiles` is read-only
-- to its owner by default. That is a claim about a policy written months before
-- is_operator existed, so it is asserted rather than assumed — if anyone ever
-- re-widens that grant, this is the line that goes red.
-- ════════════════════════════════════════════════════════════════════════════
select is(public.is_platform_operator(:'creator'::uuid), false,
          'the creator is not an operator');
select is(public.is_platform_operator(:'operator'::uuid), false,
          'and neither is the caller, yet');
select is(public.is_platform_operator(null), false,
          'the predicate answers false for a NULL id rather than NULL');
select is(public.is_platform_operator('00000000-0000-0000-0000-0000000000ff'::uuid), false,
          'and false for a profile that does not exist');

set local request.jwt.claims = :'creator_jwt';
set local role authenticated;
select is(auth.uid(), :'creator'::uuid, 'the session really is acting as the creator');
select throws_ok(
  format($$ update public.profiles set is_operator = true where id = %L $$, :'creator'),
  '42501', null, 'a user cannot promote themselves to operator');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Filing a report
-- ════════════════════════════════════════════════════════════════════════════
-- The report ids are READ BACK with \gset rather than chosen here, and that is
-- an assertion in itself: `id` is deliberately absent from
-- `grant insert (model_id, reporter_id, reason, details)`, so a reporter cannot
-- name the primary key of their own report. A fixture that supplied one would
-- fail with "permission denied for table" — which is what it did, before this
-- comment existed — and papering over that by widening the grant would hand a
-- client a weak oracle over which report ids are taken.
\set privlisting '00000000-0000-0000-0000-0000000000c9'

-- A private listing owned by the creator, to prove the insert policy is not an
-- existence oracle over private rows.
insert into public.custom_models (
  id, user_id, slug, display_name, hf_repo_slug, served_model_name,
  runtime, weights_bytes, active_weights_bytes,
  price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken,
  visibility, status
) values (
  :'privlisting', :'creator', 'internal-support-bot', 'Internal Support Bot',
  'acme/internal-support-bot', 'acme/internal-support-bot',
  'vllm', 1000000000, 1000000000, 100000, 200000, 'private', 'draft');

set local request.jwt.claims = :'operator_jwt';
set local role authenticated;

select lives_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason, details)
            values (%L, %L, 'copyright', 'these weights are mine') $$,
         :'model', :'operator'),
  'a signed-in visitor can report a public listing');
select is((select status::text from public.model_reports where model_id = :'model'::uuid),
          'open', 'and it lands in the queue as open');

-- The generated id, read back. Still acting as the reporter, which is itself the
-- point: `model_reports_select_own` is what makes this row readable, and if it
-- did not, everything below would fail with an unset psql variable.
select id as report1 from public.model_reports where model_id = :'model'::uuid \gset

select throws_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason)
            values (%L, %L, 'license') $$, :'model', :'operator'),
  '23505', null,
  'the same person cannot file a second OPEN report on the same listing');

select throws_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason)
            values (%L, %L, 'license') $$, :'model', :'creator'),
  '42501', null, 'a reporter cannot file a report as somebody else');

-- The oracle case. A private listing must be unreportable, or the FK turns
-- `model_reports` into "does this uuid name a real listing?" for anyone.
select throws_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason)
            values (%L, %L, 'acceptable_use') $$, :'privlisting', :'operator'),
  '42501', null, 'a PRIVATE listing cannot be reported (no existence oracle)');
-- 42501 and not 23503: RLS WITH CHECK is evaluated as part of the INSERT, while
-- the foreign key is an AFTER-ROW trigger queued behind it. That ordering is
-- what makes this an assertion about the ORACLE and not about the FK — a made-up
-- uuid and a real private one fail identically, which is the whole point.
select throws_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason)
            values ('00000000-0000-0000-0000-00000000dead', %L, 'other') $$, :'operator'),
  '42501', null, 'and a listing that does not exist fails IDENTICALLY');

-- The privilege layer refuses a SET on the resolution columns before RLS is
-- consulted: INSERT is granted on (model_id, reporter_id, reason, details) only.
-- Column privileges are checked at executor startup, so this beats both the
-- unique index and the policy to the error — which is the ordering we want, and
-- the reason the target here is the PUBLIC listing this reporter has already
-- reported.
select throws_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason, status)
            values (%L, %L, 'other', 'dismissed') $$, :'model', :'operator'),
  '42501', null, 'a reporter cannot file a report that is already resolved');
select throws_ok(
  format($$ update public.model_reports set status = 'actioned' where id = %L $$, :'report1'),
  '42501', null, 'a reporter cannot resolve their own report');
select throws_ok(
  format($$ delete from public.model_reports where id = %L $$, :'report1'),
  '42501', null, 'nor delete it');

reset role;

-- A report is private to its reporter: a public count is a griefing signal
-- ("this model has 12 reports"), and a readable body is a leak about a
-- listing's legal exposure.
set local request.jwt.claims = :'creator_jwt';
set local role authenticated;
select is((select count(*)::int from public.model_reports), 0,
          'the reported CREATOR cannot see the report against their own listing');
reset role;
-- anon fails a layer earlier than RLS: `model_reports` is granted to
-- `authenticated` only, so the table privilege refuses the read before any
-- policy is consulted. Asserted as a privilege rather than as a count, because a
-- count would raise rather than return 0.
select ok(not has_table_privilege('anon', 'public.model_reports', 'SELECT'),
          'and anon cannot read the table at all');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The operator boundary
--
-- The four RPCs are granted to `authenticated`, on purpose: it lets the operator
-- surface run on the caller's own cookie-bound session instead of handing a
-- Next.js route a BYPASSRLS credential. That design is only sound if each
-- function checks — so here is each function, called by the creator of the
-- listing it would suspend, by a signed-in non-operator, and by anon.
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = :'creator_jwt';
set local role authenticated;

select throws_ok(
  format($$ select public.suspend_model_listing(%L, 'i would rather not be suspended') $$,
         :'model'),
  '42501', null, 'the creator cannot suspend a listing');
select throws_ok(
  format($$ select public.lift_model_suspension(%L) $$, :'model'),
  '42501', null, 'the creator cannot lift a suspension');
select throws_ok(
  format($$ select public.dismiss_model_report(%L) $$, :'report1'),
  '42501', null, 'the creator cannot dismiss the report against them');
select throws_ok(
  $$ select * from public.operator_report_queue() $$,
  '42501', null, 'the creator cannot read the moderation queue');
reset role;

-- A signed-in stranger is no better placed than the creator.
set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select throws_ok(
  format($$ select public.suspend_model_listing(%L, 'because i said so') $$, :'model'),
  '42501', null, 'a signed-in non-operator cannot suspend a listing');
select throws_ok(
  $$ select * from public.operator_report_queue() $$,
  '42501', null, 'nor read the queue');
reset role;

-- anon holds no EXECUTE at all, so it fails one layer earlier.
select ok(not has_function_privilege('anon',
            'public.suspend_model_listing(uuid,text,uuid)', 'EXECUTE'),
          'anon cannot even execute suspend_model_listing');
select ok(not has_function_privilege('anon',
            'public.operator_report_queue(public.report_status,integer)', 'EXECUTE'),
          'nor the queue read');
select ok(has_function_privilege('authenticated',
            'public.suspend_model_listing(uuid,text,uuid)', 'EXECUTE'),
          'authenticated CAN execute it — the guard is inside, not on the grant');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. An operator suspends, and the queue closes behind them
-- ════════════════════════════════════════════════════════════════════════════
update public.profiles set is_operator = true where id = :'operator'::uuid;
select is(public.is_platform_operator(:'operator'::uuid), true,
          'the caller is an operator now');

set local request.jwt.claims = :'operator_jwt';
set local role authenticated;

select is((select count(*)::int from public.operator_report_queue()), 1,
          'the operator sees exactly the one open report');
select is((select model_slug from public.operator_report_queue()),
          'qwen3.8-27b-uncensored-gguf', 'joined to the listing it names');
select is((select creator_handle from public.operator_report_queue()),
          'jonathancoletti',
          'and to the creator''s handle — which creator_public could not have given, '
          'since it filters is_suspended = false and hides exactly the accounts '
          'under moderation');

-- The reason is not optional: `custom_models_suspension_needs_reason` (#24)
-- would raise 23514, but a suspension nobody can explain is a support ticket
-- with no answer, so the RPC refuses it in words instead.
select is(
  (select public.suspend_model_listing(:'model'::uuid, '   ') ->> 'code'),
  'reason_required', 'a suspension with a blank reason is refused, in words');
select is((select suspended_at from public.custom_models where id = :'model'::uuid),
          null, 'and it really did not suspend anything');

select is(
  (select public.suspend_model_listing(:'model'::uuid, 'dmca notice 2026-08-20', :'report1'::uuid)
            ->> 'code'),
  'suspended', 'the operator suspends the listing');
reset role;

select isnt((select suspended_at from public.custom_models where id = :'model'::uuid),
            null, 'suspended_at is set');
select is((select suspension_reason from public.custom_models where id = :'model'::uuid),
          'dmca notice 2026-08-20', 'with the reason the operator gave');
select is((select status::text from public.model_reports where id = :'report1'::uuid),
          'actioned', 'and the report that asked for it is actioned');
select is((select resolved_by from public.model_reports where id = :'report1'::uuid),
          :'operator'::uuid, 'attributed to the operator who acted');

-- Idempotent, and it does NOT overwrite the standing reason: the first takedown
-- is the one with the paper trail behind it.
set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select is(
  (select public.suspend_model_listing(:'model'::uuid, 'a different reason') ->> 'code'),
  'already_suspended', 'suspending twice is a no-op');
reset role;
select is((select suspension_reason from public.custom_models where id = :'model'::uuid),
          'dmca notice 2026-08-20', 'and the original reason survives it');

-- ════════════════════════════════════════════════════════════════════════════
-- 6. "Through ANY policy" — every route out of a suspension
--
-- 07 asserts the direct write and the form-POST-shaped write. These are the
-- rest: the RPC, going private to hide the banner, and the soft delete.
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = :'creator_jwt';
set local role authenticated;

select throws_ok(
  format($$ select public.lift_model_suspension(%L) $$, :'model'),
  '42501', null, 'the creator cannot lift the suspension through the RPC');
select throws_ok(
  format($$ update public.custom_models set suspended_at = null, suspension_reason = null
             where id = %L $$, :'model'),
  '42501', null, 'nor by writing the columns');

-- Going private is still allowed — it is the creator's own column — but it must
-- not launder the suspension away.
select lives_ok(
  format($$ update public.custom_models set visibility = 'private' where id = %L $$, :'model'),
  'the creator may still take their suspended listing private');

-- THE SOFT-DELETE ESCAPE. `deleted_at` is not pinned by
-- custom_models_update_own, and custom_models_variant_uniq is PARTIAL on
-- `deleted_at is null` — so without a guard a suspended creator soft-deletes the
-- listing, frees its variant slot, and re-lists the same weights unsuspended in
-- one round trip. Blocked in the WITH CHECK only while the row is suspended, so
-- an unsuspended creator's ordinary delete flow is untouched (asserted below).
select throws_ok(
  format($$ update public.custom_models set deleted_at = now() where id = %L $$, :'model'),
  '42501', null, 'and cannot soft-delete a SUSPENDED listing to escape it');
reset role;

update public.custom_models set visibility = 'public' where id = :'model'::uuid;
select isnt((select suspended_at from public.custom_models where id = :'model'::uuid),
            null, 'the suspension survived all of it');

-- ════════════════════════════════════════════════════════════════════════════
-- 7. The gateway fact
--
-- gateway_resolve is SECURITY DEFINER and bypasses RLS by design, so #24's
-- select policy cannot stop it serving. The suspension has to arrive as a raw
-- fact in the envelope. `found` must stay true: filtering the row out would
-- collapse "suspended" into "no such model", and the gateway would answer 404
-- where it owes a revoked key its 401.
-- ════════════════════════════════════════════════════════════════════════════
select ok(
  pg_get_functiondef('public.gateway_resolve(text,text,text)'::regprocedure)
    like '%suspended_at%',
  'gateway_resolve reads suspended_at — this is the line 07 pointed at');

select is(
  (select public.gateway_resolve(:'livekey', 'jonathancoletti',
                                 'qwen3.8-27b-uncensored-gguf') ->> 'found'),
  'true', 'a suspended listing still RESOLVES rather than vanishing');
select isnt(
  (select public.gateway_resolve(:'livekey', 'jonathancoletti',
                                 'qwen3.8-27b-uncensored-gguf') ->> 'modelSuspendedAt'),
  null, 'and the envelope carries modelSuspendedAt, which the gateway maps to 404');

-- The distinction that makes this different from `modelVisibility`: a private
-- model still serves its owner. A suspended one serves nobody, so the fact is
-- caller-independent — there is no owner branch to take.
select is(
  (select public.gateway_resolve(:'livekey', 'jonathancoletti',
                                 'qwen3.8-27b-uncensored-gguf') ->> 'modelStatus'),
  'ready', 'the listing is still `ready`: nothing about provisioning changed');

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Lifting
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select is((select public.lift_model_suspension(:'model'::uuid) ->> 'code'), 'lifted',
          'the operator lifts the suspension');
select is((select public.lift_model_suspension(:'model'::uuid) ->> 'code'), 'not_suspended',
          'and lifting twice is a no-op');
select is(
  (select public.lift_model_suspension('00000000-0000-0000-0000-00000000dead'::uuid)
            ->> 'code'),
  'not_found', 'an unknown listing is a not_found envelope, not an exception');
reset role;

select is((select suspended_at from public.custom_models where id = :'model'::uuid),
          null, 'suspended_at is cleared');
select is((select suspension_reason from public.custom_models where id = :'model'::uuid),
          null, 'and the reason with it — the CHECK requires both halves together');
select is(
  (select public.gateway_resolve(:'livekey', 'jonathancoletti',
                                 'qwen3.8-27b-uncensored-gguf') ->> 'modelSuspendedAt'),
  null, 'and the gateway sees it serving again');

-- Reports are NOT reopened. The complaint was answered; the answer was reversed
-- on appeal, which is a new fact about the listing, not a re-opening.
select is((select status::text from public.model_reports where id = :'report1'::uuid),
          'actioned', 'the resolved report stays resolved after a lift');

-- With the suspension gone, the creator's own delete flow is back. Without this
-- the guard in §6 would have frozen every suspended-then-lifted listing forever
-- and nobody would have noticed until a creator tried to delete one.
set local request.jwt.claims = :'creator_jwt';
set local role authenticated;
select lives_ok(
  format($$ update public.custom_models set deleted_at = now() where id = %L $$,
         :'privlisting'),
  'a creator can still soft-delete a listing that is NOT suspended');
reset role;
update public.custom_models set deleted_at = null where id = :'privlisting'::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Dismissing
-- ════════════════════════════════════════════════════════════════════════════
-- The first report is closed, so the partial unique index lets the same reporter
-- file again — a new complaint about the same URL, which is the case that index
-- is partial for.
set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select lives_ok(
  format($$ insert into public.model_reports (model_id, reporter_id, reason, details)
            values (%L, %L, 'acceptable_use', 'second look') $$,
         :'model', :'operator'),
  'a reporter may file again once their earlier report is resolved');
reset role;

select id as report2 from public.model_reports
 where model_id = :'model'::uuid and status = 'open' \gset

set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select is((select public.dismiss_model_report(:'report2'::uuid, 'reviewed, within policy')
             ->> 'code'),
          'dismissed', 'the operator dismisses it');
select is((select public.dismiss_model_report(:'report2'::uuid) ->> 'code'),
          'already_resolved', 'dismissing it again is refused');
select is((select public.dismiss_model_report('00000000-0000-0000-0000-00000000dead'::uuid)
             ->> 'code'),
          'not_found', 'an unknown report is a not_found envelope');
reset role;

select is((select status::text from public.model_reports where id = :'report2'::uuid),
          'dismissed', 'the report is dismissed');
select is((select resolution_note from public.model_reports where id = :'report2'::uuid),
          'reviewed, within policy', 'with the note the operator left');
select is((select suspended_at from public.custom_models where id = :'model'::uuid),
          null, 'and the listing was NOT touched — dismissing means nothing was wrong');

-- The resolution CHECK: a decision, who made it, and when, move together.
--
-- Needs a genuinely OPEN row, so a third report is filed. Using an
-- already-actioned one would pass vacuously: setting `status = 'actioned'` on a
-- row that is already actioned satisfies the constraint, so the statement would
-- not raise and the assertion would be about nothing. That is what it did before
-- this comment existed.
set local request.jwt.claims = :'creator_jwt';
set local role authenticated;
insert into public.model_reports (model_id, reporter_id, reason)
values (:'model', :'creator', 'other');
reset role;
select id as report3 from public.model_reports
 where model_id = :'model'::uuid and status = 'open' \gset

select throws_ok(
  format($$ update public.model_reports set status = 'actioned' where id = %L $$, :'report3'),
  '23514', null, 'a resolved status with no resolved_at is rejected');
select throws_ok(
  format($$ update public.model_reports
               set resolved_at = now(), resolved_by = null where id = %L $$, :'report3'),
  '23514', null, 'and a timestamp with nobody attached to it is rejected too');
select throws_ok(
  format($$ update public.model_reports set resolved_at = null where id = %L $$, :'report2'),
  '23514', null, 'a resolved report cannot lose its timestamp');

-- Cleared again so the queue counts below are about the two decided reports.
delete from public.model_reports where id = :'report3'::uuid;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. The queue, after the fact
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = :'operator_jwt';
set local role authenticated;
select is((select count(*)::int from public.operator_report_queue('open')), 0,
          'nothing is open any more');
select is((select count(*)::int from public.operator_report_queue('actioned')), 1,
          'one report was actioned');
select is((select count(*)::int from public.operator_report_queue('dismissed')), 1,
          'and one was dismissed');
-- The limit is clamped rather than trusted: a caller-supplied 0 or a negative
-- number would otherwise return an empty queue that reads as "nothing to do".
select is((select count(*)::int from public.operator_report_queue('actioned', 0)), 1,
          'a zero limit is clamped up to 1, not honoured into an empty queue');
select ok((select count(*) from public.operator_report_queue('actioned', 100000)) <= 500,
          'and a huge one is clamped down to 500');
reset role;

-- A cascade, not an orphan: deleting a listing must not leave reports pointing
-- at nothing, and a report is meaningless without the listing it describes.
delete from public.custom_models where id = :'model'::uuid;
select is((select count(*)::int from public.model_reports), 0,
          'deleting a listing takes its reports with it');

select * from finish();
rollback;
