import { redirect } from "next/navigation";

import { Overview } from "@/components/console/overview";
import { daysAgoIso } from "@/lib/console/format";
import { fetchSummary } from "@/lib/console/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * Server Component: it holds the cookie-bound Supabase client and does the
 * fetch, then hands plain numbers to a client component. HeroUI cannot be
 * imported here at all — the barrel is client-only (PRD §4.1.0).
 */
export const dynamic = "force-dynamic";

export default async function ConsoleOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The layout already redirected, so this is a type narrowing more than a
  // guard — but `fetchSummary` needs a user id and must never be handed one it
  // did not verify.
  if (!user) redirect("/login?next=/console");

  // The 30-day window is computed on the server and passed as data. Deriving it
  // in the client component instead would make the boundary render depend on the
  // client clock.
  const summary = await fetchSummary(supabase, user.id, daysAgoIso(30));

  return <Overview summary={summary} />;
}
