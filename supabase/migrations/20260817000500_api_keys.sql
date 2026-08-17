-- ============================================================================
-- 20260817000500_api_keys.sql   (PRD §5.3)
-- ============================================================================
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,

  name          text not null check (char_length(name) between 1 and 60),

  -- SHA-256 hex of the full plaintext key. The plaintext is NEVER stored (FR-GW-010).
  key_hash      text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),

  -- Display-only prefix, e.g. 'sk-plat-a1b2c3d4'. Safe to show; not sufficient to auth.
  key_prefix    text not null check (key_prefix ~ '^sk-plat-[A-Za-z0-9_-]{8}$'),

  scopes        text[] not null default array['inference']::text[],

  last_used_at  timestamptz,
  request_count bigint not null default 0,
  revoked_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.api_keys is
  'Virtual platform keys (sk-plat-...). Only the SHA-256 hash is persisted. '
  'Gateway auth is a single indexed lookup on key_hash.';

-- THE hot-path index. Partial on live keys keeps it small and cache-resident.
create unique index api_keys_hash_active_idx
  on public.api_keys (key_hash) where revoked_at is null;

create index api_keys_user_idx on public.api_keys (user_id, created_at desc);

create trigger api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.tg_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.api_keys enable row level security;

-- Read own keys. key_hash is readable by its owner but is useless without the
-- plaintext preimage, so this leaks nothing exploitable.
create policy api_keys_select_own on public.api_keys
  for select to authenticated using (user_id = auth.uid());

-- Creation goes through an Edge Function (which generates entropy and returns the
-- plaintext exactly once). No client INSERT policy exists, by design.

-- Owner may rename and revoke. Owner may NOT rotate the hash in place.
create policy api_keys_update_own on public.api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and key_hash   = (select k.key_hash   from public.api_keys k where k.id = api_keys.id)
    and key_prefix = (select k.key_prefix from public.api_keys k where k.id = api_keys.id)
  );

create policy api_keys_delete_own on public.api_keys
  for delete to authenticated using (user_id = auth.uid());
