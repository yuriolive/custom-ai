import { notFound } from "next/navigation";

import { ReportQueue } from "@/components/operator/report-queue";
import { isReportStatus, type ReportStatus } from "@/lib/trust/reports";
import { fetchReportQueue, viewerIsOperator } from "@/lib/trust/server";

/**
 * `/operator` — the surface that acts on a report (§5.5, GitHub #31).
 *
 * NOT under `/console`. The console is the creator's own account — keys, wallet,
 * usage — and everything in it is scoped to `auth.uid()`. This page is the
 * opposite: it reads other people's listings and takes them down. Sharing a route
 * table with the console would mean sharing its nav and its "this is yours"
 * framing with a tool that is neither.
 *
 * WHY 404 AND NOT 403. A 403 confirms the route exists, which tells anyone who
 * guesses the URL that this platform has a moderation surface and that they are
 * not on it. `notFound()` is the same non-disclosure rule the gateway follows for
 * a private model and the catalog follows for a suspended one — it is the house
 * answer to "you may not see this".
 *
 * `viewerIsOperator()` is NOT the security boundary; the four RPCs each re-check
 * `is_platform_operator(auth.uid())` in Postgres and raise 42501 regardless of
 * what this page decided (see lib/trust/server.ts, and supabase/tests/08 for the
 * proof). This gate exists so a non-operator gets a clean 404 instead of a shell
 * whose every button fails.
 *
 * `middleware.ts` does not gate `/operator` — its PROTECTED_PREFIXES list covers
 * /console, /studio and /playground — so for once the check here IS the first
 * line as well. That is fine: signed out, `viewerIsOperator()` is false and the
 * route 404s, which is a better answer for this URL than a redirect to a login
 * form that names it.
 */

export const metadata = {
  title: "Operator",
  // Belt and braces with the 404: a crawler that somehow reaches this must not
  // index the fact that it exists.
  robots: { index: false, follow: false },
};

/** Reads the session on every request; never prerender, never cache. */
export const dynamic = "force-dynamic";

type SearchParams = { status?: string };

export default async function OperatorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await viewerIsOperator())) notFound();

  const { status } = await searchParams;
  const active: ReportStatus = isReportStatus(status) ? status : "open";
  const { reports, failed } = await fetchReportQueue(active);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Trust &amp; safety</h1>
        <p className="text-muted max-w-3xl text-sm">
          Reports against individual listings. Suspending one takes it out of the catalog{" "}
          <em>and</em> makes the gateway 404 it — for its creator too — and the creator cannot put
          it back. It is per-listing: a whole-account suspension is a different, blunter control on
          the profile.
        </p>
      </header>

      <ReportQueue activeStatus={active} loadFailed={failed} reports={reports} />
    </div>
  );
}
