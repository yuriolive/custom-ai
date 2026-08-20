-- ============================================================================
-- FR-CON-001 — api_keys.request_count / last_used_at.
--
-- The columns shipped with a default and no writer, so the console's "Requests"
-- and "Last used" were structurally 0/never. 20260819000400 made
-- authorize_request the single writer, with an EXACT contract:
--
--   request_count == count(usage_transactions where api_key_id = this key)
--   last_used_at  == max(created_at) over those same rows
--
-- Everything below defends that equality — both halves. It is easy to write a
-- counter that only ever over-counts (bump on replay, bump on a rejected
-- authorize, bump again at settlement), and every one of those bugs is silent:
-- the number still looks plausible in the UI. So the negative cases carry as
-- much weight here as the positive one.
--
-- Concurrency lives in 05_concurrency_test.sql (scenario 8) — a single
-- connection cannot show a lost increment or the FK-lock deadlock.
-- ============================================================================
begin;
select plan(47);

\set creator '00000000-0000-0000-0000-0000000000a1'
\set payer   '00000000-0000-0000-0000-0000000000a2'
\set apikey  '00000000-0000-0000-0000-0000000000b1'
\set revoked '00000000-0000-0000-0000-0000000000b2'
\set model   '00000000-0000-0000-0000-0000000000c1'

-- ── The plumbing exists ─────────────────────────────────────────────────────
select has_view('public', 'v_api_key_usage_drift', 'the counter audit view exists');
-- Checked against the catalog rather than has_index(): the four-argument form of
-- has_index reads its last argument as a COLUMN, not a description, and this
-- index is on two columns with a DESC and a partial predicate.
select ok(
  exists (select 1 from pg_index i
            join pg_class c on c.oid = i.indexrelid
           where c.relname = 'usage_txn_api_key_time_idx'),
  'usage_transactions is indexed by api_key_id (the drift view and the backfill scan it)');

-- ── Baseline: the seed has keys and no traffic ───────────────────────────────
select is((select request_count from public.api_keys where id = :'apikey'::uuid), 0::bigint,
          'the seeded key starts at 0 requests');
select ok((select last_used_at from public.api_keys where id = :'apikey'::uuid) is null,
          'the seeded key has never been used');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'no counter drift on a freshly seeded database');

-- ════════════════════════════════════════════════════════════════════════════
-- The positive case: one admitted request, one increment.
-- ════════════════════════════════════════════════════════════════════════════
select public.authorize_request('c0000000-0000-0000-0000-000000000001'::uuid, :'payer'::uuid,
                               :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);

select is((select request_count from public.api_keys where id = :'apikey'::uuid), 1::bigint,
          'an admitted authorize bumps request_count to 1');
-- `now()` is the transaction timestamp, so the bump and the row it counts share
-- it exactly. If the bump ever moves to clock_timestamp() this fails, and it
-- should: the drift view's equality on last_used_at would start reporting.
select is((select last_used_at from public.api_keys where id = :'apikey'::uuid), now(),
          'last_used_at is the transaction timestamp of the reservation');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'the counters agree with usage_transactions after one request');

-- ── A replayed authorize is the SAME request, not a second one ──────────────
select public.authorize_request('c0000000-0000-0000-0000-000000000001'::uuid, :'payer'::uuid,
                               :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);
select is((select request_count from public.api_keys where id = :'apikey'::uuid), 1::bigint,
          'a replayed authorize does not double-count');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'no drift after a replay');

-- ── Settlement must not bump again ──────────────────────────────────────────
-- This is the trap in ALSO bumping inside deduct_token_cost: both RPCs run once
-- per request, so a writer in each place doubles every number.
select public.deduct_token_cost('c0000000-0000-0000-0000-000000000001'::uuid, 1000, 2000);
select is((select request_count from public.api_keys where id = :'apikey'::uuid), 1::bigint,
          'settling a reservation does not bump request_count');

