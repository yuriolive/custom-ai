import { KeysPanel } from "@/components/console/keys-panel";
import { fetchApiKeys } from "@/lib/console/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "API keys — Nexus Inference",
};

/** Reads under the caller's own RLS context; no user id is passed or needed. */
export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const supabase = await createClient();
  const keys = await fetchApiKeys(supabase);

  // `now` is captured on the server and passed down, so "3 hours ago" renders
  // identically in the server HTML and after hydration.
  return <KeysPanel initialKeys={keys} now={Date.now()} />;
}
