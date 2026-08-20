import { redirect } from "next/navigation";

import { ConsoleNav } from "@/components/console/console-nav";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata = {
  title: "Console",
};

/**
 * /console/** shell.
 *
 * `middleware.ts` already gates this route table (CONTRACTS.md §Frontend / auth
 * contract), so this check is the second line rather than the first. It is worth
 * having anyway: the matcher is a regex that someone will edit one day, and the
 * failure mode without this is a page that renders empty tables to a signed-out
 * visitor instead of sending them to sign in. It costs one `getUser()` per
 * navigation on a route that is already dynamic and already reads the session.
 */
export default async function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/console");

  return (
    <div className="flex flex-col gap-6">
      <ConsoleNav />
      {children}
    </div>
  );
}