-- ── A request that voids is still counted ───────────────────────────────────
-- The whole reason the writer is at reservation and not at settlement: a call
-- that delivered nothing is still a call, and is the most interesting kind when
-- the question is "what is still using this key?".
select public.authorize_request('c0000000-0000-0000-0000-000000000002'::uuid, :'payer'::uuid,
                               :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);
select public.void_reservation('c0000000-0000-0000-0000-000000000002'::uuid,
                               'upstream_unavailable', 'no tokens delivered');
select is((select request_count from public.api_keys where id = :'apikey'::uuid), 2::bigint,
          'a voided request is still counted (settlement-time counting would miss it)');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'no drift after a void');

-- ── A request the reaper expires is counted, and never decremented ──────────
select public.authorize_request('c0000000-0000-0000-0000-000000000003'::uuid, :'payer'::uuid,
                               :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);
update public.usage_transactions set expires_at = now() - interval '1 minute'
 where id = 'c0000000-0000-0000-0000-000000000003'::uuid;
select ok((select public.expire_stale_holds()) >= 1, 'the reaper swept the backdated hold');
select is((select request_count from public.api_keys where id = :'apikey'::uuid), 3::bigint,
          'an expired reservation is counted and not rolled back');

-- ════════════════════════════════════════════════════════════════════════════
-- The negative cases. Every authorize below is REFUSED and must write nothing.
-- ════════════════════════════════════════════════════════════════════════════
create temp table before_rejections as
select request_count as n, last_used_at as t
  from public.api_keys where id = :'apikey'::uuid;

-- insufficient_balance. Provoked with a huge max_tokens rather than by editing
-- the balance or the price: the wallet is left alone so v_balance_drift can be
-- asserted at the end, and the model is left `ready` so this is a pure
-- balance refusal and not a disguised model_unavailable.
select is((select public.authorize_request('c0000000-0000-0000-0000-000000000010'::uuid,
                                          :'payer'::uuid, :'apikey'::uuid, :'model'::uuid,
                                          1000, 10000000, true)->>'code'),
          'insufficient_balance', 'the oversized request really was refused');
select is((select request_count from public.api_keys where id = :'apikey'::uuid),
          (select n from before_rejections),
          'insufficient_balance does not bump request_count');

-- model_unavailable.
update public.custom_models set status = 'paused' where id = :'model'::uuid;
select is((select public.authorize_request('c0000000-0000-0000-0000-000000000011'::uuid,
                                          :'payer'::uuid, :'apikey'::uuid, :'model'::uuid,
                                          1000, 2000, true)->>'code'),
          'model_unavailable', 'the paused-model request really was refused');
update public.custom_models set status = 'ready' where id = :'model'::uuid;
select is((select request_count from public.api_keys where id = :'apikey'::uuid),
          (select n from before_rejections),
          'model_unavailable does not bump request_count');

-- account_suspended.
update public.profiles set is_suspended = true where id = :'payer'::uuid;
select is((select public.authorize_request('c0000000-0000-0000-0000-000000000012'::uuid,
                                          :'payer'::uuid, :'apikey'::uuid, :'model'::uuid,
                                          1000, 2000, true)->>'code'),
          'account_suspended', 'the suspended-account request really was refused');
update public.profiles set is_suspended = false where id = :'payer'::uuid;
select is((select request_count from public.api_keys where id = :'apikey'::uuid),
          (select n from before_rejections),
          'account_suspended does not bump request_count');

select is((select last_used_at from public.api_keys where id = :'apikey'::uuid),
          (select t from before_rejections),
          'no rejected authorize moves last_used_at');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'no drift introduced by three rejected authorizes');

