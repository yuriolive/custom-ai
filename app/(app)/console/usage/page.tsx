import { redirect } from "next/navigation";

import { UsagePanel } from "@/components/console/usage-panel";
import { fetchCalledModels, fetchUsagePage } from "@/lib/console/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Usage — Nexus Inference",
};

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/console/usage");

  // Both reads are payer-scoped to this verified user id, NOT left to RLS:
  // `usage_transactions` also lets a creator read settled rows for their own
  // models, which is somebody else's spend. See lib/console/queries.ts.
  const [initialPage, models] = await Promise.all([
    fetchUsagePage(supabase, user.id),
    fetchCalledModels(supabase, user.id),
  ]);

  return <UsagePanel initialPage={initialPage} models={models} userId={user.id} />;
}
