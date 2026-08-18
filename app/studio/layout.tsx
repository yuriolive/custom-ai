import { redirect } from "next/navigation";

import { StudioNav } from "@/components/studio/studio-nav";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata = {
  title: "Creator Studio — Nexus Inference",
};

/**
 * /studio/** shell.
 *
 * `middleware.ts` already gates this route table (CONTRACTS.md §Frontend / auth
 * contract), so this check is the second line rather than the first — worth
 * having because the matcher is a regex someone will edit one day, and the
 * failure mode without it is a deploy form rendered to a signed-out visitor
 * whose every submit 401s.
 */
export default async function StudioLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio");

  return (
    <div className="flex flex-col gap-6">
      <StudioNav />
      {children}
    </div>
  );
}
