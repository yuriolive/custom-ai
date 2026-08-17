-- ============================================================================
-- 20260817000400_profiles.sql   (PRD §5.2)
-- ============================================================================
create table public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,

  -- Identity. handle forms the `creator/` namespace and is therefore immutable.
  handle                text not null unique
                          check (handle ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  display_name          text,
  avatar_url            text,
  bio                   text check (char_length(bio) <= 500),

  -- Wallet: spendable, purchased balance. micro-USD. NEVER negative.
  balance_micro_usd     bigint not null default 0 check (balance_micro_usd >= 0),

  -- Earnings: accrued creator royalties. A SEPARATE account from balance (FR-BIL-024).
  earnings_micro_usd    bigint not null default 0 check (earnings_micro_usd >= 0),
  lifetime_earnings_micro_usd bigint not null default 0 check (lifetime_earnings_micro_usd >= 0),
  lifetime_spend_micro_usd    bigint not null default 0 check (lifetime_spend_micro_usd >= 0),

  -- Risk / ops controls
  max_balance_micro_usd bigint not null default 2000000000,   -- $2,000 (FR-BIL-036)
  is_suspended          boolean not null default false,
  suspension_reason     text,
  rate_limit_rpm        integer not null default 60 check (rate_limit_rpm > 0),

  stripe_customer_id    text unique,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on column public.profiles.balance_micro_usd is
  'Spendable prepaid wallet, micro-USD. Mutated ONLY by SECURITY DEFINER RPCs '
  '(deduct_token_cost, credit_wallet). CHECK >= 0 is the last line of defense.';

create index profiles_handle_idx on public.profiles (handle);
create index profiles_stripe_customer_idx on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ── Auto-provision a profile on signup ──────────────────────────────────────
create or replace function public.tg_on_auth_user_created()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_base   text;
  v_handle text;
  v_n      integer := 0;
begin
  v_base := lower(regexp_replace(
              coalesce(new.raw_user_meta_data->>'user_name',
                       split_part(new.email, '@', 1),
                       'user'),
              '[^a-z0-9-]', '', 'g'));
  if char_length(v_base) < 2 then v_base := 'user' || v_base; end if;
  v_base   := left(v_base, 30);
  v_handle := v_base;

  while exists (select 1 from public.profiles where handle = v_handle) loop
    v_n := v_n + 1;
    v_handle := left(v_base, 30) || '-' || v_n;
  end loop;

  insert into public.profiles (id, handle, display_name, avatar_url)
  values (new.id, v_handle,
          new.raw_user_meta_data->>'full_name',
          new.raw_user_meta_data->>'avatar_url');
  return new;
end $$;

revoke all on function public.tg_on_auth_user_created() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_on_auth_user_created();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Own full row.
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

-- Update own row but NEVER money or risk columns: those are RPC-only.
-- The subselects read the pre-UPDATE tuple (command snapshot), so this is an
-- "unchanged" assertion on each protected column.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and balance_micro_usd     = (select p.balance_micro_usd     from public.profiles p where p.id = auth.uid())
    and earnings_micro_usd    = (select p.earnings_micro_usd    from public.profiles p where p.id = auth.uid())
    and max_balance_micro_usd = (select p.max_balance_micro_usd from public.profiles p where p.id = auth.uid())
    and is_suspended          = (select p.is_suspended          from public.profiles p where p.id = auth.uid())
    and rate_limit_rpm        = (select p.rate_limit_rpm        from public.profiles p where p.id = auth.uid())
    and handle                = (select p.handle                from public.profiles p where p.id = auth.uid())
  );

-- No client INSERT / DELETE: the auth trigger owns creation, CASCADE owns deletion.

-- Public creator identity for the catalog, via a narrow view (no money columns).
create view public.creator_public
  with (security_invoker = true) as
  select id, handle, display_name, avatar_url, bio, created_at
  from public.profiles
  where is_suspended = false;

grant select on public.creator_public to anon, authenticated;
