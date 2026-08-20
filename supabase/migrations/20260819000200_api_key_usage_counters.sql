-- ============================================================================
-- 20260819000200_api_key_usage_counters.sql   (FR-CON-001)
--
-- Gives api_keys.request_count / last_used_at a WRITER. Until this migration
-- nothing in the repo ever UPDATEd either column — five call sites read them,
-- zero wrote them — so the console's "Last used" column read "Never" and
-- "Requests" read 0 for every key that had ever served traffic.
--
-- ── Why the writer lives in authorize_request and not on the resolve path ────
-- 20260817001800_gateway_resolve.sql declines to bump these columns, and that
-- reasoning stands: gateway_resolve is `stable`, runs before any lock is taken,
-- and cannot be skipped or cached, so writing there would put a fresh row lock
-- in front of every single request including the ones that fail auth.
--
-- authorize_request has neither problem. By the time the bump happens it has
-- ALREADY taken `profiles(payer) FOR UPDATE` and inserted a usage_transactions
-- row. An api key belongs to exactly one profile, so every request that could
-- contend for a given api_keys row is already serialized on that profile row —
-- the api_keys lock is strictly downstream of one the caller holds. It adds no
-- new serialization point, only one more row write inside a transaction that
-- was always going to commit.
--
-- ── Why not deduct_token_cost ───────────────────────────────────────────────
-- Settlement is also a per-request write transaction, but it only runs for
-- requests that settle. A request that streams and then voids (zero tokens
-- delivered), fails upstream, or expires under the reaper is still a use of the
-- key — and on the "is anything still calling with this key?" question, which is
-- the entire reason the column exists, a failed call is the most interesting
-- kind. Counting at reservation catches all of them.
--
-- ── What the number means, exactly ──────────────────────────────────────────
--   request_count == count(usage_transactions where api_key_id = this key)
--   last_used_at  == max(created_at) over those same rows
--
-- Both hold as EQUALITIES, not approximations, which is why
-- v_api_key_usage_drift below can assert them and why the backfill at the bottom
-- is exact rather than best-effort. The bump sits after the idempotency guard,
-- so a retried authorize with the same txn id returns the existing reservation
-- and does not re-count.
--
-- The last_used_at half is only an equality because the write is GREATEST and
-- not an assignment — see the bump itself. Transactions serialize in COMMIT
-- order but stamp `now()` at START, and under concurrency those two orders
-- disagree.
--
-- NOT counted, deliberately: requests rejected before a reservation exists —
-- unknown or revoked key, suspended account, insufficient balance, model not
-- ready. Those paths return `{ok:false}` (or never reach the RPC at all) and
-- write nothing. Bumping there would let an unauthenticated caller drive
-- unbounded writes into api_keys with a garbage key hash, which is a
-- write-amplification DoS on the one path that must stay cheap. The console and
-- keygen say so rather than implying the count is every HTTP call.
--
-- ── Lock order ──────────────────────────────────────────────────────────────
-- CONTRACTS.md's order becomes
--   usage_transactions -> profiles(payer) -> profiles(creator) -> api_keys
-- api_keys is LAST and is a sink: no RPC acquires anything after it, so it
-- cannot close a cycle. The bump is a plain UPDATE of non-key columns, so it
-- takes FOR NO KEY UPDATE, which does NOT conflict with the FOR KEY SHARE that
-- the usage_transactions FK check just took on the same row — two concurrent
-- authorizes on one key would otherwise deadlock against each other's own FK
-- lock. Putting request_count into a unique index or a foreign key would promote
-- that lock to FOR UPDATE and reintroduce exactly that deadlock.
-- ============================================================================

comment on column public.api_keys.request_count is
  'Requests ADMITTED for billing with this key: exactly count(usage_transactions '
  'with this api_key_id). Written by authorize_request, never on the resolve path. '
  'Excludes requests rejected before reservation (revoked key, insufficient '
  'balance, model not ready) — those create no transaction. Reconciled by '
  'v_api_key_usage_drift.';

