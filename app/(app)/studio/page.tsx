import { MyModelsTable } from "@/components/studio/my-models-table";
import { fetchMyModels } from "@/lib/studio/queries";
import { createClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * /studio — "My Models" (FR-STU-009).
 *
 * A Server Component does the fetch and passes plain serializable rows to a
 * client component that renders the HeroUI tree. That split is not stylistic:
 * `@heroui/react` pulls in a `client-only` marker through react-aria's Toast,
 * so importing anything from it into a Server Component fails the build
 * outright (PRD §4.1.0).
 */
export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const user = await getCurrentUser();
  // The layout already redirected; this narrows the type without a second
  // round trip's worth of ceremony.
  if (!user) return null;

  const supabase = await createClient();
  const models = await fetchMyModels(supabase, user.id);

  return <MyModelsTable initialModels={models} userId={user.id} />;
}