-- ── p_api_key_id => null must not raise and must not bump anything ──────────
-- usage_transactions.api_key_id is nullable, the self-dealing fixture in 03 and
-- every scenario in 05 pass null, and `update ... where id = null` would match
-- zero rows quietly — but a `not null` assumption in the bump would take
-- settlement down with it.
create temp table before_null as
select coalesce(sum(request_count), 0) as total from public.api_keys;
select lives_ok(
  $$ select public.authorize_request('c0000000-0000-0000-0000-000000000020'::uuid,
                                     '00000000-0000-0000-0000-0000000000a2'::uuid, null,
                                     '00000000-0000-0000-0000-0000000000c1'::uuid,
                                     1000, 2000, true) $$,
  'authorize with a null api_key_id succeeds');
select is((select coalesce(sum(request_count), 0) from public.api_keys),
          (select total from before_null),
          'a keyless reservation bumps no key');
select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'the drift view ignores keyless reservations');

-- ── Revocation is not consulted ─────────────────────────────────────────────
-- The gateway maps a revoked key to 401 before authorize is ever called, so this
-- is unreachable in production. Pinned anyway: the counter answers "was this key
-- used", and if a revoked key ever does reach a reservation, silently not
-- counting it is the worse of the two answers.
select public.authorize_request('c0000000-0000-0000-0000-000000000030'::uuid, :'payer'::uuid,
                               :'revoked'::uuid, :'model'::uuid, 1000, 2000, true);
select is((select request_count from public.api_keys where id = :'revoked'::uuid), 1::bigint,
          'a revoked key still counts a reservation made with it');

-- ════════════════════════════════════════════════════════════════════════════
-- updated_at keeps meaning "last modified by its owner".
-- The bump is an UPDATE, so without the trigger WHEN clause added by
-- 20260819000400 it would move updated_at on every request — leaving api_keys
-- with two columns that both mean "last used" and none that means "last edited".
-- ════════════════════════════════════════════════════════════════════════════
-- Backdating updated_at requires a statement the trigger SKIPS, and the only
-- such statement is one that moves request_count. That is the property under
-- test, used here as the tool: bump and un-bump, carrying the backdate through.
update public.api_keys
   set request_count = request_count + 1,
       updated_at    = now() - interval '7 days'
 where id = :'apikey'::uuid;
update public.api_keys set request_count = request_count - 1 where id = :'apikey'::uuid;

create temp table before_touch as
select updated_at as u from public.api_keys where id = :'apikey'::uuid;
select cmp_ok((select u from before_touch), '<', now(),
              'a counter-moving update skips the updated_at trigger');

select public.authorize_request('c0000000-0000-0000-0000-000000000040'::uuid, :'payer'::uuid,
                               :'apikey'::uuid, :'model'::uuid, 1000, 2000, true);
select is((select updated_at from public.api_keys where id = :'apikey'::uuid),
          (select u from before_touch),
          'a usage bump does not touch updated_at');

update public.api_keys set name = 'renamed by its owner' where id = :'apikey'::uuid;
select cmp_ok((select updated_at from public.api_keys where id = :'apikey'::uuid), '>',
              (select u from before_touch),
              'a rename still touches updated_at');

-- ════════════════════════════════════════════════════════════════════════════
-- The audit view must actually DETECT drift, and the backfill must repair it.
-- A view that is empty because it is mis-joined would pass every assertion
-- above, so break the invariant on purpose and require a row.
-- ════════════════════════════════════════════════════════════════════════════
create temp table truth as
select api_key_id, count(*)::bigint as n, max(created_at) as t
  from public.usage_transactions
 where api_key_id is not null
 group by api_key_id;

select cmp_ok((select n from truth where api_key_id = :'apikey'::uuid), '>', 1::bigint,
              'the fixture produced several reservations to reconcile against');
select is((select request_count from public.api_keys where id = :'apikey'::uuid),
          (select n from truth where api_key_id = :'apikey'::uuid),
          'FR-CON-001: request_count == count(usage_transactions), exactly');
select is((select last_used_at from public.api_keys where id = :'apikey'::uuid),
          (select t from truth where api_key_id = :'apikey'::uuid),
          'FR-CON-001: last_used_at == max(usage_transactions.created_at), exactly');

