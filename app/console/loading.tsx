import { StatsSkeleton } from "@/components/console/primitives";

/**
 * Streamed while the Server Component's rollup query runs. Mirrors the real
 * layout so the only thing that changes on arrival is the text (PRD quality bar:
 * skeletons, never a bare spinner).
 */
export default function ConsoleOverviewLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Console</h1>
      <StatsSkeleton />
    </div>
  );
}