comment on column public.api_keys.last_used_at is
  'When this key last had a request admitted for billing: exactly '
  'max(usage_transactions.created_at) for this api_key_id. A request rejected at '
  'auth does not move it, so a key can be in active (failing) use and still read '
  'stale here. See api_keys.request_count.';

-- ── updated_at must keep meaning "last modified by its owner" ────────────────
-- The counter bump is an UPDATE, so the existing api_keys_updated_at trigger
-- would fire on every request and turn updated_at into a second, worse copy of
-- last_used_at — silently breaking any future "recently changed keys" view,
-- which would return every active key. A usage bump always increments
-- request_count and a rename/revoke never touches it, so that column is an exact
-- discriminator between the two kinds of write.
drop trigger if exists api_keys_updated_at on public.api_keys;
create trigger api_keys_updated_at
  before update on public.api_keys
  for each row
  when (new.request_count = old.request_count)
  execute function public.tg_set_updated_at();

-- ── The owner must not be able to write the counters ────────────────────────
-- api_keys_update_own (20260817000500) is a DENYLIST: it pins key_hash and
-- key_prefix and implicitly permits every other column, so `authenticated` could
-- always UPDATE its own request_count and last_used_at. That was harmless vanity
-- while nothing wrote or trusted them. It is not harmless now: the columns are a
-- reconciled projection of usage_transactions, so a client write puts a row in
-- v_api_key_usage_drift — a forged P1 alert from the browser, and an audit view
-- worth nothing because its subject can edit itself.
--
-- Inverted to the ALLOWLIST form established by 20260817002100 for profiles,
-- with the same failure direction: a column added to api_keys later is read-only
-- until someone names it here. `name` (rename) and `revoked_at` (revoke) are the
-- only two operations the browser performs — see components/console/keys-panel.tsx.
-- updated_at is masked because the BEFORE UPDATE trigger sets it before WITH
-- CHECK runs, so it always differs and is not user-supplied.
drop policy if exists api_keys_update_own on public.api_keys;

create policy api_keys_update_own on public.api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (to_jsonb(api_keys) - 'name' - 'revoked_at' - 'updated_at')
        = (select to_jsonb(k) - 'name' - 'revoked_at' - 'updated_at'
             from public.api_keys k where k.id = api_keys.id)
  );

comment on policy api_keys_update_own on public.api_keys is
  'ALLOWLIST, not a denylist: name (rename) and revoked_at (revoke) are the only '
  'columns a user may change. key_hash, key_prefix, scopes, request_count and '
  'last_used_at — and any column added later — must be byte-identical to the '
  'stored row. Forgetting to add a new column here leaves it read-only, which is '
  'the safe direction to fail.';

-- Defense in depth, matching profiles: the table-wide UPDATE grant let a client
-- name any column in a SET clause, so a counter write was refused by RLS rather
-- than by the privilege layer. Narrow the grant to the two editable columns.
revoke update on public.api_keys from authenticated;
grant update (name, revoked_at) on public.api_keys to authenticated;

