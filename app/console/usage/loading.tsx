import { TableSkeleton } from "@/components/console/primitives";

export default function UsageLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <TableSkeleton columns={7} rows={6} />
    </div>
  );
}
