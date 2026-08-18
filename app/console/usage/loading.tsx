import { TableSkeleton } from "@/components/console/primitives";

export default function UsageLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">Usage</h1>
      <TableSkeleton columns={7} rows={6} />
    </div>
  );
}