-- Under-count and over-count both have to be visible.
update public.api_keys set request_count = request_count - 1 where id = :'apikey'::uuid;
select is((select count_drift from public.v_api_key_usage_drift
            where api_key_id = :'apikey'::uuid),
          -1::bigint, 'the audit view reports a lost increment');
update public.api_keys set request_count = request_count + 3 where id = :'apikey'::uuid;
select is((select count_drift from public.v_api_key_usage_drift
            where api_key_id = :'apikey'::uuid),
          2::bigint, 'the audit view reports a double-applied increment');

-- A stale timestamp with a correct count must still be caught.
update public.api_keys
   set request_count = (select n from truth where api_key_id = :'apikey'::uuid),
       last_used_at  = null
 where id = :'apikey'::uuid;
select is((select count(*)::int from public.v_api_key_usage_drift
            where api_key_id = :'apikey'::uuid),
          1, 'the audit view reports a stale last_used_at even when the count is right');

-- The backfill from 20260819000400, run verbatim: it is the repair procedure, so
-- it has to close every one of the states above.
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

select is((select count(*)::int from public.v_api_key_usage_drift), 0,
          'the backfill repairs every drifted key');
select is((select request_count from public.api_keys where id = :'apikey'::uuid),
          (select n from truth where api_key_id = :'apikey'::uuid),
          'the backfill restores the exact count');
select is((select last_used_at from public.api_keys where id = :'apikey'::uuid),
          (select t from truth where api_key_id = :'apikey'::uuid),
          'the backfill restores the exact last_used_at');

-- ── The counter work must not have touched the money ────────────────────────
select is((select count(*)::int from public.v_balance_drift), 0,
          'I4: the whole fixture moved no money without a ledger row');

-- ── Ops-only, like v_balance_drift ──────────────────────────────────────────
-- The view joins across every user's keys, and Supabase's default privileges
-- would hand it to anon and authenticated the moment it was created.
select ok(not has_table_privilege('anon', 'public.v_api_key_usage_drift', 'SELECT'),
          'anon cannot select the counter audit view');
select ok(not has_table_privilege('authenticated', 'public.v_api_key_usage_drift', 'SELECT'),
          'authenticated cannot select the counter audit view');

-- ════════════════════════════════════════════════════════════════════════════
-- The key's OWNER must not be able to write its own counters.
--
-- api_keys_update_own shipped as a denylist that pinned key_hash and key_prefix
-- and permitted everything else, so this was writable from the browser. It did
-- not matter while nothing read the columns. It matters now: they are a
-- reconciled projection, so a self-serve write forges a v_api_key_usage_drift
-- row — a P1 alert anyone with a session can manufacture, on a view that is
-- worthless if its subject can edit itself.
--
-- Probed as the REAL role, like 04, not by reading the grant catalog.
-- ════════════════════════════════════════════════════════════════════════════
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
set local role authenticated;

-- Guard: with a null auth.uid() the UPDATEs below match zero rows and pass
-- vacuously. Assert the impersonation is real first.
select is(auth.uid(), '00000000-0000-0000-0000-0000000000a2'::uuid,
          'the session really is acting as the key owner');

select throws_ok(
  $$ update public.api_keys set request_count = 999999
       where id = '00000000-0000-0000-0000-0000000000b1' $$,
  '42501', null, 'the owner cannot inflate its own request_count');

select throws_ok(
  $$ update public.api_keys set last_used_at = now()
       where id = '00000000-0000-0000-0000-0000000000b1' $$,
  '42501', null, 'the owner cannot forge its own last_used_at');

-- The allowlist has to still permit the two operations the console performs, or
-- this is a lockout dressed as a fix.
select lives_ok(
  $$ update public.api_keys set name = 'renamed under RLS'
       where id = '00000000-0000-0000-0000-0000000000b1' $$,
  'the owner can still rename its own key');
select is((select name from public.api_keys
            where id = '00000000-0000-0000-0000-0000000000b1'),
          'renamed under RLS', 'the rename actually landed');

reset role;
select * from finish();
rollback;