-- ── The writer ──────────────────────────────────────────────────────────────
-- Signature is unchanged from 20260817001200 and the returned envelope gains no
-- field, so CONTRACTS.md's RPC contract still holds. Only the block marked
-- FR-CON-001 is new; everything else is carried forward verbatim.
create or replace function public.authorize_request(
  p_txn_id              uuid,
  p_user_id             uuid,
  p_api_key_id          uuid,
  p_model_id            uuid,
  p_est_prompt_tokens   integer,
  p_max_tokens          integer,
  p_was_streaming       boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance      bigint;
  v_suspended    boolean;
  v_holds        bigint;
  v_available    bigint;
  v_model        record;
  v_hold         bigint;
  v_existing     record;
  v_min_floor    bigint := 100;   -- $0.0001 floor: never engage a GPU on a dust balance
begin
  -- Idempotency: a retried authorize returns the existing reservation unchanged.
  -- DIVERGENCE FROM PRD §5.7 (reported): the PRD body does
  --   `select jsonb_build_object(...) into v_balance;`
  -- which assigns jsonb into a bigint variable and raises at runtime on every
  -- replay. The dead assignment is dropped, and the envelope is filled out with
  -- hold/balance so a replay matches the shape promised in CONTRACTS.md.
  select t.hold_micro_usd, t.user_id
    into v_existing
    from public.usage_transactions t
   where t.id = p_txn_id;

  if found then
    -- FR-CON-001: no bump here. This is the same request arriving twice, and the
    -- counter counts requests, not delivery attempts.
    return jsonb_build_object(
      'ok', true, 'txn_id', p_txn_id, 'replayed', true,
      'hold_micro_usd',    v_existing.hold_micro_usd,
      'balance_micro_usd', (select p.balance_micro_usd from public.profiles p
                             where p.id = v_existing.user_id));
  end if;

  -- Lock the payer row: serializes authorize and settle for this user.
  select balance_micro_usd, is_suspended
    into v_balance, v_suspended
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;

  if v_suspended then
    return jsonb_build_object('ok', false, 'code', 'account_suspended');
  end if;

  select id, user_id, status, visibility, platform_fee_bps,
         price_prompt_micro_usd_per_mtoken     as pp,
         price_completion_micro_usd_per_mtoken as pc
    into v_model
    from public.custom_models
   where id = p_model_id and deleted_at is null;

  if not found or v_model.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'model_unavailable');
  end if;

  -- Outstanding holds for this user (open reservations not yet expired).
  select coalesce(sum(hold_micro_usd), 0)
    into v_holds
    from public.usage_transactions
   where user_id = p_user_id
     and status = 'reserved'
     and expires_at > now();

  v_available := v_balance - v_holds;

  -- Conservative worst-case cost for this request.
  v_hold := greatest(
    v_min_floor,
    public.calc_token_cost_micro(
      coalesce(p_est_prompt_tokens, 0),
      coalesce(p_max_tokens, 512),
      v_model.pp, v_model.pc)
  );

  if v_available < v_hold then
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_balance',
      'balance_micro_usd',   v_balance,
      'available_micro_usd', v_available,
      'required_micro_usd',  v_hold);
  end if;

  insert into public.usage_transactions (
    id, user_id, api_key_id, model_id, creator_id, status,
    hold_micro_usd, est_prompt_tokens, max_tokens_requested, expires_at,
    price_prompt_micro_snapshot, price_completion_micro_snapshot,
    platform_fee_bps_snapshot, was_streaming
  ) values (
    p_txn_id, p_user_id, p_api_key_id, p_model_id, v_model.user_id, 'reserved',
    v_hold, p_est_prompt_tokens, p_max_tokens, now() + interval '15 minutes',
    v_model.pp, v_model.pc, v_model.platform_fee_bps, p_was_streaming
  );

  -- ── FR-CON-001: the counter bump ──────────────────────────────────────────
  -- LAST in the lock order (see header). `now()` is the transaction timestamp,
  -- the same value usage_transactions.created_at just defaulted to.
  -- p_api_key_id is nullable on usage_transactions (and is null in the pgTAP
  -- concurrency fixtures), so the guard is real, not defensive.
  --
  -- GREATEST, not a plain assignment, and this is not paranoia — 20 concurrent
  -- authorizes on one key caught it (05_concurrency_test.sql scenario 8). `now()`
  -- is the transaction START time, but these UPDATEs are serialized in COMMIT
  -- order, and the two orders do not agree: a transaction that started earlier
  -- can write later and drag last_used_at BACKWARD, behind a request that has
  -- already been served. GREATEST makes the column the max over every now()
  -- written, which is exactly max(created_at) under any interleaving — so
  -- "last used" cannot move backwards and v_api_key_usage_drift stays empty.
  if p_api_key_id is not null then
    update public.api_keys
       set request_count = request_count + 1,
           -- GREATEST ignores nulls, so the first-ever use needs no coalesce.
           last_used_at  = greatest(last_used_at, now())
     where id = p_api_key_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'txn_id', p_txn_id,
    'hold_micro_usd',    v_hold,
    'balance_micro_usd', v_balance);
