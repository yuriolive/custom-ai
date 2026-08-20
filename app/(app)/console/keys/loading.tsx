import { TableSkeleton } from "@/components/console/primitives";

export default function KeysLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">API keys</h1>
      <TableSkeleton columns={6} />
    </div>
  );
}
