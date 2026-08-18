import { TableSkeleton } from "@/components/console/primitives";

export default function KeysLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
      <TableSkeleton columns={6} />
    </div>
  );
}