exception
  -- Two concurrent authorizes with the same txn id: the loser observes the
  -- winner's row rather than surfacing a 23505 to the gateway. The only unique
  -- constraint in play is on usage_transactions.id, so the loser raises at the
  -- INSERT and never reaches the bump below it — one request, one increment.
  when unique_violation then
    return jsonb_build_object('ok', true, 'txn_id', p_txn_id, 'replayed', true);
end $$;

comment on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean) is
  'Phase 1 of reserve-then-settle. Also the ONLY writer of api_keys.request_count '
  '/ last_used_at (FR-CON-001) — bumped once per admitted reservation, after the '
  'idempotency guard, with api_keys locked last. Rejected authorizes bump nothing.';

revoke all on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.authorize_request(uuid,uuid,uuid,uuid,integer,integer,boolean)
  to service_role;

-- Point the next reader at the writer. 20260817001800's header says the resolve
-- path does not bump and — correctly — does not say where it happens instead.
comment on function public.gateway_resolve(text, text, text) is
  'Gateway auth + model resolution in one round trip. Returns a discriminated '
  'envelope ({found:false, reason:''no_key''|''no_model''}) instead of raising, so '
  'the gateway owns the HTTP mapping. Deliberately does NOT filter revoked keys '
  'or non-ready/private models — see the migration header before adding a WHERE. '
  'Also does not bump api_keys.request_count / last_used_at: authorize_request '
  'owns those (20260819000200), off this hot path.';

-- ── Reconciliation, same contract as v_balance_drift: MUST return zero rows ──
-- The counters are an exact projection of usage_transactions, so any row here is
-- a lost or duplicated bump. Kept as a view rather than a CHECK because the
-- underlying aggregate is not constrainable and the useful reaction is an alert,
-- not a failed settlement.
create or replace view public.v_api_key_usage_drift
  with (security_invoker = true) as
  select k.id                                       as api_key_id,
         k.user_id,
         k.key_prefix,
         k.request_count                            as stored_count,
         coalesce(t.txn_count, 0)                   as reserved_count,
         k.request_count - coalesce(t.txn_count, 0) as count_drift,
         k.last_used_at                             as stored_last_used,
         t.last_reserved_at
    from public.api_keys k
    left join (
      select api_key_id,
             count(*)::bigint  as txn_count,
             max(created_at)   as last_reserved_at
        from public.usage_transactions
       where api_key_id is not null
       group by api_key_id
    ) t on t.api_key_id = k.id
   where k.request_count <> coalesce(t.txn_count, 0)
      or k.last_used_at is distinct from t.last_reserved_at;

comment on view public.v_api_key_usage_drift is
  'FR-CON-001 audit. MUST return zero rows: api_keys.request_count / last_used_at '
  'are an exact projection of usage_transactions per api_key_id. A row means a '
  'bump was lost or double-applied. Ops-only, like v_balance_drift.';

-- Supabase default privileges would otherwise hand this to anon and
-- authenticated the moment it is created, and it joins across every user's keys.
revoke all on public.v_api_key_usage_drift from public, anon, authenticated;
grant select on public.v_api_key_usage_drift to service_role;

-- Index for the drift view and for the backfill below. usage_transactions had no
-- index on api_key_id at all — its three time indexes are keyed on user, creator
-- and model — so both were sequential scans of the whole metering ledger.
create index if not exists usage_txn_api_key_time_idx
  on public.usage_transactions (api_key_id, created_at desc)
  where api_key_id is not null;

-- ── Backfill: make the columns honest for traffic that already happened ─────
-- Exact, not approximate, for the same reason the drift view can be an equality.
-- Runs once; on a fresh `db reset` the seed has no usage_transactions rows and
-- this is a no-op.
update public.api_keys k
   set request_count = t.txn_count,
       last_used_at  = t.last_reserved_at
  from (
    select api_key_id,
           count(*)::bigint  as txn_count,
           max(created_at)   as last_reserved_at
      from public.usage_transactions
     where api_key_id is not null
     group by api_key_id
  ) t
 where t.api_key_id = k.id
   and (k.request_count <> t.txn_count
        or k.last_used_at is distinct from t.last_reserved_at);
