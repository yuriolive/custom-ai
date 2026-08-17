-- ============================================================================
-- 20260817000100_extensions.sql
-- PRD §5.1. Extensions must exist before any enum, table, or index that uses
-- them. pg_trgm lives in `extensions` because the catalog index references
-- `extensions.gin_trgm_ops` by qualified name.
-- ============================================================================

create schema if not exists extensions;

create extension if not exists "pgcrypto" with schema extensions;  -- gen_random_uuid, digest
create extension if not exists "pg_trgm"  with schema extensions;  -- fuzzy catalog search

-- supabase_vault holds encrypted HF tokens (custom_models.hf_token_secret_id).
-- Nothing in this schema has a hard dependency on it (the column is a bare uuid
-- with no FK), so a platform that does not ship the extension still migrates.
do $$
begin
  create extension if not exists "supabase_vault";
exception when others then
  raise warning 'supabase_vault unavailable (%): private-repo HF tokens will not work here', sqlerrm;
end $$;

-- pg_cron drives the stale-hold reaper. Requires shared_preload_libraries, so it
-- is optional at migrate time; see 20260817001500_reconciliation.sql for the job.
do $$
begin
  create extension if not exists "pg_cron";
exception when others then
  raise warning 'pg_cron unavailable (%): expire_stale_holds() must be scheduled externally', sqlerrm;
end $$;
