-- ============================================================================
-- 20260818000400_realtime_balance.sql   (FR-PLAY-006, FR-CON-005)
-- ============================================================================
-- The nav's balance chip and the wallet card both want the balance to move on
-- its own — after a Stripe credit, and after a Playground request settles.
-- Realtime cannot deliver a `profiles` UPDATE that is not published.
--
-- SAFETY. `profiles` is readable only by its owner
-- (`profiles_select_own`, 20260817000400), and Realtime evaluates RLS per
-- subscriber, so publishing the table exposes a row to exactly the one account
-- that already reads it over PostgREST. REPLICA IDENTITY FULL is what lets that
-- evaluation happen at all on an UPDATE: without the OLD row, the change
-- arrives with an empty payload and no policy can be checked against it.

alter table public.profiles replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'profiles')
    then
      alter publication supabase_realtime add table public.profiles;
    end if;
  else
    raise warning 'publication supabase_realtime is absent; the balance chip will fall back to polling';
  end if;
end $$;
