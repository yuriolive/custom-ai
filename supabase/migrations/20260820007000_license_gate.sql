-- ============================================================================
-- 20260820007000_license_gate.sql
--
-- Phase 6 of the marketplace discovery plan (GitHub #29). Stacked on #24, whose
-- `commercial_hosting` enum and `custom_models.license_ack_*` columns this file
-- is the first reader of, and on #25, whose cascade fills them in.
--
-- ── Why the licence and not ownership ───────────────────────────────────────
-- A creator does not sell weights, they sell inference. Every serious inference
-- marketplace serves Llama, Qwen and Mistral without owning any of them, and
-- the right to do that comes from the licence — so ownership is the wrong gate
-- and the licence is the right one. The exposure sits with the PLATFORM, not
-- the creator: our GPU, our endpoint, our invoice, our name on the request the
-- end user made.
--
-- ── The gate (§5.1) ─────────────────────────────────────────────────────────
--   allowed      publishes.
--   conditional  publishes once the creator acknowledges the conditions,
--                recorded as license_ack_at + license_ack_version.
--   prohibited   a PRIVATE deploy is still fine — the creator spending their
--                own money on their own compute — but never `public`.
--   unknown      neither a silent publish nor a silent rejection: the listing
--                stays private and lands in an operator review queue.
--
-- ── Why a CHECK and not just the pipeline ───────────────────────────────────
-- Same reason `custom_models_ready_needs_placement` is a CHECK: a rule that
-- only lives in application code is a rule one code path forgets. `visibility`
-- is inside the creator's own RLS update policy, so the browser can PATCH it
-- through PostgREST with no route handler in the way — the pipeline is not even
-- the only writer today.
--
-- A CHECK constraint may only read the row it is on, and `commercial_hosting`
-- lives on `base_models`. Two columns therefore MIRROR the governing licence
-- onto the listing, maintained by trigger, in exactly the way
-- `gpu_usd_per_hour_micro_snapshot` mirrors a tier price. The mirror is not a
-- cache to be kept fresh by hand: `license_governing` below is the only
-- definition of the verdict, and both triggers call it.
--
-- ── What this file does NOT touch ───────────────────────────────────────────
-- No money column, no settlement RPC, no existing invariant. "A prohibited
-- model never accrues creator_earnings" needs no money change to hold, and the
-- reasoning is worth writing down because it is not obvious:
--   1. `prohibited` can never be `public` (the CHECK below), and
--   2. `gateway_resolve` returns visibility raw so the gateway 404s a private
--      model for anybody who is not its owner, and
--   3. self-dealing writes no `creator_earnings` row (an invariant that
--      predates this file and is asserted in 01_money_identity_test.sql).
-- The only caller a prohibited listing can have is its own owner, and their
-- calls settle to the platform. That is the whole proof.
-- ============================================================================

-- ── The governing licence of a base model ───────────────────────────────────
-- Not simply `base_models.commercial_hosting` of the row the listing points at.
-- A derivative does not escape the terms of the weights it came from by saying
-- nothing — or by saying something permissive, which quant and fine-tune repos
-- do constantly ("apache-2.0" on a Llama fine-tune is a common and wrong model
-- card). So the verdict is the STRICTEST reading over the row and its
-- ancestors.
--
-- `unknown` DEFERS rather than ranking, matching `strictest()` in
-- packages/hf-probe/src/license.ts: it is not a strictness level, it is the
-- absence of an answer, and letting an unclassified child overwrite a
-- classified parent would report Llama weights as unclassified. All-unknown
-- still yields `unknown`, which is what the gate blocks on.
--
-- The row that CONTRIBUTES the verdict is also the row whose licence text the
-- creator is asked to acknowledge — nearest first, so a child that states its
-- own conditional licence is acknowledged against its own text and not its
-- parent's.
--
-- `terms_version` is `coalesce(license_version, license_id)`. The Llama licence
-- has been revised, so the ack has to name a revision — but most cards declare
-- no revision at all, and for those the licence id IS the identity of the text
-- (`llama3.1` and `llama3.3` are different documents). A `conditional` verdict
-- with neither is therefore unacknowledgeable and unpublishable, which is the
-- fail-closed direction: it is a conclusion with no premise, and the operator
-- who reached it has to record which licence they read.
--
-- The depth cap is a cycle guard. `base_models_parent_not_self` catches the
-- only cycle a single statement can create; a longer one is not reachable
-- through #25's writer, but a recursive walk that trusted that would hang the
-- deploy pipeline rather than fail it.
create or replace function public.license_governing(p_base_model_id uuid)
returns table (
  hosting       public.commercial_hosting,
  terms_version text,
  license_id    text,
  governing_id  uuid
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with recursive chain as (
    select b.id, b.parent_id, b.commercial_hosting, b.license_id, b.license_version,
           0 as depth
      from public.base_models b
     where b.id = p_base_model_id
    union all
    select p.id, p.parent_id, p.commercial_hosting, p.license_id, p.license_version,
           c.depth + 1
      from public.base_models p
      join chain c on p.id = c.parent_id
     where c.depth < 8
  ),
  ranked as (
    select *,
           case commercial_hosting
             when 'allowed'     then 0
             when 'conditional' then 1
             when 'prohibited'  then 2
             -- `unknown` ranks NULL so `nulls last` makes it defer to any real
             -- answer anywhere in the chain.
             else null
           end as rank
      from chain
  )
  select coalesce(r.commercial_hosting, 'unknown'::public.commercial_hosting),
         coalesce(r.license_version, r.license_id),
         r.license_id,
         r.id
    from ranked r
   order by r.rank desc nulls last, r.depth asc
   limit 1;
$$;

comment on function public.license_governing(uuid) is
  'The strictest commercial_hosting over a base model and its ancestors, and '
  'the licence text a creator must acknowledge to publish under it (nearest '
  'contributing row first). `unknown` defers to any real answer in the chain '
  'rather than winning, matching strictest() in packages/hf-probe. The ONLY '
  'definition of the verdict — both gate triggers call it.';

revoke all on function public.license_governing(uuid) from public, anon, authenticated;
grant execute on function public.license_governing(uuid) to service_role;

-- ============================================================================
-- The mirror, and the gate
-- ============================================================================
alter table public.custom_models
  -- The governing verdict for the weights this listing serves. NOT NULL with a
  -- default of `unknown` for the same reason `base_models.commercial_hosting`
  -- is: three-valued logic in a publish gate is how `prohibited` becomes
  -- `allowed` by accident. A listing with no `base_model_id` at all reads
  -- `unknown` — nobody has identified the weights, so nobody has established
  -- their terms, and #25 says so in as many words.
  add column license_hosting public.commercial_hosting not null default 'unknown',

  -- What `license_ack_version` is compared against: the identity of the licence
  -- text in force for these weights. NULL when there is no licence to
  -- acknowledge.
  add column license_terms_version text check (char_length(license_terms_version) <= 100),

  -- The creator asked for a public listing and the gate held it. Without this
  -- the review queue is "every listing with an unestablished licence", which
  -- includes every deliberately private one — and a queue nobody can read is
  -- the rejection-with-extra-steps §7 warns about. With it, the queue is
  -- exactly the set of creators waiting on us.
  --
  -- Deliberately NOT pinned out of the creator's RLS policy. It is a request,
  -- not a permission: setting it on a listing the gate blocks adds the creator
  -- to a queue, and setting it on one the gate allows does nothing they could
  -- not do by flipping `visibility` themselves.
  add column license_public_requested_at timestamptz;

comment on column public.custom_models.license_hosting is
  'MIRROR of public.license_governing(base_model_id).hosting — the strictest '
  'reading over the base model and its ancestors. Trigger-maintained; a value '
  'written by any client is overwritten with the truth on the same statement. '
  'Exists as a column because a CHECK cannot read another table, and this rule '
  'has to be a CHECK.';

comment on column public.custom_models.license_terms_version is
  'MIRROR of public.license_governing(base_model_id).terms_version. '
  'license_ack_version is compared against THIS, so a stale ack — the creator '
  'accepted the old Llama text and the licence has been revised since — is '
  'distinguishable from a missing one, and neither publishes.';

comment on column public.custom_models.license_public_requested_at is
  'When the creator asked for a public listing that the licence gate held. '
  'Drives public.license_review_queue and is cleared the moment the listing '
  'actually reaches `public`.';

-- ── The gate itself ─────────────────────────────────────────────────────────
-- NOT VALID, deliberately, and this is the only compromise in the file.
-- Validating would evaluate the predicate against rows that predate it, so a
-- database with one hand-populated public listing whose licence was never
-- captured (which is exactly what production is — see the bean
-- "populate production by hand") would fail the migration instead of applying
-- it. Unpublishing somebody's live listing is an operator decision, not
-- something a schema migration should do while nobody is looking; the notice
-- below names every row in that state, and `license_review_queue` keeps naming
-- them until they are dealt with.
--
-- NOT VALID changes nothing about enforcement going forward: every INSERT and
-- every UPDATE is checked, including any UPDATE to a grandfathered row. Run
-- `alter table public.custom_models validate constraint
-- custom_models_public_needs_license;` once the queue is drained.
alter table public.custom_models
  add constraint custom_models_public_needs_license
    check (
      visibility <> 'public'
      or license_hosting = 'allowed'
      or (license_hosting = 'conditional'
          and license_ack_at is not null
          and license_terms_version is not null
          and license_ack_version = license_terms_version)
    ) not valid;

-- ── The mirror's only writer ────────────────────────────────────────────────
-- Also the demotion path, and this is the division of labour worth
-- understanding before changing either half:
--
--   the TRIGGER demotes   a listing whose licence changed UNDER it. An operator
--                         classifying weights as `prohibited`, or a re-probe
--                         bumping a licence revision, must SUCCEED and take the
--                         listing out of the catalog with it. Raising there
--                         would mean the takedown fails and the listing stays
--                         published, which is precisely backwards.
--
--   the CHECK raises      for the other direction: somebody asking for `public`
--                         on a listing the gate does not allow. That is a
--                         request to refuse out loud, not to silently ignore —
--                         a creator who flips the switch and sees nothing
--                         happen has been told nothing.
--
-- The two are told apart by whether the mirror moved on this statement.
create or replace function public.tg_custom_models_license_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hosting       public.commercial_hosting := 'unknown';
  v_terms_version text;
  v_gate_ok       boolean;
  -- All three stay FALSE on INSERT, and are computed in one `tg_op` branch
  -- rather than inside the conditions that read them: PL/pgSQL leaves OLD
  -- unassigned on an INSERT, and `and` is not specified to short-circuit, so a
  -- guarded `tg_op = 'UPDATE' and old.something` is a latent error rather than a
  -- guard.
  v_mirror_moved  boolean := false;
  v_ack_moved     boolean := false;
  v_went_private  boolean := false;
begin
  if new.base_model_id is not null then
    select g.hosting, g.terms_version
      into v_hosting, v_terms_version
      from public.license_governing(new.base_model_id) g;
    -- An id that resolves to no row (a base model deleted in the same
    -- statement) leaves the declared default: unknown, and unknown blocks.
    if not found then
      v_hosting := 'unknown';
      v_terms_version := null;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    v_mirror_moved := v_hosting is distinct from old.license_hosting
                      or v_terms_version is distinct from old.license_terms_version;
    v_ack_moved := new.license_ack_at is distinct from old.license_ack_at
                   or new.license_ack_version is distinct from old.license_ack_version;
    -- Read before the branches below may rewrite `new.visibility`, so it means
    -- what the STATEMENT asked for rather than what the trigger decided.
    v_went_private := new.visibility = 'private' and old.visibility = 'public';
  end if;

  new.license_hosting       := v_hosting;
  new.license_terms_version := v_terms_version;

  -- The gate predicate, restated once. It is the CHECK's predicate and it has
  -- to stay in step with it; the pgTAP file asserts the pair on every branch of
  -- the four-row table.
  v_gate_ok := new.license_hosting = 'allowed'
               or (new.license_hosting = 'conditional'
                   and new.license_ack_at is not null
                   and new.license_terms_version is not null
                   and new.license_ack_version = new.license_terms_version);

  if v_mirror_moved and new.visibility = 'public' and not v_gate_ok then
    -- The licence moved under a published listing. Out of the catalog it goes,
    -- and the creator's standing request to be public is preserved so the queue
    -- and the operator's next decision can complete it.
    new.visibility := 'private';
    new.license_public_requested_at :=
      coalesce(new.license_public_requested_at, now());

  elsif new.visibility = 'private' and v_gate_ok
        and new.license_public_requested_at is not null
        and (v_mirror_moved or v_ack_moved) then
    -- The held request completes: an operator established the terms, or the
    -- creator acknowledged them. Publishing here is what stops the review queue
    -- from being a rejection with extra steps — the creator asked for public
    -- and nothing is standing in the way any more.
    --
    -- `v_ack_moved` compares BOTH ack columns, not just the timestamp. `now()`
    -- is transaction time, so re-acknowledging a revised licence in the same
    -- transaction that revised it moves only the VERSION — and that is the case
    -- this branch exists for.
    new.visibility := 'public';
    new.license_public_requested_at := null;
  end if;

  if new.visibility = 'public' then
    -- Satisfied, by whatever route.
    new.license_public_requested_at := null;
  elsif v_went_private and not v_mirror_moved then
    -- The creator took their own listing private. That withdraws the request;
    -- leaving it standing would let a later operator decision re-publish
    -- something its owner has since unpublished.
    new.license_public_requested_at := null;
  end if;

  return new;
end $$;

comment on function public.tg_custom_models_license_gate() is
  'Recomputes license_hosting / license_terms_version from '
  'license_governing(base_model_id) and demotes a listing whose licence moved '
  'under it. Never raises: a licence classification must succeed and take the '
  'listing down with it. Asking for `public` on a blocked listing is the '
  'CHECK''s job to refuse.';

create trigger custom_models_license_gate_insert
  before insert on public.custom_models
  for each row execute function public.tg_custom_models_license_gate();

-- The WHEN clause is not an optimization, it is the reason the billing path is
-- untouched: `tg_bump_model_counters` UPDATEs total_requests and the token
-- totals on this table for every settled request, and a recursive walk of
-- base_models per request is not something to put on that path.
create trigger custom_models_license_gate_update
  before update on public.custom_models
  for each row
  when (new.base_model_id            is distinct from old.base_model_id
     or new.license_hosting          is distinct from old.license_hosting
     or new.license_terms_version    is distinct from old.license_terms_version
     or new.visibility               is distinct from old.visibility
     or new.license_ack_at           is distinct from old.license_ack_at
     or new.license_ack_version      is distinct from old.license_ack_version
     or new.license_public_requested_at
                                     is distinct from old.license_public_requested_at)
  execute function public.tg_custom_models_license_gate();

-- ── When the LICENCE changes, not the listing ───────────────────────────────
-- The operator surface writes `base_models.commercial_hosting`; the listings
-- that serve those weights are what the decision is actually about. Without
-- this the operator marks weights prohibited and every listing of them keeps
-- serving from the catalog.
--
-- The whole SUBTREE, because the verdict reads ancestors: classifying
-- `meta/llama-3.1-8b` as prohibited has to reach the listings of every
-- fine-tune of it, not just the ones pointing directly at it.
create or replace function public.tg_base_models_resync_license_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Values are computed here rather than poked, because the BEFORE trigger on
  -- custom_models only fires when the mirror actually moves — writing a
  -- placeholder would be a no-op update on exactly the rows whose verdict did
  -- not change, and those are the rows that must not be demoted.
  -- `UPDATE ... FROM f(target.col)` is not lateral-visible to the target table,
  -- so the row is re-read through an alias the function CAN see.
  update public.custom_models m
     set license_hosting       = g.hosting,
         license_terms_version = g.terms_version
    from public.custom_models src
         cross join lateral public.license_governing(src.base_model_id) g
   where src.id = m.id
     and m.deleted_at is null
     and m.base_model_id in (
       with recursive subtree as (
         select b.id, 0 as depth from public.base_models b where b.id = new.id
         union all
         select c.id, s.depth + 1
           from public.base_models c
           join subtree s on c.parent_id = s.id
          where s.depth < 8
       )
       select id from subtree
     );
  return null;
end $$;

comment on function public.tg_base_models_resync_license_gate() is
  'Pushes a licence change out to every listing it governs, itself and its '
  'descendants. The custom_models BEFORE trigger does the demotion; this only '
  'has to reach the right rows.';

create trigger base_models_resync_license_gate
  after update of commercial_hosting, license_id, license_version, parent_id
  on public.base_models
  for each row execute function public.tg_base_models_resync_license_gate();

-- ============================================================================
-- The review queue (§5.1, `unknown`)
--
-- `unknown` is the one verdict that is a QUESTION rather than an answer, and
-- the only one an operator can resolve: they read the card, decide what the
-- weights actually permit, and write `base_models.commercial_hosting`. The
-- resync trigger above then completes the creator's held request.
--
-- Scoped to `unknown` on purpose. `conditional` without an ack is the
-- CREATOR's inbox, not ours — Studio asks them and the answer is theirs to
-- give. `prohibited` is a decided answer; a listing sitting behind it is not
-- waiting for anybody.
--
-- §7 asks who staffs this and in what window. That is a product question and
-- this file does not answer it — but it does make the queue countable, which
-- is the difference between an unstaffed queue somebody can measure and one
-- nobody knows exists.
-- ============================================================================
create view public.license_review_queue
with (security_invoker = on) as
select m.id                          as model_id,
       m.user_id,
       m.slug,
       m.display_name,
       m.hf_repo_slug,
       m.hf_revision,
       m.status,
       m.visibility,
       m.base_model_id,
       b.slug                        as base_model_slug,
       b.license_id                  as base_model_license_id,
       b.license_name                as base_model_license_name,
       b.license_url                 as base_model_license_url,
       m.base_model_match ->> 'signal' as base_model_signal,
       m.license_public_requested_at,
       -- How long the creator has been waiting, which is the only number a
       -- review-window commitment can ever be measured against.
       now() - m.license_public_requested_at as waiting_for
  from public.custom_models m
  left join public.base_models b on b.id = m.base_model_id
 where m.deleted_at is null
   -- A deployment that never came up is not waiting on a licence decision, and
   -- an operator reading a queue of dead rows stops reading the queue.
   and m.status not in ('failed', 'auth_failed', 'deleting', 'deleted')
   and m.license_public_requested_at is not null
   and m.license_hosting = 'unknown';

comment on view public.license_review_queue is
  'Listings whose creator asked for a public listing and whose weights have no '
  'established licence terms. The operator resolves one by writing '
  'base_models.commercial_hosting; the resync trigger then publishes the '
  'listing if the answer allows it. service_role only — the operator surface '
  'is #31 and no client role reads this.';

revoke all on public.license_review_queue from public, anon, authenticated;
grant select on public.license_review_queue to service_role;

-- ============================================================================
-- Backfill: the mirror describes every existing row, and the grandfathered
-- public ones get named out loud.
-- ============================================================================
update public.custom_models m
   set license_hosting       = g.hosting,
       license_terms_version = g.terms_version
  from public.custom_models src
       cross join lateral public.license_governing(src.base_model_id) g
 where src.id = m.id
   and m.base_model_id is not null;

do $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select id, slug, license_hosting
      from public.custom_models
     where deleted_at is null
       and visibility = 'public'
       and not (license_hosting = 'allowed'
                or (license_hosting = 'conditional'
                    and license_ack_at is not null
                    and license_terms_version is not null
                    and license_ack_version = license_terms_version))
  loop
    v_count := v_count + 1;
    raise notice
      'license gate: listing % (%) is public with commercial_hosting=% and is '
      'grandfathered by NOT VALID. It is in license_review_queue only once its '
      'creator re-requests public; establish base_models.commercial_hosting for '
      'it, or take it private.',
      v_row.slug, v_row.id, v_row.license_hosting;
  end loop;

  if v_count = 0 then
    raise notice 'license gate: no existing public listing violates it.';
  end if;
end $$;
