import { MyModelsTable } from "@/components/studio/my-models-table";
import { gatewayBaseUrl } from "@/components/marketplace/snippets";
import { fetchMyModels } from "@/lib/studio/queries";
import { SUPABASE_URL } from "@/lib/supabase/public-config";
import { createClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * /studio — "My Models" (FR-STU-009).
 *
 * A Server Component does the fetch and passes plain serializable rows to a
 * client component that renders the HeroUI tree. That split is not stylistic:
 * `@heroui/react` pulls in a `client-only` marker through react-aria's Toast,
 * so importing anything from it into a Server Component fails the build
 * outright (PRD §4.1.0).
 *
 * The creator's handle is fetched here because the platform model id is
 * `handle/slug` — the string the "Use this model" snippets pass as `model`.
 * It is never `hf_repo_slug` (see snippets.ts), and it is not on the model row.
 */
export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const user = await getCurrentUser();
  // The layout already redirected; this narrows the type without a second
  // round trip's worth of ceremony.
  if (!user) return null;

  const supabase = await createClient();
  const [models, profile] = await Promise.all([
    fetchMyModels(supabase, user.id),
    supabase.from("profiles").select("handle").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <MyModelsTable
      baseUrl={gatewayBaseUrl(SUPABASE_URL)}
      creatorHandle={profile.data?.handle ?? null}
      initialModels={models}
      userId={user.id}
    />
  );
}
