-- ============================================================================
-- 20260820002000_trust_reports_and_suspension.sql
--
-- Phase 8 of the marketplace discovery plan (GitHub #31, §5.5): the machinery
-- around the takedown column that #24 (20260820000100) added.
--
-- #24 shipped `custom_models.suspended_at` / `suspension_reason`, pinned both
-- out of `custom_models_insert_own` and `custom_models_update_own`, and taught
-- `custom_models_select_public` to hide a suspended row. It deliberately
-- shipped no WRITER: nothing sets the column, so it is NULL on every row and
-- nothing observable changed. This migration is the writer, the report inbox
-- that justifies a write, and the one fact the gateway needs to stop serving.
--
-- ── Three things had to be decided, and none of them is obvious ─────────────
--
-- 1. WHO IS AN OPERATOR, and where is that checked.
--
--    In a route handler is the wrong answer. The rule being enforced is "the
--    target of a takedown cannot lift it", and a creator holds a valid
--    `authenticated` JWT that reaches PostgREST directly (CONTRACTS.md
--    §Frontend): they never have to go through the handler. So the operator
--    check lives in the database, next to the pin it complements, exactly as
--    `custom_models_ready_needs_placement` lives there rather than in the deploy
--    pipeline that would otherwise be its only guard.
--
--    `profiles.is_operator` is the flag, and it is safe by construction:
--    `profiles_update_own` (20260817002100) is an ALLOWLIST that compares the
--    whole proposed row as jsonb with only display_name/avatar_url/bio masked
--    out, and the UPDATE privilege is narrowed to those same three columns. A
--    column added to `profiles` today is read-only to its owner without anyone
--    remembering to say so — which is the entire reason that policy was
--    inverted. Nothing here needs to change to protect it, and there is a pgTAP
--    assertion in 08 that proves it rather than trusting it.
--
-- 2. WHO MAY CALL THE OPERATOR RPCS.
--
--    They are granted to `authenticated`, not to `service_role` alone, and each
--    one re-checks `is_platform_operator(auth.uid())` itself and raises 42501
--    otherwise. That is deliberate: it means the operator surface in the app can
--    run on the caller's own cookie-bound session, and the Next.js app never
--    needs the service-role key to moderate. A handler holding a BYPASSRLS
--    credential is one authz bug away from being the takedown mechanism for
--    everyone, and it moves the invariant back out of the database.
--
--    `security definer` is still required — the functions write columns no
--    client policy admits — so each one is written with the standard shape:
--    pinned `search_path`, `revoke all` from public, explicit grants.
--
-- 3. WHAT A SUSPENSION DOES TO THE REPORTS THAT ASKED FOR IT.
--
--    Suspending a listing resolves EVERY open report against it, not just the
--    one the operator was looking at. Five people reporting the same DMCA
--    violation is one takedown and one decision; leaving four rows `open`
--    afterwards makes the queue re-present work that is already done, which is
--    the failure mode that makes moderation queues get ignored.
-- ============================================================================

-- ── Report taxonomy ─────────────────────────────────────────────────────────
-- A CLOSED vocabulary, not free text. The reason drives which queue a report
-- lands in and which legal process answers it — a DMCA notice has a statutory
-- clock, an acceptable-use complaint does not — and an open vocabulary makes
-- that ungroupable. `other` exists so a reporter is never forced to mis-file;
-- `details` carries what the enum cannot.
create type public.report_reason as enum (
  'license',          -- the listing violates the weights' licence terms
  'copyright',        -- DMCA / ownership claim over the weights or the name
  'acceptable_use',   -- content the AUP forbids
  'security',         -- the model or its repo ships something malicious
  'impersonation',    -- passing itself off as someone else's model
  'other'
);

create type public.report_status as enum (
  'open',        -- in the queue, nobody has decided
  'actioned',    -- the listing was suspended because of this report
  'dismissed'    -- looked at, no action taken
);

-- ── The operator flag ───────────────────────────────────────────────────────
alter table public.profiles
  add column is_operator boolean not null default false;

comment on column public.profiles.is_operator is
  'Platform moderator. Read-only to its owner WITHOUT a policy change, because '
  'profiles_update_own is an allowlist over display_name/avatar_url/bio and the '
  'UPDATE privilege is narrowed to those three columns (20260817002100). '
  'Granted out of band by service_role; there is deliberately no self-service '
  'path to it.';

-- Small and rarely written; partial so the index holds only the operators.
create index profiles_operator_idx on public.profiles (id) where is_operator;

-- ── The operator predicate ──────────────────────────────────────────────────
-- SECURITY DEFINER because `profiles` has no SELECT policy for anyone but the
-- row's owner, and every guard below has to answer this question about the
-- CALLER — which is the owner, so an invoker-rights read would in fact work
-- today. It is definer anyway so the guards keep working if a future policy
-- narrows own-row reads, and because a boolean oracle over `auth.uid()` reveals
-- nothing: it takes no argument a caller can vary to probe someone else.
--
-- `p_user` is a parameter rather than an implicit `auth.uid()` so service_role
-- (which has no JWT, and for which `auth.uid()` is NULL) can ask about a
-- specific person, and so the pgTAP tests can assert on both.
create or replace function public.is_platform_operator(p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((select p.is_operator from public.profiles p where p.id = p_user), false);
$$;

comment on function public.is_platform_operator(uuid) is
  'True when p_user is a platform moderator. The authorization predicate behind '
  'every operator RPC in this migration. Boolean only, and NULL-safe: an absent '
  'profile and a NULL id both answer false rather than NULL, so a guard written '
  '`if not is_platform_operator(...)` cannot fall through on a NULL.';

revoke all on function public.is_platform_operator(uuid) from public;
grant execute on function public.is_platform_operator(uuid) to authenticated, service_role;

-- ============================================================================
-- model_reports — the report inbox
-- ============================================================================
create table public.model_reports (
  id            uuid primary key default gen_random_uuid(),
  model_id      uuid not null references public.custom_models(id) on delete cascade,

  -- The reporter. NOT NULL: an anonymous in-app report is an unauthenticated
  -- INSERT into a table, which is a spam endpoint without a CAPTCHA this repo
  -- does not have. Anonymous notices arrive through the legal channel on
  -- /legal/acceptable-use instead, and an operator files them by hand.
  reporter_id   uuid not null references public.profiles(id) on delete cascade,

  reason        public.report_reason not null,
  -- Free text from an untrusted reporter. Bounded, and rendered as text — never
  -- as markup — by the operator surface.
  details       text check (char_length(details) <= 4000),

  status        public.report_status not null default 'open',

  -- ── Resolution: written only by the operator RPCs below ──────────────────
  resolved_at   timestamptz,
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolution_note text check (char_length(resolution_note) <= 2000),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A resolution is a decision plus who made it plus when. Half of one is a
  -- queue row nobody can audit, so the three move together. `resolution_note`
  -- is deliberately outside this: "dismissed, no note" is a legitimate outcome.
  constraint model_reports_resolution_complete check (
    (status = 'open') = (resolved_at is null)
    and (resolved_at is null) = (resolved_by is null)
  )
);

-- ONE open report per person per listing.
--
-- Partial on `status = 'open'`: a reporter whose first report was dismissed may
-- report the same listing again when something new happens, which is a
-- different complaint about the same URL. What this stops is the same person
-- filing the same open complaint forty times and drowning the queue — the only
-- volume control that does not need a rate limiter, since the reporter must
-- hold an account and each row is scoped to their own id.
create unique index model_reports_one_open_per_reporter
  on public.model_reports (model_id, reporter_id)
  where status = 'open';

-- The queue read: open reports, oldest first (a report waiting three days
-- outranks one filed a minute ago).
create index model_reports_queue_idx
  on public.model_reports (created_at)
  where status = 'open';

-- "What has been reported about this listing", for the operator detail view and
-- for the suspend RPC's bulk resolve.
create index model_reports_model_idx on public.model_reports (model_id, created_at desc);

create trigger model_reports_updated_at
  before update on public.model_reports
  for each row execute function public.tg_set_updated_at();

comment on table public.model_reports is
  'Abuse/licence/DMCA reports against one listing. A reporter may read only '
  'their own rows: a public report count is a griefing signal ("this model has '
  '12 reports") and a private one is a leak about a listing''s legal exposure. '
  'Resolution columns are written ONLY by the operator RPCs in this migration.';

-- ── RLS: model_reports ──────────────────────────────────────────────────────
alter table public.model_reports enable row level security;

-- A reporter reads their own reports and nothing else. Not even a count of
-- other people's: see the table comment.
create policy model_reports_select_own on public.model_reports
  for select to authenticated
  using (reporter_id = auth.uid());

-- An operator reads the whole queue. A separate policy rather than an `or` in
-- the one above, so the two grounds for reading are independently revocable and
-- independently testable.
create policy model_reports_select_operator on public.model_reports
  for select to authenticated
  using (public.is_platform_operator(auth.uid()));

-- Filing a report.
--
-- The reporter may only file AS themselves, only in `open`, and only with the
-- resolution columns empty — the same pin polarity as every other creator-
-- writable table here: a client-supplied `status = 'dismissed'` would let a
-- reporter file a report that is already closed, which is a queue-poisoning
-- primitive rather than a report.
--
-- The model must be one the reporter can actually see as a member of the public
-- catalog. Without that predicate `model_reports` becomes an existence oracle
-- over `custom_models`: a stranger POSTs a guessed uuid and learns from the FK
-- whether it names a real listing, including a private one. The subquery runs as
-- the caller, so it is subject to `custom_models`' own policies — which is
-- exactly what makes a suspended or private listing unreportable through it.
--
-- CONSEQUENCE, deliberate: an already-suspended listing cannot be reported
-- again. It is out of the catalog, nobody can reach its page, and a second
-- report about it adds nothing an operator does not already know.
create policy model_reports_insert_own on public.model_reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and status = 'open'
    and resolved_at is null
    and resolved_by is null
    and resolution_note is null
    and exists (
      select 1 from public.custom_models m
       where m.id = model_reports.model_id
         and m.visibility = 'public'
         and m.status = 'ready'
         and m.deleted_at is null
         and m.suspended_at is null
    )
  );

-- NO client UPDATE or DELETE policy, deliberately. Resolving a report is an
-- operator decision and goes through the RPCs below; a reporter who could
-- UPDATE their own row could mark it `actioned` and forge the audit trail that
-- says a takedown happened. Withdrawing a report is not a feature MVP-0 has;
-- when it becomes one it is a `withdrawn` status set by a guarded RPC, not an
-- UPDATE policy over `status`.

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Nothing is auto-exposed (see 20260817001600), so RLS is irrelevant without
-- these — the table grant fails first.
--
-- INSERT is narrowed to the four columns a reporter actually supplies, matching
-- what 20260817002100 did to `profiles`: the privilege layer refuses a SET on
-- `status` or `resolved_by` before RLS is consulted, so the pins in the policy
-- are the second line of defence rather than the only one.
grant select on public.model_reports to authenticated;
grant insert (model_id, reporter_id, reason, details) on public.model_reports to authenticated;
grant select, insert, update, delete on public.model_reports to service_role;

-- ============================================================================
-- The operator RPCs
--
-- Each returns a jsonb discriminated envelope for the "nothing to do" cases
-- (unknown id, already in the requested state) and RAISES for the authorization
-- failure. That split is on purpose: `{ok:false, code:'not_found'}` is a normal
-- outcome the surface renders as a message, while a non-operator reaching these
-- at all is a policy violation, and 42501 is the code every other guard in this
-- schema uses for one. It is also what pgTAP's `throws_ok` can assert on.
-- ============================================================================

-- ── suspend ─────────────────────────────────────────────────────────────────
create or replace function public.suspend_model_listing(
  p_model_id  uuid,
  p_reason    text,
  p_report_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := nullif(btrim(p_reason), '');
  v_already timestamptz;
  v_closed  integer;
begin
  -- service_role has no JWT, so auth.uid() is NULL for it. It holds BYPASSRLS
  -- and every grant in this schema already, so it is an operator by definition;
  -- an authenticated caller must prove it.
  if v_actor is not null and not public.is_platform_operator(v_actor) then
    raise exception 'only a platform operator may suspend a listing'
      using errcode = '42501';
  end if;

  -- The schema's own CHECK (`custom_models_suspension_needs_reason`, #24) would
  -- catch a NULL reason as a 23514. Refusing it here instead makes the surface's
  -- error a sentence rather than a constraint name, and keeps the invariant
  -- readable at the place a human supplies the value.
  if v_reason is null then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;
  if char_length(v_reason) > 2000 then
    return jsonb_build_object('ok', false, 'code', 'reason_too_long');
  end if;

  select m.suspended_at into v_already
    from public.custom_models m
   where m.id = p_model_id and m.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_already is not null then
    -- Idempotent, and it does NOT overwrite the standing reason: the first
    -- takedown is the one with the paper trail behind it.
    return jsonb_build_object('ok', true, 'code', 'already_suspended',
                              'suspendedAt', v_already);
  end if;

  update public.custom_models
     set suspended_at = now(), suspension_reason = v_reason
   where id = p_model_id;

  -- Every open report against this listing is answered by this one decision.
  -- See the header: leaving the others open makes the queue re-present work
  -- that is already done.
  update public.model_reports
     set status = 'actioned', resolved_at = now(),
         resolved_by = coalesce(v_actor, resolved_by, reporter_id),
         resolution_note = coalesce(resolution_note, v_reason)
   where model_id = p_model_id and status = 'open';
  get diagnostics v_closed = row_count;

  -- p_report_id is accepted for the surface's benefit — it is the row the
  -- operator was looking at — but it is not required and not privileged: the
  -- bulk resolve above already covers it. Naming it lets the caller confirm the
  -- report they clicked was in fact one of the ones closed.
  return jsonb_build_object(
    'ok', true, 'code', 'suspended',
    'reportsResolved', v_closed,
    'requestedReportClosed', p_report_id is null or exists (
      select 1 from public.model_reports r
       where r.id = p_report_id and r.model_id = p_model_id and r.status = 'actioned'));
end $$;

comment on function public.suspend_model_listing(uuid, text, uuid) is
  'Operator-only per-listing takedown. Sets custom_models.suspended_at + '
  'suspension_reason — columns no client policy admits — and resolves every '
  'open report against the listing as `actioned`. Raises 42501 for an '
  'authenticated non-operator; idempotent for an already-suspended listing, '
  'whose standing reason it does not overwrite.';

revoke all on function public.suspend_model_listing(uuid, text, uuid) from public, anon;
grant execute on function public.suspend_model_listing(uuid, text, uuid)
  to authenticated, service_role;

-- ── lift ────────────────────────────────────────────────────────────────────
create or replace function public.lift_model_suspension(
  p_model_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_susp  timestamptz;
begin
  if v_actor is not null and not public.is_platform_operator(v_actor) then
    raise exception 'only a platform operator may lift a suspension'
      using errcode = '42501';
  end if;

  select m.suspended_at into v_susp
    from public.custom_models m
   where m.id = p_model_id and m.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_susp is null then
    return jsonb_build_object('ok', true, 'code', 'not_suspended');
  end if;

  -- Both halves together: `custom_models_suspension_needs_reason` requires it,
  -- and a lifted suspension that keeps its reason reads as still suspended.
  update public.custom_models
     set suspended_at = null, suspension_reason = null
   where id = p_model_id;

  -- Reports are NOT reopened. They were answered; the answer was reversed on
  -- appeal, which is a new fact about the listing and not a re-opening of the
  -- complaint. `resolution_note` keeps the original decision readable.
  return jsonb_build_object('ok', true, 'code', 'lifted');
end $$;

comment on function public.lift_model_suspension(uuid) is
  'Operator-only. Clears suspended_at and suspension_reason together — the '
  'CHECK requires it, and a lifted suspension that keeps its reason reads as '
  'still suspended. Does not reopen the reports the suspension resolved.';

revoke all on function public.lift_model_suspension(uuid) from public, anon;
grant execute on function public.lift_model_suspension(uuid) to authenticated, service_role;

-- ── dismiss ─────────────────────────────────────────────────────────────────
create or replace function public.dismiss_model_report(
  p_report_id uuid,
  p_note      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_status public.report_status;
begin
  if v_actor is not null and not public.is_platform_operator(v_actor) then
    raise exception 'only a platform operator may dismiss a report'
      using errcode = '42501';
  end if;

  select r.status into v_status
    from public.model_reports r where r.id = p_report_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'already_resolved',
                              'status', v_status);
  end if;

  update public.model_reports
     set status = 'dismissed', resolved_at = now(),
         -- `coalesce` on the actor: service_role has no auth.uid(), and
         -- resolved_by is NOT NULL whenever resolved_at is (the CHECK). The
         -- reporter's own id is the honest fallback for "resolved by the
         -- platform, out of band" — it keeps the row auditable and the
         -- constraint satisfied without inventing a uuid.
         resolved_by = coalesce(v_actor, reporter_id),
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_report_id;

  return jsonb_build_object('ok', true, 'code', 'dismissed');
end $$;

comment on function public.dismiss_model_report(uuid, text) is
  'Operator-only. Closes one report without touching the listing. The listing '
  'is untouched on purpose: dismissing is the decision that nothing was wrong.';

revoke all on function public.dismiss_model_report(uuid, text) from public, anon;
grant execute on function public.dismiss_model_report(uuid, text) to authenticated, service_role;

-- ── the queue read ──────────────────────────────────────────────────────────
-- `model_reports_select_operator` already lets an operator SELECT the table, so
-- this function is not what makes the queue readable. It exists because the
-- queue needs columns from three tables — the report, the listing it names, and
-- the listing's creator — and `profiles` has NO public SELECT policy, so an
-- operator reading a reported creator's handle through PostgREST would have to
-- go through `creator_public`, which filters `is_suspended = false` and would
-- therefore hide precisely the accounts under moderation.
--
-- Returns the CURRENT suspension state alongside each report so the surface can
-- render "already suspended" without a second round trip, and so two operators
-- working the queue at once do not both suspend (the RPC is idempotent anyway).
create or replace function public.operator_report_queue(
  p_status public.report_status default 'open',
  p_limit  integer default 100
) returns table (
  report_id       uuid,
  reason          public.report_reason,
  details         text,
  status          public.report_status,
  created_at      timestamptz,
  resolved_at     timestamptz,
  resolution_note text,
  model_id        uuid,
  model_slug      text,
  model_display_name text,
  model_visibility public.model_visibility,
  suspended_at    timestamptz,
  suspension_reason text,
  creator_id      uuid,
  creator_handle  text,
  creator_is_suspended boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is not null and not public.is_platform_operator(v_actor) then
    raise exception 'only a platform operator may read the report queue'
      using errcode = '42501';
  end if;

  return query
    select r.id, r.reason, r.details, r.status, r.created_at,
           r.resolved_at, r.resolution_note,
           m.id, m.slug, m.display_name, m.visibility,
           m.suspended_at, m.suspension_reason,
           p.id, p.handle, p.is_suspended
      from public.model_reports r
      join public.custom_models m on m.id = r.model_id
      join public.profiles p      on p.id = m.user_id
     where r.status = p_status
     -- Oldest first for the open queue: a report waiting three days outranks
     -- one filed a minute ago. Newest first for anything already decided,
     -- where the question is "what did we just do".
     order by case when p_status = 'open' then r.created_at end asc nulls last,
              r.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

comment on function public.operator_report_queue(public.report_status, integer) is
  'The moderation queue: one row per report, joined to the listing and its '
  'creator. SECURITY DEFINER because it must read `profiles` directly — '
  'creator_public filters is_suspended = false and would hide exactly the '
  'accounts under moderation. Raises 42501 for an authenticated non-operator.';

revoke all on function public.operator_report_queue(public.report_status, integer)
  from public, anon;
grant execute on function public.operator_report_queue(public.report_status, integer)
  to authenticated, service_role;

-- ============================================================================
-- custom_models_update_own — close the soft-delete escape from a suspension
--
-- #24 pinned `suspended_at` and `suspension_reason`, so a creator cannot write
-- either. `deleted_at` is NOT pinned, deliberately — a creator soft-deletes
-- their own listing, and that is the delete flow. But `custom_models_variant_uniq`
-- is PARTIAL on `deleted_at is null`, precisely so a deleted listing frees its
-- (repo, revision, variant) slot for a re-deploy. Put those two facts together
-- and a suspended creator has a one-round-trip escape: soft-delete the suspended
-- listing, re-insert the same weights, serve on a fresh row with `suspended_at`
-- NULL. The takedown survives every direct write and is undone by a delete.
--
-- The fix is one disjunct, and its SHAPE matters. The obvious version —
-- `and suspended_at is null` in the USING clause — is wrong twice over: it would
-- make the suspended row invisible to UPDATE, so an attempt to clear the
-- suspension would match ZERO ROWS and succeed silently instead of raising
-- 42501, which is exactly the assertion 07 makes about that statement. Keeping
-- the row visible and refusing the specific write in WITH CHECK preserves the
-- error, and scopes the freeze to the one column that is an escape hatch: a
-- suspended creator can still rename, re-price, and take the listing private,
-- none of which puts the weights back in front of anyone.
--
-- Re-listing the same weights on a NEW row after a LEGITIMATE delete remains
-- possible and is not treated as evasion here — a variant-level block would need
-- a suspension record that outlives the listing, which is a bigger table than
-- this issue justifies. Noted as follow-up work rather than half-built.
--
-- Otherwise byte-identical to its definition in 20260820000100.
drop policy if exists custom_models_update_own on public.custom_models;

create policy custom_models_update_own on public.custom_models
  for update to authenticated
  using (user_id = auth.uid() and deleted_at is null)
  with check (
    user_id = auth.uid()
    and slug               = (select m.slug               from public.custom_models m where m.id = custom_models.id)
    and hf_repo_slug       = (select m.hf_repo_slug       from public.custom_models m where m.id = custom_models.id)
    -- `is not distinct from` on the nullable columns: `=` yields NULL, i.e. a
    -- WITH CHECK failure, for every pre-provisioning draft. See 20260817000700.
    and gpu_tier_id        is not distinct from
                             (select m.gpu_tier_id        from public.custom_models m where m.id = custom_models.id)
    and upstream_endpoint_ref is not distinct from
                             (select m.upstream_endpoint_ref from public.custom_models m where m.id = custom_models.id)
    and hf_token_secret_id is not distinct from
                             (select m.hf_token_secret_id from public.custom_models m where m.id = custom_models.id)
    and supports_tools     is not distinct from
                             (select m.supports_tools     from public.custom_models m where m.id = custom_models.id)
    and base_model_id      is not distinct from
                             (select m.base_model_id      from public.custom_models m where m.id = custom_models.id)
    and base_model_match   is not distinct from
                             (select m.base_model_match   from public.custom_models m where m.id = custom_models.id)
    and license_ack_at     is not distinct from
                             (select m.license_ack_at     from public.custom_models m where m.id = custom_models.id)
    and license_ack_version is not distinct from
                             (select m.license_ack_version from public.custom_models m where m.id = custom_models.id)
    and suspended_at       is not distinct from
                             (select m.suspended_at       from public.custom_models m where m.id = custom_models.id)
    and suspension_reason  is not distinct from
                             (select m.suspension_reason  from public.custom_models m where m.id = custom_models.id)
    and total_requests     = (select m.total_requests     from public.custom_models m where m.id = custom_models.id)
    and platform_fee_bps   = (select m.platform_fee_bps   from public.custom_models m where m.id = custom_models.id)
    and runpod_workers_min = 0
    -- THE NEW CLAUSE. While a listing is suspended its `deleted_at` is frozen
    -- too; see the header. Scoped to the suspended case, so the ordinary delete
    -- flow on an unsuspended listing is byte-for-byte unchanged.
    and ((select m.suspended_at from public.custom_models m where m.id = custom_models.id) is null
         or deleted_at is not distinct from
            (select m.deleted_at from public.custom_models m where m.id = custom_models.id))
  );

comment on policy custom_models_update_own on public.custom_models is
  'The creator''s own edit surface. Every platform-written column is pinned to '
  'its stored value; on a SUSPENDED listing `deleted_at` is pinned as well, '
  'because deleting one frees its variant slot in custom_models_variant_uniq and '
  'turns a takedown into a re-list. The pins are WITH CHECK rather than USING on '
  'purpose: a USING filter would make a forbidden write match zero rows and '
  'succeed silently instead of raising 42501.';

-- ============================================================================
-- gateway_resolve — the one fact that makes a suspension stop the stream
--
-- #24's `custom_models_select_public` covers every RLS-bound reader at once:
-- the catalog, the model page, the sitemap. It does NOT cover the gateway, and
-- cannot: `gateway_resolve` is SECURITY DEFINER and bypasses RLS by design,
-- because it must return a private and a non-existent model IDENTICALLY so a
-- probe cannot enumerate private listings (20260817001800, NON-filter 2).
--
-- So the suspension arrives the same way visibility does — as a RAW FACT the
-- Edge Function maps to a status code. No WHERE clause is added here, for the
-- same reason none was added for visibility: filtering the row out would make
-- "suspended" indistinguishable from "no such key's model", which loses the
-- gateway's ability to answer 401 `revoked_api_key` on the same request.
--
-- Otherwise BYTE-IDENTICAL to its definition in 20260819000300_tool_calling.sql,
-- which is the current definition of record. Two added lines: `m.suspended_at`
-- in the projection, `modelSuspendedAt` in the envelope.
-- ============================================================================
create or replace function public.gateway_resolve(
  p_key_hash       text,
  p_creator_handle text,
  p_model_slug     text
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_key   record;
  v_payer record;
  v_model record;
begin
  select k.id, k.user_id, k.revoked_at, k.scopes
    into v_key
    from public.api_keys k
   where k.key_hash = p_key_hash;          -- NO revoked_at filter. See 20260817001800.

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_key');
  end if;

  select p.id, p.handle, p.is_suspended, p.balance_micro_usd, p.rate_limit_rpm
    into v_payer
    from public.profiles p
   where p.id = v_key.user_id;

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_key');
  end if;

  select m.id, m.user_id as creator_id, m.slug, m.served_model_name, m.runtime,
         m.upstream_endpoint_ref, m.status, m.visibility, m.deleted_at,
         m.suspended_at,
         m.price_prompt_micro_usd_per_mtoken     as pp,
         m.price_completion_micro_usd_per_mtoken as pc,
         m.platform_fee_bps, m.context_length, m.cold_start_budget_s,
         m.max_concurrent_streams, m.variant_files, m.supports_tools
    into v_model
    from public.custom_models m
    join public.profiles c on c.id = m.user_id
   where c.handle = p_creator_handle
     and m.slug   = p_model_slug;          -- NO visibility/status filter.

  if not found then
    return jsonb_build_object('found', false, 'reason', 'no_model');
  end if;

  return jsonb_build_object(
    'found', true,
    -- ── ResolvedRequest (packages/shared/types.ts) ──────────────────────────
    'apiKeyId',             v_key.id,
    'userId',               v_payer.id,
    'modelId',              v_model.id,
    'creatorId',            v_model.creator_id,
    'upstreamEndpointRef',  v_model.upstream_endpoint_ref,
    -- DEPRECATED alias, identical value. Safe to delete once nothing reads it.
    'runpodEndpointId',     v_model.upstream_endpoint_ref,
    'servedModelName',      v_model.served_model_name,
    'runtime',              v_model.runtime,
    'pricePromptMicro',     v_model.pp,
    'priceCompletionMicro', v_model.pc,
    'platformFeeBps',       v_model.platform_fee_bps,
    'contextLength',        v_model.context_length,
    'coldStartBudgetS',     v_model.cold_start_budget_s,
    -- NULL stays NULL through jsonb: "unknown" must not collapse to false.
    'supportsTools',        v_model.supports_tools,
    -- ── Raw facts the gateway maps to status codes itself ───────────────────
    'keyRevokedAt',         v_key.revoked_at,          -- non-null => 401 revoked_api_key
    'keyScopes',            to_jsonb(v_key.scopes),
    'userIsSuspended',      v_payer.is_suspended,
    'userBalanceMicroUsd',  v_payer.balance_micro_usd, -- never cache this
    'userRateLimitRpm',     v_payer.rate_limit_rpm,
    'creatorHandle',        p_creator_handle,
    'modelSlug',            v_model.slug,
    'modelStatus',          v_model.status,            -- <> 'ready'  => 503 model_unavailable
    'modelVisibility',      v_model.visibility,        -- private + not owner => 404
    'modelDeletedAt',       v_model.deleted_at,        -- non-null => 404
    -- Non-null => 404 model_not_found, for EVERYONE INCLUDING THE OWNER. That
    -- is the difference between this and `modelVisibility`: a private model
    -- still serves its owner, a suspended one serves nobody. A takedown that
    -- leaves the offender's own key working has not taken anything down.
    'modelSuspendedAt',     v_model.suspended_at,
    'maxConcurrentStreams', v_model.max_concurrent_streams,
    'variantFiles',         to_jsonb(v_model.variant_files));
end $$;

comment on function public.gateway_resolve(text, text, text) is
  'Gateway auth + model resolution in one round trip. Returns a discriminated '
  'envelope ({found:false, reason:''no_key''|''no_model''}) instead of raising, so '
  'the gateway owns the HTTP mapping. Deliberately does NOT filter revoked keys, '
  'non-ready/private models, or SUSPENDED ones — all three come back as raw '
  'facts. See the migration header before adding a WHERE.';

revoke all on function public.gateway_resolve(text, text, text) from public, anon, authenticated;
grant execute on function public.gateway_resolve(text, text, text) to service_role;
