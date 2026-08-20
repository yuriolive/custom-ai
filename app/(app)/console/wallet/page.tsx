import { redirect } from "next/navigation";

import { WalletPanel } from "@/components/console/wallet-panel";
import { daysAgoIso } from "@/lib/console/format";
import { fetchLedgerPage, fetchSummary } from "@/lib/console/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Wallet",
};

export const dynamic = "force-dynamic";

export default async function WalletPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/console/wallet");

  const [summary, initialPage] = await Promise.all([
    // The summary carries the authoritative balance from `profiles`; the ledger
    // below carries how it got there. Reading both means the page can show a
    // disagreement rather than hide one.
    fetchSummary(supabase, user.id, daysAgoIso(30)),
    fetchLedgerPage(supabase),
  ]);

  return (
    <WalletPanel
      balanceMicroUsd={summary.balanceMicroUsd}
      initialPage={initialPage}
      lifetimeSpendMicroUsd={summary.lifetimeSpendMicroUsd}
    />
  );
}
