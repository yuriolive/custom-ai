import { StatsSkeleton, TableSkeleton } from "@/components/console/primitives";

export default function WalletLoading() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">Wallet</h1>
      <StatsSkeleton />
      <TableSkeleton columns={5} />
    </div>
  );
}
